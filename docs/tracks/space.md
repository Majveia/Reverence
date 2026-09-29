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
  bodies,                         // [{ b, local (planet-local Vector3), mesh, ring, shell, … }]
  aim(ref, fromLocal?),           // → { yaw, pitch } (deg, 0 = north, 90 = east) toward '0-2-2' | 'sun' | 'galcenter' | 'comet0'
                                  //   | 'parent' (a moon's planet) | 'moon' | 'biggest' (largest body in the sky)
  skyInfo(ref),                   // → { yaw, pitch, id, angDeg, ringDeg } angular radius of the body / its rings
  look(ref, dYaw?, dPitch?),      // capture helper: turns the player camera (fp/surface) toward that object
  frame(refA, refB, f?, dYaw?, dPitch?), // capture helper: looks at the point f of the way from refA to refB
  small.probe(i, t),              // comet i at world time t: { elong, tailView (90 = side-on), dist, r }
  orbitSunShot(deg, rollDeg),     // capture helper for view=orbit: star `deg`° from the planet centre, behind it
}
__rv.state().space → { sky: 'baked'|'baking'|'failed', stars, bodies (visible ids), sunVis, sunAng }
```

## Best capture views (`/?mode=system&galaxy=0&…`)
| view | URL / steps |
|---|---|
| G1 backlit ringed giant (Cassini look: sun over the limb, ring shadow, ring-shine on the night side) | `star=2&planet=2&view=orbit` + steps `[{"advance":0.5},{"eval":"__rv.world.space.orbitSunShot(26, 12)"},{"advance":0.5}]` |
| G1 ringed gas giant from orbit (quarter phase, rings crossing the disk) | `star=2&planet=2&view=orbit&tod=0.3` |
| G1 gibbous: turbulent belts, vortices, rings | `star=2&planet=2&view=orbit` + steps `[{"advance":0.5},{"eval":"__rv.world.space.orbitSunShot(135, 20)"},{"advance":0.5}]` (close-up: `&dist=1300000`, `orbitSunShot(120, -10)`) |
| W9 night: gibbous ringed giant high in the sky, Milky Way toward the core | `star=2&planet=2.1&view=fp&tod=0.96&time=99000&weather=clear` + steps `[{"advance":0.3},{"eval":"__rv.world.space.frame('parent','galcenter',0.55,0,-3)"},{"advance":0.5}]` (giant alone: `look('parent')`) |
| W4 eclipse: star behind the limb, Milky Way behind | `star=2&planet=0&view=orbit&weather=clear` + steps `[{"advance":0.5},{"eval":"__rv.world.space.orbitSunShot(19, 20)"},{"advance":0.5}]` |
| W12 rings arching over the ice at night (planet shadow on the rings) | `star=9&planet=5&view=fp&tod=0.05&lat=35&lon=20&yaw=180&pitch=25&weather=clear` |
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
* Draw calls: ~4 background + ≤ 3 per visible body (surface, shell, rings) + 1 dot batch + belts + 3 per comet.
* Bake: worker ~4–6 s (768×256 × 40 steps at high, 384×160 × 28 at med/low), cube 768² (high) / 512² (med) /
  384² (low), once per system. `isReady()` waits for it (≤ 45 s).
* Stars: 30k (+24k band stars) at high, 16k med, 9k low. Shader octaves scale with on-screen size.

## Known issues
* The W9 moon orbits at ~7.6 giant radii (the first lush moon of a ringed giant is the second moon), so the giant
  spans ~15° of sky (radius 7.3°, rings 16°); `view=fp` is fixed at 72° vertical FOV.
* Giant rings seen from a moon are opened ~24° more than physical (moons orbit in the ring plane).
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
