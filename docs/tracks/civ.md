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
| `pools.js` | ground light pools under every low light (street lamps, lanterns, shopfronts, blade signs): one additive draw per site; on wet ground (`G.uWetness`) each pool stretches into a reflection streak toward the camera (neon on wet asphalt) |

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
* URL `civdbg=noflora` hides the flora group (debug only, to judge architecture).

## Capture URLs
All `/?mode=system&galaxy=0&…`. The capital's lat/lon for any world is in `__rv.state().civ.capital`
(the planner is deterministic; positions change only when the terrain generator changes — the round-1 table was
stale after the terrain track's round-1 changes, this one is regenerated). Street views use `view=fp` (or a 10 m
`view=fly`) with `yaw` pointing *away* and `camyaw=180`, so the vehicles the vehicle track parks in front of the spawn
end up behind the camera; `flat=0` keeps the exact spot. Add `&civdbg=noflora` to judge architecture without trees.

| view | URL |
|---|---|
| W4 neon megacity, night, aerial | `/?mode=system&galaxy=0&star=2&planet=0&tod=0.95&view=fly&alt=90&pitch=-8&lat=1.36195&lon=32.89360&yaw=20` |
| W4 Blade Runner street canyon, night (10 m) | `/?mode=system&galaxy=0&star=2&planet=0&tod=0.95&view=fly&alt=10&pitch=2&lat=1.54880&lon=32.96537&yaw=275&camyaw=180` |
| W4 street, eye level | `/?mode=system&galaxy=0&star=2&planet=0&tod=0.95&view=fp&flat=0&pitch=6&lat=1.65346&lon=33.01765&yaw=5&camyaw=180` |
| W1 village street at dusk (lanterns, NPCs, pools) | `/?mode=system&galaxy=0&star=6&planet=1&tod=0.86&view=fp&flat=0&pitch=4&lat=7.34406&lon=26.43407&yaw=311&camyaw=180` |
| W1 capital plaza, golden hour (statue, crowd, church, windmill) | `/?mode=system&galaxy=0&star=6&planet=1&tod=0.3&view=fly&alt=22&pitch=-22&lat=7.23470&lon=26.51382&yaw=185&camyaw=180` |
| W1 capital from above at night (was "0 tris" in round 1) | `/?mode=system&galaxy=0&star=6&planet=1&tod=0.05&view=fly&alt=110&lat=7.2848&lon=26.5138` |
| W7 Tarkovsky kremlin-monastery town | `/?mode=system&galaxy=0&star=3&planet=2&tod=0.4&view=fly&alt=150&pitch=-20&lat=12.29727&lon=28.20922&yaw=20` |
| W3 Moebius spire town | `/?mode=system&galaxy=0&star=9&planet=2&tod=0.35&view=fly&alt=40&pitch=-8&lat=12.69878&lon=28.22669&yaw=20` |
| W6 Roger Dean sea metropolis + space elevator | `/?mode=system&galaxy=0&star=1&planet=3&tod=0.4&view=fly&alt=158&pitch=-10&lat=8.14908&lon=34.90067&yaw=20` |
| W8 Stålenhag industrial metropolis + Loop reactor | `/?mode=system&galaxy=0&star=2&planet=1&tod=0.3&view=fly&alt=120&pitch=-10&lat=11.58900&lon=28.70668&yaw=20` |
| W10 Hearthian village | `/?mode=system&galaxy=0&star=17&planet=0&tod=0.3&view=fly&alt=45&pitch=-12&lat=12.29934&lon=28.23129&yaw=20` |
| W2 BotW ruins city | `/?mode=system&galaxy=0&star=11&planet=0&tod=0.4&view=fly&alt=103&pitch=-14&lat=6.25884&lon=26.31260&yaw=20` |
| W11 Nausicaä nomad town | `/?mode=system&galaxy=0&star=0&planet=0&tod=0.4&view=fly&alt=63&pitch=-14&lat=12.40544&lon=28.75091&yaw=20` |
| City lights from orbit (night side) | `/?mode=system&galaxy=0&star=9&planet=2&tod=0.0&view=orbit` |
| M1 Kubrick monolith (civ 0) | `/?mode=system&galaxy=0&star=0&planet=2.0&tod=0.4` (monolith ~200 m ahead of the default spawn) |

## Known issues
* Round-1 "capital renders 0 tris at night from 110 m" could not be reproduced (same URL now: 515 k tris, lit town);
  diagnostics above make any recurrence visible in `__rv.state().civ` (`siteTris`, `fails`, `err`).
* Night exposure on non-neon worlds is bright (terrain reads as moonlit day) so window lights / pools read weaker than on
  W4 — atmosphere track (see Requests).
* Light pools are additive (not albedo-modulated); on grass they read as a warm glow rather than lit ground.
* Street-level neon facades above the podium are still mostly window grids (no balconies/signage on high floors).
* Layout of each far site is computed on the main thread (50–150 ms per metropolis) during the first frames.
* Triangle cost: 0.15–0.6 M per detailed town/city, ~0.75–1.0 M for level-5 metropolises at `high` (W6 1.0 M, W8 0.74 M);
  scaled down on med/low via density, tessellation and walker/traffic counts.
* Terrain grading covers plazas / monument terraces only (not every building pad): foundations / terraces / stilts still
  bridge slopes under individual houses.

## Requests
* **atmosphere** — (1) night ambient floor: with the sun 40–70° below the horizon, W1/W7 terrain still reads almost like
  day (compare W4 at the same sun elevation); lower the night hemi/ambient + exposure so window lights and lamp pools carry
  the frame. (2) W7 (Solaris Sea) fog 0.6 washes the whole frame one pale green: cooler, less saturated fog colour.
  (3) the moon / sun disc sprite at dusk showed a hard-edged white rectangle in round 1 (W1 dusk street): radial falloff.
* **vehicles** — the parked starship spawns on the capital plaza in `view=fly` (W1 plaza shot); please avoid civ POIs of kind
  city/village (`world.pois`, `radius`) or `world.civ.clearings` when choosing parking spots.
* **flora** — thanks for honouring `clearings` (W4 streets are now clear). Paved (grid) cities now send `keep = 0`.
* **player** — (done) faces `world.civ.spawnTarget`; `camyaw` also works in `fp`, which the street captures rely on.
