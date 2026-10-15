// API CHECK – run this BEFORE connecting the ESP32. It acts like a controller for a few
// seconds and checks that the telemetry API of a LIVE server answers correctly.
//
//   Local:   npm start            (in one terminal, with a device key configured)
//            npm run api-check    (in another)
//   Hosted:  npm run api-check -- --url https://lv-monitor-api.<your-subdomain>.workers.dev --key your-device-key
//
// The key can also be given as the environment variable DEVICE_KEY. Without --key the
// local config/devices.local.json (or DEVICE_KEYS) is used.
//
// It sends a few TEST readings (labelled "test-sender" – the dashboard shows them as
// TEST SENDER, never as real hardware readings). They are saved in the live history.

import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadDeviceKeys } from '../server/config/load-config.js';

const VOLTS = { 'N-A': 229.1, 'N-B': 227.6, 'N-C': 226.0 };   // example values only – not a calibration

function report(controllerId, bootId, seq, nodeIds, overrides = {}) {
  return {
    schema_version: '1.0',
    controller_id: controllerId,
    boot_id: bootId,
    sequence_number: seq,
    uptime_ms: (seq + 1) * 1000,
    device_time: null,
    time_synced: false,
    firmware_version: 'test-sender-api-check',
    report_interval_ms: 1000,
    nodes: nodeIds.map((id) => ({ node_id: id, voltage_rms: VOLTS[id] ?? 230, supply_present: true, data_valid: true, sensor_status: 'OK' })),
    protection: null,
    ...overrides,
  };
}

// Returns a list of { name, ok, detail }.
export async function runApiCheck({ url, key, controllerId, nodeIds, log = () => {} }) {
  const results = [];
  const step = (name, ok, detail) => { results.push({ name, ok, detail }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  – ${detail}` : ''}`); };
  const base = url.replace(/\/+$/, '');
  const post = async (body, k = key) => {
    const res = await fetch(`${base}/api/v1/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(k ? { 'X-Device-Key': k } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  };

  try {
    const res = await fetch(`${base}/api/v1/health`);
    const h = await res.json();
    step('Server reachable (GET /api/v1/health)', res.status === 200 && h.ok, `mode ${h.mode}`);
    if (h.mode !== 'live') step('Server is in LIVE mode', false, 'this server runs DEMO mode – it refuses device data. Use the LIVE service.');
  } catch (err) {
    step('Server reachable (GET /api/v1/health)', false, err.message);
    return results;
  }

  const bootId = randomBytes(4).toString('hex');
  const good = report(controllerId, bootId, 0, nodeIds);
  const r1 = await post(good);
  step('Valid report accepted (HTTP 200)', r1.status === 200 && r1.json?.accepted === true,
    r1.status === 401 ? 'wrong or missing key – check DEVICE_KEYS on the server and --key here' : `HTTP ${r1.status} ${JSON.stringify(r1.json)}`);

  const r2 = await post(good);
  step('Repeated report recognised as duplicate', r2.status === 200 && r2.json?.duplicate === true, `HTTP ${r2.status}`);

  const r3 = await post(report(controllerId, bootId, 1, nodeIds), 'wrong-key-for-testing-only');
  step('Wrong key refused (HTTP 401)', r3.status === 401, `HTTP ${r3.status}`);

  const bad = report(controllerId, bootId, 2, nodeIds);
  bad.nodes[0].voltage_rms = 'two hundred';
  const r4 = await post(bad);
  step('Invalid report refused (HTTP 400)', r4.status === 400 && r4.json?.error === 'VALIDATION_FAILED', `HTTP ${r4.status} ${r4.json?.details?.[0]?.field ?? ''}`);

  const r5 = await post(report(controllerId, bootId, 3, nodeIds));
  const statusRes = await fetch(`${base}/api/v1/status`);
  const s = await statusRes.json();
  const shown = s.nodes?.find((n) => n.node_id === nodeIds[0]);
  step('Dashboard data shows the reading', r5.status === 200 && shown?.validity === 'VALID' && shown?.last_valid_voltage_rms === VOLTS[nodeIds[0]],
    `${nodeIds[0]} = ${shown?.last_valid_voltage_rms ?? '—'} V (${shown?.validity ?? 'no node'})`);
  return results;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const config = loadConfig();
  const controller = config.feeder.controllers[0];
  const url = arg('url', `http://127.0.0.1:${config.server.port}`);
  const key = arg('key', process.env.DEVICE_KEY) || loadDeviceKeys()[controller.controller_id];
  if (!key) {
    console.log('No device key. Use --key <key> (the same text as DEVICE_KEYS on the server).');
    process.exitCode = 1;
    return;
  }
  console.log(`API check against ${url} as ${controller.controller_id} (test data, labelled TEST SENDER)\n`);
  const results = await runApiCheck({ url, key, controllerId: controller.controller_id, nodeIds: controller.nodes, log: console.log });
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} check(s) FAILED.` : '\nAll checks passed – the API is ready for the ESP32.');
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
