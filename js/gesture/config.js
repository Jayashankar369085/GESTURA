// Gesture mapping configuration — drives the state machine, the dispatcher and
// the tutorial UI. Every mapping is configurable here and can be enabled or
// disabled per-gesture at runtime (settings are persisted).

export const GESTURE_CONFIG = [
  {
    id: 'point',
    label: 'Point',
    icon: 'i-hand',
    action: 'pointer',
    dwell: 0,
    cooldown: 0,
    desc: 'Extend your index finger to move the pointer around the screen.',
  },
  {
    id: 'pinch',
    label: 'Pinch to select',
    icon: 'i-check',
    action: 'click',
    dwell: 0,
    cooldown: 250,
    desc: 'Touch thumb and index fingertip together to click once per pinch. Keep pinching over a slider to drag it.',
  },
  {
    id: 'thumb_up',
    label: 'Thumb up — volume +',
    icon: 'i-volume',
    action: 'volume_up',
    dwell: 350,
    cooldown: 150,
    repeat: 400,
    desc: 'Fold four fingers and point the thumb up to raise the volume. While held it repeats every 400 ms.',
  },
  {
    id: 'thumb_down',
    label: 'Thumb down — volume −',
    icon: 'i-volume',
    action: 'volume_down',
    dwell: 350,
    cooldown: 150,
    repeat: 400,
    desc: 'Fold four fingers and point the thumb down to lower the volume. While held it repeats every 400 ms.',
  },
  {
    id: 'palm',
    label: 'Open palm — pause',
    icon: 'i-pause',
    action: 'toggle_pause',
    dwell: 900,
    cooldown: 1500,
    hold: true,
    desc: 'Hold an open palm steadily to pause or resume gesture actions.',
  },
  {
    id: 'fist',
    label: 'Fist — gesture lock',
    icon: 'i-lock',
    action: 'toggle_lock',
    dwell: 900,
    cooldown: 1500,
    hold: true,
    desc: 'Hold a closed fist steadily to lock or unlock gesture control. A locked system only responds to the fist.',
  },
  {
    id: 'swipe_left',
    label: 'Swipe left — previous track',
    icon: 'i-prev',
    action: 'prev_track',
    dwell: 0,
    cooldown: 800,
    desc: 'While pointing, sweep your index finger quickly to the left.',
  },
  {
    id: 'swipe_right',
    label: 'Swipe right — next track',
    icon: 'i-next',
    action: 'next_track',
    dwell: 0,
    cooldown: 800,
    desc: 'While pointing, sweep your index finger quickly to the right.',
  },
  {
    id: 'v_sign',
    label: 'V sign — voice control (Navigation only)',
    icon: 'i-mic',
    action: 'voice_control',
    dwell: 800,
    cooldown: 1500,
    hold: true,
    desc: 'Hold index and middle finger up in a V to start voice control — only while the Navigation screen is open. Say “navigate to…”, “find petrol pumps”, “show route”, “zoom in/out”, “clear destination” or “stop listening”.',
  },
  {
    id: 'three_finger',
    label: 'Three fingers — home',
    icon: 'i-home',
    action: 'go_home',
    dwell: 800,
    cooldown: 1500,
    hold: true,
    desc: 'Raise index, middle and ring finger (three fingers) and hold to return to the home dashboard.',
  },
  {
    id: 'point_down',
    label: 'Point down — notifications',
    icon: 'i-bell',
    action: 'open_notifications',
    dwell: 900,
    cooldown: 1500,
    hold: true,
    desc: 'Point your index finger straight down and hold to open the notification centre.',
  },
  {
    id: 'two_finger_pinch',
    label: 'Two-finger pinch — map zoom',
    icon: 'i-plus',
    action: 'map_zoom',
    dwell: 0,
    cooldown: 600,
    enabled: false,
    experimental: true,
    desc: 'Bring thumb, index and middle fingertips together to zoom the map. Disabled by default because it is easy to confuse with a normal pinch.',
  },
];

export const GESTURE_BY_ID = Object.fromEntries(GESTURE_CONFIG.map((g) => [g.id, g]));

/** Default enabled state (before persisted overrides are applied). */
export function defaultEnabledMap() {
  const map = {};
  for (const g of GESTURE_CONFIG) map[g.id] = g.enabled !== false;
  return map;
}

/**
 * Detection tuning derived from the sensitivity slider (1..10).
 * Higher sensitivity → looser pinch distance, lower confidence gate, faster dwell.
 */
export function tuningForSensitivity(sensitivity = 6) {
  const s = Math.min(10, Math.max(1, Number(sensitivity) || 6));
  const t = (s - 1) / 9; // 0..1
  const pinchEnter = 0.26 + t * 0.20; // normalized by hand size
  return {
    sensitivity: s,
    pinchEnter,
    pinchExit: pinchEnter * 1.55,
    confidenceGate: 0.6 - t * 0.22, // 0.60 → 0.38
    dwellScale: 1.35 - t * 0.65, // 1.35 → 0.70
  };
}
