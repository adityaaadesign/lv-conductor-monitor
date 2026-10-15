// Layers A and B of the detection logic (docs/STATE_MACHINE.md §3–§4), per node:
//   A. data validity  — is this node's data usable right now?
//   B. electrical condition — normal / low / no supply, with persistence and recovery timers.
//
// No I/O and no clock: every function is given the time ("t" / "now") by the caller.
// Functions update the node state object in place and return a list of "outputs"
// (things that happened) for the feeder state machine and event manager.

import { NodeCondition as C, NodeValidity as V, Band, InvalidReason } from '../../shared/enums.js';

export function createNodeState(nodeId) {
  return {
    node_id: nodeId,
    // Layer A
    validity: V.NEVER_SEEN,
    validitySince: null,
    invalidReason: null,
    lastMessageAt: null,       // any message mentioning this node (valid or not)
    lastMeasurement: null,
    lastValidAt: null,         // last VALID measurement
    lastValid: null,
    lastValidFromHistory: false,   // true when lastValid was loaded from the DB after a restart
    validCount: 0,
    invalidCount: 0,
    // Layer B
    condition: C.UNKNOWN,
    conditionSince: null,
    band: null,
    lastPu: null,
    pendingFrom: null,         // condition to return to if a pending abnormality clears
    firstObservedAt: null,     // first abnormal sample of the current episode
    absentSince: null,         // start of the current run of ABSENT samples
    pendingMinPu: null,
    pendingSawAbsent: false,
    confirmedAt: null,         // when the current abnormal condition was confirmed
    recoveringFrom: null,
    recoveringSince: null,
    stableSince: null,         // start of the last successful stability window
    unstableCount: 0,
  };
}

export function computeBand(prevBand, pu, p) {
  if (pu < p.loss_pickup_pu || (prevBand === Band.ABSENT && pu < p.loss_dropout_pu)) return Band.ABSENT;
  if (pu < p.uv_pickup_pu || (prevBand === Band.LOW && pu < p.uv_dropout_pu)) return Band.LOW;
  return Band.OK;
}

function setCondition(s, cond, t, out) {
  if (s.condition === cond) return;
  out.push({ type: 'CONDITION_CHANGED', node_id: s.node_id, from: s.condition, to: cond, at: t });
  s.condition = cond;
  s.conditionSince = t;
}

function clearPending(s) {
  s.pendingFrom = null;
  s.absentSince = null;
  s.pendingMinPu = null;
  s.pendingSawAbsent = false;
}

// Cancel timers that cannot be completed without fresh valid data.
function cancelPending(s, t, out) {
  if (s.condition === C.UV_PENDING || s.condition === C.LOSS_PENDING) {
    const back = s.pendingFrom ?? C.UNKNOWN;
    clearPending(s);
    if (back === C.NORMAL || back === C.UNKNOWN) s.firstObservedAt = null;
    setCondition(s, back, t, out);
  } else if (s.condition === C.RECOVERING) {
    const back = s.recoveringFrom ?? C.UNKNOWN;
    s.recoveringSince = null;
    setCondition(s, back, t, out);
  }
}

function setValidity(s, v, reason, t, out) {
  if (s.validity === v && s.invalidReason === reason) return;
  const from = s.validity;
  s.validity = v;
  s.invalidReason = reason;
  if (from !== v) {
    s.validitySince = t;
    out.push({ type: 'VALIDITY_CHANGED', node_id: s.node_id, from, to: v, reason, at: t });
    if (from === V.VALID) cancelPending(s, t, out);
  }
}

// Validity from data age (STATE_MACHINE §3). A LINK_LOST measurement counts as
// "missing data", so freshness is judged from the last valid sample.
export function ageValidity(s, now, p, controllerOnline = true) {
  if (s.lastMessageAt === null) return { v: V.NEVER_SEEN, reason: null };
  const m = s.lastMeasurement;
  const commLike = m.validity === V.VALID || m.invalid_reason === InvalidReason.LINK_LOST;
  let v;
  let reason;
  if (commLike) {
    if (s.lastValidAt === null) return { v: V.INVALID, reason: InvalidReason.LINK_LOST };
    const age = now - s.lastValidAt;
    reason = m.validity === V.VALID ? InvalidReason.NO_DATA : InvalidReason.LINK_LOST;
    if (age > p.offline_after_ms) v = V.OFFLINE;
    else if (age > p.stale_after_ms) v = V.STALE;
    else { v = V.VALID; reason = null; }
  } else {
    const age = now - s.lastMessageAt;
    if (age > p.offline_after_ms) { v = V.OFFLINE; reason = InvalidReason.NO_DATA; }
    else if (age > p.stale_after_ms) { v = V.STALE; reason = InvalidReason.NO_DATA; }
    else { v = V.INVALID; reason = m.invalid_reason; }
  }
  if (!controllerOnline && v !== V.INVALID) {
    return { v: V.OFFLINE, reason: InvalidReason.CONTROLLER_OFFLINE };
  }
  return { v, reason };
}

function transientOutput(s, kind, start, at, lowestPu) {
  return { type: 'TRANSIENT', node_id: s.node_id, kind, first_observed: start, at, lowest_pu: lowestPu };
}

function startPending(s, band, from, t, pu, minPu, out) {
  s.pendingFrom = from;
  if (s.firstObservedAt === null || from === C.NORMAL || from === C.UNKNOWN) s.firstObservedAt = t;
  s.pendingMinPu = Math.min(pu, minPu ?? pu);
  s.pendingSawAbsent = band === Band.ABSENT;
  s.absentSince = band === Band.ABSENT ? t : null;
  setCondition(s, band === Band.LOW ? C.UV_PENDING : C.LOSS_PENDING, t, out);
}

function confirm(s, cond, t, out) {
  s.confirmedAt = t;
  clearPending(s);
  setCondition(s, cond, t, out);
  out.push({ type: 'CONDITION_CONFIRMED', node_id: s.node_id, condition: cond, at: t, first_observed: s.firstObservedAt });
}

function maybeConfirm(s, t, p, out) {
  if (s.condition === C.UV_PENDING && t - s.firstObservedAt >= p.uv_persistence_ms) {
    confirm(s, C.UNDERVOLTAGE, t, out);
  } else if (s.condition === C.LOSS_PENDING && s.absentSince !== null && t - s.absentSince >= p.loss_persistence_ms) {
    confirm(s, C.SUPPLY_LOST, t, out);
  }
}

function startRecovery(s, from, t, out) {
  clearPending(s);
  s.recoveringFrom = from;
  s.recoveringSince = t;
  setCondition(s, C.RECOVERING, t, out);
  out.push({ type: 'SUPPLY_RETURNED', node_id: s.node_id, at: t, from });
}

function completeRecovery(s, t, out) {
  s.stableSince = s.recoveringSince;
  out.push({ type: 'RECOVERY_STABLE', node_id: s.node_id, at: t, stable_since: s.stableSince });
  s.recoveringFrom = null;
  s.recoveringSince = null;
  s.firstObservedAt = null;
  s.confirmedAt = null;
  setCondition(s, C.NORMAL, t, out);
}

// Layer B: advance the electrical condition with one VALID sample (STATE_MACHINE §4.2).
function stepCondition(s, m, t, p, nominalV, out) {
  const pu = m.voltage_rms / nominalV;
  const minPu = m.voltage_rms_min !== null ? m.voltage_rms_min / nominalV : null;
  const band = computeBand(s.band, pu, p);
  s.band = band;
  s.lastPu = pu;

  switch (s.condition) {
    case C.UNKNOWN:
      if (band === Band.OK) setCondition(s, C.NORMAL, t, out);
      else startPending(s, band, C.UNKNOWN, t, pu, minPu, out);
      break;

    case C.NORMAL:
      if (band === Band.OK) {
        // Dip shorter than one report, visible only in the per-cycle minimum.
        if (minPu !== null && minPu < p.transient_dip_pu) out.push(transientOutput(s, 'IN_WINDOW', t, t, minPu));
      } else {
        startPending(s, band, C.NORMAL, t, pu, minPu, out);
      }
      break;

    case C.UV_PENDING:
    case C.LOSS_PENDING: {
      s.pendingMinPu = Math.min(s.pendingMinPu ?? pu, pu, minPu ?? pu);
      if (band === Band.OK) {
        if (s.pendingFrom === C.UNDERVOLTAGE) {
          startRecovery(s, C.UNDERVOLTAGE, t, out);
        } else {
          const kind = s.pendingSawAbsent ? 'MOMENTARY_LOSS' : 'SHORT_DIP';
          const from = s.pendingFrom;
          const start = s.firstObservedAt;
          const lowest = s.pendingMinPu;
          clearPending(s);
          s.firstObservedAt = null;
          setCondition(s, C.NORMAL, t, out);
          if (from !== C.UNKNOWN) out.push(transientOutput(s, kind, start, t, lowest));
        }
      } else if (band === Band.LOW) {
        if (s.pendingFrom === C.UNDERVOLTAGE) {
          clearPending(s);
          setCondition(s, C.UNDERVOLTAGE, t, out);   // brief absence inside a confirmed undervoltage
        } else {
          s.absentSince = null;
          setCondition(s, C.UV_PENDING, t, out);
          maybeConfirm(s, t, p, out);
        }
      } else {
        if (s.absentSince === null) s.absentSince = t;
        s.pendingSawAbsent = true;
        setCondition(s, C.LOSS_PENDING, t, out);
        maybeConfirm(s, t, p, out);
      }
      break;
    }

    case C.UNDERVOLTAGE:
      if (band === Band.ABSENT) startPending(s, band, C.UNDERVOLTAGE, t, pu, minPu, out);
      else if (band === Band.OK) startRecovery(s, C.UNDERVOLTAGE, t, out);
      break;

    case C.SUPPLY_LOST:
      if (band === Band.OK) startRecovery(s, C.SUPPLY_LOST, t, out);
      else if (band === Band.LOW) { s.confirmedAt = t; setCondition(s, C.UNDERVOLTAGE, t, out); }   // partial return
      break;

    case C.RECOVERING: {
      const dipped = minPu !== null && minPu < p.uv_pickup_pu;
      if (band !== Band.OK || dipped) {
        // Unstable recovery: fall straight back to the abnormal condition and reset the timer.
        const lowest = Math.min(pu, minPu ?? pu);
        const back = band === Band.ABSENT || lowest < p.loss_pickup_pu ? C.SUPPLY_LOST : C.UNDERVOLTAGE;
        s.unstableCount += 1;
        s.recoveringSince = null;
        s.recoveringFrom = null;
        s.confirmedAt = t;
        setCondition(s, back, t, out);
        out.push({ type: 'RECOVERY_UNSTABLE', node_id: s.node_id, at: t, fell_back_to: back, lowest_pu: lowest });
      } else if (t - s.recoveringSince >= p.recovery_stability_ms) {
        completeRecovery(s, t, out);
      }
      break;
    }
    default:
      break;
  }
}

// Apply one validated measurement (from the validator) received at time t.
export function applyMeasurement(s, m, t, p, nominalV) {
  const out = [];
  s.lastMessageAt = t;
  s.lastMeasurement = m;
  if (m.validity === V.VALID) {
    s.validCount += 1;
    s.lastValid = m;
    s.lastValidAt = t;
    s.lastValidFromHistory = false;
    setValidity(s, V.VALID, null, t, out);
    stepCondition(s, m, t, p, nominalV, out);
  } else {
    s.invalidCount += 1;
    const { v, reason } = ageValidity(s, t, p, true);
    setValidity(s, v, reason, t, out);
  }
  return out;
}

// Periodic re-evaluation: data ageing and timer expiry.
export function applyTime(s, now, p, { controllerOnline = true } = {}) {
  const out = [];
  if (s.lastMessageAt === null) return out;
  const { v, reason } = ageValidity(s, now, p, controllerOnline);
  setValidity(s, v, reason, now, out);
  if (s.validity === V.VALID) {
    if (s.condition === C.UV_PENDING && s.band === Band.LOW) maybeConfirm(s, now, p, out);
    else if (s.condition === C.LOSS_PENDING && s.band === Band.ABSENT) maybeConfirm(s, now, p, out);
    else if (s.condition === C.RECOVERING && now - s.recoveringSince >= p.recovery_stability_ms) completeRecovery(s, now, out);
  }
  return out;
}
