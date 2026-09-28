# Water track — oceans, lava seas, acid seas, frozen seas

Owner paths: `src/world/water/**`, this file.

## What was built

| file | content |
|---|---|
| `index.js` | subsystem (order 15): ocean mesh + material, scene grab, per-frame wave/LOD update, CPU queries, underwater (130) and lava heat-shimmer (145) pipeline effects |
| `waves.js` | `WaveSet`: wind-aligned Gerstner spectrum (8–12 waves by tier), float64 phases at the camera nadir, CPU `heightQ` with Gerstner inversion (used by `heightAt`) |
| `textures.js` | CPU generated, tileable, mipmapped: Phillips/Tessendorf spectrum via inverse FFT (slopes, fold/Jacobian, height), dispersive caustics (rays refracted through the spectrum and splatted), Worley foam webs, crust cells (lava / ice) |
| `shaders.js` | ocean surface vertex/fragment (water, acid, lava, ice variants), underwater effect, heat shimmer |

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

## Capture URLs
(filled in below as they are verified)

## Performance
* Mesh: high 190 rings × 208 segments ≈ 78k tris (1 draw call); low 110 × 128 ≈ 28k.
* Fragment: 8/10/12 Gerstner normals (low/med/high), 3 detail fetches, 2 caustic + 2 foam fetches,
  SSR (20 steps, high/ultra only, < 3 km). One colour+depth blit per frame.
* Textures generated once on the CPU (≈ 100–300 ms per planet at 256², 128² on low).

## Known issues

## Requests
