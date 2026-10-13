// NavigationController — Leaflet + OpenStreetMap with Nominatim search and
// OSRM route preview. Honest about capabilities: destination search is NOT
// turn-by-turn navigation; distances/times are only shown when the routing
// service actually returns a route. Map failures degrade to a fallback panel
// without affecting any other module.

import { emit, on } from '../core/events.js';
import { qs, escapeHtml } from '../core/dom.js';
import { get as storeGet, set as storeSet, STORAGE_KEYS } from '../core/storage.js';
import * as sounds from '../core/sounds.js';
import { VoiceControl } from './voice.js';

const LEAFLET_VERSION = '1.9.4';
const LEAFLET_JS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;

// Simulated vehicle position (preserved from the original project).
export const HOME_BASE = { lat: 12.84094147761589, lng: 77.5112775357779, name: 'Home base · Jyothy Institute, Bengaluru' };

let leafletPromise = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const existing = document.querySelector(`script[src="${LEAFLET_JS}"]`);
    const script = existing || document.createElement('script');
    const timer = setTimeout(() => reject(new Error('Map library load timed out')), 12000);
    script.onload = () => { clearTimeout(timer); window.L ? resolve(window.L) : reject(new Error('Leaflet missing after load')); };
    script.onerror = () => { clearTimeout(timer); leafletPromise = null; reject(new Error('Map library failed to load (offline?)')); };
    script.src = LEAFLET_JS;
    if (!existing) document.head.appendChild(script);
  });
  return leafletPromise;
}

function divIcon(kind) {
  return window.L.divIcon({
    className: 'apex-marker-wrap',
    html: `<span class="apex-marker apex-marker-${kind}"></span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

export class NavigationController {
  constructor() {
    this.map = null;
    this.preview = null;
    this.mapFailed = false;
    this.destMarker = null;
    this.dest = null;
    this.routeLine = null;
    this.routeFrom = null;
    this.searching = false;
    this.lastSearchAt = 0;
    this.abort = null;
    this.cache = new Map();
    this.saved = normalisePlaces(getSafe(STORAGE_KEYS.navSaved, []));
    this.recents = normalisePlaces(getSafe(STORAGE_KEYS.navRecent, []));
  }

  init() {
    this.el = {
      feedback: qs('#nav-feedback'),
      results: qs('#nav-results'),
      search: qs('#nav-search'),
      destCard: qs('#nav-dest-card'),
      destName: qs('#nav-dest-name'),
      destCoords: qs('#nav-dest-coords'),
      routeInfo: qs('#nav-route-info'),
      routeDist: qs('#route-distance'),
      routeDur: qs('#route-duration'),
      saved: qs('#nav-saved'),
      savedEmpty: qs('#nav-saved-empty'),
      recents: qs('#nav-recent'),
      recentsEmpty: qs('#nav-recent-empty'),
      fallback: qs('#nav-map-fallback'),
      fallbackMsg: qs('#nav-map-fallback-msg'),
      homeDest: qs('#home-dest'),
    };

    qs('#btn-nav-search').addEventListener('click', () => this.search());
    this.el.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.search(); }
    });
    qs('#btn-recenter').addEventListener('click', () => this.recenter());
    qs('#btn-zoom-in').addEventListener('click', () => this.map?.zoomIn());
    qs('#btn-zoom-out').addEventListener('click', () => this.map?.zoomOut());
    qs('#btn-route').addEventListener('click', () => this.route());
    qs('#btn-save-place').addEventListener('click', () => this.saveCurrent());
    qs('#btn-clear-dest').addEventListener('click', () => this.clearDestination());
    qs('#btn-clear-recent').addEventListener('click', () => this.clearRecents());
    qs('#btn-retry-map').addEventListener('click', () => { this.mapFailed = false; this.ensureMap(true); });
    qs('#home-recenter-btn').addEventListener('click', () => this.recenter());

    this.renderSaved();
    this.renderRecents();

    // Voice control (Navigation-only) — V-sign gesture or the mic button.
    this.uiPage = 'home';
    this.voice = new VoiceControl(this);

    on('page:changed', ({ page }) => this.onPage(page));
  }

  onPage(page) {
    this.uiPage = page;
    if (page === 'nav') this.ensureMap();
    if (page === 'home') this.ensurePreview();
  }

  // ----------------------------------------------------------------- maps
  async ensureMap(force = false) {
    if (this.map && !force) { this.invalidate(); return; }
    this.el.fallback.hidden = true;
    try {
      const L = await loadLeaflet();
      if (!this.map) {
        this.map = L.map('map', {
          center: [HOME_BASE.lat, HOME_BASE.lng],
          zoom: 15,
          zoomControl: false,
          attributionControl: true,
        });
        this.addTiles(this.map);
        L.control.attribution({ position: 'bottomleft' }).addTo(this.map);
        if (this.dest) this.paintDestination(this.dest);
        if (this.routeLine) this.routeLine.addTo(this.map);
      }
      this.map.invalidateSize();
      this.mapFailed = false;
    } catch (err) {
      console.warn('[nav] map init failed:', err);
      this.mapFailed = true;
      this.el.fallbackMsg.textContent = `${err.message}. Other modules keep working — retry when you are back online.`;
      this.el.fallback.hidden = false;
      emit('toast', { message: 'Map unavailable — navigation degraded, everything else still works', level: 'warn' });
    }
  }

  addTiles(map) {
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      className: 'leaflet-dark-tiles',
    }).addTo(map);
  }

  async ensurePreview() {
    if (this.preview) { this.preview.invalidateSize(); return; }
    try {
      const L = await loadLeaflet();
      this.preview = L.map('home-map', {
        center: [HOME_BASE.lat, HOME_BASE.lng],
        zoom: 14,
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
      });
      this.addTiles(this.preview);
      if (this.dest) this.preview.setView([this.dest.lat, this.dest.lng], 15);
      this.preview.invalidateSize();
    } catch (err) {
      console.warn('[nav] preview map failed:', err);
      qs('#home-map').innerHTML =
        '<div class="map-mini-fallback">Map preview unavailable — you are probably offline.</div>';
    }
  }

  invalidate() {
    setTimeout(() => { this.map?.invalidateSize(); this.preview?.invalidateSize(); }, 120);
  }

  recenter() {
    if (!this.map) { this.ensureMap(); return; }
    this.map.setView([HOME_BASE.lat, HOME_BASE.lng], 15);
    this.feedback(`Recentered on ${HOME_BASE.name}`, 'ok');
    sounds.click();
  }

  /** One-shot zoom step (used by the optional two-finger-pinch gesture). */
  zoom(dir = 1) {
    if (!this.map) return;
    if (dir > 0) this.map.zoomIn();
    else this.map.zoomOut();
  }

  // ---------------------------------------------------------------- search
  /**
   * Search Nominatim.
   * @param {string} [query] explicit query (voice control / callers); when
   *   omitted the search field's value is used.
   * @returns {Promise<Array>} the (possibly cached) results — [] on failure.
   */
  async search(query) {
    const q = (query !== undefined ? String(query) : this.el.search.value).trim();
    if (query !== undefined && document.activeElement !== this.el.search) this.el.search.value = q;
    if (q.length < 3) {
      this.feedback('Enter at least 3 characters to search.', 'err');
      this.renderResults([]);
      return [];
    }
    const now = Date.now();
    if (this.searching || now - this.lastSearchAt < 1100) {
      if (this.searching) return [];
      this.feedback('Please wait a moment between searches (Nominatim rate limit).', 'err');
      return [];
    }
    this.lastSearchAt = now;

    if (this.cache.has(q)) {
      this.renderResults(this.cache.get(q));
      return this.cache.get(q);
    }

    this.searching = true;
    this.abort?.abort();
    this.abort = new AbortController();
    this.feedback('Searching…');
    this.renderResults([]);
    sounds.click();

    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { signal: this.abort.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const results = (Array.isArray(data) ? data : []).map((r) => ({
        name: (r.name || '').toString(),
        label: (r.display_name || '').toString(),
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
      })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
      this.cache.set(q, results);
      if (!results.length) {
        this.feedback(`No results for “${q}”.`, 'err');
      } else {
        this.feedback(`${results.length} result(s) — pick one.`, 'ok');
      }
      this.renderResults(results);
      return results;
    } catch (err) {
      if (err.name === 'AbortError') return [];
      console.warn('[nav] search failed:', err);
      this.feedback('Search unavailable — check your internet connection. Other modules keep working.', 'err');
      this.renderResults([]);
      return [];
    } finally {
      this.searching = false;
    }
  }

  renderResults(results) {
    this.el.results.innerHTML = results.map((r, i) => `
      <li class="result-item" data-result="${i}">
        <svg class="ico ico-sm"><use href="#i-nav"/></svg>
        <span>${escapeHtml(r.name || r.label)}<span class="sub">${escapeHtml(r.label)}</span></span>
      </li>`).join('');
    this.el.results.querySelectorAll('[data-result]').forEach((li) => {
      li.addEventListener('click', () => this.selectDestination(results[Number(li.dataset.result)]));
    });
  }

  selectDestination(place) {
    if (!place) return;
    this.dest = place;
    this.clearRoute();
    this.el.destCard.hidden = false;
    this.el.destName.textContent = place.label || place.name;
    this.el.destCoords.textContent = `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`;
    this.el.routeInfo.hidden = true;
    this.el.homeDest.textContent = place.name || place.label;
    emit('nav:destination', { dest: { ...place } });

    this.addRecent(place);
    this.feedback(`Destination set: ${place.name || place.label}`, 'ok');
    sounds.ok();

    this.ensureMap().then(() => {
      this.paintDestination(place);
      this.map?.setView([place.lat, place.lng], 15);
    });
    if (this.preview) this.preview.setView([place.lat, place.lng], 15);
  }

  paintDestination(place) {
    if (!this.map || !window.L) return;
    if (this.destMarker) this.destMarker.remove();
    this.destMarker = window.L.marker([place.lat, place.lng], { icon: divIcon('dest') })
      .addTo(this.map)
      .bindPopup(escapeHtml(place.label || place.name));
  }

  clearDestination() {
    this.dest = null;
    this.destMarker?.remove();
    this.destMarker = null;
    this.clearRoute();
    this.el.destCard.hidden = true;
    this.el.homeDest.textContent = 'No destination set';
    emit('nav:destination', { dest: null });
    this.feedback('Destination cleared.');
  }

  // ----------------------------------------------------------------- routes
  clearRoute() {
    if (this.routeLine) { this.routeLine.remove(); this.routeLine = null; }
    this.el.routeInfo.hidden = true;
    this.routeFrom = null;
  }

  async route() {
    if (!this.dest) return;
    if (!this.map) await this.ensureMap();
    this.el.routeInfo.hidden = true;
    this.feedback('Calculating route…');

    try {
      const url = `https://router.project-osrm.org/route/v1/driving/`
        + `${HOME_BASE.lng},${HOME_BASE.lat};${this.dest.lng},${this.dest.lat}`
        + `?overview=full&geometries=geojson`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const route = data?.routes?.[0];
      if (!route) throw new Error('no route');

      this.clearRoute();
      const coords = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      this.routeLine = window.L.polyline(coords, { color: '#38e0d0', weight: 5, opacity: 0.85 }).addTo(this.map);
      this.map.fitBounds(this.routeLine.getBounds(), { padding: [40, 40] });

      this.el.routeDist.textContent = route.distance >= 1000
        ? `${(route.distance / 1000).toFixed(1)} km`
        : `${Math.round(route.distance)} m`;
      const mins = Math.round(route.duration / 60);
      this.el.routeDur.textContent = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} m` : `${mins} min`;
      this.el.routeInfo.hidden = false;
      this.feedback('Route preview from the simulated vehicle position (OSRM demo server).', 'ok');
    } catch (err) {
      console.warn('[nav] routing failed:', err);
      this.feedback('Routing unavailable right now — no distance or travel time is shown. Try again later.', 'err');
    }
  }

  // --------------------------------------------------------- saved / recents
  saveCurrent() {
    if (!this.dest) return;
    if (this.saved.some((p) => p.lat === this.dest.lat && p.lng === this.dest.lng)) {
      emit('toast', { message: 'Already in saved places', level: 'info' });
      return;
    }
    this.saved.unshift({ name: this.dest.name || this.dest.label, label: this.dest.label, lat: this.dest.lat, lng: this.dest.lng });
    this.saved = this.saved.slice(0, 20);
    storeSet(STORAGE_KEYS.navSaved, this.saved);
    this.renderSaved();
    emit('toast', { message: 'Place saved', level: 'ok' });
    sounds.ok();
  }

  addRecent(place) {
    this.recents = this.recents.filter((p) => !(p.lat === place.lat && p.lng === place.lng));
    this.recents.unshift({ name: place.name || place.label, label: place.label, lat: place.lat, lng: place.lng, ts: Date.now() });
    this.recents = this.recents.slice(0, 10);
    storeSet(STORAGE_KEYS.navRecent, this.recents);
    this.renderRecents();
  }

  clearRecents() {
    this.recents = [];
    storeSet(STORAGE_KEYS.navRecent, []);
    this.renderRecents();
  }

  removeSaved(lat, lng) {
    this.saved = this.saved.filter((p) => !(p.lat === lat && p.lng === lng));
    storeSet(STORAGE_KEYS.navSaved, this.saved);
    this.renderSaved();
  }

  renderSaved() {
    const items = this.saved.map((p, i) => placeRow(p, 'saved', i)).join('');
    this.el.saved.innerHTML = items;
    this.el.savedEmpty.hidden = this.saved.length > 0;
    bindPlaceRows(this.el.saved, 'saved', this.saved, (p) => this.selectDestination(p), (p) => this.removeSaved(p.lat, p.lng));
  }

  renderRecents() {
    const items = this.recents.map((p, i) => placeRow(p, 'recent', i)).join('');
    this.el.recents.innerHTML = items;
    this.el.recentsEmpty.hidden = this.recents.length > 0;
    bindPlaceRows(this.el.recents, 'recent', this.recents, (p) => this.selectDestination(p), null);
  }

  feedback(msg, kind = '') {
    this.el.feedback.textContent = msg;
    this.el.feedback.className = `nav-feedback ${kind}`;
  }
}

// ------------------------------------------------------------------ helpers
function getSafe(key, fallback) {
  const v = storeGet(key, fallback);
  return v == null ? fallback : v;
}

function normalisePlaces(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => ({ name: String(p.name || p.label || 'Place'), label: String(p.label || p.name || ''), lat: p.lat, lng: p.lng, ts: p.ts || 0 }));
}

function placeRow(p, kind, i) {
  return `
    <li class="place-item" data-pick="${i}">
      <svg class="ico ico-sm"><use href="#i-${kind === 'saved' ? 'bookmark' : 'list'}"/></svg>
      <span>${escapeHtml(p.name)}<span class="sub">${escapeHtml((p.label || '').slice(0, 60))}</span></span>
      ${kind === 'saved'
        ? `<button class="track-remove place-remove" data-drop="${i}" type="button" aria-label="Remove ${escapeHtml(p.name)}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>`
        : ''}
    </li>`;
}

function bindPlaceRows(root, kind, arr, onPick, onDrop) {
  root.querySelectorAll('[data-pick]').forEach((li) => {
    li.addEventListener('click', (e) => {
      if (e.target.closest('[data-drop]')) return;
      onPick(arr[Number(li.dataset.pick)]);
    });
  });
  if (onDrop) {
    root.querySelectorAll('[data-drop]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onDrop(arr[Number(btn.dataset.drop)]);
      });
    });
  }
}
