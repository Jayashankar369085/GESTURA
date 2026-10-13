// MediaController — complete local music player built on the HTML5 Audio API.
//  * imported files → session object URLs (revoked on removal / unload)
//  * bundled demo tracks → relative paths (work at domain root or any subpath)
//  * playlists, seek, elapsed/total time, volume, shuffle, repeat, artwork
//  * graceful autoplay-block and unsupported-format handling
// No uploads, no remote music, no backend.

import { emit, on } from '../core/events.js';
import { DEMO_TRACKS } from '../data/demo.js';
import { readAudioMetadata, titleFromFilename } from './id3.js';
import { qs, updateRangeFill, formatTime, escapeHtml } from '../core/dom.js';
import { get as storeGet, set as storeSet } from '../core/storage.js';
import * as sounds from '../core/sounds.js';

export class MediaController {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.tracks = [];
    this.index = -1;
    this.playing = false;
    this.status = 'Idle';
    this.error = null;
    this.shuffle = false;
    this.repeat = 'off'; // off | all | one
    this.volume = 60;
    this.muted = false;
    this.seekingUntil = 0;
    this.seq = 0;
  }

  init() {
    // ---- element refs ----
    this.el = {
      empty: qs('#media-empty'),
      main: qs('#media-main'),
      fileInput: qs('#file-input'),
      art: qs('#media-art'),
      badge: qs('#media-badge'),
      title: qs('#media-title'),
      artist: qs('#media-artist'),
      elapsed: qs('#media-elapsed'),
      duration: qs('#media-duration'),
      progress: qs('#media-progress'),
      play: qs('#btn-play'),
      prev: qs('#btn-prev'),
      next: qs('#btn-next'),
      stop: qs('#btn-stop'),
      shuffle: qs('#btn-shuffle'),
      repeat: qs('#btn-repeat'),
      repeatDot: qs('#repeat-dot'),
      mute: qs('#btn-mute'),
      volume: qs('#media-volume'),
      volumeVal: qs('#media-volume-val'),
      status: qs('#media-status'),
      error: qs('#media-error'),
      list: qs('#playlist-list'),
      count: qs('#playlist-count'),
      clear: qs('#btn-clear-playlist'),
    };

    // ---- buttons ----
    const importOpen = () => this.el.fileInput.click();
    qs('#btn-import')?.addEventListener('click', importOpen);
    qs('#btn-import-empty')?.addEventListener('click', importOpen);
    qs('#btn-load-demo')?.addEventListener('click', () => this.loadDemoTracks(true));

    this.el.fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length) this.addFiles(files);
      e.target.value = ''; // allow re-selecting the same file
    });

    this.el.play.addEventListener('click', () => this.togglePlay());
    this.el.next.addEventListener('click', () => this.next('user'));
    this.el.prev.addEventListener('click', () => this.prev());
    this.el.stop.addEventListener('click', () => this.stop());
    this.el.shuffle.addEventListener('click', () => this.setShuffle(!this.shuffle));
    this.el.repeat.addEventListener('click', () => this.cycleRepeat());
    this.el.mute.addEventListener('click', () => this.toggleMute());

    this.el.volume.addEventListener('input', () => this.setVolume(Number(this.el.volume.value), { fromUi: true }));
    this.el.progress.addEventListener('input', () => this.onSeekInput());
    this.el.progress.addEventListener('change', () => { this.seekingUntil = 0; });
    this.el.progress.addEventListener('pointerdown', () => { this.seekingUntil = Infinity; });

    this.el.clear.addEventListener('click', () => this.clear());

    // Keyboard shortcuts + home-widget commands (single entry point).
    on('media:shortcut', ({ command, delta }) => {
      if (command === 'toggle') this.togglePlay();
      else if (command === 'next') this.next('user');
      else if (command === 'prev') this.prev();
      else if (command === 'vol+') this.adjustVolume(delta ?? 5);
      else if (command === 'vol-') this.adjustVolume(-(delta ?? 5));
      else if (command === 'stop') this.stop();
    });

    // ---- audio element events ----
    const a = this.audio;
    a.addEventListener('play', () => { this.playing = true; this.error = null; this.setStatus(`Playing: ${this.current?.title || 'track'}`); this.push(); });
    a.addEventListener('pause', () => { this.playing = false; if (!a.ended) this.setStatus('Paused'); this.push(); });
    a.addEventListener('ended', () => this.onEnded());
    a.addEventListener('timeupdate', () => this.onTimeUpdate());
    a.addEventListener('loadedmetadata', () => {
      this.error = null;
      // Metadata arrived without playback (autoplay off / initial load) —
      // otherwise the status pill would stay stuck on "Loading…".
      if (!this.playing && this.status?.startsWith('Loading')) this.setStatus('Paused');
      this.push();
      this.renderPlayer();
    });
    a.addEventListener('waiting', () => this.setStatus('Buffering…'));
    a.addEventListener('playing', () => this.setStatus(`Playing: ${this.current?.title || 'track'}`));
    a.addEventListener('error', () => this.onAudioError());
    a.addEventListener('volumechange', () => { this.muted = a.muted; this.renderVolume(); this.push(); });

    // Keep in sync with the settings slider.
    on('settings:changed', ({ key, value }) => {
      if (key === 'volume') this.setVolume(value, { fromSettings: true });
      if (key === 'shuffle') this.setShuffle(!!value, { fromSettings: true });
      if (key === 'repeat') this.setRepeat(value, { fromSettings: true });
    });

    window.addEventListener('pagehide', () => this.revokeAll());

    // First run: seed the bundled demo library unless the user cleared it.
    const cleared = storeGet('mediaCleared', false) === true;
    if (!cleared) this.loadDemoTracks(false);
    this.setVolume(this.volume, { init: true });
    this.render();
    this.push();
  }

  // ------------------------------------------------------------------ library
  get current() { return this.tracks[this.index] || null; }

  loadDemoTracks(announce) {
    let added = 0;
    for (const t of DEMO_TRACKS) {
      if (!this.tracks.some((x) => x.id === t.id)) {
        this.tracks.push({ ...t, cover: null, objectUrl: false });
        added += 1;
      }
    }
    if (storeGet('mediaCleared', false) === true && added) storeSet('mediaCleared', false);
    if (this.index < 0 && this.tracks.length) this.select(0, { autoplay: false });
    if (announce) emit('toast', { message: added ? `${added} demo track(s) added` : 'Demo tracks already loaded', level: 'info' });
    this.render();
    this.push();
    return added;
  }

  async addFiles(files) {
    const added = [];
    for (const file of files) {
      if (!file.type.startsWith('audio') && !/\.(mp3|m4a|wav|ogg|flac|aac)$/i.test(file.name)) continue;
      const url = URL.createObjectURL(file);
      const track = {
        id: `f-${Date.now().toString(36)}-${this.seq++}`,
        title: titleFromFilename(file.name),
        artist: 'Local file',
        album: null,
        cover: null,
        src: url,
        objectUrl: true,
        fileName: file.name,
      };
      this.tracks.push(track);
      added.push(track);
      // Metadata parse is best-effort and never blocks adding the track.
      readAudioMetadata(file).then((meta) => {
        if (meta.title) track.title = meta.title;
        if (meta.artist) track.artist = meta.artist;
        if (meta.coverUrl) track.cover = meta.coverUrl;
        this.render();
        if (this.current === track) this.renderPlayer();
      }).catch(() => {});
    }
    if (!added.length) {
      emit('toast', { message: 'No playable audio files selected', level: 'warn' });
      return;
    }
    if (this.index < 0) this.select(0, { autoplay: false });
    emit('toast', { message: `${added.length} track(s) added to the playlist`, level: 'ok' });
    sounds.ok();
    this.render();
    this.push();
  }

  removeTrack(id) {
    const i = this.tracks.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [removed] = this.tracks.splice(i, 1);
    if (removed.objectUrl) URL.revokeObjectURL(removed.src);
    if (removed.cover && removed.cover.startsWith('blob:')) URL.revokeObjectURL(removed.cover);

    if (i === this.index) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      if (this.tracks.length) this.select(Math.min(i, this.tracks.length - 1), { autoplay: false });
      else { this.index = -1; this.setStatus('Idle'); }
    } else if (i < this.index) {
      this.index -= 1;
    }
    this.render();
    this.push();
  }

  clear() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.revokeAll();
    this.tracks = [];
    this.index = -1;
    this.playing = false;
    this.setStatus('Idle');
    storeSet('mediaCleared', true);
    emit('toast', { message: 'Playlist cleared — import music or reload the demo tracks', level: 'info' });
    this.render();
    this.push();
  }

  revokeAll() {
    for (const t of this.tracks) {
      if (t.objectUrl && t.src.startsWith('blob:')) URL.revokeObjectURL(t.src);
      if (t.cover && t.cover.startsWith('blob:')) URL.revokeObjectURL(t.cover);
    }
  }

  // ----------------------------------------------------------------- playback
  select(i, { autoplay = true } = {}) {
    if (!this.tracks.length) { this.setStatus('No tracks'); return; }
    this.index = ((i % this.tracks.length) + this.tracks.length) % this.tracks.length;
    const t = this.current;
    this.audio.src = t.src;
    this.error = null;
    this.setStatus('Loading…');
    this.render();
    this.push();
    if (autoplay) this.play();
  }

  async play() {
    if (!this.current) {
      if (this.tracks.length) return this.select(0);
      this.setStatus('No tracks — import music first');
      this.push();
      return;
    }
    try {
      await this.audio.play();
    } catch (err) {
      if (err?.name === 'NotAllowedError') {
        this.setStatus('Autoplay blocked — press Play to start');
        this.error = null;
      } else {
        this.setStatus('Playback failed');
        this.error = err?.message || 'Could not play this file';
      }
      this.push();
    }
  }

  pause() { this.audio.pause(); }

  togglePlay() {
    if (this.audio.paused) this.play();
    else this.pause();
  }

  stop() {
    this.audio.pause();
    if (Number.isFinite(this.audio.duration)) this.audio.currentTime = 0;
    this.setStatus('Stopped');
    this.renderPlayer();
    this.push();
  }

  next(mode = 'user') {
    if (!this.tracks.length) return;
    let target;
    if (this.shuffle && this.tracks.length > 1) {
      do { target = Math.floor(Math.random() * this.tracks.length); } while (target === this.index);
    } else {
      target = this.index + 1;
      if (target >= this.tracks.length) {
        if (this.repeat === 'all' || mode === 'user') target = 0;
        else { this.setStatus('End of playlist'); this.pause(); return; }
      }
    }
    this.select(target, { autoplay: true });
  }

  prev() {
    if (!this.tracks.length) return;
    if (this.audio.currentTime > 3) { this.audio.currentTime = 0; return; }
    let target = this.index - 1;
    if (target < 0) target = this.repeat === 'all' ? this.tracks.length - 1 : 0;
    this.select(target, { autoplay: true });
  }

  onEnded() {
    if (this.repeat === 'one') {
      this.audio.currentTime = 0;
      this.play();
      return;
    }
    if (this.index === this.tracks.length - 1 && this.repeat !== 'all' && !this.shuffle) {
      this.playing = false;
      this.setStatus('End of playlist');
      this.renderPlayer();
      this.push();
      return;
    }
    this.next('auto');
  }

  onAudioError() {
    const code = this.audio.error?.code;
    const map = {
      1: 'Playback aborted',
      2: 'Network error while loading the track',
      3: 'Decode error — this audio format could not be decoded',
      4: 'Unsupported or missing audio format',
    };
    this.error = map[code] || 'Playback error';
    this.setStatus('Error');
    this.playing = false;
    this.push();
    this.render();
    emit('toast', { message: `${this.current?.title || 'Track'}: ${this.error}`, level: 'err' });
  }

  // ------------------------------------------------------------- volume/seek
  setVolume(v, opts = {}) {
    const val = Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
    this.volume = val;
    this.audio.volume = val / 100;
    if (val > 0 && this.muted) { this.muted = false; this.audio.muted = false; }
    if (!opts.fromSettings) emit('media:volume', { value: val, persisted: !opts.fromUi });
    this.renderVolume();
    this.push();
  }

  adjustVolume(delta) {
    const next = Math.min(100, Math.max(0, this.volume + delta));
    if (next !== this.volume) {
      this.setVolume(next);
      emit('media:volume:changed', { value: next, delta });
    }
    return this.volume;
  }

  toggleMute() {
    this.muted = !this.muted;
    this.audio.muted = this.muted;
    this.renderVolume();
    this.push();
  }

  onSeekInput() {
    const d = this.audio.duration;
    if (!Number.isFinite(d)) return;
    this.seekingUntil = performance.now() + 600;
    const t = (Number(this.el.progress.value) / 100) * d;
    this.audio.currentTime = t;
    this.el.elapsed.textContent = formatTime(t);
  }

  onTimeUpdate() {
    if (performance.now() < this.seekingUntil) return;
    const { currentTime, duration } = this.audio;
    if (Number.isFinite(duration) && duration > 0) {
      this.el.progress.value = String((currentTime / duration) * 100);
      updateRangeFill(this.el.progress);
      this.el.elapsed.textContent = formatTime(currentTime);
      this.el.duration.textContent = formatTime(duration);
    }
    emit('media:progress', { current: currentTime, duration });
  }

  // -------------------------------------------------------------- mode toggles
  setShuffle(on, opts = {}) {
    this.shuffle = !!on;
    this.el.shuffle.classList.toggle('on', this.shuffle);
    this.el.shuffle.setAttribute('aria-pressed', String(this.shuffle));
    this.el.shuffle.setAttribute('aria-label', this.shuffle ? 'Shuffle on' : 'Shuffle off');
    if (!opts.fromSettings) emit('media:modes', { shuffle: this.shuffle, repeat: this.repeat });
    this.push();
  }

  cycleRepeat() {
    const order = ['off', 'all', 'one'];
    this.setRepeat(order[(order.indexOf(this.repeat) + 1) % order.length]);
  }

  setRepeat(mode, opts = {}) {
    if (!['off', 'all', 'one'].includes(mode)) mode = 'off';
    this.repeat = mode;
    this.el.repeat.classList.toggle('on', mode !== 'off');
    this.el.repeat.setAttribute('aria-label', `Repeat: ${mode}`);
    this.el.repeatDot.hidden = mode !== 'one';
    this.el.repeatDot.textContent = '1';
    if (!opts.fromSettings) emit('media:modes', { shuffle: this.shuffle, repeat: this.repeat });
    this.push();
  }

  // ------------------------------------------------------------------- render
  setStatus(text) { this.status = text; this.renderStatus(); }

  push() {
    emit('media:state', {
      hasTracks: this.tracks.length > 0,
      trackCount: this.tracks.length,
      index: this.index,
      title: this.current?.title || null,
      artist: this.current?.artist || null,
      cover: this.current?.cover || null,
      playing: this.playing,
      status: this.status,
      error: this.error,
      volume: this.volume,
      muted: this.muted,
      shuffle: this.shuffle,
      repeat: this.repeat,
    });
  }

  render() {
    const has = this.tracks.length > 0;
    this.el.empty.hidden = has;
    this.el.main.hidden = !has;
    this.el.count.textContent = `${this.tracks.length} track${this.tracks.length === 1 ? '' : 's'}`;
    this.renderPlayer();
    this.renderPlaylist();
    this.renderStatus();
    this.renderVolume();
  }

  renderPlayer() {
    const t = this.current;
    this.el.title.textContent = t ? t.title : 'Nothing playing';
    this.el.artist.textContent = t
      ? `${t.artist || 'Unknown artist'}${t.album ? ` · ${t.album}` : ''}${t.demo ? ' · bundled demo' : ''}`
      : 'Import audio to get started';

    // artwork
    const art = this.el.art;
    art.style.backgroundImage = t?.cover ? `url("${t.cover}")` : '';
    art.classList.toggle('has-cover', !!t?.cover);

    // play/pause icon
    const use = this.el.play.querySelector('use');
    use.setAttribute('href', this.playing ? '#i-pause' : '#i-play');
    this.el.play.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');

    // badge
    this.el.badge.textContent = this.playing ? 'Playing' : (this.index >= 0 ? (this.status === 'Stopped' ? 'Stopped' : 'Paused') : 'Idle');

    const d = this.audio.duration;
    this.el.duration.textContent = Number.isFinite(d) ? formatTime(d) : '0:00';
    this.el.elapsed.textContent = formatTime(this.audio.currentTime || 0);
    if (Number.isFinite(d) && d > 0) {
      this.el.progress.value = String(((this.audio.currentTime || 0) / d) * 100);
      updateRangeFill(this.el.progress);
    }
    this.renderStatus();
  }

  renderPlaylist() {
    const list = this.el.list;
    list.innerHTML = this.tracks.map((t, i) => `
      <li class="track-item ${i === this.index ? 'active' : ''}" data-index="${i}" role="option" aria-selected="${i === this.index}">
        <span class="track-num">${i === this.index && this.playing ? '▶' : i + 1}</span>
        <span class="track-info">
          <span class="track-name">${escapeHtml(t.title)}</span>
          <span class="track-sub">${escapeHtml(t.artist || '')}${t.demo ? ' · bundled' : ' · imported (session only)'}</span>
        </span>
        <button class="track-remove" data-remove="${t.id}" type="button" aria-label="Remove ${escapeHtml(t.title)}">
          <svg class="ico ico-sm"><use href="#i-close"/></svg>
        </button>
      </li>`).join('');

    list.querySelectorAll('.track-item').forEach((li) => {
      li.addEventListener('click', (e) => {
        if (e.target.closest('[data-remove]')) return;
        this.select(Number(li.dataset.index), { autoplay: true });
      });
    });
    list.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeTrack(btn.dataset.remove);
      });
    });
  }

  renderStatus() {
    if (!this.el.status) return;
    this.el.status.textContent = this.status;
    if (this.error) {
      this.el.error.hidden = false;
      this.el.error.textContent = this.error;
    } else {
      this.el.error.hidden = true;
    }
  }

  renderVolume() {
    if (!this.el.volume) return;
    this.el.volume.value = String(this.volume);
    this.el.volumeVal.textContent = this.muted ? 'muted' : String(this.volume);
    updateRangeFill(this.el.volume);
    const use = this.el.mute.querySelector('use');
    use.setAttribute('href', this.muted ? '#i-mute' : '#i-volume');
    this.el.mute.classList.toggle('on', this.muted);
    this.el.mute.setAttribute('aria-label', this.muted ? 'Unmute' : 'Mute');
  }
}
