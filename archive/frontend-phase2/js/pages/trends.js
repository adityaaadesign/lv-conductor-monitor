// Page D – Trends and diagnostics. Charts are drawn only from STORED measurements.
// Invalid or missing data appears as a gap in the line, never as 0 V.

import { FEEDER_STATE_INFO, VALIDITY_INFO, INVALID_REASON_TEXT } from '/shared/labels.js';
import { getJson } from '../api.js';
import { esc, fmtTime, fmtDateTime, fmtAge, fmtV } from '../format.js';
import { badge, infoBadge, simTag, placeholderTag, errorBox } from '../ui.js';

const RANGES = [
  { key: '2m', label: '2 min', ms: 2 * 60e3 },
  { key: '10m', label: '10 min', ms: 10 * 60e3 },
  { key: '30m', label: '30 min', ms: 30 * 60e3 },
  { key: '2h', label: '2 h', ms: 2 * 3600e3 },
  { key: '12h', label: '12 h', ms: 12 * 3600e3 },
];
// Series colours deliberately avoid the red/amber/green status colours.
const SERIES = ['#2563c9', '#8b3fc6', '#0f8a7e', '#b0581c', '#c43c8a', '#5b6b10'];
const TONE_LINE = { green: '#1b7a4b', amber: '#b37400', red: '#c8312a', grey: '#7b8794' };

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// Chart.js plugin: horizontal threshold lines and vertical state-change markers.
const markersPlugin = {
  id: 'feederMarkers',
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea: a, scales: { x, y } } = chart;
    ctx.save();
    ctx.font = '11px system-ui, sans-serif';
    for (const t of opts.thresholds ?? []) {
      const py = y.getPixelForValue(t.value);
      if (py < a.top || py > a.bottom) continue;
      ctx.strokeStyle = t.color;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = t.color;
      ctx.fillText(t.label, a.left + 6, py - 4);
    }
    for (const m of opts.markers ?? []) {
      const px = x.getPixelForValue(m.t);
      if (px < a.left || px > a.right) continue;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      ctx.save();
      ctx.translate(px + 3, a.top + 4);
      ctx.rotate(Math.PI / 2);
      ctx.fillStyle = m.color;
      ctx.fillText(m.label, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  },
};

// Turn stored rows into chart points, inserting null where data is invalid or missing.
function toPoints(rows, field, gapMs) {
  const pts = [];
  let lastT = null;
  for (const r of rows) {
    if (lastT !== null && r.t - lastT > gapMs) pts.push({ x: lastT + 1, y: null });
    pts.push({ x: r.t, y: r.validity === 'VALID' ? r[field] : null });
    lastT = r.t;
  }
  return pts;
}

export function createTrendsPage(root, store) {
  const cfg = store.config;
  const nodes = store.topology.nodes;
  const anyCurrent = nodes.some((n) => n.has_current_sensor);
  let range = RANGES[0];
  let showMin = true;
  const selected = new Set(nodes.map((n) => n.node_id));
  let chart = null;
  let currentChart = null;
  let timer = null;
  let diagTimer = null;

  root.innerHTML = `
    <div class="stack">
      <section class="card">
        <header>
          <h2>Voltage vs time <span id="srcTag"></span></h2>
          <div class="row">
            <div class="seg" id="ranges">${RANGES.map((r) => `<button type="button" data-key="${r.key}" class="${r.key === range.key ? 'active' : ''}">${r.label}</button>`).join('')}</div>
            ${nodes.map((n, i) => `<label class="small"><input type="checkbox" data-node="${esc(n.node_id)}" checked> <span style="color:${SERIES[i % SERIES.length]};font-weight:700">■</span> ${esc(n.label)}</label>`).join('')}
            <label class="small"><input type="checkbox" id="showMin" checked> per-cycle minimum</label>
          </div>
        </header>
        <div style="position:relative;height:340px"><canvas id="vchart" aria-label="Voltage chart"></canvas></div>
        <p class="small muted" id="chartNote">Stored measurements only. Gaps = invalid, missing or late-arriving data (never drawn as 0 V). Vertical lines mark feeder state changes. Dashed horizontal lines are the configured thresholds (placeholders).</p>
      </section>
      <section class="card">
        <header><h2>Current vs time</h2></header>
        ${anyCurrent ? '<div style="position:relative;height:220px"><canvas id="ichart"></canvas></div>' : '<div class="empty">No current sensors are configured (<span class="mono">has_current_sensor: false</span> for every node in config/feeder.json). Current is not measured, so no chart is shown.</div>'}
      </section>
      <div id="diag" class="stack"><div class="loading">Loading diagnostics…</div></div>
    </div>`;

  root.querySelector('#ranges').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-key]');
    if (!b) return;
    range = RANGES.find((r) => r.key === b.dataset.key);
    for (const x of root.querySelectorAll('#ranges button')) x.classList.toggle('active', x === b);
    loadSeries();
    schedule();
  });
  for (const cb of root.querySelectorAll('input[data-node]')) {
    cb.addEventListener('change', () => { if (cb.checked) selected.add(cb.dataset.node); else selected.delete(cb.dataset.node); loadSeries(); });
  }
  root.querySelector('#showMin').addEventListener('change', (e) => { showMin = e.target.checked; loadSeries(); });

  async function loadSeries() {
    if (!window.Chart) {
      root.querySelector('#chartNote').innerHTML = errorBox('Chart library failed to load (node_modules/chart.js missing? run npm install).');
      return;
    }
    const to = store.status?.server_now ?? Date.now();
    const from = to - range.ms;
    let data;
    try {
      data = await getJson('/measurements', { from, to, nodes: [...selected].join(','), max_points: 1200 });
    } catch (err) {
      root.querySelector('#chartNote').innerHTML = errorBox(`Could not load measurements: ${err.message}`);
      return;
    }
    root.querySelector('#srcTag').innerHTML = data.source === 'SIMULATED' ? `${simTag('SIMULATED')} <span class="small muted">simulated measurements</span>` : '';
    const gapMs = 2.5 * (cfg.detection.expected_report_interval_ms ?? 1000);
    const datasets = [];
    nodes.forEach((n, i) => {
      const s = data.series[n.node_id];
      if (!s) return;
      const color = SERIES[i % SERIES.length];
      const gap = s.downsampled ? 2.5 * s.bucket_ms : gapMs;
      datasets.push({ label: `${n.label}${s.downsampled ? ' (averaged)' : ''}`, data: toPoints(s.points, 'v', gap), borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, spanGaps: false, tension: 0 });
      if (showMin) datasets.push({ label: `${n.label} min`, data: toPoints(s.points, 'vmin', gap), borderColor: color, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, spanGaps: false, tension: 0 });
    });
    const nominal = cfg.nominal_voltage_v;
    const thresholds = [
      { value: cfg.detection.uv_pickup_pu * nominal, label: `Undervoltage pickup ${cfg.detection.uv_pickup_pu} pu (placeholder)`, color: TONE_LINE.amber },
      { value: cfg.detection.loss_pickup_pu * nominal, label: `Loss pickup ${cfg.detection.loss_pickup_pu} pu (placeholder)`, color: TONE_LINE.red },
    ];
    const markers = data.transitions.map((t) => {
      const info = FEEDER_STATE_INFO[t.to_state] ?? { label: t.to_state, tone: 'grey' };
      return { t: t.ts, label: info.label, color: TONE_LINE[info.tone] };
    });
    const textColor = cssVar('--text-2') || '#445263';
    const gridColor = cssVar('--border') || '#d6dce2';
    const options = {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      normalized: true,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: { type: 'linear', min: from, max: to, ticks: { color: textColor, maxTicksLimit: 8, callback: (v) => fmtTime(v) }, grid: { color: gridColor } },
        y: { min: 0, suggestedMax: nominal * 1.1, title: { display: true, text: 'V RMS', color: textColor }, ticks: { color: textColor }, grid: { color: gridColor } },
      },
      plugins: {
        legend: { labels: { color: textColor, boxWidth: 14, filter: (item) => !item.text.endsWith(' min') } },
        tooltip: { callbacks: { title: (items) => fmtDateTime(items[0].parsed.x), label: (item) => `${item.dataset.label}: ${fmtV(item.parsed.y)} V` } },
        feederMarkers: { thresholds, markers },
      },
    };
    if (!chart) {
      chart = new window.Chart(root.querySelector('#vchart'), { type: 'line', data: { datasets }, options, plugins: [markersPlugin] });
    } else {
      chart.data.datasets = datasets;
      chart.options = options;
      chart.update('none');
    }
    if (anyCurrent) {
      const cds = nodes.filter((n) => n.has_current_sensor && data.series[n.node_id]).map((n) => ({
        label: n.label, data: toPoints(data.series[n.node_id].points, 'i', gapMs), borderColor: SERIES[nodes.indexOf(n) % SERIES.length], borderWidth: 2, pointRadius: 0, spanGaps: false,
      }));
      const copt = { ...options, scales: { ...options.scales, y: { min: 0, title: { display: true, text: 'A RMS', color: textColor } } }, plugins: { ...options.plugins, feederMarkers: { markers } } };
      if (!currentChart) currentChart = new window.Chart(root.querySelector('#ichart'), { type: 'line', data: { datasets: cds }, options: copt, plugins: [markersPlugin] });
      else { currentChart.data.datasets = cds; currentChart.options = copt; currentChart.update('none'); }
    }
  }

  async function loadDiagnostics() {
    const el = root.querySelector('#diag');
    let d;
    try {
      d = await getJson('/diagnostics');
    } catch (err) {
      el.innerHTML = errorBox(`Could not load diagnostics: ${err.message}`);
      return;
    }
    const now = store.status?.server_now;
    const counts = {};
    for (const c of d.measurement_counts) {
      counts[c.node_id] ??= { VALID: 0, INVALID: 0, late: 0 };
      counts[c.node_id][c.validity] = (counts[c.node_id][c.validity] ?? 0) + c.n;
      counts[c.node_id].late += c.late ?? 0;
    }
    const nodeRows = d.nodes.map((n) => {
      const c = counts[n.node_id] ?? { VALID: 0, INVALID: 0, late: 0 };
      const totalRows = (c.VALID ?? 0) + (c.INVALID ?? 0);
      const pct = totalRows ? ((100 * (c.VALID ?? 0)) / totalRows).toFixed(1) : '—';
      return `<tr><td class="mono">${esc(n.node_id)}</td><td>${infoBadge(VALIDITY_INFO, n.validity)}</td>
        <td>${esc(n.invalid_reason ? (INVALID_REASON_TEXT[n.invalid_reason] ?? n.invalid_reason) : '—')}</td>
        <td class="nowrap">${n.last_message_at ? `${fmtTime(n.last_message_at)} (${fmtAge(n.last_message_at, now)})` : '—'}</td>
        <td class="nowrap">${n.last_valid_at ? fmtTime(n.last_valid_at) : '—'}</td>
        <td>${esc(n.sensor_status ?? '—')}</td>
        <td class="num">${c.VALID ?? 0} / ${c.INVALID ?? 0} (${pct}% valid)</td>
        <td class="num">${c.late}</td>
        <td class="small mono">${esc((n.flags ?? []).join(' ') || '—')}</td></tr>`;
    }).join('');
    const ctrlRows = d.controllers.map((c) => `<tr><td class="mono">${esc(c.controller_id)}</td>
      <td>${badge(c.online ? 'Online' : 'Offline', c.online ? 'green' : 'grey')}</td>
      <td class="nowrap">${c.last_message_at ? `${fmtTime(c.last_message_at)} (${fmtAge(c.last_message_at, now)})` : '—'}</td>
      <td class="mono">${esc(c.boot_id ?? '—')}</td><td class="mono">${esc(c.firmware_version ?? '—')}</td>
      <td class="num">${c.report_interval_ms ?? '—'}</td><td class="num">${c.last_sequence ?? '—'}</td>
      <td class="num">${c.gap_count}</td><td class="num">${c.late_count}</td><td class="num">${c.duplicate_count}</td></tr>`).join('');
    const trRows = d.recent_transitions.slice().reverse().map((t) => {
      const info = FEEDER_STATE_INFO[t.to_state] ?? { label: t.to_state, tone: 'grey' };
      return `<tr><td class="nowrap">${fmtDateTime(t.timestamp)}</td><td>${esc(FEEDER_STATE_INFO[t.from_state]?.label ?? t.from_state ?? '—')}</td><td>${badge(info.label, info.tone)}</td><td class="small mono">${esc(t.reason_codes.join(', '))}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="empty">No transitions recorded.</td></tr>';
    const rejRows = d.rejections.map((r) => `<tr><td class="nowrap">${fmtDateTime(r.timestamp)}</td><td class="mono">${esc(r.controller_id ?? '—')}</td><td>${esc(r.reason)}</td><td class="small mono">${esc(JSON.stringify(r.details))}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">No rejected messages.</td></tr>';
    const det = cfg.detection;
    const phByPath = new Map(d.placeholders.map((p) => [p.path, p]));
    const settingRows = Object.entries(det).map(([k, v]) => {
      const ph = phByPath.get(`detection.${k}`);
      return `<tr><td class="mono">${esc(k)}</td><td class="num">${esc(v)}</td><td>${ph ? placeholderTag() : '<span class="muted small">software setting</span>'}</td><td class="small muted">${esc(ph?.note ?? '')}</td></tr>`;
    }).join('');
    const otherPh = d.placeholders.filter((p) => !p.path.startsWith('detection.')).map((p) => `<tr><td class="mono">${esc(p.path)}</td><td class="num">${esc(p.value)}${p.unit ? ` ${esc(p.unit)}` : ''}</td><td>${placeholderTag()}</td><td class="small muted">${esc(p.note)}</td></tr>`).join('');
    const ctr = d.counters;
    el.innerHTML = `
      <div class="grid grid-2">
        <section class="card flush"><header><h2>Controllers</h2>${d.storage.ok ? badge('Storage OK', 'green') : badge(`Storage error: ${d.storage.last_error}`, 'red')}</header>
          <div class="table-wrap"><table><thead><tr><th>ID</th><th>Link</th><th>Last report</th><th>Boot</th><th>Firmware</th><th>Interval ms</th><th>Last seq.</th><th>Gaps</th><th>Late</th><th>Dup.</th></tr></thead><tbody>${ctrlRows}</tbody></table></div>
          <p class="small muted" style="padding:0 16px 12px">Reports accepted ${ctr.accepted}, duplicates ignored ${ctr.duplicates}, late (history only) ${ctr.late}, rejected ${ctr.rejected}, unknown-node entries ${ctr.rejected_nodes}. Counters since server start ${fmtTime(d.started_at)}.</p>
        </section>
        <section class="card flush"><header><h2>Recent feeder state changes</h2></header>
          <div class="table-wrap" style="max-height:320px"><table><thead><tr><th>Time</th><th>From</th><th>To</th><th>Reasons</th></tr></thead><tbody>${trRows}</tbody></table></div></section>
      </div>
      <section class="card flush"><header><h2>Node data quality</h2><span class="small muted">counts are stored rows in the current database</span></header>
        <div class="table-wrap"><table><thead><tr><th>Node</th><th>Validity</th><th>Reason</th><th>Last message</th><th>Last valid</th><th>Sensor</th><th>Valid / invalid rows</th><th>Late rows</th><th>Flags</th></tr></thead><tbody>${nodeRows}</tbody></table></div></section>
      <div class="grid grid-2">
        <section class="card flush"><header><h2>Detection settings</h2>${placeholderTag()}</header>
          <p class="small muted" style="padding:0 16px">From <span class="mono">config/detection.json</span>. Values marked PLACEHOLDER are not validated engineering settings; set them from measurements on the real test setup.</p>
          <div class="table-wrap"><table><thead><tr><th>Parameter</th><th>Value</th><th></th><th>Note</th></tr></thead><tbody>${settingRows}${otherPh}</tbody></table></div></section>
        <section class="card flush"><header><h2>Rejected messages</h2></header>
          <div class="table-wrap" style="max-height:360px"><table><thead><tr><th>Time</th><th>Controller</th><th>Reason</th><th>Details</th></tr></thead><tbody>${rejRows}</tbody></table></div>
          <p class="small muted" style="padding:0 16px 12px">Transient detection capability: <span class="mono">${esc(cfg.capabilities.transient_detection)}</span>${phByPath.has('feeder.capabilities.transient_detection') ? placeholderTag() : ''}. Dips shorter than this resolution cannot be detected.</p></section>
      </div>`;
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(loadSeries, range.ms <= 30 * 60e3 ? 2000 : 15000);
  }

  loadSeries();
  loadDiagnostics();
  schedule();
  diagTimer = setInterval(loadDiagnostics, 3000);
  const offCleared = store.on('history_cleared', () => { loadSeries(); loadDiagnostics(); });

  return {
    destroy() {
      clearInterval(timer);
      clearInterval(diagTimer);
      offCleared();
      chart?.destroy();
      currentChart?.destroy();
    },
  };
}
