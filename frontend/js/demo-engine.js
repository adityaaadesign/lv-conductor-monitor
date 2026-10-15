// In-browser DEMO: the real processing pipeline and simulator, running inside this
// browser tab. Used when the DEMO/LIVE switch is set to DEMO.
//
// - All readings are SIMULATED. Nothing is sent to any server, so demo data can never
//   reach the LIVE database (Cloudflare D1 or data/live.db).
// - It answers the same requests as the server API (/config, /status, /events, /sim/run …),
//   so the dashboard code is the same in both modes.
// - History is kept only while the tab is open.

import { Pipeline } from '../../server/processing/pipeline.js';
import { Simulator, prepareScenario, scenarioSummaries } from '../../server/simulation/simulator.js';
import { buildConfig } from '../../server/config/build-config.js';
import { MemoryRepo } from '../../server/storage/memory-repo.js';
import { configBody, topologyBody, eventForApi, eventFilter } from '../../server/api/helpers.js';
import { eventsToCsv } from '../../server/api/csv.js';
import { toIso } from '../../server/domain/clock.js';
import { DataSource } from '../../shared/enums.js';

const SOURCE = DataSource.SIMULATED;

export class DemoRequestError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// files: { feeder, detection, server } (parsed JSON); scenarios: parsed scenario files.
export function createDemoEngine({ files, scenarios, now = () => Date.now(), autoStart = true }) {
  const config = buildConfig(files);
  const list = scenarios.map((s) => prepareScenario(structuredClone(s)));
  const repo = new MemoryRepo();
  let eventsChanged = false;
  const pipeline = new Pipeline({
    config, repo, source: SOURCE, logger: { error() {}, warn() {}, log() {} },
    onEvent: () => { eventsChanged = true; },
  });
  const t0 = now();
  pipeline.start(t0);
  const simulator = new Simulator({ config, pipeline, startTime: t0 });

  const simState = () => ({ ...simulator.state(), speed: 1, sim_time_iso: toIso(simulator.cursor) });

  function run(id, fresh) {
    const sc = list.find((s) => s.id === id);
    if (!sc) throw new DemoRequestError(400, { error: 'BAD_REQUEST', details: [{ field: 'scenario_id', problem: 'UNKNOWN_SCENARIO' }] });
    if (fresh) {
      simulator.stop();
      pipeline.demoReset(simulator.cursor);
    }
    simulator.start(sc);
    eventsChanged = true;
    return { ok: true, state: simState() };
  }

  const first = config.server.simulation.auto_start_scenario;
  if (autoStart && first) run(first, false);

  function advance(t = now()) {
    if (t > simulator.cursor) simulator.advanceTo(t);
  }

  // The same answers as the server API (server/api/routes.js) for what the dashboard uses.
  function request(method, path, query = {}, body = {}) {
    advance();
    const route = path.split('?')[0];
    if (method === 'GET') {
      if (route === '/config') return configBody(config, { mode: 'sim', source: SOURCE, liveUpdates: { method: 'local' } });
      if (route === '/topology') return topologyBody(config);
      if (route === '/status') return { ...pipeline.getStatus(), mode: 'sim', simulation: simState(), in_browser_demo: true };
      if (route === '/sim/scenarios') return { scenarios: scenarioSummaries(list) };
      if (route === '/sim/state') return simState();
      if (route === '/events') {
        const f = eventFilter(config, SOURCE, query);
        if (f.error) throw new DemoRequestError(400, { error: 'BAD_REQUEST', details: [{ field: f.error[0], problem: f.error[1] }] });
        const result = repo.queryEvents(f.filter);
        return { ...result, source: SOURCE, items: result.items.map(eventForApi) };
      }
      const m = /^\/events\/(\d+)$/.exec(route);
      if (m) {
        const e = repo.getEvent(Number(m[1]));
        if (!e) throw new DemoRequestError(404, { error: 'NOT_FOUND' });
        return eventForApi(e);
      }
    }
    if (method === 'POST') {
      if (route === '/sim/run') return run(body.scenario_id, !!body.fresh);
      if (route === '/sim/stop') { simulator.stop(); return { ok: true, state: simState() }; }
      // Device data is never accepted in DEMO.
      if (route === '/telemetry') throw new DemoRequestError(409, { accepted: false, error: 'SERVER_IN_SIMULATION_MODE' });
    }
    throw new DemoRequestError(404, { error: 'NOT_FOUND' });
  }

  function csv() {
    advance();
    return eventsToCsv(repo.queryEvents({ source: SOURCE, limit: 1000, offset: 0 }).items);
  }

  // Live updates for the page: advance the simulation and hand over the status.
  function connect(store, intervalMs = 200) {
    const step = () => {
      advance();
      store.setConnection('live');
      store.setStatus(request('GET', '/status'));
      if (eventsChanged) {
        eventsChanged = false;
        store.emit('events', { kind: 'demo' });
      }
    };
    step();
    const timer = setInterval(step, intervalMs);
    return { close: () => clearInterval(timer) };
  }

  return { config, request, advance, csv, connect, run, pipeline, simulator };
}

// Browser only: load the configuration and scenarios published with the dashboard.
export async function loadDemoEngine() {
  const get = async (name) => {
    const res = await fetch(`/demo/${name}`);
    if (!res.ok) throw new Error(`cannot load /demo/${name} (HTTP ${res.status})`);
    return res.json();
  };
  const [feeder, detection, server, scenarios] = await Promise.all(
    ['feeder.json', 'detection.json', 'server.json', 'scenarios.json'].map(get),
  );
  return createDemoEngine({ files: { feeder, detection, server }, scenarios });
}
