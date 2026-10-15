// A small stand-in for Cloudflare D1 (same method names) on top of Node's built-in SQLite,
// so the Worker can be tested without a Cloudflare account. Every call is asynchronous
// like real D1, so two requests can interleave the way they can on Cloudflare.
// It is NOT Cloudflare itself – the real D1 is only tested when you deploy.

import { DatabaseSync } from 'node:sqlite';

const tick = () => new Promise((r) => setImmediate(r));

function checkArgs(args) {
  for (const a of args) {
    if (a === undefined) throw new Error('D1_TYPE_ERROR: undefined cannot be bound');
    if (typeof a === 'boolean') throw new Error('D1 test double: bind 1/0 instead of booleans');
  }
}

class Statement {
  constructor(d1, sql, args = []) { this.d1 = d1; this.sql = sql; this.args = args; }
  bind(...args) { checkArgs(args); return new Statement(this.d1, this.sql, args); }
  #exec() {
    const st = this.d1.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)) return { results: st.all(...this.args), meta: {} };
    const r = st.run(...this.args);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  _run() { this.d1.calls++; return { success: true, ...this.#exec() }; }
  async first(col) {
    await tick();
    const row = this._run().results[0] ?? null;
    return col ? (row ? row[col] : null) : row;
  }
  async all() { await tick(); return this._run(); }
  async run() { await tick(); return this._run(); }
}

export class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.calls = 0;
    this.batches = 0;
    this.failedBatches = 0;
  }
  prepare(sql) { return new Statement(this, sql); }
  async exec(sql) { await tick(); this.db.exec(sql); }
  execSync(sql) { this.db.exec(sql); }
  // All statements in one transaction: all succeed, or nothing is changed.
  async batch(statements) {
    await tick();
    this.batches++;
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => s._run());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.failedBatches++;
      throw err;
    }
  }
  // test helper
  rows(sql, ...args) { return this.db.prepare(sql).all(...args); }
}
