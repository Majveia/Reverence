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
| `textures.js` | procedural panel / fabric normal maps and wear roughness (canvas, cached) |
| `Animator.js` | procedural animation: effector-space layer blending + analytic two-bone IK |
| `Cloth.js` | verlet scarf (2 tails, wind + relative airflow, body collision spheres) |
| `Glider.js` | paraglider (arched cellular canopy, lines, deploy/stow, flutter, backlit translucency) |
| `FX.js` | pooled particles (dust, spray, droplets, motes, jet sparks), ripples, footprints, contact shadow, jet flames, wingtip trails |
| `Physics.js` | `HeightSampler` (cached heightfield + normals + water), `ColliderIndex` (spatial hash over `world.colliders`, capsule resolve, raycast), `AirField` (wind, thermals, ridge lift) |
| `util.js` | springs, frames, noise, helpers |

### Character
Stylish explorer: off-white armoured shell plates with bevelled edges and panel grooves over a dark
technical-fabric undersuit (quilted normal + sheen), accent colour blocking derived from the world's
art palette (`heroPalette(body)`: warm worlds get a teal accent / blue scarf, etc.), gold-film visor
with a procedural sky/horizon/sun reflection layered on the PBR env reflection, ear pods with glow
rings, antenna (spring-jiggled), jetpack with twin thrusters, emissive trims, scarf wrap + two
simulated tails. ≈38k triangles, 5 draw calls (+ scarf 2, glider 3, FX ≈7).

### Animation (procedural, no clips)
Idle breathing + weight shift, walk/run/sprint gait with cadence/duty/stride from speed, IK foot
placement on the heightfield (pelvis drop, foot tilt to the slope normal), arm counter-swing, lean
into acceleration and turns, jump tuck / fall / long-fall pedal, landing squash spring, superhero
hard landing, glide hang with pendulum sway, surf stance while sliding (carve), swim crawl / treading,
four-limb climb cycle, head look toward the camera view or a nearby POI, backpack + antenna jiggle.

### Moveset
* walk / run / sprint (Shift) — no stamina, momentum-preserving acceleration, wider sprint turns.
* jump with coyote time (0.14 s) and input buffering (0.16 s), variable height (release early).
* jetpack: second Space in the air = double-jump burst; hold Shift in the air = sustained thrust
  (fuel 2.6 s, refills on ground / water — never on foot).
* paraglider: Space in the air (>2 m up) — steer with the stick (coordinated banking), Shift = dive,
  pull back = flare, Space / C = release. Thermals (visible as rising motes) and ridge lift from wind.
* slide: hold C on slopes / at speed (auto on slopes > ~54°) — gravity along the surface, friction by
  surface (sand/snow slick), carve with A/D, launch off crests, jump out with Space.
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
glide roll. First person (V) from the animated eye (stabilised), head hidden, body visible below.
`view=fly` free flight and `view=orbit` planet overview kept for URL compatibility.

## Public API

* `world.player` : `.pos` `.forward` (= `.bodyFacing`) `.up` `.vel` `.view` `.state`
  (`ground|air|glide|slide|swim|climb|fly`) `.grounded` `.teleport(pos)` `.physics {heights, colliders, air}`
  `.onControlLost()` / `.onControlGained()` (hide / show the body for vehicles), `.inputScheme='character'`.
* Events: `player:jump {pos, speed, double?}`, `player:land {pos, speed, hard}`.
* Audio: `setParam('speed'|'altitude'|'wind'|'glide'|'swim'|'boost')`,
  `play('step'|'jump'|'land'|'boost'|'glider'|'splash', {surface, intensity…})`.
* UI: one contextual prompt id `'player'` (Glide / Dive·Drop / Slide / Jump off).
* `physics.heights.groundR(p)`, `.normal(p, out)`, `.water(p)`; `physics.colliders.raycast(o, dir, max, pad)`,
  `.resolveCapsule(pos, up, r, h)`; `physics.air.wind(p, out)`, `.updraft(p, alt, sunElev)`.

## URL params (spawn)
`lat, lon, yaw, pitch, alt, tod, view=surface|fp|fly|orbit` (as before) plus:
* `alt>6` with `view=surface` → spawns airborne with the glider open (glide captures).
* `act=slide` → spawns sliding downhill; `act=glide` → glider even at low alt.
* `camyaw=<deg>` → camera orbits the hero (150 ≈ front three-quarter portrait).
* `zoom=<k>` arm multiplier (0.5 = close-up), `fov=<deg>`.
* Surface/fp spawns snap to the nearest walkable spot within 45 m (`flat=0` disables).

## Best captures (all verified; 1280x720 finals)

| view | URL | steps |
|---|---|---|
| W1 golden-hour run (core use) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.27&pitch=-7` | `[{"advance":1},{"move":[0.05,1],"sec":2.5},{"advance":1.3}]` |
| W2 paraglider banking over the valley | `/?mode=system&galaxy=0&star=11&planet=0&view=surface&alt=60&lat=18.18&lon=-50.80&yaw=22&pitch=-14&tod=0.3` | `[{"advance":1.5},{"move":[0.7,0.6],"sec":2},{"advance":1.4}]` |
| W3 surfing a desert sand slope | `/?mode=system&galaxy=0&star=9&planet=2&view=surface&lat=22.571&lon=56.286&act=slide&tod=0.68` | `[{"hold":"KeyC","sec":4},{"move":[0.5,0],"sec":1.2},{"advance":1.6}]` |
| W3 first person | `/?mode=system&galaxy=0&star=9&planet=2&view=fp&lat=22.571&lon=56.286&yaw=200&pitch=-8&tod=0.68` | `[{"advance":1},{"move":[0,0.4],"sec":1.5},{"advance":1.2}]` (add `{"look":[0,-50]}` to see the body) |
| hero portrait (front ¾, gold visor) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.3&camyaw=150&zoom=0.55&pitch=-3` | `[{"advance":1.5}]` |
| W2 climbing a rock face | `/?mode=system&galaxy=0&star=11&planet=0&view=surface&lat=18.3733&lon=-51.0533&yaw=90&pitch=0&tod=0.35` | `[{"advance":1},{"move":[0,1],"sec":5},{"advance":3.5}]` |
| swimming (W1 shallows) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=1.086&lon=-28.557&yaw=0&pitch=-8&tod=0.3` | `[{"advance":1},{"move":[0,1],"sec":3},{"advance":2}]` |
| jetpack double jump | W1 default spawn | `[{"advance":1},{"hold":"ShiftLeft","sec":3},{"move":[0.3,1],"sec":3},{"advance":2},{"press":"Space"},{"advance":0.35},{"press":"Space"},{"advance":0.3}]` |

`window.__rv.world.player.getState()` → `{view, state, alt, speed, grounded, fuel, surface, tris, colliders}`.

## Performance
Explorer ≈38k tris / 5 draw calls (+2 scarf, +3 glider when open, ≤7 FX); tessellation scales with
`quality.tier` (low 0.6×, med 0.8×); `low` uses MeshStandard instead of MeshPhysical. Particle pool
scales with `particleScale`. Hot paths are allocation-free (module temps, pooled FX); heightfield
queries go through a lazily filled 0.4 m cache grid around the player; the collider hash appends
incrementally and rebuilds time-sliced (5k/frame). Scarf: 75 verlet particles × 2–3 substeps.

## Known issues
* No water surface is rendered yet (no water track in the tree), so swimming floats over the visible
  seabed; ripples/splashes are drawn at `surface.seaLevel`. Swim uses `water.heightAt(p)` automatically
  once the water track exposes it.
* Flora rocks / trees register no `world.colliders`, so the player walks through boulders and the camera
  can end up inside big props (heightfield collision works everywhere). The camera ignores colliders
  smaller than 2.2 m on purpose (BotW-style), so parked vehicles don't yank the arm.
* Climbing works on the heightfield only (not on building colliders); mantling is a simple hop.
* The URL on-foot spot from the terrain notes (`lat=3.96&lon=-29.58`) is a cliff edge: walking forward
  drops you off (the camera follows the fall; press Space to glide).
* The explorer's physical materials (sheen / clearcoat / iridescence) cost a noticeable one-time shader
  compile on software GL.

## Requests
* **flora** — register `world.addCollider({type:'sphere'|'capsule', pos, radius, height})` for boulders
  > ~1 m and tree trunks (the player's `ColliderIndex` hashes them; step-up and camera avoidance follow).
* **civ** — box colliders for buildings (`halfExtents` + `quaternion`, local Y ≈ up): the player can
  stand on roofs / walls block movement and the camera; large boxes also block the camera.
* **water** — expose `heightAt(p)` (planet-local point → water surface height in m rel. radius, waves
  included); the player floats and splashes on it automatically.
* **audio** — one-shots used: `step {surface: ground|sand|snow|rock, speed, side}`, `jump`, `land
  {intensity}`, `boost`, `glider {open}`, `splash {intensity}`; params `speed, altitude, wind, glide, swim, boost`.
* **ui** — the player uses prompt id `'player'` (text only, e.g. "Glide", "Dive · Shift   Drop · C");
  a touch "glide/jump" button can map to the `jump` action, "slide" to `descend`.
* **vehicles** — parked vehicles' sphere colliders are treated as dynamic (tested every query), thanks
  for the `vehicle: true` flag. The parked bike shows a rider mannequin while unoccupied.
* **core** — none required. (Lead inbox item done: `view=orbit` now looks at the planet; spawns never roll.)
