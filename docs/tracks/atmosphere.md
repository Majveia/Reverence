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
| `effect.js` | pipeline effect **`atmosphere` (order 100)**: sky from the ground (LUT) → seamless per-pixel march from altitude/space; aerial perspective on all geometry; background (stars / sun / planets of the space track) × transmittance with daytime star suppression; night sky (starlight, moonlit sky, airglow layer with limb brightening); aurora curtains; analytic height-fog banks (weather); fallback sun disk + star field + galactic band **only when no `space` subsystem exists** |
| `clouds.js` | pipeline effect **`clouds` (order 110)**: volumetric cloud shell (same march from ground, altitude and orbit), GPU-generated tileable Perlin-Worley 3D noise, planet-wide weather cube map (coverage / tallness / storm cells) drifting with the wind, per-type shaping, Beer-powder + dual-lobe HG + silver lining + 4-octave multiple scattering, sun light × atmospheric transmittance per sample (gold/pink clouds at sunset, planet shadow after dusk), overcast/storm base darkening, lightning flash, aerial fade into the sky; half-res + depth-aware upsample; **cloud shadow map** projected along the key light; `q=low` → cheap 2-sample slab |
| `lightshafts.js` | pipeline effect **`volumetric-light` (order 120)**: crepuscular rays / god rays (quarter-res mask of unoccluded sky × cloud transmittance, two radial blur passes), scaled by world haze, low sun and weather |
| `weather.js` | weather state machine + pipeline effect **`weather` (order 125)**: rain streaks, snow flakes, dust motes (camera-local volume wrapped in the vertex shader, soft depth test), lightning bolt + cloud flash + environment flash; drives `uWetness`, `uSnow`, `uWindStrength` |
| `lighting.js` | `SunLight` key light with custom N-cascade shadows (`RVSunShadow`: 2–4 cascades in one atlas, texel snapping, per-cascade normal bias), moon as key light at night (phase-aware), PMREM environment of the sky (+ smooth cloud deck) on `scene.environment`, hemisphere fallback, material auto-setup (cloud shadows on the key light) |
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
| Golden-hour sunset through clouds (W2) | `star=11&planet=0&view=fly&alt=800&tod=0.74&pitch=6&yaw=270` |
| Morning, sun behind clouds (W1) | `star=6&planet=1&view=fly&alt=800&tod=0.3&pitch=2&yaw=90` |
| Aerial perspective, mountains in haze at sunset (W1) | `star=6&planet=1&view=fly&alt=800&tod=0.74&pitch=2&yaw=270` |
| Blade Runner rain storm (W4) | `star=2&planet=0&view=surface&tod=0.45` steps `[{"look":[0,8]},{"advance":0.5}]` |
| Storm + lightning (W1) | `star=6&planet=1&view=fly&alt=800&tod=0.45&pitch=4&weather=storm&lightning=1` |
| Planet from orbit: limb, terminator, cloud shell | `star=11&planet=0&view=orbit&tod=0.4` |
| Low tier clouds | add `&q=low` |

## Performance
* high: atmosphere pass (≤ 10–20 samples/pixel, full res) + clouds (half res, ≤ 56 steps, 5 light
  steps, early exit) + rays (quarter res) + weather (6k instanced quads, one draw) + LUT sky-view
  (192×108) per frame; transmittance/MS LUTs, 3D noise (64³) and weather cube built once; env map
  PMREM only when the sun moves / altitude changes; cloud shadow map every 3rd frame.
* Measured in SwiftShader (960×540, system-surface check view): the whole atmosphere track ≈ 1.6 s
  of a ≈ 17 s frame (~10 %); the rest is scene + MSAA + post.
* Tiers: low = no shadows, 2D cloud slab, no god rays, 1.4k particles; med = 2 cascades, 36 steps;
  ultra = 4 cascades, 80 steps, 96³ noise. Zero per-frame allocations in hot paths.

## Known issues
* `tools/check.mjs` `system-surface` fails on Playwright's fixed 30 s screenshot timeout in
  SwiftShader (the frame takes ~17 s; the baseline before this track's changes timed out too).
* No temporal reprojection yet for clouds (half-res + spatial jitter + depth-aware 9-tap upsample);
  a little grain is visible in thin cloud edges.
* Clouds from orbit still read a bit "cellular"; large swirling systems / fronts are future work.
* Fallback star field is a stand-in until the space track renders stars (it switches itself off when
  `world.get('space')` exists).
* The orbit view camera currently never rotates (player track stub), so orbit framing is fixed.

## Requests
* **core / tools**: `tools/shoot.mjs` uses Playwright's default 30 s `page.screenshot` timeout; with
  SwiftShader frames of 15–20 s (under load) captures of terrain-heavy views fail. Please pass
  `timeout: 180000` to `page.screenshot` (a private copy with that change works reliably).
* **post**: MSAA on the HDR scene target roughly doubles the SwiftShader frame; consider `samples: 0`
  in shot mode, or TAA. The atmosphere writes physically based HDR (sun ≈ 6, sky ≈ 0.3–1.0): auto
  exposure keyed to `G.uSunIntensity` + `G.uAmbientSky` would help nights and storms.
* **space**: please render stars / sun disk / planets into the background (depth = far) — the
  atmosphere pass multiplies them by the view transmittance and hides faint stars by day. Once
  `world.get('space')` exists the fallback sun/stars are disabled automatically.
* **water / flora / civ**: include `rv_cloudshadow` in custom shaders (see API) and read `G.uWetness`
  (dark, glossy wet surfaces, puddles) and `G.uSnow` (snow cover on up-facing surfaces).
* **player**: orbit view camera should look at the planet (currently identity rotation).
