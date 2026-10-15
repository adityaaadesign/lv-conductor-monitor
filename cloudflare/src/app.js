// The Cloudflare Worker version of the LIVE backend.
//
// A Worker keeps no memory between requests and has no timer loop, so every request:
//   1. loads the saved monitoring memory from D1 (table pipeline_state),
//   2. runs the SAME processing code as the laptop server (server/processing/*):
//      first the time check (nodes go STALE / OFFLINE when reports stop), then the report,
//   3. saves the memory plus all new rows (readings, events) in ONE D1 batch.
// A cron trigger runs step 1–3 once a minute, so a silent node or controller is recorded
// even when nobody has the dashboard open.
//
// LIVE data only: there is no simulator and no demo endpoint here. DEMO runs on the laptop.
// The API only RECEIVES data; there is no endpoint that can operate a switch.

import { Pipeline } from '../../server/processing/pipeline.js';
import { buildConfig, parseDeviceKeys, timingOverrides } from '../../server/config/build-config.js';
import {
  deviceKeyMatches, unauthorisedBody, eventForApi, eventFilter, topologyBody, configBody,
} from '../../server/api/helpers.js';
import { eventFilterSql, eventFromRow } from '../../server/storage/repository.js';
import { eventsToCsv } from '../../server/api/csv.js';
import { toIso } from '../../server/domain/clock.js';
import { DataSource } from '../../shared/enums.js';
import { BufferedRepo, newRepoState } from './buffered-repo.js';
import { encodeSnapshot, decodeSnapshot } from './snapshot.js';

const SOURCE = DataSource.LIVE;
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_MEMORY = 300;            // recent report numbers kept for duplicate checks
const SAVE_ATTEMPTS = 5;            // D1 free plan: max 50 queries per request – stay well below
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_REFRESH_MS = 2000;
const DAY = 24 * 3600 * 1000;

export function createApp({ files, now = () => Date.now(), logger = console }) {
  const configCache = new Map();

  // Settings come from wrangler.toml [vars] and secrets (DEVICE_KEYS).
  function settings(env) {
    const timing = timingOverrides(env);
    const key = JSON.stringify(timing);
    if (!configCache.has(key)) configCache.set(key, buildConfig(files, { detection: timing }));
    const refresh = Math.max(MIN_REFRESH_MS, Number(env.DASHBOARD_REFRESH_MS) || 5000);
    return {
      config: configCache.get(key),
      deviceKeysText: env.DEVICE_KEYS ?? '',
      allowedOrigins: String(env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
      refreshMs: refresh,
    };
  }

  // ---- load → process → save ------------------------------------------------------------
  // fn(pipeline, t) does the work. The memory is saved when the database must change
  // (new reading, new event, state change). Two requests at the same moment: the one that
  // saves second notices the version changed, and starts again from the newer memory.
  async function withPipeline(env, config, fn) {
    let lastError = null;
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
      const t = now();
      const row = await env.DB.prepare('SELECT version, snapshot FROM pipeline_state WHERE id = 1').first();
      const saved = row ? decodeSnapshot(row.snapshot) : null;
      const repo = new BufferedRepo(env.DB, saved?.repo ?? newRepoState());
      const pipeline = new Pipeline({ config, repo, source: SOURCE, logger, sessionMemory: SESSION_MEMORY });
      if (saved) pipeline.importMemory(saved.pipeline);
      else pipeline.start(t);
      const result = fn(pipeline, t);
      if (row && !repo.dirty) return { result, pipeline, repo, t, saved: false };

      const snapshot = encodeSnapshot({ pipeline: pipeline.exportMemory(), repo: repo.state });
      const save = row
        ? [
          env.DB.prepare('UPDATE pipeline_state SET version = version + 1, saved_at = ?, snapshot = ? WHERE id = 1 AND version = ?')
            .bind(t, snapshot, row.version),
          // Stops the whole batch if the row was not updated (someone else saved first).
          env.DB.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('SAVE_CONFLICT') END AS ok"),
        ]
        : [env.DB.prepare('INSERT INTO pipeline_state (id, version, saved_at, snapshot) VALUES (1, 1, ?, ?)').bind(t, snapshot)];
      try {
        await env.DB.batch([...save, ...repo.queue]);
        return { result, pipeline, repo, t, saved: true };
      } catch (err) {
        lastError = err;
        logger.warn?.(`[d1] save attempt ${attempt} failed: ${err.message}`);
        // Another request saved first: wait a short random time, then start again from its memory.
        if (attempt < SAVE_ATTEMPTS) await sleep(10 + Math.random() * 40 * attempt);
      }
    }
    const err = new Error(`database save failed: ${lastError?.message}`);
    err.code = 'SAVE_FAILED';
    throw err;
  }

  // ---- HTTP helpers ------------------------------------------------------------------------
  function corsHeaders(request, allowedOrigins) {
    const origin = request.headers.get('Origin');
    if (!origin || !allowedOrigins.includes(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type',   // never X-Device-Key: browsers cannot send telemetry
      'Access-Control-Max-Age': '600',
    };
  }

  const json = (body, status, extra) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

  const badRequest = (field, problem, cors) => json({ error: 'BAD_REQUEST', details: [{ field, problem }] }, 400, cors);

  // ---- routes -------------------------------------------------------------------------------
  async function handle(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let s;
    try {
      s = settings(env);
    } catch (err) {
      return json({ error: 'CONFIGURATION_ERROR', message: err.message }, 500);
    }
    const cors = corsHeaders(request, s.allowedOrigins);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const { config } = s;
    const query = Object.fromEntries(url.searchParams);

    if (path === '/') {
      return json({ service: 'LV conductor monitor – LIVE API', health: '/api/v1/health', dashboard: 'hosted separately (Vercel)' }, 200, cors);
    }
    if (!path.startsWith('/api/v1/')) return json({ error: 'NOT_FOUND' }, 404, cors);
    const route = path.slice('/api/v1'.length);

    if (request.method === 'POST' && route === '/telemetry') return telemetry(request, env, s, cors);
    if (request.method !== 'GET') return json({ error: 'NOT_FOUND' }, 404, cors);

    switch (route) {
      case '/health': {
        let databaseOk = true;
        try { await env.DB.prepare('SELECT 1 AS ok').first(); } catch { databaseOk = false; }
        return json({ ok: true, mode: 'live', database_ok: databaseOk, server_time: toIso(now()), host: 'cloudflare-worker' }, 200, cors);
      }
      case '/config':
        return json(configBody(config, { mode: 'live', source: SOURCE, liveUpdates: { method: 'poll', interval_ms: s.refreshMs } }), 200, cors);
      case '/topology':
        return json(topologyBody(config), 200, cors);
      case '/status': {
        let r;
        try {
          r = await withPipeline(env, config, (p, t) => p.tick(t));
        } catch (err) {
          return json({ error: 'DATABASE_UNAVAILABLE', message: err.message }, 503, cors);
        }
        return json({
          ...r.pipeline.getStatus(r.t), mode: 'live', simulation: null, events_version: r.repo.state.eventsVersion,
        }, 200, cors);
      }
      case '/events': {
        const f = eventFilter(config, SOURCE, query);
        if (f.error) return badRequest(...f.error, cors);
        const result = await queryEvents(env, f.filter);
        return json({ ...result, source: SOURCE, items: result.items.map(eventForApi) }, 200, cors);
      }
      case '/events.csv': {
        const f = eventFilter(config, SOURCE, query);
        if (f.error) return badRequest(...f.error, cors);
        const { items } = await queryEvents(env, { ...f.filter, limit: 1000, offset: 0 });
        const stamp = new Date(now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
        return new Response(eventsToCsv(items), {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="events-${SOURCE}-${stamp}.csv"`,
            'Cache-Control': 'no-store',
            ...cors,
          },
        });
      }
      default: {
        const m = /^\/events\/([^/]+)$/.exec(route);
        if (m) {
          const id = Number(m[1]);
          if (!Number.isInteger(id) || id <= 0) return badRequest('id', 'INVALID_ID', cors);
          const row = await env.DB.prepare('SELECT * FROM events WHERE event_id = ?').bind(id).first();
          if (!row || row.source !== SOURCE) return json({ error: 'NOT_FOUND' }, 404, cors);
          const e = eventFromRow(row);
          const tl = await env.DB.prepare('SELECT ts, kind, details FROM event_timeline WHERE event_id = ? ORDER BY ts, id').bind(id).all();
          e.timeline = tl.results.map((x) => ({ ...x, details: JSON.parse(x.details) }));
          return json(eventForApi(e), 200, cors);
        }
        if (route.startsWith('/sim/')) return json({ error: 'SIMULATION_NOT_ACTIVE' }, 404, cors);
        return json({ error: 'NOT_FOUND' }, 404, cors);
      }
    }
  }

  async function queryEvents(env, f) {
    const { sql, args } = eventFilterSql(f);
    const limit = Math.min(Math.max(1, Number(f.limit) || 50), 1000);
    const offset = Math.max(0, Number(f.offset) || 0);
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${sql}`).bind(...args).first('n');
    const rows = await env.DB.prepare(`SELECT * FROM events WHERE ${sql}
      ORDER BY COALESCE(start_ts, created_ts) DESC, event_id DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset).all();
    return { total, items: rows.results.map(eventFromRow), limit, offset };
  }

  // Real-device input. Same checks and answers as the laptop server (server/api/routes.js).
  async function telemetry(request, env, s, cors) {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413, cors);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'MALFORMED_JSON' }, 400, cors); }
    let deviceKeys;
    try {
      deviceKeys = parseDeviceKeys(s.deviceKeysText);
    } catch (err) {
      return json({ accepted: false, error: 'CONFIGURATION_ERROR', message: err.message }, 500, cors);
    }
    const controllerId = typeof body?.controller_id === 'string' ? body.controller_id : null;
    if (!deviceKeyMatches(deviceKeys, controllerId, request.headers.get('X-Device-Key'))) {
      return json(unauthorisedBody(deviceKeys), 401, cors);
    }
    let r;
    try {
      // Time check first (a node that stopped reporting ages), then the new report.
      r = await withPipeline(env, s.config, (p, t) => { p.tick(t); return p.ingestReport(body, t); });
    } catch (err) {
      // 503 = "try again later": the firmware keeps the report and sends it again.
      return json({ accepted: false, error: 'DATABASE_UNAVAILABLE', message: err.message }, 503, cors);
    }
    const result = r.result;
    const serverTime = toIso(r.t);
    if (!result.accepted) {
      return json({ accepted: false, error: result.error, details: result.details, server_time: serverTime }, 400, cors);
    }
    return json({
      accepted: true,
      duplicate: !!result.duplicate,
      late: !!result.late,
      rejected_nodes: result.rejected_nodes ?? [],
      server_time: serverTime,
      pending_requests: 0,
    }, 200, cors);
  }

  return {
    async fetch(request, env) {
      try {
        return await handle(request, env);
      } catch (err) {
        logger.error?.(err);
        return json({ error: 'INTERNAL_ERROR' }, 500);
      }
    },

    // Cron trigger (wrangler.toml, every minute): time check without any visitor, and once an
    // hour delete old readings (config/server.json retention).
    async scheduled(controller, env) {
      const { config } = settings(env);
      await withPipeline(env, config, (p, t) => p.tick(t));
      const t = now();
      if (new Date(controller?.scheduledTime ?? t).getUTCMinutes() === 0) {
        const r = config.server.retention;
        await env.DB.batch([
          env.DB.prepare('DELETE FROM measurements WHERE received_at < ?').bind(t - r.measurements_days * DAY),
          env.DB.prepare('DELETE FROM ingest_rejections WHERE ts < ?').bind(t - r.rejections_days * DAY),
        ]);
      }
    },
  };
}
