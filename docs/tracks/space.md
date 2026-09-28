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
  look(ref, dYaw?, dPitch?),      // capture helper: turns the player camera (fp/surface) toward that object
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
| W9 night: ringed giant + Milky-Way core over the moon | `star=2&planet=2.1&view=fp&tod=0.02&time=24000&weather=clear` + steps `[{"advance":0.3},{"eval":"__rv.world.space.look('galcenter', -25, -10)"},{"advance":0.5}]` |
| W4 eclipse: star behind the limb, Milky Way behind | `star=2&planet=0&view=orbit&weather=clear` + steps `[{"advance":0.5},{"eval":"__rv.world.space.orbitSunShot(19, 20)"},{"advance":0.5}]` |
| W12 rings arching over the ice at night (planet shadow on the rings) | `star=9&planet=5&view=fp&tod=0.05&lat=35&lon=20&yaw=180&pitch=25&weather=clear` |
| W9 orbit: moon night side (city lights) with the backlit ringed giant | `star=2&planet=2.1&view=orbit` |
| W9 sunset: ringed giant rising | `star=2&planet=2.1&view=fp&tod=0.74&time=42500&yaw=113&pitch=30&weather=clear` |
| W2 dawn comet (sungrazer at perihelion) | `star=11&planet=0&view=fp&tod=0.22&time=24000&weather=clear&only=space,player,atmosphere` + steps `[{"advance":0.3},{"eval":"__rv.world.space.look('comet0', 0, 14)"},{"advance":0.5}]` (full world: trees hide it) |
| sky panorama (debug) | any world + `&skypano=1&only=space,player` |

The sky wheels fast (planet years are hours of game time): use `time=` to pick the season/orbit phase
and `aim()` (via an `eval` step) to find a body's yaw/pitch.

## Performance
* Draw calls: ~4 background + ≤ 3 per visible body (surface, shell, rings) + 1 dot batch + belts + 3 per comet.
* Bake: worker ~4–6 s (768×256 × 40 steps at high, 384×160 × 28 at med/low), cube 768² (high) / 512² (med) /
  384² (low), once per system. `isReady()` waits for it (≤ 45 s).
* Stars: 30k (+24k band stars) at high, 16k med, 9k low. Shader octaves scale with on-screen size.

## Known issues
* **Gas giants as the current body**: the atmosphere track's cumulus shell would cover the banded deck;
  until it declares `world.atmosphere.gasGiantSurface`, the space track sets `atmosphere.clouds.present =
  enabled = false` once for gas bodies (documented workaround, see Requests).
* Giant rings seen from a moon are opened ~24° more than physical (moons orbit in the ring plane).
* By day the atmosphere pass hides background pixels dimmer than 3× the sky luminance: other planets and
  rings in a bright sky break up into speckles (see Requests).
* The Milky-Way core from star 2 is broad and warm (the observer sits ~1.6 kly below the disk); the mid-plane
  rift is black where the baked dust column saturates.
* Comet tail length is scaled for display (reads like a Great Comet from anywhere), not strictly physical.

## Requests
* **atmosphere** — for `world.body.isGas`: skip the cumulus cloud shell (or render a thin high haze) and set
  `world.atmosphere.gasGiantSurface = true` if you ever render the giant's deck yourself; the space track
  currently disables your clouds for gas bodies (see Known issues). Apply the day-time star-visibility
  threshold (`uStarVis`) only to point-like sources — extended bright bodies (a ringed giant, rings, other
  planets) should stay visible by day like the Moon (e.g. skip the threshold where the background pixel has
  real depth, i.e. not the far plane). Rain streaks are drawn from orbit on W4 (`view=orbit`).
  Optional: `world.space.sunVisibility(localPos)` gives eclipse dimming of the key light.
* **core** — lush moons of ringed giants (W9) orbit at ~11 R; placing the first lush moon at 3.5–5 R would
  make the giant truly fill the sky. `view=fp` ignores `fov=` (forced 72°); a `fov` for fp would allow
  telephoto shots of planets in the sky.
* **post** — lens flare / glare: `world.space.sun` exposes `screen` (NDC), `onScreen`, `visibility`, `color`.
