# Data Contract — Controller ⇄ Server ⇄ Dashboard

**Schema version:** `1.0` (draft — to be agreed with the hardware teammate before integration).
**Short version for the firmware developer:** [HARDWARE_INTEGRATION.md](HARDWARE_INTEGRATION.md).
**Server status:** `POST /api/v1/telemetry` is implemented and tested with software senders only — not yet with real hardware.

This is the shared agreement between firmware and software. If either side needs a
change, update this document first and bump `schema_version`.

---

## 1. Conventions

| Topic | Rule |
|---|---|
| Encoding | UTF-8 JSON, one object per HTTP request |
| Field names | `snake_case` |
| Enum values | `UPPER_SNAKE_CASE` strings (never integers) |
| Voltage | volts RMS, number (e.g. `229.4`) |
| Current | amperes RMS, number |
| Durations | milliseconds, integer, field name ends in `_ms` |
| Timestamps | ISO 8601 UTC with milliseconds and `Z`: `2026-10-12T09:15:02.481Z`. Displayed in local time (IST) by the dashboard. |
| Unavailable values | `null`. **Never** substitute `0`, `-1` or the last value. A field absent from the message is also treated as unavailable. |
| Booleans | `true` / `false` only |
| IDs | `controller_id`, `node_id`, `section_id`, `switch_id` are short ASCII strings matching `^[A-Z0-9_-]{1,32}$` and must exist in `config/feeder.json` |

---

## 2. Two hardware arrangements, one message format

The controller arrangement is not final (see HARDWARE_ASSUMPTIONS §2). The contract
supports both without change:

- **Central controller** (one ESP32 reads several sensing points): sends one report
  containing several entries in `nodes[]`.
- **Distributed nodes** (one ESP32 per node, each with Wi-Fi): each ESP32 sends its own
  report with its own `controller_id` and a single entry in `nodes[]`.
- **Gateway** (nodes talk to a gateway via ESP-NOW/LoRa/wired, gateway posts): gateway
  sends one report with all nodes and fills each node's `link_status`.

`config/feeder.json` declares which controller reports which nodes, so the server
knows what to expect from whom.

---

## 3. Controller report (ESP32 → server)

`POST /api/v1/telemetry` with headers `Content-Type: application/json` and
`X-Device-Key: <key>`.

### 3.1 Envelope fields

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `schema_version` | string | ✅ | `"1.0"` |
| `controller_id` | string | ✅ | Configured controller ID |
| `boot_id` | string | ✅ | Random value generated at each boot (e.g. 8 hex chars). Lets the server detect reboots and sequence resets. |
| `sequence_number` | integer ≥ 0 | ✅ | Increments by 1 per report since boot. Used for duplicate / gap / order detection. |
| `uptime_ms` | integer | ✅ | `millis()` at the time the report was built |
| `device_time` | string \| null | ✅ | Device wall-clock time if synchronised (NTP/RTC), else `null` |
| `time_synced` | boolean | ✅ | `true` only if `device_time` is trustworthy |
| `firmware_version` | string \| null | optional | e.g. `"0.3.1"` |
| `report_interval_ms` | integer | ✅ | The interval the firmware is currently using |
| `nodes` | array | ✅ | One or more node measurements (§3.2) |
| `protection` | object \| null | ✅ | Local protection status (§3.3); `null` if this controller has no protection role |

### 3.2 Node measurement object

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `node_id` | string | ✅ | Configured node ID |
| `sequence_number` | integer \| null | optional | Per-node counter, for gateway arrangements where nodes have their own counter |
| `sample_uptime_ms` | integer \| null | optional | Controller `millis()` when this measurement window ended (if different from envelope) |
| `link_status` | enum | optional | `OK`, `LOST`, `NOT_APPLICABLE` (directly wired). Default `NOT_APPLICABLE`. |
| `voltage_rms` | number \| null | ✅ | RMS voltage averaged over the reporting window |
| `voltage_rms_min` | number \| null | optional | Lowest per-cycle (or per-RMS-window) value within the reporting window — enables detection of brief dips between reports |
| `voltage_rms_max` | number \| null | optional | Highest per-cycle value within the window |
| `rms_window_ms` | integer \| null | optional | Length of one RMS computation window (e.g. 20 ms = one 50 Hz cycle). Required for the server to state transient-detection resolution honestly. |
| `current_rms` | number \| null | optional | Only if a current sensor is fitted (declared in config) |
| `supply_present` | boolean \| null | ✅ | The **controller's own** local judgement. The server records it and compares with its own assessment. |
| `data_valid` | boolean | ✅ | `false` if the firmware knows the reading is unreliable |
| `sensor_status` | enum | ✅ | §7 `SensorStatus` |

### 3.3 Protection status object

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `protection_enabled` | boolean | ✅ | Local protection logic armed |
| `lockout` | boolean | ✅ | Controller has tripped and is holding isolation until reset |
| `trip_reason` | string \| null | ✅ | Controller's reason code, e.g. `"LOSS_OF_SUPPLY_NODE_B"` |
| `restore_requested` | boolean | ✅ | A restore/reset has been requested and is being evaluated |
| `restore_source` | enum \| null | ✅ | `LOCAL_BUTTON`, `REMOTE_REQUEST`, `AUTOMATIC`, or `null` |
| `restoration_permitted` | boolean \| null | ✅ | Controller's interlocks currently allow re-energising (`null` if not implemented) |
| `switches` | array | ✅ | One entry per isolation device (§3.4). v1 expects one. |

### 3.4 Switch object

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `switch_id` | string | ✅ | Configured switch ID |
| `isolation_commanded` | boolean | ✅ | The controller is **driving the output to isolate** (relay coil state as commanded) |
| `commanded_change_uptime_ms` | integer \| null | ✅ | `millis()` of the last change of the command |
| `feedback` | enum | ✅ | §7 `IsolationFeedback`: `OPEN`, `CLOSED`, `UNKNOWN`, `NOT_FITTED` |

> "Commanded" ≠ "confirmed". The server shows isolation as **confirmed** only when
> `feedback == "OPEN"`. If no feedback contact is fitted, the dashboard says
> *"Isolation commanded — not confirmed (no feedback fitted)"*.

### 3.5 Server response

| Status | Body | Device action |
|---|---|---|
| `200` | `{"accepted": true, "duplicate": false, "late": false, "server_time": "…Z", "pending_requests": 0}` | continue |
| `200` | `{"accepted": true, "duplicate": true, …}` | continue (retry was harmless) |
| `400` | `{"accepted": false, "error": "VALIDATION_FAILED", "details": [{"field": "nodes[1].voltage_rms", "problem": "NOT_A_NUMBER"}]}` | fix firmware; do not retry same payload |
| `401` | `{"accepted": false, "error": "UNAUTHORISED"}` | check device key |
| `409` | `{"accepted": false, "error": "SERVER_IN_SIMULATION_MODE"}` | server is running a demo |
| `413` | `{"accepted": false, "error": "PAYLOAD_TOO_LARGE"}` | — |
| `5xx` / timeout | — | keep protecting locally; retry next interval; optional local buffer |

`server_time` lets the firmware log clock offset; the firmware must **not** depend on
the server for any protection timing.

---

## 4. Validation rules applied by the server

Incoming data is untrusted until it passes these checks, in order:

1. **Size & parse**: body ≤ 16 KB, valid JSON object. Else `400 MALFORMED_JSON`, logged in `ingest_rejections`.
2. **Auth**: `X-Device-Key` matches `controller_id`. Else `401`.
3. **Schema**: required fields present with correct types; enums known; unknown fields ignored. Else `400`.
4. **Identity**: `controller_id` configured; each `node_id` configured *and assigned to that controller*. Unknown node entries are rejected individually (rest of the report accepted) and counted in diagnostics.
5. **Duplicate**: same (`controller_id`, `boot_id`, `sequence_number`) already processed → `200 duplicate:true`, nothing else happens.
6. **Order**: for the current `boot_id`, `sequence_number` lower than the last processed → stored as `LATE`, excluded from current-state processing. A new `boot_id` starts a new session (logged as `CONTROLLER_REBOOT`).
7. **Gaps**: a jump in `sequence_number` > 1 increments the gap counter (shown in diagnostics); missing reports are never fabricated.
8. **Value sanity** per node:
   - `voltage_rms` must be finite and within `[0, sensor_full_scale_v]` from config, else the measurement is `INVALID (OUT_OF_RANGE)`.
   - `data_valid == false`, `sensor_status != "OK"` or `link_status == "LOST"` → `INVALID` with that reason. The voltage value (if any) is stored for diagnostics but **not used for classification and not displayed as a live reading**.
   - `voltage_rms == null` with `data_valid == true` → `INVALID (MISSING_VALUE)`.
   - `current_rms` present for a node whose config says no current sensor → ignored and flagged.
9. **Time**: `received_at` (server clock) is authoritative for current state and staleness. `device_time` is stored only if `time_synced == true` and within a configured tolerance of server time; otherwise discarded and flagged `TIME_UNSYNCED`. For history charts the server also stores `measured_at`, estimated as `uptime_ms + offset`, where `offset` is the smallest `received_at − uptime_ms` seen in the current boot session. This places late (buffered) reports at approximately the right time instead of at their arrival time.

---

## 5. Feeder status record (server → dashboard)

Returned by `GET /api/v1/status` and pushed as the SSE `status` message.

| Field | Type | Meaning |
|---|---|---|
| `feeder_id` | string | From config |
| `source` | `LIVE` \| `SIMULATED` | Run mode |
| `status` | enum `FeederState` (§7) | Overall supervisory state |
| `status_label` | string | Short user-facing label |
| `condition_since` | timestamp | When the current `status` began |
| `affected_section` | string \| null | Section ID estimate, or `null` |
| `candidate_sections` | string[] | All sections consistent with the evidence (≥2 means ambiguous) |
| `localization_status` | enum `LocalizationStatus` | §7 |
| `localization_evidence` | string[] | Plain-language evidence lines for the dashboard |
| `reason_codes` | string[] | Machine-readable reasons (§7 `ReasonCode`) |
| `recovery_state` | enum `RecoveryState` | §7 |
| `recovery_stable_for_ms` | integer \| null | Progress of the stability timer |
| `recovery_required_ms` | integer \| null | Configured stability period |
| `isolation_command_state` | enum `IsolationCommandState` | §7 |
| `isolation_feedback_state` | enum `IsolationFeedback` | §7 |
| `protection_agreement` | `AGREE` \| `DISAGREE` \| `UNKNOWN` | Server assessment vs controller's `supply_present`/trip status |
| `data_quality` | `GOOD` \| `DEGRADED` \| `NONE` | Whether all expected nodes have valid fresh data |
| `active_event_ids` | integer[] | Open events |
| `node_counts` | object | `{normal, warning, interrupted, offline_or_invalid}` |
| `nodes` | array | Per node: `node_id`, `label`, `validity`, `condition`, `last_valid_voltage_rms`, `last_valid_current_rms` (null if not fitted), `last_valid_at`, `last_message_at`, `sensor_status` |
| `controllers` | array | `controller_id`, `online`, `last_message_at`, `boot_id`, `firmware_version`, `gap_count` |
| `last_updated` | timestamp | When this record was computed |

Additional fields used by the dashboard (Phase 2): `status_label`, `reason_text`,
`explanation` (plain-language lines explaining the state), `localization_label`,
`localization_summary`, `frozen_localization_status` (the original estimate while
`localization_status` is `FROZEN`), `sections` (per-section status with upstream /
downstream supply), `isolation_confirmed`, `isolation` (switch id, raw feedback, trip
reason, lockout, restore flags as reported), `unstable_recovery_count`, `active_events`,
`last_valid_measurement_at`, `storage` (database health), `server_now` (epoch ms — the
reference for "x s ago", since the demo clock may run faster than real time),
`previous_run` (state before the last restart). Per node: `isolation_effect`
(`CONFIRMED` / `UNCONFIRMED` / null), `last_valid_from_history` (value loaded from the
database after a restart, not live).

---

## 6. Event record (persisted, shown in history, exported)

| Field | Type | Meaning |
|---|---|---|
| `event_id` | integer | Auto-increment; displayed as `EV-000123` |
| `event_type` | enum `EventType` | §7 |
| `severity` | enum `Severity` | `INFO`, `WARNING`, `CRITICAL` |
| `status` | `OPEN` \| `CLOSED` | |
| `source` | `LIVE` \| `SIMULATED` | |
| `start_timestamp` | timestamp | Server time when the condition was **confirmed** (after persistence) |
| `first_observed_timestamp` | timestamp | Server time of the first abnormal sample (before persistence) |
| `end_timestamp` | timestamp \| null | When closed |
| `end_timestamp_quality` | `EXACT` \| `APPROXIMATE` \| `UNAVAILABLE` \| null | `APPROXIMATE` e.g. if it cleared while the server was down |
| `duration_ms` | integer \| null | `end − start` when both exist |
| `node_ids` | string[] | Nodes involved |
| `affected_section` | string \| null | Estimated section |
| `localization_status` | enum | at detection |
| `measurement_snapshot` | object | Per involved node at detection: `voltage_rms`, `voltage_rms_min`, `current_rms`, `validity`, `received_at` (nulls preserved) |
| `detection_reason` | string[] | Reason codes |
| `isolation_requested` | boolean \| null | Controller commanded isolation during this event (`null` = no protection status available) |
| `isolation_requested_at` | timestamp \| null | |
| `isolation_confirmed` | `CONFIRMED` \| `NOT_CONFIRMED` \| `NO_FEEDBACK_FITTED` \| `NOT_APPLICABLE` | Never `CONFIRMED` without `OPEN` feedback |
| `isolation_confirmed_at` | timestamp \| null | |
| `recovery_status` | enum `RecoveryState` | Final/current |
| `unstable_recovery_count` | integer | Times the stability timer was reset |
| `related_event_id` | integer \| null | e.g. the undervoltage event this escalated from |
| `end_reason` | string \| null | Why it closed: `RECOVERY_STABLE`, `CONDITION_CLEARED`, `ESCALATED`, … |
| `details` | object | Type-specific extras (candidate sections, evidence lines, trip reason, dip depth, `suppressed_count`, …) |
| `acknowledged_at`, `acknowledged_by` | timestamp/string \| null | Optional feature |
| `timeline` | array | Only in `GET /events/:id`: `{ts, kind, details}` |

---

## 7. Enumerations

**SensorStatus** (firmware → server):
`OK`, `NOT_FITTED`, `OUT_OF_RANGE`, `SATURATED`, `ADC_FAULT`, `NOT_CALIBRATED`, `NO_SIGNAL_REFERENCE`, `UNKNOWN`

**NodeValidity** (server): `NEVER_SEEN`, `VALID`, `INVALID`, `STALE`, `OFFLINE`

**NodeCondition** (server, from valid data only): `UNKNOWN`, `NORMAL`, `UV_PENDING`, `UNDERVOLTAGE`, `LOSS_PENDING`, `SUPPLY_LOST`, `RECOVERING`

**FeederState** (server): `INITIALIZING`, `NORMAL`, `UNDERVOLTAGE`, `TRANSIENT`, `INTERRUPTION_SUSPECTED`, `ISOLATION_PENDING`, `ISOLATED`, `RECOVERY_CHECK`, `RESTORATION_PENDING`, `RESTORED`, `DEGRADED`, `UNKNOWN`

**LocalizationStatus**: `NOT_APPLICABLE` (no abnormality), `LOCALIZED_ESTIMATE`, `AMBIGUOUS`, `SOURCE_OR_UPSTREAM`, `INCONSISTENT`, `INSUFFICIENT_DATA`, `FROZEN` (held from pre-isolation evidence)

**RecoveryState**: `NOT_APPLICABLE`, `WAITING_FOR_SUPPLY`, `STABILITY_CHECK`, `UNSTABLE`, `STABLE_AWAITING_CONTROLLER`, `RESTORED`, `FAILED`

**IsolationCommandState**: `NONE`, `COMMANDED`, `RELEASED`, `UNAVAILABLE` (no protection status received)

**IsolationFeedback**: `OPEN`, `CLOSED`, `UNKNOWN`, `NOT_FITTED`, plus server-derived `CONTRADICTORY`, `TIMEOUT`

**EventType**:
`UNDERVOLTAGE`, `TRANSIENT_DIP`, `INTERRUPTION_SUSPECTED`, `SOURCE_INTERRUPTION_SUSPECTED`,
`NODE_OFFLINE`, `SENSOR_FAULT`, `CONTROLLER_COMM_LOST`, `CONTROLLER_REBOOT`,
`MEASUREMENT_INCONSISTENT`, `ISOLATION_UNCONFIRMED`, `ISOLATION_FEEDBACK_CONTRADICTORY`,
`PROTECTION_DISAGREEMENT`, `SERVER_RESTART`

(Isolation requested/confirmed, recovery and restoration are recorded *inside* the
owning interruption event and its timeline rather than as separate rows, so one
incident = one row in the history table.)

**Severity**: `INFO`, `WARNING`, `CRITICAL`

**ReasonCode** (non-exhaustive, extended as implemented):
`ALL_NODES_NORMAL`, `NODE_UNDERVOLTAGE`, `NODE_SUPPLY_LOST`, `UPSTREAM_PRESENT_DOWNSTREAM_ABSENT`,
`ALL_NODES_ABSENT`, `PATTERN_INCONSISTENT`, `NODE_DATA_STALE`, `NODE_OFFLINE`, `SENSOR_INVALID`,
`CONTROLLER_OFFLINE`, `ISOLATION_COMMANDED`, `ISOLATION_FEEDBACK_OPEN`, `ISOLATION_FEEDBACK_TIMEOUT`,
`FEEDBACK_NOT_FITTED`, `SUPPLY_RETURNED`, `RECOVERY_RESET_BY_ABNORMALITY`, `RECOVERY_STABLE`,
`AWAITING_CONTROLLER_RESTORE`, `TIME_UNSYNCED`, `DIP_BELOW_REPORT_RESOLUTION_POSSIBLE`,
`PROTECTION_TRIP_REPORTED`, `LOCALIZED_FROM_TRIP_REPORT`, `LOCATION_AMBIGUOUS`, `LOCATION_UNKNOWN`,
`NODE_RECOVERING`, `RECLOSE_REPORTED`, `RESTORATION_FAILED`, `RESTORE_REQUESTED`,
`FEEDBACK_CONTRADICTORY`, `FEEDBACK_UNCOMMANDED_OPEN`, `AWAITING_FEEDBACK`, `AWAITING_SWITCH_CLOSE`,
`WAITING_FOR_DATA`, `MONITORING_RESUMED`, `NO_VALID_NODE_DATA`, `TRANSIENT_DIP_DETECTED`,
`AFFECTED_NODE_DATA_UNAVAILABLE`

The authoritative list with plain-language descriptions is `shared/labels.js`.

---

## 8. Example messages

Values below are illustrative for a hypothetical 230 V-nominal *label*; the real test
setup voltage is configured in `config/feeder.json` (`nominal_voltage_v`). These
examples will be saved under `docs/examples/` and reused by tests.

### 8.1 Normal operation (central controller, 3 nodes, no current sensors)

```json
{
  "schema_version": "1.0",
  "controller_id": "CTRL-01",
  "boot_id": "7f3a91c2",
  "sequence_number": 1842,
  "uptime_ms": 1843210,
  "device_time": null,
  "time_synced": false,
  "firmware_version": "0.3.1",
  "report_interval_ms": 1000,
  "nodes": [
    { "node_id": "N-A", "voltage_rms": 229.1, "voltage_rms_min": 227.8, "voltage_rms_max": 230.2, "rms_window_ms": 20,
      "current_rms": null, "supply_present": true, "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-B", "voltage_rms": 227.6, "voltage_rms_min": 226.4, "voltage_rms_max": 228.9, "rms_window_ms": 20,
      "current_rms": null, "supply_present": true, "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-C", "voltage_rms": 226.0, "voltage_rms_min": 224.7, "voltage_rms_max": 227.1, "rms_window_ms": 20,
      "current_rms": null, "supply_present": true, "data_valid": true, "sensor_status": "OK" }
  ],
  "protection": {
    "protection_enabled": true, "lockout": false, "trip_reason": null,
    "restore_requested": false, "restore_source": null, "restoration_permitted": null,
    "switches": [ { "switch_id": "SW-1", "isolation_commanded": false, "commanded_change_uptime_ms": null, "feedback": "CLOSED" } ]
  }
}
```

### 8.2 Undervoltage at Node C (protection does not trip)

```json
{
  "schema_version": "1.0", "controller_id": "CTRL-01", "boot_id": "7f3a91c2",
  "sequence_number": 1903, "uptime_ms": 1904220, "device_time": null, "time_synced": false,
  "report_interval_ms": 1000,
  "nodes": [
    { "node_id": "N-A", "voltage_rms": 228.7, "supply_present": true, "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-B", "voltage_rms": 221.3, "supply_present": true, "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-C", "voltage_rms": 188.4, "voltage_rms_min": 186.9, "supply_present": true, "data_valid": true, "sensor_status": "OK" }
  ],
  "protection": {
    "protection_enabled": true, "lockout": false, "trip_reason": null,
    "restore_requested": false, "restore_source": null, "restoration_permitted": null,
    "switches": [ { "switch_id": "SW-1", "isolation_commanded": false, "commanded_change_uptime_ms": null, "feedback": "CLOSED" } ]
  }
}
```

### 8.3 Interruption: A present, B and C absent; controller has commanded isolation

```json
{
  "schema_version": "1.0", "controller_id": "CTRL-01", "boot_id": "7f3a91c2",
  "sequence_number": 2011, "uptime_ms": 2012480, "device_time": null, "time_synced": false,
  "report_interval_ms": 1000,
  "nodes": [
    { "node_id": "N-A", "voltage_rms": 229.4, "supply_present": true,  "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-B", "voltage_rms": 0.6,   "supply_present": false, "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-C", "voltage_rms": 0.4,   "supply_present": false, "data_valid": true, "sensor_status": "OK" }
  ],
  "protection": {
    "protection_enabled": true, "lockout": true, "trip_reason": "LOSS_OF_SUPPLY_DOWNSTREAM",
    "restore_requested": false, "restore_source": null, "restoration_permitted": false,
    "switches": [ { "switch_id": "SW-1", "isolation_commanded": true, "commanded_change_uptime_ms": 2011950, "feedback": "OPEN" } ]
  }
}
```

Expected server result: `INTERRUPTION_SUSPECTED` → `ISOLATED`; `affected_section: "S-AB"`,
`localization_status: "LOCALIZED_ESTIMATE"`, evidence *"N-A supply present (valid);
N-B, N-C supply absent (valid)"*. The 0.6 V reading is a valid measurement of
"no supply", not missing data.

### 8.4 Recovery in progress (after local reset, switch reclosed)

```json
{
  "schema_version": "1.0", "controller_id": "CTRL-01", "boot_id": "7f3a91c2",
  "sequence_number": 2240, "uptime_ms": 2241530, "device_time": null, "time_synced": false,
  "report_interval_ms": 1000,
  "nodes": [
    { "node_id": "N-A", "voltage_rms": 229.0, "supply_present": true, "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-B", "voltage_rms": 227.2, "supply_present": true, "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-C", "voltage_rms": 225.8, "supply_present": true, "data_valid": true, "sensor_status": "OK" }
  ],
  "protection": {
    "protection_enabled": true, "lockout": false, "trip_reason": null,
    "restore_requested": false, "restore_source": "LOCAL_BUTTON", "restoration_permitted": true,
    "switches": [ { "switch_id": "SW-1", "isolation_commanded": false, "commanded_change_uptime_ms": 2236010, "feedback": "CLOSED" } ]
  }
}
```

Expected server result: `RECOVERY_CHECK` with the stability timer running; becomes
`RESTORED` only after all nodes stay normal for `recovery_stability_ms`, and the event
closes after `restored_hold_ms`.

### 8.5 Node offline (gateway arrangement: link to N-C lost)

```json
{
  "schema_version": "1.0", "controller_id": "GW-01", "boot_id": "11c0de42",
  "sequence_number": 530, "uptime_ms": 531200, "device_time": "2026-10-12T09:21:44.120Z", "time_synced": true,
  "report_interval_ms": 1000,
  "nodes": [
    { "node_id": "N-A", "link_status": "OK",   "voltage_rms": 229.3, "supply_present": true, "data_valid": true,  "sensor_status": "OK" },
    { "node_id": "N-B", "link_status": "OK",   "voltage_rms": 227.9, "supply_present": true, "data_valid": true,  "sensor_status": "OK" },
    { "node_id": "N-C", "link_status": "LOST", "voltage_rms": null,  "supply_present": null, "data_valid": false, "sensor_status": "UNKNOWN" }
  ],
  "protection": null
}
```

Expected server result: N-C `INVALID` → `OFFLINE` after `offline_after_ms`; feeder
`DEGRADED`; `NODE_OFFLINE` event (WARNING). **No interruption is reported** and N-C is
shown grey with its last valid value and timestamp, not 0 V.

In the distributed arrangement (one ESP32 per node), an offline node simply stops
sending; the server reaches the same result through its staleness timers.

### 8.6 Sensor fault

```json
{ "node_id": "N-B", "voltage_rms": 412.0, "supply_present": null, "data_valid": false, "sensor_status": "SATURATED" }
```

Expected: N-B `INVALID (SATURATED)`; `SENSOR_FAULT` event; value kept only in diagnostics.

---

## 9. Supervisory request (designed only — NOT implemented; the system is read-only)

```json
{
  "request_id": 17,
  "controller_id": "CTRL-01",
  "type": "RESET_LOCKOUT_REQUEST",
  "requested_by": "operator1",
  "requested_at": "2026-10-12T09:30:00.000Z",
  "expires_at": "2026-10-12T09:31:00.000Z",
  "status": "PENDING"
}
```

Allowed `type` values (v1 design): `RESET_LOCKOUT_REQUEST`, `SELF_TEST_REQUEST`.
There is deliberately **no** "close switch" or "force restore" type.

Controller reply: `POST /api/v1/controller/CTRL-01/requests/17/result`

```json
{ "result": "REJECTED", "reason": "SUPPLY_NOT_STABLE", "uptime_ms": 2300112 }
```

`result` ∈ `ACCEPTED`, `REJECTED`, `EXPIRED`. Every request and result is written to
`audit_log`. An accepted reset request only lets the controller *begin* its own
restore sequence; the dashboard then reports what the controller actually does.
