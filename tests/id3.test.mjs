// Unit tests for the local ID3v2 metadata parser (synthetic tags, no files
// written to disk). Run: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readAudioMetadata, titleFromFilename } from '../js/media/id3.js';

const latin1 = (s) => [...s].map((c) => c.charCodeAt(0) & 0xff);

function v23Frame(id, bodyBytes) {
  const size = bodyBytes.length;
  return [
    ...latin1(id),
    (size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff,
    0x00, 0x00,
    ...bodyBytes,
  ];
}

function textFrame(id, text) {
  return v23Frame(id, [0x00, ...latin1(text)]); // encoding 0 = ISO-8859-1
}

function buildTag(frames) {
  const body = frames.flat();
  const size = body.length;
  const synchsafe = [
    (size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0xff,
  ];
  return new Uint8Array([
    ...latin1('ID3'), 0x03, 0x00, 0x00, // v2.3, no flags
    ...synchsafe,
    ...body,
  ]);
}

test('parses ID3v2.3 title and artist', async () => {
  const bytes = buildTag([textFrame('TIT2', 'Midnight Drive'), textFrame('TPE1', 'Synthwave Cat')]);
  const file = new File([bytes, new Uint8Array([0x11, 0x22, 0x33])], 'track.mp3', { type: 'audio/mpeg' });
  const meta = await readAudioMetadata(file);
  assert.equal(meta.title, 'Midnight Drive');
  assert.equal(meta.artist, 'Synthwave Cat');
  assert.equal(meta.coverUrl, null);
});

test('returns nulls for files without a tag', async () => {
  const file = new File([new Uint8Array([0x01, 0x02, 0x03, 0x04])], 'bare.mp3');
  const meta = await readAudioMetadata(file);
  assert.deepEqual(meta, { title: null, artist: null, album: null, coverUrl: null });
});

test('tolerates a truncated/corrupt tag without throwing', async () => {
  const bytes = buildTag([textFrame('TIT2', 'Broken')]);
  const truncated = bytes.subarray(0, 8); // header claims a larger size
  const file = new File([truncated], 'bad.mp3');
  const meta = await readAudioMetadata(file);
  assert.equal(meta.title, null);
});

test('titleFromFilename cleans up names', () => {
  assert.equal(titleFromFilename('song 2.mp3'), 'song 2');
  assert.equal(titleFromFilename('my_track_one.wav'), 'my track one');
  assert.equal(titleFromFilename(''), 'Untitled');
});
