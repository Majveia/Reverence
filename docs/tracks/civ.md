# Civ track — settlements, architecture, art & lights

Owner paths: `src/world/civ/**`, this file. Subsystem `civ`, order 35.

## What was built

| file | role |
|---|---|
| `index.js` | subsystem: planning, streaming (far LOD ⇄ detail), time-sliced builds, colliders, POIs, glow sprites, life, state |
| `planner.js` | deterministic site selection from `body.civ.placeSeed`: capital 0.7–2 km ahead of the default spawn (replicates `Player._findLand` + yaw 30°, line-of-sight scored), a hamlet 170–350 m from the spawn, then flat / dry / temperate / coastal sites (a ring of neighbours 3–16 km from the capital, the rest around the globe) |
| `layout.js` | per-site plan in the tangent plane: plaza, organic spokes + rings + branching lanes (medieval styles) or a rotated grid (modern styles), lots along roads (front faces the street, second rows behind, terrain-checked, bit-mask occupancy), infill (farms, gardens, mills), lamps, market stalls, NPC walk segments; water styles build on decks over the sea |
| `geo.js` | `Geo` builder: chamfered boxes, frustums, lathes, domes, gable / hip roofs, prisms, tubes, panels; packs albedo/rough/metal/emission/pattern per vertex (u8), window-cell UVs, glow sprites and collider boxes |
| `material.js` | civ uber-material (MeshStandardMaterial + onBeforeCompile): analytic, AA'd patterns — windows (lit at night per window, per-location night factor from the sun, lampshade gradient), curtain glass, arched & slit windows, planks, ashlar stone (+moss), metal panels (+rust), roof tiles, thatch, corrugated metal, cobbles, flagstones, asphalt with lane paint, dirt ruts, glowing glyphs, board-formed concrete, canvas (backlit at night), crystal (fresnel glow), neon, holograms (scanlines/glitch); bump from pattern height; weathering (macro grime, rain streaks, base contact AO, snow on up-facing, wetness); warm street-level bounce at night. Vertex-animation variants for NPCs / traffic / boats. Additive glow-sprite material (min-pixel size so lights read from orbit) |
| `styles.js` | architecture kits: **village** (Ghibli/Bierstadt cottages, timber frames, jettied upper floors, L-wings, dormers, fences, gardens, barns, windmills, bell-tower church), **hearth** (Outer Wilds plank cabins with porches, lookouts, observatory with telescope, wooden launch tower + ship), **harbor**, **spire** (Moebius domed adobe + slender white bulb towers, needle landmark), **neon** (Blade Runner towers with podiums, setbacks, neon bands, holo billboards, vertical signs, AC units, stepped arcology landmark), **industrial** (Stålenhag: Falu-red houses, corrugated sheds, saw-tooth brick factories with chimneys, cooling towers, silos, pylons, container stacks, radar-dish landmark), **organic** (Roger Dean pods on stems, arches, great arch), **monastery** (white walls, onion domes, chapels, cathedral + bell tower), **ruins** (BotW: mossy shells, broken towers, colonnades, decayed guardians, glowing shrines, ruined citadel with glowing core; living thatched huts), **nomad** (Nausicaä tents, yurts, wagons, Valley-of-the-Wind windmills, pennant poles), **frontier** (Bebop saloons with false fronts + neon, water towers, landing pads + ship), **outpost/nasapunk** (habitat capsules, glass domes, pads, comm tower), **brutalist** (ziggurat monoliths, slit windows), **crystal**, **monolith**, **bizarre** (blob houses, eyeball towers, portals) |
| `parts.js` | shared parts: doors, timber frames, chimneys, flower boxes, balconies, awnings, antennas, dishes, pipes, signs, 4 lamp types, trees, fences, stalls, clutter, catenary cables with lanterns, windmill, lattice towers, colossal statue, obelisk, beacon, arch |
| `life.js` | GPU-animated walkers (gait, arm swing, idle, ~40 % carry a swaying hand lantern that glows at night), flying traffic on looping lanes (hover cars / gliders / wooden ships), bobbing boats, space elevator (screen-space tether ≥1.4 px, climbers, beacons) |
| `camera.js` | `civcam` capture presets: computes a framing from the settlement's own layout (plaza, landmark, roads, lots) at create time and writes the player's spawn params before the player spawns — capture URLs no longer go stale when terrain changes |
| `pools.js` | ground light pools under every low light (street lamps, lanterns, shopfronts, blade signs): one additive draw per site; on wet ground (`G.uWetness`) each pool stretches into a reflection streak toward the camera (neon on wet asphalt) |

### Round 3 changes (critic round 1, second pass)
* **Robust capture framing: `&civcam=plaza|street|hero|aerial|top|edge` (+ `&civsite=<id>`)** — settlement positions follow
  the terrain + predicted spawn, so the round-2 lat/lon table went stale again when the terrain track changed its relief (the
  W1 capital moved from lat 7.3 to 14.9; the critic's "0 tris" URL pointed at empty land). `camera.js` now derives the camera
  from the site's layout at create time and writes `lat/lon/yaw/camyaw/pitch/alt/view/flat` into the shared params before the
  player (order 50) reads them; explicit URL params still win. Presets:
  `plaza` eye level where a main road enters the plaza, looking across the centrepiece to the landmark;
  `street` eye level on the road whose view has the most facades on BOTH sides (a street canyon, not a path over a meadow);
  `hero` ≈28 m over the plaza rim, choosing the rim angle with no building in the lens' way; `aerial` a low oblique establishing
  shot (under the cloud deck) from the side with a clear line of sight; `top` 110 m straight above the centre; `edge`
  third-person on the road just outside town. All presets prefer viewpoints with a flat, open patch *behind* the lens, where
  the vehicles track parks the starship/bike/rover (they no longer drift into the frame); `props=0` is set for them too.
* **Round-1 critical "capital renders 0 tris at night from 110 m"** — verified with `civcam=top&tod=0.05` on W1:
  `siteTris {0: 277k}`, lit town. The old URL simply no longer pointed at the capital. `__rv.state().civ` also reports
  `siteLots`, `readyMs`, `civcam`.
* **Neon street at night** — the beige wash that covered the street floor was the additive light pools summing up (1600
  overlapping skirts × wet stretch ≈ 32 m); pools are now compact lit discs under each lamp/shopfront with a narrow wet
  reflection streak that follows Fresnel (bright only at grazing angles, not under the viewer). Street floors get canyon sky
  occlusion (env diffuse + a horizon-occluded env reflection, so a wet street mirrors the dark lit facades instead of the open sky).
  No uniform warm bounce on the road mesh.
* **Shopfronts** — new `PAT.SHOP`: lit interiors behind glass with shelves of coloured goods or counters + menu boards,
  ceiling light strips, customer / shopkeeper silhouettes, glass streaks (was a flat emissive colour block).
* **Holo billboards** — ad content: paged glyph copy, rotating logo roundel, two-tone sweep (was a flat coloured sheet).
* **Window lights** — lights come on per room (runs of 2–4 windows share a light), some floors are dark offices, rare TV-blue
  flicker; resolved windows show a ceiling-lamp hotspot, furniture silhouettes and occasional people. Facades read as lived-in
  rooms instead of a per-window checkerboard.
* **Pedestrians** — anatomical walkers (shoes, tapered legs, hips, tapered torso, rounded shoulders, arms with hands, neck,
  head + hair cap, style hats), children (~10 %), same GPU gait. Clearly readable at street level in day and night shots.
* **Glow sprites** fade out within ~3–9 m of the lens (no giant bokeh discs from a lamp next to the camera).
* **Site selection** — the civic heart (plaza + first blocks, 8–26 % of the radius) must be dry land for non-water styles
  (W2's capital plaza used to sit in a lagoon ring of shore foam).
* **Debug** — `civdbg=noroads|nopools|nobld|noglow|nonpc` hide those layers (diagnostics).

### Round 2 changes (critic round 1 fixes)
* **Build validation / diagnostics** — every detailed site now records its triangle count; an empty build is logged
  (`[civ] site … built empty: lots=… lotFails=…`) and counted instead of silently shown as built; failing lot builds and
  failing jobs are counted (`fails`, first message in `err`); a failing detail job backs off 10 s instead of rebuilding
  every frame (and no longer blocks `isReady()` forever). `__rv.state().civ` now reports **live** numbers for the
  currently detailed sites: `tris`, `siteTris {id: tris}`, `npcs`, `traffic`, `boats`, plus `trisBuilt` (cumulative),
  `fails`, `err`. `update()` can never throw into the frame loop. (The round-1 "capital with 0 tris" capture could not be
  reproduced with the current tree — same URL renders the town with 515 k tris; the old `tris` counter was cumulative and
  global, which the new per-site counters make unambiguous.)
* **Terrain grading** — each settlement's plaza / monument terrace is graded into the hillside with the terrain track's
  flatten stamps (`surface.addFlatten`) before any layout, so roads, lots and NPC paths all see the graded ground.
* **Neon (Blade Runner)** — tower variants: round glass drums with neon rings and mullion fins, residential megablocks with
  balcony slabs / AC units / rooftop tanks, setback towers with exoskeleton ribs and spire crowns; corner blade signs; lit
  shop interiors with mullions; hanging blade signs over the sidewalk; holo billboards on podium roofs; shopfronts moved to
  the podium face (they were buried inside the podium); ground light pools + wet reflection streaks; paved cities are fully
  cleared of flora (clearing keep 0).
* **Monastery (Tarkovsky)** — kremlin ring wall (terrain-following, swallow-tail merlons, blind arcade, round towers with
  tent roofs + onions, gatehouses with icon niches and lanterns where roads cross; reserved in the layout occupancy so no
  house straddles it); free-standing tiered belfries; chapels with kokoshniks + apse; log izbas (gable to the street, porch);
  plaster palette (whitewash / ochre / rose / sky-blue), 5 roof materials, hip/gable mix, rooftop cupolas, galleries;
  capital placement rewards prominence (hilltop monasteries).
* **Organic (Roger Dean)** — colossal stalk towers (70–125 m) with spiral shell ribbons and larger stacked pods in city
  cores (scale hierarchy), glossier pods.
* **Life** — more walkers (town 190, city 280, metropolis 340 at high), busier main roads, plaza crowds (14–56).

### Per-site content
* Plaza with centrepiece (statue + basin in towns/cities, well in villages, campfire for hearth/nomad).
* Monument sites: colossal statue / arch / obelisk field / beacon tower / glowing glyph-wall ring / Kubrick monolith (M1 even at civ 0).
* Level 5 capital: spaceport (pads + control tower) and a **space elevator** visible from anywhere on the hemisphere (hearth worlds get the Outer Wilds launch tower instead).
* Night: every window pattern lights per-window (warm/cool mix), street lamps / lanterns / neon / beacons as bloom sprites, warm bounce near the ground; light clusters per site stay visible from orbit on the night side (far LOD sprites, per-location night factor from the sun).
* Life: 70–340 walkers per detailed site (lantern carriers at night), flying traffic for level ≥ 4 cities, boats for coastal sites.
* Colliders: an oriented box per building / tower / lamp (`world.addCollider`, tag `civ`), removed when a site is dropped.
* POIs: every site (`city` / `village` / `ruin` / `monument`) with `data {style, level, capital, civ}`.

### Performance
* One merged mesh per detailed site (buildings, 1 draw call) + roads (1) + glow sprites (1) + light pools (1) + walkers (1) + traffic (1) + boats (1). Far LOD: 2 draw calls per visible site.
* Detail radius `3.2 km × drawDistance`, dropped beyond +2.5 km; builds are generators time-sliced (5 ms/frame live, 250 ms in shot mode before ready).
* Building counts / walkers / traffic scale with the tier (low 0.45 · med 0.7 · high 1 · ultra 1.25).
* Typical detailed town: 0.2–0.6 M triangles.

## API
* `world.get('civ')`: `sites[]` (`{id, name, kind, style→kit, level, up, east, north, pos, radius, lat, lon, capital, hamlet, spaceport}`), `clearings`, `spawnTarget`, `getState()`.
* `world.civ = { clearings, sites, spawnTarget, capital }` (set at create) and event `civ:clearings`.
* `clearings`: `[dirX, dirY, dirZ, cosAngularRadius, keepFraction]` per site — for flora/fauna placement.
* URL `civdbg=noflora` hides the flora group (debug only, to judge architecture); `civdbg=noroads|nopools|nobld|noglow|nonpc`.
* URL `civcam=plaza|street|hero|aerial|top|edge` (+ `civsite=<id>`): capture framing presets (see Capture URLs).
* `__rv.state().civ`: `detail`, `tris`, `siteTris`, `siteLots`, `npcs`, `traffic`, `boats`, `fails`, `err`, `planMs`, `readyMs`, `capital`, `civcam`.

## Capture URLs
All `/?mode=system&galaxy=0&…`. **Use `civcam` presets** — they are computed from the settlement layout, so they stay valid
when other tracks change the terrain (hard-coded lat/lon for settlements go stale). `civsite=<id>` picks another site
(ids in `__rv.state().civ`; 0 = capital, 1 = hamlet). Stormy worlds (W4, W8) flash lightning at t≈0.3–0.8 s in shot mode:
use `--advance 2.5` for the normal night look.

| view | URL |
|---|---|
| W4 Blade Runner street canyon, night (10 m, fixed coords — W4 capital has not moved) | `star=2&planet=0&tod=0.95&view=fly&alt=10&pitch=2&lat=1.54880&lon=32.96537&yaw=275&camyaw=180` (advance 2.5) |
| W4 street, eye level, night | `star=2&planet=0&tod=0.95&civcam=street` (advance 2.5) |
| W4 neon megacity aerial, night | `star=2&planet=0&tod=0.95&civcam=aerial` (advance 2.5) |
| W1 village plaza, day (church, statue, stalls, townsfolk) | `star=6&planet=1&tod=0.36&civcam=plaza` |
| W1 village plaza, night (lantern strings, lit church) | `star=6&planet=1&tod=0.84&civcam=plaza` |
| W1 village street at dusk (lamps, lantern carriers, lit windows) | `star=6&planet=1&tod=0.84&civcam=street` |
| W1 capital from 110 m at night (round-1 "0 tris" case) | `star=6&planet=1&tod=0.05&civcam=top` |
| W1 establishing aerial | `star=6&planet=1&tod=0.35&civcam=aerial` |
| W3 Moebius spire town (plaza, statue, domes, towers) | `star=9&planet=2&tod=0.33&civcam=hero` |
| W7 Tarkovsky kremlin-monastery town | `star=3&planet=2&tod=0.4&civcam=aerial` |
| W6 Roger Dean sea metropolis + space elevator | `star=1&planet=3&tod=0.4&civcam=aerial` |
| W8 Stålenhag industrial metropolis | `star=2&planet=1&tod=0.3&civcam=aerial` (heavy storm fog at t≈0.5 — atmosphere) |
| W10 Hearthian village | `star=17&planet=0&tod=0.3&civcam=hero` |
| W2 BotW ruins city | `star=11&planet=0&tod=0.4&civcam=hero` / `civcam=aerial` |
| W11 Nausicaä nomad town | `star=0&planet=0&tod=0.4&civcam=hero` |
| City lights from orbit (night side) | `star=9&planet=2&tod=0.0&view=orbit` |
| M1 Kubrick monolith (civ 0) | `star=0&planet=2.0&tod=0.4` (monolith ~200 m ahead of the default spawn) |

## Known issues
* `node tools/check.mjs` passes (ALL OK). Under heavy shared load `system-surface` can exceed its 180 s readiness timeout
  with or without civ (`disable=civ` is as slow); civ itself is ready ~4 s after create (`readyMs`), flora ~24–28 s.
* Parked vehicles (vehicles track) still appear in settlement shots when no open, flat patch exists behind the lens
  (`props=0` not honoured yet — see Requests).
* W8's storm (rain 0.9, fog 0.45 at t≈0.5 s) buries the industrial metropolis in fog in aerial captures (atmosphere weather).
* Big green/red bokeh discs in W4 street shots near the lens are not civ (hidden with `civdbg=noglow` they remain): flora
  bioluminescent motes / post lens effects.
* Night exposure on non-neon worlds is still brighter than the neon world (atmosphere track).
* Street-level neon facades above the podium are still mostly window grids (now with room lighting / silhouettes, but no
  balconies or signage on high floors of every tower type).
* Layout of each far site is computed on the main thread (50–150 ms per metropolis) during the first frames; planning ~0.3–1 s
  at create.
* Triangle cost: 0.15–0.6 M per detailed town/city, ~0.75–1.0 M for level-5 metropolises at `high`.
* Terrain grading covers plazas / monument terraces only.

## Requests
* **vehicles** — honour `props=0` (skip `spawnAll()` / `spawnAtSettlements()`): the civ `civcam` presets set it so parked
  starships/bikes stay out of settlement framings. Also avoid parking on civ plazas: `world.civ.clearings` / POIs of kind
  city/village (`radius`) — the flattest spot found by `findSpot` is often a graded plaza.
* **atmosphere** — (1) night ambient on W1/W7 is brighter than W4 at the same sun elevation; (2) W8 storm fog at t≈0.5 s whites
  out the whole valley from 100–400 m; (3) the round-1 hard-edged moon/sun rectangle at dusk (W1) — radial falloff.
* **flora / post** — W4 street captures show large green/red out-of-focus discs right at the lens (bioluminescent motes or
  lens droplets); consider fading motes within ~3 m of the camera.
* **flora** — thanks for honouring `clearings` (W4 streets are clear). Paved (grid) cities send `keep = 0`.
* **player** — (done) faces `world.civ.spawnTarget`; `camyaw` works in `fp`/`fly`, which `civcam` relies on.
