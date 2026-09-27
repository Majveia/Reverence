// Vehicles subsystem (order 55). OWNED BY THE VEHICLES TRACK.
//   Hoverbike (Ride) · Rover (Drive) · Starship (Board) — procedural AAA models, physics, cameras, FX.
//
// Spawns deterministically around the player spawn (and near civ landing/settlement POIs), handles
// enter/exit with the 'vehicle' action (F / gamepad Y / touch button) via world.setController, shows
// prompts, drives audio params ('engine', 'speed', 'boost', 'altitude') and minimal telemetry.
//
// URL: view=bike|rover|ship spawns directly in that vehicle. Extra (vehicles only):
//   cam=chase|cockpit|side|front|low|high|top|quarter|rear   camera preset for captures
//   alt=<m>  (view=ship) start airborne at this altitude above ground; above the atmosphere = orbit
//   speed=<m/s> initial forward speed (bike/rover/ship)      liv=<name> force a livery
// Hold 'vehicle' (F) on foot away from any vehicle → summon the last used vehicle (materializes).
import * as THREE from 'three';
import { Ground } from './ground.js';
import { ColliderGrid } from './colliders.js';
import { makeUberMaterial, makeGlowMaterial, makeDecalMaterial, makeGlassMaterial, EnvProbe, pickLivery, weathering, LIVERIES } from './materials.js';
import { Particles } from './fx/particles.js';
import { SpeedBlur } from './fx/speedblur.js';
import { Streaks } from './fx/streaks.js';
import { Hoverbike } from './Hoverbike.js';
import { clamp, damp, headingDir, orthoForward, fmtSpeed, FastRand } from './util.js';
import { latLonToDir } from '../../core/math.js';
import { G } from '../../core/Uniforms.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _n = new THREE.Vector3();
const _e = new THREE.Vector3(), _no = new THREE.Vector3();

const KINDS = { bike: Hoverbike };

class VehicleManager {
  constructor(world) {
    this.world = world;
    this.engine = world.engine;
    this.quality = world.quality || {};
    this.params = world.params || {};
    this.ground = new Ground(world);
    this.colliders = new ColliderGrid(world);
    this.vehicles = [];
    this.active = null;
    this.lastUsed = 'bike';
    this.cool = 0;
    this.holdT = 0;
    this.prompt = null;
    this.teleT = 0;
    this.baseFov = world.camera.fov;
    this._envTex = null;
    this._envState = 'none';
    this.rand = new FastRand(1337);
    this.errors = 0;

    // shared FX pools (few draw calls for every vehicle)
    const ps = clamp(this.quality.particleScale ?? 1, 0.25, 2);
    this.fx = {
      dust: new Particles(world, { max: Math.round(420 * ps), name: 'vehicle-dust' }),
      spray: new Particles(world, { max: Math.round(260 * ps), name: 'vehicle-spray' }),
      sparks: new Particles(world, { max: Math.round(120 * ps), additive: true, stretch: true, lit: false, name: 'vehicle-sparks', renderOrder: 9 }),
    };
    this.streaks = new Streaks(world, this.quality.mobile ? 80 : 160);
    try { this.probe = new EnvProbe(this.engine.renderer, world); } catch (e) { this.probe = null; }
    this.blur = this.quality.tier !== 'low' ? new SpeedBlur(this.engine.pipeline) : null;
  }

  // ------------------------------------------------------------------ materials & liveries
  livery(kind) {
    const force = this.params.liv;
    if (force && LIVERIES[force]) return { name: force, ...LIVERIES[force], artAccent: LIVERIES[force].accent };
    if (!this._liv) this._liv = {};
    if (!this._liv[kind]) this._liv[kind] = pickLivery(this.world.body, kind);
    return this._liv[kind];
  }
  makeMaterials(kind, opts = {}) {
    const liv = this.livery(kind);
    const wth = weathering(this.world.body);
    const pal = this.world.body.art?.palette || {};
    const hi = this.quality.tier === 'high' || this.quality.tier === 'ultra';
    const body = makeUberMaterial({
      clearcoat: hi, panelScale: opts.panelScale ?? 0.45, dirt: wth.dirt * (opts.dirtMul ?? 1), wear: wth.wear, rust: wth.rust * (opts.rustMul ?? 1),
      dirtColor: pal.sand || '#8a7a60', edgeColor: liv.edge, seed: opts.seed ?? 1.7, dirtLow: opts.dirtLow ?? 0, dirtHigh: opts.dirtHigh ?? 1.5,
    });
    const glow = makeGlowMaterial();
    const decal = makeDecalMaterial({ wear: 0.25 + wth.wear * 0.35, seed: (opts.seed ?? 1.7) * 3.1 });
    const glass = makeGlassMaterial(liv.glass);
    const mats = { body, glow, decal, glass };
    (this._mats ||= []).push(mats);
    if (this._envTex) for (const m of [body, glass, decal]) { m.envMap = this._envTex; m.needsUpdate = true; }
    return mats;
  }

  // ------------------------------------------------------------------ spawning
  /** Find a flat, dry spot near `center` (planet-local) at ~dist m in direction `dir` (tangent). */
  findSpot(center, dir, dist, { maxSlope = 0.18, footprint = 2, dry = true, tries = 48, avoid = [] } = {}) {
    const g = this.ground, R = this.world.body.radius;
    const up = _u.copy(center).normalize();
    const base = orthoForward(up, dir, new THREE.Vector3());
    const side = new THREE.Vector3().crossVectors(base, up).normalize();
    let best = null, bestScore = -1e9;
    const p = new THREE.Vector3();
    for (let i = 0; i < tries; i++) {
      const a = (i * 2.39996) % (Math.PI * 2);
      const rr = dist + Math.sqrt(i) * dist * 0.18;
      const off = i === 0 ? 0 : 1;
      p.copy(center).addScaledVector(base, dist * (1 - off) + off * (Math.cos(a) * rr * 0.35 + dist)).addScaledVector(side, off * Math.sin(a) * rr * 0.5);
      p.normalize();
      const h = g.terrainAt(p.clone().multiplyScalar(R));
      if (dry && g.hasOcean && h < g.sea + 0.6) continue;
      // flatness over the footprint
      let hmin = h, hmax = h;
      for (let k = 0; k < 4; k++) {
        const ang = k * Math.PI / 2 + 0.4;
        _w.copy(p).multiplyScalar(R).addScaledVector(base, Math.cos(ang) * footprint).addScaledVector(side, Math.sin(ang) * footprint);
        const hh = g.terrainAt(_w);
        hmin = Math.min(hmin, hh); hmax = Math.max(hmax, hh);
      }
      const slope = (hmax - hmin) / (footprint * 2);
      let score = -slope * 10 - i * 0.02;
      if (slope > maxSlope) score -= 5;
      for (const o of avoid) { const d = o.distanceTo(_w.copy(p).multiplyScalar(R + h)); if (d < footprint * 2 + 3) score -= 8; }
      if (score > bestScore) { bestScore = score; best = { dir: p.clone(), h, slope }; }
      if (slope < maxSlope * 0.35 && i > 2) break;
    }
    if (!best) {
      const d = _v.copy(center).addScaledVector(base, dist).normalize();
      best = { dir: d.clone(), h: g.terrainAt(d.clone().multiplyScalar(R)), slope: 1 };
    }
    return best;
  }

  spawnPoint() {
    const w = this.world, pl = w.player;
    if (pl?.pos && Number.isFinite(pl.pos.x) && pl.pos.lengthSq() > 1) {
      const up = _u.copy(pl.pos).normalize();
      const fwd = pl.forward ? orthoForward(up, pl.forward, new THREE.Vector3()) : headingDir(up, this.params.yaw ?? 30, new THREE.Vector3());
      return { pos: pl.pos.clone(), fwd };
    }
    const p = this.params;
    const dir = latLonToDir(p.lat !== undefined ? +p.lat : 12, p.lon !== undefined ? +p.lon : 28);
    const R = w.body.radius;
    const h = this.ground.terrainAt(dir.clone().multiplyScalar(R));
    const pos = dir.clone().multiplyScalar(R + Math.max(h, this.ground.hasOcean ? this.ground.sea : -1e9));
    return { pos, fwd: headingDir(dir, p.yaw ?? 30, new THREE.Vector3()) };
  }

  add(kind, opts = {}) {
    const C = KINDS[kind];
    if (!C) return null;
    try {
      const v = new C(this, { id: opts.id ?? kind, seed: this.vehicles.length * 1.37 });
      v.build();
      this.vehicles.push(v);
      return v;
    } catch (e) {
      console.error(`[vehicles] failed to build ${kind}`, e);
      return null;
    }
  }

  placeOnGround(v, dir, fwd, lift) {
    const R = this.world.body.radius;
    const h = this.ground.supportAt(_v.copy(dir).multiplyScalar(R));
    const pos = dir.clone().normalize().multiplyScalar(R + h + (lift ?? v.restHeight ?? 1));
    v.place(pos, fwd);
    v.settle?.();
  }

  spawnAll() {
    if (!this.ground.solid) return;
    const sp = this.spawnPoint();
    this.spawn = sp;
    const up = _u.copy(sp.pos).normalize();
    const fwd = sp.fwd;
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const view = this.params.view;
    const taken = [];
    const mk = (kind, angleDeg, dist, opts) => {
      if (!KINDS[kind]) return null;
      const v = this.add(kind);
      if (!v) return null;
      let spot;
      if (view === kind) spot = { dir: sp.pos.clone().normalize() };
      else {
        const a = angleDeg * Math.PI / 180;
        const dir = fwd.clone().multiplyScalar(Math.cos(a)).addScaledVector(right, Math.sin(a)).normalize();
        spot = this.findSpot(sp.pos, dir, dist, { ...opts, avoid: taken });
      }
      const heading = view === kind ? fwd.clone() : fwd.clone().applyAxisAngle(up, (opts?.turn ?? 0) * Math.PI / 180);
      this.placeOnGround(v, spot.dir, heading);
      taken.push(v.pos.clone());
      return v;
    };
    mk('bike', 38, 5.5, { footprint: 1.2, maxSlope: 0.35, dry: false, turn: -20 });
    mk('rover', -48, 9.5, { footprint: 2.2, maxSlope: 0.25, turn: 25 });
    mk('ship', -18, 34, { footprint: 7, maxSlope: 0.12, turn: 35 });
  }

  // ------------------------------------------------------------------ enter / exit
  enter(v) {
    if (!v || this.active === v) return;
    this.cool = 0.35;
    this.baseFov = this.world.camera.fov || this.baseFov;
    try {
      if (this.world.setController) this.world.setController(v);
      else { this.world.controller = v; v.onControlGained?.(); }
    } catch (e) { console.error('[vehicles] enter failed', e); }
  }
  onEnter(v) {
    this.active = v;
    this.lastUsed = v.type;
    this._clearPrompt();
    this.audio('play', 'vehicle.enter', { type: v.type });
    this.world.events?.emit?.('vehicle:enter', { type: v.type, vehicle: v });
    this.engine.ui?.hint?.(this._hintFor(v), 5500);
  }
  onExit(v) {
    if (this.active === v) this.active = null;
    this.audio('play', 'vehicle.exit', { type: v.type });
    this.audio('set', 'engine', 0); this.audio('set', 'boost', 0);
    this.world.events?.emit?.('vehicle:exit', { type: v.type, vehicle: v });
    this.engine.ui?.setTelemetry?.(null);
    const cam = this.world.camera;
    if (Math.abs(cam.fov - this.baseFov) > 0.01) { cam.fov = this.baseFov; cam.updateProjectionMatrix(); }
    if (this.blur) this.blur.strength = 0;
  }

  exit(v) {
    const pl = this.world.player;
    if (!pl) { this.engine.ui?.hint?.('No pilot to disembark', 2000); return; }
    if (v.canExit && !v.canExit()) { this.engine.ui?.hint?.(v.exitHint ?? 'Cannot exit here', 2200); return; }
    this.cool = 0.4;
    const p = v.exitPoint(new THREE.Vector3());
    // keep the player out of the water / colliders if possible
    const R = this.world.body.radius, g = this.ground;
    let h = g.terrainAt(p);
    if (g.hasOcean && h < g.sea) {
      v.exitPoint(p); p.addScaledVector(v.rightVec, 2 * (v.exitSide ?? 1.4));
      h = Math.max(g.terrainAt(p), g.sea);
    }
    p.normalize().multiplyScalar(R + Math.max(h, g.hasOcean ? g.sea : -1e9) + 0.05);
    try {
      if (typeof pl.teleport === 'function') pl.teleport(p);
      else { pl.pos?.copy(p); }
      pl.vel?.set?.(0, 0, 0);
      if (pl.forward?.isVector3) orthoForward(_u.copy(p).normalize(), v.fwdVec, pl.forward);
      if (pl.bodyFacing?.isVector3) pl.bodyFacing.copy(pl.forward);
    } catch (e) { console.error('[vehicles] player teleport failed', e); }
    try {
      if (this.world.setController) this.world.setController(pl);
      else { this.world.controller = pl; v.onControlLost?.(); }
    } catch (e) { console.error('[vehicles] exit failed', e); }
  }

  _hintFor(v) {
    const dev = this.engine.input?.lastDevice;
    if (dev === 'touch') return v.type === 'ship' ? 'Left stick throttle/roll · drag to steer · buttons: boost, up/down' : 'Left stick drive · drag to look · boost & jump buttons';
    if (dev === 'gamepad') return v.type === 'ship' ? 'LS throttle/roll · RS steer · RT boost · A up · B down · Y exit' : 'LS drive · RS look · RT boost · A jump · Y exit';
    if (v.type === 'ship') return 'Mouse steer · W/S throttle · A/D roll · Shift boost/pulse · Space up · C down · V view · F exit';
    if (v.type === 'rover') return 'W/S drive · A/D steer · Space handbrake · Shift boost · E lights · V view · F exit';
    return 'W/S throttle · A/D steer · Shift boost · Space hop · V view · F exit';
  }

  _clearPrompt() { if (this.prompt) { this.engine.ui?.clearPrompt?.('vehicle'); this.prompt = null; } }

  summon() {
    const pl = this.world.player;
    if (!pl?.pos) return;
    const kind = this.lastUsed && KINDS[this.lastUsed] ? this.lastUsed : 'bike';
    const v = this.vehicles.find((x) => x.type === kind);
    if (!v || v.occupied) return;
    const up = _u.copy(pl.pos).normalize();
    const f = pl.forward ? orthoForward(up, pl.forward, new THREE.Vector3()) : headingDir(up, 0, new THREE.Vector3());
    const dist = kind === 'ship' ? 26 : kind === 'rover' ? 6 : 4;
    const spot = this.findSpot(pl.pos, f, dist, { footprint: kind === 'ship' ? 7 : 2, maxSlope: kind === 'ship' ? 0.14 : 0.3, dry: kind !== 'bike' });
    this.placeOnGround(v, spot.dir, f.clone().applyAxisAngle(up, 0.6));
    v.materialize?.();
    this.audio('play', 'warp', { intensity: 0.4 });
    this.world.events?.emit?.('discovery', { kind: 'Summoned', name: v.displayName ?? v.type });
  }

  // ------------------------------------------------------------------ helpers
  audio(kind, name, v) {
    const a = this.engine.audio;
    if (!a) return;
    try { if (kind === 'set') a.setParam?.(name, v); else a.play?.(name, v || {}); } catch (_) { /* audio optional */ }
  }

  sparksAt(p, n, count) {
    const s = this.fx.sparks, r = this.rand;
    for (let i = 0; i < count; i++) {
      const vx = n.x * 4 + r.signed() * 6, vy = n.y * 4 + r.signed() * 6, vz = n.z * 4 + r.signed() * 6;
      s.spawn(p.x, p.y, p.z, vx, vy, vz, { life: 0.35 + r.next() * 0.4, size0: 0.05, size1: 0.02, alpha: 1, color: _e.set(6, 3.2, 1.2), drag: 2.5, grav: 9 });
    }
  }

  _updateEnv(dt) {
    const w = this.world;
    const sceneEnv = w.scene.environment;
    if (sceneEnv) {
      if (this._envState !== 'scene') {
        this._envState = 'scene';
        for (const ms of this._mats || []) for (const m of [ms.body, ms.glass, ms.decal]) { m.envMap = null; m.needsUpdate = true; }
      }
      return;
    }
    if (!this.probe) return;
    const made = this.probe.update(dt, this.active ? this.active.radialUp : (this.spawn ? _u.copy(this.spawn.pos).normalize() : null));
    if (made) {
      const tex = this.probe.texture;
      const first = this._envState !== 'probe';
      this._envState = 'probe';
      this._envTex = tex;
      for (const ms of this._mats || []) for (const m of [ms.body, ms.glass, ms.decal]) { m.envMap = tex; if (first) m.needsUpdate = true; }
    }
  }

  // ------------------------------------------------------------------ frame
  update(dt, t) {
    const w = this.world, input = w.input;
    this.cool = Math.max(0, this.cool - dt);
    this.colliders.sync(dt);
    this._updateEnv(dt);

    const cam = w.camera.position;
    const pl = w.player;
    const onFoot = pl && w.controller === pl;
    // enter / exit / summon
    if (this.active && w.controller !== this.active) {
      // someone else took control (e.g. player track teleport) — release gracefully
      const a = this.active; this.active = null; a.occupied = false;
    }
    if (this.active) {
      if (this.cool <= 0 && input.down('vehicle')) this.exit(this.active);
      else if (input.down('view') && this.active.camera) this.active.camera.toggle();
    } else if (onFoot) {
      let best = null, bd = 1e9;
      for (const v of this.vehicles) {
        const d = v.pos.distanceTo(pl.pos) - v.enterRadius;
        if (d < bd) { bd = d; best = v; }
      }
      if (best && bd < 0) {
        if (this.prompt !== best) { this.engine.ui?.prompt?.('vehicle', best.promptText, 'vehicle'); this.prompt = best; }
        if (this.cool <= 0 && input.down('vehicle')) this.enter(best);
        this.holdT = 0;
      } else {
        this._clearPrompt();
        if (input.held('vehicle')) { this.holdT += dt; if (this.holdT > 0.6 && this.cool <= 0) { this.summon(); this.holdT = -10; this.cool = 1; } }
        else this.holdT = 0;
      }
    } else this._clearPrompt();

    // simulate & animate
    for (const v of this.vehicles) {
      try {
        v.distToCam = v.pos.distanceTo(cam);
        const vis = v.occupied || v.distToCam < (v.cullDist ?? 1600);
        if (vis !== v.visible) { v.visible = vis; v.group.visible = vis; }
        if (v.occupied || v.awake) {
          const steps = v.substeps ?? 1;
          const h = dt / steps;
          for (let i = 0; i < steps; i++) v.simulate(h, input, i === steps - 1);
          v.syncTransform();
        }
        if (vis) v.animate(dt, t);
        this._weather(v, dt);
      } catch (e) {
        if (++this.errors < 5) console.error(`[vehicles] ${v.type} update failed`, e);
      }
    }
    // camera for the active vehicle (after physics)
    const a = this.active;
    if (a) {
      try { a.updateCamera(dt, input); } catch (e) { if (++this.errors < 5) console.error('[vehicles] camera failed', e); }
      this._activeFeedback(a, dt);
    }
    // vehicle vs vehicle nudges
    this._vehicleContacts();
    for (const k in this.fx) this.fx[k].update(dt);
  }

  _weather(v, dt) {
    const u = v.mats?.body?.userData?.u;
    if (!u) return;
    const rain = G.uWetness.value || 0;
    v.wet = Math.max(v.wet ?? 0, rain);
    if (v.onWater || v.inWater) v.wet = 1;
    v.wet = Math.max(rain, (v.wet ?? 0) - dt * 0.03);
    u.uWet.value = v.wet;
    if (v.occupied && v.speed > 3 && !v.onWater && v.type !== 'ship') u.uDirt.value = Math.min(1, u.uDirt.value + dt * v.speed * 0.00035);
    if (v.dustColor) u.uDirtColor.value.lerp(v.dustColor, dampF01(dt * 0.05));
  }

  _vehicleContacts() {
    const a = this.active;
    if (!a) return;
    for (const v of this.vehicles) {
      if (v === a || !v.visible) continue;
      const rr = (a.colliderRadius ?? 1) + (v.colliderRadius ?? 1);
      _v.copy(a.pos).sub(v.pos);
      const d = _v.length();
      if (d < rr && d > 1e-4) {
        _v.divideScalar(d);
        a.pos.addScaledVector(_v, rr - d);
        const vn = a.vel.dot(_v);
        if (vn < 0) { a.vel.addScaledVector(_v, -vn * 1.2); a.camera?.kick(Math.min(1, -vn * 0.05)); }
      }
    }
  }

  _activeFeedback(a, dt) {
    const sp = a.speed;
    this.audio('set', 'engine', a.engine ?? 0);
    this.audio('set', 'speed', sp);
    this.audio('set', 'boost', a.boost ?? 0);
    if (a.type === 'ship') this.audio('set', 'altitude', a.alt ?? 0);
    // speed blur toward the focus of expansion
    if (this.blur) {
      const k = a.blurAmount ? a.blurAmount() : clamp((sp - 28) / 45, 0, 1) * 0.55 + (a.boost ?? 0) * 0.35;
      this.blur.strength = damp(this.blur.strength, a.camera?.mode === 'cockpit' ? k * 0.5 : k, 4, dt);
      const cam = this.world.camera;
      _v.copy(a.vel);
      if (_v.lengthSq() > 1) {
        _v.normalize().multiplyScalar(1000).add(cam.position);
        _v.sub(this.world.origin); // → scene space
        _v.project(cam);
        if (_v.z < 1 && Math.abs(_v.x) < 1.5 && Math.abs(_v.y) < 1.5) this.blur.center.set(clamp(_v.x * 0.5 + 0.5, 0.1, 0.9), clamp(_v.y * 0.5 + 0.5, 0.1, 0.9));
      }
    }
    // streaks
    const sk = a.streakAmount ? a.streakAmount() : { power: clamp((sp - 35) / 40, 0, 1) * 0.5, mode: 'wind' };
    this.streaks.update(dt, a.vel, sk.power, sk.mode);
    // telemetry (5 Hz)
    this.teleT -= dt;
    if (this.teleT <= 0) {
      this.teleT = 0.2;
      const tele = a.telemetry ? a.telemetry() : { speed: fmtSpeed(sp) };
      this.engine.ui?.setTelemetry?.(tele);
    }
  }

  isReady() { return true; }

  getState() {
    const st = { active: this.active ? this.active.type : null, count: this.vehicles.length, env: this._envState };
    for (const v of this.vehicles) { try { st[v.id] = v.getState(); } catch (_) { /* ignore */ } }
    if (this.active?.camera) st.cam = { mode: this.active.camera.mode, fov: +this.active.camera.fov.toFixed(1) };
    return st;
  }

  dispose() {
    this._clearPrompt();
    for (const v of this.vehicles) { try { v.dispose(); } catch (_) { /* ignore */ } }
    for (const k in this.fx) this.fx[k].dispose();
    this.streaks?.dispose();
    this.blur?.dispose();
    this.probe?.dispose();
    for (const ms of this._mats || []) for (const k in ms) ms[k]?.dispose?.();
  }
}

function dampF01(x) { return 1 - Math.exp(-x); }

export default {
  name: 'vehicles',
  order: 55,
  async create(world) {
    const mgr = new VehicleManager(world);
    world.vehicles = mgr;
    try { mgr.spawnAll(); } catch (e) { console.error('[vehicles] spawn failed', e); }
    // URL view=bike|rover|ship → start inside that vehicle
    const view = world.params?.view;
    const v = mgr.vehicles.find((x) => x.type === view);
    if (v) {
      try {
        v.startFromParams?.(world.params);
        mgr.enter(v);
        v.camera?.update(0, { look: null, allowLook: false, speed: v.speed, radialUp: v.radialUp });
      } catch (e) { console.error('[vehicles] start in vehicle failed', e); }
    }
    return mgr;
  },
};
