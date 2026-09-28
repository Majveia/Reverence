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
(`/?mode=system&galaxy=0&…`; `getState().civ.capital` gives the capital lat/lon for any world)

* W4 neon night: `star=2&planet=0&tod=0.95&view=fly&alt=61&pitch=-6&lat=1.4077&lon=32.8061&yaw=45`
* W3 spire: `star=9&planet=2&tod=0.4&view=fly&alt=30&pitch=-8&lat=12.7144&lon=28.2325&yaw=20`
* W1 village: `star=6&planet=1&tod=0.4&view=fly&lat=7.5&lon=26.655&alt=22&yaw=18&pitch=-12` (capital moved — see state)

## Known issues
* Flora does not know about settlements yet → trees grow through towns (see Requests).
* Terrain is not flattened under buildings; foundations/terraces bridge slopes instead.

## Requests
* **flora** — please skip instances inside settlement clearings: `const C = world.civ?.clearings || world.get('civ')?.clearings` (array of `[dx, dy, dz, cosR, keep]`, unit dirs). In `placeLayer` (and grass), for a candidate unit direction `(dx,dy,dz)`: `for (const c of C) if (dx*c[0]+dy*c[1]+dz*c[2] > c[3] && r2 > c[4]) → skip`. Civ is created after flora (order 35 vs 30), so read it lazily when building the worker job config (or listen to `civ:clearings`). Without this, forests grow through every town.
* **player** — when no `yaw` URL param is given, face `world.civ?.spawnTarget` (planet-local Vector3 of the capital) at spawn so the first frame shows the town; keep yaw=30 fallback.
* **terrain** (nice to have) — optional flatten stamps (`surface.addFlatten({dir, radius, height, falloff})`) so plazas / building pads can be graded into the terrain.
* **ui** — marker kinds `city|village|ruin|monument` are emitted with `data.capital`; a larger marker for capitals would help.
