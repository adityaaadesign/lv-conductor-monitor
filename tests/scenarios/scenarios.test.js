// Every simulator scenario is run instantly (virtual clock) and checked against the
// "expect" block in its JSON file: state sequence, exact event counts, event fields,
// final status. Running each twice also proves the results are repeatable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios } from '../../server/simulation/simulator.js';
import { runScenario, checkExpectations } from '../../server/simulation/headless.js';
import { testConfig, memoryRepo, quietLogger } from '../helpers.js';
import { checkPasses } from '../../shared/simple.js';

const config = testConfig();
const scenarios = loadScenarios();

test('all required scenario types exist', () => {
  const ids = scenarios.map((s) => s.id);
  for (const id of ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18']) {
    assert.ok(ids.includes(id), `missing scenario ${id}`);
  }
});

for (const sc of scenarios) {
  test(`${sc.id} – ${sc.title}`, () => {
    const r = runScenario(sc, { config, repo: memoryRepo(), logger: quietLogger });
    const failures = checkExpectations(sc, r);
    assert.deepEqual(failures, [], failures.join('\n'));
    // No event may be duplicated: at most one OPEN event per dedupe key.
    const openKeys = r.events.filter((e) => e.status === 'OPEN' && e.dedupe_key).map((e) => e.dedupe_key);
    assert.equal(new Set(openKeys).size, openKeys.length, 'duplicate open events');
    // Simulated data is always labelled as such.
    assert.ok(r.events.every((e) => e.source === 'SIMULATED'));
    assert.equal(r.status.source, 'SIMULATED');
  });
}

// The dashboard's test buttons show a "what you should see" checklist. The same
// checklist must pass at the end of each button scenario.
test('every test-button checklist passes at the end of its scenario', () => {
  const withButtons = scenarios.filter((s) => s.button);
  assert.deepEqual(withButtons.map((s) => s.id).sort(), ['S01', 'S15', 'S16', 'S17', 'S18']);
  for (const sc of withButtons) {
    const r = runScenario(sc, { config, repo: memoryRepo(), logger: quietLogger });
    for (const check of sc.button.checks) {
      assert.ok(checkPasses(check, r.status), `${sc.id}: "${check.text}" did not pass`);
    }
  }
});

test('scenarios are deterministic: two runs give identical transitions and events', () => {
  for (const sc of scenarios) {
    const a = runScenario(sc, { config, repo: memoryRepo(), logger: quietLogger });
    const b = runScenario(sc, { config, repo: memoryRepo(), logger: quietLogger });
    assert.deepEqual(a.transitions.map((t) => [t.at, t.to]), b.transitions.map((t) => [t.at, t.to]), sc.id);
    assert.deepEqual(a.events.map((e) => [e.event_type, e.start_ts, e.end_ts]), b.events.map((e) => [e.event_type, e.start_ts, e.end_ts]), sc.id);
  }
});

test('the isolated state is never shown without OPEN feedback in any scenario', () => {
  for (const sc of scenarios) {
    const r = runScenario(sc, { config, repo: memoryRepo(), logger: quietLogger });
    const timeline = r.events.flatMap((e) => (e.event_type.includes('INTERRUPTION') ? [e] : []));
    for (const e of timeline) {
      if (e.isolation_confirmed === 'CONFIRMED') {
        const full = r.pipeline.repo.getEvent(e.event_id);
        assert.ok(full.timeline.some((t) => t.kind === 'ISOLATION_CONFIRMED' && t.details.feedback === 'OPEN'), sc.id);
      }
    }
    if (sc.controller?.feedback === 'NOT_FITTED' || sc.controller?.relay_fault) assert.ok(!r.states.includes('ISOLATED'), sc.id);
  }
});
