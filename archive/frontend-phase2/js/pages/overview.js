// Page A – Overview: feeder status, the reasons behind it, live node readings,
// isolation (commanded vs confirmed), recovery, alerts and communication health.

import {
  FEEDER_STATE_INFO, NODE_CONDITION_INFO, VALIDITY_INFO, INVALID_REASON_TEXT, LOCALIZATION_INFO,
  RECOVERY_INFO, ISOLATION_COMMAND_INFO, ISOLATION_FEEDBACK_INFO, ISOLATION_CONFIRMED_INFO,
  EVENT_TYPE_INFO, SEVERITY_INFO, TONE_ICON,
} from '/shared/labels.js';
import { esc, fmtTime, fmtAge, fmtV, fmtDuration, evLabel } from '../format.js';
import { badge, infoBadge, simTag, progressBar, reasonChips } from '../ui.js';

function nodeTone(n) {
  if (n.validity !== 'VALID') return 'grey';
  return NODE_CONDITION_INFO[n.condition]?.tone ?? 'grey';
}

function nodeCard(n, status, store) {
  const tone = nodeTone(n);
  const src = status.source;
  const now = status.server_now;
  const valid = n.validity === 'VALID';
  let reading;
  let sub;
  if (valid) {
    reading = `<div class="reading num">${fmtV(n.last_valid_voltage_rms)}<span class="unit">V RMS</span> ${simTag(src)}</div>`;
    sub = `${n.last_valid_pu !== null ? `${n.last_valid_pu.toFixed(3)} pu` : ''} · measured ${fmtTime(n.last_valid_at)}`;
  } else {
    reading = '<div class="reading invalid num">—<span class="unit">V RMS</span></div>';
    if (n.last_valid_voltage_rms !== null && n.last_valid_at) {
      sub = `No current valid reading. Last valid: ${fmtV(n.last_valid_voltage_rms)} V at ${fmtTime(n.last_valid_at)} (${fmtAge(n.last_valid_at, now)})${n.last_valid_from_history ? ' – stored before server restart' : ''}`;
    } else {
      sub = 'No valid reading received yet.';
    }
  }
  const current = n.has_current_sensor
    ? (valid && n.last_valid_current_rms !== null ? `${fmtV(n.last_valid_current_rms, 2)} A` : '—')
    : '<span class="muted">Not measured (no sensor fitted)</span>';
  const reported = n.supply_present_reported === null ? '—' : n.supply_present_reported ? 'Yes' : 'No';
  const recovering = n.condition === 'RECOVERING' && n.recovering_for_ms !== null && valid
    ? `<div class="small muted" style="margin-top:8px">Stability check ${fmtDuration(n.recovering_for_ms)} / ${fmtDuration(status.recovery_required_ms)}</div>${progressBar(n.recovering_for_ms / status.recovery_required_ms)}`
    : '';
  const notes = [];
  if (n.isolation_effect === 'CONFIRMED') notes.push('De-energised on purpose: isolation upstream of this node is confirmed by switch feedback.');
  if (n.isolation_effect === 'UNCONFIRMED') notes.push('Isolation has been commanded upstream of this node but is NOT confirmed – the node may still be energised.');
  if (n.validity === 'INVALID') notes.push(`${INVALID_REASON_TEXT[n.invalid_reason] ?? n.invalid_reason}. The reported value is not used or displayed as a measurement.`);
  if (n.validity === 'STALE' || n.validity === 'OFFLINE') notes.push('Communication / data problem – this is not evidence that supply is lost.');

  return `<article class="card node-card tone-border-${tone}" aria-label="${esc(n.label)}">
    <header>
      <div><h2>${esc(n.label)}</h2><span class="mono muted">${esc(n.node_id)} · section ${esc(n.section_id)}</span></div>
      <div class="row">${infoBadge(VALIDITY_INFO, n.validity)}</div>
    </header>
    <div class="row">${valid ? infoBadge(NODE_CONDITION_INFO, n.condition) : badge(`Last known: ${NODE_CONDITION_INFO[n.condition]?.label ?? n.condition}`, 'grey')}</div>
    ${reading}
    <div class="sub">${esc(sub)}</div>
    ${recovering}
    <dl class="kv">
      <dt>Min / max in window</dt><dd class="num">${valid ? `${fmtV(n.last_valid_voltage_rms_min)} / ${fmtV(n.last_valid_voltage_rms_max)} V` : '—'}</dd>
      <dt>Current</dt><dd>${current}</dd>
      <dt>Controller says supply present</dt><dd>${reported}</dd>
      <dt>Sensor status</dt><dd>${esc(n.sensor_status ?? '—')}</dd>
      <dt>Last message</dt><dd>${n.last_message_at ? `${fmtTime(n.last_message_at)} (${fmtAge(n.last_message_at, now)})` : '—'}</dd>
    </dl>
    ${notes.map((t) => `<div class="note">${esc(t)}</div>`).join('')}
  </article>`;
}

function isolationFact(status) {
  const cmd = ISOLATION_COMMAND_INFO[status.isolation_command_state] ?? { label: status.isolation_command_state, tone: 'grey' };
  const fb = ISOLATION_FEEDBACK_INFO[status.isolation_feedback_state] ?? { label: status.isolation_feedback_state, tone: 'grey' };
  const conf = ISOLATION_CONFIRMED_INFO[status.isolation_confirmed];
  return `<div class="fact"><div class="k">Isolation</div>
    <div class="v">Command: ${badge(cmd.label, cmd.tone)}</div>
    <div class="v" style="margin-top:4px">Feedback: ${badge(fb.label, fb.tone)}</div>
    ${status.isolation_command_state !== 'NONE' && conf ? `<div class="s">Result: ${esc(conf.label)}</div>` : ''}
    ${status.isolation.trip_reason ? `<div class="s">Trip reason (controller): <span class="mono">${esc(status.isolation.trip_reason)}</span></div>` : ''}
  </div>`;
}

function recoveryFact(status) {
  const info = RECOVERY_INFO[status.recovery_state] ?? { label: status.recovery_state, tone: 'grey' };
  const prog = status.recovery_stable_for_ms !== null
    ? `<div class="s">${fmtDuration(status.recovery_stable_for_ms)} of ${fmtDuration(status.recovery_required_ms)} stable</div>${progressBar(status.recovery_stable_for_ms / status.recovery_required_ms)}`
    : '';
  return `<div class="fact"><div class="k">Recovery</div><div class="v">${badge(info.label, info.tone)}</div>${prog}
    ${status.unstable_recovery_count ? `<div class="s">Unstable recoveries this incident: ${status.unstable_recovery_count}</div>` : ''}</div>`;
}

function locationFact(status) {
  const info = LOCALIZATION_INFO[status.localization_status] ?? { label: status.localization_status, tone: 'grey' };
  let v;
  if (status.affected_section) v = `Section <b class="mono">${esc(status.affected_section)}</b> <span class="muted">(estimate)</span>`;
  else if (status.candidate_sections.length > 1) v = `Candidates: <span class="mono">${esc(status.candidate_sections.join(', '))}</span>`;
  else v = esc(info.label);
  return `<div class="fact"><div class="k">Suspected affected section</div><div class="v">${v}</div>
    <div class="s">${badge(info.label, info.tone)} <a href="#/topology">details</a></div></div>`;
}

function healthFact(status) {
  const c = status.node_counts;
  const ctrl = status.controllers.map((x) => `${badge(`${x.controller_id}: ${x.online ? 'online' : 'offline'}`, x.online ? 'green' : 'grey')}`).join(' ');
  const quality = { GOOD: ['All nodes valid', 'green'], DEGRADED: ['Some nodes without valid data', 'amber'], NONE: ['No valid data', 'grey'] }[status.data_quality];
  return `<div class="fact"><div class="k">Nodes &amp; communication</div>
    <div class="counts">${badge(`${c.normal} normal`, 'green')}${badge(`${c.warning} warning`, 'amber')}${badge(`${c.interrupted} no supply`, 'red')}${badge(`${c.offline_or_invalid} offline / invalid`, 'grey')}</div>
    <div class="v" style="margin-top:6px">${ctrl}</div>
    <div class="s">Data quality: ${badge(quality[0], quality[1])}</div>
    <div class="s">Last valid measurement: ${fmtTime(status.last_valid_measurement_at)}</div>
  </div>`;
}

function alertsCard(status) {
  const evs = status.active_events ?? [];
  const rows = evs.length
    ? evs.map((e) => {
      const sev = SEVERITY_INFO[e.severity];
      return `<tr><td class="nowrap mono"><a href="#/events?id=${e.event_id}">${evLabel(e.event_id)}</a></td>
        <td>${badge(sev.label, sev.tone)}</td>
        <td>${esc(EVENT_TYPE_INFO[e.event_type]?.label ?? e.event_type)}${e.carried_over ? ' <span class="muted small">(open before restart)</span>' : ''}</td>
        <td class="mono">${esc((e.node_ids ?? []).join(', '))}${e.affected_section ? ` · ${esc(e.affected_section)}` : ''}</td>
        <td class="nowrap">${fmtTime(e.start_ts)}</td></tr>`;
    }).join('')
    : '<tr><td colspan="5" class="empty">No active alerts.</td></tr>';
  return `<section class="card flush"><header><h2>Active alerts</h2><a href="#/events">Event history →</a></header>
    <div class="table-wrap"><table><thead><tr><th>Event</th><th>Severity</th><th>Type</th><th>Nodes / section</th><th>Since</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function controllerCard(status) {
  const rows = status.controllers.map((c) => {
    const p = c.protection;
    return `<tr><td class="mono">${esc(c.controller_id)} ${simTag(status.source)}</td>
      <td>${badge(c.online ? 'Online' : 'Offline', c.online ? 'green' : 'grey')}</td>
      <td class="nowrap">${c.last_message_at ? `${fmtTime(c.last_message_at)} (${fmtAge(c.last_message_at, status.server_now)})` : '—'}</td>
      <td class="mono">${esc(c.boot_id ?? '—')}</td>
      <td>${p ? `${p.protection_enabled ? 'Enabled' : 'Disabled'}${p.lockout ? ' · lockout' : ''}` : '—'}</td>
      <td class="num">${c.gap_count} / ${c.late_count} / ${c.duplicate_count}</td></tr>`;
  }).join('');
  const storage = status.storage?.ok
    ? badge('History is being recorded', 'green')
    : badge(`Storage error: ${status.storage?.last_error ?? 'unknown'} – history may be incomplete`, 'red');
  return `<section class="card flush"><header><h2>Controller &amp; communication health</h2>${storage}</header>
    <div class="table-wrap"><table><thead><tr><th>Controller</th><th>Link</th><th>Last report</th><th>Boot ID</th><th>Local protection (reported)</th><th title="sequence gaps / late / duplicate reports">Gaps / late / dup.</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="small muted" style="padding:0 16px 12px">Local protection runs on the controller and does not depend on this server or network.</p></section>`;
}

export function createOverviewPage(root, store) {
  root.innerHTML = '<div class="stack" id="ov"></div>';
  const el = root.querySelector('#ov');

  function update(status) {
    const info = FEEDER_STATE_INFO[status.status] ?? { label: status.status, tone: 'grey', summary: '' };
    const prev = status.previous_run;
    el.innerHTML = `
      <section class="card hero tone-border-${info.tone}" aria-live="polite">
        <div class="hero-state">
          <div class="label">Overall feeder status ${simTag(status.source)}</div>
          <div class="value tone-text-${info.tone}"><span class="ico" aria-hidden="true">${TONE_ICON[info.tone]}</span>${esc(info.label)}</div>
          <div class="muted">${esc(info.summary)}</div>
          <div class="small muted" style="margin-top:6px">Since ${fmtTime(status.condition_since)} (${fmtAge(status.condition_since, status.server_now)}) · updated ${fmtTime(status.last_updated)}</div>
          ${prev && status.status === 'INITIALIZING' ? `<div class="note">Server restarted. Before the restart the feeder was <b>${esc(prev.last_state?.to_state ?? 'unknown')}</b>. Conditions during the downtime were not observed.</div>` : ''}
        </div>
        <div class="facts">${locationFact(status)}${isolationFact(status)}${recoveryFact(status)}${healthFact(status)}</div>
      </section>

      <section class="card">
        <header><h2>Why this status?</h2><span class="small muted">Rule-based reasoning from validated measurements</span></header>
        <ul class="explain">${(status.explanation.length ? status.explanation : status.reason_text).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        ${reasonChips(status.reason_codes)}
      </section>

      <section>
        <div class="row" style="margin-bottom:8px"><h3>Nodes (source → end of feeder)</h3><span class="spacer"></span>
          <span class="small muted">Nominal ${fmtV(store.config.nominal_voltage_v, 0)} V – placeholder setting</span></div>
        <div class="grid grid-nodes">${status.nodes.map((n) => nodeCard(n, status, store)).join('')}</div>
      </section>

      <div class="grid grid-2">${alertsCard(status)}${controllerCard(status)}</div>`;
  }

  return { update };
}
