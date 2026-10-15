// The voltage dial on the node cards (frontend/js/gauge.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gaugeSettings, gaugeSvg, gaugeLegend } from '../../frontend/js/gauge.js';
import { configBody } from '../../server/api/helpers.js';
import { testConfig } from '../helpers.js';

const pageConfig = (overrides) => configBody(testConfig(overrides), { mode: 'live', source: 'LIVE' });

test('range and bands come from the configuration', () => {
  const g = gaugeSettings(pageConfig());
  assert.equal(g.min, 0);
  assert.equal(g.max, 300);
  assert.deepEqual(g.bands.map((b) => [b.kind, Math.round(b.from), Math.round(b.to)]),
    [['nosupply', 0, 23], ['low', 23, 207], ['normal', 207, 300]]);

  // A low-voltage demonstration circuit: everything follows the config, nothing assumes 230 V.
  const small = gaugeSettings(pageConfig({ feeder: { nominal_voltage_v: 12, sensor_full_scale_v: 20, gauge_max_v: 15 } }));
  assert.equal(small.max, 15);
  assert.deepEqual(small.bands.map((b) => [b.kind, +b.from.toFixed(1), +b.to.toFixed(1)]),
    [['nosupply', 0, 1.2], ['low', 1.2, 10.8], ['normal', 10.8, 15]]);
  assert.match(gaugeSvg({ settings: small, value: 12.1, label: 'Node A', statusLabel: 'Online' }), />15\.0 V</);
});

test('a valid reading shows the needle and the value with its unit', () => {
  const g = gaugeSettings(pageConfig());
  const svg = gaugeSvg({ settings: g, value: 229.14, label: 'Node A', statusLabel: 'Online' });
  assert.match(svg, /class="g-needle"/);
  assert.match(svg, />229\.1<tspan class="g-unit" dx="4">V<\/tspan>/);
  assert.match(svg, /aria-label="Node A: 229\.1 volts"/);
  // A measured 0 V is a real reading (no supply) and is shown as such.
  const zero = gaugeSvg({ settings: g, value: 0, label: 'Node B', statusLabel: 'Online' });
  assert.match(zero, /class="g-needle"/);
  assert.match(zero, />0\.0<tspan/);
});

test('no valid reading: no needle, no number, the status is shown instead (never 0 V)', () => {
  const g = gaugeSettings(pageConfig());
  for (const status of ['Stale Data', 'Offline', 'No Data', 'Waiting']) {
    const svg = gaugeSvg({ settings: g, value: null, label: 'Node C', statusLabel: status });
    assert.doesNotMatch(svg, /g-needle/);
    assert.match(svg, /class="g-value none"[^>]*>—</);
    assert.match(svg, new RegExp(`class="g-status"[^>]*>${status}<`));
    assert.doesNotMatch(svg, /class="g-value"[^>]*>0/);
    assert.match(svg, /no-reading/);
    assert.match(svg, new RegExp(`aria-label="Node C: no valid reading \\(${status}\\)"`));
  }
});

test('a reading above the dial range keeps the needle at the end but shows the real value', () => {
  const g = gaugeSettings(pageConfig({ feeder: { gauge_max_v: 250 } }));
  const svg = gaugeSvg({ settings: g, value: 260, label: 'Node A', statusLabel: 'Online' });
  assert.match(svg, />260\.0<tspan/);
  const [, x2, y2] = /class="g-needle" x1="100" y1="92" x2="([\d.]+)" y2="([\d.]+)"/.exec(svg);
  assert.ok(Number(x2) >= 159 && Math.abs(Number(y2) - 92) < 1, 'needle at the right end');
});

test('legend names the bands and says the limits are configuration placeholders', () => {
  const html = gaugeLegend(gaugeSettings(pageConfig()));
  assert.match(html, /No supply 0\.0–23\.0 V/);
  assert.match(html, /Low voltage 23\.0–207 V/);
  assert.match(html, /Normal ≥ 207 V/);
  assert.match(html, /placeholders/);
});

test('an impossible dial range is refused when the configuration loads', () => {
  assert.throws(() => testConfig({ feeder: { gauge_min_v: 100, gauge_max_v: 50 } }), /gauge_max_v/);
});
