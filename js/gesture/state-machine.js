// GestureStateMachine — pure timing/hysteresis logic. No DOM, no camera.
//
// Responsibilities:
//   * confidence gating (ambiguous frames do nothing)
//   * pinch enter/exit hysteresis → exactly one `click` per pinch
//   * temporal stability (N consecutive frames) before any action
//   * dwell timers for hold gestures + visual progress reporting
//   * per-action cooldowns and entry/exit latches so a gesture held across
//     many frames never re-fires (except configured repeats: volume)
//
// `update()` is called once per processed frame with `now` in milliseconds.

import { GESTURE_BY_ID } from './config.js';

const HOLDABLE = new Set(['palm', 'fist', 'v_sign', 'three_finger', 'point_down']);
// Consecutive frames the pinch distance must stay under the enter threshold
// before a click fires — rejects single-frame jitter while staying instant
// enough to feel direct (2 frames ≈ 66 ms at 30 FPS).
const PINCH_CONFIRM_FRAMES = 2;

/**
 * Global gating applied before any action is dispatched:
 *  * gesture lock   → only the lock toggle passes
 *  * paused interaction → only pause/lock toggles pass
 *  * pointer frames and empty actions → never dispatched
 * Returns the action to run, or null to suppress it.
 */
export function gateAction(action, { locked = false, paused = false } = {}) {
  if (!action || action === 'pointer') return null;
  if (locked && action !== 'toggle_lock') return null;
  if (paused && action !== 'toggle_pause' && action !== 'toggle_lock') return null;
  return action;
}

export class GestureStateMachine {
  constructor(opts = {}) {
    this.minConfidence = opts.minConfidence ?? 0.5;
    this.stableFrames = opts.stableFrames ?? 3;
    this.pinchEnter = opts.pinchEnter ?? 0.34;
    this.pinchExit = opts.pinchExit ?? 0.53;
    this.dwellScale = opts.dwellScale ?? 1;
    this.isEnabled = opts.isEnabled || (() => true);
    this.candidate = null;
    this.candidateSince = 0;
    this.frames = 0;
    this.latched = new Map(); // gesture -> true (must exit before refire)
    this.cooldownUntil = new Map();
    this.lastFire = new Map();
    this.pinchClosed = false;
    this.pinchStable = 0; // consecutive frames below the enter threshold
    this.pauseWindowStart = 0; // used to clear dwell after ambiguous gaps
  }

  /** Update tuning when sensitivity/dwell settings change. */
  configure({ minConfidence, pinchEnter, pinchExit, dwellScale, stableFrames } = {}) {
    if (minConfidence !== undefined) this.minConfidence = minConfidence;
    if (pinchEnter !== undefined) this.pinchEnter = pinchEnter;
    if (pinchExit !== undefined) this.pinchExit = pinchExit;
    if (dwellScale !== undefined) this.dwellScale = dwellScale;
    if (stableFrames !== undefined) this.stableFrames = stableFrames;
  }

  reset() {
    this.candidate = null;
    this.candidateSince = 0;
    this.frames = 0;
    this.latched.clear();
    this.cooldownUntil.clear();
    this.lastFire.clear();
    this.pinchClosed = false;
    this.pinchStable = 0;
  }

  /**
   * @param {object} frame { pose, confidence, pinchRatio, swipe, handPresent }
   * @param {number} now performance.now()
   * @returns {{events:Array, hold:{gesture:string,progress:number}|null,
   *            pinch:{closed:boolean, changed:boolean}, pose:string}}
   */
  update(frame, now) {
    const events = [];
    const { handPresent = false, pose = 'none', confidence = 0, pinchRatio = Infinity, swipe = null } = frame;

    // ---- hand lost: clean reset (pinch latch clears so next pinch re-fires)
    if (!handPresent) {
      this.candidate = null;
      this.frames = 0;
      this.pinchClosed = false;
      this.pinchStable = 0;
      this.latched.clear();
      return { events, hold: null, pinch: { closed: false, changed: false }, pose: 'none' };
    }

    const confident = confidence >= this.minConfidence;
    const effectivePose = confident ? pose : 'none';

    // ---- pinch hysteresis ------------------------------------------------
    // A click needs the normalized thumb/index distance to stay below the
    // enter threshold for PINCH_CONFIRM_FRAMES consecutive frames, and the
    // fingers must open past the (larger) exit threshold before another
    // click can happen. This gives exactly one click per deliberate pinch.
    let pinchChanged = false;
    if (Number.isFinite(pinchRatio)) {
      if (!this.pinchClosed && pinchRatio <= this.pinchEnter) {
        this.pinchStable += 1;
        if (this.pinchStable >= PINCH_CONFIRM_FRAMES) {
          this.pinchClosed = true;
          pinchChanged = true;
          if (confident && this.isEnabled('pinch') && now >= this.cooldown('pinch', now)) {
            this.cooldownUntil.set('pinch', now + (GESTURE_BY_ID.pinch?.cooldown || 250));
            this.lastFire.set('pinch', now);
            events.push({ action: 'click', gesture: 'pinch', at: now });
          }
        }
      } else if (this.pinchClosed && pinchRatio > this.pinchExit) {
        this.pinchClosed = false;
        this.pinchStable = 0;
        pinchChanged = true;
      } else if (!this.pinchClosed && pinchRatio > this.pinchEnter) {
        this.pinchStable = 0; // broken before confirming — not a pinch
      }
    }

    // ---- swipe (instant, cooldown-gated; left/right share one cooldown) ---
    if (swipe && confident) {
      const id = swipe === 'left' ? 'swipe_left' : 'swipe_right';
      const cfg = GESTURE_BY_ID[id];
      if (cfg && this.isEnabled(id)
          && now >= this.cooldown(id, now)
          && now >= this.cooldown('swipe', now)) {
        this.cooldownUntil.set(id, now + cfg.cooldown);
        this.cooldownUntil.set('swipe', now + cfg.cooldown);
        this.lastFire.set(id, now);
        this.latched.set(id, true); // must exit the point pose before another swipe
        events.push({ action: cfg.action, gesture: id, at: now });
      }
    }

    // ---- candidate tracking (stability) ---------------------------------
    if (effectivePose !== this.candidate) {
      this.candidate = effectivePose;
      this.candidateSince = now;
      this.frames = 1;
    } else {
      this.frames += 1;
    }

    // Clear latches once the pose actually leaves the gesture.
    for (const id of [...this.latched.keys()]) {
      if (id !== effectivePose && !(id === 'pinch' && this.pinchClosed)) this.latched.delete(id);
    }
    // Pinch latch clears when the pinch opens.
    if (this.latched.get('pinch') && !this.pinchClosed) this.latched.delete('pinch');

    let hold = null;
    const cand = this.candidate;

    if (cand && cand !== 'none' && GESTURE_BY_ID[cand] && cand !== 'pinch') {
      const cfg = GESTURE_BY_ID[cand];
      const dwell = HOLDABLE.has(cand) ? cfg.dwell * this.dwellScale : (cfg.dwell || 0) * this.dwellScale;
      const held = now - this.candidateSince;
      const stable = this.frames >= this.stableFrames;

      if (dwell > 0) {
        const progress = Math.min(1, held / dwell);
        if (HOLDABLE.has(cand)) hold = { gesture: cand, progress: stable ? progress : Math.min(progress, 0.15) };
      }

      const actionable = cfg.action && cfg.action !== 'pointer';
      if (dwell <= 0) {
        // instant, non-hold gestures (swipes are handled above)
        if (actionable && stable && !this.latched.has(cand) && now >= this.cooldown(cand, now) && this.isEnabled(cand)) {
          this.fire(cand, cfg, now, events);
        }
      } else if (actionable && stable && held >= dwell && this.isEnabled(cand)) {
        const repeat = cfg.repeat || 0;
        if (!this.latched.has(cand)) {
          if (now >= this.cooldown(cand, now)) this.fire(cand, cfg, now, events);
        } else if (repeat > 0 && now - (this.lastFire.get(cand) || 0) >= repeat) {
          // configured long-press repeat (volume only) — still rate-limited
          this.fire(cand, cfg, now, events);
        }
      }
    }

    return { events, hold, pinch: { closed: this.pinchClosed, changed: pinchChanged }, pose: effectivePose };
  }

  fire(id, cfg, now, events) {
    this.latched.set(id, true);
    this.lastFire.set(id, now);
    this.cooldownUntil.set(id, now + (cfg.cooldown || 0));
    events.push({ action: cfg.action, gesture: id, at: now });
  }

  cooldown(id, now) {
    return this.cooldownUntil.get(id) || 0;
  }
}
