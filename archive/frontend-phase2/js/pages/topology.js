// Page B – Feeder topology and localization: diagram, estimated section, the evidence
// behind it, and an explicit statement when the location is uncertain.

import { LOCALIZATION_INFO, SECTION_STATUS_INFO, NODE_CONDITION_INFO, VALIDITY_INFO } from '/shared/labels.js';
import { esc, fmtV } from '../format.js';
import { badge, infoBadge, simTag } from '../ui.js';
import { feederDiagram, diagramLegend } from '../components/feeder-diagram.js';

const SUPPLY_LABEL = { PRESENT: ['Present', 'green'], ABSENT: ['Absent', 'red'], UNKNOWN: ['Unknown', 'grey'] };

export function createTopologyPage(root, store) {
  root.innerHTML = '<div class="stack" id="topo"></div>';
  const el = root.querySelector('#topo');

  function update(status) {
    const topo = store.topology;
    const locKey = status.localization_status;
    const loc = LOCALIZATION_INFO[locKey] ?? { label: locKey, tone: 'grey' };
    const frozenInfo = status.frozen_localization_status ? LOCALIZATION_INFO[status.frozen_localization_status] : null;
    const meaning = frozenInfo ? `${loc.explanation} Original estimate: ${frozenInfo.label}. ${frozenInfo.explanation ?? ''}` : (loc.explanation ?? '');

    const sectionRows = status.sections.map((s) => {
      const up = SUPPLY_LABEL[s.upstream_supply] ?? SUPPLY_LABEL.UNKNOWN;
      const down = SUPPLY_LABEL[s.downstream_supply] ?? SUPPLY_LABEL.UNKNOWN;
      return `<tr><td class="mono">${esc(s.section_id)}</td><td>${esc(s.label)}</td>
        <td>${badge(up[0], up[1])}</td><td>${badge(down[0], down[1])}</td><td>${infoBadge(SECTION_STATUS_INFO, s.status)}</td></tr>`;
    }).join('');

    const nodeRows = status.nodes.map((n) => `<tr><td>${esc(n.label)} <span class="mono muted">${esc(n.node_id)}</span></td>
      <td class="mono">${esc(n.upstream)}</td>
      <td>${infoBadge(VALIDITY_INFO, n.validity)}</td>
      <td>${n.validity === 'VALID' ? infoBadge(NODE_CONDITION_INFO, n.condition) : badge('unknown', 'grey')}</td>
      <td class="num">${n.validity === 'VALID' ? `${fmtV(n.last_valid_voltage_rms)} V ${simTag(status.source)}` : '—'}</td></tr>`).join('');

    el.innerHTML = `
      <section class="card">
        <header><h2>Feeder diagram ${simTag(status.source)}</h2>${diagramLegend()}</header>
        <div class="diagram-wrap">${feederDiagram(topo, status)}</div>
        <p class="small muted">Generated from <span class="mono">config/feeder.json</span>. Sections are the conductor spans between monitoring points; a fault can only be located to a whole section.</p>
      </section>

      <div class="grid grid-2">
        <section class="card">
          <header><h2>Location estimate</h2>${badge(loc.label, loc.tone)}</header>
          <p style="margin-top:0"><b>${esc(status.localization_summary)}</b></p>
          <p class="muted">${esc(meaning)}</p>
          ${status.candidate_sections.length > 1 ? `<p>Candidate sections: <span class="mono">${esc(status.candidate_sections.join(', '))}</span></p>` : ''}
          <h3 style="margin:12px 0 6px">Evidence</h3>
          <ul class="explain">${status.localization_evidence.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
          <div class="note">The software reports a <b>suspected interruption</b> and an <b>estimated section</b>. A broken conductor, an open switch, a blown fuse or a loose joint in that section all produce the same measurements, so a physical break is never claimed.</div>
        </section>

        <section class="card">
          <header><h2>When can the location be estimated?</h2></header>
          <ul class="explain">
            <li><b>Estimated section</b> – the node upstream has supply and the node downstream does not, both with valid data.</li>
            <li><b>Uncertain</b> – a node in between has no valid data (offline, stale or sensor fault), so several sections remain possible.</li>
            <li><b>Source or first section</b> – no node has supply. A source outage and a break before the first node look identical without a sensor at the source.</li>
            <li><b>Inconsistent</b> – a node without supply has a node with supply below it. Impossible in a radial feeder, so a measurement fault is assumed.</li>
            <li><b>Held from before isolation</b> – after the controller isolates, downstream nodes are dead on purpose, so the earlier estimate is kept.</li>
            <li>Not detectable from voltage alone: where inside a section the fault is; breaks held up by backfeed through loads (may look like undervoltage); high-impedance faults; the order of events within one report interval.</li>
          </ul>
        </section>
      </div>

      <div class="grid grid-2">
        <section class="card flush"><header><h2>Sections</h2>${status.sections[0]?.supply_held_from_before_isolation ? '<span class="small muted">supply columns held from before isolation</span>' : ''}</header>
          <div class="table-wrap"><table><thead><tr><th>Section</th><th>Span</th><th>Upstream supply</th><th>Downstream supply</th><th>Status</th></tr></thead><tbody>${sectionRows}</tbody></table></div></section>
        <section class="card flush"><header><h2>Nodes</h2></header>
          <div class="table-wrap"><table><thead><tr><th>Node</th><th>Upstream</th><th>Data</th><th>Condition</th><th>Voltage</th></tr></thead><tbody>${nodeRows}</tbody></table></div></section>
      </div>`;
  }

  return { update };
}
