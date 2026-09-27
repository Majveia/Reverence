// World — the planet-scale game world used by SystemMode.
//
// COORDINATES (read this!):
//   • Gameplay code works in PLANET-LOCAL coordinates: meters, planet center = (0,0,0),
//     +Y = north pole, frame rotates with the ground. JS numbers are float64, so this is
//     precise everywhere (orbit to blade of grass).
//   • Every object that lives on/around the planet is parented to `world.root` and uses
//     planet-local position directly. The CAMERA is also a child of `world.root`.
//   • Floating origin: world.root.position = -world.origin, where origin follows the camera
//     (re-based every 4 km). Shaders therefore see small world-space numbers near the camera.
//     root has NO rotation → directions are identical in local and scene space.
//   • Shared uniforms G.uPlanetCenter (scene space) = -origin.
//
// SUBSYSTEMS: every folder src/world/<name>/index.js exporting
//   export default { name, order, async create(world) { return instance } }
// is auto-loaded (sorted by order), fault-isolated (errors are logged, never fatal).
// Instance hooks (all optional):
//   update(dt, t)      every frame, in order        lateUpdate(dt, t)  after camera is final
//   isReady()          for deterministic capture     getState()         merged into __rv.state()
//   onOriginShift(d)   after re-basing               dispose()
//
// CONVENTIONAL ORDERS: planet 0 · space 5 · terrain 10 · water 15 · atmosphere 20 · flora 30 ·
//   civ 35 · fauna 40 · player 50 · vehicles 55 · (anything else 60+)
import * as THREE from 'three';
import { G } from '../core/Uniforms.js';
import { events } from '../core/events.js';
import { Celestial } from './Celestial.js';

const SUBSYSTEMS = import.meta.glob('./*/index.js');

export class World {
  constructor(engine, mode, params = {}) {
    this.engine = engine;
    this.mode = mode;
    this.params = params;
    this.events = events;
    this.universe = engine.universe;
    this.quality = engine.quality;
    this.input = engine.input;

    const g = parseInt(params.galaxy ?? 0, 10) || 0;
    const s = parseInt(params.star ?? 0, 10) || 0;
    this.galaxyIndex = g;
    this.starIndex = s;
    this.system = this.universe.system(g, s);
    this.star = this.system.star;
    this.body = (params.planet !== undefined && params.planet !== null && params.planet !== '')
      ? this.universe.body(this.system, params.planet)
      : this.universe.bestPlanet(this.system);

    this.scene = new THREE.Scene();
    this.scene.name = 'world';
    this.root = new THREE.Group();
    this.root.name = 'planet-root';
    this.scene.add(this.root);
    this.camera = mode.camera;
    this.camera.near = 0.05;
    this.camera.far = 2e10;
    this.camera.updateProjectionMatrix();
    this.root.add(this.camera);

    this.origin = new THREE.Vector3();
    this.rebaseDistance = 4000;
    this.celestial = new Celestial(this.system, this.body);
    this.time = parseFloat(params.time ?? 0) || 0;
    this.timeScale = 1;

    this.systems = new Map();
    this.order = [];
    this.surface = null;      // PlanetSurface (set by the planet subsystem): height/sample queries
    this.controller = null;   // active controller (player on foot / vehicle); see player track
    this.colliders = [];      // static colliders in planet-local coords (see ARCHITECTURE.md)
    this.pois = [];           // points of interest: { kind, name, pos: Vector3 (local), radius, data }
    this._errors = new Map();
  }

  async init() {
    const defs = [];
    for (const [path, load] of Object.entries(SUBSYSTEMS)) {
      const folder = path.split('/')[1];
      try {
        const mod = await load();
        if (!mod.default || typeof mod.default.create !== 'function') { console.warn(`[world] ${folder}/index.js has no default {create}`); continue; }
        defs.push({ folder, def: mod.default });
      } catch (e) { console.error(`[world] failed to load subsystem "${folder}"`, e); }
    }
    defs.sort((a, b) => (a.def.order ?? 100) - (b.def.order ?? 100));
    this.celestial.update(this.time);
    for (const { folder, def } of defs) {
      const name = def.name ?? folder;
      try {
        const inst = await def.create(this);
        if (inst) { inst.__name = name; this.systems.set(name, inst); this.order.push(inst); }
      } catch (e) { console.error(`[world] subsystem "${name}" create() failed`, e); }
    }
    events.emit('world:ready', { world: this });
  }

  get(name) { return this.systems.get(name); }

  _safe(inst, fn, ...args) {
    try { inst[fn]?.(...args); }
    catch (e) {
      const n = (this._errors.get(inst) || 0) + 1;
      this._errors.set(inst, n);
      if (n <= 3) console.error(`[world] ${inst.__name}.${fn} failed`, e);
      if (n === 30) console.error(`[world] ${inst.__name} disabled after repeated errors`);
    }
  }

  update(dt) {
    this.time += dt * this.timeScale;
    this.celestial.update(this.time);
    for (const s of this.order) if ((this._errors.get(s) || 0) < 30) this._safe(s, 'update', dt, this.time);
    this._updateOrigin();
    for (const s of this.order) if ((this._errors.get(s) || 0) < 30) this._safe(s, 'lateUpdate', dt, this.time);
    this._updateUniforms();
  }

  _updateOrigin() {
    const cam = this.camera.position; // planet-local
    if (cam.distanceTo(this.origin) > this.rebaseDistance) {
      const delta = cam.clone().sub(this.origin);
      this.origin.copy(cam);
      events.emit('origin:shift', { delta });
      for (const s of this.order) this._safe(s, 'onOriginShift', delta);
    }
    this.root.position.copy(this.origin).negate();
    this.root.updateMatrixWorld(true);
  }

  _updateUniforms() {
    G.uPlanetCenter.value.copy(this.origin).negate();
    G.uPlanetRadius.value = this.body.radius;
    G.uAtmosphereRadius.value = this.body.radius + (this.body.atmosphere?.height ?? 0);
    G.uCameraAltitude.value = this.camera.position.length() - this.body.radius;
  }

  isReady() {
    for (const s of this.order) {
      try { if (s.isReady && s.isReady() === false) return false; } catch (_) { /* broken → don't block */ }
    }
    return true;
  }

  render(pipeline) {
    this.scene.updateMatrixWorld();
    pipeline.render(this.scene, this.camera);
  }

  getState() {
    const st = {
      body: { id: this.body.id, name: this.body.name, type: this.body.type, radius: Math.round(this.body.radius) },
      time: +this.time.toFixed(2),
      localTime: +this.celestial.localTime(this.camera.position.clone().normalize()).toFixed(3),
      camera: { alt: Math.round(this.camera.position.length() - this.body.radius), pos: this.camera.position.toArray().map((v) => Math.round(v)) },
    };
    for (const [name, s] of this.systems) {
      try { const x = s.getState?.(); if (x) st[name] = x; } catch (_) {}
    }
    return st;
  }

  dispose() {
    for (const s of this.order) this._safe(s, 'dispose');
    this.scene.traverse((o) => { o.geometry?.dispose?.(); });
  }

  // ---------------------------------------------------------------- helpers
  /** local up vector at a local position */
  upAt(localPos, out = new THREE.Vector3()) { return out.copy(localPos).normalize(); }
  toScene(local, out = new THREE.Vector3()) { return out.copy(local).sub(this.origin); }
  toLocal(scenePos, out = new THREE.Vector3()) { return out.copy(scenePos).add(this.origin); }
  /** Ground point (local) under a direction, optionally offset along up. Requires world.surface. */
  groundAt(dir, offset = 0, out = new THREE.Vector3()) {
    const d = out.copy(dir).normalize();
    const h = this.surface ? this.surface.height(d.x, d.y, d.z) : 0;
    return d.multiplyScalar(this.body.radius + h + offset);
  }
  /** Register a static collider. shape: { type: 'sphere'|'capsule'|'box', pos (local), radius, height, halfExtents, quaternion } */
  addCollider(c) { this.colliders.push(c); return c; }
  removeCollider(c) { const i = this.colliders.indexOf(c); if (i >= 0) this.colliders.splice(i, 1); }
  addPOI(p) { this.pois.push(p); events.emit('poi:add', p); return p; }
  /** Hand camera/input control to a controller (player, vehicle). Calls onControlLost/Gained hooks. */
  setController(c) {
    const prev = this.controller;
    if (prev === c) return;
    try { prev?.onControlLost?.(c); } catch (e) { console.error('[world] onControlLost failed', e); }
    this.controller = c;
    try { c?.onControlGained?.(prev); } catch (e) { console.error('[world] onControlGained failed', e); }
    const scheme = c?.inputScheme ?? 'character';
    this.engine.input.setScheme(scheme);
    this.engine.ui?.setControls?.(scheme);
    events.emit('controller:change', { from: prev, to: c });
  }
}
