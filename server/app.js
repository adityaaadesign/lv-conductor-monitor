// Assembles the server: config → database → pipeline → (simulator) → HTTP API + dashboard.
// Kept separate from index.js so integration tests can start a server on a spare port.

import express from 'express';
import path from 'node:path';
import { openDatabase } from './storage/db.js';
import { Repository } from './storage/repository.js';
import { Pipeline } from './processing/pipeline.js';
import { Simulator, loadScenarios } from './simulation/simulator.js';
import { buildApiRouter } from './api/routes.js';
import { SseHub } from './api/sse.js';
import { RealClock, ScaledClock, toIso } from './domain/clock.js';
import { DataSource } from '../shared/enums.js';

export function createServer({ config, mode, dataDir, logger = console, autoStart = true, deviceKeys = {}, allowedOrigins = [] }) {
  if (mode !== 'sim' && mode !== 'live') throw new Error(`Unknown mode "${mode}"`);
  const source = mode === 'sim' ? DataSource.SIMULATED : DataSource.LIVE;
  // Separate database files: simulated data can never end up in the live history.
  const dbPath = path.join(dataDir, mode === 'sim' ? 'sim.db' : 'live.db');
  const db = openDatabase(dbPath);
  const repo = new Repository(db);
  const clock = mode === 'sim'
    ? new ScaledClock(config.server.simulation.default_speed, repo.latestTimestamp())
    : new RealClock();
  const sse = new SseHub({ minIntervalMs: config.server.status_push_min_interval_ms });

  const pipeline = new Pipeline({
    config,
    repo,
    source,
    logger,
    onStatus: (status) => sse.pushStatus({ ...status, mode, simulation: simControl?.state() ?? null }),
    onEvent: (kind, e) => sse.send(kind, { event_id: e.event_id, event_type: e.event_type, status: e.status }),
  });

  let simulator = null;
  let simControl = null;
  let scenarios = [];
  if (mode === 'sim') {
    scenarios = loadScenarios();
    simControl = {
      scenarios: () => scenarios.map((s) => ({
        id: s.id, title: s.title, category: s.category, description: s.description,
        what_to_look_for: s.what_to_look_for, duration_ms: s.duration_ms, steps: s.steps,
        controller: s.controller, expected_states: s.expect?.states ?? [], expected_events: s.expect?.events ?? {},
        button: s.button ?? null,
      })),
      state: () => (simulator
        ? { ...simulator.state(), speed: clock.speed, sim_time_iso: toIso(simulator.cursor) }
        : { running: false, speed: clock.speed }),
      // fresh=true (used by the dashboard test buttons): reset the simulated feeder first.
      run: (id, speed, fresh = false) => {
        const sc = scenarios.find((s) => s.id === id);
        if (!sc) return { error: 'UNKNOWN_SCENARIO', field: 'scenario_id' };
        if (speed !== undefined) {
          if (!config.server.simulation.allowed_speeds.includes(speed)) return { error: 'SPEED_NOT_ALLOWED', field: 'speed' };
          clock.setSpeed(speed);
        }
        if (fresh) {
          simulator.stop();
          pipeline.demoReset(simulator.cursor);
        }
        simulator.start(sc);
        repo.audit(clock.now(), 'dashboard', 'SIM_RUN_SCENARIO', sc.id, { speed: clock.speed, fresh }, 'OK');
        return { ok: true, state: simControl.state() };
      },
      stop: () => {
        simulator.stop();
        repo.audit(clock.now(), 'dashboard', 'SIM_STOP', null, null, 'OK');
        return { ok: true, state: simControl.state() };
      },
      setSpeed: (speed) => {
        if (!config.server.simulation.allowed_speeds.includes(speed)) return { error: 'SPEED_NOT_ALLOWED' };
        clock.setSpeed(speed);
        return { ok: true, state: simControl.state() };
      },
      // Clear SIMULATED history only (the live database is a different file).
      reset: () => {
        simulator.stop();
        repo.clearAll();
        const now = clock.now();
        pipeline.reset(now);
        simulator = new Simulator({ config, pipeline, startTime: now });
        repo.audit(now, 'dashboard', 'SIM_HISTORY_CLEARED', null, null, 'OK');
        sse.send('history_cleared', {});
        return { ok: true, state: simControl.state() };
      },
    };
  }

  const app = express();
  app.disable('x-powered-by');
  const root = config.projectRoot;
  // CORS: lets a dashboard hosted elsewhere (e.g. Vercel) read this API. Only the exact
  // addresses in ALLOWED_ORIGINS are allowed; with none set, nothing changes.
  // Device keys are never accepted from a browser (X-Device-Key is not an allowed header).
  app.use('/api/v1', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
        return res.sendStatus(204);
      }
    }
    next();
  });
  app.get('/api/v1/stream', sse.handler());
  app.use('/api/v1', buildApiRouter({ config, repo, getPipeline: () => pipeline, mode, clock, simControl, logger, deviceKeys: mode === 'live' ? deviceKeys : {} }));
  app.use('/shared', express.static(path.join(root, 'shared')));
  app.use(express.static(path.join(root, 'frontend')));

  let loop = null;
  let retentionTimer = null;
  let httpServer = null;

  function start(port = config.server.port, host = config.server.host) {
    const now = clock.now();
    if (mode === 'sim') simulator = new Simulator({ config, pipeline, startTime: now });
    pipeline.start(now);
    repo.applyRetention(now, { measurementsDays: config.server.retention.measurements_days, rejectionsDays: config.server.retention.rejections_days });
    if (mode === 'sim') {
      const first = config.server.simulation.auto_start_scenario;
      if (autoStart && first) simControl.run(first);
      // Advance simulated time in small real-time steps.
      loop = setInterval(() => simulator.advanceTo(clock.now()), 100);
    } else {
      loop = setInterval(() => pipeline.tick(clock.now()), config.detection.tick_interval_ms);
    }
    retentionTimer = setInterval(() => repo.applyRetention(clock.now(), {
      measurementsDays: config.server.retention.measurements_days, rejectionsDays: config.server.retention.rejections_days,
    }), 3600_000);
    retentionTimer.unref();
    return new Promise((resolve) => {
      httpServer = app.listen(port, host, () => resolve(httpServer.address()));
    });
  }

  function stop() {
    clearInterval(loop);
    clearInterval(retentionTimer);
    sse.close();
    return new Promise((resolve) => {
      const done = () => { try { db.close(); } catch { /* already closed */ } resolve(); };
      if (httpServer) {
        httpServer.closeAllConnections?.();
        httpServer.close(done);
      } else done();
    });
  }

  return { app, start, stop, pipeline, repo, clock, get simulator() { return simulator; }, simControl, dbPath };
}
