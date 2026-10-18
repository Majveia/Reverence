# Audio track — procedural music, ambience & SFX

Everything is synthesized live with WebAudio native nodes (no audio files). The same graph renders
in real time in the game and offline (OfflineAudioContext) for tests, previews and critics.

## What was built

| file | role |
|---|---|
| `src/audio/Audio.js` | host: API (`unlock / setScene / setParam / play / update / setVolume`), scene → style resolution, world sensing (shore, settlements, weather, night, altitude, underwater, space), energy/flow model, doppler, `__rv.audioDebug()`, `Audio.renderOffline()` |
| `src/audio/mix.js` | buses (music · ambience · sfx · ui), generated-IR convolution reverb with A/B crossfade (cosmos / cathedral / hall / valley / outdoor / room / plate), tempo-synced ping-pong echo, tape insert on the music bus (wow + flutter delay modulation, lowpass, drive, vinyl crackle), underwater muffle, glue compressor + brick-wall limiter, ducking, metering |
| `src/audio/theory.js` | modes (ionian…locrian-ish, hijaz, lydian-dominant, Japanese in/yo, pentatonics, whole-tone), stacked-third chords + colours (7, 9, add9, sus2/4, 6, quartal, cluster, power), weighted Markov progression graphs (tonal, lydian, aeolian, dorian, mixolydian, drone, jazz ii-V-I, planing), voice leading (minimal motion, open bass spacing, no unisons), motif generator + developer (repeat / sequence / invert / rhythm / truncate / ornament) |
| `src/audio/styles.js` | 13 styles and 20 art-direction variants (see table) |
| `src/audio/music.js` | Composer: bar look-ahead scheduler on the audio clock, sections (intro / play / breath) with energy-driven arrangement, cadences, modulations, phrase-arc dynamics, humanized timing, swing; layer generators: pad (gliding voice-led PadBank), drone, arp (up / updown / broken / random / travis fingerpicking / oud drone-tremolo), melody (4-bar a-a'-b-cadence phrases, call-and-response counter lines, grace-note ornaments), bass (root / root-fifth / long / pulse / bounce / jazz walking with chromatic approach), comp (rootless charleston rhodes, strummed guitar), perc kits (brush, lofi, desert maqsum, taiko, timpani rolls, soft, drift, slowbeat, toy), granular shimmer, sparse bells; discovery stings in the current key |
| `src/audio/instruments.js` | PadBank (warm, strings, brass CS-80 filter swell, choir via formant bank, glass, organ, drone, pulse), MonoVoice (duduk, flute, whistle, harmonica, cs80, theremin, horn, cello, lead, bowed) with portamento, delayed vibrato, breath noise, scoops; plucked/struck voices (piano, harp, koto, oud, banjo, guitar, upright, synthBass, synthPluck, FM rhodes, modal marimba / kalimba / bell / celesta / vibes / glassBell); voice budget scaled by quality |
| `src/audio/samples.js` | one-shot buffers rendered once in JS DSP: drums, 7 footstep surfaces × variants, thud, cloth, whoosh, splash, bubbles, clunk, impact, cricket chirp, frog croak, rain drip, 7 s stereo thunder, church bell, vinyl crackle, UI tick, machine clank |
| `src/audio/ambience.js` | wind (roar + gusting whistles + speed rush), ocean (roar + scheduled breaking waves & backwash), rain (hiss + body + drops), thunder on lightning flashes (distance delay), crickets & frogs at night, cicadas on hot days, per-world procedural birdsong (alien warbles on exotic worlds, dawn chorus), distant creature calls, settlement murmur + per-civ flavour (bells, wind chimes, neon hum & spinner fly-bys, industrial clanks; ruins stay silent), underwater bubbles, space hum / radio shimmer / VLF whistlers / morse / pulsars |
| `src/audio/creatures.js` | **real-fauna voices** (round 2): scans `world.get('fauna').creatures` at 4 Hz around the camera and voices the nearest animal of each archetype *where it actually is* — per-species bird songs from flocks (+ wing flutter on close fly-bys), humpback-like whale song (per-pod theme of up/down sweeps, moans, cries, grunts, repeated with variation and answered by another pod member), breathy ray hoots, jelly glass chimes snapped to the music key, fish splashes, formant-synthesized grazer lows with herd call-and-response, giant infrasonic bellows + ground-shaking footfalls, hexapod chitter, hopper trilled bleats, critter squeaks. Spatialization: camera-basis pan, inverse-distance gain, air-absorption low-pass, rear shading, distance-scaled reverb, pan ramps along the animal's velocity. Species voices are deterministic per world seed + species id. A creature `discovery` (with `archetype`) makes that species answer the sting |
| `src/audio/sfx.js` | footsteps by surface, jump / land / glider / boost / splash, vehicle enter/exit, takeoff, pulse drive, impacts, whooshes, warp (on `mode:leaving`) + arrival bloom (on `mode:enter`), UI clicks (any `button`, `[role=button]`, `.rv-btn`, `[data-sfx]`), discovery stings (rate-limited), engines: hoverbike turbine whine with camera-relative doppler, rover rumble with gear shifts + gravel, starship reactor hum + thrust roar + boost hiss |
| `src/audio/overlay.js` | `?audiodebug=1` panel: style, key, tempo, form, chord trail, active layers, ambience beds, mix + a log-frequency spectrogram (live analyser when unlocked; otherwise a deterministic 15 s offline render of the current world) |
| `tools/audio_render.mjs` | offline renderer → WAV + spectrogram PNG + JSON per scenario |

### Styles per scale / art direction

| scene / `body.art.key` | style | signature |
|---|---|---|
| cosmic | cosmic | lydian, 6-voice gliding warm pads, glass halo, sub drone, granular shimmer & celesta; `cosmicGrowth` opens filters and grain density |
| galaxy | galaxy | formant choir (vowel morphing), low strings, celesta / harp arps |
| space (system mode above ~0.85 of the atmosphere height, in orbit) | space | beating drones with filter sweeps, glass pad, glass bells, sparse cello |
| ghibli · botw · bierstadt · rogerdean · nausicaa | pastoral | piano / harp / strings (+ flute, horn, koto, marimba, choir per variant); BotW is sparse piano with rests |
| outerwilds | hearth | banjo travis picking, strummed guitar, harmonica & whistle, harmonium |
| moebius | desert | duduk with scoops & grace notes over drones, oud tremolo, maqsum frame drums |
| villeneuve | dune | brass throat drones, low choir, duduk, taiko |
| bladerunner · starfield | vangelis | CS-80 brass swells, bells into long echo, cs80 lead (starfield: lydian strings + horn) |
| bebop | lofi | swing 0.64, walking upright, brushes & ride, rootless rhodes charleston comping, vibes, tape + crackle |
| stalenhag · nms | drift | Juno-ish warm pad, synth pulse bass, echoed synth arps, worn-tape wow & flutter |
| rickmorty | quirky | bouncy synth bass, kalimba bleeps, theremin, toy percussion, chromatic-mediant key jumps |
| tarkovsky · kubrick · beksinski · crystal | eerie | drones, glass / Ligeti choir clusters, single piano notes in huge reverb, bowed metal, cello |
| friedrich · turner | sublime | romantic strings, choir, horn, timpani rolls |

Night → darker mode list and ~8 % slower; storms → `danger` (darker, tenser); flow (speed, glide,
vehicles) → more layers join; discoveries → sting + energy pulse; altitude / space → more reverb.

### Round 2 changes

* **Scene cuts no longer bleed beds**: on a director mode change (and on `setScene`) derived params snap to
  the new world (no 1.5 s glide of `P.space` from the galaxy value) and every ambience bed converges with a
  ≤ 0.3 s time constant for ~1.6 s (`Ambience.cut()`); the surface ⇄ orbit sub-scene flip does the same.
  Space radio events (whistlers / morse / pulsar trains up to 13 s long) ride a gate inside the space bed so
  they stop with it. Verified live (galaxy → W1 surface: `space` bed gain 0.000 1.5 s after landing) and
  offline (`landing` preset: 55 Hz hum lines end at the cut, see `bedTrace` in the JSON).
* `audioDebug().ambience.beds` now reports the **actual** automated bed gain in the live context (a fading bed
  reads as fading), the overlay's voice count shows `active/max`, and a late offline preview no longer
  overwrites the live panel.
* **Real-fauna creature voices** (`creatures.js`, above); the old random distant creature call is only a
  fallback when no fauna subsystem is present. Overlay row `FAUNA` lists what is in earshot and call counts.
* **Directional beds**: the ocean bed pans toward the actual water (shore-ring samples → camera basis), the
  settlement murmur pans toward the nearest town and envelops you once inside it.
* Discovery events forward `source` (UI place-name banners) and `archetype` (creature answers the sting).

## API

```js
engine.audio.unlock();                          // first gesture (engine does it); &audio=1 auto-unlocks (not in shot mode)
engine.audio.setScene('surface', { body });     // 'cosmic'|'galaxy'|'space'|'surface'|'city'|'underwater'
engine.audio.setParam('speed', 12);             // speed, altitude, wind, glide, swim, engine, boost, danger, discovery, cosmicGrowth, volume
engine.audio.play('step', { surface: 'grass', speed: 3, side: 1 });
engine.audio.setVolume(0.8);
window.__rv.audioDebug();                        // full graph state (locked: pending style); .creatures = {live, near:{arch:{d,n,pan}}, calls}
window.__rv.audioSet({ night: 1, rain: 0.8 });   // override derived params live
window.__rv.audioUnlock();                       // start audio from a test (headless ok)
await window.__rv.audioRender({ seconds: 10, scene: 'surface', art: 'bebop' }); // offline render
```

One-shots: `step jump land glider boost splash vehicle.enter vehicle.exit takeoff pulse impact whoosh warp
arrive select ui.click ui.hover ui.back ui.open ui.close photo discover`. Events listened to: `mode:leaving`
(warp), `mode:enter` (arrival bloom), `discovery` (sting), `vehicle:enter`.

## Testing / capture

```bash
node tools/audio_render.mjs --list
node tools/audio_render.mjs --preset bebop --seconds 30 --out /tmp/audio         # → bebop.wav / .png / .json
node tools/audio_render.mjs --all --seconds 16 --out /tmp/audio                   # 24 scenarios
node tools/audio_render.mjs --all --music-only --only cosmic,bebop --out /tmp/a   # music bus only (loudness calibration)
node tools/audio_render.mjs --preset fauna --seconds 30 --out /tmp/audio                  # creature voices (whale/grazer/giant/birds/ray/hexapod → hopper/jelly/critter)
node tools/audio_render.mjs --preset fauna --buses '{"music":0}' --name fauna-dry --out /tmp/audio   # without music
node tools/audio_render.mjs --preset landing --out /tmp/audio                             # scene-cut regression (galaxy → surface), JSON has bedTrace
node tools/audio_render.mjs --scene surface --art ghibli --creatures '[{"archetype":"whale","dist":800,"az":30,"n":3}]' --events '[{"t":1,"call":"whale"}]' --name w --out /tmp/a
node tools/audio_render.mjs --scene surface --art moebius --over '{"night":1,"wind":0.8}' --walk 2 --surface sand --name x --out /tmp/a
```

Best capture URLs (`&audiodebug=1` shows the panel; add a wait so the offline preview finishes):

* W3 Moebius duduk: `/?mode=system&galaxy=0&star=9&planet=2&view=surface&tod=0.35&audiodebug=1` steps `[{"advance":1},{"wait":16000}]`
* W4 Blade Runner rain, night: `/?mode=system&galaxy=0&star=2&planet=0&view=surface&tod=0.9&weather=rain&audiodebug=1` steps `[{"advance":1},{"wait":16000}]`
* W1 live hoverbike ride (real-time analyser): `/?mode=system&galaxy=0&star=6&planet=1&view=bike&tod=0.4&audiodebug=1` steps
  `[{"advance":0.5},{"eval":"__rv.audioUnlock().state"},{"hold":"KeyW","sec":6},{"advance":1.5},{"wait":800},{"advance":1.5},{"wait":800},{"advance":1.5},{"wait":2000}]`
* Scene cut (galaxy → landed W1, space bed must be gone; FAUNA row live): `/?mode=galaxy&audiodebug=1` steps
  `[{"advance":1},{"eval":"__rv.audioUnlock().state"},{"advance":2},{"wait":1500},{"go":"system","params":{"galaxy":0,"star":6,"planet":1,"view":"surface","tod":0.4}},{"advance":1.5},{"wait":1500},{"eval":"JSON.stringify(__rv.audioDebug().ambience.beds)"}]`
* Cosmic web: `/?mode=cosmic&audiodebug=1` steps `[{"advance":2},{"wait":16000}]`
* W10 Outer Wilds campfire at night: `/?mode=system&galaxy=0&star=17&planet=0&view=surface&tod=0.9&audiodebug=1` steps `[{"advance":1},{"wait":16000}]`

## Performance

Native nodes only; per-note voices are 3–8 nodes and auto-disconnect; voice budget 40–100 by quality
(`engine.quality.tier`, mobile ×0.6); IR length scales with quality; per-frame automation is de-duplicated
(`setT`), world sensing is time-sliced at 4 Hz (18 height samples); the context suspends when the tab is hidden.
Headless renders: 14 s of any scene render in ~4–6 s.

## Known issues

* Loudness per style is hand-calibrated from offline renders (music RMS ≈ −19 dBFS); styles with very
  sparse sections (BotW, eerie) are intentionally quieter at low energy.
* Piano / strings are synthesized (additive + subtractive) — convincing in a mix, not sample-realistic.
* Doppler for the hoverbike is camera-relative (chase-cam lag), not per-object 3D panning; other vehicles
  and creatures are not spatialized individually.
* `danger` is only derived from storms; nothing else sets it yet.
* Creature calls are panned at call start (+ a velocity-predicted pan ramp), not continuously re-spatialized
  while a long whale phrase plays; only the nearest individual per archetype (plus up to 4 responders) is voiced.
* Live captures are slow on the shared software renderer (3–7 min with fauna); the offline `fauna` preset is the
  quickest way to inspect creature voices.

## Requests

* **player / vehicles** — optional: emit `engine.audio.setParam('danger', x)` when the player is hurt, falling
  from a deadly height or chased; and `setParam('discovery', 1)` briefly when a vista/POI is first seen.
* **fauna** — (done on our side: `creatures` are voiced in place.) Optional: emit
  `events.emit('creature:alarm', {archetype, pos})` when a herd/flock is startled (player sprinting close,
  vehicle passing) so we can play alarm calls + stampede/wing bursts exactly at that moment.
* **ui** — buttons already get click sounds automatically; add `data-sfx="ui.open"`/`"ui.back"` on menu open/back
  buttons for distinct sounds; the menu's volume slider can call `audio.setVolume(v)` (supported).
* **atmosphere** — `weather.flash` is used for thunder; a `weather.boltDist` (m) would let thunder delay match the flash.
