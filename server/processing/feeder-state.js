// Layer D: the feeder state machine (docs/STATE_MACHINE.md §6).
//
// Inputs each evaluation: node states (layers A/B), the localization result (layer C),
// controller online status and the controller's reported protection status.
// Output: the feeder state is updated in place and a list of actions is returned
// (state transitions, incident opened/closed, timeline entries) for the event manager.
//
// An "incident" groups one abnormal episode from detection to closure, so that one
// interruption is one event in the history no matter how many reports it spans.
//   kind 'INT' — interruption (one INTERRUPTION_SUSPECTED / SOURCE_INTERRUPTION_SUSPECTED event)
//   kind 'UV'  — undervoltage episode (the events themselves are per node)
//
// No I/O and no clock reads.

import {
  FeederState as F, NodeCondition as C, NodeValidity as V, LocalizationStatus as L,
  EventType, RecoveryState as R, IsolationConfirmed as IC,
} from '../../shared/enums.js';
import { isUsefulLocalization } from './localization.js';

const ISOLATION_STATES = [F.ISOLATION_PENDING, F.ISOLATED, F.RESTORATION_PENDING];

export function createFeederState(now) {
  return {
    state: F.INITIALIZING,
    since: now,
    initStartedAt: now,
    reasons: ['WAITING_FOR_DATA'],
    incident: null,
    transientUntil: 0,
    lastTransient: null,
    isolation: {
      available: false,
      commanded: false,
      feedbackState: 'UNKNOWN',
      rawFeedback: null,
      switchId: null,
      commandedAt: null,
      releasedAt: null,
      sawOpenDuringCommand: false,
      tripReason: null,
      lockout: null,
      protectionEnabled: null,
      restoreRequested: false,
      restoreSource: null,
      restorationPermitted: null,
    },
  };
}

// Interpret the controller's protection block (STATE_MACHINE T9–T12).
export function updateIsolation(fs, protection, now, p) {
  const iso = fs.isolation;
  if (!protection) {
    iso.available = false;
    iso.commanded = false;
    iso.feedbackState = 'UNKNOWN';
    iso.rawFeedback = null;
    return;
  }
  iso.available = true;
  iso.lockout = protection.lockout;
  iso.protectionEnabled = protection.protection_enabled;
  iso.tripReason = protection.trip_reason;
  iso.restoreRequested = protection.restore_requested;
  iso.restoreSource = protection.restore_source;
  iso.restorationPermitted = protection.restoration_permitted;

  const sw = protection.switches.find((s) => s.isolation_commanded) ?? protection.switches[0] ?? null;
  if (!sw) {
    iso.commanded = false;
    iso.feedbackState = 'UNKNOWN';
    return;
  }
  iso.switchId = sw.switch_id;
  const wasCommanded = iso.commanded;
  if (sw.isolation_commanded && !wasCommanded) {
    iso.commandedAt = now;
    iso.sawOpenDuringCommand = false;
  }
  if (!sw.isolation_commanded && wasCommanded) iso.releasedAt = now;
  iso.commanded = sw.isolation_commanded;

  const raw = sw.feedback;
  iso.rawFeedback = raw;
  let fb;
  if (raw === 'NOT_FITTED') {
    fb = 'NOT_FITTED';
  } else if (sw.isolation_commanded) {
    if (raw === 'OPEN') { fb = 'OPEN'; iso.sawOpenDuringCommand = true; }
    else if (raw === 'CLOSED' && iso.sawOpenDuringCommand) fb = 'CONTRADICTORY';   // opened, then closed while still commanded
    else if (now - iso.commandedAt >= p.isolation_feedback_timeout_ms) fb = 'TIMEOUT';
    else fb = raw;   // still waiting for the relay
  } else if (raw === 'OPEN') {
    const inGrace = iso.releasedAt !== null && now - iso.releasedAt < p.isolation_feedback_timeout_ms;
    fb = inGrace ? 'OPEN' : 'CONTRADICTORY';   // open although not commanded
  } else {
    fb = raw;
  }
  iso.feedbackState = fb;
}

function summarise(inp) {
  const ids = inp.topology.orderedNodeIds;
  const node = (id) => inp.nodes.get(id);
  const valid = ids.filter((id) => node(id).validity === V.VALID);
  const withCond = (...conds) => valid.filter((id) => conds.includes(node(id).condition));
  const normal = withCond(C.NORMAL);
  return {
    ids,
    valid,
    notValid: ids.filter((id) => node(id).validity !== V.VALID),
    lost: withCond(C.SUPPLY_LOST),
    uv: withCond(C.UNDERVOLTAGE),
    recovering: withCond(C.RECOVERING),
    pending: withCond(C.UV_PENDING, C.LOSS_PENDING),
    normal,
    allNormal: valid.length === ids.length && normal.length === ids.length,
  };
}

function snapshotNodes(inp) {
  const snap = {};
  for (const id of inp.topology.orderedNodeIds) {
    const n = inp.nodes.get(id);
    const m = n.lastValid;
    snap[id] = {
      voltage_rms: m?.voltage_rms ?? null,
      voltage_rms_min: m?.voltage_rms_min ?? null,
      current_rms: m?.current_rms ?? null,
      validity: n.validity,
      condition: n.condition,
      received_at: n.lastValidAt,
    };
  }
  return snap;
}

function locReasons(loc) {
  switch (loc?.status) {
    case L.LOCALIZED_ESTIMATE: return ['NODE_SUPPLY_LOST', 'UPSTREAM_PRESENT_DOWNSTREAM_ABSENT'];
    case L.SOURCE_OR_UPSTREAM: return ['NODE_SUPPLY_LOST', 'ALL_NODES_ABSENT'];
    case L.AMBIGUOUS: return ['NODE_SUPPLY_LOST', 'LOCATION_AMBIGUOUS'];
    default: return ['LOCATION_UNKNOWN'];
  }
}

const union = (a, b) => [...new Set([...a, ...b])];

export function evaluateFeeder(fs, inp) {
  const { now, params: p } = inp;
  const actions = [];

  const go = (to, reasons) => {
    if (to !== fs.state) {
      actions.push({ kind: 'TRANSITION', at: now, from: fs.state, to, reasons });
      fs.state = to;
      fs.since = now;
    }
    fs.reasons = reasons;
  };
  const timeline = (entryKind, details = {}) => {
    if (fs.incident) actions.push({ kind: 'TIMELINE', at: now, incident: fs.incident, entry_kind: entryKind, details });
  };

  const sum = summarise(inp);
  updateIsolation(fs, inp.protection, now, p);
  const iso = fs.isolation;
  const loc = inp.liveLoc;

  // ---- T21 / T22: is monitoring possible at all? ----------------------------------
  const monitoring = inp.controllers.anyOnline && sum.valid.length > 0;
  if (!monitoring) {
    const startingUp = fs.state === F.INITIALIZING && now - fs.initStartedAt < p.init_timeout_ms;
    if (startingUp) {
      fs.reasons = ['WAITING_FOR_DATA'];
    } else {
      if (fs.state !== F.UNKNOWN && fs.incident) timeline('MONITORING_LOST', {});
      go(F.UNKNOWN, [inp.controllers.anyOnline ? 'NO_VALID_NODE_DATA' : 'CONTROLLER_OFFLINE']);
    }
    return actions;
  }
  if (fs.state === F.UNKNOWN) {
    if (fs.incident) {
      timeline('MONITORING_RESUMED', {});
    } else {
      go(F.INITIALIZING, ['MONITORING_RESUMED']);
      fs.initStartedAt = now;
    }
  }
  if (fs.incident?.adopted && (sum.lost.length || sum.uv.length)) fs.incident.observedSinceAdopt = true;

  // ---- T8–T13, T19: the controller is holding isolation ---------------------------
  if (iso.commanded) {
    handleIsolationActive(fs, inp, sum, go, timeline, actions);
    return actions;
  }

  // ---- T14: isolation released while we were in an isolation state ----------------
  if (fs.incident?.kind === 'INT' && fs.incident.isolationRequested && ISOLATION_STATES.includes(fs.state)) {
    const fb = iso.feedbackState;
    if (fb === 'CLOSED' || fb === 'NOT_FITTED' || fb === 'UNKNOWN') {
      const inc = fs.incident;
      inc.recloseAt = now;
      inc.supplySeenSinceReclose = false;
      inc.frozen = null;
      inc.recoveryState = R.WAITING_FOR_SUPPLY;
      timeline('RECLOSE_REPORTED', { switch_id: iso.switchId, feedback: fb });
      go(F.RECOVERY_CHECK, ['RECLOSE_REPORTED', 'WAITING_FOR_SUPPLY']);
    } else {
      go(F.RESTORATION_PENDING, [fb === 'CONTRADICTORY' ? 'FEEDBACK_UNCOMMANDED_OPEN' : 'AWAITING_SWITCH_CLOSE']);
    }
    return actions;
  }

  if (fs.incident?.kind === 'INT') handleInterruption(fs, inp, sum, go, timeline, actions);
  else if (fs.incident?.kind === 'UV') handleUndervoltage(fs, inp, sum, go, timeline, actions);
  else handleNoIncident(fs, inp, sum, go, timeline, actions);
  return actions;
}

function openInterruption(fs, inp, sum, usedLoc, extraReasons, timeline, actions) {
  const prev = fs.incident;
  const absentNodes = usedLoc?.absent?.length ? usedLoc.absent : sum.lost;
  const firstSeen = absentNodes.map((id) => inp.nodes.get(id).firstObservedAt).filter((x) => x !== null);
  const inc = {
    kind: 'INT',
    eventType: usedLoc?.status === L.SOURCE_OR_UPSTREAM ? EventType.SOURCE_INTERRUPTION_SUSPECTED : EventType.INTERRUPTION_SUSPECTED,
    startedAt: inp.now,
    firstObservedAt: firstSeen.length ? Math.min(...firstSeen) : inp.now,
    affectedNodes: [...absentNodes],
    localization: usedLoc,
    frozen: null,
    snapshot: snapshotNodes(inp),
    reasons: [...locReasons(usedLoc), ...extraReasons],
    isolationRequested: inp.protection ? false : null,   // null = no protection status available
    isolationRequestedAt: null,
    isolationConfirmed: IC.NOT_APPLICABLE,
    isolationConfirmedAt: null,
    lastCommandAt: null,
    commandFlags: {},
    tripReason: fs.isolation.tripReason,
    recoveryState: R.WAITING_FOR_SUPPLY,
    unstableCount: 0,
    recloseAt: null,
    supplySeenSinceReclose: false,
    restoredAt: null,
    endAt: null,
    endQuality: null,
    escalatedFrom: prev?.kind === 'UV' ? prev.affectedNodes : [],
    eventId: null,
    adopted: false,
    observedSinceAdopt: true,
  };
  fs.incident = inc;
  actions.push({ kind: 'INCIDENT_OPENED', at: inp.now, incident: inc });
  timeline('DETECTED', {
    reasons: inc.reasons,
    localization_status: usedLoc?.status ?? null,
    affected_section: usedLoc?.affected_section ?? null,
    candidate_sections: usedLoc?.candidate_sections ?? [],
  });
  if (inc.escalatedFrom.length) timeline('ESCALATED_FROM_UNDERVOLTAGE', { nodes: inc.escalatedFrom });
  return inc;
}

function handleIsolationActive(fs, inp, sum, go, timeline, actions) {
  const { now } = inp;
  const iso = fs.isolation;
  let inc = fs.incident;

  if (!inc || inc.kind !== 'INT') {
    // The controller tripped before the server confirmed anything (local protection is
    // faster than supervisory persistence). Use the samples from this report.
    const useTrip = !isUsefulLocalization(inp.liveLoc) && isUsefulLocalization(inp.tripLoc);
    const usedLoc = useTrip ? inp.tripLoc : inp.liveLoc;
    const extra = ['PROTECTION_TRIP_REPORTED'];
    if (useTrip) extra.push('LOCALIZED_FROM_TRIP_REPORT');
    inc = openInterruption(fs, inp, sum, usedLoc, extra, timeline, actions);
  }

  // Adopted after a server restart while isolation was already commanded: continuation, not a new command.
  if (inc.adopted && inc.lastCommandAt === null && inc.isolationRequested) inc.lastCommandAt = iso.commandedAt;

  if (inc.lastCommandAt !== iso.commandedAt) {
    const isRetrip = inc.isolationRequested === true;
    inc.lastCommandAt = iso.commandedAt;
    inc.commandFlags = {};
    inc.isolationRequested = true;
    inc.isolationRequestedAt = now;
    inc.tripReason = iso.tripReason;
    if (inc.isolationConfirmed === IC.CONFIRMED && isRetrip) { inc.isolationConfirmed = IC.NOT_CONFIRMED; inc.isolationConfirmedAt = null; }
    // Freeze the location estimate from evidence gathered before the switch opened.
    if (!inc.frozen) {
      let best = inc.localization;
      if (isUsefulLocalization(inp.liveLoc) && !isRetrip) best = inp.liveLoc;
      else if (!isUsefulLocalization(best) && isUsefulLocalization(inp.tripLoc)) best = inp.tripLoc;
      inc.frozen = best;
      inc.localization = best;
    }
    timeline(isRetrip ? 'ISOLATION_REQUESTED_AGAIN' : 'ISOLATION_REQUESTED', {
      switch_id: iso.switchId,
      trip_reason: iso.tripReason,
      feedback: iso.rawFeedback,
    });
  }

  const fb = iso.feedbackState;
  if (fb === 'OPEN' && inc.isolationConfirmed !== IC.CONFIRMED) {
    inc.isolationConfirmed = IC.CONFIRMED;
    inc.isolationConfirmedAt = now;
    timeline('ISOLATION_CONFIRMED', { switch_id: iso.switchId, feedback: 'OPEN' });
  } else if (inc.isolationConfirmed !== IC.CONFIRMED) {
    inc.isolationConfirmed = fb === 'NOT_FITTED' ? IC.NO_FEEDBACK_FITTED : IC.NOT_CONFIRMED;
  }
  if (fb === 'TIMEOUT' && !inc.commandFlags.timeout) {
    inc.commandFlags.timeout = true;
    timeline('ISOLATION_FEEDBACK_TIMEOUT', { switch_id: iso.switchId, feedback: iso.rawFeedback });
  }
  if (fb === 'CONTRADICTORY' && !inc.commandFlags.contradictory) {
    inc.commandFlags.contradictory = true;
    timeline('ISOLATION_FEEDBACK_CONTRADICTORY', { switch_id: iso.switchId, feedback: iso.rawFeedback });
  }

  // T19: affected nodes back to stable supply while the controller still holds isolation.
  const stable = inc.affectedNodes.length > 0 && sum.lost.length === 0 && sum.uv.length === 0
    && inc.affectedNodes.every((id) => {
      const n = inp.nodes.get(id);
      return n.validity === V.VALID && n.condition === C.NORMAL && n.stableSince !== null && n.stableSince > inc.startedAt;
    });

  if (iso.restoreRequested) {
    if (!inc.commandFlags.restoreRequested) {
      inc.commandFlags.restoreRequested = true;
      timeline('RESTORATION_REQUESTED', { restore_source: iso.restoreSource });
    }
    inc.recoveryState = stable ? R.STABLE_AWAITING_CONTROLLER : R.WAITING_FOR_SUPPLY;
    go(F.RESTORATION_PENDING, ['RESTORE_REQUESTED']);
  } else if (stable) {
    inc.recoveryState = R.STABLE_AWAITING_CONTROLLER;
    go(F.RESTORATION_PENDING, ['AWAITING_CONTROLLER_RESTORE']);
  } else if (fb === 'OPEN') {
    inc.recoveryState = R.WAITING_FOR_SUPPLY;
    go(F.ISOLATED, ['ISOLATION_COMMANDED', 'ISOLATION_FEEDBACK_OPEN']);
  } else {
    inc.recoveryState = R.WAITING_FOR_SUPPLY;
    const why = {
      NOT_FITTED: 'FEEDBACK_NOT_FITTED',
      TIMEOUT: 'ISOLATION_FEEDBACK_TIMEOUT',
      CONTRADICTORY: 'FEEDBACK_CONTRADICTORY',
    }[fb] ?? 'AWAITING_FEEDBACK';
    go(F.ISOLATION_PENDING, ['ISOLATION_COMMANDED', why]);
  }
}

function closeIncident(fs, inp, sum, go, actions) {
  actions.push({ kind: 'INCIDENT_CLOSED', at: inp.now, incident: fs.incident });
  fs.incident = null;
  if (sum.notValid.length) go(F.DEGRADED, degradedReasons(inp, sum));
  else go(F.NORMAL, ['ALL_NODES_NORMAL']);
}

// Shared by INT and UV incidents: everything back to normal → RESTORED → (hold) → close.
function handleAllNormal(fs, inp, go, timeline, actions, sum) {
  const inc = fs.incident;
  const p = inp.params;
  if (fs.state !== F.RESTORED) {
    const stableTimes = inc.affectedNodes
      .map((id) => inp.nodes.get(id).stableSince)
      .filter((x) => x !== null && x >= inc.startedAt);
    if (inc.adopted && !inc.observedSinceAdopt) {
      // Cleared while the server was down: the true end time is unknown.
      inc.endAt = inp.now;
      inc.endQuality = 'APPROXIMATE';
      inc.endReason = 'CLEARED_WHILE_SERVER_DOWN';
    } else {
      inc.endAt = stableTimes.length ? Math.max(...stableTimes) : inp.now;
      inc.endQuality = stableTimes.length ? 'EXACT' : 'APPROXIMATE';
      inc.endReason = 'RECOVERY_STABLE';
    }
    inc.restoredAt = inp.now;
    inc.recoveryState = R.RESTORED;
    timeline('RECOVERY_STABLE', { stable_since: inc.endAt });
    go(F.RESTORED, ['RECOVERY_STABLE']);
    return;
  }
  if (inp.now - inc.restoredAt >= p.restored_hold_ms) closeIncident(fs, inp, sum, go, actions);
}

function handleInterruption(fs, inp, sum, go, timeline, actions) {
  const { now, params: p } = inp;
  const inc = fs.incident;
  const loc = inp.liveLoc;

  // Keep the estimate current while not isolated (more nodes may be affected than at first).
  if (sum.lost.length && isUsefulLocalization(loc)
    && (loc.status !== inc.localization?.status || loc.affected_section !== inc.localization?.affected_section
      || loc.candidate_sections.join() !== (inc.localization?.candidate_sections ?? []).join())) {
    inc.localization = loc;
    timeline('LOCALIZATION_UPDATED', {
      localization_status: loc.status, affected_section: loc.affected_section, candidate_sections: loc.candidate_sections,
    });
  }
  if (sum.lost.length && !inc.recloseAt) inc.affectedNodes = union(inc.affectedNodes, sum.lost);

  const notRecovered = sum.lost.length > 0 || sum.uv.length > 0;
  const unstableNow = inp.nodeOutputs.some((o) => o.type === 'RECOVERY_UNSTABLE');

  if (notRecovered) {
    const waitingAfterReclose = fs.state === F.RECOVERY_CHECK && inc.recloseAt !== null
      && !inc.supplySeenSinceReclose && now - inc.recloseAt < p.reclose_supply_timeout_ms && !unstableNow;
    if (waitingAfterReclose) {
      inc.recoveryState = R.WAITING_FOR_SUPPLY;
      go(F.RECOVERY_CHECK, ['RECLOSE_REPORTED', 'WAITING_FOR_SUPPLY']);
      return;
    }
    if (fs.state === F.RECOVERY_CHECK || fs.state === F.RESTORED) {
      // T16: recovery failed or became unstable — same incident continues.
      const failed = inc.recloseAt !== null && !inc.supplySeenSinceReclose;
      inc.unstableCount += 1;
      inc.restoredAt = null;
      inc.recloseAt = null;
      inc.recoveryState = failed ? R.FAILED : R.UNSTABLE;
      timeline(failed ? 'RESTORATION_FAILED' : 'RECOVERY_UNSTABLE', {
        nodes: [...sum.lost, ...sum.uv], unstable_recovery_count: inc.unstableCount,
      });
      go(F.INTERRUPTION_SUSPECTED, [failed ? 'RESTORATION_FAILED' : 'RECOVERY_RESET_BY_ABNORMALITY', ...inc.reasons]);
      return;
    }
    if (inc.recoveryState !== R.UNSTABLE && inc.recoveryState !== R.FAILED) inc.recoveryState = R.WAITING_FOR_SUPPLY;
    go(F.INTERRUPTION_SUSPECTED, inc.reasons);
    return;
  }

  if (sum.recovering.length > 0) {
    if (fs.state !== F.RECOVERY_CHECK) timeline('SUPPLY_RETURN_DETECTED', { nodes: sum.recovering });
    inc.supplySeenSinceReclose = true;
    inc.recoveryState = R.STABILITY_CHECK;
    go(F.RECOVERY_CHECK, ['SUPPLY_RETURNED']);
    return;
  }

  const affectedOk = inc.affectedNodes.every((id) => {
    const n = inp.nodes.get(id);
    return n.validity === V.VALID && n.condition === C.NORMAL;
  });
  if (affectedOk && sum.pending.length === 0 && sum.valid.every((id) => inp.nodes.get(id).condition === C.NORMAL)) {
    handleAllNormal(fs, inp, go, timeline, actions, sum);
    return;
  }

  // Waiting: an affected node has no valid data, or a node is still confirming something.
  if (fs.state === F.RECOVERY_CHECK || fs.state === F.RESTORED || fs.state === F.INITIALIZING) {
    const missing = inc.affectedNodes.some((id) => inp.nodes.get(id).validity !== V.VALID);
    if (missing) fs.reasons = [...new Set([...fs.reasons, 'AFFECTED_NODE_DATA_UNAVAILABLE'])];
    return;
  }
  go(F.INTERRUPTION_SUSPECTED, inc.reasons);
}

function handleUndervoltage(fs, inp, sum, go, timeline, actions) {
  const inc = fs.incident;
  if (sum.lost.length && inp.liveLoc.status !== L.INCONSISTENT) {
    const newInc = openInterruption(fs, inp, sum, inp.liveLoc, [], timeline, actions);
    go(F.INTERRUPTION_SUSPECTED, newInc.reasons);
    return;
  }
  if (sum.uv.length) {
    inc.affectedNodes = union(inc.affectedNodes, sum.uv);
    if (fs.state === F.RECOVERY_CHECK || fs.state === F.RESTORED) {
      inc.unstableCount += 1;
      inc.restoredAt = null;
      inc.recoveryState = R.UNSTABLE;
    } else if (inc.recoveryState !== R.UNSTABLE) {
      inc.recoveryState = R.WAITING_FOR_SUPPLY;
    }
    go(F.UNDERVOLTAGE, ['NODE_UNDERVOLTAGE']);
    return;
  }
  if (sum.recovering.length) {
    inc.recoveryState = R.STABILITY_CHECK;
    go(F.RECOVERY_CHECK, ['SUPPLY_RETURNED']);
    return;
  }
  const affectedOk = inc.affectedNodes.every((id) => {
    const n = inp.nodes.get(id);
    return n.validity === V.VALID && n.condition === C.NORMAL;
  });
  if (affectedOk && sum.pending.length === 0) handleAllNormal(fs, inp, go, timeline, actions, sum);
}

function degradedReasons(inp, sum) {
  const reasons = new Set();
  for (const id of sum.notValid) {
    const v = inp.nodes.get(id).validity;
    if (v === V.STALE) reasons.add('NODE_DATA_STALE');
    else if (v === V.OFFLINE) reasons.add('NODE_OFFLINE');
    else if (v === V.INVALID) reasons.add('SENSOR_INVALID');
    else if (v === V.NEVER_SEEN) reasons.add('NODE_NEVER_REPORTED');
  }
  if (inp.liveLoc.status === L.INCONSISTENT) reasons.add('PATTERN_INCONSISTENT');
  if (sum.recovering.length) reasons.add('NODE_RECOVERING');
  return [...reasons];
}

function handleNoIncident(fs, inp, sum, go, timeline, actions) {
  const { now, params: p } = inp;
  if (sum.lost.length) {
    if (inp.liveLoc.status === L.INCONSISTENT) {
      go(F.DEGRADED, degradedReasons(inp, sum));   // T3a: probable measurement fault, not an interruption
      return;
    }
    const inc = openInterruption(fs, inp, sum, inp.liveLoc, [], timeline, actions);   // T3
    go(F.INTERRUPTION_SUSPECTED, inc.reasons);
    return;
  }
  if (sum.uv.length) {   // T4
    fs.incident = {
      kind: 'UV', startedAt: now, affectedNodes: [...sum.uv], unstableCount: 0,
      recoveryState: R.WAITING_FOR_SUPPLY, restoredAt: null, adopted: false, observedSinceAdopt: true,
    };
    go(F.UNDERVOLTAGE, ['NODE_UNDERVOLTAGE']);
    return;
  }

  const transients = inp.nodeOutputs.filter((o) => o.type === 'TRANSIENT');
  if (transients.length && fs.state !== F.INITIALIZING) {   // T5
    fs.transientUntil = now + p.transient_display_hold_ms;
    fs.lastTransient = {
      at: now,
      nodes: transients.map((t) => t.node_id),
      lowest_pu: Math.min(...transients.map((t) => t.lowest_pu)),
    };
  }

  if (fs.state === F.INITIALIZING) {   // T1 / T2
    if (sum.allNormal) go(F.NORMAL, ['ALL_NODES_NORMAL']);
    else if (now - fs.initStartedAt >= p.init_timeout_ms) go(F.DEGRADED, degradedReasons(inp, sum));
    else fs.reasons = ['WAITING_FOR_DATA'];
    return;
  }
  if (now < fs.transientUntil) {   // T6 holds TRANSIENT for the display period
    go(F.TRANSIENT, ['TRANSIENT_DIP_DETECTED']);
    return;
  }
  const degraded = degradedReasons(inp, sum);   // T7
  if (degraded.length) go(F.DEGRADED, degraded);
  else go(F.NORMAL, ['ALL_NODES_NORMAL']);
}
