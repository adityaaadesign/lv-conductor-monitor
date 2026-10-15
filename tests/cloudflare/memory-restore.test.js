// The Worker keeps no memory between requests: it saves the pipeline memory to D1 and
// restores it on the next request. This test runs all 18 scenarios twice – once normally,
// once with the memory saved, turned into text and restored before EVERY step – and checks
// that both runs give exactly the same states, events and final status. If a field were
// missing from exportMemory()/importMemory(), the two runs would differ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Pipeline } from '../../server/processing/pipeline.js';
import { runScenarioHeadless } from '../../server/simulation/simulator.js';
import { runScenario, HEADLESS_START } from '../../server/simulation/headless.js';
import { DataSource } from '../../shared/enums.js';
import { encodeSnapshot, decodeSnapshot } from '../../cloudflare/src/snapshot.js';
import { testConfig, memoryRepo, quietLogger } from '../helpers.js';

const dir = path.resolve(import.meta.dirname, '../../server/simulation/scenarios');
const scenarios = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
const config = testConfig();

function runWithRestoreEveryStep(scenario) {
  const repo = memoryRepo();
  const transitions = [];
  const make = () => new Pipeline({
    config, repo, source: DataSource.SIMULATED, logger: quietLogger,
    onStatus: (_s, actions) => { for (const a of actions) if (a.kind === 'TRANSITION') transitions.push(a); },
  });
  let p = make();
  p.start(HEADLESS_START);
  let restores = 0;
  const restore = () => {
    const memory = decodeSnapshot(encodeSnapshot(p.exportMemory()));
    p = make();
    p.importMemory(memory);
    restores++;
  };
  const wrapper = {
    ingestReport(report, t) { restore(); return p.ingestReport(report, t); },
    tick(t) { restore(); return p.tick(t); },
  };
  runScenarioHeadless({ scenario, pipeline: wrapper, config, startTime: HEADLESS_START });
  return {
    restores,
    states: ['INITIALIZING', ...transitions.map((t) => t.to)],
    events: repo.queryEvents({ source: DataSource.SIMULATED, limit: 1000 }).items.reverse(),
    status: p.getStatus(),
  };
}

const strip = (events) => events.map(({ created_ts, updated_ts, ...e }) => e);

for (const sc of scenarios) {
  test(`${sc.id}: same result when the memory is saved and restored before every step`, () => {
    const normal = runScenario(sc, { config, repo: memoryRepo(), logger: quietLogger });
    const restored = runWithRestoreEveryStep(sc);
    assert.ok(restored.restores > 50);
    assert.deepEqual(restored.states, normal.states);
    assert.deepEqual(strip(restored.events), strip(normal.events));
    assert.deepEqual(JSON.parse(JSON.stringify(restored.status)), JSON.parse(JSON.stringify(normal.status)));
  });
}

test('snapshot text keeps Map, Set and Infinity', () => {
  const v = { m: new Map([['a', new Set([1, 2])]]), x: Infinity, y: -Infinity, n: null, list: [1, { k: 2 }] };
  const back = decodeSnapshot(encodeSnapshot(v));
  assert.ok(back.m instanceof Map);
  assert.ok(back.m.get('a') instanceof Set);
  assert.deepEqual([...back.m.get('a')], [1, 2]);
  assert.equal(back.x, Infinity);
  assert.equal(back.y, -Infinity);
  assert.deepEqual(back.list, [1, { k: 2 }]);
});
