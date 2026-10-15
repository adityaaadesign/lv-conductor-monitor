// Reads the demo/test scenarios from server/simulation/scenarios/*.json (laptop only).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareScenario } from './simulator.js';

export const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scenarios');

export function loadScenarios(dir = SCENARIO_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => prepareScenario(JSON.parse(readFileSync(path.join(dir, f), 'utf8')), f));
}
