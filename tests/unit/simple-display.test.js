// The simple dashboard view: five statuses, node states, and the on-screen checklists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayStatus, nodeDisplayState, checkPasses, DISPLAY_STATUS, NODE_DISPLAY, summarySentence, readingStatus, supplyText,
  locationView, shutdownView, switchDrawing,
} from '../../shared/simple.js';
import { manualPipeline, protection, NORMAL } from '../helpers.js';

test('every internal feeder state maps to one of the five simple statuses', () => {
  const map = (status, fb = 'CLOSED') => displayStatus({ status, isolation_feedback_state: fb });
  assert.equal(map('NORMAL'), 'NORMAL');
  assert.equal(map('TRANSIENT'), 'NORMAL');
  assert.equal(map('UNDERVOLTAGE'), 'FAULT_SUSPECTED');
  assert.equal(map('INTERRUPTION_SUSPECTED'), 'FAULT_SUSPECTED');
  assert.equal(map('ISOLATION_PENDING'), 'ISOLATION_PENDING');
  assert.equal(map('ISOLATED', 'OPEN'), 'ISOLATED');
  assert.equal(map('DEGRADED'), 'DEGRADED_UNKNOWN');
  assert.equal(map('UNKNOWN'), 'DEGRADED_UNKNOWN');
  assert.equal(map('INITIALIZING'), 'DEGRADED_UNKNOWN');
  assert.equal(Object.keys(DISPLAY_STATUS).length, 5);
});

test('ISOLATED is only shown when switch feedback says OPEN', () => {
  assert.equal(displayStatus({ status: 'RESTORATION_PENDING', isolation_feedback_state: 'OPEN' }), 'ISOLATED');
  for (const fb of ['CLOSED', 'UNKNOWN', 'TIMEOUT', 'NOT_FITTED', 'CONTRADICTORY']) {
    assert.equal(displayStatus({ status: 'RESTORATION_PENDING', isolation_feedback_state: fb }), 'ISOLATION_PENDING', fb);
  }
});

test('a node without valid data is "No data" – never "No supply"', () => {
  for (const validity of ['INVALID', 'STALE', 'OFFLINE', 'NEVER_SEEN']) {
    assert.equal(nodeDisplayState({ validity, condition: 'SUPPLY_LOST' }), 'NO_DATA', validity);
  }
  assert.equal(nodeDisplayState({ validity: 'VALID', condition: 'SUPPLY_LOST' }), 'NO_SUPPLY');
  assert.equal(nodeDisplayState({ validity: 'VALID', condition: 'UNDERVOLTAGE' }), 'LOW_VOLTAGE');
  assert.equal(nodeDisplayState({ validity: 'VALID', condition: 'LOSS_PENDING' }), 'CHECKING');
});

test('the live status carries the simple fields the page needs', () => {
  const h = manualPipeline();
  h.hold(NORMAL, 3, { protection: protection() });
  let s = h.status();
  assert.equal(s.display_status, 'NORMAL');
  assert.ok(s.nodes.every((n) => n.display_state === 'NORMAL'));
  h.hold({ 'N-A': 229, 'N-B': 227 }, 6, { protection: protection() });   // Node C stops reporting
  s = h.status();
  assert.equal(s.display_status, 'DEGRADED_UNKNOWN');
  assert.equal(s.nodes[2].display_state, 'NO_DATA');
  assert.ok(s.explanation.some((l) => l.includes('NOT treated as 0 V')));
});

test('checklist evaluation reads paths, node fields and open events', () => {
  const status = {
    display_status: 'ISOLATED',
    nodes: [{ node_id: 'N-C', display_state: 'NO_DATA' }],
    active_events: [{ event_type: 'INTERRUPTION_SUSPECTED', severity: 'CRITICAL' }],
    affected_section: null,
  };
  assert.equal(checkPasses({ path: 'display_status', equals: 'ISOLATED' }, status), true);
  assert.equal(checkPasses({ path: 'nodes.N-C.display_state', equals: 'NO_DATA' }, status), true);
  assert.equal(checkPasses({ path: 'affected_section', equals: null }, status), true);
  assert.equal(checkPasses({ active_event: 'INTERRUPTION_SUSPECTED' }, status), true);
  assert.equal(checkPasses({ active_event: 'UNDERVOLTAGE' }, status), false);
  assert.equal(checkPasses({ no_active_fault_events: true }, status), false);
});

// ---- Dashboard wording rules (shared/simple.js) ------------------------------------------
const nodes = [
  { node_id: 'N-A', label: 'Node A', validity: 'VALID', condition: 'NORMAL' },
  { node_id: 'N-B', label: 'Node B', validity: 'VALID', condition: 'NORMAL' },
  { node_id: 'N-C', label: 'Node C', validity: 'VALID', condition: 'NORMAL' },
];
const sections = [
  { section_id: 'S-0A', from: 'SOURCE', to: 'N-A' },
  { section_id: 'S-AB', from: 'N-A', to: 'N-B' },
  { section_id: 'S-BC', from: 'N-B', to: 'N-C' },
];
const st = (over) => ({ nodes, sections, candidate_sections: [], localization_evidence: [], ...over });

test('status sentence: one plain sentence per situation, no internal codes', () => {
  assert.equal(summarySentence(st({ status: 'NORMAL' })), 'All valid monitoring points are within configured limits.');
  const low = nodes.map((n) => (n.node_id === 'N-C' ? { ...n, condition: 'UNDERVOLTAGE' } : n));
  assert.equal(summarySentence(st({ status: 'UNDERVOLTAGE', nodes: low })), 'Voltage at Node C is below the configured threshold.');
  assert.equal(summarySentence(st({ status: 'INTERRUPTION_SUSPECTED', localization_status: 'LOCALIZED_ESTIMATE' })),
    'Supply is present upstream but absent downstream; an interruption is suspected.');
  assert.equal(summarySentence(st({ status: 'ISOLATION_PENDING', isolation_feedback_state: 'TIMEOUT' })),
    'An isolation command was issued, but switch opening has not been confirmed.');
  const offline = nodes.map((n) => (n.node_id === 'N-C' ? { ...n, validity: 'OFFLINE' } : n));
  assert.equal(summarySentence(st({ status: 'DEGRADED', nodes: offline })), 'Node C is not reporting, so the feeder condition cannot be fully determined.');
  for (const s of ['NORMAL', 'UNDERVOLTAGE', 'INTERRUPTION_SUSPECTED', 'ISOLATED', 'DEGRADED', 'UNKNOWN', 'INITIALIZING']) {
    assert.doesNotMatch(summarySentence(st({ status: s })), /[A-Z]{3,}_[A-Z]+|\bpu\b/, s);
  }
});

test('node reading status: missing data is "Connection lost" / "No valid reading", never a number', () => {
  assert.equal(readingStatus({ validity: 'VALID' }).label, 'Valid reading');
  assert.equal(readingStatus({ validity: 'STALE' }).label, 'Connection lost');
  assert.equal(readingStatus({ validity: 'OFFLINE' }).label, 'Connection lost');
  assert.equal(readingStatus({ validity: 'INVALID' }).label, 'No valid reading');
  assert.equal(supplyText({ validity: 'OFFLINE', condition: 'SUPPLY_LOST' }), 'Unknown', 'no supply claim without valid data');
  assert.equal(supplyText({ validity: 'VALID', condition: 'SUPPLY_LOST' }), 'No supply');
});

test('location: only a single clear section is an estimate; everything else is "Location uncertain"', () => {
  const est = locationView(st({ status: 'INTERRUPTION_SUSPECTED', localization_status: 'LOCALIZED_ESTIMATE', affected_section: 'S-AB' }));
  assert.equal(est.certainty, 'ESTIMATE');
  assert.equal(est.headline, 'Possible interruption between Node A and Node B');
  for (const loc of ['SOURCE_OR_UPSTREAM', 'AMBIGUOUS', 'INCONSISTENT', 'INSUFFICIENT_DATA']) {
    const v = locationView(st({ status: 'INTERRUPTION_SUSPECTED', localization_status: loc, candidate_sections: ['S-AB', 'S-BC'] }));
    assert.equal(v.headline, 'Location uncertain', loc);
    assert.equal(v.section, undefined, `${loc} must not name a section`);
  }
  assert.match(locationView(st({ status: 'INTERRUPTION_SUSPECTED', localization_status: 'SOURCE_OR_UPSTREAM' })).short, /No node has supply/);
  const held = locationView(st({ status: 'ISOLATED', localization_status: 'FROZEN', frozen_localization_status: 'LOCALIZED_ESTIMATE', affected_section: 'S-AB' }));
  assert.equal(held.certainty, 'ESTIMATE');
  assert.match(held.reason, /just before the shutdown/);
});

// Wording updated to the final dashboard brief (Command: Not requested / Command issued;
// Feedback: Confirmed open / Not confirmed / Unavailable). The safety rule is unchanged:
// only OPEN feedback may ever read as confirmed.
test('isolation wording keeps command and feedback separate', () => {
  const v = (cmd, fb) => shutdownView({ isolation_command_state: cmd, isolation_feedback_state: fb });
  assert.equal(v('NONE', 'CLOSED').command.text, 'Not requested');
  assert.equal(v('UNAVAILABLE', 'UNKNOWN').command.text, 'Unknown');
  assert.equal(v('COMMANDED', 'OPEN').command.text, 'Command issued');
  assert.equal(v('COMMANDED', 'OPEN').feedback.text, 'Confirmed open');
  assert.equal(v('COMMANDED', 'TIMEOUT').feedback.text, 'Not confirmed');
  assert.equal(v('COMMANDED', 'NOT_FITTED').feedback.text, 'Unavailable');
  assert.equal(v('COMMANDED', 'CLOSED').feedback.text, 'Not confirmed');
  assert.equal(v('NONE', 'CLOSED').feedback.text, '—', 'nothing to confirm without a command');
  for (const fb of ['CLOSED', 'UNKNOWN', 'TIMEOUT', 'NOT_FITTED', 'CONTRADICTORY']) {
    assert.notEqual(v('COMMANDED', fb).feedback.text, 'Confirmed open', fb);
  }
});

test('node card labels are the four short words from the brief', () => {
  const label = (validity, condition) => NODE_DISPLAY[nodeDisplayState({ validity, condition })].label;
  assert.equal(label('VALID', 'NORMAL'), 'Normal');
  assert.equal(label('VALID', 'UNDERVOLTAGE'), 'Low Voltage');
  assert.equal(label('VALID', 'SUPPLY_LOST'), 'No Supply');
  assert.equal(label('OFFLINE', 'SUPPLY_LOST'), 'No Data', 'missing data is "No Data", never "No Supply"');
});

test('switch drawing: open only with OPEN feedback; unknown without a controller report', () => {
  assert.equal(switchDrawing({ isolation_command_state: 'UNAVAILABLE' }), 'UNKNOWN');
  assert.equal(switchDrawing({ isolation_command_state: 'NONE' }), 'CLOSED');
  assert.equal(switchDrawing({ isolation_command_state: 'COMMANDED', isolation_feedback_state: 'TIMEOUT' }), 'OPEN_ORDERED');
  assert.equal(switchDrawing({ isolation_command_state: 'COMMANDED', isolation_feedback_state: 'OPEN' }), 'OPEN_CONFIRMED');
});
