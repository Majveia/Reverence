# Space track — star, sky, other bodies, rings, belts, comets

Owner paths: `src/world/space/**`, `docs/tracks/space.md`.
Subsystem `space` (order 5), auto-loaded by `World`. Every part is fault-isolated (a failing part is
logged and skipped; the frame loop never sees an exception).

## What was built

| file | what |
|---|---|
| `index.js` | subsystem glue, per-frame context (camera, pixel angle, in-atmosphere factor, sun illuminance), public API (`world.space`) |
| `skyBake.js` + `sky.worker.js` | **host-galaxy night sky**, baked in a worker from `GalaxyModel`: log-stepped ray march of `galaxyDensity()` from this star (bulge / old disk / young arms + HII glow, wavelength-dependent dust extinction) → equirect HDR band with non-linear latitude rows (0.25° at the galactic equator); **resolved stars** = the real local-neighbourhood stars (`forEachLocalStar`, ≤1200 ly) + luminous giants from the global population, flux L/d², blackbody colours, reddening by the dust column; + ~24k faint stars distributed like the band's light (the band sparkles); notable nebulae (`galaxyNebulae`) with angular sizes |
| `sky.js` | one GPU pass bakes a detailed **cube map** (galaxy frame): soft band + dust filaments / rift, star clouds, nebula glows, log response with a true-black floor; per frame a far-plane fullscreen triangle samples it through `uL2G = qGal · celestial.q` (the sky wheels with the planet's spin and the orbit). Stars are `THREE.Points` (gaussian core + halo, diffraction spikes only for the ~15 brightest, scintillation inside an atmosphere). Distant galaxies are procedural sprites (spiral / elliptical, one "Andromeda" hero). `?skypano=1` shows the baked sky as an equirect panorama (debug). |
| `star.js` | **the star**: far-plane billboard with correct angular size (`star.radius / distance`), HDR limb-darkened disk (quadratic law, redder limb), animated granulation (worley) when resolvable, sunspots/faculae (activity = `star.flare`), chromosphere, prominences, streamer corona (∝ r^-3.2) visible from space, soft glare halo. Planets/terrain occlude it naturally (eclipses). |
| `bodies.js`, `bodyLook.js`, `bodyShaders.js` | **other planets & moons** (+ the current body when it is a gas giant, + the current body's rings): real spheres at `celestial.bodyLocal(b)` with the body's tilt & spin. Rocky shader: domain-warped continents vs `ocean.oceanFraction`, art palette (grass/veg/sand/rock/snow/water/deep), ice caps by zone/type, craters (airless/barren), dunes, crystal facets, bump from the mountain field, ocean sun glint, animated cloud layer + cloud shadows, lava seas / lava cracks (volcanic), **city lights on the night side for civ ≥ 3** (neon palette for `civ.style = neon`). Gas shader: art-directed band palette (jovian / saturnian / ice / exotic, tinted by `art.palette`), flow-map animated zonal jets, turbulent festoons, vortex storms (GRS-like oval), Minnaert limb darkening, reddened terminator. **Atmosphere limb shells** (10-step single scattering, art sky tint, planet shadow, eclipses) — blend `ONE, SRC_ALPHA` so they also extinguish the surface behind. **Rings**: procedural radial profile (C/B/A rings, Cassini division, Encke gap, F ring, 140 ringlets, mipmapped), single-scattering slab model (lit/unlit side, icy backscatter + dusty forward scatter), **planet shadow on the rings, ring shadow on the planet**, spokes. **Eclipses**: every surface/shell takes up to 4 spherical occluders (moons ↔ parent, the camera's own body) with penumbra. Far bodies become "wandering star" dots (phase-correct flux). |
| `smallBodies.js` | **asteroid belts** (`system.belts`): Keplerian particle streams in the vertex shader (differential rotation, Kirkwood-like gaps, phase-lit, sized by angular size); **comets** (`system.comets`): nucleus + coma sprite, straight blue ion tail (streamers) along anti-star, broad curved dust tail trailing the orbit, length/brightness by heliocentric distance. |

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
  aim(ref, fromLocal?),           // → { yaw, pitch } (deg, 0 = north, 90 = east) toward '0-2-2' | 'sun' | 'galcenter'
  orbitSunShot(deg, rollDeg),     // capture helper for view=orbit: star `deg`° from the planet centre, behind it
}
__rv.state().space → { sky: 'baked'|'baking'|'failed', stars, bodies (visible ids), sunVis, sunAng }
```

## Best capture views (`/?mode=system&galaxy=0&…`)
| view | URL / steps |
|---|---|
| W9 night: ringed giant + Milky Way core | `star=2&planet=2.1&view=fp&tod=0.02&time=24000&yaw=135&pitch=30` |
| W9 sunset: ringed giant rising | `star=2&planet=2.1&view=fp&tod=0.74&time=42500&yaw=113&pitch=30&weather=clear` |
| G1 ringed gas giant from orbit | `star=2&planet=2&view=orbit&tod=0.3` (see known issues: atmosphere clouds) |
| W4 eclipse: star behind the limb, band behind | `star=2&planet=0&view=orbit&weather=clear` + steps `[{"advance":0.5},{"eval":"__rv.world.space.orbitSunShot(19, 20)"},{"advance":0.5}]` |
| W12 rings from the ground at night | `star=9&planet=5&view=fp&tod=0.05&lat=35&lon=20&yaw=180&pitch=25` |
| sky panorama (debug) | any world + `&skypano=1&only=space,player` |

The sky wheels fast (planet years are hours of game time): use `time=` to pick the season/orbit phase
and `aim()` (via an `eval` step) to find a body's yaw/pitch.

## Performance
* Draw calls: ~4 background + ≤ 3 per visible body (surface, shell, rings) + 1 dot batch + belts + 3 per comet.
* Bake: worker ~4–6 s (768×256 × 40 steps at high, 384×160 × 28 at med/low), cube 768² (high) / 512² (med) /
  384² (low), once per system. `isReady()` waits for it (≤ 45 s).
* Stars: 30k (+24k band stars) at high, 16k med, 9k low. Shader octaves scale with on-screen size.

## Known issues
* The atmosphere track's volumetric cloud layer covers the current body even when it is a gas giant
  (G1 orbit view shows cumulus instead of the banded giant) — see Requests.
* Giant rings seen from a moon are opened ~24° more than physical (moons orbit in the ring plane).

## Requests
* **atmosphere** — for `world.body.isGas`: disable the cumulus cloud shell (or replace it by a thin
  high haze); the space track already renders the banded, animated giant surface under your scattering.
  Also: apply the day-time star-visibility threshold (`uStarVis`) only to point-like sources — extended
  bright bodies (a ringed giant in the sky, the other planets) should stay visible by day like the Moon.
  Optional: `world.space.sunVisibility(localPos)` gives eclipse dimming of the key light.
* **core** — lush moons of ringed giants (W9) orbit at ~11 R; placing the first lush moon at 3.5–5 R would
  make the giant truly fill the sky.
* **post** — lens flare / glare: `world.space.sun` exposes `screen` (NDC), `onScreen`, `visibility`, `color`.
