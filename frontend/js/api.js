// Thin wrappers around fetch for the server's REST API.

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// Where the server is. Empty = the same address as this page (the laptop server).
// On Vercel, config.js is generated at build time from the API_BASE_URL setting.
const API_BASE = String(window.LV_API_BASE ?? '').replace(/\/+$/, '');

export function apiUrl(path) {
  return new URL(`${API_BASE}/api/v1${path}`, window.location.origin).toString();
}

// In-browser DEMO (demo-engine.js): when set, every request is answered inside this tab
// and nothing goes to the network.
let local = null;
export function useLocalBackend(engine) { local = engine; }
export function isLocalBackend() { return local !== null; }

function localCall(method, path, params, body) {
  try {
    const query = Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
    return Promise.resolve(JSON.parse(JSON.stringify(local.request(method, path, query, body))));
  } catch (err) {
    return Promise.reject(new ApiError(err.body?.error ?? err.message, err.status ?? 500, err.body ?? null));
  }
}

function buildUrl(path, params) {
  const url = new URL(apiUrl(path));
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  return url;
}

async function handle(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = body?.details?.map((d) => `${d.field}: ${d.problem}`).join(', ');
    throw new ApiError(`${body?.error ?? res.statusText}${detail ? ` (${detail})` : ''}`, res.status, body);
  }
  return body;
}

export async function getJson(path, params) {
  if (local) return localCall('GET', path, params);
  let res;
  try {
    res = await fetch(buildUrl(path, params), { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError('Cannot reach the monitoring server', 0, null);
  }
  return handle(res);
}

export async function postJson(path, body = {}) {
  if (local) return localCall('POST', path, null, body);
  let res;
  try {
    res = await fetch(buildUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError('Cannot reach the monitoring server', 0, null);
  }
  return handle(res);
}

// In the in-browser DEMO the link is handled by app.js (the file is made in the browser).
export const LOCAL_CSV_HREF = '#download-demo-csv';
export function csvUrl(params) {
  if (local) return LOCAL_CSV_HREF;
  return buildUrl('/events.csv', params).toString();
}
