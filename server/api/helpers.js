// API pieces shared by the Express server (routes.js) and the Cloudflare Worker
// (cloudflare/src/app.js), so both answer in exactly the same format.
// No Express and no Node-only modules in here.

import { toIso } from '../domain/clock.js';
import { EventType, Severity, EventStatus } from '../../shared/enums.js';

export function parseTime(v) {
  if (v === undefined || v === null || v === '') return null;
  if (/^\d+$/.test(String(v))) return Number(v);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : undefined;
}

// Compare the controller's key with the configured one. The time taken does not depend
// on where the texts differ (constant time for equal lengths).
export function deviceKeyMatches(keys, controllerId, sentKey) {
  const expected = controllerId ? keys[controllerId] : undefined;
  if (typeof expected !== 'string' || typeof sentKey !== 'string') return false;
  if (expected.length !== sentKey.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sentKey.charCodeAt(i);
  return diff === 0;
}

export function unauthorisedBody(keys) {
  const noKeys = !Object.keys(keys ?? {}).length;
  return {
    accepted: false,
    error: 'UNAUTHORISED',
    details: [{ field: 'X-Device-Key', problem: noKeys ? 'NO_DEVICE_KEYS_CONFIGURED_ON_SERVER' : 'MISSING_OR_WRONG_KEY' }],
  };
}

// Convert stored epoch-ms fields to ISO strings for the API.
export function eventForApi(e) {
  return {
    ...e,
    event_label: `EV-${String(e.event_id).padStart(6, '0')}`,
    start_timestamp: toIso(e.start_ts),
    first_observed_timestamp: toIso(e.first_observed_ts),
    end_timestamp: toIso(e.end_ts),
    isolation_requested_timestamp: toIso(e.isolation_requested_ts),
    isolation_confirmed_timestamp: toIso(e.isolation_confirmed_ts),
    acknowledged_timestamp: toIso(e.acknowledged_ts),
    created_timestamp: toIso(e.created_ts),
    updated_timestamp: toIso(e.updated_ts),
    timeline: e.timeline?.map((t) => ({ ...t, timestamp: toIso(t.ts) })),
  };
}

// Check the query of /events and /events.csv. Returns { filter } or { error: [field, problem] }.
export function eventFilter(config, source, q) {
  const from = parseTime(q.from);
  const to = parseTime(q.to);
  if (from === undefined) return { error: ['from', 'INVALID_TIME'] };
  if (to === undefined) return { error: ['to', 'INVALID_TIME'] };
  if (q.type && !(q.type in EventType)) return { error: ['type', 'UNKNOWN_EVENT_TYPE'] };
  if (q.severity && !(q.severity in Severity)) return { error: ['severity', 'UNKNOWN_SEVERITY'] };
  if (q.status && !(q.status in EventStatus)) return { error: ['status', 'UNKNOWN_STATUS'] };
  if (q.node && !config.topology.nodeById.has(q.node)) return { error: ['node', 'UNKNOWN_NODE'] };
  return {
    filter: {
      source, from, to, type: q.type || null, severity: q.severity || null, status: q.status || null,
      node: q.node || null, q: q.q ? String(q.q).slice(0, 100) : null, limit: q.limit, offset: q.offset,
      excludeInfo: q.exclude_info === '1' || q.exclude_info === 'true',
    },
  };
}

export function topologyBody(config) {
  const t = config.topology;
  return {
    feeder_id: config.feeder.feeder_id,
    name: config.feeder.name,
    nodes: t.orderedNodeIds.map((id) => t.nodeById.get(id)),
    sections: t.sections,
    isolation_points: [...t.switches.values()],
    controllers: [...t.controllersById.values()],
    source_reference_node: t.sourceReferenceNode,
  };
}

// liveUpdates: how the dashboard gets new data – Server-Sent Events from the laptop
// server, or polling every interval_ms from the Cloudflare Worker.
export function configBody(config, { mode, source, liveUpdates = { method: 'sse' } }) {
  return {
    mode,
    source,
    feeder_id: config.feeder.feeder_id,
    feeder_name: config.feeder.name,
    nominal_voltage_v: config.feeder.nominal_voltage_v,
    sensor_full_scale_v: config.feeder.sensor_full_scale_v,
    gauge: { min_v: config.feeder.gauge_min_v, max_v: config.feeder.gauge_max_v },
    capabilities: config.feeder.capabilities,
    detection: config.detection,
    placeholders: config.placeholders,
    simulation: mode === 'sim' ? { allowed_speeds: config.server.simulation.allowed_speeds } : null,
    supervisory_requests_enabled: false,
    live_updates: liveUpdates,
  };
}
