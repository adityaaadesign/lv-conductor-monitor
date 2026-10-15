// Layer C: estimate which section is affected (docs/STATE_MACHINE.md §5).
// Pure function of the topology and each node's supply status. It never claims a
// "break" — only which section is consistent with the measured pattern.

import {
  LocalizationStatus as L, SupplyStatus as S, SectionStatus, NodeCondition as C, NodeValidity as V, SOURCE,
} from '../../shared/enums.js';

// Map a node's monitored state to PRESENT / ABSENT / UNKNOWN for localization.
// usePendingBand: also treat a node whose latest sample is in the ABSENT band but not
// yet confirmed (LOSS_PENDING) as ABSENT. Used only for the trip-time snapshot (§5.3).
export function supplyFromNode(ns, { usePendingBand = false } = {}) {
  if (ns.validity !== V.VALID) return S.UNKNOWN;
  switch (ns.condition) {
    case C.NORMAL:
    case C.UV_PENDING:
    case C.UNDERVOLTAGE:
    case C.RECOVERING:
      return S.PRESENT;
    case C.SUPPLY_LOST:
      return S.ABSENT;
    case C.LOSS_PENDING:
      return usePendingBand ? S.ABSENT : S.UNKNOWN;
    default:
      return S.UNKNOWN;
  }
}

// supply: { [node_id]: 'PRESENT' | 'ABSENT' | 'UNKNOWN' }
export function localize(topology, supply) {
  const ids = topology.orderedNodeIds;
  const present = ids.filter((id) => supply[id] === S.PRESENT);
  const absent = ids.filter((id) => supply[id] === S.ABSENT);
  const unknown = ids.filter((id) => supply[id] !== S.PRESENT && supply[id] !== S.ABSENT);

  // In a radial feeder, any node with supply proves the source is energised.
  const ref = topology.sourceReferenceNode;
  const sourcePresent = (ref && supply[ref] === S.PRESENT) || present.length > 0;

  const result = {
    status: L.NOT_APPLICABLE,
    affected_section: null,
    candidate_sections: [],
    present,
    absent,
    unknown,
    inconsistent_nodes: [],
    suspect_nodes: [],
    source_present: sourcePresent,
    sections: [],
  };

  if (present.length === 0 && absent.length === 0) {
    result.status = L.INSUFFICIENT_DATA;
  } else if (absent.length > 0) {
    // Consistency: a node with supply below a node without supply is impossible in a radial feeder.
    const inconsistent = present.filter((id) => topology.ancestors(id).some((a) => supply[a] === S.ABSENT));
    if (inconsistent.length) {
      result.status = L.INCONSISTENT;
      result.inconsistent_nodes = inconsistent;
      result.suspect_nodes = absent.filter((a) => inconsistent.some((p) => topology.ancestors(p).includes(a)));
    } else {
      const candidates = new Set();
      let reachedUnpoweredSource = false;
      const topAbsent = absent.filter((id) => {
        const up = topology.parentOf(id);
        return up === SOURCE || supply[up] !== S.ABSENT;
      });
      for (const id of topAbsent) {
        // Walk upstream through nodes without valid data until we reach supply or the source.
        const walk = [];
        let cur = id;
        let explained = false;
        for (;;) {
          walk.push(topology.sectionOf(cur));
          const up = topology.parentOf(cur);
          if (up === SOURCE) {
            if (!sourcePresent) reachedUnpoweredSource = true;
            break;
          }
          if (supply[up] === S.PRESENT) break;
          if (supply[up] === S.ABSENT) { explained = true; break; }   // already explained further up
          cur = up;
        }
        if (!explained) walk.forEach((sec) => candidates.add(sec));
      }
      result.candidate_sections = [...candidates];
      if (reachedUnpoweredSource) {
        result.status = L.SOURCE_OR_UPSTREAM;
      } else if (candidates.size === 1) {
        result.status = L.LOCALIZED_ESTIMATE;
        result.affected_section = result.candidate_sections[0];
      } else {
        result.status = L.AMBIGUOUS;
      }
    }
  }

  result.sections = sectionStatuses(topology, supply, result);
  return result;
}

function sectionStatuses(topology, supply, loc) {
  const candidates = new Set(loc.candidate_sections);
  return topology.sections.map((sec) => {
    const up = sec.from === SOURCE ? (loc.source_present ? S.PRESENT : S.UNKNOWN) : supply[sec.from];
    const down = supply[sec.to] ?? S.UNKNOWN;
    let status;
    if (candidates.has(sec.section_id)) {
      status = loc.status === L.LOCALIZED_ESTIMATE ? SectionStatus.SUSPECTED : SectionStatus.CANDIDATE;
    } else if (up === S.PRESENT && down === S.PRESENT) {
      status = SectionStatus.ENERGISED;
    } else if (up === S.ABSENT && down === S.ABSENT) {
      status = SectionStatus.NO_SUPPLY;
    } else if (up === S.ABSENT && down === S.PRESENT) {
      status = SectionStatus.INCONSISTENT;
    } else {
      status = SectionStatus.UNKNOWN;
    }
    return { ...sec, status, upstream_supply: up, downstream_supply: down };
  });
}

// A localization result is "useful" if it says something about where supply was lost.
export function isUsefulLocalization(loc) {
  return !!loc && [L.LOCALIZED_ESTIMATE, L.AMBIGUOUS, L.SOURCE_OR_UPSTREAM].includes(loc.status);
}
