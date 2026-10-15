# Putting the dashboard online – free (Vercel + Cloudflare Workers + D1)

> **Status:** these steps have **not yet been carried out on Cloudflare or Vercel**.
> What *was* tested on the laptop: the Worker in Cloudflare's own local runtime (`wrangler dev`,
> with a local D1 database), `npm run api-check` against it, the dashboard built for Vercel and served
> from a different address, a node going Stale Data → Offline, and the automated tests.
> No real ESP32 has sent data yet.

## 1. How the parts connect

```
 ESP32 controller ──HTTPS POST /api/v1/telemetry + X-Device-Key──►  CLOUDFLARE WORKER (backend, LIVE only)
 (measures A, B, C; trips the switch LOCALLY –                       checks the report, runs detection,
  works even with no internet)                                       saves to CLOUDFLARE D1 (database)
                                                                          ▲   ▲
 VERCEL: dashboard page (plain files) ── asks every 5 s for the ──────────┘   │ once a minute: cron check
                                          status (allowed by CORS)             (silent nodes are recorded
                                                                               even with no visitor)
 DEMO mode: the DEMO/LIVE switch at the top of the page. DEMO runs the simulator inside the browser tab
 (also on Vercel) and never sends data to Cloudflare. `npm run sim` on the laptop still works.
```

- **Cloudflare Worker** = the backend. It runs the *same* detection code as the laptop server
  (`server/processing/`). A Worker keeps no memory between requests, so after each request it saves the
  monitoring memory in D1, and the next request continues from it (`cloudflare/src/app.js`).
- **Cloudflare D1** = the database (SQLite in the cloud). Schema: `cloudflare/migrations/0001_initial.sql`.
- **Vercel** = only the dashboard files. It is told the Worker address (`API_BASE_URL`) when it builds.
- **Protection stays on the ESP32.** The website only shows what the controller reports. It cannot
  operate a switch, has no remote reset and never recloses anything.
- **DEMO data never reaches Cloudflare**: the Worker has no simulator and no demo controls; it only accepts
  device reports that carry the right key. DEMO (switch at the top of the page) runs in the browser tab and
  makes no request to the Worker; on the laptop, `npm run sim` keeps its own database (`data/sim.db`).
- The Vercel site therefore also publishes the simulator and detection code that the browser DEMO needs
  (listed in `server/demo-assets.js`) – no API code, keys or settings.

## 2. Accounts and cost

| Account | What for | Cost |
|---|---|---|
| GitHub | Holds the code (done: private repository) | free |
| Cloudflare (dash.cloudflare.com) | Worker + D1 database | **Free plan.** Do not add a payment method or click "Upgrade" – nothing here needs it. |
| Vercel (vercel.com) | The dashboard | Free "Hobby" plan |

Total: **₹0**, as long as you stay within the free limits (§8).

## 3. Deploy the backend on Cloudflare (once)

You need: this project on your laptop, Node.js, and a terminal opened in the project folder.

1. **Create a Cloudflare account** at dash.cloudflare.com (free plan). Confirm your e-mail.
2. **Choose your device key**: long random text, at least 16 characters (letters and digits). It goes
   into Cloudflare (step 7) and into the ESP32 firmware. Never put it in GitHub.
3. Install the Cloudflare tool (Wrangler) for this project:

   ```bash
   cd cloudflare
   npm install
   ```

4. Log in (a browser window opens – click **Allow**):

   ```bash
   npx wrangler login
   ```

5. Create the database (`apac` = Asia-Pacific location):

   ```bash
   npx wrangler d1 create lv-monitor --location apac
   ```

   It prints a `database_id` (a long code like `1a2b3c4d-...`). Open `cloudflare/wrangler.toml` and paste it
   in place of `PASTE_YOUR_D1_DATABASE_ID_HERE`. (The id is not secret – it is fine in GitHub.)
6. Create the tables (the migration):

   ```bash
   npx wrangler d1 migrations apply lv-monitor --remote
   ```

   Answer **yes**. It lists `0001_initial.sql ✅`.
7. Store the device key as a **secret** (it is never written into a file):

   ```bash
   npx wrangler secret put DEVICE_KEYS
   ```

   When asked, type `CTRL-01=` followed by your key, e.g. `CTRL-01=k7Qp2...` and press Enter.
   (If Wrangler asks to create the Worker first, answer **yes**.)
8. Deploy:

   ```bash
   npx wrangler deploy
   ```

   It prints your address, e.g. `https://lv-monitor-api.<your-subdomain>.workers.dev`. If Cloudflare asks you
   to choose a `workers.dev` subdomain first, pick any free name in the dashboard and run the command again.
9. Check it from the project folder (go back with `cd ..`):

   ```bash
   npm run api-check -- --url https://lv-monitor-api.<your-subdomain>.workers.dev --key <your key>
   ```

   All six lines must say **PASS**. These are TEST SENDER readings and are labelled as such on the dashboard.

## 4. Deploy the dashboard on Vercel

1. Sign in to vercel.com with GitHub. **Add New → Project**, import `lv-conductor-monitor`.
2. Leave the build settings as they are (`vercel.json` sets them). Under **Environment Variables** add
   `API_BASE_URL` = your Worker address from §3.8 (no `/api/v1`, no slash at the end). Click **Deploy**.
3. Note the Vercel address, e.g. `https://lv-conductor-monitor.vercel.app`.
4. Allow that address in the Worker: open `cloudflare/wrangler.toml`, set
   `ALLOWED_ORIGINS = "https://lv-conductor-monitor.vercel.app"` (your exact address, no slash at the end),
   then in the `cloudflare` folder run `npx wrangler deploy` again. Commit and push the change.

If the Worker address ever changes, update `API_BASE_URL` in Vercel and **redeploy** the Vercel project.
After changing anything in `config/` (thresholds, dial range), run `npx wrangler deploy` again – the Worker
contains a copy of the configuration.

## 5. Settings (environment variables)

| Where | Name | Value | Secret? |
|---|---|---|---|
| Cloudflare (set with `wrangler secret put`) | `DEVICE_KEYS` | `CTRL-01=<your key>` (several: separate with commas) | **yes** |
| `cloudflare/wrangler.toml` `[vars]` | `ALLOWED_ORIGINS` | your Vercel address | no |
| `cloudflare/wrangler.toml` `[vars]` | `REPORT_INTERVAL_MS` | `5000` – must match `REPORT_INTERVAL_MS` in the firmware | no |
| `cloudflare/wrangler.toml` `[vars]` | `STALE_AFTER_MS` / `OFFLINE_AFTER_MS` | `12000` / `30000` (placeholders) | no |
| `cloudflare/wrangler.toml` `[vars]` | `CONTROLLER_OFFLINE_AFTER_MS` | `30000` (placeholder) | no |
| `cloudflare/wrangler.toml` `[vars]` | `DASHBOARD_REFRESH_MS` | `5000` (how often the page asks; minimum 2000) | no |
| `cloudflare/wrangler.toml` | `database_id` | from `wrangler d1 create` | no |
| Vercel → Project → Settings → Environment Variables | `API_BASE_URL` | your Worker address | no |

There is **no database password**: the Worker reaches D1 through the binding in `wrangler.toml`, and only
your Cloudflare account can use it. The device key lives only in Cloudflare's secret store and in the
ESP32. The Vercel page contains no secret at all (anyone may read the dashboard; only a device with the key
can add data).

## 6. The telemetry message

`POST https://lv-monitor-api.<your-subdomain>.workers.dev/api/v1/telemetry`
Headers: `Content-Type: application/json` and `X-Device-Key: <your key>` (only the part after `CTRL-01=`).

```json
{
  "schema_version": "1.0",
  "controller_id": "CTRL-01",
  "boot_id": "7f3a91c2",
  "sequence_number": 42,
  "uptime_ms": 215000,
  "device_time": null,
  "time_synced": false,
  "firmware_version": "fw-0.1",
  "report_interval_ms": 5000,
  "nodes": [
    { "node_id": "N-A", "voltage_rms": 229.1, "supply_present": true, "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-B", "voltage_rms": 227.6, "supply_present": true, "data_valid": true, "sensor_status": "OK" },
    { "node_id": "N-C", "voltage_rms": 226.0, "supply_present": true, "data_valid": true, "sensor_status": "OK" }
  ],
  "protection": null
}
```

The voltages are examples, not calibration values. All fields: [HARDWARE_INTEGRATION.md](HARDWARE_INTEGRATION.md).
Answers: `200` accepted (or `duplicate: true`), `400` invalid (with the field names), `401` wrong/missing key,
`413` too large, `503` database busy (the firmware keeps the report and sends it again).

### HTTPS on the ESP32

Cloudflare only accepts `https://`. The firmware (`firmware/esp32-controller/`) now connects with
`WiFiClientSecure` when `SERVER_URL` starts with `https://`, and checks the server's certificate against
`SERVER_ROOT_CA` in `config.h`. It never switches certificate checking off. Still to do by the firmware
person (not compiled or tested yet):

1. Find which root certificate signs your Worker address: open the address in Chrome → padlock →
   *Connection is secure* → *Certificate is valid* → *Details*, and look at the top of the chain (the root).
2. Download that root certificate in PEM format from the issuer's official website and paste it into
   `SERVER_ROOT_CA`. Cloudflare can use more than one certificate authority, so pasting the roots of all
   authorities Cloudflare lists for its edge certificates is safer.
3. Flash, open the Serial Monitor, and check that reports are answered with HTTP 200.

## 7. What the dashboard shows when data stops

| Node card | Meaning |
|---|---|
| **Online** + dial needle + voltage | A valid reading arrived recently |
| **Stale Data**, dial without needle, `— V` | No valid reading for longer than `STALE_AFTER_MS` (12 s) |
| **Offline**, dial without needle, `— V` | No valid reading for longer than `OFFLINE_AFTER_MS` (30 s) |
| **No Data** | The controller reported the sensor as faulty / invalid |
| **Waiting** | Nothing received yet |

Missing data is shown as `— V`, "Not counted as 0 V", and never causes *Fault suspected*. If the whole
controller goes silent the status becomes **DEGRADED / UNKNOWN**. A measured 0 V (a real, valid reading) is
different: it is shown on the dial and can indicate *No supply*.

The dial range (`gauge_min_v`, `gauge_max_v`) and the coloured bands (no supply / low / normal, from
`loss_pickup_pu`, `uv_pickup_pu` × `nominal_voltage_v`) come from `config/feeder.json` and
`config/detection.json`. They are placeholders: set them for the real demonstration circuit, then redeploy.

## 8. Free-plan limits (checked on Cloudflare's documentation, October 2026)

| Limit (free plan) | Our use with one report every 5 s |
|---|---|
| Workers: **100,000 requests / day** | ESP32: 17,280 · each open dashboard tab: 17,280 (paused while the tab is hidden) · cron: 1,440 → about **36,000/day** with one tab open all day |
| Workers: **10 ms CPU** per request | about 2 ms measured on the laptop (Cloudflare's own figure may differ) |
| D1: **100,000 rows written / day** | about 3 rows per report → about **52,000/day** if the ESP32 reports 24 h non-stop |
| D1: **5 million rows read / day** | a few rows per request → well below |
| D1: **500 MB** per database | about 20 MB of readings per day of non-stop reporting; readings older than 14 days are deleted automatically (stays below about 300 MB) |
| D1: **50 queries** per request | normally 2–3; at most about 30 when two requests collide and retry |

**What happens if a limit is exceeded:** the daily counters reset at **00:00 UTC (05:30 IST)**.
- Too many requests: Cloudflare answers with an error page (error 1027) instead of running the Worker.
- Too many database rows: D1 refuses queries until the reset.
- In both cases the dashboard shows "Disconnected" and the ESP32 keeps its reports and retries. **Local
  protection on the ESP32 is not affected.** Nothing is charged: the free plan simply stops until the reset.

**How to stay inside:** keep `REPORT_INTERVAL_MS` at 5000 or more (2000 ms would exceed the write limit if
run all day), close dashboard tabs you do not need, and switch the ESP32 off when not demonstrating.

## 9. Tests after deploying

**A. The Vercel dashboard receives telemetry**

1. Open the Vercel address. Top right: **LIVE** and **Connected**.
2. On the laptop (project folder) run (about 80 s):

   ```bash
   npm run send-test -- --url https://lv-monitor-api.<your-subdomain>.workers.dev --key <your key> --scenario silent-c --interval 5000 --seconds 80
   ```

3. Within about 5 s the three dials show voltages with needles, the cards say **Online**, and the strip says
   "TEST SENDER, not from real hardware" – without reloading the page.

**B. A silent node goes OFFLINE** (keep watching the same run)

- Node C stops reporting after 15 s → about 12 s later **Stale Data**, about 30 s later **Offline**; its dial
  has no needle and shows `— V`; a "Node offline (no data)" event appears. Status DEGRADED / UNKNOWN, not
  FAULT SUSPECTED.
- After the sender stops (80 s), Nodes A and B also go Stale Data → Offline, and within about a minute the
  "Controller communication lost" event appears even if you close the page (cron check).

**C. Data is kept:** reload the page or open it on your phone – the events are still listed (they are in D1).

If the page shows "Cannot reach the monitoring server": `API_BASE_URL` in Vercel is wrong (fix it and
redeploy Vercel) or `ALLOWED_ORIGINS` in `wrangler.toml` does not exactly match the Vercel address (fix it
and run `npx wrangler deploy`). The browser console (F12) shows a "CORS" message in the second case.

Laptop results (tested with `wrangler dev`): A and B behaved exactly as described.
On Cloudflare + Vercel: **not yet tested.**

## 10. Testing on the laptop without any account

```bash
cd cloudflare
npx wrangler d1 migrations apply lv-monitor --local
```

Create `cloudflare/.dev.vars` (ignored by git) containing `DEVICE_KEYS=CTRL-01=<any 16+ character test key>`, then:

```bash
npx wrangler dev --port 8787
```

and in the project folder: `npm run api-check -- --url http://127.0.0.1:8787 --key <that test key>`.
`npx wrangler deploy --dry-run --outdir dist` only builds the Worker (nothing is uploaded).
