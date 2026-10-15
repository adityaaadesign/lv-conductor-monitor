// Run a scenario instantly (virtual clock) against a fresh pipeline and check its
// "expect" block. Used by the automated tests and by `npm run scenario -- S04`.

import { Pipeline } from '../processing/pipeline.js';
import { runScenarioHeadless } from './simulator.js';
import { DataSource } from '../../shared/enums.js';

export const HEADLESS_START = Date.UTC(2026, 0, 1, 0, 0, 0);

export function runScenario(scenario, { config, repo, startTime = HEADLESS_START, logger = console }) {
  const transitions = [];
  const pipeline = new Pipeline({
    config,
    repo,
    source: DataSource.SIMULATED,
    logger,
    onStatus: (_status, actions) => {
      for (const a of actions) if (a.kind === 'TRANSITION') transitions.push(a);
    },
  });
  pipeline.start(startTime);
  const sim = runScenarioHeadless({ scenario, pipeline, config, startTime });
  const events = repo.queryEvents({ source: DataSource.SIMULATED, limit: 1000 }).items.reverse();
  return {
    pipeline,
    sim,
    startTime,
    transitions,
    states: ['INITIALIZING', ...transitions.map((t) => t.to)],
    events,
    status: pipeline.getStatus(),
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Returns a list of human-readable failures (empty = scenario behaved as specified).
export function checkExpectations(scenario, result) {
  const exp = scenario.expect ?? {};
  const failures = [];

  if (exp.states && !same(result.states, exp.states)) {
    failures.push(`states: expected ${exp.states.join(' → ')}\n           got      ${result.states.join(' → ')}`);
  }
  for (const s of exp.never_states ?? []) {
    if (result.states.includes(s)) failures.push(`state ${s} must never occur`);
  }

  if (exp.events) {
    const counts = {};
    for (const e of result.events) counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
    const types = new Set([...Object.keys(counts), ...Object.keys(exp.events)]);
    for (const t of types) {
      const want = exp.events[t] ?? 0;
      const got = counts[t] ?? 0;
      if (want !== got) failures.push(`events: expected ${want} × ${t}, got ${got}`);
    }
  }

  for (const c of exp.event_checks ?? []) {
    const e = result.events.find((x) => x.event_type === c.event_type);
    if (!e) { failures.push(`event_checks: no ${c.event_type} event`); continue; }
    const actual = e[c.field];
    if ('equals' in c && !same(actual, c.equals)) {
      failures.push(`${c.event_type}.${c.field}: expected ${JSON.stringify(c.equals)}, got ${JSON.stringify(actual)}`);
    }
    if ('includes' in c && !(Array.isArray(actual) && actual.includes(c.includes))) {
      failures.push(`${c.event_type}.${c.field}: expected to include ${c.includes}, got ${JSON.stringify(actual)}`);
    }
    if ('relative_equals' in c) {
      const rel = actual === null ? null : actual - result.startTime;
      if (rel !== c.relative_equals) failures.push(`${c.event_type}.${c.field}: expected t0+${c.relative_equals} ms, got t0+${rel} ms`);
    }
  }

  for (const [field, want] of Object.entries(exp.final_status ?? {})) {
    if (!same(result.status[field], want)) {
      failures.push(`final status ${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(result.status[field])}`);
    }
  }

  if (exp.diagnostics) {
    const ctrl = result.status.controllers[0];
    if ('late' in exp.diagnostics && ctrl.late_count !== exp.diagnostics.late) {
      failures.push(`late reports: expected ${exp.diagnostics.late}, got ${ctrl.late_count}`);
    }
    if ('duplicates' in exp.diagnostics && ctrl.duplicate_count !== exp.diagnostics.duplicates) {
      failures.push(`duplicate reports: expected ${exp.diagnostics.duplicates}, got ${ctrl.duplicate_count}`);
    }
  }
  return failures;
}
