# Reverence — Architecture & Contracts

A playable, procedurally generated universe in Three.js (WebGL2): from the **cosmic web**
(gravity, expansion, structure formation) → **galaxies** → **star systems** → **living planets**
you can walk, glide, drive and fly across. Minimal, immersive, OLED-black, runs on desktop
and mobile.

> Vision (from the brief): *Cosmos: Possible Worlds × Planet Earth III × No Man's Sky ×
> Starfield × Outer Wilds × Pacific Drive × Breath of the Wild × Rick and Morty × Cowboy Bebop.*
> Emergent, elegant, novel, alive. Worlds with life, civilization, cities, art and technology,
> each art-directed like a great film. Controls that put you in a flow state. Maximum ambition.

---

## 1. Run & capture

```bash
npm install
npm run dev                       # http://localhost:5173  (a shared dev server is usually already running)
node tools/shoot.mjs --url "/?mode=system&view=surface&tod=0.3" --out shots/x.png
node tools/check.mjs              # build + boot every mode headlessly, reports console errors
```

URL params (see `src/core/Params.js`): `mode=cosmic|galaxy|system`, `seed`, `galaxy`, `star`,
`planet` (`"2"` or moon `"2.1"`), `view=surface|fp|fly|orbit|bike|rover|ship`, `lat`, `lon`,
`yaw`, `pitch`, `alt`, `dist`, `tod` (0 midnight · .25 sunrise · .5 noon · .75 sunset),
`q=low|med|high|ultra`, `shot=1`, `ui=1`, `stats=1`, `time`.

**Every visual state a critic needs must be reachable by URL + `__rv` steps.** If you add a
feature (a city, a vehicle, a creature herd), make it easy to frame: e.g. document good
`lat/lon/yaw/pitch` values in your track notes, or add a `view=` preset.

`window.__rv` (deterministic in `shot=1`): `ready`, `advance(sec)`, `hold(code, sec)`,
`press(code)`, `move(x, y, sec)`, `look(dxDeg, dyDeg)`, `click(px, py)`, `go(mode, params)`,
`state()`, `render()`. Sim time is frozen until the mode is ready, then advances only via
`advance()` — screenshots are reproducible.

## 2. Ownership map (one track = one owner; edit ONLY your paths)

| Track | Owns | Notes |
|---|---|---|
| core (lead) | `src/core/*`, `src/main.js`, `src/modes/system/*`, `src/world/World.js`, `src/world/Celestial.js`, `src/universe/*` (except GalaxyModel), `tools/*`, `index.html`, `ARCHITECTURE.md` | contracts; request changes via your track notes |
| post | `src/post/*` | HDR pipeline, bloom, tonemap, grading, TAA/SMAA, auto-exposure, lens effects |
| cosmic | `src/modes/cosmic/*` | cosmic web: GPU N-body/Zel'dovich, expansion, clusters, filaments, voids |
| galaxy | `src/modes/galaxy/*`, `src/universe/GalaxyModel.js` | galaxies, nebulae, dust, black hole (lensing), star picking |
| space | `src/world/space/*` | star (corona, granulation), other planets/moons/rings seen from anywhere, asteroid belts, comets, star field + Milky-Way sky, orbit map |
| terrain | `src/world/planet/*`, `src/world/terrain/*` | PlanetSurface (height/biome = CPU source of truth), LOD terrain, terrain materials |
| atmosphere | `src/world/atmosphere/*` | scattering (space+ground), sun/moon light, shadows (CSM), clouds, weather, night sky glow, env maps, fog |
| water | `src/world/water/*` | oceans/lakes/lava/acid, waves, shore foam, underwater |
| flora | `src/world/flora/*` | grass, trees, flowers, alien plants, wind, instancing, LOD |
| fauna | `src/world/fauna/*` | creatures, flocks, herds, sky whales, fish; behaviors |
| civ | `src/world/civ/*` | settlements by art style, buildings, roads, lights, monuments/art, NPCs, traffic |
| player | `src/world/player/*` | character (procedural anim), TP/FP camera, movement (glide, climb, sprint, swim), physics helpers |
| vehicles | `src/world/vehicles/*` | hoverbike, rover, starship (atmo+space flight, landing, pulse drive) |
| ui | `src/ui/*`, `src/styles.css` | minimal HUD, mobile touch controls, menus, markers, map, transitions |
| audio | `src/audio/*` | procedural music & SFX (WebAudio, no files) |

**Rules for parallel work**
1. Edit only files you own. Need something from another track? Use its public API; if missing,
   write the request in `docs/tracks/<your-track>.md` under "Requests" and work around it.
2. **Never run git commands that change state** (commit, add, stash, checkout, reset, rebase).
   The lead commits. `git diff/status/log` are fine.
3. Don't start/stop the shared dev server on :5173. `tools/shoot.mjs` auto-starts its own if needed.
4. Keep your subsystem **fault-tolerant**: guard against missing optional neighbours
   (`world.get('flora')` may be null). A crash must never blank the screen.
5. Determinism: generation uses `RNG`/`hashCombine`/`Noise` from `src/core/*` seeded from
   `body.seed` — **never `Math.random()` for world content** (fine for purely cosmetic jitter).
6. Performance is a feature. Scale with `engine.quality` (`particleScale`, `floraDensity`,
   `drawDistance`, `shadows`, `volumetrics`, `terrainDetail`, `tier`, `mobile`). Budgets at
   `high`: < 600 draw calls, < 3M triangles, no per-frame allocations in hot loops, heavy
   generation in workers or time-sliced. `low` must be playable on a phone.
7. Dispose every GPU resource in `dispose()`/`exit()`.
8. Document your track in `docs/tracks/<track>.md`: what you built, good capture URLs, API.

## 3. Coordinates & scale

* **Cosmic / galaxy modes**: free choice of units inside the mode (document them).
* **System mode / World**: meters. **Planet-local frame**: planet center at origin, +Y = north
  pole, rotates with the ground. All gameplay math uses planet-local float64 vectors.
* Objects on/around the planet are children of **`world.root`** using planet-local positions.
  The **camera is a child of `world.root`** too. `world.root.position = -world.origin`
  (floating origin, re-based every 4 km) ⇒ shader world positions are small near the camera.
  `world.root` never rotates ⇒ directions are the same in local and scene space.
* Sky bodies (star, planets, moons) are placed each frame via `world.celestial`
  (`bodyLocal(b)`, `toLocal(inertial)`, `toLocalDir(dir)`); the star field rotates with
  `celestial.qInv` so stars wheel across the night sky.
* Lat/lon: `latLonToDir(lat, lon)` (`src/core/math.js`): +Y north, lon 0 on +Z, lon 90 on +X.
* Scales (see `src/universe/Universe.js`): rocky planets 28–110 km radius, relief ≈ 3.5–7% of
  radius, atmosphere ≈ 12% of radius, moons 12–45 km, gas giants 260–650 km, stars ≈ 300–2000 km,
  orbits 2e7–6e8 m, days 16–48 min. Gravity ≈ 0.45–1.35 g (moons lower).
* **Depth**: reversed-Z with a 32F depth texture (when `EXT_clip_control` exists; check
  `engine.reversedDepth`). Near 0.05 m, far 2e10 m. In GLSL use `#ifdef USE_REVERSED_DEPTH_BUFFER`
  (far plane = depth 0). Linearize with `rv_viewZFromDepth(depth, near, far)` (`rv_common`) or
  three's `perspectiveDepthToViewZ`. Sky domes: see `src/world/atmosphere/index.js` (writes z = far).

## 4. Core APIs (stable — add, don't rename)

* `engine`: `renderer`, `quality`, `input`, `director`, `pipeline`, `universe`, `ui`, `audio`,
  `events`, `time {t, dt, frame}`, `params`, `shot`, `width/height`, `reversedDepth`.
* `Input` (`src/core/Input.js`): `axis('move'|'look')`, `held/down/up(action)`, `zoom`,
  `pointer {nx, ny, clicked, doubleClicked, dragging}`, `setScheme('orbit'|'character'|'vehicle'|'flight')`,
  `setVirtual(action, bool)` (touch buttons), `touchSticks` (for UI rendering),
  `lastDevice` ('keyboard'|'touch'|'gamepad'), `requestPointerLock()`.
  Actions: jump, ascend, descend, sprint, boost, interact(E), vehicle(F), view(V), map(M/Tab),
  back(Esc), primary, secondary, photo(H), time(T), glide, rollLeft/rollRight(Q/E), up/down/left/right.
* `Pipeline` (`src/post/Pipeline.js`): `addEffect({name, order, render(renderer, io)})`,
  `setLook({...})`, `settings`, `depthTexture`, `makeFullscreenMaterial()`, `FullscreenQuad`.
  Effect orders: ssao 50 · atmosphere 100 · clouds 110 · volumetric light 120 · underwater 130 ·
  lens/heat/distortion 150.
* `G` shared uniforms (`src/core/Uniforms.js`): uTime, uResolution, uSunDir, uSunColor,
  uSunIntensity, uAmbientSky, uAmbientGround, uNight, uPlanetCenter, uPlanetRadius, uSeaLevel,
  uAtmosphereRadius, uCameraAltitude, uWindDir, uWindStrength, uWetness, uSnow, uCameraPos…
  Materials can reference them directly (`uniforms: { uTime: G.uTime }`).
* GLSL chunks: `#include <rv_common>` (hash, IGN dither, luma, depth linearize),
  `#include <rv_noise>` (simplex, fbm, ridged, worley), `#include <rv_color>` (blackbody).
  Register your own with `registerChunk(name, glsl)` from `src/shaders/chunks.js`.
* `World` (`src/world/World.js`): `root`, `camera`, `scene`, `body`, `system`, `star`,
  `surface`, `celestial`, `time`, `timeScale`, `controller`, `player`, `colliders`, `pois`,
  `get(name)`, `groundAt(dir, offset)`, `upAt(pos)`, `addCollider()`, `addPOI()`, `events`.
  Subsystem module: `export default { name, order, async create(world) { return inst } }` with
  optional `update(dt,t)`, `lateUpdate(dt,t)`, `isReady()`, `getState()`, `onOriginShift(delta)`,
  `dispose()`.
* `PlanetSurface` (`world.surface`): `height(x,y,z)`, `sample(x,y,z,out)` → `{height, biome,
  moisture, temperature}`, `normal(dir)`, `seaLevel`, `maxHeight`, `amp`, `biomeColor(biome)`,
  `BIOMES`. CPU/worker-safe. **Placement and physics must use this, never raycast the GPU mesh.**
* Controller hand-off (player ⇄ vehicles): `world.controller` is the object currently driving
  the camera. The player sets itself on spawn. A vehicle takes control with
  `world.setController?.(vehicle)` or `world.controller = vehicle` and must return control to
  `world.player` on exit; the player hides/shows its body accordingly. The player exposes
  `world.player.pos` (local Vector3), `.forward`, `.up`, `.vel`, `.view`, `.teleport(pos)`.
* Colliders (`world.colliders`): `{ type: 'sphere'|'capsule'|'box', pos: Vector3(local),
  radius, height, halfExtents, quaternion, tag }` — civ buildings, rocks, trees register
  them; the player/vehicles collide against them (spatial hash recommended).
* POIs (`world.pois`): `{ kind: 'city'|'village'|'monument'|'ruin'|'landing'|'creature'|'wonder',
  name, pos, radius }` — used by UI markers, discovery toasts, audio, spawn selection.
* Events (`engine.events` / `world.events`): `discovery {kind,name}`, `mode:enter`,
  `origin:shift {delta}`, `vehicle:enter|exit {type}`, `player:land`, `player:jump`,
  `poi:add`, `input:gesture`, `input:scheme`, `ready`.
* `UI` (`src/ui/UI.js`): `setLocation`, `showTitle`, `prompt(id,text,action)`, `clearPrompt`,
  `toast`, `hint`, `setTelemetry`, `setMarkers`, `setControls(scheme)`.
* `Audio` (`src/audio/Audio.js`): `setScene(name, params)`, `setParam(name, v)`, `play(name, opts)`.
* `Universe` data: `universe.galaxy(g)`, `.star(g, s)`, `.system(g, s)`, `.body(system, "2.1")`,
  `.bestPlanet(system)`. Planet fields: `radius, gravity, type, dayLength, axialTilt, orbit,
  atmosphere{present,density,height,tint,mie,mieG,haze}, ocean{present,level,liquid,shallow,deep},
  clouds{coverage,type,altitude}, terrain{amplitude,features,...}, life{flora,fauna,style},
  civ{level 0-5, style, name, settlements}, rings, weather, art`.
* **Art direction** (`src/universe/art.js`): each body has `body.art` = a preset inspired by a
  director/artist/game (Ghibli, Moebius, Villeneuve, Blade Runner, Stålenhag, Roger Dean,
  Tarkovsky, Friedrich, Bierstadt, Beksiński, Nausicaä, Bebop, Rick & Morty, Kubrick, Turner,
  VanderMeer, BotW, Outer Wilds, NMS, Starfield) with `palette`, `grade`, `civ`, `flora`,
  `clouds`, `weather`. **Read these** so terrain, sky, flora, cities and grade agree.

## 5. Quality bar

We are compared **blind, side by side** against screenshots of No Man's Sky, Starfield, Outer
Wilds, Pacific Drive and Breath of the Wild (and, for cosmic scales, Space Engine / scientific
visualizations). What separates AAA from "tech demo":
* Lighting first: correct sun/sky balance, soft shadows, ambient occlusion, bounce light,
  aerial perspective, atmospheric depth layering, specular highlights, rim light.
* Material richness: micro-detail normal/roughness variation, triplanar detail up close,
  no stretched textures, no flat vertex-color look, no obvious tiling/repetition.
* Density & scale: things at every distance (foreground detail, midground interest,
  background silhouettes), layered composition, readable silhouettes.
* Motion: wind in foliage, drifting clouds, living creatures, flickering lights, water motion.
* Color: art-directed palette, filmic tonemapping, no banding (dither), true OLED blacks.
* Zero artifacts: no z-fighting, popping, seams, shadow acne, aliasing shimmer, NaNs, black frames.
