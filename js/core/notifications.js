// Notification centre — in-memory + persisted, capped list.

import { get, set, STORAGE_KEYS } from './storage.js';
import { emit } from './events.js';

const MAX = 40;
let items = [];
let seq = 1;

function normalise(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n) => n && typeof n === 'object')
    .map((n) => ({
      id: typeof n.id === 'string' ? n.id : `n-${Math.random().toString(36).slice(2)}`,
      title: typeof n.title === 'string' ? n.title : 'Notification',
      body: typeof n.body === 'string' ? n.body : '',
      level: ['info', 'warn', 'err', 'ok'].includes(n.level) ? n.level : 'info',
      ts: Number.isFinite(n.ts) ? n.ts : Date.now(),
      read: n.read === true,
    }))
    .slice(0, MAX);
}

export function loadNotifications() {
  items = normalise(get(STORAGE_KEYS.notifications, []));
}

export function list() { return [...items]; }
export function unreadCount() { return items.filter((n) => !n.read).length; }

export function notify(title, body = '', level = 'info') {
  const item = {
    id: `n-${Date.now().toString(36)}-${seq++}`,
    title: String(title),
    body: String(body),
    level,
    ts: Date.now(),
    read: false,
  };
  items.unshift(item);
  items = items.slice(0, MAX);
  persist();
  emit('notif:changed', { items: list(), unread: unreadCount() });
  return item;
}

export function markAllRead() {
  items.forEach((n) => { n.read = true; });
  persist();
  emit('notif:changed', { items: list(), unread: 0 });
}

export function clearNotifications() {
  items = [];
  persist();
  emit('notif:changed', { items: [], unread: 0 });
}

function persist() {
  set(STORAGE_KEYS.notifications, items.slice(0, MAX));
}
