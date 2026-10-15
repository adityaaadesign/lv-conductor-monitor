// The dashboard: one minimal page.
//
// Always visible:  status · isolation status · feeder diagram · fault location · node cards ·
//                  latest 3 events · demo buttons (DEMO only) · safety notices
// Behind "▸" panels (collapsed on load): why · how the section was estimated · isolation
//                  details · technical details · event details · all events · demo help.
//
// The page skeleton (including every <details> panel) is built ONCE. Live updates only
// replace the contents inside the panels, so an opened panel never snaps shut while it is
// being read. Event panels inside lists remember their open state in `openPanels`.
// All wording comes from shared/simple.js.

import {
  DISPLAY_STATUS, NODE_DISPLAY, EVENT_SIMPLE, checkPasses, nodeCheckingText, connectionState,
  summarySentence, readingStatus, supplyText, locationView, shutdownView,
} from '/shared/simple.js';
import { REASON_TEXT } from '/shared/labels.js';
import { getJson, postJson, csvUrl, useLocalBackend, LOCAL_CSV_HREF } from './api.js';
import { createStore, connectLive } from './store.js';
import { esc, fmtTime, fmtDateTime, fmtDuration, fmtV } from './format.js';
import { feederDiagram, diagramLegend } from './diagram.js';
import { gaugeSettings, gaugeSvg, gaugeLegend } from './gauge.js';
import { loadDemoEngine } from './demo-engine.js';

const store = createStore();
const main = document.getElementById('main');
let buttons = [];               // demo scenarios that have a button
let events = [];                // recent meaningful events (newest first)
const eventDetails = new Map(); // event_id -> loaded detail (timeline + snapshot)
const openPanels = new Set();   // data-key of event panels that are open
let actionError = '';
let vertical = false;           // diagram orientation (vertical on narrow screens)

const isDemo = () => store.config.mode === 'sim';
const pill = (text, tone) => `<span class="pill tone-${tone}">${esc(text)}</span>`;
const nodeName = (id) => store.topology.nodes.find((n) => n.node_id === id)?.label ?? id;
const SEVERITY = { CRITICAL: ['Critical', 'red'], WARNING: ['Warning', 'amber'], INFO: ['Info', 'grey'] };
const fromTestSender = (s) => (s.controllers ?? []).some((c) => c.online && String(c.firmware_version ?? '').startsWith('test-sender'));

// Replace an element's content only if it changed (keeps focus and scroll stable).
const lastHtml = {};
function put(id, html) {
  if (lastHtml[id] === html) return;
  lastHtml[id] = html;
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}
function setText(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}
function setTone(id, base, tone) {
  const el = document.getElementById(id);
  if (el) el.className = `${base} tone-${tone}`;
}

// ---- B. Status ---------------------------------------------------------------------------------
function renderStatus(s) {
  const d = DISPLAY_STATUS[s.display_status];
  setTone('status-card', 'card status', d.tone);
  put('p-status', `<div class="word">${esc(d.label)}</div><div class="why-line">${esc(summarySentence(s))}</div>`);
  const fault = ['FAULT_SUSPECTED', 'ISOLATION_PENDING', 'ISOLATED'].includes(s.display_status);
  setText('why-summary', fault ? 'Why was this fault detected?' : 'Why this status?');
  const readings = s.nodes.map((n) => {
    const v = n.display_state === 'NO_DATA' ? 'no valid reading' : `${fmtV(n.last_valid_voltage_rms, 1)} V`;
    return `<li>${esc(n.label)}: ${esc(v)} – ${esc(NODE_DISPLAY[n.display_state].label)}</li>`;
  }).join('');
  put('d-why', `<ul>${s.explanation.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <div class="muted small" style="margin-top:8px">Node readings used:</div><ul>${readings}</ul>
    <div class="muted small">Limits used: low voltage below ${fmtV(store.config.detection.uv_pickup_pu * store.config.nominal_voltage_v, 0)} V for ${store.config.detection.uv_persistence_ms / 1000} s; no supply below ${fmtV(store.config.detection.loss_pickup_pu * store.config.nominal_voltage_v, 0)} V for ${store.config.detection.loss_persistence_ms / 1000} s (starting values, not yet validated on hardware).</div>`);
}

// ---- E. Isolation status ---------------------------------------------------------------------------
function renderIsolation(s) {
  const v = shutdownView(s);
  const box = (k, x) => `<div class="iso tone-${x.tone}"><div class="k">${k}</div><div class="v">${esc(x.text)}</div></div>`;
  put('p-iso', `<div class="iso-grid">${box('Command', v.command)}${box('Feedback', v.feedback)}</div>
    <div class="iso-note">${isDemo() ? 'Simulated switch. ' : ''}A command alone is not a confirmed shutdown. This page cannot operate any switch.</div>`);
  const iso = s.isolation ?? {};
  const rows = [
    ['Command', `${v.command.text} – ${v.command.detail}`],
    ['Command issued at', s.isolation_command_state === 'COMMANDED' && iso.commanded_at ? fmtTime(iso.commanded_at) : '—'],
    ['Switch feedback', `${v.feedback.text} – ${v.feedback.detail}`],
    ['Feedback signal received', iso.raw_feedback ?? 'none'],
    ['Confirmation must arrive within', `${store.config.detection.isolation_feedback_timeout_ms / 1000} s (starting value)`],
    ['Controller trip reason', iso.trip_reason ?? '—'],
    ['Switch', isDemo() ? 'Simulated switch (demo)' : 'Real switch – reported by the controller'],
  ];
  put('d-iso', `<div class="table-wrap"><table>${rows.map(([k, x]) => `<tr><th>${esc(k)}</th><td>${esc(x)}</td></tr>`).join('')}</table></div>
    <p class="small">The protection controller decides on its own to open the switch; this software only reports what it says. "Confirmed open" needs a feedback signal from the switch itself.</p>`);
}

// ---- C. Feeder diagram, fault location, node cards ----------------------------------------------------
function renderFeeder(s) {
  put('p-diagram', feederDiagram(store.topology, s, vertical));

  const loc = locationView(s);
  const tone = { ESTIMATE: 'red', UNCERTAIN: 'amber', NONE: 'green' }[loc.certainty];
  const caution = loc.certainty === 'NONE' ? '' : ' Estimate from voltage readings – not proof of a physical break.';
  put('p-location', `<div class="location tone-${tone}">
      <span class="where">${esc(loc.headline)}</span>
      ${loc.certainty === 'ESTIMATE' ? '<span class="tag estimate">Estimate</span>' : ''}
      ${loc.short || caution ? `<span class="short">${esc(loc.short)}${esc(caution)}</span>` : ''}
    </div>`);
  put('d-section', `<p>${esc(loc.reason)}</p>
    ${loc.observations.length ? `<div class="muted small">What each node showed:</div><ul>${loc.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
    <div class="muted small" style="margin-top:8px">How it works and its limits:</div>
    <ul>
      <li>If a node has supply and the next node does not, the interruption is estimated to be between them.</li>
      <li>If no node has supply, a source outage and a fault before Node A look the same – no section is named.</li>
      <li>If a node in between has no valid reading, the location is uncertain.</li>
      <li>The exact spot inside a section cannot be found, and a broken wire, open switch, blown fuse or loose joint look the same.</li>
    </ul>`);

  const dial = gaugeSettings(store.config);
  put('p-nodes', s.nodes.map((n) => {
    // Without a valid reading the card shows the connection state (Stale Data / Offline /
    // No Data / Waiting) instead of an electrical status – never 0 V, and the dial has no needle.
    const conn = connectionState(n);
    const d = n.display_state === 'NO_DATA' ? conn : NODE_DISPLAY[n.display_state];
    const value = n.display_state === 'NO_DATA' ? null : n.last_valid_voltage_rms;
    const volts = `<div class="volts">${gaugeSvg({ settings: dial, value, label: n.label, statusLabel: conn.label })}</div>`;
    const lastValid = n.last_valid_at ? `last valid report ${fmtTime(n.last_valid_at)}` : 'no valid report yet';
    const connLine = `<div class="hint">${esc(conn.label)} · ${esc(lastValid)}</div>`;
    let hint = '';
    if (n.isolation_effect === 'CONFIRMED') hint = 'Switched off by the confirmed shutdown';
    else if (n.isolation_effect === 'UNCONFIRMED') {
      hint = n.display_state === 'NO_SUPPLY'
        ? 'No supply measured – switch opening not confirmed'
        : 'Shutdown commanded but not confirmed – may still be live';
    }
    else if (n.display_state === 'CHECKING') hint = nodeCheckingText(n);
    else if (n.display_state === 'NO_DATA') hint = 'Not counted as 0 V';
    return `<div class="node tone-${d.tone}"><div class="name">${esc(n.label)}</div>${volts}${pill(d.label, d.tone)}${hint ? `<div class="hint">${esc(hint)}</div>` : ''}${connLine}</div>`;
  }).join(''));
  put('p-gauge-legend', gaugeLegend(dial));

  const source = isDemo() ? 'Simulated by the software' : fromTestSender(s) ? 'Software test sender (not real hardware)' : 'Real device';
  const nodeRows = s.nodes.map((n) => `<tr><td>${esc(n.label)} <span class="muted">${esc(n.node_id)}</span></td>
    <td>${esc(readingStatus(n).label)}</td><td>${esc(supplyText(n))}</td>
    <td class="num">${n.last_valid_voltage_rms === null ? '—' : `${fmtV(n.last_valid_voltage_rms, 1)} V`}</td>
    <td class="num">${n.last_message_at ? fmtTime(n.last_message_at) : '—'}</td><td>${esc(n.sensor_status ?? '—')}</td></tr>`).join('');
  const ctrl = (s.controllers ?? []).map((c) => `${esc(c.controller_id)}: ${c.online ? 'reporting' : 'not reporting'}, last report ${c.last_message_at ? fmtTime(c.last_message_at) : '—'}`).join('; ');
  put('d-tech', `<div class="table-wrap"><table>
      <tr><th>Node</th><th>Reading</th><th>Supply</th><th>Last valid</th><th>Last update</th><th>Sensor</th></tr>${nodeRows}</table></div>
    <table style="margin-top:8px">
      <tr><th>Data source</th><td>${esc(source)}</td></tr>
      <tr><th>Controller</th><td>${ctrl || '—'}</td></tr>
      <tr><th>Database</th><td>${s.storage?.ok === false ? `Problem: ${esc(s.storage.last_error)}` : 'Saving normally'}</td></tr>
      <tr><th>Internal state</th><td>${esc(s.status)} since ${fmtTime(s.condition_since)}; location result ${esc(s.frozen_localization_status ?? s.localization_status)}${s.localization_status === 'FROZEN' ? ' (held from before the shutdown)' : ''}</td></tr>
    </table>`);
}

// ---- F. Events -------------------------------------------------------------------------------------------
const TIMELINE_TEXT = {
  DETECTED: 'Fault detected', ESCALATED_FROM_UNDERVOLTAGE: 'Low voltage turned into loss of supply',
  LOCALIZATION_UPDATED: 'Location estimate updated', ISOLATION_REQUESTED: 'Controller commanded the switch to open',
  ISOLATION_REQUESTED_AGAIN: 'Controller commanded the switch to open again', ISOLATION_CONFIRMED: 'Switch feedback confirmed OPEN',
  ISOLATION_FEEDBACK_TIMEOUT: 'No confirmation from the switch in time', ISOLATION_FEEDBACK_CONTRADICTORY: 'Switch feedback disagreed with the command',
  MONITORING_LOST: 'Readings stopped arriving', MONITORING_RESUMED: 'Readings resumed', CLOSED: 'Event ended',
  RESTORATION_REQUESTED: 'Reset requested at the controller', RECLOSE_REPORTED: 'Controller released the switch',
  SUPPLY_RETURN_DETECTED: 'Supply returned', RECOVERY_UNSTABLE: 'Supply dropped again', RESTORATION_FAILED: 'Supply did not return',
  RECOVERY_STABLE: 'Supply steady again',
};

function shutdownResult(e) {
  if (!e.event_type.includes('INTERRUPTION')) return '';
  if (!e.isolation_requested) return 'no shutdown command';
  if (e.isolation_confirmed === 'CONFIRMED') return 'shutdown confirmed open';
  if (e.isolation_confirmed === 'NO_FEEDBACK_FITTED') return 'shutdown commanded – feedback unavailable';
  return 'shutdown commanded – not confirmed';
}

function eventDetailHtml(id) {
  const d = eventDetails.get(id);
  if (!d) return '<div class="muted small">Loading…</div>';
  if (d.error) return `<div class="error">${esc(d.error)}</div>`;
  const snap = Object.entries(d.measurement_snapshot ?? {}).map(([nid, x]) => `<tr><td>${esc(nodeName(nid))}</td>
    <td class="num">${x.voltage_rms === null || x.voltage_rms === undefined ? 'no valid reading' : `${fmtV(x.voltage_rms, 1)} V`}</td></tr>`).join('');
  return `<table>
      <tr><th>Started</th><td>${fmtDateTime(d.start_timestamp)}</td></tr>
      <tr><th>Ended</th><td>${d.end_timestamp ? `${fmtDateTime(d.end_timestamp)}${d.end_reason === 'DEMO_RESET' ? ' (demo reset)' : ''}` : 'still active'}</td></tr>
      <tr><th>Duration</th><td>${d.duration_ms === null || d.duration_ms === undefined ? '—' : fmtDuration(d.duration_ms)}</td></tr>
      ${d.affected_section ? `<tr><th>Estimated section</th><td>${esc(d.affected_section)}</td></tr>` : ''}
      ${shutdownResult(d) ? `<tr><th>Shutdown</th><td>${esc(shutdownResult(d))}</td></tr>` : ''}
      <tr><th>Why</th><td>${(d.detection_reason ?? []).map((r) => esc(REASON_TEXT[r] ?? r)).join('; ') || '—'}</td></tr>
    </table>
    ${snap ? `<div class="muted small" style="margin-top:6px">Readings saved when it was detected:</div><table>${snap}</table>` : ''}
    ${d.timeline?.length ? `<div class="muted small" style="margin-top:6px">Timeline:</div><ul>${d.timeline.map((t) => `<li>${fmtTime(t.timestamp)} – ${esc(TIMELINE_TEXT[t.kind] ?? t.kind)}</li>`).join('')}</ul>` : ''}`;
}

function eventItem(e, scope) {
  const key = `ev-${scope}-${e.event_id}`;
  const [sevText, sevTone] = SEVERITY[e.severity] ?? [e.severity, 'grey'];
  const where = e.affected_section ? `Section ${e.affected_section}` : (e.node_ids ?? []).map(nodeName).join(', ');
  const extra = [where, shutdownResult(e), sevText, e.source === 'SIMULATED' ? 'simulated' : ''].filter(Boolean).join(' · ');
  const state = e.status === 'OPEN' ? pill('Active', sevTone === 'grey' ? 'amber' : sevTone) : pill('Ended', 'grey');
  return `<li><details class="ev" data-key="${key}" data-event="${e.event_id}"${openPanels.has(key) ? ' open' : ''}>
    <summary><span class="t">${fmtTime(e.start_timestamp)}</span>
      <span><span class="title">${esc(EVENT_SIMPLE[e.event_type] ?? e.event_type)}</span><br><span class="where">${esc(extra)}</span></span>${state}</summary>
    <div class="dbody">${eventDetailHtml(e.event_id)}</div></details></li>`;
}

function renderEvents() {
  put('p-events', events.length ? events.slice(0, 3).map((e) => eventItem(e, 'main')).join('') : '<li class="empty">No fault events yet.</li>');
  setText('allev-summary', `View all events (${events.length}${events.length === 50 ? '+' : ''})`);
  put('d-allev', events.length
    ? `<ul class="events">${events.map((e) => eventItem(e, 'all')).join('')}</ul>
       <p class="small">Saved in the database – kept after refreshes and restarts. <a class="link" href="${csvUrl()}" download>Download all as CSV</a></p>`
    : '<p class="empty">No fault events yet.</p>');
}

async function loadEventDetail(id) {
  try {
    eventDetails.set(id, await getJson(`/events/${id}`));
  } catch (err) {
    eventDetails.set(id, { error: `Could not load details: ${err.message}` });
  }
  renderEvents();
}

async function loadEvents() {
  try {
    events = (await getJson('/events', { limit: 50, exclude_info: 1 })).items;
  } catch {
    return;   // keep the previous list; the connection notice explains the problem
  }
  // Refresh details of any event panel that is open (its timeline may have grown).
  for (const key of openPanels) {
    const id = Number(key.split('-').pop());
    if (id) loadEventDetail(id);
  }
  renderEvents();
}

// ---- G. Demo testing ------------------------------------------------------------------------------------
function demoCard() {
  if (!isDemo()) return '';
  const howto = buttons.map((b, i) => `<li><b>${i + 1}. ${esc(b.button.label)}</b> – ${esc(b.button.does)} <span class="muted">${esc(b.button.wait)}</span>
    <ul>${b.button.checks.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul></li>`).join('');
  return `<section class="card demo-card" aria-label="Demo testing">
    <div class="card-head"><h2>Demo testing</h2><span class="tag sim">Simulation only</span></div>
    <p class="demo-note">Each button resets the simulated line and starts a simulated situation (the fault begins after about 3 s). These buttons cannot reach any real hardware.</p>
    <div class="buttons">${buttons.map((b, i) => `<button type="button" class="test-btn" data-run="${esc(b.id)}" title="Start the simulated scenario: ${esc(b.button.label)}"><span class="n">${i + 1}</span>${esc(b.button.label)}</button>`).join('')}</div>
    <div class="run" id="p-run"></div>
    <details class="more" data-key="expected"><summary>Expected results</summary><div class="dbody" id="d-expected"></div></details>
    <details class="more" data-key="howto"><summary>How to use this demo</summary><div class="dbody">
      <p>Press a button, wait a few seconds, and compare the screen with the expected results. "Expected results" ticks each line automatically when the screen matches.</p>
      <ol style="padding-left:18px">${howto}</ol></div></details>
  </section>`;
}

function renderDemo(s) {
  const running = s.simulation?.running ? s.simulation.scenario_id : null;
  for (const el of main.querySelectorAll('button[data-run]')) el.classList.toggle('active', el.dataset.run === running);
  const active = buttons.find((b) => b.id === running);
  let run = actionError ? `<div class="error">${esc(actionError)}</div>` : '';
  let expected = '<p class="muted small">Press a button to start a scenario.</p>';
  if (active) {
    const checks = active.button.checks.map((c) => ({ ...c, ok: checkPasses(c, s) }));
    const passed = checks.filter((c) => c.ok).length;
    const secs = Math.floor((s.simulation.elapsed_ms ?? 0) / 1000);
    run += `Running: <b>${esc(active.button.label)}</b> · ${secs} s · ${passed === checks.length
      ? `<span class="res-ok">✓ all ${checks.length} expected results seen</span>`
      : `<span class="res-wait">${passed} of ${checks.length} expected results seen so far</span>`}`;
    expected = `<ul class="checklist">${checks.map((c) => `<li class="${c.ok ? 'ok' : 'wait'}"><span class="mark">${c.ok ? '✓' : '…'}</span><span>${esc(c.text)}</span></li>`).join('')}</ul>`;
  } else if (!running) {
    run += '<span class="muted">No scenario running – the simulated controller is off.</span>';
  }
  put('p-run', run);
  put('d-expected', expected);
}

// ---- Page skeleton (built once) -------------------------------------------------------------------------------
function buildLayout() {
  main.innerHTML = `
    <section class="row-top">
      <div class="card status" id="status-card">
        <h2>Feeder status</h2>
        <div id="p-status"></div>
        <details class="more" data-key="why"><summary id="why-summary">Why this status?</summary><div class="dbody" id="d-why"></div></details>
      </div>
      <div class="card" id="iso-card">
        <h2>Isolation status</h2>
        <div id="p-iso"></div>
        <details class="more" data-key="iso"><summary>Isolation details</summary><div class="dbody" id="d-iso"></div></details>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Feeder</h2><div class="legend">${diagramLegend()}</div></div>
      <div id="p-diagram"></div>
      <div id="p-location"></div>
      <details class="more" data-key="section"><summary>How was the section estimated?</summary><div class="dbody" id="d-section"></div></details>
      <div class="nodes" id="p-nodes"></div>
      <div class="gauge-legend" id="p-gauge-legend"></div>
      <details class="more" data-key="tech"><summary>Technical details</summary><div class="dbody" id="d-tech"></div></details>
    </section>
    <section class="row-bottom">
      <div class="card">
        <div class="card-head"><h2>Recent events</h2><a class="link" href="${csvUrl()}" download>Download CSV</a></div>
        <ul class="events" id="p-events"></ul>
        <details class="more" data-key="allev"><summary id="allev-summary">View all events</summary><div class="dbody" id="d-allev"></div></details>
      </div>
      ${demoCard()}
    </section>`;

  // Choose the diagram orientation from the space available (vertical on phones).
  const holder = document.getElementById('p-diagram');
  new ResizeObserver(() => {
    const v = holder.clientWidth < 480;
    if (v !== vertical) { vertical = v; delete lastHtml['p-diagram']; render(); }
  }).observe(holder);
}

function renderNotices(s) {
  const live = document.getElementById('live-strip');
  live.hidden = isDemo();
  if (!isDemo()) {
    setText('live-strip-text', fromTestSender(s)
      ? 'Readings come from the software TEST SENDER, not from real hardware · hardware integration not yet tested'
      : 'Readings appear only when a device sends data · hardware integration not yet tested');
  }
  const storage = document.getElementById('storage-strip');
  storage.hidden = s.storage?.ok !== false;
  if (s.storage?.ok === false) storage.textContent = `Database problem: ${s.storage.last_error}. Detection continues, but event history may be incomplete.`;
}

function render() {
  const s = store.status;
  if (!s) return;
  renderNotices(s);
  renderStatus(s);
  renderIsolation(s);
  renderFeeder(s);
  if (isDemo()) renderDemo(s);
}

let queued = false;
function scheduleRender() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
}

// Remember which event panels are open; load an event's details when it is opened.
// ("toggle" does not bubble, so listen in the capture phase.)
document.addEventListener('toggle', (ev) => {
  const d = ev.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.event) return;
  if (d.open) {
    openPanels.add(d.dataset.key);
    const id = Number(d.dataset.event);
    if (!eventDetails.has(id)) loadEventDetail(id);
  } else {
    openPanels.delete(d.dataset.key);
  }
}, true);

main.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-run]');
  if (!b) return;
  actionError = '';
  try {
    await postJson('/sim/run', { scenario_id: b.dataset.run, fresh: true });
  } catch (err) {
    actionError = `Could not start the scenario: ${err.message}`;
  }
  loadEvents();
  scheduleRender();
});

function renderConnection(state) {
  const el = document.getElementById('connection');
  el.className = `connection ${state}`;
  el.innerHTML = `<span class="dot"></span>${{ live: 'Connected', reconnecting: 'Disconnected' }[state] ?? 'Connecting…'}`;
  const strip = document.getElementById('conn-strip');
  strip.hidden = state !== 'reconnecting';
  strip.textContent = `Connection to the monitoring server lost – retrying. Values shown are from ${store.lastStatusAt ? fmtTime(store.lastStatusAt) : 'earlier'} and may be out of date.`;
}

// ---- DEMO / LIVE switch ---------------------------------------------------------------
// DEMO = simulation running inside this browser tab (nothing is sent anywhere).
// LIVE = the monitoring server (Cloudflare Worker online, or `npm start` on the laptop).
// The choice is kept in the address (?mode=demo / ?mode=live) and remembered in this browser.
// Switching reloads the page, so the two modes never share any data on screen.
function wantedMode() {
  const fromUrl = new URLSearchParams(location.search).get('mode');
  if (fromUrl === 'demo' || fromUrl === 'live') {
    try { localStorage.setItem('lv-mode', fromUrl); } catch { /* storage blocked */ }
    return fromUrl;
  }
  try { return localStorage.getItem('lv-mode') === 'demo' ? 'demo' : 'live'; } catch { return 'live'; }
}

function renderModeSwitch(active, liveNote = '') {
  const el = document.getElementById('mode-switch');
  const opt = (mode, title, sub, disabledNote) => `<button type="button" role="radio" class="ms-opt ${mode}${active === mode ? ' on' : ''}"
      data-mode="${mode}" aria-checked="${active === mode}" ${disabledNote ? `disabled title="${esc(disabledNote)}"` : ''}>
      <span class="ms-title">${title}</span><span class="ms-sub">${sub}</span></button>`;
  el.innerHTML = opt('demo', 'DEMO', 'Simulated') + opt('live', 'LIVE', 'Real device', liveNote);
  el.hidden = false;
  el.onclick = (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.disabled || b.dataset.mode === active) return;
    const url = new URL(location.href);
    url.searchParams.set('mode', b.dataset.mode);
    location.assign(url);
  };
}

let demoEngine = null;

async function boot() {
  const want = wantedMode();
  renderModeSwitch(want);
  try {
    if (want === 'demo') {
      demoEngine = await loadDemoEngine();
      useLocalBackend(demoEngine);
    }
    const [config, topology, status] = await Promise.all([getJson('/config'), getJson('/topology'), getJson('/status')]);
    store.config = config;
    store.topology = topology;
    store.status = status;
    if (isDemo()) {
      buttons = (await getJson('/sim/scenarios')).scenarios.filter((x) => x.button).sort((a, b) => a.button.order - b.button.order);
    }
  } catch (err) {
    const fix = want === 'demo'
      ? 'The demo files could not be loaded – reload the page.'
      : window.LV_API_BASE
        ? `Check that the backend at ${esc(window.LV_API_BASE)} is deployed and that ALLOWED_ORIGINS includes this page's address. You can still use <b>DEMO</b> (switch at the top).`
        : 'Start it with <b>npm start</b> (LIVE) or <b>npm run sim</b>, and reload the page – or use <b>DEMO</b> (switch at the top).';
    main.innerHTML = `<div class="error">Cannot reach the monitoring server (${esc(err.message)}). ${fix}</div>`;
    renderConnection('reconnecting');
    return;
  }
  // A laptop server started with `npm run sim` is itself a DEMO server: no LIVE there.
  renderModeSwitch(isDemo() ? 'demo' : 'live',
    isDemo() && !demoEngine ? 'This server runs in DEMO mode (npm run sim). Start it with npm start for LIVE.' : '');
  document.getElementById('demo-strip').hidden = !isDemo();
  document.getElementById('demo-where').textContent = demoEngine
    ? 'Runs only in this browser tab – nothing is sent to the server; the history is cleared when you reload.'
    : '';
  if (demoEngine) {
    document.addEventListener('click', (e) => {
      if (!e.target.closest(`a[href="${LOCAL_CSV_HREF}"]`)) return;
      e.preventDefault();
      const url = URL.createObjectURL(new Blob([demoEngine.csv()], { type: 'text/csv' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: 'events-SIMULATED-demo.csv' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  store.on('status', scheduleRender);
  store.on('connection', renderConnection);
  let t = null;
  store.on('events', () => { clearTimeout(t); t = setTimeout(loadEvents, 400); });
  store.on('history_cleared', loadEvents);
  buildLayout();
  render();
  loadEvents();
  connectLive(store, demoEngine);
}

boot();
