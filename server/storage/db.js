// Opens the SQLite database (Node's built-in node:sqlite) and creates the schema.
// Times are stored as INTEGER epoch milliseconds; the API converts them to ISO 8601.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS measurements (
  id INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  measured_at INTEGER NOT NULL,
  controller_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  voltage_rms REAL,
  voltage_rms_min REAL,
  voltage_rms_max REAL,
  current_rms REAL,
  supply_present_reported INTEGER,
  data_valid INTEGER,
  sensor_status TEXT,
  link_status TEXT,
  validity TEXT NOT NULL,
  invalid_reason TEXT,
  late INTEGER NOT NULL DEFAULT 0,
  device_time INTEGER,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_measurements_node_time ON measurements(node_id, measured_at);
CREATE INDEX IF NOT EXISTS ix_measurements_received ON measurements(received_at);

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  dedupe_key TEXT,
  start_ts INTEGER,
  first_observed_ts INTEGER,
  end_ts INTEGER,
  end_ts_quality TEXT,
  end_reason TEXT,
  duration_ms INTEGER,
  node_ids TEXT NOT NULL DEFAULT '[]',
  affected_section TEXT,
  localization_status TEXT,
  measurement_snapshot TEXT NOT NULL DEFAULT '{}',
  detection_reason TEXT NOT NULL DEFAULT '[]',
  isolation_requested INTEGER,
  isolation_requested_ts INTEGER,
  isolation_confirmed TEXT,
  isolation_confirmed_ts INTEGER,
  recovery_status TEXT,
  unstable_recovery_count INTEGER NOT NULL DEFAULT 0,
  related_event_id INTEGER,
  acknowledged_ts INTEGER,
  acknowledged_by TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);
-- At most one OPEN event per condition (STATE_MACHINE §7.1).
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_open_key ON events(dedupe_key) WHERE status = 'OPEN' AND dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_events_start ON events(start_ts);

CREATE TABLE IF NOT EXISTS event_timeline (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_timeline_event ON event_timeline(event_id, ts);

CREATE TABLE IF NOT EXISTS state_transitions (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_codes TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_transitions_ts ON state_transitions(ts);

CREATE TABLE IF NOT EXISTS protection_snapshots (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  controller_id TEXT NOT NULL,
  snapshot TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  payload TEXT,
  outcome TEXT,
  outcome_reason TEXT
);

CREATE TABLE IF NOT EXISTS ingest_rejections (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  controller_id TEXT,
  reason TEXT NOT NULL,
  details TEXT,
  excerpt TEXT
);

CREATE TABLE IF NOT EXISTS controller_sessions (
  controller_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_sequence INTEGER,
  gap_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  late_count INTEGER NOT NULL DEFAULT 0,
  firmware_version TEXT,
  PRIMARY KEY (controller_id, boot_id)
);
`;

// filePath ':memory:' gives a throw-away database (used by tests).
export function openDatabase(filePath) {
  if (filePath !== ':memory:') mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  return db;
}
