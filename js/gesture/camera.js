// CameraController — owns getUserMedia lifecycle.
// The camera is NEVER started on page load; only after an explicit user action.

import { emit } from '../core/events.js';

export class CameraController {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.status = 'off'; // off | starting | on | error
    this.error = null;
  }

  get isActive() {
    return !!this.stream && this.stream.active;
  }

  /**
   * Request camera access and attach the stream to the video element.
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async start() {
    if (this.isActive) return { ok: true };
    this.setStatus('starting', null);

    if (!window.isSecureContext) {
      const msg = 'Camera requires HTTPS (or localhost). Open the app over a secure origin.';
      return this.fail(msg);
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const msg = 'This browser does not expose camera access (getUserMedia missing).';
      return this.fail(msg);
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
      this.stream = stream;
      this.video.srcObject = stream;
      // Some browsers need an explicit play() after srcObject assignment.
      try { await this.video.play(); } catch (err) {
        // Autoplay of a muted video is allowed; ignore benign rejections.
        if (err && err.name !== 'NotAllowedError') console.warn('[camera] play():', err);
      }
      const track = stream.getVideoTracks()[0];
      track?.addEventListener('ended', () => {
        if (this.stream === stream) this.handleTrackEnded();
      });
      this.setStatus('on', null);
      return { ok: true };
    } catch (err) {
      return this.fail(CameraController.humanError(err));
    }
  }

  handleTrackEnded() {
    this.stream = null;
    this.setStatus('error', 'Camera stopped (released by the system). Retry to restart.');
  }

  static humanError(err) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Camera permission denied. Allow camera access in your browser settings, then retry.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No camera was found on this device.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'The camera is already in use by another application. Close it and retry.';
    }
    if (name === 'OverconstrainedError') {
      return 'The camera does not support the requested resolution.';
    }
    if (name === 'SecurityError') {
      return 'Browser blocked camera access for this page (security policy).';
    }
    return `Camera failed to start${err?.message ? `: ${err.message}` : '.'}`;
  }

  fail(message) {
    this.setStatus('error', message);
    return { ok: false, error: message };
  }

  /** Fully stop every track — releases the camera indicator light. */
  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try { track.stop(); } catch { /* noop */ }
      }
      this.stream = null;
    }
    try { this.video.srcObject = null; } catch { /* noop */ }
    this.setStatus('off', null);
  }

  setStatus(status, error) {
    this.status = status;
    this.error = error;
    emit('camera:status', { status, error });
  }
}
