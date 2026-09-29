# Water track — oceans, lava seas, acid seas, frozen seas

Owner paths: `src/world/water/**`, this file.

## What was built

| file | content |
|---|---|
| `index.js` | subsystem (order 15): ocean mesh + material, scene grab, per-frame wave/LOD update, bathymetry requests, CPU queries, underwater (130) and lava heat-shimmer (145) pipeline effects, marine snow |
| `waves.js` | `WaveSet`: wind-aligned Gerstner spectrum (8–12 waves by tier), float64 phases at the camera nadir, CPU `heightQ` with Gerstner inversion (used by `heightAt`) |
| `texdata.js` | THREE-free texture synthesis: Phillips/Tessendorf spectrum via inverse FFT (slopes, fold/Jacobian, height), dispersive caustics (jittered rays refracted through an isotropic spectrum, splatted + tent-filtered), domain-warped multi-scale Worley foam with a density field, crust cells (lava / ice) |
| `textures.js` | THREE wrappers (mipmapped RGBA8 DataTextures), placeholders, sync fallback |
| `water.worker.js` | module worker: texture synthesis + bathymetry grids (`SurfaceGen.heightLod`, same generator as the terrain) — nothing heavy on the main thread |
| `shaders.js` | ocean surface vertex/fragment (water, acid, lava, ice variants), underwater effect, shore effect (wet sand / swash / hot lava rims), heat shimmer, marine snow |
| `reef.js` | seabed life around the camera (liquid water only): 7 instanced types — seagrass, kelp, branching (staghorn) coral, brain coral, sea fans, tube sponges, boulders — swaying in the wave surge/current, palette-driven colours with coral fluorescence, bioluminescent tips on alien worlds; shrinks into the bed at the edge of its radius (no pop) |
| `reefgeo.js` | procedural geometry for the reef types (tubes / ribbons / lumpy domes, vertex colour + sway + glow attributes) |
| `reefplace.js` | THREE-free placement (runs in the water worker): planet-global cube-sphere lattice (deterministic, no popping when re-requested), classified by depth / temperature / sand / slope with 100 m–km patchiness |

### Rendering scheme
* **Geometry** — one camera-centred polar grid laid directly on the sea sphere (`radius + seaLevel`):
  ring 0 under the camera, rings exponentially spaced (≈ constant screen density) out to just past the
  horizon of the wave crests. The same mesh serves swimming, sailing, flying and orbit: no LOD seams, no
  popping, the horizon silhouette is a ring. Precision: positions are built relative to the camera nadir
  (`2 sin²(θ/2)` form), wave phases are computed per wave in float64 on the CPU at the nadir and the GPU
  only adds `k·(D·q_rel)`.
* **Waves** — Gerstner sum aligned with the prevailing wind at the anchor (`G.uWindDir`), amplitude
  follows `G.uWindStrength` (smoothed). Vertex waves are filtered by local vertex spacing; fragment
  normals re-evaluate the same waves analytically (pixel-footprint filtered, the lost slope variance is
  added to GGX roughness → distant water gets the broad glitter path instead of aliasing), plus three
  rotated/scrolling layers of FFT-spectrum detail normals.
* **Scene grab** — the ocean mesh is the last opaque object (`renderOrder 1e6`). In `onBeforeRender` it
  blits the current HDR colour + depth (MSAA-resolving) into a grab target; the shader then refracts the
  seabed with Beer–Lambert absorption (from `body.ocean.shallow`) and in-scatter (`body.ocean.deep`),
  computes water thickness / depth below the surface from the depth buffer (shore foam, surf lines,
  soft shoreline, caustics) and ray-marches screen-space reflections. Because the water writes depth,
  the atmosphere's aerial perspective, clouds and all transparent objects (splashes, ripples) composite
  correctly on top.
* **Shading** — Fresnel sky reflection from the atmosphere's sky cube (`world.lighting.cubeRT`), SSR
  (high/ultra), GGX sun/moon glint via `world.lighting.uniforms.uKeyDir/uKeyColor` (moon glint at night),
  cloud shadows (`rv_cloudshadow`), subsurface glow through backlit crests, crest foam from the Gerstner
  Jacobian + FFT fold × Worley foam webs, shore foam + surf lines moving shoreward, dispersive caustics on
  the seabed projected along the refracted sun.
* **Shore swell** — a worker-built bathymetry map (48–96² around the camera, re-centred as you move) drives
  (a) damping of the open-sea waves in the shallows, (b) a shoaling swell whose crests follow the depth
  contours and roll toward the beach, steepen and break (white water on the crest front, lace behind,
  broken up along the shore), (c) CPU `heightAt` (same functions) so swimmers bob on the same swell.
* **Shore** (`water-shore`, order 95, med+ tiers, camera < 700 m) — a full-screen pass before the atmosphere.
  Land pixels are recognised exactly (their depth equals the pre-water grab depth) and those just above sea
  level get the swash of the shore swell: a thin glossy sheet of water that runs up the beach fast and drains
  back slowly (phase drifting along the beach), a lacy foam line at its front, sand that stays darker, more
  saturated and glossy (sky Fresnel + sun glint) up to the highest run-up. On lava worlds the same pass makes
  the rocky rim glow from the heat of the melt, cooling upward.
* **Wind slicks** — at 0.1–140 km, kilometre-scale noise modulates the roughness: calm mirror patches and rough
  matte streaks in the sky reflection and the sun path seen from altitude; the orbital glint is boosted so it
  survives the aerial perspective.
* **Underwater** (`underwater`, order 130) — when the camera is below the local wavy surface: absorption
  fog, in-scatter integrated along the ray with depth-dependent sunlight and god-ray shafts (caustic
  pattern projected along the sun), seabed caustics; the surface from below shows Snell's window and
  total internal reflection.
* **Liquids** — `water`; `acid` (venom-green self-luminous scatter, murky); `lava` (near-black basalt rafts
  drifting on an incandescent, convecting melt: kilometre-scale "activity" fields decide where the rafts
  crack apart into open melt and where they lie as a solid crust laced with glowing fissures; mega-plate
  seams, dull-red cooling rims on every raft, a heat ramp dull red → orange → yellow (~T³ radiance),
  pixel-footprint filtering of the cracks, rough glassy sheen, hot shoreline + glowing rock rims, heat
  shimmer effect 145); `ice` (static frozen sea: pressure plates, cracks with blue subsurface glow, snow drifts,
  glossy reflections).

## Round 2 changes (critic fixes)
* **Grid / crosshatch on the water** — root causes were (a) the pipeline's screen-space AO hatching the smooth,
  grazing water (and the underside of the surface when diving): the shore pass (95) now restores the pre-AO
  scene colour on water pixels (and fades AO out with distance underwater); (b) detail-normal layers whose
  tiles shrank to a few dozen pixels (visible repetition lattice): every FFT layer now fades out by its
  pixel footprint and its lost slope variance goes into GGX roughness; (c) glitter cells on a regular lattice:
  now two cross-faded octaves (one rotated), each glint at a random spot/size inside its cell.
* **Swell** — the WaveSet now has 3 long, smooth swell trains (2.5–5.6 × the wind-sea wavelength, ~0.1 of
  total steepness) under the choppier wind sea (steepness 0.048–0.1, Σ Q·k·A 0.72–0.9); amplitude floor raised
  (0.78 + 0.6 × wind). A drifting gust field (0.4–4 km) scales the short waves and roughness → cat's paws up
  close, calm slicks and rough streaks in the sun path from altitude; km-scale swell trains (0.7 / 2.4 km
  tiles) keep relief visible from kilometres up; 20/61 km roughness bands mottle the glint from orbit.
* **Glint** — stochastic micro-facet glitter inside a broad GGX lobe, energy-matched to the lobe, twinkling
  at ~7 Hz, density follows the gust field.
* **Lava** — a two-phase flow map advects the convection cells and flow-stretched streaks (the melt visibly
  moves, rafts drift as rigid plates at a different velocity); open-melt zones much larger (gap width up to
  0.8 of a raft in active regions); incandescent upwellings; slow region-wide breathing of the glow.
* **Wet sand** — graded moisture: saturated up to the highest run-up then a long capillary damp → dry fade,
  a mirror sheen that decays ~2 s after the backwash uncovers the sand, roughness grading from film (0.045)
  to matte damp sand (0.42), bubble line at the top of the run-up dissolving, lacy (never solid) foam front.
* **Caustics** — seabed caustics are the product of two dispersive caustic layers at different scales and
  drift directions (sharp bright interference web) plus their mean; god-ray shafts use the smooth focusing
  pattern (broad beams) with exact per-segment extinction, a near span of `SHAFT_STEPS` (8/12/16/22 by tier)
  and a coarser far span.
* **Seabed life** (new, `reef*.js`) so dives and clear shallows have foreground interest.
* **Shore foam beyond the horizon** (terrain request) — land seen through a long water path is treated as deep
  water (no spurious foam on islands behind the curvature).

## Public API (`world.get('water')`, also `world.water`)
* `heightAt(p)` / `surfaceHeight(p)` — planet-local point → liquid surface height (m rel. `body.radius`,
  waves included, Gerstner-inverted so it matches the rendered surface). Player swimming uses it.
* `normalAt(p, out)`, `isUnderwater(p)`, `depthAt(p)` (liquid depth above the seabed).
* `liquid` (`water|lava|acid|ice`), `solid` (true for ice), `seaLevel`, `under` (camera underwater),
  `waves` (`WaveSet`).
* `getState()` → `{liquid, under, camH, waveH, amp, L0, grab, grid, tris, genMs}`.

## Capture URLs (verified, 1280×720)

| view | URL | steps |
|---|---|---|
| W1 tropical beach, noon (hero: turquoise shallows → deep blue, breaking surf, reflections) | `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=40&lat=15.917&lon=34.255&yaw=200&pitch=-14&tod=0.5` | |
| W1 same beach, golden hour | same with `tod=0.3` | |
| W1 swimming (core use: refraction of the body, SSR of ship/trees, player ripples) | `/?mode=system&galaxy=0&star=6&planet=1&view=surface&lat=1.086&lon=-28.557&yaw=0&pitch=-8&tod=0.3` | `[{"advance":1},{"move":[0,1],"sec":3},{"advance":2}]` |
| W2 lake, sunset sun-glitter path | `/?mode=system&galaxy=0&star=11&planet=0&view=fly&alt=3&lat=-13.325&lon=146.162&yaw=270&pitch=-2&tod=0.7&disable=vehicles` | |
| W2 lake, mountain reflections (SSR) | `/?mode=system&galaxy=0&star=11&planet=0&view=fly&alt=3&lat=-13.325&lon=146.162&yaw=270&pitch=-4&tod=0.3` | |
| Underwater, W1 sandy shelf (caustics, god rays, Snell's window above) | `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=4&lat=15.8013&lon=34.3048&yaw=330&pitch=-10&tod=0.4&uw=3&disable=vehicles` | |
| Underwater looking up at the surface (rippled Snell window, caustic highlights on the underside) | same with `yaw=100&pitch=25&uw=4` | |
| W6 Roger Dean sea city on the water | `/?mode=system&galaxy=0&star=1&planet=3&tod=0.4&view=fly&alt=76&pitch=-8&lat=8.4422&lon=34.4330&yaw=45` | |
| W6 island beach, noon | `/?mode=system&galaxy=0&star=1&planet=3&view=fly&alt=4&lat=-14.108&lon=-66.948&yaw=180&pitch=-5&tod=0.5` | |
| W4 Neon Monsoon storm surf | `/?mode=system&galaxy=0&star=2&planet=0&view=fly&alt=6&lat=8.826&lon=152.765&yaw=135&pitch=-5&tod=0.5` | |
| W4 night bay, neon reflections | `/?mode=system&galaxy=0&star=2&planet=0&tod=0.95&view=fly&alt=125&pitch=-3&lat=0.86&lon=32.79&yaw=0` | |
| Lava sea, Beksiński world (black crust, glowing fissure network, open melt) — **best lava view** | `/?mode=system&galaxy=0&star=22&planet=1&view=fly&alt=25&lat=-30.334&lon=-74.814&yaw=135&pitch=-10&tod=0.35&disable=vehicles` | |
| Lava sea, open melt with rafts (thick white haze on this moon) | `/?mode=system&galaxy=0&star=7&planet=4.0&view=fly&alt=14&lat=-7.276&lon=22.387&yaw=60&pitch=-14&tod=0.3&disable=vehicles` | |
| Ocean from 3 km: sun path, wind slicks | `/?mode=system&galaxy=0&star=6&planet=1&view=fly&alt=3000&lat=0&lon=-90&pitch=-14&yaw=90&tod=0.3` | |
| Ocean from orbit (glint on the day side) | `/?mode=system&galaxy=0&star=6&planet=1&view=orbit&lat=0&lon=-90&tod=0.55` | |
| Acid sea in a storm | `/?mode=system&galaxy=0&star=3&planet=0&view=fly&alt=4&lat=-26.425&lon=-99.917&yaw=225&pitch=-6&tod=0.35` | |
| Frozen sea in an arctic fjord (clear ice, frost cracks, pressure ridges) | `/?mode=system&galaxy=0&star=0&planet=4&view=fly&alt=3&lat=-12.764&lon=-82.965&yaw=170&pitch=-10&tod=0.35&disable=vehicles` | |

URL params added by this track: `reef=0` disables seabed life; `uw=<m>` puts the camera that many metres below sea level (the player
cannot dive yet); `wdebug=1` shows SSR hits (R), scene grab (G), Fresnel (B); `wdebug=2` lava emission only;
`wdebug=5` paints the water mesh magenta. `disable=vehicles` only removes parked vehicles from the frame.

## Performance
* Shore pass: one full-screen pass (≈ 6 texture fetches, early-outs on sky / water / > 2 m above the sea),
  only below 700 m and not on `low`.
* Mesh: high 190 rings × 208 segments ≈ 78k tris (1 draw call); low 110 × 128 ≈ 28k.
* Reef: 7 instanced draw calls, ≈ 2.5k instances / ≈ 0.35–0.45 M tris at high within 85 m (×0.55 med, ×0.3 low),
  only while the camera is within 260 m of the sea level; placement in the worker, re-requested after ~25 m of travel.
* Fragment: 8/10/12 Gerstner normals (low/med/high), 3 detail fetches, 2 caustic + 2 foam fetches,
  SSR (20 steps, high/ultra only, < 3 km). One colour+depth blit per frame.
* Textures synthesised once per planet in the water worker (≈ 0.5 s at 256² on a desktop core, 128² on
  low); bathymetry grids (9k `heightLod` samples at high) also in the worker, re-requested only after the
  camera moved ~30 % of the map. `isReady()` waits for both (shot mode).
* No per-frame allocations; one `gl.blitFramebuffer` per frame for the grab (resolves MSAA too).

## Known issues
* The ocean does not receive terrain/cliff shadows (CSM) — only cloud shadows. Sun glint can appear in
  water that should be in a cliff's shadow late in the day.
* SSR is a screen-space effect: reflections of objects outside the screen (above the top edge) fall back
  to the sky cube; thin horizontal streaks can appear where rays graze the far shore.
* Wave pattern of the texture layers jumps when the camera crosses a 4 km grid line and the Gerstner field
  re-anchors after ~0.12 rad of travel (only noticeable from a fast ship at low altitude).
* No true waterline split when the camera is half submerged (the underwater effect switches per frame).
* From orbit the ocean colour is dominated by the atmosphere's aerial perspective (pale blue); the glint
  is a broad soft highlight.
* Lakes above sea level are not simulated (the terrain carves lakes down to sea level, where the ocean
  fills them).
* Lava/acid worlds with thick haze wash the emissive colour toward pink/white (atmosphere fog) — the
  `star=7&planet=4.0` moon is the worst case; `star=22&planet=1` reads best.
* The shore pass wets anything within ~0.2–1 m above the sea next to the camera (also a parked vehicle's
  wheels or a cliff foot: plausible as spray). It does not know the local beach slope, so run-up is expressed
  in metres of height, not distance.
* Seen from below, the Snell window edge breaks into sharp-edged patches where ripples push the view past the
  critical angle (physically right, a little crisp).

## Requests
* **player** — (1) diving: let the swimmer dive below the surface (`descend` while swimming) — the water
  track already renders underwater (`world.get('water').under`, effect 130, marine snow); (2) frozen seas:
  when `world.get('water').solid` is true (liquid `ice`), treat the sea surface as walkable ground (height
  `seaLevel`) instead of swimming; (3) swim ripples are very bright opaque white rings over the new water —
  consider lower opacity / additive blending so they read as ripples, and use `water.heightAt(p)` for their
  height so they ride the swell.
* **atmosphere** — (new) the rectangular bright patch the critic saw above the sun glint in the 3 km capture is a
  cumulus billboard with a hard, axis-aligned edge (visible with the water disabled too): please give cloud
  impostors a soft radial / depth fade.
* **atmosphere** — (0) from orbit the aerial perspective turns the oceans pale sky-blue (the raw ocean is a
  dark navy — compare `disable=atmosphere`); Earth-like oceans from space should stay deep blue with a
  thinner blue veil; (1) the ocean reads `world.lighting.cubeRT.texture` (raw sky cube) for reflections;
  please keep it a plain `samplerCube` in scene/planet-local orientation (or expose `lighting.skyCube`);
  (2) volcanic worlds: let lava light the low haze (warm emissive fog near sea level) — the lava shader
  is ~3–6 units of emission; (3) a public function for sky radiance in a direction would allow sharper
  reflections than the 64² cube.
* **terrain** — (1) a thin dark seam line is visible on the sandy seabed underwater (W1 shelf, see the
  underwater capture); (2) optional: expose the heightfield chunk data / a coarse height texture around
  the camera so the water track can drop its own bathymetry sampling.
* **vehicles** — boats / hover-bike over water can use `water.heightAt(p)` and `normalAt(p)` for buoyancy.
* **post** — the underwater effect expects to run after the atmosphere (100) and before lens effects (150);
  the ocean is an opaque object in the main pass (renderOrder 1e6) and writes depth, so SSAO sees it.
