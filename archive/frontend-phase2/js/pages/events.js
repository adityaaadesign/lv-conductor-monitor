// Page C – Event history: searchable, filterable table read from the database, so it
// survives browser refreshes and server restarts. CSV export uses the same filters.

import { EVENT_TYPE_INFO, SEVERITY_INFO, ISOLATION_CONFIRMED_INFO, RECOVERY_INFO } from '/shared/labels.js';
import { EventType, Severity } from '/shared/enums.js';
import { getJson, csvUrl } from '../api.js';
import { esc, fmtDateTime, fmtDuration, fmtV, evLabel } from '../format.js';
import { badge, infoBadge, simTag, errorBox } from '../ui.js';
import { openEventDrawer } from '../components/event-detail.js';

const PAGE_SIZE = 25;

function voltagesAtDetection(e) {
  const entries = Object.entries(e.measurement_snapshot ?? {}).filter(([id]) => (e.node_ids ?? []).includes(id));
  if (!entries.length) return '—';
  return entries.map(([id, s]) => `${esc(id)}: ${fmtV(s.voltage_rms)} V`).join('<br>');
}

function isolationCell(e) {
  if (e.isolation_requested === null || e.isolation_requested === undefined) {
    return e.event_type.includes('INTERRUPTION') ? '<span class="muted">no protection status</span>' : '—';
  }
  if (!e.isolation_requested) return 'Not requested';
  const c = ISOLATION_CONFIRMED_INFO[e.isolation_confirmed];
  return `Requested<br>${badge(c?.label ?? e.isolation_confirmed, c?.tone ?? 'grey')}`;
}

export function createEventsPage(root, store) {
  const nodes = store.topology.nodes;
  root.innerHTML = `
    <div class="stack">
      <section class="card">
        <form class="filters" id="filters">
          <label>From <input type="datetime-local" name="from"></label>
          <label>To <input type="datetime-local" name="to"></label>
          <label>Node <select name="node"><option value="">All</option>${nodes.map((n) => `<option value="${esc(n.node_id)}">${esc(n.label)} (${esc(n.node_id)})</option>`).join('')}</select></label>
          <label>Type <select name="type"><option value="">All</option>${Object.keys(EventType).map((t) => `<option value="${t}">${esc(EVENT_TYPE_INFO[t]?.label ?? t)}</option>`).join('')}</select></label>
          <label>Severity <select name="severity"><option value="">All</option>${Object.keys(Severity).map((s) => `<option value="${s}">${esc(SEVERITY_INFO[s].label)}</option>`).join('')}</select></label>
          <label>Status <select name="status"><option value="">All</option><option value="OPEN">Open</option><option value="CLOSED">Closed</option></select></label>
          <label>Search <input type="search" name="q" placeholder="EV-000012, S-AB, N-B…"></label>
          <button class="btn primary" type="submit">Apply</button>
          <button class="btn" type="button" id="reset">Reset</button>
          <span class="spacer"></span>
          <a class="btn" id="csv" href="#" download>Export CSV</a>
        </form>
      </section>
      <section class="card flush">
        <header><h2 id="count">Events</h2><span class="small muted" id="src"></span></header>
        <div id="table" class="table-wrap"><div class="loading">Loading events…</div></div>
        <div class="row" style="padding:10px 16px"><button class="btn" id="prev">← Newer</button><span id="pageinfo" class="small muted"></span><button class="btn" id="next">Older →</button></div>
      </section>
    </div>`;

  const form = root.querySelector('#filters');
  const tableEl = root.querySelector('#table');
  let offset = 0;
  let total = 0;
  let loading = false;
  let refreshTimer = null;

  const params = () => {
    const f = new FormData(form);
    const p = {};
    for (const [k, v] of f.entries()) if (v) p[k] = v;
    if (p.from) p.from = new Date(p.from).toISOString();
    if (p.to) p.to = new Date(p.to).toISOString();
    return p;
  };

  async function load() {
    if (loading) return;
    loading = true;
    const p = params();
    root.querySelector('#csv').href = csvUrl(p);
    try {
      const res = await getJson('/events', { ...p, limit: PAGE_SIZE, offset });
      total = res.total;
      root.querySelector('#count').textContent = `Events (${total})`;
      root.querySelector('#src').innerHTML = res.source === 'SIMULATED' ? `${simTag('SIMULATED')} Simulated history (data/sim.db)` : 'Live history';
      root.querySelector('#pageinfo').textContent = total ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}` : '';
      root.querySelector('#prev').disabled = offset === 0;
      root.querySelector('#next').disabled = offset + PAGE_SIZE >= total;
      if (!res.items.length) {
        tableEl.innerHTML = '<div class="empty">No events match these filters.</div>';
      } else {
        tableEl.innerHTML = `<table><thead><tr>
          <th>Event</th><th>Start</th><th>End</th><th>Type</th><th>Severity</th><th>Node(s)</th><th>Section</th>
          <th>V at detection</th><th>Duration</th><th>Status</th><th>Isolation</th><th>Recovery</th></tr></thead><tbody>
          ${res.items.map((e) => {
            const sev = SEVERITY_INFO[e.severity];
            const rec = e.recovery_status ? infoBadge(RECOVERY_INFO, e.recovery_status) : '—';
            return `<tr class="clickable" data-id="${e.event_id}" tabindex="0">
              <td class="mono nowrap">${evLabel(e.event_id)} ${simTag(e.source)}</td>
              <td class="nowrap">${fmtDateTime(e.start_timestamp)}</td>
              <td class="nowrap">${e.end_timestamp ? fmtDateTime(e.end_timestamp) + (e.end_ts_quality === 'APPROXIMATE' ? ' <span class="muted" title="approximate">≈</span>' : '') : '<span class="muted">open</span>'}</td>
              <td>${esc(EVENT_TYPE_INFO[e.event_type]?.label ?? e.event_type)}</td>
              <td>${badge(sev.label, sev.tone)}</td>
              <td class="mono">${esc((e.node_ids ?? []).join(', ') || '—')}</td>
              <td class="mono">${esc(e.affected_section ?? '—')}</td>
              <td class="num small">${voltagesAtDetection(e)}</td>
              <td class="nowrap">${e.duration_ms === null || e.duration_ms === undefined ? (e.status === 'OPEN' ? 'ongoing' : '—') : fmtDuration(e.duration_ms)}</td>
              <td>${badge(e.status === 'OPEN' ? 'Open' : 'Closed', e.status === 'OPEN' ? 'amber' : 'grey')}</td>
              <td class="small">${isolationCell(e)}</td>
              <td>${rec}</td></tr>`;
          }).join('')}</tbody></table>`;
      }
    } catch (err) {
      tableEl.innerHTML = errorBox(`Could not load events: ${err.message}`);
    } finally {
      loading = false;
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); offset = 0; load(); });
  root.querySelector('#reset').addEventListener('click', () => { form.reset(); offset = 0; load(); });
  root.querySelector('#prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); load(); });
  root.querySelector('#next').addEventListener('click', () => { offset += PAGE_SIZE; load(); });
  const open = (row) => row && openEventDrawer(Number(row.dataset.id));
  tableEl.addEventListener('click', (e) => open(e.target.closest('tr[data-id]')));
  tableEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e.target.closest('tr[data-id]')); });

  // Refresh when events change (debounced), instead of polling.
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(load, 600); };
  const offEvents = store.on('events', scheduleRefresh);
  const offCleared = store.on('history_cleared', scheduleRefresh);

  load();
  const idMatch = /id=(\d+)/.exec(window.location.hash);
  if (idMatch) openEventDrawer(Number(idMatch[1]), { onClose: () => { window.location.hash = '#/events'; } });

  return {
    destroy() { offEvents(); offCleared(); clearTimeout(refreshTimer); },
  };
}
