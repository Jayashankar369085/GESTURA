// StorageManager — safe localStorage wrapper.
// Handles missing/malformed stored data, private-mode failures (falls back to
// an in-memory store) and provides a single reset point. No backend, ever.

const PREFIX = 'apexdrive.';
export const STORAGE_KEYS = {
  settings: 'settings',
  callHistory: 'callHistory',
  navSaved: 'navSaved',
  navRecent: 'navRecent',
  notifications: 'notifications',
  widgets: 'widgets',
  gestureEnabled: 'gestureEnabled',
};

const memory = new Map();
let localAvailable = null;

function hasLocal() {
  if (localAvailable !== null) return localAvailable;
  try {
    const k = PREFIX + '__probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    localAvailable = true;
  } catch {
    localAvailable = false;
  }
  return localAvailable;
}

/** Read + JSON.parse a key. Returns `fallback` on any problem. */
export function get(key, fallback = null) {
  const full = PREFIX + key;
  try {
    const raw = hasLocal() ? window.localStorage.getItem(full) : memory.get(full);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[storage] failed to read "${key}", using fallback:`, err);
    return fallback;
  }
}

/** JSON.stringify + persist. Returns false when storage is unavailable. */
export function set(key, value) {
  const full = PREFIX + key;
  let raw;
  try {
    raw = JSON.stringify(value);
  } catch (err) {
    console.warn(`[storage] value for "${key}" is not serializable:`, err);
    return false;
  }
  try {
    if (hasLocal()) window.localStorage.setItem(full, raw);
    else memory.set(full, raw);
    return true;
  } catch (err) {
    // Quota or serialization problems degrade gracefully to memory.
    console.warn(`[storage] failed to write "${key}":`, err);
    try { memory.set(full, raw); } catch { /* give up silently */ }
    return false;
  }
}

export function remove(key) {
  const full = PREFIX + key;
  try {
    if (hasLocal()) window.localStorage.removeItem(full);
    memory.delete(full);
  } catch { /* ignore */ }
}

/** Wipe every apexdrive.* key (settings, history, saved places…). */
export function clearAll() {
  try {
    if (hasLocal()) {
      const doomed = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(PREFIX)) doomed.push(k);
      }
      doomed.forEach((k) => window.localStorage.removeItem(k));
    }
  } catch (err) {
    console.warn('[storage] clearAll failed:', err);
  }
  memory.clear();
}

/**
 * Merge a stored object with defaults, keeping only known keys and applying
 * type checks — protects against malformed/legacy stored shapes.
 */
export function mergeValid(stored, defaults) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return { ...defaults };
  }
  const out = {};
  for (const [k, def] of Object.entries(defaults)) {
    const v = stored[k];
    if (typeof def === 'boolean') out[k] = typeof v === 'boolean' ? v : def;
    else if (typeof def === 'number') out[k] = typeof v === 'number' && Number.isFinite(v) ? v : def;
    else if (typeof def === 'string') out[k] = typeof v === 'string' ? v : def;
    else if (def && typeof def === 'object') out[k] = v && typeof v === 'object' ? { ...def, ...v } : { ...def };
    else out[k] = v === undefined ? def : v;
  }
  return out;
}
