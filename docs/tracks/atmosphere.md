# Atmosphere track — scattering, sky, clouds, weather & lighting

Owner paths: `src/world/atmosphere/**`, `docs/tracks/atmosphere.md`.
Subsystem `atmosphere` (order 20) auto-loaded by `World`. Every pass is fault-isolated
(try/catch around init/update, pipeline disables a throwing effect) and guards optional neighbours.

## What was built

| file | what |
|---|---|
| `model.js` | CPU side: per-body Rayleigh / Mie / ozone coefficients from `body.atmosphere` + `body.art`, art-tint calibration, CPU transmittance table, CPU sky radiance/irradiance (ambient, cloud ambient) |
| `glsl.js` | shader chunks `rv_atmo` (medium, phases, LUT lookups, `atmo_march`, `atmo_transSegment`, `atmo_sunTransmittance`), `rv_atmo_sky` (sky-view LUT), `rv_atmo_view` (screen ray reconstruction), `rv_cloudshadow` |
| `luts.js` | Hillaire 2020 LUTs on the GPU: transmittance 256×64, multiple scattering 32×32 (once per planet), sky-view 192×108 MRT (Rayleigh / Mie / multi-scatter split, phases applied per pixel → sharp aureole) every frame |
| `effect.js` | pipeline effect **`atmosphere` (order 100)**: sky from the ground (LUT, ×`uSkyViewGain` ≈ 1.28 for a game-bright sky dome) → seamless per-pixel march from altitude/space; aerial perspective on all geometry (the art sky gain relaxes to physical from altitude/orbit → deep blue oceans from space); background (stars / sun / planets of the space track) × transmittance with daytime star suppression on the **far-plane background only**; night sky (deep-blue starlight gradient brighter toward the horizon, moonlit sky, green airglow band / limb ring from space); aurora curtains; analytic height-fog banks (weather); **lava-lit glowing low haze** on lava worlds; fallback sun disk + star field + galactic band **only when no `space` subsystem exists** |
| `clouds.js` | pipeline effect **`clouds` (order 110)**: volumetric cloud shell (same march from ground, altitude and orbit), GPU-generated tileable Perlin-Worley 3D noise + a second, finer curl-offset detail octave (cauliflower edges), lumpy bases/tops, density gradient (translucent bases, solid tops), planet-wide weather cube map (coverage / tallness / storm cells / orbit detail) with **deterministic cyclones** (spiral bands, clear eyes) drifting with the wind, per-type shaping, lighting = single + 3 multiple-scattering octaves (desaturated: light inside clouds loses the low-sun tint), view-dependent powder (dark sun-facing edges seen from the anti-sun side, none toward the sun), silver lining, **column optical depth above each sample** (ambient occlusion + diffuse transmission → mottled, darker thick bases; storm decks with structure), sun × atmospheric transmittance per sample, overcast/storm darkening, localized lightning flash, aerial fade into the sky; **distance LOD** (22–70 km × size): far away the 3D noise tile averages out and the weather map's cellular detail carries the shapes (no tiling from orbit); half-res + depth-aware upsample; **cloud shadow map** projected along the key light; `q=low` → cheap 2-sample slab |
| `lightshafts.js` | pipeline effect **`volumetric-light` (order 120)**: (1) **ray-marched volumetric light** (quarter res, MRT, depth-aware upsample): each view ray is marched through the air below and between the clouds; a near segment samples the **sun's cascaded shadow map** (trees, buildings, ridges → Pacific-Drive-style shafts in fog), the whole ray samples the **cloud shadow map** (crepuscular rays through cloud gaps, anti-crepuscular rays). Shadowed air loses the single scattering the atmosphere pass gave it (hue-preserving darkening, weighted by the clouds in front), lit weather haze (fog / dust / rain / morning haze) glows with a forward phase; **rain curtains** hang under dense / stormy cells of the weather map (grey extinction + in-scatter); (2) screen-space radial streaks around the key light (quarter-res sky × cloud-transmittance mask, two radial blurs) |
| `weather.js` | weather state machine + pipeline effect **`weather` (order 125)**: rain streaks (thin, dim lens-like drops, faded near the lens), snow flakes, dust motes (camera-local volume wrapped in the vertex shader, soft depth test), **no precipitation above the cloud deck / dust layer or outside the atmosphere**; lightning = fractal (midpoint-displacement) branched bolt with **depth test** against the scene, localized cloud flash, environment flash scaled by darkness; strikes are scheduled deterministically from sim time, so captures of stormy worlds see bolts too; drives `uWetness`, `uSnow`, `uWindStrength` |
| `lighting.js` | `SunLight` key light with custom N-cascade shadows (`RVSunShadow`: 2–4 cascades in one atlas, texel snapping, per-cascade normal bias), moon as key light at night (phase-aware), PMREM environment of the sky + cloud deck (cover / colours follow the weather and time of day) on `scene.environment`, **overcast-aware ambient** (the deck greys and dims the sky dome; blocked direct sun returns as diffuse light), hemisphere fallback, material auto-setup (cloud shadows on the key light) |
| `index.js` | subsystem glue, per-frame CPU state, pre-render GPU work (LUTs, env map, cloud shadow map) |

### Season 2 · round 3 (Ghost of Yotei: the air as a medium, not a dome with objects in it)
* **Landscape-scale aerial perspective** (`effect.js landOD / hazeSky`, `index.js _updateFog`): an exponential
  height haze integrated along the view ray over the curved ground (6 samples), whose in-scatter is the **sky
  radiance of the same azimuth just above the horizon** (sky-view LUT incl. the sun's aureole, blue-hour dome,
  night glow, golden aureole). Each ridge back is one step paler and takes the colour of the sky right behind it;
  a soft shoulder on the optical depth keeps the farthest planes as faint silhouettes. The foreground stays crisp
  (`× (1 − e^(−d/600 m))`). Rain triples it (`wet = 1 + 3.2·rain + …`), fog / moody / dust worlds thicken it, the
  sun's Mie aureole is dropped from the near haze once the sun has set at the camera (`uLandSun`). Far clouds fade
  into the same haze (`clouds.js cl_landOD`).
* **Rain as a veil** (`uLandOC`): under a closed / raining deck the haze, the far clouds and the horizon band all
  blend toward one deck-lit veil colour (the world's fog hue, a soft cool lavender in rain, slate under storms),
  so the horizon is the veil itself; the volumetric pass adds the diffuse, deck-lit part of the rain haze (no dark
  band) and the far rain sheet is fainter (it summed into a flat milky film over the foreground).
* **Golden aureole** (`uGold`, effect.js `skyExtras`): a low sun (≈ 20° down to sunrise / sunset, clear air)
  floods the sky around it with honeyed light (HG 0.76 + a broad HG 0.5 lobe, strongest near the horizon); the
  haze takes it too, so ridges toward the sun glow gold. The key light warms at golden hour (luminance kept).
* **Blue hour: the land has no colour** (`uLandMono`): during the blue-hour window (and ~40 % at night) the land's
  own colour drains to a cool grey (scotopic vision) while the haze in front keeps the sky's hue and bright
  emitters (windows, lanterns, glowing flora, the World Tree) keep theirs; off on moody worlds and from altitude.
  The ambient hold-back is milder (a faint cool rim of detail stays), the last-light line is wider and brighter.
* **The World Tree lights the mist** (flora request; `landmarkGlow`, `uGlowP/uGlowC`): at dusk and night the
  haze around `flora.sacred` glows warm (analytic single scattering from a point source: brightest where the
  view grazes the crown, a soft halo a few km out, stronger in fog / rain and while the explorer meditates).
* **The sky answers** (player request): `world.player.meditating` brightens the stars, draws a faint ring of light
  around the zenith (the sign of the source, `uSource`), stills the wind (`G.uWindStrength × (1 − 0.8·m)`) and
  warms the key light (warm / cool palette at W9 dusk).
* **Dust storm with a light inside** (`uFogGlow`): the hidden sun glows on one side of the one-colour wall
  (HG 0.5 + a tight core), gust bands roll along the wind in the density, and the wall is brighter up high,
  denser and darker near the floor.
* **Orbit**: the limb line takes the world's own sky hue (near white, a breath of tint), warm at the terminator,
  a ~1 % airglow hairline on the night side (no saturated green ring, post request); the cloud tops' terminator is
  graded over ~12° (`smoothstep(−0.03, 0.2, μ)`).
* **Wavy horizontal stripes across distant clouds fixed** (the "comb" in grazing views from altitude): the
  weather cube was read with the implicit, derivative-based mip choice inside the jittered march, where
  neighbouring pixels sample points kilometres apart → the level jumped in bands across the screen. It is now
  read with an explicit LOD (`textureLod`, 0 near, up to 1.5 in the orbit far field). Cloud forms everywhere are
  smoother (fewer hard sprite-like edges and speckle).
* **Clouds cleaner**: (1) the seam at altitude is gone (rays that dip under the base and miss the ground
  continue to the far exit of the layer instead of stopping at the base tangent); (2) quadratic step spacing for
  long grazing paths from inside / above the layer; (3) the light march uses the base shape only, its steps are
  jittered and the step leaving the layer is weighted by the part inside (fixed sample points terraced the
  lighting); the column-above gate at h = 0.9 is gone (a contour line across every cloud); (4) stricter
  anti-confetti gate on thin coverage; (5) full-res stills get a 4×4 depth-aware gaussian denoise of the cloud
  target (no dither grain); (6) night clouds near towns take the light pollution's hue (neon worlds most).
* **Aurora**: thin vertical curtains (sinuous folds, fine rays that drift), a hard lower edge, green fading to
  violet-navy at the top, a thin magenta fringe at the bottom.
* **Rain fog** in the analytic height fog is lower (the veil is carried by the landscape haze, which keeps the
  foreground crisp); the horizontal-ray height-fog integral uses a series near zero (no dashed horizon seam).

### Season 2 · round 2 (toward the creator's frames: the air does the acting)
* **Blue hour** (`effect.js twilightSky`, `index.js`, `lighting.js`): for the sun between ~+2.5° and −23° an
  art twilight dome is added to the physical sky: deep saturated navy zenith (a touch of the world's sky tint),
  a teal band low toward the sun, a rose glow, a thin orange **last-light line** hugging the horizon under the
  set sun (`exp(-elev/0.022)`, fading with the sun's depression) and the belt of Venus opposite. Meanwhile the
  land is exposed for the sky: the art "readable night" ground ambient is held back (×0.28) and the sky
  ambient / environment intensity drop to ×0.44 inside the blue-hour window → land in silhouette, sky in
  colour; full night returns the readable moonlit ground. `state.atmosphere.twilight`.
* **Nights**: deeper, more saturated indigo starlight sky; stars and the galactic band are no longer hidden by
  the night sky glow (`uStarVis` 3.0 by day → 0.45 at night: the daytime contrast threshold was hiding the
  space track's band and most stars at night).
* **Orbit limb = thin hard line** (`effect.js limbLine`): an emitting shell just above the cloud tops and the
  highest relief, seen edge-on (chord / thickness ≈ ×25 limb brightening) → a 1–2 px line just outside the
  disc edge: teal-white on the day side, warm at the terminator, a faint green airglow line on the night side
  (the old soft night-only airglow shell fades out from orbit). **Soft terminator**: from orbit the lit ground
  is faded with the sphere's own N·L (`smoothstep(-0.07, 0.16, μ)`): no lit facets past the terminator, a
  graded warm band. **Orbit cloud veils** (`clouds.js`, `uShape7.y`, `&veil=`): thin translucent stratiform
  sheets join the far-field cloud fields (milky ocean between the bright cores instead of white confetti).
* **Landscape god-ray fan** (`lightshafts.js`): a third screen-space channel — open sky through the deck's gaps
  (cloud transmittance), averaged over the WHOLE line to the sun (the sun may be ~a screen off-frame) — then
  contrast against the neighbouring lines a few degrees to each side: lines through gaps are brightened in the
  key light's hue, the shadowed lines between them dimmed (multiplicative, so it reads against any sky).
  Gated to partial cover (0.22–0.9), low-to-mid sun, the deck overhead (none above a sea of clouds), fades with
  `sunDim`. `&fan=0..2` overrides; `&atmoDebug=6` shows the fan buffer (R mean, G/B ± contrast).
* **Rainbow** (`weather.js`, copy pass at order 125 so it hangs in front of the clouds): primary bow
  40.5–42.5° from the antisolar point, reversed secondary at 50.4–53.6° (×0.3), brighter sky inside, Alexander's
  dark band, only over the far land (> ~600 m) and the sky. Natural trigger: wet air + thinning shower + sun
  out (`sunDim` > 0.45) + sun below ~40°, below the cloud base; `&weather=rainbow` stages it (light drizzle,
  broken deck, wet ground). `state.atmosphere.rainbow`.
* **Snow is fog / dust is a one-colour wall** (`index.js _updateFog`, `effect.js uFogMono`): heavy snow
  ≈ 1.2e-3 /m (land fades within ~1 km); a dust storm ≈ 2.6e-3 /m whose in-scatter collapses to ONE hue
  (the dust's, from the ground albedo / tint, saturated); clouds are swallowed by the veil from below
  (`clouds.js uSwallow`).
* **Coloured fog**: every haze carries ~30–45 % of the world's `art.palette.fog` hue (lavender rain veils, teal
  neon smog); plain rain (no storm) veils are paler (each ridge one step lighter); on **bioluminescent**
  worlds at night a low mist glows with the flora's palette colour (teal around W4's forest — flora request).
* **Eclipse** (space request): `world.get('space').eclipse` (0..1) when present, else 1 − `space.sunVisibility`
  at the camera: sunlight × (1 − 0.97·e) for the sky, clouds, key light and env map, and the twilight dome
  with last light all around the horizon (360° sunset). `state.atmosphere.eclipse`.

### Round 4 (critic fixes: orbit fidelity, storm mood, cloud cleanliness)
* **Orbit cloud fields read as weather, not cut-out islands**: the weather cube is sheared by **jet streams**
  (latitude-dependent zonal rotation about the planet axis + a large meander) and mildly stretched east-west, so
  fields become slanted frontal bands, cloud streets and spiral arms around the cyclones; the far-field texture
  puts less weight on the 14 km octave (it made ~10 km blobs) and more on east-west-stretched fine octaves
  (fibrous, mottled interiors); wider soft coverage edge.
* **Thin, graded limb**: view-only orbit compression of the shell (`uOrbitK`, same vertical column, scale
  heights × 1/1.85 from 1.2–3.2 atmosphere heights up): the limb is a thin glow bright at the surface that fades
  into space instead of a thick uniform ring. The LUTs always stay physical (`AtmosphereLUTs._phys`).
* **Narrow terminator band**: from orbit the art sunset reddening relaxes (`uSunsetK` → 1.15, `uSunKDrop` 0.18)
  so only a narrow band near the terminator turns orange (was a broad orange quarter of the disc).
* **Ground from orbit is lit by the sunlight that reaches it**: the key light from orbit is the unattenuated
  star; the atmosphere pass now multiplies lit ground by the sun-path transmittance relative to the overhead
  sun (`uOrbitLit`): golden → red → dark twilight band at the terminator; night-side emission untouched.
* **No confetti of tiny cumulus**: thin weather-map coverage no longer produces noise-peak puffs near the camera
  (density fades below ~0.3 coverage): clear sky between real cloud clusters.
* **No freckled sponge on shadowed cloud sides**: the light march uses the detail erosion only on its first
  step (deeper detail samples turned the low-sun shadow sides of thick cumulus into a dotted texture).
* **Storm / rain mood**: rain and storm decks pass far less diffuse light (`deckDim` = 1 − 0.42·precip −
  0.25·storm on the sky / ground ambient, blocked sun returns as 16 % diffuse instead of 30 %), the environment
  map's deck reaches the horizon under a closed deck and its ground no longer reflects direct sun the deck blocks
  (`uSunVis`), daytime lightning barely lifts the ambient (night flashes unchanged), rain haze slate-grey under
  storms and denser (`rn²·1.1e-3 /m`).
* **Stronger aerial perspective** by default (`apScale` 0.4 → 0.5): far ridges fade into blue haze.

### Round 3b (critic fixes, continued after the restart)
* **Cumulus read as cumulus, not one smooth blob per weather-map contour**: new per-type `billow` (`uShape7.x`):
  the coverage threshold rises toward the borders of the base Worley cells (~1/5 of a cloud) and drops in
  their cores → clusters of rounded towers with lumpy cauliflower outlines; smaller base tile (3.6 km), softer
  dome taper (0.45) so tops stay dense and crisp; stricter anti-speck gate on the base shape (`smoothstep(0.05,
  0.18, b0)`): fewer detached dots around the cloud tops.
* **Orbit**: a third, finer far-field octave (~1 km, rotated) frays the edges of the cloud fields (no smooth
  cut-out outlines); **cloud shadows on the ground from altitude / orbit** (3-sample march from the ground
  point toward the key light through the layer, complements the cloud shadow map that fades out at 12–30 km):
  every cloud field casts its shadow, long shadows near the terminator.
* **Rain mood**: rain means a closed deck: `sunDim = 1 − 1.55·precip − 0.4·storm` (moderate rain already kills
  the hard sun shadows: soft, shadowless storm light); rain haze grows with rain² (`rn²·7e-4 /m`: ~30 % at 1 km
  in moderate rain); denser but finer rain (12k streaks on high, width 6.5 mm, shorter 32 ms shutter, faded
  within 1.8–6 m of the lens: no white scratches across the frame).
* **Sun aureole instead of a milky veil**: the weather / golden-hour haze uses a two-lobe aerosol phase
  (HG 0.82 + HG 0.35): a compact bright glow around the sun, less flat brightening of the whole sky;
  lighter high cloud over the fog sea (0.3).
* **God rays without a milky veil**: the screen-space streak source also writes the unoccluded glow (G); the
  composite keeps the contrast (shafts through gaps, behind ridges and cloud edges) and drops ~75 % of the
  uniform glow of an open sky (`open³` of blurred / reference) — a clear sky around a low sun no longer turns
  into a flat white haze over half the frame (that glow belongs to the Mie aureole and the bloom). The
  volumetric haze uses the same two-lobe phase.
* **Airless bodies**: planetshine / earthshine (the lit parent planet or the brightest moon, `moon.ill`) +
  a starlight floor in the environment map → shadowed regolith reads instead of crushing to black.

### Round 3 (critic fixes)
* **Orbit clouds no longer cut-out patches**: far-field extinction drops to `farSig` (0.38) so thin cloud fields are
  translucent and only dense cores stay opaque; the coverage threshold is a soft remap that widens with the distance
  LOD (no binary edge); the far-field shape is curl-warped (domain warp of the 3D noise), the weather map's orbit
  detail uses round convective cells (squared inverted F1, no Voronoi polygons) whose strength varies regionally
  (popcorn fields vs smooth sheets: no regular "fish scales"); dense cores tower (`topF`) so a grazing sun at the
  terminator gives relief and self-shadow.
* **Orbit lighting bug fixed**: from altitude/orbit the key light is always the unattenuated star (it used to switch
  to the moon / planet-shadowed sun of the camera position, lighting the night side white and the day side dark);
  clouds use the star too, with a faint moon/starlight fill (`uAmbNight`) on the night side.
* **Night-side city lights + light pollution** (`effect.js`, from `world.civ.sites`): from altitude the night side
  of the ground glows where settlements are (cores + noise sprawl + road filaments, terminator-aware, warm sodium or
  neon magenta on Blade-Runner worlds); from the ground at night the air above towns glows on the horizon / overhead.
* **Ground clouds**: the detail erosion is band-limited with distance (octaves fade before they alias: no
  salt-and-pepper specks), sharper density-to-edge ramp (`edge`), rounded domes over flat bases (`dome`), billow
  octaves without the fur-like finest octave, curl-warped base shape; soft contact with terrain (density fades within
  ~260 m of the depth buffer — no cut-outs against fjord walls) and at the end of the march range (no hard line).
* **High cloud layer** (`uCirrus`): a 2D altocumulus / cirrocumulus sheet above the cumulus (soft mottled rafts
  drifting with the wind, forward-scattering), behind the cumulus from below, in front from above, fading from orbit.
  `&cirrus=0..1` overrides its opacity.
* **Sea of clouds**: billow-scale noise (2.8 km / 520 m), a crisp lumpy deck top (`topSoft` 0.86, `lump` 0.62) that
  a low sun rakes, thicker deck (760 m).
* **God rays**: the screen-space streaks no longer form one hard wedge — radial blur reach limited to ~0.55 screen
  heights, 3 × 32 taps with per-pass decay, gaussian angular falloff (σ ≈ 24°), applied over geometry only in
  proportion to the air in front of it, 4-tap soft upsample.
* **Golden hour**: a low-sun humid haze (forward scattering, warm, through the height-fog path) makes backlit
  ridges glow instead of sitting as flat silhouettes; aerial perspective stronger by default (`apScale` 0.4) and
  aerosols concentrated lower (`HM` = 0.28 `HR`): paler horizon band, deeper zenith, far ridges fade.
* **Rain mood**: rain implies a closed deck: `sunDim` = 1 − 1.05·rain − 0.35·storm (shadowless soft light), rain haze
  ×4 but lit by the dark cloud bases (`uFogAmb` × (1 − 0.55·overcast)); rain streaks have per-drop length / width / opacity / speed variation (no diagonal grid) plus a far rain
  sheet (3× volume, fainter) for density into the distance; `&weather=fog|dust` also clear the storm.
* **Moon**: aerosol aureole around the moon disc (soft white halo).

### Round 2 (critic fixes)
* **Clouds read as volumes, not painted blobs**: lighting rebalanced to real cloud albedo — key-light gain per
  type (`sunGain` 3–5.2) vs sky ambient `AMBK` 1.1 (was 1.6, which flattened sunlit vs shadowed sides to ~1:1;
  now ~4:1), column self-shadowing `Tup = 1/(1 + tupK·odUp)` with a deep floor (thick towers / storm decks
  get dark, mottled bases), denser bases (`grad`), multiple-scattering octaves a 0.5 / b 0.35.
* **Silver lining without a blown-out sun**: the forward (HG 0.8/0.9) peak is soft-limited
  (`lum/(1+2.2·lum)`): thin edges next to the sun were ~100× sky radiance and bloomed into a white veil over the
  whole frame (the critic's "overexposed white disc"). The art sky gain applies only partly to the Mie term
  (`uMieGain` = 1 + 0.6·(skyGain−1)): blue sky stays bright, the aureole and backlit haze no longer wash out.
* **Temporal sampling**: the cloud march and the volumetric march get a new IGN pattern every render (incl. the
  TAA sub-frames of a still), so the TAA resolve accumulates them (real time: ~10 frames). High-tier stills march
  the clouds at full resolution (= the converged image; the 2×2 half-res checker from orbit is gone).
* **Orbit**: far-field cloud density = weather-map cells + the 3D noise at two incommensurate, rotated planet
  scales (14 km / 3.8 km) → fractal cloud fields, popcorn cumulus, fibrous cyclone bands; the coverage edge widens
  with distance (translucent fringes, no cut-out chips, no tiling).
* **God rays**: screen-space occlusion source = open sky × cloud transmittance² **+ silver-lined cloud edges**
  (cloud radiance / key-light luminance), three radial passes (1.0 / 0.4 / 0.14), angular falloff so there is
  no full-screen veil, warmer and stronger at golden hour; volumetric pass keeps the physically based shadow
  beams (shadowed in-scatter removed) with a much thinner clear-day haze (was a pink milky veil).
* **Sea of clouds / stratus**: crisper, lumpier deck tops (`topSoft` 0.72, `lump` 0.42, erosion 0.4) → billows
  read under grazing light.
* **Shadows**: PCF radius ×1.9 on the middle cascade (22–130 m at high), ×1.35 beyond (flora request).
* **Nights**: +40 % night ambient on moody (neon-noir) worlds so glow-lit silhouettes read (flora request);
  moon discs (space track) confirmed in frame at W3 (see capture table).
* **Audio hook**: `world.atmosphere.weather.boltDist` (m) / `boltTime` + event `weather:lightning {dist, pos}`.

### Physical model & art direction (the important numbers)
* Scale heights are ~36 % of the atmosphere shell (miniature planets: mountains up to 7 km must stay
  inside the air); density fades to 0 at the top (`uTopFade`), so the limb is a soft glowing shell.
* Vertical Rayleigh optical depth ≈ 1.3 × Earth × density; the Rayleigh spectrum is calibrated so the
  midday zenith has the hue of `art.palette.sky` (alien tints ⇒ physically consistent alien sunsets).
  Dark tints (Blade Runner…) ⇒ "moody": desaturated, smoggy, absorbing aerosols, dimmer sky.
* **Sunset reddening** (`sunsetK = 1.9`): small planets have a short horizon air mass
  (√(πR/2H) ≈ 5 vs Earth's 38); the sun-path transmittance of low suns is raised to a power so the
  light on terrain and clouds goes gold → orange → red like on Earth, without extra haze.
* **Sky gain** (`skyGain = 2.0`): in-scattered light is brightened (sky, aerial perspective, env map,
  CPU ambient all consistent) — game skies are brighter than sunlit ground.
* **Aerial-perspective scale** (UE-style `apScale` 0.4–0.9 by fog/dust/mood; aerosol scale height `HM` = 0.28 `HR`): near the ground geometry
  and clouds see a lighter veil; it relaxes to fully physical from altitude/space.

### Cloud types (`body.clouds.type`)
`cumulus` (puffy, broken, towers where the weather map says tall) · `storm` (thick cumulonimbus with
anvils, dark bases, storm cells, lightning) · `stratus` (low sheets) · `wisp` (high streaky cirrus
stretched along the wind) · `haze` (high thin veil) · `fogsea` (sea of fog at sea level: mountains
poke through — the Friedrich look). Coverage comes from `body.clouds.coverage`, altitude from
`body.clouds.altitude`, storm cells from `body.weather.storms`; rain/storm push to overcast.

### Weather
State from `body.weather` / `art.weather` with a slow deterministic cycle (seeded, driven by world time):
rainy worlds start wet, arctic / Friedrich worlds snow instead of rain, dusty worlds get dust storms.
**URL override for captures:** `&weather=clear|rain|storm|snow|dust|fog|aurora`, and `&lightning=1`
forces a bolt on the captured frame (with `weather=storm`).

## Public API
```js
world.lighting = {
  sun,               // THREE.SunLight (key light: star by day, moon/starlight by night)
  csm,               // RVSunShadow (cascades: splits, mapSize, fade, casterReach)
  envMap,            // PMREM texture of the sky (also scene.environment)
  setupMaterial(mat),// cloud shadows on the key light (+ skip hemi fallback for PBR); auto-applied
                     // to world.root meshes ~1×/s (skip with mesh/material userData.noCSM)
  uniforms: { rvCloudShadowMap, rvCloudShadowMatrix, rvCloudShadowParams, uKeyDir, uKeyColor },
  keyIsMoon, nightFactor, sunColor, skyIrr, groundRad, moon {dir, ill, body},
}
world.atmosphere = {
  model,             // AtmosphereModel: Rb, Rt, height, rayleigh, mieExt, transmittance(r, mu), skyIrradiance(...)
  weather,           // live state { rain, snow, dust, fog, storm, wind, coverBoost, sunDim, flash, aurora }
  clouds,            // Clouds (type, Rc0, Rc1, present) — null if no clouds
  shared,            // uniforms { uSunDir, uSunIll, uNightSky, uMoonDir, uMoonSky, uAirglow, uAurora, uTime }
  atmoUniforms,      // uniforms for the rv_atmo chunk (spread them into your ShaderMaterial to use it;
                     // uOrbitK / uSunKDrop default to 0 = physical if a material declares its own)
}
```
* **Cloud shadows in custom shaders** (grass, water, trees): `#include <rv_cloudshadow>` and add
  `world.lighting.uniforms.rvCloudShadow*` to your uniforms; `float s = rv_cloudShadow(scenePos);`
  (scene-space world position) multiplies your direct sun term. Built-in materials get it automatically.
* **Scattering in custom shaders**: `#include <rv_common>` + `#include <rv_atmo>` with
  `...world.atmosphere.atmoUniforms` gives `atmo_transmittance(r, mu)`, `atmo_sunTransmittance(r, muS)`,
  `atmo_transSegment(p0, p1)` (planet-centred metres).
* G uniforms written every frame: `uSunDir, uSunColor, uSunIntensity, uAmbientSky, uAmbientGround,
  uNight, uWindDir, uWindStrength, uWetness, uSnow`.
* S2 r3: `world.atmosphere.meditating` (0..1, read from `world.player.meditating`); effect uniforms `uLand`,
  `uLandOC` (rain veil colour / share), `uGold` (golden aureole), `uLandMono` (blue-hour land desaturation),
  `uGlowP/uGlowC` (World Tree glow), `uSource` (ring of the source), `uFogGlow` (dust-wall sun glow).
* `__rv.state().atmosphere` → `{ sunElev, key, night, env, shadows, clouds, weather{…}, wet, snowCover, twilight,
  eclipse, rainbow, shafts{fan, gate, cover, …} }`; `world.atmosphere.twilight` (0..1 blue-hour dome),
  `.eclipse` (0..1), `.weather.rainbow` (0..1).

## Best capture views (`/?mode=system&galaxy=0&…`)
Finals of this round (1280×720) are listed first; all are plain URLs (steps only where noted).

| view | URL / steps |
|---|---|
| **Sunrise behind the volcano** (S2 r3, Yotei): the sun bursts from behind W1's great mountain, god rays fanning over a sea of cloud, golden aureole, the cone fading into haze | `star=6&planet=1&view=fly&alt=800&lat=17.777&lon=-2.5&yaw=87&pitch=6&tod=0.272&disable=fauna,vehicles` |
| **Golden-hour fan** (S2 r3): shafts from the sun behind the ridge, each ridge one step paler (W2) | `star=11&planet=0&view=fly&alt=800&tod=0.74&pitch=6&yaw=270&cover=0.8` |
| **Blue hour** (S2 r3): the sky keeps its colour, the land has none (W2) | `star=11&planet=0&view=fly&alt=300&tod=0.77&pitch=8&yaw=262` |
| **World Tree lights the mist** (S2 r3, W1 night) | `star=6&planet=1&view=fly&alt=110&lat=13.978&lon=26.62&yaw=271&pitch=7&tod=0.02&disable=fauna,vehicles` |
| **Above the weather** (S2 r3, no stripes): cumulus bank, sea of cloud, peaks through (W2) | `star=11&planet=0&view=fly&alt=3500&tod=0.6&pitch=2&yaw=200&cover=0.9` |
| **Aurora + ringed neighbour** (S2 r3): thin green curtains, starry night (W2) | `star=11&planet=0&view=fly&alt=200&tod=0.95&pitch=22&yaw=270&weather=aurora` |
| Rain veil (S2 r3, W2) | `star=11&planet=0&view=fly&alt=300&tod=0.4&pitch=4&yaw=262&weather=rain` |
| **Blue hour** (S2 r2): sky keeps its colour, afterglow clouds, land in silhouette (W2) | `star=11&planet=0&view=fly&alt=300&tod=0.77&pitch=8&yaw=262` |
| **Rainbow after rain** (S2 r2): double bow over the sea, soft violet sky (W2) | `star=11&planet=0&view=fly&alt=300&tod=0.31&pitch=8&yaw=275&weather=rainbow` |
| **Golden-hour fan** (S2 r2): shafts fanning up from the sun behind the ridge through broken cumulus (W2) | `star=11&planet=0&view=fly&alt=800&tod=0.74&pitch=6&yaw=270&cover=0.8` |
| **Orbit** (S2 r2): thin limb line, milky cloud veils, soft warm terminator, cyclone (W2) | `star=11&planet=0&view=orbit&tod=0.4` |
| **Night** (S2 r2): indigo starry sky, moonlit wisps, readable ground (W3) | `star=9&planet=2&view=fly&alt=600&tod=0.02&pitch=8&yaw=283` |
| **Dust storm** (S2 r2): one-colour wall, spires stepping into the haze (W3) | `star=9&planet=2&view=fly&alt=200&tod=0.4&pitch=4&yaw=200&weather=dust` |
| Snow as fog (W12) | `star=9&planet=5&view=fly&alt=200&tod=0.45&pitch=6&weather=snow` |
| **BotW cumulus sky** (W2 noon-ish): lumpy cumulus clusters + high cloud | `star=11&planet=0&view=fly&alt=800&tod=0.4&pitch=8` |
| **Golden hour**, warm streaks fanning from behind the ridge (W2) | `star=11&planet=0&view=fly&alt=800&tod=0.74&pitch=6&yaw=270` |
| **Morning sun through broken cumulus** (W2, god rays / shadow beams) | `star=11&planet=0&view=fly&alt=800&tod=0.28&pitch=8&yaw=100&cover=0.7` |
| **Storm over the neon city**: dark scud cells, rain, branched lightning (W4) | `star=2&planet=0&view=fly&alt=300&tod=0.45&pitch=6&lightning=1` |
| **Sea of clouds** toward the low sun: billowed deck, gaps to the sea, layered high cloud lit around the sun (W7) | `star=3&planet=2&view=fly&alt=3000&tod=0.28&yaw=118&pitch=-2` |
| **Moonrise night**: moon disc, moonlit wisps, deep-blue starry sky (W3 Arzach) | `star=9&planet=2&view=fly&alt=600&tod=0.02&pitch=8&yaw=283` |
| **Planet from orbit**: cyclone, frayed cloud fields casting shadows on the ocean, sunset-lit terminator clouds (W2) | `star=11&planet=0&view=orbit&tod=0.4` |
| **Terminator from orbit**: orange cloud band, dark night side with city / rural lights, airglow ring (W1) | `star=6&planet=1&view=orbit&tod=0.22` |
| **Rain in the forest** (W4 surface, overcast, varied streaks, far rain sheet) | `star=2&planet=0&view=surface&tod=0.45&lightning=1&props=0` steps `[{"look":[0,22]},{"advance":0.5}]` |
| Overcast stratus deck, sun a dim disc through it (W2) | `star=11&planet=0&view=fly&alt=500&tod=0.3&pitch=12&yaw=108&cover=0.75&clouds=stratus` |
| Rain storm in the forest (W4, surface; framing depends on the player spawn) | `star=2&planet=0&view=surface&tod=0.45&lightning=1` steps `[{"look":[0,22]},{"advance":0.5}]` |
| Night over the archipelago (W2, moonless) | `star=11&planet=0&view=fly&alt=800&tod=0.02&pitch=12` |
| Aurora curtains + stars (W8) | `star=2&planet=1&view=fly&alt=800&tod=0.02&pitch=12&weather=aurora` |
| Moonlit overcast (W7, moon behind the deck → corona) | `star=3&planet=2&view=fly&alt=600&tod=0.02&pitch=35&yaw=267` |
| Lava moon at dusk (glowing haze, clear air over lava) | `star=7&planet=4.0&view=fly&alt=300&tod=0.78&pitch=-4` |
| Snow (W12 arctic) | `star=9&planet=5&view=surface&tod=0.45&weather=snow` steps `[{"look":[0,10]},{"advance":0.5}]` |
| Low tier clouds | add `&q=low` |

Framing tips: `__rv.state().atmosphere` reports `sunAz` / `sunElev` and `moon {az, elev}` — pass them as
`yaw` / `pitch` to face the sun or the moon.

**Art / capture overrides:** `&weather=clear|rain|storm|snow|dust|fog|aurora|rainbow`, `&fan=0..2` (landscape god-ray fan strength),
`&veil=0..0.1` (orbit cloud veils, default 0.015), `&atmoDebug=6` (fan buffer), `&lightning=1` (forced bolt on
the captured frame), `&clouds=cumulus|storm|stratus|wisp|haze|fogsea|none`, `&cover=0..1` (cloud coverage), `&cirrus=0..1` (high cloud layer opacity).
Debug: `&atmoDebug=5` shows the volumetric-light terms (R: added light, G: shadowed/removed light, B: 1 − T);
`&shafts=0` disables the volumetric-light pass (A/B); `&clscale=0.25..1` overrides the cloud march resolution.
`__rv.state().atmosphere` now also reports `moon {name, ill, elev, az}`, `sunAz` (compass, = `yaw` to face
it) and `overcast`.

## Performance
* S2 r3 costs: landscape haze = 6 cheap exp samples + 3 LUT fetches per geometry pixel (atmosphere pass), 5
  samples per cloud pixel for the far-cloud fade; World Tree glow = one atan pair per pixel only at dusk / night
  on worlds with a tree; blue-hour mono = a few ALU; the light-march jitter and the explicit weather LOD are free;
  the still-only 4×4 cloud denoise runs only in `shot=1` at full res.
* high: atmosphere pass (≤ 10–20 samples/pixel, full res) + clouds (half res, ≤ 56 steps (84 in shot mode),
  5 light steps + 2 column samples, early exit, distance LOD skips the detail fetches far away) +
  volumetric light (quarter res, 36 steps: 14 near with the sun cascades, 22 far with the cloud shadow map)
  + streaks (quarter res, 3 radial blurs × 24 taps) + weather (6k instanced quads, one draw) + sky-view LUT (192×108) per
  frame; transmittance/MS LUTs, 3D noise (64³) and weather cube (384² × 6) built once; env map PMREM only
  when the sun / altitude / cloud cover change; cloud shadow map every 3rd frame.
* Stills (`shot=1`, high/ultra) march the clouds at full res (4 TAA sub-frames cannot converge a half-res
  jitter); real time stays half res. Far-field orbit detail costs 2 extra 3D-noise fetches per sample only where
  the distance LOD is active (detail fetches are skipped there).
* Tiers: low = no shadows, 2D cloud slab, no volumetric light, 1.4k particles; med = 2 cascades, 36 steps,
  1 column sample and no second detail octave (`CL_HQ` off), 22 volumetric steps; ultra = 4 cascades, 80 steps, 96³ noise, 48 volumetric steps. Zero per-frame
  allocations in hot paths.

* Round 3 costs: high cloud layer = 3 noise fetches + 1 weather fetch per cloud pixel (0 on low); domain warp +1
  fetch per density evaluation; city glow loops 12 sites only on ground pixels seen from > 2.5 km and on night-sky
  pixels near towns; the far rain sheet is one extra instanced draw while it rains.

## Known issues
* S2 r3: in rain (W2 `weather=rain`) the near hill still sits under a flat, light-grey film (overcast light plus
  the rain pass); the far ridges step paler as intended, but the creator's rain frame keeps the nearest ridge
  darker and bluer. The source of the near film was not isolated this round (not the far rain sheet, not the
  volumetric pass, not the clouds).
* S2 r3: on moonless nights (W1 `tod=0.02`) thick cumulus still reads as dark navy smoke against the starry sky
  (the brown sodium cast is gone: the city tint is now limited to neon-noir worlds, and the night-sky ambient on
  clouds was raised ×2.2); dense cores need a stronger multiple-scattering floor at night to sit in the sky.
* S2 r3: the golden aureole and the land haze use the sky colour, but far clouds fade into the plain sky LUT
  (no golden aureole on the far cloud fade).
* S2 r3: the sunrise frame's white puffs at the summit are the terrain track's mountain clouds; the radial
  streak above the sun (screen-space streaks) reads a little like a lens star.
* S2 r2: the landscape fan is screen-space: it needs the sun within ~a screen of the frame and cloud gaps in
  view; a sun far behind the camera gives no anti-crepuscular fan (the 3D volumetric pass still does). Over a
  clear sky a faint angular modulation (±9 %) remains.
* S2 r2: the blue-hour hold-back of the land's ambient is camera-local (sun elevation at the camera); custom
  shaders that light themselves from `G.uAmbientSky` follow it, emissive surfaces (windows, glow flora) do not
  (intended: warm windows against a dark land).
* S2 r2: the limb line sits above the cloud tops (not at the surface) so clouds cannot cut it; on worlds with a
  very tall relief it is clamped to 0.62 atmosphere heights.
* S2 r2: the rainbow is drawn over everything farther than ~600 m (sky, far land, clouds) and is not occluded
  by a cloud that is nearer than the shower.
* S2 r2: at night thin moonlit cirrus is still the brightest thing in the sky on W3; thick cumulus over W4's
  city at night reads as dark smoke with a dithered half-res edge (lifted a little by the starlit sky and city
  glow on the bases).
* Round 4: from inside the cumulus layer at altitude (W2 `fly&alt=3000`) a faint pale band sits a few degrees above
  the sea horizon where view rays stop leaving the layer through its base (the deck's own horizon, averaged
  distant cloud); physically plausible but slightly too regular.
* Round 4: orbit cloud streaks are high-contrast white over the ocean; thin, grey translucent veils between
  fields are still rarer than on Earth photos. The view-only orbit compression of the shell happens between
  1.2 and 3.2 atmosphere heights (the limb visibly thins while climbing out).
* Round 3b: cumulus seen straight from below still shows a fairly uniform grey base (physically right; BotW
  paints them brighter); a few small cloudlets remain around the big clouds (now puffs, not 1–2 px specks).
* Orbit cloud shadows are a 3-sample march (soft, slightly blobby under thin fields); they skip the night side.
* Round 3: the high cloud layer is 2D (no parallax inside it, no self-shadowing); from orbit it fades out.
* Night-side city glow uses the civ settlement list (12 brightest sites) + procedural rural speckle over land; it
  does not follow real road networks. Near the ground (< 2.5 km) only civ's own lights show.
* From orbit the sky ambient (environment map) fades to 10 %: a single probe cannot light a whole disc; shadowed
  day-side terrain from orbit is therefore lit by the star + the atmosphere pass only.
* The domain warp adds one 3D-noise fetch per cloud density evaluation (≈ +25 % cloud march cost).
* Real time: clouds are half res, jittered per frame and converged by the post TAA (no dedicated cloud history
  buffer yet); very fast camera motion can show a little grain on thin edges for a few frames.
* Volumetric light is quarter res: very thin occluders (a single trunk) give soft shafts; the cloud shadow
  map covers ~26 km × size around the camera, so shafts fade beyond it.
* Inside the cloud layer the shaft visibility uses the sun-ward fraction of the column (approximation).
* Crepuscular rays need broken clouds or a ridge near the sun; on clear-sky worlds only the (correct) Mie
  aureole shows — use `&cover=` to stage them. Under a fully overcast deck there are (correctly) no rays.
* The W4 surface storm framing depends on the player spawn (currently next to a parked ship); the storm-sea
  fly view is the reliable storm showcase.
* Lightning bolts are camera-facing ribbons (no volumetric glow halo; the cloud flash provides that).

## Requests
* **space** (S2 r3, still open, from the critic): the galactic band reads as a marbled grey-beige streak with dark
  blotches (W2 `tod=0.95&weather=aurora`); the creator's frames paint warm dust (core ≈ (1, .75, .5) fading to
  blue-grey) with fine star grain and darker dust lanes. The sun disc is still tiny at sunrise (see round 3b).
* **water** (S2 r3): from orbit (W2 `view=orbit&tod=0.4`) a white starburst / flower-shaped glint sits in the
  ocean near the sub-solar point; the sea at blue hour still shows regular bright stripes (W2 `tod=0.77`).
* **terrain** (S2 r3): in the sunrise view (W1 `lon=-2.5`, `tod=0.272`) the small white summit puffs of the
  mountain clouds read as sprites against the backlit cone; at a low sun behind the mountain they should be dark
  with a bright rim (backlit), or thin streaks.
* **post** (S2 r3): the blue-hour land is now desaturated in the atmosphere pass itself (`uLandMono`); the
  Purkinje part of the earlier request is done here. A lower exposure key at twilight is still welcome.
* **space** (S2 r2): the galactic band is now allowed through at night (`uStarVis` drops to 0.45) but it is still
  too faint to read in W2 / W3 night and late-dusk frames; the creator's frames paint it as warm dust with fine
  star grain — a brighter, warmer band. (`space.eclipse` is now read directly; thanks.)
* **post** (S2 r2): blue hour now keeps the sky bright and the land dark; please keep auto-exposure from lifting
  the silhouette back (meter weighted toward the sky, or a lower key when `world.atmosphere.twilight` > 0.5),
  and a touch of Purkinje desaturation on the land at late dusk (W3 `tod=0.79` mesas still read warm brown).
* **water** (S2 r2): the sea at blue hour shows bright, regular horizontal stripes (W2 `tod=0.77`); a calmer,
  sky-coloured reflection would double the twilight sky (rule 11: still water doubles the sky).
* **terrain** (still open): angular lit facets of the coarse orbit LOD near the terminator; the atmosphere now
  fades lit ground past the terminator (`smoothstep(-0.07, 0.16, μ)`), which hides most of them.

### Done (inbox, S2 r3)
* flora: the World Tree lights the haze around it at dusk and night (`landmarkGlow`).
* player: meditation lets the sky answer (stars, the ring of the source, the wind stills) and warms the key
  light (round 2 request, W9 dusk).
* post: no saturated green ring on the night side from orbit (limb hairline ≈ 1 % of the day limb, tinted from
  the world's sky).
* terrain: warmer, lower key light at sunrise (golden key + golden aureole); the W1 sunrise view is listed above.

### Done (inbox, S2 r2)
* space → atmosphere: eclipses (`space.eclipse` or `sunVisibility`) dim the sunlight and turn the sky into a
  twilight dome ringed by last light.
* flora (fix r2): teal low mist glowing at night around bioluminescent forests (W4); stronger aerial perspective
  was already in place (`apScale` 0.5).
* **post** (round 4): under rain / storm decks the atmosphere now drops the ambient (`world.lighting.deckDim`,
  `G.uSunIntensity`, `world.atmosphere.weather.overcast`); auto-exposure (strength 0.7) gives most of it back.
  A lower exposure key under overcast / storm (e.g. `key × (1 − 0.35·overcast·storm)`) would keep the storm mood.
* **space** (round 4, from the critic): the night moon reads as a flat disc — a phase-shaded sphere (terminator,
  a few maria / craters) would sit better in the moonlit sky the atmosphere draws around it (aureole + moonlit
  Rayleigh sky are already there).
* **terrain** (round 4): from orbit, at a grazing sun, the coarse orbit-LOD mountains near the terminator show
  as angular white facets (W1 `view=orbit&tod=0.22`); smoother normals / lower relief exaggeration at the
  coarsest LODs would remove the "cut-out" look the critic attributes to clouds.
* **water** (round 4): W2 `view=orbit&tod=0.4` shows a hatched / grid pattern in the ocean sun glint.
* **space** (round 3b): the star disc is tiny from the ground (`state.space.sunAng` 0.2–0.46°, i.e. 2–5 px at
  960×540), so no sun disc reads in sunrise / sea-of-clouds frames; a minimum apparent diameter of ~0.5° (or a
  brighter, slightly larger core sprite when the true disc is < 0.4°) would give the critic the "visible sun
  disc" the references have. The atmosphere already attenuates and reddens whatever the space track draws.
* **civ** (round 3b, still open): the two brown out-of-focus discs left/right of W1 in `view=orbit&tod=0.22`.
* **civ** (round 3): in `star=6&planet=1&view=orbit&tod=0.22` two large brown out-of-focus discs float in space left
  and right of the planet only when civ is loaded (orbit light network points?); please check their far fade.
* **terrain / flora** (round 3): golden-hour rim light — a wrap / sun-facing Fresnel term on grass and foliage
  (`G.uSunDir`, `G.uSunColor`) would make backlit meadows glow like Pacific Drive; the atmosphere now supplies the
  warm forward-scattering haze.
* **post**: the atmosphere writes physically based HDR (sun ≈ 6, sky ≈ 0.3–1.2, moonless night sky
  ≈ 0.005–0.02): keep auto-exposure's night drop moderate so the deep-blue night gradient stays visible;
  lens rain droplets during storms look good — consider keying them to `G.uWetness` *and* camera altitude
  below the cloud base (`world.atmosphere.clouds.Rc0`).
* **space**: moons / the parent gas giant are the night key light (`world.lighting.moon`); their discs come
  from the space track — when a moon is up at night please make sure it is drawn (the atmosphere adds the
  moonlit sky glow around it).
* **water / flora / civ**: include `rv_cloudshadow` in custom shaders (see API) and read `G.uWetness`
  (dark, glossy wet surfaces, puddles) and `G.uSnow` (snow cover on up-facing surfaces).
* **terrain**: cloud shadows now use strength 0.72; very dark shadowed slopes at low sun suggest the terrain
  shader under-weights `scene.environment` (sky ambient) relative to the direct sun.

* **vehicles / player** (round 2): at W4 `view=surface&tod=0.45` the camera spawns ~2 m from the parked ship,
  which fills a third of the frame and hides the storm sky; honour `props=0` or park props ≥ 15 m from the spawn.
* **post** (round 2): the atmosphere now soft-limits cloud silver linings (no more ~100× radiance edges); if the
  bloom still spreads a veil from the sun disc under broken clouds, a slightly higher bloom threshold for
  far-plane (sky) pixels would keep backlit terrain contrasty.
* **terrain / lead** (re: CRITICAL airless-body request): reproduced M1
  (`star=0&planet=2.0&view=fp&lat=-25.555&lon=-70.154&tod=0.5`) — the terrain is black **identically with
  and without** the atmosphere (`&disable=atmosphere`), and with `only=terrain,player` too in current code.
  On airless bodies the atmosphere pass is a strict pass-through (`uHasAtmo = 0`), no LUTs/clouds/shafts
  are created, and the key light is valid (white sun, env map present — checked in-page). Please look at
  the terrain material path for barren bodies (or the camera spawn inside terrain).

### Done (inbox, round 3b)
* terrain: bounce / earthshine ambient on airless moons (`uShine` in the environment map: the lit parent planet
  or brightest moon + a starlight floor).
* civ (3): the round-1 hard-edged moon/sun rectangle at dusk — the moon now gets a soft aerosol aureole (radial
  falloff) from the atmosphere; the disc itself is drawn by the space track (no rectangle seen in W1 / W3 night
  captures of this round).

### Done (inbox, round 3)
* vehicles: rain streaks have per-drop spacing / length / width / opacity / speed variation and fade with distance,
  plus a far rain sheet; `&weather=fog` and `&weather=dust` zero the storm (and rain).
* vehicles: W4 deck from low orbit has soft translucent fields, cells and gaps; city glow shows through the gaps at night.
* terrain / water: clouds fade softly within ~260 m of terrain (no cut-outs against fjord walls) and toward the end
  of the march range (no hard edge / rectangle near the horizon).
* civ (2): storm/rain haze is darker and thinner (lit by the cloud bases): no white-out of valleys; (1) night ambient
  differences between W1/W7 and W4 come from their moons (W4 has none up): kept by design.

### Done (inbox, round 2)
* audio: `weather.boltDist` / `boltTime` + `weather:lightning` event.
* flora: softer PCF on the middle cascades; stronger night ambient on moody worlds (W4).

### Done (inbox, round 1)
* vehicles/space: no rain/snow streaks above the cloud deck or outside the atmosphere.
* water: deep-blue oceans from orbit (thinner veil from altitude), lava worlds get clearer low air and a
  glowing lava-lit haze; `lighting.skyCube` exposes the raw planet-local sky cube (same as `cubeRT.texture`).
* space: gas giants get no cumulus shell (`clouds.present = false` for gas bodies); daytime star hiding
  applies only to the far-plane background (planets / rings with depth are untouched).
* post: brighter clear-day sky dome (`uSkyViewGain` ≈ 1.28 from the ground, relaxes with altitude).
