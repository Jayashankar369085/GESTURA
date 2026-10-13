// Small DOM helpers shared across modules.

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Keep a range input's webkit track fill in sync via the --fill variable. */
export function updateRangeFill(input) {
  if (!input || input.type !== 'range') return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const val = Number(input.value);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${pct.toFixed(2)}%`);
}

/** Attach the fill sync to a list of range inputs (call once at boot). */
export function bindRangeFills(inputs) {
  inputs.forEach((input) => {
    updateRangeFill(input);
    input.addEventListener('input', () => updateRangeFill(input));
  });
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm.padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
