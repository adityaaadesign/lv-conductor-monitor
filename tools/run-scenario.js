// Run one or all simulator scenarios instantly and print the state transitions and
// events. Useful for preparing a demo or showing that results are repeatable.
//
//   npm run scenario            (all scenarios)
//   npm run scenario -- S04     (one scenario, with details)

import { loadConfig } from '../server/config/load-config.js';
import { openDatabase } from '../server/storage/db.js';
import { Repository } from '../server/storage/repository.js';
import { loadScenarios } from '../server/simulation/scenario-files.js';
import { runScenario, checkExpectations } from '../server/simulation/headless.js';

const wanted = process.argv[2]?.toUpperCase();
const config = loadConfig();
const scenarios = loadScenarios().filter((s) => !wanted || s.id === wanted);
if (!scenarios.length) {
  console.error(`No scenario "${wanted}". Available: ${loadScenarios().map((s) => s.id).join(', ')}`);
  process.exit(1);
}

let failed = 0;
for (const sc of scenarios) {
  const repo = new Repository(openDatabase(':memory:'));
  const r = runScenario(sc, { config, repo });
  const failures = checkExpectations(sc, r);
  if (failures.length) failed++;
  console.log(`\n${sc.id}  ${sc.title}  [SIMULATED]  ${failures.length ? 'MISMATCH' : 'as expected'}`);
  if (wanted || failures.length) {
    for (const t of r.transitions) {
      console.log(`  t0+${String((t.at - r.startTime) / 1000).padStart(6)} s  ${t.from.padEnd(22)} → ${t.to.padEnd(22)} ${t.reasons.join(', ')}`);
    }
    for (const e of r.events) {
      const start = e.start_ts !== null ? `t0+${(e.start_ts - r.startTime) / 1000}s` : '';
      console.log(`  EV-${String(e.event_id).padStart(6, '0')} ${e.event_type.padEnd(30)} ${e.severity.padEnd(8)} ${e.status.padEnd(6)} ${start} ${e.affected_section ?? ''}`);
    }
    if (wanted) {
      console.log('\n  Final explanation:');
      for (const line of r.status.explanation) console.log(`   - ${line}`);
    }
  } else {
    console.log(`  ${r.states.join(' → ')}`);
  }
  for (const f of failures) console.log(`  ✗ ${f}`);
}
process.exit(failed ? 1 : 0);
