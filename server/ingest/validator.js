// Stage 2 of the pipeline: validate a controller report (docs/DATA_CONTRACT.md §3–§4).
// Incoming data is untrusted. Structural problems reject the whole report (firmware bug);
// unknown nodes are rejected individually; unusable values make a measurement INVALID
// but never get replaced by an invented number.

import {
  SCHEMA_VERSION, ID_PATTERN, SensorStatus, LinkStatus, ReportedFeedback, RestoreSource,
  NodeValidity, InvalidReason,
} from '../../shared/enums.js';

const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool = (v) => typeof v === 'boolean';
const isNumOrNull = (v) => v === null || isNum(v);
const isIntOrNull = (v) => v === null || isInt(v);
const BOOT_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_NODES = 32;
const MAX_SWITCHES = 8;

function fail(error, details) {
  return { ok: false, error, details };
}

function checkProtection(p, topology, err) {
  if (p === null) return;
  if (typeof p !== 'object' || Array.isArray(p)) { err('protection', 'NOT_AN_OBJECT'); return; }
  for (const k of ['protection_enabled', 'lockout', 'restore_requested']) {
    if (!isBool(p[k])) err(`protection.${k}`, 'NOT_A_BOOLEAN');
  }
  if (!(p.trip_reason === null || (typeof p.trip_reason === 'string' && p.trip_reason.length <= 64))) {
    err('protection.trip_reason', 'NOT_A_SHORT_STRING_OR_NULL');
  }
  if (!(p.restore_source === null || p.restore_source in RestoreSource)) err('protection.restore_source', 'UNKNOWN_ENUM');
  if (!(p.restoration_permitted === null || isBool(p.restoration_permitted))) err('protection.restoration_permitted', 'NOT_A_BOOLEAN_OR_NULL');
  if (!Array.isArray(p.switches) || p.switches.length > MAX_SWITCHES) { err('protection.switches', 'NOT_AN_ARRAY'); return; }
  p.switches.forEach((sw, i) => {
    const f = `protection.switches[${i}]`;
    if (!sw || typeof sw !== 'object') { err(f, 'NOT_AN_OBJECT'); return; }
    if (typeof sw.switch_id !== 'string' || !topology.switches.has(sw.switch_id)) err(`${f}.switch_id`, 'NOT_CONFIGURED');
    if (!isBool(sw.isolation_commanded)) err(`${f}.isolation_commanded`, 'NOT_A_BOOLEAN');
    if (!isIntOrNull(sw.commanded_change_uptime_ms)) err(`${f}.commanded_change_uptime_ms`, 'NOT_AN_INTEGER_OR_NULL');
    if (!(sw.feedback in ReportedFeedback)) err(`${f}.feedback`, 'UNKNOWN_ENUM');
  });
}

function checkNodeShape(n, i, err) {
  const f = `nodes[${i}]`;
  if (!n || typeof n !== 'object' || Array.isArray(n)) { err(f, 'NOT_AN_OBJECT'); return false; }
  if (typeof n.node_id !== 'string' || !ID_PATTERN.test(n.node_id)) err(`${f}.node_id`, 'INVALID_ID');
  for (const k of ['voltage_rms', 'supply_present', 'data_valid', 'sensor_status']) {
    if (!(k in n)) err(`${f}.${k}`, 'MISSING_FIELD');
  }
  if ('voltage_rms' in n && !isNumOrNull(n.voltage_rms)) err(`${f}.voltage_rms`, 'NOT_A_NUMBER');
  if ('data_valid' in n && !isBool(n.data_valid)) err(`${f}.data_valid`, 'NOT_A_BOOLEAN');
  if ('supply_present' in n && !(n.supply_present === null || isBool(n.supply_present))) err(`${f}.supply_present`, 'NOT_A_BOOLEAN_OR_NULL');
  if ('sensor_status' in n && !(n.sensor_status in SensorStatus)) err(`${f}.sensor_status`, 'UNKNOWN_ENUM');
  for (const k of ['voltage_rms_min', 'voltage_rms_max', 'current_rms']) {
    if (k in n && !isNumOrNull(n[k])) err(`${f}.${k}`, 'NOT_A_NUMBER');
  }
  for (const k of ['rms_window_ms', 'sequence_number', 'sample_uptime_ms']) {
    if (k in n && !isIntOrNull(n[k])) err(`${f}.${k}`, 'NOT_AN_INTEGER');
  }
  if ('link_status' in n && !(n.link_status in LinkStatus)) err(`${f}.link_status`, 'UNKNOWN_ENUM');
  return true;
}

// Decide whether one measurement is usable (DATA_CONTRACT §4 rule 8).
export function classifyMeasurement(n, nodeCfg, fullScaleV) {
  const flags = [];
  const m = {
    node_id: n.node_id,
    voltage_rms: n.voltage_rms ?? null,
    voltage_rms_min: n.voltage_rms_min ?? null,
    voltage_rms_max: n.voltage_rms_max ?? null,
    rms_window_ms: n.rms_window_ms ?? null,
    current_rms: n.current_rms ?? null,
    supply_present_reported: n.supply_present ?? null,
    data_valid: n.data_valid,
    sensor_status: n.sensor_status,
    link_status: n.link_status ?? LinkStatus.NOT_APPLICABLE,
    validity: NodeValidity.VALID,
    invalid_reason: null,
    flags,
  };
  const invalid = (reason) => { m.validity = NodeValidity.INVALID; m.invalid_reason = reason; return m; };

  if (m.current_rms !== null && !nodeCfg.has_current_sensor) {
    m.current_rms = null;
    flags.push('CURRENT_NOT_CONFIGURED');
  }
  for (const k of ['voltage_rms_min', 'voltage_rms_max']) {
    if (m[k] !== null && (m[k] < 0 || m[k] > fullScaleV)) { m[k] = null; flags.push(`${k.toUpperCase()}_OUT_OF_RANGE`); }
  }

  if (m.link_status === LinkStatus.LOST) return invalid(InvalidReason.LINK_LOST);
  if (m.sensor_status !== SensorStatus.OK) return invalid(InvalidReason.SENSOR_FAULT);
  if (!m.data_valid) return invalid(InvalidReason.DATA_FLAGGED_INVALID);
  if (m.voltage_rms === null) return invalid(InvalidReason.MISSING_VALUE);
  if (m.voltage_rms < 0 || m.voltage_rms > fullScaleV) return invalid(InvalidReason.OUT_OF_RANGE);
  return m;
}

// Returns { ok:false, error, details } or
// { ok:true, report, nodes:[measurement...], rejectedNodes:[...], flags:[...] }
export function validateReport(raw, config, receivedAt) {
  const { topology, feeder, server } = config;
  const details = [];
  const err = (field, problem) => details.push({ field, problem });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('MALFORMED_REPORT', [{ field: '(root)', problem: 'NOT_AN_OBJECT' }]);
  }
  if (raw.schema_version !== SCHEMA_VERSION) err('schema_version', 'UNSUPPORTED_VERSION');
  if (typeof raw.controller_id !== 'string' || !ID_PATTERN.test(raw.controller_id)) {
    err('controller_id', 'INVALID_ID');
  } else if (!topology.controllersById.has(raw.controller_id)) {
    return fail('UNKNOWN_CONTROLLER', [{ field: 'controller_id', problem: 'NOT_CONFIGURED' }]);
  }
  if (typeof raw.boot_id !== 'string' || !BOOT_ID.test(raw.boot_id)) err('boot_id', 'INVALID_BOOT_ID');
  if (!isInt(raw.sequence_number) || raw.sequence_number < 0) err('sequence_number', 'NOT_A_NON_NEGATIVE_INTEGER');
  if (!isInt(raw.uptime_ms) || raw.uptime_ms < 0) err('uptime_ms', 'NOT_A_NON_NEGATIVE_INTEGER');
  if (!isInt(raw.report_interval_ms) || raw.report_interval_ms <= 0) err('report_interval_ms', 'NOT_A_POSITIVE_INTEGER');
  if (!isBool(raw.time_synced)) err('time_synced', 'NOT_A_BOOLEAN');
  if (!(raw.device_time === null || typeof raw.device_time === 'string')) err('device_time', 'NOT_A_STRING_OR_NULL');
  if ('firmware_version' in raw && !(raw.firmware_version === null || typeof raw.firmware_version === 'string')) {
    err('firmware_version', 'NOT_A_STRING_OR_NULL');
  }
  if (!('protection' in raw)) err('protection', 'MISSING_FIELD');
  else checkProtection(raw.protection, topology, err);

  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0 || raw.nodes.length > MAX_NODES) {
    err('nodes', 'MUST_BE_NON_EMPTY_ARRAY');
  } else {
    const seen = new Set();
    raw.nodes.forEach((n, i) => {
      if (checkNodeShape(n, i, err) && typeof n.node_id === 'string') {
        if (seen.has(n.node_id)) err(`nodes[${i}].node_id`, 'DUPLICATE_NODE');
        seen.add(n.node_id);
      }
    });
  }
  if (details.length) return fail('VALIDATION_FAILED', details);

  const flags = [];
  let deviceTime = null;
  if (raw.device_time !== null) {
    const parsed = Date.parse(raw.device_time);
    const tolerance = server?.device_time_tolerance_ms ?? 5000;
    if (raw.time_synced && Number.isFinite(parsed) && Math.abs(parsed - receivedAt) <= tolerance) deviceTime = parsed;
    else flags.push('TIME_UNSYNCED');
  }

  const nodes = [];
  const rejectedNodes = [];
  for (const n of raw.nodes) {
    const cfg = topology.nodeById.get(n.node_id);
    if (!cfg) { rejectedNodes.push({ node_id: n.node_id, reason: 'UNKNOWN_NODE' }); continue; }
    if (topology.controllerOf(n.node_id) !== raw.controller_id) {
      rejectedNodes.push({ node_id: n.node_id, reason: 'NODE_NOT_ASSIGNED_TO_CONTROLLER' });
      continue;
    }
    nodes.push(classifyMeasurement(n, cfg, feeder.sensor_full_scale_v));
  }

  return {
    ok: true,
    report: {
      controller_id: raw.controller_id,
      boot_id: raw.boot_id,
      sequence_number: raw.sequence_number,
      uptime_ms: raw.uptime_ms,
      report_interval_ms: raw.report_interval_ms,
      firmware_version: raw.firmware_version ?? null,
      device_time: deviceTime,
      protection: raw.protection,
    },
    nodes,
    rejectedNodes,
    flags,
  };
}

// Tracks boot sessions per controller to detect duplicates, late (out-of-order)
// reports, sequence gaps and reboots (DATA_CONTRACT §4 rules 5–7).
export class SessionTracker {
  constructor(maxRemembered = 2048) {
    this.max = maxRemembered;
    this.sessions = new Map();
  }

  // Seed from the database after a server restart, so a continuing session is not
  // mistaken for a reboot.
  seed(controllerId, bootId, lastSeq) {
    this.sessions.set(controllerId, this.#newSession(bootId, lastSeq));
  }

  #newSession(bootId, lastSeq = null) {
    return {
      bootId, lastSeq, offset: null, seen: new Set(), oldBoots: new Set(),
      duplicates: 0, late: 0, gaps: 0, reports: 0,
    };
  }

  #remember(s, key) {
    s.seen.add(key);
    if (s.seen.size > this.max) s.seen.delete(s.seen.values().next().value);
  }

  // Returns { kind: 'NEW'|'DUPLICATE'|'LATE', reboot, previousBootId, gap, measuredAt }
  classify(controllerId, bootId, seq, receivedAt, uptimeMs) {
    let s = this.sessions.get(controllerId);
    let reboot = false;
    let previousBootId = null;
    if (!s) {
      s = this.#newSession(bootId);
      this.sessions.set(controllerId, s);
    } else if (bootId !== s.bootId) {
      if (s.oldBoots.has(bootId)) {
        // A report from an earlier boot arriving after the reboot: history only.
        const key = `${bootId}:${seq}`;
        if (s.seen.has(key)) { s.duplicates++; return { kind: 'DUPLICATE', reboot: false, gap: 0, measuredAt: receivedAt }; }
        this.#remember(s, key);
        s.late++;
        return { kind: 'LATE', reboot: false, gap: 0, measuredAt: receivedAt };
      }
      previousBootId = s.bootId;
      const fresh = this.#newSession(bootId);
      fresh.oldBoots = new Set([...s.oldBoots, s.bootId]);
      fresh.seen = s.seen;
      fresh.duplicates = s.duplicates;
      fresh.late = s.late;
      fresh.gaps = s.gaps;
      fresh.reports = s.reports;
      s = fresh;
      this.sessions.set(controllerId, s);
      reboot = true;
    }

    const key = `${bootId}:${seq}`;
    if (s.seen.has(key)) {
      s.duplicates++;
      return { kind: 'DUPLICATE', reboot, previousBootId, gap: 0, measuredAt: receivedAt };
    }
    this.#remember(s, key);
    s.reports++;

    // Estimate when the report was measured: uptime + (smallest receive-minus-uptime seen).
    const offsetNow = receivedAt - uptimeMs;
    if (s.offset === null || offsetNow < s.offset) s.offset = offsetNow;
    const measuredAt = uptimeMs + s.offset;

    // seq <= lastSeq: older than (or a re-send of) what was already processed. Within one
    // server run an exact re-send is caught as DUPLICATE above; after a server restart the
    // "seen" set is empty, so a re-send of the last report is treated as late history.
    if (s.lastSeq !== null && seq <= s.lastSeq) {
      s.late++;
      return { kind: 'LATE', reboot, previousBootId, gap: 0, measuredAt };
    }
    const gap = s.lastSeq !== null && seq > s.lastSeq + 1 ? seq - s.lastSeq - 1 : 0;
    s.gaps += gap;
    s.lastSeq = seq;
    return { kind: 'NEW', reboot, previousBootId, gap, measuredAt };
  }

  stats(controllerId) {
    const s = this.sessions.get(controllerId);
    if (!s) return null;
    return { boot_id: s.bootId, last_sequence: s.lastSeq, duplicates: s.duplicates, late: s.late, gaps: s.gaps, reports: s.reports };
  }
}
