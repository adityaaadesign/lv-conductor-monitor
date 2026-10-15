// SVG diagram of the configured radial feeder, generated from /api/v1/topology —
// nothing about the node arrangement is hard-coded here.

import { SECTION_STATUS_INFO, NODE_CONDITION_INFO, ISOLATION_FEEDBACK_INFO } from '/shared/labels.js';
import { esc, fmtV } from '../format.js';

const LINE_STYLE = {
  ENERGISED: { color: 'var(--line-energised)', width: 6, dash: '' },
  SUSPECTED: { color: 'var(--line-suspected)', width: 8, dash: '14 8' },
  CANDIDATE: { color: 'var(--line-candidate)', width: 7, dash: '10 6' },
  NO_SUPPLY: { color: 'var(--line-nosupply)', width: 5, dash: '' },
  UNKNOWN: { color: 'var(--line-unknown)', width: 4, dash: '3 6' },
  INCONSISTENT: { color: 'var(--line-candidate)', width: 5, dash: '3 5' },
  DE_ENERGISED: { color: 'var(--line-nosupply)', width: 5, dash: '1 7' },
};
const TONE_FILL = { green: 'var(--green)', amber: 'var(--amber)', red: 'var(--red)', grey: 'var(--grey)' };

// Position nodes: x by distance from the source, y by branch (leaf order).
function layout(topology) {
  const children = new Map([['SOURCE', []]]);
  for (const n of topology.nodes) children.set(n.node_id, []);
  for (const n of topology.nodes) children.get(n.upstream).push(n.node_id);
  const pos = new Map();
  let lane = 0;
  const visit = (id, depth) => {
    const kids = children.get(id);
    if (!kids.length) { pos.set(id, { depth, lane: lane++ }); return; }
    kids.forEach((k) => visit(k, depth + 1));
    const lanes = kids.map((k) => pos.get(k).lane);
    pos.set(id, { depth, lane: (Math.min(...lanes) + Math.max(...lanes)) / 2 });
  };
  visit('SOURCE', 0);
  return { pos, lanes: Math.max(1, lane) };
}

export function feederDiagram(topology, status) {
  const { pos, lanes } = layout(topology);
  const dx = 230;
  const dy = 130;
  const x0 = 70;
  const y0 = 80;
  const maxDepth = Math.max(...[...pos.values()].map((p) => p.depth));
  const width = x0 + maxDepth * dx + 110;
  const height = y0 + (lanes - 1) * dy + 90;
  const xy = (id) => ({ x: x0 + pos.get(id).depth * dx, y: y0 + pos.get(id).lane * dy });
  const nodesById = new Map(status.nodes.map((n) => [n.node_id, n]));
  const sectionsById = new Map(status.sections.map((s) => [s.section_id, s]));
  const parts = [];

  // Source block
  const s = xy('SOURCE');
  parts.push(`<rect x="${s.x - 42}" y="${s.y - 26}" width="84" height="52" rx="6" fill="var(--surface-2)" stroke="var(--border-strong)" stroke-width="2"/>
    <text x="${s.x}" y="${s.y - 2}" text-anchor="middle" font-weight="700" font-size="13">SOURCE</text>
    <text x="${s.x}" y="${s.y + 15}" text-anchor="middle" font-size="11" class="muted-text">LV test supply</text>`);

  // Sections
  for (const n of topology.nodes) {
    const a = xy(n.upstream);
    const b = xy(n.node_id);
    const sec = sectionsById.get(n.section_id);
    const st = LINE_STYLE[sec?.status] ?? LINE_STYLE.UNKNOWN;
    const startX = n.upstream === 'SOURCE' ? a.x + 42 : a.x + 26;
    const endX = b.x - 26;
    const path = a.y === b.y ? `M${startX},${a.y} L${endX},${b.y}` : `M${startX},${a.y} L${startX + 30},${a.y} L${startX + 30},${b.y} L${endX},${b.y}`;
    const label = SECTION_STATUS_INFO[sec?.status]?.label ?? 'Unknown';
    const midX = (startX + endX) / 2;
    parts.push(`<g><title>${esc(n.section_id)} (${esc(n.section_label)}): ${esc(label)}</title>
      <path d="${path}" fill="none" stroke="${st.color}" stroke-width="${st.width}" stroke-dasharray="${st.dash}" stroke-linecap="round"/>
      <text x="${midX}" y="${b.y - 16}" text-anchor="middle" font-size="12" font-weight="650">${esc(n.section_id)}</text>
      <text x="${midX}" y="${b.y + 26}" text-anchor="middle" font-size="11" class="muted-text">${esc(label)}</text>
      ${sec?.status === 'SUSPECTED' ? `<text x="${midX}" y="${b.y + 6}" text-anchor="middle" font-size="18" font-weight="800" fill="var(--line-suspected)">?</text>` : ''}
    </g>`);
  }

  // Isolation switch symbol on its section
  for (const sw of topology.isolation_points ?? []) {
    const n = topology.nodes.find((x) => x.section_id === sw.located_in_section);
    if (!n) continue;
    const a = xy(n.upstream);
    const b = xy(n.node_id);
    const sx = (n.upstream === 'SOURCE' ? a.x + 42 : a.x + 26) + 22;
    const sy = b.y;
    const commanded = status.isolation_command_state === 'COMMANDED' && status.isolation.switch_id === sw.switch_id;
    const fb = ISOLATION_FEEDBACK_INFO[status.isolation_feedback_state]?.label ?? status.isolation_feedback_state;
    // Draw the blade open ONLY when feedback confirms it. Commanded-but-unconfirmed is
    // drawn closed in amber with a "?" because the switch may not have moved.
    const confirmedOpen = commanded && status.isolation_feedback_state === 'OPEN';
    let blade;
    if (confirmedOpen) {
      blade = `<line x1="${sx}" y1="${sy}" x2="${sx + 22}" y2="${sy - 16}" stroke="var(--red)" stroke-width="4" stroke-linecap="round"/>`;
    } else if (commanded) {
      blade = `<line x1="${sx}" y1="${sy}" x2="${sx + 24}" y2="${sy}" stroke="var(--amber)" stroke-width="4" stroke-linecap="round"/>
        <text x="${sx + 13}" y="${sy - 8}" text-anchor="middle" font-size="14" font-weight="800" fill="var(--amber)">?</text>`;
    } else {
      blade = `<line x1="${sx}" y1="${sy}" x2="${sx + 24}" y2="${sy}" stroke="var(--text)" stroke-width="4" stroke-linecap="round"/>`;
    }
    parts.push(`<g><title>${esc(sw.label)} – command: ${commanded ? 'ISOLATE' : 'none'}, feedback: ${esc(fb)}</title>
      <rect x="${sx - 6}" y="${sy - 22}" width="38" height="34" fill="var(--surface)" opacity="0.9"/>
      <circle cx="${sx}" cy="${sy}" r="4" fill="var(--text)"/><circle cx="${sx + 26}" cy="${sy}" r="4" fill="var(--text)"/>${blade}
      <text x="${sx + 13}" y="${sy + 44}" text-anchor="middle" font-size="11" font-weight="650">${esc(sw.switch_id)}</text>
      <text x="${sx + 13}" y="${sy + 58}" text-anchor="middle" font-size="10.5" class="muted-text">${confirmedOpen ? 'open (confirmed)' : commanded ? 'open commanded – unconfirmed' : 'not commanded'} · ${esc(fb)}</text>
    </g>`);
  }

  // Nodes
  for (const n of topology.nodes) {
    const p = xy(n.node_id);
    const st = nodesById.get(n.node_id);
    const valid = st?.validity === 'VALID';
    const tone = valid ? (NODE_CONDITION_INFO[st.condition]?.tone ?? 'grey') : 'grey';
    const reading = valid ? `${fmtV(st.last_valid_voltage_rms)} V` : (st?.validity ?? 'NO DATA');
    const cond = valid ? (NODE_CONDITION_INFO[st.condition]?.label ?? st.condition) : 'no valid data';
    parts.push(`<g><title>${esc(n.label)}: ${esc(cond)}</title>
      <circle cx="${p.x}" cy="${p.y}" r="24" fill="${TONE_FILL[tone]}" stroke="var(--surface)" stroke-width="3" ${valid ? '' : 'stroke-dasharray="4 3" fill-opacity="0.55"'}/>
      <text x="${p.x}" y="${p.y + 5}" text-anchor="middle" font-size="13" font-weight="800" fill="#fff">${esc(n.node_id.replace(/^N-/, ''))}</text>
      <text x="${p.x}" y="${p.y - 34}" text-anchor="middle" font-size="12" font-weight="650">${esc(n.label)}</text>
      <text x="${p.x}" y="${p.y + 44}" text-anchor="middle" font-size="12.5" font-weight="700">${esc(reading)}</text>
      <text x="${p.x}" y="${p.y + 59}" text-anchor="middle" font-size="11" class="muted-text">${esc(cond)}</text>
    </g>`);
  }

  return `<svg class="diagram" viewBox="0 0 ${width} ${height}" role="img" aria-label="Feeder diagram">${parts.join('')}</svg>`;
}

export function diagramLegend() {
  const items = ['ENERGISED', 'SUSPECTED', 'CANDIDATE', 'NO_SUPPLY', 'DE_ENERGISED', 'UNKNOWN'];
  return `<div class="legend">${items.map((k) => {
    const st = LINE_STYLE[k];
    const bg = st.dash ? `repeating-linear-gradient(90deg, ${st.color} 0 8px, transparent 8px 12px)` : st.color;
    return `<span><span class="sw" style="background:${bg}"></span>${esc(SECTION_STATUS_INFO[k].label)}</span>`;
  }).join('')}<span>Dashed node outline = no valid data</span></div>`;
}
