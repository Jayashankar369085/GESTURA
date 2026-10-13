// CallSimulator — a fully simulated phone module. No telephony, no backend.
// State machine: idle → ringing → active → idle, with exactly one record per
// call (missed / rejected / accepted / outgoing). All timers are owned here
// so ringing can never outlive a call, and overlapping calls are impossible.

import { emit, on } from '../core/events.js';
import { DEMO_CONTACTS } from '../data/demo.js';
import { qs, initials, escapeHtml, formatTime } from '../core/dom.js';
import { get as storeGet, set as storeSet, STORAGE_KEYS } from '../core/storage.js';
import * as sounds from '../core/sounds.js';

const RING_TIMEOUT_MS = 20000; // unanswered → missed
const AUTO_INTERVAL_MS = 25000;
const MAX_HISTORY = 50;

export class CallSimulator {
  constructor() {
    this.state = 'idle'; // idle | ringing | active
    this.contact = null;
    this.ringSince = 0;
    this.activeSince = 0;
    this.outgoing = false;
    this.muted = false;
    this.ringTimer = null;
    this.tickTimer = null;
    this.autoState = 'stopped'; // stopped | running | paused
    this.autoTimer = null;
    this.history = loadHistory();
    this.seq = 0;
  }

  init() {
    this.el = {
      pageContacts: qs('#phone-contacts'),
      pageHistory: qs('#call-history'),
      pageHistoryEmpty: qs('#call-history-empty'),
      detail: qs('#contact-detail'),
      layout: qs('.phone-layout'),
      detailName: qs('#detail-name'),
      detailNumber: qs('#detail-number'),
      detailAvatar: qs('#detail-avatar'),
      detailNote: qs('#detail-note'),

      incoming: qs('#incoming-overlay'),
      incomingName: qs('#incoming-name'),
      incomingNumber: qs('#incoming-number'),
      incomingAvatar: qs('#incoming-avatar'),
      incomingElapsed: qs('#incoming-elapsed'),

      active: qs('#activecall-overlay'),
      activeName: qs('#active-name'),
      activeNumber: qs('#active-number'),
      activeAvatar: qs('#active-avatar'),
      callDuration: qs('#call-duration'),
      muteBtn: qs('#btn-mute-call'),

      autoStatus: qs('#auto-status'),
      autoStart: qs('#btn-auto-start'),
      autoPause: qs('#btn-auto-pause'),
      autoStop: qs('#btn-auto-stop'),
    };

    qs('#btn-simulate-call').addEventListener('click', () => this.simulateIncoming());
    qs('#btn-accept').addEventListener('click', () => this.accept());
    qs('#btn-reject').addEventListener('click', () => this.reject());
    qs('#btn-end-call').addEventListener('click', () => this.endCall());
    this.el.muteBtn.addEventListener('click', () => this.toggleMute());
    qs('#btn-clear-history').addEventListener('click', () => this.clearHistory());
    qs('#btn-contact-back').addEventListener('click', () => this.closeDetail());
    qs('#btn-detail-call').addEventListener('click', () => this.startOutgoing(this.selected));

    this.el.autoStart.addEventListener('click', () => this.setAuto('running'));
    this.el.autoPause.addEventListener('click', () => this.setAuto('paused'));
    this.el.autoStop.addEventListener('click', () => this.setAuto('stopped'));

    on('gesture:event', ({ action }) => {
      if (this.state !== 'ringing') return;
      if (action === 'call_accept') this.accept();
      if (action === 'call_reject') this.reject();
    });

    this.renderContacts();
    this.renderHistory();
    this.renderAuto();
    this.push();
    emit('phone:history', { history: this.history });

    // Home widget shortcut → open this contact's detail on the phone page.
    on('phone:open-contact', ({ id }) => {
      emit('page:request', { page: 'phone' });
      this.openDetail(id);
    });
  }

  // ---------------------------------------------------------------- contacts
  renderContacts() {
    this.el.pageContacts.innerHTML = DEMO_CONTACTS.map((c) => `
      <div class="contact-row" data-contact="${c.id}" role="button" tabindex="0">
        <span class="avatar" style="--av:${c.color}">${initials(c.name)}</span>
        <span class="contact-meta">
          <span class="contact-name">${escapeHtml(c.name)}</span>
          <span class="contact-num">${escapeHtml(c.number)} · simulated</span>
        </span>
        <button class="iconbtn" data-call="${c.id}" type="button" aria-label="Simulate incoming call from ${escapeHtml(c.name)}">
          <svg class="ico"><use href="#i-call"/></svg>
        </button>
      </div>`).join('');

    this.el.pageContacts.querySelectorAll('[data-contact]').forEach((row) => {
      const open = (e) => {
        if (e.target.closest('[data-call]')) return;
        this.openDetail(row.dataset.contact);
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
      });
    });
    this.el.pageContacts.querySelectorAll('[data-call]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = byId(btn.dataset.call);
        if (c) this.simulateIncoming(c);
      });
    });
  }

  openDetail(id) {
    const c = byId(id);
    if (!c) return;
    this.selected = c;
    this.el.detailName.textContent = c.name;
    this.el.detailNumber.textContent = `${c.number} (fictional)`;
    this.el.detailNote.textContent = c.note;
    this.el.detailAvatar.textContent = initials(c.name);
    this.el.detailAvatar.style.setProperty('--av', c.color);
    this.el.detail.hidden = false;
    this.el.layout.classList.add('detail-open');
    sounds.click();
  }

  closeDetail() {
    this.el.detail.hidden = true;
    this.el.layout.classList.remove('detail-open');
  }

  // ------------------------------------------------------------ incoming call
  simulateIncoming(contact = null) {
    if (this.state !== 'idle') {
      emit('toast', { message: 'A simulated call is already in progress', level: 'warn' });
      return;
    }
    const c = contact || pickContact();
    this.contact = c;
    this.outgoing = false;
    this.state = 'ringing';
    this.ringSince = Date.now();

    this.el.incomingName.textContent = c.name;
    this.el.incomingNumber.textContent = `${c.number} · SIMULATED`;
    this.el.incomingAvatar.textContent = initials(c.name);
    this.el.incomingAvatar.style.setProperty('--av', c.color);
    this.el.incomingElapsed.textContent = '0s';
    this.el.incoming.hidden = false;
    this.el.incoming.classList.add('ringing');

    sounds.startRing();
    this.tickTimer = setInterval(() => this.tickRing(), 1000);
    this.ringTimer = setTimeout(() => this.missed(), RING_TIMEOUT_MS);

    this.push();
    emit('phone:state', { state: 'ringing', contact: c });
    emit('notif:call', { kind: 'ringing', contact: c });
  }

  tickRing() {
    const secs = Math.floor((Date.now() - this.ringSince) / 1000);
    this.el.incomingElapsed.textContent = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }

  clearTimers() {
    clearTimeout(this.ringTimer);
    clearInterval(this.tickTimer);
    this.ringTimer = null;
    this.tickTimer = null;
    sounds.stopRing();
    this.el.incoming.hidden = true;
    this.el.incoming.classList.remove('ringing');
  }

  accept() {
    if (this.state !== 'ringing') return;
    this.clearTimers();
    this.state = 'active';
    this.activeSince = Date.now();
    this.muted = false;
    this.renderMute();

    this.el.activeName.textContent = this.contact.name;
    this.el.activeNumber.textContent = `${this.contact.number} · SIMULATED`;
    this.el.activeAvatar.textContent = initials(this.contact.name);
    this.el.activeAvatar.style.setProperty('--av', this.contact.color);
    this.el.callDuration.textContent = '0:00';
    this.el.active.hidden = false;

    this.tickTimer = setInterval(() => this.tickActive(), 1000);
    this.push();
    emit('phone:state', { state: 'active', contact: this.contact });
    emit('toast', { message: `Simulated call accepted with ${this.contact.name}`, level: 'ok' });
    sounds.ok();
  }

  reject() {
    if (this.state !== 'ringing') return;
    const c = this.contact;
    this.clearTimers();
    this.record('rejected', c, 0);
    this.reset();
    emit('toast', { message: `Simulated call from ${c.name} rejected`, level: 'info' });
    sounds.back();
  }

  missed() {
    if (this.state !== 'ringing') return;
    const c = this.contact;
    this.clearTimers();
    this.record('missed', c, 0);
    this.reset();
    emit('toast', { message: `Missed simulated call from ${c.name}`, level: 'warn' });
    sounds.error();
  }

  // ------------------------------------------------------------- active call
  startOutgoing(contact) {
    if (!contact) return;
    if (this.state !== 'idle') {
      emit('toast', { message: 'A simulated call is already in progress', level: 'warn' });
      return;
    }
    this.contact = contact;
    this.outgoing = true;
    this.state = 'active';
    this.activeSince = Date.now();
    this.muted = false;
    this.renderMute();
    this.el.activeName.textContent = contact.name;
    this.el.activeNumber.textContent = `${contact.number} · SIMULATED OUTGOING`;
    this.el.activeAvatar.textContent = initials(contact.name);
    this.el.activeAvatar.style.setProperty('--av', contact.color);
    this.el.callDuration.textContent = '0:00';
    this.el.active.hidden = false;
    this.tickTimer = setInterval(() => this.tickActive(), 1000);
    this.push();
    emit('phone:state', { state: 'active', contact });
    emit('toast', { message: `Simulated outgoing call to ${contact.name}`, level: 'info' });
  }

  tickActive() {
    const secs = Math.floor((Date.now() - this.activeSince) / 1000);
    this.el.callDuration.textContent = formatTime(secs);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.renderMute();
  }

  renderMute() {
    const btn = this.el.muteBtn;
    btn.setAttribute('aria-pressed', String(this.muted));
    btn.querySelector('use').setAttribute('href', this.muted ? '#i-micoff' : '#i-mic');
    btn.querySelector('span').textContent = this.muted ? 'Unmute' : 'Mute';
    btn.classList.toggle('on', this.muted);
  }

  endCall() {
    if (this.state !== 'active') return;
    const secs = Math.floor((Date.now() - this.activeSince) / 1000);
    const c = this.contact;
    this.clearTimers();
    this.el.active.hidden = true;
    this.record(this.outgoing ? 'outgoing' : 'accepted', c, secs);
    this.reset();
    emit('toast', { message: `Simulated call ended · ${formatTime(secs)}`, level: 'info' });
    sounds.endBeep();
  }

  // ----------------------------------------------------------------- history
  reset() {
    this.state = 'idle';
    this.contact = null;
    this.outgoing = false;
    this.muted = false;
    this.push();
    emit('phone:state', { state: 'idle', contact: null });
  }

  record(kind, contact, durationSec) {
    this.history.unshift({
      id: `c-${Date.now().toString(36)}-${this.seq++}`,
      kind,
      name: contact?.name || 'Unknown',
      number: contact?.number || '—',
      color: contact?.color || '#38e0d0',
      ts: Date.now(),
      duration: durationSec,
      simulated: true,
    });
    this.history = this.history.slice(0, MAX_HISTORY);
    storeSet(STORAGE_KEYS.callHistory, this.history);
    this.renderHistory();
    emit('phone:history', { history: this.history });
  }

  clearHistory() {
    this.history = [];
    storeSet(STORAGE_KEYS.callHistory, []);
    this.renderHistory();
    emit('phone:history', { history: [] });
    emit('toast', { message: 'Call history cleared', level: 'info' });
  }

  renderHistory() {
    this.el.pageHistoryEmpty.hidden = this.history.length > 0;
    this.el.pageHistory.innerHTML = this.history.map((h) => {
      const icon = h.kind === 'missed' ? 'i-alert'
        : h.kind === 'rejected' ? 'i-x-circle'
          : h.kind === 'outgoing' ? 'i-call'
            : 'i-check';
      const label = h.kind.charAt(0).toUpperCase() + h.kind.slice(1);
      return `
        <li class="call-row">
          <span class="avatar" style="--av:${h.color};width:34px;height:34px;font-size:13px">${initials(h.name)}</span>
          <span>
            <span class="who">${escapeHtml(h.name)}</span><br />
            <span class="call-kind ${h.kind}"><svg class="ico ico-sm" style="width:13px;height:13px"><use href="#${icon}"/></svg> ${label}${h.duration ? ` · ${formatTime(h.duration)}` : ''} · simulated</span>
          </span>
          <span class="when">${relative(h.ts)}</span>
        </li>`;
    }).join('');
  }

  // ------------------------------------------------------------ auto demo
  setAuto(mode) {
    this.autoState = mode;
    clearInterval(this.autoTimer);
    this.autoTimer = null;
    if (mode === 'running') {
      this.autoTimer = setInterval(() => {
        if (this.state === 'idle') this.simulateIncoming();
      }, AUTO_INTERVAL_MS);
    }
    this.renderAuto();
  }

  renderAuto() {
    const { autoState } = this;
    this.el.autoStatus.textContent = autoState === 'running'
      ? `Running — a simulated call every ${AUTO_INTERVAL_MS / 1000}s`
      : autoState === 'paused' ? 'Paused' : 'Stopped';
    this.el.autoStart.disabled = autoState === 'running';
    this.el.autoPause.disabled = autoState !== 'running';
    this.el.autoStop.disabled = autoState === 'stopped';
  }

  push() {
    emit('phone:state', { state: this.state, contact: this.contact, muted: this.muted });
  }
}

// ------------------------------------------------------------------ helpers
function byId(id) { return DEMO_CONTACTS.find((c) => c.id === id) || null; }

function pickContact() {
  return DEMO_CONTACTS[Math.floor(Math.random() * DEMO_CONTACTS.length)];
}

function loadHistory() {
  const raw = storeGet(STORAGE_KEYS.callHistory, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((h) => h && typeof h === 'object' && Number.isFinite(h.ts)).slice(0, MAX_HISTORY);
}

function relative(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
