-- D1 database schema for the Cloudflare Worker (LIVE data only – DEMO data never comes here).
-- Apply with:  npx wrangler d1 migrations apply lv-monitor --remote
-- Times are INTEGER epoch milliseconds. The tables follow server/storage/db.js (laptop
-- SQLite), with two differences that keep the free-plan write budget low:
--   * measurements: ONE row per report (all nodes as JSON) instead of one row per node;
--   * pipeline_state: the monitoring memory saved between requests (a Worker keeps none).

-- The monitoring memory (node timers, open events, feeder state). Exactly one row.
-- "version" lets two requests at the same moment notice each other (the later one retries).
CREATE TABLE IF NOT EXISTS pipeline_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  snapshot TEXT NOT NULL
);

-- Every accepted report. "nodes" is a JSON array: node_id, voltage_rms, validity,
-- invalid_reason, ... An invalid or missing reading is stored as null / INVALID, never 0.
CREATE TABLE IF NOT EXISTS measurements (
  id INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  measured_at INTEGER NOT NULL,
  controller_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  device_time INTEGER,
  source TEXT NOT NULL,
  nodes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_measurements_received ON measurements(received_at);

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS ix_rejections_ts ON ingest_rejections(ts);
