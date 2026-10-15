// The in-browser DEMO (frontend/js/demo-engine.js), run in Node with a hand-driven clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDemoEngine } from '../../frontend/js/demo-engine.js';
import { BROWSER_MODULES, demoDataFiles } from '../../server/demo-assets.js';
import { loadScenarios } from '../../server/simulation/scenario-files.js';
import { checkPasses } from '../../shared/simple.js';
import { T0 } from '../helpers.js';

const root = path.resolve(import.meta.dirname, '../..');

function engine() {
  const data = demoDataFiles(root);
  const clock = { t: T0 };
  const e = createDemoEngine({
    files: { feeder: data['feeder.json'], detection: data['detection.json'], server: data['server.json'] },
    scenarios: JSON.parse(JSON.stringify(data['scenarios.json'])),
    now: () => clock.t,
  });
  return { e, clock, wait: (ms) => { clock.t += ms; e.advance(clock.t); } };
}

test('the browser only needs the listed modules – no Node-only code, no secrets', () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      assert.ok(!spec.startsWith('node:') && !/^[a-z@]/.test(spec), `${path.relative(root, file)} imports "${spec}" (not available in a browser)`);
      if (spec.startsWith('.')) visit(path.resolve(path.dirname(file), spec));
    }
  };
  visit(path.join(root, 'frontend/js/demo-engine.js'));
  const serverFiles = [...seen].map((f) => path.relative(root, f).replaceAll('\\', '/')).filter((f) => f.startsWith('server/'));
  for (const f of serverFiles) assert.ok(BROWSER_MODULES.includes(f), `${f} is needed by the browser demo but not listed in BROWSER_MODULES`);
  for (const f of BROWSER_MODULES) assert.ok(!/routes|app\.js|index\.js|load-config|devices|db\.js/.test(f), f);
  assert.deepEqual(Object.keys(demoDataFiles(root)).sort(), ['detection.json', 'feeder.json', 'scenarios.json', 'server.json']);
});

test('DEMO answers like a demo server and refuses device data', () => {
  const { e } = engine();
  const c = e.request('GET', '/config');
  assert.equal(c.mode, 'sim');
  assert.equal(c.source, 'SIMULATED');
  assert.deepEqual(c.live_updates, { method: 'local' });
  const buttons = e.request('GET', '/sim/scenarios').scenarios.filter((s) => s.button);
  assert.equal(buttons.length, 5);
  assert.throws(() => e.request('POST', '/telemetry', {}, { controller_id: 'CTRL-01' }), (err) => err.status === 409);
  assert.equal(e.request('GET', '/status').source, 'SIMULATED');
});

test('every demo button gives the same result in the browser engine as in the scenario tests', () => {
  const scenarios = loadScenarios().filter((s) => s.button);
  const { e, wait } = engine();
  wait(5000);   // the automatic first scenario runs for a while, like on a real page
  for (const sc of scenarios) {
    e.request('POST', '/sim/run', {}, { scenario_id: sc.id, fresh: true });
    wait(sc.duration_ms + 500);
    const status = e.request('GET', '/status');
    for (const check of sc.button.checks) {
      assert.ok(checkPasses(check, status), `${sc.id}: "${check.text}" did not pass in the browser demo`);
    }
  }
});

test('Node communication failure: Stale Data, then Offline, never 0 V; events, details and CSV work', () => {
  const { e, wait } = engine();
  e.request('POST', '/sim/run', {}, { scenario_id: 'S18', fresh: true });
  wait(8000);
  let c = e.request('GET', '/status').nodes.find((n) => n.node_id === 'N-C');
  assert.equal(c.validity, 'STALE');
  assert.equal(c.display_state, 'NO_DATA');
  wait(8000);
  const s = e.request('GET', '/status');
  c = s.nodes.find((n) => n.node_id === 'N-C');
  assert.equal(c.validity, 'OFFLINE');
  assert.notEqual(s.display_status, 'FAULT_SUSPECTED');
  const list = e.request('GET', '/events', { limit: '50', exclude_info: '1' });
  const off = list.items.find((x) => x.event_type === 'NODE_OFFLINE');
  assert.ok(off);
  assert.equal(e.request('GET', `/events/${off.event_id}`).event_type, 'NODE_OFFLINE');
  assert.match(e.csv(), /NODE_OFFLINE/);
  assert.throws(() => e.request('GET', '/events/99999'), (err) => err.status === 404);
});
