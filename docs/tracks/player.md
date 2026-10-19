# Player track — explorer, camera & movement (flow state)

Owner paths: `src/world/player/**`, this file.

## Season 2 round 3 — the cosmic mystic swordswoman (the creator, 19 Oct)

"Ghost of Yotei like figure and feel, she needs to look badass, sexy, and cool with katana on her back that you can
draw and use." The wayfarer (hood, pack, lantern, staff) and every trace of the spacesuit / jetpack / paraglider are
gone from the default look.

**She** (`Explorer.js`, an original design): athletic, ~7.5 heads tall, narrow-shouldered and poised. A fitted
kimono-style coat with a cross-over collar (left over right, a fine gold thread on the lapel), a dark obi with gold
edges, fitted sleeves over wrapped forearms with black lacquered bracers, hakama trousers with pleats tucked into calf
wraps (kyahan) and slim black boots — all in ONE deep night colour (indigo; plum-black on blue/violet worlds) with a
gold thread on hems and seams. One black lacquered guard on the left shoulder (the sword hand stays free). A leather
baldric crosses her chest to the **katana on her back**: black lacquered scabbard with gold flecks, the hilt over her
right shoulder. Dark hair swept back into a **high ponytail** (verlet: a tapered tube core + three wispy locks,
`Scarf(kind 'hair')` in `Cloth.js`), two locks framing an oval face, a side-swept fringe. The **red scarf** worn loose
at the neck with two long verlet tails is the one warm accent. **Woven stars** (`SUIT_LIGHT.uStar`): tiny gold-white
points in the dark cloth (coat skirt too) — faint at night, bright when an ability flows through her (pulse, blink,
drift, meditation). The coat skirt (`Coat.js`) is the same night silk with a gold hem thread, to mid-calf.

**The katana** (`Katana.js` model + state machine, `SwordAnim.js` key poses, Animator overlay + `_swordSolve`):
* **G** / gamepad **Y**: draw over the right shoulder (reach the hilt, pull it out along the scabbard, swing it over the
  top, settle into a low ready stance) / sheathe (chiburi flick, over the shoulder, slide home, click).
* **click** / **RB** (also **J**): a fluid three-cut combo — kesa-giri down across the body, a flat backhand, a rising
  finisher — chained by clicking during a cut; each cut lunges a step. A click while sheathed draws with a cut.
* **hold click**: the **iaido stance** (low, right shoulder back, hand on the hilt, the left hand forward; with the
  blade drawn: held low and back). **Release**: the flash cut — out and through in a tenth of a second while she dashes
  ~3–5 m in a streak of light, the follow-through is HELD (the beat), a flick, then (if she drew from the scabbard) a
  slow sheathe; on the **click** everything along the dash falls in petals and light (`player:slash` kind
  `iai-bloom`). The camera swings to a low ¾ front **standoff** framing for the stance, the cut and the sheathe.
* the blade: faceted, curved (sori), kissaki, a wavy hamon (rougher/finer), an **edge glow** (abilities, night, the
  iaido charge, the flash of the draw) and **blade trails of light** (additive ribbon, warm core → cosmic blue tail,
  sub-stepped so fast arcs stay round).
* cuts throw **petals, leaves and grass cuttings** (new FX particle kind 3: a tumbling lit petal) in the world's flora
  colours (`art.palette.flora`), plus motes of light (more when the blade glows).
* while she sits, the katana comes off her back and is laid on the ground at her right hip (in front of her when she
  meditates); swimming / climbing / vehicles stow it at once.
* events: `player:draw {drawn, pos}`, `player:slash {pos, dir, radius, kind}` (kind `slash1|slash2|slash3|iai|iai-bloom`);
  audio one-shots `draw {iai}`, `sheathe`, `slash {kind, intensity}`.

**Abilities** (`Abilities.js`):
* **Drift** — replaces the jetpack and the paraglider (`glider=1` brings the old canopy back): jump again high up, or
  hold jump through the apex, and she stands on a **ring of light** (concentric gold rings + glyph ticks, turning) and
  glides with the glide physics (banking, thermals, ridge lift); **hold jump** to rise slowly (3 s of aether, refills
  on the ground); Shift dives, C drops. Pose: upright, knees soft, arms open low like wings, banking about the feet;
  light streams from her fingertips at speed. A tap of jump in the air is a light second jump off a flash of the ring.
* **Lumen** — a small orb of light with a halo and a real point light (off on `low`) following at her left shoulder
  (it leads a little when she is fast); **L** / gamepad **RT** sends it to where you look (it hovers there ~7 s, press
  again to call it back); in first person it floats above her open left palm. `lumen=0` hides it. Event `player:lumen {pos}`.
* **Resonance** — **R** / gamepad **X**: a ring of light runs ~60 m out over the land, conformed to the heightfield (it
  rides over the sea), with a burst of motes; her woven stars and the blade light up. Event `player:pulse {pos, radius}`.
* **Blink** — **Q** / gamepad **LT**: a ~7 m step through light along the stick (or forward), stopped by rising ground;
  a stardust streak along the path. Event `player:blink {from, to}`.
* **Commune** — sit (X / hold C), then hold C again: sit → **meditate** → lie back → sit (or **Z** directly):
  cross-legged, spine tall, palms up on the knees, she rises a hand's breadth on the ring of light, motes of light rise
  around her and the Lumen circles her. `world.player.meditating` (0..1) — the sky can answer. `act=meditate`.

**The white wolf** (`Companion.js`, restyled from the lantern fox): a big pale silver-white wolf (shoulder ≈ 0.6 m)
with a faint ring of light on its brow and a wisp of light at the tail tip; it lopes after her, sits at her left hip
when she rests, and her arm goes around its shoulders (still the fallback for `world.get('fauna').companion`).

**First person** (`Viewmodel.js`): the right hand holds the katana low right with the blade rising into the view (it
sweeps across the frame on a cut, rises from below on the draw); sheathed, a relaxed hand at the lower-right edge. The
left hand is open and cupped low left with the Lumen floating above the palm (its light rides with it). R (the pulse)
reaches the left arm out toward the view.

Kept from round 2 (now framing her): rest as a verb (sit, sit on a ridge with the legs over the drop, lie back,
`world.player.resting`), the rest / overlook / wide / low / shoulder camera framings (B cycles), the vista finder
(`vista=`), the companion contact, the first-person body.

## What was built

A BotW / Journey / Outer Wilds-style explorer that plays on a spherical planet.

| file | role |
|---|---|
| `index.js` | subsystem module (order 50) → `Player` |
| `Player.js` | controller: state machine, spherical gravity, collisions, spawn, vehicle hand-off, events, audio params, prompts, FX triggers |
| `Camera.js` | camera rig: third-person spring arm, first person, fly, orbit |
| `Explorer.js` | the swordswoman, procedurally modelled (24-bone skeleton, 6 skinned meshes / draw calls, night-colour palette per world, woven-star cloth shader) |
| `geo.js` | modelling toolkit (lofts, armour patches with bevels, lathe/tube helpers, skin-weight assembler) |
| `textures.js` | procedural panel normal + panel albedo (panel lines, grime streaks) / fabric normal maps and wear roughness (canvas, cached) |
| `bake.js` | one-time surface bake of the suit: voxel AO (14 hemisphere rays / vertex), convex-edge paint wear, height + cavity grime tinted with the planet's dust colour → vertex colours + `aWear` (roughness / clearcoat / metalness per vertex) |
| `Animator.js` | procedural animation: effector-space layer blending + analytic two-bone IK |
| `Cloth.js` | verlet strips: the red scarf (2 tails) and the ponytail (`kind 'hair'`: 3 locks + a tapered tube core) |
| `Coat.js` | verlet coat skirt (4 panels: open front, back vent, side slits; shape memory, leash, leg / pelvis / pack capsules, ground plane) |
| `Companion.js` | the white wolf companion (follow / sit / hug), fallback for fauna's companion |
| `Viewmodel.js` | first-person hands: the katana low right, the Lumen above the open left palm (point light), reach |
| `Katana.js` | katana + scabbard model, draw / combo / iaido / sheathe state machine, blade trails, edge glow, petals |
| `SwordAnim.js` | katana key poses (chest space) and their evaluation |
| `Abilities.js` | Drift ring of light, Lumen orb + light, Resonance wave, Blink, meditation motes |
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
* Events: `player:jump {pos, speed, double?}`, `player:land {pos, speed, hard}`, `player:rest {on, pos}`,
  `player:draw {drawn, pos}`, `player:slash {pos, dir, radius, kind}`, `player:pulse {pos, radius}`,
  `player:blink {from, to}`, `player:lumen {pos}`, `player:framing {framing}`.
* Season 2 round 3: `.meditating` (0..1), `.katana` (`.drawn`, `.act`, `.charging`, `.glow`), `.abilities`
  (`.lumenPos`, `.glow`, `.aether`), `.hair`; `getState()` adds `meditating`, `sword`, `aether`.
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
* `frame=shoulder|wide|low` third-person framing preset (B cycles auto → shoulder → wide → low): shoulder = close over
  the right shoulder; wide = the small figure under a vast sky (arm 9.5 m, horizon on the lower third); low = the lens
  low behind her looking up past the figure.
* `vista=<m>` (or `vista=1` = 350 m): walk to the best overlook nearby and face out over it (works with `act=rest`,
  `act=meditate`, `view=fp`).
* `act=meditate` (Commune at spawn), `act=rest|sit|lie`; `glider=1` (the old paraglider instead of Drift); `lumen=0`.
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
* Round 3 (the swordswoman): the katana has no collision — the blade passes through rocks and the body on extreme
  poses; the cuts do not yet cut the grass (flora request) — petals and leaves are the player's own particles.
* The over-the-shoulder draw is stylised: the blade slides out along the scabbard and swings over the top while the
  hand travels less than the blade's length (it pops through the scabbard mouth for a frame or two, hidden by the flash).
* The ponytail and scarf are verlet strips; without world wind (the lab) the scarf hangs to the ground.
* The white wolf is the player's own fallback companion (ellipsoid-built, 11 bones, no IK); it walks through small props.
* The face is simple (oval, almond eyes, lips): it reads at game distance, not in extreme close-ups.
* Season 2: the coat skirt is a single-sided cloth sheet (darker lining on back faces); seated on the ground it
  spreads flat around the hips. Large / fast teleports re-drape it (one frame).
* The FP viewmodel is drawn in the world pass (children of the camera): it can poke into a wall the explorer
  is pressed against. Sleeves are plain tapered tubes (no folds).
* Rest: lying back is disabled when sitting on an edge (legs over the drop). The edge seat search only looks
  1.45 m straight ahead (face the drop before sitting).
* The Lumen's point light adds one light to every lit material (constant, no recompiles; off on `low`).
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
* **flora** (season 2 round 3, the katana) — `player:slash {pos, dir, radius, kind}` (planet-local `pos` ~1 m above the
  ground in front of her, `radius` 2.2–3.6 m; kind `iai-bloom` comes ~2 s after an iaido cut, on the sheathe click):
  please cut / flatten grass, flowers and bamboo inside the radius (a short-lived "cut" list for the grass shader next to
  the existing player push, e.g. 4 slots `{pos, radius, t}` that shorten blades and tip flower heads for ~20 s), and
  spawn your own petals / leaves if you have per-species colours (the player already throws petals in
  `art.palette.flora` colours). Also (round 2, still open): fade grass within ~1.5 m of the camera.
* **fauna** (round 3) — `player:pulse {pos, radius ≈ 60}`: creatures within the radius look up / toward her, giants lower
  their heads; `player:blink {from, to}` and `player:slash` nearby can startle small critters (no harm — the world is
  gentle). A fauna-owned companion (`world.get('fauna').companion`) replaces the player's white wolf if present.
* **flora / civ / terrain** (round 3) — on `player:pulse`, glow life, paths and sacred sites within the radius for a few
  seconds (an emissive pulse travelling outward at ≈ 25 m/s matches the player's ring of light).
* **atmosphere / space** (round 3) — `world.player.meditating` (0..1): let the sky answer — stars brighten, the ring of
  the source appears faintly overhead, the wind stills.
* **ui** (round 3) — ability keys in the controls list / touch: draw/sheathe **G** (pad Y), cut **click** (pad RB; hold
  = iaido), Resonance **R** (pad X), Blink **Q** (pad LT), Lumen **L** (pad RT), meditate **Z** (or hold C while
  sitting), Drift = hold jump in the air. Fade the HUD with `world.player.resting` / `.meditating`. The player prompt
  shows "Draw katana · G   Iaido · hold click" / "Release · the flash cut".
* **audio** (round 3) — one-shots `draw {iai}`, `sheathe` (the click), `slash {kind, intensity}`, `pulse`, `blink`,
  `jump {double: true}` (the light jump); param `rest` (0..1). A low drone + held breath during the iaido stance
  (`world.player.katana.charging`) would land the standoff.
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
