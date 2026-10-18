# Post-processing & image quality (track: post)

Owner paths: `src/post/**`, `docs/tracks/post.md`.

## What it does

Every mode renders through `engine.pipeline.render(scene, camera, opts)`:

```
scene (Halton-jittered projection on TAA tiers) → HDR sceneRT (RGBA16F + Float32 depth texture, reversed-Z, MSAA if q.msaa)
→ GTAO (order 50, system mode, q.ssao)            src/post/ssao.js
→ effects[] by order (atmosphere 100, clouds 110, shafts 120, weather 125, underwater 130, speed blur 145, lens 150 …)
→ camera jitter restored
→ TAA resolve (depth + camera-motion reprojection, YCoCg variance clip, Catmull-Rom history)   src/post/taa.js
→ depth of field (photo mode on high/ultra, or setLook)   → camera motion blur (high/ultra, real-time only)   src/post/camera.js
→ auto-exposure: centre-weighted log-average (64→16→4→1) + asymmetric GPU adaptation      src/post/exposure.js
→ bloom: dual filter (13-tap Karis prefilter, tent upsample); 'mix' = energy-conserving scatter, 'add' = classic
→ sun occlusion probe (depth + disc/ring luminance contrast → clouds/haze dim the flare; temporally smoothed)   src/post/lens.js
→ composite: CA → clarity (ratio local contrast vs the bloom pyramid) → bloom → exposure (manual × adaptation) → white balance → lens flare (core/halo, 6-blade starburst,
  anamorphic streak, 7 hexagonal coated ghosts, screen-space ghosts of every bright light, lens dirt) → Purkinje night
  shift → AgX + film look (CDL power/sat in AgX space) → vignette → black point → sRGB → 3D grading LUT   src/post/composite.js
→ final: FXAA 3.11 quality (low/med, or while TAA history is fresh) · CAS sharpening after TAA → luma-gated film grain
  → triangular dither → fade → screen
```

### Per-mode profiles (`'auto'` settings)
| | system (planets/space) | cosmic / galaxy |
|---|---|---|
| AA | TAA on high/ultra, FXAA 3.11 on low/med | FXAA (none if MSAA) |
| GTAO | yes (q.ssao) | no |
| Eye adaptation | yes, partial (strength 0.7, key 0.28, key −45 % at night via `G.uNight`), clamps 0.4–4×, ≤1.1× above the atmosphere (space stays OLED black) | no (modes meter themselves) |
| Lens flare / dirt | yes | no |
| Film look | `film` (AgX power 1.22, sat 1.22) | `neutral` (plain AgX) |
| Bloom | `mix` (scatter 6 %, threshold 0, highlight boost ×4 above the look's threshold) | `add` (mode's threshold/strength) |
| Clarity | 0.25 | 0 |
| Motion blur | high/ultra, real-time only | no |
| DOF | in UI photo mode (high/ultra) | no |

### Invariants
* **OLED black**: black stays exactly 0 — lift is masked near black in the LUT (`LUT(0)=0`), contrast is an S-curve
  pinned at 0 and 1, grain and dither are gated off in pure black, exposure is multiplicative, AgX's toe maps
  < 2^-12.5 to 0. Space above the atmosphere is never boosted by eye adaptation.
* **No banding**: the graded image is kept in RGBA16F until the final pass, which applies triangular dither.
* **Never blank**: any exception inside the pipeline logs once and falls back to a direct render; TAA restores the
  camera projection (and never overwrites a projection three recomputed, e.g. the reversed-Z switch on first use).
* **Shot mode**: when TAA history is invalid (every `advance()` capture), the frame is rendered as N jittered
  sub-frames of the frozen instant and averaged (N = 4 high, 6 ultra; `&taas=N` overrides, `&taas=1` for fast
  iteration) — exactly what a converged TAA shows for a still camera. Shadow maps are rendered once per capture.
  Eye adaptation and the sun probe snap instantly on history resets.

## API (all old fields kept)

`pipeline.addEffect(effect) → unregister`, `removeEffect`, `setLook(look)`, `resetLook()`, `settings`, `render`,
`setFade(v, color)`, `depthTexture`, `makeFullscreenMaterial(frag, uniforms, extra)`, `FullscreenQuad` (now also
`quad.draw(renderer, material, target)`), `width/height`, `quad`, `sceneRT`, `stats` (last frame's features).

`settings` (merge with `setLook`; nested objects merge one level):
```js
exposure, tonemap: 'agx'|'aces'|'reinhard'|'none', filmLook: 'auto'|'neutral'|'film'|'punchy'|{power, saturation},
saturation, contrast, vibrance, temperature, tint, lift[3], gamma[3], gain[3], shadows[3]?, highlights[3]?,  // → 3D LUT
vignette, grain, chromatic, blackPoint,
bloom: { strength, radius, threshold, knee, mode: 'auto'|'add'|'mix', scatter, mixThreshold, highlightBoost },
clarity: 'auto'|0..0.5,
aa: 'auto'|'taa'|'fxaa'|'none',   taa: { feedback, sharpen, shotSamples },
ssao: { enabled, radius (m), intensity, fadeFar (m), debug },
autoExposure: { enabled, key, strength, min, max, spaceMax, nightDrop, speedUp, speedDown, floor },
flare: { enabled, intensity, ghosts, starburst, halo, streak, dirt, ssGhosts },
purkinje, motionBlur: { enabled, strength }, dof: { enabled: true|false|'photo', focus (m, 0 = auto), aperture, maxCoc },
debugView: 'scene'   // composite the raw scene target (bisecting)
```
The grade LUT is rebuilt only when grade-relevant settings change (`gradeSignature`).

Debug: `window.__rvPost.stats`, `__rvPost.meter()` (adapted luminance), `__rvPost.sun()` (probe),
`&post=legacy` renders through the original scaffold pipeline for A/B comparisons.

## Capture URLs

* Surface, day (TAA + GTAO + grade): `/?mode=system&galaxy=0&star=6&planet=1&tod=0.3` steps `[{"advance":1}]`
* Forest (BotW grade, saturation): `/?mode=system&galaxy=0&star=11&planet=0&tod=0.35` steps `[{"advance":1}]`
* Sun flare from orbit: `/?mode=system&galaxy=0&star=6&planet=1&view=orbit` steps
  `[{"advance":0.5},{"eval":"__rv.world.space.orbitSunShot(23, 35)"},{"advance":0.5}]`
* Sunset toward the sun: `/?mode=system&galaxy=0&star=6&planet=1&tod=0.72` steps
  `[{"advance":0.5},{"eval":"__rv.world.space.look('sun', 22, 4)"},{"advance":0.5}]`
* Night, emissive glow + OLED sky: `/?mode=system&galaxy=0&star=2&planet=0&tod=0.9` steps `[{"advance":1}]`
* Photo-mode depth of field: `/?mode=system&galaxy=0&star=6&planet=1&tod=0.3` steps
  `[{"eval":"(__rvPost.pipeline.settings.dof.enabled=true,1)"},{"advance":1}]`
* AO only: add `{"eval":"(__rvPost.pipeline.settings.ssao.debug=true,__rv.render(),1)"}`.

## Known issues
* The sun probe's cloud test compares the solar disc with a ring around it; a sun that is only a diffuse glow
  (thick haze) correctly gets no hard flare, but a disc drawn smaller than ~2 px is judged by depth alone.
* SwiftShader captures of shot sub-frames cost ~N× a frame (4 × 10–25 s at 960×540 on busy machines).
* Alpha-tested foliage still shows some stipple at 960×540 with 4 shot sub-frames; real-time TAA (16-sample cycle)
  resolves it better.

## Requests
* **space** — draw the star disc into the HDR target (far depth) from orbit too: from `view=orbit` the probe reads
  ~0 luminance at `world.space.sun.screen`; the flare core currently stands in for the disc.
* **flora** — alpha-tested leaf cards: with TAA available (`engine.pipeline.stats.taa`), consider alpha-to-coverage
  style dithered alpha (IGN keyed to `G.uFrame`) so TAA resolves soft canopy edges instead of hard stipple.
* **core** — optional: set `engine.pipeline.settings.dof = { enabled: true, focus }` during cinematic transitions.
