# Track: galaxy — galaxies, nebulae & the central black hole

Owner paths: `src/modes/galaxy/**`, `src/universe/GalaxyModel.js`, this file.

## What it is

One galaxy of the universe (`&galaxy=<i>`), from the whole disk seen from 200 kly away down to a
stellar neighbourhood of individually clickable stars, into volumetric nebulae, and down to the event
horizon of the supermassive black hole at the centre. Everything is deterministic from the
`Universe.galaxy(i)` record; star `i` in the mode is exactly `Universe.star(g, i)` (same position,
class and temperature), so picking a star and travelling to it lands in that star's system.

Units: 1 scene unit = 1 kly. Galaxy at the origin, disk in the XZ plane, +Y galactic north.
GalaxyModel works in ly.

### GalaxyModel (`src/universe/GalaxyModel.js`, shared source of truth)

* `galaxyStar(galaxy, i, out)` → `{x,y,z (ly), cls, temperature, luminosity, radiusSolar, component,
  young, sub, follow}`. **Class/temperature/luminosity of global stars are bit-identical to the original
  placeholder** (showcase systems W1–W12 depend on them); positions come from the structured model.
* `STAR_CLASSES`, `CLASS_INDEX`, `GLOBAL_STARS` (2²² representative stars; any prefix is a fair sample).
* Structure (`galaxyStructure(g)`, cached): log-spiral density-wave arms with noise warp, per-arm
  strength/extent, fragmentation, spurs, flocculence; bars (Ferrers), inner/outer rings, lenticular
  lenses with Sombrero-like dust rings, elliptical shells and Cen-A-like dust lanes, irregular clumps,
  Hernquist/Plummer bulges, nucleus, stellar halo, 70–420 globular clusters, jittered-grid cluster/HII
  sites shared bit-exactly with the GPU (`shaders/galaxyCommon.js`).
* Populations: young stars sit downstream of the dust lanes, spread by age (O/B tight, K/M wide);
  open clusters gather around HII sites; old disk follows a flat rotation curve, pattern rotates rigidly
  (`rotationOmega`, `patternOmega`), halo is almost static.
* Local LOD stars: index space `LOCAL_BASE + code` decodes to a 200 ly cell (`localIndex`, `decodeLocal`,
  `forEachLocalStar`, `localCellCount`) with counts from `galaxyDensity(g, x, y, z)`. Local indices are
  valid star indices for `Universe.star(g, i)` and `director.go('system', {galaxy, star: i})`.
* `galaxyNebulae(g)` → 10 named nebulae (emission / pillars / planetary / remnant) at the brightest HII
  sites; `globularClusters(g)`.

### Rendering (`src/modes/galaxy/`)

| file | what |
|---|---|
| `GalaxyVolume.js` + `shaders/maps.js` + `shaders/volume.js` | One-off GPU disk map (old stars, young stars, dust, HII; braided arms, knots, spurs, bar lanes, nuclear rings, fine dust filaments) + 3-D tileable noise. Per frame a low-res raymarch: disk layers integrated **exactly** per step (sech² / Gaussian antiderivatives → no banding), bulge (4 Plummer + finite extended envelope), bar (Ferrers) and halo integrated **analytically** per segment, wavelength-dependent dust extinction (reddening), clumpy local obscuration, bicubic upsample, composited as `emission + dst × transmittance`. |
| `StarField.js` + `shaders/stars.js` + `starWorker.js` + `starPack.js` | 1.2 M (× `particleScale`) GPU points generated in workers; blackbody colours, flux-conserving PSF (core + halo + diffraction spikes for bright stars), sub-pixel handling, per-star dust extinction toward the camera through the same dust field, differential rotation in the vertex shader. Local LOD population (up to 240k × `particleScale`) streamed by workers around the camera target; global tracers fade out inside the LOD sphere. |
| `BlackHole.js` | Full-screen effect (pipeline one-shot effect, order 150) within 20 000 r_s: Schwarzschild null geodesics per pixel (velocity-Verlet on x'' = −3/2 h² x / r⁵), weak-field deflection far out, thin disk with Novikov–Thorne-like temperature, ISCO from spin (Kerr-inspired), Doppler beaming g³ + gravitational redshift + blackbody shift, Keplerian turbulent streaks, multiple crossings → photon ring and lensed far side of the disk. The background frame is re-sampled along bent rays. |
| `Nebulae.js` | Up to 3 nearest nebulae raymarched at reduced resolution when within ~60 radii: emission clouds (wind-blown cavity, ionised walls, dust lanes with ionisation-front rims, reflection haze), pillars (Pillars-of-Creation columns with lit tips, teal/gold haze), planetary nebulae (prolate shell, [OIII] core, Hα rim, cometary knots, white dwarf), SN remnants (filamentary shell, pulsar). Hubble or natural palette. Discovery toast + markers. |
| `Backdrop.js` | ~2 600 distant background galaxies (spiral / elliptical / edge-on, redshifted colours) + foreground halo stars, one instanced draw at infinity. |
| `GalaxyCamera.js` | Log-distance orbit rig over ~15 orders of magnitude, zoom toward the cursor point on the disk, pan, cinematic `flyTo`, idle drift, target in the pattern frame (co-rotates). |
| `Reticle.js` | Selection ring. |
| `index.js` | Mode: generation, LOD, picking, selection UI, travel, exposure metering (edge-on disks metered down, eye adaptation when diving into the disk, disk-dominated exposure next to the hole), telemetry (`Scale`, `Horizon` in r_s). |

### Interaction

* Drag = orbit, wheel / pinch = zoom (toward the point under the cursor), WASD/stick = pan, ascend/descend.
* Tap/click a star → selected (reticle + marker with name, class, temperature + prompt
  "Travel to <name>"). Tap it again, double-tap, or press E / the prompt → camera flies to it, then
  `director.go('system', { galaxy, star: index }, { transition: 'white' })`. Esc clears the selection.
* Picking is a screen-space search over all GPU star positions (same rotation maths as the shader),
  scored by apparent brightness and distance to the tap; touch uses a larger radius (26 px).

## URL parameters

`&galaxy=<i>` · `&yaw=<deg>` `&pitch=<deg>` `&dist=<kly>` · `&focus=core | local | star:<i> | neb:<k>`
(`&dist` is in r_s with `focus=core`, in nebula radii with `focus=neb`) · `&star=<i>` focuses/selects a
star · `&gx=OldL:0.4,YoungL:0.8,HiiL:2,DustL:8,Screen:0.9,BulgeL:24,HaloL:0.35,exp:0.8,stars:1` art-direction overrides.

Galaxy types for seed 1: 0 ring (4 arms), 1 spiral (3), 2 barred (3), 3/4/6/16/19/20 spiral,
5/17/21/23 lenticular (Sombrero-like dust rings), 7/11/12/14/15/18 barred, 8 elliptical, 9/22 irregular, 10/13 ring.

## Best capture views

| view | URL |
|---|---|
| grand-design spiral (Whirlpool-like) | `/?mode=galaxy&galaxy=2` |
| ring galaxy, whole disk | `/?mode=galaxy&galaxy=0` |
| 2-arm spiral face-on | `/?mode=galaxy&galaxy=19&pitch=58&yaw=20` |
| barred spiral | `/?mode=galaxy&galaxy=7&pitch=70` or `galaxy=14&pitch=65` |
| Sombrero (edge-on lenticular) | `/?mode=galaxy&galaxy=5&dist=100&pitch=7` |
| edge-on spiral with dust lane | `/?mode=galaxy&galaxy=1&dist=150&pitch=4` |
| elliptical | `/?mode=galaxy&galaxy=8&pitch=25` |
| irregular | `/?mode=galaxy&galaxy=9` |
| black hole (lensing, disk, photon ring) | `/?mode=galaxy&galaxy=0&focus=core&pitch=16&yaw=40` (or plain `focus=core`) |
| pillars nebula | `/?mode=galaxy&galaxy=0&focus=neb:1` |
| emission nebula | `/?mode=galaxy&galaxy=0&focus=neb:4` (also `neb:0`) |
| planetary nebula | `/?mode=galaxy&galaxy=0&focus=neb:3` |
| stellar neighbourhood (LOD stars, open cluster) | `/?mode=galaxy&galaxy=0&focus=local&dist=2.5&pitch=12` |
| selected star + UI | `/?mode=galaxy&galaxy=0&focus=local` + `--ui --steps '[{"advance":1},{"click":[520,248]},{"advance":0.6}]'` (960×540) |

## Performance

* Stars: `displayStars (1.2M) × particleScale` (low 300k … ultra 2.4M), one draw call; vertex shader
  does rotation + 3–8 dust samples (tier-scaled) per star; faint stars are culled in the vertex shader.
* Volume raymarch: 48–144 steps at 34–60 % resolution (pixel cap per tier); nebulae 36–110 steps at
  34–60 %, only when close; black hole 110–320 geodesic steps, only within 20 000 r_s (full-res; strong
  field only inside ~320 r_s impact parameter, weak-field analytic deflection elsewhere).
* Draw calls ≈ 15–18. Generation fully in workers (main-thread fallback time-sliced).

## Known issues

* The black-hole effect is full resolution; on low-end mobile at `focus=core` it is the most expensive view
  (steps scale with tier).
* Picking scans all global stars on the CPU on tap (~10–30 ms for 1.2 M) — fine for taps, not per-frame hover.
* Emission nebulae still read somewhat spherical from some angles; pillars are always the 3-column motif.
* Edge-on spirals: the dust lane is correct but the edge-on disk is thin and a bit faint at default exposure.

## Requests

* **space** — the night sky could render this galaxy from the current star with `galaxyDensity()` /
  `galaxyStructure()` (the Milky-Way band of the *actual* host galaxy, with its dust lanes).
* **audio** — galaxy mode calls `audio.play('select')` on star selection and `audio.play('whoosh')` on travel.
* **ui** — telemetry keys `Scale` and `Horizon` (strings); markers use `sub` for class · temperature.
