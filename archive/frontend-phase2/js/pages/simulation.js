// Simulation control (demo mode only). Runs repeatable scenarios in the built-in
// simulator. Nothing on this page can reach real hardware.

import { FEEDER_STATE_INFO, EVENT_TYPE_INFO } from '/shared/labels.js';
import { getJson, postJson } from '../api.js';
import { esc } from '../format.js';
import { badge, simTag, progressBar, errorBox } from '../ui.js';

const fmtSec = (ms) => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s`;

function stateSeq(states) {
  return `<div class="state-seq">${states.map((s, i) => {
    const info = FEEDER_STATE_INFO[s] ?? { label: s, tone: 'grey' };
    return `${i ? '<span class="muted">→</span>' : ''}${badge(info.label, info.tone)}`;
  }).join('')}</div>`;
}

export function createSimulationPage(root, store) {
  root.innerHTML = `
    <div class="stack">
      <section class="card">
        <header><h2>Simulation control ${simTag('SIMULATED')}</h2>
          <div class="row">
            <span class="small muted">Simulated clock speed</span>
            <div class="seg" id="speeds">${store.config.simulation.allowed_speeds.map((s) => `<button type="button" data-speed="${s}">×${s}</button>`).join('')}</div>
            <button class="btn" id="stop">Stop simulated controller</button>
            <button class="btn danger" id="clear">Clear simulated history…</button>
          </div>
        </header>
        <p class="small muted" style="margin:0">Each scenario feeds simulated reports through the <b>same</b> validation, detection and event logic that real hardware will use. Scenarios are deterministic: the same scenario always produces the same state sequence (they double as automated tests). Running a scenario powers up a fresh simulated controller.
        Speeds above ×1 make the simulated clock (and timestamps) run ahead of real time.</p>
        <div id="msg"></div>
      </section>
      <section class="card" id="current"></section>
      <section><h3 style="margin-bottom:8px">Scenarios</h3><div class="scenario-grid" id="list"><div class="loading">Loading scenarios…</div></div></section>
    </div>`;

  let scenarios = [];
  const msg = (html) => { root.querySelector('#msg').innerHTML = html; };

  async function act(fn) {
    try { await fn(); msg(''); } catch (err) { msg(errorBox(err.message)); }
  }

  root.querySelector('#speeds').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-speed]');
    if (b) act(() => postJson('/sim/speed', { speed: Number(b.dataset.speed) }));
  });
  root.querySelector('#stop').addEventListener('click', () => act(() => postJson('/sim/stop')));
  root.querySelector('#clear').addEventListener('click', () => {
    if (window.confirm('Delete ALL simulated measurements and events (data/sim.db)? Live data is stored separately and is not affected.')) {
      act(() => postJson('/sim/reset'));
    }
  });
  root.querySelector('#list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-run]');
    if (b) act(async () => { await postJson('/sim/run', { scenario_id: b.dataset.run }); window.location.hash = '#/overview'; });
  });

  function renderList(sim) {
    root.querySelector('#list').innerHTML = scenarios.map((s) => `
      <article class="card scenario-card${sim?.scenario_id === s.id && sim.running ? ' running' : ''}">
        <header><h2><span class="mono">${esc(s.id)}</span> ${esc(s.title)}</h2>${badge(s.category, 'grey')}</header>
        <p>${esc(s.description)}</p>
        <div class="small muted">Expected states:</div>${stateSeq(s.expected_states)}
        <p class="small">Expected events: ${Object.keys(s.expected_events).length ? Object.entries(s.expected_events).map(([t, n]) => `${n} × ${esc(EVENT_TYPE_INFO[t]?.label ?? t)}`).join(', ') : 'none'}</p>
        <div class="row"><button class="btn primary" data-run="${esc(s.id)}">Run ${esc(s.id)}</button><span class="small muted">${fmtSec(s.duration_ms)} at ×1</span></div>
      </article>`).join('');
  }

  function renderCurrent(sim) {
    const el = root.querySelector('#current');
    for (const b of root.querySelectorAll('#speeds button')) b.classList.toggle('active', Number(b.dataset.speed) === sim?.speed);
    if (!sim?.running) {
      el.innerHTML = '<header><h2>No scenario running</h2></header><p class="muted">The simulated controller is switched off, so the server receives no reports. After the controller timeout the feeder shows UNKNOWN – which is the correct, honest result.</p>';
      return;
    }
    const s = scenarios.find((x) => x.id === sim.scenario_id);
    if (!s) return;
    const done = sim.steps_done?.length ?? 0;
    el.innerHTML = `
      <header><h2>Running: <span class="mono">${esc(s.id)}</span> ${esc(s.title)}</h2>
        ${sim.complete ? badge('Complete – holding final conditions', 'green') : badge(`${fmtSec(sim.elapsed_ms)} / ${fmtSec(s.duration_ms)}`, 'amber')}</header>
      ${progressBar(sim.elapsed_ms / s.duration_ms, sim.complete)}
      <div class="grid grid-2" style="margin-top:12px">
        <div><h3 style="margin-bottom:6px">Scripted steps</h3>
          <ul class="steps">${s.steps.length ? s.steps.map((st, i) => `<li class="${i < done ? 'done' : ''}"><span class="mark">${i < done ? '✓' : '○'}</span><span class="t">t+${fmtSec(st.at_ms)}</span><span>${esc(st.note ?? st.action)}</span></li>`).join('') : '<li class="muted">No disturbances – normal operation throughout.</li>'}</ul>
          ${Object.keys(s.controller ?? {}).length ? `<p class="small muted">Simulated hardware: <span class="mono">${esc(JSON.stringify(s.controller))}</span></p>` : ''}
        </div>
        <div><h3 style="margin-bottom:6px">What to look for</h3><ul class="explain">${s.what_to_look_for.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
          <div class="small muted" style="margin-top:8px">Expected state sequence:</div>${stateSeq(s.expected_states)}</div>
      </div>`;
  }

  async function init() {
    try {
      scenarios = (await getJson('/sim/scenarios')).scenarios;
    } catch (err) {
      root.querySelector('#list').innerHTML = errorBox(`Could not load scenarios: ${err.message}`);
      return;
    }
    renderList(store.status?.simulation);
    renderCurrent(store.status?.simulation);
  }
  init();

  let lastKey = '';
  return {
    update(status) {
      if (!scenarios.length) return;
      const sim = status.simulation;
      renderCurrent(sim);
      const key = `${sim?.scenario_id}|${sim?.running}`;
      if (key !== lastKey) { lastKey = key; renderList(sim); }
    },
  };
}
