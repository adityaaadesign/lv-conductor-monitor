// Configuration logic without any file access, so it also runs on Cloudflare Workers.
// load-config.js reads the files from disk on the laptop; the Worker imports the same
// JSON files at build time. Both then call buildConfig().

import { ID_PATTERN, SOURCE } from '../../shared/enums.js';

export class ConfigError extends Error {}

// Replace every { value, placeholder, ... } wrapper with its plain value and remember
// which settings are placeholders so the dashboard can label them. Keys starting with
// "_" are comments and are dropped.
export function unwrapPlaceholders(value, pathParts = [], placeholders = []) {
  if (Array.isArray(value)) {
    return value.map((v, i) => unwrapPlaceholders(v, [...pathParts, i], placeholders));
  }
  if (value && typeof value === 'object') {
    if ('value' in value && 'placeholder' in value) {
      if (value.placeholder) {
        placeholders.push({
          path: pathParts.join('.'),
          value: value.value,
          unit: value.unit ?? null,
          note: value.note ?? '',
        });
      }
      return value.value;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_')) continue;
      out[k] = unwrapPlaceholders(v, [...pathParts, k], placeholders);
    }
    return out;
  }
  return value;
}

const DETECTION_KEYS = [
  'uv_pickup_pu', 'uv_dropout_pu', 'loss_pickup_pu', 'loss_dropout_pu', 'transient_dip_pu',
  'uv_persistence_ms', 'loss_persistence_ms', 'recovery_stability_ms', 'restored_hold_ms',
  'reclose_supply_timeout_ms', 'expected_report_interval_ms', 'stale_after_ms', 'offline_after_ms',
  'controller_offline_after_ms', 'init_timeout_ms', 'isolation_feedback_timeout_ms',
  'transient_display_hold_ms', 'transient_max_events_per_min', 'protection_disagreement_ms',
  'tick_interval_ms',
];

export function validateDetection(d) {
  const problems = [];
  for (const k of DETECTION_KEYS) {
    if (typeof d[k] !== 'number' || !Number.isFinite(d[k]) || d[k] <= 0) {
      problems.push(`${k} must be a positive number`);
    }
  }
  if (problems.length) throw new ConfigError(`detection.json: ${problems.join('; ')}`);
  const rule = (ok, msg) => { if (!ok) problems.push(msg); };
  rule(d.loss_pickup_pu < d.loss_dropout_pu, 'loss_dropout_pu must be greater than loss_pickup_pu');
  rule(d.loss_dropout_pu < d.uv_pickup_pu, 'loss_dropout_pu must be below uv_pickup_pu');
  rule(d.uv_pickup_pu < d.uv_dropout_pu, 'uv_dropout_pu must be greater than uv_pickup_pu');
  rule(d.uv_dropout_pu < 1.2, 'uv_dropout_pu looks unreasonably high');
  rule(d.transient_dip_pu < d.uv_dropout_pu, 'transient_dip_pu must be below uv_dropout_pu');
  rule(d.stale_after_ms > d.expected_report_interval_ms, 'stale_after_ms must exceed expected_report_interval_ms');
  rule(d.offline_after_ms > d.stale_after_ms, 'offline_after_ms must exceed stale_after_ms');
  rule(d.controller_offline_after_ms > d.expected_report_interval_ms, 'controller_offline_after_ms must exceed expected_report_interval_ms');
  rule(d.tick_interval_ms <= d.expected_report_interval_ms, 'tick_interval_ms should not exceed the report interval');
  if (problems.length) throw new ConfigError(`detection.json: ${problems.join('; ')}`);
  return d;
}

// Build lookup helpers for the radial tree described in feeder.json.
export function buildTopology(feeder) {
  const problems = [];
  const nodes = feeder.nodes ?? [];
  if (!nodes.length) problems.push('at least one node is required');

  const byId = new Map();
  const sectionIds = new Set();
  for (const n of nodes) {
    if (!ID_PATTERN.test(n.node_id ?? '') || n.node_id === SOURCE) problems.push(`invalid node_id "${n.node_id}"`);
    if (byId.has(n.node_id)) problems.push(`duplicate node_id ${n.node_id}`);
    if (!ID_PATTERN.test(n.section_id ?? '')) problems.push(`invalid section_id for ${n.node_id}`);
    if (sectionIds.has(n.section_id)) problems.push(`duplicate section_id ${n.section_id}`);
    byId.set(n.node_id, n);
    sectionIds.add(n.section_id);
  }
  for (const n of nodes) {
    if (n.upstream !== SOURCE && !byId.has(n.upstream)) problems.push(`${n.node_id}: upstream "${n.upstream}" does not exist`);
  }

  // Detect cycles by walking upstream from every node.
  for (const n of nodes) {
    const seen = new Set();
    let cur = n.node_id;
    while (cur !== SOURCE && byId.has(cur)) {
      if (seen.has(cur)) { problems.push(`cycle in topology at ${n.node_id}`); break; }
      seen.add(cur);
      cur = byId.get(cur).upstream;
    }
  }

  const controllers = feeder.controllers ?? [];
  const controllerOfNode = new Map();
  const controllersById = new Map();
  for (const c of controllers) {
    if (!ID_PATTERN.test(c.controller_id ?? '')) problems.push(`invalid controller_id "${c.controller_id}"`);
    controllersById.set(c.controller_id, c);
    for (const nid of c.nodes ?? []) {
      if (!byId.has(nid)) problems.push(`controller ${c.controller_id} lists unknown node ${nid}`);
      if (controllerOfNode.has(nid)) problems.push(`node ${nid} is assigned to more than one controller`);
      controllerOfNode.set(nid, c.controller_id);
    }
  }
  for (const n of nodes) {
    if (!controllerOfNode.has(n.node_id)) problems.push(`node ${n.node_id} is not assigned to any controller`);
  }

  const switches = new Map();
  for (const sw of feeder.isolation_points ?? []) {
    if (!ID_PATTERN.test(sw.switch_id ?? '')) problems.push(`invalid switch_id "${sw.switch_id}"`);
    for (const nid of sw.de_energises_nodes ?? []) {
      if (!byId.has(nid)) problems.push(`switch ${sw.switch_id} lists unknown node ${nid}`);
    }
    switches.set(sw.switch_id, sw);
  }
  if (feeder.source_reference_node && !byId.has(feeder.source_reference_node)) {
    problems.push('source_reference_node does not exist');
  }
  if (problems.length) throw new ConfigError(`feeder.json: ${problems.join('; ')}`);

  const children = new Map([[SOURCE, []]]);
  for (const n of nodes) children.set(n.node_id, []);
  for (const n of nodes) children.get(n.upstream).push(n.node_id);

  // Breadth-first order from the source: upstream nodes always come first.
  const orderedNodeIds = [];
  const queue = [...children.get(SOURCE)];
  while (queue.length) {
    const id = queue.shift();
    orderedNodeIds.push(id);
    queue.push(...children.get(id));
  }

  const parentOf = (id) => byId.get(id).upstream;
  const ancestors = (id) => {
    const out = [];
    let cur = parentOf(id);
    while (cur !== SOURCE) { out.push(cur); cur = parentOf(cur); }
    return out;
  };
  const descendants = (id) => {
    const out = [];
    const stack = [...children.get(id)];
    while (stack.length) { const c = stack.pop(); out.push(c); stack.push(...children.get(c)); }
    return out;
  };

  return {
    orderedNodeIds,
    nodeById: byId,
    children,
    parentOf,
    ancestors,
    descendants,
    sectionOf: (id) => byId.get(id).section_id,
    sections: orderedNodeIds.map((id) => {
      const n = byId.get(id);
      return { section_id: n.section_id, label: n.section_label ?? `${n.upstream} – ${id}`, from: n.upstream, to: id };
    }),
    controllersById,
    controllerOf: (id) => controllerOfNode.get(id),
    switches,
    sourceReferenceNode: feeder.source_reference_node ?? null,
  };
}

// Parse "CTRL-01=key1,CTRL-02=key2" (the DEVICE_KEYS setting) and check every key.
// Returns {} when the text is empty, which keeps the real-device input locked.
export function parseDeviceKeys(text, where = 'DEVICE_KEYS') {
  const raw = {};
  for (const pair of String(text ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new ConfigError('DEVICE_KEYS must look like CTRL-01=your-own-random-text');
    raw[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return checkDeviceKeys(raw, where);
}

export function checkDeviceKeys(raw, where) {
  const keys = {};
  for (const [id, key] of Object.entries(raw)) {
    if (id.startsWith('_')) continue;
    if (!ID_PATTERN.test(id)) throw new ConfigError(`${where}: invalid controller id "${id}"`);
    if (typeof key !== 'string' || key.length < 16 || key.includes('change-me')) {
      throw new ConfigError(`${where}: key for ${id} must be your own random text of at least 16 characters`);
    }
    keys[id] = key;
  }
  return keys;
}

// Communication timing can be changed per installation without editing detection.json:
//   REPORT_INTERVAL_MS, STALE_AFTER_MS, OFFLINE_AFTER_MS, CONTROLLER_OFFLINE_AFTER_MS
// (used by the Cloudflare Worker – see cloudflare/wrangler.toml – and optionally by the
// laptop server). These are communication settings, not electrical thresholds.
const TIMING_ENV = {
  REPORT_INTERVAL_MS: 'expected_report_interval_ms',
  STALE_AFTER_MS: 'stale_after_ms',
  OFFLINE_AFTER_MS: 'offline_after_ms',
  CONTROLLER_OFFLINE_AFTER_MS: 'controller_offline_after_ms',
};

export function timingOverrides(env = {}) {
  const out = {};
  for (const [name, key] of Object.entries(TIMING_ENV)) {
    const text = env[name];
    if (text === undefined || text === null || String(text).trim() === '') continue;
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} must be a positive number of milliseconds`);
    out[key] = { value, unit: 'ms', placeholder: true, note: `Set by ${name} for this installation.` };
  }
  return out;
}

// files: the parsed feeder.json, detection.json and server.json.
// overrides: { feeder: {...}, detection: {...}, server: {...} } merged over the files.
export function buildConfig(files, overrides = {}, projectRoot = null) {
  const placeholders = [];
  const feeder = unwrapPlaceholders({ ...files.feeder, ...(overrides.feeder ?? {}) }, ['feeder'], placeholders);
  const detection = validateDetection(unwrapPlaceholders(
    { ...files.detection, ...(overrides.detection ?? {}) }, ['detection'], placeholders,
  ));
  const server = unwrapPlaceholders({ ...files.server, ...(overrides.server ?? {}) }, ['server'], placeholders);

  if (!(feeder.nominal_voltage_v > 0)) throw new ConfigError('feeder.json: nominal_voltage_v must be positive');
  if (!(feeder.sensor_full_scale_v > feeder.nominal_voltage_v)) {
    throw new ConfigError('feeder.json: sensor_full_scale_v must exceed nominal_voltage_v');
  }
  if (!ID_PATTERN.test(feeder.feeder_id ?? '')) throw new ConfigError('feeder.json: invalid feeder_id');
  // Dial range on the node cards. Defaults: 0 V to the sensor full scale.
  feeder.gauge_min_v ??= 0;
  feeder.gauge_max_v ??= feeder.sensor_full_scale_v;
  if (!(feeder.gauge_min_v >= 0) || !(feeder.gauge_max_v > feeder.gauge_min_v)) {
    throw new ConfigError('feeder.json: gauge_max_v must be greater than gauge_min_v (and gauge_min_v at least 0)');
  }

  const topology = buildTopology(feeder);
  return { feeder, detection, server, topology, placeholders, projectRoot };
}
