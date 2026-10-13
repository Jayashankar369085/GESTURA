// Minimal typed pub/sub bus. Listener errors are isolated so one broken
// subscriber can never take down an emitter (or the whole app).

const listeners = new Map();

export function on(type, handler) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(handler);
  return () => off(type, handler);
}

export function off(type, handler) {
  const set = listeners.get(type);
  if (set) set.delete(handler);
}

export function emit(type, payload) {
  const set = listeners.get(type);
  if (!set) return;
  for (const handler of [...set]) {
    try {
      handler(payload);
    } catch (err) {
      console.error(`[events] listener for "${type}" failed:`, err);
    }
  }
}

export function clearAllListeners() {
  listeners.clear();
}
