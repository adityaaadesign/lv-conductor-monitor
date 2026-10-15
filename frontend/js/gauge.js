// Semicircular voltage dial for the node cards (plain SVG, no library).
//
// Range and coloured bands come from the configuration (GET /api/v1/config), never from
// fixed numbers here:
//   range  : feeder.json gauge_min_v … gauge_max_v
//   bands  : "No supply" below loss_pickup_pu × nominal, "Low voltage" below uv_pickup_pu ×
//            nominal, "Normal" above (detection.json). All of these are placeholders until
//            the hardware team provides the real values.
// Without a valid reading the dial shows NO needle and NO number – only the status
// (Stale Data / Offline / No Data / Waiting). Missing data is never drawn as 0 V.

const CX = 100;
const CY = 92;
const R = 74;
const H = 142;   // viewBox height: dial on top, reading underneath

const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function gaugeSettings(config) {
  const nominal = config.nominal_voltage_v;
  const min = config.gauge?.min_v ?? 0;
  const max = config.gauge?.max_v ?? config.sensor_full_scale_v;
  const lossV = config.detection.loss_pickup_pu * nominal;
  const lowV = config.detection.uv_pickup_pu * nominal;
  const clip = (v) => Math.min(max, Math.max(min, v));
  const bands = [
    { kind: 'nosupply', label: 'No supply', from: min, to: clip(lossV) },
    { kind: 'low', label: 'Low voltage', from: clip(lossV), to: clip(lowV) },
    { kind: 'normal', label: 'Normal', from: clip(lowV), to: max },
  ].filter((b) => b.to > b.from);
  return { min, max, nominal, lossV, lowV, bands };
}

// Fraction 0..1 along the dial → point on the arc (0 = left end, 1 = right end).
function point(frac, r = R) {
  const a = Math.PI * (1 - frac);
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
}

function arc(f0, f1) {
  const [x0, y0] = point(f0);
  const [x1, y1] = point(f1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// value: the voltage to show, or null when there is no valid reading.
// statusLabel: the word shown in the middle when there is no reading.
export function gaugeSvg({ settings, value, label, statusLabel }) {
  const { min, max, nominal, bands } = settings;
  const frac = (v) => (Math.min(max, Math.max(min, v)) - min) / (max - min);
  const has = typeof value === 'number' && Number.isFinite(value);

  const bandPaths = bands.map((b) => `<path class="g-band g-${b.kind}" d="${arc(frac(b.from), frac(b.to))}"/>`).join('');
  let nominalTick = '';
  if (nominal > min && nominal < max) {
    const [x0, y0] = point(frac(nominal), R + 9);
    const [x1, y1] = point(frac(nominal), R + 16);
    nominalTick = `<line class="g-nominal" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`;
  }
  let needle = '';
  let centre;
  let aria;
  if (has) {
    const [nx, ny] = point(frac(value), R - 14);
    needle = `<line class="g-needle" x1="${CX}" y1="${CY}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"/><circle class="g-hub" cx="${CX}" cy="${CY}" r="5"/>`;
    centre = `<text class="g-value" x="${CX}" y="${CY + 42}" text-anchor="middle">${value.toFixed(1)}<tspan class="g-unit" dx="4">V</tspan></text>`;
    aria = `${label}: ${value.toFixed(1)} volts`;
  } else {
    // No needle: the status word sits inside the dial, the reading line says "— V".
    centre = `<text class="g-status" x="${CX}" y="${CY - 10}" text-anchor="middle">${esc(statusLabel)}</text>`
      + `<text class="g-value none" x="${CX}" y="${CY + 42}" text-anchor="middle">—<tspan class="g-unit" dx="4">V</tspan></text>`;
    aria = `${label}: no valid reading (${statusLabel})`;
  }
  const [lx, ly] = point(0, R);
  const [rx, ry] = point(1, R);
  return `<svg class="gauge${has ? '' : ' no-reading'}" viewBox="0 0 200 ${H}" role="img" aria-label="${esc(aria)}">`
    + `<path class="g-track" d="${arc(0, 1)}"/>${bandPaths}${nominalTick}${needle}${centre}`
    + `<text class="g-end" x="${lx.toFixed(1)}" y="${(ly + 14).toFixed(1)}" text-anchor="middle">${fmt(min)}</text>`
    + `<text class="g-end" x="${rx.toFixed(1)}" y="${(ry + 14).toFixed(1)}" text-anchor="middle">${fmt(max)} V</text>`
    + '</svg>';
}

export function gaugeLegend(settings) {
  const item = (b) => {
    const range = b.kind === 'normal' ? `≥ ${fmt(b.from)} V` : `${fmt(b.from)}–${fmt(b.to)} V`;
    return `<span class="g-key"><span class="g-swatch g-${b.kind}"></span>${esc(b.label)} ${range}</span>`;
  };
  return `${settings.bands.map(item).join('')}<span class="g-key"><span class="g-swatch g-nominal-key"></span>Nominal ${fmt(settings.nominal)} V</span>`
    + '<span class="g-note">Dial range and limits come from the configuration (placeholders until calibrated).</span>';
}
