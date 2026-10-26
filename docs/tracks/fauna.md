# Fauna track — creatures & life

Owner paths: `src/world/fauna/**`, this file. Subsystem `fauna`, order 40.

## What is built

Every living world gets a deterministic **roster** of species (`species.js`, seeded from `body.seed`,
styled by `body.art` — naturalistic palettes on Bierstadt/Friedrich/Tarkovsky worlds, flora/accent
driven palettes and bioluminescence on NMS / Roger Dean / Rick & Morty / Blade Runner worlds).
Names come from `universe/names.js` (`word()` + an archetype noun: "Riosoliara Grazer", "Eleeveayaal Heron").

| layer | archetypes | body | behaviour |
|---|---|---|---|
| ground | grazer, giant (long-necked), hexapod, hopper (biped), critter | `bodies/legged.js` lofted skinned mesh: torso with shoulder / haunch / rib-cage / withers muscle bulges, slim laterally-compressed neck tapering to a throat latch (clear jaw stop), head with cheeks + brow ridge, eyes set in lidded sockets, ears, 8 horn types (antler, lyre, spiral, crest…), dorsal plates, hooves/pads/paws/claws | `behavior/ground.js` Herd: graze / wander / alert / flee state machine, formation slots, separation, water & cliff avoidance, curious individuals approach, a still observer is tolerated (Planet Earth rule), running/driving scatters them |
| air | bird, ray | `bodies/chain.js` bird: body + beak + 2-bone wings with scalloped feather trailing edge + fan/fork/streamer tail; ray: one flat loft re-skinned by span (manta planform, cephalic lobes, whip tail) | `behavior/air.js` Flock: boids around a looping anchor that climbs / swoops; flap when climbing, glide when descending, bank in turns; scatters away from the player |
| sky | whale | 36–110 m sky whale: rounded head, ventral grooves, humpback pectorals (+ optional 2nd pair), flukes, dorsal ridge with glowing nodules | Pod: leader wanders slowly, followers hold echelon slots, terrain look-ahead altitude hold |
| float | jelly | double-walled translucent bell + scalloped glowing rim + tentacles + frilly oral arms (transparent crowd) | Swarm: wind drift, altitude spring, lift on each bell contraction, shy of the player |
| ground | serpent | `bodies/chain.js` 2–7 m serpent: 9-bone chain, flattened belly with ventral scutes, wedge head, brow scales, mouth line; optional membrane crest on exotic worlds | Herd (1–3), `ChainAnimator` serpentine: travelling wave whose phase advances with distance travelled (segments follow the head's path), deep resting S-curve, body draped over the terrain per segment, rears up cobra-like when alert |
| water | fish | fusiform body, exaggerated forked/fan/lunate caudal fin, tall dorsal, pectoral fins | School: boids under the sea surface, depth band, avoid shallows, startle, leaps (ballistic arcs out of the water) with a spray + surface-foam burst on every breach and re-entry |

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
saddle, dapples, rings, blotches), per-individual tint, socks/muzzle, fur/scale micro-normal and
micro-albedo (both faded by pixel footprint via `fwidth` *before* the noise reaches pixel frequency —
dFdx of pixel-rate noise is what produced the old 2×2 "checkerboard"), keratin, eyes with sclera /
noisy iris / pupil and a soft sky catch-light (roughness 0.16, lidded sockets), membranes & ears with sun
translucency, carapace iridescence, bioluminescent organs/lines/tips/veins that pulse at night,
eyeshine, fur sheen rim. Dithered distance fade (no pop), shadow casting through a skinned depth
material, cloud shadows via `world.lighting.setupMaterial` (auto).

**Motes** (`particles.js`, 1 draw call): fireflies at dusk/night (blinking, art-directed colour,
bioluminescent-world hues), pollen/midges by day lit by forward scattering against the sun.

**Splashes** (`particles.js` `Splashes`, 1 draw call, only while a burst is alive): ring buffer of
960 point sprites; each burst = droplets (ballistic, evaluated in the vertex shader from spawn
pos/velocity/time) + surface foam specks sliding outward; lit by sun + sky ambient. Triggered by
fish breaching / re-entering (`env.splash(pos, up, size)`); CPU only writes the new burst's rows.

**Night bioluminescence**: glowing species keep their volume at night — besides the glow pattern
(spots / spine+lateral lines / tips / veins / **photophores**: rows of dots on flanks & belly), the
whole body gets a dim self-illumination scattered "under the skin": dark back → glowing belly
gradient, fresnel toward the silhouette, low-frequency mottling, pulsing. Sky whales use veins or
photophores (never the thin single spine line).

**Streaming**: deterministic cube-sphere cells (`cells.js`) per layer — ground 210 m (radius
620 m), air 800 m (1.3 km), fish 260 m (420 m, only in water 1.5–40 m deep), sky whales 3.2 km
(5.2 km). Per-layer creature budgets scale with `quality.tier` (`maxCreatures` 90/180/320/450),
flock sizes with `tierK`, particles with `particleScale`. Animation is LOD'd (every frame near,
every 2–8 frames far/offscreen, pose shifted to the current root so it never lags).

**Discovery**: `events.emit('discovery', {kind:'creature', name, species, archetype})` the first
time each species is visible within its discovery distance (≥ 2.5 s apart).

**Alarm**: `events.emit('creature:alarm', {archetype, species, name, pos: Vector3 (planet-local),
dist, count})` when a herd bolts (FLEE) or a flock scatters (player sprinting / driving close);
rate-limited to one per 1.2 s (audio: alarm calls, stampede / wing bursts).

## Season 2 (Ghost of Yotei, gentle life)

* **Colossi** (`behavior/colossus.js`, body `bodies/legged.js` kind `colossus`): every living world has one
  colossus species made of the world: a 28-32 m tall, spindly, long-legged forest spirit with legs of twisted
  root and bark, lichen, moss creeping over every up-facing surface, a garden on its back (moss cushions,
  flowering shrubs, a blossoming sapling on the withers), hanging moss beards, pale weathered-wood antlers and
  a pale wooden face mask with softly lit eyes. One or two walk slow curving paths 400-700 m around the player
  (streamed, deterministic per world). Distance haze is height-weighted (`pHaze`): the farther, the paler and
  cooler, the head goes into the mist before the feet. **The bow:** stand still within ~50 m for 3 s (or send a
  Resonance pulse) and it walks up, turns to face her and lowers its head until its face is in front of hers.
  Never steps on the player (personal-space steering), avoids water, cliffs and town clearings.
* **Mount API** (`mount.js`), two seat sockets on every colossus (see API below).
* **Spirit fox companion** (`companion.js`, `fauna.companion`): a small white-silver fox with gold-tipped
  ears and tail that trots at her left side, runs ahead toward the nearest wonder (World Tree, sacred site,
  wonder / monument / ruin POI) and waits looking back, and sits beside her when she rests or meditates
  (`player.resting` / `player.meditating`). The Player uses it instead of its own fallback wolf.
* **Wild horses** (Yotei): naturalistic worlds (exotic <= 0.4) get a herd species of horses (bay, chestnut,
  dun, dappled grey, black, palomino, white) with a long head, a mane of locks falling to one side and a long
  hair tail. `&fauna=horse` frames a herd.
* **Gentle giants** (`giant` herds): stand still within ~30 m for 3 s and they turn to her and lower their heads.
* **Murmuration** (`murmuration.js`): a flock as weather, 600-4000 birds (by tier) in one instanced draw,
  evaluated entirely in the vertex shader (a folding, rolling sheet with travelling density waves), placed
  across the low sun at dusk and dawn (sun elevation -5..16 deg).
* **Sky whales** read as gentle volumes: dark cool slate back, pale throat, pale scars, long humpback
  pectorals (0.3-0.4 of body length); the showcase aims them into the upper third of the actual lens view.
* **Inbox done**: space -> fauna (small glowing life fades to faint points beyond ~90-600 m, so far night terrain is
  not dotted with saturated halos; giants and whales keep their light); player -> fauna (`player:pulse` head lift,
  fauna-owned companion); fix of a striped band at the colossus / giant pad feet (interpolated material ids).
* **Resonance** (`player:pulse`): the curtain of light (25 m/s) reaches creatures, they lift their heads to the
  sky for ~4 s; colossi in 2.5x the radius bow.

## API

```js
const fauna = world.get('fauna');   // null on lifeless / gas bodies
fauna.roster        // [{ id, name, archetype, layer, genome, look, glowing, temper, … }]
fauna.creatures     // live individuals: { species, pos: Float64Array(3) planet-local, fwd, up, speed, … }
fauna.nearest(archetype?, fromFloat64Array3?)
fauna.getState()    // { species, roster, groups, creatures, byKind, drawn, meshes, motes, discovered, showcase, colossi, companion, murmuration }
fauna.near(pos, r)  // creatures whose body sphere meets (pos, r): [{creature, pos, radius, dist, archetype, name}]

// companion (null with &companion=0|wolf or &fauna=none)
fauna.companion     // { pos, headPos, forward, up (Vector3, planet-local), mode: 'follow'|'guide'|'sit', seated,
                    //   leading, target (Vector3|null: the wonder it leads to), creature, setMode('auto'|'follow'|'sit'|'stay') }

// mounts (one per live colossus)
fauna.mounts        // [Mount]
fauna.mount         // the mount nearest to the player (or null)
fauna.mountNear(pos, r = 40)
mount.seats[0|1]    // THREE.Object3D children of world.root, planet-local; +Z = its forward, +Y = up (two seats side
                    // by side just behind the withers; they follow the chest bone every frame, after fauna's update)
mount.board(rider, i?) -> seat Object3D | null ;  mount.leave(rider)
mount.drive(dirVector3 | null, speed 0..1.6)   // steer while ridden; null = it walks its own scenic path
mount.kneel         // 0..1 how far it has lowered its head (bows when a rider stands still before it)
mount.pos / forward / up (Vector3), mount.height (seat height above its feet, m), mount.name, mount.speed
// events: 'discovery' {kind:'creature', name, species, archetype} · 'creature:alarm' {archetype, species, name, pos, dist, count}
```

URL params: `fauna=<grazer|horse|giant|colossus|murmuration|hexapod|hopper|critter|serpent|birds|rays|whales|jellies|fish|none>` frames a
showcase group in front of the spawn camera (clear line of sight vs terrain + colliders; herds stay
grazing, broadside, until the player moves); `faunadist=<0.3..4>` scales the showcase distance.
Without `fauna=`, a herd + a bird flock (+ rays / a whale pod when the roster has them, jellies at
night) are framed anyway.

## Best capture URLs

All verified at 1280×720 with the default post pipeline (`post=legacy` also works).

Season 2 (round 2):
* **Gentle giant, face to face** (W2 meadow, the colossus bows its head to her, the spirit fox at her side):
  `/?mode=system&galaxy=0&star=11&planet=0&view=surface&lat=5.3479&lon=24.1607&yaw=241.5&pitch=14&tod=0.33&props=0&fauna=colossus&faunadist=0.15` steps `[{"advance":4}]`
  (`faunadist <= 0.25` = face to face; otherwise the showcase colossus walks across the view at `230 x faunadist` m
  with a second one 2.4x farther back for two layers of haze).
* **Colossus in the haze before the volcano** (W2):
  `/?mode=system&galaxy=0&star=11&planet=0&view=surface&lat=5.3479&lon=24.1607&yaw=241.5&pitch=10&tod=0.3&weather=fog&props=0&fauna=colossus&faunadist=0.5`
* **Murmuration across the setting sun** (W1):
  `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.74&fauna=murmuration&faunadist=0.8&lat=9.08&lon=30.92&yaw=270&pitch=8&props=0`
* **Sky whales overhead** (W3 dunes, the white spires below):
  `/?mode=system&galaxy=0&star=9&planet=2&view=surface&tod=0.3&pitch=14&fauna=whales&faunadist=0.6&props=0`
* **Wild horses in the autumn field** (W1):
  `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=9.08&lon=30.92&yaw=297&pitch=4&tod=0.3&fauna=horse&faunadist=1.4&props=0`

Round 1 views:

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

* Riding the colossus needs the player track (the mount API and seat sockets are live; see Requests).
* The far colossus can be hidden by a tree line in forested spawns (the showcase checks terrain and nearby
  colliders only); streamed colossi walk 420-1800 m out and are often behind ridges.
* Horse manes and tails are skinned rigidly to the neck and tail bones (they follow the gait and head, but
  have no wind sway of their own yet).
* Per-vertex material ids are interpolated: a loft whose rings switch between non-adjacent ids (e.g. hexapod
  SKIN -> CARAPACE) can show a thin band of in-between materials; pad feet were fixed this round.
* `node tools/check.mjs` can time out on `system-surface` (180 s) when the shared software-GL machine is busy;
  the same URL boots without errors in 233 s with a longer timeout.

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

* **player** (season 2, round 2) — ride the colossus: when she stands before a bowing colossus
  (`fauna.mountNear(player.pos, 25)` with `mount.kneel > 0.7`), an interact prompt boards it:
  `const seat = mount.board(player)`; each frame (after fauna's update, e.g. in `lateUpdate`) put her at
  `seat.position` (planet-local) with `seat.quaternion`, play a sit pose, steer with `mount.drive(dir, speed)`
  (dir = planet-local tangent Vector3, or `null` for its own scenic walk); `mount.leave(player)` to dismount.
  Seat 1 is free for a second rider (the two-on-a-gentle-giant frame). A `ride=1` URL param (spawn seated on the
  nearest colossus) would make the "mount so large it is a viewpoint" frame capturable.
* **player** — `fauna.companion` (the spirit fox) is live on every living world and the Player already uses it
  instead of its wolf; the arm-around-it rest pose can read `companion.headPos`.

* **player** — expose a way to face a target at spawn (e.g. `world.player.lookAt(pos)`) so the
  `fauna=` showcase can frame creatures without hand-picked `yaw` values.
* **vehicles** — optionally skip spawning the parked bike/rover/ship when `fauna=` (or a generic
  `props=0`) is set, so creature captures are not cluttered.
* **audio** — creature ambience: `audio.play('creature', {kind, dist})` could be driven from
  `fauna.creatures` (bird calls near flocks, whale song under a pod, frog/insect chorus with motes).
* **ui** — `discovery {kind:'creature'}` events carry `archetype` for an icon.
