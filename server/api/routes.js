// REST API for the dashboard (docs/ARCHITECTURE.md §5). Everything under /api/v1.
// Version 1 is read-only monitoring: there is no endpoint that operates switching.
// Simulation-control endpoints exist only in SIMULATION mode and only affect the simulator.

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { eventsToCsv } from './csv.js';
import { toIso } from '../domain/clock.js';
import { EventType, Severity, EventStatus, DataSource } from '../../shared/enums.js';

function parseTime(v) {
  if (v === undefined || v === null || v === '') return null;
  if (/^\d+$/.test(String(v))) return Number(v);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : undefined;
}

// Constant-time comparison of the controller's key with the configured one.
function deviceKeyMatches(keys, controllerId, sentKey) {
  const expected = controllerId ? keys[controllerId] : undefined;
  if (typeof expected !== 'string' || typeof sentKey !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(sentKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

function badRequest(res, field, problem) {
  return res.status(400).json({ error: 'BAD_REQUEST', details: [{ field, problem }] });
}

// Convert stored epoch-ms fields to ISO strings for the API.
function eventForApi(e) {
  return {
    ...e,
    event_label: `EV-${String(e.event_id).padStart(6, '0')}`,
    start_timestamp: toIso(e.start_ts),
    first_observed_timestamp: toIso(e.first_observed_ts),
    end_timestamp: toIso(e.end_ts),
    isolation_requested_timestamp: toIso(e.isolation_requested_ts),
    isolation_confirmed_timestamp: toIso(e.isolation_confirmed_ts),
    acknowledged_timestamp: toIso(e.acknowledged_ts),
    created_timestamp: toIso(e.created_ts),
    updated_timestamp: toIso(e.updated_ts),
    timeline: e.timeline?.map((t) => ({ ...t, timestamp: toIso(t.ts) })),
  };
}

export function buildApiRouter(ctx) {
  const { config, repo, getPipeline, mode, clock, simControl } = ctx;
  const source = mode === 'sim' ? DataSource.SIMULATED : DataSource.LIVE;
  const r = express.Router();
  r.use(express.json({ limit: '16kb' }));

  // Used by the hosting service to check the server is running.
  r.get('/health', (req, res) => {
    const storage = getPipeline().storage;
    res.json({ ok: true, mode, database_ok: storage?.ok !== false, server_time: toIso(clock.now()) });
  });

  r.get('/status', (req, res) => {
    res.json({ ...getPipeline().getStatus(), mode, simulation: simControl?.state() ?? null });
  });

  r.get('/topology', (req, res) => {
    const t = config.topology;
    res.json({
      feeder_id: config.feeder.feeder_id,
      name: config.feeder.name,
      nodes: t.orderedNodeIds.map((id) => t.nodeById.get(id)),
      sections: t.sections,
      isolation_points: [...t.switches.values()],
      controllers: [...t.controllersById.values()],
      source_reference_node: t.sourceReferenceNode,
    });
  });

  r.get('/config', (req, res) => {
    res.json({
      mode,
      source,
      feeder_id: config.feeder.feeder_id,
      feeder_name: config.feeder.name,
      nominal_voltage_v: config.feeder.nominal_voltage_v,
      sensor_full_scale_v: config.feeder.sensor_full_scale_v,
      capabilities: config.feeder.capabilities,
      detection: config.detection,
      placeholders: config.placeholders,
      simulation: mode === 'sim' ? { allowed_speeds: config.server.simulation.allowed_speeds } : null,
      supervisory_requests_enabled: false,
    });
  });

  const eventFilter = (q) => {
    const from = parseTime(q.from);
    const to = parseTime(q.to);
    if (from === undefined) return { error: ['from', 'INVALID_TIME'] };
    if (to === undefined) return { error: ['to', 'INVALID_TIME'] };
    if (q.type && !(q.type in EventType)) return { error: ['type', 'UNKNOWN_EVENT_TYPE'] };
    if (q.severity && !(q.severity in Severity)) return { error: ['severity', 'UNKNOWN_SEVERITY'] };
    if (q.status && !(q.status in EventStatus)) return { error: ['status', 'UNKNOWN_STATUS'] };
    if (q.node && !config.topology.nodeById.has(q.node)) return { error: ['node', 'UNKNOWN_NODE'] };
    return {
      filter: {
        source, from, to, type: q.type || null, severity: q.severity || null, status: q.status || null,
        node: q.node || null, q: q.q ? String(q.q).slice(0, 100) : null, limit: q.limit, offset: q.offset,
        excludeInfo: q.exclude_info === '1' || q.exclude_info === 'true',
      },
    };
  };

  r.get('/events', (req, res) => {
    const f = eventFilter(req.query);
    if (f.error) return badRequest(res, ...f.error);
    const result = repo.queryEvents(f.filter);
    res.json({ ...result, source, items: result.items.map(eventForApi) });
  });

  r.get('/events.csv', (req, res) => {
    const f = eventFilter(req.query);
    if (f.error) return badRequest(res, ...f.error);
    const { items } = repo.queryEvents({ ...f.filter, limit: 1000, offset: 0 });
    const stamp = new Date(clock.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="events-${source}-${stamp}.csv"`);
    res.send(eventsToCsv(items));
  });

  r.get('/events/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return badRequest(res, 'id', 'INVALID_ID');
    const e = repo.getEvent(id);
    if (!e || e.source !== source) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(eventForApi(e));
  });

  r.get('/measurements', (req, res) => {
    const now = getPipeline().lastEvalAt;
    const to = parseTime(req.query.to) ?? now;
    const from = parseTime(req.query.from) ?? to - 15 * 60 * 1000;
    if (from === undefined || to === undefined || from >= to) return badRequest(res, 'from/to', 'INVALID_RANGE');
    const nodeIds = (req.query.nodes ? String(req.query.nodes).split(',') : config.topology.orderedNodeIds)
      .filter((id) => config.topology.nodeById.has(id));
    const maxPoints = Math.min(Math.max(50, Number(req.query.max_points) || 1500), 5000);
    res.json({
      source, from, to, server_now: now,
      series: repo.measurementSeries({ nodeIds, from, to, maxPoints, source }),
      transitions: repo.transitions({ from, to, source }),
    });
  });

  r.get('/diagnostics', (req, res) => {
    const p = getPipeline();
    const status = p.getStatus();
    res.json({
      source,
      mode,
      ...p.diagnostics(),
      controllers: status.controllers,
      measurement_counts: repo.measurementCounts(source),
      rejections: repo.recentRejections(30).map((x) => ({ ...x, timestamp: toIso(x.ts) })),
      recent_transitions: repo.transitions({ from: 0, to: p.lastEvalAt, source, limit: 30 }).map((t) => ({ ...t, timestamp: toIso(t.ts) })),
      placeholders: config.placeholders,
    });
  });

  // Real-device input (docs/HARDWARE_INTEGRATION.md). Reports go into the SAME pipeline
  // the simulator uses, so there is only one implementation of the detection logic.
  // - DEMO mode: always refused, so simulated and real data never mix in one database.
  // - LIVE mode: each controller must send its secret key (config/devices.local.json).
  //   With no keys configured, every request is refused – the input stays locked.
  // This endpoint only RECEIVES data. There is no endpoint that sends commands to hardware.
  r.post('/telemetry', (req, res) => {
    if (mode === 'sim') return res.status(409).json({ accepted: false, error: 'SERVER_IN_SIMULATION_MODE' });
    const body = req.body;
    const controllerId = typeof body?.controller_id === 'string' ? body.controller_id : null;
    if (!deviceKeyMatches(ctx.deviceKeys ?? {}, controllerId, req.get('X-Device-Key'))) {
      const noKeys = !Object.keys(ctx.deviceKeys ?? {}).length;
      return res.status(401).json({
        accepted: false,
        error: 'UNAUTHORISED',
        details: [{ field: 'X-Device-Key', problem: noKeys ? 'NO_DEVICE_KEYS_CONFIGURED_ON_SERVER' : 'MISSING_OR_WRONG_KEY' }],
      });
    }
    const result = getPipeline().ingestReport(body, clock.now());
    const serverTime = toIso(clock.now());
    if (!result.accepted) {
      return res.status(400).json({ accepted: false, error: result.error, details: result.details, server_time: serverTime });
    }
    return res.json({
      accepted: true,
      duplicate: !!result.duplicate,
      late: !!result.late,
      rejected_nodes: result.rejected_nodes ?? [],
      server_time: serverTime,
      pending_requests: 0,   // supervisory requests are not implemented (read-only system)
    });
  });

  // ---- simulation control (demo mode only) ---------------------------------------------
  if (mode === 'sim' && simControl) {
    r.get('/sim/scenarios', (req, res) => res.json({ scenarios: simControl.scenarios() }));
    r.get('/sim/state', (req, res) => res.json(simControl.state()));
    r.post('/sim/run', (req, res) => {
      const { scenario_id: id, speed, fresh } = req.body ?? {};
      const result = simControl.run(id, speed, fresh === true);
      if (result.error) return badRequest(res, result.field, result.error);
      res.json(result);
    });
    r.post('/sim/stop', (req, res) => res.json(simControl.stop()));
    r.post('/sim/speed', (req, res) => {
      const result = simControl.setSpeed(req.body?.speed);
      if (result.error) return badRequest(res, 'speed', result.error);
      res.json(result);
    });
    r.post('/sim/reset', (req, res) => res.json(simControl.reset()));
  } else {
    r.all('/sim/*', (req, res) => res.status(404).json({ error: 'SIMULATION_NOT_ACTIVE' }));
  }

  r.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'MALFORMED_JSON' });
    ctx.logger.error(err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  return r;
}
