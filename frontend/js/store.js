// Minimal shared state with publish/subscribe, plus the live connection to the server.

import { apiUrl, getJson } from './api.js';

export function createStore() {
  const listeners = new Map();
  const store = {
    config: null,
    topology: null,
    status: null,
    connection: 'connecting',
    lastStatusAt: null,
    on(topic, fn) {
      if (!listeners.has(topic)) listeners.set(topic, new Set());
      listeners.get(topic).add(fn);
      return () => listeners.get(topic).delete(fn);
    },
    emit(topic, data) {
      for (const fn of listeners.get(topic) ?? []) {
        try { fn(data); } catch (err) { console.error(`listener for ${topic} failed`, err); }
      }
    },
    setStatus(status) {
      store.status = status;
      store.lastStatusAt = Date.now();
      store.emit('status', status);
    },
    setConnection(state) {
      if (store.connection === state) return;
      store.connection = state;
      store.emit('connection', state);
    },
  };
  return store;
}

// Live updates. The laptop server pushes them (Server-Sent Events, reconnects by itself).
// The Cloudflare Worker cannot push, so /config says "poll": the page then asks for the
// status every interval_ms – and stops while the browser tab is hidden, to stay well
// inside the free request limit.
export function connectLive(store) {
  const lu = store.config?.live_updates;
  if (lu?.method === 'poll') return pollStatus(store, Math.max(2000, Number(lu.interval_ms) || 5000));
  const es = new EventSource(apiUrl('/stream'));
  es.onopen = () => store.setConnection('live');
  es.onerror = () => store.setConnection('reconnecting');
  es.addEventListener('status', (e) => {
    store.setConnection('live');
    store.setStatus(JSON.parse(e.data));
  });
  for (const kind of ['event_opened', 'event_updated', 'event_closed']) {
    es.addEventListener(kind, (e) => store.emit('events', { kind, ...JSON.parse(e.data) }));
  }
  es.addEventListener('history_cleared', () => store.emit('history_cleared'));
  return es;
}

function pollStatus(store, intervalMs) {
  let eventsVersion = store.status?.events_version ?? null;
  let timer = null;
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const s = await getJson('/status');
      store.setConnection('live');
      store.setStatus(s);
      if (s.events_version !== eventsVersion) {   // the event list changed on the server
        eventsVersion = s.events_version;
        store.emit('events', { kind: 'poll' });
      }
    } catch {
      store.setConnection('reconnecting');
    } finally {
      busy = false;
    }
  };
  const start = () => { if (!timer) { run(); timer = setInterval(run, intervalMs); } };
  const stop = () => { clearInterval(timer); timer = null; };
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  if (!document.hidden) start();
  return { close: stop };
}
