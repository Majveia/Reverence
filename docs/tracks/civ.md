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
| `life.js` | GPU-animated walkers (gait, arm swing, idle), flying traffic on looping lanes (hover cars / gliders / wooden ships), bobbing boats, space elevator (screen-space tether ≥1.4 px, climbers, beacons) |

### Per-site content
* Plaza with centrepiece (statue + basin in towns/cities, well in villages, campfire for hearth/nomad).
* Monument sites: colossal statue / arch / obelisk field / beacon tower / glowing glyph-wall ring / Kubrick monolith (M1 even at civ 0).
* Level 5 capital: spaceport (pads + control tower) and a **space elevator** visible from anywhere on the hemisphere (hearth worlds get the Outer Wilds launch tower instead).
* Night: every window pattern lights per-window (warm/cool mix), street lamps / lanterns / neon / beacons as bloom sprites, warm bounce near the ground; light clusters per site stay visible from orbit on the night side (far LOD sprites, per-location night factor from the sun).
* Life: 50–260 walkers per detailed site, flying traffic for level ≥ 4 cities, boats for coastal sites.
* Colliders: an oriented box per building / tower / lamp (`world.addCollider`, tag `civ`), removed when a site is dropped.
* POIs: every site (`city` / `village` / `ruin` / `monument`) with `data {style, level, capital, civ}`.

### Performance
* One merged mesh per detailed site (buildings, 1 draw call) + roads (1) + glow sprites (1) + walkers (1) + traffic (1) + boats (1). Far LOD: 2 draw calls per visible site.
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
(the planner is deterministic, so these stay valid until the terrain generator changes).
Add `&civdbg=noflora` to judge architecture without trees (debug only).

| view | URL |
|---|---|
| W4 neon megacity, night, aerial | `/?mode=system&galaxy=0&star=2&planet=0&tod=0.95&view=fly&alt=62&pitch=-6&lat=1.4004&lon=32.7900&yaw=45` |
| W4 neon street, night | `/?mode=system&galaxy=0&star=2&planet=0&tod=0.95&view=surface&camyaw=0&pitch=12&lat=1.5778&lon=33.0170&yaw=280` |
| W3 Moebius spire town | `/?mode=system&galaxy=0&star=9&planet=2&tod=0.35&view=fly&alt=30&pitch=-8&lat=12.7144&lon=28.2325&yaw=20` |
| W7 Tarkovsky monastery town | `/?mode=system&galaxy=0&star=3&planet=2&tod=0.4&view=fly&alt=63&pitch=-26&lat=12.0058&lon=28.4921&yaw=20` |
| W6 Roger Dean sea city + space elevator | `/?mode=system&galaxy=0&star=1&planet=3&tod=0.4&view=fly&alt=76&pitch=-8&lat=8.4422&lon=34.4330&yaw=45` |
| W8 Stålenhag industrial + Loop reactor, power lines | `/?mode=system&galaxy=0&star=2&planet=1&tod=0.3&view=fly&alt=63&pitch=-6&lat=12.1822&lon=28.5721&yaw=135` |
| W1 village street at dusk (lanterns, NPCs) | `/?mode=system&galaxy=0&star=6&planet=1&tod=0.86&view=surface&camyaw=0&pitch=4&lat=7.3241&lon=26.5282&yaw=200` |
| W1 village golden hour, low aerial | `/?mode=system&galaxy=0&star=6&planet=1&tod=0.29&view=fly&alt=23&pitch=-9&lat=7.1377&lon=26.5678&yaw=340` |
| W2 BotW ruins | `/?mode=system&galaxy=0&star=11&planet=0&tod=0.4&view=fly&alt=33&pitch=-6&lat=6.3597&lon=26.5589&yaw=315` |
| W11 Nausicaä nomad camp | `/?mode=system&galaxy=0&star=0&planet=0&tod=0.4&view=fly&alt=50&pitch=-14&lat=12.7438&lon=28.9861&yaw=225` |
| W10 Hearthian village on stilts + observatory | `/?mode=system&galaxy=0&star=17&planet=0&tod=0.3&view=fly&alt=38&pitch=-12&lat=12.7833&lon=28.3234&yaw=180` |
| W5 Rick & Morty blobs + portal | `/?mode=system&galaxy=0&star=1&planet=2&tod=0.4&view=fly&alt=50&pitch=-12&lat=15.8554&lon=30.0467&yaw=45` |
| City lights from orbit (night side) | `/?mode=system&galaxy=0&star=9&planet=2&tod=0.0&view=orbit` |
| M1 Kubrick monolith (civ 0) | `/?mode=system&galaxy=0&star=0&planet=2.0&tod=0.4` (monolith ~200 m ahead of the default spawn) |

## Known issues
* Flora does not know about settlements yet → trees and grass grow through towns and roads (see Requests).
* The default third-person spawn view rarely frames the capital (terrain / trees in between; camera pitch −10°
  looks at the grass). The capital is placed 0.7–2 km along the default spawn yaw with a line-of-sight score,
  the hamlet 170–350 m away — see the player Request.
* Terrain is not flattened under buildings; foundations / terraces / stilts / decks bridge slopes instead.
* `view=fly` on steep slopes starts with a rolled horizon (player track), e.g. W10.
* Layout of each far site is computed on the main thread (50–150 ms per metropolis) during the first
  frames; shot mode hides it, live play shows a few hitches at load. Moving layout to a worker is the next step.
* Triangle cost: 0.15–0.5 M per detailed town, ~0.75–1 M for level-5 metropolises at `high` (scaled down on
  med/low via density, tessellation and walker/traffic counts).

## Requests
* **flora** — please skip instances inside settlement clearings: `const C = world.civ?.clearings || world.get('civ')?.clearings` (array of `[dx, dy, dz, cosR, keep]`, unit dirs). In `placeLayer` (and grass), for a candidate unit direction `(dx,dy,dz)`: `for (const c of C) if (dx*c[0]+dy*c[1]+dz*c[2] > c[3] && r2 > c[4]) → skip`. Civ is created after flora (order 35 vs 30), so read it lazily when building the worker job config (or listen to `civ:clearings`). Without this, forests grow through every town.
* **player** — when no `yaw` URL param is given, face `world.civ?.spawnTarget` (planet-local Vector3 of the capital) at spawn so the first frame shows the town; keep yaw=30 fallback.
* **terrain** (nice to have) — optional flatten stamps (`surface.addFlatten({dir, radius, height, falloff})`) so plazas / building pads can be graded into the terrain.
* **ui** — marker kinds `city|village|ruin|monument` are emitted with `data.capital`; a larger marker for capitals would help.
