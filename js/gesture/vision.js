// Model / library loaders with pinned, verified URLs and error recovery.
//
//  * MediaPipe Tasks Vision (HandLandmarker) — the tracking model.
//    Pinned package + Google-hosted float16 model (verified to exist).
//  * OpenCV.js — lazy-loaded for genuine frame-quality diagnostics
//    (luminance/contrast of the camera feed, to explain bad tracking).
//
// Nothing here is fetched until the user starts gesture control.

export const MP_VERSION = '1.1.0';
export const MP_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
export const MP_WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
export const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
export const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

let handLandmarkerPromise = null;
let landmarker = null;
let opencvPromise = null;
let cvStatus = 'not loaded'; // not loaded | loading | ready | failed

export function modelStatus() {
  if (landmarker) return 'ready';
  if (handLandmarkerPromise) return 'loading';
  return 'not loaded';
}

export function opencvState() { return cvStatus; }

/**
 * Load (once) the HandLandmarker. Repeated calls share one promise;
 * a failed load is cleared so `retry` can try again.
 */
export function loadHandLandmarker({ onProgress } = {}) {
  if (landmarker) return Promise.resolve(landmarker);
  if (handLandmarkerPromise) return handLandmarkerPromise;

  handLandmarkerPromise = (async () => {
    onProgress?.('loading runtime…');
    const vision = await import(MP_BUNDLE_URL);
    const { FilesetResolver, HandLandmarker } = vision;

    const fileset = await FilesetResolver.forVisionTasks(MP_WASM_URL);
    onProgress?.('loading model…');

    const instance = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    landmarker = instance;
    onProgress?.('ready');
    return instance;
  })();

  handLandmarkerPromise.catch(() => {
    handLandmarkerPromise = null; // allow retry
  });
  return handLandmarkerPromise;
}

export function getLandmarker() { return landmarker; }

export function disposeLandmarker() {
  try { landmarker?.close?.(); } catch { /* noop */ }
  landmarker = null;
  handLandmarkerPromise = null;
}

/** Force a fresh model load (Retry button). */
export function retryHandLandmarker() {
  disposeLandmarker();
  return loadHandLandmarker();
}

/**
 * Lazy-load OpenCV.js. Failure is non-fatal — diagnostics degrade gracefully.
 * @returns {Promise<boolean>}
 */
export function loadOpenCV() {
  if (window.cv && typeof window.cv.Mat === 'function') {
    cvStatus = 'ready';
    return Promise.resolve(true);
  }
  if (opencvPromise) return opencvPromise;

  cvStatus = 'loading';
  opencvPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = OPENCV_URL;
    script.async = true;
    const timeout = setTimeout(() => {
      cvStatus = 'failed';
      console.warn('[opencv] load timed out');
      resolve(false);
    }, 20000);
    script.onload = () => {
      clearTimeout(timeout);
      // techstark build initialises window.cv asynchronously (onRuntimeInitialized)
      const finish = (ok) => {
        cvStatus = ok ? 'ready' : 'failed';
        resolve(ok);
      };
      if (window.cv && typeof window.cv.Mat === 'function') finish(true);
      else if (window.cv) {
        const prev = window.cv.onRuntimeInitialized;
        window.cv.onRuntimeInitialized = () => {
          prev?.();
          finish(typeof window.cv.Mat === 'function');
        };
        setTimeout(() => finish(typeof window.cv.Mat === 'function'), 4000);
      } else finish(false);
    };
    script.onerror = () => {
      clearTimeout(timeout);
      cvStatus = 'failed';
      console.warn('[opencv] failed to load');
      resolve(false);
    };
    document.head.appendChild(script);
  });
  return opencvPromise;
}

/**
 * Frame-quality diagnostic using OpenCV: mean luminance + contrast of a small
 * grayscale copy of the video frame. Helps explain "tracking is jumpy"
 * (too dark / blown out) without doing heavy per-frame processing.
 * Returns null when OpenCV is unavailable.
 */
let qualityCanvas = null; // scratch canvas, reused across frames

export function frameQuality(video) {
  if (cvStatus !== 'ready' || !window.cv || !video || video.readyState < 2) return null;
  if (!video.videoWidth || !video.videoHeight) return null;
  const cv = window.cv;
  let src = null;
  let gray = null;
  try {
    const w = 160;
    const h = Math.max(2, Math.round((video.videoHeight / video.videoWidth) * w));
    // cv.imread only accepts a canvas/img (or an element id) — draw the video
    // frame onto a small scratch canvas first. This also does the downscale
    // for us, so no separate cv.resize is needed.
    if (!qualityCanvas) qualityCanvas = document.createElement('canvas');
    if (qualityCanvas.width !== w || qualityCanvas.height !== h) {
      qualityCanvas.width = w;
      qualityCanvas.height = h;
    }
    const ctx = qualityCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    src = cv.imread(qualityCanvas);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const mean = new cv.Mat();
    const std = new cv.Mat();
    cv.meanStdDev(gray, mean, std);
    const luma = mean.data64F?.[0] ?? mean.doubleAt(0, 0) ?? 0;
    const contrast = std.data64F?.[0] ?? std.doubleAt(0, 0) ?? 0;
    mean.delete(); std.delete(); gray.delete(); src.delete();
    return { luma: Math.round(luma), contrast: Math.round(contrast) };
  } catch (err) {
    console.warn('[opencv] frameQuality failed:', err);
    try { src?.delete(); gray?.delete(); } catch { /* noop */ }
    return null;
  }
}
