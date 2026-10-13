# GESTURA — Gesture-based User Recognition for Automobiles

**Your Drive. Your Gestures. Your Control.**

A complete, browser-based automotive infotainment **simulator** driven by real
computer-vision hand tracking. Matte-black premium UI, landscape-first, and
fully functional with **mouse and keyboard** when gesture control is off.

> **Simulation only.** Phone calls, vehicle settings and climate controls are
> visual simulations. Nothing here connects to real telephony or car hardware.
> Camera video is processed **entirely on this device** with MediaPipe — frames
> are never uploaded, stored or sent to any service.

---

## Quick start (local)

```bash
# any static file server works; a tiny zero-dependency one is included
npm start            # serves http://localhost:8080
# or: python3 -m http.server 8080
```

Open <http://localhost:8080>. No install, no build, no API keys.

> **Why a server instead of opening `index.html` directly?** The app uses ES
> modules and fetches a WASM runtime, both of which browsers block on the
> `file://` protocol. Any static server works.

### Requirements

- Node.js ≥ 18 (only for the included dev server and test scripts — the app
  itself is dependency-free vanilla JS)
- Modern **Chrome or Edge** (recommended; Firefox works for UI but MediaPipe
  hand tracking is best supported on Chromium)

---

## Camera permissions

The camera is **never** started automatically. Press **Start gesture control**
(or the hand chip in the status bar, or the `G` key) and approve the browser
prompt.

- Video is processed locally via MediaPipe Tasks Vision `HandLandmarker`.
- Denied permission, a missing camera, model-load failure or an inference
  error all show a friendly message with **Retry** — the app keeps working
  with mouse and keyboard.
- **No floating camera preview.** Hand tracking runs invisibly in the
  background; the camera status and live gesture feedback stay visible in the
  status bar. An optional camera feed renders only inside the diagnostics
  drawer (Gesture Lab) when enabled in Vehicle Settings.
- **Stop camera** (or toggling gesture control off) releases the camera light
  and all video tracks immediately.
- Camera access requires a **secure context**: `https://` in deployment, or
  `http://localhost` for local development.

---

## Ambient lighting

The ambient-light colour drives the **whole UI** — background glow, cards,
borders, dock, active icons, sliders, buttons, overlays and the gesture cursor
— through shared CSS custom properties (`--ambient` and a derived accent
family) with smooth transitions. Presets: **Ice Blue, Cyan, Violet, Emerald,
Amber, Crimson**, plus a custom colour picker in Vehicle Settings. The choice
persists across reloads; day theme automatically darkens the derived accent so
text stays readable.

---

## Dependencies & model assets (all pinned, loaded from CDN)

| Asset | Pinned version | Source |
| --- | --- | --- |
| MediaPipe Tasks Vision (ESM + WASM) | `1.1.0` | jsDelivr |
| Hand Landmarker model (`hand_landmarker.task`, float16/1) | `1` | Google storage |
| OpenCV.js (frame diagnostics) | `4.10.0-release.1` | jsDelivr (`@techstark/opencv-js`) |
| Leaflet + OpenStreetMap tiles | `1.9.4` | unpkg / tile.openstreetmap.org |
| Nominatim (destination search) | — | nominatim.openstreetmap.org |
| OSRM (route preview) | — | router.project-osrm.org (demo server) |

Every URL is checked by `npm run smoke` — the app fails loudly (never silently)
if an asset 404s. Navigation search/routing and map tiles need an internet
connection; **every other module works offline**.

---

## Supported gestures

| Gesture | Action |
| --- | --- |
| Index finger extended | Move pointer (pointing up does nothing else — it is just the cursor) |
| Thumb + index fingertip pinch | Click / select (exactly one click per deliberate pinch; release before the next) |
| Pinch held over a slider | Drag slider (dispatches `input` + `change`) |
| Thumb up | Volume + |
| Thumb down | Volume − |
| Open palm held | Pause / resume gesture interaction |
| Closed fist held | Toggle gesture lock |
| Index swipe left / right | Previous / next track (fast, horizontal sweeps only) |
| Three fingers held | Go Home |
| V sign held (**Navigation screen only**) | Start / stop voice control |
| Index point down / held | Open notifications |
| Two-finger pinch (optional) | Zoom map (only on the nav page) |

All mappings are **configurable** and every action is protected by temporal
stability checks, dwell timers, cooldowns, entry/exit hysteresis and a global
gesture lock — an action never repeats just because a gesture is still held.
Ambiguous frames do nothing.

Diagnostics (status-bar icon or `D`) show live camera/model/hand/gesture/
confidence/FPS.

---

## Keyboard & mouse

Everything works without gestures. Shortcuts (ignored while typing):

`H` home · `M` media · `N` navigation · `P` phone · `S` settings ·
`G` gesture dialog · `Q` quick controls · `C` notifications · `D` diagnostics ·
`?` tutorial · `Space` play/pause · `←`/`→` prev/next · `↑`/`↓` volume ·
`Esc` close panel/modal or go back.

The back arrow is always **top-left beside the page title**, and Home is
always in the bottom dock.

---

## Voice control (Navigation only)

Hold a **V sign** on the Navigation screen (or tap the microphone button next
to the search field) to start voice control. It uses the browser's **Web Speech
API** (Chrome/Edge) — no backend, no API key. Recognized commands drive the
same Nominatim search, Leaflet map and OSRM route preview as the manual
controls:

- “Navigate to Elephant Gate” — searches and sets the destination
- “Find petrol pumps near me” / “Search restaurants” — lists results
- “Show route” — OSRM route preview
- “Zoom in” / “Zoom out”
- “Clear destination” · “Stop listening”

Listening and error states are shown under the search field. Where the Web
Speech API is unavailable, the mic button explains why and manual search keeps
working. The V sign does **nothing on other screens**.

## Importing & playing music

Media page → **Import music** → pick audio files (MP3/OGG/WAV/ FLAC…).
Files stay in the browser session (object URLs — nothing is uploaded, nothing
is written to disk). Playback format support follows your browser's codecs
(MP3/OGG/WAV/AAC everywhere; FLAC/MP4 where the browser allows). For MP3 files,
ID3 tags (title/artist/artwork) are parsed locally.
Three bundled demo tracks are included so playback works out of the box.
Shuffle, repeat, seek, volume/mute, playlist reorder and remove all work.

## Simulating incoming calls

Phone page → **Simulate incoming call** (or the phone icon on any contact).
The overlay rings, counts down, and can be accepted (thumb-up gesture, `Enter`
or the Accept button) or rejected. Active calls show a running timer with
Mute/End; completed calls land in **Recent calls** with duration and are
persisted in `localStorage`. **Auto demo calls** schedules recurring simulated
calls for presentations.

---

## Storage

`localStorage` (namespaced `apexdrive.*`) holds settings, call history, saved
places, recent destinations, notifications and widget choices. Malformed or
missing data falls back to defaults, and **Reset all data & settings**
(Settings → Dashboard & Demo) wipes everything.
Imported audio is deliberately *not* persisted — it lives for the session.

---

## Deploy

The output is a plain static site: deploy the repository root as-is. No env
vars, no secrets, no server side.

### Vercel

```bash
npm i -g vercel
vercel            # preview, then:
vercel --prod
```
`vercel.json` is included (security headers + cache policy).

### AWS Amplify Hosting

Connect the repo in the Amplify console. `amplify.yml` is included and runs a
syntax check before publishing the static artifacts. No build step required.

Both platforms serve over **HTTPS automatically**, which the camera API
requires.

---

## Testing

```bash
npm run verify    # = npm run check && npm test && npm run smoke
```

| Suite | What it covers | Result |
| --- | --- | --- |
| `npm run check` | Syntax of every JS file, no duplicate declarations | 28/28 pass |
| `npm test` | Gesture classifier, state machine, storage, ID3 parser | 39/39 pass |
| `npm run smoke` | Static serving, ES-module graph, no legacy backend refs, all pinned CDN URLs return 200 | all pass |

**Manual camera checks** (require a webcam and human hands — cannot be
automated here): pinch-clicks once per pinch without double-firing; swipe
left/right changes tracks only once; palm/fist dwell behaviour; slider drag
via pinch; lock/pause gating; pointer smoothing at different sensitivities.

---

## Project layout

```
index.html            app shell (all pages, dialogs, overlays)
style.css             design system: tokens, chrome, pages, overlays
js/
  main.js             bootstrap + gesture→action dispatcher
  core/               events, storage, settings, notifications, sounds, dom
  data/demo.js        bundled tracks + demo contacts
  gesture/            camera, MediaPipe loader, classifier, state machine,
                      pointer, engine
  media/              player + ID3 parser
  nav/                Leaflet map, Nominatim search, OSRM routes, saved places
  phone/              call simulator + history
  home/               dashboard widgets
  ui/                 chrome, drawers, settings bindings, shortcuts, tutorial
tests/                node:test unit suites
scripts/              zero-dep dev server, syntax checker, smoke test
```

## Resetting

Settings → **Reset all data & settings** clears every `apexdrive.*` key and
restores first-run defaults.
