// GESTURA — application bootstrap and gesture-to-action dispatcher.
// Gesture-based User Recognition for Automobiles.
// ES module entry point (no build step, no backend, no API keys).

import { on, emit } from './core/events.js';
import { qs, qsa } from './core/dom.js';
import { loadNotifications, notify, list as notifications } from './core/notifications.js';
import { loadSettings, all as allSettings, loadGestureEnabled } from './core/settings.js';
import { defaultEnabledMap } from './gesture/config.js';
import { GestureEngine } from './gesture/engine.js';
import { UIController } from './ui/ui.js';
import { MediaController } from './media/media.js';
import { NavigationController } from './nav/nav.js';
import { CallSimulator } from './phone/phone.js';
import { initHome } from './home/home.js';

function boot() {
  loadNotifications();

  const ui = new UIController();
  const media = new MediaController();
  const nav = new NavigationController();
  const phone = new CallSimulator();
  const engine = new GestureEngine({
    canvas: qs('#gesture-canvas'),
    video: qs('#camera-video'),
    previewEl: qs('#camera-preview'),
    hintEl: qs('#no-hand-hint'),
    camHintEl: qs('#cam-hint'),
  });

  // Chrome first so every module finds its page visible/hidden correctly.
  ui.init();
  media.init();
  nav.init();
  phone.init();
  initHome();
  nav.onPage(ui.page); // ui.init already performed the first navigation

  // ------------------------------------------------------- engine settings
  const applyTuning = (s) => {
    engine.applySettings({
      sensitivity: s.sensitivity,
      dwell: s.dwell,
      smoothing: s.smoothing,
      pointerSpeed: s.pointerSpeed,
      cameraPreview: s.cameraPreview,
    });
    engine.setSensitivity(s.sensitivity);
  };
  const applyEnabled = (map) => {
    const merged = { ...defaultEnabledMap(), ...map };
    engine.setEnabledMap(merged);
    engine.setTwoFingerEnabled(merged.two_finger_pinch !== false);
  };
  applyTuning(allSettings());
  applyEnabled(loadGestureEnabled());

  on('settings:gesture-tuning', ({ all }) => applyTuning(all));
  on('gesture-enabled:changed', ({ map }) => applyEnabled(map));
  on('settings:changed', ({ key, all }) => {
    if (['sensitivity', 'dwell', 'smoothing', 'pointerSpeed', 'cameraPreview'].includes(key)) applyTuning(all);
  });

  // ------------------------------------------------------- engine lifecycle
  on('gesture:request-start', () => { engine.start(); });
  on('gesture:request-stop', () => {
    engine.setPractice(false);
    engine.setPaused(false);
    engine.stop();
  });
  on('gesture:request-retry', () => { engine.retry(); });
  on('gesture:request-lock', ({ locked }) => engine.setLocked(locked === undefined ? !engine.locked : locked));
  on('engine:stopped', () => resetPracticeUi());
  // Camera feed lives inside the diagnostics drawer — re-sync when it opens.
  on('diag:visibility', () => engine.syncPreview());

  // ------------------------------------------------- gesture → app actions
  on('gesture:event', ({ action }) => {
    switch (action) {
      case 'volume_up': media.adjustVolume(6); break;
      case 'volume_down': media.adjustVolume(-6); break;
      case 'prev_track': media.prev(); ui.toast('Previous track', 'info'); break;
      case 'next_track': media.next('user'); ui.toast('Next track', 'info'); break;
      case 'go_home': ui.navigate('home'); break;
      case 'voice_control':
        // V-sign voice control is Navigation-only; elsewhere it does nothing.
        if (ui.page === 'nav') nav.voice?.toggle();
        else ui.toast('Voice control is available on the Navigation screen', 'info');
        break;
      case 'open_notifications': ui.toggleDrawer('notif-panel'); break;
      case 'toggle_lock': engine.setLocked(!engine.locked); break;
      case 'toggle_pause': engine.setPaused(!engine.paused); break;
      case 'map_zoom':
        if (ui.page === 'nav') { nav.zoom(1); ui.toast('Map zoomed in (two-finger pinch)', 'info'); }
        break;
      case 'call_accept': phone.accept(); break;
      case 'call_reject': phone.reject(); break;
      default: break;
    }
  });

  // While a simulated call rings, thumb up/down accept/reject it.
  on('phone:state', ({ state }) => {
    engine.setRemap(state === 'ringing'
      ? { volume_up: 'call_accept', volume_down: 'call_reject' }
      : {});
  });

  // ----------------------------------------------------------- practice mode
  const practiceStatus = qs('#practice-status');
  const practiceBtn = qs('#btn-practice');
  const resetPracticeUi = () => {
    engine.setPractice(false);
    qsa('#practice-checklist li').forEach((li) => li.classList.remove('done'));
    if (practiceStatus) practiceStatus.textContent = 'Idle';
    if (practiceBtn) practiceBtn.textContent = 'Start practice';
  };
  practiceBtn?.addEventListener('click', async () => {
    if (engine.practice) { resetPracticeUi(); return; }
    if (engine.status !== 'running') {
      const res = await engine.start();
      if (!res.ok) return;
    }
    engine.setPractice(true);
    qsa('#practice-checklist li').forEach((li) => li.classList.remove('done'));
    practiceStatus.textContent = 'Listening…';
    practiceBtn.textContent = 'Stop practice';
    ui.toast('Practice mode: gestures are shown, never executed', 'info');
  });
  on('gesture:observed', ({ gesture }) => {
    if (!engine.practice || !gesture || gesture === 'none') return;
    ui.markPractice(gesture);
    practiceStatus.textContent = `Saw: ${gesture}`;
  });

  // --------------------------------------------------- global error guard
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[app] unhandled rejection:', e.reason);
    notify('Unexpected error', String(e.reason?.message || e.reason || 'Unknown error'), 'err');
  });
  window.addEventListener('error', (e) => {
    console.error('[app] error:', e.message);
  });

  // --------------------------------------------------------------- welcome
  // Only greet once — otherwise every reload piles up a duplicate entry.
  const greeted = notifications().some((n) => n.title === 'Welcome to GESTURA');
  if (!greeted) {
    notify(
      'Welcome to GESTURA',
      'Gesture-based User Recognition for Automobiles. Calls and vehicle controls are simulated, and camera frames never leave this device. Press G or tap the hand chip to start gesture control.',
      'info',
    );
  }

  // Debug handle (harmless, helps manual QA in the console).
  window.__gestura = { ui, media, nav, phone, engine, emit };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
