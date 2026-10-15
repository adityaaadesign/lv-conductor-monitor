import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, SessionTracker } from '../../server/ingest/validator.js';
import { testConfig, makeReport, protection, T0 } from '../helpers.js';

const cfg = testConfig();

test('a well-formed report is accepted and every node is VALID', () => {
  const v = validateReport(makeReport({ nodes: { 'N-A': 229, 'N-B': 227, 'N-C': 226 }, protection: protection() }), cfg, T0);
  assert.equal(v.ok, true);
  assert.deepEqual(v.nodes.map((n) => n.validity), ['VALID', 'VALID', 'VALID']);
});

test('malformed payloads are rejected with field-level details', () => {
  assert.equal(validateReport('hello', cfg, T0).error, 'MALFORMED_REPORT');
  assert.equal(validateReport([], cfg, T0).error, 'MALFORMED_REPORT');
  const bad = makeReport({ nodes: { 'N-A': 229 } });
  bad.nodes[0].voltage_rms = '229';
  bad.sequence_number = -1;
  const v = validateReport(bad, cfg, T0);
  assert.equal(v.error, 'VALIDATION_FAILED');
  assert.ok(v.details.some((d) => d.field === 'nodes[0].voltage_rms'));
  assert.ok(v.details.some((d) => d.field === 'sequence_number'));
});

test('unknown controller is rejected; unknown node is rejected individually', () => {
  assert.equal(validateReport(makeReport({ controller: 'CTRL-99', nodes: { 'N-A': 229 } }), cfg, T0).error, 'UNKNOWN_CONTROLLER');
  const v = validateReport(makeReport({ nodes: { 'N-A': 229, 'N-Z': 229 } }), cfg, T0);
  assert.equal(v.ok, true);
  assert.deepEqual(v.rejectedNodes, [{ node_id: 'N-Z', reason: 'UNKNOWN_NODE' }]);
  assert.equal(v.nodes.length, 1);
});

test('measured 0 V is a VALID measurement; null / flagged / faulty / out-of-range are INVALID', () => {
  const v = validateReport(makeReport({
    nodes: {
      'N-A': 0.4,
      'N-B': { voltage_rms: null },
      'N-C': { voltage_rms: 412, sensor_status: 'SATURATED', data_valid: false },
    },
  }), cfg, T0);
  assert.equal(v.nodes[0].validity, 'VALID');
  assert.equal(v.nodes[1].invalid_reason, 'MISSING_VALUE');
  assert.equal(v.nodes[2].invalid_reason, 'SENSOR_FAULT');
  const oor = validateReport(makeReport({ nodes: { 'N-A': 999 } }), cfg, T0);
  assert.equal(oor.nodes[0].invalid_reason, 'OUT_OF_RANGE');
  const flagged = validateReport(makeReport({ nodes: { 'N-A': { voltage_rms: 229, data_valid: false } } }), cfg, T0);
  assert.equal(flagged.nodes[0].invalid_reason, 'DATA_FLAGGED_INVALID');
  const link = validateReport(makeReport({ nodes: { 'N-A': { voltage_rms: null, link_status: 'LOST', data_valid: false, sensor_status: 'UNKNOWN' } } }), cfg, T0);
  assert.equal(link.nodes[0].invalid_reason, 'LINK_LOST');
});

test('current is ignored for nodes without a configured current sensor', () => {
  const v = validateReport(makeReport({ nodes: { 'N-A': { voltage_rms: 229, current_rms: 1.2 } } }), cfg, T0);
  assert.equal(v.nodes[0].current_rms, null);
  assert.ok(v.nodes[0].flags.includes('CURRENT_NOT_CONFIGURED'));
});

test('device time is only trusted when synced and close to server time', () => {
  const r = makeReport({ nodes: { 'N-A': 229 } });
  r.device_time = new Date(T0 + 60_000).toISOString();
  r.time_synced = true;
  const v = validateReport(r, cfg, T0);
  assert.equal(v.report.device_time, null);
  assert.ok(v.flags.includes('TIME_UNSYNCED'));
});

test('devices cannot send server-derived feedback values', () => {
  const p = protection();
  p.switches[0].feedback = 'TIMEOUT';
  assert.equal(validateReport(makeReport({ nodes: { 'N-A': 229 }, protection: p }), cfg, T0).ok, false);
});

test('session tracker: duplicates, late reports, gaps and reboots', () => {
  const s = new SessionTracker();
  assert.equal(s.classify('C', 'b1', 0, 1000, 1000).kind, 'NEW');
  assert.equal(s.classify('C', 'b1', 1, 2000, 2000).kind, 'NEW');
  assert.equal(s.classify('C', 'b1', 1, 2100, 2000).kind, 'DUPLICATE');
  const gap = s.classify('C', 'b1', 4, 5000, 5000);
  assert.equal(gap.kind, 'NEW');
  assert.equal(gap.gap, 2);
  const late = s.classify('C', 'b1', 3, 5200, 4000);
  assert.equal(late.kind, 'LATE');
  assert.equal(late.measuredAt, 4000, 'late report is placed at its estimated measurement time');
  const reboot = s.classify('C', 'b2', 0, 6000, 500);
  assert.equal(reboot.reboot, true);
  assert.equal(reboot.previousBootId, 'b1');
  assert.equal(s.classify('C', 'b1', 5, 6100, 6000).kind, 'LATE', 'report from the previous boot is history only');
  assert.deepEqual({ dup: s.stats('C').duplicates, late: s.stats('C').late }, { dup: 1, late: 2 });
});
