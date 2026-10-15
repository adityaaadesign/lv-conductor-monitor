import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localize } from '../../server/processing/localization.js';
import { buildTopology } from '../../server/config/load-config.js';
import { testConfig } from '../helpers.js';

const line = testConfig().topology;
const P = 'PRESENT';
const A = 'ABSENT';
const U = 'UNKNOWN';
const loc = (a, b, c, topo = line) => localize(topo, { 'N-A': a, 'N-B': b, 'N-C': c });

test('all present → nothing to locate', () => {
  const r = loc(P, P, P);
  assert.equal(r.status, 'NOT_APPLICABLE');
  assert.ok(r.sections.every((s) => s.status === 'ENERGISED'));
});

test('upstream present, downstream absent → single estimated section', () => {
  const r = loc(P, A, A);
  assert.equal(r.status, 'LOCALIZED_ESTIMATE');
  assert.equal(r.affected_section, 'S-AB');
  assert.deepEqual(r.sections.map((s) => s.status), ['ENERGISED', 'SUSPECTED', 'NO_SUPPLY']);
  assert.equal(loc(P, P, A).affected_section, 'S-BC');
});

test('all absent → source or first section, no section claimed', () => {
  const r = loc(A, A, A);
  assert.equal(r.status, 'SOURCE_OR_UPSTREAM');
  assert.equal(r.affected_section, null);
  assert.deepEqual(r.candidate_sections, ['S-0A']);
});

test('missing data between present and absent nodes → ambiguous', () => {
  const r = loc(P, U, A);
  assert.equal(r.status, 'AMBIGUOUS');
  assert.equal(r.affected_section, null);
  assert.deepEqual(r.candidate_sections.sort(), ['S-AB', 'S-BC']);
});

test('absent node with a present node downstream → inconsistent (probable sensor fault)', () => {
  const r = loc(P, A, P);
  assert.equal(r.status, 'INCONSISTENT');
  assert.deepEqual(r.suspect_nodes, ['N-B']);
  assert.equal(r.affected_section, null);
});

test('no valid data at all → insufficient data', () => {
  assert.equal(loc(U, U, U).status, 'INSUFFICIENT_DATA');
});

test('first node absent while it is the only data → source or upstream', () => {
  assert.equal(loc(A, U, U).status, 'SOURCE_OR_UPSTREAM');
});

test('tree: a present node on another branch proves the source is energised', () => {
  const f = testConfig().feeder;
  const nodes = [...f.nodes, { node_id: 'N-D', label: 'D', upstream: 'SOURCE', section_id: 'S-0D' }];
  const topo = buildTopology({ ...f, nodes, controllers: [{ controller_id: 'CTRL-01', nodes: nodes.map((n) => n.node_id) }] });
  const r = localize(topo, { 'N-A': A, 'N-B': A, 'N-C': A, 'N-D': P });
  assert.equal(r.status, 'LOCALIZED_ESTIMATE');
  assert.equal(r.affected_section, 'S-0A');
});
