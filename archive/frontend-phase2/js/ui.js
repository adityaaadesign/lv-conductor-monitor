// Small HTML builders shared by the pages.

import { TONE_ICON, REASON_TEXT } from '/shared/labels.js';
import { esc } from './format.js';

// Status badge: colour + icon shape + text, so colour is never the only cue.
export function badge(text, tone = 'grey', title = '') {
  return `<span class="badge tone-${tone}"${title ? ` title="${esc(title)}"` : ''}><span class="ico" aria-hidden="true">${TONE_ICON[tone] ?? '◌'}</span>${esc(text)}</span>`;
}

export function infoBadge(map, key, fallbackTone = 'grey') {
  const info = map[key];
  return badge(info?.label ?? key ?? '—', info?.tone ?? fallbackTone);
}

export function simTag(source) {
  return source === 'SIMULATED' ? '<span class="sim-tag" title="Simulated data – not a hardware measurement">SIM</span>' : '';
}

export function placeholderTag() {
  return '<span class="placeholder-tag" title="Unvalidated placeholder value – set from measurements before testing">PLACEHOLDER</span>';
}

export function progressBar(fraction, done = false) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return `<div class="progress${done ? ' done' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(0)}"><span style="width:${pct.toFixed(1)}%"></span></div>`;
}

export function reasonChips(codes) {
  return `<div class="chips">${(codes ?? []).map((c) => `<span class="chip" title="${esc(REASON_TEXT[c] ?? c)}">${esc(c)}</span>`).join('')}</div>`;
}

export function errorBox(message) {
  return `<div class="error-box" role="alert">${esc(message)}</div>`;
}
