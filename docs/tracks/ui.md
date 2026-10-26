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
| `Warp.js` (+ `warpRender.js`, `warp.worker.js`) | cinematic transitions above the director's fade veil on every `mode:leaving → mode:shown` (the director holds the veil until the new scale has streamed in). Live play on GPU hardware draws in a **worker on an OffscreenCanvas**, so the tunnel keeps its frame rate while the main thread builds a planet; the caption then animates with CSS (compositor). Captures (`&uipanel=warp`), software GL (one emulated GPU would serve both: the worker warp starved the load) and browsers without OffscreenCanvas draw on the main thread with the same renderer. The warp canvas is capped at ~2.2 MP and its fade-out follows real time (≤ 250 ms per frame) so a slow device is rid of it quickly; hints are cleared on `mode:leaving`: tinted nebula tunnel in the destination's palette, a **procedural portrait of the destination** looming out of the dark (the target galaxy with its real type/arm count/pitch/colours/bar/ring + dust lanes; the target star with blackbody colour, diffraction spikes, orbit and the destination world as a lit crescent; the cosmic web as filaments + clusters), seeded star streaks, vignette, "ENTERING · <name> · <type / class · K>" caption. Sprites are pre-rendered once per transition; rAF only while visible; boot wordmark loader |

### Round 3 changes (critic r2 fixes)
* **Contrast protection (critical)** — two contrast shades behind the HUD bands (`.rv-shade.top` / `.bot`, soft
  `rgba(4,8,12,.55) → 0` gradients). Their opacity follows the light at the camera (`G.uNight`, on-planet factor from
  altitude): ~full in daylight on a planet, ~30 % at night, 0 in space and in the black cosmic/galaxy modes. Every HUD
  text node uses the two-layer shadow `0 0 1px rgba(0,0,0,.9), 0 1px 6px rgba(0,0,0,.65)`; breadcrumb crumbs .8 and
  subline .84 opacity (10.5 px). POI / body marker labels sit on a small dark glass plate (`.rv-mk-lab`, blur 6 px);
  diamonds/dots get dark hairlines. The compass canvas draws a soft dark elliptical plate, stroke-outlined letters and
  outlined POI diamonds.
* **Toasts (critical)** — one toast at a time, top-centre under the compass (or under the portrait telemetry);
  the rest queue (max 4) and follow with a 0.45 s gap; a waiting toast shortens the visible one to 2.6 s. Single-line
  pill (icon · EYEBROW · name); on short viewports (≤ 460 px tall) no icon, 12 px, ≤ 360 px wide. Enter/exit =
  translateY + opacity + scale, shimmer sweep. The old left/right collision solver is gone.
* **Touch (major)** — one button spec (56 px hit, 44 px disc — primary 72/60, small 56/38 — tinted glass
  `rgba(10,14,20,.4)` + blur 8, 1.5 px light rim, dark hairlines inside and out, 2 px icon strokes). Buttons sit on a
  thumb arc around the primary (polar slots 86 px at 180°/135°/90°, outer 152 px). Labels 10 px at .92 with a dark
  shadow, retired per button after its first use (persisted in `localStorage['rv.touchUsed']`, not in shot mode) and
  brought back when the meaning changes (glide, ride). Context buttons fire a soft ring pulse when they become
  available; the idle "hold · call" ghost is at .62.
* **Desktop surface HUD (major)** — the keys legend fades after ~8 s of actual play (or 40 s) and comes back only
  after 20 s standing idle early in the session; idle auto-hide moved to 36 s. Compass 384×40 (260×36 on phones),
  12 px cardinals that grow to 16 px at the centre. Prompts are BotW-style: on foot in third person the pill is
  anchored beside the character (projected from the hip, smoothed, clamped); first person / vehicles / galaxy fall back
  to bottom-centre. Top-right buttons stay hidden on desktop until the pointer moves (or Esc), always visible on touch.
* **Warp (major)** — streaks are tapered sprites (transparent tail → bright head, halo, baked red-leading /
  blue-trailing fringes) in a 5-step black-body ramp, additive, width 0.55–2.65 px and brightness by depth (z²
  distribution, per-star magnitude), head glows on near stars, streak length ramps on easeInOutCubic. A radial
  zoom-blur / chromatic split pass (half-res, quarter on mobile, red/neutral/blue copies scaled 1.025–1.13 about the
  centre) scales with warp speed; stronger vignette. The destination portrait grows from ~17 % to ~67 % of the screen
  height (ease-in over the warp) with a bloom halo in its own colour. Caption 22 px / 10.5 px with a glow.
* **Ship HUD (major)** — arrival title cards are compact lower-third captions (21 px, ~4.4 s total); only the opening
  cosmic card stays centred (40 px hero with a glow and a 0.5→0.36 em tracking reveal). Free-text hints become
  icon+label chips (`W/S throttle` → [W][S] throttle, `Mouse steer` → mouse glyph, `drag to orbit` → device glyph
  that adapts to keyboard / touch / gamepad), fading in one after another and dimming once the player is active. Speed
  readout 28 px weight 500 tabular with a thin arc gauge (soft-saturating per unit) whose tick turns violet under pulse
  drive; larger status pill; centre reticle in flight.
* **Menu (minor)** — Photo / Share / Controls as an icon row at the top (Share shows a ✓ Copied state), panel
  `max-height: calc(100dvh - 32px - safe)` with a sticky footer, one-line ellipsized subtitle, 34 px rows on short
  viewports.
* **Requests** — cosmic: `.rv-tv-k` nowrap + 24 px gap between telemetry items; cosmic/external marker labels have a
  strong dark text shadow and a 40 % radial backdrop.

### Round 2 changes (critic r1 fixes)
* **Toast ↔ telemetry collision (critical)** — `UI._layoutToasts()` is a real collision solver: 4×/s while toasts exist
  (or immediately when a toast/telemetry/resize changes) it measures the visible HUD blocks (telemetry, touch
  cluster + stick, compass, top buttons, breadcrumb, prompts, onboarding) and scans the right column, then the
  left column under the breadcrumb, for the first vertical gap tall enough for the stack. If neither fits all,
  the side with more room wins and the oldest toasts retire early. Toasts slide in from their side. Verified on
  844×390 touch landscape (stack moves under the breadcrumb, speed readout untouched) and 390×844 portrait.
* **Hint ↔ instruments** — when a vehicle's telemetry sits bottom-right and would overlap the centred hint,
  the hint becomes a left-aligned footnote wrapping only between ` · ` segments (`_layoutHint`).
* **Touch stick** — resting anchor is a fixed inset from the bottom-left safe corner (`stickAnchor()`, no
  width-relative term; lifted slightly in vehicle/flight schemes). Ring = tinted glass disc (blur) + 58 % white
  rim + dark outer hairline + inner guide ring + four direction chevrons; knob brighter with a dark rim. Reads
  over grass and sky. Action buttons got the same contrast treatment (50 % rim, dark hairline, icon drop shadow).
* **Glyphs** — boost is a thruster flame (not ≫); jump is an up-arrow off a ground line; airborne it morphs
  (shrink-grow) into a paraglider canopy with a `glide` label (`swim up` when swimming). Vehicle buttons
  labelled `boost` / `hop`.
* **Cosmic title card** — the card holds (invisible) while the director is fading and, on the cosmic web,
  until structure has formed (z < 26, max 5 s) so it never sits on the near-uniform primordial fog.
* **Warp** — see table: the transition is now a scene (destination portrait + nebula), not just streaks.
* **Breadcrumb legibility** — stronger shadow, brighter secondary crumbs, and a barely-there corner shade.
* **Requests implemented** — marker labels drop a leading '◦'; marker kinds become classes (`k-cosmic` = small
  centred label); civ capitals (`data.capital`) get a larger gold marker + "capital" + longer range + priority;
  creature discoveries use the `archetype` (10 icons, eyebrow "New species · Avian"); ship telemetry renders
  `drive`/`status` as a status pill and `target` as a "⌖ TARGET name · distance" row, and the target body gets a
  bracket reticle + forced label among the space body markers; `data-sfx="ui.open"/"ui.back"` on menu / map /
  photo buttons; depth of field via `pipeline.setLook({dof})` while the pause menu is open and in photo mode
  (high/ultra, planets only; the previous setting is restored).

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
ui.hint(text)  // "Key label · Key label" / "drag to orbit" segments render as device-adaptive glyph chips
ui.toast(...)  // queued: one visible at a time, top-centre
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
| warp → galaxy (deterministic) | `/?mode=galaxy&galaxy=1&uipanel=warp` (ring galaxy: `galaxy=0`) | `[{"advance":2.5}]` |
| warp → star system | `/?mode=system&galaxy=0&star=6&planet=1&uipanel=warp` | `[{"advance":1.5}]` |
| warp → cosmic web | `/?mode=cosmic&uipanel=warp` | `[{"advance":2}]` |
| touch landscape, toasts + telemetry (collision case) | `/?mode=system&galaxy=0&star=6&planet=1&view=bike&tod=0.35&touch=1` (`--w 844 --h 390`) | `[{"advance":5},{"hold":"KeyW","sec":2.5},{"advance":2}]` |
| touch glide glyph | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.35&touch=1` (`--w 844 --h 390`) | `[{"advance":5},{"hold":"Space","sec":0.25},{"advance":0.35}]` |
| ship pulse: arc gauge, PULSE pill, target row + lead marker, reticle, key chips | `/?mode=system&galaxy=0&star=2&planet=0&view=ship&tod=0.45&alt=120000&pitch=10&pulse=20000` | `[{"advance":3}]` (lower-third title still up at 2 s) |
| BotW prompt beside the player (swim: Dive · C) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=1.086&lon=-28.557&tod=0.4` | `[{"advance":4}]` |
| cosmic title over forming structure | `/?mode=cosmic` | `[{"advance":6}]` |

## Perf
DOM only, ~40 nodes at steady state; opacity/transform writes are cached and skipped when unchanged;
POI ranking at 6 Hz, marker projection per frame for ≤ 5 POIs + ≤ 10 bodies with pre-allocated vectors;
compass canvas redraws only when the heading changes (≥ 0.1°) or the POI set changes; warp canvas + rAF
only during transitions (in a worker in live play: `ui.warp.lastStats` = frames / worst gap of the last warp). No per-frame allocations in hot paths except the small `bodyLocal` clone inside
`Celestial` (space only).

## Known issues
* The arrival title card (lower third) can still sit over the hero object when the framing puts it low (W4 ship
  at 3 s: the planet); world markers dim to 25 % while it is shown.
* Contrast shades key off `G.uNight` + altitude, not measured screen luminance (no CPU readback of the frame);
  bright snow at night would get the weaker shade.
* Warp chromatic split is done with tinted half-res copies of the streak layer (no per-pixel CA shader); the
  2D-canvas warp costs ~4 extra half-res blits per frame while visible (quarter-res on mobile).
* Touch button labels retire per button after first use (`localStorage['rv.touchUsed']`); clear it to see them again.
* Galaxy portraits in the warp use `Universe.galaxy().colors` which are pale (L = 0.7), so arms read whitish.
* The toast solver measures DOM rects (≤ 12 `getBoundingClientRect` calls, 4 Hz, only while toasts exist).
* Quality tier cannot be switched live (engine detects it once) → the menu reloads with `q=` at the same place.
* Hints from other tracks are free text; `W/S throttle`-style and `drag/scroll/tap …` segments become glyph chips,
  anything else is shown as a plain label.
* Warp star field uses `Math.random` (cosmetic only).

## Requests
* **cosmic** — the first ~3 s of the cosmic web (z > 26) are a near-uniform purple fog; the UI now holds the title
  card until structure forms, but a sharper/earlier first frame would make the opening shot land harder.
* **galaxy/universe** — galaxy `colors.arms` are very pale; slightly more saturated arm colours would help every
  galaxy depiction (warp portrait, map cards).
* **core** — a `quality.setTier()` that can switch tiers live (the menu reloads at the same place today).
* **audio** — `discovery` events with `source: 'ui'` are POI location reveals (good moment for a sting);
  UI buttons now carry `data-sfx="ui.open"` / `"ui.back"`.
* **civ / flora** — POI names repeat a lot for wonders ('Elder Oak' ×25); unique names or a `minor: true`
  flag would help markers and reveals. (`data.capital` is now used: larger gold marker + "capital".)
* **vehicles** — `_hintFor` could consult `engine.ui.device` (touch layer active) instead of `input.lastDevice`.
