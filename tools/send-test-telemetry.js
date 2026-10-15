// Software TEST SENDER – pretends to be the ESP32 controller and sends reports over HTTP
// to a server running in LIVE mode, exactly as the real firmware will
// (format: docs/HARDWARE_INTEGRATION.md). Use it to check the live data path before the
// hardware exists, or to compare with what the firmware sends on integration day.
//
// Its reports carry firmware_version "test-sender", and the dashboard labels them
// "TEST SENDER". They are NOT real measurements.
//
//   Terminal 1:  npm start
//   Terminal 2:  npm run send-test -- --scenario break
//
// Options: --scenario normal | low | break | silent-c   (default: normal)
//          --seconds 30                                 (how long to send)
//          --url http://127.0.0.1:8080                  (server address)
//          --key your-device-key                        (needed for a hosted server)

import { randomBytes } from 'node:crypto';
import { loadConfig, loadDeviceKeys } from '../server/config/load-config.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const scenario = arg('scenario', 'normal');
const seconds = Number(arg('seconds', 30));
const config = loadConfig();
const url = `${arg('url', `http://127.0.0.1:${config.server.port}`)}/api/v1/telemetry`;
const controllerId = config.feeder.controllers[0].controller_id;
// --key (or the DEVICE_KEY environment variable) for a hosted server; otherwise the local key.
const key = arg('key', process.env.DEVICE_KEY) || loadDeviceKeys()[controllerId];

if (!['normal', 'low', 'break', 'silent-c'].includes(scenario)) {
  console.error('Unknown --scenario. Use normal, low, break or silent-c.');
  process.exit(1);
}
if (!key) {
  console.error(`No key for ${controllerId}. Copy config/devices.example.json to config/devices.local.json,`);
  console.error('put your own random text (16+ characters) as the key, then restart the server with: npm start');
  process.exit(1);
}

const bootId = randomBytes(4).toString('hex');
const nominal = config.feeder.nominal_voltage_v;
const startedAt = Date.now();
let seq = 0;

// Node voltages for this second. The fault starts after 5 s.
function readings(elapsedS) {
  const faultOn = elapsedS >= 5;
  const noise = () => (Math.random() - 0.5) * 2;
  const v = { 'N-A': nominal * 0.996 + noise(), 'N-B': nominal * 0.99 + noise(), 'N-C': nominal * 0.984 + noise() };
  if (faultOn && scenario === 'low') v['N-C'] = nominal * 0.8 + noise();
  if (faultOn && scenario === 'break') { v['N-B'] = 0.3; v['N-C'] = 0.2; }
  return Object.entries(v)
    .filter(([id]) => !(faultOn && scenario === 'silent-c' && id === 'N-C'))
    .map(([id, volts]) => ({
      node_id: id,
      voltage_rms: Math.round(volts * 10) / 10,
      supply_present: volts > nominal * 0.1,
      data_valid: true,
      sensor_status: 'OK',
    }));
}

async function sendOne() {
  const elapsed = (Date.now() - startedAt) / 1000;
  const report = {
    schema_version: '1.0',
    controller_id: controllerId,
    boot_id: bootId,
    sequence_number: seq++,
    uptime_ms: Date.now() - startedAt,
    device_time: null,
    time_synced: false,
    firmware_version: 'test-sender-1',
    report_interval_ms: 1000,
    nodes: readings(elapsed),
    protection: null,   // the test sender has no protection logic or switch
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': key },
      body: JSON.stringify(report),
    });
    const body = await res.json();
    console.log(`t=${elapsed.toFixed(0).padStart(3)} s  seq ${report.sequence_number}  ->  HTTP ${res.status} ${JSON.stringify(body)}`);
  } catch (err) {
    console.log(`t=${elapsed.toFixed(0).padStart(3)} s  could not reach ${url}: ${err.message}`);
  }
}

console.log(`TEST SENDER (not real hardware): scenario "${scenario}" for ${seconds} s -> ${url}`);
const timer = setInterval(async () => {
  if (Date.now() - startedAt >= seconds * 1000) {
    clearInterval(timer);
    console.log('Done.');
    return;
  }
  await sendOne();
}, 1000);
