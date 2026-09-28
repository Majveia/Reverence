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
  projected on ground), IQ stochastic anti-tiling up close, crag-scale macro normals (192 m tiles,
  noise-warped) visible from kilometres, 8 m + 2 m micro detail, altitude-locked strata ledges and
  vertical weathering streaks on cliffs, lichen on moist rock, wet shoreline darkening + low
  roughness, underwater seabed tint, cavity/AO (curvature + detail height), snow on up-facing micro
  facets (rock peeks through), snow glitter, volcanic crack glow. All detail coordinates are periodic
  in 4096 m and anchored with a float64 origin offset → no precision loss or pattern jumps on
  origin shifts.
* `detailTex.js` — procedural tileable layers baked in the worker at startup (~1 s, 7×256² RGBA8):
  rock (planar facets + joint sets + ridged grain + lichen), ground (soil + grass clumps), sand
  ripples, snow drifts/sastrugi, pebbles/scree, noise (4 channels), strata.

## Capture URLs (verified)
Use `view=fly` for terrain-only framing (no player body). Golden-hour `tod` (0.28–0.33 / 0.68–0.72)
reads relief best.
* W2 Hyrule Echo, BotW hills + crags:
  `/?mode=system&galaxy=0&star=11&planet=0&view=fly&alt=60&lat=18.18&lon=-50.80&yaw=22&pitch=-8&tod=0.3`
* W1 Golden Valley, lake + mountain wall:
  `/?mode=system&galaxy=0&star=6&planet=1&view=fp&lat=3.96&lon=-29.58&yaw=315&pitch=-4&tod=0.3`
* W1 mountain massif (fly): `/?mode=system&galaxy=0&star=6&planet=1&view=fly&lat=26.5&lon=4&alt=500&yaw=0&pitch=-6&tod=0.33`
* W3 Arzach dunes / lake: `/?mode=system&galaxy=0&star=9&planet=2&view=fly&alt=60&lat=13.79&lon=123.90&yaw=67.5&pitch=-6&tod=0.3`
* More vista candidates per world (lat/lon/yaw, found by a horizon-profile search): W12
  `lat=-9.94&lon=-59.10&yaw=112.5`, M1 `lat=-21.49&lon=-167.09&yaw=292.5`, W5 `lat=43.85&lon=37.76&yaw=337.5`.

`__rv.state().terrain` → `{chunks, casters, desired, inflight, uploads, maxLevel, K, workers, tex,
inView, levels, ms, msMax}`. Debug URL param `tk=<K>` overrides the LOD range factor.

## Performance
* high @1080p: K≈2.3; @540p K clamps to 1.3 (1.05 in `shot=1`). ~150–250 chunks drawn,
  ~1.2–1.6 M terrain triangles in the main pass, near/small chunks cast shadows only
  (≤ 0.6·shadowDist in view). Per-frame CPU ≈ 0.2–0.5 ms (selection + uploads); builds in workers.
* In `shot=1` the terrain is hidden until fully streamed (software-GL renders of partial terrain
  only slow captures) and out-of-view nodes stay coarse.

## Known issues
* Software GL (SwiftShader) frames with the full terrain take ~8–20 s under load; captures can hit
  the harness' 30 s screenshot timeout when the machine is busy (retry).
* Mountain massifs can read as smooth pyramids from far away (large first ridged octave); crags and
  gullies help up close. Rivers are valleys + sea-level channels only (no flowing water network).
* No occlusion culling yet (terrain behind ridges is drawn); horizon-map culling is the next step.
* Distant terrain can look saturated red-brown: this comes from the aerial-perspective transmittance
  (see Requests).

## Requests
* **atmosphere**: distant terrain (3–15 km) turns strongly red/brown and hazy even at mid-morning
  (W1, W2 captures) — transmittance/extinction looks too strong for small planets. Also consider a
  cheaper shadow filter under software GL (PCF taps dominate capture time on terrain pixels).
* **player**: `view=fp` / `view=surface` cameras sometimes spawn rolled on slopes (W2, W12); please
  keep the camera horizon level on spawn so vistas frame cleanly.
* **post**: MSAA 4× under SwiftShader makes terrain frames very slow; consider disabling MSAA in
  `shot=1` or on software renderers (TAA/SMAA instead).
* **core**: optional — expose the camera fov/height before subsystems are created (terrain derives
  its LOD range from them; it currently falls back to 60°/window height).
