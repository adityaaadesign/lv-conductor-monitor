// Runs SIMULATED scenarios through the real processing pipeline.
//
// Time advances in 20 ms steps (one mains cycle). At each step the scenario's scheduled
// actions are applied to the simulated feeder, the virtual controller samples it, and
// whenever a report is due it is passed to pipeline.ingestReport() — the same function
// the HTTP endpoint will use for real hardware. The pipeline's periodic tick is driven
// from the same loop, so a scenario produces identical results in real time (demo) and
// instantly (tests).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FeederPhysics } from './feeder-physics.js';
import { VirtualController } from './virtual-controller.js';

export const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scenarios');

const ACTIONS = new Set([
  'set_source', 'break_section', 'repair_section', 'set_node_drop', 'sensor_fault', 'clear_sensor_fault',
  'node_link', 'controller_link', 'local_reset', 'note',
]);

export function loadScenarios(dir = SCENARIO_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const s = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      for (const step of s.steps ?? []) {
        if (!ACTIONS.has(step.action)) throw new Error(`${f}: unknown action "${step.action}"`);
      }
      s.steps = [...(s.steps ?? [])].sort((a, b) => a.at_ms - b.at_ms);
      return s;
    });
}

export class Simulator {
  constructor({ config, pipeline, startTime }) {
    this.config = config;
    this.pipeline = pipeline;
    this.cycleMs = 20;
    this.cursor = startTime;
    this.nextTick = startTime + config.detection.tick_interval_ms;
    this.scenario = null;
    this.controllers = [];
    this.physics = null;
    this.t0 = null;
    this.stepIndex = 0;
    this.log = [];
  }

  // Begin a scenario at the current simulated time. A new virtual controller is
  // created, which is equivalent to the hardware being powered up (new boot ID).
  start(scenario) {
    const t0 = this.cursor;
    const { topology, feeder, detection } = this.config;
    this.physics = new FeederPhysics(topology, feeder.nominal_voltage_v);
    this.controllers = [...topology.controllersById.keys()].map((id, i) => new VirtualController({
      controllerId: id,
      topology,
      detection,
      nominalV: feeder.nominal_voltage_v,
      fullScaleV: feeder.sensor_full_scale_v,
      physics: this.physics,
      settings: scenario.controller ?? {},
      seed: (scenario.seed ?? 1) * 1000 + i,
      startTime: t0,
    }));
    this.scenario = scenario;
    this.t0 = t0;
    this.stepIndex = 0;
    this.log = [];
  }

  // Stop: the simulated controller is switched off and sends nothing more.
  stop() {
    this.scenario = null;
    this.controllers = [];
    this.physics = null;
  }

  #apply(step, t) {
    const ph = this.physics;
    const ctrl = this.controllers[0];
    switch (step.action) {
      case 'set_source': ph.setSource(step.pu); break;
      case 'break_section': ph.breakSection(step.section); break;
      case 'repair_section': ph.repairSection(step.section); break;
      case 'set_node_drop': ph.setNodeDrop(step.node, step.pu); break;
      case 'sensor_fault': for (const c of this.controllers) if (c.nodeIds.includes(step.node)) c.sensorFault.set(step.node, step.mode); break;
      case 'clear_sensor_fault': for (const c of this.controllers) c.sensorFault.delete(step.node); break;
      case 'node_link':
        for (const c of this.controllers) {
          if (!c.nodeIds.includes(step.node)) continue;
          if (step.lost) c.linkLost.add(step.node); else c.linkLost.delete(step.node);
        }
        break;
      case 'controller_link':
        for (const c of this.controllers) {
          c.link.up = !!step.up;
          if (!step.up) c.link.buffer = !!step.buffer;
          if (step.replay_duplicates !== undefined) c.link.replayDuplicates = step.replay_duplicates;
        }
        break;
      case 'local_reset': ctrl?.pressLocalReset(t); break;
      default: break;
    }
    this.log.push({ at: t, elapsed_ms: t - this.t0, action: step.action, note: step.note ?? null });
  }

  #deliver(reports, at) {
    for (const report of reports) this.pipeline.ingestReport(report, at);
  }

  advanceTo(t) {
    while (this.cursor + this.cycleMs <= t) {
      this.cursor += this.cycleMs;
      const c = this.cursor;
      if (this.scenario) {
        // 1. A scheduled report covers the cycles BEFORE this instant.
        for (const ctrl of this.controllers) {
          if (ctrl.isScheduledReportDue(c)) this.#deliver(ctrl.produceReports(c, true), c);
        }
        // 2. Scenario actions take effect from this cycle onwards.
        const steps = this.scenario.steps;
        while (this.stepIndex < steps.length && this.t0 + steps[this.stepIndex].at_ms <= c) {
          this.#apply(steps[this.stepIndex], c);
          this.stepIndex += 1;
        }
        // 3. The controller samples this cycle and runs its local protection.
        // 4. A protection state change triggers an immediate report.
        for (const ctrl of this.controllers) {
          ctrl.cycle(c);
          if (ctrl.immediateReport) this.#deliver(ctrl.produceReports(c, false), c);
        }
      }
      if (c >= this.nextTick) {
        this.pipeline.tick(c);
        this.nextTick += this.config.detection.tick_interval_ms;
      }
    }
  }

  state() {
    const s = this.scenario;
    return {
      running: !!s,
      scenario_id: s?.id ?? null,
      title: s?.title ?? null,
      started_at: this.t0,
      elapsed_ms: s ? this.cursor - this.t0 : null,
      duration_ms: s?.duration_ms ?? null,
      complete: s ? this.cursor - this.t0 >= s.duration_ms : false,
      steps_done: this.log,
      next_step: s && this.stepIndex < s.steps.length ? s.steps[this.stepIndex] : null,
      sim_time: this.cursor,
    };
  }
}

// Run a scenario instantly with a fresh pipeline (used by tests and tools/run-scenario.js).
export function runScenarioHeadless({ scenario, pipeline, config, startTime, extraMs = 0 }) {
  const sim = new Simulator({ config, pipeline, startTime });
  sim.start(scenario);
  sim.advanceTo(startTime + scenario.duration_ms + extraMs);
  return sim;
}
