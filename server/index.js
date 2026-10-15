// Entry point.
//   npm run sim     → demo mode with simulated data (data/sim.db)
//   npm start       → live mode: accepts device reports on POST /api/v1/telemetry (data/live.db).
//                     Not yet tested with the real hardware.

import path from 'node:path';
import { loadConfig, loadDeviceKeys, ConfigError } from './config/load-config.js';
import { createServer } from './app.js';

// Settings can also come from environment variables (used on a hosting service):
//   APP_MODE   sim | live            (default sim; --mode on the command line wins)
//   PORT       port to listen on     (set automatically by most hosts)
//   HOST       address to listen on  (default 0.0.0.0 when PORT is set, otherwise server.json)
//   DATA_DIR   folder for the SQLite files (on Render: the persistent disk's mount path)
//   DEVICE_KEYS  controller keys for LIVE mode, e.g. CTRL-01=your-own-random-text
//   ALLOWED_ORIGINS  dashboard address(es) on another host, e.g. https://lv-conductor-monitor.vercel.app
//                    (several: separate with commas; no trailing slash)
const modeArg = process.argv.indexOf('--mode');
const mode = modeArg > -1 ? process.argv[modeArg + 1] : (process.env.APP_MODE || 'sim');
const portArg = process.argv.indexOf('--port');

let config;
let deviceKeys = {};
try {
  config = loadConfig();
  if (mode === 'live') deviceKeys = loadDeviceKeys();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error – server not started:\n  ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// --no-autostart: in demo mode, do not start the auto_start_scenario (useful to show
// that an open event survives a restart without the simulator immediately clearing it).
const autoStart = !process.argv.includes('--no-autostart');
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(config.projectRoot, config.server.data_dir);
const server = createServer({ config, mode, dataDir, autoStart, deviceKeys, allowedOrigins });
const port = portArg > -1 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT || config.server.port);
const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : config.server.host);

server.start(port, host).then((addr) => {
  const banner = mode === 'sim'
    ? 'DEMO MODE – SIMULATED DATA ONLY. No hardware is contacted.'
    : 'LIVE MODE – waiting for a device. Hardware integration has NOT yet been tested with the real ESP32.';
  console.log(`\n  LV Conductor Monitor  |  ${banner}`);
  console.log(`  Dashboard:  http://${addr.address === '0.0.0.0' ? 'localhost' : addr.address}:${addr.port}/`);
  console.log(`  Database:   ${server.dbPath}`);
  if (mode === 'live') {
    const ids = Object.keys(deviceKeys);
    console.log(ids.length
      ? `  Device input: POST /api/v1/telemetry accepts reports from ${ids.join(', ')} (with their keys).`
      : '  Device input: LOCKED – no DEVICE_KEYS variable or config/devices.local.json, so all device reports are refused.');
  }
  if (config.placeholders.length) {
    console.log(`  Note: ${config.placeholders.length} configuration values are unvalidated PLACEHOLDERS (see config/detection.json).`);
  }
  console.log('  Press Ctrl+C to stop.\n');
}).catch((err) => {
  console.error(`Could not start server: ${err.message}`);
  process.exit(1);
});

const shutdown = () => {
  console.log('\nStopping…');
  server.stop().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
