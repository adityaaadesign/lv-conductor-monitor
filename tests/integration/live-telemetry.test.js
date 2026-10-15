// The real-device input (POST /api/v1/telemetry) in LIVE mode, tested with software
// reports – NOT with real hardware. Also proves that demo controls cannot reach any
// real-device path and that the server has no way to send commands to hardware.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../server/app.js';
import { buildApiRouter } from '../../server/api/routes.js';
import { testConfig, quietLogger, makeReport } from '../helpers.js';

const config = testConfig();
const KEY = 'test-key-0123456789abcdef';
let dir;
let live;
let base;
let seq = 0;

const send = (body, key = KEY) => fetch(`${base}/api/v1/telemetry`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Device-Key': key } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const report = (nodes) => makeReport({ boot: 'liveboot1', seq: seq++, uptime: seq * 1000, nodes, protection: null });
const status = async () => (await fetch(`${base}/api/v1/status`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lvlive-'));
  live = createServer({ config, mode: 'live', dataDir: dir, logger: quietLogger, deviceKeys: { 'CTRL-01': KEY } });
  const addr = await live.start(0, '127.0.0.1');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await live?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('missing or wrong device key → 401, nothing stored', async () => {
  assert.equal((await send(report({ 'N-A': 229 }), null)).status, 401);
  const r = await send(report({ 'N-A': 229 }), 'wrong-key-0123456789');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'UNAUTHORISED');
  assert.equal((await status()).nodes[0].validity, 'NEVER_SEEN');
});

test('malformed and invalid reports → 400 with details', async () => {
  const bad = await send('{"controller_id": "CTRL-01", oops');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'MALFORMED_JSON');
  const invalid = report({ 'N-A': 229 });
  invalid.nodes[0].voltage_rms = 'two hundred';
  const r = await send(invalid);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error, 'VALIDATION_FAILED');
  assert.ok(body.details.some((d) => d.field === 'nodes[0].voltage_rms'));
});

test('valid reports are accepted, duplicates are recognised, unknown nodes are listed', async () => {
  const first = report({ 'N-A': 229, 'N-B': 227, 'N-C': 226, 'N-Z': 229 });
  const r1 = await send(first);
  assert.equal(r1.status, 200);
  const b1 = await r1.json();
  assert.equal(b1.accepted, true);
  assert.equal(b1.duplicate, false);
  assert.deepEqual(b1.rejected_nodes, [{ node_id: 'N-Z', reason: 'UNKNOWN_NODE' }]);
  assert.match(b1.server_time, /Z$/);
  const again = await (await send(first)).json();
  assert.equal(again.duplicate, true, 'same boot_id + sequence_number is a duplicate');
  const s = await status();
  assert.equal(s.source, 'LIVE');
  assert.equal(s.nodes[0].validity, 'VALID');
  assert.equal(s.nodes[0].last_valid_voltage_rms, 229);
});

test('the live path uses the same detection logic: break pattern → interruption suspected at S-AB', async () => {
  for (let i = 0; i < 2; i++) { await send(report({ 'N-A': 229, 'N-B': 227, 'N-C': 226 })); await sleep(200); }
  // Supply present at A, absent at B and C, held long enough for the 2 s persistence rule.
  for (let i = 0; i < 6; i++) { await send(report({ 'N-A': 229, 'N-B': 0.3, 'N-C': 0.2 })); await sleep(500); }
  const s = await status();
  assert.equal(s.status, 'INTERRUPTION_SUSPECTED');
  assert.equal(s.affected_section, 'S-AB');
  assert.equal(s.display_status, 'FAULT_SUSPECTED');
  assert.equal(s.isolation_command_state, 'UNAVAILABLE', 'no protection report → shutdown state unknown, never assumed');
  const events = await (await fetch(`${base}/api/v1/events?exclude_info=1`)).json();
  assert.equal(events.items.filter((e) => e.event_type === 'INTERRUPTION_SUSPECTED').length, 1);
});

// ---- No path from the demo (or anything else) to real hardware -----------------------------

function postRoutes(router) {
  return router.stack
    .filter((l) => l.route && (l.route.methods.post || l.route.methods._all))
    .map((l) => l.route.path);
}

test('demo mode exposes only simulator controls; live mode exposes only the data INPUT', () => {
  const fake = { config, repo: {}, getPipeline: () => ({}), clock: { now: () => 0 }, logger: quietLogger };
  const sim = postRoutes(buildApiRouter({ ...fake, mode: 'sim', simControl: {} }));
  const liveRoutes = postRoutes(buildApiRouter({ ...fake, mode: 'live' }));
  assert.deepEqual(sim.sort(), ['/sim/reset', '/sim/run', '/sim/speed', '/sim/stop', '/telemetry'].sort());
  assert.deepEqual(liveRoutes.sort(), ['/sim/*', '/telemetry'].sort(), '/sim/* in live mode only answers 404');
  for (const p of [...sim, ...liveRoutes]) {
    assert.doesNotMatch(p, /switch|relay|isolat|command|trip|close|open/i, `unexpected control-like route ${p}`);
  }
});

test('the server code contains no outgoing network client (it cannot send anything to a device)', () => {
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(config.projectRoot, 'server'));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\bfetch\(|http\.request|https\.request|net\.connect|dgram|serialport|mqtt/i, `outgoing client found in ${f}`);
  }
});
