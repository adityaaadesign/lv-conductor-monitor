# ESP32 Controller Firmware – Skeleton

A starting point for the controller firmware. Who finishes it (you or the hardware
teammate) is still to be decided. It follows the report format the server expects
(`docs/HARDWARE_INTEGRATION.md`) and the same protection rule as the software simulator.

## Status – read this first

| Part | Status |
|---|---|
| `esp32-controller/src/core/` – RMS maths, supply detection, protection rule, report JSON, outage buffer | **Compiled and tested on a PC** (`npm test` / `npm run firmware-test`), including a check that its reports are accepted by the real server and lead to the right dashboard result |
| `esp32-controller/esp32-controller.ino` – ADC reading, relay, feedback input, reset button, Wi-Fi, HTTP, the two tasks | **Written but NOT compiled for an ESP32 and NOT tested on hardware** |
| `esp32-controller/config.h` – pins, calibration, Wi-Fi, key | **Placeholders** – must be filled in from the real circuit |

Nothing here has run on a real ESP32 or near real electrical equipment.

## What the firmware does

```
 Core 1 (measureTask) – every mains cycle (20 ms at 50 Hz), never waits for Wi-Fi
   read every node's ADC 40 times per cycle (2 kHz, placeholder)
     → RMS volts per cycle (DC offset removed automatically)
     → sensor health: no offset = "no signal reference", clipping = "saturated", factor 0 = "not calibrated"
     → supply present? (hysteresis, same placeholder limits as the server)
     → LOCAL protection: A has supply + B and everything after has none for 1 s → open the relay, lock out
     → drive the relay; read feedback contact and reset button
     → every 1 s (or immediately after a trip / reset): hand a report to core 0

 Core 0 (networkTask)
   report → JSON → print "REPORT {...}" on Serial → HTTP POST to the laptop
   no Wi-Fi / no server → keep up to 30 reports; afterwards send newest first, then the backlog
```

Safety-related behaviour built in:
- An invalid sensor reading is **never** treated as "no supply" and is sent as `null`, never as 0.
- A source-wide loss (no node has supply) does **not** trip.
- After a trip the relay stays open until the **local reset button** is pressed; there is no
  automatic reclosing and the server cannot reset anything.
- If `RELAY_PIN` is not set, protection is disabled and the reports say so.
- If the node pins are not set, the firmware refuses to start measuring.

## Files

| File | What it contains |
|---|---|
| `esp32-controller/config.h` | All settings – fill in the `TODO(hardware)` and `PUT_…` values |
| `esp32-controller/esp32-controller.ino` | ESP32 glue: pins, ADC, relay, Wi-Fi, HTTP, tasks |
| `src/core/rms.*` | RMS per mains cycle and per report window; sensor health checks |
| `src/core/supply.h` | Supply present / absent with hysteresis |
| `src/core/protection.*` | The local trip rule, lockout and local reset |
| `src/core/controller_core.*` | Ties the above together (the main logic, testable on a PC) |
| `src/core/report_json.*` | Builds the JSON report |
| `src/core/report_buffer.h` | Keeps reports during an outage |
| `host-tests/test_core.cpp` | 51 PC unit checks of the core logic |
| `host-tests/sim_feeder.cpp` | Runs the core on simulated sine waves and prints the reports |

## Building

**On a PC (logic tests only):** `npm run firmware-test` (needs `g++`; this runs automatically in `npm test`).

**For the ESP32 (not yet tried):** install the Arduino IDE and the "esp32" boards package, open
`esp32-controller/esp32-controller.ino`, fill in `config.h`, choose your board, and upload.
The `src/` folder is compiled automatically. Expect to fix small compile issues the first time –
this file has not been compiled yet.

## Calibration on integration day

1. In `config.h` set every `voltsPerCount` to `1.0` and upload (readings then arrive in raw counts).
2. Laptop: `npm start`; supply ON; measure each node with a multimeter.
3. `npm run calibrate -- --expect on --last 30 --factor 1.0 --reference N-A=…,N-B=…,N-C=…`
4. Put the printed `voltsPerCount` values into `config.h`, upload again.
5. Check limits: `npm run calibrate -- --expect on` (supply on), then `--expect off` (supply off).

Copy the Serial Monitor output to a file and run `npm run check-report -- <file>` to check the
reports at any time.

## Decisions still needed from the hardware team

Pins for each sensor (ADC1 pins – ADC2 does not work with Wi-Fi on), the relay output level that
opens the switch and the safe start-up state, whether a feedback contact exists and its level,
the reset button, the sensor's DC offset range, sample rate, the real trip delay and trip rule.
Full list: `docs/HARDWARE_INTEGRATION.md` §6.
