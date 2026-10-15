import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, unwrapPlaceholders, validateDetection, buildTopology, ConfigError } from '../../server/config/load-config.js';

test('placeholder wrappers are unwrapped and listed', () => {
  const ph = [];
  const out = unwrapPlaceholders({ _comment: 'x', a: { value: 0.9, placeholder: true, note: 'n' }, b: { value: 5, placeholder: false } }, ['d'], ph);
  assert.deepEqual(out, { a: 0.9, b: 5 });
  assert.deepEqual(ph.map((p) => p.path), ['d.a']);
});

test('shipped configuration loads and every detection threshold is flagged as a placeholder', () => {
  const cfg = loadConfig();
  assert.equal(cfg.topology.orderedNodeIds.join(','), 'N-A,N-B,N-C');
  const detPh = cfg.placeholders.filter((p) => p.path.startsWith('detection.')).map((p) => p.path);
  for (const k of ['uv_pickup_pu', 'loss_pickup_pu', 'uv_persistence_ms', 'recovery_stability_ms']) {
    assert.ok(detPh.includes(`detection.${k}`), `${k} must be marked placeholder`);
  }
  assert.ok(cfg.placeholders.some((p) => p.path === 'feeder.nominal_voltage_v'));
});

test('inconsistent thresholds are rejected', () => {
  const d = loadConfig().detection;
  assert.throws(() => validateDetection({ ...d, uv_dropout_pu: 0.85 }), ConfigError);
  assert.throws(() => validateDetection({ ...d, loss_pickup_pu: 0.95 }), ConfigError);
  assert.throws(() => validateDetection({ ...d, stale_after_ms: 500 }), ConfigError);
});

test('topology errors are rejected (unknown upstream, cycle, unassigned node)', () => {
  const base = loadConfig().feeder;
  assert.throws(() => buildTopology({ ...base, nodes: [...base.nodes, { node_id: 'N-X', upstream: 'N-Q', section_id: 'S-QX' }] }), ConfigError);
  const cyc = base.nodes.map((n) => (n.node_id === 'N-A' ? { ...n, upstream: 'N-C' } : n));
  assert.throws(() => buildTopology({ ...base, nodes: cyc }), ConfigError);
  assert.throws(() => buildTopology({ ...base, controllers: [{ controller_id: 'CTRL-01', nodes: ['N-A', 'N-B'] }] }), ConfigError);
});

test('tree topologies are supported', () => {
  const base = loadConfig().feeder;
  const nodes = [...base.nodes, { node_id: 'N-D', label: 'Node D', upstream: 'N-A', section_id: 'S-AD' }];
  const t = buildTopology({ ...base, nodes, controllers: [{ controller_id: 'CTRL-01', nodes: nodes.map((n) => n.node_id) }] });
  assert.deepEqual(t.children.get('N-A').sort(), ['N-B', 'N-D']);
  assert.deepEqual(t.descendants('N-A').sort(), ['N-B', 'N-C', 'N-D']);
  assert.deepEqual(t.ancestors('N-C'), ['N-B', 'N-A']);
});

test('device keys: missing file keeps device input locked; example placeholder keys are rejected', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { loadDeviceKeys } = await import('../../server/config/load-config.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lvkeys-'));
  try {
    assert.deepEqual(loadDeviceKeys(dir), {});
    writeFileSync(path.join(dir, 'devices.local.json'), JSON.stringify({ 'CTRL-01': 'change-me-to-your-own-long-random-text' }));
    assert.throws(() => loadDeviceKeys(dir), ConfigError);
    writeFileSync(path.join(dir, 'devices.local.json'), JSON.stringify({ _comment: 'x', 'CTRL-01': 'a-real-secret-key-1234' }));
    assert.deepEqual(loadDeviceKeys(dir), { 'CTRL-01': 'a-real-secret-key-1234' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
