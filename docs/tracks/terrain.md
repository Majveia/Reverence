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

### Round 4 changes (critic round 2: combed/streaked cliffs, monochrome slopes, faceting, on-foot ground)
* **Root cause of the "draped fabric / combed" walls**: a heightfield wall is the band between two
  contour lines, so every relief term that depends only on the horizontal position (fractal detail,
  buttresses) is extruded down the whole wall as vertical stripes, and the walls themselves reach slope
  10 (84°), where one vertex row spans 30–65 m of height.
  * **3D wall relief** (`SurfaceGen`, after the buttresses): on walls the relief is evaluated at the 3D
    surface point (radius R + h) and its height offset is scaled by the wall slope s. A height offset Δh
    on a face of slope s moves the face horizontally by Δh/s, so this is an approximately isotropic 3D
    displacement along the wall normal. It uses **3D Voronoi facets** (`_facets3`: tilted plane per
    jittered cell, Gaussian-blended seams). Voronoi boundaries are planes, so walls get polygonal joint
    blocks with differently oriented faces instead of the crescents/fish scales that ridged noise gave.
    It also adds fine cracks and, on all worlds, **ledges**: altitude terracing (monotonic, never folds)
    with slowly wandering phase, strong on layered-rock worlds (`st.wallLedges`, `st.ledgeStep` 9–16 m)
    and mild on granite. Weight = max(generator steep/cliff hints, measured slope 58°→73°). Slope factor
    capped at 3.6 so the profile cannot fold.
  * **Fractal detail** octaves < 200 m are sampled at the 3D surface point (radius R + h, everywhere, so
    there is no varying-frequency seam) and boosted by the slope on walls. The big crag octaves stay 2D:
    plan-view ribs and couloirs ARE vertical structures.
  * **Octaves are faded by the wall's vertical mesh resolution** (lod × slope), so sub-resolution relief
    never aliases into per-vertex-column combs.
  * **Bug fix: spatially varying noise frequency.** The buttress wavelength followed `wallH` (which tracks
    the range mask), which rescaled noise coordinates of ~10³ units by a varying factor and decorrelated
    the noise within metres. This was the source of the old "thin fins on crests" and of part of the
    combing. Wavelengths are now per-world constants (`st.buttWl`, `st.wallLam`). Measured: height
    second-difference RMS at 0.6 m along a W1 wall dropped from 85 m to 1.5 m.
  * **Relief-aware CDLOD** (`index.js`): a chunk whose relief/side ratio is high refines up to 60 % earlier
    (`reliefK`: high 0.6, med 0.35, low 0). It is set once when the chunk is built and bounded so
    D(child) ≤ 0.66·D(parent) (rf(child) ≤ 1.3·rf(parent)), which keeps CDLOD geomorphing seamless.
    It adds about 10–30 % chunks in mountain views.
* **Shader**:
  * Vertical triplanar planes use mirror-only orientations. A 90° swap turned horizontal ledges and
    fractures into vertical scratches.
  * The strata layer no longer has vertical joint lines; it has partings and horizontal lenses instead.
    Drainage streaks are wider so they never go sub-pixel.
  * Far rock albedo is calm: ±12 % from the macro layers, which had read as fish scales. Near detail
    gives up to ±30 % with sharpened cavities. Strata colour bands appear only on layered-rock worlds.
  * Rock bodies: warm iron/ochre vs cool dark vs pale granite at 512 m and 64 m, with ±20 % value and
    ±8 % hue. The palette rock is no longer pulled toward a bluish grey (that was the "purple-grey
    monochrome" the critic saw).
  * **Layered-rock close range**: ~5 m beds (< 900 m) and ~1.2 m laminae (< 90 m) from the strata
    layer, with the faceted layer-0 detail faded on bedded faces (it had read as crumpled paper). The band
    warp comes from a purely horizontal field; the triplanar macro noise had stepped the bands into "Z"
    shapes at projection seams.
  * **Talus / scree aprons**: 30–40° concave slopes below rock, grey rubble from the pebble layer.
    **Gravel patches** on gentle dry ground, suppressed in meadows. The sand/grass edge is
    noise-distorted at two scales.
  * Curvature: sunlit crests are lighter (+12–28 %) and hollows darker (cavity −26 %).
  * **Near detail (2 m rock, 1 m ground) is now on in software-GL captures too.** It was disabled in
    "lite" mode, so every on-foot capture lacked sub-2 m detail.
  * Snow-free **wave-washed fringe** at the waterline (dark wet band where snow meets the sea).
* **API** (flora request): `terrain.lodAt(x, y, z)` returns the lod (m) of the drawn mesh at a unit
  direction; `terrain.renderedHeight(x, y, z)` = `surface.heightLod(x, y, z, terrain.lodAt(...))` is the
  height of the rendered mesh at its vertices (get the instance with `world.get('terrain')`).
* Cost: `height()` ≈ 11–13 µs full detail (was 8–10). Detail bake unchanged (~1.4 s in the worker).
* The player request (W3 `lat=22.571&lon=56.286` "needle spikes") is checked: the CPU heightfield is
  smooth there at all LODs and the capture shows dunes with ripples, no spikes.

### Round 5 changes (critic round 2 follow-up: combed walls, monochrome faces, ground contact detail)
* **Root cause of the fine vertical "comb" lines on every cliff found: the per-vertex curvature hint.**
  `chunkBuild` computed curvature as the raw height Laplacian / spacing. On a wall of slope s, a
  horizontal wobble Δx of the face is a height change of s·Δx, so the Laplacian saturated to ±1 and
  flipped sign from one vertex column to the next. Cavity darkening, crest lightening, AO, talus,
  drainage-streak and iron masks all read that hint → one light/dark line per vertex column. A/B with
  `tdebug=6/7/15` proved it was neither the streak layer, the detail normals nor the geometry.
  Curvature is now the offset from the 3×3 neighbourhood mean measured **along the normal**
  ((hMean − h)·cosθ / spacing) — the same value on flat ground, ~10× smaller (and smooth) on 84° walls.
* **Rock detail layer (0) rebaked**: the stepped ledges were the contours of a terraced fbm (curly dark
  riser lines = "wrinkled skin / worms" on walls at 50–300 m). Ledges are now near-parallel bedding /
  sheeting planes (sawtooth tread + riser, periodic) and the cracks are a sparse subset of straight
  polygon seams of a second block field (angular joints, 2–5 px wide in the bake).
* **Wall tone bodies**: big faces get vertically elongated pale (exfoliation scars) / dark-cool (seeps,
  lichen) tone bodies ~150–600 m wide (±30 % value) from two vertical-plane fetches; macro drainage
  stains are darker (−62 %) and cover more of the face.
* **0.5 m rock grain** (third rock detail scale) within 16 m of the camera — on-foot walls and boulders.
* **Underfoot micro layer** (vehicles request): within 14 m, scattered grit / 3–4 cm stones (pebble
  layer at 0.6 m, masked sparse) on soil and sand, and 1 m fine sand ripples — boots and rover wheels.
* **Talus / rubble aprons** (new generator hint): `SurfaceGen` reports `talus` (0..1) at the foot of
  mesa, plateau and canyon walls; it is exported by `surface.sample().talus` and streamed to the GPU
  as a new vertex attribute `aMat3.x`. The shader paints coarse 0.3–1 m rubble (pebble layer at 7 m
  scale) there and keeps sand off it. Geometry: mesas/plateaus got a low **debris fan** (+6 % of the
  wall height over the outer Δv = 1, ≈ 18–25°, fading up the cliff — the profile stays monotonic) and
  canyon walls a concave **debris apron** (7.5 % of the depth) instead of a crisp floor/wall corner.
* **Steep shores → dark shingle**: near sea level (−6…+9 m) on slopes > ~15° the bright sand band
  (the "thin bright stroke along the contour" the critic saw in the fjord) becomes wet shingle /
  boulders; beaches remain on gentle shores, with a noise-varied width.
* **Meadow colour drifts**: where the ground takes the flora blade colour, it now varies in 20–200 m
  patches (sun-dried yellow, lush dark-green hollows) instead of one flat green.
* **Landform hint fixes** (they painted broad rock / soil stripes across meadows, which flora then
  avoided → stripy grass): (1) canyon wall hints are scaled by the real mean wall slope (depth /
  (0.05·wavelength)) — W1's half-strength canyons have gentle flanks; (2) plateau/mesa wall hints are
  scaled by `sstep(0.3, 0.75, reg·inland)`; (3) the coastal-cliff rock band now uses the same jagged
  coordinate as the cliff riser (it ignored a ±0.0025 jag and ran far inland); (4) mountain 3D wall
  relief + ledges only count mountain faces from ~48° of large-scale slope (full at ~63°) — the
  range's "steep" hint starts at 27° and had terraced meadow flanks into rice-paddy steps.
* All changes keep `PlanetSurface` deterministic and worker-safe; `height()` cost unchanged
  (~7–11 µs full detail).

### Round 6 changes (critic round 2, final pass: wall structure, crest needles, capture reliability)
* **Captures no longer time out (critic item 7)**. The W1 lake-cliff view failed twice at 400 s. The
  cause was the shot-mode dispatch: at most 6 builds per worker were queued per frame, and software-GL
  progress frames block the main thread for seconds, so the workers sat idle (466 builds that need
  ~30 s of worker CPU took ~190 s). Shot mode now queues every pending build at once (the camera is
  static). Measured: W1 hero `readyMs` 188 s → 109 s, the lake view now completes (258 s total
  under shared load, 761 builds). Out-of-view nodes in shot mode also stop refining below 50 m chunks.
  An offline CDLOD selection simulator (scratch tool) reproduces the chunk counts per URL without a
  browser.
* **Rock structure on big faces (critic items 1 and 3)**. The terrain shader adds three analytic
  layers on the two vertical planes of the local frame. All of them are footprint-faded (nothing
  sub-pixel, so nothing shimmers), and all periods divide 4096 m so the pattern stays stable across
  origin shifts.
  1. **Big polygonal facets**: Voronoi cells 128 m wide and 280 m tall. Each is a rock plane with
     its own tilt (1.5× stronger beyond 1.2–4 km, where aerial perspective flattens walls), its own
     tone (±6 %) and its own warm-oxidised or cool-fresh hue. Seams are eased over 12 % of a cell.
     They fade in from 350–900 m, so on-foot views never see them.
  2. **Aretes and dihedrals**: creased, piecewise-linear 1D noise across the face at 64 m and 16 m,
     with short angular kinks along the altitude. They come and go along the wall, which gives crisp
     vertical light and dark edges instead of soft fabric folds. The crease is antialiased.
  3. **Sparse open joints** at 32 m and 8 m. These are continuous orthogonal sets: long vertical
     cracks (~40 % open, in 3-row runs) and rarer sheeting joints (~15 %), with light-catching bevels.
     On massive-rock worlds some sheeting joints are narrow lit ledges under a shadowed overhang, and
     these collect snow or moss through the normal.

  Iterations that were rejected after offline previews or captures: a per-block Voronoi with joint
  lines everywhere (it read as crackle glaze or tortoise shell), rows offset per column (brickwork),
  sinusoidal wander (wavy curtains) and per-cell tone at 32 m (graph-paper checker). An offline
  numpy preview of the wall pattern (scratch tool) was used to judge those, without the browser.
* **Less "draped fabric"**: wall tone bodies are now ~1.6:1 instead of 3:1 vertical. The macro
  drainage stains are sharpened (a smoothstep on the stain density) and lighter (darkening −62 % →
  −35 %). Mip-filtered at kilometres, they had spread into the broad, soft, dark vertical bands that
  read as fabric folds.
* **Crest needles removed (critic item 3, "isolated cones stuck on the ridge")**. A needle counter
  (local maxima more than 12 m above an 8 m ring, 800 m patch, 2 m grid) found 276 needles on the W1
  face crest. They came from the buttress ribs and the steep-boosted crag octaves: their positive
  ridge crests crossed the mountain crest and stacked into pinnacles. Both terms now mostly carve:
  the positive rib part is damped (×0.3 for buttresses, ×(1 − 0.65·steep) for crag octaves), and the
  two finest buttress octaves are weaker. The count dropped to 24 while the range height stayed the
  same (3523 m), so crests are notched (gendarmes and couloirs) instead of spiked. New debug bits:
  `tgen=16` (no buttresses) and `tgen=32` (no steep crag boost).
* **No more "hair" in gullies / contour stripes on 30–45° slopes**: `tdebug=15` (geometry N·L)
  showed that the thin dark wavy strokes on W3 badlands were geometric. The generator profile showed
  why: the plateau / mesa "cliff" hint (full strength over the whole cliff band of the profile) was
  driving the 3D wall relief and the **ledge terracing** on bands that are only 30–45° where the
  noise gradient is small. That turned them into 3–8 m terraces whose risers shade as wavy contour
  strokes. The wall-relief weight now follows the **real slope of the band**
  (plateauH · |mesa′| · |∇noise|, one analytic-derivative noise call). It is unchanged on real walls
  (slope 8–10 at the W3 mesa) and off on gentle bands; rock colour hints are unchanged. Ridged rock
  octaves within ~6 vertex spacings of the chunk lod also use a softened |v|, so sub-resolution
  razor creases no longer alias.
* The `tdebug=15` A/B on the W1 hero also confirmed that the soft vertical "fabric" bands on the spires
  are geometry: smooth heightfield columns between buttress chutes. The shader facets and aretes now
  break them into angular planes. Real overhangs would need non-heightfield geometry.
* **Broader cavity**: per-vertex curvature now mixes a ±2-vertex term (chunks carry a 2-vertex
  border). A one-vertex V notch on its own drew thin dark "ink" lines along every badlands gully.
  The cavity darkening was also lowered (−26 % → −20 %).
* **Green flanks on lush worlds (critic item 2)**: on lush, temperate worlds grass and scrub hold to
  steeper slopes (+0.08 in 1−cosθ, i.e. ~45–50° instead of ~40°). This fades out with altitude
  (0.3–0.65 × amplitude), cold and dryness, so mountain flanks are green with rock breaking through
  and bare rock stays above.
* **Bare-ground patches (critic item 4; new API field)**: `SurfaceGen` computes a `bare` mask (worn
  soil / gravel patches, 13 m + 48 m noise, more around rock and talus, none on sand, dunes or lakes,
  LOD-faded). It is returned by `surface.sample().bare` and streamed per vertex as `aMat3.y`. The
  shader paints soil and gravel there and removes the meadow blade tint, so meadows get BotW-like
  dirt patches. About 12 % of the land on W1/W2 and 17 % on W3. Flora can thin grass on it (see
  Requests).
* **Caprock rims**: plateau and mesa tops carry a rock hint along the rim (the hard bed that holds
  the table up), so the tops no longer read as one pale sand sheet from the air.
* **Wave-cut platforms (critic item 6)**: where steep rock meets the sea, heights in [−40, +2] m are
  pulled toward ≈ −0.6 m by a monotonic remap (it never folds). This makes a 7–15 m rock shelf at
  the foot of 55–70° sea cliffs, patchy along the coast and broken into rocks by the fractal detail.
  Style knob `st.shelf`; it adds no rng draw, so all other style values are unchanged.
* **Inbox (atmosphere)**: (1) *orbit LOD facets near the terminator*: beyond ~25 km the shading normal is
  eased toward the sphere normal (up to 50 % at 160 km), so coarse orbit chunks no longer shade as
  angular white cut-outs at a grazing sun. Slope and biome masks still use the true normal. (2)
  *golden-hour rim/wrap on grass*: with a low sun (elevation < ~23°), meadow ground gets a soft wrap
  term and a back-lit translucency rim, tinted by `G.uSunColor` (emissive, meadows only, no rock or
  snow).
* **Low tier**: the wall-structure block (about 50 hashes per wall fragment) is skipped on `low`.
* **Strata contrast**: bed albedo contrast raised from ±8 % to ±~20 % (critic item 5).

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
* **W3 on foot, savanna under a strata cliff (new this round: trees, creatures, banded wall)**:
  `/?mode=system&galaxy=0&star=9&planet=2&view=surface&lat=25.042&lon=112.372&yaw=90&pitch=12&tod=0.45`, steps `[{"advance":1}]`
* W3 on foot at the strata-wall foot. Since the round-5 debris fans, the player spawns on the
  inclined apron, so this view is a slope close-up and no longer a wall vista:
  `/?mode=system&galaxy=0&star=9&planet=2&view=surface&lat=-43.2326&lon=-28.5306&yaw=90&pitch=8&tod=0.62`, steps `[{"advance":1}]`
* **W1 on foot, meadow under a rock wall with boulders**:
  `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=-13.8425&lon=155.4463&yaw=210&pitch=8&tod=0.3`, steps `[{"advance":1}]`
* **W3 sandstone wall close-up (bedding / laminae, new)**:
  `/?mode=system&galaxy=0&star=9&planet=2&view=fly&alt=25&lat=-43.2326&lon=-28.478&yaw=90&pitch=8&tod=0.62&disable=fauna,vehicles`
* **W1 spire wall close-up (3D wall relief test)**:
  `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=1300&lat=-11.6&lon=101.969&yaw=180&pitch=8&tod=0.3&tk=1.7`
* W3 badlands / mesa strata from 60 m (the old "fur" test):
  `/?mode=system&galaxy=0&star=9&planet=2&view=fly&alt=60&lat=38.65&lon=51.31&yaw=67.5&pitch=-4&tod=0.68`
* **W1 lake cliffs (streak test; it timed out before this round and now captures in ~150–260 s)**: `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=30&lat=3.96&lon=-29.58&yaw=315&pitch=-3&tod=0.3`
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
`13` local-frame normal, `14` shading normal, `15` N·L (geometry only);
`tgen=<bits>`: 1 no buttresses, 2 no 3D wall relief / ledges, 4 no gully erosion, 8 no fractal detail (A/B),
`tk=<K>` (LOD range override), `trelief=<0..1.5>` (relief-aware split boost; 0 = off),
`tlite=0|1` (force PBR / Lambert terrain lighting).

`__rv.state().terrain` → `{chunks, casters, desired, inflight, uploads, maxLevel, K, workers, tex,
inView, levels, ms, msMax, readyMs, builds}` (`readyMs` = time until the terrain first became complete).

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
* Heightfield limit: on 80°+ walls (W1 spires, lake cliffs) the 3D facets are only a few metres of
  horizontal relief, because more would fold the heightfield. From 2–5 km those faces still read fairly
  smooth when they are in diffuse light. There are no overhangs or arches.
* W1 mountain flanks are busier than before (blocks and ledges on every slope above ~58°). If a critic
  calls them noisy, lower `wallBlocks` or raise the `wS` slope ramp in `SurfaceGen`.
* The talus and gravel tint is warm-brown on W1 (Bierstadt palette rock) and reads as dirt patches on the
  meadow slope; flora grass still grows on top of them.
* Landforms changed at the < 2 km scale this round (isotropic detail, mountain warp): other tracks'
  hard-coded lat/lon spawn notes may land a few metres higher/lower or on a different slope; macro
  layout (continents, coasts, ranges, mesas, rivers, lakes) is unchanged.
* Software-GL frames are still ~8–20 s at 720p under load. With the shot-mode dispatch fix, terrain
  readiness is about 110–160 s for 450–760 builds at load ≈ 8 on 4 cores (it was 190 s, and the lake
  view never finished). Total capture time is now dominated by waiting for one of the two shared
  render slots. Run captures one at a time with `--timeout 470`.
* Rock structure (facets, aretes, joints) is shader-only. Silhouettes and crests come from the
  heightfield. On 80°+ walls the planar facets shade like real planes but cannot cast shadows.
  Facet seams can read slightly "low-poly" on walls 0.5–1.5 km away in flat light.
* Crests are now notched rather than spiked. Where carving dominates, a few crest lines read as a
  regular crenellation (W1 hero, left massif).
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
* **flora** (new this round): `surface.sample().bare` (0..1) marks worn soil / gravel patches that the
  terrain paints (about 12 % of land on W1/W2). Thin or skip grass where `bare > 0.5` (scale density by
  `1 - bare`) so the patches read like BotW dirt patches instead of being covered by blades.
* **flora** (new API): to root grass on the drawn mesh use `world.get('terrain')?.renderedHeight(x, y, z)`
  (or `surface.heightLod(x, y, z, terrain.lodAt(x, y, z))`); fall back to `surface.height` when null.
  Please also skip grass/understorey where `sample().slope > 0.45`: the new talus/scree aprons look best
  without grass on them.
* **all tracks**: small-scale relief changed again. The fractal detail below 200 m is now sampled at the
  3D surface point everywhere (same statistics, different values): gentle ground moved by up to about
  ±1 m, rock by a few metres, and walls (> ~55°) got new blocks and ledges. Macro layout is unchanged.
  Re-check hard-coded spawn/park positions (runtime `surface.sample` placement is unaffected).
