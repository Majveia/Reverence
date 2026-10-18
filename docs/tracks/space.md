# Space track — star, sky, other bodies, rings, belts, comets

Owner paths: `src/world/space/**`, `docs/tracks/space.md`.
Subsystem `space` (order 5), auto-loaded by `World`. Every part is fault-isolated (a failing part is
logged and skipped; the frame loop never sees an exception).

## What was built

| file | what |
|---|---|
| `index.js` | subsystem glue, per-frame context (camera, pixel angle, in-atmosphere factor, sun illuminance), public API (`world.space`) |
| `skyBake.js` + `sky.worker.js` | **host-galaxy night sky**, baked in a worker from `GalaxyModel`: log-stepped ray march of `galaxyDensity()` from this star (bulge / old disk / young arms + HII glow, wavelength-dependent dust extinction) → equirect HDR band with non-linear latitude rows (0.25° at the galactic equator); **resolved stars** = the real local-neighbourhood stars (`forEachLocalStar`, ≤1200 ly) + luminous giants from the global population, flux L/d², blackbody colours, reddening by the dust column; + ~24k faint stars distributed like the band's light (the band sparkles); notable nebulae (`galaxyNebulae`) with angular sizes |
| `sky.js` | one GPU pass bakes a detailed **cube map** (galaxy frame): the baked band (latitude-warped lookup → ragged dust-layer edges) × soft star clouds (anisotropic, sheared along the plane) × wavelength-dependent dust (branching filaments, dark globules, a ragged Great-Rift lane scaled by the baked dust column), a soft toe instead of a hard floor (no contour lines), texel-sized speckle of myriad unresolved stars whose density follows the band light, faint high-latitude cirrus, photographic colour (warm star clouds, cooler outskirts), nebula glows, log response with a true-black floor; per frame a far-plane fullscreen triangle samples it through `uL2G = qGal · celestial.q` (the sky wheels with the planet's spin and the orbit). Stars are `THREE.Points` (gaussian core + halo, diffraction spikes only for the ~15 brightest, scintillation inside an atmosphere). Distant galaxies are procedural sprites (spiral / elliptical, one "Andromeda" hero). `?skypano=1` shows the baked sky as an equirect panorama (debug). |
| `star.js` | **the star**: far-plane billboard with correct angular size (`star.radius / distance`), HDR limb-darkened disk (quadratic law, redder limb), animated granulation (worley) when resolvable, sunspots/faculae (activity = `star.flare`), chromosphere, prominences, streamer corona (∝ r^-3.2) visible from space, soft glare halo. Planets/terrain occlude it naturally (eclipses). |
| `bodies.js`, `bodyLook.js`, `bodyShaders.js` | **other planets & moons** (+ the current body when it is a gas giant, + the current body's rings): real spheres at `celestial.bodyLocal(b)` with the body's tilt & spin. Rocky shader: domain-warped continents vs `ocean.oceanFraction`, art palette (grass/veg/sand/rock/snow/water/deep), ice caps by zone/type, craters (airless/barren), dunes, crystal facets, bump from the mountain field, ocean sun glint, animated cloud layer + cloud shadows, lava seas / lava cracks (volcanic), **city lights on the night side for civ ≥ 3** (neon palette for `civ.style = neon`). Gas shader: art-directed band palette (jovian / saturnian / ice / exotic, tinted by `art.palette`), flow-map animated zonal jets, turbulent festoons, vortex storms (GRS-like oval), Minnaert limb darkening, reddened terminator, shear-zone eddies and white ovals / brown barges up close, ring-shine and faint moonlight on the night side. **Atmosphere limb shells** (10-step single scattering, art sky tint, planet shadow, eclipses) — blend `ONE, SRC_ALPHA` so they also extinguish the surface behind. **Rings**: procedural radial profile (C/B/A rings, Cassini division, Encke gap, F ring, 140 ringlets, mipmapped, sampled with an explicit 4-tap radial anisotropic filter so ringlets stay crisp on grazing views without aliasing), single-scattering slab model (lit/unlit side, icy backscatter + dusty forward scatter), **planet shadow on the rings, ring shadow on the planet**, spokes. **Eclipses**: every surface/shell takes up to 4 spherical occluders (moons ↔ parent, the camera's own body) with penumbra. Far bodies become "wandering star" dots (phase-correct flux). |
| `smallBodies.js` | **asteroid belts** (`system.belts`): Keplerian particle streams in the vertex shader (differential rotation, Kirkwood-like gaps, phase-lit, sized by angular size); **comets** (`system.comets`): star-like nucleus + inner/outer coma, straight blue ion tail (streamers, drifting knots) along anti-star, broad curved dust tail trailing the orbit with striae and a bright leading edge; tails fade to zero at their borders; length scales with activity (heliocentric distance) and reads like a Great Comet (tens of degrees) wherever it is seen from. `probe(i, t)` finds good capture times. |

### Season 2 round 2 — the sky is the subject
* **A neighbouring world fills half the sky** (`bodies.js`): from the ground, the parent giant of a moon is drawn
  closer along its true direction (`e.app`, magnification `e.mag`) until it spans `?giant=` degrees of angular
  radius (default 16°: the rings, ~33°, still fit in a frame; capped ×4.5 and never inside its rings); the neighbouring moons get a ≥ 1.6° disc so their
  phases read. Translation (not scaling) keeps lighting, ring shadow, the moon's shadow on the giant and every
  occluder geometrically true relative to the body; eclipses (`sunVisibility`, `eclipse`) use the apparent
  positions so what you see is what dims the light. Fades to true geometry with altitude (0.08 R → 1.2 R): orbit
  views are physical. `?skymag=0` disables it. `skyInfo()` reports `mag`.
* **Rings opened toward the viewer** from a moon of a ringed giant: the ring plane is tilted per frame so it is never
  less than 25° open (a moon in the ring plane would only ever see a line); replaces the fixed +24° hack.
* **Eclipses as events** (`index.js`, `star.js`): `world.space.eclipse` (0..1, fraction of the star disc hidden by
  bodies — never the horizon) and `eclipseBody` (id). The occluder (a moon, the magnified giant, or the current
  planet seen from above its air) gets an **eclipse ring**: a thin blazing edge in the reddened star colour (gold
  for gas giants, orange-red through rocky air, white corona for airless bodies), a soft aureole and faint streamers,
  brightest where the star hides, uniform when it is centred (the black disc with a thin coloured ring).
* **Galaxy band** (`sky.js`): painted in the host galaxy's own palette (`GalaxyModel.galaxyDisplayColors`, softened to
  pastels): warm gold dust-light in the bright star clouds and core, cool blue faint arms, umber where the dust column
  is thick. The night lift under an atmosphere is now **compressive** (`uLift / (1 + l / knee)`: faint band light
  rises above the air's star-hiding threshold, the core does not) followed by a soft `tanh` luminance cap (0.35):
  no more blown-out cream slab. `?bandboost=`, `?bandknee=` for tuning.
* **Deep-sky objects visible from the ground**: the two largest emission nebulae of the galaxy as seen from this star
  are art-scaled to 2–6° and brightened (H-alpha pink, OIII teal); a **pulsar** (the cosmic lighthouse: a beating
  blue-white point with two faint sweeping beams) near the galactic plane. `look('nebula' | 'nebula1' | 'pulsar')`.
* **Star in space**: a wide halo in the star's colour (~8°) tints the space around it (space only).
* **Gas giants**: a second hue (cool blue / teal / lilac / rose for warm giants, cream for ice giants) on some belts
  and the polar hoods — two-hue planets; warmer, stronger ring-shine on the night side; backlit dusty ringlets glow
  (forward scattering ×4.5); the planet's shadow on the rings and the ring shadow on the planet have soft edges.
* **Cosmic & Otherworldly** (`wonder.js`): on a few worlds (art direction: Tarkovsky / Friedrich / Annihilation →
  **halo**; Beksiński / Villeneuve → **orb**; Kubrick → **monolith**; ~10 % of other living worlds by seed;
  `?wonder=halo|orb|monolith|off`):
  * *halo*: a ring of light hanging 3.5–9 km above a dry-land site, a broken arc whose brightness travels around it,
    always seen as a circle (an impossible object), with a single thread of light falling to the ground;
  * *orb*: a black orb with a thin blazing orange ring pouring a pillar of flowing light onto the land, a pool of
    light where it lands;
  * *monolith*: a featureless black slab (1 : 4 : 9) hanging over the land, one line of light down its edge and a
    single thread of light to the ground (M1: it stands in front of the eclipsed parent planet);
  * all: slabs of the land coming gently apart around the foot, drifting slowly upward, turning, dissolving.
  Real geometry (aerial perspective fades it into haze), visible tens of kilometres away: the world's luminous
  landmark. Uses terrain landmarks (`terrain.landmarks.sacred[0]`) when that track exposes them.
* **Capture helpers**: `dryLand(lat, lon, spanDeg)` teleports to the nearest dry land (the W12 spawn was underwater);
  `wonderShot(dist, bearingDeg)` stands on dry land `dist` m from the wonder; then `look('wonder', dYaw, dPitch)`.

### Round 2 changes (critic fixes)
* **Gas giants are turbulent storm systems, not painted stripes** (`bodyShaders.js` GAS_FRAG): the band palette is
  sampled at an *advected* latitude — a 3–6 octave anisotropic **curl flow** (divergence-free swirls from the analytic
  gradient of simplex noise `sp_snoiseG`, zonal-dominant) whose strength peaks in the **shear zones** between belts and
  zones (detected from the band palette's latitude derivative) and in the **turbulent wake** trailing the big vortex →
  ragged, wind-sheared belt edges, Kelvin-Helmholtz curls, filaments of one band dragged into the next (two-stage
  layered lookup), bright plumes and dark blue-grey festoons (`uFest`), longitudinal band segments. Vortices spin
  2.4 rad at the core (spiral arms) with a pale collar; the palette (`bodyLook.gasLook`) has more, narrower bands with
  crisp edges, higher belt/zone contrast, thin dark sub-belt lanes.
* **Soft, hazy gas-giant terminator**: wider wrap/smoothstep window, reddened light through the upper haze and a
  forward-scattered haze glow bleeding across the terminator; gas-giant limb shells are thinner (2.5 % of R, scale
  height 0.55 % R) with a stronger forward-scattering haze (g = 0.84) → a crisp, bright backlit crescent.
* **Sky-filling parent giant is framable**: `aim/look('parent' | 'moon' | 'biggest')`, `skyInfo(ref)` (angular sizes),
  `frame(refA, refB, f)` (look between two sky objects, e.g. the giant and the galactic core). The W9 moon's orbit is
  almost synchronous with the giant's orbit around the star (synodic period ≈ 262 000 s), so the sky geometry changes
  slowly: the giant is up at night around `time=95000–125000`, half-lit at dusk around `time=60000`.
* **Star field colours**: the galaxy model's local population is main-sequence with hot stars over-represented (art
  direction for galaxy mode). The sky bake now applies a realistic IMF (most O/B stars demoted to A/F dwarfs,
  deterministic) and turns ~1.2 % of cool stars into evolved K/M giants (red clump, RGB/AGB); distant luminous stars
  are mostly K/M giants. Reddening of star colours saturates (tau ≤ 1.2) and colours are slightly desaturated
  (photographic pastels). Top-300 bright stars: ~50–65 % blue-white, the rest white/yellow/orange, a few red.
* **Comet tails never streak the view**: a camera-facing ribbon viewed along its axis (or from inside the fan) has its
  streamers converge to a vanishing point → long straight streaks across the frame. The tail now fades out when the
  view is within ~10–25° of the tail axis or the camera is inside the fan (as a real tail's low surface brightness would).
* **Sub-pixel star disc** (request from post): when the photosphere is smaller than 1.5 px it is drawn as a 1.5 px disc
  with the same flux, so it never falls between pixel centres (the lens-flare occlusion probe and bloom always see a
  real bright disc at far-plane depth).

### Frames & precision
* Everything lives under `world.root` in planet-local metres (bodies at 1e7–1e9 m). Matrices are built in
  float64 on the CPU (`modelViewMatrix`), ray/sphere work in shaders is done in units of the body radius.
* Background layers (Milky Way, stars, galaxies, star) write no depth and are drawn first
  (`renderOrder -1000…-990`, far plane); bodies/rings write real depth → the atmosphere pass treats them
  as background beyond the air (transmittance + day-time suppression of faint things).
* Galaxy frame ↔ system inertial frame: deterministic random rotation per star (`qGal`, galactic plane
  inclined 25–70° to the ecliptic), so the band crosses the sky at an angle and wheels with the day.
  The band is observed from near the galactic mid-plane (art direction: stars far above the disk would
  otherwise see a half-sky glow); resolved stars use the true position.

## Public API
```js
world.space = {
  sun: { dir, angularRadius, color, visibility /*0..1 horizon + eclipses*/, screen /*NDC*/, onScreen },  // lens-flare hooks
  sunVisibility(localPos),        // fraction of the star disk visible past other bodies (eclipses on the current body)
  eclipse,                        // 0..1 fraction of the star disc hidden by OTHER bodies (not the horizon, not the
                                  //   current planet) — the light on this world: atmosphere / post
  eclipseView,                    // same seen from the camera, incl. the current planet's disc from orbit
  eclipseBody,                    // id of the body covering the star (or null)
  bodies,                         // [{ b, local (true planet-local Vector3), app (apparent, drawn position), mag, mesh, ring, shell, … }]
  aim(ref, fromLocal?),           // → { yaw, pitch } (deg, 0 = north, 90 = east) toward '0-2-2' | 'sun' | 'galcenter' | 'comet0'
                                  //   | 'parent' (a moon's planet) | 'moon' | 'biggest' (largest body in the sky)
  skyInfo(ref),                   // → { yaw, pitch, id, mag, angDeg, ringDeg } apparent angular radius of the body / its rings
                                  //   aim/look refs also: 'wonder', 'nebula', 'nebula1', 'pulsar'
  wonder,                         // null | { kind: 'halo'|'orb'|'monolith', lat, lon, height, target(out) }
  wonderShot(dist, bearingDeg),   // capture helper: stand on flat dry land with a clear view of the wonder
  dryLand(lat, lon, spanDeg),     // capture helper: teleport to the nearest flat dry land
  look(ref, dYaw?, dPitch?),      // capture helper: turns the player camera (fp/surface) toward that object
  frame(refA, refB, f?, dYaw?, dPitch?), // capture helper: looks at the point f of the way from refA to refB
  small.probe(i, t),              // comet i at world time t: { elong, tailView (90 = side-on), dist, r }
  orbitSunShot(deg, rollDeg),     // capture helper for view=orbit: star `deg`° from the planet centre, behind it
}
__rv.state().space → { sky: 'baked'|'baking'|'failed', stars, bodies (visible ids), sunVis, sunAng, eclipse, eclipseBody, wonder }
URL: ?giant=<deg> (apparent radius of a moon's parent from the ground, default 16) · ?skymag=0 (true sizes) ·
     ?wonder=halo|orb|monolith|off · ?bandboost= · ?bandknee=
```

## Best capture views (`/?mode=system&galaxy=0&…`)
| view | URL / steps |
|---|---|
| **M1 eclipse + monolith** (the parent planet as a black disc with a blazing ring and corona over the mesas, the monolith's line of light in front, Milky Way) | `star=0&planet=2.0&view=fp&tod=0.33&time=546200&lat=16.4&lon=38.5&weather=clear` + steps `[{"advance":0.3},{"eval":"__rv.world.space.wonderShot(8000, 230)"},{"advance":2},{"eval":"__rv.world.space.look('wonder',0,7)"},{"advance":0.5}]` |
| **M1 eclipse over the explorer** (third person) | `star=0&planet=2.0&view=surface&camlock=1&zoom=1.6&tod=0.33&time=546200&weather=clear` + steps `[{"advance":0.3},{"eval":"__rv.world.space.look('parent',-18,-6)"},{"advance":0.5}]` |
| **W9 night: the ringed giant fills the sky** (rings as arcs, a moon beside it) | `star=2&planet=2.1&view=surface&camlock=1&zoom=1.6&tod=0.03&time=99000&weather=clear` + steps `[{"advance":0.3},{"eval":"__rv.world.space.look('parent',0,-6)"},{"advance":0.5}]` |
| **W12 ring of light in a pale sky** (halo wonder) | `star=9&planet=5&view=surface&camlock=1&zoom=1.4&tod=0.31&lat=-14&lon=-25&weather=clear` + steps `[{"advance":0.3},{"eval":"__rv.world.space.wonderShot(12000, 105)"},{"advance":2},{"eval":"__rv.world.space.look('wonder',0,-8)"},{"advance":0.5}]` |
| **W3 black orb pouring a pillar of light** (orb wonder, forced) | `star=9&planet=2&view=surface&camlock=1&zoom=1.4&tod=0.78&weather=clear&wonder=orb` + steps `[{"advance":0.3},{"eval":"__rv.world.space.wonderShot(7000, 90)"},{"advance":2},{"eval":"__rv.world.space.look('wonder',-10,-4)"},{"advance":0.5}]` |
| **W4 eclipse from orbit** (black disc, thin orange ring, corona streamers) | `star=2&planet=0&view=orbit&weather=clear` + steps `[{"advance":0.5},{"eval":"__rv.world.space.orbitSunShot(17.2, 20)"},{"advance":0.5}]` |
| **W12 rings arching over the ice at night** (spawn moved to dry land) | `star=9&planet=5&view=surface&camlock=1&zoom=1.5&tod=0.06&lat=35&lon=20&yaw=180&pitch=22&weather=clear` + steps `[{"advance":0.3},{"eval":"__rv.world.space.dryLand(35,20,10)"},{"advance":1.5}]` |
| **W9 eclipse by the giant, morning** (a gold ring round the giant, the sky turns violet with last light all round the horizon — atmosphere reads `space.eclipse`) | `star=2&planet=2.1&view=surface&camlock=1&zoom=1.6&tod=0.31&time=525000&weather=clear` + steps `[{"advance":0.3},{"eval":"__rv.world.space.look('parent',-20,-6)"},{"advance":0.5}]` |
| G1 backlit ringed giant (Cassini look: sun over the limb, ring shadow, ring-shine on the night side) | `star=2&planet=2&view=orbit` + steps `[{"advance":0.5},{"eval":"__rv.world.space.orbitSunShot(26, 12)"},{"advance":0.5}]` |
| G1 ringed gas giant from orbit (quarter phase, rings crossing the disk) | `star=2&planet=2&view=orbit&tod=0.3` |
| G1 gibbous: turbulent belts, vortices, rings | `star=2&planet=2&view=orbit` + steps `[{"advance":0.5},{"eval":"__rv.world.space.orbitSunShot(135, 20)"},{"advance":0.5}]` (close-up: `&dist=1300000`, `orbitSunShot(120, -10)`) |
| W9 night: gibbous ringed giant high in the sky, Milky Way toward the core | `star=2&planet=2.1&view=fp&tod=0.96&time=99000&weather=clear` + steps `[{"advance":0.3},{"eval":"__rv.world.space.frame('parent','galcenter',0.55,0,-3)"},{"advance":0.5}]` (giant alone: `look('parent')`) |
| W4 eclipse: star behind the limb, Milky Way behind | `star=2&planet=0&view=orbit&weather=clear` + steps `[{"advance":0.5},{"eval":"__rv.world.space.orbitSunShot(19, 20)"},{"advance":0.5}]` |
| W12 rings at night, first person (spawns in the sea: add `{"eval":"__rv.world.space.dryLand(35,20,10)"},{"advance":1.5}`) | `star=9&planet=5&view=fp&tod=0.05&lat=35&lon=20&yaw=180&pitch=25&weather=clear` |
| W9 orbit: moon night side (city lights) with the backlit ringed giant | `star=2&planet=2.1&view=orbit` |
| W9 dusk: half-lit ringed giant overhead in the pink evening sky | `star=2&planet=2.1&view=fp&tod=0.76&time=60000&weather=clear` + steps `[{"advance":0.3},{"eval":"__rv.world.space.look('parent',0,-10)"},{"advance":0.5}]` |
| W2 dawn comet (sungrazer at perihelion) | `star=11&planet=0&view=fp&tod=0.22&time=24000&weather=clear&only=space,player,atmosphere` + steps `[{"advance":0.3},{"eval":"__rv.world.space.look('comet0', 0, 14)"},{"advance":0.5}]` (full world: trees hide it) |
| sky panorama (debug) | any world + `&skypano=1&only=space,player` |

The sky wheels fast (planet years are hours of game time): use `time=` to pick the season/orbit phase
and `aim()` / `skyInfo()` (via an `eval` step) to find a body's yaw/pitch/angular size; `look(ref)` turns the
camera toward it and `frame(a, b, f)` frames two objects. W9: the moon's orbit is nearly synchronous with the giant's
orbit around the star, so the giant–sun geometry drifts slowly (giant near opposition, up all night:
`time≈95000–130000`; at quadrature, overhead at dusk: `time≈55000–65000`; a thin crescent near the sun:
`time≈20000–30000`).

## Performance
* Season 2 additions: eclipse ring = 1 fullscreen far-plane pass with early discard, only while a body covers the
  star; pulsar = 1 point; a wonder = ≤ 6 draws (ring/orb or slab, beam, pool, edge) + 1 instanced draw of 24–140
  fragments (count × `quality.particleScale`; matrices updated only within 30× the wonder's height); magnification
  and ring opening are a few vector ops per body per frame, no allocations.
* Draw calls: ~4 background + ≤ 3 per visible body (surface, shell, rings) + 1 dot batch + belts + 3 per comet.
* Bake: worker ~4–6 s (768×256 × 40 steps at high, 384×160 × 28 at med/low), cube 768² (high) / 512² (med) /
  384² (low), once per system. `isReady()` waits for it (≤ 45 s).
* Stars: 30k (+24k band stars) at high, 16k med, 9k low. Shader octaves scale with on-screen size.

## Known issues
* Sky magnification is an art-directed lie: the giant is drawn closer along its true direction (all lighting and
  shadows true relative to it), so a sibling moon may pass behind/in front of it in a slightly different place than
  physics says, and the giant shrinks smoothly as a ship climbs (0.08 R → 1.2 R altitude).
* Eclipse by day under an atmosphere: the black disc and its ring render, but the sky and the land stay sunlit until
  the atmosphere track reads `space.eclipse` (Requests).
* Wonders: the site is seeded (or terrain landmarks once exposed); the haze of a thick atmosphere greys the black orb at
  > 8 km. Fragments are lit by the scene (`MeshStandardMaterial`), so they read as silhouettes against the sky.
* The W9 moon orbits at ~7.6 giant radii; the giant's true radius in its sky is 7.3° (drawn at 16°, see above).
* Giant rings seen from a moon are opened to ≥ 25° toward the viewer (moons orbit in the ring plane).
* The critic's far-orbit streak artefact (round 1 `ours_extra0`, `view=orbit&dist=8e6`) could not be reproduced on
  W9 / W4 at several sun angles; the only space-track geometry that produces converging streaks (comet tails seen
  along their axis) is now faded out. If it recurs, suspect temporal reprojection of far-plane point sprites
  (see Requests → post).
* The red glowing dots near the horizon in W9 night shots are not stars (they are drawn with real depth over the
  terrain: civ/fauna glow lights), see Requests.
* The Milky-Way core from star 2 is broad and warm (the observer sits ~1.6 kly below the disk); the mid-plane
  rift is black where the baked dust column saturates.
* Comet tail length is scaled for display (reads like a Great Comet from anywhere), not strictly physical.
* Gas-giant shading costs ~2 × (≤ 6 gradient-noise octaves + 3–4 fbm) per pixel (two flow phases); octaves drop
  with screen size (`uDetail`), a distant giant costs 3 octaves.

## Requests
* **atmosphere** (season 2, being picked up on their side) — `world.get('space').eclipse` (0..1, other bodies only;
  the current planet seen from orbit is in `eclipseView`, which should NOT dim this world's light). Test view: W9
  eclipse by the giant `star=2&planet=2.1&time=525000&tod=0.31`, M1 `star=0&planet=2.0&time=546200&tod=0.33`.
  The eclipse ring could also tint the ground key light warm (`eclipseBody`, ring colour).
* **atmosphere** — the night star-hiding threshold `vis = (bl - 3·sl) / bl` subtracts 3× the sky luminance from the
  background: soft band light turns into hard-edged shapes (the critic's "cream slab with a hard vertical edge").
  A soft ratio at night, e.g. `vis = bl² / (bl² + (k·sl)²)`, would let the Milky Way fade naturally (space then
  drops its night lift: set `atmosphere.starVisNight = true`).
* **atmosphere** — planetshine: from the ground a moon's parent giant is drawn magnified (`entry.mag`, apparent
  angular radius in `space.skyInfo('parent').angDeg`, ~16°); the moon-light pick uses the true size (it is capped
  anyway). A bright, blue-tinted night under a full giant would match the creator's "a night scene can be bright".
* **post** (season 2) — eclipse grading: `space.eclipse` → darker, cooler, more contrast ("an eclipse changes the
  whole palette of the city under it"); keep the eclipse ring (HDR 5–9) blooming.
* **player** — the third-person camera at pitch > ~45° dips under the explorer and shows the ground (W9 dusk,
  giant overhead: `tod=0.76&time=60000`, `look('parent')`): a low "looking up at the sky" framing (u_16/u_17) needs a
  camera that can sit low behind the explorer and tilt up. W12 `view=fp&lat=35&lon=20` spawns in the sea
  (`space.dryLand()` works around it).
* **atmosphere / terrain** (critic, W4 from orbit) — the W4 limb from orbit is a lumpy white rim (terrain/cloud
  relief at the limb) with a green shell outside it; the space track now draws the eclipse ring outside the limb.
* **atmosphere** — (done on their side: no cumulus shell on gas bodies; daytime star threshold only on far-plane
  pixels.) Optional: `world.space.sunVisibility(localPos)` gives eclipse dimming of the key light.
* **core** — `view=fp` ignores `fov=` (forced 72°); a `fov` for fp would allow telephoto shots of planets in the sky.
  Making the first moon of a ringed giant the lush/showcase one (W9 is moon .1 at 7.6 R) would let the giant truly
  fill the sky.
* **post** — lens flare / glare: `world.space.sun` exposes `screen` (NDC), `onScreen`, `visibility`, `color`; the star
  disc is now always ≥ 1.5 px at far-plane depth. Please check that TAA/motion reprojection never smears far-plane
  point sprites (stars) into streaks while the orbit camera zooms out (critic round 1 `ours_extra0`, W9-like
  `view=orbit&dist=8000000`).
* **civ / fauna** — W9 night (`star=2&planet=2.1&view=fp&tod=0.96&time=99000`): several saturated red glowing points
  float near the horizon and over the terrain (beacons or glow creatures?); a critic mistook them for oddly red stars.
  Smaller/dimmer halos at distance would read better.
