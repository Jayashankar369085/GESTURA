// UIController — application chrome: pages + dock + status bar, drawers,
// modals, toasts, settings bindings, keyboard shortcuts, tutorial/practice,
// diagnostics, demo mode and data reset. Feature modules stay decoupled and
// communicate through the event bus.

import { emit, on } from '../core/events.js';
import { qs, qsa, updateRangeFill, bindRangeFills } from '../core/dom.js';
import { GESTURE_CONFIG, defaultEnabledMap } from '../gesture/config.js';
import {
  loadSettings, all as allSettings, setSetting, resetSettings,
  loadWidgets, saveWidgets, loadGestureEnabled, saveGestureEnabled,
} from '../core/settings.js';
import { clearAll } from '../core/storage.js';
import { notify, list as notifList, markAllRead, clearNotifications, unreadCount } from '../core/notifications.js';
import { VEHICLE_STATUS } from '../data/demo.js';
import * as sounds from '../core/sounds.js';

const PAGES = ['home', 'media', 'nav', 'phone', 'settings'];

export class UIController {
  constructor() {
    this.page = 'home';
    this.stack = ['home'];
    this.drawerOpen = null;
    this.demoTimer = null;
    this.practiceSeen = new Set();
    this.engineLocked = false;
    this.gestureRunning = false;
  }

  init() {
    // ---------------------------------------------------------------- pages
    this.pageEls = Object.fromEntries(PAGES.map((p) => [p, qs(`#page-${p}`)]));
    qsa('.dock-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.navigate(btn.dataset.nav));
    });
    qsa('[data-back]').forEach((btn) => {
      btn.addEventListener('click', () => this.back());
    });
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-nav-to]');
      if (t) this.navigate(t.dataset.navTo);
    });

    window.addEventListener('hashchange', () => {
      const p = pageFromHash();
      if (p !== this.page) this.navigate(p, { fromHash: true });
    });

    // ------------------------------------------------------------- settings
    loadSettings();
    this.bindSettingsControls();
    this.bindWidgetToggles();
    this.applySettings(allSettings());
    on('settings:changed', ({ key, value, all }) => {
      this.syncControl(key, value);
      this.applySettings(all, key);
    });

    // ------------------------------------------------------------ statusbar
    this.tickClock();
    setInterval(() => this.tickClock(), 1000);
    qs('#sb-gear').textContent = VEHICLE_STATUS.gear;
    qs('#sb-speed').textContent = VEHICLE_STATUS.speed;
    qs('#sb-range').textContent = VEHICLE_STATUS.range;
    qs('#sb-batt-text').textContent = VEHICLE_STATUS.battery;
    this.updateNet();
    window.addEventListener('online', () => this.updateNet());
    window.addEventListener('offline', () => this.updateNet());

    qs('#sb-gesture').addEventListener('click', () => {
      if (this.gestureRunning) this.toggleDrawer('diag-panel');
      else this.openModal('gesture-dialog');
    });

    // -------------------------------------------------------------- drawers
    qs('#btn-diagnostics').addEventListener('click', () => this.toggleDrawer('diag-panel'));
    qs('#btn-notifications').addEventListener('click', () => {
      this.toggleDrawer('notif-panel');
      if (this.drawerOpen === 'notif-panel') { markAllRead(); this.renderNotifs(); }
    });
    qs('#btn-clear-notifs').addEventListener('click', () => { clearNotifications(); this.renderNotifs(); });
    qsa('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.closeDrawer(btn.dataset.close));
    });
    // Click-away closes drawers.
    document.addEventListener('pointerdown', (e) => {
      if (!this.drawerOpen) return;
      const drawer = qs(`#${this.drawerOpen}`);
      if (drawer && !e.target.closest(`#${this.drawerOpen}`) && !e.target.closest('#btn-diagnostics, #btn-notifications, #sb-gesture')) {
        this.closeDrawer(this.drawerOpen);
      }
    });

    on('notif:changed', () => { this.renderNotifs(); this.renderHomeNotifs(); });
    on('notif:call', () => this.renderNotifs());
    this.renderNotifs();

    // ---------------------------------------------------------- toasts/hints
    on('toast', ({ message, level }) => this.toast(message, level));
    on('engine:hint', ({ message, level }) => this.toast(message, level));
    on('page:request', ({ page }) => this.navigate(page));

    // Persist volume changed by media/gesture; mirror tick feedback.
    on('media:volume', ({ value }) => {
      if (allSettings().volume !== value) setSetting('volume', value);
      else this.renderSettingValues({ volume: value });
    });
    on('media:volume:changed', ({ delta }) => sounds.volumeTick(delta > 0));
    on('media:modes', ({ shuffle, repeat }) => {
      if (allSettings().shuffle !== shuffle) setSetting('shuffle', shuffle);
      if (allSettings().repeat !== repeat) setSetting('repeat', repeat);
    });

    // ------------------------------------------------------- gesture dialogs
    qs('#btn-gesture-cancel').addEventListener('click', () => this.closeModal('gesture-dialog'));
    qs('#btn-gesture-start').addEventListener('click', () => {
      this.closeModal('gesture-dialog');
      emit('gesture:request-start', {});
    });
    qs('#home-start-gesture').addEventListener('click', () => this.openModal('gesture-dialog'));
    qs('#btn-open-gesture').addEventListener('click', () => this.openModal('gesture-dialog'));
    qs('#home-tutorial-btn').addEventListener('click', () => this.openTutorial());
    qs('#btn-open-tutorial').addEventListener('click', () => this.openTutorial());

    on('engine:status', (s) => this.onEngineStatus(s));
    on('gesture:lock', ({ locked }) => { this.engineLocked = locked; this.syncGestureControls(); });
    on('gesture:pause', () => this.syncGestureControls());

    // ----------------------------------------------------------- diagnostics
    on('diag:update', (d) => this.renderDiag(d));
    qs('#btn-start-gesture').addEventListener('click', () => emit('gesture:request-start', {}));
    qs('#btn-stop-gesture').addEventListener('click', () => emit('gesture:request-stop', {}));
    qs('#btn-retry-model').addEventListener('click', () => emit('gesture:request-retry', {}));
    qs('#btn-cam-hide').addEventListener('click', () => {
      setSetting('cameraPreview', false);
      emit('toast', { message: 'Camera feed hidden — tracking keeps running (re-enable in Vehicle Settings)', level: 'info' });
    });
    on('diag:visibility', () => { /* engine re-syncs via main.js */ });

    // ----------------------------------------------------------- quick panel
    const qVol = qs('#quick-volume');
    const qBright = qs('#quick-brightness');
    qVol.addEventListener('input', () => setSetting('volume', Number(qVol.value)));
    qBright.addEventListener('input', () => setSetting('brightness', Number(qBright.value)));
    qs('#quick-gesture-toggle').addEventListener('change', (e) => {
      emit(e.target.checked ? 'gesture:request-start' : 'gesture:request-stop', {});
    });
    qs('#quick-lock-toggle').addEventListener('change', (e) => emit('gesture:request-lock', { locked: e.target.checked }));
    qs('#quick-ac-toggle').addEventListener('change', (e) => setSetting('ac', e.target.checked));
    qs('#quick-sounds-toggle').addEventListener('change', (e) => setSetting('sounds', e.target.checked));
    qs('#quick-theme-btn').addEventListener('click', () => {
      const next = allSettings().theme === 'day' ? 'dark' : 'day';
      setSetting('theme', next);
      emit('toast', { message: `Theme: ${next === 'day' ? 'Day' : 'Night'}`, level: 'info' });
    });

    // ---------------------------------------------------------- tutorial UI
    this.renderGestureCards();

    // ------------------------------------------------------------ misc buttons
    qs('#btn-demo-start').addEventListener('click', () => this.startDemo());
    qs('#btn-demo-stop').addEventListener('click', () => this.stopDemo());
    qs('#btn-reset-all').addEventListener('click', () => this.resetAll());

    // ---------------------------------------------------------------- keys
    window.addEventListener('keydown', (e) => this.onKey(e));

    // initial page from hash
    const initial = pageFromHash();
    this.navigate(initial, { fromHash: true, replace: true });
    this.syncGestureControls();
  }

  // ------------------------------------------------------------- navigation
  navigate(page, { fromHash = false, replace = false } = {}) {
    if (!PAGES.includes(page)) page = 'home';
    const prev = this.page;
    this.page = page;

    PAGES.forEach((p) => {
      const el = this.pageEls[p];
      const active = p === page;
      el.classList.toggle('active', active);
      el.hidden = !active;
    });

    qsa('.dock-btn').forEach((btn) => {
      const active = btn.dataset.nav === page;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });

    if (!fromHash) {
      const hash = `#/${page}`;
      if (location.hash !== hash) {
        if (replace) location.replace(hash);
        else location.hash = hash;
      }
      if (page !== this.stack[this.stack.length - 1]) {
        if (this.stack[this.stack.length - 1] === 'home' || page === 'home') {
          if (page === 'home') this.stack = ['home'];
          else this.stack.push(page);
        } else {
          this.stack.push(page);
        }
        if (this.stack.length > 12) this.stack.shift();
      }
    }

    if (prev !== page) {
      emit('page:changed', { page, prev });
      if (page === 'home') this.renderHomeNotifs();
    }
    sounds.click();
  }

  /** In-app back: previous page in the stack, else home. */
  back() {
    if (this.stack.length > 1) {
      this.stack.pop();
      const target = this.stack[this.stack.length - 1];
      this.navigate(target);
      return;
    }
    if (this.page !== 'home') this.navigate('home');
    else emit('toast', { message: 'Already on the home dashboard', level: 'info' });
  }

  // --------------------------------------------------------------- drawers
  toggleDrawer(id) {
    if (this.drawerOpen === id) return this.closeDrawer(id);
    qsa('.drawer').forEach((d) => { d.hidden = d.id !== id; });
    this.drawerOpen = id;
    qs(`#${id}`)?.querySelector('button, input')?.focus?.();
    if (id === 'diag-panel') emit('diag:visibility', { open: true });
  }

  closeDrawer(id) {
    const el = qs(`#${id}`);
    if (el) el.hidden = true;
    if (this.drawerOpen === id) this.drawerOpen = null;
    if (id === 'diag-panel') emit('diag:visibility', { open: false });
  }

  openModal(id) { qs(`#${id}`).hidden = false; }
  closeModal(id) { qs(`#${id}`).hidden = true; }

  // ---------------------------------------------------------------- toasts
  toast(message, level = 'info') {
    if (!message) return;
    const host = qs('#toast-host');
    const el = document.createElement('div');
    el.className = `toast ${level === 'err' ? 'err' : level === 'warn' ? 'warn' : ''}`;
    const icon = level === 'err' ? 'i-alert' : level === 'warn' ? 'i-alert' : level === 'ok' ? 'i-check' : 'i-info';
    el.innerHTML = `<svg class="ico ico-sm"><use href="#${icon}"/></svg><span></span>`;
    el.querySelector('span').textContent = message;
    host.appendChild(el);
    if (level === 'err') sounds.error();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 350);
    }, level === 'err' ? 6000 : 3800);
    while (host.children.length > 4) host.firstChild.remove();
  }

  // ------------------------------------------------------------- clock/net
  tickClock() {
    const now = new Date();
    const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const date = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    qs('#sb-time').textContent = time;
    qs('#sb-date').textContent = date;
    const homeTime = qs('#home-time');
    if (homeTime) {
      homeTime.textContent = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
      qs('#home-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const hr = now.getHours();
      qs('#home-greeting').textContent = hr < 5 ? 'Late night drive' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    }
  }

  updateNet() {
    const online = navigator.onLine;
    qs('#sb-net').querySelector('.dot').className = `dot ${online ? 'dot-on' : 'dot-off'}`;
    qs('#sb-net-text').textContent = online ? 'Online' : 'Offline';
    if (!online) notify('You are offline', 'Navigation search and maps need the internet. Media, calls and settings keep working.', 'warn');
  }

  // -------------------------------------------------------------- settings
  bindSettingsControls() {
    const map = [
      ['#set-ac', 'ac', 'change', (el) => el.checked],
      ['#set-temp', 'temp', 'input', (el) => Number(el.value)],
      ['#set-fan', 'fan', 'input', (el) => Number(el.value)],
      ['#set-airflow', 'airflow', 'change', (el) => el.value],
      ['#set-recirc', 'recirc', 'change', (el) => el.checked],
      ['#set-seat-heat', 'seatHeat', 'input', (el) => Number(el.value)],
      ['#set-seat-vent', 'seatVent', 'input', (el) => Number(el.value)],
      ['#set-brightness', 'brightness', 'input', (el) => Number(el.value)],
      ['#set-theme', 'theme', 'change', (el) => el.value],
      ['#set-ambient', 'ambient', 'input', (el) => el.value],
      ['#set-sounds', 'sounds', 'change', (el) => el.checked],
      ['#set-reduced-motion', 'reducedMotion', 'change', (el) => el.checked],
      ['#set-cam-preview', 'cameraPreview', 'change', (el) => el.checked],
      ['#set-sensitivity', 'sensitivity', 'input', (el) => Number(el.value)],
      ['#set-pointer-speed', 'pointerSpeed', 'input', (el) => Number(el.value)],
      ['#set-smoothing', 'smoothing', 'input', (el) => Number(el.value)],
      ['#set-dwell', 'dwell', 'input', (el) => Number(el.value)],
    ];
    this.settingControls = [];
    for (const [sel, key, evt, read] of map) {
      const el = qs(sel);
      if (!el) continue;
      this.settingControls.push({ el, key, read });
      el.addEventListener(evt, () => {
        if (evt === 'input') updateRangeFill(el);
        setSetting(key, read(el));
        if (evt === 'input') this.renderSettingValues({ [key]: read(el) });
      });
    }
    bindRangeFills(qsa('#page-settings .range, .drawer .range'));
    this.renderSettingValues(allSettings());
  }

  syncControl(key, value) {
    const ctl = this.settingControls?.find((c) => c.key === key);
    if (ctl && document.activeElement !== ctl.el) {
      if (ctl.el.type === 'checkbox') ctl.el.checked = value;
      else ctl.el.value = value;
      updateRangeFill(ctl.el);
    }
    this.renderSettingValues({ [key]: value });
    // Keep mirrors in sync (home widget + quick drawer).
    if (key === 'volume') {
      const q = qs('#quick-volume');
      if (q && document.activeElement !== q) { q.value = value; updateRangeFill(q); }
      qs('#quick-volume-val').textContent = value;
    }
    if (key === 'brightness') {
      const q = qs('#quick-brightness');
      if (q && document.activeElement !== q) { q.value = value; updateRangeFill(q); }
      qs('#quick-brightness-val').textContent = value;
    }
    if (key === 'ac') qs('#quick-ac-toggle').checked = value;
    if (key === 'sounds') qs('#quick-sounds-toggle').checked = value;
    if (key === 'theme') qsa('[data-theme]').forEach((b) => b.classList.toggle('active', b.dataset.theme === value));
  }

  renderSettingValues(patch) {
    const set = (sel, text) => { const el = qs(sel); if (el) el.textContent = text; };
    const s = { ...allSettings(), ...patch };
    set('#set-temp-val', `${s.temp}°C`);
    set('#set-fan-val', String(s.fan));
    set('#set-brightness-val', String(s.brightness));
    set('#set-sensitivity-val', String(s.sensitivity));
    set('#set-pointer-speed-val', `${s.pointerSpeed}%`);
    set('#set-smoothing-val', String(s.smoothing));
    set('#set-dwell-val', `${s.dwell}ms`);
    set('#home-brightness-val', String(s.brightness));
    set('#home-volume-val', String(s.volume));
    const hb = qs('#home-brightness');
    if (hb && document.activeElement !== hb) { hb.value = s.brightness; updateRangeFill(hb); }
    const hv = qs('#home-volume');
    if (hv && document.activeElement !== hv) { hv.value = s.volume; updateRangeFill(hv); }
    if (patch.theme && document.activeElement !== qs('#set-theme')) qs('#set-theme').value = s.theme;
    if (patch.ambient && document.activeElement !== qs('#set-ambient')) qs('#set-ambient').value = s.ambient;
  }

  applySettings(all, key) {
    const root = document.documentElement;

    // theme (auto follows the system)
    let theme = all.theme;
    if (theme === 'auto') {
      theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'dark';
    }
    root.dataset.theme = theme;
    qsa('[data-theme]').forEach((b) => b.classList.toggle('active', b.dataset.theme === all.theme));

    // brightness
    qs('#app').style.filter = all.brightness === 100 ? '' : `brightness(${all.brightness / 100})`;

    // Ambient lighting — page-wide. The selected colour drives the accent
    // family (buttons, icons, sliders, borders, dock, overlays) through
    // derived custom properties, so the whole UI takes the ambient tint.
    // Applied after the theme so day mode can darken the derived accent.
    this.applyAmbient(all.ambient);

    // motion
    root.dataset.reducedMotion = all.reducedMotion ? 'true' : 'false';

    // sounds
    sounds.setSoundsEnabled(all.sounds);

    // let the engine re-tune itself
    if (key === undefined || ['sensitivity', 'dwell', 'smoothing', 'pointerSpeed', 'cameraPreview'].includes(key)) {
      emit('settings:gesture-tuning', { all });
    }
    if (key === undefined || key === 'volume') emit('media:volume', { value: all.volume, settings: true });
  }

  /** Derive the full accent family from one ambient colour (page-wide). */
  applyAmbient(hex) {
    const root = document.documentElement;
    root.style.setProperty('--ambient', hex);
    // Day theme needs a darker accent for readable text on light surfaces.
    const day = root.dataset.theme === 'day';
    const accent = day ? `color-mix(in srgb, ${hex} 68%, black)` : hex;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-2', `color-mix(in srgb, ${accent} 74%, black)`);
    root.style.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 15%, transparent)`);
    root.style.setProperty('--accent-glow', `color-mix(in srgb, ${accent} 38%, transparent)`);
    qsa('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.ambient === hex));
  }

  bindWidgetToggles() {
    const widgets = loadWidgets();
    qsa('.widget-toggle').forEach((cb) => {
      cb.checked = widgets[cb.dataset.widget] !== false;
      cb.addEventListener('change', () => {
        const next = { ...loadWidgets(), [cb.dataset.widget]: cb.checked };
        saveWidgets(next);
      });
    });
    on('widgets:changed', ({ widgets: w }) => this.applyWidgets(w));
    this.applyWidgets(widgets);
  }

  applyWidgets(map) {
    qsa('[data-widget]').forEach((el) => {
      const key = el.dataset.widget;
      if (key in map) el.hidden = map[key] === false;
    });
    // Re-fit maps after layout changes.
    emit('layout:changed', {});
  }

  // ------------------------------------------------------------ gesture UI
  onEngineStatus(s) {
    this.gestureRunning = s.status === 'running';
    const chip = qs('#sb-gesture');
    const text = qs('#sb-gesture-text');
    chip.classList.remove('chip-off', 'chip-on', 'chip-live', 'chip-locked');
    let label = 'Gestures off';
    if (s.status === 'starting') { label = 'Starting…'; chip.classList.add('chip-on'); }
    else if (s.status === 'running') {
      label = s.locked ? 'Locked' : s.paused ? 'Paused' : 'Tracking live';
      chip.classList.add(s.locked ? 'chip-locked' : 'chip-live');
    } else if (s.status === 'error') { label = 'Camera error'; chip.classList.add('chip-off'); }
    else chip.classList.add('chip-off');
    text.textContent = label;

    qs('#diag-cam').textContent = s.camera === 'on' ? 'Live' : s.camera === 'starting' ? 'Starting…' : s.camera === 'error' ? 'Error' : 'Off';
    qs('#diag-model').textContent = s.model || (s.status === 'running' ? 'ready' : 'Not loaded');
    qs('#diag-msg').textContent = s.error || '';
    qs('#btn-start-gesture').disabled = s.status === 'running' || s.status === 'starting';
    qs('#btn-stop-gesture').disabled = !(s.status === 'running' || s.status === 'starting');
    const hs = qs('#home-gesture-status');
    if (hs) {
      hs.textContent = label;
      hs.className = `status-v ${s.status === 'running' ? 'ok' : s.status === 'error' ? 'err' : ''}`;
    }
    const cs = qs('#home-camera-status');
    if (cs) {
      cs.textContent = s.camera === 'on' ? 'Live (local only)' : s.status === 'error' ? 'Error' : 'Off';
      cs.className = `status-v ${s.camera === 'on' ? 'ok' : s.status === 'error' ? 'err' : ''}`;
    }
    const startBtn = qs('#home-start-gesture');
    if (startBtn) startBtn.textContent = this.gestureRunning ? 'Stop gesture control' : 'Start gesture control';
    this.syncGestureControls();
  }

  syncGestureControls() {
    const running = !!this.gestureRunning;
    qs('#quick-gesture-toggle').checked = running;
    const lock = qs('#diag-lock');
    const engineLocked = this.engineLocked === true;
    if (lock) lock.textContent = engineLocked ? 'Locked' : 'Unlocked';
    qs('#quick-lock-toggle').checked = engineLocked;
  }

  renderDiag(d) {
    const set = (id, v) => { const el = qs(id); if (el) el.textContent = v; };
    set('#diag-hand', d.hand);
    set('#diag-gesture', d.gesture);
    set('#diag-conf', d.confidence ? d.confidence.toFixed(2) : '—');
    set('#diag-fps', String(d.fps));
    set('#diag-infer', `${d.inferMs ? d.inferMs.toFixed(1) : '—'} ms`);
    set('#diag-point', d.pointer);
    set('#diag-cv', d.luma);
    set('#diag-lock', d.locked ? 'Locked' : d.paused ? 'Paused' : 'Unlocked');
  }

  renderGestureCards() {
    const enabledMap = { ...defaultEnabledMap(), ...loadGestureEnabled() };
    const host = qs('#gesture-cards');
    host.innerHTML = GESTURE_CONFIG.map((g) => `
      <div class="gesture-card" data-gesture="${g.id}">
        <div class="gc-head"><svg class="ico"><use href="#${g.icon}"/></svg> ${g.label}</div>
        <div class="gc-desc">${g.desc}</div>
        ${g.dwell ? `<span class="gc-hold">hold ${(g.dwell * (g.dwellScale || 1)).toFixed(0)} ms to trigger${g.repeat ? ` · repeats every ${g.repeat} ms` : ''}</span>` : ''}
        ${g.experimental ? '<span class="gc-hold">experimental · off by default</span>' : ''}
        <label class="switch-row" style="border:none;padding-bottom:0"><span style="font-size:12.5px">Enabled</span>
          <input type="checkbox" class="switch gesture-enable" data-g="${g.id}" ${enabledMap[g.id] !== false ? 'checked' : ''} />
        </label>
      </div>`).join('');

    host.querySelectorAll('.gesture-enable').forEach((cb) => {
      cb.addEventListener('change', () => {
        const map = { ...loadGestureEnabled(), [cb.dataset.g]: cb.checked };
        saveGestureEnabled(map);
        emit('toast', { message: `${cb.dataset.g} ${cb.checked ? 'enabled' : 'disabled'}`, level: 'info' });
      });
    });

    // practice checklist
    const list = qs('#practice-checklist');
    list.innerHTML = GESTURE_CONFIG
      .filter((g) => !['point', 'pinch'].includes(g.id))
      .map((g) => `<li data-gc="${g.id}">${g.label}</li>`).join('');
  }

  openTutorial() {
    this.openModal('tutorial-modal');
    this.renderGestureCards();
  }

  markPractice(gesture) {
    this.practiceSeen.add(gesture);
    const li = qs(`#practice-checklist [data-gc="${gesture}"]`);
    if (li) li.classList.add('done');
  }

  // -------------------------------------------------------------- shortcuts
  onKey(e) {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Escape') {
      if (this.drawerOpen) return this.closeDrawer(this.drawerOpen);
      const open = qsa('.modal:not([hidden]), .call-overlay:not([hidden])')[0];
      if (open && !open.classList.contains('call-overlay')) return this.closeModal(open.id);
      this.back();
      return;
    }
    if (typing) return;

    switch (e.key.toLowerCase()) {
      case 'h': this.navigate('home'); break;
      case 'm': this.navigate('media'); break;
      case 'n': this.navigate('nav'); break;
      case 'p': this.navigate('phone'); break;
      case 's': this.navigate('settings'); break;
      case 'g': this.openModal('gesture-dialog'); break;
      case 'q': this.toggleDrawer('quick-panel'); break;
      case 'c': this.toggleDrawer('notif-panel'); break;
      case 'd': this.toggleDrawer('diag-panel'); break;
      case '?': case '/': this.openTutorial(); break;
      case ' ': e.preventDefault(); emit('media:shortcut', { command: 'toggle' }); break;
      case 'arrowright': emit('media:shortcut', { command: 'next' }); break;
      case 'arrowleft': emit('media:shortcut', { command: 'prev' }); break;
      case 'arrowup': e.preventDefault(); emit('media:shortcut', { command: 'vol+', delta: 5 }); break;
      case 'arrowdown': e.preventDefault(); emit('media:shortcut', { command: 'vol-', delta: 5 }); break;
      default: break;
    }
  }

  // ------------------------------------------------------------- demo mode
  startDemo() {
    if (this.demoTimer) return;
    const order = ['home', 'media', 'nav', 'phone', 'home'];
    let i = 0;
    this.demoTimer = setInterval(() => {
      i = (i + 1) % order.length;
      this.navigate(order[i]);
    }, 5000);
    qs('#btn-demo-start').disabled = true;
    qs('#btn-demo-stop').disabled = false;
    this.toast('Demo mode running — pages cycle every 5 seconds', 'info');
  }

  stopDemo() {
    clearInterval(this.demoTimer);
    this.demoTimer = null;
    qs('#btn-demo-start').disabled = false;
    qs('#btn-demo-stop').disabled = true;
    this.navigate('home');
    this.toast('Demo mode stopped', 'info');
  }

  // ----------------------------------------------------------------- reset
  resetAll() {
    if (!window.confirm('Reset all locally stored settings, call history, saved places and widget choices?')) return;
    clearAll();
    resetSettings();
    location.reload();
  }

  renderNotifs() {
    const items = notifList();
    const host = qs('#notif-list');
    qs('#notif-empty').hidden = items.length > 0;
    host.innerHTML = items.map((n) => `
      <li class="notif-item ${n.level}">
        <svg class="ico ico-sm"><use href="#${n.level === 'err' ? 'i-alert' : n.level === 'warn' ? 'i-alert' : n.level === 'ok' ? 'i-check' : 'i-info'}"/></svg>
        <div>
          <div class="notif-title">${escape(n.title)}</div>
          ${n.body ? `<div class="notif-body">${escape(n.body)}</div>` : ''}
          <div class="notif-time">${ago(n.ts)}</div>
        </div>
      </li>`).join('');
    const badge = qs('#notif-count');
    const unread = unreadCount();
    badge.hidden = unread === 0;
    badge.textContent = String(unread);
  }

  renderHomeNotifs() {
    const host = qs('#home-notif-list');
    if (!host) return;
    const items = notifList().slice(0, 4);
    host.innerHTML = items.length
      ? items.map((n) => `<li><span>${escape(n.title)}</span><span class="mini-time">${ago(n.ts)}</span></li>`).join('')
      : '<li><span>No notifications yet</span></li>';
  }
}

// ------------------------------------------------------------------- utils
function pageFromHash() {
  const m = /^#\/?([a-z]+)/i.exec(location.hash || '');
  return m && PAGES.includes(m[1]) ? m[1] : 'home';
}

function escape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ago(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h`;
  return `${Math.floor(d / 86400000)}d`;
}
