// Builds the feeder status record sent to the dashboard (docs/DATA_CONTRACT.md §5),
// including plain-language explanations of WHY the feeder is in its current state.

import {
  FeederState as F, NodeCondition as C, NodeValidity as V, LocalizationStatus as L, IsolationCommandState,
  DataQuality,
} from '../../shared/enums.js';
import {
  FEEDER_STATE_INFO, LOCALIZATION_INFO, INVALID_REASON_TEXT, REASON_TEXT,
} from '../../shared/labels.js';
import { toIso } from '../domain/clock.js';
import { displayStatus, faultKind, nodeDisplayState, DISPLAY_STATUS } from '../../shared/simple.js';

const fmtV = (v) => (v === null || v === undefined ? 'n/a' : `${v.toFixed(1)} V`);
const fmtS = (ms) => `${(ms / 1000).toFixed(1)} s`;

function nodeLabel(topology, id) {
  return topology.nodeById.get(id)?.label ?? id;
}

// One evidence line per node, in plain English, e.g. "Node A has voltage (229.4 V)."
export function evidenceLines(topology, nodes, loc) {
  return topology.orderedNodeIds.map((id) => {
    const n = nodes.get(id);
    const label = nodeLabel(topology, id);
    if (n.validity !== V.VALID) {
      return `${label}: no reliable reading (${(INVALID_REASON_TEXT[n.invalidReason] ?? 'no data').toLowerCase()}), so we do not know whether it has supply.`;
    }
    const v = fmtV(n.lastValid?.voltage_rms);
    if (loc.present.includes(id)) return `${label} has voltage (${v}).`;
    if (loc.absent.includes(id)) return `${label} has no supply (${v} measured).`;
    return `${label}: voltage ${v}, still being checked.`;
  });
}

export function localizationSentence(topology, loc) {
  const between = (sid) => {
    const sec = topology.sections.find((s) => s.section_id === sid);
    if (!sec) return sid;
    const from = sec.from === 'SOURCE' ? 'the supply source' : nodeLabel(topology, sec.from);
    return `between ${from} and ${nodeLabel(topology, sec.to)} (section ${sid})`;
  };
  switch (loc.status) {
    case L.LOCALIZED_ESTIMATE:
      return `The fault is most likely ${between(loc.affected_section)}: the point before it still has voltage and the points after it have none. This is an estimate – the exact spot inside that section cannot be found from voltages.`;
    case L.AMBIGUOUS:
      return `The faulty section is uncertain. It could be ${loc.candidate_sections.map(between).join(' or ')}, because a monitoring point in between has no reliable reading.`;
    case L.SOURCE_OR_UPSTREAM:
      return 'No monitoring point has supply. This could be a supply-source outage or a fault before the first node – the system cannot tell which, so it does not name a section.';
    case L.INCONSISTENT:
      return `The readings do not make sense together: ${loc.inconsistent_nodes.map((id) => nodeLabel(topology, id)).join(', ')} still has voltage although ${loc.suspect_nodes.map((id) => nodeLabel(topology, id)).join(', ')} (before it on the line) shows none. This usually means a sensor problem, so no faulty section is named.`;
    case L.INSUFFICIENT_DATA:
      return 'No reliable readings are available, so the faulty section cannot be estimated.';
    default:
      return 'No supply loss detected, so there is no faulty section to estimate.';
  }
}

function explain(fs, ctx) {
  const { topology, nodes, detection: p, nominalV, now, liveLoc, controllers } = ctx;
  const lines = [];
  const iso = fs.isolation;
  const inc = fs.incident;
  const total = topology.orderedNodeIds.length;
  const validCount = topology.orderedNodeIds.filter((id) => nodes.get(id).validity === V.VALID).length;
  const lowLimit = `${(p.uv_pickup_pu * nominalV).toFixed(0)} V`;
  switch (fs.state) {
    case F.INITIALIZING:
      lines.push(`Starting up: waiting for readings from all monitoring points (${validCount} of ${total} received).`);
      break;
    case F.NORMAL:
    case F.RESTORED:
      lines.push(`All ${total} monitoring points report voltage above the low-voltage limit (${lowLimit}).`);
      break;
    case F.TRANSIENT: {
      const t = fs.lastTransient;
      if (t) lines.push(`A brief voltage dip was seen at ${t.nodes.map((id) => nodeLabel(topology, id)).join(', ')}, but the voltage came back before it could count as a fault. It was recorded and nothing else happened.`);
      break;
    }
    case F.UNDERVOLTAGE:
      for (const id of topology.orderedNodeIds) {
        const n = nodes.get(id);
        if (n.condition === C.UNDERVOLTAGE) {
          lines.push(`${nodeLabel(topology, id)} is at ${fmtV(n.lastValid?.voltage_rms)}, below the low-voltage limit of ${lowLimit}, and has stayed low for more than ${fmtS(p.uv_persistence_ms)}.`);
        }
      }
      lines.push('Low voltage alone does not shut the line down; the supply is still present.');
      break;
    case F.DEGRADED:
      for (const id of topology.orderedNodeIds) {
        const n = nodes.get(id);
        if (n.validity !== V.VALID) {
          // No "x seconds ago" here: these lines are shown in expandable panels and should
          // not change every second while someone reads them (times are in the technical details).
          lines.push(`${nodeLabel(topology, id)}: ${(INVALID_REASON_TEXT[n.invalidReason] ?? 'no usable data').toLowerCase()}. Its voltage is unknown. This is a communication or sensor problem – it is NOT treated as 0 V and NOT taken as a broken line.`);
        } else if (n.condition === C.RECOVERING) {
          lines.push(`${nodeLabel(topology, id)}: voltage is back; checking that it stays steady.`);
        }
      }
      if (liveLoc.status === L.INCONSISTENT) lines.push(localizationSentence(topology, liveLoc));
      break;
    case F.UNKNOWN: {
      for (const c of controllers.list.filter((x) => !x.online)) {
        lines.push(`No reports from controller ${c.controller_id} for more than ${fmtS(p.controller_offline_after_ms)}.`);
      }
      if (controllers.list.every((c) => c.online)) lines.push('No monitoring point is sending reliable readings.');
      lines.push('The state of the line is unknown. This does NOT mean a line is broken. The controller\'s own protection keeps working without this software.');
      break;
    }
    default:
      break;
  }

  if (inc?.kind === 'INT') {
    const loc = inc.frozen ?? inc.localization;
    if (loc) lines.push(localizationSentence(topology, loc));
    if (inc.reasons.includes('LOCALIZED_FROM_TRIP_REPORT')) {
      lines.push('The controller acted before this software finished its own check, so the section estimate uses the readings taken just before the switch opened.');
    }
    lines.push('Voltage readings alone cannot prove that the wire is physically broken – an open switch, a blown fuse or a loose joint in that section would look the same.');
  }

  if (iso.available && iso.commanded) {
    lines.push(`The controller ordered switch ${iso.switchId} to open (shutdown).`);
    const fb = {
      OPEN: 'The switch feedback signal says OPEN, so the shutdown is confirmed.',
      NOT_FITTED: 'This switch has no feedback signal, so the shutdown cannot be confirmed. The switch may or may not have opened.',
      TIMEOUT: `The switch did not confirm OPEN within ${fmtS(p.isolation_feedback_timeout_ms)}. The shutdown is NOT confirmed – check the switch and its wiring.`,
      CONTRADICTORY: 'The switch feedback disagrees with the order. The shutdown is NOT confirmed.',
      CLOSED: 'Waiting for the switch to report OPEN.',
      UNKNOWN: 'No feedback signal has been received from the switch yet.',
    }[iso.feedbackState];
    if (fb) lines.push(fb);
  }
  // Recovery is not part of the simple demo, but the backend still reports it honestly.
  if (fs.state === F.RESTORATION_PENDING) lines.push('A reset was requested at the controller. Re-energising is the controller\'s decision; this software never switches anything on.');
  if (fs.state === F.RECOVERY_CHECK && inc) lines.push('Voltage has come back. The event stays open until it has been steady for a while.');
  return lines;
}

function recoveryProgress({ topology, nodes, now }) {
  const recovering = topology.orderedNodeIds.map((id) => nodes.get(id)).filter((n) => n.validity === V.VALID && n.condition === C.RECOVERING);
  if (!recovering.length) return { stableForMs: null };
  return { stableForMs: Math.min(...recovering.map((n) => now - n.recoveringSince)) };
}

export function buildStatus(fs, ctx) {
  const { topology, nodes, detection: p, feeder, source, now, liveLoc, controllers, storage, sessions } = ctx;
  const inc = fs.incident;
  const iso = fs.isolation;

  // While isolated, show the location held from before the switch opened.
  const shownLoc = inc?.kind === 'INT' ? (inc.frozen ?? inc.localization ?? liveLoc) : liveLoc;
  const frozen = !!(inc?.kind === 'INT' && inc.frozen);
  const sectionsSource = shownLoc.sections?.length ? shownLoc : liveLoc;

  // Nodes downstream of a switch the controller has commanded open. "CONFIRMED" only
  // when the switch feedback reports OPEN; otherwise the node may still be energised.
  const commandedSwitch = iso.commanded ? topology.switches.get(iso.switchId) : null;
  const isolationEffect = (id) => {
    if (!commandedSwitch?.de_energises_nodes.includes(id)) return null;
    return iso.feedbackState === 'OPEN' ? 'CONFIRMED' : 'UNCONFIRMED';
  };

  const nodeList = topology.orderedNodeIds.map((id) => {
    const n = nodes.get(id);
    const cfg = topology.nodeById.get(id);
    return {
      node_id: id,
      label: cfg.label,
      upstream: cfg.upstream,
      section_id: cfg.section_id,
      has_current_sensor: !!cfg.has_current_sensor,
      validity: n.validity,
      invalid_reason: n.invalidReason,
      condition: n.condition,
      condition_since: toIso(n.conditionSince),
      last_valid_voltage_rms: n.lastValid?.voltage_rms ?? null,
      last_valid_voltage_rms_min: n.lastValid?.voltage_rms_min ?? null,
      last_valid_voltage_rms_max: n.lastValid?.voltage_rms_max ?? null,
      last_valid_current_rms: cfg.has_current_sensor ? (n.lastValid?.current_rms ?? null) : null,
      last_valid_pu: n.lastValid?.voltage_rms !== undefined && n.lastValid?.voltage_rms !== null ? n.lastValid.voltage_rms / feeder.nominal_voltage_v : null,
      last_valid_at: toIso(n.lastValidAt),
      last_valid_from_history: n.lastValidFromHistory,
      last_message_at: toIso(n.lastMessageAt),
      sensor_status: n.lastMeasurement?.sensor_status ?? null,
      supply_present_reported: n.lastMeasurement?.supply_present_reported ?? null,
      recovering_for_ms: n.condition === C.RECOVERING && n.recoveringSince !== null ? now - n.recoveringSince : null,
      unstable_count: n.unstableCount,
      isolation_effect: isolationEffect(id),
      valid_count: n.validCount,
      invalid_count: n.invalidCount,
    };
  });

  const counts = { normal: 0, warning: 0, interrupted: 0, offline_or_invalid: 0 };
  for (const n of nodeList) {
    if (n.validity !== V.VALID) counts.offline_or_invalid++;
    else if (n.condition === C.NORMAL) counts.normal++;
    else if (n.condition === C.SUPPLY_LOST) counts.interrupted++;
    else counts.warning++;
  }
  const validCount = nodeList.length - counts.offline_or_invalid;

  let commandState = IsolationCommandState.UNAVAILABLE;
  if (iso.available) {
    if (iso.commanded) commandState = IsolationCommandState.COMMANDED;
    else if (inc?.kind === 'INT' && inc.isolationRequested) commandState = IsolationCommandState.RELEASED;
    else commandState = IsolationCommandState.NONE;
  }

  const rec = recoveryProgress(ctx);
  const ctrlList = controllers.list.map((c) => {
    const st = sessions.stats(c.controller_id);
    return {
      controller_id: c.controller_id,
      label: topology.controllersById.get(c.controller_id)?.label ?? c.controller_id,
      online: c.online,
      last_message_at: toIso(c.lastSeenAt),
      boot_id: c.bootId,
      firmware_version: c.firmwareVersion,
      report_interval_ms: c.reportIntervalMs,
      last_sequence: st?.last_sequence ?? null,
      gap_count: st?.gaps ?? 0,
      duplicate_count: st?.duplicates ?? 0,
      late_count: st?.late ?? 0,
      protection: c.online ? c.protection : null,
    };
  });

  // Protection agreement (STATE_MACHINE §6.5)
  let agreement = 'UNKNOWN';
  if (ctx.disagreement?.active) agreement = 'DISAGREE';
  else if (iso.available) agreement = 'AGREE';

  const result = {
    feeder_id: feeder.feeder_id,
    feeder_name: feeder.name,
    source,
    status: fs.state,
    status_label: FEEDER_STATE_INFO[fs.state]?.label ?? fs.state,
    condition_since: toIso(fs.since),
    reason_codes: fs.reasons,
    reason_text: fs.reasons.map((r) => REASON_TEXT[r] ?? r),
    explanation: explain(fs, ctx),
    affected_section: shownLoc.status === L.LOCALIZED_ESTIMATE ? shownLoc.affected_section : null,
    candidate_sections: shownLoc.candidate_sections ?? [],
    localization_status: frozen ? L.FROZEN : shownLoc.status,
    frozen_localization_status: frozen ? shownLoc.status : null,
    localization_label: LOCALIZATION_INFO[frozen ? L.FROZEN : shownLoc.status]?.label,
    localization_summary: localizationSentence(topology, shownLoc),
    localization_evidence: frozen ? evidenceLinesFromSnapshot(topology, inc) : evidenceLines(topology, nodes, shownLoc),
    sections: sectionsSource.sections.map((s) => ({
      ...s,
      status: isolationEffect(s.to) === 'CONFIRMED' && !['SUSPECTED', 'CANDIDATE'].includes(s.status) ? 'DE_ENERGISED' : s.status,
      supply_held_from_before_isolation: frozen,
      label: topology.sections.find((x) => x.section_id === s.section_id)?.label ?? s.section_id,
    })),
    recovery_state: inc ? inc.recoveryState : 'NOT_APPLICABLE',
    recovery_stable_for_ms: rec.stableForMs,
    recovery_required_ms: p.recovery_stability_ms,
    unstable_recovery_count: inc?.unstableCount ?? 0,
    isolation_command_state: commandState,
    isolation_feedback_state: iso.available ? iso.feedbackState : 'UNKNOWN',
    isolation_confirmed: inc?.kind === 'INT' ? inc.isolationConfirmed : 'NOT_APPLICABLE',
    isolation: {
      switch_id: iso.switchId,
      commanded_at: toIso(iso.commandedAt),
      raw_feedback: iso.rawFeedback,
      trip_reason: iso.tripReason,
      lockout: iso.lockout,
      protection_enabled: iso.protectionEnabled,
      restore_requested: iso.restoreRequested,
      restore_source: iso.restoreSource,
      restoration_permitted: iso.restorationPermitted,
    },
    protection_agreement: agreement,
    data_quality: validCount === 0 ? DataQuality.NONE : validCount < nodeList.length ? DataQuality.DEGRADED : DataQuality.GOOD,
    active_event_ids: ctx.openEventIds,
    active_events: ctx.openEvents,
    node_counts: counts,
    nodes: nodeList,
    controllers: ctrlList,
    last_valid_measurement_at: toIso(Math.max(0, ...nodeList.map((n) => (n.last_valid_at ? Date.parse(n.last_valid_at) : 0))) || null),
    storage,
    last_updated: toIso(now),
    server_now: now,
    previous_run: ctx.previousRun ?? null,
  };
  // Simple five-state view used by the dashboard (shared/simple.js).
  for (const n of result.nodes) n.display_state = nodeDisplayState(n);
  result.display_status = displayStatus(result);
  result.display_status_label = DISPLAY_STATUS[result.display_status].label;
  result.fault_kind = faultKind(result);
  return result;
}

function evidenceLinesFromSnapshot(topology, inc) {
  const loc = inc.frozen;
  return topology.orderedNodeIds.map((id) => {
    const label = topology.nodeById.get(id)?.label ?? id;
    const state = loc.present?.includes(id) ? 'had voltage' : loc.absent?.includes(id) ? 'had no supply' : 'had no reliable reading';
    const v = inc.snapshot?.[id]?.voltage_rms;
    const reading = v !== null && v !== undefined ? `${v.toFixed(1)} V` : 'no value';
    return `${label} ${state} just before the shutdown (${reading}).`;
  });
}
