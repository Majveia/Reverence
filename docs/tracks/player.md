# Player track — explorer, camera & movement (flow state)

Owner paths: `src/world/player/**`, this file.

## What was built

A BotW / Journey / Outer Wilds-style explorer that plays on a spherical planet.

| file | role |
|---|---|
| `index.js` | subsystem module (order 50) → `Player` |
| `Player.js` | controller: state machine, spherical gravity, collisions, spawn, vehicle hand-off, events, audio params, prompts, FX triggers |
| `Camera.js` | camera rig: third-person spring arm, first person, fly, orbit |
| `Explorer.js` | procedurally modelled character (24-bone skeleton, 5 skinned meshes / draw calls, art-directed palette per world) |
| `geo.js` | modelling toolkit (lofts, armour patches with bevels, lathe/tube helpers, skin-weight assembler) |
| `textures.js` | procedural panel normal + panel albedo (panel lines, grime streaks) / fabric normal maps and wear roughness (canvas, cached) |
| `bake.js` | one-time surface bake of the suit: voxel AO (14 hemisphere rays / vertex), convex-edge paint wear, height + cavity grime tinted with the planet's dust colour → vertex colours + `aWear` (roughness / clearcoat / metalness per vertex) |
| `Animator.js` | procedural animation: effector-space layer blending + analytic two-bone IK |
| `Cloth.js` | verlet scarf (2 tails, wind + relative airflow, body collision spheres) |
| `Glider.js` | paraglider (arched cellular canopy, lines, deploy/stow, flutter, backlit translucency) |
| `FX.js` | pooled particles (dust, spray, droplets, motes, jet sparks), ripples, footprints, contact shadow, jet flames, wingtip trails |
| `Physics.js` | `HeightSampler` (cached heightfield + normals + water), `ColliderIndex` (spatial hash over `world.colliders`, capsule resolve, raycast), `AirField` (wind, thermals, ridge lift) |
| `util.js` | springs, frames, noise, helpers |
| `lab/` | **Explorer Lab** (dev only, not in the build): the real `Player` in a tiny fake world (meadow, 26 m cliff, 30° dune, sea shelf), sky env + sun. Captures in ~10 s instead of 5–9 min on the shared machine |

### Character
Stylish explorer: off-white armoured shell plates with bevelled edges, panel lines (normal + albedo
atlas) and grime streaks over a dark technical-fabric undersuit (quilted normal, low sheen), accent
piping along the side / arm / leg seams, a front zip, accent colour blocking derived from the world's
art palette (`heroPalette(body)`), amber **gold-metal visor** (gold F0 under a glass clearcoat, thin-film
rim, sky glint) , ear pods with glow rings, antenna (spring-jiggled), jetpack with twin thrusters,
emissive trims, scarf wrap + two simulated tails. Round 2: a one-time **surface bake** (`bake.js`) adds
AO in every gap between plates / fabric / pack, dust from the planet's ground palette on boots and
shins and in crevices, chipped paint on convex plate edges, albedo mottling; the per-vertex wear drives
roughness / clearcoat / metalness in the material patch. Round 3: the **visor now lies on the exact
super-ellipsoid of the shell** (before, the shell bulged ~6 mm through the glass at the diagonals — the
"white stain" inside the visor in every portrait), finer visor tessellation and a crisp smoked-gold
horizon reflection (bright hazy sky, dark bronze ground, sun glint) instead of the blotchy env map;
helmet panel seams (brow seam, rear ring, two crest-parallel seams) + a temple lamp; slatted rear
grille; dimmer ear rings and idle nozzle glow (from behind they read as a face); plate grime is soft
mottling instead of wood-grain streaks; wool scarf with weave normal map, fringed alpha-tested ends and a
hue-true sheen (it was a pink film). ≈47k triangles, 5 draw calls (+ scarf 2,
glider 3, FX ≈7).

### Animation (procedural, no clips)
Idle breathing + weight shift, walk/run/sprint gait with cadence/duty/stride from speed, IK foot
placement on the heightfield (pelvis drop, foot tilt to the slope normal), arm counter-swing, lean
into acceleration and turns, jump tuck / fall / long-fall pedal, landing squash spring, superhero
hard landing, glide hang with pendulum sway, surf stance while sliding (carve), swim crawl / treading,
four-limb climb cycle, head look toward the camera view or a nearby POI, backpack + antenna jiggle.
Climb (round 2): the whole body frame aligns with the rock (up the wall, facing into it), the chest
anchor is re-projected onto the heightfield along the wall normal every frame, 8 body-front probes
(toes → visor) push the body out of any bulge (no interpenetration), and every hand / foot is
**ray-planted on the heightfield** (`HeightSampler.ray`); the four-limb gait (diagonal pairs) is
world-planted — the phase advances with the distance climbed. Chest arches away from the rock, head
looks up the route; Space+up = lunge (animated), camera swings to a ¾ view of the wall.
Round 3: relaxed **contrapposto idle** (weight on the right leg, pelvis shifted/tilted, free foot forward
and turned out, soft elbows); run arms no longer "chicken-wing" (elbow pole back/down instead of out);
scarf tails flutter and twist at speed instead of streaming as a rigid plank.
Swim: front crawl rides at the surface; **hold C to dive** (streamlined underwater glide, profile
camera under water, Space / release to surface); ice and lava seas are walkable (`water.solid`).

### Moveset
* walk / run / sprint (Shift) — no stamina, momentum-preserving acceleration, wider sprint turns.
* jump with coyote time (0.14 s) and input buffering (0.16 s), variable height (release early).
* jetpack: second Space in the air = double-jump burst; hold Shift in the air = sustained thrust
  (fuel 2.6 s, refills on ground / water — never on foot).
* paraglider: Space in the air (>2 m up) — steer with the stick (coordinated banking), Shift = dive,
  pull back = flare, Space / C = release. Thermals (visible as rising motes) and ridge lift from wind.
* slide: hold C on slopes / at speed (auto on slopes > ~54°) — gravity along the surface, friction by
  surface (sand/snow slick), carve with A/D, launch off crests, jump out with Space. Deep speed-scaled
  crouch, sand/snow spray thrown off the board edge (carried with the rider), grains, furrow marks,
  camera pitched down the fall line.
* climb: push into rock steeper than ~50° — BotW-style; Space+W = climb jump, Space = kick off, C = let go,
  mantles over the top.
* swim: at `surface.seaLevel` (flat sea, or the water track's `heightAt(p)` if it exists); Shift =
  fast crawl, Space = dolphin hop, walk out on shallows.
* collisions: capsule vs heightfield + `world.colliders` (spatial hash, time-sliced rebuild, box tops
  are standable), step-down snapping, slope limit.

### Camera
Third person spring arm (critically damped pivot, over-the-shoulder offset, small look-ahead),
terrain + collider collision (pull in fast, ease out slowly), auto-recenter behind motion after 0.9 s
without manual look, pitch drift, FOV kick on sprint / glide / dive / jet, trauma shake on landings,
glide roll. On foot the lens keeps ~1 m of ground clearance (stays above meadow grass). Climbing high
on a face (> ~3 m) the camera swings wider along the wall, backs off and looks down past the climber so
the frame shows the drop and the vista. First person (V) from the animated eye (stabilised), head hidden, body visible below.
`view=fly` free flight and `view=orbit` planet overview kept for URL compatibility.

## Public API

* `world.player` : `.pos` `.forward` (= `.bodyFacing`) `.up` `.vel` `.view` `.state` `.lookAt(pos)` (face a
  target, body + camera, e.g. fauna showcases)
  (`ground|air|glide|slide|swim|climb|fly`) `.grounded` `.teleport(pos)` `.physics {heights, colliders, air}`
  `.onControlLost()` / `.onControlGained()` (hide / show the body for vehicles), `.inputScheme='character'`.
* Events: `player:jump {pos, speed, double?}`, `player:land {pos, speed, hard}`.
* Audio: `setParam('speed'|'altitude'|'wind'|'glide'|'swim'|'boost')`,
  `play('step'|'jump'|'land'|'boost'|'glider'|'splash', {surface, intensity…})`.
* UI: one contextual prompt id `'player'` (Glide / Dive·Drop / Slide / Jump off).
* `physics.heights.groundR(p)` (includes walkable ice / lava crust), `.normal(p, out)`, `.water(p)`,
  `.inside(p)`, `.ray(o, dir, max)` (heightfield ray march), `.pushOut(p, dir, max)`; `physics.colliders.raycast(o, dir, max, pad)`,
  `.resolveCapsule(pos, up, r, h)`; `physics.air.wind(p, out)`, `.updraft(p, alt, sunElev)`.

## URL params (spawn)
`lat, lon, yaw, pitch, alt, tod, view=surface|fp|fly|orbit` (as before) plus:
* `alt>6` with `view=surface` → spawns airborne with the glider open (glide captures).
* `act=slide` → spawns sliding downhill; `act=glide` → glider even at low alt.
* `act=climb` (+ `climbh=<m>`, default 4) → finds the nearest real rock face (heading first, then a fan)
  and starts the explorer on it `climbh` m above its foot, framed ¾ from the side. Deterministic climb captures.
* `flat=low` (+ `flatr=<m>`, default 400) → spawn on the LOWEST walkable dry spot nearby (valley floor /
  shore instead of a clifftop; terrain request).
* `camyaw=<deg>` → camera orbits the hero (150 ≈ front three-quarter portrait).
* `facesun=<deg>` → the explorer faces the sun (+deg to the left) — front-lit hero portraits.
* no `yaw` → faces `world.civ.spawnTarget` (the capital) when it is < 9 km away.
* `fov=` applies to first person too (telephoto sky shots).
* spawns step away from tree / boulder colliders during the first frames (flora request).
* `zoom=<k>` arm multiplier (0.5 = close-up), `fov=<deg>`.
* Surface/fp spawns snap to the nearest walkable spot within 45 m (`flat=0` disables).

## Best captures (round 3, verified at 1280x720 unless noted)

| view | URL | steps |
|---|---|---|
| W1 golden-hour run toward the capital | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.27&pitch=-7` | `[{"advance":1},{"move":[0.05,1],"sec":2.5},{"advance":1.3}]` |
| hero portrait (front ¾, sun-lit, gold visor) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.3&facesun=-46&camyaw=151&zoom=0.5&pitch=2` | `[{"advance":2}]` |
| hero portrait (backlit, vista) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.3&yaw=210&camyaw=155&zoom=0.5&pitch=2` | `[{"advance":2}]` |
| W2 paraglider banking over the valley | `/?mode=system&galaxy=0&star=11&planet=0&view=surface&alt=60&lat=18.18&lon=-50.80&yaw=22&pitch=-14&tod=0.3` | `[{"advance":1.5},{"move":[0.7,0.6],"sec":2},{"advance":1.4}]` |
| W2 climbing high on a sea cliff (deterministic `act=climb`) | `/?mode=system&galaxy=0&star=11&planet=0&view=surface&lat=18.3733&lon=-51.0533&yaw=90&tod=0.35&act=climb&climbh=12` | `[{"advance":1},{"move":[0.2,1],"sec":1.2},{"advance":1.2}]` |
| W3 surfing a sand dune (new spot — the old one is now covered in rock spires) | `/?mode=system&galaxy=0&star=9&planet=2&view=surface&lat=22.65&lon=56.2&act=slide&tod=0.68&flat=0` | `[{"hold":"KeyC","sec":4},{"advance":2.2},{"move":[0.4,0],"sec":0.8},{"advance":0.8}]` |
| W3 first person (dune, rover, crawlers) | `/?mode=system&galaxy=0&star=9&planet=2&view=fp&lat=22.65&lon=56.2&yaw=240&pitch=-10&tod=0.68&flat=0` | `[{"advance":1},{"move":[0,0.4],"sec":1.5},{"advance":1.2}]` |
| W1 swimming (front crawl) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=1.086&lon=-28.557&yaw=0&pitch=-8&tod=0.3` | `[{"advance":1},{"move":[0.3,1],"sec":5},{"advance":5}]` |
| W1 diving over the sand (underwater) | same URL | `[{"advance":1},{"move":[0,1],"sec":6},{"advance":3},{"move":[0,0.8],"sec":4},{"hold":"KeyC","sec":2.5},{"advance":3.5}]` |
| jetpack double jump | W1 default spawn | `[{"advance":1},{"hold":"ShiftLeft","sec":3},{"move":[0.3,1],"sec":3},{"advance":2},{"press":"Space"},{"advance":0.35},{"press":"Space"},{"advance":0.3}]` |
| Explorer Lab (character only, ~10 s) | `/src/world/player/lab/?camyaw=150&zoom=0.5&pitch=3&yaw=20&sunaz=240&sunel=14` (+ `act=climb&x=12&yaw=-90&climbh=14`, `act=slide&x=-42`, `alt=30`, `z=-40` swim, `view=fp`) | `[{"advance":1.5}]` |

Note: `move` / `hold` only schedule input — the following `advance` consumes it.

`window.__rv.world.player.getState()` → `{view, state, alt, speed, grounded, fuel, surface, dive, tris, colliders}`.

## Performance
Explorer ≈42k tris / 5 draw calls (+2 scarf, +3 glider when open, ≤7 FX); tessellation scales with
`quality.tier` (low 0.6×, med 0.8×); `low` uses MeshStandard instead of MeshPhysical. Particle pool
scales with `particleScale`. Hot paths are allocation-free (module temps, pooled FX); heightfield
queries go through a lazily filled 0.4 m cache grid around the player; the collider hash appends
incrementally and rebuilds time-sliced (5k/frame). Scarf: 75 verlet particles × 2–3 substeps.
Suit bake: one-time at build (voxel grid 0.7 MB, AO cached per tessellation level across world loads).
Climbing: ~8 push-out probes + 4 limb rays per frame on the cached heightfield (a few hundred lookups).

## Known issues
* Climbing works on the heightfield only (not on building / boulder colliders); the mantle is a hop,
  not an animated vault.
* Flora rocks on some worlds (W2) register few colliders, so the player can walk through small boulders;
  the camera ignores colliders < 2.2 m on purpose (BotW-style).
* The first-person view shows the body only when looking down / moving the arms (no held tool).
* The explorer's physical materials (sheen / clearcoat / iridescence) cost a noticeable one-time shader
  compile on software GL.
* The super-ellipsoid visor has a faint horizontal crease in its reflection at eye level (the |x|^0.89
  mapping's derivative at 0); only visible in extreme close-ups.
* Swimming: the water track's surface shading washes the submerged half of the body grey (physically
  plausible, but it hides the stroke); the crawl reads best from a ¾ side angle.
* Suit materials are still clean-stylised (panel lines, seams, baked AO/dust, mottling) rather than the
  heavily weathered Starfield look; there is no fabric wrinkle simulation.

## Requests
* **terrain / flora** (new) — the old W3 slide spot (`lat=22.571&lon=56.286`) now renders as a dense field
  of needle spikes (rock-spire instances or new small-scale relief) while the CPU heightfield there is smooth;
  moved the slide capture to `lat=22.65&lon=56.2`.
* **flora** (new) — fade / dither-out grass and small plant billboards within ~1.5 m of the camera (distance to
  `G.uCameraPos`): at low camera angles single blades fill the frame as giant ribbons. The player camera now
  keeps ~1 m ground clearance on foot, but tall grass (W4, W2 clifftops) still reaches it.
* **audio** (new) — the player now sets `setParam('danger', 0..1)` during long unbraked free falls (no glider).
* **flora** — thanks for the tree / rock colliders (W1: 738). W2 (Hyrule Echo) registers only ~3 near the
  climb spawn although it has many boulders — please register rocks > ~1 m there too.
* **civ** — box colliders for buildings (`halfExtents` + `quaternion`, local Y ≈ up): the player can
  stand on roofs / walls block movement and the camera; large boxes also block the camera.
* **water** — `heightAt(p)` is used (thanks). The player dives with C; `world.get('water').under` drives the
  underwater look. Ice / lava seas are treated as walkable ground (`liquid === 'ice' | 'lava'`).
* **audio** — one-shots used: `step {surface: ground|sand|snow|rock, speed, side}`, `jump`, `land
  {intensity}`, `boost`, `glider {open}`, `splash {intensity}`; params `speed, altitude, wind, glide, swim, boost`.
* **ui** — the player uses prompt id `'player'` (text only, e.g. "Glide", "Dive · Shift   Drop · C",
  "Dive · C" / "Surface · Space" while swimming); a touch "glide/jump" button can map to the `jump`
  action, "slide / dive" to `descend`.
* **vehicles** — parked vehicles' sphere colliders are treated as dynamic (tested every query), thanks
  for the `vehicle: true` flag. The parked bike shows a rider mannequin while unoccupied.
* **vehicles** — the W1 swim spot (`lat=1.086&lon=-28.557`) has a parked rover sitting on the seabed in
  ~4 m of water: please don't park props below `surface.seaLevel`.
* **core** — none required. Inbox items done this round: face `civ.spawnTarget` with no `yaw` (civ),
  step off tree / boulder colliders at spawn (flora), dive while swimming + walkable `water.solid` +
  softer ripples (water), `view=fp` honours `fov=` (space), `world.player.lookAt(pos)` (fauna).
