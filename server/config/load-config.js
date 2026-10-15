// Loads and validates config/feeder.json, config/detection.json and config/server.json.
// The server refuses to start with an inconsistent configuration rather than guessing.
// The checks themselves live in build-config.js (shared with the Cloudflare Worker).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError, buildConfig, parseDeviceKeys, checkDeviceKeys,
} from './build-config.js';

export {
  ConfigError, unwrapPlaceholders, validateDetection, buildTopology, buildConfig, parseDeviceKeys, timingOverrides,
} from './build-config.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_CONFIG_DIR = path.join(PROJECT_ROOT, 'config');

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read ${file}: ${err.message}`);
  }
}

// Secret keys that real controllers must send with each report (LIVE mode only).
// File: config/devices.local.json – never committed (see config/devices.example.json).
// Returns {} when the file does not exist, which keeps the real-device input locked.
// On a hosting service, set the environment variable DEVICE_KEYS instead of the file:
//   DEVICE_KEYS=CTRL-01=your-own-random-text   (several: separate with commas)
// The environment variable wins over the file when both exist.
export function loadDeviceKeys(dir = DEFAULT_CONFIG_DIR, env = process.env) {
  if (env.DEVICE_KEYS && env.DEVICE_KEYS.trim()) return parseDeviceKeys(env.DEVICE_KEYS);
  const file = path.join(dir, 'devices.local.json');
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new ConfigError(`Cannot read ${file}: ${err.message}`);
  }
  return checkDeviceKeys(raw, 'devices.local.json');
}

// overrides: { feeder: {...}, detection: {...}, server: {...} } merged over the files
// (used by tests to change a threshold without editing config files).
export function loadConfig({ dir = DEFAULT_CONFIG_DIR, overrides = {} } = {}) {
  const files = {
    feeder: readJson(path.join(dir, 'feeder.json')),
    detection: readJson(path.join(dir, 'detection.json')),
    server: readJson(path.join(dir, 'server.json')),
  };
  return buildConfig(files, overrides, PROJECT_ROOT);
}
