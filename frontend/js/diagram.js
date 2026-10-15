// The feeder drawing: SUPPLY – switch – Node A – Node B – Node C.
// Drawn horizontally on wide screens and vertically on narrow ones (phones), so the labels
// stay readable. Built from the configured topology and the live status.
//
// Section colours:   green = normal   red dashes + ✕ = possible interruption (estimate)
//                    amber dashes + ? = uncertain   grey = no supply / switched off
// Switch:            drawn OPEN only when feedback confirms it; "?" when commanded but
//                    unconfirmed or when its state is unknown.

import { NODE_DISPLAY, switchDrawing } from '/shared/simple.js';
import { esc, fmtV } from './format.js';

const SECTION_LOOK = {
  ENERGISED: { kind: 'normal', label: '' },
  SUSPECTED: { kind: 'fault', label: 'Possible interruption' },
  CANDIDATE: { kind: 'uncertain', label: 'Uncertain' },
  INCONSISTENT: { kind: 'uncertain', label: 'Uncertain' },
  NO_SUPPLY: { kind: 'off', label: 'No supply' },
  DE_ENERGISED: { kind: 'off', label: 'Switched off' },
  UNKNOWN: { kind: 'unknown', label: 'Unknown' },
};
const STROKE = {
  normal: { color: 'var(--green)', dash: '', width: 9 },
  fault: { color: 'var(--red)', dash: '14 9', width: 10 },
  uncertain: { color: 'var(--amber)', dash: '10 8', width: 9 },
  off: { color: 'var(--line-nosupply)', dash: '', width: 8 },
  unknown: { color: 'var(--line-nosupply)', dash: '3 8', width: 7 },
};
const FILL = { green: 'var(--green)', amber: 'var(--amber)', red: 'var(--red)', grey: 'var(--grey)' };
const SWITCH_LABEL = {
  OPEN_CONFIRMED: 'Switch open – confirmed',
  OPEN_ORDERED: 'Open commanded – not confirmed',
  CLOSED: 'Switch closed',
  UNKNOWN: 'Switch state unknown',
};

function line(x1, y1, x2, y2, look) {
  const s = STROKE[look.kind];
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${s.color}" stroke-width="${s.width}" stroke-dasharray="${s.dash}" stroke-linecap="round"/>`;
}

function marker(x, y, look) {
  if (look.kind === 'fault') {
    return `<circle cx="${x}" cy="${y}" r="15" fill="var(--surface)" stroke="var(--red)" stroke-width="3"/>
      <text x="${x}" y="${y + 6}" text-anchor="middle" font-size="18" font-weight="800" fill="var(--red)">✕</text>`;
  }
  if (look.kind === 'uncertain') {
    return `<circle cx="${x}" cy="${y}" r="14" fill="var(--surface)" stroke="var(--amber)" stroke-width="3"/>
      <text x="${x}" y="${y + 6}" text-anchor="middle" font-size="17" font-weight="800" fill="var(--amber)">?</text>`;
  }
  return '';
}

// Switch symbol centred at (x, y); vertical = line runs top-to-bottom.
function switchSymbol(x, y, state, vertical) {
  const a = vertical ? [x, y - 16] : [x - 16, y];
  const b = vertical ? [x, y + 16] : [x + 16, y];
  let blade;
  if (state === 'OPEN_CONFIRMED') {
    const tip = vertical ? [x + 20, y + 8] : [x + 8, y - 20];
    blade = `<line x1="${a[0]}" y1="${a[1]}" x2="${tip[0]}" y2="${tip[1]}" stroke="var(--red)" stroke-width="5" stroke-linecap="round"/>`;
  } else {
    const color = state === 'CLOSED' ? 'var(--text)' : state === 'UNKNOWN' ? 'var(--grey)' : 'var(--amber)';
    blade = `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${color}" stroke-width="5" stroke-linecap="round" ${state === 'UNKNOWN' ? 'stroke-dasharray="4 4"' : ''}/>`;
  }
  const query = state === 'OPEN_ORDERED' || state === 'UNKNOWN'
    ? `<text x="${vertical ? x - 22 : x}" y="${vertical ? y + 6 : y - 16}" text-anchor="middle" font-size="18" font-weight="800" fill="${state === 'UNKNOWN' ? 'var(--grey)' : 'var(--amber)'}">?</text>`
    : '';
  return `<rect x="${x - 26}" y="${y - 26}" width="52" height="52" rx="8" fill="var(--surface)"/>
    <circle cx="${a[0]}" cy="${a[1]}" r="5" fill="var(--text)"/><circle cx="${b[0]}" cy="${b[1]}" r="5" fill="var(--text)"/>${blade}${query}`;
}

function nodeCircle(x, y, node, def) {
  const disp = NODE_DISPLAY[node.display_state];
  const noData = node.display_state === 'NO_DATA';
  return `<circle cx="${x}" cy="${y}" r="30" fill="${FILL[disp.tone]}" ${noData ? 'fill-opacity="0.35" stroke="var(--grey)" stroke-dasharray="5 4"' : 'stroke="var(--surface)"'} stroke-width="4"/>
    <text x="${x}" y="${y + 7}" text-anchor="middle" font-size="20" font-weight="800" fill="${noData ? 'var(--text)' : '#fff'}">${esc(def.node_id.replace(/^N-/, ''))}</text>`;
}

const reading = (n) => (n.display_state === 'NO_DATA' ? 'No data' : `${fmtV(n.last_valid_voltage_rms, 0)} V`);

export function feederDiagram(topology, status, vertical) {
  const nodes = topology.nodes;
  const sections = new Map(status.sections.map((s) => [s.section_id, s]));
  const live = new Map(status.nodes.map((n) => [n.node_id, n]));
  const sw = switchDrawing(status);
  const hasSwitch = (topology.isolation_points ?? []).length > 0;
  const out = [];

  if (!vertical) {
    const step = 245;
    const x0 = 90;
    const y = 110;
    const width = x0 + nodes.length * step + 50;
    const xOf = (id) => (id === 'SOURCE' ? x0 : x0 + (nodes.findIndex((n) => n.node_id === id) + 1) * step);
    out.push(`<rect x="${x0 - 60}" y="${y - 30}" width="120" height="60" rx="12" fill="var(--surface-2)" stroke="var(--border-strong)" stroke-width="2"/>
      <text x="${x0}" y="${y + 6}" text-anchor="middle" font-size="16" font-weight="800">SUPPLY</text>`);
    for (const n of nodes) {
      const look = SECTION_LOOK[sections.get(n.section_id)?.status] ?? SECTION_LOOK.UNKNOWN;
      const a = xOf(n.upstream) + (n.upstream === 'SOURCE' ? 60 : 32);
      const b = xOf(n.node_id) - 32;
      const mid = (a + b) / 2;
      out.push(line(a, y, b, y, look));
      out.push(marker(mid + (n.upstream === 'SOURCE' && hasSwitch ? 30 : 0), y, look));
      if (look.label) {
        out.push(`<text x="${mid}" y="${y + 44}" text-anchor="middle" font-size="15" font-weight="${look.kind === 'fault' ? 800 : 600}" fill="${STROKE[look.kind].color}">${esc(look.label)}</text>`);
      }
    }
    if (hasSwitch) {
      const sx = x0 + 60 + 52;
      out.push(switchSymbol(sx, y, sw, false));
      out.push(`<text x="${sx}" y="${y - 40}" text-anchor="middle" font-size="12" fill="var(--text-2)">${esc(SWITCH_LABEL[sw])}</text>`);
    }
    for (const def of nodes) {
      const n = live.get(def.node_id);
      const x = xOf(def.node_id);
      out.push(nodeCircle(x, y, n, def));
      out.push(`<text x="${x}" y="${y - 44}" text-anchor="middle" font-size="18" font-weight="700">${esc(def.label)}</text>
        <text x="${x}" y="${y + 60}" text-anchor="middle" font-size="19" font-weight="800">${esc(reading(n))}</text>`);
    }
    return `<svg class="diagram" viewBox="0 0 ${width} 200" role="img" aria-label="Feeder diagram">${out.join('')}</svg>`;
  }

  // Vertical layout for narrow screens.
  const step = 104;
  const x = 70;
  const y0 = 50;
  const height = y0 + nodes.length * step + 50;
  const yOf = (id) => (id === 'SOURCE' ? y0 : y0 + (nodes.findIndex((n) => n.node_id === id) + 1) * step);
  out.push(`<rect x="${x - 50}" y="${y0 - 26}" width="100" height="52" rx="12" fill="var(--surface-2)" stroke="var(--border-strong)" stroke-width="2"/>
    <text x="${x}" y="${y0 + 6}" text-anchor="middle" font-size="15" font-weight="800">SUPPLY</text>`);
  for (const n of nodes) {
    const look = SECTION_LOOK[sections.get(n.section_id)?.status] ?? SECTION_LOOK.UNKNOWN;
    const a = yOf(n.upstream) + (n.upstream === 'SOURCE' ? 26 : 32);
    const b = yOf(n.node_id) - 32;
    const mid = (a + b) / 2;
    out.push(line(x, a, x, b, look));
    if (!(n.upstream === 'SOURCE' && hasSwitch)) out.push(marker(x, mid, look));
    if (look.label) out.push(`<text x="${x + 46}" y="${mid + 5}" font-size="15" font-weight="${look.kind === 'fault' ? 800 : 600}" fill="${STROKE[look.kind].color}">${esc(look.label)}</text>`);
  }
  if (hasSwitch) {
    const sy = (yOf('SOURCE') + 26 + yOf(nodes[0].node_id) - 32) / 2;
    out.push(switchSymbol(x, sy, sw, true));
    out.push(`<text x="${x + 46}" y="${sy + 24}" font-size="13" fill="var(--text-2)">${esc(SWITCH_LABEL[sw])}</text>`);
  }
  for (const def of nodes) {
    const n = live.get(def.node_id);
    const y = yOf(def.node_id);
    out.push(nodeCircle(x, y, n, def));
    out.push(`<text x="${x + 46}" y="${y - 2}" font-size="16" font-weight="700">${esc(def.label)}</text>
      <text x="${x + 46}" y="${y + 20}" font-size="16" font-weight="800">${esc(reading(n))}</text>`);
  }
  return `<svg class="diagram vertical" viewBox="0 0 340 ${height}" role="img" aria-label="Feeder diagram">${out.join('')}</svg>`;
}

export function diagramLegend() {
  const item = (kind, text) => {
    const s = STROKE[kind];
    return `<span class="lg"><svg width="30" height="10" aria-hidden="true"><line x1="3" y1="5" x2="27" y2="5" stroke="${s.color}" stroke-width="5" stroke-dasharray="${s.dash ? '6 4' : ''}" stroke-linecap="round"/></svg>${text}</span>`;
  };
  return `${item('normal', 'Normal')}${item('fault', 'Possible interruption')}${item('uncertain', 'Uncertain')}${item('off', 'No supply')}`;
}
