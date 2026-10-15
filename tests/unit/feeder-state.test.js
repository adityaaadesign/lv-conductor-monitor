// Feeder state machine and event lifecycle, driven report by report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualPipeline, protection, NORMAL } from '../helpers.js';

const BREAK_AB = { 'N-A': 229, 'N-B': 0.3, 'N-C': 0.2 };
const ALL_DEAD = { 'N-A': 0.2, 'N-B': 0.3, 'N-C': 0.2 };
const count = (events, type) => events.filter((e) => e.event_type === type).length;

test('all nodes normal → NORMAL with no events', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 5);
  assert.equal(h.status().status, 'NORMAL');
  assert.equal(h.events().length, 0);
});

test('without protection status: interruption is suspected and located; isolation is "unavailable", never assumed', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 3);
  h.hold(BREAK_AB, 4);
  const s = h.status();
  assert.equal(s.status, 'INTERRUPTION_SUSPECTED');
  assert.equal(s.affected_section, 'S-AB');
  assert.equal(s.isolation_command_state, 'UNAVAILABLE');
  const e = h.events().find((x) => x.event_type === 'INTERRUPTION_SUSPECTED');
  assert.equal(e.isolation_requested, null);
  assert.equal(e.isolation_confirmed, 'NOT_APPLICABLE');
  assert.ok(s.explanation.some((l) => l.includes('cannot prove that the wire is physically broken')));
});

test('a long abnormal condition creates ONE event, not one per sample', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 3);
  h.hold({ ...NORMAL, 'N-C': 185 }, 60);
  assert.equal(h.status().status, 'UNDERVOLTAGE');
  assert.equal(count(h.events(), 'UNDERVOLTAGE'), 1);
});

test('undervoltage escalating to loss closes the UV event as ESCALATED and links it', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 3);
  h.hold({ ...NORMAL, 'N-C': 185 }, 5);
  h.hold({ ...NORMAL, 'N-C': 0.2 }, 4);
  const ev = h.events();
  const uv = ev.find((e) => e.event_type === 'UNDERVOLTAGE');
  const int = ev.find((e) => e.event_type === 'INTERRUPTION_SUSPECTED');
  assert.equal(uv.status, 'CLOSED');
  assert.equal(uv.end_reason, 'ESCALATED');
  assert.equal(int.related_event_id, uv.event_id);
  assert.equal(int.affected_section, 'S-BC');
});

test('a node that stops reporting gives DEGRADED, not an interruption', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 3);
  h.hold({ 'N-A': 229, 'N-B': 227 }, 15);
  const s = h.status();
  assert.equal(s.status, 'DEGRADED');
  assert.equal(s.nodes[2].validity, 'OFFLINE');
  assert.equal(count(h.events(), 'NODE_OFFLINE'), 1);
  assert.equal(count(h.events(), 'INTERRUPTION_SUSPECTED'), 0);
});

test('isolation commanded with feedback missing (UNKNOWN) → timeout alert, never ISOLATED', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 3, { protection: protection() });
  h.hold(BREAK_AB, 8, { protection: protection({ commanded: true, feedback: 'UNKNOWN' }) });
  assert.ok(!h.transitions.includes('ISOLATED'));
  const s = h.status();
  assert.equal(s.status, 'ISOLATION_PENDING');
  assert.equal(s.isolation_feedback_state, 'TIMEOUT');
  assert.equal(count(h.events(), 'ISOLATION_UNCONFIRMED'), 1);
  assert.equal(h.events().find((e) => e.event_type === 'INTERRUPTION_SUSPECTED').isolation_confirmed, 'NOT_CONFIRMED');
});

test('no feedback fitted → "cannot confirm", no timeout alert, never ISOLATED', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 3, { protection: protection({ feedback: 'NOT_FITTED' }) });
  h.hold(BREAK_AB, 8, { protection: protection({ commanded: true, feedback: 'NOT_FITTED' }) });
  assert.ok(!h.transitions.includes('ISOLATED'));
  assert.equal(count(h.events(), 'ISOLATION_UNCONFIRMED'), 0);
  assert.equal(h.events().find((e) => e.event_type === 'INTERRUPTION_SUSPECTED').isolation_confirmed, 'NO_FEEDBACK_FITTED');
});

test('feedback OPEN then CLOSED while still commanded → contradictory, not isolated', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 3, { protection: protection() });
  h.hold(BREAK_AB, 2, { protection: protection({ commanded: true, feedback: 'OPEN' }) });
  assert.equal(h.status().status, 'ISOLATED');
  h.hold(BREAK_AB, 2, { protection: protection({ commanded: true, feedback: 'CLOSED' }) });
  const s = h.status();
  assert.equal(s.status, 'ISOLATION_PENDING');
  assert.equal(s.isolation_feedback_state, 'CONTRADICTORY');
  assert.equal(count(h.events(), 'ISOLATION_FEEDBACK_CONTRADICTORY'), 1);
});

test('switch reporting OPEN although not commanded → contradictory feedback alert', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 3, { protection: protection() });
  h.hold(NORMAL, 6, { protection: protection({ commanded: false, feedback: 'OPEN' }) });
  assert.equal(count(h.events(), 'ISOLATION_FEEDBACK_CONTRADICTORY'), 1);
});

test('all nodes lose supply → source/feeder-wide interruption, no localized break invented', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 3);
  h.hold(ALL_DEAD, 4);
  const s = h.status();
  assert.equal(s.localization_status, 'SOURCE_OR_UPSTREAM');
  assert.equal(s.affected_section, null);
  assert.equal(count(h.events(), 'SOURCE_INTERRUPTION_SUSPECTED'), 1);
});

test('recovery cannot complete while an affected node has no valid data', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 3);
  h.hold(BREAK_AB, 4);
  h.hold({ 'N-A': 229, 'N-B': 227 }, 20);   // supply returns at B; C stops reporting
  const s = h.status();
  assert.notEqual(s.status, 'RESTORED');
  assert.notEqual(s.status, 'NORMAL');
  assert.equal(h.events().find((e) => e.event_type === 'INTERRUPTION_SUSPECTED').status, 'OPEN');
});

test('while monitoring is lost (UNKNOWN), open events are kept open, not closed as "cleared"', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 3, { protection: protection() });
  h.hold(BREAK_AB, 8, { protection: protection({ commanded: true, feedback: 'UNKNOWN' }) });
  assert.equal(h.events().find((e) => e.event_type === 'ISOLATION_UNCONFIRMED').status, 'OPEN');
  h.advance(30_000);   // controller goes silent
  assert.equal(h.status().status, 'UNKNOWN');
  const ev = h.events();
  assert.equal(ev.find((e) => e.event_type === 'ISOLATION_UNCONFIRMED').status, 'OPEN');
  assert.equal(ev.find((e) => e.event_type === 'INTERRUPTION_SUSPECTED').status, 'OPEN');
  assert.equal(count(ev, 'CONTROLLER_COMM_LOST'), 1);
});

test('a database failure does not stop monitoring; it is reported on the status', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 2);
  const original = h.repo.insertMeasurements;
  h.repo.insertMeasurements = () => { throw new Error('disk full (simulated)'); };
  h.hold({ ...NORMAL, 'N-C': 185 }, 6);
  const s = h.status();
  assert.equal(s.status, 'UNDERVOLTAGE', 'detection continues');
  assert.equal(s.storage.ok, false);
  assert.match(s.storage.last_error, /disk full/);
  h.repo.insertMeasurements = original;
});
