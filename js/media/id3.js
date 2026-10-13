// Minimal ID3v2 (v2.3 / v2.4) reader — title, artist, album and cover art.
// Local file reads only; nothing is uploaded. Falls back to the filename.

const MAX_TAG_BYTES = 8 * 1024 * 1024; // ignore absurd tags (covers can be big)

function decodeText(bytes, encoding) {
  try {
    if (encoding === 0) return new TextDecoder('iso-8859-1').decode(bytes); // latin1
    if (encoding === 1) {
      // UTF-16 with BOM
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
      return new TextDecoder('utf-16le').decode(bytes);
    }
    if (encoding === 2) return new TextDecoder('utf-16be').decode(bytes);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

function readTerminator(bytes, start, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let i = start; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    }
    return -1;
  }
  for (let i = start; i < bytes.length; i += 1) {
    if (bytes[i] === 0) return i;
  }
  return -1;
}

function readSyncsafe(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21)
    | ((bytes[offset + 1] & 0x7f) << 14)
    | ((bytes[offset + 2] & 0x7f) << 7)
    | (bytes[offset + 3] & 0x7f);
}

function readFrameSize(bytes, offset, versionMinor) {
  if (versionMinor === 4) return readSyncsafe(bytes, offset);
  // v2.3 uses a plain big-endian 32-bit size (top bit unused in practice)
  return ((bytes[offset] << 24) >>> 0)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3];
}

/**
 * @param {File} file
 * @returns {Promise<{title:string|null, artist:string|null, album:string|null, coverUrl:string|null}>}
 */
export async function readAudioMetadata(file) {
  const out = { title: null, artist: null, album: null, coverUrl: null };
  try {
    if (file.size < 20) return out;
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (String.fromCharCode(...head.subarray(0, 3)) !== 'ID3') return out;

    const versionMinor = head[3];
    const tagSize = readSyncsafe(head, 6);
    if (tagSize <= 0 || tagSize > MAX_TAG_BYTES) return out;

    const buf = new Uint8Array(await file.slice(0, 10 + tagSize).arrayBuffer());
    let pos = 10;
    if (head[5] & 0x40) pos += readSyncsafe(buf, 10); // skip extended header

    while (pos + 10 <= buf.length) {
      const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = readFrameSize(buf, pos + 4, versionMinor);
      if (size <= 0 || pos + 10 + size > buf.length) break;
      const body = buf.subarray(pos + 10, pos + 10 + size);

      if (id === 'TIT2' || id === 'TPE1' || id === 'TALB') {
        const enc = body[0];
        const text = decodeText(body.subarray(1), enc).replace(/\0+$/, '').trim();
        if (text) {
          if (id === 'TIT2') out.title = text;
          else if (id === 'TPE1') out.artist = text;
          else out.album = text;
        }
      } else if (id === 'APIC' && !out.coverUrl) {
        const enc = body[0];
        const mimeEnd = body.indexOf(0, 1);
        if (mimeEnd > 0) {
          const mime = decodeText(body.subarray(1, mimeEnd), 0) || 'image/jpeg';
          const descStart = mimeEnd + 2; // skip picture-type byte
          const descEnd = readTerminator(body, descStart, enc);
          const dataStart = descEnd >= 0 ? descEnd + ((enc === 1 || enc === 2) ? 2 : 1) : descStart;
          if (dataStart < body.length) {
            const blob = new Blob([body.subarray(dataStart)], { type: mime.trim() || 'image/jpeg' });
            out.coverUrl = URL.createObjectURL(blob);
          }
        }
      }

      pos += 10 + size;
      if (out.title && out.artist && out.coverUrl) break;
    }
  } catch (err) {
    console.warn('[id3] metadata read failed:', err);
  }
  return out;
}

/** Fallback title from the file name (extension removed). */
export function titleFromFilename(name) {
  return String(name || 'Untitled')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_]+/g, ' ')
    .trim() || 'Untitled';
}
