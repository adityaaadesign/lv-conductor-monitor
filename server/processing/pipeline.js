// The processing pipeline (docs/ARCHITECTURE.md §3):
//   validate → node monitor → localization → feeder state → event manager → repository
//
// It is evaluated on every accepted report (ingestReport) and on a periodic tick (tick)
// so that timers expire even when no messages arrive. The pipeline never reads the
// clock itself: callers pass the time in. In demo mode the caller is the simulator.

import { validateReport, SessionTracker } from '../ingest/validator.js';
import { createNodeState, applyMeasurement, applyTime } from './node-monitor.js';
import { localize, supplyFromNode } from './localization.js';
import { createFeederState, evaluateFeeder } from './feeder-state.js';
import { EventManager, desiredConditions } from './event-manager.js';
import { buildStatus } from './status-builder.js';
import {
  EventType, Severity, FeederState as F, NodeValidity as V, NodeCondition as C, SupplyStatus as S,
  LocalizationStatus as L, EventStatus,
} from '../../shared/enums.js';
import { toIso } from '../domain/clock.js';

export class Pipeline {
  constructor({ config, repo, source, onStatus = () => {}, onEvent = () => {}, logger = console }) {
    this.config = config;
    this.repo = repo;
    this.source = source;
    this.onStatus = onStatus;
    this.onEvent = onEvent;
    this.logger = logger;
    this.params = config.detection;
    this.topology = config.topology;
  }

  // ---- lifecycle -----------------------------------------------------------------------
  start(now) {
    this.#initMemory(now);
    this.#safe('startup', () => {
      const previousRun = this.repo.getMeta('last_run_started');
      this.previousRun = previousRun
        ? { started_at: toIso(Number(previousRun)), last_state: this.repo.lastTransition(this.source) }
        : null;
      const carried = this.events.loadOpenEvents();
      this.#adoptIncident(carried);
      this.#seedFromHistory();
      if (previousRun) {
        this.events.recordAtomic({
          event_type: EventType.SERVER_RESTART,
          severity: Severity.INFO,
          detection_reason: ['SERVER_RESTART'],
          details: {
            previous_run_started: toIso(Number(previousRun)),
            open_events_carried_over: carried.map((e) => e.event_id),
            note: 'Conditions while the server was stopped were not observed.',
          },
        }, now);
      }
      this.repo.setMeta('last_run_started', now);
      this.repo.audit(now, 'system', 'SERVER_START', null, { source: this.source }, 'OK');
    });
    this.#publish(now);
  }

  // Simulation "clear history": forget everything in memory (the DB is cleared by the caller).
  reset(now) {
    this.#initMemory(now);
    this.previousRun = null;
    this.#safe('reset', () => this.repo.setMeta('last_run_started', now));
    this.#publish(now);
  }

  // Demo mode only: a test button returns the simulated feeder to a clean starting
  // point. Open events are closed with reason DEMO_RESET (kept in history), and the
  // in-memory state starts again from INITIALIZING.
  demoReset(now) {
    this.#safe('demo reset', () => {
      this.events.closeAllOpen(now, 'DEMO_RESET');
      this.repo.audit(now, 'dashboard', 'DEMO_RESET', null, null, 'OK');
    });
    this.#initMemory(now);
    this.#publish(now);
  }

  #initMemory(now) {
    this.startedAt = now;
    this.nodes = new Map(this.topology.orderedNodeIds.map((id) => [id, createNodeState(id)]));
    this.controllers = new Map([...this.topology.controllersById.keys()].map((id) => [id, {
      controller_id: id, lastSeenAt: null, online: false, offlineSince: now, bootId: null,
      firmwareVersion: null, reportIntervalMs: null, protection: null, protectionJson: null,
    }]));
    this.sessions = new SessionTracker();
    this.feeder = createFeederState(now);
    this.events = new EventManager({
      repo: this.repo, source: this.source, feederId: this.config.feeder.feeder_id, params: this.params,
      onEvent: (kind, e) => this.onEvent(kind, e),
    });
    this.disagreement = { since: new Map(), active: false, nodes: [], since_ts: null };
    this.liveLoc = localize(this.topology, {});
    this.storage = { ok: true, last_error: null, last_error_at: null, failures: 0 };
    this.counters = { accepted: 0, duplicates: 0, late: 0, rejected: 0, rejected_nodes: 0 };
    this.lastEvalAt = now;
  }

  // Re-create the interruption incident from an event left open by the previous run.
  #adoptIncident(carried) {
    const e = carried.find((x) => x.dedupe_key === `INT:${this.config.feeder.feeder_id}`);
    if (!e) return;
    const loc = {
      status: e.localization_status ?? L.INSUFFICIENT_DATA,
      affected_section: e.affected_section,
      candidate_sections: e.details?.candidate_sections ?? [],
      present: [], absent: e.node_ids, unknown: [], inconsistent_nodes: [], suspect_nodes: [], sections: [],
    };
    this.feeder.incident = {
      kind: 'INT',
      eventType: e.event_type,
      startedAt: e.start_ts,
      firstObservedAt: e.first_observed_ts,
      affectedNodes: e.node_ids,
      localization: loc,
      frozen: e.details?.localization_frozen ? loc : null,
      snapshot: e.measurement_snapshot,
      reasons: e.detection_reason,
      isolationRequested: e.isolation_requested,
      isolationRequestedAt: e.isolation_requested_ts,
      isolationConfirmed: e.isolation_confirmed,
      isolationConfirmedAt: e.isolation_confirmed_ts,
      lastCommandAt: null,
      commandFlags: {},
      tripReason: e.details?.trip_reason ?? null,
      recoveryState: e.recovery_status,
      unstableCount: e.unstable_recovery_count,
      recloseAt: null,
      supplySeenSinceReclose: false,
      restoredAt: null,
      endAt: null,
      endQuality: null,
      escalatedFrom: e.details?.escalated_from_nodes ?? [],
      eventId: e.event_id,
      adopted: true,
      observedSinceAdopt: false,
    };
  }

  #seedFromHistory() {
    for (const row of this.repo.lastValidPerNode(this.source)) {
      const n = this.nodes.get(row.node_id);
      if (!n) continue;
      n.lastValid = {
        node_id: row.node_id, voltage_rms: row.voltage_rms, voltage_rms_min: row.voltage_rms_min,
        voltage_rms_max: row.voltage_rms_max, current_rms: row.current_rms, validity: V.VALID,
      };
      n.lastValidAt = row.received_at;
      n.lastValidFromHistory = true;   // shown as "last stored value", never as live data
    }
    for (const s of this.repo.latestSessions()) {
      if (this.controllers.has(s.controller_id)) this.sessions.seed(s.controller_id, s.boot_id, s.last_sequence);
    }
  }

  // Storage errors must never stop monitoring; they are reported on the dashboard.
  #safe(what, fn) {
    try {
      return fn();
    } catch (err) {
      this.storage = { ok: false, last_error: `${what}: ${err.message}`, last_error_at: toIso(this.lastEvalAt), failures: this.storage.failures + 1 };
      this.logger.error(`[storage] ${what} failed: ${err.message}`);
      return undefined;
    }
  }

  // ---- inputs -------------------------------------------------------------------------
  ingestReport(raw, receivedAt) {
    const v = validateReport(raw, this.config, receivedAt);
    if (!v.ok) {
      this.counters.rejected++;
      const excerpt = (() => { try { return JSON.stringify(raw).slice(0, 500); } catch { return null; } })();
      this.#safe('rejection', () => this.repo.insertRejection(receivedAt, typeof raw?.controller_id === 'string' ? raw.controller_id.slice(0, 32) : null, v.error, v.details, excerpt));
      return { accepted: false, error: v.error, details: v.details };
    }
    const r = v.report;
    const sc = this.sessions.classify(r.controller_id, r.boot_id, r.sequence_number, receivedAt, r.uptime_ms);
    const st = this.sessions.stats(r.controller_id);
    const sessionRow = {
      controller_id: r.controller_id, boot_id: r.boot_id, first_seen: receivedAt, last_seen: receivedAt,
      last_sequence: st.last_sequence, gap_count: st.gaps, duplicate_count: st.duplicates, late_count: st.late,
      firmware_version: r.firmware_version,
    };
    if (sc.kind === 'DUPLICATE') {
      this.counters.duplicates++;
      this.#safe('session', () => this.repo.upsertSession(sessionRow));
      return { accepted: true, duplicate: true, late: false };
    }

    this.#safe('measurements', () => {
      this.repo.insertMeasurements({ receivedAt, measuredAt: sc.measuredAt, report: r, nodes: v.nodes, late: sc.kind === 'LATE', source: this.source });
      this.repo.upsertSession(sessionRow);
      if (v.rejectedNodes.length) this.repo.insertRejection(receivedAt, r.controller_id, 'UNKNOWN_NODES', v.rejectedNodes, null);
    });
    this.counters.rejected_nodes += v.rejectedNodes.length;

    if (sc.reboot) {
      this.#safe('reboot event', () => this.events.recordAtomic({
        event_type: EventType.CONTROLLER_REBOOT,
        severity: Severity.INFO,
        detection_reason: ['CONTROLLER_REBOOT'],
        details: { controller_id: r.controller_id, previous_boot_id: sc.previousBootId, new_boot_id: r.boot_id },
      }, receivedAt));
    }
    if (sc.kind === 'LATE') {
      // Stored as history only. Late data never drives the current state.
      this.counters.late++;
      return { accepted: true, duplicate: false, late: true };
    }
    this.counters.accepted++;

    const c = this.controllers.get(r.controller_id);
    c.lastSeenAt = receivedAt;
    c.bootId = r.boot_id;
    c.firmwareVersion = r.firmware_version;
    c.reportIntervalMs = r.report_interval_ms;
    const pj = JSON.stringify(r.protection);
    if (pj !== c.protectionJson) {
      this.#safe('protection snapshot', () => this.repo.insertProtectionSnapshot(receivedAt, r.controller_id, r.protection));
      c.protectionJson = pj;
    }
    c.protection = r.protection;

    const outputs = [];
    for (const m of v.nodes) {
      outputs.push(...applyMeasurement(this.nodes.get(m.node_id), m, receivedAt, this.params, this.config.feeder.nominal_voltage_v));
    }
    this.#evaluate(receivedAt, outputs);
    return { accepted: true, duplicate: false, late: false, rejected_nodes: v.rejectedNodes };
  }

  tick(now) {
    if (now < this.lastEvalAt) return;   // never evaluate backwards in time
    this.#updateControllers(now);
    const outputs = [];
    for (const [id, n] of this.nodes) {
      const online = this.controllers.get(this.topology.controllerOf(id)).online;
      outputs.push(...applyTime(n, now, this.params, { controllerOnline: online }));
    }
    this.#evaluate(now, outputs);
  }

  // ---- evaluation ---------------------------------------------------------------------
  #updateControllers(now) {
    for (const c of this.controllers.values()) {
      const online = c.lastSeenAt !== null && now - c.lastSeenAt <= this.params.controller_offline_after_ms;
      if (c.online && !online) c.offlineSince = now;
      c.online = online;
    }
  }

  #controllerSummary() {
    const list = [...this.controllers.values()];
    return { list, byId: this.controllers, anyOnline: list.some((c) => c.online) };
  }

  // Compare the controller's own supply judgement with ours (STATE_MACHINE §6.5).
  #updateDisagreement(now) {
    const d = this.disagreement;
    const disagreeing = [];
    for (const [id, n] of this.nodes) {
      const reported = n.lastMeasurement?.supply_present_reported;
      if (n.validity !== V.VALID || reported === null || reported === undefined) { d.since.delete(id); continue; }
      let ours = null;
      if ([C.NORMAL, C.UNDERVOLTAGE, C.RECOVERING].includes(n.condition)) ours = true;
      else if (n.condition === C.SUPPLY_LOST) ours = false;
      if (ours === null || ours === reported) { d.since.delete(id); continue; }
      if (!d.since.has(id)) d.since.set(id, now);
      if (now - d.since.get(id) >= this.params.protection_disagreement_ms) disagreeing.push(id);
    }
    d.active = disagreeing.length > 0;
    d.nodes = disagreeing;
    d.since_ts = d.active ? Math.min(...disagreeing.map((id) => d.since.get(id))) : null;
  }

  #evaluate(now, outputs) {
    this.lastEvalAt = now;
    this.#updateControllers(now);
    const supplyLive = {};
    const supplyTrip = {};
    for (const [id, n] of this.nodes) {
      supplyLive[id] = supplyFromNode(n);
      supplyTrip[id] = supplyFromNode(n, { usePendingBand: true });
    }
    const liveLoc = localize(this.topology, supplyLive);
    const tripLoc = localize(this.topology, supplyTrip);
    this.liveLoc = liveLoc;
    this.#updateDisagreement(now);

    const controllers = this.#controllerSummary();
    const protectionCtrl = controllers.list.find((c) => c.online && c.protection);
    const actions = evaluateFeeder(this.feeder, {
      now,
      params: this.params,
      topology: this.topology,
      nodes: this.nodes,
      controllers,
      protection: protectionCtrl?.protection ?? null,
      nodeOutputs: outputs,
      liveLoc,
      tripLoc,
    });

    this.#safe('events', () => {
      this.events.applyFeederActions(actions, now);
      if (this.feeder.incident) this.events.syncIncident(this.feeder.incident, now);
      const transients = outputs.filter((o) => o.type === 'TRANSIENT');
      const interval = controllers.list.find((c) => c.reportIntervalMs)?.reportIntervalMs ?? this.params.expected_report_interval_ms;
      if (transients.length && !this.feeder.incident) this.events.recordTransients(transients, now, interval);
      const desired = desiredConditions({
        topology: this.topology, nodes: this.nodes, controllers, feeder: this.feeder, liveLoc,
        disagreement: { ...this.disagreement, since: this.disagreement.since_ts },
        feederId: this.config.feeder.feeder_id, now,
      });
      this.events.reconcile(desired, now, {
        settled: this.feeder.state !== F.INITIALIZING && this.feeder.state !== F.UNKNOWN,
        monitoring: this.feeder.state !== F.UNKNOWN,
        nodes: this.nodes,
        incident: this.feeder.incident,
      });
    });
    this.#publish(now, actions);
  }

  #publish(now, actions = []) {
    this.onStatus(this.getStatus(now), actions);
  }

  // ---- outputs ------------------------------------------------------------------------
  getStatus(now = this.lastEvalAt) {
    const open = [...this.events.open.values()].filter((e) => e.status === EventStatus.OPEN);
    return buildStatus(this.feeder, {
      topology: this.topology,
      nodes: this.nodes,
      detection: this.params,
      feeder: this.config.feeder,
      nominalV: this.config.feeder.nominal_voltage_v,
      source: this.source,
      now,
      liveLoc: this.liveLoc,
      controllers: this.#controllerSummary(),
      sessions: this.sessions,
      storage: this.storage,
      disagreement: this.disagreement,
      openEventIds: open.map((e) => e.event_id),
      openEvents: open.map((e) => ({
        event_id: e.event_id, event_type: e.event_type, severity: e.severity, start_ts: toIso(e.start_ts),
        node_ids: e.node_ids, affected_section: e.affected_section, carried_over: !!e._carriedOver,
      })),
      previousRun: this.previousRun,
    });
  }

  diagnostics() {
    return {
      counters: this.counters,
      storage: this.storage,
      started_at: toIso(this.startedAt),
      last_evaluation_at: toIso(this.lastEvalAt),
      nodes: [...this.nodes.values()].map((n) => ({
        node_id: n.node_id,
        validity: n.validity,
        invalid_reason: n.invalidReason,
        validity_since: toIso(n.validitySince),
        condition: n.condition,
        band: n.band,
        last_message_at: toIso(n.lastMessageAt),
        last_valid_at: toIso(n.lastValidAt),
        sensor_status: n.lastMeasurement?.sensor_status ?? null,
        link_status: n.lastMeasurement?.link_status ?? null,
        flags: n.lastMeasurement?.flags ?? [],
        valid_count: n.validCount,
        invalid_count: n.invalidCount,
        unstable_count: n.unstableCount,
        supply_live: supplyFromNode(n),
      })),
      supply_status_legend: S,
    };
  }
}
