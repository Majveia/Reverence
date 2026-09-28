# Fauna track — creatures & life

Owner paths: `src/world/fauna/**`, this file. Subsystem `fauna`, order 40.

## What is built

Every living world gets a deterministic **roster** of species (`species.js`, seeded from `body.seed`,
styled by `body.art` — naturalistic palettes on Bierstadt/Friedrich/Tarkovsky worlds, flora/accent
driven palettes and bioluminescence on NMS / Roger Dean / Rick & Morty / Blade Runner worlds).
Names come from `universe/names.js` (`word()` + an archetype noun: "Riosoliara Grazer", "Eleeveayaal Heron").

| layer | archetypes | body | behaviour |
|---|---|---|---|
| ground | grazer, giant (long-necked), hexapod, hopper (biped), critter | `bodies/legged.js` lofted skinned mesh: torso/neck/head spline, ears, 8 horn types (antler, lyre, spiral, crest…), dorsal plates, hooves/pads/paws/claws | `behavior/ground.js` Herd: graze / wander / alert / flee state machine, formation slots, separation, water & cliff avoidance, curious individuals approach, a still observer is tolerated (Planet Earth rule), running/driving scatters them |
| air | bird, ray | `bodies/chain.js` bird: body + beak + 2-bone wings with scalloped feather trailing edge + fan/fork/streamer tail; ray: one flat loft re-skinned by span (manta planform, cephalic lobes, whip tail) | `behavior/air.js` Flock: boids around a looping anchor that climbs / swoops; flap when climbing, glide when descending, bank in turns; scatters away from the player |
| sky | whale | 36–110 m sky whale: rounded head, ventral grooves, humpback pectorals (+ optional 2nd pair), flukes, dorsal ridge with glowing nodules | Pod: leader wanders slowly, followers hold echelon slots, terrain look-ahead altitude hold |
| float | jelly | double-walled translucent bell + scalloped glowing rim + tentacles + frilly oral arms (transparent crowd) | Swarm: wind drift, altitude spring, lift on each bell contraction, shy of the player |
| water | fish | fusiform body, forked/fan/lunate caudal fin, dorsal fin | School: boids under the sea surface, depth band, avoid shallows, startle, occasional leaps (ballistic arcs out of the water) |

**Animation** (all procedural, CPU, allocation-free per frame):
* `anim/LeggedAnimator.js` — walk / trot / gallop / tripod / hop gait tables blended by speed, feet
  locked on the terrain during stance, swing arcs to predicted landing spots sampled from
  `world.surface` (IK-ish foot placement on slopes), analytic 2-bone IK with pole vectors, body
  pitch/lift from planted feet, bob, spine sway, breathing, neck graze calibrated so the muzzle
  reaches the ground, head look-at the player, ear flicks, tail swish with lag.
* `anim/ChainAnimator.js` — bird flap with wrist fold on the upstroke / glide with gust wobble /
  banking / head stabilisation; ray travelling wing wave; whale dorso-ventral undulation +
  paddling pectorals; fish lateral wave ∝ speed; jelly bell contraction via per-bone scale.

**Rendering** (`Crowd.js`, `material.js`): one `InstancedBufferGeometry` draw per species per LOD
(LOD0 hero mesh ≈ 3–11 k tris, LOD1 ≈ 0.25–1.1 k), GPU skinning from a per-frame RGBA32F bone texture
(one row per visible instance, 2-bone linear blend), a single shared `MeshStandardMaterial`
program patched with: countershading, 7 procedural coat patterns (stripes, spots, reticulated,
saddle, dapples, rings, blotches), per-individual tint, socks/muzzle, fur/scale micro-normal
(footprint-faded), keratin, wet eyes with sky catch-light, membranes & ears with sun
translucency, carapace iridescence, bioluminescent organs/lines/tips/veins that pulse at night,
eyeshine, fur sheen rim. Dithered distance fade (no pop), shadow casting through a skinned depth
material, cloud shadows via `world.lighting.setupMaterial` (auto).

**Motes** (`particles.js`, 1 draw call): fireflies at dusk/night (blinking, art-directed colour,
bioluminescent-world hues), pollen/midges by day lit by forward scattering against the sun.

**Streaming**: deterministic cube-sphere cells (`cells.js`) per layer — ground 210 m (radius
620 m), air 800 m (1.3 km), fish 260 m (420 m, only in water 1.5–40 m deep), sky whales 3.2 km
(5.2 km). Per-layer creature budgets scale with `quality.tier` (`maxCreatures` 90/180/320/450),
flock sizes with `tierK`, particles with `particleScale`. Animation is LOD'd (every frame near,
every 2–8 frames far/offscreen, pose shifted to the current root so it never lags).

**Discovery**: `events.emit('discovery', {kind:'creature', name, species, archetype})` the first
time each species is visible within its discovery distance (≥ 2.5 s apart).

## API

```js
const fauna = world.get('fauna');   // null on lifeless / gas bodies
fauna.roster        // [{ id, name, archetype, layer, genome, look, glowing, temper, … }]
fauna.creatures     // live individuals: { species, pos: Float64Array(3) planet-local, fwd, up, speed, … }
fauna.nearest(archetype?, fromFloat64Array3?)
fauna.getState()    // { species, roster, groups, creatures, byKind, drawn, meshes, motes, discovered }
```

URL params: `fauna=<grazer|giant|hexapod|hopper|critter|birds|rays|whales|jellies|fish|none>` frames a
showcase group in front of the spawn camera (clear line of sight vs terrain + colliders; herds stay
grazing, broadside, until the player moves); `faunadist=<0.3..4>` scales the showcase distance.
Without `fauna=`, a herd + a bird flock (+ rays / a whale pod when the roster has them, jellies at
night) are framed anyway.

## Best capture URLs

All verified at 1280×720 with the default post pipeline (`post=legacy` also works).

* Herd close-up, W1 savanna: `/?mode=system&galaxy=0&star=6&planet=1&view=fp&tod=0.3&fauna=grazer&lat=9.08&lon=30.92&yaw=200&faunadist=0.7` steps `[{"advance":3}]`
* Bird flock at sunset, W1: `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.74&fauna=birds&lat=9.08&lon=30.92&yaw=270` steps `[{"advance":3}]`
* Sky rays, W1: `/?mode=system&galaxy=0&star=6&planet=1&view=fp&tod=0.4&fauna=rays&lat=9.08&lon=30.92&yaw=270` steps `[{"advance":3}]`
* Sky whale over the hills, W9: `/?mode=system&galaxy=0&star=2&planet=2.1&view=fp&tod=0.35&fauna=whales&lat=4&lon=33.33&faunadist=0.45` steps `[{"advance":3}]`
* Bioluminescent night, W6 jellies + fireflies: `/?mode=system&galaxy=0&star=1&planet=3&view=fp&tod=0.95&fauna=jellies&lat=6.67&lon=34.67&yaw=270` steps `[{"advance":3}]`
* Glowing sky-whale pod at night, W6: `/?mode=system&galaxy=0&star=1&planet=3&view=fp&tod=0.95&fauna=whales&faunadist=0.6&lat=6.67&lon=34.67&yaw=270` steps `[{"advance":3}]`
* Leaping fish on a W1 beach: `/?mode=system&galaxy=0&star=6&planet=1&view=fp&tod=0.4&fauna=fish&lat=9.2&lon=31&yaw=22.5` steps `[{"advance":3}]`

Roster per showcase world (glowing = *): W1 grazer×2 hopper critter bird×2 ray fish · W3 + whale ·
W5 everything incl. giant, whale, jelly* · W6 grazer* hopper* critter* bird* whale* jelly* fish ·
W9 hexapod whale* · W10 giant* ray* jelly* · W11 whale*.

## Known issues

* Fish are only readable when they leap (the water surface hides them at grazing angles); showcase
  schools leap in bursts every ~0.25 s, ambient ones every 2.5–8 s. No splash particles yet.
* Grazers are stylised (lofted, 8–11 k tris hero LOD) — clean silhouettes, but no fur cards/shells.
* Whales/jellies do not avoid terrain peaks sideways, only climb over them (look-ahead altitude).
* Creatures do not collide with `world.colliders` (trees/buildings): herds steer only around water
  and steep slopes; flocks keep a minimum AGL above terrain, not above canopies.
* Showcase framing uses the player's spawn camera: vehicles parked at spawn (vehicles track) often
  sit in the same view; choose `yaw`/`lat`/`lon` to frame around them.
* No sound hooks yet (audio could key off `fauna.nearest()` / discovery events).

## Requests

* **player** — expose a way to face a target at spawn (e.g. `world.player.lookAt(pos)`) so the
  `fauna=` showcase can frame creatures without hand-picked `yaw` values.
* **vehicles** — optionally skip spawning the parked bike/rover/ship when `fauna=` (or a generic
  `props=0`) is set, so creature captures are not cluttered.
* **audio** — creature ambience: `audio.play('creature', {kind, dist})` could be driven from
  `fauna.creatures` (bird calls near flocks, whale song under a pod, frog/insect chorus with motes).
* **ui** — `discovery {kind:'creature'}` events carry `archetype` for an icon.
