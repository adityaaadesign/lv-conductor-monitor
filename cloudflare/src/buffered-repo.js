// The repository the processing pipeline writes to inside the Worker.
//
// The pipeline was written for the laptop's synchronous SQLite. D1 is asynchronous, so
// this class COLLECTS the writes as prepared D1 statements while the pipeline runs; the
// Worker then sends them to D1 in one batch (all or nothing), together with the saved
// memory. The few things the pipeline reads back during processing are kept in "state",
// which is saved with the memory.

import { EVENT_COLUMNS, toDb } from '../../server/storage/repository.js';

const RECENT_EVENTS_KEPT = 10;

export function newRepoState() {
  return { nextEventId: 1, eventsVersion: 0, meta: {}, lastTransition: null, recentEvents: [] };
}

export class BufferedRepo {
  constructor(db, state = newRepoState()) {
    this.db = db;
    this.state = state;
    this.queue = [];
  }

  get dirty() { return this.queue.length > 0; }

  #write(sql, ...args) {
    this.queue.push(this.db.prepare(sql).bind(...args.map((a) => (a === undefined ? null : a))));
  }

  transaction(fn) { return fn(); }   // the whole batch is one transaction anyway

  // ---- meta / audit ---------------------------------------------------------------
  getMeta(key) { return this.state.meta[key] ?? null; }
  setMeta(key, value) { this.state.meta[key] = String(value); }
  audit(ts, actor, action, target = null, payload = null, outcome = null, outcomeReason = null) {
    this.#write('INSERT INTO audit_log (ts, actor, action, target, payload, outcome, outcome_reason) VALUES (?,?,?,?,?,?,?)',
      ts, actor, action, target, payload ? JSON.stringify(payload) : null, outcome, outcomeReason);
  }

  // ---- measurements (one row per report) -------------------------------------------
  insertMeasurements({ receivedAt, measuredAt, report, nodes, late, source }) {
    const list = nodes.map((m) => ({
      node_id: m.node_id,
      voltage_rms: m.voltage_rms,
      voltage_rms_min: m.voltage_rms_min,
      voltage_rms_max: m.voltage_rms_max,
      current_rms: m.current_rms,
      supply_present_reported: m.supply_present_reported,
      data_valid: m.data_valid,
      sensor_status: m.sensor_status,
      link_status: m.link_status,
      validity: m.validity,
      invalid_reason: m.invalid_reason,
    }));
    this.#write(`INSERT INTO measurements (received_at, measured_at, controller_id, boot_id, sequence_number, late, device_time, source, nodes)
      VALUES (?,?,?,?,?,?,?,?,?)`,
    receivedAt, measuredAt, report.controller_id, report.boot_id, report.sequence_number, late ? 1 : 0,
    report.device_time, source, JSON.stringify(list));
  }

  // The Worker never restarts with an empty memory, so nothing has to be re-loaded.
  lastValidPerNode() { return []; }
  latestSessions() { return []; }
  getOpenEvents() { return []; }

  // Report counters per controller live in the saved memory (no extra database writes).
  upsertSession() {}

  // ---- events ---------------------------------------------------------------------
  insertEvent(e, now) {
    const id = this.state.nextEventId++;
    this.#write(`INSERT INTO events (event_id, ${EVENT_COLUMNS.join(',')}, created_ts, updated_ts)
      VALUES (?, ${EVENT_COLUMNS.map(() => '?').join(',')}, ?, ?)`,
    id, ...EVENT_COLUMNS.map((c) => toDb(c, e[c])), now, now);
    this.#remember({ ...structuredClone(e), event_id: id, created_ts: now, updated_ts: now });
    this.state.eventsVersion++;
    return id;
  }

  updateEvent(eventId, patch, now) {
    const cols = Object.keys(patch).filter((c) => EVENT_COLUMNS.includes(c));
    if (!cols.length) return;
    this.#write(`UPDATE events SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_ts = ? WHERE event_id = ?`,
      ...cols.map((c) => toDb(c, patch[c])), now, eventId);
    const cached = this.state.recentEvents.find((x) => x.event_id === eventId);
    if (cached) Object.assign(cached, structuredClone(patch), { updated_ts: now });
    this.state.eventsVersion++;
  }

  // Only used for the most recent brief-dip event (to count further dips on it).
  getEvent(eventId) {
    const e = this.state.recentEvents.find((x) => x.event_id === eventId);
    return e ? structuredClone(e) : null;
  }

  #remember(e) {
    this.state.recentEvents.push(e);
    if (this.state.recentEvents.length > RECENT_EVENTS_KEPT) this.state.recentEvents.shift();
  }

  insertTimeline(eventId, ts, kind, details) {
    this.#write('INSERT INTO event_timeline (event_id, ts, kind, details) VALUES (?,?,?,?)',
      eventId, ts, kind, JSON.stringify(details ?? {}));
    this.state.eventsVersion++;
  }

  // ---- transitions, protection, rejections -------------------------------------------
  insertTransition(ts, from, to, reasons, source) {
    this.#write('INSERT INTO state_transitions (ts, from_state, to_state, reason_codes, source) VALUES (?,?,?,?,?)',
      ts, from, to, JSON.stringify(reasons ?? []), source);
    this.state.lastTransition = { ts, from_state: from, to_state: to };
  }

  lastTransition() { return this.state.lastTransition; }

  insertProtectionSnapshot(ts, controllerId, snapshot) {
    this.#write('INSERT INTO protection_snapshots (ts, controller_id, snapshot) VALUES (?,?,?)', ts, controllerId, JSON.stringify(snapshot));
  }

  insertRejection(ts, controllerId, reason, details, excerpt) {
    this.#write('INSERT INTO ingest_rejections (ts, controller_id, reason, details, excerpt) VALUES (?,?,?,?,?)',
      ts, controllerId, reason, JSON.stringify(details ?? null), excerpt);
  }
}
