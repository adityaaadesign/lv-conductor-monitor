// Clocks. Processing code never calls Date.now() directly; it is handed "now" by
// whoever drives it. That is what makes simulation and tests deterministic.
// All times are epoch milliseconds (numbers). They are converted to ISO 8601 strings
// only at the API boundary (see toIso).

export class RealClock {
  now() { return Date.now(); }
}

// Manually advanced clock for tests and headless scenario runs.
export class ManualClock {
  constructor(start) { this.t = start; }
  now() { return this.t; }
  set(t) {
    if (t < this.t) throw new Error('ManualClock cannot go backwards');
    this.t = t;
  }
}

// Simulated clock for demo mode: runs at `speed` times real time and never goes
// backwards, even when the speed is changed. Because a faster speed makes simulated
// time run ahead of real time, the server passes `resumeAfter` (the latest timestamp
// already stored) so a restart never produces timestamps older than existing history.
export class ScaledClock {
  constructor(speed = 1, resumeAfter = null) {
    this.speed = speed;
    this.baseReal = Date.now();
    this.baseSim = resumeAfter !== null ? Math.max(this.baseReal, resumeAfter + 1000) : this.baseReal;
  }
  now() { return Math.floor(this.baseSim + (Date.now() - this.baseReal) * this.speed); }
  setSpeed(speed) {
    this.baseSim = this.now();
    this.baseReal = Date.now();
    this.speed = speed;
  }
}

export function toIso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}
