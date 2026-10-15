// In-memory repository with the same methods as repository.js (SQLite).
// Used by the in-browser DEMO (frontend/js/demo-engine.js): simulated history lives only
// in the browser tab and is never sent anywhere. No file or database access.

import { EVENT_COLUMNS } from './repository.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const startOf = (e) => e.start_ts ?? e.created_ts;

export class MemoryRepo {
  constructor() { this.clearAll(); }

  clearAll() {
    this.events = [];
    this.timeline = [];
    this.transitionsList = [];
    this.meta = {};
    this.nextEventId = 1;
  }

  transaction(fn) { return fn(); }

  getMeta(key) { return this.meta[key] ?? null; }
  setMeta(key, value) { this.meta[key] = String(value); }
  audit() {}

  // Readings are not kept in the browser demo (the dashboard shows the current status only).
  insertMeasurements() {}
  lastValidPerNode() { return []; }
  latestSessions() { return []; }
  upsertSession() {}
  insertProtectionSnapshot() {}
  insertRejection() {}

  insertEvent(e, now) {
    const row = { event_id: this.nextEventId++, created_ts: now, updated_ts: now };
    for (const c of EVENT_COLUMNS) row[c] = clone(e[c]) ?? null;
    this.events.push(row);
    return row.event_id;
  }

  updateEvent(eventId, patch, now) {
    const row = this.events.find((x) => x.event_id === eventId);
    if (!row) return;
    for (const [k, v] of Object.entries(patch)) if (EVENT_COLUMNS.includes(k)) row[k] = clone(v) ?? null;
    row.updated_ts = now;
  }

  getEvent(eventId) {
    const row = this.events.find((x) => x.event_id === eventId);
    if (!row) return null;
    return {
      ...clone(row),
      timeline: this.timeline.filter((t) => t.event_id === eventId).map(({ ts, kind, details }) => ({ ts, kind, details: clone(details) })),
    };
  }

  getOpenEvents(source) { return this.events.filter((e) => e.status === 'OPEN' && e.source === source).map(clone); }

  insertTimeline(eventId, ts, kind, details) { this.timeline.push({ event_id: eventId, ts, kind, details: clone(details ?? {}) }); }

  // Same filters as eventFilterSql() in repository.js.
  queryEvents(f) {
    const q = f.q ? String(f.q).trim().toLowerCase() : null;
    const idMatch = q ? /^ev-?0*(\d+)$/i.exec(q) : null;
    const list = this.events.filter((e) => {
      if (e.source !== f.source) return false;
      if (f.from !== undefined && f.from !== null && startOf(e) < f.from) return false;
      if (f.to !== undefined && f.to !== null && startOf(e) > f.to) return false;
      if (f.type && e.event_type !== f.type) return false;
      if (f.severity && e.severity !== f.severity) return false;
      if (f.excludeInfo && e.severity === 'INFO') return false;
      if (f.status && e.status !== f.status) return false;
      if (f.node && !(e.node_ids ?? []).includes(f.node)) return false;
      if (idMatch) return e.event_id === Number(idMatch[1]);
      if (q) {
        const text = [e.event_type, e.affected_section, JSON.stringify(e.node_ids), JSON.stringify(e.detection_reason), JSON.stringify(e.details)]
          .join(' ').toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (startOf(b) - startOf(a)) || (b.event_id - a.event_id));
    const limit = Math.min(Math.max(1, Number(f.limit) || 50), 1000);
    const offset = Math.max(0, Number(f.offset) || 0);
    return { total: list.length, items: list.slice(offset, offset + limit).map(clone), limit, offset };
  }

  insertTransition(ts, from, to, reasons, source) {
    this.transitionsList.push({ ts, from_state: from, to_state: to, reason_codes: clone(reasons ?? []), source });
  }

  lastTransition(source) {
    const t = this.transitionsList.filter((x) => x.source === source).at(-1);
    return t ? { ts: t.ts, from_state: t.from_state, to_state: t.to_state } : null;
  }
}
