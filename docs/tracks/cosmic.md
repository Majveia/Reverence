# Track: cosmic — the cosmic web (opening scene, universe scale)

Owner paths: `src/modes/cosmic/**`, this file.

## What it is

The first thing the player sees: a periodic ΛCDM universe that forms its own cosmic web in front of
them, from a near-uniform fog at z = 49 to sheets, filaments, voids and glowing clusters at z = 0
(~32 s), then keeps evolving (slow Λ-dominated future, halo orbits, idle camera drift) forever.
Nothing is noise-faked: every filament comes from gravity acting on a Gaussian random field.

### Physics pipeline

| stage | where | what |
|---|---|---|
| Cosmology | `cosmology.js` | flat ΛCDM (Planck 2018), E(a), exact linear growth D1 (Heath integral), 2LPT D2, ages, COLA drift/kick factors, Eisenstein–Hu 1998 P(k), σ8-normalised |
| Initial conditions | `ic.worker.js` + `fft.js` (Web Worker) | Gaussian random field δ(k) on an N³ grid (hash-seeded per wave-vector → 64³ and 128³ share every large mode), **real 3D FFT**; Zel'dovich ψ1 = ikδ/k², 2LPT ψ2 from the Hessian source; smoothed fields → cluster peaks (5 Mpc/h), galaxy hosts (1.6 Mpc/h peaks + HOD satellites + density-biased dwarfs), environment, collapse times |
| Gravity | `sim.js` + `shaders.js` (GPU) | particle-mesh with **COLA** time stepping (Tassev+ 2013): CIC deposit via point sprites → fold periodic ghosts → Stockham radix-2 3D FFT in float render targets → Green's function + 4-point gradient in k-space → inverse FFT → kick + drift of the residual (x = q + D1ψ1 + D2ψ2 + x_res). 19 steps from z = 19 to 0, ~1 step per 1.5 s of opening; continues into the future |
| Render density | `sim.js` | every step also deposits *all* particles into a particle-resolution (2 Mpc/h) padded, filterable density field used for adaptive smoothing, colour and heat |
| Rendering | `render.js` | see below |

Units: 1 world unit = 1 comoving Mpc/h. Box L = 256 Mpc/h (192 on the 64³ lattice), periodic.
The camera sits at the three.js origin and everything is wrapped around a centre ahead of the camera
(`x − c − ⌊x − c + ½⌋`), so the box tiles an infinite universe with no float-precision drift.
Expansion (Hubble flow) is shown by the comoving camera distance shrinking as a(t)^0.32 during the
opening (the web visibly grows around you while it collapses).

### Look (render.js)

1. **Resolve** pass (one texel per particle): final position incl. halo orbits (virialised matter keeps
   orbiting with ω ∝ √ρ) + sub-lattice jitter, local density, smoothed "shock heat".
2. **Accumulation**: each particle plus up to 3 **Lagrangian-sheet tracers** (points on the edges to its
   lattice neighbours, Abel/Hahn/Kaehler-style) → soft adaptive-kernel sprite (h ∝ ρ^−1/3), additively
   accumulated in a float target: R = projected column density Σ, G = Σ·log ρ (Springel-style colour),
   B = Σ·T (heated gas). Surface brightness is distance-invariant, so it is a true projected density.
   Depth cues: fog behind the focus, near-field fade, a mild circle-of-confusion.
3. **Composite** (in the HDR scene → post bloom/tonemap): density-adaptive smoothing, log-density
   brightness with a black toe (voids = true OLED black), 2D colour map: dark-matter blue-violet →
   magenta filaments → TNG-style ember/orange/white-gold hot gas around clusters. IGN dither.
4. **Galaxies** (9k–48k): pinpoints riding their host particles, ignite when their host collapses,
   red-sequence gold in clusters / blue cloud in the field; resolve into oriented spiral / elliptical /
   irregular discs when you fly close (morphology from `universe.galaxy(i).type` for i < 4096).
5. **Hover ring** + label (UI markers), telemetry `z … age …`, title card.

Exposure follows structure growth (lifted fog early, deep black point once the web exists).

### Interaction

OrbitRig: drag/pinch/scroll, WASD drift (+Shift boost), idle auto-orbit. Hover a cluster → ring +
"<name> · N galaxies"; hover a galaxy when near (<45 Mpc/h) → ring + galaxy name. Click/tap → 2.2 s
fly-to → `director.go('galaxy', { galaxy }, { transition: 'fade' })` (cluster → its BCG). Coming back
(`returning`) restores the camera where you dove in, with the web already mature. Without input, the
camera settles on the most massive *final* halo (ranked by gathered core density, not linear peak).

Quality: 128³ lattice (2.1 M particles, PM mesh 128³) on desktop tiers — `med` 2 sprites/particle
(4.2 M), `high` 3 (6.3 M), `ultra` 4 (8.4 M); phones and `low`: 64³ lattice (262 k particles, ×3
sprites, ~50 MB of textures). Galaxies 9k/18k/30k/48k.

## API

Mode `cosmic` (standard Mode contract). URL extras (all optional):

| param | meaning |
|---|---|
| `ct=<sec>` | start the opening timeline at τ seconds (≥ 32 = mature web at z ≈ 0; the PM sim catches up before `ready`) |
| `cl=<rank>` | orbit the rank-th most massive final cluster (0 = biggest) |
| `gal=<rank>` | frame the rank-th brightest galaxy (fully evolved position) |
| `dist`, `yaw`, `pitch` | camera distance (Mpc/h, physical at z = 0) and angles (deg) |
| `pm=0` | disable PM gravity (pure 2LPT, for comparison) |
| `n`, `k`, `mesh` | lattice size, sprites per particle, PM mesh (debug) |
| `s0`, `gain`, `toe`, `bright`, `heat`, `hlo`, `hhi`, `fog`, `h0`, `coc` | look tuning overrides |

Test helpers on the mode (`__rv.mode`): `visibleCluster()`, `screenOfCluster(k)`, `hoverAt(x, y)`,
`debugStats()` (column-density percentiles), `getState()` → `{tau, a, z, ageGyr, pmSteps, particles,
galaxies, clusters, hover, …}`.

## Best capture views

Mature web needs ~20 PM steps before `ready`: ~140 s ready time on the shared SwiftShader box (longer
under load; pass `--timeout 400`).

| view | URL | steps |
|---|---|---|
| Hero: mature cosmic web | `/?mode=cosmic&ct=40` | `[{"advance":1}]` |
| Massive node, filaments converging | `/?mode=cosmic&ct=40&dist=38&pitch=10` | `[{"advance":1}]` |
| Inside a filament (galaxies strung along it) | `/?mode=cosmic&ct=40&gal=40&dist=22&pitch=5` | `[{"advance":1}]` |
| Opening: seeds wrinkling (z ≈ 3) | `/?mode=cosmic` | `[{"advance":16}]` |
| Opening: web crystallising (z ≈ 1) | `/?mode=cosmic` | `[{"advance":22}]` |
| Hover ring + label (use `--ui`) | `/?mode=cosmic&ct=40` | `[{"advance":0.3},{"eval":"const v=__rv.mode.visibleCluster(); v && __rv.mode.hoverAt(v.x, v.y)"},{"advance":0.3}]` |

## Known issues

- Render cost is dominated by the accumulation (6.3 M sprites at `high`); fine on desktop GPUs,
  heavy on SwiftShader (a frame takes ~3 s there, readiness at ct=40 ~2–5 min under shared load).
- Close-ups (< ~15 Mpc/h) approach the 2 Mpc/h particle resolution: kernels widen near the camera so
  matter reads as soft nebulous gas (galaxies stay crisp); true sub-Mpc detail would need a zoom-in
  resimulation or more sheet tracers near the camera.
- Editing files under `src/modes/cosmic/` while a capture runs triggers a Vite full reload and aborts it.
- Cluster ranking for hero framing uses the gathered core density; the initial frames of an opening
  use the linear-peak rank and the camera eases to the final hero at a > 0.55.
- 64³ (phone) tier is necessarily coarser (3 Mpc/h resolution, fewer thin filaments).
- Galaxy mode (other track) logs `Shader Error 0 - VALIDATE_STATUS false` right after the transition.

## Requests

- **galaxy track**: `Shader Error 0 - VALIDATE_STATUS false` is logged when galaxy mode boots
  (`/?mode=galaxy&galaxy=3`), which makes `tools/check.mjs` fail for galaxy.
- **ui track**: markers are drawn as `◦ label`; the cosmic ring is rendered in-scene, so a marker kind
  `'cosmic'` without the `◦` glyph (label only, small caps, centred above the point) would look cleaner.
- **audio track**: cosmic mode calls `audio.setParam('cosmicGrowth', D1 ∈ [0, 1])` every 0.2 s and
  `audio.play('whoosh')` on fly-to — hook them if useful (both optional-chained).
