// CALIBRATION HELPER – for integration day, using readings the LIVE server has stored.
//
// It reports MEASURED FACTS and checks the current placeholder settings against them.
// It does not choose engineering thresholds for you.
//
// 1) Sensor calibration (volts per count), with a multimeter:
//      - set voltsPerCount = 1.0 for every node in firmware config.h and upload
//        (readings then arrive in "counts", not volts – that is expected),
//      - with the supply ON, measure each node with a multimeter, then run:
//      npm run calibrate -- --expect on --last 30 --factor 1.0 --reference N-A=229.5,N-B=228.9,N-C=228.0
//      - put the printed voltsPerCount values into config.h and upload again.
// 2) Supply ON check:   npm run calibrate -- --expect on --last 60
//      Are normal readings safely above the low-voltage limit?
// 3) Supply OFF check:  npm run calibrate -- --expect off --last 30
//      Is the "no supply" limit safely above the sensor noise floor?
//
// Options: --last <seconds> (default 60)  --db <file> (default data/live.db)

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../server/config/load-config.js';

// Statistics of the VALID readings of each node.
// acceptOutOfRange: also use readings the server refused ONLY for being above the sensor
// full scale. Needed for the first calibration: with voltsPerCount = 1.0 the firmware sends
// raw counts (e.g. ~460), which the server correctly refuses as live readings.
export function summarise(rows, nodeIds, { acceptOutOfRange = false } = {}) {
  const usable = (r) => r.voltage_rms !== null && (r.validity === 'VALID' || (acceptOutOfRange && r.invalid_reason === 'OUT_OF_RANGE'));
  const out = {};
  for (const id of nodeIds) {
    const mine = rows.filter((r) => r.node_id === id);
    const v = mine.filter(usable).map((r) => r.voltage_rms);
    const cycleMins = mine.filter((r) => usable(r) && r.voltage_rms_min !== null).map((r) => r.voltage_rms_min);
    const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    const std = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : null;
    out[id] = {
      valid: v.length,
      invalid: mine.length - v.length,
      invalidReasons: [...new Set(mine.filter((r) => r.validity !== 'VALID').map((r) => r.invalid_reason))],
      mean,
      min: v.length ? Math.min(...v) : null,
      max: v.length ? Math.max(...v) : null,
      std,
      lowestCycle: cycleMins.length ? Math.min(...cycleMins) : null,
    };
  }
  return out;
}

// Plain-English findings. expect: 'on' | 'off'. references: { nodeId: multimeterVolts }.
export function advice(stats, { expect, references = {}, factor = null }, config) {
  const lines = [];
  const nominal = config.feeder.nominal_voltage_v;
  const d = config.detection;
  const uvLimit = d.uv_pickup_pu * nominal;
  const lossLimit = d.loss_pickup_pu * nominal;
  for (const [id, s] of Object.entries(stats)) {
    if (!s.valid) {
      lines.push({ node: id, level: 'FAIL', text: `no valid readings${s.invalidReasons.length ? ` (${s.invalidReasons.join(', ')})` : ''} – check wiring, sensor power and that voltsPerCount is not 0` });
      continue;
    }
    if (references[id] !== undefined) {
      if (factor === null) {
        lines.push({ node: id, level: 'INFO', text: 'give --factor (the voltsPerCount the firmware used for these readings) to calculate a new calibration value' });
      } else {
        const newFactor = factor * (references[id] / s.mean);
        lines.push({ node: id, level: 'RESULT', text: `multimeter ${references[id]} V, firmware average ${s.mean.toFixed(2)} → set voltsPerCount = ${newFactor.toPrecision(5)} for ${id} in config.h` });
      }
    }
    if (expect === 'on') {
      const low = Math.min(s.min, s.lowestCycle ?? s.min);
      if (low < uvLimit) {
        lines.push({ node: id, level: 'WARN', text: `with normal supply the reading went down to ${low.toFixed(1)} V, below the low-voltage limit ${uvLimit.toFixed(1)} V (${d.uv_pickup_pu} × ${nominal} V). Expect false "low voltage" alarms: check calibration, nominal_voltage_v, or uv_pickup_pu.` });
      } else {
        lines.push({ node: id, level: 'OK', text: `normal supply ${s.min.toFixed(1)}–${s.max.toFixed(1)} V (average ${s.mean.toFixed(1)} V, spread ±${(s.std ?? 0).toFixed(2)} V) stays above the low-voltage limit ${uvLimit.toFixed(1)} V` });
      }
    } else if (expect === 'off') {
      if (s.max >= lossLimit) {
        lines.push({ node: id, level: 'FAIL', text: `with the supply OFF the reading reached ${s.max.toFixed(2)} V, at or above the "no supply" limit ${lossLimit.toFixed(1)} V – a dead line would NOT be recognised. Raise loss_pickup_pu (and loss_dropout_pu) or reduce sensor noise.` });
      } else {
        lines.push({ node: id, level: 'OK', text: `supply OFF noise floor up to ${s.max.toFixed(2)} V (${(s.max / nominal).toFixed(3)} pu) is below the "no supply" limit ${lossLimit.toFixed(1)} V (${d.loss_pickup_pu} pu), margin ×${(lossLimit / Math.max(s.max, 0.001)).toFixed(1)}` });
      }
    }
  }
  return lines;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function main() {
  const config = loadConfig();
  const expect = arg('expect', null);
  if (!['on', 'off'].includes(expect)) {
    console.log('Usage: npm run calibrate -- --expect on|off [--last 60] [--factor 1.0 --reference N-A=229.5,N-B=...]');
    process.exit(1);
  }
  const lastS = Number(arg('last', 60));
  const dbPath = path.resolve(config.projectRoot, arg('db', path.join(config.server.data_dir, 'live.db')));
  if (!existsSync(dbPath)) {
    console.log(`No database at ${dbPath}. Start LIVE mode (npm start) and let the ESP32 send for a while first.`);
    process.exit(1);
  }
  const references = Object.fromEntries((arg('reference', '') || '').split(',').filter(Boolean).map((p) => {
    const [id, v] = p.split('=');
    return [id.trim(), Number(v)];
  }));
  const factor = arg('factor', null) === null ? null : Number(arg('factor'));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const latest = db.prepare("SELECT MAX(received_at) AS t FROM measurements WHERE source = 'LIVE' AND late = 0").get().t;
  if (!latest) {
    console.log('The live database has no readings yet.');
    process.exit(1);
  }
  const from = latest - lastS * 1000;
  const rows = db.prepare(`SELECT node_id, voltage_rms, voltage_rms_min, validity, invalid_reason, received_at
    FROM measurements WHERE source = 'LIVE' AND late = 0 AND received_at >= ?`).all(from);
  const senders = db.prepare('SELECT DISTINCT firmware_version FROM controller_sessions WHERE last_seen >= ?').all(from).map((r) => r.firmware_version);
  db.close();

  console.log(`Readings from the last ${lastS} s of LIVE data (up to ${new Date(latest).toLocaleTimeString()}), supply expected ${expect.toUpperCase()}:`);
  if (senders.some((f) => String(f).startsWith('test-sender'))) {
    console.log('\n  ! These readings come from the software TEST SENDER, not real sensors. Do not calibrate with them.');
  }
  // Calibration step (multimeter references given): raw-count readings are usable even
  // though the server refused them as live values. Supply checks use valid readings only.
  const calibrating = Object.keys(references).length > 0;
  const stats = summarise(rows, config.topology.orderedNodeIds, { acceptOutOfRange: calibrating });
  if (calibrating && rows.some((r) => r.invalid_reason === 'OUT_OF_RANGE')) {
    console.log('\n  Note: using readings the server refused as "out of range" – expected while the firmware is not yet calibrated.');
  }
  console.log('\n  Node   usable invalid   average     min       max      spread');
  for (const [id, s] of Object.entries(stats)) {
    const f = (x) => (x === null ? '     —   ' : `${x.toFixed(2).padStart(8)} `);
    console.log(`  ${id.padEnd(6)} ${String(s.valid).padStart(5)} ${String(s.invalid).padStart(8)}  ${f(s.mean)} ${f(s.min)} ${f(s.max)} ${s.std === null ? '   —' : `±${s.std.toFixed(2)}`}`);
  }
  console.log('');
  // While calibrating, readings are in raw counts, so the voltage-limit checks would be meaningless.
  for (const l of advice(stats, { expect: calibrating ? null : expect, references, factor }, config)) console.log(`  [${l.level}] ${l.node}: ${l.text}`);
  if (calibrating) console.log('\n  After uploading the new voltsPerCount values, run the --expect on and --expect off checks.');
  console.log('\nThese are measurements and checks, not chosen settings. Decide the final limits with your team and record why in the test report.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
