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
   orbiting with ω ∝ √ρ) + sub-lattice jitter (exactly one cell wide in low-density regions, which cancels
   every Bragg harmonic of the lattice → no moiré), local density, smoothed "shock heat".
2. **Accumulation**: each particle plus up to 3 **Lagrangian-sheet tracers** (points on the edges to its
   lattice neighbours, Abel/Hahn/Kaehler-style, with their own jitter) → additively accumulated in a float
   target: R = projected column density Σ, G = Σ·log ρ (Springel-style colour), B = Σ·T (heated gas).
   * **Anti-aliased, flux-conserving splats** (round 2): the Gaussian is evaluated at the exact sub-pixel
     offset from the unsnapped sprite centre, never narrower than σ ≈ 0.45 px, normalised per sample
     (flux ∝ m/d², so surface brightness is distance-invariant). No flat 1-px points → no shimmer/crosshatch.
   * **Resolution-matched smoothing**: far away the kernel is narrower than the sample spacing (many samples
     per pixel → razor-sharp filaments). Once the local spacing of *collapsed* matter (ρ > 2–8) is resolved
     on screen (> 4–8 px) kernels jump to SPH overlap (diameter 2.6 spacings) and the sheet tracers hand
     their mass back to the particle (fill rate) → cluster gas stays continuous in close-ups instead of
     breaking into discs. Void/sheet tracers stay fine dust.
   * Kernels larger than the sprite limit (a clump right in front of the lens) become faint bokeh discs.
   Depth cues: fog behind the focus, near-field fade, a mild circle-of-confusion.
3. **Levels** (round 2): every 15 frames a 128×72 thumbnail of Σ is read back (async; sync in shot mode)
   and sorted on the CPU. The composite's black point sits at a measured percentile of what is on screen:
   ~6 % at z ≳ 10 (dim fog, deepest troughs black), ~25 % at z ≈ 3, ~45 % today (voids). A highlight knee
   above the brightest 3 % plus a highlight exposure keep a screen-filling cluster core as a gradient
   instead of a clipped disc. Smoothed over ~0.3 s (eye adaptation); NaN-guarded with a schedule fallback.
4. **Composite** (in the HDR scene → post bloom/tonemap): raw column density for dense structure; only the
   sparsest pixels blend with an 8-tap golden-angle kernel rotated per pixel (IGN) — no fixed tap lattice.
   Log-density brightness with the measured toe (voids = true OLED black), 2D colour map: dark-matter
   blue-violet → magenta filaments → TNG-style ember/orange/white-gold hot gas around clusters. IGN dither.
5. **Galaxies** (9k–48k): pinpoints riding their host particles, ignite when their host collapses,
   red-sequence gold in clusters / blue cloud in the field; resolve into oriented spiral / elliptical /
   irregular discs when you fly close (morphology from `universe.galaxy(i).type` for i < 4096).
6. **Hover ring** + label (UI marker kind `'cosmic'`, name + "N galaxies · d Mpc/h" or "type galaxy · d"),
   telemetry `z … age …`, title card.

### Interaction

OrbitRig: drag/pinch/scroll, WASD drift (+Shift boost), idle auto-orbit. Hover a cluster → ring +
"<name> · N galaxies"; hover a galaxy when near (<45 Mpc/h) → ring + galaxy name. Click/tap → 2.2 s
fly-to → `director.go('galaxy', { galaxy }, { transition: 'fade' })` (cluster → its BCG). Coming back
(`returning`) restores the camera where you dove in, with the web already mature. Without input, the
camera settles on the most massive *final* halo (ranked by gathered core density, not linear peak).

Quality: 128³ lattice (2.1 M particles, PM mesh 128³) on desktop tiers — `med` 2 sprites/particle
(4.2 M), `high` 3 (6.3 M), `ultra` 4 (8.4 M); phones and `low`: 64³ lattice (262 k particles, ×3
sprites, ~50 MB of textures, accumulation at 0.75× resolution, base kernel 0.93 spacings — smaller ones
sit in the Poisson-blotch regime on the coarse lattice). SPH switch thresholds are in CSS px (same look on
1× and 3× screens). Galaxies 9k/18k/30k/48k. Sprite size
limit (close-ups only): low 24 px, med 48, high 72, ultra 112. Distant sprites are 3×3–4×4 px (AA
splat), i.e. ~60–90 M additive fragments per frame at `high` 1080p.

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
| `s0`, `gain`, `toe`, `bright`, `heat`, `hlo`, `hhi`, `fog`, `h0`, `coc` | look tuning overrides (`toe` = fallback toe when no float readback) |
| `qb` | fraction of the screen below the black point (overrides the epoch schedule) |
| `sph`, `kt` | SPH kernel diameter in spacings (2.6); `kt=0` keeps sheet tracers in close-ups |

Test helpers on the mode (`__rv.mode`): `visibleCluster()`, `screenOfCluster(k)`, `hoverAt(x, y)`,
`debugStats()` (column-density percentiles R, their log levels l, current toe/toeW/knee/bright), `getState()` → `{tau, a, z, ageGyr, pmSteps, particles,
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
| Inside the most massive node (close-up) | `/?mode=cosmic&ct=40&dist=8` | `[{"advance":1}]` |
| Low tier (64³, phones) | `/?mode=cosmic&ct=40` + `--q low` | `[{"advance":1}]` |
| Primordial fog (z ≈ 25) | `/?mode=cosmic` | `[{"advance":3}]` |

Useful for tuning: add `{"eval":"__rv.mode.debugStats()"}` to print Σ percentiles and the live levels.

## Known issues

- Render cost is dominated by the accumulation (6.3 M AA splats at `high`); fine on desktop GPUs,
  heavy on SwiftShader (a frame takes ~3 s there, readiness at ct=40 ~2–5 min under shared load).
- Close-ups (< ~15 Mpc/h) are limited by the 2 Mpc/h particle / PM force resolution: cluster gas is a
  continuous smooth glow with embedded galaxies but has no sub-Mpc shock structure (would need a finer PM
  mesh / P³M or a zoom-in resimulation); filaments at ~20 Mpc/h read as soft gas tubes.
- z ≈ 3 frames are physically low-contrast at this resolution (the nonlinear scale is below 2 Mpc/h): the
  levels keep troughs black and wrinkles visible, but they read as mottled clouds more than threads.
- Editing files under `src/modes/cosmic/` while a capture runs can abort it (module reload).
- Cluster ranking for hero framing uses the gathered core density; the initial frames of an opening
  use the linear-peak rank and the camera eases to the final hero at a > 0.55.
- 64³ (phone) tier is necessarily coarser (3 Mpc/h resolution, fewer thin filaments, dustier voids).
- Without float readback (`EXT_color_buffer_float` missing) the levels fall back to the old fixed schedule.

## Requests

- **audio track**: cosmic mode calls `audio.setParam('cosmicGrowth', D1 ∈ [0, 1])` every 0.2 s and
  `audio.play('whoosh')` on fly-to — hook them if useful (both optional-chained).
- (done, thanks) ui: marker kind `'cosmic'`; cosmic now passes `sub` explicitly.

## Round 2 changes (critic round 1)

1. Close-up node halo no longer breaks into discrete sprite discs: resolution-matched SPH smoothing for
   collapsed matter, flux-conserving splats, bokeh dimming of clamped foreground sprites, larger close-up
   sprite limits, highlight knee + exposure so the core is a gradient.
2. Low-tier crosshatch fixed at the source: AA splats (no 1-px flat points), one-cell lattice jitter
   (+ tracer jitter), per-pixel-rotated sparse-region kernel, accumulation at 0.75× (was 0.6×).
3. z ≈ 3 wash fixed: measured black point (levels) — troughs are true black, only overdensities glow.
4. Crisper filaments at hero range: no 5-tap blur, sparse-region blur only below the toe.
