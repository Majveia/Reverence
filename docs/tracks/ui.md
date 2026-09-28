# UI track — minimal HUD, touch controls, menus, transitions

Owner paths: `src/ui/**`, `src/styles.css`, this file.

Design brief: BotW / Journey / Outer Wilds sparseness with Apple-level polish. Tiny, quiet, OLED-friendly
typography (bundled **Inter** variable font, `src/ui/fonts/`, OFL), white-on-scene with soft shadows,
glass only where a surface is needed (prompts, toasts, menu). Nothing permanent obscures the view: most
elements appear when relevant and fade away. Every animation that can appear in a capture is driven from
`ui.update(dt)` on the sim clock (deterministic in `shot=1`); CSS transitions are only used for hover/press.

## What was built

| file | role |
|---|---|
| `UI.js` | host + API contract; breadcrumb, cinematic title card, toasts, prompts, hint, telemetry, onboarding, external markers, idle auto-hide, photo mode, global actions (menu / map / photo), share state |
| `ui.css` | all HUD styles (imported from `UI.js`), responsive rules for phones (portrait + landscape, safe areas) |
| `glyphs.js` | input glyphs that adapt to `input.lastDevice`: keycaps, Xbox-style pad buttons (A/B/X/Y colour rings, shoulders), mouse, touch icons; parses compound prompts `"Dive · Shift   Drop · C"` into chips |
| `icons.js` | inline SVG line icons (actions, scales, discovery kinds) |
| `WorldHud.js` | planet HUD: compass/heading strip (canvas) with POI ticks, world POI markers with distance (fade in by distance + screen-centre relevance), sky-body markers when in space, proximity discovery + BotW-style location reveal |
| `Touch.js` | touch layer: floating move stick from `input.touchSticks` (ring + knob, sprint ring), look-touch feedback, context-sensitive action cluster per scheme (≥ 44 px hit areas, small visuals), pinch onboarding |
| `Menu.js` | pause menu (glass panel): resume, map, back-up-one-scale, photo mode, share link, controls reference (keyboard / gamepad / touch), quality tier, look sensitivity, invert Y, volume; persisted in `localStorage['rv.settings']` |
| `MapNav.js` | map / scale navigation: scale ladder (Universe › Galaxy › Star › World), galaxies (cosmic), notable systems (galaxy), orrery of the current system with planets + moons (system) — click to travel |
| `Warp.js` | cinematic transitions: warp-streak star field + "ENTERING · <destination>" label above the director's fade veil on every `mode:leaving → mode:enter`; boot wordmark loader. rAF runs only while visible |

### Behaviour
* **Breadcrumb** (top-left): scale icon + last two crumbs (`Star — World`), subtitle (art preset · type · civ)
  that fades after ~9 s; crumbs are clickable to climb the hierarchy. Derived from the director, not from
  `setLocation` args (those are used for the subtitle/fallback).
* **Title card**: letter-spaced thin title that de-blurs and tightens, hairline rule draws out, subtitle fades in.
* **Location reveal**: entering a POI's radius (`world.pois`) shows `— NAME —  kind` (BotW) and emits
  `discovery {kind, name, source:'ui', poi}` (so audio can sting); repeated wonder names reveal once.
* **Toasts** (top-right): `discovery` events → capsule with kind icon + eyebrow ("NEW SPECIES"), shimmer sweep.
  De-duplicated for 6 s.
* **Prompts** (bottom centre): pill with a device glyph + label; compound prompts become several chips.
* **Compass** (top centre, surface only): N/E/S/W + intercardinals + 15° ticks, POI diamonds coloured by
  kind (clamped to the edge when off-strip). Hidden in orbit view / space.
* **Markers**: up to 5 POIs (city 14 km, village 7 km, wonder 0.9 km …), names on the two most relevant.
  In space (altitude > 8 % R) other planets/moons get a dot + name + distance.
* **Telemetry**: only when a track calls `setTelemetry` (vehicles, cosmic redshift/age). First entry big
  (thin 30 px), unit split off automatically (`"83 km/h"`), bars for 0..1 keys (`boost`, `throttle`, `fuel`…).
* **Onboarding**: keycap legend (`WASD move · Space jump · Shift sprint · F ride · M map · Esc menu`) for
  the character scheme; fades once the player has moved ~3 s; retired after 4 sessions (`rv.onboard`).
  Hints fade early once the user is actively playing.
* **Idle**: after 24 s without input the HUD fades out (cinematic idle); any input brings it back.
* **Photo mode** (`H`, or menu): hides all UI; a tap shows a small ✕ for 3 s.
* **Menu** (`Esc`, pad Start, ≡ button): pauses the sim (`engine.time.scale = 0`). Esc/pad-Start are
  re-bound from `back` to a new `menu` action at runtime (Backspace keeps `director.back()`); losing pointer
  lock in a character/vehicle scheme opens the menu (browsers swallow Esc while locked). Arrow keys / d-pad
  navigate, Enter / E / pad A activate. Quality change reloads the page at the *same place* (share URL + `q=`).
* **Map** (`M`, `Tab`, pad View, ◇ button): also pauses; travel uses `director.go(...)` with a fade (white
  galaxy→system) so the warp plays.
* **Touch**: shown on phones/tablets until a real keyboard/mouse event is seen, whenever
  `input.lastDevice === 'touch'`, or with `&touch=1`. Layouts: character (jump↔glide icon by player state,
  slide when grounded, ride/“hold · call” vehicle, interact when an `interact` prompt exists, view), vehicle
  (boost, hop, exit, view), flight (boost, up, down, exit, view). Jump also presses `glide`, boost also
  presses `sprint`. In touch mode telemetry moves above the right cluster (landscape) / under the compass
  (portrait).

## API (contract + additions)
```
ui.setLocation({scale,title,subtitle})  ui.showTitle(t, sub, ms)  ui.prompt(id, text, action)  ui.clearPrompt(id)
ui.toast(text, {kind, ms, eyebrow, icon})  ui.hint(text, ms)  ui.setTelemetry(obj|null)  ui.setControls(scheme)
ui.setMarkers([{id, x, y, visible, label, kind, distance, sub, unit}])   // label "A · B" → name A, sub B; no '◦' prefix
ui.openMenu/closeMenu/toggleMenu()  ui.openMap/closeMap/toggleMap()  ui.setPhoto(bool)  ui.reveal(name, kind)
ui.locationInfo() → {title, subtitle, crumbs, up, coords}   ui.shareState() → params for buildQuery()
ui.visible  (false in photo mode)
```
Input: adds action `menu` (`Escape`, `Pad9`); removes those codes from `back`.

## Capture URLs (add `--ui`; `--mobile` for phone portrait)
| view | url | steps |
|---|---|---|
| cosmic title + telemetry | `/?mode=cosmic` | `[{"advance":2}]` |
| galaxy + breadcrumb/title | `/?mode=galaxy&galaxy=0` | `[{"advance":2}]` |
| galaxy map (notable systems) | `/?mode=galaxy&galaxy=0` | `[{"advance":1},{"press":"KeyM"},{"advance":0.6}]` |
| surface HUD (compass, markers, toast, onboarding) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.35` | `[{"advance":6}]` |
| system map / orrery | same | `[{"advance":6},{"press":"KeyM"},{"advance":0.6}]` or `&uipanel=map` |
| pause menu | same | `[{"advance":6},{"press":"Escape"},{"advance":0.6}]` or `&uipanel=menu` / `controls` |
| touch landscape (bike) | `/?mode=system&galaxy=0&star=6&planet=1&view=bike&tod=0.35&touch=1` (`--w 844 --h 390`) | `[{"advance":5},{"hold":"KeyW","sec":2.5},{"advance":2}]` |
| touch portrait | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.35` `--mobile` | `[{"advance":5},{"hold":"Space","sec":0.4},{"advance":0.8}]` |
| warp transition (deterministic) | `/?mode=galaxy&galaxy=0&uipanel=warp` | `[{"advance":1.5}]` |

## Perf
DOM only, ~40 nodes at steady state; opacity/transform writes are cached and skipped when unchanged;
POI ranking at 6 Hz, marker projection per frame for ≤ 5 POIs + ≤ 10 bodies with pre-allocated vectors;
compass canvas redraws only when the heading changes (≥ 0.1°) or the POI set changes; warp canvas + rAF
only during transitions. No per-frame allocations in hot paths except the small `bodyLocal` clone inside
`Celestial` (space only).

## Known issues
* Quality tier cannot be switched live (engine detects it once) → the menu reloads with `q=` at the same place.
* Hints from other tracks are free text (keyboard wording even on touch, e.g. vehicle hints check
  `lastDevice`, which is `keyboard` when the touch layer is forced with `&touch=1`).
* Warp star field uses `Math.random` (cosmetic only).

## Requests
* **core** — consider making `Escape`/`Pad9` → `menu` the default binding in `Input.js` (the UI re-binds at
  runtime today) and a `quality.setTier()` that can switch tiers live.
* **audio** — expose `audio.setVolume(0..1)` (UI falls back to `setParam('volume')` + `master.gain`);
  `discovery` events with `source: 'ui'` are POI location reveals (good moment for a sting).
* **civ / flora** — POI names repeat a lot for wonders ('Elder Oak' ×25); unique names or a `minor: true`
  flag would help markers and reveals. Flagging the capital (`data.capital`) is used for nothing yet —
  a `kind: 'city'` for capitals would give them the gold city marker.
* **vehicles** — `_hintFor` could consult `engine.ui.device` (touch layer active) instead of `input.lastDevice`.
