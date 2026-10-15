// Side drawer showing one event in full: fields, measurement snapshot, reasons, timeline.

import {
  EVENT_TYPE_INFO, SEVERITY_INFO, ISOLATION_CONFIRMED_INFO, RECOVERY_INFO, REASON_TEXT, LOCALIZATION_INFO,
} from '/shared/labels.js';
import { getJson } from '../api.js';
import { esc, fmtDateTime, fmtDuration, fmtV, evLabel } from '../format.js';
import { badge, infoBadge, simTag, errorBox } from '../ui.js';

const TIMELINE_TEXT = {
  DETECTED: 'Condition detected',
  ESCALATED_FROM_UNDERVOLTAGE: 'Escalated from undervoltage',
  LOCALIZATION_UPDATED: 'Location estimate updated',
  ISOLATION_REQUESTED: 'Controller commanded isolation',
  ISOLATION_REQUESTED_AGAIN: 'Controller commanded isolation again',
  ISOLATION_CONFIRMED: 'Switch feedback reported OPEN (isolation confirmed)',
  ISOLATION_FEEDBACK_TIMEOUT: 'Feedback did not confirm isolation in time',
  ISOLATION_FEEDBACK_CONTRADICTORY: 'Feedback contradicted the command',
  RESTORATION_REQUESTED: 'Restore requested at the controller',
  RECLOSE_REPORTED: 'Controller released isolation (reclose)',
  SUPPLY_RETURN_DETECTED: 'Supply returned – stability check started',
  RECOVERY_UNSTABLE: 'Supply abnormal again – stability timer reset',
  RESTORATION_FAILED: 'Supply did not return after reclose',
  RECOVERY_STABLE: 'Supply stable for the configured period',
  MONITORING_LOST: 'Monitoring lost (no valid data)',
  MONITORING_RESUMED: 'Monitoring resumed',
  CLOSED: 'Event closed',
};

function detailsText(details) {
  return Object.entries(details ?? {})
    .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="mono">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`)
    .join('');
}

export async function openEventDrawer(eventId, { onClose } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  const drawer = document.createElement('aside');
  drawer.className = 'drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.innerHTML = `<header><h2>${evLabel(eventId)}</h2><span class="spacer"></span><button class="btn" data-close>Close</button></header><div class="body"><div class="loading">Loading…</div></div>`;
  document.body.append(backdrop, drawer);
  const close = () => { backdrop.remove(); drawer.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('click', close);
  drawer.querySelector('[data-close]').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  drawer.querySelector('[data-close]').focus();

  const body = drawer.querySelector('.body');
  let e;
  try {
    e = await getJson(`/events/${eventId}`);
  } catch (err) {
    body.innerHTML = errorBox(`Could not load event: ${err.message}`);
    return;
  }
  const sev = SEVERITY_INFO[e.severity];
  const type = EVENT_TYPE_INFO[e.event_type];
  const snapRows = Object.entries(e.measurement_snapshot ?? {}).map(([id, s]) => `<tr><td class="mono">${esc(id)}</td>
    <td class="num">${fmtV(s.voltage_rms)} V</td><td class="num">${fmtV(s.voltage_rms_min)} V</td>
    <td class="num">${s.current_rms === null || s.current_rms === undefined ? '—' : `${fmtV(s.current_rms, 2)} A`}</td>
    <td>${esc(s.validity ?? '—')}</td><td>${esc(s.condition ?? '—')}</td></tr>`).join('');
  const isoRequested = e.isolation_requested === null ? 'No protection status available' : e.isolation_requested ? `Yes – ${fmtDateTime(e.isolation_requested_timestamp)}` : 'No';

  body.innerHTML = `
    <div class="row">${badge(sev.label, sev.tone)} ${badge(e.status === 'OPEN' ? 'Open' : 'Closed', e.status === 'OPEN' ? 'amber' : 'grey')} ${simTag(e.source)}</div>
    <div><h2>${esc(type?.label ?? e.event_type)}</h2><p class="muted" style="margin:4px 0 0">${esc(type?.description ?? '')}</p></div>
    <dl class="kv">
      <dt>Start (confirmed)</dt><dd>${fmtDateTime(e.start_timestamp)}</dd>
      <dt>First abnormal sample</dt><dd>${fmtDateTime(e.first_observed_timestamp)}</dd>
      <dt>End</dt><dd>${e.end_timestamp ? `${fmtDateTime(e.end_timestamp)}${e.end_ts_quality && e.end_ts_quality !== 'EXACT' ? ` (${esc(e.end_ts_quality.toLowerCase())})` : ''}` : 'still open'}</dd>
      <dt>Duration</dt><dd>${e.duration_ms === null || e.duration_ms === undefined ? (e.status === 'OPEN' ? 'ongoing' : 'unknown (shorter than the report interval)') : `${e.end_ts_quality === 'APPROXIMATE' ? '≈ ' : ''}${fmtDuration(e.duration_ms)}`}</dd>
      <dt>End reason</dt><dd>${esc(e.end_reason ?? '—')}</dd>
      <dt>Nodes</dt><dd class="mono">${esc((e.node_ids ?? []).join(', ') || '—')}</dd>
      <dt>Affected section</dt><dd class="mono">${esc(e.affected_section ?? '—')}</dd>
      <dt>Location status</dt><dd>${e.localization_status ? infoBadge(LOCALIZATION_INFO, e.localization_status) : '—'}</dd>
      <dt>Isolation requested</dt><dd>${esc(isoRequested)}</dd>
      <dt>Isolation result</dt><dd>${e.isolation_confirmed ? infoBadge(ISOLATION_CONFIRMED_INFO, e.isolation_confirmed) : '—'}</dd>
      <dt>Recovery</dt><dd>${e.recovery_status ? infoBadge(RECOVERY_INFO, e.recovery_status) : '—'}</dd>
      <dt>Unstable recoveries</dt><dd>${e.unstable_recovery_count ?? 0}</dd>
      <dt>Related event</dt><dd>${e.related_event_id ? evLabel(e.related_event_id) : '—'}</dd>
    </dl>
    <section><h3>Detection reasons</h3><ul class="explain">${(e.detection_reason ?? []).map((r) => `<li>${esc(REASON_TEXT[r] ?? r)} <span class="chip">${esc(r)}</span></li>`).join('') || '<li>—</li>'}</ul></section>
    ${snapRows ? `<section><h3>Measurements at detection ${simTag(e.source)}</h3><div class="table-wrap"><table><thead><tr><th>Node</th><th>V RMS</th><th>Min in window</th><th>Current</th><th>Data</th><th>Condition</th></tr></thead><tbody>${snapRows}</tbody></table></div></section>` : ''}
    ${e.timeline?.length ? `<section><h3>Timeline</h3><ul class="timeline">${e.timeline.map((t) => `<li><div class="when">${fmtDateTime(t.timestamp)}</div><div>${esc(TIMELINE_TEXT[t.kind] ?? t.kind)}</div>${Object.keys(t.details ?? {}).length ? `<div class="small muted mono">${esc(JSON.stringify(t.details))}</div>` : ''}</li>`).join('')}</ul></section>` : ''}
    ${detailsText(e.details) ? `<section><h3>Details</h3><table><tbody>${detailsText(e.details)}</tbody></table></section>` : ''}`;
}
