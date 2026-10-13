// Hand pose classifier — pure, framework-free, unit-testable.
//
// Input : 21 MediaPipe hand landmarks in *screen space* (x already mirrored so
//         that moving your hand right moves the pointer right).
// Output: { pose, confidence, pointer, pinchRatio, ...features }
//
// The classifier never fires actions; it only describes the frame. Timing,
// hysteresis, dwell and cooldowns live in the state machine.

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Front-camera selfie mapping: flip x so screen space matches what the user
 * sees in the mirrored preview (moving your hand right → pointer moves right).
 */
export function mirrorLandmarks(lm) {
  return lm.map((p) => ({ ...p, x: 1 - p.x }));
}

/** Interior angle at `b` formed by a→b→c, in degrees. */
function angleAt(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const len = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (len < 1e-9) return 180;
  const cos = (v1.x * v2.x + v1.y * v2.y) / len;
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/** Extension score for a finger: 0 = fully curled, 1 = straight. */
function extensionScore(mcp, pip, tip) {
  const angle = angleAt(mcp, pip, tip);
  return clamp01((angle - 110) / 60);
}

/**
 * Classify a single frame.
 * @param {Array<{x:number,y:number}>} lm 21 landmarks, screen space
 * @param {{allowTwoFingerPinch?:boolean, pinchEnter?:number}} [tuning]
 */
export function classify(lm, tuning = {}) {
  if (!Array.isArray(lm) || lm.length < 21) {
    return { pose: 'none', confidence: 0, pointer: null, pinchRatio: Infinity };
  }

  const pinchEnter = tuning.pinchEnter ?? 0.34;
  const handSize = Math.max(dist(lm[LM.WRIST], lm[LM.MIDDLE_MCP]), 1e-6);

  // --- fingers ------------------------------------------------------------
  const ext = {
    index: extensionScore(lm[LM.INDEX_MCP], lm[LM.INDEX_PIP], lm[LM.INDEX_TIP]),
    middle: extensionScore(lm[LM.MIDDLE_MCP], lm[LM.MIDDLE_PIP], lm[LM.MIDDLE_TIP]),
    ring: extensionScore(lm[LM.RING_MCP], lm[LM.RING_PIP], lm[LM.RING_TIP]),
    pinky: extensionScore(lm[LM.PINKY_MCP], lm[LM.PINKY_PIP], lm[LM.PINKY_TIP]),
  };
  const isExt = (k) => ext[k] > 0.55;
  const isFold = (k) => ext[k] < 0.4;
  const fourFolded = isFold('index') && isFold('middle') && isFold('ring') && isFold('pinky');
  const allExtended = isExt('index') && isExt('middle') && isExt('ring') && isExt('pinky');

  // --- pinch --------------------------------------------------------------
  const pinchRatio = dist(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP]) / handSize;
  const clusterRatio = Math.max(
    pinchRatio,
    dist(lm[LM.THUMB_TIP], lm[LM.MIDDLE_TIP]) / handSize,
  );
  const indexMiddleGap = dist(lm[LM.INDEX_TIP], lm[LM.MIDDLE_TIP]) / handSize;

  // --- thumb direction ----------------------------------------------------
  const thumbVec = { x: lm[LM.THUMB_TIP].x - lm[LM.THUMB_MCP].x, y: lm[LM.THUMB_TIP].y - lm[LM.THUMB_MCP].y };
  const thumbLen = Math.hypot(thumbVec.x, thumbVec.y) || 1e-6;
  const thumbUp = -thumbVec.y / thumbLen > 0.65 && thumbLen / handSize > 0.35;
  const thumbDown = thumbVec.y / thumbLen > 0.65 && thumbLen / handSize > 0.35;

  // --- index pointing direction (screen space, y grows downward) ----------
  const pointVec = { x: lm[LM.INDEX_TIP].x - lm[LM.WRIST].x, y: lm[LM.INDEX_TIP].y - lm[LM.WRIST].y };
  const pointLen = Math.hypot(pointVec.x, pointVec.y) || 1e-6;
  const upness = -pointVec.y / pointLen;
  const downness = pointVec.y / pointLen;
  let direction = 'neutral';
  if (upness > 0.72) direction = 'up';
  else if (downness > 0.72) direction = 'down';

  const mean = (obj) => (obj.index + obj.middle + obj.ring + obj.pinky) / 4;
  // Pointer always tracks the index fingertip — including while pinching —
  // so the cursor never jumps to the thumb/index midpoint right as you click.
  const pointer = { x: lm[LM.INDEX_TIP].x, y: lm[LM.INDEX_TIP].y };

  const base = {
    pointer,
    pinchRatio,
    handSize,
    direction,
    fingers: ext,
    thumbUp,
    thumbDown,
  };

  // --- decision tree (priority order) -------------------------------------
  if (pinchRatio <= pinchEnter) {
    const pinchConf = clamp01((pinchEnter - pinchRatio) / (pinchEnter * 0.55)) * 0.6 + 0.4;
    if (tuning.allowTwoFingerPinch && clusterRatio <= pinchEnter * 1.1 && indexMiddleGap < 0.75) {
      return { ...base, pose: 'two_finger_pinch', confidence: Math.min(0.97, pinchConf) };
    }
    return { ...base, pose: 'pinch', confidence: Math.min(0.97, pinchConf) };
  }

  if (fourFolded && thumbUp) {
    return { ...base, pose: 'thumb_up', confidence: clamp01(0.5 + ext.index * 0.15 + (upness * 0.4)) };
  }
  if (fourFolded && thumbDown) {
    return { ...base, pose: 'thumb_down', confidence: clamp01(0.5 + ext.index * 0.15 + (downness * 0.4)) };
  }

  const indexMiddleUp = isExt('index') && isExt('middle') && isFold('ring') && isFold('pinky');
  if (indexMiddleUp && indexMiddleGap > 0.45) {
    const spread = clamp01(indexMiddleGap);
    return { ...base, pose: 'v_sign', confidence: clamp01(0.45 + spread * 0.5) };
  }

  // Three fingers up (index + middle + ring, pinky folded) → go home.
  const threeUp = isExt('index') && isExt('middle') && isExt('ring') && isFold('pinky');
  if (threeUp) {
    const spread = clamp01(dist(lm[LM.INDEX_TIP], lm[LM.RING_TIP]) / handSize);
    return { ...base, pose: 'three_finger', confidence: clamp01(0.5 + spread * 0.4) };
  }

  if (fourFolded) {
    return { ...base, pose: 'fist', confidence: clamp01(0.45 + mean(ext) * -0.1 + 0.5) };
  }

  if (allExtended && !isFold('index')) {
    // Open palm — reject anything already claimed above.
    return { ...base, pose: 'palm', confidence: clamp01(0.5 + mean(ext) * 0.45) };
  }

  if (isExt('index') && isFold('middle') && isFold('ring') && isFold('pinky')) {
    const conf = clamp01(0.4 + ext.index * 0.3 + (1 - (ext.middle + ext.ring + ext.pinky) / 3) * 0.25);
    // Pointing up no longer triggers any action — it is just the pointer.
    // Point down still opens the notification centre.
    const indexLen = dist(lm[LM.INDEX_TIP], lm[LM.INDEX_MCP]) / handSize;
    if (direction === 'down' && indexLen > 0.5) return { ...base, pose: 'point_down', confidence: Math.min(0.95, conf) };
    return { ...base, pose: 'point', confidence: Math.min(0.95, conf) };
  }

  // Anything else (half-closed, splayed, ambiguous) → deliberately nothing.
  return { ...base, pose: 'none', confidence: 0.3 };
}

/**
 * Swipe detector with its own short history window.
 * Fires at most once per sweep; the caller applies cooldowns.
 */
export class SwipeTracker {
  constructor({ windowMs = 340, distance = 0.18, yTolerance = 0.6, minSpeed = 0.45 } = {}) {
    this.windowMs = windowMs;
    this.distance = distance;
    this.yTolerance = yTolerance;
    this.minSpeed = minSpeed; // normalized units per second — rejects slow drifts
    this.points = [];
    this.emaX = null;
    this.cooldownUntil = 0;
  }

  reset() { this.points = []; this.emaX = null; }

  /**
   * Feed the index-finger position (normalized screen coords) for a frame.
   * x is EMA-smoothed first so single-frame jitter cannot fake a sweep.
   * @returns {'left'|'right'|null}
   */
  push(x, y, now, { active = true } = {}) {
    if (!active) { this.reset(); return null; }
    // Light smoothing (alpha 0.55) — keeps latency low but kills spike noise.
    this.emaX = this.emaX === null ? x : this.emaX * 0.45 + x * 0.55;
    this.points.push({ x: this.emaX, y, t: now });
    const cutoff = now - this.windowMs;
    while (this.points.length && this.points[0].t < cutoff) this.points.shift();
    if (now < this.cooldownUntil) return null;
    if (this.points.length < 4) return null;

    const first = this.points[0];
    const last = this.points[this.points.length - 1];
    const dx = last.x - first.x;
    const dy = Math.abs(last.y - first.y);
    if (Math.abs(dx) < this.distance) return null;
    if (dy > Math.abs(dx) * this.yTolerance) return null;
    // Must be fast enough to be a deliberate sweep, not slow cursor travel.
    const elapsed = (last.t - first.t) / 1000;
    if (elapsed <= 0 || Math.abs(dx) / elapsed < this.minSpeed) return null;
    // Must be a genuine sweep, not hand jitter: back-steps may not outweigh
    // more than ~30% of the net displacement in either direction.
    let fwd = 0;
    let back = 0;
    for (let i = 1; i < this.points.length; i += 1) {
      const step = this.points[i].x - this.points[i - 1].x;
      if (step > 0) fwd += step;
      else back += -step;
    }
    const net = Math.abs(dx);
    if (Math.min(fwd, back) > 0.3 * net) return null;

    this.cooldownUntil = now + 800;
    this.reset();
    return dx < 0 ? 'left' : 'right';
  }
}
