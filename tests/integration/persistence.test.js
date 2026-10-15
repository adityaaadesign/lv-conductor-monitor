// Persistence across application restarts, using a real database file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../server/storage/db.js';
import { Repository } from '../../server/storage/repository.js';
import { Pipeline } from '../../server/processing/pipeline.js';
import { Simulator } from '../../server/simulation/simulator.js';
import { loadScenarios } from '../../server/simulation/scenario-files.js';
import { testConfig, makeReport, protection, quietLogger, T0 } from '../helpers.js';

const config = testConfig();
const S04 = loadScenarios().find((s) => s.id === 'S04');

const openDbs = new Set();
function closeAll() { for (const db of openDbs) { try { db.close(); } catch { /* already closed */ } } openDbs.clear(); }

function openPipeline(file, start) {
  const db = openDatabase(file);
  openDbs.add(db);
  const repo = new Repository(db);
  const transitions = [];
  const pipeline = new Pipeline({
    config, repo, source: 'SIMULATED', logger: quietLogger,
    onStatus: (_s, actions) => { for (const a of actions) if (a.kind === 'TRANSITION') transitions.push(a.to); },
  });
  pipeline.start(start);
  return { db, repo, pipeline, transitions };
}

function runFirstLife(file) {
  const a = openPipeline(file, T0);
  const sim = new Simulator({ config, pipeline: a.pipeline, startTime: T0 });
  sim.start(S04);
  sim.advanceTo(T0 + 25_000);   // break at 10 s, isolated by 12 s
  const session = a.repo.latestSessions()[0];
  const events = a.repo.queryEvents({ source: 'SIMULATED', limit: 100 }).items;
  a.db.close();
  return { session, events };
}

const dead = { 'N-A': 0.2, 'N-B': 0.3, 'N-C': 0.2 };
const normal = { 'N-A': 229, 'N-B': 227, 'N-C': 226 };

test('an open event survives a restart and is continued, not duplicated', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lvmon-'));
  const file = path.join(dir, 'sim.db');
  try {
    const first = runFirstLife(file);
    const intBefore = first.events.find((e) => e.event_type === 'INTERRUPTION_SUSPECTED');
    assert.equal(intBefore.status, 'OPEN');

    // Second life: server restarted 60 s later; the controller is still isolating.
    const restartAt = T0 + 85_000;
    const b = openPipeline(file, restartAt);
    let seq = first.session.last_sequence + 1;
    let t = restartAt;
    for (let i = 0; i < 20; i++) {
      t += 1000;
      b.pipeline.ingestReport(makeReport({ boot: first.session.boot_id, seq: seq++, uptime: t - T0, nodes: dead, protection: protection({ commanded: true, feedback: 'OPEN' }) }), t);
      b.pipeline.tick(t + 250);
    }
    const events = b.repo.queryEvents({ source: 'SIMULATED', limit: 100 }).items;
    const ints = events.filter((e) => e.event_type === 'INTERRUPTION_SUSPECTED');
    assert.equal(ints.length, 1, 'still exactly one interruption event');
    assert.equal(ints[0].event_id, intBefore.event_id, 'same event continued');
    assert.equal(ints[0].status, 'OPEN');
    assert.equal(b.pipeline.getStatus().status, 'ISOLATED');
    assert.equal(events.filter((e) => e.event_type === 'SERVER_RESTART').length, 1);
    assert.equal(events.filter((e) => e.event_type === 'CONTROLLER_REBOOT').length, 0, 'same boot continues â€“ not a reboot');
    const full = b.repo.getEvent(intBefore.event_id);
    assert.equal(full.timeline.filter((x) => x.kind === 'ISOLATION_REQUESTED').length, 1, 'isolation request not logged twice');
    b.db.close();
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a condition that cleared while the server was down is closed with an APPROXIMATE end time', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lvmon-'));
  const file = path.join(dir, 'sim.db');
  try {
    const first = runFirstLife(file);
    const restartAt = T0 + 300_000;
    const b = openPipeline(file, restartAt);
    let t = restartAt;
    for (let i = 0; i < 12; i++) {
      t += 1000;
      b.pipeline.ingestReport(makeReport({ boot: 'newboot1', seq: i, uptime: i * 1000 + 1000, nodes: normal, protection: protection() }), t);
      b.pipeline.tick(t + 250);
    }
    const e = b.repo.queryEvents({ source: 'SIMULATED', type: 'INTERRUPTION_SUSPECTED', limit: 10 }).items[0];
    assert.equal(e.event_id, first.events.find((x) => x.event_type === 'INTERRUPTION_SUSPECTED').event_id);
    assert.equal(e.status, 'CLOSED');
    assert.equal(e.end_ts_quality, 'APPROXIMATE');
    assert.equal(e.end_reason, 'CLEARED_WHILE_SERVER_DOWN');
    assert.equal(b.repo.queryEvents({ source: 'SIMULATED', type: 'CONTROLLER_REBOOT', limit: 10 }).total, 1, 'new boot ID is recorded');
    b.db.close();
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('measurement history and last values persist; the dashboard gets them as "stored before restart"', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lvmon-'));
  const file = path.join(dir, 'sim.db');
  try {
    runFirstLife(file);
    const b = openPipeline(file, T0 + 100_000);
    const series = b.repo.measurementSeries({ nodeIds: ['N-A'], from: T0, to: T0 + 30_000, source: 'SIMULATED' });
    assert.ok(series['N-A'].points.length >= 25);
    const nodeA = b.pipeline.getStatus().nodes[0];
    assert.equal(nodeA.validity, 'NEVER_SEEN', 'no live data yet in the new run');
    assert.equal(nodeA.last_valid_from_history, true);
    assert.notEqual(nodeA.last_valid_voltage_rms, null);
    b.db.close();
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate reports re-sent after a restart do not create events', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lvmon-'));
  const file = path.join(dir, 'sim.db');
  try {
    const first = runFirstLife(file);
    const b = openPipeline(file, T0 + 30_000);
    const before = b.repo.queryEvents({ source: 'SIMULATED', limit: 100 }).total;
    // Re-send old sequence numbers (e.g. a controller replaying its buffer).
    for (let s = first.session.last_sequence - 5; s <= first.session.last_sequence; s++) {
      const r = b.pipeline.ingestReport(makeReport({ boot: first.session.boot_id, seq: s, uptime: (s + 1) * 1000, nodes: dead, protection: protection({ commanded: true, feedback: 'OPEN' }) }), T0 + 30_500);
      assert.equal(r.accepted, true);
      assert.equal(r.late, true);
    }
    assert.equal(b.repo.queryEvents({ source: 'SIMULATED', limit: 100 }).total, before);
    b.db.close();
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
