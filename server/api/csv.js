// CSV export of event history. Unavailable values are written as empty cells, never 0.

import { toIso } from '../domain/clock.js';

const COLUMNS = [
  ['source', (e) => e.source],
  ['event_id', (e) => `EV-${String(e.event_id).padStart(6, '0')}`],
  ['event_type', (e) => e.event_type],
  ['severity', (e) => e.severity],
  ['status', (e) => e.status],
  ['start_timestamp', (e) => toIso(e.start_ts)],
  ['first_observed_timestamp', (e) => toIso(e.first_observed_ts)],
  ['end_timestamp', (e) => toIso(e.end_ts)],
  ['end_timestamp_quality', (e) => e.end_ts_quality],
  ['duration_s', (e) => (e.duration_ms === null || e.duration_ms === undefined ? '' : (e.duration_ms / 1000).toFixed(1))],
  ['node_ids', (e) => (e.node_ids ?? []).join(' ')],
  ['affected_section', (e) => e.affected_section],
  ['localization_status', (e) => e.localization_status],
  ['voltage_at_detection_v', (e) => Object.entries(e.measurement_snapshot ?? {})
    .map(([id, s]) => `${id}=${s.voltage_rms === null || s.voltage_rms === undefined ? 'n/a' : s.voltage_rms}`).join(' ')],
  ['current_at_detection_a', (e) => Object.entries(e.measurement_snapshot ?? {})
    .filter(([, s]) => s.current_rms !== null && s.current_rms !== undefined)
    .map(([id, s]) => `${id}=${s.current_rms}`).join(' ')],
  ['detection_reason', (e) => (e.detection_reason ?? []).join(' ')],
  ['isolation_requested', (e) => (e.isolation_requested === null || e.isolation_requested === undefined ? 'unavailable' : String(e.isolation_requested))],
  ['isolation_confirmed', (e) => e.isolation_confirmed],
  ['recovery_status', (e) => e.recovery_status],
  ['unstable_recovery_count', (e) => e.unstable_recovery_count],
  ['end_reason', (e) => e.end_reason],
  ['acknowledged', (e) => (e.acknowledged_ts ? `${toIso(e.acknowledged_ts)} by ${e.acknowledged_by}` : '')],
];

function cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function eventsToCsv(events) {
  const lines = [COLUMNS.map(([h]) => h).join(',')];
  for (const e of events) lines.push(COLUMNS.map(([, f]) => cell(f(e))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
