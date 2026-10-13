// GestureEngine — orchestrates the whole computer-vision pipeline:
//   CameraController → MediaPipe HandLandmarker → classifier → state machine
//   → gesture-to-action dispatcher (via the event bus)
//
// Guarantees:
//   * camera only starts on explicit user action (never on page load)
//   * no overlapping inference calls (busy flag + frame throttle)
//   * error recovery: model-load/camera/inference failures are reported, the
//     camera is released and a Retry path is offered — the app never crashes
//   * lock/pause filters suppress every action except their own toggles
//   * practice mode observes gestures without executing anything

import { emit } from '../core/events.js';
import { CameraController } from './camera.js';
import { loadHandLandmarker, loadOpenCV, retryHandLandmarker, frameQuality, opencvState } from './vision.js';
import { classify, SwipeTracker, mirrorLandmarks } from './classifier.js';
import { GestureStateMachine, gateAction } from './state-machine.js';
import { tuningForSensitivity } from './config.js';
import { PointerController } from './pointer.js';

const TARGET_FPS = 30;
const HAND_LOST_GRACE = 700; // ms before "no hand" hint appears

export class GestureEngine {
  constructor({ canvas, video, previewEl, hintEl, camHintEl }) {
    this.camera = new CameraController(video);
    this.video = video;
    this.previewEl = previewEl;
    this.hintEl = hintEl;
    this.camHintEl = camHintEl;
    this.pointer = new PointerController(canvas);

    this.machine = new GestureStateMachine();
    this.swipe = new SwipeTracker();

    this.status = 'off'; // off | starting | running | error
    this.errorMessage = null;
    this.modelMessage = '';

    this.locked = false;
    this.paused = false;
    this.practice = false;
    this.actionRemap = {}; // e.g. { volume_up: 'call_accept' } while ringing

    this.rafId = 0;
    this.inferBusy = false;
    this.lastInferAt = 0;
    this.minInterval = 1000 / TARGET_FPS;
    this.lastLandmarks = null;
    this.lastPose = 'none';
    this.lastConfidence = 0;
    this.lastHandAt = 0;
    this.inferMsEma = 0;
    this.fpsEma = 0;
    this.frameCount = 0;
    this.fpsWindowStart = 0;
    this.inferenceErrors = 0;
    this.lastDiagAt = 0;
    this.luma = null;
    this.lastHint = '';
  }

  // ------------------------------------------------------------ configuration
  applySettings({ sensitivity, dwell, smoothing, pointerSpeed, cameraPreview } = {}) {
    const t = tuningForSensitivity(sensitivity);
    this.machine.configure({
      minConfidence: t.confidenceGate,
      pinchEnter: t.pinchEnter,
      pinchExit: t.pinchExit,
      dwellScale: t.dwellScale,
    });
    this.pointer.configure({ smoothing, speed: pointerSpeed });
    if (cameraPreview !== undefined) this.setPreviewVisible(cameraPreview);
  }

  setEnabledMap(map) {
    this.machine.isEnabled = (id) => map[id] !== false;
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    if (this.status === 'running' || this.status === 'starting') return { ok: true };
    this.status = 'starting';
    this.errorMessage = null;
    this.emitStatus();

    const cam = await this.camera.start();
    if (!cam.ok) {
      this.status = 'error';
      this.errorMessage = cam.error;
      this.emitStatus();
      emit('toast', { message: cam.error, level: 'err' });
      return { ok: false, error: cam.error };
    }

    try {
      this.modelMessage = 'Loading hand-tracking model…';
      this.emitStatus();
      const instance = await loadHandLandmarker({
        onProgress: (m) => { this.modelMessage = m === 'ready' ? 'Model ready' : `Model ${m}`; this.emitStatus(); },
      });
      bindLandmarker(instance);
    } catch (err) {
      console.error('[engine] model load failed:', err);
      this.camera.stop();
      this.status = 'error';
      this.errorMessage = 'Hand-tracking model failed to load. Check your connection and press Retry.';
      this.emitStatus();
      emit('toast', { message: this.errorMessage, level: 'err' });
      return { ok: false, error: this.errorMessage };
    }

    // OpenCV diagnostics are optional and must never block tracking.
    loadOpenCV().catch(() => {});

    this.machine.reset();
    this.swipe.reset();
    this.lastLandmarks = null;
    this.inferenceErrors = 0;
    this.fpsWindowStart = performance.now();
    this.pointer.setEnabled(true);
    this.status = 'running';
    this.setPreviewVisible(this._previewPref === true);
    this.emitStatus();
    this.setStatusText('Camera live — show your hand');

    this.startLoop();
    emit('engine:started', {});
    return { ok: true };
  }

  stop({ reason = null } = {}) {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.camera.stop();
    this.pointer.setEnabled(false);
    this.pointer.clear();
    this.pointer.setGestureState({ present: false, hold: null, pinchClosed: false });
    this.lastLandmarks = null;
    this.lastPose = 'none';
    this.swipe.reset();
    this.machine.reset();
    if (this.previewEl) this.previewEl.hidden = true;
    this.hintEl.hidden = true;
    if (this.status !== 'error') this.status = 'off';
    if (reason) this.errorMessage = reason;
    this.emitStatus();
    this.setStatusText('');
    emit('engine:stopped', {});
  }

  async retry() {
    this.stop();
    this.status = 'off';
    this.errorMessage = null;
    try { await retryHandLandmarker(); } catch { /* start() reports it */ }
    return this.start();
  }

  // ----------------------------------------------------------------- main loop
  startLoop() {
    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      if (this.status !== 'running') return;

      const now = performance.now();
      this.pointer.tick();
      this.pointer.draw(this.lastLandmarks);
      this.pointer.updateHover();

      // FPS accounting (loop frames)
      this.frameCount += 1;
      if (now - this.fpsWindowStart >= 1000) {
        this.fpsEma = Math.round((this.frameCount * 1000) / (now - this.fpsWindowStart));
        this.frameCount = 0;
        this.fpsWindowStart = now;
      }

      const videoReady = this.video.readyState >= 2 && this.video.videoWidth > 0;
      if (!this.inferBusy && videoReady && now - this.lastInferAt >= this.minInterval) {
        this.infer(now);
      }


      this.updateHandHint(now);
      if (now - this.lastDiagAt > 400) {
        this.lastDiagAt = now;
        this.emitDiagnostics();
      }
    };
    this.rafId = requestAnimationFrame(loop);
  }

  infer(now) {
    this.inferBusy = true;
    this.lastInferAt = now;
    const lm = landmarkerRef;
    if (!lm) { this.inferBusy = false; return; }
    try {
      const t0 = performance.now();
      const results = lm.detectForVideo(this.video, now);
      const dt = performance.now() - t0;
      this.inferMsEma = this.inferMsEma ? this.inferMsEma * 0.85 + dt * 0.15 : dt;
      this.inferenceErrors = 0;
      this.process(results, now);
    } catch (err) {
      this.inferenceErrors += 1;
      if (this.inferenceErrors === 1) console.warn('[engine] inference error:', err);
      if (this.inferenceErrors >= 8) {
        this.stop({ reason: 'Inference failed repeatedly. Camera released — press Retry to recover.' });
        this.status = 'error';
        this.emitStatus();
        emit('toast', { message: this.errorMessage, level: 'err' });
      }
    } finally {
      this.inferBusy = false;
    }
  }

  process(results, now) {
    const raw = results?.landmarks?.[0];
    if (!raw || !raw.length) {
      this.lastLandmarks = null;
      const r = this.machine.update({ handPresent: false }, now);
      this.applyFrame(r, null, now);
      return;
    }

    const lm = mirrorLandmarks(raw);
    this.lastLandmarks = lm;

    const t = tuningForSensitivity(this.sensitivityValue());
    const cls = classify(lm, { pinchEnter: t.pinchEnter, allowTwoFingerPinch: this.allowTwoFingerPinch });
    this.lastPose = cls.pose;
    this.lastConfidence = cls.confidence;

    // Pointer target only for poses where the index tip is meaningful,
    // so a fist or thumb-up never teleports the cursor.
    const pointerPose = cls.pose === 'point' || cls.pose === 'pinch'
      || cls.pose === 'point_up' || cls.pose === 'point_down' || cls.pose === 'two_finger_pinch';
    if (pointerPose && cls.pointer) {
      this.pointer.setTarget(cls.pointer.x * window.innerWidth, cls.pointer.y * window.innerHeight);
      this.lastHandAt = now;
    } else if (this.pointer.position) {
      this.lastHandAt = now; // hand still visible; cursor holds position
    }

    const swipe = cls.pose === 'point' && cls.confidence > 0.5
      ? this.swipe.push(cls.pointer.x, cls.pointer.y, now, { active: true })
      : (this.swipe.reset(), null);

    const r = this.machine.update(
      { handPresent: true, pose: cls.pose, confidence: cls.confidence, pinchRatio: cls.pinchRatio, swipe },
      now,
    );

    if (this.practice) {
      emit('gesture:observed', { gesture: cls.pose, confidence: cls.confidence, swipe });
    }
    this.applyFrame(r, cls, now);
  }

  applyFrame(result, cls, now) {
    this.pointer.setGestureState({
      present: this.lastLandmarks !== null,
      pose: result.pose,
      confidence: cls?.confidence ?? 0,
      hold: result.hold,
      pinchClosed: result.pinch.closed,
      locked: this.locked,
      paused: this.paused,
    });

    for (const ev of result.events) {
      this.dispatch(ev);
    }

    // OpenCV quality check every ~700 ms (cheap, 160px grayscale copy).
    if (this.luma === null || now - (this._lastLumaAt || 0) > 700) {
      this._lastLumaAt = now;
      const q = frameQuality(this.video);
      if (q) {
        this.luma = q;
        if (q.luma < 45) this.hint('warn', 'Camera image is dark — tracking may drift. Add light.');
        else if (q.luma > 215) this.hint('warn', 'Camera image is overexposed — tracking may drift.');
        else this.lastHint = '';
      }
    }
  }

  /** Lock/pause/practice filters + context remapping, then emit. */
  dispatch(ev) {
    let { action } = ev;

    // Context remap (e.g. thumb up/down accepts/rejects a ringing call).
    if (this.actionRemap[action]) action = this.actionRemap[action];

    // Lock / pause / pointer gating (pure, unit-tested).
    action = gateAction(action, { locked: this.locked, paused: this.paused });
    if (!action) return;

    // Pinch clicks are executed right here so practice mode can suppress them.
    if (action === 'click') {
      if (!this.practice) this.pointer.activate();
      return;
    }

    emit('gesture:event', { action, gesture: ev.gesture, at: ev.at });
  }

  // -------------------------------------------------------------- public state
  setLocked(on) {
    this.locked = !!on;
    if (this.locked) this.paused = false;
    this.pointer.setGestureState({ locked: this.locked, paused: this.paused });
    emit('gesture:lock', { locked: this.locked });
    this.emitStatus();
  }

  setPaused(on) {
    this.paused = !!on;
    this.pointer.setGestureState({ paused: this.paused });
    emit('gesture:pause', { paused: this.paused });
    this.emitStatus();
  }

  setPractice(on) {
    this.practice = !!on;
    emit('gesture:practice', { practice: this.practice });
  }

  setRemap(remap) {
    this.actionRemap = remap || {};
  }

  setPreviewVisible(on) {
    // The camera feed only ever renders inside the diagnostics drawer (Gesture
    // Lab) — there is no floating picture-in-picture over the UI. The drawer
    // itself being hidden also hides the feed, so we never show PiP.
    this._previewPref = !!on;
    const drawerOpen = !document.querySelector('#diag-panel')?.hidden;
    if (this.previewEl) this.previewEl.hidden = !(on && this.status === 'running' && drawerOpen);
  }

  /** Re-evaluate preview visibility (called when the diagnostics drawer opens/closes). */
  syncPreview() {
    if (this.status === 'running') this.setPreviewVisible(this._previewPref === true);
  }

  sensitivityValue() {
    return this._sensitivity ?? 6;
  }

  get allowTwoFingerPinch() {
    return this._twoFingerEnabled === true;
  }

  setTwoFingerEnabled(on) { this._twoFingerEnabled = !!on; }

  setSensitivity(v) { this._sensitivity = v; }

  // -------------------------------------------------------------------- hints
  updateHandHint(now) {
    const hasHand = this.lastHandAt && now - this.lastHandAt < HAND_LOST_GRACE;
    this.hintEl.hidden = !!hasHand || this.status !== 'running';
    if (this.camHintEl) {
      this.camHintEl.textContent = hasHand ? 'Hand detected' : 'Show your hand to the camera';
    }
  }

  setStatusText(text) {
    if (this.camHintEl && text) this.camHintEl.textContent = text;
  }

  /** Emit a hint only when it changes — prevents toast spam. */
  hint(level, message) {
    if (!message || message === this.lastHint) return;
    this.lastHint = message;
    emit('engine:hint', { level, message });
  }

  emitStatus() {
    emit('engine:status', {
      status: this.status,
      error: this.errorMessage,
      model: this.modelMessage,
      locked: this.locked,
      paused: this.paused,
      practice: this.practice,
      camera: this.camera.status,
      opencv: opencvState(),
    });
  }

  emitDiagnostics() {
    emit('diag:update', {
      camera: this.camera.status,
      model: this.modelMessage || 'ready',
      hand: this.lastLandmarks ? `${this.lastPose}` : 'none',
      gesture: this.lastPose,
      confidence: this.lastConfidence,
      fps: this.fpsEma,
      inferMs: this.inferMsEma,
      pointer: this.pointer.pos
        ? `${Math.round(this.pointer.pos.x)}, ${Math.round(this.pointer.pos.y)}`
        : '—',
      luma: this.luma ? `${this.luma.luma} (c ${this.luma.contrast})` : (opencvState() === 'ready' ? '—' : 'cv off'),
      locked: this.locked,
      paused: this.paused,
      cv: opencvState(),
    });
  }

}

// Cached landmarker instance keeps the hot loop allocation-free.
let landmarkerRef = null;
export function bindLandmarker(instance) { landmarkerRef = instance; }
