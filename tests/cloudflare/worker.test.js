// The Cloudflare Worker backend (cloudflare/src/app.js), run in Node with a D1 test double
// (fake-d1.js) and a hand-driven clock. This proves the Worker logic; it does NOT prove that
// the deployment on Cloudflare works – that is only tested by deploying it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../../cloudflare/src/app.js';
import { FakeD1 } from './fake-d1.js';
import { quietLogger, T0 } from '../helpers.js';

const root = path.resolve(import.meta.dirname, '../..');
const readJson = (f) => JSON.parse(readFileSync(path.join(root, f), 'utf8'));
const files = { feeder: readJson('config/feeder.json'), detection: readJson('config/detection.json'), server: readJson('config/server.json') };
const MIGRATION = readFileSync(path.join(root, 'cloudflare/migrations/0001_initial.sql'), 'utf8');
const KEY = 'cloud-test-key-0123456789';
const DASH = 'https://lv-conductor-monitor.vercel.app';

function setup({ keys = `CTRL-01=${KEY}`, db } = {}) {
  const d1 = db ?? new FakeD1();
  if (!db) d1.execSync(MIGRATION);
  const clock = { t: T0 };
  const env = {
    DB: d1, DEVICE_KEYS: keys, ALLOWED_ORIGINS: DASH,
    REPORT_INTERVAL_MS: '5000', STALE_AFTER_MS: '12000', OFFLINE_AFTER_MS: '30000', CONTROLLER_OFFLINE_AFTER_MS: '30000',
    DASHBOARD_REFRESH_MS: '5000',
  };
  const app = createApp({ files, now: () => clock.t, logger: quietLogger });
  const call = async (method, p, { body, headers = {} } = {}) => {
    const init = { method, headers };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await app.fetch(new Request(`https://lv-monitor-api.example.workers.dev${p}`, init), env);
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
  let seq = 0;
  const send = (nodes, { key = KEY, boot = 'cfboot01', s = seq++ } = {}) => call('POST', '/api/v1/telemetry', {
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Device-Key': key } : {}) },
    body: {
      schema_version: '1.0', controller_id: 'CTRL-01', boot_id: boot, sequence_number: s, uptime_ms: (s + 1) * 5000,
      device_time: null, time_synced: false, firmware_version: 'test', report_interval_ms: 5000,
      nodes: Object.entries(nodes).map(([id, v]) => ({ node_id: id, voltage_rms: v, supply_present: v > 23, data_valid: true, sensor_status: 'OK' })),
      protection: null,
    },
  });
  const status = async () => (await call('GET', '/api/v1/status')).body;
  const node = (s, id) => s.nodes.find((n) => n.node_id === id);
  return { d1, env, app, call, send, status, node, clock, advance: (ms) => { clock.t += ms; } };
}

const ALL = { 'N-A': 229, 'N-B': 227, 'N-C': 226 };
const AB = { 'N-A': 229, 'N-B': 227 };

test('telemetry: a valid report is accepted, stored in D1 and shown in /status', async () => {
  const w = setup();
  const r = await w.send(ALL);
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted, true);
  assert.equal(r.body.duplicate, false);

  const rows = w.d1.rows('SELECT * FROM measurements');
  assert.equal(rows.length, 1, 'one row per report');
  const stored = JSON.parse(rows[0].nodes);
  assert.deepEqual(stored.map((n) => [n.node_id, n.voltage_rms, n.validity]), [['N-A', 229, 'VALID'], ['N-B', 227, 'VALID'], ['N-C', 226, 'VALID']]);
  assert.equal(rows[0].source, 'LIVE');

  w.advance(1000);
  const s = await w.status();
  assert.equal(s.mode, 'live');
  assert.equal(w.node(s, 'N-A').validity, 'VALID');
  assert.equal(w.node(s, 'N-A').last_valid_voltage_rms, 229);

  const again = await w.send(ALL, { s: 0 });
  assert.equal(again.body.duplicate, true);
  assert.equal(w.d1.rows('SELECT * FROM measurements').length, 1, 'a repeated report is not stored twice');
});

test('authentication: missing, wrong or unconfigured key → 401 and nothing stored', async () => {
  const w = setup();
  const none = await w.send(ALL, { key: null });
  assert.equal(none.status, 401);
  assert.equal(none.body.details[0].problem, 'MISSING_OR_WRONG_KEY');
  const wrong = await w.send(ALL, { key: 'cloud-test-key-WRONG-6789' });
  assert.equal(wrong.status, 401);
  const shorter = await w.send(ALL, { key: 'cloud-test-key' });
  assert.equal(shorter.status, 401);
  assert.equal(w.d1.rows('SELECT * FROM measurements').length, 0);
  assert.equal(w.d1.rows('SELECT * FROM pipeline_state').length, 0);

  const locked = setup({ keys: '' });
  const r = await locked.send(ALL);
  assert.equal(r.status, 401);
  assert.equal(r.body.details[0].problem, 'NO_DEVICE_KEYS_CONFIGURED_ON_SERVER');

  const typo = setup({ keys: 'CTRL-01=short' });
  assert.equal((await typo.send(ALL)).status, 500, 'a wrong DEVICE_KEYS setting is reported, never accepted');
  assert.equal((await typo.call('GET', '/api/v1/status')).status, 200, 'the dashboard still works');
});

test('validation: malformed, invalid and oversized reports are refused with details', async () => {
  const w = setup();
  const bad = await w.call('POST', '/api/v1/telemetry', { headers: { 'X-Device-Key': KEY }, body: '{"controller_id": "CTRL-01", oops' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'MALFORMED_JSON');

  const r = await w.send({ 'N-A': 'two hundred' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'VALIDATION_FAILED');
  assert.ok(r.body.details.some((d) => d.field === 'nodes[0].voltage_rms'));
  assert.equal(w.d1.rows('SELECT * FROM measurements').length, 0);
  assert.equal(w.d1.rows('SELECT * FROM ingest_rejections').length, 1, 'the refusal is logged');

  const big = await w.call('POST', '/api/v1/telemetry', { headers: { 'X-Device-Key': KEY }, body: `{"x":"${'a'.repeat(17000)}"}` });
  assert.equal(big.status, 413);
});

test('a node that stops reporting goes STALE, then OFFLINE – never 0 V, never a confirmed break', async () => {
  const w = setup();
  // All three nodes report every 5 s for 20 s, then Node C goes silent while A and B continue.
  for (let i = 0; i < 4; i++) { assert.equal((await w.send(ALL)).status, 200); w.advance(5000); }
  const lastC = w.clock.t - 5000;
  let s = await w.status();
  assert.equal(w.node(s, 'N-C').validity, 'VALID');
  assert.equal(s.display_status, 'NORMAL');

  const seen = [];
  for (let i = 0; i < 9; i++) {
    await w.send(AB);
    w.advance(5000);
    s = await w.status();
    const c = w.node(s, 'N-C');
    seen.push(c.validity);
    const age = w.clock.t - lastC;
    if (age <= 12000) assert.equal(c.validity, 'VALID', `age ${age}`);
    else if (age <= 30000) assert.equal(c.validity, 'STALE', `age ${age}`);
    else assert.equal(c.validity, 'OFFLINE', `age ${age}`);
    assert.equal(c.display_state, age <= 12000 ? 'NORMAL' : 'NO_DATA');
    assert.notEqual(s.display_status, 'FAULT_SUSPECTED', 'missing data is not a conductor break');
    assert.equal(s.affected_section, null);
    assert.equal(w.node(s, 'N-A').validity, 'VALID');
  }
  assert.ok(seen.includes('STALE') && seen.includes('OFFLINE'));
  assert.equal(s.display_status, 'DEGRADED_UNKNOWN');

  // The "Node offline" event is in the D1 history and appears in /events.
  const offline = w.d1.rows("SELECT * FROM events WHERE event_type = 'NODE_OFFLINE'");
  assert.equal(offline.length, 1);
  assert.equal(offline[0].status, 'OPEN');
  assert.equal(JSON.parse(offline[0].node_ids)[0], 'N-C');
  const ev = (await w.call('GET', '/api/v1/events?limit=50&exclude_info=1')).body;
  assert.ok(ev.items.some((e) => e.event_type === 'NODE_OFFLINE'));
  // No stored reading for Node C after it went silent – nothing is filled in as 0 V.
  for (const row of w.d1.rows('SELECT nodes FROM measurements ORDER BY id').slice(4)) {
    assert.ok(!JSON.parse(row.nodes).some((n) => n.node_id === 'N-C'));
  }
});

test('with no reports and no visitors, the cron check records the controller as offline', async () => {
  const w = setup();
  await w.send(ALL);
  w.advance(5000);
  await w.send(ALL);
  for (let m = 0; m < 2; m++) { w.advance(60_000); await w.app.scheduled({ scheduledTime: w.clock.t }, w.env); }
  const ev = w.d1.rows("SELECT event_type, status FROM events WHERE event_type = 'CONTROLLER_COMM_LOST'");
  assert.deepEqual(ev.map((e) => ({ ...e })), [{ event_type: 'CONTROLLER_COMM_LOST', status: 'OPEN' }]);
  const s = await w.status();
  for (const n of s.nodes) assert.notEqual(n.validity, 'VALID');
  assert.equal(s.display_status, 'DEGRADED_UNKNOWN');
});

test('persistence: a fresh Worker instance continues from the data in D1', async () => {
  const first = setup();
  for (let i = 0; i < 3; i++) { await first.send(ALL); first.advance(5000); }
  for (let i = 0; i < 8; i++) { await first.send(AB); first.advance(5000); }
  const before = await first.status();
  const offlineEvent = (await first.call('GET', '/api/v1/events')).body.items.find((e) => e.event_type === 'NODE_OFFLINE');
  assert.ok(offlineEvent);

  // New Worker instance (as after a Cloudflare restart or on another machine): only D1 is shared.
  const second = setup({ db: first.d1 });
  second.clock.t = first.clock.t;
  const after = await second.status();
  assert.deepEqual(after.nodes.map((n) => [n.node_id, n.validity, n.last_valid_voltage_rms]),
    before.nodes.map((n) => [n.node_id, n.validity, n.last_valid_voltage_rms]));
  assert.equal(after.display_status, before.display_status);
  const detail = (await second.call('GET', `/api/v1/events/${offlineEvent.event_id}`)).body;
  assert.equal(detail.event_type, 'NODE_OFFLINE');
  assert.equal(second.d1.rows('SELECT * FROM measurements').length, 11);
  // The report counter survived too: an old report number is still a duplicate.
  const dup = await second.send(ALL, { s: 2 });
  assert.equal(dup.body.duplicate, true);
  // Node C reporting again brings it back.
  await second.send(ALL, { s: 100 });
  assert.equal(second.node(await second.status(), 'N-C').validity, 'VALID');
});

test('two reports at the same moment: both are kept (the later save retries)', async () => {
  const w = setup();
  await w.send(ALL);
  w.advance(5000);
  const [a, b] = await Promise.all([w.send(ALL), w.send(ALL)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(w.d1.rows('SELECT * FROM measurements').length, 3);
  assert.ok(w.d1.failedBatches >= 1, 'the conflict was detected and retried');
  assert.equal(w.d1.rows('SELECT version FROM pipeline_state')[0].version, 3);
});

test('CORS: only the configured dashboard address may read the API; browsers cannot send telemetry', async () => {
  const w = setup();
  const ok = await w.call('GET', '/api/v1/status', { headers: { Origin: DASH } });
  assert.equal(ok.headers.get('access-control-allow-origin'), DASH);
  const other = await w.call('GET', '/api/v1/status', { headers: { Origin: 'https://someone-else.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const pre = await w.call('OPTIONS', '/api/v1/events', { headers: { Origin: DASH, 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
  assert.doesNotMatch(pre.headers.get('access-control-allow-headers'), /device-key/i);
});

test('health, config (polling, dial range) and LIVE-only behaviour', async () => {
  const w = setup();
  const h = (await w.call('GET', '/api/v1/health')).body;
  assert.equal(h.ok, true);
  assert.equal(h.mode, 'live');
  assert.equal(h.database_ok, true);
  const c = (await w.call('GET', '/api/v1/config')).body;
  assert.deepEqual(c.live_updates, { method: 'poll', interval_ms: 5000 });
  assert.deepEqual(c.gauge, { min_v: 0, max_v: 300 });
  assert.equal(c.detection.stale_after_ms, 12000);
  assert.equal(c.detection.offline_after_ms, 30000);
  assert.ok(c.placeholders.some((p) => p.path === 'detection.stale_after_ms'), 'cloud timing is labelled as a placeholder');
  assert.equal(c.simulation, null);
  assert.equal((await w.call('POST', '/api/v1/sim/run', { body: {} })).status, 404, 'no demo controls in the cloud');
  assert.equal((await w.call('GET', '/api/v1/sim/scenarios')).status, 404);
});

test('cron housekeeping deletes readings older than the retention period', async () => {
  const w = setup();
  await w.send(ALL);
  w.advance(15 * 24 * 3600 * 1000);
  w.clock.t -= w.clock.t % 3600_000;   // on the hour
  await w.send(ALL);
  await w.app.scheduled({ scheduledTime: w.clock.t }, w.env);
  assert.equal(w.d1.rows('SELECT * FROM measurements').length, 1);
});

test('detection still works with one report every 5 s (line interruption and low voltage)', async () => {
  const brk = setup();
  for (let i = 0; i < 3; i++) { await brk.send(ALL); brk.advance(5000); }
  await brk.send({ 'N-A': 229, 'N-B': 0.3, 'N-C': 0.2 });   // valid readings: B and C have no supply
  brk.advance(5000);
  await brk.send({ 'N-A': 229, 'N-B': 0.3, 'N-C': 0.2 });
  brk.advance(1000);
  let s = await brk.status();
  assert.equal(s.display_status, 'FAULT_SUSPECTED');
  assert.equal(s.affected_section, 'S-AB');
  assert.equal(brk.node(s, 'N-B').display_state, 'NO_SUPPLY');
  assert.equal(brk.d1.rows("SELECT * FROM events WHERE event_type = 'INTERRUPTION_SUSPECTED'").length, 1);

  const low = setup();
  for (let i = 0; i < 3; i++) { await low.send(ALL); low.advance(5000); }
  for (let i = 0; i < 2; i++) { await low.send({ ...ALL, 'N-C': 184 }); low.advance(5000); }
  s = await low.status();
  assert.equal(low.node(s, 'N-C').display_state, 'LOW_VOLTAGE');
  assert.equal(low.d1.rows("SELECT * FROM events WHERE event_type = 'UNDERVOLTAGE'").length, 1);
});
