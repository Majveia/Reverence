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
| `FaintStars.js` | The unresolved crowd of faint dwarfs in the stellar neighbourhood: ~175k (tier-scaled) procedural GPU points in a world-anchored 12-ly grid around the camera (stable while moving), counts follow the disk map × sech² vertical profile, dwarf-dominated luminosity function, same single-star gain as the LOD stars. Not pickable (the catalogued LOD stars are). |
| `Backdrop.js` | ~2 600 distant background galaxies (spiral / elliptical / edge-on, redshifted colours) + foreground halo stars, one instanced draw at infinity; plus 1.5–4k foreground field stars with diffraction spikes (second draw, fades inside a galaxy). |
| `GlobularClusters.js` | The globular-cluster system as compact golden Plummer point sources (log-normal luminosities), one draw. |
| `NebulaStars.js` | Dense star field of a visited star-forming region (JWST PSF), behind (attenuated by the nebula) + in front, two instanced draws, only near a nebula. |
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

## Round 2 changes (critic r1 → fixes)

* **Framing**: the default whole-galaxy distance is *fitted* to the projected visible extent (disk rim,
  ring + offset, Sombrero dust ring, elliptical) and a lens shift (`camera.setViewOffset`) centres the
  inclined disk (its near side looms larger); both fade out as you zoom in. Galaxies now fill the frame
  like the Hubble references. Sombrero-like S0s default to a 6.5° edge-on view.
* **Colour / structure**: bluer, dimmer young arms (no white "cotton" ridges), star-tracer share of the
  disk light 0.4 → 0.26 (old-disk tracer weight 0.45 → 0.3) → far less point grain; arm clumps and in-arm
  dust are now sampled in a **log-polar frame sheared by differential rotation** (long strands along a
  slightly tighter spiral, periodic cos/sin embedding) — M51-like "fingerprint" dust filaments instead of
  isotropic crumpled ridged noise; the isotropic dust web is much weaker on spirals.
* **Sombrero**: bright flat lens inside the dust ring, the stellar disk (map + GalaxyModel star
  positions) truncated just outside the ring, granular optically-thick lane (brown where reddened light
  leaks through), bigger/brighter extended envelope so the lane silhouettes against the bulge,
  neutral white-lavender palette.
* **Pillars**: new shading — umber dust bodies with self-shadowed direct light from the cluster
  (above-right), gold ionisation skins, backlit translucent edges, vertical striations; reshaped columns
  (bending, pinching, swollen heads, broad base mound); a textured **cavity wall** (HII-region shell of
  radius 2.6 R, two analytic samples per ray) fills the frame with teal/gold nebulosity and dark clouds
  (no more circular teal disc).
* **Stellar neighbourhood**: `FaintStars` crowd + 2.2× local star gain with a softer luminosity
  exponent; the view defaults to looking along the disk toward the galactic centre (pitch 5°); the
  galaxy's diffuse band stays visible (floor 0.16); magnified map texels (HII knots, dust) are faded /
  smoothed inside the disk (no blocky knots or checkerboards).
* **Black hole**: next to the hole the nucleus glow and the faint-star crowd are exposed down to black
  and a procedural sky of sharp stars is lensed by direction (Einstein-ring arcs) → Interstellar look
  from any `focus=core` view.
* **Cartwheel**: spokes end at the collisional ring (model + map). Emission-nebula envelope noise reduced.
* Inbox: the `VALIDATE_STATUS` shader error no longer reproduces (all galaxy shaders include `rv_common`
  where they use its helpers; `check.mjs` galaxy scene is clean).
* `&gx=` gained A/B keys: `tm:agx|aces|reinhard|none`, `sat`, `fsat`, `fpow`, `bloom`, `Detail` (0 = no
  full-res detail transfer), in addition to uniform names (`DustNoise`, `DiskW`, `YoungL`, …).

## Round 3 changes (critic r2 → fixes)

* **Spiral structure (maps.js)**: the arm frame is now a *conformal log-polar* frame (a log spiral is a straight
  line in (θ, ln r)): `al` is constant along the arm's orthogonal trajectories, `ac` across it, so anisotropic noise
  is really stretched *along* the arms (the old r/sin p coordinate changed 3.7× faster across the arm → brush-stroke
  grooves). Dust lanes are a **bundle of woven filaments** (≈7:1 anisotropic ridged noise, braided by a warp, lane
  centre and width wandering along the arm, segments breaking and re-forming, a thinner secondary lane upstream),
  at moderate optical depth (τ_B ≈ 1.5 body, 4–6 in strands: brown where reddened light leaks through).
  **Feathers / spurs**: steeper-pitched dust filaments (pitch + 43°) leaving the lane downstream and cutting the arm
  into segments, with blue spur fragments between them. **Inner "fingerprint"** of fine, tightly wound dust filaments.
  **HII strings**: complexes strung along the young edge of each lane (two knot scales, gated by along-arm complexes),
  each ringed by its blue cluster; isolated site blobs and interarm pink dots reduced. **Arm width tapers** (narrow
  inside, broad and frayed outside), outer arms fragment into star clouds, stronger along-arm brightness variation,
  the density wave also brightens the old disk (white arms, not only blue). The old disk is smooth (no "cracked mud"),
  the isotropic dust web is gone from spirals, and the low-frequency 3-D volume noise is faded out when viewing the
  galaxy from outside (it is kept up close). Creamier old-disk / bulge palette.
* **Barred**: two offset bar lanes on the leading edges (filamentary), converging on the nuclear ring; arm lanes start
  at the bar ends (no dark blobs at the bar tips).
* **Foreground field stars (Backdrop.js)**: 1.5–4k (tier) sharp point sources in front of every galaxy, power-law
  fluxes, blackbody colours, Hubble 4-point diffraction spikes on the bright ones; fade out when diving into a galaxy.
* **Globular clusters (GlobularClusters.js, new)**: the galaxy's 70–420 globulars (GalaxyModel.globularClusters) as
  compact golden Plummer point sources with a log-normal luminosity function (one draw).
* **Pillars (Nebulae.js)**: JWST composition — four leaning, tapered columns (smooth-union capsules, swollen heads,
  common base cloud) pointing at the cluster (upper right), 3-iteration domain warp, grooves stretched along the light
  direction; 5-sample self-shadowing toward the cluster, ionisation-front skin, compact evaporating wisps, red
  protostar knot; JWST palette (gold lit dust, rust bodies, deep-blue cavity). Sphere-traced adaptive stepping through
  the SDF (no sampling grain), larger bounding sphere (no clipping).
* **Nebula star field (NebulaStars.js, new)**: 4–14k stars around a nebula you are visiting, JWST 6+2-spike PSF; the
  background set is drawn *before* the nebula composite so dense dust hides it, a sparse set in front.
* **Planetary nebula**: Helix-like — [OIII] teal-blue interior, a pole-on thick-torus Hα/[NII] shell (orange-red,
  clumpy, radial structure), inner bright rim with cometary knots (bright heads, radial dark tails), broken outer halo.
* **Emission nebula**: envelope of 4 warped ellipsoidal lobes with soft noise-faded edges (no sphere / box outline),
  Bok globules.
* **Stellar neighbourhood (focus=local)**: the camera sits inside the thin dust layer (like the Sun) → the galaxy is a
  band split by a dust rift instead of a hard horizon over a dust "floor"; magnified map lookups are domain-warped
  by 3-D noise (no flat stretched rectangles); diffuse disk light within the resolved radius (LOD) is not
  double-counted as glow (`uResolvedR`).
* **Sombrero**: crisp optically thick annulus (flat-topped, τ varying along the lane), bright lens right up to the
  lane (no dark gap), disk truncated just outside it, thinner dust layer (0.45 h_dust), halo 0.35×, smaller envelope,
  far fewer grainy tracer points (disk / spheroid tracer weights), pitch 5.2°.
* **Cartwheel**: 10–14 broad, faint spokes of varying length and strength, brighter toward the ring (model + map +
  GPU mirror), spoke stars spread 2×, 78 % of arm stars in the ring, **no stars beyond the ring** (the retry loop could
  re-sample r past the spoke end: fixed; 0 of 200k stars beyond 1.15 R), old disk visible between spokes.
* **Elliptical**: globular-cluster swarm, nuclear dust disk (+ Cen-A-like lane when `dustLane`), exposure 0.85 → 1.7.
* **Irregular**: lopsided old body, domain-warped gas filaments / bridges, super star clusters, a ragged dust lane,
  fewer dust "cracks" inside the clumps.
* **Black hole**: soft knee on the g³ beaming of the approaching side (structure instead of a white clip), trailing
  log-spiral striations (shear), three orbiting hot spots.
* **UI**: the arrival title card fades out as soon as a star is selected (`ui.hideTitle()` if present, else a guarded
  fade), selection label placed clear of the reticle (above, or below near the top edge), bigger brighter reticle
  (≈38 px ring + ticks). Picking now applies the same LOD fades as the shaders (no selecting invisible stars).
* **Debug**: `&gxdebug=map` draws the disk map face-on (old/young light, dust, HII) — handy for map work.
* `GalaxyModel.galaxyDisplayColors(galaxy)` — the saturated display palette the galaxy mode renders (answers the ui
  request for more saturated `colors.arms`; Universe's own record is core-owned).

## Season 2 round 2 (critic s2r1 → fixes)

* **Black hole = the ring of the source (BlackHole.js)**
  * The disk is now made of **analytic orbiting arcs** (`arcs()`): per ln-r band one thin line at a random offset,
    cut into an integer number of dashes (seamless in azimuth), random length and brightness, slight trailing
    shear, three layers (F = 30, 69, 159 bands per ln r). Lines are widened and dimmed to ≥ ~1 px
    (energy-conserving analytic AA), so unresolved bands fade into an even glow instead of a dotted wire or
    blocky noise. Replaces the low-frequency fbm "camouflage" (critic #1).
  * Gold "ring of fire" colour ramp (deep red embers → orange → gold → warm white at the ISCO), beaming g³ with a
    soft knee, steeper outward fall-off (prof^3.8, outer edge fades from 0.25 to 0.9 × r_out), white-hot inner
    heart (`uDiskBase`, larger when unresolved / far, small up close so the arcs carry the light).
  * **Distance exposure** `uDiskK` = `diskK` (2.2) × (0.34 … 1) with log distance: up close the frame is filled
    by the hottest gas and is exposed down (no white-out). Near the hole (and near nebulae) the mode switches the
    pipeline tone map to `agx-punchy` (hue 0.7) so the gold and Hα stay saturated instead of sliding to cream
    (galaxy-mode settings only; the Director resets the look on mode change).
  * Photon ring drawn analytically at pixel scale (gold-white core + soft outer glow, Doppler-brighter side,
    black inside); the shadow is true black (bloom scaled down next to the hole).
  * **Pillar of light**: a collimated polar jet (gold-white core, fiery flickering sheath, travelling knots)
    integrated along the bent rays; it fades when seen pole-on so it never fogs the shadow (`&gx=Jet:`).
  * **Torn space**: red Hα / teal [OIII] veils with dark filaments around the hole, a function of direction only,
    so the geodesics wrap it into Einstein rings; concentrated around the hole's direction and added outside the
    nucleus-glow gain (it was invisible before). Default subtle (0.1); `&gx=Torn:0.28` for the Cosmic &
    Otherworldly look (black orb, blazing gold ring, pillar of light, space torn red and teal).
* **Nebulae colour the space around them (Nebulae.js)**: an analytic halo per nebula (Gaussian columns
  integrated along the ray through the impact point, three radii up to ~5 R), broken into wisps by noise at the
  point of closest approach, hue shifting toward the complementary colour at the edge (Helix teal → red,
  emission Hα → teal). `uHalo` scales it.
* **Helix**: eye-shaped (1.28 elongation), cyan [OIII] interior with a radial gradient (darker centre, bright
  toward the rim), a brighter cyan-white inner rim, radially streaked Hα shell.
* **Emission nebula**: larger teal [OIII] core, denser dark dust (τ 16 → 26 per unit).
* **Pillars**: deeper umber shadows, richer gold lit faces, directional (TL²) ionisation rims instead of a pale
  skin over the whole surface, backlit translucent fringes, fewer pale wisps.
* **Stellar neighbourhood**: inside the disk (camera within ~2 kly of its target, within 1.5 h_old of the plane,
  away from the nucleus and from a visited nebula) the lens widens 42° → 72° and the reddening along in-plane
  sight lines is softened (`uExt`), so the galaxy reads as a band with dark sky above and below rather than a
  brown wall; diffuse light gain ×1.5 there. Picking uses the same camera, so selection still matches.
* **Spirals**: creamier old disk / bulge palette, brighter old disk (`uOldL` 0.45 for spirals), inner disk
  brightened (×2.7 at the centre, e-folding 0.17 R) with half the dust there, so the centre is never darker than
  the arms. GalaxyModel: 2–3-arm spirals open up to ≥ 18–26° pitch (independent hash; galaxy 0 and the showcase
  systems are unchanged; star class / temperature / luminosity unchanged).
* `state()` reports `inDisk`, `fov`, `camY`, `camR`, `R`, `neb` for capture debugging.

## URL parameters

`&galaxy=<i>` · `&yaw=<deg>` `&pitch=<deg>` `&dist=<kly>` · `&focus=core | local | star:<i> | neb:<k>`
(`&dist` is in r_s with `focus=core`, in nebula radii with `focus=neb`) · `&star=<i>` focuses/selects a
star · `&gx=OldL:0.4,YoungL:0.8,HiiL:2,DustL:8,Screen:0.9,BulgeL:24,HaloL:0.35,exp:0.8,stars:1` art-direction overrides.
Black-hole keys: `&gx=Jet:0.06,Torn:0.1,DiskK:2.2,DiskGain:5,DiskT:6000,DiskOut:20,Ring:1`.

Galaxy types for seed 1: 0 ring (4 arms), 1 spiral (3), 2 barred (3), 3/4/6/16/19/20 spiral,
5/17/21/23 lenticular (Sombrero-like dust rings), 7/11/12/14/15/18 barred, 8 elliptical, 9/22 irregular, 10/13 ring.

## Best capture views

| view | URL |
|---|---|
| black hole, oblique (Interstellar: lensed gold disk over and under the shadow, photon ring, jet) | `/?mode=galaxy&galaxy=0&focus=core` |
| black hole, face-on ring of fire (u_14) | `/?mode=galaxy&galaxy=0&focus=core&pitch=89&dist=30` |
| black hole, filling the view | `/?mode=galaxy&galaxy=0&focus=core&pitch=78&dist=9` |
| the source, otherworldly (black orb, gold ring, pillar of light, space torn red and teal) | `/?mode=galaxy&galaxy=0&focus=core&pitch=4&yaw=30&dist=60&gx=Torn:0.28` |
| black hole from afar (small and glowing) | `/?mode=galaxy&galaxy=0&focus=core&pitch=25&dist=140` |
| grand-design spiral | `/?mode=galaxy&galaxy=3` (face-on `&pitch=89`) |
| barred spiral | `/?mode=galaxy&galaxy=7` or `galaxy=2` |
| cartwheel ring galaxy | `/?mode=galaxy&galaxy=0` |
| Sombrero (edge-on lenticular) | `/?mode=galaxy&galaxy=5` |
| elliptical / irregular | `/?mode=galaxy&galaxy=8` / `galaxy=9` |
| planetary nebula (Helix) | `/?mode=galaxy&galaxy=0&focus=neb:3` |
| pillars nebula | `/?mode=galaxy&galaxy=0&focus=neb:1` |
| emission nebula | `/?mode=galaxy&galaxy=0&focus=neb:4` |
| stellar neighbourhood (band + rift, wide lens) | `/?mode=galaxy&galaxy=3&focus=local` |
| selected star + UI | `/?mode=galaxy&galaxy=3&focus=local` + `--ui --steps '[{"advance":1},{"click":[576,469]},{"advance":0.8}]'` (1280×720; an O supergiant) |
| disk map debug | `/?mode=galaxy&galaxy=3&gxdebug=map` |

## Performance

* Stars: `displayStars (1.2M) × particleScale` (low 300k … ultra 2.4M), one draw call; vertex shader
  does rotation + 3–8 dust samples (tier-scaled) per star; faint stars are culled in the vertex shader.
* Volume raymarch: 48–144 steps at 34–60 % resolution (pixel cap per tier); nebulae 36–110 steps at
  34–60 %, only when close; black hole 110–320 geodesic steps, only within 20 000 r_s (full-res; strong
  field only inside ~320 r_s impact parameter, weak-field analytic deflection elsewhere).
* Faint neighbourhood stars: 26³×10 (high) / 22³×10 (med) / 18³×6 (low) procedural points, only drawn
  inside the LOD range; one texture fetch per vertex.
* Draw calls ≈ 20–27 (measured 22 whole-galaxy, 27 at a nebula); triangles ≤ 64k (instanced star quads).
  Pillars: sphere-traced through the SDF (2.6 × tier steps max, 5 shadow samples only inside / near the dust).
  Generation fully in workers (main-thread fallback time-sliced).

* (s2r2) Black-hole disk arcs: 3 layers of hash-only dashes per disk crossing (cheaper than the old 3-octave
  simplex noise); nebula halo: 4 noise fetches per pixel per active nebula, analytic column (no extra steps).

## Known issues

* (s2r2) Pillars are richer in colour but still read as soft "cotton" columns; the cluster's self-shadowing gives
  little side-to-side modelling from the default view. The JWST fine striations and dense spiked-star field are
  not there yet.
* (s2r2) The hero spiral is brighter in the centre but still reads synthetic beside M51 (regular arms, few HII
  strings, no companion galaxy, no foreground depth layers).
* (s2r2) Stellar neighbourhood: the band is now a band, but it is dim and brownish-grey with a fairly uniform rift
  and faint vertical streaks in the volume; galaxy 0's local star sits in the Cartwheel ring, so its view toward
  the centre is mostly empty (use galaxy 3).
* (s2r2) Face-on hole (u_14): the inner disk is gold rather than u_14's near-white blaze, and the disk reaches a
  little further out before fading to black.
* Spirals are much closer to Hubble structure but still read a little "rendered": the young arms are clean
  blue-white ribbons of beaded clusters, HII strings are sparser than M51's, and lanes are thinner than the
  reference's broad brown bundles at full-galaxy scale (the map is 2048² → ~1.7 texels / px at 1280).
* Pillars: composition, palette, self-shadowing and sculpting are JWST-like, but the surfaces are still somewhat
  "fluffy" (cotton edges) rather than smooth translucent veils; the field-star density is lower than JWST's.
* Emission nebula (`neb:4`) is irregular now but still a compact pink cloud with "cotton" texture.
* Sombrero lane is crisp and opaque but grey-black (the reference's brown, textured near edge is not reproduced).
* From inside the disk (`focus=local`) the band spans the whole 42° frame (realistic for the old-disk scale height
  vs. FOV) and reads brownish; the rift is fairly uniform (dust clumps within ~1 kly are weak).
* Elliptical: the globular-cluster swarm near the core is dense enough to read like a star cluster; shells are only
  in the star tracers (faint).
* Picking scans all global stars on the CPU on tap (~10–30 ms for 1.2 M) — fine for taps, not per-frame hover.
* The black-hole effect is full resolution; on low-end mobile at `focus=core` it is the most expensive view.
* Galaxy-0 nebula positions (`neb:N`, picked from HII sites) moved with the r3 Cartwheel spokes (pillars `neb:1` and
  planetary `neb:3` are unchanged; the emission nebula `neb:4` moved).
* `node tools/check.mjs`: ALL OK (build + cosmic, galaxy, system-orbit, system-surface).

## Requests

* **ui** — please add `ui.hideTitle()` (fade the arrival title card now). Galaxy mode calls it on star selection; until
  it exists it shortens `ui.titleS.dur` (guarded). Also: the lower-third title card overlaps the bottom-centre prompt
  pill ("Travel to …") when both are up — could the card sit above the prompt row, or yield to it?
* **ui** (answer to "more saturated galaxy colors.arms") — `GalaxyModel.galaxyDisplayColors(galaxy)` returns the
  saturated display palette (core / arms / hii / dust, linear, max = 1) the galaxy mode renders; Warp.js could use it.
* **space** — the night sky could render this galaxy from the current star with `galaxyDensity()` /
  `galaxyStructure()` (the Milky-Way band of the *actual* host galaxy, with its dust lanes).
* **audio** — galaxy mode calls `audio.play('select')` on star selection and `audio.play('whoosh')` on travel.
* **ui** — telemetry keys `Scale` and `Horizon` (strings); markers use `sub` for class · temperature.
