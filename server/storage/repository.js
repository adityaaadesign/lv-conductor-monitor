// All SQL lives here. The rest of the server works with plain JS objects.

const JSON_COLUMNS = ['node_ids', 'measurement_snapshot', 'detection_reason', 'details'];

export const EVENT_COLUMNS = [
  'event_type', 'severity', 'status', 'source', 'dedupe_key', 'start_ts', 'first_observed_ts',
  'end_ts', 'end_ts_quality', 'end_reason', 'duration_ms', 'node_ids', 'affected_section',
  'localization_status', 'measurement_snapshot', 'detection_reason', 'isolation_requested',
  'isolation_requested_ts', 'isolation_confirmed', 'isolation_confirmed_ts', 'recovery_status',
  'unstable_recovery_count', 'related_event_id', 'acknowledged_ts', 'acknowledged_by', 'details',
];

export const toDb = (col, v) => {
  if (v === undefined) return null;
  if (JSON_COLUMNS.includes(col)) return JSON.stringify(v ?? (col === 'node_ids' || col === 'detection_reason' ? [] : {}));
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
};

export function eventFromRow(row) {
  if (!row) return null;
  const e = { ...row };
  for (const c of JSON_COLUMNS) e[c] = e[c] ? JSON.parse(e[c]) : (c === 'node_ids' || c === 'detection_reason' ? [] : {});
  e.isolation_requested = e.isolation_requested === null ? null : e.isolation_requested === 1;
  return e;
}

// WHERE clause for the event list (also used by the Cloudflare Worker with D1).
export function eventFilterSql(f) {
  const where = ['source = ?'];
  const args = [f.source];
  if (f.from !== undefined && f.from !== null) { where.push('COALESCE(start_ts, created_ts) >= ?'); args.push(f.from); }
  if (f.to !== undefined && f.to !== null) { where.push('COALESCE(start_ts, created_ts) <= ?'); args.push(f.to); }
  if (f.type) { where.push('event_type = ?'); args.push(f.type); }
  if (f.severity) { where.push('severity = ?'); args.push(f.severity); }
  if (f.excludeInfo) where.push("severity <> 'INFO'");
  if (f.status) { where.push('status = ?'); args.push(f.status); }
  if (f.node) { where.push('node_ids LIKE ?'); args.push(`%"${f.node}"%`); }
  if (f.q) {
    const q = String(f.q).trim();
    const idMatch = /^EV-?0*(\d+)$/i.exec(q);
    if (idMatch) { where.push('event_id = ?'); args.push(Number(idMatch[1])); }
    else {
      where.push('(event_type LIKE ? OR affected_section LIKE ? OR node_ids LIKE ? OR detection_reason LIKE ? OR details LIKE ?)');
      const like = `%${q}%`;
      args.push(like, like, like, like, like);
    }
  }
  return { sql: where.join(' AND '), args };
}

export class Repository {
  constructor(db) {
    this.db = db;
    this.stmts = {
      insertMeasurement: db.prepare(`INSERT INTO measurements
        (received_at, measured_at, controller_id, boot_id, sequence_number, node_id, voltage_rms, voltage_rms_min,
         voltage_rms_max, current_rms, supply_present_reported, data_valid, sensor_status, link_status, validity,
         invalid_reason, late, device_time, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      insertEvent: db.prepare(`INSERT INTO events (${EVENT_COLUMNS.join(',')}, created_ts, updated_ts)
        VALUES (${EVENT_COLUMNS.map(() => '?').join(',')}, ?, ?)`),
      getEvent: db.prepare('SELECT * FROM events WHERE event_id = ?'),
      openEvents: db.prepare("SELECT * FROM events WHERE status = 'OPEN' AND source = ? ORDER BY event_id"),
      insertTimeline: db.prepare('INSERT INTO event_timeline (event_id, ts, kind, details) VALUES (?,?,?,?)'),
      timeline: db.prepare('SELECT ts, kind, details FROM event_timeline WHERE event_id = ? ORDER BY ts, id'),
      insertTransition: db.prepare('INSERT INTO state_transitions (ts, from_state, to_state, reason_codes, source) VALUES (?,?,?,?,?)'),
      insertProtection: db.prepare('INSERT INTO protection_snapshots (ts, controller_id, snapshot) VALUES (?,?,?)'),
      insertAudit: db.prepare('INSERT INTO audit_log (ts, actor, action, target, payload, outcome, outcome_reason) VALUES (?,?,?,?,?,?,?)'),
      insertRejection: db.prepare('INSERT INTO ingest_rejections (ts, controller_id, reason, details, excerpt) VALUES (?,?,?,?,?)'),
      upsertSession: db.prepare(`INSERT INTO controller_sessions
        (controller_id, boot_id, first_seen, last_seen, last_sequence, gap_count, duplicate_count, late_count, firmware_version)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(controller_id, boot_id) DO UPDATE SET
          last_seen = excluded.last_seen, last_sequence = excluded.last_sequence, gap_count = excluded.gap_count,
          duplicate_count = excluded.duplicate_count, late_count = excluded.late_count,
          firmware_version = excluded.firmware_version`),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- meta / audit -----------------------------------------------------------------
  getMeta(key) { return this.stmts.getMeta.get(key)?.value ?? null; }
  setMeta(key, value) { this.stmts.setMeta.run(key, String(value)); }
  audit(ts, actor, action, target = null, payload = null, outcome = null, outcomeReason = null) {
    this.stmts.insertAudit.run(ts, actor, action, target, payload ? JSON.stringify(payload) : null, outcome, outcomeReason);
  }

  // ---- measurements -----------------------------------------------------------------
  insertMeasurements({ receivedAt, measuredAt, report, nodes, late, source }) {
    this.transaction(() => {
      for (const m of nodes) {
        this.stmts.insertMeasurement.run(
          receivedAt, measuredAt, report.controller_id, report.boot_id, report.sequence_number, m.node_id,
          m.voltage_rms, m.voltage_rms_min, m.voltage_rms_max, m.current_rms,
          m.supply_present_reported === null ? null : (m.supply_present_reported ? 1 : 0),
          m.data_valid ? 1 : 0, m.sensor_status, m.link_status, m.validity, m.invalid_reason,
          late ? 1 : 0, report.device_time, source,
        );
      }
    });
  }

  // Most recent valid measurement per node (used to show "last known" values after a restart).
  lastValidPerNode(source) {
    return this.db.prepare(`SELECT m.* FROM measurements m
      JOIN (SELECT node_id, MAX(id) AS id FROM measurements WHERE validity = 'VALID' AND source = ? AND late = 0 GROUP BY node_id) x
      ON m.id = x.id`).all(source);
  }

  // Time series for charts. Returns raw rows, or bucket averages when there are too many points.
  measurementSeries({ nodeIds, from, to, maxPoints = 1500, source }) {
    const out = {};
    const span = Math.max(1, to - from);
    for (const nodeId of nodeIds) {
      const count = this.db.prepare(
        'SELECT COUNT(*) AS n FROM measurements WHERE node_id = ? AND source = ? AND measured_at BETWEEN ? AND ?',
      ).get(nodeId, source, from, to).n;
      if (count <= maxPoints) {
        out[nodeId] = {
          downsampled: false,
          points: this.db.prepare(`SELECT measured_at AS t, voltage_rms AS v, voltage_rms_min AS vmin, voltage_rms_max AS vmax,
              current_rms AS i, validity, invalid_reason, late
            FROM measurements WHERE node_id = ? AND source = ? AND measured_at BETWEEN ? AND ? ORDER BY measured_at, id`)
            .all(nodeId, source, from, to),
        };
      } else {
        const bucket = Math.ceil(span / maxPoints);
        out[nodeId] = {
          downsampled: true,
          bucket_ms: bucket,
          points: this.db.prepare(`SELECT (? + CAST((measured_at - ?) / ? AS INTEGER) * ?) AS t,
              AVG(CASE WHEN validity = 'VALID' THEN voltage_rms END) AS v,
              MIN(CASE WHEN validity = 'VALID' THEN COALESCE(voltage_rms_min, voltage_rms) END) AS vmin,
              MAX(CASE WHEN validity = 'VALID' THEN COALESCE(voltage_rms_max, voltage_rms) END) AS vmax,
              AVG(CASE WHEN validity = 'VALID' THEN current_rms END) AS i,
              CASE WHEN SUM(validity = 'VALID') > 0 THEN 'VALID' ELSE 'INVALID' END AS validity,
              NULL AS invalid_reason, MAX(late) AS late
            FROM measurements WHERE node_id = ? AND source = ? AND measured_at BETWEEN ? AND ?
            GROUP BY CAST((measured_at - ?) / ? AS INTEGER) ORDER BY t`)
            .all(from, from, bucket, bucket, nodeId, source, from, to, from, bucket),
        };
      }
    }
    return out;
  }

  measurementCounts(source) {
    return this.db.prepare(`SELECT node_id, validity, COUNT(*) AS n, SUM(late) AS late
      FROM measurements WHERE source = ? GROUP BY node_id, validity`).all(source);
  }

  // ---- events -----------------------------------------------------------------------
  insertEvent(e, now) {
    const values = EVENT_COLUMNS.map((c) => toDb(c, e[c]));
    const r = this.stmts.insertEvent.run(...values, now, now);
    return Number(r.lastInsertRowid);
  }

  updateEvent(eventId, patch, now) {
    const cols = Object.keys(patch).filter((c) => EVENT_COLUMNS.includes(c));
    if (!cols.length) return;
    const sql = `UPDATE events SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_ts = ? WHERE event_id = ?`;
    this.db.prepare(sql).run(...cols.map((c) => toDb(c, patch[c])), now, eventId);
  }

  getEvent(eventId) {
    const e = eventFromRow(this.stmts.getEvent.get(eventId));
    if (e) e.timeline = this.stmts.timeline.all(eventId).map((t) => ({ ...t, details: JSON.parse(t.details) }));
    return e;
  }

  getOpenEvents(source) { return this.stmts.openEvents.all(source).map(eventFromRow); }

  insertTimeline(eventId, ts, kind, details) {
    this.stmts.insertTimeline.run(eventId, ts, kind, JSON.stringify(details ?? {}));
  }

  queryEvents(f) {
    const { sql, args } = eventFilterSql(f);
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${sql}`).get(...args).n;
    const limit = Math.min(Math.max(1, Number(f.limit) || 50), 1000);
    const offset = Math.max(0, Number(f.offset) || 0);
    const items = this.db.prepare(`SELECT * FROM events WHERE ${sql} ORDER BY COALESCE(start_ts, created_ts) DESC, event_id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset).map(eventFromRow);
    return { total, items, limit, offset };
  }

  // ---- transitions, protection, rejections, sessions ---------------------------------
  insertTransition(ts, from, to, reasons, source) {
    this.stmts.insertTransition.run(ts, from, to, JSON.stringify(reasons ?? []), source);
  }

  transitions({ from, to, source, limit = 500 }) {
    return this.db.prepare(`SELECT ts, from_state, to_state, reason_codes FROM state_transitions
      WHERE source = ? AND ts BETWEEN ? AND ? ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(source, from, to, limit)
      .map((r) => ({ ...r, reason_codes: JSON.parse(r.reason_codes) }))
      .reverse();
  }

  lastTransition(source) {
    const r = this.db.prepare('SELECT ts, from_state, to_state FROM state_transitions WHERE source = ? ORDER BY id DESC LIMIT 1').get(source);
    return r ?? null;
  }

  insertProtectionSnapshot(ts, controllerId, snapshot) {
    this.stmts.insertProtection.run(ts, controllerId, JSON.stringify(snapshot));
  }

  insertRejection(ts, controllerId, reason, details, excerpt) {
    this.stmts.insertRejection.run(ts, controllerId, reason, JSON.stringify(details ?? null), excerpt);
  }

  recentRejections(limit = 50) {
    return this.db.prepare('SELECT ts, controller_id, reason, details, excerpt FROM ingest_rejections ORDER BY id DESC LIMIT ?')
      .all(limit).map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }

  upsertSession(s) {
    this.stmts.upsertSession.run(s.controller_id, s.boot_id, s.first_seen, s.last_seen, s.last_sequence,
      s.gap_count, s.duplicate_count, s.late_count, s.firmware_version);
  }

  latestSessions() {
    return this.db.prepare(`SELECT s.* FROM controller_sessions s
      JOIN (SELECT controller_id, MAX(last_seen) AS ls FROM controller_sessions GROUP BY controller_id) x
      ON s.controller_id = x.controller_id AND s.last_seen = x.ls`).all();
  }

  // Latest time written anywhere (used so the simulated clock never runs backwards).
  latestTimestamp() {
    const r = this.db.prepare(`SELECT MAX(t) AS t FROM (
      SELECT MAX(received_at) AS t FROM measurements
      UNION ALL SELECT MAX(ts) FROM state_transitions
      UNION ALL SELECT MAX(updated_ts) FROM events
      UNION ALL SELECT MAX(ts) FROM audit_log)`).get();
    return r?.t ?? null;
  }

  // ---- housekeeping ----------------------------------------------------------------
  applyRetention(now, { measurementsDays, rejectionsDays }) {
    const day = 24 * 3600 * 1000;
    this.db.prepare('DELETE FROM measurements WHERE received_at < ?').run(now - measurementsDays * day);
    this.db.prepare('DELETE FROM ingest_rejections WHERE ts < ?').run(now - rejectionsDays * day);
  }

  // Simulation only: wipe all history (the caller checks the run mode).
  clearAll() {
    this.transaction(() => {
      for (const t of ['measurements', 'events', 'event_timeline', 'state_transitions', 'protection_snapshots',
        'ingest_rejections', 'controller_sessions']) {
        this.db.exec(`DELETE FROM ${t}`);
      }
      this.db.exec("DELETE FROM meta WHERE key <> 'schema_version'");
    });
  }
}
