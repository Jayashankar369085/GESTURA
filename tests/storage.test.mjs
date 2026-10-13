// Unit tests for StorageManager safety: malformed stored data must never
// crash the app, defaults must be restored, and types must be enforced.
// In Node there is no window.localStorage, so these run against the
// in-memory fallback path — which is itself part of what we're testing.
// Run: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { get, set, remove, clearAll, mergeValid, STORAGE_KEYS } from '../js/core/storage.js';

const DEFAULTS = {
  ac: false,
  temp: 22,
  theme: 'dark',
  volume: 60,
  nested: { a: 1 },
};

test('set/get round-trip', () => {
  assert.equal(set('roundtrip', { hello: 'world' }), true);
  assert.deepEqual(get('roundtrip'), { hello: 'world' });
  remove('roundtrip');
  assert.equal(get('roundtrip', null), null);
});

test('missing key returns the provided fallback', () => {
  assert.equal(get('does-not-exist', 42), 42);
  assert.deepEqual(get('does-not-exist', []), []);
});

test('clearAll removes only apexdrive.* keys (memory path clears everything)', () => {
  set('a', 1);
  set('b', 2);
  clearAll();
  assert.equal(get('a', null), null);
  assert.equal(get('b', null), null);
});

test('mergeValid restores defaults for null/malformed stored data', () => {
  assert.deepEqual(mergeValid(null, DEFAULTS), DEFAULTS);
  assert.deepEqual(mergeValid('a string', DEFAULTS), DEFAULTS);
  assert.deepEqual(mergeValid([1, 2], DEFAULTS), DEFAULTS);
  assert.deepEqual(mergeValid(undefined, DEFAULTS), DEFAULTS);
});

test('mergeValid coerces wrong types back to defaults', () => {
  const out = mergeValid(
    { ac: 'yes', temp: 'hot', theme: 12, volume: null, nested: 'nope', unknownKey: true },
    DEFAULTS,
  );
  assert.equal(out.ac, false, 'non-boolean restored to default');
  assert.equal(out.temp, 22, 'non-number restored to default');
  assert.equal(out.theme, 'dark', 'non-string restored to default');
  assert.equal(out.volume, 60, 'null restored to default');
  assert.deepEqual(out.nested, { a: 1 }, 'object restored from default');
  assert.equal('unknownKey' in out, false, 'unknown keys dropped');
});

test('mergeValid accepts valid overrides and merges nested objects', () => {
  const out = mergeValid({ ac: true, temp: 19, nested: { b: 2 } }, DEFAULTS);
  assert.equal(out.ac, true);
  assert.equal(out.temp, 19);
  assert.deepEqual(out.nested, { a: 1, b: 2 }, 'nested defaults preserved');
});

test('non-finite numbers are rejected by mergeValid', () => {
  const out = mergeValid({ temp: NaN }, DEFAULTS);
  assert.equal(out.temp, 22);
  const out2 = mergeValid({ temp: Infinity }, DEFAULTS);
  assert.equal(out2.temp, 22);
});

test('set() refuses unserializable values without throwing', () => {
  const circular = {};
  circular.self = circular;
  assert.equal(set('circular', circular), false, 'returns false instead of throwing');
});

test('storage keys used by the app are namespaced', () => {
  assert.equal(STORAGE_KEYS.settings, 'settings');
  assert.equal(STORAGE_KEYS.callHistory, 'callHistory');
});
