// Hosting support: DEVICE_KEYS environment variable, GET /api/v1/health, the api-check
// tool, and the Online / Stale Data / Offline labels on the node cards.
// Runs against local servers only – this does NOT test a real Render deployment.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../server/app.js';
import { loadDeviceKeys, ConfigError } from '../../server/config/load-config.js';
import { connectionState } from '../../shared/simple.js';
import { runApiCheck } from '../../tools/api-check.js';
import { testConfig, quietLogger } from '../helpers.js';

const config = testConfig();
const KEY = 'deploy-test-key-0123456789';
const dirs = [];
const servers = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'lvdeploy-')); dirs.push(d); return d; };
async function start(mode, deviceKeys = {}) {
  const s = createServer({ config, mode, dataDir: tmp(), logger: quietLogger, deviceKeys, autoStart: false });
  servers.push(s);
  const addr = await s.start(0, '127.0.0.1');
  return `http://127.0.0.1:${addr.port}`;
}

after(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('DEVICE_KEYS environment variable is read and checked', () => {
  const dir = tmp();
  assert.deepEqual(loadDeviceKeys(dir, { DEVICE_KEYS: 'CTRL-01=a-real-secret-key-1234' }), { 'CTRL-01': 'a-real-secret-key-1234' });
  assert.deepEqual(loadDeviceKeys(dir, { DEVICE_KEYS: ' CTRL-01=a-real-secret-key-1234 , CTRL-02=another-secret-key-5678 ' }),
    { 'CTRL-01': 'a-real-secret-key-1234', 'CTRL-02': 'another-secret-key-5678' });
  assert.throws(() => loadDeviceKeys(dir, { DEVICE_KEYS: 'just-a-key-without-id' }), ConfigError);
  assert.throws(() => loadDeviceKeys(dir, { DEVICE_KEYS: 'CTRL-01=short' }), ConfigError);
  assert.throws(() => loadDeviceKeys(dir, { DEVICE_KEYS: 'CTRL-01=change-me-to-your-own-long-random-text' }), ConfigError);
  // The environment variable wins over the local file.
  writeFileSync(path.join(dir, 'devices.local.json'), JSON.stringify({ 'CTRL-01': 'file-secret-key-123456' }));
  assert.deepEqual(loadDeviceKeys(dir, {}), { 'CTRL-01': 'file-secret-key-123456' });
  assert.deepEqual(loadDeviceKeys(dir, { DEVICE_KEYS: 'CTRL-01=env-secret-key-1234567' }), { 'CTRL-01': 'env-secret-key-1234567' });
});

test('GET /api/v1/health reports mode and database state', async () => {
  const base = await start('live', { 'CTRL-01': KEY });
  const res = await fetch(`${base}/api/v1/health`);
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.ok, true);
  assert.equal(h.mode, 'live');
  assert.equal(h.database_ok, true);
  assert.ok(!Number.isNaN(Date.parse(h.server_time)));
});

test('api-check passes against a correctly configured LIVE server', async () => {
  const base = await start('live', { 'CTRL-01': KEY });
  const results = await runApiCheck({ url: base, key: KEY, controllerId: 'CTRL-01', nodeIds: ['N-A', 'N-B', 'N-C'] });
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.equal(results.length, 6);
});

test('api-check fails clearly with a wrong key or a DEMO server', async () => {
  const live = await start('live', { 'CTRL-01': KEY });
  const wrong = await runApiCheck({ url: live, key: 'not-the-right-key-123456', controllerId: 'CTRL-01', nodeIds: ['N-A'] });
  assert.equal(wrong.find((r) => r.name.startsWith('Valid report accepted')).ok, false);

  const demo = await start('sim');
  const results = await runApiCheck({ url: demo, key: KEY, controllerId: 'CTRL-01', nodeIds: ['N-A'] });
  assert.equal(results.find((r) => r.name === 'Server is in LIVE mode').ok, false);
});

test('connection labels: Online / Stale Data / Offline – never a voltage', () => {
  assert.equal(connectionState({ validity: 'VALID' }).label, 'Online');
  assert.equal(connectionState({ validity: 'STALE' }).label, 'Stale Data');
  assert.equal(connectionState({ validity: 'OFFLINE' }).label, 'Offline');
  assert.equal(connectionState({ validity: 'INVALID' }).label, 'No Data');
  assert.equal(connectionState({ validity: 'NEVER_SEEN' }).label, 'Waiting');
  for (const v of ['STALE', 'OFFLINE', 'INVALID', 'NEVER_SEEN']) assert.doesNotMatch(connectionState({ validity: v }).label, /\d/);
});

test('CORS: only the configured dashboard address may read the API', async () => {
  const VERCEL = 'https://lv-conductor-monitor.vercel.app';
  const s = createServer({ config, mode: 'live', dataDir: tmp(), logger: quietLogger, deviceKeys: { 'CTRL-01': KEY }, allowedOrigins: [VERCEL] });
  servers.push(s);
  const base = `http://127.0.0.1:${(await s.start(0, '127.0.0.1')).port}`;

  const ok = await fetch(`${base}/api/v1/status`, { headers: { Origin: VERCEL } });
  assert.equal(ok.headers.get('access-control-allow-origin'), VERCEL);
  const other = await fetch(`${base}/api/v1/status`, { headers: { Origin: 'https://someone-else.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);

  const pre = await fetch(`${base}/api/v1/sim/run`, { method: 'OPTIONS', headers: { Origin: VERCEL, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.doesNotMatch(pre.headers.get('access-control-allow-headers'), /device-key/i);

  // The live stream (Server-Sent Events) also carries the header.
  const ctrl = new AbortController();
  const stream = await fetch(`${base}/api/v1/stream`, { headers: { Origin: VERCEL }, signal: ctrl.signal });
  assert.equal(stream.headers.get('access-control-allow-origin'), VERCEL);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  ctrl.abort();

  // Without ALLOWED_ORIGINS nothing changes (laptop use).
  const plain = await start('live', { 'CTRL-01': KEY });
  assert.equal((await fetch(`${plain}/api/v1/status`, { headers: { Origin: VERCEL } })).headers.get('access-control-allow-origin'), null);
});

test('Vercel build: dashboard files plus config.js pointing at the backend', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, existsSync } = await import('node:fs');
  const root = path.resolve(import.meta.dirname, '../..');
  const run = (env) => execFileSync(process.execPath, ['tools/build-frontend.js'], { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe' });
  try {
    assert.throws(() => run({ API_BASE_URL: '' }));
    assert.throws(() => run({ API_BASE_URL: 'https://x.onrender.com/api/v1' }));
    run({ API_BASE_URL: 'https://lv-monitor-api.onrender.com/' });
    const dist = path.join(root, 'dist');
    assert.match(readFileSync(path.join(dist, 'config.js'), 'utf8'), /window\.LV_API_BASE = "https:\/\/lv-monitor-api\.onrender\.com";/);
    for (const f of ['index.html', 'js/app.js', 'css/app.css', 'shared/simple.js']) assert.ok(existsSync(path.join(dist, f)), f);
    assert.ok(!existsSync(path.join(dist, 'server')), 'server code must not be published on Vercel');
  } finally {
    rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  }
});

test('every dashboard script has valid JavaScript syntax', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readdirSync } = await import('node:fs');
  const root = path.resolve(import.meta.dirname, '../..');
  const files = [
    ...readdirSync(path.join(root, 'frontend/js')).filter((f) => f.endsWith('.js')).map((f) => `frontend/js/${f}`),
    'frontend/config.js',
    ...readdirSync(path.join(root, 'shared')).filter((f) => f.endsWith('.js')).map((f) => `shared/${f}`),
  ];
  for (const f of files) assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', f], { cwd: root, stdio: 'pipe' }), f);
});
