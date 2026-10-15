# Hardware Integration Handover

**For:** the hardware / firmware teammate.
**Purpose:** what the ESP32 firmware must send, and what the software does with it.
**Status:** the receiving side (`POST /api/v1/telemetry`) is implemented and has been tested
only with **software** senders (automated tests and `npm run send-test`). It has **not**
been tested with real hardware. Full field-by-field reference: [DATA_CONTRACT.md](DATA_CONTRACT.md).

---

## 1. The big picture

```
 sensors ─► ESP32 controller ──(Wi-Fi, HTTPS POST, JSON, every REPORT_INTERVAL_MS)──► Cloudflare Worker (or laptop server) ─► dashboard
             │
             └─ makes ALL protection decisions locally (open the switch etc.)
```

- The ESP32 must protect the line **on its own**. The server never sends commands and has
  no way to operate a switch. If Wi-Fi or the laptop fails, protection must keep working.
- The server only **receives** reports, checks them, detects faults, estimates the section
  and shows what the controller says it did.

---

## 2. One report every `REPORT_INTERVAL_MS` (plus one immediately when protection changes)

Online demonstration: every **5 s** (`REPORT_INTERVAL_MS` in `firmware/esp32-controller/config.h` must match
`REPORT_INTERVAL_MS` in `cloudflare/wrangler.toml`). Laptop bench tests: the laptop server expects ~1 s by
default (`config/detection.json`); for 5 s start it with `REPORT_INTERVAL_MS=5000 STALE_AFTER_MS=12000 OFFLINE_AFTER_MS=30000 CONTROLLER_OFFLINE_AFTER_MS=30000 npm start`.

Send `POST http://<laptop-ip>:8080/api/v1/telemetry` (laptop) or
`POST https://lv-monitor-api.<your-subdomain>.workers.dev/api/v1/telemetry` (online – HTTPS only; the firmware
uses `WiFiClientSecure` with the root certificate in `SERVER_ROOT_CA`, see [DEPLOYMENT.md](DEPLOYMENT.md) §6) with headers
`Content-Type: application/json` and `X-Device-Key: <your key>`.

One report covers **all nodes this controller measures** plus the switch status:

```json
{
  "schema_version": "1.0",
  "controller_id": "CTRL-01",
  "boot_id": "7f3a91c2",
  "sequence_number": 1842,
  "uptime_ms": 1843210,
  "device_time": null,
  "time_synced": false,
  "firmware_version": "0.1.0",
  "report_interval_ms": 1000,
  "nodes": [
    { "node_id": "N-A", "voltage_rms": 229.1, "supply_present": true,  "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-B", "voltage_rms": 0.6,   "supply_present": false, "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-C", "voltage_rms": null,  "supply_present": null,  "data_valid": false, "sensor_status": "ADC_FAULT" }
  ],
  "protection": {
    "protection_enabled": true,
    "lockout": true,
    "trip_reason": "LOSS_OF_SUPPLY_BELOW_N-A",
    "restore_requested": false,
    "restore_source": null,
    "restoration_permitted": false,
    "switches": [
      { "switch_id": "SW-1", "isolation_commanded": true, "commanded_change_uptime_ms": 1842950, "feedback": "OPEN" }
    ]
  }
}
```

### Required fields (report)

| Field | Type / unit | Rule |
|---|---|---|
| `schema_version` | text | always `"1.0"` |
| `controller_id` | text | must be listed in `config/feeder.json` (e.g. `CTRL-01`) |
| `boot_id` | text, 1–32 letters/digits | **new random value at every power-up** (see §4) |
| `sequence_number` | whole number ≥ 0 | +1 for every report since power-up |
| `uptime_ms` | whole number, milliseconds | `millis()` when the report was built |
| `device_time` | text (ISO 8601 UTC) or `null` | `null` unless the clock is synchronised (NTP/RTC) |
| `time_synced` | true / false | `true` only if `device_time` can be trusted |
| `report_interval_ms` | whole number, milliseconds | the interval actually used (expected ~1000) |
| `nodes` | list, 1–32 entries | one entry per node (below) |
| `protection` | object or `null` | switch/protection status (below); `null` if this controller has none |

### Required fields (each node)

| Field | Type / unit | Rule |
|---|---|---|
| `node_id` | text | listed in `config/feeder.json` **and** assigned to this controller |
| `voltage_rms` | number (volts RMS) or `null` | `null` if not available – **never send 0 to mean "unknown"** |
| `supply_present` | true / false / `null` | the controller's own judgement |
| `data_valid` | true / false | `false` if the firmware knows the reading is unreliable |
| `sensor_status` | text | `OK`, `NOT_FITTED`, `OUT_OF_RANGE`, `SATURATED`, `ADC_FAULT`, `NOT_CALIBRATED`, `NO_SIGNAL_REFERENCE`, `UNKNOWN` |

Optional per node: `voltage_rms_min` / `voltage_rms_max` (lowest/highest per-cycle RMS in
the report window – lets the server see short dips), `rms_window_ms`, `current_rms` (only if a
current sensor exists), `link_status` (`OK`, `LOST`, `NOT_APPLICABLE`).

### Switch / protection fields

| Field | Rule |
|---|---|
| `isolation_commanded` | `true` while the controller is **driving the switch open** (the command) |
| `feedback` | what the switch **actually reports**: `OPEN`, `CLOSED`, `UNKNOWN`, or `NOT_FITTED` if there is no feedback contact |
| `lockout`, `trip_reason`, `restore_requested`, `restore_source`, `restoration_permitted`, `protection_enabled` | as defined in DATA_CONTRACT.md §3.3 |

The dashboard shows **Feedback: "Confirmed open" only when `feedback` is `OPEN`**.
A command alone is shown as "Command issued" with feedback "Not confirmed". With `NOT_FITTED` the
feedback reads "Unavailable" and the status can never become ISOLATED.

**Candidate field names mentioned in the project brief and where they live here:**
`node_id`, `sequence_number`, `voltage_rms`, `supply_present`, `data_valid`, `sensor_status` →
as above. `timestamp` → `device_time` (optional; the server uses its own receive time).
`controller_state` → the `protection` block (`lockout`, `trip_reason`, `protection_enabled`).
`isolation_command_state` → `switches[].isolation_commanded`. `isolation_feedback_state` →
`switches[].feedback`.

---

## 3. What the server answers

| HTTP status | Body (example) | What the firmware should do |
|---|---|---|
| 200 | `{"accepted":true,"duplicate":false,"late":false,"rejected_nodes":[],"server_time":"…Z","pending_requests":0}` | carry on |
| 200 | `{"accepted":true,"duplicate":true,…}` | carry on (a resend was ignored safely) |
| 200 | `…"rejected_nodes":[{"node_id":"N-Z","reason":"UNKNOWN_NODE"}]` | fix the node ID in firmware or config |
| 400 | `{"accepted":false,"error":"VALIDATION_FAILED","details":[{"field":"nodes[0].voltage_rms","problem":"NOT_A_NUMBER"}]}` | firmware bug – do not resend the same message |
| 400 | `{"error":"MALFORMED_JSON"}` | the JSON text is broken |
| 401 | `{"accepted":false,"error":"UNAUTHORISED","details":[{"field":"X-Device-Key","problem":"MISSING_OR_WRONG_KEY"}]}` | wrong or missing key |
| 409 | `{"accepted":false,"error":"SERVER_IN_SIMULATION_MODE"}` | the laptop is running the demo (`npm run sim`), not `npm start` |
| 413 | `{"error":"PAYLOAD_TOO_LARGE"}` | report larger than 16 KB |
| timeout / no answer | – | keep protecting locally; try again at the next report |

`pending_requests` is always 0: the server never sends instructions back.

**Invalid message example** (rejected with 400): `"voltage_rms": "229"` (text instead of a
number), a missing `data_valid`, or `"feedback": "TIMEOUT"` (only the server may derive that).

---

## 4. How the server treats imperfect data

| Situation | What the server does |
|---|---|
| Same `boot_id` + `sequence_number` sent twice | second copy acknowledged as `duplicate`, ignored |
| Older `sequence_number` arrives after a newer one | stored as history (`late`), does **not** change the live status |
| `boot_id` changes | logged as "Controller restarted"; a new sequence starts |
| **`boot_id` reused after a restart** | new reports look *older* than the stored ones and are treated as late → the dashboard stays UNKNOWN. **Generate a random `boot_id` at each power-up.** |
| Node missing from reports, or `link_status: "LOST"` | node shows "No Data" after 3 s, "Node offline" after 10 s (placeholder times). **Not** treated as 0 V or as a fault. |
| `data_valid: false` or `sensor_status` ≠ `OK` | "No valid reading" immediately; value not used |
| `voltage_rms` above the sensor full scale (300 V placeholder) | rejected as out of range |
| No report from the controller for 10 s | controller offline → feeder UNKNOWN (never "line broken") |
| `device_time` missing or not synced | server receive time is used |

On reconnect after an outage: send the **newest** report first, then any buffered older
ones (they will be stored as history).

When the protection state changes (trip, reset, reclose), send a report **immediately**,
so the server sees the readings taken just before the switch moved.

---

## 5. How to test on integration day

A firmware skeleton that already sends this format is in `firmware/` (core logic tested on a PC;
the ESP32 part not yet compiled or tested). The full step-by-step plan, including calibration, is
in [INTEGRATION_DAY_CHECKLIST.md](INTEGRATION_DAY_CHECKLIST.md). In short:

1. On the laptop: copy `config/devices.example.json` to `config/devices.local.json` and put a
   random key (16+ characters) in it. Put the same key in the firmware.
2. In `config/server.json` change `"host": "127.0.0.1"` to `"0.0.0.0"` so the ESP32 can reach
   the laptop over Wi-Fi.
3. Start live mode: `npm start`. The terminal says which controllers may send.
4. Check the software side first with the fake controller: `npm run send-test -- --scenario normal`
   (dashboard banner: "TEST SENDER"). Then stop it and power the ESP32.
5. If a report is refused, the HTTP answer says exactly which field is wrong.

Nothing on the dashboard can switch real equipment. Use only the isolated,
current-limited low-voltage test setup.

---

## 6. Open questions for the hardware teammate

1. Are the node sensors/ESP32s powered independently of the line they measure? (If not, a
   lost supply just looks like a silent node.)
2. One central ESP32 reading all nodes, or one per node? (Both fit the format; config changes.)
3. Where is the isolation switch, and does it have a feedback contact or load-side voltage sense?
4. What is the nominal test voltage and the sensor full-scale voltage after calibration?
5. Which voltage sensor, sample rate and RMS window? Can the firmware report per-cycle min/max?
6. What report interval can the firmware keep up without disturbing protection?
7. What is the firmware's own trip rule and delay? (The simulator assumes: trip when a node has no
   supply while the node before it does – see HARDWARE_ASSUMPTIONS.md A14.)
8. How is a trip reset (local button only)? The software has no remote reset.
9. Is there an RTC or NTP for `device_time`?
10. Are current sensors fitted at any node?

Other assumptions: [HARDWARE_ASSUMPTIONS.md](HARDWARE_ASSUMPTIONS.md).
