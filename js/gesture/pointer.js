// PointerController — turns raw landmark positions into a stable cursor and
// mediates every gesture-driven interaction with the DOM.
//
//  * exponential-moving-average smoothing (configurable)
//  * viewport-resize aware (CSS-pixel space, DPR-correct canvas)
//  * hover feedback on the deepest actionable element
//  * exactly one activation per pinch, never bubbling to a parent card
//  * pinch-drag on <input type="range"> dispatching input + change events
//  * pointer canvas is pointer-events:none, so normal mouse use is untouched

import { qsa } from '../core/dom.js';

export const ACTIONABLE_SELECTOR = [
  'button:not(:disabled)',
  'a[href]',
  'input:not(:disabled):not([type=range])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[role="button"]:not([aria-disabled="true"])',
  '[data-gesture-target]',
  '.track-item',
  '.contact-row',
  '.result-item',
  '.place-item',
  '.avatar-btn',
  '.swatch',
  '.seg-btn',
  '.range:not(:disabled)',
  '.leaflet-interactive',
].join(',');

export class PointerController {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.enabled = false;
    this.smoothing = 65;
    this.speed = 100;

    this.target = null;   // raw target (CSS px)
    this.pos = null;      // smoothed position (CSS px)
    this.present = false; // hand visible
    this.pinchClosed = false;
    this.hold = null;     // {gesture, progress}
    this.pose = 'none';
    this.confidence = 0;
    this.locked = false;
    this.paused = false;

    this.hoverEl = null;
    this.drag = null;     // {input, rect, min, max, step, changed}

    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.resize();
  }

  configure({ smoothing, speed } = {}) {
    if (smoothing !== undefined) this.smoothing = Number(smoothing);
    if (speed !== undefined) this.speed = Number(speed);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.clear();
      this.present = false;
      this.endDrag();
      this.clearHover();
    }
  }

  /** Feed a raw pointer position in CSS pixels (already mirrored/mapped). */
  setTarget(x, y) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const gain = Math.max(0.3, this.speed / 100);
    const tx = Math.min(window.innerWidth, Math.max(0, cx + (x - cx) * gain));
    const ty = Math.min(window.innerHeight, Math.max(0, cy + (y - cy) * gain));
    this.target = { x: tx, y: ty };
    if (!this.pos) this.pos = { x: tx, y: ty };
  }

  setGestureState({ present, pose, confidence, hold, pinchClosed, locked, paused } = {}) {
    if (present !== undefined) this.present = present;
    if (pose !== undefined) this.pose = pose;
    if (confidence !== undefined) this.confidence = confidence;
    if (hold !== undefined) this.hold = hold;
    if (locked !== undefined) this.locked = locked;
    if (paused !== undefined) this.paused = paused;
    if (pinchClosed !== undefined && pinchClosed !== this.pinchClosed) {
      this.pinchClosed = pinchClosed;
      if (pinchClosed) {
        // Snap the smoothed cursor to the raw target so a click lands exactly
        // where the user aimed, not where smoothing still lags behind.
        if (this.target) this.pos = { x: this.target.x, y: this.target.y };
        this.tryStartDrag();
      } else this.endDrag();
    }
  }

  /** Advance smoothing one step; call once per animation frame. */
  tick() {
    if (!this.target) return;
    const alpha = 1 - (this.smoothing / 100) * 0.92;
    this.pos.x += (this.target.x - this.pos.x) * alpha;
    this.pos.y += (this.target.y - this.pos.y) * alpha;
    if (this.pinchClosed && this.drag) this.updateDrag();
  }

  get position() { return this.pos || { x: 0, y: 0 }; }

  // ---------------------------------------------------------------- hit tests
  actionableAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    if (hit.closest('.range')) return hit.closest('.range');
    return hit.closest(ACTIONABLE_SELECTOR);
  }

  clearHover() {
    if (this.hoverEl) {
      this.hoverEl.classList.remove('g-hover');
      this.hoverEl = null;
    }
  }

  updateHover() {
    if (!this.enabled || !this.present || this.locked || !this.pos) {
      this.clearHover();
      return;
    }
    const el = this.actionableAt(this.pos.x, this.pos.y);
    if (el === this.hoverEl) return;
    this.clearHover();
    if (el && !this.isOverlayBlocked(el)) {
      el.classList.add('g-hover');
      this.hoverEl = el;
    }
  }

  /** Don't hover elements inside a hidden/closed container. */
  isOverlayBlocked(el) {
    const modal = el.closest('.modal, .call-overlay');
    if (modal && modal.hidden) return true;
    const drawer = el.closest('.drawer');
    if (drawer && drawer.hidden) return true;
    return false;
  }

  /**
   * One pinch = one activation on the deepest actionable element, so a button
   * inside a card never also triggers the card.
   * @returns {Element|null}
   */
  activate() {
    if (!this.pos || this.locked || this.paused) return null;
    const el = this.actionableAt(this.pos.x, this.pos.y);
    if (!el || this.isOverlayBlocked(el)) return null;

    if (el.matches('input[type=range]')) {
      this.writeRangeValue(el, this.pos.x);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el;
    }

    // Visual press feedback + real activation (works for keyboard-driven UI too).
    el.classList.add('g-pressed');
    setTimeout(() => el.classList.remove('g-pressed'), 140);
    if (el.matches('input, select, textarea')) {
      el.focus({ preventScroll: true });
    }
    el.click();
    return el;
  }

  // ------------------------------------------------------------ slider drag
  tryStartDrag() {
    if (this.drag || !this.pos || this.locked || this.paused) return;
    const el = this.actionableAt(this.pos.x, this.pos.y);
    if (el && el.matches('input[type=range]') && !this.isOverlayBlocked(el)) {
      this.drag = {
        input: el,
        min: Number(el.min || 0),
        max: Number(el.max || 100),
        step: Number(el.step || 1),
        changed: false,
      };
      el.classList.add('dragging');
      this.updateDrag();
    }
  }

  updateDrag() {
    if (!this.drag || !this.pos) return;
    this.writeRangeValue(this.drag.input, this.pos.x);
    this.drag.changed = true;
  }

  writeRangeValue(input, x) {
    const rect = input.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const step = Number(input.step || 1);
    let value = min + pct * (max - min);
    if (step > 0) value = Math.round(value / step) * step;
    value = Math.min(max, Math.max(min, value));
    const str = String(Math.round(value * 1000) / 1000);
    if (input.value !== str) {
      input.value = str;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  endDrag() {
    if (!this.drag) return;
    const { input, changed } = this.drag;
    input.classList.remove('dragging');
    if (changed) input.dispatchEvent(new Event('change', { bubbles: true }));
    this.drag = null;
  }

  // ----------------------------------------------------------------- drawing
  clear() {
    this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  draw(landmarks) {
    const { ctx } = this;
    this.clear();
    if (!this.enabled) return;

    if (landmarks && this.present) this.drawHand(landmarks);
    if (this.present && this.pos) this.drawCursor();
  }

  /** Current ambient colour (cached — read from CSS at most 4×/second). */
  ambientColor() {
    const now = performance.now();
    if (!this._ambAt || now - this._ambAt > 250) {
      this._ambAt = now;
      this._amb = getComputedStyle(document.documentElement).getPropertyValue('--ambient').trim() || '#38e0d0';
    }
    return this._amb;
  }

  drawCursor() {
    const { ctx, pos } = this;
    const r = 17;
    let color = this.ambientColor();
    if (this.locked) color = '#ffc86b';
    else if (this.paused) color = '#8a97a3';
    else if (this.pinchClosed) color = '#59e3a7';

    ctx.save();
    ctx.shadowBlur = 16;
    ctx.shadowColor = color;

    // outer ring
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = this.pinchClosed ? 3.5 : 2.2;
    ctx.globalAlpha = 0.95;
    ctx.stroke();

    // hold-progress arc (visual feedback for dwell gestures)
    if (this.hold && this.hold.progress > 0 && this.hold.progress < 1) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 7, -Math.PI / 2, -Math.PI / 2 + this.hold.progress * Math.PI * 2);
      ctx.strokeStyle = '#ffc86b';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // inner dot
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, this.pinchClosed ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 1;
    ctx.fill();
    ctx.shadowBlur = 0;

    // label
    const label = this.locked
      ? 'LOCKED — hold fist'
      : this.paused
        ? 'PAUSED — hold palm'
        : this.pose !== 'none' && this.pose !== 'point'
          ? `${this.pose} ${(this.confidence || 0).toFixed(2)}`
          : '';
    if (label) {
      ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
      const w = ctx.measureText(label).width + 16;
      const lx = Math.min(pos.x + 22, window.innerWidth - w - 6);
      const ly = Math.max(pos.y - 12, 14);
      ctx.fillStyle = 'rgba(8, 11, 14, 0.88)';
      ctx.beginPath();
      ctx.roundRect(lx, ly - 14, w, 22, 7);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(label, lx + 8, ly + 1);
    }
    ctx.restore();
  }

  drawHand(landmarks) {
    const { ctx } = this;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pt = (lm) => ({ x: lm.x * w, y: lm.y * h });

    ctx.save();
    // Hand skeleton follows the ambient lighting colour too.
    const amb = this.ambientColor();
    ctx.strokeStyle = this.withAlpha(amb, 0.55);
    ctx.lineWidth = 2;
    for (const [a, b] of HAND_LINES) {
      const p1 = pt(landmarks[a]);
      const p2 = pt(landmarks[b]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
    ctx.fillStyle = this.withAlpha(amb, 0.85);
    landmarks.forEach((lm, i) => {
      const p = pt(lm);
      ctx.beginPath();
      ctx.arc(p.x, p.y, i === 8 || i === 4 ? 4.5 : 2.6, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  /** Hex (#rgb/#rrggbb) → rgba() string with the given alpha. */
  withAlpha(hex, alpha) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return `rgba(56, 224, 208, ${alpha})`;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  destroy() {
    window.removeEventListener('resize', this._resize);
    this.clear();
  }
}

// Kept local to avoid a cross-module import cycle with the classifier.
const HAND_LINES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
