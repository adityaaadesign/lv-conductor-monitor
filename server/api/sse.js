// Server-Sent Events: one-way push of live status and event changes to the dashboard.
// Browsers reconnect automatically if the connection drops.

export class SseHub {
  constructor({ minIntervalMs = 300 } = {}) {
    this.clients = new Set();
    this.minIntervalMs = minIntervalMs;
    this.lastStatusSent = 0;
    this.pendingStatus = null;
    this.timer = null;
    this.heartbeat = setInterval(() => this.#write(': heartbeat\n\n'), 15000);
    this.heartbeat.unref?.();
  }

  handler() {
    return (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      this.clients.add(res);
      if (this.latestStatus) res.write(this.#frame('status', this.latestStatus));
      req.on('close', () => this.clients.delete(res));
    };
  }

  #frame(type, data) {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  #write(text) {
    for (const c of this.clients) c.write(text);
  }

  send(type, data) {
    this.#write(this.#frame(type, data));
  }

  // Status updates are throttled (the pipeline may evaluate many times per second);
  // the latest one is always delivered.
  pushStatus(status) {
    this.latestStatus = status;
    const now = Date.now();
    const wait = this.minIntervalMs - (now - this.lastStatusSent);
    if (wait <= 0) {
      this.lastStatusSent = now;
      this.send('status', status);
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.lastStatusSent = Date.now();
        this.send('status', this.latestStatus);
      }, wait);
      this.timer.unref?.();
    }
  }

  close() {
    clearInterval(this.heartbeat);
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}
