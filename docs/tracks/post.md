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

### Season 2 art direction (system mode; cosmic/galaxy untouched — verified bit-identical cosmic capture)
* **Two hues + one warm accent** (`src/post/looks.js` `harmonyFromArt`, baked into the 3D LUT in `grade.js`): from
  `body.art.palette` the pipeline derives a sky hue A and a land hue B (chroma-weighted grass/rock/sand). In YIQ
  (luma-exact) every hue is pulled toward the nearer anchor (`harmonyStrength` 0.56), chroma × 0.8, and a split tone
  leans shadows toward the sky hue and highlights toward a warm light (zero at black). Strongly saturated reds (the
  scarf, lanterns, windows — hue window × chroma gate, so pink sand/rock is NOT exempt) stay out of the pull and get ×1.2.
* **Depth-layered aerial perspective** (rule 4): each layer back drifts toward the metered colour of the lower sky
  (`SkyMeter`, 4 tiny GPU passes), paler and a touch cooler; when no sky is in frame the haze colour falls back to
  `G.uAmbientSky × 1.1` (sky radiance ≈ irradiance / π, horizon brighter). `haze: { enabled, strength 0.34, distance }`.
* **Night** (rule 3): indigo Purkinje on dim tones + multiplicative lift of the land's dim tones (`night.lift`), black
  stays 0, the sky is not lifted.
* **Blue hour / dusk** (`atmosphere.twilight`): exposure meters for the sky (key × (1 − 0.42·twilight)) and the land
  loses its colour toward the sky's hue (`dusk.desat` 0.5, hue pushed ×1.7 so it reads blue/violet, not grey).
* **Overcast** lowers the key (`× (1 − 0.35·overcast·storm)`); **eclipse** (`space.eclipse`) darker, cooler, harder.
* **Space**: above the air the sun probe trusts depth alone (no cloud can sit in front of a star), so starburst, halo
  and ghosts show from orbit even when the star disc is too small/dim to meter; the star tints a wide patch of space
  around it (`flare.spaceGlow`, default 1). Screen-space ghosts of other bright lights fade out above the air (they
  mirrored the lit planet into big brown discs from orbit — civ's W1 `view=orbit&tod=0.22` report).
* `stats.avgLum` for the HUD (ui request), see API.

### Season 2 round 3 (21 Oct): silhouettes that read, golden hour, Kurosawa and ink wash
* **Looks build value from depth, not from noisy texture.** `layerT(dist)` (log depth, 6 m → 0.55 × atmosphere
  height) gives each look its layers: the ground at the lens, the middle distance, the far ridges (rule 4).
  Two-tone and candy map land to a lifted floor in the look's dark hue that steps toward the sky hue with distance
  (u_177: black figure, magenta mid-ground, poured sky); poster bands depth layers + heavily smoothed light
  (shadow dapples and grass ignored), ink-wash turns layers into washes.
* **Rim**: a land pixel whose neighbour ~1.5 px away is much farther (or sky) gets a fine fringe in the look's
  light hue (twotone, candy) or a wet ink edge (ink): silhouettes, ridges and the figure keep crisp shapes.
* **The explorer mask** (`_updatePlayerMask`): her feet → head capsule projected to the screen, depth-matched
  (±0.7–1.4 m), only while she is drawn (not fp/orbit/vehicles) and only when a look is on. Looks make her the
  darkest, cleanest shape in frame (pure black in twotone/candy/poster, ink in sumi-e); reds keep the accent.
* **The poured sky**: sky value from the sky's own luminance relative to the metered sky (SkyMeter) plus a slow
  vertical pour, so a flat sky gets deep crimson at the zenith, hot magenta and a pale cap where the clouds burn.
* **Golden hour (no look, system mode)**: `_golden()` from the sun's elevation at the camera (≈ 21° → 3°, gone
  0.5° below the horizon): exposure key −36 % (expose for the sky), split tone (shadows indigo, highlights the sun's
  colour; multiplicative, black stays 0) and a graduated land drop (`landDrop`, also at blue hour) so the land goes
  deep while far hazy ridges keep their light. `settings.golden = { enabled, strength 1.3, keyDrop 0.36, landDrop 0.5, warmth 0.6 }`.
* **Night**: the sky is pulled to deep indigo (`night.sky` 0.55; bright stars keep their colour) and the brightest
  emitters (lanterns, the World Tree's light cards) get a wide soft luminous mist from the wide bloom
  (`night.mist` 0.12, soft-capped; flora request).
* **Space**: the star's wide halo is ~3× stronger and tinted by its own colour (more saturated than the core) so
  the space around a star is coloured, not neutral grey (rule 6, u_14).
* **New looks**: `kurosawa` (red-filter black-and-white film: deep contrast, halation, a touch of wind blur along
  the screen-space wind, heavy grain, vignette) and `ink` (sumi-e: paper texture, depth-layered washes, the ground at
  her feet left as paper so her figure reads, wet ridge edges, depth ink lines, the sun as a vermilion seal, the
  scarf in vermilion).
* **Instant look switching**: `pipeline.recomposite()` re-grades the last frame without rendering the scene (photo
  mode UI can switch looks instantly); `__rvPost.look(name, opts)` = setPhotoLook + recomposite (captures iterate
  every look from one scene render).

### Season 2 round 4 (21 Oct)
* **Backlit golden haze**: at low sun (`uGolden`) the aerial-perspective haze scatters the sun forward
  (Henyey-Greenstein g 0.7, normalised to 1 at the sun): toward the sun each depth layer becomes a luminous gold
  veil (haze up to ×2.6 denser, ×2.5 brighter, warm), away from the sun it stays the cool metered sky. The land
  drop still applies after it, so the near land goes deep and the far ridges glow: "each ridge one step paler".
  `settings.golden.glow` (default 1, 0 disables); it is applied in `_finish`, so `recomposite()` A/Bs it:
  `{"eval":"(__rvPost.pipeline.settings.golden=Object.assign({},__rvPost.pipeline.settings.golden,{glow:0}),__rvPost.recomposite(),1)"}`.
  Verified on the W1 sunrise behind the volcano (the cone's upper slopes and the sea of cloud turn gold) and the
  W3 sunset (a red luminous veil at the cliff foot under the sun). Note: other render-time grade uniforms are NOT
  refreshed by `recomposite()` (only looks and the glow); toggle them with a real render.
* **Blue hour no longer desaturated twice**: the atmosphere drains the land's colour itself now (`uLandMono`), so
  post's `dusk.desat` only tops up what it leaves (`× (1 − uLandMono.x)`).

### Photo looks (UI photo mode)
`pipeline.setPhotoLook(name, opts?)`, `pipeline.cyclePhotoLook(dir)`, `pipeline.photoLooks` (names), URL `&look=name`.
The look survives `resetLook()` (it is the player's choice). Applied after the LUT, so the output is exactly the look's
colours (plus the accent where enabled).

| name | what | creator checklist |
|---|---|---|
| `twotone` | black → crimson → magenta → pale-pink poured sky; land layered by depth (lifted dark floor), rim on silhouettes, the explorer pure black | "Two colours: magenta and black" |
| `bw` | high-key black and white with halation from the wide bloom | "High-key black and white" |
| `poster` | sky in 2 flat bands (sky hue / cream), land in depth layers (dark mass, lighter ground at her feet and far ridges) from a depth-aware 16-tap smoothed light, depth ink lines 2 px, red accent kept | "Poster flatness: hard shapes, three colours" |
| `candy` | poured rose → coral → pale-gold sky, land in plum layers with a coral rim, red accent | "A candy sky over a near-black foreground" |
| `woodcut` | stepped two-colour sky, engraved cross-hatched land, ink lines | "A two-colour sky with black line-work in front" |
| `kurosawa` | red-filter B&W film: deep contrast, halation, wind blur, heavy grain | Ghost of Yotei "Kurosawa mode" |
| `ink` | sumi-e: paper, depth-layered washes, wet ridge edges, vermilion sun and scarf | Ghost of Yotei ink-wash looks |

`opts` overrides: `{ toneA, toneB, toneC, toneD (css colours), land, accent, ink, bands, sat, grain, inkWidth }`,
e.g. `setPhotoLook('twotone', { toneB: '#2a6cff' })` for a blue/black two-tone.

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
`setFade(v, color)`, `recomposite()` (re-grade the last frame, no scene render), `depthTexture`, `makeFullscreenMaterial(frag, uniforms, extra)`, `FullscreenQuad` (now also
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
harmony: 'auto'|false|{hueA, hueB, strength, splitShadow, splitHigh, warmHue, accentHue, accentWidth, accentSat, otherSat},
harmonyStrength, haze: { enabled, strength, distance, fallback }, night: { lift }, dusk: { desat, keyDrop },
eclipse: 'auto'|0..1, photoLook, photoLookOpts, flare.spaceGlow,
golden: { enabled, strength, keyDrop, landDrop, warmth, glow }, night: { lift, sky, mist },
debugView: 'scene'   // composite the raw scene target (bisecting)
```
The grade LUT is rebuilt only when grade-relevant settings change (`gradeSignature`).

`stats.avgLum` (ui request): display-referred mean frame brightness 0..1, from one 1×1 readback every ~0.5 s
(system mode with eye adaptation; `null` elsewhere).

Debug: `window.__rvPost.stats`, `__rvPost.meter()` (adapted luminance), `__rvPost.sun()` (probe), `__rvPost.skyColor()`
(metered haze colour vs ambient),
`&post=legacy` renders through the original scaffold pipeline for A/B comparisons.

## Capture URLs

Season 2 round 3 (looks are captured by URL `&look=name`, or switched on the same frame with
`{"eval":"__rvPost.look('ink')"}` followed by a `shot` step: no new scene render):
* **Two-tone, the explorer as a black silhouette against a poured magenta sky (u_177)**:
  `/?mode=system&galaxy=0&star=9&planet=2&tod=0.745&look=twotone` steps
  `[{"advance":1},{"eval":"__rv.world.space.look('sun', 28, 14)"},{"advance":0.3}]`
* **Candy sky over the arch and the volcano, red spider lilies as the accent**:
  `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=16.7394&lon=27.123&yaw=276.5&pitch=9&tod=0.3&props=0&look=candy`
  steps `[{"advance":1}]`
* **Kurosawa black and white on the flowered ridge facing the mountain**:
  `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=16.6718&lon=25.7718&yaw=277&pitch=9&tod=0.37&props=0&look=kurosawa`
  steps `[{"advance":1}]`
* **Ink wash through the arch** (vermilion lilies and scarf): the arch URL with `&look=ink`
* **Poster** on the W3 dunes: the two-tone URL with `&look=poster`
* **Sunrise behind the volcano, backlit gold haze (no look)**:
  `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=800&lat=17.777&lon=-2.5&yaw=87&pitch=6&tod=0.272&disable=fauna,vehicles`
  steps `[{"advance":1}]`
* Golden hour grade (no look): the W3 URL without `look`; W1 sea of cloud at sunrise:
  `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=700&lat=5.79&lon=13.2736&yaw=0&pitch=7&tod=0.28&disable=fauna,vehicles`

Season 2 (best views, composed sky-first):
* Diamond ring from orbit (black disc, thin bright coloured edge, corona, star-tinted space):
  `/?mode=system&galaxy=0&star=6&planet=1&view=orbit` steps
  `[{"advance":0.5},{"eval":"__rv.world.space.orbitLimbShot(0.8, 35)"},{"advance":0.5}]`
* Sun, starburst and ghosts from orbit: same URL, steps
  `[{"advance":0.5},{"eval":"__rv.world.space.orbitSunShot(31, 35)"},{"advance":0.5}]` (23° hides the sun behind the limb)
* Photo looks over the W3 dunes at sunset (sky two thirds, the explorer on the join):
  `/?mode=system&galaxy=0&star=9&planet=2&tod=0.745&look=candy` (or `twotone`, `poster`, `bw`, `woodcut`, none) steps
  `[{"advance":1},{"eval":"__rv.world.space.look('sun', 28, 14)"},{"advance":0.3}]`
* Night, indigo readable ground + emissive flora: `/?mode=system&galaxy=0&star=2&planet=0&tod=0.9` steps `[{"advance":1}]`
* Day grade (two hues + red accent, haze layers): `/?mode=system&galaxy=0&star=6&planet=1&tod=0.3` steps `[{"advance":1}]`
* Blue hour (land takes the sky's hue): `/?mode=system&galaxy=0&star=6&planet=1&tod=0.76` steps
  `[{"advance":1},{"eval":"__rv.world.space.look('sun', 25, 9)"},{"advance":0.3}]`
* A/B: `{"eval":"(__rvPost.pipeline.settings.harmony=false,__rvPost.pipeline.settings.haze.enabled=false,__rv.render(),1)"}`
* Fast iteration: add `&taas=1` (one shot sub-frame).

Earlier:
* Forest (BotW grade, saturation): `/?mode=system&galaxy=0&star=11&planet=0&tod=0.35` steps `[{"advance":1}]`
* Photo-mode depth of field: `/?mode=system&galaxy=0&star=6&planet=1&tod=0.3` steps
  `[{"eval":"(__rvPost.pipeline.settings.dof.enabled=true,1)"},{"advance":1}]`
* AO only: add `{"eval":"(__rvPost.pipeline.settings.ssao.debug=true,__rv.render(),1)"}`.

## Known issues
* Open after season 2 (the round 3 critic, 21 Oct: 4.5 → 5.0 → 5.5/10, blind 1/4 → 3/4 → 1/4; the track's season-2
  rounds are used up, so these lead the next pass): the critic credits real art direction (the kurosawa grade, the
  sunrise god-ray fan on the volcano, the diamond-ring eclipse limb, the red lilies and scarf kept as the warm
  accent), and the blind judges took the layered black-and-white valley with the floating isles. Still open: the
  two-tone look collapses the land into a flat black slab with a pink outline, and candy and ink crush the land and
  foreground to black with a cut-out outline, where the references keep layered silhouettes with atmosphere and a
  poured sky; the kurosawa look is high-key and flat (no deep blacks, weak mid-tone separation); the sunrise frame is
  low-contrast and desaturated with no foreground, figure or sun disc; the orbit limb is jagged (terrain LOD, see
  section 6); the night reads muddy teal with a visible grain pattern instead of indigo. The cosmic view stayed
  byte-identical to the baseline through this pass (checked 21 Oct).
* Ink wash: a large rock right at the lens becomes a flat soft grey wash (no edges inside it); poster: a sunlit cliff
  top can show a soft grey band where the smoothed light crosses the threshold.
* The backlit gold haze follows the sun's colour (`uGoldTint`): on red-star worlds (W3) the veil is red, not gold.
* The explorer mask is a projected capsule (0.42 m half-width, depth-matched ±0.45–0.9 m): a katana or scarf
  flying far outside it is graded as land; a rock touching her at the same depth joins her shape.
* Looks band depth layers from `layerT` (6 m → 0.55 × atmosphere height); on very small moons the far layers come
  closer and the mid-ground reads paler.
* The jagged lit limb from orbit is still the terrain LOD (see Requests); the green night-side ring is gone (atmosphere).
* The hard green ring around the night side of planets from orbit is drawn by the atmosphere effect (order 100):
  it disappears with that effect disabled, and is unchanged by harmony / chromatic aberration (bisected, see Requests).
* The jagged lit crescent from orbit is the coarse terrain LOD at the limb (terrain), not post.
* The woodcut hatching is screen-space (fixed pitch ∝ resolution); on large flat cliffs it can read as a screen pattern.
* The haze fallback (no sky in frame) estimates sky radiance from `G.uAmbientSky`; it is a little darker and bluer than
  the metered horizon at sunset.
* The sun probe's cloud test compares the solar disc with a ring around it; a sun that is only a diffuse glow
  (thick haze) correctly gets no hard flare, but a disc drawn smaller than ~2 px is judged by depth alone.
* SwiftShader captures of shot sub-frames cost ~N× a frame (4 × 10–25 s at 960×540 on busy machines).
* Alpha-tested foliage still shows some stipple at 960×540 with 4 shot sub-frames; real-time TAA (16-sample cycle)
  resolves it better.

## Requests
* **terrain** — from orbit (W1 `view=orbit`, `orbitLimbShot(0.8, 35)`) the lit limb is a stair-stepped, notched
  silhouette (coarse displaced LOD poking through the atmosphere ring). Clamp the limb chunks to a smooth sphere LOD
  or fade relief toward the silhouette (n·v → 0) at orbit distance.
* **ui** — photo mode: the two new looks `kurosawa` and `ink` are in `engine.pipeline.photoLooks`; switch with
  `setPhotoLook(name)` then `recomposite()` while paused (instant).
* **atmosphere** — from orbit, a 3–4 px saturated green ring outlines the whole night side of W1 (`view=orbit`,
  `orbitSunShot(23, 35)`); bisected to the atmosphere effect (order 100). If it is airglow, make it far fainter and
  thinner (a hairline at ~1–2 % of the day limb), or tint the limb from the sun side: `pow(1 − mu, 5) · mix(sunTint,
  skyBlue, …)` fading to ~0 on the night side.
* **ui** — photo mode looks: a selector (or one button / key cycling) calling `engine.pipeline.setPhotoLook(name)` /
  `cyclePhotoLook(±1)`; names in `engine.pipeline.photoLooks` (`none, twotone, bw, poster, candy, woodcut, kurosawa, ink`). Show the
  look name briefly when it changes. Call `engine.pipeline.recomposite()` after `setPhotoLook` while the game is
  paused in photo mode: the look switches instantly without a new scene render. `stats.avgLum` is now available for the HUD contrast shades.
* **space** — (still open) draw the star disc into the HDR target (far depth) from orbit too: the probe now trusts depth
  in space, but the disc itself is not visible, only the flare core stands in for it.
* **flora** — alpha-tested leaf cards: with TAA available (`engine.pipeline.stats.taa`), consider alpha-to-coverage
  style dithered alpha (IGN keyed to `G.uFrame`) so TAA resolves soft canopy edges instead of hard stipple.
* **core** — optional: set `engine.pipeline.settings.dof = { enabled: true, focus }` during cinematic transitions.
