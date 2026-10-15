// SIMULATED physics of the prototype feeder: what voltage each node would "see".
// Only used in demo mode. Very simple on purpose: a radial line where a broken section
// or an open source-side switch removes voltage from everything downstream.

import { SOURCE } from '../../shared/enums.js';

// Small deterministic pseudo-random generator (mulberry32) so runs are repeatable.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FeederPhysics {
  constructor(topology, nominalV) {
    this.topology = topology;
    this.nominalV = nominalV;
    this.sourcePu = 1.0;
    this.brokenSections = new Set();
    this.switchClosed = new Map([...topology.switches.keys()].map((id) => [id, true]));
    // Natural voltage drop along the line (fraction of nominal), larger further from the source.
    this.nodeDropPu = new Map(topology.orderedNodeIds.map((id, i) => [id, 0.004 + 0.006 * i]));
  }

  setSource(pu) { this.sourcePu = pu; }
  breakSection(sectionId) { this.brokenSections.add(sectionId); }
  repairSection(sectionId) { this.brokenSections.delete(sectionId); }
  setNodeDrop(nodeId, pu) { this.nodeDropPu.set(nodeId, pu); }
  setSwitch(switchId, closed) { this.switchClosed.set(switchId, closed); }

  // True RMS voltage at a node right now (before sensor noise).
  voltageAt(nodeId) {
    if (this.sourcePu <= 0) return 0;
    for (const sw of this.topology.switches.values()) {
      if (!this.switchClosed.get(sw.switch_id) && sw.de_energises_nodes.includes(nodeId)) return 0;
    }
    let cur = nodeId;
    while (cur !== SOURCE) {
      if (this.brokenSections.has(this.topology.sectionOf(cur))) return 0;
      cur = this.topology.parentOf(cur);
    }
    return this.nominalV * this.sourcePu * (1 - (this.nodeDropPu.get(nodeId) ?? 0));
  }
}
