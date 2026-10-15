# Putting the dashboard online (Vercel + Render)

> **Status:** these steps have **not yet been carried out**. Every part was tested on a laptop:
> a LIVE backend and the built dashboard on two different addresses (like Render and Vercel),
> `npm run api-check`, the offline timing, and a restart with the data kept. No real Render or
> Vercel deployment and no real ESP32 have been tested.

## 1. How the parts connect

```
 ESP32 controller ──HTTPS POST /api/v1/telemetry + X-Device-Key──►  RENDER: backend (LIVE mode)
 (measures A, B, C; trips the switch LOCALLY,                         Express API + detection
  works even with no internet)                                       SQLite file on a persistent disk
                                                                          ▲
 VERCEL: dashboard page (plain files) ── reads /api/v1/... and the ───────┘
                                          live update stream (allowed by CORS)

 DEMO mode: on the laptop only – npm run sim. It refuses device data.
```

- **Render** runs the backend: it receives ESP32 reports, runs the detection, stores readings and events
  in SQLite on a **persistent disk** (`/var/data/live.db`), and serves the API.
- **Vercel** only hosts the dashboard files. It is told the backend address (`API_BASE_URL`) when it
  builds. The backend only lets that one address read the API from a browser (`ALLOWED_ORIGINS`).
- **Protection stays on the ESP32.** The website only *shows* what the controller reports. It cannot
  operate a switch, has no remote reset and never recloses anything.

### Why only one Render service?

A server runs either DEMO or LIVE, never both, so an online DEMO would need a second backend and a second
dashboard. For the college demonstration, DEMO runs on the laptop (`npm run sim`): it costs nothing,
does not depend on the hall's Wi-Fi, and keeps simulated data completely away from the real data.

## 2. Accounts and cost

| Account | What for | Cost |
|---|---|---|
| GitHub | Holds the code; Render and Vercel deploy from it | free |
| Render (render.com) | The backend | **Paid.** The data must survive restarts, which needs a persistent disk, and Render only allows disks on paid instances (smallest: `0.5c-512mb`, plus a 1 GB disk). A payment card is needed. **Check current prices on render.com/pricing first.** |
| Vercel (vercel.com) | The dashboard | Free "Hobby" plan is enough for a student project |

Nothing is charged until you click **Deploy** on Render. Render bills while the service exists; delete it
after the project is assessed if you no longer need it.

## 3. When to create the accounts

1. **GitHub:** now (the code must be there first).
2. **Vercel:** any time – but its build needs the Render address, so do it right after step 3.
3. **Render:** when you are ready to pay for the hosting – ideally a few days before the hardware is
   ready or before the demonstration, so you can run the checks below in advance. Until then everything
   can be tested free on the laptop (`npm start` + `npm run send-test`).

## 4. Deploy the backend on Render

1. **Choose your device key**: long random text (at least 16 characters). The same text goes into the
   ESP32 firmware. Never commit it to GitHub.
2. Sign in to render.com with your GitHub account.
3. **New → Blueprint**, choose the `lv-conductor-monitor` repository. Render reads `render.yaml` and shows
   one service: **`lv-monitor-api`** (with a disk).
4. Render asks for two values:
   - `DEVICE_KEYS` = `CTRL-01=<your key>`
   - `ALLOWED_ORIGINS` = leave a placeholder such as `https://example.invalid` for now – you get the real
     Vercel address in §5.
5. Click **Deploy** (this starts the charges). Wait until the service shows **Live**.
6. Note the address, e.g. `https://lv-monitor-api.onrender.com` (Render may add a suffix).
7. Check it from the laptop:

   ```bash
   npm run api-check -- --url https://lv-monitor-api.onrender.com --key <your key>
   ```

   All six lines must say PASS. These are TEST SENDER readings, labelled as such on the dashboard.

## 5. Deploy the dashboard on Vercel

1. Sign in to vercel.com with GitHub. **Add New → Project**, import `lv-conductor-monitor`.
2. Leave the settings as they are (`vercel.json` already sets the build). Under **Environment Variables**
   add `API_BASE_URL` = your Render address from §4.6 (no `/api/v1`, no slash at the end).
3. Click **Deploy**. Note the address, e.g. `https://lv-conductor-monitor.vercel.app`.
4. Back in Render → `lv-monitor-api` → **Environment**: set `ALLOWED_ORIGINS` to that exact Vercel address
   (with `https://`, no slash at the end) and save. Render restarts the service; the data stays on the disk.

If the Render address ever changes, update `API_BASE_URL` in Vercel and **redeploy** the Vercel project
(the address is written in at build time).

## 6. Environment variables

| Where | Variable | Value |
|---|---|---|
| Render | `DEVICE_KEYS` | `CTRL-01=<your key>` – **secret**, several keys separated by commas |
| Render | `ALLOWED_ORIGINS` | your Vercel address, e.g. `https://lv-conductor-monitor.vercel.app` |
| Render | `APP_MODE`, `DATA_DIR`, `NODE_VERSION` | already set by `render.yaml` (`live`, `/var/data`, `24`) |
| Vercel | `API_BASE_URL` | your Render address, e.g. `https://lv-monitor-api.onrender.com` |

On the laptop nothing changes: `npm run sim` and `npm start` work as before and need none of these.

## 7. The telemetry message

`POST https://lv-monitor-api.onrender.com/api/v1/telemetry`
Headers: `Content-Type: application/json` and `X-Device-Key: <your key>`

```json
{
  "schema_version": "1.0",
  "controller_id": "CTRL-01",
  "boot_id": "7f3a91c2",
  "sequence_number": 42,
  "uptime_ms": 43000,
  "device_time": null,
  "time_synced": false,
  "firmware_version": "fw-0.1",
  "report_interval_ms": 1000,
  "nodes": [
    { "node_id": "N-A", "voltage_rms": 229.1, "supply_present": true, "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-B", "voltage_rms": 227.6, "supply_present": true, "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-C", "voltage_rms": 226.0, "supply_present": true, "data_valid": true, "sensor_status": "OK" }
  ],
  "protection": null
}
```

The voltages are examples, not calibration values. All fields and the `protection` block:
[HARDWARE_INTEGRATION.md](HARDWARE_INTEGRATION.md). Answers: `200` accepted (or duplicate), `400` invalid
(with the field names), `401` wrong/missing key, `409` sent to a DEMO server by mistake.

The ESP32 sends to **Render**, never to Vercel. **HTTPS:** Render only accepts `https://`. The firmware
skeleton still uses a plain `http://` URL for laptop tests; for Render it needs `WiFiClientSecure` with the
server's root CA certificate. That is not written or tested yet.

## 8. What the dashboard shows when data stops

| Node card | Meaning |
|---|---|
| **Online** + voltage | A valid reading arrived recently |
| **Stale Data**, `— V` | No valid reading for longer than `stale_after_ms` (3 s) |
| **Offline**, `— V` | No valid reading for longer than `offline_after_ms` (10 s) |
| **No Data** | The controller reported the sensor as faulty / invalid |
| **Waiting** | Nothing received since the server started |

Each card shows "last valid report HH:MM:SS". Missing data is shown as `— V`, "Not counted as 0 V", and
never causes *Fault suspected*. If the whole controller goes silent the status becomes **DEGRADED / UNKNOWN**.
The timeouts are placeholders in `config/detection.json`; change them once the real report interval is known.

## 9. Tests after deploying

**A. The Vercel dashboard receives data from Render**

1. Open the Vercel address. Top right must say **LIVE** and **Connected**.
2. On the laptop run (about 40 s):

   ```bash
   npm run send-test -- --url https://lv-monitor-api.onrender.com --key <your key> --scenario silent-c --seconds 40
   ```

3. Within a few seconds the Vercel page shows Node A, B and C **Online** with voltages and the strip
   "TEST SENDER, not from real hardware" – without reloading the page.
4. If it says "Connecting…" or shows nothing: `ALLOWED_ORIGINS` in Render does not exactly match the
   Vercel address, or `API_BASE_URL` in Vercel is wrong (then redeploy Vercel). The browser console (F12)
   shows a "CORS" message in the first case.

**B. A node goes OFFLINE when its reports stop** (continue watching the same run)

- Node C stops at 5 s → about 3 s later **Stale Data**, about 10 s later **Offline**, and a
  "Node offline (no data)" event appears. Node C never shows 0 V. Status DEGRADED / UNKNOWN, not FAULT SUSPECTED.
- After the sender stops (40 s), Nodes A and B also go Stale Data → Offline.

**C. Data survives a restart**: Render → `lv-monitor-api` → **Manual Deploy → Restart service**. After it is
Live again, refresh the Vercel page: the events from test A/B are still listed (plus a "server restart" event).

Results on the laptop (tested): A, B and C behaved exactly as described. On Render/Vercel: **not yet tested.**
