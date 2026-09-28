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
| `shaders.js` | ocean surface vertex/fragment (water, acid, lava, ice variants), underwater effect, heat shimmer, marine snow |

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
* **Underwater** (`underwater`, order 130) — when the camera is below the local wavy surface: absorption
  fog, in-scatter integrated along the ray with depth-dependent sunlight and god-ray shafts (caustic
  pattern projected along the sun), seabed caustics; the surface from below shows Snell's window and
  total internal reflection.
* **Liquids** — `water`; `acid` (venom-green self-luminous scatter, murky); `lava` (slow viscous swell,
  drifting crust plates with incandescent blackbody cracks, hot shoreline, glassy sheen, heat shimmer
  effect 145); `ice` (static frozen sea: pressure plates, cracks with blue subsurface glow, snow drifts,
  glossy reflections).

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
| Underwater looking up at the surface | same with `yaw=100&pitch=12&uw=5` | |
| W6 Roger Dean sea city on the water | `/?mode=system&galaxy=0&star=1&planet=3&tod=0.4&view=fly&alt=76&pitch=-8&lat=8.4422&lon=34.4330&yaw=45` | |
| W6 island beach, noon | `/?mode=system&galaxy=0&star=1&planet=3&view=fly&alt=4&lat=-14.108&lon=-66.948&yaw=180&pitch=-5&tod=0.5` | |
| W4 Neon Monsoon storm surf | `/?mode=system&galaxy=0&star=2&planet=0&view=fly&alt=6&lat=8.826&lon=152.765&yaw=135&pitch=-5&tod=0.5` | |
| W4 night bay, neon reflections | `/?mode=system&galaxy=0&star=2&planet=0&tod=0.95&view=fly&alt=125&pitch=-3&lat=0.86&lon=32.79&yaw=0` | |
| Lava sea (crust plates, glowing fissures, flow veins, heat shimmer) | `/?mode=system&galaxy=0&star=7&planet=4.0&view=fly&alt=14&lat=-7.276&lon=22.387&yaw=60&pitch=-14&tod=0.3&disable=vehicles` | |
| Acid sea in a storm | `/?mode=system&galaxy=0&star=3&planet=0&view=fly&alt=4&lat=-26.425&lon=-99.917&yaw=225&pitch=-6&tod=0.35` | |
| Frozen sea in an arctic fjord (clear ice, frost cracks, pressure ridges) | `/?mode=system&galaxy=0&star=0&planet=4&view=fly&alt=3&lat=-12.764&lon=-82.965&yaw=170&pitch=-10&tod=0.35&disable=vehicles` | |

URL params added by this track: `uw=<m>` puts the camera that many metres below sea level (the player
cannot dive yet); `wdebug=1` shows SSR hits (R), scene grab (G), Fresnel (B); `wdebug=5` paints the water
mesh magenta. `disable=vehicles` only removes parked vehicles from the frame.

## Performance
* Mesh: high 190 rings × 208 segments ≈ 78k tris (1 draw call); low 110 × 128 ≈ 28k.
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
* Lava/acid worlds with thick haze wash the emissive colour toward pink/white (atmosphere fog).

## Requests
* **player** — (1) diving: let the swimmer dive below the surface (`descend` while swimming) — the water
  track already renders underwater (`world.get('water').under`, effect 130, marine snow); (2) frozen seas:
  when `world.get('water').solid` is true (liquid `ice`), treat the sea surface as walkable ground (height
  `seaLevel`) instead of swimming; (3) swim ripples are very bright opaque white rings over the new water —
  consider lower opacity / additive blending so they read as ripples, and use `water.heightAt(p)` for their
  height so they ride the swell.
* **atmosphere** — (1) the ocean reads `world.lighting.cubeRT.texture` (raw sky cube) for reflections;
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
