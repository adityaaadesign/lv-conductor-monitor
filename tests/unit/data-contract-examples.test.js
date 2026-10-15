// Keeps docs/DATA_CONTRACT.md honest: every complete example message in the document
// must pass the real validator and be classified as the document says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateReport } from '../../server/ingest/validator.js';
import { buildTopology } from '../../server/config/load-config.js';
import { testConfig, T0 } from '../helpers.js';

const cfg = testConfig();
const doc = readFileSync(path.join(cfg.projectRoot, 'docs', 'DATA_CONTRACT.md'), 'utf8');
const examples = [...doc.matchAll(/```json\n([\s\S]*?)```/g)]
  .map((m) => JSON.parse(m[1]))
  .filter((x) => x.schema_version);

// Example 8.5 uses a gateway arrangement (controller GW-01) to show that the contract
// supports it; validate it against a gateway variant of the topology.
const gatewayCfg = {
  ...cfg,
  topology: buildTopology({ ...cfg.feeder, controllers: [{ controller_id: 'GW-01', nodes: ['N-A', 'N-B', 'N-C'] }] }),
};

test('the data contract contains the five documented example reports', () => {
  assert.equal(examples.length, 5);
});

test('every example report passes validation', () => {
  for (const ex of examples) {
    const c = ex.controller_id === 'GW-01' ? gatewayCfg : cfg;
    const v = validateReport(ex, c, T0);
    assert.equal(v.ok, true, `${ex.controller_id} seq ${ex.sequence_number}: ${JSON.stringify(v.details)}`);
  }
});

test('the example in HARDWARE_INTEGRATION.md (the firmware handover) passes validation', () => {
  const handover = readFileSync(path.join(cfg.projectRoot, 'docs', 'HARDWARE_INTEGRATION.md'), 'utf8');
  const ex = [...handover.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1])).find((x) => x.schema_version);
  assert.ok(ex, 'handover document must contain an example report');
  const v = validateReport(ex, cfg, T0);
  assert.equal(v.ok, true, JSON.stringify(v.details));
  assert.deepEqual(v.nodes.map((n) => n.validity), ['VALID', 'VALID', 'INVALID'], 'null voltage with a sensor fault is "no valid reading", not 0 V');
});

test('example classifications match the document', () => {
  const offline = examples.find((x) => x.controller_id === 'GW-01');
  const v = validateReport(offline, gatewayCfg, Date.parse(offline.device_time));
  assert.deepEqual(v.nodes.map((n) => n.validity), ['VALID', 'VALID', 'INVALID']);
  assert.equal(v.nodes[2].invalid_reason, 'LINK_LOST');
  const interruption = examples.find((x) => x.protection?.switches?.[0]?.isolation_commanded);
  const vi = validateReport(interruption, cfg, T0);
  assert.equal(vi.nodes[1].validity, 'VALID', '0.6 V is a valid measurement of "no supply", not missing data');
});
