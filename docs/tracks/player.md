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

## Best captures
(see below — filled in after the final captures)

## Known issues

## Requests
