// Player track — the explorer controller (flow-state movement on a spherical planet).
//
// States: ground (walk/run/sprint, crouch) · air (jump, coyote, buffer, jetpack double-jump + thrust)
//         · glide (paraglider: banking turns, dive, thermals / ridge lift, wind drift)
//         · slide (surf dunes / snow / scree: gravity along the slope, carving, crest launches)
//         · swim (float at sea level, crawl / tread) · climb (BotW-style on steep rock).
// Physics: capsule vs heightfield (cached HeightSampler over world.surface) + world.colliders
// (ColliderIndex spatial hash), step-up/step-down snapping, slope limit, spherical gravity.
// Presentation: procedural Explorer (Explorer.js) animated by Animator.js, verlet scarf (Cloth.js),
// paraglider (Glider.js), dust/spray/splash/jets/trails/footprints (FX.js), camera (Camera.js).
//
// Public (ARCHITECTURE.md): world.player.pos / .forward / .up / .vel / .view / .teleport(pos) /
// .state / .grounded / .physics {heights, colliders, air}; events player:jump, player:land;
// vehicle hand-off via world.setController (onControlLost / onControlGained).
import * as THREE from 'three';
import { latLonToDir } from '../../core/math.js';
import { buildExplorer, B } from './Explorer.js';
import { Animator } from './Animator.js';
import { Scarf } from './Cloth.js';
import { Glider } from './Glider.js';
import { FX } from './FX.js';
import { HeightSampler, ColliderIndex, AirField } from './Physics.js';
import { CameraRig } from './Camera.js';
import {
  clamp, saturate, smoothstep, lerp, dampF, damp, DEG, projectOnPlane, tangentBasis, orthoForward,
  quatFromUpForward, Spring, safe,
} from './util.js';

// ------------------------------------------------------------------------------------ tuning
const T = {
  walk: 2.1, run: 5.6, sprint: 9.6, crouch: 1.7,
  accel: 9.5, decel: 12, airAccel: 2.4, turn: 13, turnSprint: 7.5,
  jumpH: 1.35, coyote: 0.14, buffer: 0.16,
  dblV: 7.4, jet: 16, jetFuel: 2.6, jetRegen: 1.6, jetMaxUp: 8.5,
  radius: 0.33, height: 1.82, stepDown: 0.55,
  walkCos: 0.64,          // steeper than ~50°: can't walk up (slide / climb)
  slideAutoCos: 0.58,     // steeper than ~54°: can't stand
  float: 1.28,            // feet below the water surface while swimming (chest at the surface)
  swimDepth: 1.34, swim: 2.3, swimSprint: 4.1,
  glide: 9.8, glideDive: 19, sink: 1.3, sinkDive: 6.8,
  climb: 1.55, climbFast: 2.6,
};

// climbing body probes: [height along the body, depth of the body's front toward the wall] (toes · shin ·
// knee · hips · belly · chest · visor · hands-over-head)
const CLIMB_PROBES = [0.08, 0.2, 0.3, 0.12, 0.5, 0.16, 0.92, 0.14, 1.1, 0.15, 1.32, 0.17, 1.62, 0.2, 1.8, 0.1];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _e = new THREE.Vector3(), _n = new THREE.Vector3(), _t = new THREE.Vector3(), _w = new THREE.Vector3();
const _v = new THREE.Vector3(), _x = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _col = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

export class Player {
  constructor(world) {
    this.world = world;
    this.engine = world.engine;
    this.input = world.input;
    this.camera = world.camera;
    const p = world.params || {};
    this.params = p;
    this.R = world.body.radius;
    this.g = clamp(world.body.gravity || 9.81, 0.5, 40);
    this.surface = world.surface;
    this.quality = world.quality || this.engine?.quality || {};
    this.inputScheme = 'character';
    this.view = ['surface', 'fp', 'fly', 'orbit'].includes(p.view) ? p.view : 'surface';

    // ---- physics helpers (also offered to other tracks via world.player.physics)
    this.heights = new HeightSampler(world);
    this.colliders = new ColliderIndex(world);
    this.air = new AirField(world, this.heights);
    this.physics = { heights: this.heights, colliders: this.colliders, air: this.air };

    // ---- kinematic state
    let dir = latLonToDir(p.lat !== undefined ? +p.lat : 12, p.lon !== undefined ? +p.lon : 28);
    if (p.lat === undefined && this.surface) dir = this._findLand(dir);
    else if (this.surface && p.view !== 'fly' && p.view !== 'orbit' && !(+p.alt > 0.5) && p.flat !== '0') dir = this._flatSpot(dir, 45);
    this.up = dir.clone().normalize();
    this.pos = this.up.clone().multiplyScalar(this.R + this._terrainH(this.up));
    if (this.heights.solidSea && this.pos.length() < this.heights.seaR) this.pos.setLength(this.heights.seaR); // on the ice
    this.vel = new THREE.Vector3();
    this._settle = (this.view === 'surface' || this.view === 'fp') && !(+p.alt > 0.5) && p.flat !== '0' ? 2.5 : 0;
    const east = new THREE.Vector3(), north = new THREE.Vector3();
    tangentBasis(this.up, east, north);
    const yaw = (p.yaw !== undefined ? +p.yaw : 30) * DEG;
    this.forward = north.clone().multiplyScalar(Math.cos(yaw)).addScaledVector(east, Math.sin(yaw)).normalize();
    // no explicit heading: face the capital so the first frame shows the town (civ track request)
    if (p.yaw === undefined) {
      const tgt = world.civ?.spawnTarget || world.get?.('civ')?.spawnTarget;
      if (tgt?.isVector3 && tgt.distanceTo(this.pos) < 9000) {
        const f = projectOnPlane(tgt.clone().sub(this.pos), this.up);
        if (f.lengthSq() > 1) this.forward.copy(f.normalize());
      }
    }
    this.bodyFacing = this.forward; // alias (vehicles copy into it)
    this.state = 'ground';
    this.grounded = true;
    this.groundN = this.up.clone();
    this.groundVr = 0;
    this.coyote = 0; this.jumpBuf = 0; this.airTime = 0; this.fallStartR = 0;
    this.jetFuel = T.jetFuel; this.jetBurst = 0; this.usedDouble = false; this.jumpCut = false; this.boostP = 0;
    this.hardT = 0; this.landImpact = 0;
    this.glide = { dir: new THREE.Vector3(), s: 0, w: 0, bank: 0, turn: 0, dive: 0, pitch: 0, swayX: new Spring(0, 5, 0.3), swayZ: new Spring(0, 4.5, 0.3), t: 0 };
    this.slideS = { carve: 0, t: 0 };
    this.climbS = {
      anchor: new THREE.Vector3(), n: new THREE.Vector3(), up: new THREE.Vector3(), fwd: new THREE.Vector3(),
      t: 0, move: 0, dx: 0, dy: 0, lean: 0, push: 0, lunge: 0, speed: 0, wallZ: 0.24, side: 1,
    };
    this.climbBlend = 0;
    this.climbPush = 0;
    this.swimT = 0; this.dive = 0;
    this.time = 0;
    this.turnRate = 0; this._prevFacing = this.forward.clone();
    this.accel = new THREE.Vector3(); this._prevVel = new THREE.Vector3(); this.accelUp = 0;
    this.speed = 0;
    this.surfaceKind = 'ground'; this.groundColor = new THREE.Color(0.5, 0.45, 0.4); this._sampleT = 99;
    this.water = -Infinity;
    this._promptId = null;
    this._quietLand = true;
    this._poiT = 99; this.lookTarget = null;
    this._visible = true;
    this.S = {
      state: 'ground', crouch: false, speed: 0, accelLocal: new THREE.Vector3(), accelUp: 0, turnRate: 0,
      hardLand: 0, landImpact: 0, dive: 0, lookYaw: 0, lookPitch: 0, fp: false, vy: 0, airTime: 0, boost: 0, time: 0,
      glide: { pitch: 0, bank: 0, swayZ: 0, swayX: 0 }, slide: { carve: 0 }, climb: { move: 0, dirX: 0, dirY: 0, lean: 0, speed: 0, wallZ: 0.24, lunge: 0 },
    };

    // ---- camera
    this.cam = new CameraRig(world, this);
    this.cam.fwd.copy(this.forward);
    if (p.camyaw !== undefined) this.cam.fwd.applyAxisAngle(this.up, -(+p.camyaw) * DEG);
    this.cam.pitch = clamp((p.pitch !== undefined ? +p.pitch : -10) * DEG, -1.4, 1.4);
    if (p.zoom !== undefined) this.cam.zoom = clamp(+p.zoom, 0.3, 4);
    this.cam.fovBase = p.fov !== undefined ? clamp(+p.fov, 30, 100) : 58;
    this.cam.fpFov = p.fov !== undefined ? clamp(+p.fov, 10, 100) : 72; // fov= also drives first person (telephoto sky shots)
    this.cam.fov.reset(this.view === 'fp' ? this.cam.fpFov : this.cam.fovBase);
    if (p.dist !== undefined) this.cam.orbit.dist = +p.dist;
    if (p.tod !== undefined) safe(() => world.celestial.setLocalTime(this.up, +p.tod));
    // facesun=<deg>: turn the explorer toward the sun (+deg to the left) — front-lit hero portraits
    if (p.facesun !== undefined) safe(() => {
      const sd = projectOnPlane(world.celestial.sunDir.clone(), this.up);
      if (sd.lengthSq() < 1e-6) return;
      this.forward.copy(sd.normalize()).applyAxisAngle(this.up, (+p.facesun || 0) * DEG);
      this.cam.fwd.copy(this.forward);
      if (p.camyaw !== undefined) this.cam.fwd.applyAxisAngle(this.up, -(+p.camyaw) * DEG);
    });

    // ---- presentation
    this._buildBody();

    // ---- spawn state
    this.heights.follow(this.pos);
    const sea = this.heights.water(this.pos);
    if (this.view === 'fly') {
      this.pos.addScaledVector(this.up, p.alt !== undefined ? +p.alt : 120);
      this.state = 'fly';
    } else if (p.alt !== undefined && +p.alt > 0.5 && this.view !== 'orbit') {
      this.pos.addScaledVector(this.up, +p.alt);
      this.state = 'air'; this.grounded = false; this.airTime = 1;
      if (+p.alt > 6 || p.act === 'glide') this._openGlider(true);
    } else if (sea > -1e8 && this._terrainH(this.up) < sea - T.swimDepth) {
      this.pos.setLength(this.R + sea - T.float);
      this.state = 'swim'; this.grounded = false;
    }
    if (p.act === 'slide' && this.state === 'ground') this._startSlide(true);

    world.player = this;
    world.controller = this;
    this.engine?.input?.setScheme?.('character');
    this._syncBody(0);
    this._camera(1 / 60);
  }

  // ======================================================================================= setup
  _buildBody() {
    const w = this.world;
    this.group = null; this.rig = null; this.animator = null;
    try {
      this.rig = buildExplorer(this.engine.renderer, w.body, this.quality);
      this.group = this.rig.group;
      this.animator = new Animator(this.rig, this.heights);
      w.root.add(this.group);
    } catch (e) {
      console.error('[player] explorer build failed — capsule fallback', e);
      const g = new THREE.CapsuleGeometry(0.33, 1.1, 6, 12); g.translate(0, 0.9, 0);
      this.group = new THREE.Group();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.55 }));
      m.castShadow = true; this.group.add(m); this._fallbackMesh = m;
      w.root.add(this.group);
    }
    const P = this.rig?.palette;
    try { if (P) { this.scarf = new Scarf(w, P, this.quality); w.root.add(this.scarf.group); } } catch (e) { console.error('[player] scarf failed', e); this.scarf = null; }
    try { if (P) { this.glider = new Glider(P, this.quality); this.group.add(this.glider.group); this.glider.group.position.set(0, 1.83, 0.1); } } catch (e) { console.error('[player] glider failed', e); this.glider = null; }
    try {
      this.fx = new FX(w, this.quality);
      w.root.add(this.fx.group);
      if (this.rig) {
        const pack = this.rig.bones[B.pack];
        this.fx.jets.forEach((j, i) => { pack.add(j); j.position.set(i ? -0.085 : 0.085, -0.28, -0.09); j.rotation.x = -0.18; j.scale.set(1.7, 1.9, 1.7); });
      }
    } catch (e) { console.error('[player] fx failed', e); this.fx = null; }
    this.anchorsW = [[new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]];
    this.spheres = [];
    for (let i = 0; i < 7; i++) this.spheres.push({ c: new THREE.Vector3(), r: 0.1 });
    this.windV = new THREE.Vector3();
    this.gquat = new THREE.Quaternion();
    this.gpos = new THREE.Vector3();
    this.eye = new THREE.Vector3();
  }

  _terrainH(dir) {
    const S = this.surface;
    if (!S) return 0;
    const l = dir.length() || 1;
    const h = S.height(dir.x / l, dir.y / l, dir.z / l);
    return Number.isFinite(h) ? h : 0;
  }

  _findLand(dir) {
    const S = this.surface;
    if (!S || !(S.seaLevel > -1e8)) return dir;
    let best = dir.clone(), bestScore = -Infinity;
    const e = new THREE.Vector3(), n = new THREE.Vector3(), d = new THREE.Vector3();
    tangentBasis(dir, e, n);
    for (let i = 0; i < 400; i++) {
      const t = i * 2.39996, r = Math.sqrt(i) * 0.02;
      d.copy(dir).addScaledVector(e, Math.cos(t) * r).addScaledVector(n, Math.sin(t) * r).normalize();
      const h = S.height(d.x, d.y, d.z);
      let score = h > 20 && h < S.amp * 0.35 ? 1 - r : -1;
      if (score > 0) { const nn = S.normal(d, n.clone(), 1.2); score -= nn.dot(d) > 0.9 ? 0 : 0.6; }
      if (score > bestScore) { bestScore = score; best.copy(d); if (score > 0.9) break; }
    }
    return best;
  }

  /** Nearest walkable, dry-ish spot within `meters` of dir (keeps URL framing, avoids cliff spawns). */
  _flatSpot(dir, meters) {
    const S = this.surface;
    const nrm = new THREE.Vector3(), e = new THREE.Vector3(), n = new THREE.Vector3(), d = new THREE.Vector3();
    const ok = (v) => { const nn = S.normal(v, nrm, 1.0); return nn.dot(v) > 0.9; };
    if (ok(dir) || (S.seaLevel > -1e8 && S.height(dir.x, dir.y, dir.z) < S.seaLevel)) return dir; // swimming spawns stay
    tangentBasis(dir, e, n);
    const k = 1 / this.R;
    for (let i = 1; i < 160; i++) {
      const t = i * 2.39996, r = Math.sqrt(i / 160) * meters * k;
      d.copy(dir).addScaledVector(e, Math.cos(t) * r).addScaledVector(n, Math.sin(t) * r).normalize();
      if (ok(d)) return d.clone();
    }
    return dir;
  }

  // ======================================================================================= API
  teleport(p) {
    this.pos.copy(p);
    this.vel.set(0, 0, 0);
    this.up.copy(p).normalize();
    this.heights.follow(this.pos);
    this.state = 'air'; this.grounded = false; this.airTime = 0; this._quietLand = true;
    this._openGlider(false, true);
    this.cam.pivotInit = false; this.cam.fpInit = false;
    if (this.scarf) this.scarf.initialized = false;
    this.fx?.rebase(this.pos);
  }

  /** Face a planet-local target (body + camera), e.g. a creature or monument at spawn. */
  lookAt(target) {
    if (!target?.isVector3) return;
    const f = projectOnPlane(_a.copy(target).sub(this.pos), this.up);
    if (f.lengthSq() < 1e-6) return;
    f.normalize();
    this.forward.copy(f); this._prevFacing.copy(f);
    this.cam.fwd.copy(f);
    // pitch the view toward the target (keeps it framed when it is above / below the horizon)
    const d = _b.copy(target).sub(this.pos).addScaledVector(this.up, -1.5);
    const el = Math.asin(clamp(d.normalize().dot(this.up), -1, 1));
    this.cam.pitch = clamp(el * 0.8 - 0.08, -0.8, 0.6);
    this.cam.pivotInit = false; this.cam.fpInit = false;
    if (this.scarf) this.scarf.initialized = false;
  }

  /** Early frames: step off spawn points that ended up inside / hugging a tree or rock (flora request). */
  _spawnSettle(dt) {
    this._settle -= dt;
    if (this.speed > 0.2 || this.state !== 'ground' || !this.colliders.count) return;
    const near = (p) => {
      const list = this.colliders.query(p, 6);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.enabled === false || c.vehicle) continue;
        const minD = c.tag === 'tree' ? 4 : c.tag === 'rock' ? (c.radius || 1) + 1.2 : 0;
        if (!minD) continue;
        _x.copy(p).sub(c.pos); projectOnPlane(_x, this.up);
        if (_x.length() < minD) return true;
      }
      return false;
    };
    if (!near(this.pos)) { this._settle = Math.min(this._settle, 0.6); return; }
    tangentBasis(this.up, _c, _d);
    const k = 1 / this.R;
    for (let i = 1; i < 90; i++) {
      const t = i * 2.39996, r = 1.5 + Math.sqrt(i) * 1.6;
      _e.copy(this.up).addScaledVector(_c, Math.cos(t) * r * k).addScaledVector(_d, Math.sin(t) * r * k).normalize();
      _e.multiplyScalar(this.heights.groundR(_e));
      if (near(_e)) continue;
      this.heights.normal(_e, _n, 0.8);
      if (_n.dot(_v.copy(_e).normalize()) < 0.88) continue;
      if (this.heights.water(_e) > -1e8 && _e.length() < this.R + this.heights.water(_e)) continue;
      this.pos.copy(_e); this.up.copy(_e).normalize();
      orthoForward(this.up, this.forward, this.forward);
      this.cam.pivotInit = false;
      if (this.scarf) this.scarf.initialized = false;
      this._settle = 0;
      return;
    }
    this._settle = 0;
  }

  onControlLost() {
    this._setVisible(false);
    this._openGlider(false, true);
    this._clearPrompt();
    this.engine?.audio?.setParam?.('glide', 0);
  }

  onControlGained() {
    this.cam.fwd.copy(this.forward);
    this.cam.pivotInit = false; this.cam.fpInit = false;
    this.cam.pitch = -0.14;
    if (this.view === 'fly' || this.view === 'orbit') this.view = 'surface';
    if (this.state === 'fly') this.state = 'air';
    if (this.scarf) this.scarf.initialized = false;
    this._setVisible(true);
  }

  _setVisible(v) {
    this._visible = v;
    if (this.group) this.group.visible = v;
    if (this.scarf) this.scarf.group.visible = v;
    if (!v && this.fx) for (const j of this.fx.jets) j.visible = false;
  }

  // ======================================================================================= frame
  update(dt) {
    const w = this.world;
    if (w.controller !== this) { if (this._visible) this._setVisible(false); return; }
    dt = Math.min(Math.max(dt, 0), 1 / 20);
    if (this.view === 'orbit') { this._setVisible(false); this.cam.orbitView(dt, this.input, this.R); return; }
    if (dt <= 0) return;
    this.time += dt;
    const input = this.input;
    this.colliders.sync(dt);
    if (this._settle > 0) safe(() => this._spawnSettle(dt));

    if (input.down('view')) {
      if (this.view === 'surface') this.view = 'fp';
      else if (this.view === 'fp') this.view = 'surface';
    }
    if (this.view === 'orbit') {
      this._setVisible(false);
      this.cam.orbitView(dt, input, this.R);
      return;
    }
    if (this.view === 'fly' || this.state === 'fly') { this._fly(dt, input); return; }
    if (!this._visible) this._setVisible(true);

    this.up.copy(this.pos).normalize();
    this.heights.follow(this.pos);
    this.cam.transport(this.up);
    orthoForward(this.up, this.forward, this.forward);
    const look = input.axis('look');
    this.cam.look(this.up, look.x, look.y, this.view === 'fp');
    if (input.zoom && this.view === 'surface') this.cam.zoom = clamp(this.cam.zoom * Math.exp(-input.zoom * 0.8), 0.45, 2.6);

    // ---- intent
    const mv = input.axis('move');
    const mag = Math.min(1, Math.hypot(mv.x, mv.y));
    this.cam.frame(this.up);
    const wish = _w.copy(this.cam.fwd).multiplyScalar(mv.y).addScaledVector(this.cam.camRight, mv.x);
    if (wish.lengthSq() > 1e-6) wish.normalize();
    const I = {
      mv, mag, wish,
      jumpDown: input.down('jump'), jumpHeld: input.held('jump'),
      sprint: input.held('sprint'), descend: input.held('descend'), descendDown: input.down('descend'),
    };
    if (I.jumpDown) this.jumpBuf = T.buffer; else this.jumpBuf = Math.max(0, this.jumpBuf - dt);
    this.coyote = Math.max(0, this.coyote - dt);
    this.hardT = Math.max(0, this.hardT - dt);
    this.jetBurst = Math.max(0, this.jetBurst - dt);
    this._sampleGround(dt);
    this.water = this.heights.water(this.pos);

    // ---- state machine
    this._prevVel.copy(this.vel);
    const r0 = this.pos.length();
    switch (this.state) {
      case 'ground': this._ground(dt, I); break;
      case 'air': this._air(dt, I); break;
      case 'glide': this._glide(dt, I); break;
      case 'slide': this._slide(dt, I); break;
      case 'swim': this._swim(dt, I); break;
      case 'climb': this._climb(dt, I); break;
      default: this.state = 'air'; this._air(dt, I);
    }
    if (!Number.isFinite(this.pos.x + this.pos.y + this.pos.z) || this.pos.lengthSq() < 1) {
      // never let NaNs escape into the frame loop — re-ground where we were
      this.pos.copy(this.up).multiplyScalar(this.R + this._terrainH(this.up) + 0.2);
      this.vel.set(0, 0, 0); this.state = 'air';
    }
    if (!Number.isFinite(this.vel.x + this.vel.y + this.vel.z)) this.vel.set(0, 0, 0);
    this.up.copy(this.pos).normalize();
    if (this.grounded) this.groundVr = (this.pos.length() - r0) / dt;
    this.grounded = this.state === 'ground' || this.state === 'slide';
    if (this.state === 'ground' || this.state === 'slide' || this.state === 'swim') this.jetFuel = Math.min(T.jetFuel, this.jetFuel + T.jetRegen * dt);

    // ---- derived motion
    projectOnPlane(_a.copy(this.vel), this.up);
    this.speed = _a.length();
    _b.copy(this.vel).sub(this._prevVel).divideScalar(dt);
    this.accel.lerp(_b, dampF(10, dt));
    this.accelUp = this.accel.dot(this.up);
    const ang = Math.atan2(_c.crossVectors(this._prevFacing, this.forward).dot(this.up), clamp(this._prevFacing.dot(this.forward), -1, 1));
    this.turnRate = damp(this.turnRate, ang / dt, 10, dt);
    this._prevFacing.copy(this.forward);

    this._syncBody(dt);
    this._camera(dt);
    this._feedback(dt, I);
  }

  // ======================================================================================= helpers
  _sampleGround(dt) {
    this._sampleT += dt;
    if (this._sampleT < 0.25) return;
    this._sampleT = 0;
    const s = this.heights.sample(this.pos);
    if (!s) return;
    const Bm = this.surface?.BIOMES || {};
    const b = s.biome;
    this.surfaceKind = (s.snow > 0.4 || b === Bm.SNOW) ? 'snow'
      : (b === Bm.DESERT || b === Bm.BEACH || (s.sand ?? 0) > 0.45 || (s.dune ?? 0) > 0.3) ? 'sand'
        : (b === Bm.ROCK || b === Bm.VOLCANIC || b === Bm.CRYSTAL || (s.rock ?? 0) > 0.6) ? 'rock' : 'ground';
    try { this.surface.biomeColor(b, _col); this.groundColor.copy(_col); } catch (_) { /* keep */ }
  }

  /** Radius of the floor under p: terrain or the top of a box collider we can stand on. */
  _floorR(p, up) {
    let fr = this.heights.groundR(p);
    if (this.colliders.cells.size || this.colliders.big.length) {
      const list = this.colliders.query(p, 2);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.type !== 'box' || !c.halfExtents || c.enabled === false) continue;
        const h = c.halfExtents;
        _x.copy(p).sub(c.pos);
        if (c.quaternion) _x.applyQuaternion(_q.copy(c.quaternion).invert());
        if (Math.abs(_x.x) > h.x + 0.15 || Math.abs(_x.z) > h.z + 0.15) continue;
        const top = h.y - _x.y; // how far above p the top face is (box Y ≈ local up)
        if (top > -0.9 && top < 0.5) fr = Math.max(fr, p.length() + top);
      }
    }
    return fr;
  }

  _groundNormal(p, out) { return this.heights.normal(p, out, 0.6); }

  _resolveColliders() {
    if (!this.colliders.cells.size && !this.colliders.big.length) return false;
    _e.copy(this.pos);
    const n = this.colliders.resolveCapsule(this.pos, this.up, T.radius, T.height, 2);
    if (!n) return false;
    // remove velocity into contacts
    for (let i = 0; i < n; i++) {
      const cn = this.colliders.contacts[i].normal;
      const vn = this.vel.dot(cn);
      if (vn < 0) this.vel.addScaledVector(cn, -vn);
    }
    return true;
  }

  _jump(scale = 1) {
    const h = T.jumpH * scale * Math.sqrt(9.81 / this.g); // jump a little higher on low-g worlds
    const v0 = Math.sqrt(2 * this.g * h);
    const vt = projectOnPlane(_a.copy(this.vel), this.up);
    this.vel.copy(vt).addScaledVector(this.up, Math.max(v0, this.groundVr + v0 * 0.6));
    this.pos.addScaledVector(this.up, 0.02);
    this.state = 'air'; this.grounded = false; this.airTime = 0; this.coyote = 0; this.jumpBuf = 0;
    this.usedDouble = false; this.jumpCut = false; this.fallStartR = this.pos.length();
    this.world.events?.emit?.('player:jump', { pos: this.pos, speed: this.speed });
    this.engine?.audio?.play?.('jump', { surface: this.surfaceKind });
    if (this.fx) this.fx.dust(this.pos, this.up, this._dustColor(), 5, 1.1, 0.22, 0.35);
  }

  _dustColor() {
    _col.copy(this.groundColor).lerp(WHITE, this.surfaceKind === 'snow' ? 0.7 : 0.35);
    return _col;
  }

  _land(impact) {
    const quiet = this._quietLand;
    this._quietLand = false;
    this.state = 'ground'; this.grounded = true; this.airTime = 0;
    this.usedDouble = false;
    const vr = this.vel.dot(this.up);
    if (vr < 0) this.vel.addScaledVector(this.up, -vr);
    if (quiet) return;
    this.landImpact = impact;
    if (impact > 14) { this.hardT = 0.62; this.cam.addTrauma(clamp((impact - 10) / 22, 0.25, 0.8)); this.vel.multiplyScalar(0.25); }
    else if (impact > 7) this.cam.addTrauma(clamp((impact - 7) / 30, 0, 0.25));
    this.world.events?.emit?.('player:land', { pos: this.pos, speed: impact, hard: impact > 14 });
    this.engine?.audio?.play?.('land', { intensity: clamp(impact / 20, 0.1, 1), surface: this.surfaceKind });
    if (this.fx && impact > 3) this.fx.dust(this.pos, this.up, this._dustColor(), Math.round(clamp(impact * 0.9, 4, 22)), 0.8 + impact * 0.08, 0.3, 0.5);
    this.coyote = 0;
  }

  _openGlider(open, instant = false) {
    if (open) {
      if (this.state !== 'glide') {
        const g = this.glide;
        const vt = projectOnPlane(_a.copy(this.vel), this.up);
        const s = vt.length();
        g.dir.copy(s > 0.5 ? vt.divideScalar(s) : this.forward);
        orthoForward(this.up, g.dir, g.dir);
        g.s = Math.max(s, T.glide * 0.8);
        g.w = this.vel.dot(this.up);
        g.bank = 0; g.turn = 0; g.dive = 0; g.t = 0;
        g.swayX.v -= 1.5; // canopy snap tugs the body
        this.state = 'glide';
        this.engine?.audio?.play?.('glider', { open: true });
      }
    } else if (this.state === 'glide') {
      this.state = 'air';
      this.engine?.audio?.play?.('glider', { open: false });
    }
    if (instant && this.glider && !open) { this.glider.deploy = 0; this.glider.group.visible = false; }
  }

  _startSlide(force = false) {
    this.state = 'slide';
    this.slideS.t = 0;
    if (force) {
      // give it a push downhill so act=slide captures are immediately in motion
      this._groundNormal(this.pos, _n);
      const dh = projectOnPlane(_a.copy(_n), this.up);
      if (dh.lengthSq() > 1e-6) { dh.normalize(); this.vel.copy(dh).multiplyScalar(9); this.forward.copy(dh); this.cam.fwd.copy(dh); }
      else this.vel.copy(this.forward).multiplyScalar(8);
    }
  }

  /** Probe for a climbable wall in tangent direction `dir`; writes the wall normal to out. */
  _wallAhead(dir, out) {
    _t.copy(this.pos).addScaledVector(dir, 0.55).addScaledVector(this.up, 0.3);
    this._groundNormal(_t, out);
    if (out.dot(this.up) > T.walkCos) return false;
    const into = -dir.dot(projectOnPlane(_v.copy(out), this.up).normalize());
    if (into < 0.45) return false;
    // the wall must rise in front of us (not a drop-off)
    const hHere = this.heights.groundR(this.pos), hAhead = this.heights.groundR(_t);
    return hAhead - hHere > 0.25;
  }

  // ======================================================================================= states
  _ground(dt, I) {
    const up = this.up;
    const n = this._groundNormal(this.pos, this.groundN);
    const slopeCos = n.dot(up);
    const hard = this.hardT > 0;
    let spd = 0;
    if (I.mag > 0.05) {
      spd = I.mag < 0.6 ? T.walk * (I.mag / 0.6) : lerp(T.walk, T.run, (I.mag - 0.6) / 0.4);
      if (I.sprint) spd = T.sprint * Math.max(I.mag, 0.7);
      if (I.descend) spd = Math.min(spd, T.crouch);
      if (hard) spd *= 0.15;
    }
    const target = _a.copy(I.wish).multiplyScalar(spd);
    // slope: gentle modulation (flow), block steep uphill
    const dh = projectOnPlane(_b.copy(n), up); // points downhill
    const grade = dh.length();
    if (grade > 1e-4) {
      dh.divideScalar(grade);
      const along = target.dot(dh); // + downhill
      if (slopeCos < T.walkCos && along < 0) target.addScaledVector(dh, -along);
      else if (spd > 0) target.multiplyScalar(1 + clamp(along / Math.max(spd, 1e-3), -1, 1) * clamp(grade, 0, 0.6) * 0.35);
    }
    const vt = projectOnPlane(_c.copy(this.vel), up);
    const rate = target.lengthSq() >= vt.lengthSq() ? T.accel : T.decel;
    vt.lerp(target, dampF(rate, dt));
    this.vel.copy(vt);
    // face movement (sprint turns wider)
    if (vt.lengthSq() > 0.09) this._turnToward(vt, I.sprint ? T.turnSprint : T.turn, dt);

    // transitions
    if (this.jumpBuf > 0 && !hard) { this._jump(); this._move(dt); return; }
    const sp = vt.length();
    if ((I.descendDown || (I.descend && this.slideS.t > 0)) && (sp > 4.2 || slopeCos < 0.94)) { this._startSlide(); this._move(dt); return; }
    this.slideS.t = I.descend ? this.slideS.t + dt : 0;
    if (slopeCos < T.slideAutoCos) {
      if (I.mag > 0.4 && this._wallAhead(I.wish, _n) && this._enterClimb(_n, I.wish)) return;
      this._startSlide(); this._move(dt); return;
    }
    if (I.mag > 0.4 && this._wallAhead(I.wish, _n)) {
      this.climbPush += dt;
      if (this.climbPush > 0.18 && this._enterClimb(_n, I.wish)) return;
    } else this.climbPush = 0;

    this._move(dt);
    this._resolveColliders();
    // snap / leave ground
    const floor = this._floorR(this.pos, up);
    const r = this.pos.length();
    const stepDown = T.stepDown + sp * 0.05;
    if (r - floor <= stepDown) this.pos.setLength(floor);
    else { this.state = 'air'; this.coyote = T.coyote; this.airTime = 0; this.fallStartR = r; this.usedDouble = false; this.vel.addScaledVector(up, Math.max(0, this.groundVr)); }
    if (this.water > -1e8 && this.heights.groundR(this.pos) < this.R + this.water - T.swimDepth) this._enterSwim(0);
  }

  _move(dt) { this.pos.addScaledVector(this.vel, dt); }

  _turnToward(dir, rate, dt) {
    _t.copy(dir); projectOnPlane(_t, this.up);
    if (_t.lengthSq() < 1e-8) return;
    _t.normalize();
    const ang = Math.atan2(_v.crossVectors(this.forward, _t).dot(this.up), clamp(this.forward.dot(_t), -1, 1));
    const step = Math.abs(ang) < 0.3 ? ang * dampF(rate * 1.4, dt) : clamp(ang, -rate * dt, rate * dt);
    this.forward.applyAxisAngle(this.up, step);
    orthoForward(this.up, this.forward, this.forward);
  }

  _air(dt, I) {
    const up = this.up;
    this.airTime += dt;
    // coyote jump / buffered jump just after walking off an edge
    if (this.jumpBuf > 0 && this.coyote > 0) { this._jump(); this._move(dt); return; }
    const vt = projectOnPlane(_c.copy(this.vel), up);
    let vy = this.vel.dot(up);
    // air control keeps momentum: steer toward the wish at >= current speed
    if (I.mag > 0.05) {
      const s = Math.max(vt.length(), T.run * 0.85 * I.mag);
      _a.copy(I.wish).multiplyScalar(s);
      vt.lerp(_a, dampF(T.airAccel, dt));
      this._turnToward(I.wish, 5, dt);
    } else if (vt.lengthSq() > 0.5) this._turnToward(vt, 3, dt);
    vt.multiplyScalar(1 - 0.02 * dt);
    vy -= this.g * dt;
    // variable jump height
    if (!I.jumpHeld && vy > 0 && !this.jumpCut && this.airTime > 0.05 && this.airTime < 0.3 && !this.usedDouble) { vy *= 0.6; this.jumpCut = true; }
    // double jump (jetpack burst) / glider
    if (I.jumpDown && this.coyote <= 0) {
      const aboveGround = this.pos.length() - this.heights.groundR(this.pos);
      if (!this.usedDouble && this.jetFuel > 0.3 && this.airTime > 0.06) {
        this.usedDouble = true; vy = Math.max(vy, T.dblV); this.jetBurst = 0.42; this.jetFuel -= 0.35;
        if (I.mag > 0.1) vt.lerp(_a.copy(I.wish).multiplyScalar(Math.max(vt.length(), T.run)), 0.5);
        this.world.events?.emit?.('player:jump', { pos: this.pos, double: true });
        this.engine?.audio?.play?.('boost', { intensity: 0.6 });
      } else if (aboveGround > 2.2) {
        this.vel.copy(vt).addScaledVector(up, vy);
        this._openGlider(true);
        this._move(dt);
        return;
      }
    }
    // sustained jet thrust (Shift in the air) — refills on the ground; no stamina on foot
    const jetOn = I.sprint && this.jetFuel > 0 && this.airTime > 0.12;
    if (jetOn) {
      vy = Math.min(vy + T.jet * dt, T.jetMaxUp);
      vt.addScaledVector(this.forward, 3.5 * dt);
      this.jetFuel = Math.max(0, this.jetFuel - dt);
    }
    this.boostP = damp(this.boostP, jetOn || this.jetBurst > 0 ? 1 : 0, jetOn || this.jetBurst > 0 ? 18 : 6, dt);
    vy = Math.max(vy, -60);
    this.vel.copy(vt).addScaledVector(up, vy);
    this._move(dt);
    this._resolveColliders();
    this.up.copy(this.pos).normalize();
    // climb grab when flying into a steep wall
    if (I.mag > 0.4 && this.airTime > 0.15 && vy < 3 && this._wallAhead(I.wish, _n) && this._enterClimb(_n, I.wish)) return;
    // ground / water
    const r = this.pos.length();
    const floor = this._floorR(this.pos, this.up);
    const seaR = this.water > -1e8 ? this.R + this.water : -Infinity;
    if (seaR > floor + T.swimDepth - 0.2 && r < seaR - 0.35) { this._enterSwim(-this.vel.dot(this.up)); return; }
    if (r <= floor) {
      this.pos.setLength(floor);
      const impact = Math.max(0, -this.vel.dot(this.up));
      this._land(impact);
      _n.copy(this.groundN);
      if (I.descend && this.speed > 3) this._startSlide();
    }
  }

  _glide(dt, I) {
    const g = this.glide, up = this.up;
    g.t += dt;
    orthoForward(up, g.dir, g.dir);
    // steering: turn toward the stick direction (camera relative) with coordinated banking
    let turnT = 0;
    if (I.mag > 0.12) {
      const a = Math.atan2(_a.crossVectors(g.dir, I.wish).dot(up), clamp(g.dir.dot(I.wish), -1, 1));
      turnT = clamp(a * 1.5, -1.25, 1.25) * I.mag;
    }
    g.turn = damp(g.turn, turnT, 2.6, dt);
    g.dir.applyAxisAngle(up, g.turn * dt);
    g.bank = damp(g.bank, clamp(g.turn * 0.62, -0.75, 0.75), 3.2, dt);
    g.dive = damp(g.dive, I.sprint ? 1 : 0, 1.8, dt);
    const flare = I.mv.y < -0.5 && Math.abs(I.mv.x) < 0.5 ? 1 : 0;
    const sT = lerp(T.glide, T.glideDive, g.dive) * (1 - 0.18 * flare);
    g.s = damp(g.s, sT, 0.7 + g.dive * 0.8, dt);
    const alt = this.pos.length() - this.heights.groundR(this.pos);
    const sunElev = safe(() => this.world.celestial.sunDir.dot(up), 0.5);
    const lift = this.air.updraft(this.pos, alt, sunElev);
    this.lift = lift;
    const sinkT = lerp(T.sink, T.sinkDive, g.dive * g.dive) + 0.45 * Math.abs(g.bank) - 0.25 * flare;
    g.w = damp(g.w, -sinkT + lift, g.w < -sinkT - 3 ? 1.1 : 1.6, dt); // arrests a fall smoothly after deploy
    this.air.wind(this.pos, this.windV);
    this.vel.copy(g.dir).multiplyScalar(g.s).addScaledVector(up, g.w).addScaledVector(this.windV, 0.55);
    this._turnToward(g.dir, 6, dt);
    // pendulum sway (driven by turn changes and deploy)
    g.swayZ.update(-g.turn * 0.08, dt); g.swayX.update(-g.dive * 0.15 + flare * 0.2, dt);
    g.pitch = g.dive * 0.55 - flare * 0.25;
    this._move(dt);
    this._resolveColliders();
    this.airTime += dt;
    // exits
    if (I.jumpDown || I.descendDown) { this._openGlider(false); this.usedDouble = true; return; }
    this.up.copy(this.pos).normalize();
    const r = this.pos.length();
    const floor = this._floorR(this.pos, this.up);
    const seaR = this.water > -1e8 ? this.R + this.water : -Infinity;
    if (seaR > floor + T.swimDepth - 0.2 && r < seaR - 0.2) { this._openGlider(false); this._enterSwim(-this.vel.dot(this.up)); return; }
    if (r <= floor + 0.02) {
      this.pos.setLength(floor);
      this._openGlider(false);
      this._land(Math.max(0, -this.vel.dot(this.up)) * 0.6);
      // keep some forward flow on touchdown (run out of the landing)
      projectOnPlane(this.vel, this.up).multiplyScalar(0.55);
    }
  }

  _slide(dt, I) {
    const up = this.up, S = this.slideS;
    S.t += dt;
    const n = this._groundNormal(this.pos, this.groundN);
    const cosN = clamp(n.dot(up), 0, 1);
    const vt = projectOnPlane(_c.copy(this.vel), up);
    // gravity along the surface, projected to the tangent plane
    const gs = projectOnPlane(_a.copy(n), up).multiplyScalar(this.g * cosN);
    vt.addScaledVector(gs, dt * 1.15);
    let sp = vt.length();
    const mu = this.surfaceKind === 'sand' ? 0.07 : this.surfaceKind === 'snow' ? 0.045 : this.surfaceKind === 'rock' ? 0.2 : 0.14;
    if (sp > 1e-3) {
      const fr = mu * this.g * cosN * dt + 0.0035 * sp * sp * dt;
      vt.multiplyScalar(Math.max(0, sp - fr) / sp);
      sp = vt.length();
    }
    // carving: stick x relative to the camera turns the board
    S.carve = damp(S.carve, I.mv.x, 5, dt);
    if (sp > 0.5) vt.applyAxisAngle(up, -S.carve * clamp(2.4 - sp * 0.06, 0.9, 2.4) * dt);
    if (I.mv.y > 0.3 && sp < 7) vt.addScaledVector(this.forward, 2.2 * dt * I.mv.y);
    if (sp > 26) vt.multiplyScalar(26 / sp);
    this.vel.copy(vt);
    if (sp > 0.4) this._turnToward(vt, 9, dt);
    // exits
    if (this.jumpBuf > 0) { this._jump(1.05); this._move(dt); return; }
    if (!I.descend && I.mag > 0.4 && sp < 6 && this._wallAhead(I.wish, _e) && this._enterClimb(_e, I.wish)) return;
    if ((sp < 0.9 && cosN > T.slideAutoCos) || (!I.descend && sp < 3.2 && cosN > T.walkCos && S.t > 0.4) || (!I.descend && S.t > 0.5 && cosN > 0.97 && sp < 6)) {
      this.state = 'ground';
    }
    this._move(dt);
    this._resolveColliders();
    const floor = this._floorR(this.pos, up);
    const r = this.pos.length();
    if (r - floor <= 0.35 + sp * 0.025) this.pos.setLength(floor);
    else { // launched off a crest — pure flow
      this.state = 'air'; this.airTime = 0; this.coyote = T.coyote; this.usedDouble = false;
      this.vel.addScaledVector(up, Math.max(0, this.groundVr));
    }
    if (this.water > -1e8 && this.heights.groundR(this.pos) < this.R + this.water - T.swimDepth) this._enterSwim(0);
  }

  _enterSwim(impact) {
    const wasAir = this.state === 'air' || this.state === 'glide';
    this.state = 'swim'; this.grounded = false; this.swimT = 0; this.dive = 0;
    this._openGlider(false);
    if (this.fx && (impact > 1.5 || wasAir)) {
      _a.copy(this.pos).setLength(this.R + this.water);
      this.fx.splash(_a, this.up, clamp(impact, 2, 16), _col.setRGB(0.75, 0.85, 0.9));
    }
    if (impact > 1.5) this.engine?.audio?.play?.('splash', { intensity: clamp(impact / 15, 0.1, 1) });
    // arrest the plunge
    const vr = this.vel.dot(this.up);
    if (vr < 0) this.vel.addScaledVector(this.up, -vr * 0.8);
  }

  _swim(dt, I) {
    const up = this.up;
    this.swimT += dt;
    const seaR = this.R + (this.water > -1e8 ? this.water : 0);
    const spd = I.mag > 0.05 ? (I.sprint ? T.swimSprint : T.swim * I.mag) : 0;
    const vt = projectOnPlane(_c.copy(this.vel), up);
    vt.lerp(_a.copy(I.wish).multiplyScalar(spd), dampF(spd > vt.length() ? 2.2 : 1.6, dt));
    if (vt.lengthSq() > 0.05) this._turnToward(vt, 3.2, dt);
    else if (this.view === 'fp') this._turnToward(this.cam.fwd, 2, dt);
    // dive (hold descend): sink toward the seabed; buoyancy brings you back up when released
    const floorHere = this.heights.groundR(this.pos);
    const maxDive = Math.max(0, seaR - T.float - floorHere - 0.7);
    if (I.descend) this.dive = Math.min(maxDive, this.dive + dt * (I.sprint ? 2.6 : 1.7));
    else this.dive = Math.max(0, this.dive - dt * (I.jumpHeld ? 2.4 : 1.1));
    if (this.dive > maxDive) this.dive = damp(this.dive, maxDive, 4, dt);
    const bob = Math.sin(this.time * 1.7) * 0.035 * (1 - smoothstep(0.2, 0.8, this.dive));
    const r = this.pos.length();
    // front crawl rides higher (back, pack and helmet break the surface); treading sits chest-deep
    const floatD = lerp(T.float, 1.19, smoothstep(0.3, 1.6, this.speed) * (1 - smoothstep(0.1, 0.6, this.dive)));
    const err = (seaR - floatD + bob - this.dive) - r;
    let vr = this.vel.dot(up);
    vr += (err * 14 - vr * 5) * dt;
    this.vel.copy(vt).addScaledVector(up, vr);
    if (I.jumpDown && err > -0.3 && this.dive < 0.2) { // dolphin hop
      this.vel.addScaledVector(up, 4.6 - vr);
      this.state = 'air'; this.airTime = 0; this.usedDouble = true;
      if (this.fx) this.fx.splash(_a.copy(this.pos).setLength(seaR), up, 4, _col.setRGB(0.75, 0.85, 0.9));
      this._move(dt);
      return;
    }
    this._move(dt);
    this._resolveColliders();
    // walk out of the water when it gets shallow
    const floor = this._floorR(this.pos, up);
    if (floor > seaR - T.swimDepth + 0.12) {
      this.state = 'ground';
      if (this.pos.length() < floor) this.pos.setLength(floor);
      this._quietLand = true;
    }
  }

  /**
   * Grab the wall: find the chest contact point on the heightfield along `dir`, return false when there
   * is nothing to hold on to (then the caller slides / keeps walking).
   */
  _enterClimb(n, dir) {
    const C = this.climbS, up = this.up;
    const d = projectOnPlane(_v.copy(dir || this.forward), up);
    if (d.lengthSq() < 1e-6) d.copy(projectOnPlane(_v.copy(n), up)).negate();
    if (d.lengthSq() < 1e-6) return false;
    d.normalize();
    let hit = -1;
    for (const hgt of [1.3, 0.95, 0.6]) {
      _t.copy(this.pos).addScaledVector(up, hgt);
      hit = this.heights.ray(_t, d, 1.4, 0.07);
      if (hit > 0) break;
    }
    if (!(hit > 0)) return false;
    C.anchor.copy(_t).addScaledVector(d, hit);
    this.heights.normal(C.anchor, C.n, 0.45);
    if (C.n.dot(up) > T.walkCos + 0.08) return false; // not steep enough to be a wall here
    this.state = 'climb'; this.vel.set(0, 0, 0); this.climbPush = 0;
    this._openGlider(false);
    C.t = 0; C.lunge = 0; C.push = 0.05; C.speed = 0;
    // which side the camera sits on (keeps the ¾ framing on the side the player already looks from)
    C.side = _a.crossVectors(this.cam.fwd, d).dot(up) >= 0 ? 1 : -1;
    this._climbFrame(0, true);
    return true;
  }

  /** Body frame + position from the chest anchor on the wall (anti-penetration along the wall normal). */
  _climbFrame(dt, snap = false) {
    const C = this.climbS, up = this.up, H = this.heights;
    const n = C.n;
    const wallUp = C.up.copy(up).addScaledVector(n, -n.dot(up));
    if (wallUp.lengthSq() < 1e-6) wallUp.copy(this.forward);
    wallUp.normalize();
    C.fwd.copy(n).negate();
    const CH = 1.3, STAND = 0.24;
    // feet reference (group origin): chest height below the anchor along the wall, standing off the rock
    const pos = _d.copy(C.anchor).addScaledVector(n, STAND).addScaledVector(wallUp, -CH);
    // the rock is not a plane: sample the body's front (toes, knees, hips, chest, visor) and push out
    let need = 0;
    for (let i = 0; i < CLIMB_PROBES.length; i += 2) {
      _e.copy(pos).addScaledVector(wallUp, CLIMB_PROBES[i]).addScaledVector(n, -CLIMB_PROBES[i + 1]);
      const t = H.pushOut(_e, n, 0.9, 0.035);
      if (t > need) need = t;
    }
    C.push = snap || need > C.push ? need : damp(C.push, need, 5, dt);
    pos.addScaledVector(n, C.push);
    C.wallZ = STAND + C.push;
    // feet never below the floor at the base of the wall: slide the anchor up instead
    const fr = this._floorR(pos, up);
    const r = pos.length();
    if (r < fr) {
      const k = Math.max(0.35, wallUp.dot(up));
      C.anchor.addScaledVector(wallUp, (fr - r) / k);
      pos.addScaledVector(wallUp, (fr - r) / k);
      C.atBase = true;
    } else C.atBase = r - fr < 0.08;
    this.pos.copy(pos);
    projectOnPlane(_a.copy(C.fwd), up);
    if (_a.lengthSq() > 1e-6) this.forward.copy(_a.normalize());
  }

  _climb(dt, I) {
    const C = this.climbS, up = this.up, H = this.heights;
    C.t += dt;
    // smoothed wall normal around the anchor
    H.normal(C.anchor, _n, 0.5);
    C.n.lerp(_n, dampF(9, dt)).normalize();
    const n = C.n;
    const wallUp = _b.copy(up).addScaledVector(n, -n.dot(up));
    if (wallUp.lengthSq() < 1e-6) { this.state = 'air'; return; }
    wallUp.normalize();
    const wallRight = _c.crossVectors(wallUp, n).normalize();
    const spd = I.sprint ? T.climbFast : T.climb;
    const my = I.mv.y, mx = I.mv.x;
    const mag = Math.min(1, Math.hypot(mx, my));
    C.dx = damp(C.dx, mx, 8, dt); C.dy = damp(C.dy, my, 8, dt);
    C.lunge = Math.max(0, C.lunge - dt);
    const lungeV = C.lunge > 0 ? 4.6 * Math.sin((C.lunge / 0.32) * Math.PI) : 0;
    const vUp = my * spd + lungeV, vRight = mx * spd;
    C.speed = Math.hypot(vUp, vRight);
    C.move = damp(C.move, Math.max(mag, C.lunge > 0 ? 1 : 0), 8, dt);
    C.anchor.addScaledVector(wallUp, vUp * dt).addScaledVector(wallRight, vRight * dt);
    // re-project the anchor onto the rock along the wall normal
    _t.copy(C.anchor).addScaledVector(n, 0.6);
    if (H.inside(_t)) _t.copy(C.anchor).addScaledVector(n, 1.5);
    const back = _t.distanceTo(C.anchor);
    const hit = H.ray(_t, _e.copy(n).negate(), back + 0.9, 0.06);
    const lostWall = hit < 0;
    if (!lostWall) C.anchor.copy(_t).addScaledVector(n, -hit);
    const cosN = n.dot(up);
    C.lean = clamp(Math.PI / 2 - Math.acos(clamp(cosN, -1, 1)), -0.2, 0.9);
    // ---- mantle over the top (the rock above the hands turns walkable, or there is no rock left ahead)
    _t.copy(C.anchor).addScaledVector(wallUp, 0.55);
    H.normal(_t, _x, 0.45);
    if ((lostWall || _x.dot(up) > 0.78) && (my > 0.1 || C.lunge > 0)) {
      _t.copy(C.anchor).addScaledVector(wallUp, 0.35).addScaledVector(n, -0.55);
      this.pos.copy(_t).setLength(this._floorR(_t, up) + 0.08);
      projectOnPlane(_a.copy(n).negate(), up);
      if (_a.lengthSq() > 1e-6) this.forward.copy(_a.normalize());
      this.vel.copy(this.forward).multiplyScalar(2.2).addScaledVector(up, 2.2);
      this.state = 'air'; this.airTime = 0.2; this.usedDouble = false; this._quietLand = true;
      this.cam.addTrauma(0.04);
      return;
    }
    if (lostWall || cosN > T.walkCos + 0.12) { // the wall flattened out under us
      this.state = 'air'; this.airTime = 0.2; this._quietLand = true; this.vel.set(0, 0, 0);
      return;
    }
    this._climbFrame(dt);
    this.vel.copy(wallUp).multiplyScalar(vUp).addScaledVector(wallRight, vRight);
    // ---- exits
    if (I.jumpDown) {
      if (my > 0.5 && C.lunge <= 0) { C.lunge = 0.32; this.cam.addTrauma(0.04); this.engine?.audio?.play?.('jump', { surface: 'rock' }); return; }
      if (my <= 0.5) {
        const nH = projectOnPlane(_a.copy(n), up).normalize();
        this.vel.copy(nH).multiplyScalar(3.8).addScaledVector(up, 5.2);
        this.forward.copy(nH);
        this.state = 'air'; this.airTime = 0; this.usedDouble = false; this.fallStartR = this.pos.length();
        return;
      }
    }
    if (I.descendDown) {
      const nH = projectOnPlane(_a.copy(n), up).normalize();
      this.vel.copy(nH).multiplyScalar(1.2); this.state = 'air'; this.airTime = 0.3;
      return;
    }
    // climbed down to the foot of the wall
    if (C.atBase && my < -0.1) { this.state = 'ground'; this._quietLand = true; this.vel.set(0, 0, 0); }
  }

  _fly(dt, input) {
    this._setVisible(false);
    const up = this.up.copy(this.pos).normalize();
    this.cam.transport(up);
    const look = input.axis('look');
    this.cam.look(up, look.x, look.y, true);
    const alt = this.pos.length() - this.R;
    const speed = clamp(alt * 0.8, 15, 20000) * (input.held('boost') ? 4 : 1);
    const mv = input.axis('move');
    const camF = this.cam.frame(up);
    this.pos.addScaledVector(camF, mv.y * speed * dt).addScaledVector(this.cam.camRight, mv.x * speed * dt);
    if (input.held('ascend')) this.pos.addScaledVector(up, speed * dt);
    if (input.held('descend')) this.pos.addScaledVector(up, -speed * dt);
    const minR = this.R + Math.max(this._terrainH(this.pos), this.heights.hasOcean ? this.heights.sea : -1e9) + 2;
    if (this.pos.length() < minR) this.pos.setLength(minR);
    this.forward.copy(this.cam.fwd);
    this.cam.flyView(dt, this.pos, up);
  }

  // ======================================================================================= presentation
  _animState(dt) {
    const S = this.S, st = this.state;
    S.state = st === 'fly' ? 'air' : st;
    S.crouch = st === 'ground' && this.input.held('descend') && this.speed < 3;
    S.speed = st === 'swim' ? this.speed : this.speed;
    // acceleration in character space (x = left, z = forward)
    _a.crossVectors(this.up, this.forward); // left
    S.accelLocal.set(this.accel.dot(_a), this.accelUp, this.accel.dot(this.forward));
    S.accelUp = this.accelUp;
    S.turnRate = this.turnRate;
    S.hardLand = st === 'ground' ? clamp(this.hardT / 0.22, 0, 1) : 0;
    if (this.landImpact > 0) { S.landImpact = this.landImpact; this.landImpact = 0; }
    S.fp = this.view === 'fp';
    S.vy = this.vel.dot(this.up);
    S.airTime = this.airTime;
    S.boost = this.boostP;
    S.time = this.time;
    const g = this.glide;
    S.glide.pitch = g.pitch; S.glide.bank = g.bank; S.glide.swayZ = g.swayZ.x; S.glide.swayX = g.swayX.x;
    S.slide.carve = this.slideS.carve;
    S.dive = this.state === 'swim' ? clamp(this.dive / 1.2, 0, 1) : 0;
    const C = this.climbS;
    S.climb.move = C.move; S.climb.dirX = C.dx; S.climb.dirY = C.dy; S.climb.lean = C.lean;
    S.climb.speed = st === 'climb' ? C.speed : 0; S.climb.wallZ = C.wallZ; S.climb.lunge = C.lunge;
    // head look: toward a nearby point of interest, else where the camera looks
    this._poiT += dt;
    if (this._poiT > 0.5) { this._poiT = 0; this._pickLookTarget(); }
    let dir;
    if (S.fp) dir = this.cam.camF;
    else if (this.lookTarget) dir = _b.copy(this.lookTarget).sub(this.pos).addScaledVector(this.up, -1.6).normalize();
    else dir = this.cam.camF;
    const f = this.forward;
    const lx = dir.dot(_a), lz = dir.dot(f), ly = dir.dot(this.up);
    S.lookYaw = Math.atan2(lx, lz);
    S.lookPitch = Math.asin(clamp(ly, -1, 1));
    if (!S.fp && !this.lookTarget) S.lookPitch *= 0.55;
    return S;
  }

  _pickLookTarget() {
    this.lookTarget = null;
    const pois = this.world.pois;
    if (!Array.isArray(pois) || !pois.length || this.state !== 'ground') return;
    let best = null, bd = 60 * 60;
    for (let i = 0; i < pois.length && i < 400; i++) {
      const p = pois[i];
      if (!p?.pos) continue;
      const d2 = p.pos.distanceToSquared(this.pos);
      if (d2 < bd && d2 > 4) {
        _c.copy(p.pos).sub(this.pos).normalize();
        if (_c.dot(this.forward) > 0.2) { bd = d2; best = p.pos; }
      }
    }
    this.lookTarget = best;
  }

  _syncBody(dt) {
    const up = this.up.copy(this.pos).normalize();
    const vis = this._visible && !this.cam.hideBody && this.view !== 'orbit';
    if (this.group) this.group.visible = vis;
    if (!this.group) return;
    quatFromUpForward(up, this.forward, this.gquat);
    // climbing: the whole body frame aligns with the rock (up the wall, facing into it)
    this.climbBlend = damp(this.climbBlend, this.state === 'climb' ? 1 : 0, this.state === 'climb' ? 10 : 7, dt);
    if (this.climbBlend > 1e-3) {
      quatFromUpForward(this.climbS.up, this.climbS.fwd, _q2);
      this.gquat.slerp(_q2, this.climbBlend);
    }
    this.gpos.copy(this.pos);
    // swimming: nothing extra (the animator tilts about the chest); sliding: sink the board stance a hair
    this.group.position.copy(this.gpos);
    this.group.quaternion.copy(this.gquat);
    if (!this.animator || dt <= 0) { this.group.updateMatrixWorld(true); return; }
    const S = this._animState(dt);
    this.animator.headHidden = this.view === 'fp';
    safe(() => this.animator.update(dt, S, this.gpos, this.gquat));
    this.rig.materials.visor?.userData?.uUp?.value.copy(up);
    this.group.updateMatrixWorld(true);
    // ---- glider
    if (this.glider) {
      const open = this.state === 'glide';
      safe(() => this.glider.update(dt, open, this.glide.s));
      const gg = this.glider.group;
      gg.rotation.set(this.glide.pitch * 0.25 - 0.05, 0, -this.glide.bank * 0.9, 'YXZ');
      gg.visible = gg.visible && vis;
    }
    // ---- scarf (anchors in chest space → planet-local)
    if (this.scarf && vis && this.view !== 'fp') {
      const an = this.animator;
      const ch = an.gp[B.chest], cq = an.gq[B.chest];
      for (let k = 0; k < 2; k++) for (let i = 0; i < 3; i++) {
        this.anchorsW[k][i].copy(this.scarf.anchorsC[k][i]).applyQuaternion(cq).add(ch).applyQuaternion(this.gquat).add(this.gpos);
      }
      const sp = this.spheres;
      const place = (i, b, ox, oy, oz, r) => {
        sp[i].c.set(ox, oy, oz).applyQuaternion(an.gq[b]).add(an.gp[b]).applyQuaternion(this.gquat).add(this.gpos); sp[i].r = r;
      };
      place(0, B.head, 0, 0.08, 0.01, 0.175);
      place(1, B.chest, 0, 0.08, 0.0, 0.2);
      place(2, B.spine, 0, 0.0, 0.0, 0.18);
      place(3, B.pack, 0, 0.07, -0.06, 0.17);
      place(4, B.pack, 0, -0.1, -0.06, 0.17);
      place(5, B.hips, 0, 0.0, 0.0, 0.17);
      place(6, B.thighL, -0.09, -0.2, 0, 0.1);
      this.air.wind(this.pos, this.windV);
      const w = _d.copy(this.windV);
      if (this.state === 'swim') w.multiplyScalar(0.1);
      safe(() => this.scarf.update(dt, this.anchorsW, up, this.g, w, sp, this.gpos));
    }
    if (this.scarf) this.scarf.group.visible = vis && this.view !== 'fp';
  }

  _camera(dt) {
    if (this.view === 'orbit') { this.cam.orbitView(dt, this.input, this.R); return; }
    const ctx = this._camCtx || (this._camCtx = {});
    ctx.pos = this.pos; ctx.up = this.up; ctx.vel = this.vel; ctx.state = this.state;
    ctx.heights = this.heights; ctx.colliders = this.colliders; ctx.bank = this.glide.bank;
    ctx.carve = this.slideS.carve; ctx.dive = this.glide.dive > 0.5; ctx.boost = this.boostP;
    ctx.submerged = this.state === 'swim' && this.dive > 0.6; ctx.forward = this.forward;
    ctx.climbN = this.climbS.n; ctx.climbUp = this.climbS.up; ctx.climbSide = this.climbS.side;
    if (this.view === 'fp') {
      if (this.animator) {
        this.animator.eyeGroup(this.eye).applyQuaternion(this.gquat).add(this.gpos);
      } else this.eye.copy(this.pos).addScaledVector(this.up, 1.65);
      this.cam.firstPerson(dt, ctx, this.eye);
      // in first person the body turns with the view when standing (body awareness)
      if (this.state === 'ground' && this.speed < 0.3) {
        const a = Math.acos(clamp(this.forward.dot(this.cam.fwd), -1, 1));
        if (a > 0.9) this._turnToward(this.cam.fwd, 6, dt);
      }
    } else this.cam.thirdPerson(dt, ctx);
  }

  _feedback(dt, I) {
    const fx = this.fx, up = this.up;
    // ---- footsteps
    if (this.animator && this.state === 'ground') {
      for (const side of this.animator.stepEvents) {
        const fp = this.animator.footWorld[side];
        this.engine?.audio?.play?.('step', { surface: this.surfaceKind, speed: this.speed, side });
        if (fx) {
          const soft = this.surfaceKind === 'sand' || this.surfaceKind === 'snow';
          const n = this.speed > 7 ? 3 : soft ? 2 : 1;
          fx.dust(fp, up, this._dustColor(), n, 0.5 + this.speed * 0.06, soft ? 0.2 : 0.14, soft ? 0.45 : 0.22);
          if (soft) fx.footprint(fp, up, this.forward);
        }
      }
    }
    if (fx) {
      // ---- slide: rooster tail of sand / snow from the trailing edge, grains, and a carved furrow
      if (this.state === 'slide' && this.speed > 1.5) {
        const soft = this.surfaceKind === 'sand' || this.surfaceKind === 'snow';
        const k = smoothstep(1.5, 14, this.speed);
        const an = this.animator;
        _a.copy(this.vel).normalize().negate().addScaledVector(up, 0.25);
        // lateral kick toward the outside of the carve
        _c.crossVectors(up, this.forward).multiplyScalar(-this.slideS.carve * 0.6);
        _a.add(_c).normalize();
        this._slideAcc = (this._slideAcc || 0) + dt * (soft ? 52 : 22) * (0.35 + k);
        this._grainAcc = (this._grainAcc || 0) + dt * (soft ? 90 : 30) * k;
        const src = an ? an.footWorld.R : this.pos;
        _col.copy(this.groundColor).lerp(WHITE, this.surfaceKind === 'snow' ? 0.75 : 0.3);
        // the spray is thrown out sideways off the board edge and carried along with the rider (a chase
        // camera would otherwise leave it behind the lens within a few frames)
        const side = _c.crossVectors(up, this.forward).normalize(); // left of the body (board is sideways)
        const rnd = fx.rand;
        while (this._slideAcc >= 1) {
          this._slideAcc -= 1;
          const s = (rnd.next() < 0.5 ? 1 : -1) * (0.6 + rnd.next() * 0.8) - this.slideS.carve * 0.8;
          _b.copy(this.vel).multiplyScalar(0.45 + rnd.next() * 0.25).addScaledVector(side, s * (1.4 + this.speed * 0.14))
            .addScaledVector(up, 0.8 + rnd.next() * (0.9 + this.speed * 0.08));
          _e.copy(src).addScaledVector(side, s * 0.15);
          fx.emit(_e, _b, { kind: 0, size: (soft ? 0.34 : 0.2) * (0.6 + rnd.next() * 0.8), size1: soft ? 1.15 : 0.7, life: 0.65 + rnd.next() * 0.75, color: _col, alpha: soft ? 0.42 : 0.3, drag: 1.4, grav: 0.18, spin: (rnd.next() - 0.5) * 2 });
        }
        while (this._grainAcc >= 1) {
          this._grainAcc -= 1;
          const s = (rnd.next() < 0.5 ? 1 : -1) * (0.5 + rnd.next()) - this.slideS.carve;
          _b.copy(this.vel).multiplyScalar(0.7).addScaledVector(side, s * (1.5 + this.speed * 0.15)).addScaledVector(up, 1.8 + rnd.next() * 2.5);
          fx.emit(src, _b, { kind: 1, size: 0.02, size1: 0.016, life: 0.45 + rnd.next() * 0.4, color: _col, alpha: 0.9, drag: 0.4, grav: 1 });
        }
        if (soft && an) {
          this._furrowD = (this._furrowD || 0) + this.speed * dt;
          if (this._furrowD > 0.45) { this._furrowD = 0; fx.footprint(an.footWorld.L, up, this.forward); fx.footprint(an.footWorld.R, up, this.forward); }
        }
      }
      // ---- swim ripples + wake
      if (this.state === 'swim' && this.dive < 0.5) {
        this._ripT = (this._ripT || 0) + dt;
        const moving = this.speed > 0.6;
        if (this._ripT > (moving ? 0.42 : 0.8)) {
          this._ripT = 0;
          _a.copy(this.pos).setLength(this.R + this.water);
          fx.ripple(_a, up, 0.25, moving ? 1.6 : 1.1, moving ? 1.4 : 1.8);
          if (moving) fx.spray(_a.addScaledVector(this.forward, 0.5), this.forward, up, _col.setRGB(0.8, 0.88, 0.92), 3, 1.2, 1, 0.05);
        }
      }
      // ---- jet sparks
      const jp = this.boostP;
      if (jp > 0.1 && this.animator) {
        this._jetT = (this._jetT || 0) + dt;
        if (this._jetT > 0.03) {
          this._jetT = 0;
          for (const s of [1, -1]) {
            _a.set(s * 0.085, -0.3, -0.09).applyQuaternion(this.animator.gq[B.pack]).add(this.animator.gp[B.pack]).applyQuaternion(this.gquat).add(this.gpos);
            _b.copy(up).multiplyScalar(-6).add(this.vel);
            fx.emit(_a, _b, { kind: 2, size: 0.05, size1: 0.02, life: 0.25, color: _col.setRGB(3, 5.5, 6), alpha: 0.9 * jp, drag: 3 });
          }
        }
      }
      // ---- thermal motes (visual cue for updrafts)
      if ((this.state === 'glide' || this.state === 'air') && this.air.near.length) {
        this._moteT = (this._moteT || 0) + dt;
        if (this._moteT > 0.06) {
          this._moteT = 0;
          const th = this.air.near[(this.time * 7 | 0) % this.air.near.length];
          const d = th.base.distanceTo(this.pos);
          if (d < 260 && fx.rand) {
            const r = fx.rand;
            tangentBasis(th.up, _c, _d);
            const a = r.next() * 6.283, rr = Math.sqrt(r.next()) * th.radius;
            const hAbove = _e.copy(this.pos).sub(th.base).dot(th.up);
            _a.copy(th.base).addScaledVector(_c, Math.cos(a) * rr).addScaledVector(_d, Math.sin(a) * rr).addScaledVector(th.up, clamp(hAbove + (r.next() - 0.5) * 40, 2, th.top));
            _b.copy(th.up).multiplyScalar(th.strength * 1.3);
            fx.emit(_a, _b, { kind: 2, size: 0.12, size1: 0.08, life: 2.6, color: _col.setRGB(1.6, 1.5, 1.2), alpha: 0.5, drag: 0.1 });
          }
        }
      }
      // ---- contact shadow + trails
      const ctx = this._fxCtx || (this._fxCtx = { up: new THREE.Vector3(), shadow: { pos: new THREE.Vector3(), up: new THREE.Vector3(), heights: null, opacity: 0, size: 1.1 }, trails: { on: false, a: new THREE.Vector3(), b: new THREE.Vector3(), alpha: 0 }, jetPower: 0, gravity: 9.8 });
      ctx.up.copy(up); ctx.gravity = this.g; ctx.jetPower = this._visible ? this.boostP : 0;
      const hAbove = this.pos.length() - this.heights.groundR(this.pos);
      ctx.shadow.pos.copy(this.pos); ctx.shadow.up.copy(up); ctx.shadow.heights = this.heights;
      ctx.shadow.opacity = this._visible && this.state !== 'swim' && this.view !== 'fp' ? 0.42 * (1 - smoothstep(0.2, 4, hAbove)) : 0;
      ctx.shadow.size = 1.15;
      const tr = ctx.trails;
      tr.on = this.state === 'glide' && this.glide.s > 11.5 && this._visible && this.glider;
      tr.alpha = clamp((this.glide.s - 11) / 8, 0, 0.55);
      if (tr.on) {
        const gg = this.glider.group, c = this.glider.canopy;
        _m.multiplyMatrices(this.group.matrix, gg.matrix);
        for (const [s, out] of [[1, tr.a], [-1, tr.b]]) {
          out.set(s * 1.62 * c.scale.x, c.position.y - 0.6, -0.2).applyMatrix4(_m);
        }
      }
      fx.rebase(this.pos);
      safe(() => fx.update(dt, ctx));
    }
    // ---- audio params
    const au = this.engine?.audio;
    if (au?.setParam) {
      au.setParam('speed', this.speed);
      au.setParam('altitude', Math.max(0, this.pos.length() - this.heights.groundR(this.pos)));
      au.setParam('wind', clamp(this.state === 'glide' ? this.glide.s / 22 : this.state === 'air' ? this.vel.length() / 30 : this.speed / 40, 0, 1));
      au.setParam('glide', this.state === 'glide' ? 1 : 0);
      au.setParam('swim', this.state === 'swim' ? 1 : 0);
      au.setParam('boost', this.boostP);
    }
    // ---- contextual prompts (minimal)
    let pr = null;
    if (this.state === 'air' && this.airTime > 0.35 && this.pos.length() - this.heights.groundR(this.pos) > 5) pr = ['Glide', 'jump'];
    else if (this.state === 'glide') pr = ['Dive · Shift   Drop · C', 'sprint'];
    else if (this.state === 'climb') pr = ['Jump off · Space   Let go · C', 'jump'];
    else if (this.state === 'swim') pr = this.dive > 0.3 ? ['Surface · Space', 'jump'] : ['Dive · C', 'descend'];
    else if (this.state === 'ground' && this.groundN.dot(this.up) < 0.92 && this.speed > 2) pr = ['Slide · C', 'descend'];
    this._prompt(pr);
  }

  _prompt(pr) {
    const ui = this.engine?.ui;
    if (!ui?.prompt) return;
    const key = pr ? pr[0] : null;
    if (key === this._promptId) return;
    if (this._promptId) safe(() => ui.clearPrompt('player'));
    this._promptId = key;
    if (pr) safe(() => ui.prompt('player', pr[0], pr[1]));
  }
  _clearPrompt() { this._prompt(null); }

  // ======================================================================================= misc
  onOriginShift() { /* everything is planet-local; nothing to shift */ }

  getState() {
    const hg = this.heights.groundR(this.pos);
    return {
      view: this.view, state: this.state,
      alt: +(this.pos.length() - hg).toFixed(2),
      speed: +this.speed.toFixed(2),
      grounded: this.grounded,
      fuel: +this.jetFuel.toFixed(2),
      surface: this.surfaceKind,
      dive: +(this.dive || 0).toFixed(2),
      tris: this.rig?.triangles | 0,
      colliders: this.colliders.count,
    };
  }

  dispose() {
    this._clearPrompt();
    try {
      if (this.group) { this.world.root.remove(this.group); }
      if (this.rig) {
        for (const m of Object.values(this.rig.meshes)) m.geometry.dispose();
        for (const m of Object.values(this.rig.materials)) m.dispose();
        this.rig.skeleton?.dispose?.();
      }
      if (this._fallbackMesh) { this._fallbackMesh.geometry.dispose(); this._fallbackMesh.material.dispose(); }
      if (this.scarf) { this.world.root.remove(this.scarf.group); this.scarf.dispose(); }
      if (this.glider) this.glider.dispose();
      if (this.fx) { this.world.root.remove(this.fx.group); this.fx.dispose(); }
    } catch (e) { console.error('[player] dispose failed', e); }
  }
}
