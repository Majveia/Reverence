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
* **Grass** (`grass.js`): GPU-instanced blade patches (64 blades × 4 segments near, 26 × 2 far),
  curved blades, travelling gusts, flutter, **player push** (blades bend away and flatten around
  `world.controller.pos` / `world.player.pos`, wider for vehicles), per-blade hue/height/dryness
  variation, macro colour noise, sunlit pale tips, translucency, root AO, glowing tips on
  bioluminescent/fungal/giant worlds (subset of blades, pulsing). No alpha test (real geometry),
  blades widen and thin with distance → no shimmer. Density from biome cover × patch noise × slope
  × rock × sand; flowers drift through meadows.
* **Placement** (`placement.js`, `flora.worker.js`): deterministic per cube-sphere cell from
  `SurfaceGen` (biome, moisture, temperature, slope, altitude, shore/lake/river): jittered grid ×
  biome cover × clustering noise (forests with clearings, groves in meadows) × species affinity
  (biome weights, moisture/temperature ranges, slope limit, altitude band, shore distance, zone
  noise so species form stands). Runs in 2–3 module Web Workers (main-thread time-sliced fallback);
  jobs are dispatched from worker callbacks so software-GL frame times never throttle streaming.
* **Streaming bands & LOD** (`index.js`):

  | band | cell | radius (high) | LODs |
  |---|---|---|---|
  | grass (+flowers) | ~18 m | ~48 m | dense patches < 13 m, sparse to 48 m (CPU-thinned, larger far) |
  | understory | ~64 m | ~150 m | LOD0 < 28 m, LOD1 with rank thinning |
  | rocks | ~128 m | ~600 m | LOD0 < 60 m, LOD1 |
  | canopy | ~160 m | ~840 m | LOD0 < 70 m → LOD1 < 240 m → impostors < 800 m |
  | far forest | ~1.1 km | 4.2 km | impostors only (½ density, 1.3× scale) |

  All transitions are complementary dithered crossfades; instances are re-bucketed on the CPU
  (one band per frame) as the camera moves. Impostors: each canopy model is baked at startup into a
  side + top view atlas (albedo·AO + normal/glow); far quads are lit with the same PBR +
  translucency model, blend to the top view from above, and a depth-only impostor pass gives
  mid-distance trees cheap sun shadows. Forests stay visible from altitude.
* **Colliders**: capsules for trees (trunk radius × scale), spheres for rocks > 0.45 m, registered
  per cell within ~260 m of the camera (removed in batches beyond ~420 m).
* **POIs**: rare legendary trees (≈0.35 % of canopy trees, 2.4× scale) are registered as
  `{kind:'wonder', name:'Elder Oak'|'World Tree'|'Spore Titan'|…}`.
* **Near-camera dissolve**: foliage/branches within 2.6 m of the camera dither out.

## API (`world.get('flora')`)
* `.styleKey`, `.densityAt(dir)` (rough canopy cover 0..1), `.setVisible(bool)`,
  `.getState()` → `{style, ready, readyMs, cells:{band:"cells/jobs/ms"}, instances, drawCalls,
  trisM, top (heaviest layers), colliders}`.

## Capture URLs (verified at 1280×720 unless noted)
* W2 BotW forest meadow, daisies, golden hour: `/?mode=system&galaxy=0&star=11&planet=0&view=surface&lat=-25.292&lon=-104.202&yaw=0&pitch=2&tod=0.33`
* W2 forested hill from the air (LOD1 → impostors → far forest): `/?mode=system&galaxy=0&star=11&planet=0&view=fly&alt=90&lat=-25.292&lon=-104.202&yaw=30&pitch=-8&tod=0.3`
* W2 forest from 350 m: `/?mode=system&galaxy=0&star=11&planet=0&view=fly&alt=350&lat=-11.521&lon=118.007&yaw=67.5&pitch=-14&tod=0.35` (960×540)
* W2 noon meadow on a slope: `/?mode=system&galaxy=0&star=11&planet=0&view=surface&lat=-15.355&lon=146.556&yaw=0&pitch=-3&tod=0.5` (960×540)
* W1 golden meadow + oaks + boulder: `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=16.122&lon=5.848&yaw=0&pitch=-2&tod=0.3`
* W1 shore with reeds/cattails: `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=-14.085&lon=103.544&yaw=270&pitch=-4&tod=0.34` (960×540)
* W5 Rick & Morty jungle: `/?mode=system&galaxy=0&star=1&planet=2&view=surface&lat=31.786&lon=-28.943&yaw=22.5&pitch=-3&tod=0.42`
* W11 Nausicaä fungus forest: `/?mode=system&galaxy=0&star=0&planet=0&view=surface&lat=7.276&lon=3.168&yaw=0&pitch=-3&tod=0.45`
* W10 boreal meadow + spruces: `/?mode=system&galaxy=0&star=17&planet=0&view=surface&lat=-15.355&lon=146.556&yaw=0&pitch=-2&tod=0.32` (960×540)
* W4 bioluminescent night (lantern trees, glow mushrooms, bulbs, glowing grass): `/?mode=system&galaxy=0&star=2&planet=0&view=surface&lat=16.432&lon=151.962&yaw=202.5&pitch=-2&tod=0.02`
* Wind: `[{"advance":0.5},{"shot":"a.png"},{"advance":0.7},{"shot":"b.png"}]` on any view — grass and
  foliage move between frames.

## Performance (high)
* Flora ≈ 40–60 draw calls in the main pass (+ shadow casters: canopy LOD0 < 38 m, big understory
  LOD0 < 22 m, rock LOD0, one near-impostor depth layer that shadows every tree from 30 m to 800 m),
  ≈ 2.5–3.7 M triangles in a dense forest (grass ≈ 1.3 M of that; spruce LOD0 ≈ 2.8 k tris).
* Startup ≈ 0.8 s (atlas/bark/rock textures + ~30 models + impostor bake). Initial streaming
  ≈ 17–25 s of worker time under the shared software-GL load (≈ 3–5 s on a normal machine).
* Everything scales with `quality.floraDensity` (spacing, grass density/radius) and
  `quality.drawDistance` (all LOD distances); `low` uses 1 variant per species, smaller atlases,
  fewer blades.

## Known issues
* Leaf cards alias at their alpha-tested edges when MSAA is off (alpha-to-coverage is enabled when
  `quality.msaa > 0`).
* Mesh LOD0 → LOD1 swaps can show a brief dither band.
* Far impostor density (½, scaled 1.3×) differs slightly from near forests at ~800 m (hidden by haze).
* The player can spawn under a tree (the near-camera dissolve keeps the view readable).

## Requests
* **core / lead**: the shared dev server on :5173 does not pick up new `src/world/*/index.js`
  folders (its `import.meta.glob` list is stale — flora was invisible there). Please restart it
  after merging. My captures used a private vite on :5188.
* **terrain**: a grass-coloured ground tint under dense grass (e.g. read `biome` + moisture like
  flora does) would make meadows look denser at mid distance.
* **player**: spawns sometimes land under a tree canopy (camera behind branches); flora dissolves
  foliage within 3.2 m of the camera, but a spawn search that avoids `world.colliders` tagged
  `tree` within ~4 m would frame vistas better.
* **post**: foliage uses alpha-to-coverage when `quality.msaa > 0`; if the HDR pipeline renders
  without MSAA (software captures), leaf/grass edges alias — TAA/SMAA would clean them up.
