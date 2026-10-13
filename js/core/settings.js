// VehicleSettings — single source of truth for every preference.
// Values are simulated vehicle/UI settings; they persist in localStorage and
// emit `settings:changed` so the UI updates immediately.

import { get, set as storeSet, STORAGE_KEYS, mergeValid } from './storage.js';
import { emit } from './events.js';

export const DEFAULTS = {
  // simulated climate
  ac: false,
  temp: 22,
  fan: 2,
  airflow: 'face',
  recirc: true,
  seatHeat: 0,
  seatVent: 0,
  // display / theme
  brightness: 100,
  theme: 'dark', // dark | day | auto
  ambient: '#38e0d0',
  sounds: true,
  reducedMotion: false,
  cameraPreview: false, // camera feed only ever shows inside the diagnostics drawer
  // media
  volume: 60,
  shuffle: false,
  repeat: 'off', // off | all | one
  // gesture tuning
  sensitivity: 6, // 1..10
  pointerSpeed: 100, // 50..200 (%)
  smoothing: 65, // 0..95
  dwell: 900, // hold-gesture dwell ms (400..2000)
};

let current = { ...DEFAULTS };

export function loadSettings() {
  current = mergeValid(get(STORAGE_KEYS.settings, null), DEFAULTS);
  return { ...current };
}

export function all() { return { ...current }; }

export function getSetting(key) {
  return Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined;
}

export function setSetting(key, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    console.warn(`[settings] ignoring unknown key "${key}"`);
    return false;
  }
  const def = DEFAULTS[key];
  let v = value;
  if (typeof def === 'boolean') v = !!value;
  else if (typeof def === 'number') {
    v = Number(value);
    if (!Number.isFinite(v)) return false;
  } else if (typeof def === 'string') v = String(value);

  if (current[key] === v) return true;
  current[key] = v;
  storeSet(STORAGE_KEYS.settings, current);
  emit('settings:changed', { key, value: v, all: all() });
  return true;
}

export function resetSettings() {
  current = { ...DEFAULTS };
  storeSet(STORAGE_KEYS.settings, current);
  emit('settings:changed', { key: '*', value: null, all: all() });
}

/** Widget visibility map (dashboard customisation). */
const WIDGET_DEFAULTS = { clock: true, music: true, map: true, phone: true, controls: true, climate: true, status: true };

export function loadWidgets() {
  return mergeValid(get(STORAGE_KEYS.widgets, null), WIDGET_DEFAULTS);
}

export function saveWidgets(map) {
  storeSet(STORAGE_KEYS.widgets, mergeValid(map, WIDGET_DEFAULTS));
  emit('widgets:changed', { widgets: loadWidgets() });
}

/** Per-gesture enable/disable map (gesture configurability). */
export function loadGestureEnabled() {
  return mergeValid(get(STORAGE_KEYS.gestureEnabled, null), {});
}

export function saveGestureEnabled(map) {
  storeSet(STORAGE_KEYS.gestureEnabled, map || {});
  emit('gesture-enabled:changed', { map: loadGestureEnabled() });
}
