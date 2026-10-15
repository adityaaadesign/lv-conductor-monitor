// Firmware core logic, tested on the PC (no ESP32 involved):
//   1. compiles firmware/esp32-controller/src/core with g++ and runs its C++ unit tests;
//   2. runs the firmware logic on simulated sine waves (firmware/host-tests/sim_feeder.cpp)
//      and feeds the resulting reports into the REAL server pipeline, so we know the
//      firmware's reports match what the server expects and lead to the right result.
// Skipped (not failed) when no g++ compiler is installed.
// This proves the logic in software only – NOT that the firmware works on real hardware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateReport } from '../../server/ingest/validator.js';
import { Pipeline } from '../../server/processing/pipeline.js';
import { testConfig, memoryRepo, quietLogger, T0 } from '../helpers.js';

const config = testConfig();
const fw = path.join(config.projectRoot, 'firmware');
const coreDir = path.join(fw, 'esp32-controller', 'src', 'core');
const hasGpp = spawnSync('g++', ['--version'], { shell: false }).status === 0;
const skip = hasGpp ? false : 'g++ not installed – firmware core tests skipped';

function compile(mainFile, outDir) {
  const out = path.join(outDir, path.basename(mainFile, '.cpp') + (process.platform === 'win32' ? '.exe' : ''));
  const sources = readdirSync(coreDir).filter((f) => f.endsWith('.cpp')).map((f) => path.join(coreDir, f));
  const r = spawnSync('g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', `-I${coreDir}`, mainFile, ...sources, '-o', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, `compile failed:\n${r.stderr}`);
  return out;
}

let tmp;
let simExe;
function simReports(scenario) {
  const r = spawnSync(simExe, [scenario], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split(/\r?\n/).map((line) => {
    const space = line.indexOf(' ');
    return { at: Number(line.slice(0, space)), report: JSON.parse(line.slice(space + 1)) };
  });
}

// Feed firmware reports into a fresh server pipeline, ticking it like the real server does.
function runThroughServer(reports) {
  const repo = memoryRepo();
  const states = ['INITIALIZING'];
  const p = new Pipeline({
    config, repo, source: 'LIVE', logger: quietLogger,
    onStatus: (_s, actions) => { for (const a of actions) if (a.kind === 'TRANSITION') states.push(a.to); },
  });
  p.start(T0);
  let t = T0;
  for (const { at, report } of reports) {
    while (t + 250 <= T0 + at) { t += 250; p.tick(t); }
    const res = p.ingestReport(report, T0 + at);
    assert.equal(res.accepted, true, `server refused a firmware report: ${JSON.stringify(res)}`);
  }
  for (let i = 0; i < 8; i++) { t += 250; p.tick(t); }
  return { states, status: p.getStatus(), events: repo.queryEvents({ source: 'LIVE', limit: 100 }).items };
}

test('firmware core: C++ unit tests pass', { skip }, () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lvfw-'));
  const exe = compile(path.join(fw, 'host-tests', 'test_core.cpp'), tmp);
  const r = spawnSync(exe, [], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /ALL PASSED/);
  simExe = compile(path.join(fw, 'host-tests', 'sim_feeder.cpp'), tmp);
});

test('firmware reports pass the server validator in every simulated case', { skip }, () => {
  for (const sc of ['normal', 'break', 'break-no-feedback', 'source-loss', 'unplugged-b']) {
    for (const { at, report } of simReports(sc)) {
      const v = validateReport(report, config, T0 + at);
      assert.equal(v.ok, true, `${sc} @${at}ms: ${JSON.stringify(v.details)}`);
    }
  }
});

test('firmware + server: normal line → NORMAL, no events', { skip }, () => {
  const r = runThroughServer(simReports('normal'));
  assert.deepEqual(r.states, ['INITIALIZING', 'NORMAL']);
  assert.equal(r.events.length, 0);
});

test('firmware + server: break A–B → firmware trips, server shows ISOLATED at section S-AB', { skip }, () => {
  const r = runThroughServer(simReports('break'));
  assert.deepEqual(r.states, ['INITIALIZING', 'NORMAL', 'ISOLATION_PENDING', 'ISOLATED']);
  assert.equal(r.status.affected_section, 'S-AB');
  const e = r.events.find((x) => x.event_type === 'INTERRUPTION_SUSPECTED');
  assert.equal(e.isolation_confirmed, 'CONFIRMED');
});

test('firmware + server: no feedback contact → never ISOLATED', { skip }, () => {
  const r = runThroughServer(simReports('break-no-feedback'));
  assert.ok(!r.states.includes('ISOLATED'));
  assert.equal(r.status.display_status, 'ISOLATION_PENDING');
  assert.equal(r.status.isolation_feedback_state, 'NOT_FITTED');
});

test('firmware + server: source-wide loss → firmware does not trip, location uncertain', { skip }, () => {
  const r = runThroughServer(simReports('source-loss'));
  assert.equal(r.status.status, 'INTERRUPTION_SUSPECTED');
  assert.equal(r.status.localization_status, 'SOURCE_OR_UPSTREAM');
  assert.equal(r.status.isolation_command_state, 'NONE');
});

test('firmware + server: unplugged sensor → "no valid reading", not 0 V, not a fault', { skip }, () => {
  const r = runThroughServer(simReports('unplugged-b'));
  assert.equal(r.status.status, 'DEGRADED');
  assert.equal(r.status.nodes[1].display_state, 'NO_DATA');
  assert.equal(r.status.nodes[1].invalid_reason, 'SENSOR_FAULT');
  assert.ok(!r.states.includes('INTERRUPTION_SUSPECTED'));
  assert.equal(r.events.filter((e) => e.event_type === 'SENSOR_FAULT').length, 1);
  rmSync(tmp, { recursive: true, force: true });
});
