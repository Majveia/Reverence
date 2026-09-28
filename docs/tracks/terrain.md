# Terrain track — planet surface generation & terrain rendering

Owner paths: `src/world/planet/**`, `src/world/terrain/**`.

## What was built

### PlanetSurface / SurfaceGen (CPU source of truth — `src/world/planet/`)
* `SurfaceGen.js` — THREE-free, worker-safe, deterministic landform generator (float64 JS, simplex
  noise with analytic derivatives from `noise.js`). Every layer is LOD-aware (`evaluate(x,y,z,lod,info)`
  skips/fades octaves finer than `lod` metres) so terrain workers can build far chunks cheaply and
  physics gets the exact full-detail surface.
  Landform stack: domain-warped continents with calibrated ocean fraction → coastal shelves, beaches,
  cliff coasts → mountain ranges (warped eroded ridged multifractal + slope-aligned gully erosion filter
  = dendritic valleys, glacial U-valleys on cold ranges) → crags (rock-only 720 m / 360 m octaves) →
  rolling hills (derivative-damped fbm) → plateaus & mesas (caprock / cliff / talus profile) →
  meandering terraced canyons → terraces → karst towers, spires, kopjes, sea stacks, atolls → dunes
  (asymmetric transverse + secondary) → craters (5 size classes, central peaks, ejecta) → volcanoes
  with calderas → river valleys (sea-level channels in lowlands, dry valleys in highlands) + lakes,
  fjords → sinkholes, lunar rilles → BotW-style rock outcrops → fractal detail down to ~0.2 m.
  Per-world style = `body.type` + `body.terrain.features` + art preset (`body.art.key`, e.g. Bierstadt
  = taller glaciated ranges, Moebius = mesas + spires, Roger Dean = sea stacks + arches…).
* Landform fixes this round: ridge-crest needle walls (derivative damping now follows the smooth
  noise slope), chaotic gully branching (slope-clamped stripes, branch scaled by base slope,
  regularized kernel), near-vertical heightfield walls on mesas/karst/sea stacks (70–80° max,
  vertical walls shaded as stripes), sea stacks restricted to the shoreline, narrower beach band.
* `PlanetSurface.js` — extends SurfaceGen with THREE helpers. **API (stable):**
  * `height(x,y,z)` metres relative to `radius` at unit direction (full detail).
  * `heightLod(x,y,z,lod)` cheaper height without octaves finer than `lod` metres (far queries).
  * `sample(x,y,z,out)` → `{height, biome, moisture, temperature, slope, rock, sand, snow, cliff,
    river, lake, mountain, continental, dune}` (slope 0 flat … 1 vertical).
  * `normal(dir, out, eps)` geometric normal (unit), `seaLevel` (0 or -Infinity), `maxHeight`,
    `minHeight`, `amp`, `biomeColor(biome, out)`, `BIOMES` (also exported), `BIOME_NAMES`.
  * `surfaceConfig(body)` → structured-cloneable config (what workers receive).
  * Cost: ~8–13 µs per full `height()`; ~3–6 µs with `heightLod(…, 500)`.

### Terrain renderer (`src/world/terrain/`)
* `index.js` — quadtree cube-sphere **CDLOD**: 6 tangent-warped faces, 65×65-vertex chunks, down to
  ~0.35 m vertex spacing (high). Selection by distance to each node's bounding sphere with range
  `D = K·side`, K derived from a screen-space error target (px per quad by tier; fixed per world).
  Progressive refinement (only built nodes split), coarse-first scheduling, in-view first,
  horizon culling (+ mountain margin), three frustum culling, LRU disposal, time-sliced uploads.
* `terrain.worker.js` + `chunkBuild.js` — a pool of module Web Workers (2 on mobile, up to 4) imports
  the same `SurfaceGen`; each chunk gets positions, **geomorph targets** (parent-level surface with the
  same triangle diagonals + parent normals), normals, material hints (rock/cliff, sand, temperature,
  moisture, wetness, glacier, curvature, mountain) and a closed skirt ring. One shared index buffer.
  Main-thread fallback if workers are unavailable.
* `material.js` — `MeshStandardMaterial` + `onBeforeCompile` (keeps three PBR, CSM shadows, fog, IBL and
  the atmosphere track's cloud-shadow patch). Vertex: CDLOD morph (position + normal) driven by the
  main camera (`G.uCameraPos`) so the **shadow depth material morphs identically** (fixes the
  dark shadow streaks). Fragment: biome blending from hints + slope + altitude + macro noise with
  height-blended transitions; detail from a baked `DataArrayTexture` (triplanar on rock, planet-up
  projected on ground), IQ stochastic anti-tiling up close, macro rock relief normals (512 m eroded
  noise relief + 192 m noise-warped crags) visible from kilometres, 8 m + 2 m micro detail, altitude-locked strata ledges and
  vertical weathering streaks on cliffs, lichen on moist rock, wet shoreline darkening + low
  roughness, underwater seabed tint, cavity/AO (curvature + detail height), snow on up-facing micro
  facets (rock peeks through), snow glitter, volcanic crack glow. All detail coordinates are periodic
  in 4096 m and anchored with a float64 origin offset → no precision loss or pattern jumps on
  origin shifts.
* `detailTex.js` — procedural tileable layers baked in the worker at startup (~1 s, 7×256² RGBA8):
  rock (planar facets + joint sets + ridged grain + lichen), ground (soil + grass clumps), sand
  ripples, snow drifts/sastrugi, pebbles/scree, eroded macro relief (+ 4 noise channels), strata.

## Capture URLs (verified)
Use `view=fly` for terrain-only framing (no player body). Golden-hour `tod` (0.28–0.33 / 0.62–0.70)
reads relief best. Vistas were found with a horizon-profile search (mountain elevation angle,
water, elevated viewpoint, cliff features).
* W1 Golden Valley — fjord-like granite walls over a lake (best overall):
  `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=30&lat=3.96&lon=-29.58&yaw=315&pitch=-3&tod=0.3`
* W2 Hyrule Echo — BotW hills, rock outcrops, crags:
  `/?mode=system&galaxy=0&star=11&planet=0&view=fly&alt=60&lat=18.18&lon=-50.80&yaw=22&pitch=-8&tod=0.3`
* W3 Arzach — Moebius mesa/butte in evening light:
  `/?mode=system&galaxy=0&star=9&planet=2&view=fly&alt=60&lat=38.65&lon=51.31&yaw=67.5&pitch=-4&tod=0.68`
* W3 backlit buttes in haze: `/?mode=system&galaxy=0&star=9&planet=2&view=fly&alt=60&lat=32.70&lon=114.44&yaw=112.5&pitch=-8&tod=0.3`
* W1 mountain massif from 2.5 km: `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=2500&lat=0&lon=95&yaw=45&pitch=-15&tod=0.3`
* On foot (core use): `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=3.96&lon=-29.58&yaw=315&pitch=-4&tod=0.3`
* More candidates: W12 `lat=-9.94&lon=-59.10&yaw=112.5`, W5 `lat=43.85&lon=37.76&yaw=337.5`,
  W8 mesas `lat=5.46&lon=-156.48&yaw=135`, M1 `lat=39.89&lon=12.97&yaw=0`.

Debug URL params: `tdebug=1` (blend weights: red rock, green ground, blue sand, white snow),
`tdebug=2` (generator hints: rock/cliff, sand, wetness), `tk=<K>` (LOD range override),
`tlite=0|1` (force PBR / Lambert terrain lighting).

`__rv.state().terrain` → `{chunks, casters, desired, inflight, uploads, maxLevel, K, workers, tex,
inView, levels, ms, msMax}`.

## Performance
* high @1080p: K≈2.3; @720p K≈1.5 (1.18 in `shot=1`); @540p clamps to 1.3 (1.05 in `shot=1`).
  ~130–180 chunks in view, ~1.2–1.6 M terrain triangles in the main pass; one shared index buffer
  and material → one draw per chunk. Per-frame CPU ≈ 0.2–0.5 ms (selection + uploads); all
  generation in workers (~30–60 ms per chunk per worker).
* Shadows: only small near chunks cast (≤ 0.6·shadowDist in view, 900 m on high); chunks beyond
  the last cascade skip shadow lookups (`receiveShadow=false`).
* Software GL (SwiftShader, i.e. headless captures) is detected and gets a capture budget: terrain
  casts shadows only within 110 m (receives within 420 m), anisotropy 2, Lambert lighting, no 1–2 m
  micro layer, single-fetch tiling and shorter detail fade distances (`uRvLite`, `uRvF`). In
  `shot=1` the terrain is hidden while it streams and out-of-view nodes stay coarse.
  Measured on the check view (960×540, load ≈6–8): full frame ≈8.5 s (was ≈13 s), terrain hidden ≈1.5 s.
* `low` tier: Lambert lighting, coarser LOD (0.8 m leaves, 14 px/quad), no anisotropy.

## Known issues
* Software GL frames are still ~8–20 s at 720p under load (three lighting + CSM + cloud-shadow
  patch on every terrain pixel); captures can hit the harness' 30 s screenshot timeout (retry).
* Mountain massifs can read as smooth-ish walls from far away; crags, gullies and macro rock
  normals help. Rivers are valleys + sea-level channels only (no flowing river network).
* No occlusion culling yet (terrain behind ridges is drawn; early-Z rejects its pixels).
* Heightfield: no overhangs/arches (Roger Dean "arches" feature is approximated by karst towers).
* Distant terrain can turn saturated red/brown and hazy at some times of day: that comes from the
  aerial-perspective transmittance (see Requests). From orbit the planet renders as a dark disk
  with a lit limb in current captures — not terrain (the plain-material A/B test is identical).

## Requests
* **atmosphere**: distant terrain (3–15 km) turns strongly red/brown and hazy even at mid-morning
  (W1, W2 captures) — transmittance/extinction looks too strong for small planets. Also consider a
  cheaper shadow filter under software GL (PCF taps dominate capture time on terrain pixels).
* **player**: `view=fp` / `view=surface` cameras sometimes spawn rolled on slopes (W2, W12); please
  keep the camera horizon level on spawn so vistas frame cleanly.
* **post**: MSAA 4× under SwiftShader makes terrain frames very slow; consider disabling MSAA in
  `shot=1` or on software renderers (TAA/SMAA instead).
* **core**: in `shot=1`, after ready, the idle ticks still render every 20 frames; on SwiftShader each
  render of a terrain scene takes 8–20 s, so the harness screenshot queues behind idle renders and
  times out (30 s). Please skip idle renders in shot mode (render only in `advance`/`render`), or
  raise the screenshot timeout. Also optional: expose camera fov/height before subsystems are
  created (terrain derives its LOD range from them).
* **galaxy/other**: a ShaderMaterial uses `rv_hash13` without including `rv_common`
  (VALIDATE_STATUS errors in check and some system captures).
