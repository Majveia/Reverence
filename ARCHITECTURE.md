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

### Showcase worlds (galaxy 0 — test your track on SEVERAL of these, not just one)

| key | URL fragment (`/?mode=system&galaxy=0&…`) | world |
|---|---|---|
| W1 | `star=6&planet=1` | Golden Valley — Bierstadt terran, ocean, villages (civ 3) |
| W2 | `star=11&planet=0` | Hyrule Echo — BotW archipelago, ruins (civ 4) |
| W3 | `star=9&planet=2` | Arzach Dunes — Moebius savanna, white spires (civ 3) |
| W4 | `star=2&planet=0` | Neon Monsoon — Blade Runner ocean world, neon megacity (civ 4) |
| W5 | `star=1&planet=2` | Dimension C-137 Wilds — Rick & Morty jungle (civ 3) |
| W6 | `star=1&planet=3` | Floating Arches — Roger Dean archipelago (civ 5) |
| W7 | `star=3&planet=2` | Solaris Sea — Tarkovsky terran, monasteries (civ 3) |
| W8 | `star=2&planet=1` | Loop Lowlands — Stålenhag savanna, industrial (civ 5) |
| W9 | `star=2&planet=2.1` | Atlas Bloom — NMS jungle moon of a ringed gas giant (civ 4) |
| W10 | `star=17&planet=0` | Hearthian Campfire — Outer Wilds jungle, wooden villages (civ 5) |
| W11 | `star=0&planet=0` | Sea of Corruption — Nausicaä exotic, nomads (civ 4) |
| W12 | `star=9&planet=5` | Tarkovsky arctic world with rings (civ 2) |
| G1 | `star=2&planet=2` | ringed gas giant (use `view=orbit`) |
| M1 | `star=0&planet=2.0` | Monolith Silence — Kubrick barren moon |

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

## 6. Cross-track requests inbox (maintained by the lead — check for your track!)

* **galaxy** — boot logs `THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false` (fails check.mjs). A shader
  uses `rv_hash13`/helpers without `#include <rv_common>` (rv_noise now includes rv_common itself).
* **space** — render stars, galactic band, sun disk and planets as *background* (depth = far plane); the
  atmosphere effect attenuates them by view transmittance and hides faint stars by day. The atmosphere's
  stand-in star field disables itself once `world.get('space')` exists.
* **water / flora / civ / fauna** — cloud shadows: `#include <rv_cloudshadow>` with
  `world.lighting.uniforms.rvCloudShadow*` in custom shaders; react to `G.uWetness` (dark glossy wet
  surfaces, puddles) and `G.uSnow` (snow on up-facing surfaces). Use `world.lighting.setupMaterial(mat)`.
* **flora / civ / fauna** — `surface.sample()` also returns `slope, rock, sand, snow, cliff, river, lake,
  mountain, continental, dune`; `surface.heightLod(x, y, z, lod)` is a cheaper height for distant placement.
* **player** — `view=orbit` camera must look at the planet (rotation was identity); keep the camera
  horizon level when spawning on slopes (W2/W12 spawns came out rolled).
* **ui** — `setMarkers` always prefixes '◦'; add marker kinds (e.g. `kind: 'cosmic'` = small centred label
  only, since cosmic draws its own ring in-scene).
* **audio** — cosmic calls `audio.setParam('cosmicGrowth', 0..1)` every 0.2 s and `audio.play('whoosh')`
  on fly-to; atmosphere/weather sets `G.uWetness`, `G.uWindStrength` (rain, wind beds).
* **post** — MSAA is now disabled automatically on software GL (`quality.software`); consider auto-exposure
  keyed to `G.uSunIntensity` / `G.uAmbientSky` for storms and nights; keep OLED blacks at night.
* **capture tooling (done)** — shared dev server runs without HMR (no mid-capture reloads), screenshots
  have a 180 s timeout, shot mode never renders idle frames after ready.
* **flora** (from player) — register `world.addCollider({ type: 'sphere'|'capsule', pos, radius, height })` for
  boulders > ~1 m and tree trunks so the player collides and the camera avoids big props.
* **civ** (from player) — register box colliders for buildings (`halfExtents` + `quaternion`, local Y ≈ up):
  the player can stand on roofs, walls block movement, large boxes block the camera. Climbing on building
  colliders is not supported yet.
* **water** (from player) — expose `heightAt(p)` (planet-local point → water surface height in m relative
  to radius, waves included). Swimming/splashes/ripples pick it up automatically.
* **audio** (from player) — one-shots: `step {surface: ground|sand|snow|rock, speed, side}`, `jump`,
  `land {intensity}`, `boost`, `glider {open}`, `splash {intensity}`; params `speed, altitude, wind, glide,
  swim, boost`.
* **ui** (from player) — player uses prompt id `'player'` (text only); on touch, map a glide/jump button to
  `jump` and a slide button to `descend`. Player views: `view=surface|fp|fly|orbit`, `act=slide`,
  `camyaw`, `zoom` URL params.
* **vehicles** (from player) — the unoccupied parked bike renders a rider mannequin (remove it when parked);
  moving vehicle colliders flagged `vehicle: true` are checked per frame by the player.
* **flora + terrain (PERF, from lead)** — measured on W2 forest at `high`: flora 2.7M tris + 1.0M as shadow
  casters, terrain 1.8M; with 3 CSM cascades ≈ 9M tris/frame (budget: < 3M main + < 1M casters at high,
  far less on med/low/mobile). Fix: grass must not cast shadow-map shadows (use AO/contact darkening), trees
  cast only into the near cascade(s), grass as multi-blade clumps/cards with fewer tris, earlier impostors,
  coarser terrain chunks at distance. Software captures use a reduced profile (`quality.captureProfile`:
  floraDensity ≤ 0.45, terrainDetail ≤ 0.85, 1024 shadow maps); add `&full=1` for full-quality hero shots.
* **terrain** (from flora) — tint the ground toward grass colour (biome + moisture) under dense grass so
  meadows read denser at mid-distance.
* **player** (from flora) — avoid spawn positions within ~4 m of colliders tagged `'tree'`.
* **post** (from flora) — TAA or SMAA to anti-alias alpha-tested foliage/grass edges (alpha-to-coverage
  only applies when `quality.msaa > 0`, which software captures disable).
* **debug (lead)** — `?disable=fauna,vehicles` skips subsystems; `?only=terrain,atmosphere` loads just those.
* **input (done, lead)** — `menu` action = Escape / Pad9 (opens the UI menu); `back` = Backspace (up a scale).
* **flora** (from civ) — skip instances inside settlement clearings: `C = world.civ?.clearings ||
  world.get('civ')?.clearings`, entries `[dirX, dirY, dirZ, cosAngularRadius, keepFraction]`; for a candidate
  unit direction d, if `dot(d, c) > cosR` keep only a `keepFraction` of instances (grass and layers).
* **player** (from civ) — with no `yaw` URL param, face `world.civ?.spawnTarget` (planet-local Vector3 of the
  capital) at spawn so the first frame shows the town; keep the horizon level for `view=fly` spawns on slopes.
* **terrain** (from civ, nice-to-have) — flatten stamps `surface.addFlatten({dir, radius, height, falloff})` so
  plazas/building pads grade into terrain.
* **ui** (from civ) — POIs of kind city/village/ruin/monument carry `data.capital`, `data.style`: larger marker
  and name for capitals. (from ui) civ/flora 'wonder' POIs repeat names ('Elder Oak' ×25): use unique names
  or `minor: true`; capitals should be `kind: 'city'`.
* **audio** (from ui) — expose `audio.setVolume(0..1)`; `discovery` events with `source: 'ui'` are place-name
  banners (good moment for a sting).
* **vehicles** (from ui) — prompt glyphs: use `engine.ui.device` ('touch' whenever the touch layer is active)
  instead of `input.lastDevice`.
* **space** (from galaxy) — render the actual host galaxy from the current star with
  `GalaxyModel.galaxyDensity()` / `galaxyStructure()` for a Milky-Way band with that galaxy's real dust lanes.
* **audio** (from galaxy) — `audio.play('select')` on star selection, `audio.play('whoosh')` on travel.
  (from vehicles) engine voices from params `engine, speed, boost, altitude`; one-shots `takeoff`,
  `pulse {on}`, `impact {intensity}`, `land {intensity}`, `vehicle.enter/exit` (event `vehicle:enter {type}`).
* **ui** (from galaxy) — telemetry keys 'Scale', 'Horizon' and marker `sub` text 'class · temperature'.
  (from vehicles) ship telemetry: `drive: 'PULSE'`, `status` (LANDED/REENTRY), `target` (nearest body +
  distance); optionally a small target marker.
* **atmosphere** (from vehicles) — stop rain/snow streaks when the camera is above the cloud layer or outside
  the atmosphere (`G.uCameraAltitude > atmosphere height`).
* **flora** (from vehicles) — `flora.clearAround(pos, radius)` or honour `world.pois` of kind `'landing'` so
  understorey plants are culled under a parked 15 m starship.
* **vehicles URL params** — `view=bike|rover|ship`, `speed=`, `cam=chase3q|hero`; galaxy `focus=core|local|neb:N`.
* **atmosphere** (from water) — from orbit the haze turns oceans pale sky-blue: keep Earth-like oceans deep
  blue under a thinner veil (compare with `&disable=atmosphere`). On volcanic worlds let lava light the low
  haze (warm glowing fog near sea level) and thin the haze near the surface (star=7&planet=4.0 washes lava
  pink/white). Keep `lighting.cubeRT.texture` a plain planet-local samplerCube (or expose `lighting.skyCube`).
* **atmosphere** (from space) — for gas-giant bodies skip the cumulus shell (thin high haze at most; set
  `world.atmosphere.gasGiantSurface = true` if you draw the deck); apply the daytime star-hiding threshold
  (`uStarVis`) only to far-plane background, not to planets/rings with real depth; no rain streaks outside
  the atmosphere (W4 `view=orbit`).
* **player** (from water) — dive while swimming (descend); underwater rendering is ready
  (`world.get('water').under`, effect 130); treat `water.solid` (ice seas) as walkable ground; lower-opacity
  swim ripples. (from space) `view=fp` should honour `fov=` for telephoto sky shots.
* **terrain** (from water) — thin dark seam line on the sandy seabed underwater (W1 shelf).
* **vehicles** (from water) — hoverbike/boats: buoyancy via `water.heightAt(p)` / `water.normalAt(p)`.
* **post** (from space) — lens flare/glare hooks on `world.space.sun` (`dir`, `screen` NDC, `onScreen`,
  `visibility`, `color`, `angularRadius`).
* **core (done)** — gas-giant moons now orbit at 3.6–5 R (first) with 1.35–1.7× spacing: W9's giant spans
  ~15° of sky (was ~10°).
* **space** (from post) — when seen from orbit, draw the star disc into the HDR target at far-plane depth so the
  lens-flare occlusion probe sees a real bright disc.
* **flora** (from post) — dithered alpha on leaf cards (noise keyed to `G.uFrame`) so TAA resolves soft canopy
  edges; `engine.pipeline.stats.taa` says whether TAA is on.
* **atmosphere** (from post) — clear-day sky radiance is dim vs sunlit ground (sky highlights ~0.7 after
  tonemapping): raise it so grading reaches reference-level highlights without over-exposing ground.
* **ui/core** (from post) — depth of field for transitions/photo mode:
  `engine.pipeline.setLook({ dof: { enabled: true, focus: 0, aperture: 1 } })` (focus 0 = auto-focus centre).
* **player** (from fauna) — `world.player.lookAt(pos)` to face a target at spawn (creature showcases via `&fauna=`).
* **vehicles** (from fauna) — `props=0` URL param (or skip when `&fauna=` is set) to not spawn the parked
  bike/rover/ship, so creature captures aren't cluttered.
* **audio** (from fauna) — creature ambience from `fauna.creatures` / `nearest()`: bird calls near flocks, whale
  song under pods, night insect chorus; creature `discovery` events carry an `archetype`.
* **ui** (from fauna) — show an icon from the `archetype` field on creature discovery events.
