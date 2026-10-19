# Player track — explorer, camera & movement (flow state)

Owner paths: `src/world/player/**`, this file.

## Season 2 round 2 (toward the creator's frames)

**The explorer is now a wayfarer, not an astronaut.** Silhouette first: a deep hood with a soft peak, a short
shoulder mantle (front hem lifted so the chest and straps show), a long wool coat whose split skirt is simulated
cloth (`Coat.js`), wrapped shins and low boots, a tall canvas rucksack with a striped bedroll on top, a coil of
rope, a tin mug, a small warm **lantern** swinging on a pendulum bone off the pack, and a **walking staff** strapped
diagonally across the back with a little brass **ring of light** on top (the source's sign, carried). The only
saturated accent is the **red scarf**, wrapped over the mouth with two wide wool tails (verlet). Goggles pushed up
on the hood brim. Muted wool / canvas / leather tones picked against the world's ground hue (`heroPalette`);
~7 heads tall. Materials: felted wool (new `woolNormal`), waxy leather, brass, skin; a **sun-keyed back rim**
(golden-hour halo when the sun is behind the figure) and the old fresnel rim fixed (it was brightening every
front-facing pixel — the "flat plastic" look).

**Rest as a verb** (`world.player.resting`, 0..1, smoothed): hold **C** (descend) while standing still for 0.75 s,
or tap **X**, to sit; move / jump / X to stand; hold C again (1 s) to **lie back** / sit up.
* knees-up sit: forearms draped over the knees, gaze wandering over the horizon and the sky; the **pack comes off**
  and is set down at the right hip, the **lantern is put on the ground** in front (a small hearth);
* **sit on a ridge**: if the ground drops away within ~1.4 m ahead, the explorer shuffles onto the edge and sits
  with the legs hanging over the drop, hands on the ledge;
* **lie back**: the pack becomes a pillow, hands behind the head, looking up;
* **tender contact**: the companion sits at the left hip and the near arm goes around it; now and then the
  explorer's head turns to it and it leans in / nuzzles.
* camera: a slow drift to a ¾-back composition, lens low and tilted up (pitch ≈ +7°, FOV 44, arm 4.6 m, aim
  above the figure) so the **sky holds about two thirds** and the figure sits small in the lower third; a very slow
  breathing drift. Events `player:rest {on, pos}`; audio param `rest` (0..1); the HUD prompt clears while resting.
* URL: `act=rest` (sit at spawn, composition snapped), `act=lie`.

**Companion** (`Companion.js`): a small cream "lantern fox" whose tail tip glows and who wears a tiny ring of light
on its brow. Follows with a spring-damped offset (left-behind), trots, sits when idle, sits beside the explorer
at rest, leans into the hug. It is a fallback: if fauna ever exposes `world.get('fauna').companion` (with `.pos`,
optional `.headPos`), the player uses that one for the hug / gaze and does not build its own. `companion=0`
disables it. 2 draw calls, ~3k tris.

**First person body** (`Viewmodel.js`, rebuilt in round 2b, children of the camera, lit by the scene): built for the
frame edges like the reference frames. Each forearm runs in from a lower corner in a folded wool sleeve (compression
folds above the wrist, drape folds, fold shading, a lighter turned-back cuff) to a wrapped wrist and a fingerless
leather glove with **articulated fingers** (3 joints each + a 3-joint thumb) blended between a grip and an open pose.
Hands are posed from a forearm direction + a palm axis, so every pose is a body (the elbow leaves the frame). The
right hand holds the **lantern** by its bail low right; it **hangs plumb** (compensates the view pitch) and swings
with the gait / turns, with a real warm point light inside. The left hand grips the **staff** low left; the staff
leans away into the frame and its ring of light stands in the upper-left third. **Reach**: hold **R** (or primary /
RB) — the staff is lowered out of frame and the whole left arm reaches out from the lower-left corner toward the
view, palm down, fingers relaxed and spread (u_153 / u_154). Gait bob, breathing, look-lag. The layout keeps its
screen positions at any `fov=` (the rig is pushed deeper for telephoto). The body's own arms collapse in FP (the
legs and coat stay visible when looking down).

**Vista finder** (`vista=<m>`, or `vista=1` = 350 m): at spawn the explorer walks to the best OVERLOOK within that
radius and faces out over it: walkable, dry, the land falling away in front (an edge within ~45 m, a valley below
within 600 m), nothing near (26–300 m) rising into the view, a distant range welcome but not a mountain face
(150 candidates × 20 headings × 10 distances, one-shot). On foot it also starts already composed as an overlook.
Works with `act=rest` (sit facing the view), `view=fp` (first-person vista) and `yaw=` (relative turn).
`world.player.vistaInfo = {score}` for debugging.

**Framing presets** (`frame=shoulder|wide|low`, **B** cycles in play: auto → shoulder → wide → low):
* `shoulder`: close over the right shoulder (arm 2.15 m, lateral 0.62 m, FOV ≤ 50): pack, bedroll, scarf and staff
  in frame, the view ahead (u_136 "over-the-shoulder with the cargo in frame").
* `wide`: the small figure under a vast sky (arm 9.5 m, chest-height lens tilted up ~6°: the horizon on the lower
  third, figure centred and small) — the overlook framing, always on.
* `low`: the lens low behind the walker looking up past the figure (pitch ~15°, FOV ≥ 62): the walker against the
  sky / a giant overhead.
* event `player:framing {framing}`. Rest keeps its own composition.

**Camera framing director** (Camera.js): default third person has more sky (arm 4.3 m, aim 1.6 m, idle pitch
−3.4°); **overlook**: standing still > 1.2 s where the land drops away along the view (> 4–14 m within 50 m)
the lens pulls back to 9 m, drops to chest height (1.45 m) and tilts ~6° up so the horizon sits near the lower
third and the sky holds about two thirds, the figure small and centred; **lie back**: the lens looks down onto the
figure from ~3.5 m (above the meadow grass, not through it); **rest** as above;
**glide**: arm +2.9 m (round 2b: pulled back ~40% more), aim higher, level pitch (more sky above the canopy). Looking up (pitch > 0.3) the lens
now sits low behind the explorer instead of re-aiming down when terrain lifts it (space request: frame the
giant overhead).

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
| `Cloth.js` | verlet scarf (2 wide wool tails, wind + relative airflow, body / hood / pack / bedroll collision spheres) |
| `Coat.js` | verlet coat skirt (4 panels: open front, back vent, side slits; shape memory, leash, leg / pelvis / pack capsules, ground plane) |
| `Companion.js` | the lantern fox companion (follow / sit / hug), fallback for fauna's companion |
| `Viewmodel.js` | first-person hands: lantern (point light), staff with ring of light, reach gesture |
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
Round 4 (critic round 2 fixes): **dust is now volumetric-looking wisps**, not soft discs: every dust
particle carries a seed + age; the fragment shader builds a domain-warped 3-octave value-noise density,
weights it by a gaussian and erodes it with age, so a puff tears into wisps as it thins (the old gaussian
discs read as camera bokeh). Dust billboards stretch slightly along their screen-space motion. Slide FX:
a low plume of overlapping dust drifts back beside the board at ~half the rider's speed and hugs the slope,
plus a curtain of ~170 stretched sand grains / s (rooster tail) that falls back ballistically. Visor: a soft
horizon gradient (the crisp brown horizon line across the dome read as lips / a mouth), env reflection
reduced to a faint layer, and a crisp curved glass highlight on the upper dome. Swim camera: longer arm and
steeper pitch, so the boots no longer fill the foreground and the stroke reads; the swim wake's Kelvin arms /
kick foam break into speckled foam streaks and the ripple rings are broken up (no more smoky white bands).
Slide camera: ground-snapped states (slide, downhill runs) move along the slope while their integrated
velocity stays tangent to the sphere, so the rig now measures the feet's real motion (finite difference,
smoothed) for the pivot feed-forward and the fall-line pitch — before, the pivot trailed ~1.4 m uphill and
the surfer dropped out of the bottom of the frame. Surfing keeps a shallower pitch and only half the
terrain-lift look-down, so the rider, the run-out and the horizon share the frame. Climb camera ~1 m closer.
Scarf flutter amplitude grows toward the free end (flag-like) instead of streaming as a plank.
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
* Season 2: `.resting` (0..1), `.restS {on, lie, dangle, hug}`, `.companion` (own fallback fox, may be null),
  `.viewmodel` (FP hands), `.coat` (cloth skirt); `getState()` adds `resting`, `rest` ('sit'|'edge'|'lie'|null).
* Events: `player:jump {pos, speed, double?}`, `player:land {pos, speed, hard}`, `player:rest {on, pos}`.
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
* `act=rest` / `act=lie` → sit (or lie back) at spawn with the rest composition snapped; `companion=0` → no fox;
  `view=fp` spawns at sea step ashore to the nearest dry ground within ~4 km (`dry=0` disables).
* `zoom=<k>` arm multiplier (0.5 = close-up), `fov=<deg>`.
* Surface/fp spawns snap to the nearest walkable spot within 45 m (`flat=0` disables).

## Best captures — season 2 (verified; 1280x720)

| view | URL | steps |
|---|---|---|
| W1 rest on a ridge with the companion (sky ~2/3, valley + peaks) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.27&props=0&lat=14.916&lon=27.55&yaw=180&act=rest&flat=0` | `[{"advance":4}]` |
| W1 first person: lantern low right, staff with its ring of light upper left | `/?mode=system&galaxy=0&star=6&planet=1&view=fp&tod=0.27&props=0&lat=14.916&lon=27.55&yaw=180&flat=0&pitch=-2` | `[{"advance":1.5}]` |
| W1 first person, reach toward the view | same | `[{"advance":1},{"hold":"KeyR","sec":2.5},{"advance":2}]` |
| W1 lie back in the meadow, looking at the sky | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.27&props=0&lat=14.2065&lon=27.1184&yaw=180&act=lie&flat=0` | `[{"advance":4}]` |
| W1 overlook framing (stand still at a drop; the lens pulls back) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.27&props=0&lat=14.916&lon=27.55&yaw=180&flat=0&pitch=-4` | `[{"advance":5}]` |
| sit down / stand up in play | any surface URL | `[{"advance":1},{"hold":"KeyX","sec":0.15},{"advance":8}]` (or `{"hold":"KeyC","sec":1}` while still) |
| Explorer Lab: wayfarer front ¾ / back / rest / FP | `/src/world/player/lab/?camyaw=140&zoom=0.4&pitch=3&yaw=20&sunaz=240&sunel=14` · `?camyaw=25&zoom=0.55&…` · `?yaw=200&act=rest` · `?view=fp&yaw=300&pitch=-4` | `[{"advance":2}]` |

## Best captures (round 4, verified at 1280x720 unless noted; `props=0` keeps parked vehicles out of frame)

| view | URL | steps |
|---|---|---|
| W1 golden-hour run toward the capital | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.27&props=0&pitch=-7` | `[{"advance":1},{"move":[0.05,1],"sec":2.5},{"advance":1.3}]` |
| hero portrait (front ¾, sun-lit, gold visor) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.3&props=0&facesun=-46&camyaw=151&zoom=0.5&pitch=2` | `[{"advance":2}]` |
| hero portrait (backlit, vista) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&tod=0.3&props=0&yaw=210&camyaw=155&zoom=0.5&pitch=2` | `[{"advance":2}]` |
| W2 paraglider banking over the valley | `/?mode=system&galaxy=0&star=11&planet=0&view=surface&alt=60&lat=18.18&lon=-50.80&yaw=22&pitch=-14&tod=0.3` | `[{"advance":1.5},{"move":[0.7,0.6],"sec":2},{"advance":1.4}]` |
| W2 climbing high on a sea cliff (deterministic `act=climb`) | `/?mode=system&galaxy=0&star=11&planet=0&view=surface&lat=18.3733&lon=-51.0533&yaw=90&tod=0.35&act=climb&climbh=12` | `[{"advance":1},{"move":[0.2,1],"sec":1.2},{"advance":1.2}]` |
| W3 surfing a sand dune down into the river canyon (the old `22.65/56.2` spot now has a giant flora trunk + crawler in frame) | `/?mode=system&galaxy=0&star=9&planet=2&view=surface&lat=22.62&lon=56.68&act=slide&tod=0.68&flat=0&props=0` | `[{"hold":"KeyC","sec":4},{"advance":2.2},{"move":[0.4,0],"sec":0.8},{"advance":0.8}]` |
| W3 first person (dune, rover, crawlers) | `/?mode=system&galaxy=0&star=9&planet=2&view=fp&props=0&lat=22.65&lon=56.2&yaw=240&pitch=-10&tod=0.68&flat=0` | `[{"advance":1},{"move":[0,0.4],"sec":1.5},{"advance":1.2}]` |
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
* Season 2: the coat skirt is a single-sided cloth sheet (darker lining on back faces); seated on the ground it
  spreads flat around the hips. Large / fast teleports re-drape it (one frame).
* The FP viewmodel is drawn in the world pass (children of the camera): it can poke into a wall the explorer
  is pressed against. Sleeves are plain tapered tubes (no folds).
* The lantern fox is the player track's own fallback companion: a simple 11-bone rig (no IK), it walks
  through small props, swims by floating at the surface, and its idle sit reads stiff from behind.
* Rest: lying back is disabled when sitting on an edge (legs over the drop). The edge seat search only looks
  1.45 m straight ahead (face the drop before sitting).
* The lantern's point light adds one light to every lit material (constant, no recompiles; off on `low`).
* The W4 `view=surface` spawn lands in tall grass (flora); use `zoom` / `pitch` or a nearby lat/lon for clean captures.
* Large fauna can walk through the explorer (no creature colliders yet) — see Requests.
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
* **ui** (season 2) — `world.player.resting` (0..1, smoothed) is live: fade the HUD with it (the player already
  clears its prompt while resting). Events `player:rest {on, pos}`. Keys: hold **C** still / tap **X** = sit,
  hold C again = lie back, **R** (or primary) in first person = reach. Touch: a "rest" button can map to `descend`
  (hold) — no extra action needed.
* **audio** (season 2) — `setParam('rest', 0..1)` while seated / lying (a swell, a quieter wind bed); the lantern
  could have a faint flame crackle when `resting > 0.5`.
* **fauna** (season 2) — the player builds its own small companion (lantern fox) only while
  `world.get('fauna').companion` is absent; if fauna ships one, expose `.pos` (planet-local Vector3) and
  optionally `.headPos`, and make it sit ~0.5 m left of `world.player.pos` when `world.player.restS.on` — the
  explorer's arm goes around anything within 0.85 m.
* **civ / terrain** (season 2) — natural arches or doorways near spawn points would let the camera frame "a small
  figure under an arch" (the player camera already treats large box colliders as walls).
* **flora** (new, round 4) — W3 at `lat=22.65&lon=56.2` has a giant smooth brown trunk/pillar (~15 m wide, no bark
  texture, strata or normal detail) right next to the spawn; the critic read it as a bug. Please give large trunks /
  spires bark or strata detail, or keep them out of open dune fields. The player captures moved to `22.62/56.68`.
* **fauna** (new, round 4) — large creatures (W3 iridescent crawler, grazers) walk straight through the player at the
  dune spawn; please avoid / steer around `world.player.pos` (≥ 3 m) or register a dynamic collider.
* **vehicles** (new, round 4) — the W1 default spawn parks the hoverbike in the lower-right foreground of the run view;
  captures now use `props=0`.
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
