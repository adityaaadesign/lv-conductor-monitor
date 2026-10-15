// Thin wrappers around fetch for the server's REST API.

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function buildUrl(path, params) {
  const url = new URL(`/api/v1${path}`, window.location.origin);
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
  let res;
  try {
    res = await fetch(buildUrl(path, params), { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError('Cannot reach the monitoring server', 0, null);
  }
  return handle(res);
}

export async function postJson(path, body = {}) {
  let res;
  try {
    res = await fetch(buildUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError('Cannot reach the monitoring server', 0, null);
  }
  return handle(res);
}

export function csvUrl(params) {
  return buildUrl('/events.csv', params).toString();
}
