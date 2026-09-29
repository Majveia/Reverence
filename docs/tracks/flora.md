# Flora track — vegetation & rocks

Owner paths: `src/world/flora/**` (+ this file). Subsystem `flora`, order 30.

## What was built

* **Art-directed species** (`styles.js`): `body.art.flora` selects a style — `lush` (BotW oaks,
  birches, spruces, bushes, ferns, reeds, daisies/spikes/cups), `boreal` (spruce/pine/birch taiga,
  moss, dry shrubs), `moss` (Tarkovsky birch + snags, moss mounds), `giant` (Roger Dean / Avatar
  world trees with glowing vines, palms, glowing alien fronds), `fungal` (Nausicaä giant mushrooms,
  shelf-fungus towers, coral trees, spore bulbs), `crystal` (crystal spires, crystal trees, glow
  bulbs), `bioluminescent` (dark oaks, lantern trees, glow mushrooms, bulbs, cyan grass tips),
  `wacky` (Rick & Morty lollipop/balloon trees, polka-dot mushrooms, tentacles, eyestalks),
  `alien` (NMS palms, bloom trees, corals, fronds), `sparse-alien` (Moebius umbrella trees, cacti),
  `sparse` (acacias, snags, cacti, dry shrubs), `dead` (Beksiński bone trees), `none/barren` (rocks
  only). Colours come from `art.palette.flora/grass/grass2/rock/sand/accent`.
* **Procedural meshes at startup** (`geom/*.js`, `PlantBuilder`): skeletons (trunk paths with root
  flare, limbs, sub-branches, whorls, fronds, lathed caps…) emitted at two detail levels (LOD0 full,
  LOD1 simplified). Leaves are camera-facing cluster cards with spherified crown normals and
  per-card AO (inner/under crown darker). Bark tubes wrap a real-world-scale tiling bark array
  texture (6 layers: furrow, birch, palm, smooth, plates, organic). Rocks are noise-displaced welded
  icospheres (boulder, angular, slab, spire, layered) with cavity AO and strata.
* **Procedural textures** (`textures.js`): 2048² semantic leaf/flower atlas (R shading, G tint mask,
  B translucency, A coverage — every palette recolours it), bark array texture, rock detail texture.
* **Materials** (`materials.js`, `grass.js`, `impostor.js`): `MeshStandardMaterial` +
  `onBeforeCompile` everywhere, so the atmosphere track's cascaded sun shadows, cloud shadows, PMREM
  sky light and fog apply. Foliage lighting adds wrap diffuse + view-dependent translucency (back-lit
  leaves glow), per-leaf relief normals from the atlas, crown AO; bark gets parallax-free relief
  normals + moss; alien solids get procedural patterns (spots, stripes, polka, eyeballs, gills,
  bands, ribs); glow kinds pulse and ramp with `G.uNight`. Every material has a matching depth
  material (same instancing + wind), so shadows sway with the plants.
* **Wind**: coherent travelling gusts across the landscape + per-plant sway + leaf flutter
  (`rv_flora_wind`), driven by `G.uWindDir / uWindStrength`; trunks bend less than branch tips.
* **Grass** (`grass.js`): GPU-instanced blade patches in three bands — dense (92 blades × 4
  segments, < ~11 m), mid (32 × 3, < ~20 m), far (26 × 2, to ~30–44 m; CPU-thinned, larger far).
  Each blade's centreline is a **quadratic Bézier** (stiff base, curving top; tall seed-stalk blades
  droop more), with a **per-blade taper profile** (slender spikes … broad blades), a **twist** along
  its length and Bézier-tangent normals. Travelling gusts, flutter, **player push** (blades bend
  away/flatten around `world.controller.pos`, wider for vehicles), per-blade hue/height/dryness,
  **field-scale colour** (rotated-domain noise, ~90 m / 25 m / 7 m: BotW-like swathes of green and
  dry grass, darker lush swales), pale sunlit tips, translucency, root AO, glowing tips on
  bioluminescent/fungal/giant worlds. Thinning ranks are a random permutation (uncorrelated with the
  blade's position) so thinning never shrinks a patch into a clump. No alpha test, no shimmer.
  Density = biome cover × soft patch noise (mostly continuous meadow, rare bare spots) × slope/rock/sand.
* **Placement** (`placement.js`, `flora.worker.js`): deterministic per cube-sphere cell from
  `SurfaceGen` (biome, moisture, temperature, slope, altitude, shore/lake/river): jittered grid ×
  biome cover × clustering noise (forests with clearings, groves in meadows) × species affinity
  (biome weights, moisture/temperature ranges, slope limit, altitude band, shore distance, zone
  noise so species form stands). All field noise is **rotated-domain gradient noise** (value noise
  on an axis-aligned lattice showed through as a grid/diamond pattern). Runs in 2–3 module Web Workers (main-thread time-sliced fallback);
  jobs are dispatched from worker callbacks so software-GL frame times never throttle streaming.
* **Streaming bands & LOD** (`index.js`):

  | band | cell | radius (high) | LODs |
  |---|---|---|---|
  | grass (+flowers) | ~18 m | ~48 m | dense patches < 13 m, sparse to 48 m (CPU-thinned, larger far) |
  | understory | ~64 m | ~150 m | LOD0 < 28 m, LOD1 with rank thinning |
  | rocks | ~128 m | ~600 m | LOD0 < 60 m, LOD1 |
  | canopy | ~160 m | ~840 m | LOD0 < 70 m → LOD1 < 180 m → impostors < 800 m |
  | far forest | ~1.1 km | 4.2 km | impostors only (½ density, 1.3× scale) |

  All transitions are complementary dithered crossfades; instances are re-bucketed on the CPU
  (one band per frame) as the camera moves. Impostors: each canopy model is baked at startup into a
  side + top view atlas (albedo·AO + normal/glow); far quads are lit with the same PBR +
  translucency model, blend to the top view from above, and a depth-only impostor pass gives
  mid-distance trees cheap sun shadows. Forests stay visible from altitude.
* **Canopy shading (round 2)**: leaf clusters shade with clump-level normals + clump-core AO
  (painted, volumetric clumps). **Leaf cards look up the sun shadow around the card centre** (footprint
  shrunk to 10 %) — per-pixel lookups on ~1.5 m cards with multi-cm cascade texels stair-stepped into
  the blocky "voxel" self-shadowing; shadow casters use a coarse mip of the leaf coverage (clump
  blobs). Leaf/bark relief uses a **texture-space gradient + screen-space cotangent frame**
  (`rvPerturb`) instead of `dFdx(texture)` bump (which produced 2×2-quad blocks). Bark: fibrous
  split/merge furrows and long vertical conifer plates (no cobblestone cells); trunks 10–12 sides.
* **Temporal dither**: all dithered LOD crossfades and leaf alpha edges shift with the TAA sub-frame
  index (`FLORA_DITHER`, updated in each layer's `onBeforeRender`), so TAA / shot supersampling
  resolves them into smooth fades and soft leaf edges.
* **Bioluminescence**: `PlantBuilder` records glow emitters (glow spheres/tubes, mushroom gill
  rings) and bakes an inverse-square **bounce-light attribute (`aGlowL`)** onto the plant's own
  trunk/leaves/caps, so glowing plants read as lit bodies at night. Glow solids are brightest facing
  the viewer (rim falloff). New **lantern tree** (W4): gnarled dark tree, weeping teal foliage, strings
  of hanging teardrop lanterns, a glowing vein spiralling up the trunk. Solids (caps, stalks, bulbs)
  get albedo/roughness breakup noise.
* **Colliders**: capsules for trees (trunk radius × scale), spheres for rocks > 0.45 m, registered
  per cell within ~260 m of the camera (removed in batches beyond ~420 m).
* **POIs**: rare legendary trees (≈0.35 % of canopy trees, 2.4× scale) are registered as
  `{kind:'wonder', minor:true, name:'Elder Oak of Varneth'|'World Tree of …'|…}` (unique names).
* **Clearings**: civ settlement clearings (`world.civ.clearings`, re-read on `civ:clearings`),
  `world.pois` of kind `'landing'`, and `flora.clearAround()` cull instances (keep fraction per
  clearing, deterministic per instance) in every band incl. colliders.
* **Flatten stamps**: `surface.onFlattenChange` is forwarded to the placement workers
  (`{type:'flats'}` → `gen.setFlattens`); cells overlapping a new stamp are re-placed and in-flight
  jobs from before the change are discarded, so trees sit on graded plazas/pads.
* **Near-camera dissolve**: foliage/branches within 2.6 m of the camera dither out.

* **Round 3 (critic round 1 follow-up)**:
  * **Turf carpet**: every grass patch now carries short single-triangle turf blades under the tall
    Bézier blades (dense 64 tall + 150 turf, mid 28 + 56, far 22 + 24); tall blades are ~30 % narrower,
    so meadows read as a fine continuous sward instead of wide daggers on bare soil.
  * **Sward shade** (`makeSwardDecal`, layer `flora-sward`): a soft multiplicative Gaussian disc under
    every near grass patch darkens the lit terrain between the stems (occlusion inside a real sward).
    Overlapping discs on the patch grid sum to a nearly uniform darkening with natural mottling; it
    fades with patch density and distance (< ~23 m). The disc is pulled toward the camera by
    `0.2 m / sin(elevation)` because the rendered CDLOD terrain deviates 10–20 cm from the analytic
    surface. Debug: `&floradbg=sward` (paints it red), `&floradbg=sward,nodepth`.
  * **No more lattice/stripes**: grass cells were filled with a nominal n×n grid stretched over the
    real (non-square, larger) cube-sphere cell, with full-cell jitter → rows of gaps that read as a
    striped/checkerboard meadow. Now the grid is sized per axis from the real cell extent and jitter
    is ±32 % of the spacing (patches are randomly rotated blade discs, so the grid never shows).
    Slope/rock thinning starts at 24°/rock 0.45 (terrain micro-ledges drew contour stripes), and the
    bare-ground threshold in sparse biomes is a soft ramp instead of a hard step.
  * **BotW oaks**: 85 % of broadleaf trees fork low (38–62 % of trunk height) into 2–3 S-curved
    leaders that spread into a wider, flatter-bottomed crown (clumps compressed below their centre);
    lower trunks (12 m, crown aspect 0.9). No more straight poles through lollipop crowns.
  * **Leaf clusters**: lobed, irregular cluster outlines with stray sprays past the silhouette, and no
    bright rim per card (each card had a bright outline → "popcorn/broccoli" canopies). Leaf
    roughness varies per leaf (sheen breakup instead of uniform plastic).
  * **Perf**: oak LOD0 cards −40 % (density 6.5 → 3.8, size 1.9 → 2.2), canopy LOD0 range 55–70 m →
    42–55 m, early discard (LOD fade / near dissolve / alpha) before the relief fetches. Measured in
    the lab on the W2 forest view: flora frame 54 s → ~28–38 s on the loaded software renderer.
  * **Night**: the tallest ~10 % of blades on glowing styles glow along their whole upper blade
    (curved light strokes, Pacific Drive style) instead of only tip dots.
  * **Flora lab** (`/src/world/flora/lab/`, dev only): the real flora subsystem on the real planet
    surface with a stand-in ground/sky/sun, captured in ~30–120 s instead of 4–8 min. See below.

## API (`world.get('flora')`)
* `.clearAround(pos, radius, keep = 0)` → id (cull vegetation in a disc around a planet-local
  position, e.g. a parked ship); `.removeClear(id)`.
* `.styleKey`, `.densityAt(dir)` (rough canopy cover 0..1), `.setVisible(bool)`,
  `.getState()` → `{style, ready, readyMs, cells:{band:"cells/jobs/ms"}, instances, drawCalls,
  trisM, top (heaviest layers), colliders}`.

## Capture URLs (verified this round at 960×540 unless noted; all render in ~3–5 min under load)
* W1 golden meadow (turf + sward shade, forked oaks, autumn trees): `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=16.122&lon=5.848&yaw=0&pitch=-2&tod=0.3`
* W2 forested hill + lake from the air (canopy shade, LOD1 → impostors → far forest): `/?mode=system&galaxy=0&star=11&planet=0&view=fly&alt=90&lat=-25.292&lon=-104.202&yaw=30&pitch=-8&tod=0.3`
* W2 noon meadow (steep TP view onto the sward, player push): `/?mode=system&galaxy=0&star=11&planet=0&view=surface&lat=-15.355&lon=146.556&yaw=0&pitch=-3&tod=0.5`
* W4 **bioluminescent lantern-tree forest at night** (glowing lantern trees, glow-stroke grass, glow
  mushrooms): `/?mode=system&galaxy=0&star=2&planet=0&view=surface&lat=16.36&lon=151.86&yaw=0&pitch=3&tod=0.02`
* W4 bioluminescent meadow at night from 4 m: `/?mode=system&galaxy=0&star=2&planet=0&view=fly&alt=4&lat=16.432&lon=151.962&yaw=150&pitch=-4&tod=0.02`
* W5 Rick & Morty jungle: `/?mode=system&galaxy=0&star=1&planet=2&view=surface&lat=31.786&lon=-28.943&yaw=22.5&pitch=-3&tod=0.42`
* W10 noon meadow on a terraced hillside: `/?mode=system&galaxy=0&star=17&planet=0&view=surface&lat=-15.355&lon=146.556&yaw=0&pitch=-2&tod=0.5`
* W11 Nausicaä fungus forest (shelf towers, spore trees, dense sward): `/?mode=system&galaxy=0&star=0&planet=0&view=surface&lat=7.276&lon=3.168&yaw=0&pitch=-3&tod=0.45`
* W2 forest interior (forked BotW oaks, ferns): `/?mode=system&galaxy=0&star=11&planet=0&view=surface&lat=-25.292&lon=-104.202&yaw=0&pitch=2&tod=0.33`
  — **heaviest view in the game on software GL**: ~45 s per frame on the loaded capture box, so
  the 4-sample shot often exceeds shoot.mjs' 180 s screenshot timeout (it did in round 1 too). Use
  the flora lab for this framing (below) or the aerial view.
* W2 capital clearing (ruins among the forest, civ clearings honoured): `/?mode=system&galaxy=0&star=11&planet=0&view=fly&alt=140&lat=6.45&lon=25.95&pitch=-18&tod=0.35`
* Debug: `&floradbg=nocast` (flora casts no shadows), `&floradbg=noreceive` (flora ignores shadows),
  `&floradbg=sward` (sward shade painted red), `sward,nodepth`, `grassnodepth`.
* Wind: `[{"advance":0.5},{"shot":"a.png"},{"advance":0.7},{"shot":"b.png"}]` on any view — grass and
  foliage move between frames.

### Flora lab (dev only, fast iteration)
`/src/world/flora/lab/?star=11&planet=0&lat=-25.292&lon=-104.202&yaw=0&pitch=2&h=2.2&back=4&sunel=30&sunaz=100`
— the real flora subsystem (workers, placement, LODs, impostors, grass, shades) on the real planet
surface; ground = biome-coloured mesh from `surface.sample`, gradient sky + PMREM, one 4096² sun
shadow map, exp fog. Params: `galaxy, star, planet, lat, lon, yaw, pitch, h` (camera height),
`back` (pull back along the view like the TP camera), `fov, sunel, sunaz` (sunel < −4 → night,
moonlight), `wind, exp, env, fog, full=1` (density 1 instead of the capture profile's 0.45),
`dens, hide=<layer name parts>` (e.g. `hide=oak-0,grass`), `atlas=1` (shows the leaf atlas).
`__rv.state()` reports flora stats + `renderMs` (GPU-synchronised frame time) — used to profile.
Lighting/ground differ from the game (no terrain material, no atmosphere/post), so final looks
must still be checked in-game.

## Performance (high)
* Flora ≈ 30–60 draw calls in the main pass (+2 this round: `flora-sward`, `flora-canopy-shade`).
  Shadow casters: canopy LOD0 < 26 m (was 38), big understory LOD0 < 22 m, rock LOD0, one
  near-impostor depth layer (20–800 m). Grass never casts. Canopy LOD0 < 34–44 m (was 55–70).
* Measured at the software-capture profile (floraDensity 0.45), round 3: W1 meadow 0.96 M tris
  (45 draws), W2 aerial 0.82 M (31), W4 lantern forest 2.2 M (44), W2 forest ≈ 2.0 M. Grass ≈ 0.75 M
  (dense 64 tall × 7 + 150 turf tris, mid 28 × 5 + 56, far 22 × 3 + 24 per patch); the two shade
  layers are ~20–100 k tris of trivially shaded discs.
* Frame cost is dominated by foliage fill on software GL (lab, W2 forest interior at 960×540:
  all flora 54 s → ~30–40 s after this round's card/LOD cuts; without the oaks 8.6 s). In-game the
  same view: whole frame ≈ 47 s, flora ≈ 31 s of it, flora shadow casting ≈ 11 s, LOD0 ≈ 14 s
  (measured before the LOD0/caster range cuts).
* Startup ≈ 1 s (atlas/bark/rock textures + ~30 models + glow bake + impostor bake). Initial streaming
  ≈ 20–35 s of worker time under the shared software-GL load (≈ 3–5 s on a normal machine).
* Everything scales with `quality.floraDensity` (spacing, grass density/radius) and
  `quality.drawDistance` (all LOD distances); `low` uses 1 variant per species, smaller atlases,
  fewer blades/segments.

## Known issues
* The dithered LOD1 → impostor crossfade (140–180 m) can leave a faint stipple in stills when only a
  few TAA sub-frames are accumulated.
* The sward/canopy shade discs are pulled toward the camera (≈ 0.2–0.3 m / sin(view elevation),
  capped) to ride on the CDLOD terrain; within that distance they also darken the lowest few cm of
  grass blades, boots and trunk bases (reads as contact AO). Large canopy-shade discs are planar,
  so over sharp crests/valleys they can cut into or float a little above the ground (soft, subtle).
* W10's hillside shows faint horizontal bands 5–15 m out: those are the terrain's terracettes
  (±0.5–0.8 m ledges at ~1 m scale in the analytic surface) seen at a grazing angle, not placement
  (instance dumps show uniform density/height there).
* The W2 forest-interior hero view is too heavy for the 180 s screenshot timeout on the shared
  software renderer (see Capture URLs); on a real GPU it is fine.
* Changing the placement noise (gradient instead of value noise) re-rolled species stands: forests
  at old showcase coordinates differ from round 1 (W2 surface spot is now an oak wood).
* Removing a clearing (`removeClear`) re-streams all cells (instances are compacted out on accept).

## Requests
* **terrain**: (done by terrain: meadow tint) — flora now also darkens the ground between stems
  itself (sward shade). Optional: expose the rendered CDLOD height (or the vertex `lod` used near the
  camera) so flora can root grass exactly on the drawn mesh instead of the analytic surface.
* **tools/lead**: `shoot.mjs` screenshot timeout (180 s) is shorter than one 4-sample frame of a
  dense forest on the loaded software renderer; a longer timeout (or `taas=1` for heavy scenes)
  would make forest-interior captures reliable.
* **player**: spawns sometimes land under a tree canopy; a spawn search that avoids
  `world.colliders` tagged `tree` within ~4 m would frame vistas better.
* **atmosphere**: foliage needs soft shadows — at 1024² cascades (capture profile) the 22–130 m
  cascade texel is ~20 cm. Flora now filters its own leaf-card lookups, but a larger PCF radius for
  the middle cascade (or PCSS) would help trunks/rocks too. Nights on W4 are near-black outside glow
  sources; a slightly stronger moonlit/night ambient would let glow-lit silhouettes read further.
* **post**: bloom radius on small emissive sources (lanterns, glow caps) is large relative to the
  source; a tighter bloom kernel / lower threshold weight for small bright discs keeps silhouettes.

### Done (from the inbox)
* civ clearings (`world.civ.clearings`, `civ:clearings` event) — honoured in all bands + colliders.
* vehicles: `flora.clearAround(pos, radius, keep)` + `world.pois` of kind `'landing'` honoured.
* terrain: flatten stamps forwarded to workers (`onFlattenChange` → `{type:'flats'}` →
  `gen.setFlattens`), affected cells re-placed.
* post: temporally-shifted dither (TAA sub-frame index) on crossfades and leaf alpha edges.
* player: tree capsules + rock spheres via `world.addCollider` (now also correct on high terrain).
* ui: unique legendary-tree names, `minor: true`.
* lead (perf): grass never casts; trees cast only near (LOD0 < 38 m + near-impostor depth layer);
  grass split into 3 bands (4/3/2 segments), impostors from 140–180 m, cheaper coral LODs.
