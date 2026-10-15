# Software Overview (simple version)

A short, plain-English picture of how the software is built. The detailed design is in
[ARCHITECTURE.md](ARCHITECTURE.md) and [STATE_MACHINE.md](STATE_MACHINE.md); you do not need
them to understand or demonstrate the project.

## The parts

| Part | Job | Main file(s) |
|---|---|---|
| **Data source** | DEMO: a simulated line + simulated controller. LIVE: the real ESP32 posting reports | `server/simulation/` · `server/api/routes.js` (`/telemetry`) |
| **Checker** | Rejects broken or impossible reports; spots duplicates and late messages | `server/ingest/validator.js` |
| **Node judge** | For each node: is the reading usable? Is the voltage normal, low or absent – and has it stayed that way long enough? | `server/processing/node-monitor.js` |
| **Locator** | Compares nodes along the line to estimate which section has the interruption | `server/processing/localization.js` |
| **Feeder status** | Combines everything with the controller's switch report into one status | `server/processing/feeder-state.js` |
| **Event log** | Opens one event per problem, closes it when it ends, saves it | `server/processing/event-manager.js` · `server/storage/` |
| **Web server** | Sends the status to the browser and answers questions (events, CSV) | `server/api/` · `server/app.js` |
| **Dashboard** | One page that shows the result in plain English | `frontend/` · wording in `shared/simple.js` |

## Data flow

```
   DEMO MODE                                  LIVE MODE (not yet tested with hardware)
 ┌──────────────────────────┐               ┌──────────────────────────────┐
 │ simulated line            │               │ ESP32 controller (real)       │
 │ + simulated controller    │               │ POST /api/v1/telemetry        │
 └─────────────┬────────────┘               └──────────────┬───────────────┘
               │   the same report format (JSON)            │  + device key check
               └──────────────────┬─────────────────────────┘
                                  ▼
                        1. Checker (validator)
                                  ▼
                        2. Node judge (valid? normal / low / no supply?)
                                  ▼
                        3. Locator (which section?)
                                  ▼
                        4. Feeder status (+ switch command and feedback)
                                  ▼
                        5. Event log ──────────► SQLite database (data/sim.db or data/live.db)
                                  ▼
                        6. Web server ──(live push)──► Dashboard in the browser
```

Both modes use **the same steps 1–6**. Only the data source differs, so the detection logic
exists once and is tested once. Demo and live data go into **separate database files**.

## Rules that are built in

- **Missing is not zero.** A node that stops reporting or sends an invalid reading is shown
  as "No Data" – never 0 V, never "no supply".
- **Wait before deciding.** Low voltage must last 3 s and loss of supply 2 s before they
  count (placeholder values in `config/detection.json`).
- **Estimate, not proof.** A section is named only when the node before it has supply and
  the node after it has none. Otherwise "Location uncertain".
- **Command ≠ confirmation.** ISOLATED is shown only when the switch feedback says OPEN.
- **One event per problem.** Repeated or delayed messages never create extra events.
- **Read-only.** The software never sends commands to hardware; the controller decides.

## Where to change things

| To change… | Edit |
|---|---|
| Node names, number of nodes, how they connect | `config/feeder.json` |
| Voltage limits and waiting times | `config/detection.json` |
| Dashboard wording | `shared/simple.js` |
| Demo buttons and their checklists | `server/simulation/scenarios/S01, S15–S18*.json` (`"button"` section) |
| Device keys for LIVE mode | `config/devices.local.json` (copy from `devices.example.json`) |
