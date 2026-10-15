// Dashboard entry point: loads configuration, opens the live connection, renders the
// header / demo banner, and switches between pages using the URL hash (#/overview …).

import { FEEDER_STATE_INFO } from '/shared/labels.js';
import { getJson } from './api.js';
import { createStore, connectLive } from './store.js';
import { esc, fmtTime } from './format.js';
import { badge, errorBox } from './ui.js';
import { createOverviewPage } from './pages/overview.js';
import { createTopologyPage } from './pages/topology.js';
import { createEventsPage } from './pages/events.js';
import { createTrendsPage } from './pages/trends.js';
import { createSimulationPage } from './pages/simulation.js';

const PAGES = {
  overview: createOverviewPage,
  topology: createTopologyPage,
  events: createEventsPage,
  trends: createTrendsPage,
  simulation: createSimulationPage,
};

const store = createStore();
const pageEl = document.getElementById('page');
let current = null;

function renderHeader(status) {
  const info = FEEDER_STATE_INFO[status.status] ?? { label: status.status, tone: 'grey' };
  document.getElementById('header-status').innerHTML = badge(`Feeder: ${info.label}`, info.tone);
  document.getElementById('feeder-name').textContent = `${status.feeder_name} · ${status.feeder_id}`;
  renderModeBanner(status);
}

function renderModeBanner(status) {
  const el = document.getElementById('mode-banner');
  if (store.config.mode !== 'sim') { el.hidden = true; return; }
  const sim = status?.simulation;
  const parts = ['<span class="mode-title">DEMO MODE – SIMULATED DATA</span>',
    '<span>Not connected to hardware. All readings, events and switch states on this page are simulated.</span>'];
  if (sim?.running) {
    const elapsed = sim.elapsed_ms !== null ? `${Math.floor(sim.elapsed_ms / 1000)} s` : '';
    parts.push(`<span class="mode-detail">Scenario <b>${esc(sim.scenario_id)}</b> · ${esc(sim.title)} · ${elapsed}${sim.complete ? ' (complete – holding final conditions)' : ''}</span>`);
  } else {
    parts.push('<span class="mode-detail">No scenario running – the simulated controller is switched off</span>');
  }
  if (sim?.speed && sim.speed !== 1) parts.push(`<span class="mode-detail">Simulated clock ×${sim.speed}</span>`);
  parts.push('<a href="#/simulation">Scenario controls</a>');
  el.innerHTML = parts.join('');
  el.hidden = false;
}

function renderConnection(state) {
  const el = document.getElementById('connection');
  el.className = `connection ${state}`;
  const text = { live: 'Live updates connected', reconnecting: 'Reconnecting…', connecting: 'Connecting…' }[state] ?? state;
  el.innerHTML = `<span class="dot" aria-hidden="true"></span>${text}`;
  const banner = document.getElementById('conn-banner');
  if (state === 'reconnecting') {
    banner.textContent = `Live updates paused – reconnecting to the server. Values shown are from ${store.lastStatusAt ? fmtTime(store.lastStatusAt) : 'before the disconnect'} and may be out of date.`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function route() {
  const name = (window.location.hash.replace(/^#\//, '') || 'overview').split('?')[0];
  const key = PAGES[name] && (name !== 'simulation' || store.config.mode === 'sim') ? name : 'overview';
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.page === key);
  current?.destroy?.();
  pageEl.innerHTML = '';
  current = PAGES[key](pageEl, store);
  if (store.status) current.update?.(store.status);
}

async function boot() {
  try {
    const [config, topology, status] = await Promise.all([getJson('/config'), getJson('/topology'), getJson('/status')]);
    store.config = config;
    store.topology = topology;
    document.getElementById('nav-sim').hidden = config.mode !== 'sim';
    store.setStatus(status);
  } catch (err) {
    pageEl.innerHTML = `${errorBox(`Cannot load the dashboard: ${err.message}. Is the server running (npm run sim)?`)}
      <p><button class="btn" onclick="location.reload()">Retry</button></p>`;
    return;
  }
  store.on('status', (s) => {
    renderHeader(s);
    current?.update?.(s);
  });
  store.on('connection', renderConnection);
  renderHeader(store.status);
  window.addEventListener('hashchange', route);
  route();
  connectLive(store);
}

boot();
