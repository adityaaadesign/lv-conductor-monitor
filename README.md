# Overhead Line Break Monitor

BE ENTC final-year project: **Detection of Breakage in Low-Voltage AC Distributed Overhead Conductors**.
This repository is the **software module**. The hardware (sensors, ESP32, switch) is built separately.

## What the software does

1. Watches the voltage at several monitoring points (nodes) along a low-voltage line.
2. Notices low voltage or a suspected loss of supply.
3. Estimates **which section** of the line the interruption is in, by comparing the nodes.
4. Shows whether the local controller **commanded a shutdown** (opened its switch) and, separately,
   whether the switch's feedback **confirms** it opened.
5. Keeps a history of fault events that survives refreshes and restarts.

> **This is an academic prototype**, not certified protection equipment, and it is not ready for real
> electrical protection. Voltage readings alone can never prove that a wire is physically broken, so the
> software only says "fault **suspected**" and "**possible** interruption between …". All shutdown
> decisions are made by the controller; this software never operates a switch.

---

## 1. Install and start

You need **Node.js 22.13 or newer** (developed with Node 24).

```bash
npm install
```

```bash
npm run sim
```

Open **http://localhost:8080/**. Stop with `Ctrl + C`.

`npm run sim` is **DEMO mode**: everything is simulated by the software, the page shows a striped
DEMO MODE banner, and real devices are refused. `npm start` is **LIVE mode** for the real ESP32 (see §6).

Run the automated tests:

```bash
npm test
```

---

## 2. The dashboard (one page)

**Always visible** (the minimal screen):

| Part | What it shows |
|---|---|
| **Header** | Project name, a small **DEMO** or **LIVE** badge, and **Connected / Disconnected** |
| **Safety notice** | DEMO MODE strip (readings and switch signals are simulated) – never hidden |
| **Feeder status** | One big word – NORMAL · FAULT SUSPECTED · ISOLATION PENDING · ISOLATED · DEGRADED / UNKNOWN – and one short sentence |
| **Isolation status** | **Command:** Not requested / Command issued. **Feedback:** Confirmed open / Not confirmed / Unavailable |
| **Feeder diagram** | Supply, switch, Node A, Node B, Node C. Green = normal, red dashes + ✕ = possible interruption, amber + ? = uncertain, grey = no supply. The switch is drawn open only when feedback confirms it. Vertical on phones. |
| **Fault location** | e.g. "Possible interruption between Node A and Node B" with an **Estimate** tag and "not proof of a physical break" – or "Location uncertain" |
| **Node cards** | Node name, voltage, and Normal / Low Voltage / No Supply / No Data |
| **Recent events** | The latest 3 events, plus a CSV download link |
| **Demo testing** (DEMO only) | Five simulation buttons and a one-line result ("✓ all expected results seen") |

**Behind "▸" panels** (all collapsed when the page opens; click or press Enter to open):

| Panel | What it contains |
|---|---|
| Why was this fault detected? | The reasoning, each node's reading, and the limits used |
| How was the section estimated? | Which nodes had supply, which did not, and the limits of the method |
| Isolation details | Command time, raw feedback signal, confirmation timeout, controller trip reason |
| Technical details | Per-node reading validity, supply, last update time, sensor status; data source; controller; database; internal state |
| Each event (click it) | Start/end, duration, section, shutdown result, saved readings, timeline |
| View all events | The full saved list (latest 50) with CSV export |
| Expected results / How to use this demo | The checklist for the running scenario and instructions for all five buttons |

Open panels stay open while the page updates.

What the statuses mean:

| Status | Meaning |
|---|---|
| NORMAL | All valid monitoring points are within the configured limits. |
| FAULT SUSPECTED | Low voltage, or supply lost on part of the line. Suspected, not proven. |
| ISOLATION PENDING | The controller commanded the switch to open, but the switch has **not** confirmed it. |
| ISOLATED | Commanded **and** confirmed by the switch's feedback signal. |
| DEGRADED / UNKNOWN | Readings are missing or unreliable (or the software is starting). Missing data is never treated as 0 V or as a broken line. |

---

## 3. Demo testing – how to run each scenario and check it passed

Press a button in **Demo testing**. It resets the simulated line, starts the scenario, and the fault begins
about **3 seconds** later. The line under the buttons says how many expected results have been seen; when it
shows **"✓ all … expected results seen"** the scenario behaved correctly. Open **Expected results** to see each
item tick.

| # | Button | Wait | A successful result looks like this |
|---|---|---|---|
| 1 | Normal Operation | ~2 s | NORMAL · all nodes Normal (~226–229 V) · "No interruption detected" · Command: Not requested |
| 2 | Low Voltage | ~7 s | FAULT SUSPECTED · "Voltage at Node C is below the configured threshold." · Node C Low Voltage (~184 V) · Command: Not requested (low voltage alone does not cause a shutdown) |
| 3 | Suspected Line Interruption | ~5 s | ISOLATED · red ✕ between A and B · "Possible interruption between Node A and Node B" (Estimate) · Command issued · Feedback: Confirmed open. All nodes then read ~0 V because the shutdown switched the line off on purpose – the cards say so. |
| 4 | Isolation Not Confirmed | ~7 s | ISOLATION PENDING – **never** ISOLATED · section A–B · Command issued · Feedback: Not confirmed · "Shutdown not confirmed by switch" event |
| 5 | Node Communication Failure | ~13 s | DEGRADED / UNKNOWN · "Node C is not reporting…" · Node C No Data (no voltage, never 0 V) · "No interruption detected" · "Node offline" event after ~10 s |

The same checklists are also checked automatically by `npm test`. To print a scenario's timeline as text:
`npm run scenario -- S16` (buttons are S01, S15, S16, S17, S18).

**Demonstrating a simulated conductor interruption (about 2 minutes):**
1. `npm run sim`, open http://localhost:8080/, point out the DEMO badge and notice.
2. Press **1 Normal Operation** – everything green.
3. Press **3 Suspected Line Interruption** and wait ~5 s: status ISOLATED, the red ✕ between Node A and Node B,
   "Possible interruption between Node A and Node B · Estimate", Command issued / Confirmed open.
4. Open **Why was this fault detected?** and **How was the section estimated?** to explain the reasoning.
5. Press **4 Isolation Not Confirmed**: ISOLATION PENDING, Feedback "Not confirmed" – a command is not a confirmation.
6. Refresh the browser: the events are still listed. Stop the server (`Ctrl + C`): the page shows "Disconnected";
   start it again: it reconnects and the history is still there.

---

## 4. How one reading travels from the node to the screen

Example: button 3, a break between Node A and Node B.

1. **Simulated line** (`server/simulation/feeder-physics.js`): the wire between A and B "breaks". B and C now
   see 0 V; A still sees ~229 V.
2. **Simulated controller** (`virtual-controller.js`), playing the ESP32: measures every node 50 times a second
   and averages each second into one report. Its own protection rule sees "A has supply, B and C have none"
   for 1 s, commands its switch to open and sends a report immediately.
3. **Checker** (`server/ingest/validator.js`): the report has the right format and known nodes. 0.3 V at B is a
   *real measurement of no supply*. (A missing value would be "No valid reading" instead.)
4. **Node judge** (`server/processing/node-monitor.js`): B and C are "possibly no supply". After 2 s they
   are confirmed as "no supply".
5. **Locator** (`server/processing/localization.js`): the last node *with* supply (A) and the first node
   *without* (B) bracket the fault: section A–B.
6. **Feeder status** (`server/processing/feeder-state.js`): the report says "switch commanded open" →
   ISOLATION PENDING. The next report's feedback says OPEN → ISOLATED.
7. **Event log** (`server/processing/event-manager.js`): one "Line interruption suspected" event is saved in
   SQLite with the readings, the section and the shutdown result. It is not repeated for every report.
8. **Dashboard** (`frontend/js/app.js`, wording from `shared/simple.js`): the server pushes the new status to
   the browser, which updates each box.

In LIVE mode, step 1–2 are replaced by the real ESP32 sending the same report over Wi-Fi. Steps 3–8 are
exactly the same code.

---

## 5. Where things are

| What | File(s) |
|---|---|
| Detection rules (valid/low/no supply, timers) | `server/processing/node-monitor.js` |
| Section estimate | `server/processing/localization.js` |
| Feeder status + shutdown command/feedback | `server/processing/feeder-state.js` |
| Event creation and closing | `server/processing/event-manager.js` |
| Node configuration (names, layout) | `config/feeder.json` |
| Limits and times (all placeholders) | `config/detection.json` |
| Data contract (message format) | `docs/DATA_CONTRACT.md` · short version `docs/HARDWARE_INTEGRATION.md` |
| Report checking | `server/ingest/validator.js` |
| Backend API (incl. `/telemetry`) | `server/api/routes.js` |
| Simulator and demo scenarios | `server/simulation/` · `server/simulation/scenarios/*.json` |
| Database | `server/storage/` (files in `data/`) |
| Dashboard | `frontend/index.html`, `frontend/js/app.js`, `frontend/js/diagram.js` |
| Dashboard wording (all plain-English text) | `shared/simple.js` |
| Tests | `tests/` |
| Simple architecture | `docs/SOFTWARE_OVERVIEW.md` |
| ESP32 firmware skeleton | `firmware/esp32-controller/` (settings in `config.h`) |
| Report checker / calibration helper / test sender | `tools/check-report.js`, `tools/calibrate.js`, `tools/send-test-telemetry.js` |

---

## 6. LIVE mode and future hardware

```bash
npm start
```

- LIVE mode uses its own database (`data/live.db`) and shows a **LIVE MODE – hardware integration has not
  yet been tested** banner.
- Real devices post to `POST /api/v1/telemetry`. Each controller needs a secret key: copy
  `config/devices.example.json` to `config/devices.local.json` and put your own key in it. **Without that file
  every device report is refused.**
- To try the live path before the hardware exists, run the software **test sender** in a second terminal:

```bash
npm run send-test -- --scenario break
```

  Scenarios: `normal`, `low`, `break`, `silent-c`. Its readings are labelled **TEST SENDER** on the dashboard –
  they are not real measurements.
- Check the live API in one step (before connecting the ESP32): `npm run api-check` (laptop) or
  `npm run api-check -- --url https://lv-monitor-api.onrender.com --key <key>` (online).
- Each node card shows **Online / Stale Data / Offline** and the time of its last valid report.
- Everything the firmware must send: [docs/HARDWARE_INTEGRATION.md](docs/HARDWARE_INTEGRATION.md).

### Putting it online

- **Render** runs the LIVE backend (`render.yaml`: one service with a disk for the SQLite file).
- **Vercel** hosts the dashboard page (`vercel.json`; it reads data from Render, allowed by CORS).
- **DEMO** stays on the laptop: `npm run sim`.

Steps, accounts, costs, environment variables (`DEVICE_KEYS`, `ALLOWED_ORIGINS`, `API_BASE_URL`) and the
tests: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). **The online deployment has not been tested yet.**

### Firmware skeleton and integration tools

| What | Command / place |
|---|---|
| **ESP32 firmware skeleton** – measuring, local protection, reporting, Wi-Fi buffering | `firmware/` (see `firmware/README.md`). Core logic tested on a PC; ESP32 part **not yet compiled or tested** |
| Test only the firmware logic (needs `g++`) | `npm run firmware-test` |
| **Report checker** – paste the ESP32 Serial Monitor output into a file, get plain-English problems | `npm run check-report -- serial-log.txt` |
| **Calibration helper** – multimeter-based calibration and checks of the limits against real readings | `npm run calibrate -- --expect on` (details in `tools/calibrate.js`) |
| **Integration day plan** | `docs/INTEGRATION_DAY_CHECKLIST.md` |

---

## 7. What is complete, simulated, untested, or waiting for hardware

| | |
|---|---|
| **Complete (software)** | Report checking, detection with timers and hysteresis, section estimate with "uncertain" cases, separate command/feedback handling, event log in SQLite, one-page dashboard, five demo scenarios, live HTTP input with device keys, automated tests |
| **Simulated** | All readings and switch feedback in DEMO mode; the controller's protection rule (`virtual-controller.js`) is only a stand-in for the real firmware |
| **Tested only with software** | The live input (`/telemetry`) – with automated tests and the test sender, never with a real ESP32. The firmware core logic – on a PC, with simulated sine waves |
| **Written but not compiled or tested** | The ESP32-specific firmware code (`firmware/esp32-controller/esp32-controller.ino`): pins, ADC, relay, Wi-Fi |
| **Not verified at all** | Any real voltage measurement, real switch behaviour, detection accuracy, response time or safety performance. No such figures are claimed. |
| **Waiting for hardware** | Real threshold values, node power arrangement, switch feedback availability, report rate, controller trip rule – see the questions in `docs/HARDWARE_INTEGRATION.md` §6 |
| **Prepared but not tested** | Online deployment on Render + Vercel (`render.yaml`, `vercel.json`, `docs/DEPLOYMENT.md`); HTTPS from the ESP32 |
| **Deliberately not included** | Automatic reclosing or restoration, remote switching, user accounts |

The older five-page dashboard is kept in `archive/` for reference only and is not used.

---

## 8. Tests

`npm test` runs the automated tests (about 15 seconds). Each prints ✔ or ✖ and a summary at the end. They cover:

- detection (normal, undervoltage, brief dips, loss of supply, missing data never becomes 0 V);
- section estimate (single section, uncertain, source-wide outage, contradictory readings);
- shutdown status (confirmed only with OPEN feedback; missing, absent or contradictory feedback);
- all 18 scenarios, including the five demo buttons and their on-screen checklists;
- persistence (refresh, restart, no duplicate events from repeated or delayed messages);
- the live input (keys, malformed and invalid reports, duplicates, fault detection over HTTP);
- hosting support (`DEVICE_KEYS` variable, `/api/v1/health`, the `api-check` tool, CORS for the Vercel dashboard, the Vercel build, Online / Stale Data / Offline labels);
- safety boundaries (demo mode refuses device data; no route or code path can send commands to hardware);
- the example messages in the documentation must pass the real validator;
- the firmware core logic (compiled with `g++`): 51 C++ checks, plus its reports fed into the real server
  pipeline for normal, break, no-feedback, source-loss and unplugged-sensor cases (skipped if `g++` is missing);
- the report checker and the calibration helper.

A passing test proves only the behaviour that test exercises, in software. It is not a validation of real
electrical protection.
