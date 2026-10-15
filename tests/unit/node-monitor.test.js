import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodeState, applyMeasurement, applyTime, computeBand } from '../../server/processing/node-monitor.js';
import { testConfig, T0 } from '../helpers.js';

const p = testConfig().detection;
const NOM = 230;
const m = (v, extra = {}) => ({
  node_id: 'N-A', voltage_rms: v, voltage_rms_min: extra.min ?? null, validity: extra.validity ?? 'VALID',
  invalid_reason: extra.reason ?? null, sensor_status: 'OK', link_status: 'NOT_APPLICABLE', ...extra,
});

// Feed one sample per second starting at t0+1s; returns all outputs.
function feed(s, volts, start = T0) {
  const outs = [];
  volts.forEach((v, i) => {
    const t = start + (i + 1) * 1000;
    outs.push(...applyMeasurement(s, typeof v === 'object' ? v : m(v), t, p, NOM));
    outs.push(...applyTime(s, t + 250, p));
  });
  return outs;
}

test('voltage bands use hysteresis', () => {
  assert.equal(computeBand(null, 0.95, p), 'OK');
  assert.equal(computeBand('OK', 0.91, p), 'OK');
  assert.equal(computeBand('LOW', 0.91, p), 'LOW', 'must rise above uv_dropout_pu to leave LOW');
  assert.equal(computeBand('OK', 0.05, p), 'ABSENT');
  assert.equal(computeBand('ABSENT', 0.12, p), 'ABSENT', 'must rise above loss_dropout_pu to leave ABSENT');
  assert.equal(computeBand('ABSENT', 0.5, p), 'LOW');
});

test('sustained low voltage is confirmed only after the persistence time', () => {
  const s = createNodeState('N-A');
  feed(s, [229, 185, 185]);
  assert.equal(s.condition, 'UV_PENDING', 'not yet confirmed after 2 s');
  feed(s, [185, 185], T0 + 3000);
  assert.equal(s.condition, 'UNDERVOLTAGE');
  assert.ok(s.confirmedAt - s.firstObservedAt >= p.uv_persistence_ms);
});

test('a short dip produces a transient, not undervoltage', () => {
  const s = createNodeState('N-A');
  const outs = feed(s, [229, 150, 229]);
  assert.equal(s.condition, 'NORMAL');
  const tr = outs.filter((o) => o.type === 'TRANSIENT');
  assert.equal(tr.length, 1);
  assert.equal(tr[0].kind, 'SHORT_DIP');
});

test('a dip visible only in the per-cycle minimum is reported as an in-window transient', () => {
  const s = createNodeState('N-A');
  const outs = feed(s, [229, m(228, { min: 120 })]);
  assert.equal(outs.filter((o) => o.type === 'TRANSIENT')[0].kind, 'IN_WINDOW');
});

test('supply loss: measured near-zero voltage confirms SUPPLY_LOST after persistence', () => {
  const s = createNodeState('N-A');
  feed(s, [229, 0.4, 0.3]);
  assert.equal(s.condition, 'LOSS_PENDING');
  feed(s, [0.3], T0 + 3000);
  assert.equal(s.condition, 'SUPPLY_LOST');
});

test('recovery requires the full stability time; an abnormal sample resets it', () => {
  const s = createNodeState('N-A');
  feed(s, [229, 0, 0, 0, 0]);
  assert.equal(s.condition, 'SUPPLY_LOST');
  let outs = feed(s, [229, 229, 229, 229, 229], T0 + 5000);
  assert.equal(s.condition, 'RECOVERING');
  outs = feed(s, [100], T0 + 10000);
  assert.equal(s.condition, 'UNDERVOLTAGE', 'falls straight back – no new persistence period');
  assert.equal(outs.filter((o) => o.type === 'RECOVERY_UNSTABLE').length, 1);
  assert.equal(s.unstableCount, 1);
  feed(s, Array(11).fill(229), T0 + 11000);
  assert.equal(s.condition, 'NORMAL');
  assert.equal(s.stableSince, T0 + 12000, 'stable window starts at the first good sample after the reset');
});

test('a sensor fault makes the node INVALID immediately and cancels pending timers', () => {
  const s = createNodeState('N-A');
  feed(s, [229, 185]);
  assert.equal(s.condition, 'UV_PENDING');
  feed(s, [m(412, { validity: 'INVALID', reason: 'SENSOR_FAULT' })], T0 + 2000);
  assert.equal(s.validity, 'INVALID');
  assert.equal(s.condition, 'NORMAL', 'back to the last confirmed condition');
  assert.equal(s.lastValid.voltage_rms, 185, 'invalid value is never stored as the last valid reading');
});

test('missing data goes STALE then OFFLINE; it never becomes SUPPLY_LOST', () => {
  const s = createNodeState('N-A');
  feed(s, [229]);
  applyTime(s, T0 + 1000 + p.stale_after_ms + 1, p);
  assert.equal(s.validity, 'STALE');
  applyTime(s, T0 + 1000 + p.offline_after_ms + 1, p);
  assert.equal(s.validity, 'OFFLINE');
  assert.equal(s.condition, 'NORMAL', 'condition is frozen at last known, not changed to supply lost');
});

test('LINK_LOST messages count as missing data (stale after timeout), not a sensor fault', () => {
  const s = createNodeState('N-A');
  feed(s, [229]);
  applyMeasurement(s, m(null, { validity: 'INVALID', reason: 'LINK_LOST' }), T0 + 2000, p, NOM);
  assert.equal(s.validity, 'VALID', 'last valid sample is still fresh');
  applyMeasurement(s, m(null, { validity: 'INVALID', reason: 'LINK_LOST' }), T0 + 1000 + p.stale_after_ms + 1, p, NOM);
  assert.equal(s.validity, 'STALE');
});
