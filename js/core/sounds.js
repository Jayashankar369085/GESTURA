// WebAudio sound engine — UI blips, volume ticks and the simulated ringtone.
// No audio files are fetched; everything is synthesised locally.

import { on } from './events.js';

let ctx = null;
let enabled = true;
let ringNodes = null;

function ensureCtx() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  } catch (err) {
    console.warn('[sounds] AudioContext unavailable:', err);
    ctx = null;
  }
  return ctx;
}

/** Resume the context from a user gesture (autoplay policy). */
export function unlockAudio() {
  const c = ensureCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export function setSoundsEnabled(on_) {
  enabled = !!on_;
  if (!enabled) stopRing();
}

function tone({ freq = 660, dur = 0.07, type = 'sine', gain = 0.05, when = 0 }) {
  const c = ensureCtx();
  if (!c || !enabled) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const t0 = c.currentTime + when;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

export function click() { tone({ freq: 880, dur: 0.05, type: 'triangle', gain: 0.045 }); }
export function tick() { tone({ freq: 1180, dur: 0.03, type: 'square', gain: 0.02 }); }
export function back() { tone({ freq: 520, dur: 0.07, type: 'triangle', gain: 0.04 }); }
export function error() { tone({ freq: 220, dur: 0.16, type: 'sawtooth', gain: 0.04 }); }
export function ok() { tone({ freq: 740, dur: 0.06, type: 'sine', gain: 0.05 }); tone({ freq: 988, dur: 0.09, type: 'sine', gain: 0.05, when: 0.07 }); }

/** Soft ascending/descending pair when the volume changes by gesture. */
export function volumeTick(up) {
  tone({ freq: up ? 920 : 620, dur: 0.05, type: 'sine', gain: 0.035 });
}

/**
 * Simulated ringtone: a repeating two-tone pattern.
 * Started by a user action (Simulate button) or after the audio unlock,
 * so autoplay restrictions are respected.
 */
export function startRing() {
  stopRing();
  const c = ensureCtx();
  if (!c) return false;
  if (c.state === 'suspended') c.resume().catch(() => {});
  if (!enabled) return false;

  const master = c.createGain();
  master.gain.value = 0.0001;
  master.connect(c.destination);
  master.gain.exponentialRampToValueAtTime(0.07, c.currentTime + 0.05);

  let step = 0;
  const timer = setInterval(() => {
    const t = c.currentTime;
    const freq = step % 2 === 0 ? 440 : 554.37;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.36);
    step += 1;
  }, 420);

  ringNodes = { timer, master };
  return true;
}

export function stopRing() {
  if (!ringNodes) return;
  clearInterval(ringNodes.timer);
  try {
    const { master } = ringNodes;
    const c = ctx;
    if (c && master) {
      master.gain.cancelScheduledValues(c.currentTime);
      master.gain.setValueAtTime(master.gain.value, c.currentTime);
      master.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.08);
      setTimeout(() => { try { master.disconnect(); } catch { /* noop */ } }, 200);
    }
  } catch { /* noop */ }
  ringNodes = null;
}

/** Two short beeps that a call has ended. */
export function endBeep() {
  tone({ freq: 500, dur: 0.1, type: 'triangle', gain: 0.05 });
  tone({ freq: 360, dur: 0.16, type: 'triangle', gain: 0.05, when: 0.12 });
}

// Unlock on the first interaction anywhere so scheduled demo calls can ring.
function unlockOnce() {
  unlockAudio();
  window.removeEventListener('pointerdown', unlockOnce);
  window.removeEventListener('keydown', unlockOnce);
}
window.addEventListener('pointerdown', unlockOnce, { once: false });
window.addEventListener('keydown', unlockOnce, { once: false });

// Keep the ringtone in sync with the sound setting.
on('settings:changed', ({ key, value }) => {
  if (key === 'sounds') setSoundsEnabled(value);
});

// Safety: never let a ringtone outlive a page hide.
window.addEventListener('pagehide', stopRing);
