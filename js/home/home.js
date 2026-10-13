// Home dashboard wiring — synchronises every widget with its full module.

import { on, emit } from '../core/events.js';
import { qs, qsa, updateRangeFill, initials, escapeHtml, formatTime } from '../core/dom.js';
import { all as allSettings, setSetting } from '../core/settings.js';
import { DEMO_CONTACTS, VEHICLE_STATUS } from '../data/demo.js';

export function initHome() {
  // ------------------------------------------------------------- static bits
  const outer = qs('#home-temp-outer');
  if (outer) outer.innerHTML = `<svg class="ico ico-sm"><use href="#i-temp"/></svg> ${VEHICLE_STATUS.outsideTemp} outside`;

  // ------------------------------------------------------------- music widget
  const musicEmpty = qs('#home-music-empty');
  const musicBody = qs('#home-music-body');
  const titleEl = qs('#home-track-title');
  const artistEl = qs('#home-track-artist');
  const artEl = qs('#home-art');
  const playBtn = qs('#home-play');

  on('media:state', (s) => {
    musicEmpty.hidden = s.hasTracks;
    musicBody.hidden = !s.hasTracks;
    if (!s.hasTracks) return;
    titleEl.textContent = s.title || 'Nothing playing';
    artistEl.textContent = s.artist || '';
    artEl.style.backgroundImage = s.cover ? `url("${s.cover}")` : '';
    artEl.classList.toggle('has-cover', !!s.cover);
    playBtn.querySelector('use').setAttribute('href', s.playing ? '#i-pause' : '#i-play');
    playBtn.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
  });

  playBtn.addEventListener('click', () => emit('media:shortcut', { command: 'toggle' }));
  qs('#home-prev').addEventListener('click', () => emit('media:shortcut', { command: 'prev' }));
  qs('#home-next').addEventListener('click', () => emit('media:shortcut', { command: 'next' }));
  qs('#home-import-btn').addEventListener('click', () => {
    emit('page:request', { page: 'media' });
    // Open the picker once the media page is visible.
    setTimeout(() => qs('#file-input')?.click(), 60);
  });

  // ---------------------------------------------------- volume / brightness
  const vol = qs('#home-volume');
  vol.addEventListener('input', () => setSetting('volume', Number(vol.value)));
  const bright = qs('#home-brightness');
  bright.addEventListener('input', () => setSetting('brightness', Number(bright.value)));

  // ------------------------------------------------------ theme / ambient
  qsa('.seg-btn[data-theme]').forEach((btn) => {
    btn.addEventListener('click', () => setSetting('theme', btn.dataset.theme));
  });
  qsa('.swatch[data-ambient]').forEach((btn) => {
    btn.addEventListener('click', () => setSetting('ambient', btn.dataset.ambient));
  });
  qs('#home-open-settings').addEventListener('click', () => emit('page:request', { page: 'settings' }));

  // ---------------------------------------------------------------- contacts
  const avatars = qs('#home-contacts');
  avatars.innerHTML = DEMO_CONTACTS.slice(0, 5).map((c) => `
    <button class="avatar-btn" type="button" data-open-contact="${c.id}" title="${escapeHtml(c.name)}" aria-label="Open ${escapeHtml(c.name)}">
      <span class="avatar" style="--av:${c.color}">${initials(c.name)}</span>
    </button>`).join('');
  avatars.querySelectorAll('[data-open-contact]').forEach((btn) => {
    btn.addEventListener('click', () => emit('phone:open-contact', { id: btn.dataset.openContact }));
  });

  // ------------------------------------------------------------- recents feed
  const recents = qs('#home-recents');
  const renderRecents = (history) => {
    const items = (history || []).slice(0, 4);
    recents.innerHTML = items.length
      ? items.map((h) => {
        const missed = h.kind === 'missed';
        return `<li>
          <svg class="ico ico-sm mini-ico ${missed ? 'missed' : ''}"><use href="#${missed ? 'i-alert' : 'i-phone'}"/></svg>
          <span>${escapeHtml(h.name)}</span>
          <span class="mini-time">${h.kind}${h.duration ? ` · ${formatTime(h.duration)}` : ''}</span>
        </li>`;
      }).join('')
      : '<li><span>No recent calls yet</span></li>';
  };
  on('phone:history', ({ history }) => renderRecents(history));
  renderRecents([]);

  // ----------------------------------------------------------------- climate
  const renderClimate = () => {
    const s = allSettings();
    qs('#home-ac').textContent = s.ac ? 'On' : 'Off';
    qs('#home-ac').className = `climate-v ${s.ac ? '' : ''}`;
    qs('#home-ac-temp').textContent = s.ac ? `${s.temp}°C` : '—';
    qs('#home-fan').textContent = s.ac ? String(s.fan) : '—';
    const seat = s.seatHeat > 0 ? `Heat ${s.seatHeat}` : s.seatVent > 0 ? `Vent ${s.seatVent}` : 'Off';
    qs('#home-seat').textContent = seat;
    const fill = s.ac ? Math.max(12, (s.fan / 5) * 100) : 0;
    qs('#home-climate-bar-fill').style.width = `${fill}%`;
  };
  on('settings:changed', ({ key }) => {
    if (['ac', 'temp', 'fan', 'seatHeat', 'seatVent'].includes(key)) renderClimate();
  });
  renderClimate();

  // ------------------------------------------------------------------ layout
  on('layout:changed', () => emit('layout:refit', {}));
}
