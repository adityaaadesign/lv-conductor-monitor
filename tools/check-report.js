// REPORT CHECKER – checks reports from the ESP32 (or any sender) against the data
// contract, using the SAME validator the server uses, and explains problems in plain English.
//
//   npm run check-report -- serial-log.txt
//   npm run check-report -- one-report.json
//
// Input can be: one JSON report, one report per line, or a copy of the ESP32 serial monitor
// (lines starting with "REPORT " are picked out; other lines are ignored).
// Besides each report's fields it checks the sequence: duplicates, gaps, boot_id reuse,
// report timing, and nodes that never report a valid reading.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../server/config/load-config.js';
import { validateReport } from '../server/ingest/validator.js';

const PROBLEM_TEXT = {
  MISSING_FIELD: 'is missing',
  NOT_A_NUMBER: 'must be a number (without quotes) or null',
  NOT_A_BOOLEAN: 'must be true or false',
  NOT_A_BOOLEAN_OR_NULL: 'must be true, false or null',
  NOT_AN_INTEGER: 'must be a whole number',
  NOT_AN_INTEGER_OR_NULL: 'must be a whole number or null',
  NOT_A_NON_NEGATIVE_INTEGER: 'must be a whole number, 0 or more',
  NOT_A_POSITIVE_INTEGER: 'must be a whole number above 0',
  NOT_A_STRING_OR_NULL: 'must be text or null',
  NOT_A_SHORT_STRING_OR_NULL: 'must be short text (max 64 characters) or null',
  UNKNOWN_ENUM: 'has a value that is not allowed (see docs/HARDWARE_INTEGRATION.md)',
  NOT_CONFIGURED: 'is not listed in config/feeder.json',
  INVALID_ID: 'must use only capital letters, digits, "-" or "_" (max 32)',
  INVALID_BOOT_ID: 'must be 1–32 letters/digits',
  UNSUPPORTED_VERSION: 'must be "1.0"',
  MUST_BE_NON_EMPTY_ARRAY: 'must be a list with 1–32 node entries',
  DUPLICATE_NODE: 'appears twice in the same report',
  NOT_AN_OBJECT: 'must be a JSON object',
  NOT_AN_ARRAY: 'must be a list',
};

// Pull the JSON reports out of whatever text was given.
export function extractReports(input) {
  // Files saved by Windows tools often start with an invisible byte-order mark.
  const text = input.replace(/^﻿/, '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try { return [{ line: 1, raw: JSON.parse(trimmed) }]; } catch { /* fall through: one per line */ }
  }
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const brace = line.indexOf('{');
    if (brace < 0) return;
    if (!line.startsWith('REPORT ') && !line.trimStart().startsWith('{') && !/^\d+ \{/.test(line)) return;
    try {
      out.push({ line: i + 1, raw: JSON.parse(line.slice(brace)) });
    } catch (err) {
      out.push({ line: i + 1, raw: null, parseError: err.message });
    }
  });
  return out;
}

export function checkReports(text, config) {
  const items = extractReports(text);
  const results = [];
  const warnings = [];
  const seen = new Set();
  const nodeStats = new Map(config.topology.orderedNodeIds.map((id) => [id, { valid: 0, invalid: 0, reasons: new Set(), seen: 0 }]));
  let prev = null;
  const bootIds = [];

  for (const it of items) {
    if (it.parseError) {
      results.push({ line: it.line, ok: false, errors: [`not valid JSON (${it.parseError}) – check quotes, commas and brackets`] });
      continue;
    }
    const v = validateReport(it.raw, config, Date.now());
    const errors = v.ok ? [] : (v.details ?? []).map((d) => `${d.field} ${PROBLEM_TEXT[d.problem] ?? d.problem}`);
    if (!v.ok && v.error === 'UNKNOWN_CONTROLLER') errors.splice(0, errors.length, `controller_id "${it.raw.controller_id}" is not listed in config/feeder.json`);
    if (v.ok) for (const rn of v.rejectedNodes) errors.push(`node "${rn.node_id}" ${rn.reason === 'UNKNOWN_NODE' ? 'is not listed in config/feeder.json' : 'belongs to a different controller in config/feeder.json'}`);
    results.push({ line: it.line, ok: errors.length === 0, errors, sequence: it.raw?.sequence_number });
    if (!v.ok) continue;

    const r = v.report;
    const key = `${r.controller_id}:${r.boot_id}:${r.sequence_number}`;
    if (seen.has(key)) warnings.push(`line ${it.line}: duplicate report (same boot_id and sequence_number ${r.sequence_number}) – the server will ignore it`);
    seen.add(key);
    if (!bootIds.includes(r.boot_id)) bootIds.push(r.boot_id);

    if (prev && prev.controller_id === r.controller_id) {
      if (prev.boot_id === r.boot_id) {
        if (r.sequence_number <= 2 && prev.sequence_number > r.sequence_number + 5 && r.uptime_ms < prev.uptime_ms) {
          // Sequence restarted from the beginning without a new boot_id.
          warnings.push(`line ${it.line}: sequence went back to ${r.sequence_number} with the SAME boot_id "${r.boot_id}". The boot_id must be new and random at every power-up, otherwise the server treats new reports as old ones.`);
        } else if (r.sequence_number < prev.sequence_number) {
          warnings.push(`line ${it.line}: older report (sequence ${r.sequence_number} after ${prev.sequence_number}) – fine for a backlog after reconnecting; the server stores it as history only`);
        } else if (r.sequence_number > prev.sequence_number + 1) {
          warnings.push(`line ${it.line}: ${r.sequence_number - prev.sequence_number - 1} report(s) missing before sequence ${r.sequence_number}`);
        }
        const gap = r.uptime_ms - prev.uptime_ms;
        if (gap > r.report_interval_ms * 1.5) warnings.push(`line ${it.line}: ${gap} ms since the previous report (expected about ${r.report_interval_ms} ms)`);
      }
    }
    prev = r;

    for (const n of v.nodes) {
      const s = nodeStats.get(n.node_id);
      s.seen++;
      if (n.validity === 'VALID') s.valid++; else { s.invalid++; s.reasons.add(n.sensor_status === 'OK' ? n.invalid_reason : n.sensor_status); }
    }
    if (r.protection === null) warnings.push(`line ${it.line}: "protection" is null – the dashboard will show the shutdown state as unknown`);
  }

  for (const [id, s] of nodeStats) {
    if (!results.some((x) => x.ok)) break;
    if (s.seen === 0) warnings.push(`node ${id} (in config/feeder.json) never appears in the reports`);
    else if (s.valid === 0) warnings.push(`node ${id} never had a valid reading (${[...s.reasons].join(', ')}) – check wiring, sensor power and calibration`);
  }
  const fb = items.filter((i) => i.raw?.protection?.switches?.[0]).map((i) => i.raw.protection.switches[0].feedback);
  if (fb.length && fb.every((f) => f === 'NOT_FITTED')) warnings.push('switch feedback is always NOT_FITTED – the dashboard can never show "Shutdown confirmed by feedback"');
  return {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    results,
    warnings: [...new Set(warnings)],
    bootIds,
    nodeStats: Object.fromEntries([...nodeStats].map(([id, s]) => [id, { valid: s.valid, invalid: s.invalid, reasons: [...s.reasons] }])),
  };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.log('Usage: npm run check-report -- <file>   (one report, one per line, or a serial-monitor log)');
    process.exit(1);
  }
  const text = readFileSync(file, 'utf8');
  const res = checkReports(text, loadConfig());
  if (res.total === 0) {
    console.log('No reports found. Paste lines starting with "REPORT {" or a JSON report.');
    process.exit(1);
  }
  console.log(`Checked ${res.total} report(s): ${res.passed} accepted, ${res.total - res.passed} refused.\n`);
  for (const r of res.results.filter((x) => !x.ok).slice(0, 20)) {
    console.log(`✗ line ${r.line}${r.sequence !== undefined ? ` (sequence ${r.sequence})` : ''}:`);
    for (const e of r.errors) console.log(`    - ${e}`);
  }
  if (res.warnings.length) {
    console.log('\nThings to look at:');
    for (const w of res.warnings.slice(0, 30)) console.log(`  ! ${w}`);
  }
  console.log('\nPer node (valid / invalid readings):');
  for (const [id, s] of Object.entries(res.nodeStats)) console.log(`  ${id}: ${s.valid} / ${s.invalid}${s.reasons.length ? `  (${s.reasons.join(', ')})` : ''}`);
  if (res.bootIds.length > 1) console.log(`\nThe controller restarted ${res.bootIds.length - 1} time(s) in this log (${res.bootIds.length} different boot_ids).`);
  process.exit(res.passed === res.total ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
