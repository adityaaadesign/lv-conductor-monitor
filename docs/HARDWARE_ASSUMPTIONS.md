# Hardware Assumptions and Dependencies

**Purpose:** list every software assumption that depends on hardware not yet finalised,
what breaks if it is wrong, and the questions to settle with the hardware teammate.
Software is built so most of these are **configuration changes**, not code changes.

---

## 1. Working assumptions (development starts on these)

| # | Assumption | If wrong… |
|---|---|---|
| A1 | Prototype is a **single-phase**, radial LV feeder on an isolated, current-limited test supply. | Three-phase: treat each phase as its own feeder in config (per-phase node IDs). Neutral breaks are out of scope unless the neutral is measured. |
| A2 | **3 sensing nodes** in a line: `SOURCE → N-A → N-B → N-C`, sections `S-0A`, `S-AB`, `S-BC`. | Edit `config/feeder.json`; topology is a tree, any number of nodes. |
| A3 | Controller arrangement is **not assumed**. Default config uses one central controller `CTRL-01` reporting all nodes. | Distributed or gateway arrangements need only config changes (DATA_CONTRACT §2). |
| A4 | Each node measures **RMS voltage**; **no current sensors** by default. | Set `has_current_sensor: true` per node; current fields and charts appear automatically. |
| A5 | Node electronics stay powered when the monitored line loses supply (separate supply / battery / isolated DC from the source side). | If a node is powered from the line it measures, supply loss silences it and software can only report `OFFLINE`, never `SUPPLY_LOST`. **This must be settled; it decides whether localization works at all.** |
| A6 | Firmware reports every **~1000 ms** to the laptop server, or every **5000 ms** to the Cloudflare Worker (online demonstration, to stay inside the free plan). | Laptop: change `expected_report_interval_ms` in `detection.json`. Cloudflare: `REPORT_INTERVAL_MS`, `STALE_AFTER_MS`, `OFFLINE_AFTER_MS` in `cloudflare/wrangler.toml`. Staleness and persistence values must be re-tuned. |
| A7 | Firmware computes RMS per mains cycle and can report `voltage_rms_min`/`max` per report window. | If not, transient detection is limited to report-interval resolution (`transient_detection: "REPORT_INTERVAL"`). |
| A8 | **One isolation switch** (relay/contactor) on the source side, de-energising all downstream nodes, driven by the controller. | Per-section switches: add more `isolation_points`; the contract already carries a `switches[]` array. |
| A9 | Isolation **feedback** (auxiliary contact or voltage sense on the load side of the switch) is *unknown*. Whether feedback exists is taken from what the controller reports (`feedback: "NOT_FITTED"` vs. `OPEN`/`CLOSED`/`UNKNOWN`), not guessed by the server. In simulation, the virtual controller simulates a fitted feedback contact unless a scenario says otherwise (S14). | With feedback, the dashboard can show `ISOLATED` (confirmed). Without it, only *"commanded"* is ever shown. |
| A10 | Restoration after a trip requires a **local reset button** on the controller (lockout), not automatic reclose. | Automatic reclose is supported by the state machine (`restore_source: "AUTOMATIC"`), but the policy must be decided and implemented in firmware. |
| A11 | ESP32 and the server laptop are on the **same Wi-Fi / phone hotspot**; no internet. | Remote/cloud viewing would be a later read-only add-on. |
| A12 | ESP32 has **no reliable wall-clock time** (no NTP without internet, no RTC). Server receive time is authoritative. | If NTP/RTC is added, set `time_synced: true` and device times are stored too. |
| A14 | Local trip policy (used by the virtual controller): trip when a node has no supply while its upstream node has supply and every node downstream of it also has none (live conductor ending at a break). A source-wide loss does not trip. A sensor reported invalid is excluded from the decision. | The real firmware's policy may differ; the server does not depend on it — it only reports what the controller says it did. |
| A15 | The firmware sends an **immediate report whenever its protection state changes** (trip, restore request, reclose), outside the normal report schedule. The report sent at the moment of trip therefore contains measurements taken **before** the switch opened (relay operate time > 0). The virtual controller does exactly this. | If the trip only appears in the next scheduled report, its measurements may already include the de-energised period; localization at trip time would then see every node dead and fall back to `SOURCE_OR_UPSTREAM`. |
| A13 | Sensor noise floor with supply removed is well below `loss_pickup_pu` (e.g. ZMPT101B-type modules read a few counts of noise at 0 V). | Raise `loss_pickup_pu` after measuring; otherwise a dead line may read as "low" not "absent". |

---

## 2. Capability dependency table

What the dashboard can honestly show depends on what is fitted. These capabilities are
declared in `config/feeder.json` → `capabilities`, and the UI hides or labels features
accordingly.

| Feature | Needs | Without it, the software… |
|---|---|---|
| Voltage monitoring per node | voltage sensor + calibration per node | — (core requirement) |
| Current monitoring | current sensor (CT / Hall) per node | hides current fields; never shows 0 A as a measurement |
| Brief dip (transient) detection | per-cycle RMS min in firmware | detects only dips spanning a report boundary; labels resolution |
| Supply-loss vs. comms-loss distinction | node powered independently of the monitored line (A5) | reports `OFFLINE` instead of `SUPPLY_LOST` |
| Section localization | ≥2 nodes with valid data, radial topology | reports `SOURCE_OR_UPSTREAM` / `AMBIGUOUS` / `INSUFFICIENT_DATA` |
| Source outage vs. first-section break | a source-side reference sensor | reports `SOURCE_OR_UPSTREAM` for both |
| Isolation **confirmed** | switch feedback contact or load-side voltage sense | shows *"commanded — not confirmed"* only |
| Restoration confirmed | switch feedback + downstream node voltages | infers from node voltages, labelled as inferred |
| Accurate event timestamps | server receive time (always); device NTP/RTC (optional) | timestamps carry ± report-interval + network delay; stated in reports |
| Remote reset request | firmware request validation + operator auth | feature stays disabled (v1 is read-only) |

---

## 3. Firmware responsibilities (for the hardware teammate)

The software assumes the firmware will:

1. Run the protection loop **independently of Wi-Fi**: sampling, RMS, loss detection,
   isolation output, lockout and local reset must all work with the router switched off.
2. Never block the protection loop on an HTTP call (use a separate task/core or
   non-blocking client with a short timeout).
3. Generate a random `boot_id` at every boot and increment `sequence_number` per report.
   Send an extra report immediately when the protection state changes (A15).
4. Send `null` (not 0) when a value is unavailable, and set `data_valid` / `sensor_status` honestly.
5. Report the *commanded* switch state and the *feedback* state as separate fields.
6. Optionally keep a small ring buffer of reports while the server is unreachable and
   resend them with their original `sequence_number` (the server will store them as late
   history without creating duplicate events).
7. Treat any future supervisory request as a request: check interlocks locally, reply
   `ACCEPTED`/`REJECTED`, and never re-energise without its own conditions being met.

A reference implementation of this behaviour exists in the simulator
(`server/simulation/virtual-controller.js`) and an ESP32 example client will be provided
later. On reconnect after an outage, send the **newest** report first and the
buffered backlog afterwards, so the server's live state is current and the backlog is
stored as late history.

---

## 4. Questions to settle with the hardware teammate

Priority order — the first four change what the software can claim.

1. **Node power (A5):** Are node ESP32s/sensors powered independently of the line they monitor?
2. **Arrangement (A3):** One central ESP32 with wired sensing points, or one ESP32 per node? If per node, how do they communicate (Wi-Fi to laptop, ESP-NOW to a gateway, wired)?
3. **Isolation hardware (A8, A9):** Where is the switch (source side / per section)? Is there a feedback contact or a voltage sense after the switch?
4. **Restore policy (A10):** Local reset button only, automatic reclose after a delay, or both?
5. **Test supply:** Nominal voltage of the isolated test feeder, and the sensor's full-scale voltage after calibration.
6. **Sensors:** Voltage sensor model; current sensors fitted or not, at which nodes.
7. **Sampling:** ADC sample rate, RMS window length, and whether per-cycle min/max can be reported.
8. **Report interval** the firmware can sustain without disturbing the protection loop.
9. **Source reference:** Is there (or could there be) a sensor at the source terminals?
10. **Time:** Any RTC module or NTP access during demos?

Answers go into `config/feeder.json` and this document; no code changes are expected
for questions 2, 3, 5, 6, 8, 9 and 10.
