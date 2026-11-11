# Reverence

An original, playable, simulated universe in Three.js — you fall from the cosmic web, through a galaxy, into a
star system, and walk / ride / fly across living worlds. No build step, no external assets: everything is
procedural (geometry, textures, music), deterministic from seeds, and must look and feel like a labour of love.

## The bar (the owner's words, condensed)

- "Grand, epic, beautiful, immersive, majestic, transcendent, awe-inspiring, goosebumps-inducing."
- Fidelity: crisp, "4K QD-OLED" — **true OLED black**, rich saturated colour, no banding, no mush, no placeholder look.
- Fresh, novel, tasteful, *rich* art and animation with depth and diversity. Never generic, never empty.
- A real simulated universe: gravity, expansion, structure formation; real orbital mechanics; believable light.
- Worlds that are alive: complexity, beauty, civilisation, cities, towns, technology, art, creatures.
  Each world carries the *feeling* of great film-makers / artists (see `src/core/universe/themes.js` → `homage`).
- "Flowy and vibey — a constant flow state." Controls must be fluent and intuitive on desktop **and** mobile.
- Minimal, immersive, clean interface: tiny, responsive, never obscuring the picture.
- Reference bar for look & feel: the best modern AAA games. Be a harsh critic of your own screenshots.

Originality rule: homage is mood, light and composition only. Never copy an existing game/film's names,
characters, designs, logos, levels or music.

## Run / test

```bash
node tools/serve.mjs 8080            # dev server (no-cache). A shared one is usually already running on :8080
node tools/shot.cjs --q "realm=system&site=city0&dist=600&height=120&tod=0.3" --out shots/city.png
```

`tools/shot.cjs` drives headless Chromium with **software WebGL2** (slow: seconds per frame for heavy scenes, but
pixel-accurate). It loads `/?harness=1&<q>`, waits for `RV.ready`, lets the world settle (no pending async work +
`--frames N` rendered frames, default 40), saves a PNG and prints JSON: console errors/warnings + render stats.
See the header of `tools/shot.cjs` for `--eval`, `--after`, `--print`, `--script`, `--mobile`, `--w/--h/--dpr`.
**Always look at your screenshots (Read the PNG) and fix what you see.** Console errors = failure.
Write screenshots to `shots/<your-area>-*.png` (git-ignored). You never need to start a server: the harness uses the
shared one on :8080 if present, else a private one for the run. Never `pkill node` — other agents share this
machine. Be frugal: ≤ 1280×720, few frames.

In harness mode time is deterministic (fixed dt 1/60 per rendered frame) and the DOM UI is hidden unless `ui=1`.

### URL parameters

| param | meaning |
|---|---|
| `harness=1` | fixed timestep, no pointer lock, load only the realm named by `realm` (add `all=1` to load all) |
| `realm=cosmos\|galaxy\|system` | start directly in a realm (skips the intro) |
| `nointro=1` / `intro=1` | skip / force the intro |
| `q=low\|medium\|high\|ultra` | quality tier (`engine.quality.detail` = 0.5 … 1.5 scales densities) |
| `seed=<n>` | universe seed |
| `ui=0\|1`, `audio=0`, `fxaa=0`, `shadows=0`, `depth=log\|standard` | toggles |
| `only=a,b` / `skip=a,b` | system realm: load only / skip feature modules (`space,terrain,atmosphere,ocean,flora,civ,fauna,player,vehicles`) |
| system: `body=<id>` | start at a body of the home system: `solenne` (pastoral, home), `kharaa` (desert), `verdance` (jungle), `yugen` (mist), `ember` (volcanic), `prisma` (crystal), `nocturne` (neon moon of Halcyon), `boreal` (ice moon), `lumen` / `pearl` (airless moons), `thalune` (ocean moon), `halcyon` / `mirelle` (giants) |
| system: `site=<id>` | settlement to start at: `arrival` (default spawn), `city0…`, `town0…`, `outpost0…`, `monument0…` |
| system: `mode=foot\|bike\|ship\|fly` | control mode (`fly` = built-in free camera, always available) |
| system: `dist`, `az`, `height`, `lookHeight` | free camera `dist` m from the site at azimuth `az`°, `height` m above the site's elevation, looking at the site (+`lookHeight` m) |
| system: `tod=0..1` | local solar time at the site (0.25 ≈ sunrise, 0.5 noon, 0.75 ≈ sunset, 0 midnight) |
| system: `orbit=<radii>` | arrive in space at that many body radii |
| system: `t=<seconds>` | simulation time |
| `shot=<name>` | run a named shot registered by a module (`ctx.addShot`, `realm.shots`) |

## Architecture

```
index.html            import map (three → vendor/), <canvas id="view">, <div id="ui">
src/main.js           boot: Engine → realms → audio/ui/intro → start        window.RV = debug handle
src/core/engine.js    Engine: renderer, loop, realms, travel(), tween(), loading, quality
src/core/post/pipeline.js   HDR pipeline (PostPipeline, PostPass, LAYERS, defaultGrade)
src/core/input.js     actions/axes for keyboard, mouse, touch, gamepad + virtual layer for touch UI
src/core/rng.js       hash32, rng(seed), makeNoise(seed) (simplex/fbm/ridged/billow/worley), math helpers. Worker-safe
src/core/glsl.js      GLSL chunks: common (hash, IGN, …), noise, color (blackbody…), depth, logdepth includes
src/core/universe/    Universe (galaxies, stars, systems, bodies), themes.js (art direction table), kepler.js, names.js
src/planet/heightfield.js   THE height function of a world (terrain module owns it; everyone else calls it)
src/realms/cosmos/    cosmic web realm            src/realms/galaxy/   galaxy realm
src/realms/system/    star-system realm hub: index.js (frames, time, anchor, world), lighting.js (sun + CSM),
                      world.js (World queries), control.js (controllers, interactables, colliders), flycam.js
src/realms/system/space/    star, far planets, giants, rings, belts, comets, sky backdrop
src/planet/{terrain,atmosphere,ocean,flora,civ,fauna}/   features of the active world
src/player/  src/vehicles/  src/audio/  src/intro/  src/ui/
vendor/three/         three.js r187 (WebGL build) + addons.   import * as THREE from 'three'; 'three/addons/…'
```

**Ownership.** Each module directory has exactly one owner. Edit only your own directory (plus new files under
`assets/<yours>/`). `src/core/**`, `src/realms/system/{index,lighting,world,control,flycam}.js`, `src/main.js`,
`index.html`, `tools/**` are owned by the lead: do not edit them — if you need a core change, say so in your
final report with the exact change. Every module is loaded with a guarded dynamic import, so a broken module
never takes the app down; still, never leave yours throwing.

### Rendering rules (non-negotiable)

- Renderer: `WebGLRenderer` (WebGL2), reversed-Z float depth when `EXT_clip_control` exists, otherwise
  logarithmic depth. **Every custom `ShaderMaterial` drawn in a scene must include the log-depth chunks**
  (`#include <common>` + `<logdepthbuf_pars_vertex>` / `<logdepthbuf_vertex>` after `gl_Position` is set, and
  `<logdepthbuf_pars_fragment>` / `<logdepthbuf_fragment>`), or it will z-fight in log mode. Test with `depth=log` too.
- The scene renders into an **HDR linear** half-float target. No tone mapping / sRGB in your shaders
  (`toneMapped: false` for emissive ShaderMaterials). Emissive/bright things should exceed 1.0 (stars 5–50)
  — bloom picks up exposed values above ~1. Colours you pass as uniforms must be **linear** (`new THREE.Color('#hex')` is).
- Space is black: `0,0,0`. Never add ambient fog / grey lift to space. Banding is a bug: dither gradients
  (`rvIGN`, `rvTriNoise` in `GLSL.common`).
- Lit surface objects should use `MeshStandardMaterial` / `MeshPhysicalMaterial` (extend with `onBeforeCompile`
  for custom look) so they receive the sun, cascaded shadows and sky light from the lighting rig. The hub wraps
  lit materials for CSM automatically — set your `onBeforeCompile` *before* first render and don't reassign it.
  If two materials share an `onBeforeCompile` function but differ in behaviour, give them a `customProgramCacheKey`.
- Post passes: `new PostPass({ name, fragment, uniforms, order })` (see pipeline.js header for the uniforms you
  get: `tColor`, `tDepth`, `vUv`, `vRay`, `uCamPos`, `rvViewDepth()`, `rvIsSky()`…). Add with `ctx.addPass(pass)`
  in the system realm or put it in `realm.passes`.
- Refractive things (water, glass): put the mesh on `LAYERS.REFRACTIVE` (`mesh.layers.set(2)`), set
  `scene.userData.hasRefractive = true`, and share `engine.post.shared.{tOpaque,uOpaqueTexel,uCamNear,uCamFar}`
  uniforms: `tOpaque.rgb` = scene colour behind, `.a` = linear view depth (m). Screen uv = `gl_FragCoord.xy * uOpaqueTexel`.
- Colour grade: each realm exposes `realm.grade` (see `defaultGrade()`): exposure / autoExposure, tonemap, bloom,
  contrast, saturation, temperature, vignette, grain. In the system realm the atmosphere module may steer it.
- Performance budget (real GPU): 60 fps at 1440p. Use instancing, merge geometry, pool objects, LOD, frustum
  culling, and scale densities by `engine.quality.detail`. Never allocate per frame in hot paths. Workers for heavy CPU.
- Precision: scene coordinates on a planet are ~10⁴–10⁵ m from the origin. Object matrices are fine (three does
  model-view in doubles) but **never derive fine detail from float32 world positions in shaders** — use local /
  object-space or camera-relative coordinates.
- No external network requests at runtime. No new dependencies without vendoring them under `vendor/`.

### Engine API (src/core/engine.js)

`engine.renderer`, `engine.post`, `engine.input`, `engine.events`, `engine.universe`, `engine.quality`,
`engine.realms`, `engine.realm`, `engine.audio`, `engine.ui`, `engine.intro`, `engine.params` (URL params),
`engine.harness`, `engine.time` / `dt` / `frame`, `engine.width/height/aspect`, `engine.paused`.

- `engine.travel(target, { instant, duration, style: 'warp'|'fade' })` → Promise. `target = { realm, … }`.
- `engine.tween(seconds, t => …, engine.ease.inOutCubic)` → Promise; `engine.wait(seconds)`. Loop-driven
  (deterministic in the harness) — use these instead of `setTimeout`.
- `engine.loading.begin(tag)` / `.end(tag)`: bracket **all** async work (worker jobs, bakes) so the harness and
  loading UI know when the world has settled.
- `engine.post.warp / fade / fadeColor / letterbox / flash`: global screen effects (0..1).
- Events (`engine.events.on(name, fn)`): `ready`, `frame(dt,time)`, `resize(w,h)`, `realm(name,target)`,
  `travel:start/end(target)`, `loading(count,tag)`, `system:anchor(bodyDesc, rotating)`, `world:enter/exit(world)`,
  `control:change(id, prevId)`, `interact:focus(item|null)`, `interact:use(item)`. Modules may add namespaced
  events (`audio:*`, `discover:*` …) — document them at the top of your index.js.

### Input (src/core/input.js)

`input.move {x,y}`, `input.look {x,y}` (pixels this frame: mouse-locked, drag, touch or stick),
`input.zoom` (wheel/pinch), `input.down(a) / pressed(a) / released(a)`, `input.taps [{x,y,nx,ny}]`,
`input.pointer`, `input.wantLock` (set true for mouse-look modes), `input.lastDevice` (`keyboard|touch|gamepad`).
Actions: `jump sprint crouch interact view map summon time photo pause light scan boost brake rollL rollR up down land confirm back primary secondary`.
Touch UI feeds: `setVirtualAxis('move',x,y)`, `setVirtualButton(a,on)`, `tapAction(a)`, `addLook(dx,dy)`, `addZoom(d)`, `addTap(x,y)`,
and sets `input.externalTouch = true`.

### Realm contract

```js
export default class MyRealm {
  constructor(engine) { this.name = 'cosmos'; this.scene; this.camera; this.passes = []; this.grade = defaultGrade(); }
  async init() {}                 // once at boot (keep it fast; defer heavy work to enter)
  async enter(target, fromRealm) {}  // set up for target; may await; bracket long work with engine.loading
  exit(nextTarget) {}
  update(dt, time) {}             // read engine.input; move camera; simulate
  resize(w, h) {}
  shots = new Map()               // optional named harness shots, run when ?shot=name
  cinematic = { active: false, begin() {}, end() {}, setCamera(position, target, fov) {} /* + realm extras */ }
}
```

`realm.cinematic` lets the intro direct a realm: while `active`, the realm ignores user camera input and uses the
pose given by `setCamera` (Vector3 position, Vector3 target, optional fov). Realm extras: cosmos
`setFormation(0..1)` (structure-formation timeline); galaxy `setSpin(t)`; system → use
`realm.control.switchTo('fly')`, `realm.fly.setPose(pos, target)`, `realm.setLocalTime(dir, tod)`, `realm.timeScale`.

Navigation between realms is by `engine.travel`:
cosmos → `{ realm:'galaxy', galaxyId }` → `{ realm:'system', system:{ galaxyId, starSeed, name? } | 'home' }`,
and back up with `{ realm:'galaxy', galaxyId, focusStar }`, `{ realm:'cosmos', focusGalaxy }`.
Home is `universe.home = { galaxyId:'home', starSeed:'home', bodyId:'solenne' }` (galaxy "Canticle", star "Auriel").

### System realm contract (src/realms/system/index.js)

Scene space = frame of the **anchor** body: origin at its centre; co-rotating with it inside its sphere of
influence (so the active planet's surface never moves), inertial outside. On a world, **"up" is
`position.clone().normalize()`**, and +Y is the planet's north pole. Units: metres, seconds.
Game scale: an Earth-like world is 60 km in radius (`body.radius`), gravity `body.gravity` (9.81 at home),
a day is `body.rotationPeriod` (1440 s at home).

A feature module is `export default function create(ctx) { return { name, init?, onSystemEnter?(sys),
onPlanetEnter?(world), onPlanetExit?(world), update?(dt, frame), onSystemExit?(), resize?(w,h) } }`.

`ctx`: `engine, realm, scene, camera, events, input, universe, quality, post, loading`,
`spaceRoot` / `worldRoot` (THREE.Group: far celestial objects / active-world content),
`lighting` (LightingRig), `world` (active World or null), `system` (SystemDesc), `features` (other modules, by key),
`colliders`, `interact`, `control`, `frame`, `addPass(p)` / `removePass(p)`, `addShot(name, fn)`, `time` (sim seconds),
`sky` (shared sky state, linear colours, refreshed every frame — hub defaults, then the atmosphere module overrides:
`sunColor, sunIntensity, sunVisibility, night (0 day…1 night), zenith, horizon, ambient, fogColor, fogDensity (1/m), wind (unit Vector3, scene space), windSpeed`),
`nav` (`nav.target` runtime body | null, `nav.setTarget(rt)` → event `nav:target`), `player` (set by the player module).

`frame` (same object every update): `dt, time (sim s), realTime, timeScale, camera, camPos, sunDir (unit, toward
the star), sunDistance, star (runtime body), bodies [runtime], anchor, rotating, world, altitude (camera above
terrain/sea, Infinity in space), inertialToScene (Quaternion: orient sky backdrops with it), controller, activeId`.
Runtime body: `{ desc (BodyDesc), id, scenePos, sceneQuat, posSys, quatSys, parent, distance }`.

`World` (world.js): `body, field (heightfield), radius, amplitude, hasOcean, seaRadius, hasAtmosphere,
atmosphereRadius, gravity, sites, theme`; `up(p,out)`, `surfaceRadius(p)`, `altitude(p)`, `clearance(p)` (above
terrain-or-sea), `heightAboveSea(p)`, `isUnderwater(p)`, `groundPoint(p,out,offset)`, `basis(p,east,north,up)`,
`normal(p,out,eps)`, `slope(p)`, `raycast(origin,dir,maxDist,{sea})`, `sitePosition(site,out,lift)`,
`surfacePosition(x,y,z,out,lift)`.

Heightfield (`src/planet/heightfield.js`): `field.height(x,y,z)` (unit dir → metres above `radius`),
`field.surface(x,y,z,out)` → `{h, slope, r,g,b, snow, veg, forest, alt, biome}`, `field.seaHeight`,
`field.sites [{id, kind:'city'|'town'|'outpost'|'monument'|'arrival', name, dir:[x,y,z], radius, height, seed}]`
(terrain is flattened to `site.height` within `site.radius`), `field.spawn`. Deterministic; worker-safe.

BodyDesc (universe): `id, name, kind, class, theme, seed, radius, gravity, rotationPeriod, tilt, orbit, surface,
palette, terrain, atmosphere|null, ocean|null, life, grade, civ|null ({level, style, cities, towns, outposts,
monuments}), rings|null, moons[], homage, mood, label, themeData, giant/giantData`.

Lighting (`ctx.lighting`): `sunDir`, `sunColor`, `sunIntensity`, `sunVisibility`, `setSun(dir,color,intensity)`,
`setAmbient(sky,ground,intensity)`, `setShadows(on, distance)`, `hemi`. The hub sets plain defaults every frame
*before* features update; the atmosphere module overrides them in its `update`.

Control (`ctx.control`): `register(controller)`, `switchTo(id, handoff)`, `active`, `activeId`, `get(id)`.
Controller: `{ id, position, quaternion, velocity (scene space), enter(handoff), exit() → extra handoff,
update(dt, frame) (reads input, writes frame.camera), hud?() }`. Ids: `foot` (player module), `bike`, `ship`
(vehicles module), `fly` (built-in). The player module exposes `ctx.player = { avatar (Object3D), setSeat(parent|null), … }`
so vehicles can seat the wanderer.
`ctx.interact.add({ position (Vector3 | fn), radius, label, verb, onUse, modes:['foot'] })` → handle with `remove()`.
`ctx.colliders.addBox / addCylinder / removeGroup / query / resolve` — upright static colliders (see control.js).

## Conventions

- ES modules, no build, 2-space indent, semicolons. JSDoc the public surface of your module at the top of its
  index.js (what it exports, events it emits, shots it registers). Split big modules into several files.
- Typography (loaded by index.html from `assets/fonts/`): `font-family: var(--rv-display)` — Cormorant Garamond,
  for titles / narration / place names;  `var(--rv-ui)` — Jost, for interface text. Small sizes, wide tracking, restraint.
- Narration script: `assets/voice/script.json` (ids + text); recorded lines + timings in `assets/voice/manifest.json`.
- Deterministic: seed everything from `body.seed` / `site.seed` / `hash32(...)`. No `Math.random()` for world content.
- Dispose what you create (`onPlanetExit`, `onSystemExit`): geometries, materials, textures, render targets, workers.
- Don't write planning/notes files into the repo. Don't commit: the lead commits.
