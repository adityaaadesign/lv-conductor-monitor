// What the in-browser DEMO (frontend/js/demo-engine.js) needs, in ONE list used by both the
// laptop server (server/app.js) and the Vercel build (tools/build-frontend.js).
// Only processing/simulation code and the three non-secret config files – never
// config/devices.local.json or anything else from the server.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadScenarios } from './simulation/scenario-files.js';

// Modules the browser loads (paths relative to the project folder, served at the same path).
export const BROWSER_MODULES = [
  'server/processing/pipeline.js',
  'server/processing/node-monitor.js',
  'server/processing/localization.js',
  'server/processing/feeder-state.js',
  'server/processing/event-manager.js',
  'server/processing/status-builder.js',
  'server/ingest/validator.js',
  'server/domain/clock.js',
  'server/simulation/simulator.js',
  'server/simulation/feeder-physics.js',
  'server/simulation/virtual-controller.js',
  'server/config/build-config.js',
  'server/api/helpers.js',
  'server/api/csv.js',
  'server/storage/memory-repo.js',
  'server/storage/repository.js',
];

// Data files served at /demo/<name>.
export function demoDataFiles(projectRoot) {
  const json = (f) => JSON.parse(readFileSync(path.join(projectRoot, 'config', f), 'utf8'));
  return {
    'feeder.json': json('feeder.json'),
    'detection.json': json('detection.json'),
    'server.json': json('server.json'),
    'scenarios.json': loadScenarios(),
  };
}
