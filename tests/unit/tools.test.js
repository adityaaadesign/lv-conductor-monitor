// Integration-day helpers: the report checker and the calibration helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReports, extractReports } from '../../tools/check-report.js';
import { summarise, advice } from '../../tools/calibrate.js';
import { testConfig, makeReport, protection } from '../helpers.js';

const config = testConfig();
const NORMAL = { 'N-A': 229, 'N-B': 227, 'N-C': 226 };
const line = (r) => `REPORT ${JSON.stringify(r)}`;

test('check-report: reads a serial-monitor log and ignores other lines', () => {
  const log = ['LV feeder controller – firmware skeleton', 'WARNING: something', line(makeReport({ seq: 0, nodes: NORMAL, protection: protection() })),
    line(makeReport({ seq: 1, nodes: NORMAL, protection: protection() }))].join('\n');
  assert.equal(extractReports(log).length, 2);
  assert.equal(extractReports(`﻿${log}`).length, 2, 'a Windows byte-order mark must not hide the first report');
  assert.equal(extractReports(`﻿1000 ${JSON.stringify(makeReport({ nodes: NORMAL }))}`).length, 1);
  const res = checkReports(log, config);
  assert.equal(res.total, 2);
  assert.equal(res.passed, 2);
});

test('check-report: explains invalid fields in plain English', () => {
  const bad = makeReport({ nodes: NORMAL, protection: protection() });
  bad.nodes[0].voltage_rms = '229';
  delete bad.nodes[1].data_valid;
  bad.nodes.push({ node_id: 'N-Z', voltage_rms: 229, supply_present: true, data_valid: true, sensor_status: 'OK' });
  const res = checkReports(JSON.stringify(bad), config);
  assert.equal(res.passed, 0);
  const errs = res.results[0].errors.join(' | ');
  assert.match(errs, /nodes\[0\]\.voltage_rms must be a number/);
  assert.match(errs, /nodes\[1\]\.data_valid is missing/);
  const unknown = checkReports(JSON.stringify(makeReport({ nodes: { ...NORMAL, 'N-Z': 229 }, protection: protection() })), config);
  assert.match(unknown.results[0].errors[0], /N-Z" is not listed in config\/feeder\.json/);
  assert.match(checkReports('REPORT {"controller_id": oops}', config).results[0].errors[0], /not valid JSON/);
});

test('check-report: warns about boot_id reuse, missing reports and duplicates', () => {
  const reports = [
    makeReport({ seq: 0, boot: 'samebootX', uptime: 1000, nodes: NORMAL, protection: protection() }),
    makeReport({ seq: 1, boot: 'samebootX', uptime: 2000, nodes: { ...NORMAL, 'N-C': { voltage_rms: null, data_valid: false, sensor_status: 'NO_SIGNAL_REFERENCE' } }, protection: protection() }),
    makeReport({ seq: 9, boot: 'samebootX', uptime: 10000, nodes: { ...NORMAL, 'N-C': { voltage_rms: null, data_valid: false, sensor_status: 'NO_SIGNAL_REFERENCE' } }, protection: protection() }),
    makeReport({ seq: 0, boot: 'samebootX', uptime: 1000, nodes: NORMAL, protection: protection() }),   // restarted, same boot_id
  ];
  const res = checkReports(reports.map(line).join('\n'), config);
  const w = res.warnings.join(' | ');
  assert.match(w, /7 report\(s\) missing before sequence 9/);
  assert.match(w, /SAME boot_id/);
  assert.match(w, /duplicate report/, 'the restarted seq 0 collides with the first one');
});

test('check-report: an older backlog report after reconnect is NOT reported as boot_id reuse', () => {
  const reports = [20, 21, 15, 16].map((seq) => makeReport({ seq, boot: 'bootY1', uptime: (seq + 1) * 1000, nodes: NORMAL, protection: protection() }));
  const w = checkReports(reports.map(line).join('\n'), config).warnings.join(' | ');
  assert.doesNotMatch(w, /SAME boot_id/);
  assert.match(w, /backlog/);
});

test('check-report: feedback never fitted and missing protection are pointed out', () => {
  const r = makeReport({ nodes: NORMAL, protection: protection({ feedback: 'NOT_FITTED' }) });
  assert.match(checkReports(JSON.stringify(r), config).warnings.join(' '), /always NOT_FITTED/);
  const none = makeReport({ nodes: NORMAL, protection: null });
  assert.match(checkReports(JSON.stringify(none), config).warnings.join(' '), /"protection" is null/);
});

// ---- calibration helper --------------------------------------------------------------------
const rows = (id, values, extra = {}) => values.map((v) => ({ node_id: id, voltage_rms: v, voltage_rms_min: v, validity: 'VALID', invalid_reason: null, ...extra }));

test('calibrate: computes voltsPerCount from a multimeter reference', () => {
  const stats = summarise(rows('N-A', [459, 460, 461]), ['N-A']);
  const res = advice(stats, { expect: 'on', references: { 'N-A': 230 }, factor: 1.0 }, config);
  const r = res.find((l) => l.level === 'RESULT');
  assert.match(r.text, /voltsPerCount = 0\.50000/);
});

test('calibrate: first calibration can use raw-count readings the server refused as out of range', () => {
  const raw = rows('N-A', [460, 461, 459], { validity: 'INVALID', invalid_reason: 'OUT_OF_RANGE' });
  assert.equal(summarise(raw, ['N-A'])['N-A'].mean, null, 'normal checks never use refused readings');
  const stats = summarise(raw, ['N-A'], { acceptOutOfRange: true });
  const r = advice(stats, { expect: null, references: { 'N-A': 230 }, factor: 1.0 }, config).find((l) => l.level === 'RESULT');
  assert.match(r.text, /voltsPerCount = 0\.50000/);
  const sensorFault = rows('N-A', [460], { validity: 'INVALID', invalid_reason: 'SENSOR_FAULT' });
  assert.equal(summarise(sensorFault, ['N-A'], { acceptOutOfRange: true })['N-A'].mean, null, 'sensor faults are never used');
});

test('calibrate: supply ON – readings below the low-voltage limit give a warning', () => {
  const stats = summarise([...rows('N-A', [228, 229, 230]), ...rows('N-B', [212, 200, 215])], ['N-A', 'N-B']);
  const res = advice(stats, { expect: 'on' }, config);
  assert.equal(res.find((l) => l.node === 'N-A').level, 'OK');
  assert.equal(res.find((l) => l.node === 'N-B').level, 'WARN');
});

test('calibrate: supply OFF – a noise floor above the "no supply" limit fails', () => {
  const stats = summarise([...rows('N-A', [0.4, 0.9, 0.6]), ...rows('N-B', [30, 31, 29])], ['N-A', 'N-B']);
  const res = advice(stats, { expect: 'off' }, config);
  assert.equal(res.find((l) => l.node === 'N-A').level, 'OK');
  assert.equal(res.find((l) => l.node === 'N-B').level, 'FAIL');
});

test('calibrate: a node with only invalid readings is reported, not averaged', () => {
  const stats = summarise(rows('N-C', [null], { validity: 'INVALID', invalid_reason: 'SENSOR_FAULT' }), ['N-C']);
  assert.equal(stats['N-C'].mean, null);
  assert.equal(advice(stats, { expect: 'on' }, config)[0].level, 'FAIL');
});
