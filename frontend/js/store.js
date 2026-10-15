// Minimal shared state with publish/subscribe, plus the live connection to the server.

import { apiUrl } from './api.js';

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

// Server-Sent Events: the browser reconnects automatically if the server goes away.
export function connectLive(store) {
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
