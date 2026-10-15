// Layer E: event lifecycle (docs/STATE_MACHINE.md §7).
//
// Two mechanisms:
//  1. The interruption incident (one event per incident) is driven by explicit actions
//     from the feeder state machine: INCIDENT_OPENED, TIMELINE, INCIDENT_CLOSED.
//  2. Every other condition is "reconciled": each evaluation computes which conditions
//     should currently have an OPEN event (keyed by a dedupe key), opens the missing
//     ones and closes the ones that no longer apply. Reconciling is idempotent, so
//     repeated samples, duplicate messages and server restarts cannot create duplicates.
//     The database enforces it too (unique index on dedupe_key for OPEN events).

import {
  EventType as E, Severity, EventStatus, NodeCondition as C, NodeValidity as V, InvalidReason,
  LocalizationStatus as L, FeederState as F, TimestampQuality as Q,
} from '../../shared/enums.js';

const nodeSnapshot = (n) => ({
  voltage_rms: n.lastValid?.voltage_rms ?? null,
  voltage_rms_min: n.lastValid?.voltage_rms_min ?? null,
  current_rms: n.lastValid?.current_rms ?? null,
  validity: n.validity,
  condition: n.condition,
  received_at: n.lastValidAt,
});

// Which conditions should have an OPEN event right now? Returns Map(dedupe_key -> event fields).
export function desiredConditions({ topology, nodes, controllers, feeder, liveLoc, disagreement, feederId, now }) {
  const d = new Map();
  const interruptionOpen = feeder.incident?.kind === 'INT';
  const pastStartup = feeder.state !== F.INITIALIZING;

  for (const id of topology.orderedNodeIds) {
    const n = nodes.get(id);
    const ctrl = controllers.byId.get(topology.controllerOf(id));
    const ctrlOnline = ctrl?.online ?? false;

    const inUndervoltage = n.condition === C.UNDERVOLTAGE
      || (n.condition === C.RECOVERING && n.recoveringFrom === C.UNDERVOLTAGE)
      || (n.condition === C.LOSS_PENDING && n.pendingFrom === C.UNDERVOLTAGE);
    if (!interruptionOpen && inUndervoltage) {
      d.set(`UV:${id}`, {
        event_type: E.UNDERVOLTAGE,
        severity: Severity.WARNING,
        node_ids: [id],
        start_ts: n.confirmedAt ?? now,
        first_observed_ts: n.firstObservedAt,
        measurement_snapshot: { [id]: nodeSnapshot(n) },
        detection_reason: ['NODE_UNDERVOLTAGE'],
        details: { lowest_pu_at_detection: n.lastPu },
      });
    }
    if (n.validity === V.INVALID && n.invalidReason !== InvalidReason.LINK_LOST) {
      d.set(`SENSOR:${id}`, {
        event_type: E.SENSOR_FAULT,
        severity: Severity.WARNING,
        node_ids: [id],
        start_ts: n.validitySince ?? now,
        measurement_snapshot: { [id]: nodeSnapshot(n) },
        detection_reason: ['SENSOR_INVALID'],
        details: {
          invalid_reason: n.invalidReason,
          sensor_status: n.lastMeasurement?.sensor_status ?? null,
          reported_value_not_used: n.lastMeasurement?.voltage_rms ?? null,
        },
      });
    }
    // A node is only "offline" on its own if its controller is still talking to us.
    const offline = n.validity === V.OFFLINE || (n.validity === V.NEVER_SEEN && pastStartup);
    if (offline && ctrlOnline) {
      d.set(`OFFLINE:${id}`, {
        event_type: E.NODE_OFFLINE,
        severity: Severity.WARNING,
        node_ids: [id],
        start_ts: n.validitySince ?? now,
        measurement_snapshot: { [id]: nodeSnapshot(n) },
        detection_reason: [n.validity === V.NEVER_SEEN ? 'NODE_NEVER_REPORTED' : 'NODE_OFFLINE'],
        details: { last_valid_at: n.lastValidAt },
      });
    }
  }

  for (const c of controllers.list) {
    if (!c.online && (c.lastSeenAt !== null || pastStartup)) {
      d.set(`COMM:${c.controller_id}`, {
        event_type: E.CONTROLLER_COMM_LOST,
        severity: Severity.WARNING,
        node_ids: [...(topology.controllersById.get(c.controller_id)?.nodes ?? [])],
        start_ts: c.offlineSince ?? now,
        detection_reason: ['CONTROLLER_OFFLINE'],
        details: { controller_id: c.controller_id, last_message_at: c.lastSeenAt },
      });
    }
  }

  if (liveLoc.status === L.INCONSISTENT) {
    d.set(`INCONS:${feederId}`, {
      event_type: E.MEASUREMENT_INCONSISTENT,
      severity: Severity.WARNING,
      node_ids: [...liveLoc.suspect_nodes, ...liveLoc.inconsistent_nodes],
      start_ts: now,
      measurement_snapshot: Object.fromEntries(topology.orderedNodeIds.map((id) => [id, nodeSnapshot(nodes.get(id))])),
      detection_reason: ['PATTERN_INCONSISTENT'],
      details: { suspect_nodes: liveLoc.suspect_nodes, nodes_with_supply_downstream: liveLoc.inconsistent_nodes },
    });
  }

  const iso = feeder.isolation;
  if (iso.feedbackState === 'TIMEOUT') {
    d.set(`ISOUNC:${iso.switchId}`, {
      event_type: E.ISOLATION_UNCONFIRMED,
      severity: Severity.CRITICAL,
      node_ids: [],
      start_ts: now,
      affected_section: feeder.incident?.localization?.affected_section ?? null,
      detection_reason: ['ISOLATION_FEEDBACK_TIMEOUT'],
      details: { switch_id: iso.switchId, feedback: iso.rawFeedback, commanded_at: iso.commandedAt },
    });
  }
  if (iso.feedbackState === 'CONTRADICTORY') {
    d.set(`CONTRA:${iso.switchId}`, {
      event_type: E.ISOLATION_FEEDBACK_CONTRADICTORY,
      severity: Severity.CRITICAL,
      node_ids: [],
      start_ts: now,
      detection_reason: [iso.commanded ? 'FEEDBACK_CONTRADICTORY' : 'FEEDBACK_UNCOMMANDED_OPEN'],
      details: { switch_id: iso.switchId, commanded: iso.commanded, feedback: iso.rawFeedback },
    });
  }
  if (disagreement?.active) {
    d.set(`DISAGREE:${feederId}`, {
      event_type: E.PROTECTION_DISAGREEMENT,
      severity: Severity.WARNING,
      node_ids: disagreement.nodes,
      start_ts: disagreement.since ?? now,
      detection_reason: ['PROTECTION_DISAGREEMENT'],
      details: { nodes: disagreement.nodes },
    });
  }
  return d;
}

export class EventManager {
  constructor({ repo, source, feederId, params, onEvent = () => {} }) {
    this.repo = repo;
    this.source = source;
    this.feederId = feederId;
    this.params = params;
    this.onEvent = onEvent;
    this.open = new Map();          // dedupe_key -> event (as stored)
    this.recentTransients = [];     // [{ at, event_id }] for rate limiting
  }

  reset() {
    this.open.clear();
    this.recentTransients = [];
  }

  // After a restart: events that were open stay open until the new run has enough data
  // to decide whether the condition still exists.
  loadOpenEvents() {
    for (const e of this.repo.getOpenEvents(this.source)) {
      e._carriedOver = true;
      e._observed = false;
      if (e.dedupe_key) this.open.set(e.dedupe_key, e);
    }
    return [...this.open.values()];
  }

  #insert(fields, key, now) {
    const e = {
      status: EventStatus.OPEN,
      source: this.source,
      dedupe_key: key,
      node_ids: [],
      measurement_snapshot: {},
      detection_reason: [],
      details: {},
      unstable_recovery_count: 0,
      ...fields,
    };
    e.event_id = this.repo.insertEvent(e, now);
    if (key && e.status === EventStatus.OPEN) this.open.set(key, e);
    this.onEvent('event_opened', e);
    return e;
  }

  #update(e, patch, now) {
    const changed = {};
    for (const [k, v] of Object.entries(patch)) {
      if (JSON.stringify(e[k]) !== JSON.stringify(v)) changed[k] = v;
    }
    if (!Object.keys(changed).length) return false;
    Object.assign(e, changed);
    this.repo.updateEvent(e.event_id, changed, now);
    return true;
  }

  #close(e, { end_ts, end_ts_quality, end_reason, extra = {} }, now) {
    this.#update(e, {
      ...extra,
      status: EventStatus.CLOSED,
      end_ts,
      end_ts_quality,
      end_reason,
      duration_ms: end_ts !== null && e.start_ts !== null ? Math.max(0, end_ts - e.start_ts) : null,
    }, now);
    if (e.dedupe_key) this.open.delete(e.dedupe_key);
    this.onEvent('event_closed', e);
  }

  // Demo mode only: close every open event because the operator reset the simulated
  // feeder with a test button. The end reason says so; the history is kept.
  closeAllOpen(now, reason) {
    for (const e of [...this.open.values()]) {
      this.repo.insertTimeline(e.event_id, now, 'CLOSED', { end_reason: reason });
      this.#close(e, { end_ts: now, end_ts_quality: Q.EXACT, end_reason: reason }, now);
    }
  }

  // Atomic events are opened and closed in one step (CONTROLLER_REBOOT, SERVER_RESTART).
  recordAtomic(fields, now) {
    return this.#insert({
      start_ts: now, end_ts: now, end_ts_quality: Q.EXACT, duration_ms: 0, status: EventStatus.CLOSED, ...fields,
    }, null, now);
  }

  // ---- interruption incident -----------------------------------------------------------
  #incidentKey() { return `INT:${this.feederId}`; }

  #incidentFields(inc) {
    const loc = inc.localization;
    return {
      node_ids: inc.affectedNodes,
      affected_section: loc?.affected_section ?? null,
      localization_status: loc?.status ?? null,
      isolation_requested: inc.isolationRequested,
      isolation_requested_ts: inc.isolationRequestedAt,
      isolation_confirmed: inc.isolationConfirmed,
      isolation_confirmed_ts: inc.isolationConfirmedAt,
      recovery_status: inc.recoveryState,
      unstable_recovery_count: inc.unstableCount,
      details: {
        candidate_sections: loc?.candidate_sections ?? [],
        localization_frozen: !!inc.frozen,
        trip_reason: inc.tripReason ?? null,
        escalated_from_nodes: inc.escalatedFrom ?? [],
      },
    };
  }

  applyFeederActions(actions, now) {
    for (const a of actions) {
      if (a.kind === 'TRANSITION') {
        this.repo.insertTransition(a.at, a.from, a.to, a.reasons, this.source);
      } else if (a.kind === 'INCIDENT_OPENED' && a.incident.kind === 'INT') {
        const inc = a.incident;
        const existing = this.open.get(this.#incidentKey());
        if (existing) {
          inc.eventId = existing.event_id;   // continue the carried-over event
        } else {
          const e = this.#insert({
            event_type: inc.eventType,
            severity: Severity.CRITICAL,
            start_ts: inc.startedAt,
            first_observed_ts: inc.firstObservedAt,
            measurement_snapshot: inc.snapshot,
            detection_reason: inc.reasons,
            ...this.#incidentFields(inc),
          }, this.#incidentKey(), now);
          inc.eventId = e.event_id;
        }
      } else if (a.kind === 'TIMELINE' && a.incident.kind === 'INT' && a.incident.eventId) {
        this.repo.insertTimeline(a.incident.eventId, a.at, a.entry_kind, a.details);
        const e = this.open.get(this.#incidentKey());
        if (e) this.onEvent('event_updated', e);
      } else if (a.kind === 'INCIDENT_CLOSED' && a.incident.kind === 'INT') {
        const inc = a.incident;
        const e = this.open.get(this.#incidentKey());
        if (!e) continue;
        this.#update(e, this.#incidentFields(inc), now);
        this.repo.insertTimeline(e.event_id, now, 'CLOSED', { end_ts: inc.endAt, end_ts_quality: inc.endQuality });
        this.#close(e, { end_ts: inc.endAt, end_ts_quality: inc.endQuality, end_reason: inc.endReason ?? 'RECOVERY_STABLE' }, now);
      }
    }
  }

  syncIncident(inc, now) {
    if (!inc || inc.kind !== 'INT') return;
    const e = this.open.get(this.#incidentKey());
    if (!e) return;
    inc.eventId = e.event_id;
    e._observed = true;
    if (this.#update(e, this.#incidentFields(inc), now)) this.onEvent('event_updated', e);
  }

  // ---- brief dips -----------------------------------------------------------------------
  recordTransients(transients, now, reportIntervalMs) {
    if (!transients.length) return;
    this.recentTransients = this.recentTransients.filter((t) => now - t.at < 60_000);
    if (this.recentTransients.length >= this.params.transient_max_events_per_min) {
      const last = this.recentTransients[this.recentTransients.length - 1];
      const e = this.repo.getEvent(last.event_id);
      if (e) {
        const details = { ...e.details, suppressed_count: (e.details.suppressed_count ?? 0) + 1 };
        this.repo.updateEvent(e.event_id, { details }, now);
      }
      return;
    }
    const nodeIds = [...new Set(transients.map((t) => t.node_id))];
    const firstObserved = Math.min(...transients.map((t) => t.first_observed));
    const lowest = Math.min(...transients.map((t) => t.lowest_pu));
    const onlyInWindow = transients.every((t) => t.kind === 'IN_WINDOW');
    const e = this.#insert({
      event_type: E.TRANSIENT_DIP,
      severity: Severity.INFO,
      status: EventStatus.CLOSED,
      start_ts: firstObserved,
      first_observed_ts: firstObserved,
      end_ts: now,
      end_ts_quality: Q.APPROXIMATE,
      end_reason: 'SUPPLY_RECOVERED',
      // Duration is only known to the report resolution; for in-window dips it is unknown.
      duration_ms: onlyInWindow ? null : now - firstObserved,
      node_ids: nodeIds,
      detection_reason: [onlyInWindow ? 'DIP_BELOW_REPORT_RESOLUTION_POSSIBLE' : 'TRANSIENT_DIP_DETECTED'],
      details: {
        kinds: Object.fromEntries(transients.map((t) => [t.node_id, t.kind])),
        lowest_pu: lowest,
        resolution_ms: reportIntervalMs,
        note: onlyInWindow
          ? 'Dip seen only in the per-cycle minimum within one report window; exact duration unknown (shorter than the report interval).'
          : 'Duration is an upper bound limited by the report interval.',
      },
    }, null, now);
    this.recentTransients.push({ at: now, event_id: e.event_id });
  }

  // ---- reconciliation ------------------------------------------------------------------
  // settled:    the run has enough data to judge conditions carried over from before a restart.
  // monitoring: valid data is currently arriving. While it is not (feeder UNKNOWN), no
  //             event is closed — missing data is not evidence that a condition cleared.
  reconcile(desired, now, { settled, monitoring = true, nodes, incident }) {
    for (const [key, fields] of desired) {
      const existing = this.open.get(key);
      if (existing) { existing._observed = true; continue; }
      this.#insert(fields, key, now);
    }
    if (!monitoring) return;
    for (const [key, e] of [...this.open]) {
      if (key.startsWith('INT:')) {
        // Carried-over interruption that the feeder did not adopt (should not happen): close it.
        if (!incident || incident.kind !== 'INT') {
          if (e._carriedOver && !settled) continue;
          this.#close(e, { end_ts: now, end_ts_quality: Q.APPROXIMATE, end_reason: 'NOT_OBSERVED_AFTER_RESTART' }, now);
        }
        continue;
      }
      if (desired.has(key)) continue;
      if (e._carriedOver && !settled) continue;
      const quality = e._carriedOver && !e._observed ? Q.APPROXIMATE : Q.EXACT;
      let endTs = now;
      let reason = 'CONDITION_CLEARED';
      if (e.event_type === E.UNDERVOLTAGE) {
        const n = nodes.get(e.node_ids[0]);
        if (incident?.kind === 'INT') {
          reason = 'ESCALATED';
          const intEvent = this.open.get(this.#incidentKey());
          if (intEvent && intEvent.related_event_id == null) this.#update(intEvent, { related_event_id: e.event_id }, now);
        } else if (n && n.condition === C.NORMAL && n.stableSince !== null && n.stableSince >= (e.start_ts ?? 0)) {
          endTs = n.stableSince;
          reason = 'RECOVERY_STABLE';
        }
      }
      this.#close(e, { end_ts: endTs, end_ts_quality: quality, end_reason: reason }, now);
    }
  }
}
