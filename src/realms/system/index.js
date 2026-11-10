// SYSTEM REALM — one star system, from interplanetary space down to a blade of grass.
//
// This file is the hub.  It owns time, orbits, reference frames, lighting, the active World and control modes,
// and it drives a set of feature modules (see FEATURES).  Read CLAUDE.md → "System realm contract" first.
//
// Frames.  Bodies live in the star-centred *system frame* (doubles).  The three.js scene is always expressed in
// the frame of the current ANCHOR body: origin at its centre; co-rotating with it when we are inside its sphere of
// influence (so a planet's surface is static in scene space), inertial otherwise.

import * as THREE from 'three';
import { defaultGrade } from '../../core/post/pipeline.js';
import { orbitPosition } from '../../core/universe/kepler.js';
import { damp } from '../../core/rng.js';
import { LightingRig } from './lighting.js';
import { World } from './world.js';
import { ControlManager, Interactables, Colliders } from './control.js';
import { FlyCam } from './flycam.js';

const FEATURES = [
  ['space', 'realms/system/space/index.js'],       // star, far planets/moons/giants/rings/belts/comets, sky backdrop
  ['terrain', 'planet/terrain/index.js'],          // LOD terrain of the active world
  ['atmosphere', 'planet/atmosphere/index.js'],    // sky, aerial perspective, clouds, weather; drives the light rig
  ['ocean', 'planet/ocean/index.js'],              // water / lava / ice seas
  ['flora', 'planet/flora/index.js'],              // grass, trees, rocks, glow-life
  ['civ', 'planet/civ/index.js'],                  // cities, towns, outposts, monuments, traffic, people
  ['fauna', 'planet/fauna/index.js'],              // creatures and ambient life
  ['player', 'player/index.js'],                   // the wanderer: avatar, on-foot controller, 1st/3rd person camera
  ['vehicles', 'vehicles/index.js'],               // hoverbike + starship
];

const SOI = (d) => d.radius * (d.kind === 'star' ? 8 : d.surface ? 40 : 14);
const TAU = Math.PI * 2;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _east = new THREE.Vector3(), _north = new THREE.Vector3(), _up = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0), _qs = new THREE.Quaternion();

export default class SystemRealm {
  constructor(engine) {
    this.name = 'system';
    this.engine = engine;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, engine.aspect || 1.6, 0.1, 4e12);
    this.camera.position.set(0, 0, 1e5);
    this.scene.add(this.camera);
    this.passes = [];
    this.grade = { ...defaultGrade(), autoExposure: { key: 0.17, min: 0.35, max: 5.5, speedUp: 2.2, speedDown: 0.9 } };
    this.features = {};
    this.simTime = 0;
    /** Sim seconds per real second.  Hold `time` to fast-forward the heavens. */
    this.timeScale = 1;
    this._timeBoost = 0;
    this.sys = null; this.bodies = []; this.byId = new Map();
    this.anchor = null; this.rotating = false;
    this.world = null;
    this.frame = {
      dt: 0, time: 0, realTime: 0, camera: this.camera, camPos: this.camera.position,
      sunDir: new THREE.Vector3(0, 1, 0), sunDistance: 1, star: null, anchor: null, rotating: false, world: null,
      altitude: Infinity, inertialToScene: new THREE.Quaternion(), bodies: this.bodies, controller: null, activeId: null,
    };
    this.shots = new Map();
  }

  async init() {
    const engine = this.engine;
    const ctx = (this.ctx = {
      engine, realm: this, scene: this.scene, camera: this.camera, events: engine.events, input: engine.input,
      universe: engine.universe, quality: engine.quality, post: engine.post, loading: engine.loading,
      /** Groups: put far celestial objects in spaceRoot, active-world content in worldRoot. */
      spaceRoot: new THREE.Group(), worldRoot: new THREE.Group(),
      lighting: null, world: null, system: null, features: this.features,
      colliders: new Colliders(), interact: null, control: null, frame: this.frame,
      /** Shared sky state (linear colours).  Hub writes plain defaults each frame; the atmosphere module overrides. */
      sky: { sunColor: new THREE.Color(1, 0.96, 0.9), sunIntensity: 3.4, sunVisibility: 1, night: 0, zenith: new THREE.Color(0.12, 0.26, 0.6), horizon: new THREE.Color(0.55, 0.68, 0.85), ambient: new THREE.Color(0.3, 0.4, 0.6), fogColor: new THREE.Color(0.6, 0.7, 0.85), fogDensity: 0, wind: new THREE.Vector3(1, 0, 0), windSpeed: 4 },
      /** Navigation target shared by the system map, the ship and the HUD. */
      nav: { target: null, setTarget: (rt) => { ctx.nav.target = rt; engine.events.emit('nav:target', rt ? rt.desc : null); } },
      /** Set by the player module: { avatar, position, velocity, up, setSeat(parent|null), state }. */
      player: null,
      /** Add / remove a realm PostPass (atmosphere, clouds, underwater, …). */
      addPass: (p) => { this.passes.push(p); this.passes.sort((a, b) => a.order - b.order); return p; },
      removePass: (p) => { const i = this.passes.indexOf(p); if (i >= 0) this.passes.splice(i, 1); },
      /** Register a named camera setup for the screenshot harness: fn() may be async. */
      addShot: (name, fn) => this.shots.set(name, fn),
      get time() { return ctx.realm.simTime; },
    });
    ctx.spaceRoot.name = 'spaceRoot'; ctx.worldRoot.name = 'worldRoot';
    this.scene.add(ctx.spaceRoot, ctx.worldRoot);
    ctx.lighting = this.lighting = new LightingRig({ scene: this.scene, camera: this.camera, renderer: engine.renderer, quality: engine.quality, shadows: engine.params.shadows !== '0' });
    ctx.interact = this.interact = new Interactables(ctx);
    ctx.control = this.control = new ControlManager(ctx);
    this.fly = this.control.register(new FlyCam(ctx));

    const only = engine.params.only ? engine.params.only.split(',') : null;     // ?only=terrain,atmosphere  (debug)
    const skip = engine.params.skip ? engine.params.skip.split(',') : [];
    await Promise.all(FEATURES.map(async ([key, path]) => {
      if ((only && !only.includes(key)) || skip.includes(key)) return;
      const mod = await engine.load(path, key);
      if (!mod?.default) return;
      try { const f = mod.default(ctx); this.features[key] = f; await f.init?.(); }
      catch (e) { console.error(`[system] feature "${key}" failed to init`, e); delete this.features[key]; }
    }));
    this._each = (fn, ...a) => { for (const [k] of FEATURES) { const f = this.features[k]; if (f && f[fn]) { try { f[fn](...a); } catch (e) { if (!f._err) { f._err = true; console.error(`[system] ${k}.${fn} threw`, e); } } } } };
  }

  // ───────────────────────── entering / leaving ─────────────────────────
  /**
   * @param target { realm:'system', system?: 'home'|{galaxyId,starSeed,name?}, body?: id, site?: id, mode?: 'foot'|'bike'|'ship'|'fly',
   *                 tod?: 0..1 local time of day, alt?: metres above ground, dist?/height?/az? camera offsets for mode 'fly', orbit?: radii }
   */
  async enter(target = {}) {
    const P = this.engine.params, num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
    const sys = (this.sys = this.ctx.system = this.engine.universe.system(target.system ?? 'home'));
    this.simTime = num(target.t ?? P.t, 400);
    this.bodies.length = 0; this.byId.clear();
    const mk = (desc) => ({ desc, id: desc.id, posSys: new THREE.Vector3(), quatSys: new THREE.Quaternion(), scenePos: new THREE.Vector3(), sceneQuat: new THREE.Quaternion(), tiltQuat: new THREE.Quaternion().setFromEuler(new THREE.Euler(desc.tilt || 0, (desc.seed % 628) / 100, 0, 'YXZ')), phase: ((desc.seed >>> 8) % 628) / 100, parent: null, distance: 0 });
    const star = mk(sys.star); this.bodies.push(star); this.byId.set('star', star);
    for (const d of sys.bodies) { const rt = mk(d); this.bodies.push(rt); this.byId.set(d.id, rt); }
    for (const rt of this.bodies) rt.parent = rt.desc.parent ? this.byId.get(rt.desc.parent) : null;
    this.frame.star = star;
    this._computeBodies();
    this._each('onSystemEnter', sys);

    // where do we start?
    const wantBody = target.body ?? P.body ?? (sys.home ? this.engine.universe.home.bodyId : (sys.landable[0]?.id ?? sys.bodies[0]?.id ?? 'star'));
    const rt = this.byId.get(wantBody) || this.bodies[1] || star;
    let mode = target.mode ?? P.mode ?? (rt.desc.surface && target.orbit === undefined && P.orbit === undefined ? 'foot' : 'ship');
    this._setAnchor(rt, true, false);
    const tod = num(target.tod ?? P.tod, rt.desc.surface ? 0.31 : NaN);

    const pos = new THREE.Vector3(), look = new THREE.Vector3(), quat = new THREE.Quaternion();
    const orbitR = num(target.orbit ?? P.orbit, NaN);
    if (this.world && Number.isNaN(orbitR)) {
      const w = this.world, siteId = target.site ?? P.site;
      const site = (siteId && w.sites.find((s) => s.id === siteId)) || w.field.spawn.site;
      const sdir = _v.set(site.dir[0], site.dir[1], site.dir[2]);
      if (!Number.isNaN(tod)) this.setLocalTime(sdir, tod);
      const ground = w.sitePosition(site, new THREE.Vector3(), 0);
      w.basis(ground, _east, _north, _up);
      const dist = num(target.dist ?? P.dist, NaN), az = (num(target.az ?? P.az, 0) * Math.PI) / 180, height = num(target.height ?? P.height, 1.7);
      if (!Number.isNaN(dist) || mode === 'fly') {
        // camera placed `dist` metres from the site at azimuth az, `height` above local ground, looking at the site
        const d = Number.isNaN(dist) ? 30 : dist;
        pos.copy(ground).addScaledVector(_east, Math.sin(az) * d).addScaledVector(_north, Math.cos(az) * d);
        // `height` is measured from the site's own elevation (never closer than 2 m to the local ground / sea)
        w.groundPoint(pos, pos, 0); const g = Math.max(pos.length(), w.seaRadius); pos.setLength(Math.max(ground.length() + height, g + 2));
        look.copy(ground).addScaledVector(_up, num(target.lookHeight ?? P.lookHeight, 2));
        mode = target.mode ?? P.mode ?? 'fly';
      } else {
        pos.copy(ground).addScaledVector(_up, 0.05);
        const toward = w.field.spawn.toward && site === w.field.spawn.site ? _v2.set(...w.field.spawn.toward).multiplyScalar(w.radius) : _v2.copy(ground).add(_north);
        look.copy(toward);
      }
      // orientation: look along the tangent toward `look`
      _v3.copy(look).sub(pos); const upHere = _v2.copy(pos).normalize();
      if (mode !== 'fly') _v3.addScaledVector(upHere, -_v3.dot(upHere));
      if (_v3.lengthSq() < 1e-6) _v3.copy(_north);
      quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), _v3.normalize(), upHere));
    } else {
      // arrive in space, sunlit side, body filling a third of the view
      const R = rt.desc.radius, k = Number.isNaN(orbitR) ? 3.2 : orbitR;
      if (this.world && !Number.isNaN(tod)) this.setLocalTime(_v.set(0, 0, 1), tod);
      const sun = _v.copy(star.scenePos).sub(rt.scenePos).normalize();
      const side = _v2.set(0, 1, 0).cross(sun).normalize();
      pos.copy(rt.scenePos).addScaledVector(sun, R * k * 0.72).addScaledVector(side, R * k * 0.62).addScaledVector(_v3.set(0, 1, 0), R * k * 0.28);
      look.copy(rt.scenePos);
      quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, look, new THREE.Vector3(0, 1, 0)));
      if (mode === 'foot' || mode === 'bike') mode = 'ship';
    }
    if (!this.control.has(mode)) mode = 'fly';
    this.control.switchTo(mode, { from: null, position: pos, quaternion: quat, velocity: new THREE.Vector3(), spawn: true });
    if (mode === 'fly') this.fly.setPose(pos, look);
    this.camera.position.copy(pos); this.camera.quaternion.copy(quat);
    this.update(0, this.engine.time);

    const shot = target.shot ?? P.shot;
    if (shot && this.shots.has(shot)) { try { await this.shots.get(shot)(); } catch (e) { console.error('[system] shot failed', shot, e); } }
    this.engine.input.wantLock = this.control.activeId !== 'fly';
  }

  exit() {
    if (this.world) this._deactivateWorld();
    this._each('onSystemExit');
    this.interact.clear();
    this.engine.input.wantLock = false; this.engine.input.exitLock();
    this.anchor = null; this.sys = null; this.ctx.system = null;
  }

  // ───────────────────────── frames ─────────────────────────
  _computeBodies() {
    const t = this.simTime, tmp = this._tmp || (this._tmp = [0, 0, 0]);
    for (const rt of this.bodies) {
      const d = rt.desc;
      if (d.kind === 'star') { rt.posSys.set(0, 0, 0); rt.quatSys.identity(); continue; }
      orbitPosition(d.orbit, t, tmp);
      rt.posSys.set(tmp[0], tmp[1], tmp[2]);
      if (rt.parent && rt.parent.desc.kind !== 'star') rt.posSys.applyQuaternion(rt.parent.tiltQuat).add(rt.parent.posSys);
      const spin = rt.phase + (TAU * t) / (d.rotationPeriod || 1440);
      rt.quatSys.copy(rt.tiltQuat).multiply(_qs.setFromAxisAngle(_Y, spin));
    }
  }

  _sceneTransforms() {
    const a = this.anchor; if (!a) return;
    const inv = this.rotating ? _q.copy(a.quatSys).invert() : _q.identity();
    this.frame.inertialToScene.copy(inv);
    for (const rt of this.bodies) {
      rt.scenePos.copy(rt.posSys).sub(a.posSys).applyQuaternion(inv);
      rt.sceneQuat.copy(inv).multiply(rt.quatSys);
    }
  }

  /** Scene position → system-frame position. */
  toSystem(p, out = new THREE.Vector3()) { out.copy(p); if (this.rotating) out.applyQuaternion(this.anchor.quatSys); return out.add(this.anchor.posSys); }

  _setAnchor(rt, rotating, rebase = true) {
    const old = this.anchor, oldRot = this.rotating;
    if (old === rt && oldRot === rotating) return;
    if (rebase && old) {
      const oldQ = oldRot ? _q.copy(old.quatSys) : _q.identity();
      const newInv = rotating ? _q2.copy(rt.quatSys).invert() : _q2.identity();
      const rel = new THREE.Quaternion().copy(newInv).multiply(oldQ);
      const off = new THREE.Vector3().copy(old.posSys).sub(rt.posSys);
      const fix = (p, q, v) => { if (p) p.applyQuaternion(oldQ).add(off).applyQuaternion(newInv); if (q) q.premultiply(rel); if (v) v.applyQuaternion(rel); };
      for (const c of this.control.controllers.values()) fix(c.position, c.quaternion, c.velocity), c.onRebase?.(rel, fix);
      fix(this.camera.position, this.camera.quaternion, null);
      this.engine.events.emit('system:rebase', fix, rt, rotating);
    }
    const worldBefore = this.world;
    this.anchor = rt; this.rotating = rotating;
    this.frame.anchor = rt; this.frame.rotating = rotating;
    const wantWorld = rotating && rt.desc.surface;
    if (worldBefore && (!wantWorld || worldBefore.body !== rt.desc)) this._deactivateWorld();
    this._sceneTransforms();
    if (wantWorld && !this.world) this._activateWorld(rt);
    this.engine.events.emit('system:anchor', rt.desc, rotating);
  }

  _activateWorld(rt) {
    const w = new World(rt.desc);
    w.rt = rt;
    this.world = this.ctx.world = this.frame.world = w;
    this._each('onPlanetEnter', w);
    this.engine.events.emit('world:enter', w);
  }

  _deactivateWorld() {
    const w = this.world; if (!w) return;
    this._each('onPlanetExit', w);
    this.ctx.colliders.clear(); this.interact.clear();
    this.world = this.ctx.world = this.frame.world = null;
    this.engine.events.emit('world:exit', w);
  }

  _chooseAnchor() {
    const c = this.control.active; if (!c || !this.anchor) return;
    const p = this.toSystem(c.position, _v);
    let inside = null, nearest = null, nearestM = Infinity;
    for (const rt of this.bodies) {
      const d = p.distanceTo(rt.posSys); rt.distance = d;
      const soi = SOI(rt.desc), hyst = rt === this.anchor ? (this.rotating ? 1.08 : 1.0) : 1.0;
      if (d < soi * hyst && (!inside || rt.desc.radius < inside.desc.radius)) inside = rt;
      const m = (d / soi) * (rt === this.anchor ? 0.9 : 1);
      if (m < nearestM) { nearestM = m; nearest = rt; }
    }
    if (inside) this._setAnchor(inside, inside.desc.kind !== 'star');
    else if (nearest) this._setAnchor(nearest, false);
  }

  /**
   * Spin the anchor so that at surface direction `dir` (unit, planet frame) the local solar time is `tod`
   * (0 = midnight, 0.25 ≈ sunrise, 0.5 = noon, 0.75 ≈ sunset).
   */
  setLocalTime(dir, tod) {
    const a = this.anchor; if (!a) return;
    const lonSite = Math.atan2(dir.z, dir.x);      // read before any temp is reused
    this._computeBodies();
    const sunSys = _v2.copy(this.frame.star.posSys).sub(a.posSys);
    const sunBody = sunSys.applyQuaternion(_q.copy(a.quatSys).invert());
    const lonSun = Math.atan2(sunBody.z, sunBody.x);
    // rotating the body by +Δ about +Y moves the sun's body-frame longitude by +Δ (atan2(z,x) convention)
    const want = lonSite + (tod - 0.5) * TAU;
    a.phase += want - lonSun;
    this._computeBodies(); this._sceneTransforms();
  }

  /** Local solar time (0..1) at a scene position on the active world. */
  localTime(pos) {
    const s = this.frame.star.scenePos; const lonSun = Math.atan2(s.z, s.x), lon = Math.atan2(pos.z, pos.x);
    let t = 0.5 + (lonSun - lon) / TAU; t -= Math.floor(t); return t;
  }

  // ───────────────────────── frame update ─────────────────────────
  update(dt, realTime) {
    if (!this.sys) return;
    const input = this.engine.input, frame = this.frame;
    // hold `time` to let the heavens wheel
    this._timeBoost = damp(this._timeBoost, input.down('time') ? 1 : 0, 3, dt);
    const scale = this.timeScale * (1 + this._timeBoost * this._timeBoost * 240);
    this.simTime += dt * scale;
    frame.dt = dt; frame.time = this.simTime; frame.realTime = realTime; frame.timeScale = scale;

    this._computeBodies();
    this._chooseAnchor();
    this._sceneTransforms();

    const star = frame.star;
    frame.sunDistance = star.scenePos.length();
    frame.sunDir.copy(star.scenePos).normalize();
    frame.controller = this.control.active; frame.activeId = this.control.activeId;

    this.control.update(dt, frame);
    this.camera.updateMatrixWorld(true);
    const w = this.world;
    frame.altitude = w ? w.clearance(this.camera.position) : Infinity;

    // default lighting; the atmosphere module (if present) overrides colours in its update()
    const L = this.lighting, sd = this.sys.star;
    const flux = THREE.MathUtils.clamp(Math.pow((sd.hz || 1.5e9) / Math.max(frame.sunDistance, 1), 0.7), 0.5, 6);
    L.setSun(frame.sunDir, _c.setRGB(sd.color[0], sd.color[1], sd.color[2]).lerp(_white, 0.55), 3.4 * flux);
    if (w) {
      _up.copy(this.camera.position).normalize();
      const elev = _up.dot(frame.sunDir), dip = Math.acos(Math.min(1, w.radius / Math.max(w.radius, this.camera.position.length())));
      L.sunVisibility = THREE.MathUtils.smoothstep(elev, -Math.sin(dip) - 0.05, -Math.sin(dip) + 0.06);
      L.setUp(_up);
      L.setAmbient(_c2.setRGB(0.35, 0.5, 0.8), _c3.setRGB(0.2, 0.17, 0.13), w.hasAtmosphere ? 0.35 + 0.5 * L.sunVisibility : 0.06);
      L.setShadows(frame.altitude < 6000, 1500);
    } else {
      L.sunVisibility = 1; L.setUp(_up.set(0, 1, 0)); L.setAmbient(_c2.setRGB(0.05, 0.06, 0.09), _c3.setRGB(0.02, 0.02, 0.02), 0.25); L.setShadows(false);
    }

    // default shared sky state
    const sky = this.ctx.sky;
    sky.sunVisibility = L.sunVisibility; sky.night = 1 - L.sunVisibility; sky.sunColor.copy(L.sunColor); sky.sunIntensity = L.sunIntensity;
    if (w && w.hasAtmosphere) { sky.fogColor.set(w.body.atmosphere.fog?.color || '#9fb4cc'); sky.fogDensity = (w.body.atmosphere.fog?.density || 0.02) / 1000; sky.ambient.copy(L.hemi.color).multiplyScalar(L.hemi.intensity); }
    else { sky.fogDensity = 0; sky.zenith.setRGB(0, 0, 0); sky.horizon.setRGB(0, 0, 0); sky.ambient.setRGB(0.02, 0.02, 0.03); }

    this._each('update', dt, frame);
    this.interact.update(this.control.active ? this.control.active.position : this.camera.position, this.control.activeId, input);
    L.update();
    this.camera.updateMatrixWorld(true);
  }

  resize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.lighting?.resize(); this._each?.('resize', w, h); }

  /** HUD summary for the UI. */
  describe() {
    const a = this.anchor, w = this.world, c = this.control.active;
    return {
      system: this.sys?.name, body: a?.desc.name, bodyId: a?.id, theme: w?.theme, label: a?.desc.label, homage: a?.desc.homage,
      altitude: this.frame.altitude, mode: this.control.activeId, speed: c ? c.velocity.length() : 0,
      localTime: w && c ? this.localTime(c.position) : null, landed: !!w, timeScale: this.frame.timeScale || 1,
    };
  }
}

const _c = new THREE.Color(), _c2 = new THREE.Color(), _c3 = new THREE.Color(), _white = new THREE.Color(1, 1, 1);
