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
   every Bragg harmonic of the lattice → no moiré), local density, smoothed "shock heat", and (round 3) the
   **Lagrangian deformation** J·Jᵀ of the particle's lattice cell (central differences of the six lattice
   neighbours' positions, 3rd MRT output + spare aux channels).
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
   * **Anisotropic kernels** (round 3, ASPH-style): in that resolved regime, outside virialised halos, the
     Gaussian takes the *shape* of the particle's own Lagrangian cell projected to the screen
     (Σ₂ = M·J·Jᵀ·Mᵀ, M = projection Jacobian): orientation and axis ratio (≤ 5:1) from the cell, area from
     the density-based kernel, never stretched past the sprite limit. Streams and filament walls read as
     smooth threads instead of isotropic cotton. Elliptical Gaussian splats (inverse covariance per sprite).
   * Kernels larger than the sprite limit (a clump right in front of the lens) become faint bokeh discs.
   Depth cues: fog behind the focus, near-field fade, a mild circle-of-confusion.
3. **Levels** (round 2): every 15 frames a 128×72 thumbnail of Σ is read back (async; sync in shot mode)
   and sorted on the CPU. The composite's black point sits at a measured percentile of what is on screen:
   ~6 % at z ≳ 10 (dim fog, deepest troughs black), ~25 % at z ≈ 3, ~45 % today (voids). A highlight knee
   above the brightest 3 % plus a highlight exposure keep a screen-filling cluster core as a gradient
   instead of a clipped disc. Smoothed over ~0.3 s (eye adaptation); NaN-guarded with a schedule fallback.
   Round 3: **close-up eye adaptation** — when hot cluster gas fills > ~4 % of the frame, the highlights are
   exposed down (peak ≈ 0.9 before bloom) and the headroom lifts the knee, so a screen-filling cluster core
   shows its density gradient and its member galaxies instead of a blown-out cream disc. Levels are measured
   on every rendered frame in shot mode (captures were depending on frame-count parity).
4. **Composite** (in the HDR scene → post bloom/tonemap): raw column density for dense structure; only the
   sparsest pixels blend with an 8-tap golden-angle kernel rotated per pixel (IGN) — no fixed tap lattice.
   Log-density brightness with the measured toe (voids = true OLED black), 2D colour map: dark-matter
   blue-violet → magenta filaments → TNG-style ember/orange/gold hot gas around clusters. IGN dither.
   Round 3: **clarity** (local contrast of log Σ against an 8-tap ring at ~5 px of a 720p frame: filament
   cores lift, flanks fall to black → thread-like strands) and **sculpted relief** (log Σ lit as a height
   field from the upper left, gradient from the same ring, faded out below the toe and above the knee) —
   the volumetric, coral-like read of TNG50 gas renders. Both fade in with structure (D1 0.35 → 0.8); the
   ring and the sparse kernel are rotated per pixel by a white-noise hash (IGN's diagonal structure printed
   a hatch), re-seeded every frame in live play (fixed in shot mode).
5. **Galaxies** (9k–48k): pinpoints riding their host particles, ignite when their host collapses,
   red-sequence gold in clusters / blue cloud in the field; resolve into oriented spiral / elliptical /
   irregular discs when you fly close (morphology from `universe.galaxy(i).type` for i < 4096).
6. **Hover ring** + label (UI marker kind `'cosmic'`, name + "N galaxies · d Mpc/h" or "type galaxy · d"),
   telemetry `z … age …`, title card. While the title card is up, a label that would crowd it (central
   column) is held back (ring only); near the top edge the label flips below the ring.

#### Round 4 additions (critic round 2): what the pipeline does now

* **Emissivity, not plain column density**: every sample (particle, tracer, veil step, subhalo, shell) is
  weighted by (ρ/4)^γ, so the image is ∫ρ^(1+γ) dl (emission-measure-like, X-ray/Hα ∝ ρ²). γ = 0.5 today,
  1.0 while the web is young. Evaluated per sample *in 3D, before projection*: a stack of faint sheets
  along the line of sight no longer adds up to the brightness of one filament → thin bright threads with
  dim flanks instead of cotton wool.
* **Hybrid particle + ray-marched rendering** (`VEIL_FRAG`): diffuse matter (sheets, void walls, primordial
  fog) is ray-marched through the PM render density (CIC of every particle, 2 Mpc/h, trilinear), 24–56 steps
  by tier, at half the accumulation resolution, then added into the accumulation target. Particles keep the
  collapsed matter. The split is a smooth partition of unity in ρ (veil below 3 → particles above 10 today;
  0.9 → 3 while the web is young, so the particles' Lagrangian sheet tracers still draw the Zel'dovich
  pancakes). Both deposit identical units and weights (mean density ↔ 1/8 reference particle per (Mpc/h)³),
  so the sum is the same picture minus the Poisson noise of sparsely sampled sheets. Before PM starts
  (z > 19) a 2LPT field is deposited so the first seconds use the veil too.
* **Temperature**: the resolve pass's heat is now a log-scaled virial-temperature proxy of the
  ~2.5 Mpc/h-smoothed density (ρ 6 → 900): warm-hot filament gas (magenta) → shocked group/cluster outskirts
  (orange) → amber → white-hot only in the innermost cores (and, past the highlight knee, the core whitens
  with brightness).
* **Palette**: density ramp cyan-blue (void walls, sheets) → indigo → violet → magenta-rose (filament cores),
  then the temperature ramp; aerial perspective: matter behind the focus (accumulation alpha channel =
  Σ·far share) cools toward deep blue-violet and dims; the young web is blue-violet and warms as it collapses.
* **Highlights**: brightness ∝ Σ^1.15 above the toe; a hue-preserving soft shoulder (max channel → 1.6)
  before bloom; tonemap `agx-punchy` (hue 0.7); bloom 0.5. Close-ups (> 3.5–12 % of the frame is bright
  gas): the highlight knee *drops* to the core's outskirts (80th percentile) so the core's whole range is
  compressed into a visible gradient (it used to be lifted, which parked the core on the shoulder).
* **Substructure** (accumulated with the particles): (a) **subhalos** — every satellite / central galaxy
  carries a projected cuspy clump (Σ ∝ (1 + r²/a²)^-1.5, mass ∝ L^0.8, a = 12–50 kpc/h) riding (and orbiting
  with) its host particle, boosted inside hot cluster gas so it reads against the core, only once resolved
  and only after the host has long collapsed; (b) **accretion shocks** — one sprite per collapsed cluster
  deposits a projected thin spherical shell at ~2 R_hot (gas at ~15× mean, 0.28 R thick), limb-brightened,
  broken into arcs (no shock where filaments feed the cluster), breathing slowly; hot (orange) colour.
* **Smooth clarity / relief**: the local-contrast and relief estimator is a quarter-resolution 4×4 box of
  log Σ (plus mass-weighted colour ratios), bilinearly upsampled: noise-free (the per-pixel randomly rotated
  tap ring printed estimator grain into every filament). Sparse pixels (judged by the smooth level) blend
  to that field. Relief keeps 40 % in the highlights (cluster cores show shape).
* **Galaxies**: lognormal scatter (σ ≈ 0.33 dex in luminosity) around the host relation; field dwarfs fade
  outside the web (bias ∝ density); the brightest 5 % keep a tiny resolved, oriented disc at any distance;
  the brightest 1 % carry faint fixed-angle diffraction spikes.
* **Opening timeline**: growth eased with exponent 2.4 (was 1.6): shell crossing (D ≈ 0.3) at ~12 s,
  crisp web by ~16 s (z ≈ 1.5), mature by ~24 s; young-web kernels 2× smaller; clarity/relief from D1 0.18;
  a depth slab around the focus while young (thinner projection keeps the first wrinkles' contrast).
* **Shot-mode levels fix**: `advance(N)` runs N seconds of updates and renders once, so levels measured on
  the previous rendered frame were stale by N seconds of cosmic time (black or washed-out opening captures).
  In shot mode the frame now measures and snaps its own levels before compositing.

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
| `an`, `asp` | anisotropic Lagrangian kernels on/off (1 on 128³, 0 on 64³) and max axis ratio (5) |
| `clar`, `relief` | clarity (0.6) and sculpted relief (0.7) strengths; `0` disables |
| `early` | extra kernel width while the web is young (0.4 → 0 between D1 0.3 and 0.75) |
| `em` | emission exponent γ today (0.5; +0.5 while young; 0 = plain column density) |
| `gamma`, `shoulder`, `aerial` | brightness power (1.15), hue-preserving highlight ceiling (1.6), aerial-perspective strength (0.55) |
| `veil`, `vlo`, `vhi`, `vsteps` | ray-marched veil gain (1; 0 = particles only), partition ρ range (3 → 10 today), march steps |
| `sub`, `shell` | subhalo and accretion-shock gains (1; 0 disables) |
| `slab` | young-web depth-slab strength (0.85) |

Test helpers on the mode (`__rv.mode`): `visibleCluster()`, `screenOfCluster(k)`, `hoverAt(x, y)`,
`debugStats()` (column-density percentiles R, their log levels l, current toe/toeW/knee/bright), `getState()` → `{tau, a, z, ageGyr, pmSteps, particles,
galaxies, clusters, hover, …}`.

## Best capture views

Mature web needs ~20 PM steps before `ready`: ~140 s ready time on the shared SwiftShader box (longer
under load; pass `--timeout 400`).

| view | URL | steps |
|---|---|---|
| Hero: mature cosmic web | `/?mode=cosmic&ct=40` | `[{"advance":1},{"advance":0.5}]` |
| Massive node, filaments converging | `/?mode=cosmic&ct=40&dist=38&pitch=10` | `[{"advance":1},{"advance":0.5}]` |
| Approaching the massive node (temperature gradient, members, subhalos) | `/?mode=cosmic&ct=40&dist=24&pitch=10` | `[{"advance":1},{"advance":0.5}]` |
| Close to the massive node | `/?mode=cosmic&ct=40&dist=14&pitch=10` | `[{"advance":1},{"advance":0.5}]` |
| Inside a filament (galaxies strung along it) | `/?mode=cosmic&ct=40&gal=40&dist=40&pitch=5` | `[{"advance":1},{"advance":1}]` |
| Opening: primordial fog, first ripples (z ≈ 20) | `/?mode=cosmic` | `[{"advance":3}]` |
| Opening: proto-web (z ≈ 2.5) | `/?mode=cosmic` | `[{"advance":13}]` |
| Opening: web emerging (z ≈ 1.2) | `/?mode=cosmic` | `[{"advance":17}]` |
| Opening: web maturing (z ≈ 0.4) | `/?mode=cosmic` | `[{"advance":22}]` |
| Hover ring + label (use `--ui`; the label is held back while the title card is up) | `/?mode=cosmic&ct=40` | `[{"advance":6},{"eval":"const v=__rv.mode.visibleCluster(); v && __rv.mode.hoverAt(v.x, v.y)"},{"advance":0.3}]` |
| Low tier (64³, phones) | `/?mode=cosmic&ct=40` + `--q low` | `[{"advance":1},{"advance":0.5}]` |
| Phone portrait | `/?mode=cosmic&ct=40` + `--mobile --ui` | `[{"advance":6.5}]` |

(`dist=8` puts the camera inside the hot halo, below the 2 Mpc/h force resolution: a smooth glowing core
with member galaxies — use 14–24 for close-ups.) Several framings can share one slow load by moving the rig
with an eval step (see below); the shot frame measures its own levels, so one `advance` after a move is enough.

Useful for tuning: add `{"eval":"JSON.stringify(__rv.mode.debugStats())"}` to print Σ percentiles, the live
levels (toe/knee/expo/fBright) and a non-finite pixel count. Several framings can share one (slow) load:
move the rig with an eval step, e.g.
`{"eval":"const m=__rv.mode;m.userMoved=true;m.rig.distance=m.rig._dist=38;1"}` then two `advance` steps
(the second lets the levels settle).

## Known issues

- Render cost: accumulation of 6.3 M AA splats at `high` (particles in the veil's density range are culled
  in the vertex shader) + the veil ray-march (40 steps at half resolution: ~160 bilinear fetches per
  half-res pixel, ~1–2 ms at 1080p on a desktop GPU; 24 steps at `low`). Heavy on SwiftShader (ready at
  ct=40 in ~80–140 s on the shared box).
- Close-ups (< ~14 Mpc/h of a cluster) are limited by the 2 Mpc/h particle / PM force resolution: the core is
  a smooth glowing gradient with member galaxies and subhalo clumps, but no hydrodynamic shock / bubble
  structure (would need a finer PM mesh or a zoom-in resimulation). The accretion-shock shells and subhalos
  are analytic, physically motivated layers (positions and masses from the simulation), not resolved by it.
- At z ≈ 2–4 the projected web is physically low-contrast at this resolution: it reads as a proto-web of
  ~10 Mpc/h pancakes (cloudy) rather than threads; threads appear from ~15 s (z ≈ 1.5).
- Subhalo clumps catch the composite's sculpted relief and can read as small glossy spheres in close-ups.
- 64³ (phone / `low`) tier is necessarily coarser (3 Mpc/h resolution, blobbier filaments).
- Without float readback (`EXT_color_buffer_float` missing) the levels fall back to a fixed schedule, and
  without the PM field there is no veil (particles carry everything).
- The redshift / cosmic-age telemetry labels can overlap at the bottom right (UI CSS, see Requests).

## Requests

- **ui**: telemetry labels collide — "COSMIC AGE" is clipped by the redshift value at the bottom right
  (1280×720, critic round 2): please add `white-space: nowrap` to `.rv-tv-k` and a larger gap between `.rv-tv`
  items (≥ 16–24 px), or right-align the key over its own value only.
- **ui**: marker labels of kind `'cosmic'` sit over bright filaments: a soft dark text-shadow / 40 % radial
  backdrop on `.rv-mk.ext .rv-mk-name` / `.rv-mk-sub` would keep them legible.
- **audio track**: cosmic mode calls `audio.setParam('cosmicGrowth', D1 ∈ [0, 1])` every 0.2 s and
  `audio.play('whoosh')` on fly-to — hook them if useful (both optional-chained).
- (done, thanks) ui: marker kind `'cosmic'`; cosmic now passes `sub` explicitly.
- (done) ui → cosmic: "sharper, earlier first frame": structure now forms earlier (shell crossing ~12 s) and
  the first seconds show the real primordial ripples instead of a near-uniform fog.

## Round 4 changes (critic round 2)

1. Fat cotton filaments → emissivity weighting ∫ρ^(1+γ)dl per sample in 3D, steeper brightness curve,
   hybrid rendering (smooth ray-marched veil for diffuse matter, particles for collapsed structure),
   noise-free clarity/relief estimator: thin bright threads in soft veils, no sample speckle.
2. Blown-out nodes → hue-preserving highlight shoulder, `agx-punchy`, lower bloom, close-up knee that drops
   to the core's outskirts, log temperature ramp (white-hot only in the innermost core), subhalo clumps on
   satellite galaxies and accretion-shock arcs around clusters.
3. Monochrome purple → cyan-blue sheets → indigo → violet → magenta filament cores → orange → amber →
   white-hot, plus aerial perspective (deep blue-violet behind the focus).
4. Muddy young web → steeper growth timeline, smaller early kernels, ρ²-like contrast while young, depth
   slab, young-web toe width, particles carry the pancakes while young; and a shot-mode levels bug fixed
   (levels were stale by the whole `advance` interval, which washed out / blacked out opening captures).
5. UI → hover label held back while the title card is up; flips below the ring near the top edge.
6. Depth → aerial perspective channel, young-web depth slab (focus), fog unchanged.
7. Galaxies → lognormal luminosity scatter, density-biased dwarfs, resolved discs for the top 5 %,
   diffraction spikes for the top 1 %.
8. Low tier and phone portrait captured and checked (low tier gives the particles more of the matter).

## Round 3 changes (critic round 1, second pass)

1. Filament close-ups (lost pair vs TNG50 shocks): anisotropic Lagrangian-cell kernels, clarity + sculpted
   relief in the composite, and the documented filament framing moved to 40 Mpc/h (where the 2 Mpc/h
   particle resolution holds; 22 Mpc/h is below it).
2. Massive-node close-up: close-up eye adaptation + knee lift (gradient and member galaxies instead of a
   blown-out disc); warmer, more saturated gold for the hottest gas (less agx white-out).
3. Hatch/moiré: per-pixel kernel rotations now use a white-noise hash (IGN's diagonal structure printed a
   fine hatch through any amplifying pass); low tier re-checked at 1280×720, no lattice pattern.
4. Early universe: kernels widen while the web is young (smooth wrinkles instead of shot-noise mottling);
   clarity/relief fade in only as structure matures.
5. Misc: deterministic levels in shot mode, redshift readout clamps at 0.00 in the future (was "-0.01"),
   wider vertical FOV on portrait phones, `debugStats()` reports non-finite pixels and the adaptation state.

## Round 2 changes (critic round 1)

1. Close-up node halo no longer breaks into discrete sprite discs: resolution-matched SPH smoothing for
   collapsed matter, flux-conserving splats, bokeh dimming of clamped foreground sprites, larger close-up
   sprite limits, highlight knee + exposure so the core is a gradient.
2. Low-tier crosshatch fixed at the source: AA splats (no 1-px flat points), one-cell lattice jitter
   (+ tracer jitter), per-pixel-rotated sparse-region kernel, accumulation at 0.75× (was 0.6×).
3. z ≈ 3 wash fixed: measured black point (levels) — troughs are true black, only overdensities glow.
4. Crisper filaments at hero range: no 5-tap blur, sparse-region blur only below the toe.
