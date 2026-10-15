// Shared helpers for the automated tests.

import { loadConfig } from '../server/config/load-config.js';
import { openDatabase } from '../server/storage/db.js';
import { Repository } from '../server/storage/repository.js';
import { Pipeline } from '../server/processing/pipeline.js';

export const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
export const quietLogger = { error() {}, warn() {}, log() {} };

export function testConfig(overrides = {}) {
  return loadConfig({ overrides });
}

export function memoryRepo() {
  return new Repository(openDatabase(':memory:'));
}

// Build a valid controller report. nodes: { 'N-A': 229 | null | { voltage_rms, ...overrides } }
export function makeReport({ seq = 0, boot = 'boot0001', uptime = null, nodes = {}, protection, controller = 'CTRL-01' } = {}) {
  return {
    schema_version: '1.0',
    controller_id: controller,
    boot_id: boot,
    sequence_number: seq,
    uptime_ms: uptime ?? (seq + 1) * 1000,
    device_time: null,
    time_synced: false,
    firmware_version: 'test',
    report_interval_ms: 1000,
    nodes: Object.entries(nodes).map(([id, v]) => {
      const base = { node_id: id, voltage_rms: null, supply_present: true, data_valid: true, sensor_status: 'OK' };
      if (v === null || typeof v === 'number') return { ...base, voltage_rms: v, supply_present: v === null ? null : v > 23 };
      return { ...base, ...v };
    }),
    protection: protection === undefined ? null : protection,
  };
}

export function protection({ commanded = false, feedback = 'CLOSED', lockout = commanded, restore = false } = {}) {
  return {
    protection_enabled: true,
    lockout,
    trip_reason: commanded ? 'TEST_TRIP' : null,
    restore_requested: restore,
    restore_source: restore ? 'LOCAL_BUTTON' : null,
    restoration_permitted: null,
    switches: [{ switch_id: 'SW-1', isolation_commanded: commanded, commanded_change_uptime_ms: null, feedback }],
  };
}

const NORMAL = { 'N-A': 229, 'N-B': 227, 'N-C': 226 };

// A pipeline driven by hand: send(nodes, …) delivers one report per call at 1 s spacing
// and runs the periodic tick in between, like the real server.
export function manualPipeline({ config = testConfig(), repo = memoryRepo(), start = T0 } = {}) {
  const transitions = [];
  const pipeline = new Pipeline({
    config, repo, source: 'SIMULATED', logger: quietLogger,
    onStatus: (_s, actions) => { for (const a of actions) if (a.kind === 'TRANSITION') transitions.push(a.to); },
  });
  pipeline.start(start);
  let t = start;
  let seq = 0;
  const api = {
    pipeline, repo, config, transitions,
    get now() { return t; },
    advance(ms) {
      const end = t + ms;
      while (t + 250 <= end) { t += 250; pipeline.tick(t); }
      if (t < end) { t = end; pipeline.tick(t); }
    },
    send(nodes = NORMAL, opts = {}) {
      api.advance(1000);
      const r = pipeline.ingestReport(makeReport({ seq: seq++, nodes, ...opts }), t);
      return r;
    },
    // Send the same node values for `seconds` consecutive reports.
    hold(nodes, seconds, opts = {}) { for (let i = 0; i < seconds; i++) api.send(nodes, opts); },
    status() { return pipeline.getStatus(); },
    events() { return repo.queryEvents({ source: 'SIMULATED', limit: 1000 }).items.reverse(); },
  };
  return api;
}

export { NORMAL };
