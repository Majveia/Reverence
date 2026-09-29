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
  * `surfaceConfig(body)` → structured-cloneable config (what workers receive; includes the live
    flatten stamps of that body's surface).
  * **Flatten stamps** (civ request): `addFlatten({dir, radius, height, falloff})` → id grades the
    terrain to `height` (m rel. radius; default = current height at `dir`) inside `radius` m with a
    smooth `falloff` ring (default 0.6·radius). `removeFlatten(id)`, `flats`, `onFlattenChange(cb)`.
    Physics (`height/sample/normal`) changes immediately; the terrain resyncs its workers and rebuilds
    only the chunks the stamp touches (old mesh stays until the new one arrives → no holes). `sample()`
    reports rock/sand/cliff/river = 0 on the flat part.
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
* `detailTex.js` — procedural tileable layers baked in the worker at startup (~1.6 s, 8×256² RGBA8):
  rock (angular plane facets + stepped ledges + sparse fractures + weathering + lichen), ground (soil + grass clumps), sand
  ripples, snow drifts/sastrugi, pebbles/scree, eroded macro relief (+ 4 noise channels), strata,
  drainage/varnish streaks.

### Round 2 changes (critic: streaks, brush-stroke texture, clouded vista, iceberg, on-foot)
* **Local texture frame** (root cause of the "wood-grain / brush-stroke" rock and smeared ground):
  triplanar used world axes, so at mid latitudes every surface blended three oblique projections.
  Chunks now carry `aUV` = (cube-face u, v in metres minus a per-chunk multiple of the 4096 m period,
  altitude) computed in float64 on the CPU; the shader builds the face tangents from screen
  derivatives and projects in the local frame (u,v) / (v,alt) / (u,alt). Ground layers need a single
  up-projection (fewer fetches); cliffs project onto true vertical planes at every latitude.
* **Rock streak artifact** (regular near-black vertical bands): the 16 m-periodic 1D stripe lookup is
  gone. New baked layer 7 = drainage / desert-varnish streaks with irregular spacing, width, length and
  strength; sampled on the two vertical planes with a noise-warped horizontal coordinate, masked to
  steep faces, concentrated in concavities, patchy, and ≤ 45 % darkening. Occlusion is now one budget
  (albedo cavity + ambient AO can no longer stack toward black; AO floor 0.45).
* **Crack/seam lines**: skirts are shaded at their edge vertex (only rasterized lowered along −up), so a
  crack filled by a skirt is invisible — this also fixes the thin dark seam on the underwater seabed
  (water request) and dark hairlines on cliffs.
* **Anti-repetition**: rock/ground detail fetches pick one of the 8 lattice-preserving orientations
  (swaps/mirrors) + offset per stochastic region (keeps the exact 4096 m period across origin shifts);
  each projection plane gets its own orientation; the rock layer's joint sets now change orientation,
  spacing and presence per block (no global parallel lines). All macro tile sizes are powers of two.
* **Sedimentary strata** (layer 6) with real ledge relief aligned to the colour bands on layered-rock
  worlds (Moebius/Bebop/desert/savanna), only on steep faces; colour bands limited to faces (on gentle
  slopes they formed contour "tree rings"). Relief strength reduced where rock is only a hint on mild
  slopes (low sun turned mid-scale bumps into fur).
* **Crags**: much stronger 720/355 m rock octaves in `SurfaceGen` (plan-view buttresses and chutes on
  big walls instead of smooth clay); moss/grass on up-facing cliff ledges on lush worlds; large lighter /
  darker rock bodies.
* **Snow**: albedo < 1 with wind-packed/fresh patches, bluish hollows and 64 m drift relief (no flat
  clipped white).
* **Meadows** (flora request): where the flora track grows dense grass the ground takes the grass blade
  colour from mid distance and loses soil patches.
* **Perf** (lead request): screen-space target 8.5 px/quad on high (was 7), K ≤ 2.2 → ≈ 1.1–1.3 M terrain
  triangles at 1080p high (was ≈ 1.8 M); shadow casters limited to ≤ 0.45·shadowDist and small chunks.
* Debug: `tdebug=3` unlit albedo (as emissive), `tdebug=4` NaN finder.

### Round 3 changes (critic round 1 follow-up: fur / brush-stroke rock, smooth clay walls, combs)
* **Root cause of the "fur / brush-stroke / wood-grain" look found in the GEOMETRY, not the shader**:
  every fine-scale landform (fractal detail 720 m → 0.2 m, outcrops, kopjes, spires, karst towers,
  sea stacks, atolls, sinkholes, hills, dune modulation) was evaluated in the *continent-warped*
  coordinates. That warp's Jacobian is strongly anisotropic (measured over the sphere: median 2.3:1,
  10 % of the planet > 6:1, 1 % > 17:1), so all small-scale relief was stretched into parallel strokes
  (and cellular towers into blades). They now use the true unit direction (isotropic); only
  continent-scale masks, plateaus, mesas, canyons, rivers and lakes keep the warped frame.
* **Mountain ridged multifractal**: its own domain warp was multiplied into every octave (q·LAC per
  octave), so 100–500 m ridges inherited the same ~10:1 stretch → thin parallel stripes that aliased
  into combs / chevrons / needle rows on steep faces. The warp displacement now grows only with the
  first two octaves (finer octaves see a near-constant offset).
* **Big walls get structure**: steep-face detection (full ridge-noise slope + the slope of the range
  mask, finite-differenced only inside its ramp — kilometre walls where ranges rise out of the coast
  come from the mask, which the noise gradient never saw) drives (1) a wall-scaled buttress / chute
  relief (softened ridged noise, ≈9 % of each wavelength, first wavelength ≈ 0.9 × wall height) and
  (2) stronger big crag octaves. Mesa, plateau and canyon cliffs feed the same term. Canyon walls inside
  mountain ranges use a smooth V instead of 5 terrace steps (staircase lines on 60° slopes).
* **Rock detail texture (layer 0) rewritten**: angular plane facets with soft seams + stepped ledges
  (continuous terraced fbm) + a few long fractures + isotropic weathering. The old per-block joint-set
  hatching (aliased into fur at mid range) and the voronoi "dried-mud" outlines are gone.
* **Strata colour bands**: warp limited to ~1 band per 512 m (the fine 64 m warp folded the bands into
  contour loops — the "agate / topographic map" look on close mesa walls).
* **Shader**: a 32 m rock-block scale between the macro crags and the 8 m detail (walls 50–500 m away
  no longer read as plaster); macro drainage stains on big walls (layer 7 at 2 km → 6–50 m wide,
  300–1700 m long dark streaks visible from kilometres); warm iron-oxide staining patches on faces;
  palette rock less desaturated; sky-ambient AO floor raised (0.45 → 0.55, atmosphere request).
* Cost: `height()` ≈ +10–25 % (≈ 6–10 µs full detail); bake unchanged (~1.5 s in the worker).
* Tools (scratch, not in repo): an offline hillshade renderer + anisotropy statistics + a vista finder
  (ray-marched heightLod views scored for sky/water/layering/relief) were used to find the causes and
  the new vistas.

## Capture URLs (verified this round, 1280×720)
Use `view=fly` for terrain-only framing (no player body). Side light reads relief best: pick `tod` so the
sun is ~60–120° off the view direction (sun ≈ east at tod 0.3, ≈ west at 0.68 on these worlds).
Aerial heroes add `tk=1.7` (finer capture LOD; ~+50 % chunks — do NOT use it on foot).
* **W1 fjord spires, aerial (hero)**:
  `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=1800&lat=-8.83&lon=101.969&yaw=180&pitch=-12&tod=0.3&tk=1.7`
* **W1 buttressed mountain face over a fjord (new wall relief)**:
  `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=1500&lat=7.691&lon=-131.848&yaw=0&pitch=-10&tod=0.3&tk=1.7`
* **W3 Moebius mesa country + lake, aerial**:
  `/?mode=system&galaxy=0&star=9&planet=2&view=fly&alt=1500&lat=35.662&lon=112.465&yaw=180&pitch=-10&tod=0.3&tk=1.7`
* **W3 on foot under a strata wall (ground level, third person)**:
  `/?mode=system&galaxy=0&star=9&planet=2&view=surface&lat=-43.2326&lon=-28.5306&yaw=90&pitch=8&tod=0.62`, steps `[{"advance":1}]`
* **W1 on foot, meadow under a rock wall with boulders**:
  `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=-13.8425&lon=155.4463&yaw=210&pitch=8&tod=0.3`, steps `[{"advance":1}]`
* W3 badlands / mesa strata from 60 m (the old "fur" test):
  `/?mode=system&galaxy=0&star=9&planet=2&view=fly&alt=60&lat=38.65&lon=51.31&yaw=67.5&pitch=-4&tod=0.68`
* W1 lake cliffs (streak test): `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=30&lat=3.96&lon=-29.58&yaw=315&pitch=-3&tod=0.3`
  (front-lit at this tod; night: `tod=0.02`)
* W12 arctic fjord cliffs (snow, moody): `/?mode=system&galaxy=0&star=9&planet=5&view=fly&alt=300&lat=-34.389&lon=-165.406&yaw=225&pitch=0&tod=0.3`
* W2 archipelago: `/?mode=system&galaxy=0&star=11&planet=0&view=fly&alt=60&lat=18.18&lon=-50.80&yaw=22&pitch=-8&tod=0.3`
* W1 fjord spires, low with reflections: `…star=6&planet=1&view=fly&alt=400&lat=-8.83&lon=101.969&yaw=180&pitch=0&tod=0.3`
* W1 underwater shelf: `…star=6&planet=1&view=fly&alt=4&lat=15.8013&lon=34.3048&yaw=330&pitch=-10&tod=0.4&uw=3&disable=vehicles`
* More vista-finder candidates (not all verified): W1 `alt=350&lat=-22.778&lon=172.483&yaw=315&pitch=-5&tod=0.7`
  (lake between ridges, backlit); W3 `alt=350&lat=33.456&lon=-85.957&yaw=315&pitch=-5&tod=0.68` (savanna,
  lake, mesa range); W8 `alt=1500&lat=58.49&lon=132.906&yaw=0&pitch=-10`; W12 `alt=350&lat=0.209&lon=-112.919&yaw=270`.

Debug URL params: `tdebug=1` (blend weights: red rock, green ground, blue sand, white snow),
`tdebug=2` (generator hints: rock/cliff, sand, wetness), `tdebug=3` (unlit albedo), `tdebug=4` (NaN finder),
`tdebug=5` albedo without wall streaks, `6` lit without streaks, `7` + no detail normals, `8` rock detail albedo,
`9` triplanar weights, `10` (rock mid albedo, strata, rock height), `11` |face tangent|, `12` macro noise;
`tgen=1` disables the new steep-face buttresses (A/B), `tk=<K>` (LOD range override),
`tlite=0|1` (force PBR / Lambert terrain lighting).

`__rv.state().terrain` → `{chunks, casters, desired, inflight, uploads, maxLevel, K, workers, tex,
inView, levels, ms, msMax}`.

## Performance
* high @1080p: K≈1.9 (8.5 px/quad target; was 2.3); @720p clamps to 1.3 (1.05 in `shot=1`).
  ~110–150 chunks in view, ~1.0–1.3 M terrain triangles in the main pass; one shared index buffer
  and material → one draw per chunk. Per-frame CPU ≈ 0.2–0.5 ms (selection + uploads); all
  generation in workers (~30–60 ms per chunk per worker).
* Shadows: only small near chunks cast (≤ 0.45·shadowDist in view, side ≤ 0.5·shadowDist); chunks beyond
  the last cascade skip shadow lookups (`receiveShadow=false`).
* Software GL (SwiftShader, i.e. headless captures) is detected and gets a capture budget: terrain
  casts shadows only within 110 m (receives within 420 m), anisotropy 2, Lambert lighting, no 1–2 m
  micro layer, single-fetch tiling and shorter detail fade distances (`uRvLite`, `uRvF`). In
  `shot=1` the terrain is hidden while it streams and out-of-view nodes stay coarse.
  Measured on the check view (960×540, load ≈6–8): full frame ≈8.5 s (was ≈13 s), terrain hidden ≈1.5 s.
* `low` tier: Lambert lighting, coarser LOD (0.8 m leaves, 14 px/quad), no anisotropy.

## Known issues
* The white "iceberg" shapes on the W2 horizon are NOT terrain: they are the water track's shore foam
  drawn where the ocean surface occludes islands beyond the horizon (A/B: `tdebug=1` leaves them white,
  `disable=terrain` removes the islands) — see Requests (water).
* Cube-face edges (12 great-circle arcs per planet) are a discontinuity of the detail-texture pattern
  (not of colour or geometry) since the local frame is per face.
* Shot mode (`shot=1`) uses K = 1.05 (below the CDLOD nesting limit: neighbouring chunks can differ by
  two levels; skirts fill the cracks invisibly). Far terrain then reads slightly faceted from the air —
  aerial hero URLs add `tk=1.7`. Ground-level views should not (≈3.8 M triangles near big walls).
* Near-vertical heightfield walls (fjord spires, W12 cliffs) still shade with fine vertical streaks at
  1–5 km (one vertex column per streak); no overhangs / arches (heightfield).
* A few thin fins can appear on the crest of very steep ranges where the buttress relief meets the
  ridge (W1 `lat=7.691&lon=-131.848`, right of frame); `tgen=1` A/B disables the term.
* Landforms changed at the < 2 km scale this round (isotropic detail, mountain warp): other tracks'
  hard-coded lat/lon spawn notes may land a few metres higher/lower or on a different slope; macro
  layout (continents, coasts, ranges, mesas, rivers, lakes) is unchanged.
* Software GL frames are still ~8–20 s at 720p under load; captures take 2–6 min on the shared box.
* No occlusion culling yet (terrain behind ridges is drawn; early-Z rejects its pixels).
* Flatten stamps reach flora/water workers only through `surfaceConfig(body)` at their init (see
  Requests: flora should forward `surface.onFlattenChange`).

## Requests
* **water** (still visible on W2 this round): (1) shore foam appears on the ocean surface wherever it occludes terrain beyond the horizon
  (W2 `lat=18.18&lon=-50.80&yaw=22`: white flat "icebergs" under every distant island). In
  `shaders.js` `depthBelow = max(uRs - length(bed - uPC), 0)` is 0 when the reconstructed bed point is
  ABOVE sea level (an island's slope behind the horizon), so `shoreD = 0` → full edge foam. Treat
  `length(bed - uPC) > uRs` as deep water (e.g. `depthBelow = rThick`) and/or fade shore foam with
  `rThick`. (2) The seabed seam you reported is fixed on the terrain side (skirt shading).
* **atmosphere**: (1) the airless-body black terrain is fixed (lead: NaN in the env cubemap) — consider a
  small bounce/earthshine ambient on airless moons so shadows are not pure black. (2) Cloud billboards /
  low cumulus intersect the W1 fjord walls and read as flat cut-outs in front of them (W1 hero URL, left
  and right of frame); a softer depth fade against terrain would help. (3) Done on the terrain side: the
  sky-ambient AO floor is raised (0.45 → 0.55) so shadowed slopes keep their relief under sky light.
* **flora**: forward flatten stamps to your workers — `world.surface.onFlattenChange((f, all) =>
  worker.postMessage({ type: 'flats', flats: all }))` and call `gen.setFlattens(flats)` in the worker
  (terrain does the same), so trees never float/sink on civ plazas graded after your workers started.
* **civ**: `surface.addFlatten({dir, radius, height, falloff})` is available (see API above) — grade
  plazas / building pads before placing buildings; the terrain rebuilds the touched chunks automatically.
* **player**: `view=surface` without `alt` spawns on the nearest flat spot — at the documented W1 lake
  URL that is the top of a 1.5 km cliff, which looks like an aerial shot; the W3 on-foot URL above is a
  true ground-level framing.
* **galaxy/other** (carried over): a ShaderMaterial uses `rv_hash13` without including `rv_common`.
