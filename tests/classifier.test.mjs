// Unit tests for the pure gesture classifier (no camera, no DOM).
// Run: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, mirrorLandmarks, SwipeTracker, LM } from '../js/gesture/classifier.js';

// --------------------------------------------------------------- test hand
const MCP = {
  [LM.INDEX_MCP]: { x: 0.44, y: 0.62 },
  [LM.MIDDLE_MCP]: { x: 0.50, y: 0.60 },
  [LM.RING_MCP]: { x: 0.56, y: 0.62 },
  [LM.PINKY_MCP]: { x: 0.61, y: 0.66 },
};

function finger(mcp, tip, { pipRatio = 0.55, curl = false } = {}) {
  if (curl) {
    // folded: pip goes slightly up, tip curls back toward the palm
    return [
      { x: mcp.x, y: mcp.y - 0.06 },
      { x: mcp.x + 0.02, y: mcp.y + 0.025 },
    ];
  }
  const pip = { x: mcp.x + (tip.x - mcp.x) * pipRatio, y: mcp.y + (tip.y - mcp.y) * pipRatio };
  const dip = { x: mcp.x + (tip.x - mcp.x) * 0.8, y: mcp.y + (tip.y - mcp.y) * 0.8 };
  return [pip, dip];
}

function buildHand({ thumb, index, middle, ring, pinky }) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.9, z: 0 }));
  lm[0] = { x: 0.5, y: 0.9, z: 0 };
  lm[1] = { x: 0.44, y: 0.84, z: 0 };
  lm[2] = thumb.mcp; lm[3] = thumb.ip; lm[4] = thumb.tip;

  const set = (baseIdx, mcp, spec) => {
    lm[baseIdx] = mcp;
    const [pip, dip] = finger(mcp, spec.tip, spec);
    lm[baseIdx + 1] = pip;
    lm[baseIdx + 2] = dip;
    lm[baseIdx + 3] = spec.tip;
  };
  set(LM.INDEX_MCP, MCP[LM.INDEX_MCP], index);
  set(LM.MIDDLE_MCP, MCP[LM.MIDDLE_MCP], middle);
  set(LM.RING_MCP, MCP[LM.RING_MCP], ring);
  set(LM.PINKY_MCP, MCP[LM.PINKY_MCP], pinky);
  return lm;
}

const thumbNeutral = { mcp: { x: 0.40, y: 0.78 }, ip: { x: 0.44, y: 0.76 }, tip: { x: 0.42, y: 0.74 } };
const thumbUp = { mcp: { x: 0.40, y: 0.78 }, ip: { x: 0.385, y: 0.68 }, tip: { x: 0.375, y: 0.56 } };
const thumbDown = { mcp: { x: 0.40, y: 0.78 }, ip: { x: 0.39, y: 0.85 }, tip: { x: 0.375, y: 0.92 } };
const thumbAcross = { mcp: { x: 0.40, y: 0.78 }, ip: { x: 0.45, y: 0.76 }, tip: { x: 0.50, y: 0.75 } };

const curled = (tip) => ({ tip, curl: true });
const straight = (tip) => ({ tip });

const fourCurled = {
  index: curled({ x: 0.46, y: 0.645 }),
  middle: curled({ x: 0.52, y: 0.625 }),
  ring: curled({ x: 0.58, y: 0.645 }),
  pinky: curled({ x: 0.63, y: 0.685 }),
};

const poses = {
  point: () => buildHand({
    thumb: thumbNeutral,
    index: straight({ x: 0.26, y: 0.74 }), // lateral, foreshortened direction
    middle: curled({ x: 0.52, y: 0.625 }),
    ring: curled({ x: 0.58, y: 0.645 }),
    pinky: curled({ x: 0.63, y: 0.685 }),
  }),
  pinch: () => {
    const hand = buildHand({
      thumb: { mcp: { x: 0.40, y: 0.78 }, ip: { x: 0.43, y: 0.60 }, tip: { x: 0.44, y: 0.44 } },
      index: straight({ x: 0.445, y: 0.445 }), // tips touch
      middle: curled({ x: 0.52, y: 0.625 }),
      ring: curled({ x: 0.58, y: 0.645 }),
      pinky: curled({ x: 0.63, y: 0.685 }),
    });
    return hand;
  },
  thumb_up: () => buildHand({ thumb: thumbUp, ...fourCurled }),
  thumb_down: () => buildHand({ thumb: thumbDown, ...fourCurled }),
  fist: () => buildHand({ thumb: thumbAcross, ...fourCurled }),
  palm: () => buildHand({
    thumb: { mcp: { x: 0.40, y: 0.78 }, ip: { x: 0.37, y: 0.72 }, tip: { x: 0.34, y: 0.66 } },
    index: straight({ x: 0.40, y: 0.34 }),
    middle: straight({ x: 0.50, y: 0.30 }),
    ring: straight({ x: 0.58, y: 0.33 }),
    pinky: straight({ x: 0.65, y: 0.38 }),
  }),
  v_sign: () => buildHand({
    thumb: thumbNeutral,
    index: straight({ x: 0.36, y: 0.32 }),
    middle: straight({ x: 0.54, y: 0.30 }),
    ring: curled({ x: 0.58, y: 0.645 }),
    pinky: curled({ x: 0.63, y: 0.685 }),
  }),
  point_up: () => buildHand({
    thumb: thumbNeutral,
    index: straight({ x: 0.43, y: 0.30 }),
    middle: curled({ x: 0.52, y: 0.625 }),
    ring: curled({ x: 0.58, y: 0.645 }),
    pinky: curled({ x: 0.63, y: 0.685 }),
  }),
  point_down: () => buildHand({
    thumb: thumbNeutral,
    index: straight({ x: 0.46, y: 0.96 }),
    middle: curled({ x: 0.52, y: 0.625 }),
    ring: curled({ x: 0.58, y: 0.645 }),
    pinky: curled({ x: 0.63, y: 0.685 }),
  }),
};

// ------------------------------------------------------------------- tests
test('point pose is recognised as the pointer gesture', () => {
  const r = classify(poses.point());
  assert.equal(r.pose, 'point');
  assert.ok(r.confidence > 0.5, `confidence ${r.confidence}`);
  assert.ok(r.pointer, 'pointer position present');
});

test('pinch pose (thumb+index touching) is recognised', () => {
  const r = classify(poses.pinch());
  assert.equal(r.pose, 'pinch');
  assert.ok(r.confidence > 0.5);
  assert.ok(r.pinchRatio < 0.34, `pinchRatio ${r.pinchRatio}`);
});

test('thumb up / thumb down are distinguished', () => {
  assert.equal(classify(poses.thumb_up()).pose, 'thumb_up');
  assert.equal(classify(poses.thumb_down()).pose, 'thumb_down');
});

test('closed fist is recognised', () => {
  assert.equal(classify(poses.fist()).pose, 'fist');
});

test('open palm is recognised', () => {
  assert.equal(classify(poses.palm()).pose, 'palm');
});

test('V sign requires two extended spread fingers', () => {
  const r = classify(poses.v_sign());
  assert.equal(r.pose, 'v_sign');
});

test('pointing up is just the pointer; pointing down opens notifications', () => {
  // Point-up must NOT trigger any action any more — it only moves the cursor.
  assert.equal(classify(poses.point_up()).pose, 'point');
  assert.equal(classify(poses.point_down()).pose, 'point_down');
  assert.equal(classify(poses.point()).pose, 'point', 'lateral/foreshortened point stays a pointer');
});

test('three fingers up (index+middle+ring, pinky folded) is three_finger', () => {
  const hand = buildHand({
    thumb: thumbNeutral,
    index: straight({ x: 0.40, y: 0.34 }),
    middle: straight({ x: 0.50, y: 0.30 }),
    ring: straight({ x: 0.58, y: 0.33 }),
    pinky: curled({ x: 0.63, y: 0.685 }),
  });
  const r = classify(hand);
  assert.equal(r.pose, 'three_finger', `got ${r.pose}`);
});

test('ambiguous half-closed hand does nothing (pose none)', () => {
  const lm = poses.point();
  // Two fingers up but not spread (not a V), ring/pinky curled, not a fist:
  // genuinely ambiguous → the classifier must refuse to guess.
  lm[LM.INDEX_PIP] = { x: 0.44, y: 0.50 };
  lm[LM.INDEX_TIP] = { x: 0.45, y: 0.36 };
  lm[LM.MIDDLE_PIP] = { x: 0.50, y: 0.48 };
  lm[LM.MIDDLE_TIP] = { x: 0.48, y: 0.35 };
  const r = classify(lm);
  assert.equal(r.pose, 'none', `expected none, got ${r.pose}`);
  assert.ok(r.confidence <= 0.5, 'ambiguous frames carry low confidence');
});

test('invalid input returns none without throwing', () => {
  assert.equal(classify(null).pose, 'none');
  assert.equal(classify([]).pose, 'none');
  assert.equal(classify([{ x: 0, y: 0 }]).pose, 'none');
});

test('selfie mirroring maps hand-right to screen-right', () => {
  const raw = [{ x: 0.2, y: 0.5 }, { x: 0.9, y: 0.1 }];
  const mirrored = mirrorLandmarks(raw);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !≈ ${b}`);
  close(mirrored[0].x, 0.8);
  close(mirrored[1].x, 0.1);
  assert.equal(mirrored[0].y, 0.5, 'y is unchanged');
  // double mirror = identity (floating point tolerance)
  const back = mirrorLandmarks(mirrored);
  back.forEach((p, i) => assert.ok(Math.abs(p.x - raw[i].x) < 1e-9));
});

test('SwipeTracker fires once per fast sweep and ignores jitter', () => {
  const st = new SwipeTracker();
  let t = 1000;
  const step = (x) => { t += 60; return st.push(x, 0.5, t, { active: true }); };

  // jitter in place → nothing
  assert.equal(step(0.50), null);
  assert.equal(step(0.52), null);
  assert.equal(step(0.49), null);
  assert.equal(step(0.51), null);

  // deliberate left sweep
  const r1 = step(0.40);
  const r2 = step(0.30);
  const r3 = step(0.20);
  assert.ok(r1 === 'left' || r2 === 'left' || r3 === 'left', 'left sweep detected');
  // cooldown prevents immediate re-fire
  assert.equal(step(0.10), null);
});

test('SwipeTracker rejects mostly-vertical movement', () => {
  const st = new SwipeTracker();
  let t = 5000;
  const move = (x, y) => { t += 60; return st.push(x, y, t, { active: true }); };
  let fired = null;
  fired = move(0.5, 0.5) || fired;
  fired = move(0.45, 0.6) || fired;
  fired = move(0.38, 0.75) || fired;
  fired = move(0.30, 0.88) || fired;
  fired = move(0.22, 0.97) || fired;
  assert.equal(fired, null, 'vertical sweep must not trigger prev/next');
});

test('SwipeTracker resets when the hand is not pointing', () => {
  const st = new SwipeTracker();
  let t = 9000;
  st.push(0.5, 0.5, (t += 60), { active: true });
  st.push(0.35, 0.5, (t += 60), { active: true });
  st.push(0.2, 0.5, (t += 60), { active: false }); // inactive frame clears history
  assert.equal(st.push(0.1, 0.5, (t += 60), { active: true }), null, 'needs a fresh window');
});
