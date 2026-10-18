# Vehicles track — hoverbike, rover, starship

Owner paths: `src/world/vehicles/**`, this file. Subsystem `vehicles` (order 55).

## What was built

| file | role |
|---|---|
| `index.js` | `VehicleManager`: spawning (player spawn + settlements), collider-aware placement (clearings), enter/exit/summon, prompts, audio params, telemetry, speed blur + streaks, env probe, vehicle↔vehicle contacts |
| `Vehicle.js` | base class = controller contract (`pos vel forward up view inputScheme onControlGained/Lost`) |
| `Hoverbike.js` | flow-state speeder: 5-point predictive repulsor probe over terrain **and** water, anti-grav spring, hop, boost, carve/power-slide, banking, dust rooster tails, water spray, tail-light ribbons |
| `Rover.js` | 6-DOF rigid body at 4× substeps: raycast suspension per wheel against `surface.height` (spring/damper/bump stop/anti-roll bars), tire model with friction circle, surface grip (sand/snow/rock/wet), AWD rear-biased, handbrake drifts + counter-steer assist, roll-over assist + airborne self-levelling, chassis contact probes, self-righting, wading buoyancy, per-wheel dust/splash, tire tracks that fade (one draw call), exhaust puffs, headlights + beams + ground pool (E toggles), live dashboard screen |
| `Starship.js` | NMS-style flight: landed → VTOL take-off → atmospheric flight (ρ(alt) grip/lift/energy trade/over-speed drag) → space (flight assist) → pulse drive; auto gear, landing anywhere (aligns to ground), hull terrain contacts, reentry heat + plasma sheath + embers, contrails, engine trails, VTOL wash, interplanetary arrival (switches world to the approached planet/moon) |
| `camera.js` | chase rig (spring + heading lag, speed FOV, boost kick, shake, free look re-centre, terrain clearance, collider occlusion → pull-in/crane-up), ship follow-frame rig with horizon blend, cockpit views, cine presets |
| `models/bike.js` `models/rover.js` `models/ship.js` | procedural hard-surface models (lofts, bevelled extrusions, lathes, tubes, `shellPatch` armour plates), per-part PBR presets, conformal decals, emissive channels, animated parts (vanes, wheels, coil-overs, landing gear) |
| `models/rider.js` | pilot figure with its **own clean uber material** (`mats.rider`, grime only on boots): charcoal pressure suit with quilted panels/pockets, glossy shell armour (chest, pauldrons, gauntlets, knee cups, shin guards), helmet with gold-mirror visor, brow ridge, crest stripe, comm pods + lamp, life-support pack with O₂ canisters, vents, status LEDs and hoses to the collar, gloves, boots with soles. Colours per livery from `SUITS` (materials.js) |
| `materials.js` | uber PBR shader (panel seams, edge wear, dirt in the planet's soil colour, rust, wetness, reentry blackbody heat, dissolve), glow (8 animated channels), glass, decal atlas, sky env probe, liveries per art preset |
| `fx/*` | particles (lit dust, spray, sparks), flames/beams/pools/sprite halos, ribbons, speed streaks, radial speed blur (pipeline effect order 145), diegetic cockpit screens |

Budgets: bike ≈ 30k tris / 6 draw calls, rover ≈ 70k / 14, ship ≈ 97k / 16 (+ FX pools ≈ 6).
All three scale particle counts with `quality.particleScale`; ribbons are skipped on mobile.

### Round 2 (critic fixes)

* **Pilot** — own clean uber material (no vehicle dirt/wear pass), high-contrast suit per livery: glossy white/colour
  shell armour over a charcoal pressure suit, gold-mirror metallic visor (env reflections), accent bands, dark
  gloves/boots. The parked bike no longer shows a rider.
* **Starship hard-surface pass** — new `shellPatch()` (geom.js): raised armour plates that follow a loft's surface with
  flat-shaded chamfers (catch rim light, show edge wear). Fuselage side plates, dark gunmetal belly plates (two-tone
  underside), nose cap, two-tone nacelle plating with bolts, exposed tail structure (truss tubes, coolant lines,
  pressure tanks with bands, heat-sink stacks, hydraulic rams, cross-beam), turkey-feather nozzle petals with
  actuator rods; metallic 'pearl' hull paint; decals moved onto the plates. ≈ 97k tris.
* **Night fill** — vehicles get a soft accent-tinted bounce + rim at night so they read against neon cities.
* **No speed streaks/blur in vacuum** — ship wind streaks and radial blur are gated on air density (pulse tunnel only).
* **Dust by material** — rooster tails/wheel dust scale with loose material under the vehicle (sand/snow/dry soil
  vs lush meadow, wet or paved plazas); particles fade softly where they meet the ground.
* **Placement** — never on civ plazas/clearings or inside towns, never below sea level, ≥ 18 m (ship) / 6 m (rover)
  from the player spawn; `props=0` (or `&fauna=`) spawns only the start vehicle.
* **Light pools drape over the terrain** — headlight / VTOL / landing-light pools are subdivided quads conformed to the
  CPU heightfield (`conformPool`, throttled to when they move), so they no longer float over slopes or vanish into
  crests. Wheel-slip dust is capped so a slow, slipping climb no longer builds an opaque disc of dust.
* **Capture framing** — `camd` / `camyaw` / `campitch`, `vnear`, `vramp` (see below).

## Controls

| | Hoverbike (`vehicle`) | Rover (`vehicle`) | Starship (`flight`) |
|---|---|---|---|
| move stick / WASD | throttle · steer | throttle/brake/reverse · steer | W/S throttle · A/D roll |
| look (mouse / RS / drag) | free look (re-centres) | free look | steer (virtual stick: pitch/yaw) |
| Space / A | hop | handbrake (drift) | vertical thrust up / take off |
| C / B | — | — | vertical thrust down / land |
| Shift / RT | boost | boost | afterburner · in space hold = pulse drive (press again, S or C drops out) |
| E | — | lights on/off | — |
| V | chase ⇄ cockpit | chase ⇄ cockpit | chase ⇄ cockpit |
| F / Y / touch exit | ride / get off; hold on foot = summon last vehicle | drive / get out (< 22 km/h) | board / disembark (landed) |

Landing: fly low and slow (< 70 m/s, < 45 m) → gear deploys; touch down gently with C.

## URL / capture

`view=bike|rover|ship` starts inside that vehicle at the player spawn (moved to the nearest
clearing once flora/civ colliders exist). Extra params: `cam=chase|cockpit|side|front|low|high|top|quarter|rear|hero|chase3q`,
`speed=<m/s>`, `alt=<m>` (ship: start airborne; above the atmosphere = orbit), `pitch=<deg>` (ship nose),
`pulse=<m/s>` (ship in space: start in pulse), `liv=<livery>` (nasapunk, expedition, racer, hauler,
retro, stealth, pulp, frontier, arctic, jade).

| view | URL | steps |
|---|---|---|
| **W1 hoverbike tracking shot, golden hour** | `/?mode=system&galaxy=0&star=6&planet=1&view=bike&lat=16.122&lon=5.848&yaw=0&tod=0.27&speed=30&cam=track` | `[{"advance":0.3},{"hold":"KeyW","sec":6},{"advance":2},{"move":[0.6,1],"sec":1.2},{"hold":"KeyW","sec":2},{"advance":1.2}]` |
| W1 hoverbike 3/4 chase | same with `cam=chase3q` | same |
| **W3 rover on the dunes, Moebius spire town** (low chase) | `/?mode=system&galaxy=0&star=9&planet=2&view=rover&tod=0.33&speed=18&cam=low` | `[{"advance":0.3},{"hold":"KeyW","sec":2.0}]` |
| W3 rover airborne off a dune (side tracking) | `/?mode=system&galaxy=0&star=9&planet=2&view=rover&tod=0.33&speed=18&cam=track` | `[{"advance":0.3},{"hold":"KeyW","sec":2.2}]` (state: `rover.contacts === 0`) |
| W3 rover parked (livery, detail) | `/?mode=system&galaxy=0&star=9&planet=2&view=rover&tod=0.33&cam=quarter` | `[{"advance":1}]` |
| **W8 rover, industrial dusk (cooling towers, pylons)** | `/?mode=system&galaxy=0&star=2&planet=1&view=rover&lat=12.0&lon=28.29&yaw=60&tod=0.7&cam=low&weather=fog&time=300` | `[{"advance":0.5},{"hold":"KeyW","sec":4},{"advance":2.5}]` |
| **W4 ship VTOL take-off at the neon city edge (dusk)** | `/?mode=system&galaxy=0&star=2&planet=0&view=ship&tod=0.76&cam=chase3q&weather=clear&vnear=capital&vdist=140` | `[{"advance":0.5},{"hold":"Space","sec":1.1},{"advance":0.8}]` |
| W4 ship parked close-up (armour plates, greebles) | `/?mode=system&galaxy=0&star=2&planet=0&view=ship&tod=0.32&cam=quarter&camd=0.6&weather=clear` | `[{"advance":1}]` |
| **W4 ship over the neon megacity at night** | `/?mode=system&galaxy=0&star=2&planet=0&view=ship&alt=70&lat=1.4004&lon=32.79&yaw=45&tod=0.95&speed=90&cam=chase3q` | `[{"advance":1.2}]` |
| **W4 low orbit at the dawn terminator** (cloud streets below) | `/?mode=system&galaxy=0&star=2&planet=0&view=ship&tod=0.28&alt=30000&pitch=-10&cam=high` | `[{"advance":1}]` |
| W1 low orbit (continents, ocean, cloud) | `/?mode=system&galaxy=0&star=6&planet=1&view=ship&tod=0.42&alt=25000&pitch=-10&cam=high` | `[{"advance":1}]` |
| W4 ship climbing out | `/?mode=system&galaxy=0&star=2&planet=0&view=ship&tod=0.4` | `[{"advance":0.5},{"hold":"Space","sec":2.5},{"advance":2.5},{"hold":"KeyW","sec":3},{"advance":3}]` |
| pulse drive | `/?mode=system&galaxy=0&star=2&planet=0&view=ship&tod=0.45&alt=14000&speed=300` | `[{"advance":0.5},{"hold":"ShiftLeft","sec":1.2},{"advance":1.5},{"advance":3}]` |
| ship cockpit over the W1 fjord | `/?mode=system&galaxy=0&star=6&planet=1&view=ship&alt=250&lat=3.96&lon=-29.58&yaw=315&tod=0.3&cam=cockpit` | `[{"advance":1.5}]` |

Framing params (capture only): `camd=<mult>` camera distance, `camyaw=<deg>`, `campitch=<deg>` offsets on top of any
`cam=` preset; `vnear=capital|hamlet|<site index>&vdist=<m>` parks the start vehicle on open ground that far outside a
settlement, facing it; `vramp=<m>` searches the CPU heightfield for a dune crest within that radius and lines the
start vehicle up on it. W4/W8 are storm worlds: `weather=clear` (atmosphere override) avoids rain streaks.
Software captures of the long step sequences need up to ~10 min under load (`--timeout 420`).

`__rv.state().vehicles` → `{ active, count, placed, colliders, <id>: {pos, speed, …}, cam }`; the ship
reports `state, alt, agl, throttle, gear, pulse, pitch, bank, heat, rho, nearest, nearestKm`, the rover
`contacts, gear, steer, comp[4], tilt, surface`.

## API

* `world.vehicles` (= `world.get('vehicles')`): `vehicles[]`, `active`, `enter(v)`, `exit(v)`, `summon()`,
  `add(kind)`, `findClearing(center, dir, maxDist, opts)`, `blocked(pos, r)`.
* Every vehicle: `type` ('bike'|'rover'|'ship'), `pos vel quat fwdVec upVec rightVec speed boost engine`,
  `occupied`, `camera` (`mode`, `toggle()`), `telemetry()`, `getState()`.
* Events: `vehicle:enter|exit {type, vehicle}`, `discovery {kind:'landing', name}` on touchdown / arrival.
* Audio params every frame while driving: `engine` 0..1, `speed` m/s, `boost` 0..1, `altitude` (ship).
  One-shots: `vehicle.enter`, `vehicle.exit`, `jump`, `land {intensity}`, `impact {intensity}`, `takeoff`,
  `pulse {on}`, `warp` (summon), `whoosh` (self-righting).
* UI: `prompt('vehicle', 'Ride'|'Drive'|'Board', 'vehicle')`, `hint(...)` on enter, `setTelemetry({speed, altitude?, drive?, status?, target?, gear?, grip?})` at 5 Hz.
* Colliders: each vehicle registers a sphere collider `{tag: 'vehicle:<type>', vehicle: true}` that follows it.

## Known issues

* Ship arrival at another planet is a world switch (white flash) rather than a continuous approach;
  gas giants cannot be landed on (pulse drops out near them).
* Parked vehicles avoid collider-registered trees/rocks/buildings, but understorey plants and creatures (no colliders)
  can still occlude a chase camera (W4 spawn meadow: long-necked grazers) — `vnear=capital` frames reliably.
* No damage model; hard impacts only bounce, spark and shake.
* Rover wheels use a single ray per wheel (no wheel-width sweep), so it can clip small ledges.
* Paint reflections are limited by the 64 px sky environment cube (atmosphere) — clearcoat highlights are soft.
* W4 from orbit is a solid cloud deck (the world is a monsoon planet): shoot at the terminator (`tod=0.28`) so the cloud
  streets cast long shadows; W1 orbit shows continents/oceans.

## Requests

* **atmosphere / weather** — stop rain/snow streaks when the camera is above the cloud layer / outside
  the atmosphere (`G.uCameraAltitude > atmosphere height`): visible in the W4 orbit capture.
* **flora** — an optional `flora.clearAround(pos, radius)` (or honour `world.pois` of kind `'landing'`)
  so understorey/alien plants are culled under a parked 15 m starship.
* **audio** — engine voices keyed by `engine`/`speed`/`boost`/`altitude` plus the one-shots above
  (`takeoff`, `pulse {on}`, `impact`, `land`) for the three vehicles (`vehicle:enter {type}` tells which).
* **ui** — telemetry keys `drive: 'PULSE'`, `status`, `target` (nearest body · distance) are sent by the
  ship; a small pitch-ladder/target marker would be welcome but is optional (cockpit screens exist).
* **atmosphere / weather** (round 2) — rain streaks read as a regular diagonal grid across the whole frame in storm
  captures (W4/W8 at default weather; critic: "moiré / scanline artifact"): randomize streak spacing/length/opacity per
  particle and fade them with distance. The `weather=dust|fog` overrides keep `storm` (and thus rain ≈ 0.9) on W8, so
  a dry misty/dusty W8 is not reachable by URL; `fog`/`dust` could zero `storm`.
* **atmosphere** (round 2) — W4's cloud deck from low orbit (noon) reads as flat grey foam; some albedo/height
  variation, gaps or storm-cell structure (and city glow through gaps at night) would sell the orbit shot.
* **terrain** (round 2, from the critic) — near-field ground under the rover wheels (W3 dune sand, W8) lacks micro
  detail (grain, pebbles, normal variation) compared with Pacific Drive references.
* **fauna** (optional) — register a sphere collider (or expose `fauna.near(pos, r)`) for large creatures so vehicle
  chase cameras can avoid being blocked by them, and so vehicles can bump them.
