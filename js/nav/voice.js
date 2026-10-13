// VoiceControl — Navigation-only voice commands via the browser Web Speech API.
//
//  * No backend, no API key: uses webkitSpeechRecognition / SpeechRecognition
//    (Chrome/Edge). Where unsupported, the UI says so and the mic button and
//    manual search keep working.
//  * Activated by the V-sign gesture (only while the Navigation page is open)
//    or the microphone button next to the search field.
//  * Recognized commands drive the existing NavigationController:
//      "navigate to <place>"  → search + auto-select first result
//      "find/search <thing>"  → search (results listed for the user to pick)
//      "petrol pumps near me" → search biased to the simulated vehicle area
//      "show route"           → OSRM route preview
//      "zoom in" / "zoom out" → map zoom
//      "clear destination"    → clear destination
//      "stop listening"       → end the session
//
// States shown in #voice-status: listening (with live transcript), heard
// command, result, error. Recognition stops automatically when the user
// leaves the Navigation page.

import { on, emit } from '../core/events.js';
import { qs } from '../core/dom.js';
import * as sounds from '../core/sounds.js';

// City context appended to "near me" queries so Nominatim can resolve them
// around the simulated vehicle position.
const AREA = 'Bengaluru';

export class VoiceControl {
  constructor(nav) {
    this.nav = nav;
    this.rec = null;
    this.listening = false;
    this.wantListening = false; // survives auto-restarts, cleared by stop()
    this.finalTranscript = '';
    this.supported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    this.el = { status: qs('#voice-status'), btn: qs('#btn-voice') };

    this.el.btn?.addEventListener('click', () => this.toggle());
    on('page:changed', ({ page }) => { if (page !== 'nav') this.stop('left nav'); });
    this.renderState('idle');
  }

  toggle() {
    if (this.listening) this.stop('user');
    else this.start('user');
  }

  start(reason = 'user') {
    if (!this.supported) {
      this.renderState('unsupported');
      emit('toast', { message: 'Voice control needs the Web Speech API — use Chrome or Edge, or search manually.', level: 'warn' });
      return;
    }
    if (this.listening) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this.listening = true;
      this.renderState('listening', 'Listening…');
      if (reason === 'user') sounds.ok();
    };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) this.finalTranscript += t;
        else interim += t;
      }
      const heard = (this.finalTranscript + interim).trim();
      if (heard) this.renderState('listening', `“${heard}”`);
      if (this.finalTranscript.trim()) {
        const text = this.finalTranscript.trim();
        this.finalTranscript = '';
        this.handle(text);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.stop('denied');
        this.renderState('error', 'Microphone blocked — allow access to use voice control.');
        emit('toast', { message: 'Microphone permission denied for voice control', level: 'err' });
      } else if (e.error === 'network') {
        this.stop('network');
        this.renderState('error', 'Speech service unreachable — check your connection. Manual search still works.');
      }
      // 'no-speech' / 'aborted' are routine; onend handles the restart.
    };
    rec.onend = () => {
      this.listening = false;
      // Chrome ends recognition after silences — restart while the user still
      // wants voice control, unless we are on a non-nav page (nav.js stops us).
      if (this.wantListening && this.nav.uiPage === 'nav') {
        try { rec.start(); this.listening = true; } catch { /* already starting */ }
      } else {
        this.renderState('idle');
      }
    };

    this.rec = rec;
    this.wantListening = true;
    this.finalTranscript = '';
    try {
      rec.start();
    } catch (err) {
      this.renderState('error', `Could not start speech recognition: ${err.message}`);
    }
  }

  stop(reason = 'user') {
    this.wantListening = false;
    if (this.rec) {
      try { this.rec.stop(); } catch { /* noop */ }
      this.rec = null;
    }
    this.listening = false;
    if (reason !== 'left nav') this.renderState('idle');
    else this.renderState('idle');
  }

  /** Parse a transcript and drive the navigation controller. */
  async handle(raw) {
    const text = raw.toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
    this.renderState('heard', `Heard: “${raw.trim()}”`);
    sounds.click();

    if (/\b(stop listening|stop voice|that'?s all|never mind)\b/.test(text)) {
      this.stop('command');
      this.renderState('idle', 'Stopped listening.');
      return;
    }
    if (/\b(zoom in|bigger|closer)\b/.test(text)) {
      this.nav.zoom(1);
      this.nav.feedback('Zoomed in (voice)', 'ok');
      return;
    }
    if (/\b(zoom out|smaller|further)\b/.test(text)) {
      this.nav.zoom(-1);
      this.nav.feedback('Zoomed out (voice)', 'ok');
      return;
    }
    if (/\b(show route|route to|start route|directions|how do i get there)\b/.test(text)) {
      if (!this.nav.dest) {
        this.nav.feedback('No destination yet — say “navigate to…” first.', 'err');
        return;
      }
      this.nav.route();
      return;
    }
    if (/\b(clear destination|cancel destination|clear the map|forget it)\b/.test(text)) {
      this.nav.clearDestination();
      return;
    }

    // navigate to X → search + pick the top result automatically
    const navMatch = /\b(?:navigate to|go to|directions to|take me to|drive to)\b\s+(.+)/.exec(text);
    if (navMatch) {
      const q = this.cleanQuery(navMatch[1]);
      const results = await this.nav.search(q);
      if (results && results.length) {
        this.nav.selectDestination(results[0]);
        this.nav.feedback(`Navigating to ${results[0].name || results[0].label} (voice)`, 'ok');
      }
      return;
    }

    // find/search X (optionally "near me" / "nearby") → list results
    const findMatch = /\b(?:find|search for|search|look for|where is|show me)\b\s+(.+)/.exec(text);
    if (findMatch) {
      await this.nav.search(this.cleanQuery(findMatch[1]));
      return;
    }

    // bare "petrol pump near me", "restaurants nearby" …
    const nearMatch = /^(.+?)\s+(?:near me|nearby|around here|around me)$/.exec(text);
    if (nearMatch) {
      await this.nav.search(this.cleanQuery(nearMatch[1]));
      return;
    }

    // Anything else that looks like a place → try it as a search.
    if (text.split(' ').length <= 6) {
      await this.nav.search(this.cleanQuery(text));
      return;
    }
    this.nav.feedback(`Didn't catch a command from “${raw.trim()}”. Try “navigate to…” or “find…”.`, 'err');
  }

  /** Strip filler words and bias "near me" searches to the simulated area. */
  cleanQuery(q) {
    let s = q.toLowerCase()
      .replace(/\b(please|could you|can you|i want to|i'd like to)\b/g, '')
      .replace(/\bnear me\b|\bnearby\b|\baround here\b|\baround me\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s.includes(AREA.toLowerCase())) s = `${s} ${AREA}`;
    return s;
  }

  renderState(state, text) {
    const el = this.el.status;
    if (el) {
      el.hidden = state === 'idle' && !text;
      el.className = `voice-status ${state}`;
      const icon = state === 'listening' ? 'i-mic' : state === 'error' || state === 'unsupported' ? 'i-alert' : 'i-micoff';
      el.innerHTML = `<svg class="ico ico-sm"><use href="#${icon}"/></svg><span></span>`;
      el.querySelector('span').textContent = text
        || (state === 'unsupported' ? 'Voice control is not supported in this browser — use the search field.'
          : state === 'listening' ? 'Listening…'
            : '');
    }
    if (this.el.btn) {
      this.el.btn.setAttribute('aria-pressed', String(this.listening));
      this.el.btn.classList.toggle('iconbtn-accent', this.listening);
    }
  }
}
