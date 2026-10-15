// HTTP API end-to-end: a real server on a spare port with a temporary data directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../server/app.js';
import { testConfig, quietLogger } from '../helpers.js';

const config = testConfig();
let dir;
let server;
let base;

async function startServer(mode = 'sim') {
  const s = createServer({ config, mode, dataDir: dir, logger: quietLogger, autoStart: false });
  const addr = await s.start(0, '127.0.0.1');
  return { s, base: `http://127.0.0.1:${addr.port}` };
}
const getJson = async (url) => {
  const r = await fetch(url);
  return { status: r.status, body: await r.json() };
};
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lvapi-'));
  ({ s: server, base } = await startServer());
  // Run S04 instantly by advancing the simulator well ahead of the real-time loop.
  assert.equal((await post(`${base}/api/v1/sim/run`, { scenario_id: 'S04' })).status, 200);
  server.simulator.advanceTo(server.simulator.cursor + 30_000);
});

after(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('simulated and live data use separate database files', () => {
  assert.ok(existsSync(path.join(dir, 'sim.db')));
  assert.ok(!existsSync(path.join(dir, 'live.db')));
});

test('status shows the simulated interruption, held location and confirmed isolation', async () => {
  const { body } = await getJson(`${base}/api/v1/status`);
  assert.equal(body.mode, 'sim');
  assert.equal(body.source, 'SIMULATED');
  assert.equal(body.status, 'ISOLATED');
  assert.equal(body.affected_section, 'S-AB');
  assert.equal(body.localization_status, 'FROZEN');
  assert.equal(body.isolation_feedback_state, 'OPEN');
  assert.ok(body.explanation.length > 0);
});

test('event history: list, filter, search, detail with timeline', async () => {
  const all = await getJson(`${base}/api/v1/events`);
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 1);
  const e = all.body.items[0];
  assert.equal(e.event_type, 'INTERRUPTION_SUSPECTED');
  assert.equal(e.event_label, 'EV-000001');
  assert.match(e.start_timestamp, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal((await getJson(`${base}/api/v1/events?node=N-B`)).body.total, 1);
  assert.equal((await getJson(`${base}/api/v1/events?node=N-A`)).body.total, 0);
  assert.equal((await getJson(`${base}/api/v1/events?severity=INFO`)).body.total, 0);
  assert.equal((await getJson(`${base}/api/v1/events?q=EV-000001`)).body.total, 1);
  assert.equal((await getJson(`${base}/api/v1/events?q=S-AB`)).body.total, 1);
  assert.equal((await getJson(`${base}/api/v1/events?to=2000-01-01T00:00:00Z`)).body.total, 0);
  const detail = await getJson(`${base}/api/v1/events/${e.event_id}`);
  assert.deepEqual(detail.body.timeline.map((t) => t.kind), ['DETECTED', 'ISOLATION_REQUESTED', 'ISOLATION_CONFIRMED']);
});

test('bad query parameters are rejected with 400, unknown ids with 404', async () => {
  assert.equal((await fetch(`${base}/api/v1/events?severity=BOGUS`)).status, 400);
  assert.equal((await fetch(`${base}/api/v1/events?node=N-ZZ`)).status, 400);
  assert.equal((await fetch(`${base}/api/v1/events?from=yesterday`)).status, 400);
  assert.equal((await fetch(`${base}/api/v1/events/9999`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/nope`)).status, 404);
});

test('CSV export contains the events and labels them as simulated', async () => {
  const r = await fetch(`${base}/api/v1/events.csv`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /events-SIMULATED-/);
  const lines = (await r.text()).trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('source,event_id,event_type'));
  assert.ok(lines[1].startsWith('SIMULATED,EV-000001,INTERRUPTION_SUSPECTED'));
});

test('measurements, diagnostics and config endpoints', async () => {
  const st = (await getJson(`${base}/api/v1/status`)).body;
  const m = await getJson(`${base}/api/v1/measurements?from=${st.server_now - 40_000}&to=${st.server_now}`);
  assert.equal(m.status, 200);
  assert.ok(m.body.series['N-A'].points.length > 20);
  assert.ok(m.body.transitions.some((t) => t.to_state === 'ISOLATED'));
  const d = await getJson(`${base}/api/v1/diagnostics`);
  assert.ok(d.body.counters.accepted > 20);
  const c = await getJson(`${base}/api/v1/config`);
  assert.ok(c.body.placeholders.length > 10);
  assert.equal(c.body.supervisory_requests_enabled, false);
});

test('real-device telemetry is refused in demo mode; simulation inputs are validated', async () => {
  const t = await post(`${base}/api/v1/telemetry`, { controller_id: 'CTRL-01' });
  assert.equal(t.status, 409);
  assert.equal((await t.json()).error, 'SERVER_IN_SIMULATION_MODE');
  assert.equal((await post(`${base}/api/v1/sim/run`, { scenario_id: 'S99' })).status, 400);
  assert.equal((await post(`${base}/api/v1/sim/run`, { scenario_id: 'S01', speed: 1000 })).status, 400);
  const big = await fetch(`${base}/api/v1/sim/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(20000) }) });
  assert.equal(big.status, 413);
});

test('live updates stream sends the current status first', async () => {
  const ctrl = new AbortController();
  const r = await fetch(`${base}/api/v1/stream`, { signal: ctrl.signal });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader();
  let text = '';
  const deadline = Date.now() + 3000;
  while (!text.includes('event: status') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  ctrl.abort();
  assert.ok(text.includes('event: status'));
});

test('a test button (fresh run) closes open events as a demo reset and keeps the history', async () => {
  const before = (await getJson(`${base}/api/v1/events?status=OPEN`)).body.total;
  assert.ok(before >= 1, 'S04 left an open event');
  assert.equal((await post(`${base}/api/v1/sim/run`, { scenario_id: 'S01', fresh: true })).status, 200);
  const open = (await getJson(`${base}/api/v1/events?status=OPEN`)).body.total;
  assert.equal(open, 0);
  const all = (await getJson(`${base}/api/v1/events?exclude_info=1`)).body.items;
  const int = all.find((e) => e.event_type === 'INTERRUPTION_SUSPECTED');
  assert.equal(int.status, 'CLOSED');
  assert.equal(int.end_reason, 'DEMO_RESET');
  server.simulator.advanceTo(server.simulator.cursor + 5_000);
  const st = (await getJson(`${base}/api/v1/status`)).body;
  assert.equal(st.display_status, 'NORMAL');
});

test('repeated page loads (refreshes) never create events', async () => {
  const count = async () => (await getJson(`${base}/api/v1/events`)).body.total;
  const before = await count();
  for (let i = 0; i < 20; i++) {
    await fetch(`${base}/`);
    await getJson(`${base}/api/v1/status`);
    await getJson(`${base}/api/v1/events?limit=8&exclude_info=1`);
  }
  assert.equal(await count(), before);
});

test('events remain available after the application is restarted', async () => {
  const before = (await getJson(`${base}/api/v1/events`)).body.items.map((e) => e.event_id);
  await server.stop();
  ({ s: server, base } = await startServer());
  const afterRestart = (await getJson(`${base}/api/v1/events`)).body.items;
  for (const id of before) assert.ok(afterRestart.some((e) => e.event_id === id), `event ${id} missing after restart`);
  assert.ok(afterRestart.some((e) => e.event_type === 'SERVER_RESTART'));
});

// Regression: the simulated controller used to reuse its boot ID on every start, so after
// a restart all its reports were treated as late and the dashboard never left UNKNOWN.
test('after a restart, a newly started scenario is accepted (not mistaken for old data)', async () => {
  assert.equal((await post(`${base}/api/v1/sim/run`, { scenario_id: 'S01' })).status, 200);
  server.simulator.advanceTo(server.simulator.cursor + 5_000);
  const d = (await getJson(`${base}/api/v1/diagnostics`)).body;
  assert.ok(d.counters.accepted >= 4, `accepted ${d.counters.accepted}, late ${d.counters.late}`);
  assert.equal(d.counters.late, 0);
  assert.equal((await getJson(`${base}/api/v1/status`)).body.display_status, 'NORMAL');
});

// Requirement changed: device input used to answer 501 "not enabled". It is now
// implemented, but stays LOCKED (401) until device keys are configured. The full live
// path is tested in live-telemetry.test.js.
test('live mode uses its own database; with no device keys all device reports are refused', async () => {
  const live = await startServer('live');
  try {
    const st = (await getJson(`${live.base}/api/v1/status`)).body;
    assert.equal(st.source, 'LIVE');
    assert.equal((await getJson(`${live.base}/api/v1/events`)).body.total, 0, 'no simulated events leak into live');
    const t = await post(`${live.base}/api/v1/telemetry`, { controller_id: 'CTRL-01' });
    assert.equal(t.status, 401);
    assert.equal((await t.json()).details[0].problem, 'NO_DEVICE_KEYS_CONFIGURED_ON_SERVER');
    assert.equal((await fetch(`${live.base}/api/v1/sim/scenarios`)).status, 404);
  } finally {
    await live.s.stop();
  }
});
