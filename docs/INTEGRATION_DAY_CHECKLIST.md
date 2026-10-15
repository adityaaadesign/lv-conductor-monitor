# Integration Day Checklist

Step-by-step plan for connecting the real ESP32 to the software. Tick each box. Use only
the isolated, current-limited low-voltage test setup. Nothing on the dashboard can switch
equipment; the controller makes all protection decisions.

## Before the day

- [ ] The 10 questions in `HARDWARE_INTEGRATION.md` §6 are answered and written down.
- [ ] `config/feeder.json` matches the real arrangement (node IDs, order, controller ID,
      switch ID, `nominal_voltage_v`, `sensor_full_scale_v`).
- [ ] Firmware `config.h` uses the **same** node IDs, order, controller ID and switch ID.
- [ ] `npm test` passes on the laptop.

## 1. Laptop set-up

- [ ] Copy `config/devices.example.json` to `config/devices.local.json`; put your own random key (16+ characters).
- [ ] In `config/server.json` set `"host": "0.0.0.0"` (so the ESP32 can reach the laptop).
- [ ] Find the laptop's IP address on the Wi-Fi/hotspot (`ipconfig` on Windows).
- [ ] `npm start` → the terminal says *Device input: … accepts reports from CTRL-01*.
- [ ] Check the software side alone: `npm run send-test -- --scenario normal` →
      dashboard shows LIVE + "TEST SENDER" readings. Stop the test sender (Ctrl+C).

## 2. Firmware set-up

- [ ] `config.h`: Wi-Fi name/password, `SERVER_URL` with the laptop IP, `DEVICE_KEY` = same key.
- [ ] `config.h`: node ADC pins, relay pin and open level, feedback pin (or -1), reset button pin.
- [ ] Every `voltsPerCount` = `1.0` for the first calibration.
- [ ] Compile and upload; open the Serial Monitor at 115200 baud.

## 3. First contact

- [ ] Serial Monitor shows `REPORT {...}` lines every second and **no** `SERVER REFUSED` lines.
- [ ] Save ~30 s of Serial output to a file → `npm run check-report -- that-file.txt` → all accepted.
- [ ] If refused: the message names the field; fix the firmware or `config/feeder.json`.

## 4. Calibration (supply ON)

- [ ] Measure each node with a multimeter.
- [ ] `npm run calibrate -- --expect on --last 30 --factor 1.0 --reference N-A=…,N-B=…,N-C=…`
- [ ] Put the printed `voltsPerCount` values into `config.h`; upload; the dashboard now shows real volts.

## 5. Check the limits (placeholders → real values)

- [ ] Supply ON for 60 s: `npm run calibrate -- --expect on --last 60` → all `[OK]`.
- [ ] Supply OFF for 30 s: `npm run calibrate -- --expect off --last 30` → all `[OK]`.
- [ ] If `[WARN]` or `[FAIL]`: agree new values in `config/detection.json` (and the same supply
      limits in firmware `config.h`), restart, repeat. Record the measured values and the reasons.

## 6. Functional tests on the rig (same as the five demo buttons)

| # | Do this on the rig | Expected on the dashboard |
|---|---|---|
| 1 | Normal supply | NORMAL, all nodes Normal, Command: Not requested |
| 2 | Lower the voltage at the last node (if the rig allows) | FAULT SUSPECTED, "Voltage at Node C is below…", no shutdown |
| 3 | Disconnect the conductor between A and B | ISOLATION PENDING → ISOLATED (if feedback is fitted), "Possible interruption between Node A and Node B" |
| 4 | Same, with the feedback wire disconnected | ISOLATION PENDING, Feedback "Not confirmed" – never ISOLATED |
| 5 | Unplug node C's sensor / link | Node C "No Data" – not 0 V, not a fault |
| 6 | Turn the laptop's Wi-Fi off for 20 s during normal supply | Controller keeps protecting; dashboard shows "Disconnected"/UNKNOWN, then reconnects |

- [ ] Record for each test: what was done, what the dashboard showed, the time it took (from the
      event timestamps), and whether it matched. Only measured values may go in the report.

## Afterwards

- [ ] Change `"placeholder": true` to `false` for every value you measured and justified.
- [ ] Note any remaining differences between the firmware and server rules.
