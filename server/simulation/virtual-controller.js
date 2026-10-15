// SIMULATED controller firmware. Demo mode only — never talks to real hardware.
//
// It plays the role the ESP32 will play: samples each node once per mains cycle,
// computes RMS statistics per report window, runs a LOCAL protection rule, drives a
// (simulated) relay with an optional feedback contact, and produces reports in exactly
// the JSON format of docs/DATA_CONTRACT.md §3. The server cannot tell the difference
// except that the dashboard knows it is running in SIMULATION mode.
//
// It is also a reference for the firmware teammate: protection decisions happen here,
// without any help from the server.

import { makeRng } from './feeder-physics.js';
import { SOURCE } from '../../shared/enums.js';

export const VC_DEFAULTS = {
  cycle_ms: 20,                 // one 50 Hz cycle
  report_interval_ms: 1000,
  trip_delay_ms: 1000,          // SIMULATED firmware setting (placeholder)
  relay_operate_ms: 60,         // SIMULATED relay operate time
  restore_delay_ms: 2000,       // delay between local reset and reclose
  noise_pu: 0.003,
  noise_floor_pu: 0.002,        // reading with no voltage present
  feedback: 'FITTED',           // FITTED | NOT_FITTED | DISCONNECTED
  relay_fault: null,            // null | FAILS_TO_OPEN
  protection_enabled: true,
  firmware_version: '0.3.1-sim',
};

const round1 = (v) => Math.round(v * 10) / 10;

export class VirtualController {
  constructor({ controllerId, topology, detection, nominalV, fullScaleV, physics, settings = {}, seed = 1, startTime }) {
    this.id = controllerId;
    this.topology = topology;
    this.p = detection;
    this.nominalV = nominalV;
    this.fullScaleV = fullScaleV;
    this.physics = physics;
    this.s = { ...VC_DEFAULTS, ...settings };
    this.rng = makeRng(seed);
    // A new boot ID for every power-up, as the data contract requires. It mixes in the
    // start time: reusing a boot ID makes the server treat new reports as old (late)
    // ones. Tests stay repeatable because they always use the same start time.
    this.bootId = ((Math.floor(this.rng() * 0xffffffff) ^ (startTime % 0xffffffff)) >>> 0).toString(16).padStart(8, '0');
    this.bootTime = startTime;
    this.seq = 0;
    this.nodeIds = [...(topology.controllersById.get(controllerId)?.nodes ?? [])];
    this.nextReportAt = startTime + this.s.report_interval_ms;
    // Set when the protection state changes: the firmware sends a report immediately so
    // the server sees the measurements taken before the switch moved (assumption A15).
    this.immediateReport = false;

    this.window = new Map();
    this.localPresent = new Map(this.nodeIds.map((id) => [id, true]));
    this.sensorFault = new Map();   // node -> 'SATURATED' | 'READS_ZERO'
    this.linkLost = new Set();      // nodes missing from reports
    this.link = { up: true, buffer: false, backlog: [], replayDuplicates: 0 };

    this.switchId = [...topology.switches.keys()][0] ?? null;
    this.prot = {
      lockout: false, tripReason: null, restoreRequested: false, restoreSource: null,
      restorationPermitted: null, commanded: false, commandedChangeUptime: null, lossSince: null, restoreAt: null,
    };
    this.relay = { closed: true, changeAt: null, target: null };
    this.#resetWindow();
  }

  #resetWindow() {
    for (const id of this.nodeIds) this.window.set(id, { sum: 0, count: 0, min: Infinity, max: -Infinity });
  }

  #read(nodeId) {
    const fault = this.sensorFault.get(nodeId);
    if (fault === 'SATURATED') return this.fullScaleV * 1.37;
    const v = fault === 'READS_ZERO' ? 0 : this.physics.voltageAt(nodeId);
    if (v === 0) return this.rng() * this.s.noise_floor_pu * this.nominalV;
    return Math.max(0, v + (this.rng() - 0.5) * 2 * this.s.noise_pu * this.nominalV);
  }

  // One mains cycle: relay mechanics, sampling, local protection.
  cycle(t) {
    if (this.relay.changeAt !== null && t >= this.relay.changeAt) {
      const wantClosed = this.relay.target;
      const stuck = !wantClosed && this.s.relay_fault === 'FAILS_TO_OPEN';
      if (!stuck) this.relay.closed = wantClosed;
      this.relay.changeAt = null;
      if (this.switchId) this.physics.setSwitch(this.switchId, this.relay.closed);
    }
    for (const id of this.nodeIds) {
      const reading = this.#read(id);
      const w = this.window.get(id);
      w.sum += reading; w.count += 1;
      w.min = Math.min(w.min, reading); w.max = Math.max(w.max, reading);
      const pu = reading / this.nominalV;
      const was = this.localPresent.get(id);
      this.localPresent.set(id, was ? pu >= this.p.loss_pickup_pu : pu >= this.p.loss_dropout_pu);
    }
    this.#protection(t);
  }

  #sensorOk(id) { return !this.sensorFault.has(id) || this.sensorFault.get(id) === 'READS_ZERO'; }

  // LOCAL protection rule (assumption A14): trip when a node has no supply while its
  // upstream node has supply and no node below it has supply. A source-wide loss is not
  // a break pattern and does not trip. Invalid sensors are ignored.
  #breakCandidate() {
    for (const id of this.nodeIds) {
      if (!this.#sensorOk(id) || this.localPresent.get(id)) continue;
      const up = this.topology.parentOf(id);
      if (up === SOURCE || !this.nodeIds.includes(up) || !this.#sensorOk(up) || !this.localPresent.get(up)) continue;
      const below = this.topology.descendants(id).filter((d) => this.nodeIds.includes(d) && this.#sensorOk(d));
      if (below.every((d) => !this.localPresent.get(d))) return { node: id, upstream: up };
    }
    return null;
  }

  #protection(t) {
    const p = this.prot;
    if (p.restoreRequested && t >= p.restoreAt) {
      // Simulated interlock check passed: release isolation and reclose.
      p.restoreRequested = false;
      p.lockout = false;
      p.tripReason = null;
      p.commanded = false;
      p.commandedChangeUptime = t - this.bootTime;
      p.lossSince = null;
      this.relay.target = true;
      this.relay.changeAt = t + this.s.relay_operate_ms;
      this.immediateReport = true;
    }
    if (!this.s.protection_enabled || p.lockout) return;
    const cand = this.#breakCandidate();
    if (!cand) { p.lossSince = null; return; }
    if (p.lossSince === null) p.lossSince = t;
    if (t - p.lossSince >= this.s.trip_delay_ms) {
      p.commanded = true;
      p.lockout = true;
      p.tripReason = `LOSS_OF_SUPPLY_BELOW_${cand.upstream}`;
      p.commandedChangeUptime = t - this.bootTime;
      p.restorationPermitted = false;
      this.relay.target = false;
      this.relay.changeAt = t + this.s.relay_operate_ms;
      this.immediateReport = true;
    }
  }

  pressLocalReset(t) {
    if (!this.prot.lockout) return false;
    this.prot.restoreRequested = true;
    this.prot.restoreSource = 'LOCAL_BUTTON';
    this.prot.restorationPermitted = true;
    this.prot.restoreAt = t + this.s.restore_delay_ms;
    this.immediateReport = true;
    return true;
  }

  #feedback() {
    if (this.s.feedback === 'NOT_FITTED') return 'NOT_FITTED';
    if (this.s.feedback === 'DISCONNECTED') return 'UNKNOWN';
    return this.relay.closed ? 'CLOSED' : 'OPEN';
  }

  #buildReport(t) {
    const nodes = [];
    for (const id of this.nodeIds) {
      const w = this.window.get(id);
      if (this.linkLost.has(id) || w.count === 0) continue;
      const fault = this.sensorFault.get(id);
      const saturated = fault === 'SATURATED';
      nodes.push({
        node_id: id,
        voltage_rms: round1(w.sum / w.count),
        voltage_rms_min: saturated ? null : round1(w.min),
        voltage_rms_max: saturated ? null : round1(w.max),
        rms_window_ms: this.s.cycle_ms,
        current_rms: null,
        supply_present: saturated ? null : this.localPresent.get(id),
        data_valid: !saturated,
        sensor_status: saturated ? 'SATURATED' : 'OK',
      });
    }
    this.#resetWindow();
    const p = this.prot;
    return {
      schema_version: '1.0',
      controller_id: this.id,
      boot_id: this.bootId,
      sequence_number: this.seq++,
      uptime_ms: t - this.bootTime,
      device_time: null,
      time_synced: false,
      firmware_version: this.s.firmware_version,
      report_interval_ms: this.s.report_interval_ms,
      nodes,
      protection: {
        protection_enabled: this.s.protection_enabled,
        lockout: p.lockout,
        trip_reason: p.tripReason,
        restore_requested: p.restoreRequested,
        restore_source: p.restoreSource,
        restoration_permitted: p.restorationPermitted,
        switches: this.switchId ? [{
          switch_id: this.switchId,
          isolation_commanded: p.commanded,
          commanded_change_uptime_ms: p.commandedChangeUptime,
          feedback: this.#feedback(),
        }] : [],
      },
    };
  }

  isScheduledReportDue(t) { return t >= this.nextReportAt; }

  // Build the report for the window that just ended. Returns the list of reports to
  // deliver now (none while the link is down, several when a buffered link comes back).
  // scheduled=false is the immediate report sent on a protection state change.
  produceReports(t, scheduled = true) {
    if (scheduled) this.nextReportAt += this.s.report_interval_ms;
    this.immediateReport = false;
    const report = this.#buildReport(t);
    if (!this.link.up) {
      if (this.link.buffer) this.link.backlog.push(report);
      return [];
    }
    if (!this.link.backlog.length) return [report];
    // Reconnect: newest report first so the live state is current, then the backlog
    // (which the server stores as late history), then any configured duplicate resends.
    const backlog = this.link.backlog;
    this.link.backlog = [];
    const out = [report, ...backlog];
    const dup = this.link.replayDuplicates;
    if (dup > 0) out.push(report, ...backlog.slice(Math.max(0, backlog.length - (dup - 1))));
    return out;
  }
}
