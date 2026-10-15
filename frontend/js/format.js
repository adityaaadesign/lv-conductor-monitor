// Formatting helpers. Unavailable values are shown as "—", never as 0.

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const toMs = (t) => (t === null || t === undefined ? null : typeof t === 'number' ? t : Date.parse(t));
const pad = (n) => String(n).padStart(2, '0');

export function fmtTime(t) {
  const ms = toMs(t);
  if (ms === null || Number.isNaN(ms)) return '—';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtDateTime(t) {
  const ms = toMs(t);
  if (ms === null || Number.isNaN(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtTime(ms)}`;
}

export function fmtDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Age relative to the server's clock (the simulated clock may run faster than real time).
export function fmtAge(t, serverNow) {
  const ms = toMs(t);
  if (ms === null || !serverNow) return '—';
  return `${fmtDuration(serverNow - ms)} ago`;
}

export function fmtV(v, digits = 1) {
  return v === null || v === undefined ? '—' : Number(v).toFixed(digits);
}

export function evLabel(id) {
  return `EV-${String(id).padStart(6, '0')}`;
}

// Value for <input type="datetime-local"> in local time.
export function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
