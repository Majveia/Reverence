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
    striped/checkerboard meadow. Now the grid is sized per axis from the real cell extent, jitter is
    ±32 % of the spacing, and blades inside a patch follow a truncated Gaussian (σ = 0.5 spacing,
    patch radius 1.25 spacing), so the overlapping patches sum to an even sward with no rows.
    Slope/rock thinning starts at 24°/rock 0.45 (terrain micro-ledges drew contour stripes), and the
    bare-ground threshold in sparse biomes is a soft ramp instead of a hard step.
  * **Canopy shade** (`shade.js`, layer `flora-canopy-shade`): a wide soft multiplicative disc under
    every canopy tree out to ~600 m — sky occlusion under the crown, plus (beyond ~70–180 m, where
    the cascaded shadow maps end) a fake cast shadow shifted away from the sun by 0.55·H·cot(sun
    elevation). Forest floors between crowns go dark, so forests read as volume from the air instead
    of trees on a lawn. Pulled toward the camera by 0.3 m/sin(elev) + 2 % of the distance (coarse
    far terrain LODs sit metres off the analytic surface). Debug: `&floradbg=cshade`.
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
    (curved light strokes, Pacific Drive style) instead of only tip dots; glow bounce on bark is
    modulated by the bark relief (lantern trunks keep their texture instead of flat teal tubes);
    new showcase framing inside a lantern-tree forest (W4 `lat=16.36&lon=151.86`).
  * **Flora lab** (`/src/world/flora/lab/`, dev only): the real flora subsystem on the real planet
    surface with a stand-in ground/sky/sun, captured in ~30–120 s instead of 4–8 min. See below.

* **Round 4 (critic round 2 follow-up)**:
  * **No more stipple / hatch**: (1) the dither used for LOD crossfades, leaf alpha edges and
    near-dissolve is now **stratified over 4 TAA sub-frames** (`rvDither = fract(IGN + k/4)`): every
    pixel steps through 4 evenly spaced thresholds, so the default 4-sample shot / TAA history
    resolves a fade to a uniform level instead of a frozen screen-door; (2) **shadow casters no
    longer dither** their distance fade (that hatch was projected by the sun onto every leaf and
    the ground): LOD0 casters and the near-impostor depth layer switch per instance at a hashed
    distance inside the band (`rvLodStep`), complementary; (3) leaf alpha jitter only on near
    cards (mip < 2.5) — far crowns use a clean threshold on the mipped coverage; (4) impostors
    **blend** side/top views instead of dithering between them; (5) narrower LOD1 → impostor band
    (148–172 m).
  * **Painterly crowns**: leaf-cluster cards get a **domed shading normal** (crown/clump normal +
    the card-local radial offset, `uDome`), so each cluster shades as a rounded mass; the
    shadow-map visibility on leaves is blended (`uLeafSoft` 0.55) with an **analytic crown-shell
    term** (outer sun-facing leaves lit, inner/lower leaves in the crown's own shade, still
    shadowed by other trees) → soft lit masses with bright rims and darker cores instead of a
    mosaic of lit/unlit cards; card shadow footprint 10 % → 30 %; leaf atlas lum = coherent
    dark-core → light-rim gradient with less per-leaf noise. Impostor bake uses the same domed
    normals.
  * **Dither final form**: the spatial phase of the dither is a 2×2 Bayer pattern (multiples of ¼),
    so over 4 sub-frames every pixel sees the identical threshold set → crossfades resolve
    spatially uniform (no IGN hatch even where LOD1 and impostors differ in tone).
  * **Impostor shadow casters** are pushed to the far side of the crown along the light (no
    self-shadow acne stripes on LOD1/impostor canopies).
  * **Fallen logs** (`PL.fallenLog`, lush + boreal forests): mossy half-sunk trunks with broken limb
    stubs and a closed root end — mid-scale forest-floor detail.
  * **Stands**: `rvStandTint` — low-frequency (~150–500 m) value/hue field per planet position on
    trees and impostors (warm yellow-green ↔ cool blue-green, ±13 % value): forests read as
    patches of stands. Canopy scale follows the cluster field (bigger trees in stand cores) and
    4.5 % of trees are emergent giants (×1.3–1.55).
  * **Grass**: per-blade height ×0.45–1.8 modulated by world-space tussocks (~2 m) and swales
    (~14 m); 7 % **seed-head stalks** (tall, slender, spindle spikelet in straw `S.grass.head`),
    13 % **broad-leaf blades** (2.3× wider, deeper blue-green, arching); root → tip gradient
    brighter; **two-octave hue field** (~25 m and ~2.5 m) between warm yellow-green and cool
    blue-green; turf carpet wider and denser (180/patch) and survives density thinning longer
    (sparse patches = short sward + few tall blades, not spikes on soil). **Player push** is a
    wide smooth falloff with a moderate bend and lifted AO (no dark radial stamp). Night glow
    tips vary in hue (`glowTip` ↔ `glowTip2` in drifting patches) and strength per blade.
  * **Flowers**: lush meadows add buttercup-yellow and violet-blue drifts, bigger heads,
    flowerAmt 0.3 → 0.42 (one variant per type when a style has > 3 types: draw calls).
  * **Bushes**: ~2× more, smaller cluster cards (domed) → soft leafy masses instead of faceted
    blobs.
  * **Trunks**: moss on up-facing limbs and in a damp band at the base, root collar darkening
    into the soil (no hard ground line).
  * **Alien solids**: thin-shell translucency on caps/balloons/bands (back-lit caps glow) and a
    velvet **sheen** rim (`uSheen`); gills darken toward the stem; gill/band/rib patterns are
    antialiased with distance (no shimmer).
  * **Lantern trees (W4)**: 4–7 smaller lanterns per limb, varied size and strength (30 % bright,
    most dim embers), teardrop with a dark calyx and bright belly; less glow bounce on leaves.
  * **Weather (inbox)**: `G.uWetness` darkens bark/solids/grass and lowers roughness (glossy wet
    leaves), `G.uSnow` settles on up-facing leaves, limbs, caps, rocks and grass tips.
  * **Inbox**: grass blades within ~0.5–1.5 m of the camera shrink away; glowing grass tips fade
    within 3 m of the lens.

* **Season 2, round 1 (Ghost of Yotei worlds, 20 Oct)**:
  * **Season regions** (terrain's `sample().season` map: 0 spring green · ⅓ blossom · ⅔ gold · 1 crimson).
    Every placed instance packs its season into the tint slot (`placement.js packSeason`: round(s·64) +
    tint·0.98; GLSL `rvSeasonOf / rvTintOf`), and every consumer uses the **same ramp interpolation the
    terrain paints with** (`seaRamp`), so trees, grass, flowers, petals and the ground agree, including on
    region borders and in the great mountain's green forest belt. `FLORA_SEASON` = `surface.seasonAmt` ×
    the style's weight (`S.season`: lush 1, boreal 0.8, sparse 0.75, moss 0.7, giant 0.45, alien styles 0);
    `&fseason=0..1` overrides it.
  * **Seasonal trees** (`styles.js`): **cherry** (low, wide, gnarled, pink-white bloom; one variant is a
    **weeping** shidare-zakura with curtains of bloom strands, `broadleaf` `weep`), **maple** (palmate
    crimson/orange) and **ginkgo** (tall, upright golden fans) grow in their regions (`sp.sea =
    [centre, width, strength]`); generic oaks/conifers give way to ~45 % there, and generic broadleaf
    crowns + bushes **turn with the region** (`rvSeasonLeaf`: fresh green → ginkgo/larch gold → maple
    reds), on meshes and impostors alike (impostor normal.a now bakes a leaf mask; `dims.w` carries the
    season flag), so far forests take the season too (terrain request).
  * **New atlas cells** (atlas is now 5 × 4): `blossom` (five-petal sprays on dark twigs), `maple`
    (palmate leaves), `ginkgo` (notched fans), `lily` (red spider lily umbels with long stamens).
  * **Seasonal fields** (`grass.js`): gold regions grow **pampas / susuki** (blades 1.65× taller and
    narrower, 40 % seed stalks with long feathery cream-gold **plumes** on the top 40 % that glow when
    back-lit, matte, straw-gold leaves); crimson regions a **russet autumn sward**; blossom regions fresh
    green over a **carpet of fallen petals** in the turf. **Red spider lilies** (and blossom-time white /
    pink flowers) grow in **masses of 30–200 m** that are one species (`mass` flowers, noise-masked),
    not a scatter. Daisies got greener, thicker stems and a leaf rosette.
  * **Wind as a living force**: the grass now carries the terrain's long travelling wave (`g3`, same
    formula as the terrain's far-field sheen) on top of the gusts: gust fronts lay the field over and
    show the blades' pale, silvery (in season fields: gold) sides as bands sweeping across the meadow.
  * **Drifting petals and leaves** (`petals.js`, 2 draws): a camera-centred GPU volume (near cube 22 m,
    2600 petals; far cube 70 m, 2200 specks; × quality) that wraps in planet-local space, rides the
    shared wind (integrated in float64), swirls, surges in the gust bands and tumbles. What blows comes
    from the season at the camera: cherry petals (pink/white), maple leaves (crimson/orange), ginkgo
    fans + pampas fluff (gold), white seed fluff in green meadows; glowing spores on alien styles
    (night-lit), confetti petals on `wacky`, warm motes of light near the World Tree. Thins out above
    ~25–115 m altitude. `player:slash` throws a flurry of petals from the cut.
  * **The World Tree of light** (`sacred.js`, `geom/worldtree.js`): one per world at the terrain's
    sacred `tree` site (`landmarks.sacred[kind='tree']`): ~195 m tall (× planet size), a braided trunk of
    four strands over eleven arching roots, six–seven great limbs into a 220 m dome of deep jade/bronze
    foliage with ~24 % gold **light-cards**, curtains of glowing strands, **veins of light** up the trunk
    grooves and along the limbs (glow solids; `uDayGlow` keeps them lit by day, they blaze at night).
    Visible from kilometres (one always-on draw, ~18 k tris, casts shadows < 3 km). Trunk capsule
    collider, `{kind:'wonder', name:'The World Tree'}` POI, and a clearing of trees/bushes under the
    crown that keeps the meadow (`clearAround(..., {grass:false})`). Palette per style (teal on
    bioluminescent, violet on fungal, ice-blue on crystal…).
  * **Katana cuts** (inbox, player): `player:slash` {pos, dir, radius, kind} → a cut list of 8 discs
    (`FLORA_CUTS`); grass inside is shorn to ~16 % and flowers lose their heads, regrowing after 25 s over
    ~20 s; the iai bloom cuts wider.
  * **Grass off bare ground and scree** (inbox, terrain): `sample().bare` and `.talus` (incl. the
    volcano's ash band) now thin grass (they were not read before).
  * **Fewer fallen logs** (critic): density 0.16 → 0.07.

## API (`world.get('flora')`)
* `.clearAround(pos, radius, keep = 0, {grass = true})` → id (cull vegetation in a disc around a
  planet-local position, e.g. a parked ship; `grass: false` keeps the meadow); `.removeClear(id)`.
* `.sacred` (World Tree: `.pos` planet-local base, `.getState()` {lat, lon, height, crownR}), `.petals`,
  `.seasonAmt`. Events consumed: `player:slash`.
* `.styleKey`, `.densityAt(dir)` (rough canopy cover 0..1), `.setVisible(bool)`,
  `.getState()` → `{style, ready, readyMs, cells:{band:"cells/jobs/ms"}, instances, drawCalls,
  trisM, top (heaviest layers), colliders, season, worldTree, petals {amount, shape}, cuts}`.

## Capture URLs — season 2 round 1 (verified at 960×540, ~3–5 min each under load)
Captures: `scratchpad/shots2/flora/` (a*, b*). W1 = `star=6&planet=1` (Niotolon: volcano at 17.777 / 13.2736,
World Tree at 13.9842 / 25.987).
* **W1 ridge facing the volcano over a valley of cherry blossom** (ginkgo, white/pink blossom-time
  flowers, petals and leaves on the wind, floating isles): `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=16.6718&lon=25.7718&yaw=277&pitch=9&tod=0.3&props=0`
* **W1 the World Tree at dusk, the volcano behind** (silhouette with light-cards and strands of light):
  `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=110&lat=13.978&lon=26.62&yaw=271&pitch=7&tod=0.755&disable=fauna,vehicles`
* **W1 the World Tree of light at night under the Milky Way**: same with `tod=0.02`.
* **W1 crimson coast: maples, red spider lilies, leaves blowing out to sea**: `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=5&lat=13.7035&lon=27.595&yaw=250&pitch=-2&tod=0.3&disable=fauna,vehicles`
* **W1 gold pampas field with ginkgo** (front-lit): `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=15.43&lon=25.9&yaw=282.7&pitch=8&tod=0.31&props=0`
* **W2 a forest of cherry blossom from the air** (one-hue biome, lake): `/?mode=system&galaxy=0&star=11&planet=0&view=fly&alt=90&lat=-25.292&lon=-104.202&yaw=30&pitch=-8&tod=0.3`
* W4 lantern forest at night (unchanged look + glowing spores): `/?mode=system&galaxy=0&star=2&planet=0&view=surface&lat=16.36&lon=151.86&yaw=0&pitch=3&tod=0.02`
* Debug: `&floradbg=season` (grass painted by season membership: red crimson, green gold, blue blossom),
  `&fseason=0..1` (override the season strength), `&floradbg=nopetals`, `&floradbg=hide:worldtree`.
* Season maps / viewpoints were found with small node scripts over `SurfaceGen` (`sample().season`,
  `landmarks`): see `scratchpad/season.mjs`, `vf.mjs`, `vf2.mjs` (not in the repo).

## Capture URLs (verified round 4 at 1280×720 with the default 4 TAA shot samples, ~2–3 min each)
Round 4 finals: `scratchpad/shots/flora/r4/final_*.png`. `taas=2` is no longer needed (and should not
be used: the stratified dither resolves exactly over 4 sub-frames).
* W2 forest interior, golden hour: `/?mode=system&galaxy=0&star=11&planet=0&view=surface&lat=-25.292&lon=-104.202&yaw=0&pitch=2&tod=0.33`
* W11 Nausicaä fungus forest: `/?mode=system&galaxy=0&star=0&planet=0&view=surface&lat=7.276&lon=3.168&yaw=0&pitch=-3&tod=0.45
* W1 golden meadow (turf + sward shade, forked oaks, autumn trees): `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=16.122&lon=5.848&yaw=0&pitch=-2&tod=0.3`
* W2 forested hill + lake from the air (canopy shade, LOD1 → impostors → far forest): `/?mode=system&galaxy=0&star=11&planet=0&view=fly&alt=90&lat=-25.292&lon=-104.202&yaw=30&pitch=-8&tod=0.3`
* W2 noon meadow (steep TP view onto the sward, player push): `/?mode=system&galaxy=0&star=11&planet=0&view=surface&lat=-15.355&lon=146.556&yaw=0&pitch=-3&tod=0.5`
* W4 **bioluminescent lantern-tree forest at night** (glowing lantern trees, glow-stroke grass, glow
  mushrooms): `/?mode=system&galaxy=0&star=2&planet=0&view=surface&lat=16.36&lon=151.86&yaw=0&pitch=3&tod=0.02`
* W4 bioluminescent meadow at night from 4 m: `/?mode=system&galaxy=0&star=2&planet=0&view=fly&alt=4&lat=16.432&lon=151.962&yaw=150&pitch=-4&tod=0.02`
* W5 Rick & Morty jungle: `/?mode=system&galaxy=0&star=1&planet=2&view=surface&lat=31.786&lon=-28.943&yaw=22.5&pitch=-3&tod=0.42`
* W10 noon meadow on a terraced hillside: `/?mode=system&galaxy=0&star=17&planet=0&view=surface&lat=-15.355&lon=146.556&yaw=0&pitch=-2&tod=0.5`
* W2 capital clearing (ruins among the forest, civ clearings honoured): `/?mode=system&galaxy=0&star=11&planet=0&view=fly&alt=140&lat=6.45&lon=25.95&pitch=-18&tod=0.35`
* Debug: `&floradbg=hide:bush+log` (hide layers whose name contains a part), `&floradbg=nocast` (flora casts no shadows), `&floradbg=noreceive` (flora ignores shadows),
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
* Round 4, measured at 1280×720 in-game (capture profile, floraDensity 0.45): W1 meadow 43 draws /
  0.97 M tris, W2 forest 57 / 1.83 M, W2 aerial 32 / 0.79 M, W2 noon 54 / 1.1 M, W4 night 45 /
  2.27 M, W5 62 / 1.98 M, W10 44 / 1.08 M, W11 48 / 2.25 M (whole scenes 200–300 draws, other
  tracks included). New this round: +2 under species layers per style with logs, dense grass
  patch +30 turf triangles, bush LOD0 ≈ 2× cards (2 tris each); LOD0 understory to 24–32 m.
  Shader cost: leaf fragments add one 4-tap normal dome + the crown-shell blend (ALU only);
  impostors fetch side + top views (2 extra fetches) only inside the 0.62–0.9 elevation blend.
* Flora ≈ 30–60 draw calls in the main pass (+2 this round: `flora-sward`, `flora-canopy-shade`).
  Shadow casters: canopy LOD0 < 26 m (was 38), big understory LOD0 < 22 m, rock LOD0, one
  near-impostor depth layer (20–800 m). Grass never casts. Canopy LOD0 < 34–44 m (was 55–70).
* Measured at the software-capture profile (floraDensity 0.45), round 3: W1 meadow 0.96 M tris
  (45 draws), W2 aerial 0.82 M (31), W4 lantern forest 2.2 M (44), W11 fungal 2.25 M (48), W2 forest ≈ 2.0 M. Grass ≈ 0.75 M
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
* Open after season 2 (the round 2 critic, 20 Oct: 4.3 → 6.0/10, blind 2/4 → 3/4; the track's season-2 rounds are
  used up, so these lead the next pass): the ridge shot (small caped figure, wind-bent grass, ginkgo frame, volcano,
  floating isles, blossom valley, drifting leaves), the night lantern forest and the red maples with spider lilies read
  as a polished stylised game, and the blind judges took the blossom valley with the castle, the rainy lantern night
  and the backlit dusk pairs. Still open: the World Tree reads as a tiny flat mushroom-cap blob at distance instead of
  a landmark that stops the player, and its dusk version is a dark unlit hill; the camera can enter tree crowns, where
  the dither shows as concentric rings and a flat screen door; the foreground grass is a few giant flat blades rather
  than a dense travelling wind sea; crowns are low-poly cut-out clumps with hard alpha edges and visible dither dots;
  distant impostors read as confetti dots; the night forest lacks scale and a sky moment; the volcano is small, hazy
  or hidden in flora-led shots. The pair lost went to a reference with volumetric clouds, haze and a muted grade.
* (S2 r1) The World Tree is one mesh without LODs (~18 k tris, ~2.8 k large cards): cheap far away, but
  the card fill is heavy when the camera is inside its crown. Its day look is a dark jade dome with gold
  light-cards; it reads best at dusk / night (a pale "cauliflower" by noon from above).
* (S2 r1) W1's sacred tree site sits on a coastal hill behind a ridge: from the default spawn and most
  ground viewpoints it is hidden; the fly views above frame it (see Requests).
* (S2 r1) Pampas plumes and lily masses exist only inside the grass band (~30 m at the capture profile,
  ~44 m on high); beyond, the terrain's season colour carries the field. Grass inside the great
  mountain's forest belt is in-between seasons (the generator pulls the season toward green there).
* (S2 r1) Leaf-card crowns (maple, cherry) still show cut-out card edges against the sky up close.
* (S2 r1) `tools/check.mjs` system-surface can exceed its 180 s readiness timeout when other captures
  run at the same time (flora ready ≈ 100–135 s under load); it passes when run alone.
* Residual dither: a 4-sample shot resolves dithered fades uniformly, but the TAA sub-pixel jitter
  moves crossfading geometry slightly between sub-frames, so a very faint fine checker can remain
  on trees inside the LOD1 → impostor band (148–172 m); `taas=2` or no TAA shows the raw 2×2
  ordered dither.
* Ground showing between short turf on worlds whose terrain paints forest/jungle floors as dirt
  (W5): the sward can only darken the ground (multiplicative), it cannot recolour it.
* Night ground fog / volumetric haze around glowing forests (Pacific Drive look) is the
  atmosphere track's; the big green out-of-focus discs in W4 night views are not flora (grass
  glow now fades within 3 m of the lens).
* The dithered LOD1 → impostor crossfade (140–180 m) can leave a faint stipple in stills when only a
  few TAA sub-frames are accumulated.
* The sward/canopy shade discs are pulled toward the camera (≈ 0.2–0.3 m / sin(view elevation),
  capped) to ride on the CDLOD terrain; within that distance they also darken the lowest few cm of
  grass blades, boots and trunk bases (reads as contact AO). Large canopy-shade discs are planar,
  so over sharp crests/valleys they can cut into or float a little above the ground (soft, subtle).
* W10's hillside shows faint horizontal bands 5–15 m out: those are the terrain's terracettes
  (±0.5–0.8 m ledges at ~1 m scale in the analytic surface) seen at a grazing angle, not placement
  (instance dumps show uniform density/height there).
* Changing the placement noise (gradient instead of value noise) re-rolled species stands: forests
  at old showcase coordinates differ from round 1 (W2 surface spot is now an oak wood).
* Removing a clearing (`removeClear`) re-streams all cells (instances are compacted out on accept).

## Requests
* **terrain** (S2 r1): pick the sacred `tree` site where it is seen from the spawn / the mountain view
  (open ground, no ridge between), or expose `landmarks.views.tree` {lat, lon, yaw, pitch} like the
  arch view, so the World Tree can be framed from the ground (ideally through the arch).
* **player** (S2 r1): in tall season fields (pampas 1–1.6 m) the TP camera sits inside the grass; a
  higher, pulled-back camera option (`cam=far`, 8–12 m, figure ≈ 5 % of the frame height) would give
  the "small figure in a vast field" frames; `view=surface` spawns via `_flatSpot` often face a slope.
* **atmosphere / post** (S2 r1): at night the World Tree (`world.get('flora').sacred.pos`, ~200 m tall)
  could light the ground and haze around it (a warm in-scatter / point light), and a wide, soft bloom
  on its light-cards would turn it into the luminous mist of the reference frames.
* **terrain** (round 4): on worlds whose flora grass cover is high in FOREST/JUNGLE (e.g. W5
  `wacky`, W11 `fungal`), tint those floors toward the palette grass colour too (the meadow tint
  only covers grassland): `world.get('flora')?.S.grass.cover[biome]` gives flora's grass cover per
  biome; between short turf the brown dirt otherwise shows through.
* **atmosphere** (round 4): height fog / in-scatter at night around W4's glowing forest (teal
  haze so the tree line fades), and stronger aerial perspective on far forests (W2 aerial).
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
* (round 4) cloud shadows via `lighting.setupMaterial` (auto-applied), `G.uWetness` + `G.uSnow` on
  every flora material (plants, grass, rocks); grass shrinks within ~1.5 m of the camera; glowing
  grass tips fade within 3 m of the lens; golden-hour wrap/translucency on grass and foliage use the
  actual key light (RE_Direct), so they follow `uSunDir/uSunColor`; W3 "needle spikes"
  (`lat=22.571&lon=56.286`) re-checked: the spot is open dune sand with no flora spikes now.
* civ clearings (`world.civ.clearings`, `civ:clearings` event) — honoured in all bands + colliders.
* vehicles: `flora.clearAround(pos, radius, keep)` + `world.pois` of kind `'landing'` honoured.
* terrain: flatten stamps forwarded to workers (`onFlattenChange` → `{type:'flats'}` →
  `gen.setFlattens`), affected cells re-placed.
* post: temporally-shifted dither (TAA sub-frame index) on crossfades and leaf alpha edges.
* player: tree capsules + rock spheres via `world.addCollider` (now also correct on high terrain).
* ui: unique legendary-tree names, `minor: true`.
* lead (perf): grass never casts; trees cast only near (LOD0 < 38 m + near-impostor depth layer);
  grass split into 3 bands (4/3/2 segments), impostors from 140–180 m, cheaper coral LODs.
