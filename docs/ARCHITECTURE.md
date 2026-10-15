# Architecture — LV Overhead Conductor Breakage Monitoring

**Project:** Detection of Breakage in Low-Voltage AC Distributed Overhead Conductors
**Document status:** Phase 1 design (draft for team review)
**Related documents:**
[DATA_CONTRACT.md](DATA_CONTRACT.md) · [STATE_MACHINE.md](STATE_MACHINE.md) · [HARDWARE_ASSUMPTIONS.md](HARDWARE_ASSUMPTIONS.md)

---

## 1. Scope and safety boundary

This software is a **supervisory monitoring and event-recording system** for a
prototype feeder built on an isolated, current-limited low-voltage AC test setup.
It is not a protection relay. It does not replace certified protective devices
(MCB/RCD/fuses), and it does not control a real utility feeder.

The single most important architectural rule:

> **All time-critical detection and the protective (isolation) response run on the
> embedded controller.** The server, database, browser and network are *observers*.
> If any of them fail, the controller must keep protecting exactly as before.

| Responsibility | Embedded controller (ESP32) | Server (this software) | Dashboard (browser) |
|---|---|---|---|
| Sample sensors, compute RMS | ✅ | — | — |
| Local loss-of-supply decision and isolation | ✅ (authoritative) | — | — |
| Interlocks, lockout, reclose/restore decision | ✅ (authoritative) | — | — |
| Validate incoming data | basic self-check | ✅ (full) | — |
| Multi-node comparison, section localization | optional | ✅ | display |
| Event logging, history, export | — | ✅ | display/export |
| Supervisory requests (e.g. reset request) | validates & decides | validates, queues, audits | submits (later phase, auth required) |

The server's own classification is called the **supervisory assessment**. The
controller's decisions are reported to the server as **protection status**. The
dashboard shows both, and shows a warning if they disagree. The server never
claims an isolation or a restoration happened unless the controller reported it,
and never claims it was *confirmed* unless a feedback signal reported it.

---

## 2. Recommended technology stack

| Layer | Choice | Why this suits the project |
|---|---|---|
| Backend runtime | **Node.js 24 LTS** | Already installed on the dev machine; one language (JavaScript) for backend and frontend, so one student can own and explain the whole stack. |
| HTTP framework | **Express 4** (only runtime npm dependency) | Small, widely documented, easy to explain in a viva. |
| Database | **SQLite via Node's built-in `node:sqlite`** | Single file, no server to install, survives restarts, zero native build steps on Windows. Accessed only through one repository module, so it can be swapped for `better-sqlite3` if needed. |
| Live updates to browser | **Server-Sent Events (SSE)** | One-way server→browser push over plain HTTP; built into browsers (`EventSource`) with automatic reconnect. No WebSocket library needed. |
| ESP32 → server | **HTTP POST of JSON over Wi-Fi (LAN)** | `HTTPClient` + `ArduinoJson` on ESP32 is the simplest well-trodden path. No broker to install or keep running. |
| Server → ESP32 (later phase) | **ESP32 polls for pending supervisory requests** | The controller stays in charge: it pulls requests when it chooses, validates them locally and replies with accept/reject. No inbound connection to the ESP32. |
| Frontend | **Plain HTML + CSS + JavaScript ES modules**, no build step | Opens in any browser, easy to debug, nothing to compile. |
| Charts | None in the simplified page (Chart.js was used by the archived five-page version and has been removed) | Fewer parts to explain; the page works with no internet. |
| Tests | **Node built-in test runner (`node:test`)** | No test framework dependency. |
| Configuration | JSON files in `config/`, validated at startup | One place for node IDs, topology and thresholds. |

### Alternatives considered and rejected (for now)

| Option | Reason not chosen |
|---|---|
| Firebase | Requires internet; security rules + device credentials add complexity; the protection path must not depend on cloud. Can be added later as a *read-only mirror* if remote viewing is required. |
| MQTT (Mosquitto) | Good protocol, but adds a broker process to install and keep alive. HTTP is sufficient at ~1 report/second from a handful of nodes. Revisit if node count or rate grows significantly. |
| Python/FastAPI | Equally valid, but Python is not installed on this machine and using JS on both sides halves what must be learned and explained. |
| React/Vue | A build toolchain is unnecessary for four pages. |
| WebSockets | Bidirectional push not needed; SSE + normal HTTP requests cover it. |

Deployment assumption: the server runs on a **laptop on the same Wi-Fi network/hotspot
as the ESP32**. No internet connection is required at any point.

---

## 3. System architecture

```
 ┌──────────────────────────── Physical prototype (hardware teammate) ───────────────────────────┐
 │  Isolated, current-limited LV AC source → Node A → Section A-B → Node B → Section B-C → Node C │
 │  Voltage sensor (+ optional current sensor) at each node; isolation switch with optional        │
 │  feedback contact                                                                               │
 └──────────────┬──────────────────────────────────────────────────────────────────────────────────┘
                │ analog signals / node links (arrangement not yet final — see HARDWARE_ASSUMPTIONS)
 ┌──────────────▼──────────────────────────────┐
 │ ESP32 controller(s)                          │   LOCAL PROTECTION LOOP (works with no network)
 │  sample → RMS → local decision → isolate     │◄─ interlocks, lockout, local reset button
 │  report every N ms (JSON over HTTP)          │
 └──────────────┬──────────────────────────────┘
                │ POST /api/v1/telemetry   (X-Device-Key header)
 ┌──────────────▼───────────────────────────────────────────────────────────────────────┐
 │ Server (Node.js)                                                                       │
 │                                                                                        │
 │  1 Ingestion ─► 2 Validation ─► 3 Node monitor ─► 4 Localization ─► 5 Feeder state ─► 6 Event manager
 │  (HTTP / sim)    schema, ranges,  validity +        topology-based     state machine    open/update/close
 │                  dedupe, order    node condition    section estimate   (+ protection    incidents, timeline
 │                                   timers                               status input)
 │                                                                              │
 │  7 Repository (SQLite: measurements, events, timeline, audit) ◄──────────────┘
 │  8 API (REST + SSE stream)            9 Simulator + virtual controller (SIM mode only)
 └──────────────┬───────────────────────────────────────────────────────────────────────┘
                │ REST (history, export, config)   SSE (live status, event changes)
 ┌──────────────▼──────────────────────┐
 │ Dashboard (browser)                  │  Overview · Topology · Event history · Trends & diagnostics
 └──────────────────────────────────────┘
```

### Processing pipeline (the traceable workflow)

Each stage is a separate module with a single job. Stages 3–6 are **pure logic**:
they take `(previous state, input, now)` and return `(new state, outputs)`, with no
I/O and no reading of the system clock. That is what makes them unit-testable and
makes simulation deterministic.

| # | Stage | Input | Output | Module |
|---|---|---|---|---|
| 1 | Ingestion | HTTP body from a device (LIVE) or simulator message (DEMO) | raw report + `received_at` | `api/routes.js` (`/telemetry`), `simulation/simulator.js` |
| 2 | Validation | raw report | accepted node measurements tagged `VALID` / `INVALID`, or rejection | `ingest/validator.js` |
| 3 | Node monitor | validated measurements + clock ticks | per-node data validity and electrical condition, with persistence timers | `processing/node-monitor.js` |
| 4 | Localization | node conditions + topology | affected section estimate + evidence + localization status | `processing/localization.js` |
| 5 | Feeder state | node conditions, localization, controller protection status | feeder state + reason codes | `processing/feeder-state.js` |
| 6 | Event manager | state transitions | event opened / updated / closed, timeline entries | `processing/event-manager.js` |
| 7 | Repository | everything to persist | SQLite rows | `storage/repository.js` |
| 8 | API / SSE | repository + current state | JSON to dashboard | `api/` |

The pipeline is evaluated **on every accepted report** and on a **periodic tick**
(placeholder 250 ms) so that timers (staleness, persistence, stability) expire
even when no messages arrive.

---

## 4. Run modes: LIVE and SIMULATION

The server is started in exactly one mode. Modes never mix.

| | LIVE | SIMULATION |
|---|---|---|
| Start command | `npm start` | `npm run sim` |
| Data source | ESP32 HTTP reports | Built-in deterministic simulator + virtual controller |
| Database file | `data/live.db` | `data/sim.db` |
| `/api/v1/telemetry` | enabled; each controller needs its key in `config/devices.local.json` (no file = all refused). Tested only with software senders, not real hardware. | **disabled** (returns 409) so real data cannot enter the sim DB |
| Simulator endpoints | **disabled** | enabled |
| Every record | `source = "LIVE"` | `source = "SIMULATED"` |
| Dashboard | normal header | persistent **"DEMO MODE — SIMULATED DATA"** banner, simulated badge on every reading, chart and exported CSV row |
| Real hardware | observed | **never contacted** — the simulator has no network client at all |

The **virtual controller** inside the simulator implements a reference version of
the local protection behaviour (trip on sustained loss, report isolation command,
simulate feedback with configurable faults such as "feedback never arrives"). It
doubles as an executable specification for the firmware.

Simulation uses an injectable clock: scenarios run either in real time (for the
demo) or instantly with a virtual clock (for tests), producing identical state
transitions both ways. The demo clock can run at ×1/×2/×5/×10; above ×1 simulated
timestamps run ahead of real time, so on restart the clock resumes after the latest
stored timestamp and never goes backwards.

---

## 5. Backend API (v1)

All JSON, all under `/api/v1`. Timestamps are ISO 8601 UTC.

| Method & path | Caller | Purpose | Phase |
|---|---|---|---|
| `POST /telemetry` | ESP32 | Submit a controller report (see DATA_CONTRACT §3) | 4 (sim uses internal path from 2) |
| `GET /status` | dashboard | Current feeder status record + per-node latest values and health | 2 |
| `GET /stream` | dashboard | SSE stream: `status`, `event_opened`, `event_updated`, `event_closed`, `history_cleared` | 2 |
| `GET /topology` | dashboard | Configured nodes, sections, isolation points | 2 |
| `GET /config` | dashboard, teammate | Active thresholds and declared hardware capabilities (read-only, no secrets) | 2 |
| `GET /events` | dashboard | Filter: `from`, `to`, `node`, `type`, `severity`, `status`, `q`, `limit`, `offset` | 3 |
| `GET /events/:id` | dashboard | One event with its full timeline | 3 |
| `GET /events.csv` | dashboard | Same filters, CSV download | 3 |
| `GET /measurements` | dashboard | Time series: `node`, `from`, `to`, `max_points` | 3 |
| `GET /diagnostics` | dashboard | Controller sessions, last message times, packet gaps, rejected-message counts | 3 |
| `GET /sim/scenarios`, `GET /sim/state`, `POST /sim/run`, `POST /sim/stop`, `POST /sim/speed`, `POST /sim/reset` | dashboard | Simulation control (SIM mode only; `reset` clears the simulated database only) | 2 |
| `POST /events/:id/ack` | dashboard | Acknowledge alert (optional enhancement) | later |
| `GET /controller/:id/requests` | ESP32 | Poll pending supervisory requests | 4 (disabled by default) |
| `POST /controller/:id/requests/:rid/result` | ESP32 | Controller's accept/reject of a request | 4 (disabled by default) |
| `POST /requests` | dashboard | Submit a supervisory request (auth required) | 4 (disabled by default) |

**Version 1 is read-only monitoring.** Supervisory requests are designed but disabled
in config until authentication is enabled and the firmware implements request
validation.

---

## 6. Storage design (SQLite)

Distinguish **current state** (held in memory, rebuilt from fresh data after restart)
from **history** (persisted).

| Table | Contents | Written when | Retention (configurable) |
|---|---|---|---|
| `measurements` | Every accepted node measurement: received time, controller/boot/sequence, voltage (+min/max), current, reported flags, validity, `source` | each accepted report | placeholder 14 days |
| `protection_snapshots` | Controller protection block | only when it **changes** | with events |
| `events` | One row per incident (see DATA_CONTRACT §6) incl. open/closed status and dedupe key | on meaningful transition only | indefinite (manual purge) |
| `event_timeline` | Ordered actions within an event: detected, escalated, isolation requested/confirmed/timeout, supply return, unstable recovery, restored | on each step | with parent event |
| `state_transitions` | Every feeder state change with reason codes (used for chart markers) | on change | with events |
| `audit_log` | Supervisory requests, acknowledgements, mode changes, server start/stop | on action | indefinite |
| `ingest_rejections` | Malformed/unauthorised payloads (reason + truncated excerpt) | on rejection | placeholder 7 days, capped rows |
| `controller_sessions` | `controller_id`, `boot_id`, first/last seen, last sequence, gap count | on report | indefinite |
| `meta` | Schema version | migrations | — |

The database is accessed only through `storage/repository.js`; no SQL elsewhere.

---

## 7. Frontend structure (simplified, Phase 2b)

The dashboard is **one page** (`frontend/index.html`, `frontend/js/app.js`). The
earlier five-page version is kept in `archive/frontend-phase2/` for reference only.

| Part | Content |
|---|---|
| Feeder status | One of five simple statuses + plain-English "Why?" list |
| Monitoring points | Line drawing generated from `config/feeder.json`; one card per node |
| Estimated faulty section | Section estimate (or an explicit "cannot tell") with the readings used |
| Shutdown (isolation) | "Ordered by the controller?" and "Confirmed by switch feedback?" as two separate answers |
| Test buttons (demo only) | Scenarios S01, S15, S16, S17, S18 with a self-ticking checklist |
| Recent fault events | Last 8 non-INFO events; CSV download link |

The server still tracks the detailed 12 feeder states (STATE_MACHINE.md). `shared/simple.js`
maps them to the five displayed statuses:

| Displayed | Internal states |
|---|---|
| NORMAL | NORMAL, TRANSIENT, RESTORED |
| FAULT SUSPECTED | UNDERVOLTAGE, INTERRUPTION_SUSPECTED, RECOVERY_CHECK |
| ISOLATION PENDING | ISOLATION_PENDING; RESTORATION_PENDING without OPEN feedback |
| ISOLATED | ISOLATED; RESTORATION_PENDING with OPEN feedback |
| DEGRADED / UNKNOWN | INITIALIZING, DEGRADED, UNKNOWN |

Recovery/restoration logic remains in the backend (and its tests) but is not part of the
simple page or the test buttons. A test button resets the simulated feeder first
(`POST /api/v1/sim/run` with `fresh: true`): open events are closed with end reason
`DEMO_RESET` and kept in history.

## 8. Folder structure

As built in Phase 2 (see README.md for what each file does):

```
FINAL YEAR PROJ/
├── README.md                      architecture summary, data flow, how to run / test / demo
├── package.json
├── config/
│   ├── feeder.json                topology, node IDs, sections, isolation points, capabilities
│   ├── detection.json             thresholds, persistence and recovery timers (placeholders)
│   └── server.json                port, retention, simulation defaults
├── docs/                          ARCHITECTURE, DATA_CONTRACT, STATE_MACHINE, HARDWARE_ASSUMPTIONS
├── shared/
│   ├── enums.js                   every enum value — used by server AND browser
│   └── labels.js                  user-facing labels, colour tones, reason texts
├── server/
│   ├── index.js                   entry point (npm run sim / npm start)
│   ├── app.js                     assembles DB, pipeline, simulator, HTTP server
│   ├── config/load-config.js      read + validate config files, collect placeholders
│   ├── domain/clock.js            real, manual (tests) and scaled (demo) clocks
│   ├── ingest/validator.js        schema/range validation + duplicate/late/reboot tracking
│   ├── processing/node-monitor.js     layers A+B: data validity, electrical condition
│   ├── processing/localization.js     layer C: section estimate
│   ├── processing/feeder-state.js     layer D: feeder state machine
│   ├── processing/event-manager.js    layer E: event lifecycle
│   ├── processing/status-builder.js   status record + plain-language explanations
│   ├── processing/pipeline.js         wires stages 2–7 together
│   ├── storage/db.js  storage/repository.js   SQLite schema and all SQL
│   ├── api/routes.js  api/sse.js  api/csv.js  REST, live stream, CSV export
│   └── simulation/
│       ├── feeder-physics.js      simulated feeder voltages
│       ├── virtual-controller.js  simulated firmware incl. local protection
│       ├── simulator.js           runs scenarios through the normal pipeline
│       ├── headless.js            instant scenario runs + expectation checks
│       └── scenarios/S01…S14.json repeatable scripts with "expect" blocks
├── frontend/                      single page: index.html, css/, js/app.js, js/diagram.js
├── archive/frontend-phase2/       previous five-page dashboard (not served)
├── tools/run-scenario.js          print a scenario's transitions/events (npm run scenario)
├── tests/ unit/ scenarios/ integration/   node:test suites
└── data/                          sim.db / live.db (git-ignored)
```

The page uses no external libraries and no CDN, so it works offline.

---

## 9. Reliability behaviours (summary)

Full rules are in [STATE_MACHINE.md](STATE_MACHINE.md); headlines:

- A software timeout or missing data **never** becomes an interruption claim. Missing
  data produces `STALE` / `OFFLINE` / `DEGRADED` / `UNKNOWN`.
- A measured 0 V with `data_valid: true` and sensor `OK` is a measurement. A `null`
  voltage, invalid flag, sensor fault or stale message is *not* treated as 0 V and is
  never drawn as 0 V on charts.
- Duplicate reports (same `controller_id` + `boot_id` + `sequence_number`) are
  acknowledged but ignored, so device retries are harmless.
- Late (out-of-order) reports are stored in history flagged `LATE` but do not drive
  the current state.
- Controller reboot is detected by a new `boot_id` and logged.
- Server restart: open events are reloaded from the DB and continued, not duplicated.
  If a condition cleared while the server was down, the event is closed with
  `end_timestamp_quality: "APPROXIMATE"`.
- Database write failure: the pipeline keeps running and detection continues; the
  dashboard shows a "Storage error – history may be incomplete" badge. Failed writes are
  **not** retried in Phase 2 (a bounded retry queue is a possible later improvement).
- Server time is the authoritative timeline (`received_at`); device time is stored
  only when the device reports it as synchronised.

---

## 10. Security (prototype-appropriate)

- Server binds to the LAN only; no port-forwarding or cloud exposure in v1.
- Each controller has a per-device key sent in an `X-Device-Key` header, stored
  server-side in a git-ignored file. **No privileged keys in frontend code.**
- Strict validation of every incoming payload (types, ranges, known IDs, size limit
  16 KB); unknown fields ignored; rejections logged.
- v1 dashboard is read-only. Control-like functions (reset request, acknowledgement)
  are off by default and, when enabled, require operator login and are written to
  `audit_log` with their outcome.
- Every supervisory request is a *request*: the controller validates it against its
  own interlocks and may reject it. There is no "force relay closed" API.

---

## 11. Phase plan

| Phase | Deliverable |
|---|---|
| 1 (this) | Architecture, data contract, state machine, assumptions |
| 2 | Running server in SIM mode + all four dashboard pages + simulator scenarios |
| 3 | Full processing pipeline, event lifecycle, SQLite persistence, CSV export, unit tests |
| 4 | Live ingestion endpoint, device keys, ESP32 example client + test sender, supervisory request design |
| 5 | Integration tests, configuration guide, setup instructions, test-report template |

Phases 2 and 3 overlap in practice: the pipeline is built first (with tests) and the
dashboard is built on top of it, so the demo never shows logic that isn't real.
