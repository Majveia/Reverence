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
* **Aerial-perspective scale** (UE-style `apScale` 0.32–0.9 by fog/dust/mood): near the ground geometry
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
  atmoUniforms,      // uniforms for the rv_atmo chunk (spread them into your ShaderMaterial to use it)
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
* `__rv.state().atmosphere` → `{ sunElev, key, night, env, shadows, clouds, weather{…}, wet, snowCover }`.

## Best capture views (`/?mode=system&galaxy=0&…`)
| view | URL / steps |
|---|---|
| BotW cumulus sky (W2) | `star=11&planet=0&view=fly&alt=800&tod=0.4&pitch=8` |
| Golden-hour sunset, sunbeams fanning from behind the ridge (W2) | `star=11&planet=0&view=fly&alt=800&tod=0.74&pitch=6&yaw=270` |
| Crepuscular rays under a broken deck, morning (W1) | `star=6&planet=1&view=fly&alt=800&tod=0.28&pitch=6&yaw=90&cover=0.8` |
| Storm over the sea: dark cells, rain, branched lightning (W4) | `star=2&planet=0&view=fly&alt=300&tod=0.45&pitch=6` |
| Blade Runner rain storm in the forest (W4) | `star=2&planet=0&view=surface&tod=0.45` steps `[{"look":[0,8]},{"advance":0.5}]` |
| Sea of clouds, peaks piercing the deck (W7 Solaris) | `star=3&planet=2&view=fly&alt=3000&tod=0.3&yaw=90` |
| Night: deep-blue starry sky, horizon glow (W9) | `star=2&planet=2.1&view=fly&alt=600&tod=0.02&pitch=12` |
| Night over the archipelago (W2) | `star=11&planet=0&view=fly&alt=800&tod=0.02&pitch=12` |
| Aurora curtains + stars (W8) | `star=2&planet=1&view=fly&alt=800&tod=0.02&pitch=12&weather=aurora` |
| Terminator from orbit: orange band, reddened sun at the limb, airglow ring (W1) | `star=6&planet=1&view=orbit&tod=0.22` |
| Planet from orbit: cyclone, cumulus fields, deep oceans (W2) | `star=11&planet=0&view=orbit&tod=0.4` |
| Lava moon at dusk (glowing haze, clear air over lava) | `star=7&planet=4.0&view=fly&alt=300&tod=0.78&pitch=-4` |
| Snow (W12 arctic) | `star=9&planet=5&view=surface&tod=0.45&weather=snow` steps `[{"look":[0,10]},{"advance":0.5}]` |
| Low tier clouds | add `&q=low` |

**Art / capture overrides:** `&weather=clear|rain|storm|snow|dust|fog|aurora`, `&lightning=1` (forced bolt on
the captured frame), `&clouds=cumulus|storm|stratus|wisp|haze|fogsea|none`, `&cover=0..1` (cloud coverage).
Debug: `&atmoDebug=5` shows the volumetric-light terms (R: added light, G: shadowed/removed light, B: 1 − T).
`__rv.state().atmosphere` now also reports `moon {name, ill, elev, az}`, `sunAz` (compass, = `yaw` to face
it) and `overcast`.

## Performance
* high: atmosphere pass (≤ 10–20 samples/pixel, full res) + clouds (half res, ≤ 56 steps (84 in shot mode),
  5 light steps + 2 column samples, early exit, distance LOD skips the detail fetches far away) +
  volumetric light (quarter res, 36 steps: 14 near with the sun cascades, 22 far with the cloud shadow map)
  + streaks (quarter res, 2 blurs) + weather (6k instanced quads, one draw) + sky-view LUT (192×108) per
  frame; transmittance/MS LUTs, 3D noise (64³) and weather cube (384² × 6) built once; env map PMREM only
  when the sun / altitude / cloud cover change; cloud shadow map every 3rd frame.
* Tiers: low = no shadows, 2D cloud slab, no volumetric light, 1.4k particles; med = 2 cascades, 36 steps,
  1 column sample and no second detail octave (`CL_HQ` off), 22 volumetric steps; ultra = 4 cascades, 80 steps, 96³ noise, 48 volumetric steps. Zero per-frame
  allocations in hot paths.

## Known issues
* No temporal reprojection for clouds yet (half-res + spatial jitter + depth-aware upsample): thin cloud
  edges show a little grain in stills.
* Volumetric light is quarter res: very thin occluders (a single trunk) give soft shafts; the cloud shadow
  map covers ~26 km × size around the camera, so shafts fade beyond it.
* Inside the cloud layer the shaft visibility uses the sun-ward fraction of the column (approximation).
* Crepuscular rays need broken clouds or a ridge near the sun; on clear-sky worlds only the (correct) Mie
  aureole shows — use `&cover=` to stage them.
* Lightning bolts are camera-facing ribbons (no volumetric glow halo; the cloud flash provides that).

## Requests
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

* **terrain / lead** (re: CRITICAL airless-body request): reproduced M1
  (`star=0&planet=2.0&view=fp&lat=-25.555&lon=-70.154&tod=0.5`) — the terrain is black **identically with
  and without** the atmosphere (`&disable=atmosphere`), and with `only=terrain,player` too in current code.
  On airless bodies the atmosphere pass is a strict pass-through (`uHasAtmo = 0`), no LUTs/clouds/shafts
  are created, and the key light is valid (white sun, env map present — checked in-page). Please look at
  the terrain material path for barren bodies (or the camera spawn inside terrain).

### Done this round (inbox)
* vehicles/space: no rain/snow streaks above the cloud deck or outside the atmosphere.
* water: deep-blue oceans from orbit (thinner veil from altitude), lava worlds get clearer low air and a
  glowing lava-lit haze; `lighting.skyCube` exposes the raw planet-local sky cube (same as `cubeRT.texture`).
* space: gas giants get no cumulus shell (`clouds.present = false` for gas bodies); daytime star hiding
  applies only to the far-plane background (planets / rings with depth are untouched).
* post: brighter clear-day sky dome (`uSkyViewGain` ≈ 1.28 from the ground, relaxes with altitude).
