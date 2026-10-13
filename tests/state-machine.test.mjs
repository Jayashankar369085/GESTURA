// Unit tests for the gesture state machine: dwell timing, cooldowns,
// one-action-per-gesture latching, pinch hysteresis and lock/pause gating.
// Run: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { GestureStateMachine, gateAction } from '../js/gesture/state-machine.js';

const mk = (opts = {}) => new GestureStateMachine({
  minConfidence: 0.5,
  stableFrames: 3,
  pinchEnter: 0.34,
  pinchExit: 0.5,
  dwellScale: 1,
  isEnabled: () => true,
  ...opts,
});

const frame = (f = {}) => ({
  handPresent: true,
  pose: 'none',
  confidence: 0.9,
  pinchRatio: Infinity,
  swipe: null,
  ...f,
});

function run(machine, seq) {
  const events = [];
  let hold = null;
  let pinch = null;
  for (const [t, f] of seq) {
    const r = machine.update(f, t);
    events.push(...r.events);
    if (r.hold) hold = r.hold;
    pinch = r.pinch;
  }
  return { events, hold, pinch };
}

// ------------------------------------------------------------------- pinch
test('pinch fires exactly one click per pinch (hysteresis + latch)', () => {
  const m = mk();
  const { events } = run(m, [
    [0, frame({ pose: 'point', pinchRatio: 0.9 })],
    [100, frame({ pose: 'pinch', pinchRatio: 0.2 })], // frame 1 of confirm — not yet
    [150, frame({ pose: 'pinch', pinchRatio: 0.2 })], // frame 2 → click
    [200, frame({ pose: 'pinch', pinchRatio: 0.2 })], // held → no repeat
    [300, frame({ pose: 'pinch', pinchRatio: 0.25 })],
    [400, frame({ pose: 'pinch', pinchRatio: 0.6 })],  // above exit → opens
    [500, frame({ pose: 'pinch', pinchRatio: 0.2 })],  // second pinch…
    [550, frame({ pose: 'pinch', pinchRatio: 0.2 })],  // …confirmed → click
  ]);
  const clicks = events.filter((e) => e.action === 'click');
  assert.equal(clicks.length, 2, `expected 2 clicks, got ${clicks.length}`);
  assert.ok(clicks[0].at <= 150 && clicks[1].at >= 550);
});

test('a single low-confidence pinch frame never clicks (jitter rejection)', () => {
  const m = mk();
  const { events } = run(m, [
    [0, frame({ pose: 'point', pinchRatio: 0.9 })],
    [100, frame({ pose: 'pinch', pinchRatio: 0.2 })], // one frame only…
    [200, frame({ pose: 'point', pinchRatio: 0.9 })], // …then opens again
  ]);
  assert.equal(events.filter((e) => e.action === 'click').length, 0);
});

test('no click when recognition is ambiguous (low confidence)', () => {
  const m = mk();
  const { events } = run(m, [
    [0, frame({ pose: 'pinch', pinchRatio: 0.2, confidence: 0.2 })],
    [100, frame({ pose: 'pinch', pinchRatio: 0.2, confidence: 0.25 })],
    [200, frame({ pose: 'pinch', pinchRatio: 0.1, confidence: 0.1 })],
  ]);
  assert.equal(events.length, 0);
});

test('pinch in the ambiguous zone between enter/exit does not re-fire', () => {
  const m = mk();
  const { events } = run(m, [
    [0, frame({ pinchRatio: 0.2 })],
    [50, frame({ pinchRatio: 0.2 })], // confirm → click
    [400, frame({ pinchRatio: 0.42 })], // between enter (0.34) and exit (0.5) → stays closed
    [800, frame({ pinchRatio: 0.42 })],
  ]);
  assert.equal(events.filter((e) => e.action === 'click').length, 1);
});

// ------------------------------------------------------------ hold gestures
test('palm dwell: nothing before dwell time, then a single toggle', () => {
  const m = mk();
  const seq = [];
  for (let t = 0; t <= 800; t += 100) seq.push([t, frame({ pose: 'palm' })]);
  const before = run(m, seq);
  assert.equal(before.events.length, 0, 'must not fire before 900 ms');

  const after = run(m, [
    [900, frame({ pose: 'palm' })],
    [1200, frame({ pose: 'palm' })],
    [3000, frame({ pose: 'palm' })], // still held → no repeat
  ]);
  assert.equal(after.events.length, 1, 'fires once while held');
  assert.equal(after.events[0].action, 'toggle_pause');
});

test('hold gesture re-arms only after the hand leaves the pose', () => {
  const m = mk();
  const seq = [];
  for (let t = 0; t <= 1000; t += 100) seq.push([t, frame({ pose: 'fist' })]);
  const first = run(m, seq);
  assert.equal(first.events.length, 1);

  // still a fist → nothing more, even long after
  const held = run(m, [[5000, frame({ pose: 'fist' })]]);
  assert.equal(held.events.length, 0, 'held gesture never re-fires');

  // leave, wait out the cooldown, come back → allowed again
  const rearm = run(m, [[6000, frame({ pose: 'none' })]]);
  assert.equal(rearm.events.length, 0);
  const seq2 = [];
  for (let t = 7000; t <= 8100; t += 100) seq2.push([t, frame({ pose: 'fist' })]);
  const second = run(m, seq2);
  assert.equal(second.events.length, 1, 're-armed after exit + cooldown');
});

test('cooldown suppresses a too-quick re-trigger', () => {
  const m = mk();
  const first = run(m, [
    [0, frame({ pose: 'v_sign' })],
    [100, frame({ pose: 'v_sign' })],
    [200, frame({ pose: 'v_sign' })],
    [900, frame({ pose: 'v_sign' })], // dwell met → fire
  ]);
  assert.equal(first.events.length, 1);

  // exit, then re-enter: dwell completes at 2000, cooldown runs until 2400.
  run(m, [[1000, frame({ pose: 'none' })]]);
  const early = [];
  for (let t = 1100; t <= 2100; t += 100) early.push([t, frame({ pose: 'v_sign' })]);
  assert.equal(run(m, early).events.length, 0, 'suppressed while cooldown active');

  const later = run(m, [
    [2400, frame({ pose: 'v_sign' })],
    [2500, frame({ pose: 'v_sign' })],
  ]);
  assert.equal(later.events.length, 1, 'allowed once cooldown expires');
  assert.ok(later.events[0].at >= 2400);
});

// ----------------------------------------------------------------- volume
test('thumb up repeats at the configured interval while held', () => {
  const m = mk();
  const seq = [];
  for (let t = 0; t <= 1400; t += 50) seq.push([t, frame({ pose: 'thumb_up' })]);
  const { events } = run(m, seq);
  const fires = events.filter((e) => e.action === 'volume_up');
  assert.ok(fires.length >= 3, `expected ≥3 volume steps, got ${fires.length}`);
  assert.ok(fires.length <= 5, `rate-limited: got ${fires.length}`);
  const gaps = fires.slice(1).map((e, i) => e.at - fires[i].at);
  for (const g of gaps) assert.ok(g >= 400, `repeat gap ${g} ms must be ≥400`);
});

test('thumb down maps to volume_down and does not fire before dwell', () => {
  const m = mk();
  const seq = [];
  for (let t = 0; t <= 340; t += 50) seq.push([t, frame({ pose: 'thumb_down' })]);
  assert.equal(run(m, seq).events.length, 0, 'dwell 350 not yet met');
  const later = run(m, [[400, frame({ pose: 'thumb_down' })]]);
  assert.equal(later.events.length, 1);
  assert.equal(later.events[0].action, 'volume_down');
});

// ------------------------------------------------------------------ swipes
test('swipe fires once and respects cooldown', () => {
  const m = mk();
  const { events } = run(m, [
    [0, frame({ pose: 'point', swipe: 'left' })],
    [100, frame({ pose: 'point', swipe: 'left' })],
    [200, frame({ pose: 'point', swipe: 'right' })],
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'prev_track');
  const later = run(m, [[1200, frame({ pose: 'point', swipe: 'right' })]]);
  assert.equal(later.events.length, 1, 'allowed after cooldown');
  assert.equal(later.events[0].action, 'next_track');
});

// ------------------------------------------------------------- hand lost
test('losing the hand resets latches so the next pinch works', () => {
  const m = mk();
  run(m, [
    [0, frame({ pose: 'pinch', pinchRatio: 0.2 })],
    [50, frame({ pose: 'pinch', pinchRatio: 0.2 })],
  ]);
  const lost = run(m, [
    [100, frame({ handPresent: false })],
    [200, frame({ handPresent: false })],
  ]);
  assert.equal(lost.events.length, 0);
  const back = run(m, [
    [900, frame({ pose: 'pinch', pinchRatio: 0.2 })],
    [950, frame({ pose: 'pinch', pinchRatio: 0.2 })],
  ]);
  assert.equal(back.events.filter((e) => e.action === 'click').length, 1);
});

test('disabled gestures never fire', () => {
  const m = mk({ isEnabled: (id) => id !== 'palm' });
  const seq = [];
  for (let t = 0; t <= 1200; t += 100) seq.push([t, frame({ pose: 'palm' })]);
  assert.equal(run(m, seq).events.length, 0);
});

test('hold progress is reported for visual feedback', () => {
  const m = mk();
  const seq = [];
  for (let t = 0; t <= 500; t += 100) seq.push([t, frame({ pose: 'palm' })]);
  let lastHold = null;
  for (const [t, f] of seq) {
    const r = m.update(f, t);
    if (r.hold) lastHold = r.hold;
  }
  assert.ok(lastHold && lastHold.gesture === 'palm');
  assert.ok(lastHold.progress > 0 && lastHold.progress <= 1, `progress ${lastHold.progress}`);
});

// --------------------------------------------------------------- gating
test('gateAction enforces lock and pause semantics', () => {
  assert.equal(gateAction('next_track', {}), 'next_track');
  assert.equal(gateAction('pointer', {}), null, 'pointer frames are never dispatched');
  assert.equal(gateAction(null, {}), null);

  // locked: only the unlock toggle passes (including pinch clicks being blocked)
  assert.equal(gateAction('toggle_lock', { locked: true }), 'toggle_lock');
  assert.equal(gateAction('next_track', { locked: true }), null);
  assert.equal(gateAction('click', { locked: true }), null, 'locked means no clicks');
  assert.equal(gateAction('volume_up', { locked: true }), null);

  // paused: only pause/lock toggles pass
  assert.equal(gateAction('toggle_pause', { paused: true }), 'toggle_pause');
  assert.equal(gateAction('toggle_lock', { paused: true }), 'toggle_lock');
  assert.equal(gateAction('click', { paused: true }), null);
  assert.equal(gateAction('go_home', { paused: true }), null);

  // unlocked + running everything passes
  assert.equal(gateAction('click', { locked: false, paused: false }), 'click');
});
