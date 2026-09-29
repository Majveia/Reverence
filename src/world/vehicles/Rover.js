// ROVER — rugged expedition exocraft (Pacific Drive × NMS Roamer). Real rigid-body sim:
//   • 6-DOF body (mass, inertia tensor) integrated at 4× substeps
//   • raycast suspension per wheel against world.surface height (spring + damper + bump stop +
//     anti-roll bars) → natural weight transfer: nose dives under braking, squats on throttle,
//     leans in corners
//   • tire model with friction circle (combined slip), surface-dependent grip (sand, snow, rock,
//     wet), AWD torque split biased rear, handbrake (Space) that unlocks the rear for drifts,
//     counter-steer assist so slides stay controllable
//   • chassis contact points against the terrain (rolls over, high-centres, lands jumps)
//   • visual wheels (spin, steer, travel), animated coil-over shocks, dust / mud / splash from each
//     contact patch in the ground's own colour, exhaust puffs, brake/reverse lights, headlights +
//     volumetric beams + ground pools at night (E toggles)
import * as THREE from 'three';
import { Vehicle } from './Vehicle.js';
import { buildRover, ROVER } from './models/rover.js';
import { makePool, conformPool } from './fx/glow.js';
import { clamp, damp, dampF, smoothstep, orthoForward, quatFromFrame, FastRand, noise1, fmtSpeed } from './util.js';
import { G } from '../../core/Uniforms.js';
import { CockpitScreen } from './fx/screen.js';
import { TireTracks } from './fx/tracks.js';
import { tangentBasis } from './util.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _hp = new THREE.Vector3(), _cp = new THREE.Vector3(), _fw = new THREE.Vector3(), _sw = new THREE.Vector3();
const _F = new THREE.Vector3(), _T = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3();
const _up = new THREE.Vector3(), _bu = new THREE.Vector3(), _bf = new THREE.Vector3(), _br = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _col = new THREE.Color(), _p = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
const _se = new THREE.Vector3(), _sn = new THREE.Vector3();

const MASS = 1650;
const INERTIA = new THREE.Vector3(3400, 3700, 2300);   // body X (pitch), Y (yaw), Z (roll)
const K_SPRING = 52000, C_DAMP = 5200, K_BUMP = 260000, K_ARB = 30000;
const VMAX = 31, VBOOST = 43, VREV = 11;
const CHASSIS = [   // contact probes (body space): bottom + roof corners, bumpers
  [0.9, -0.2, 2.3], [-0.9, -0.2, 2.3], [0.9, -0.2, -2.3], [-0.9, -0.2, -2.3], [0, -0.35, 0],
  [0.95, 1.8, 0.7], [-0.95, 1.8, 0.7], [0.95, 1.8, -0.8], [-0.95, 1.8, -0.8], [0, 1.9, 0],
  [1.1, 0.6, 0], [-1.1, 0.6, 0],
];

export class Rover extends Vehicle {
  constructor(mgr, opts) {
    super(mgr, 'rover', opts);
    this.promptText = 'Drive';
    this.clearRadius = 2.8;
    this.displayName = 'Rover';
    this.inputScheme = 'vehicle';
    this.colliderRadius = 2.3;
    this.colliderLift = 0.5;
    this.enterRadius = 4.2;
    this.exitSide = 2.0;
    this.substeps = 4;
    this.angVel = new THREE.Vector3();
    this.restHeight = 0.95;
    this.steerAngle = 0; this.throttle = 0; this.brake = 0; this.handbrake = 0; this.steer = 0;
    this.lights = -1;          // -1 auto, 0 off, 1 on
    this.rand = new FastRand(9091);
    this.dustColor = new THREE.Color(0.6, 0.52, 0.4); this.dustSampleT = 0;
    this.grip = 1; this.surfaceKind = 'ground';
    this.wet = 0;
    this.gear = 1;
    this.airT = 0;
    this.flipT = 0;
    this.W = ROVER.hard.map(([x, y, z]) => ({
      hard: new THREE.Vector3(x, y, z), front: z > 0, side: Math.sign(x),
      s: ROVER.rest, comp: 0, prevComp: 0, contact: false, n: new THREE.Vector3(0, 1, 0), nT: 0,
      Fz: 0, vLong: 0, vLat: 0, slip: 0, spin: 0, spinRate: 0, cp: new THREE.Vector3(), sw: new THREE.Vector3(1, 0, 0), emit: 0,
    }));
  }

  startFromParams(p) {
    const v0 = p.speed !== undefined ? +p.speed : 0;
    if (v0 > 0) { this.vel.copy(this.fwdVec).multiplyScalar(v0); this.throttle = 1; }
  }

  build() {
    const mgr = this.mgr, liv = mgr.livery('rover');
    const mats = mgr.makeMaterials('rover', { panelScale: 0.55, dirtLow: -0.9, dirtHigh: 0.7, dirtMul: 1.35, rustMul: 1.2, seed: 5.1 });
    this.mats = mats;
    this.materials = [mats.body, mats.glow, mats.decal, mats.glass];
    const m = buildRover(mats, liv);
    this.model = m;
    this.group.add(m.root);
    this.tris = m.tris;
    m.rider.visible = false;
    this.tracks = this.mgr.quality.tier === 'low' ? null : new TireTracks(this.world, { strips: 4, max: this.mgr.quality.mobile ? 60 : 130, width: 0.36, life: 50 });
    this.headPool = makePool({ size: 26, color: [1.0, 0.9, 0.75], shape: [1.8, 0.4], segs: 10 });
    this.world.root.add(this.headPool);
    const sa = m.anchors.screen;
    this.screen = new CockpitScreen({ tint: [1.0, 0.75, 0.35], width: sa.w, height: sa.h, kind: 'rover' });
    this.screen.mesh.position.copy(sa.pos);
    this.screen.mesh.rotation.set(sa.ax, Math.PI, 0);
    m.root.add(this.screen.mesh);
    this.initCamera({
      dist: 7.4, height: 2.5, pivot: 1.25, lookAhead: 5, pitch: -0.1, fovBase: 60, fovSpeed: 12, fovBoost: 7,
      speedRef: 32, yawLag: 4.2, distSpeed: 0.18, heightSpeed: 0.1, roll: 0.0, shake: 0.85, clearance: 0.7,
      cockpitEye: m.anchors.eye.toArray(), cockpitFov: 74, cockpitPitch: 0.1, posLag: 12, recenter: 1.4, minDist: 5.5,
    });
    this.registerCollider();
  }

  onControlGained(prev) { super.onControlGained(prev); this.model.rider.visible = true; }
  onControlLost(next) {
    super.onControlLost(next);
    this.model.rider.visible = false;
    this.throttle = 0; this.handbrake = 1;
  }

  /** Settle onto the terrain after placement (spawn / summon). */
  settle() {
    this.angVel.set(0, 0, 0);
    for (let i = 0; i < 90; i++) this._step(1 / 240, null, true);
    this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
    this._syncFrame(); this.syncTransform();
  }

  canExit() { return this.speed < 6; }
  get exitHint() { return 'Slow down to get out'; }

  simulate(dt, input, last) {
    if (!(dt > 0)) return;
    const occ = this.occupied;
    // ---- controls (once per frame; simulate is called per substep, `last` on the final one)
    if (!this._ctlDone) {
      const mv = occ ? input.axis('move') : null;
      const thr = occ ? clamp(mv.y, -1, 1) : 0;
      const st = occ ? clamp(mv.x, -1, 1) : 0;
      const frameDt = dt * this.substeps;
      const vF = this.vel.dot(this.fwdVec);
      // throttle/brake/reverse logic (S brakes while rolling forward, then reverses)
      if (thr < -0.05 && vF > 1.2 && this.gear > 0) { this.brake = -thr; this.throttle = 0; }
      else if (thr > 0.05 && vF < -1.2 && this.gear < 0) { this.brake = thr; this.throttle = 0; }
      else {
        this.brake = 0;
        if (thr < -0.05 && vF <= 1.2) this.gear = -1;
        if (thr > 0.05 && vF >= -1.2) this.gear = 1;
        this.throttle = damp(this.throttle, Math.abs(thr) > 0.05 ? thr : 0, 7, frameDt);
      }
      this.handbrake = occ ? (input.held('jump') ? 1 : 0) : 1;
      const boostIn = occ && input.held('boost') && thr > 0.05 ? 1 : 0;
      this.boost = damp(this.boost, boostIn, boostIn ? 3 : 2, frameDt);
      const sp = Math.abs(vF);
      const maxSteer = 0.6 - 0.4 * clamp(sp / 30, 0, 1);
      // counter-steer assist: while the rear slides, steer toward the velocity direction
      let assist = 0;
      if (sp > 4) {
        const lat = this.vel.dot(this.rightVec);
        assist = clamp(Math.atan2(lat, sp) * 0.55, -0.35, 0.35);
      }
      this.steer = damp(this.steer, st, st === 0 ? 6 : 4.5, frameDt);
      const target = -this.steer * maxSteer - (occ ? assist : 0) * (1 - Math.abs(this.steer) * 0.5);
      this.steerAngle = damp(this.steerAngle, target, 6, frameDt);
      if (occ && input.down('interact')) this.lights = this.lights === 1 ? 0 : 1;
      this._ctlDone = true;
    }
    this._step(dt, input, false);
    if (last) this._ctlDone = false;
  }

  _surface(dt) {
    this.dustSampleT -= dt;
    if (this.dustSampleT > 0) return;
    this.dustSampleT = 0.3;
    const grd = this.ground;
    grd.dustColor(this.pos, this.dustColor);
    const s = grd.sample(this.pos);
    let grip = 1.0, kind = 'ground';
    if (s) {
      const sand = s.sand ?? 0, snow = s.snow ?? 0, rock = s.rock ?? 0;
      grip = 1.05 - sand * 0.28 - snow * 0.4 + rock * 0.05;
      kind = snow > 0.5 ? 'snow' : sand > 0.5 ? 'sand' : rock > 0.5 ? 'rock' : 'ground';
    }
    grip *= 1 - (G.uWetness.value || 0) * 0.18;
    // loose material under the tyres: sand/snow/dry soil kick up plumes, wet or paved ground barely any
    let dusty = s ? 0.3 + (s.sand ?? 0) * 0.9 + (s.dune ?? 0) * 0.3 + (s.snow ?? 0) * 0.6 + (1 - (s.moisture ?? 0.5)) * 0.45 : 0.7;
    dusty *= 1 - clamp(G.uWetness.value || 0, 0, 1) * 0.75;
    const C = this.world.civ?.clearings;
    if (C) {
      const l = this.pos.length() || 1, dx = this.pos.x / l, dy = this.pos.y / l, dz = this.pos.z / l;
      for (let i = 0; i < C.length; i++) { const c = C[i]; if (c && c[4] === 0 && dx * c[0] + dy * c[1] + dz * c[2] > c[3]) { dusty *= 0.2; break; } }
    }
    this.dusty = clamp(Number.isFinite(dusty) ? dusty : 0.7, 0.08, 1.3);
    this.grip = clamp(grip, 0.45, 1.15);
    this.surfaceKind = kind;
  }

  _step(h, input, settling) {
    const W = this.world, grd = this.ground, R = W.body.radius;
    const gAcc = clamp(W.body.gravity || 9.81, 2, 25);
    const pos = this.pos, vel = this.vel, q = this.quat, w = this.angVel;
    _up.copy(pos).normalize();
    _bu.set(0, 1, 0).applyQuaternion(q);
    _bf.set(0, 0, 1).applyQuaternion(q);
    _br.set(-1, 0, 0).applyQuaternion(q);
    _F.copy(_up).multiplyScalar(-MASS * gAcc);
    _T.set(0, 0, 0);
    if (!settling) this._surface(h);

    const r = ROVER.wheelR;
    const vF = vel.dot(_bf);
    const sp = vel.length();
    let contacts = 0, hgSum = 0;
    // engine: force available at the contact patches
    const vmax = this.gear > 0 ? VMAX + (VBOOST - VMAX) * this.boost : VREV;
    const vAbs = Math.abs(vF);
    const curve = clamp(1 - Math.pow(vAbs / vmax, 2.2), 0, 1) * (vAbs < 3 ? 1.25 : 1);
    const driveTotal = this.gear > 0 ? Math.max(0, this.throttle) * MASS * (6.2 + 3.5 * this.boost) * curve : -Math.max(0, -this.throttle) * MASS * 4.5 * curve;
    const coast = Math.abs(this.throttle) < 0.05 && this.brake < 0.05;
    const park = settling || (!this.occupied) || (coast && sp < 0.6);

    for (let i = 0; i < 4; i++) {
      const wh = this.W[i];
      _hp.copy(wh.hard).applyQuaternion(q).add(pos);
      // ground normal refreshed at ~30 Hz per wheel (cheap), height every substep
      wh.nT -= h;
      if (wh.nT <= 0) { wh.nT = 0.033 + i * 0.002; grd.normalAt(_hp, 0.7, wh.n, false); }
      const n = wh.n;
      const hg = grd.terrainH(_hp.x, _hp.y, _hp.z);
      hgSum += hg;
      const alt = _hp.length() - (R + hg);
      const planeDist = alt * clamp(n.dot(_up), 0.2, 1);
      const cosA = _bu.dot(n);
      wh.prevComp = wh.comp;
      let s = ROVER.rest, contact = false, bump = 0;
      if (cosA > 0.25) {
        const sr = (planeDist - r) / cosA;
        if (sr < ROVER.rest) {
          contact = true;
          s = sr;
          if (s < ROVER.bump) { bump = ROVER.bump - s; s = ROVER.bump; }
        }
      }
      wh.s = s; wh.contact = contact;
      wh.comp = ROVER.rest - s;
      if (!contact) { wh.Fz = 0; wh.vLat = 0; wh.slip = 0; wh.spinRate = damp(wh.spinRate, this.throttle * this.gear * 30, 1.5, h); continue; }
      contacts++;
      const compVel = clamp((wh.comp - wh.prevComp) / h, -12, 12);
      let Fs = K_SPRING * wh.comp + C_DAMP * compVel + K_BUMP * bump;
      if (Fs < 0) Fs = 0;
      // anti-roll bar (pair 0-1 front, 2-3 rear)
      const o = this.W[i ^ 1];
      Fs += (wh.comp - o.comp) * K_ARB;
      if (Fs < 0) Fs = 0;
      wh.Fz = Fs;
      // suspension force along the body up at the hard point
      _a.copy(_bu).multiplyScalar(Fs);
      _F.add(_a);
      _b.copy(_hp).sub(pos); _T.add(_c.crossVectors(_b, _a));
      // contact patch & its velocity
      _cp.copy(_hp).addScaledVector(_bu, -s).addScaledVector(n, -r);
      wh.cp.copy(_cp);
      _b.copy(_cp).sub(pos);
      _d.crossVectors(w, _b).add(vel);                 // velocity at the patch
      // wheel frame on the ground plane
      _fw.copy(_bf);
      if (wh.front) _fw.applyAxisAngle(_bu, this.steerAngle);
      orthoForward(n, _fw, _fw);
      _sw.crossVectors(n, _fw).normalize();             // points to model +X (left)
      wh.sw.copy(_sw);
      const vLong = _d.dot(_fw), vLat = _d.dot(_sw);
      wh.vLong = vLong; wh.vLat = vLat;
      const mu = this.grip * (this.surfaceKind === 'rock' ? 1.0 : 1.0);
      const muMax = mu * Fs;
      // longitudinal
      let Fx = 0;
      const rearHB = !wh.front && this.handbrake > 0.5;
      if (park) {
        Fx = clamp(-vLong * MASS * 0.25 / h * 0.25, -muMax, muMax);
      } else if (rearHB) {
        Fx = clamp(-vLong * 900, -muMax * 0.8, muMax * 0.8);
      } else if (this.brake > 0.02) {
        const Fb = MASS * 11 * this.brake * (wh.front ? 0.3 : 0.2);
        Fx = clamp(-vLong * 1500, -Fb, Fb);
      } else {
        Fx = driveTotal * (wh.front ? 0.2 : 0.3);
        if (coast) Fx += clamp(-vLong * 55, -900, 900);       // engine braking + rolling resistance
        else Fx -= vLong * 8;
      }
      // lateral: linear stiffness saturating at the friction limit; the rear lets go when handbraking
      let latMu = mu * (rearHB ? 0.38 : 1.0);
      if (!wh.front && !park && Math.abs(vLat) > 2.5) latMu *= 0.86;         // kinetic < static → sustained drifts
      if (!wh.front && this.throttle > 0.6 && Math.abs(this.steer) > 0.5 && sp > 8) latMu *= 0.9;  // power oversteer
      const Cs = park ? MASS * 0.2 / h * 0.25 : 15500;
      let Fy = clamp(-vLat * Cs, -latMu * Fs, latMu * Fs);
      // friction circle
      const lim = Math.max(muMax, 1e-3) * (rearHB ? 0.9 : 1.05);
      const mag = Math.hypot(Fx, Fy);
      let spinExtra = 0;
      if (mag > lim) {
        const k = lim / mag;
        if (Math.abs(Fx) > Math.abs(Fy) && !park) spinExtra = (1 - k) * Math.sign(Fx) * 14;
        Fx *= k; Fy *= k;
      }
      wh.slip = clamp(Math.abs(vLat) * 0.18 + Math.abs(spinExtra) * 0.08 + (rearHB ? Math.abs(vLong) * 0.05 : 0), 0, 1.5);
      // visual wheel spin rate (rad/s)
      const roll = rearHB ? 0 : vLong / r + spinExtra;
      wh.spinRate = roll;
      _a.copy(_fw).multiplyScalar(Fx).addScaledVector(_sw, Fy);
      _F.add(_a);
      // apply between the patch and the hard point (lower effective roll centre → less tippy)
      _b.copy(_cp).lerp(_hp, 0.8).sub(pos);
      _T.add(_c.crossVectors(_b, _a));
    }
    this.contacts = contacts;

    const hgAvg = hgSum * 0.25;
    // arcade stability: resist roll-overs while any wheel is on the ground (keeps drifts playful)
    if (contacts > 0 && !settling) {
      _d.set(0, 0, 0);
      for (const wh of this.W) _d.add(wh.n);
      _d.normalize();                                              // mean ground normal under the wheels
      const roll = Math.asin(clamp(_br.dot(_d), -1, 1));          // − = right side down
      const pitch = Math.asin(clamp(_bf.dot(_d), -1, 1));         // + = nose up
      const rr = w.dot(_bf), pr = w.dot(_br);
      const kR = clamp((Math.abs(roll) - 0.12) / 0.4, 0, 1), kP = clamp((Math.abs(pitch) - 0.35) / 0.4, 0, 1);
      _T.addScaledVector(_bf, Math.sign(roll) * kR * MASS * gAcc * 1.1 - rr * 2600);
      _T.addScaledVector(_br, -Math.sign(pitch) * kP * MASS * gAcc * 0.5 - pr * 900 * kP);
    }
    // chassis vs terrain (roof, bumpers): penalty contacts with friction
    for (let k = 0; k < CHASSIS.length; k++) {
      const c = CHASSIS[k];
      _p.set(c[0], c[1], c[2]).applyQuaternion(q).add(pos);
      // cheap reject against the local ground plane estimate from the wheels (saves ~48 height queries/frame)
      if (_p.length() - (R + hgAvg) > 0.9) continue;
      const hg = grd.terrainH(_p.x, _p.y, _p.z);
      const depth = R + hg - _p.length();
      if (depth <= 0) continue;
      _b.copy(_p).sub(pos);
      _d.crossVectors(w, _b).add(vel);
      _a.copy(_p).normalize();
      const vn = _d.dot(_a);
      let fn = 180000 * depth - 9000 * vn;
      if (fn < 0) fn = 0;
      _c.copy(_d).addScaledVector(_a, -vn);                   // tangential velocity
      const vt = _c.length();
      const ft = Math.min(fn * 0.6, vt * 4000);
      _a.multiplyScalar(fn);
      if (vt > 1e-3) _a.addScaledVector(_c, -ft / vt);
      _F.add(_a); _T.add(_c.crossVectors(_b, _a));
      if (vn < -4 && !settling) { this.camera?.kick(Math.min(1.4, -vn * 0.06)); this.mgr.sparksAt(_p, _up, 10); this.mgr.audio('play', 'impact', { intensity: clamp(-vn / 14, 0, 1) }); }
    }

    // water: buoyancy + heavy drag when wading
    if (grd.hasOcean) {
      const wl = grd.waterAt(pos);
      const sub = R + wl - (pos.length() - 0.4);
      this.inWater = sub > 0;
      if (sub > 0) {
        const k = clamp(sub / 1.6, 0, 1);
        _F.addScaledVector(_up, MASS * gAcc * 0.85 * k);
        _F.addScaledVector(vel, -MASS * 0.9 * k);
        w.multiplyScalar(Math.exp(-2 * k * h));
      }
    }

    // air control: pitch/roll with the sticks while all wheels are off the ground
    if (contacts === 0 && !settling) {
      // airborne: gently self-level toward the local vertical (arcade: land on the wheels), and let
      // the stick pitch the nose / yaw the body a little for style
      _c.crossVectors(_bu, _up);
      const ang = Math.asin(clamp(_c.length(), 0, 1)) + (_bu.dot(_up) < 0 ? Math.PI * 0.5 : 0);
      if (_c.lengthSq() > 1e-8) _c.normalize().multiplyScalar(ang * INERTIA.z * 2.2);
      _T.add(_c).addScaledVector(w, -INERTIA.z * 1.2);
      if (this.occupied && input) {
        const mv = input.axis('move');
        _T.addScaledVector(_br, -mv.y * INERTIA.x * 0.8).addScaledVector(_up, -mv.x * INERTIA.y * 0.9);
      }
    }
    // aerodynamic drag + mild angular damping
    _F.addScaledVector(vel, -0.9 * sp - 12);
    // integrate linear
    vel.addScaledVector(_F, h / MASS);
    // angular: world torque → body → / I → world
    _qi.copy(q).invert();
    _a.copy(_T).applyQuaternion(_qi);
    _a.set(_a.x / INERTIA.x, _a.y / INERTIA.y, _a.z / INERTIA.z).applyQuaternion(q);
    w.addScaledVector(_a, h);
    w.multiplyScalar(Math.exp(-(contacts ? 0.6 : 0.15) * h));
    if (w.lengthSq() > 400) w.setLength(20);
    pos.addScaledVector(vel, h);
    // quaternion integration
    _q.set(w.x * h * 0.5, w.y * h * 0.5, w.z * h * 0.5, 0).multiply(q);
    q.set(q.x + _q.x, q.y + _q.y, q.z + _q.z, q.w + _q.w).normalize();

    // static colliders (trees, rocks, buildings): three spheres along the body
    if (!settling) for (const off of [1.7, 0, -1.7]) this._collide(off);

    if (!Number.isFinite(pos.x + vel.x + w.x + q.w)) this._recover();
    else if (!settling) { this._good ||= { p: new THREE.Vector3(), q: new THREE.Quaternion() }; this._good.p.copy(pos); this._good.q.copy(q); }
    this.speed = vel.length();
    this._syncFrame();
    this.airT = contacts === 0 ? this.airT + h : 0;
    // self-righting when stuck on the roof / side (hold throttle or wait)
    if (!settling) {
      const tilt = _bu.dot(_up);
      if (tilt < 0.3 && this.speed < 2) {
        this.flipT += h;
        if (this.flipT > 2.2) {
          this.flipT = 0;
          orthoForward(_up, _bf, _f);
          quatFromFrame(_up, _f, q);
          pos.addScaledVector(_up, 1.6);
          w.set(0, 0, 0);
          this.mgr.audio('play', 'whoosh', { intensity: 0.4 });
        }
      } else this.flipT = 0;
    }
    // sleep when parked & settled
    if (!this.occupied && !settling) {
      if (this.speed < 0.05 && w.lengthSq() < 0.002) { this.sleepT += h; if (this.sleepT > 2.5) { this.awake = false; this.vel.set(0, 0, 0); w.set(0, 0, 0); } }
      else this.sleepT = 0;
    }
  }

  _recover() {
    // numerical blow-up guard: restore the last good pose, upright, at rest
    const g = this._good;
    if (g) { this.pos.copy(g.p); this.quat.copy(g.q); } else if (this.mgr.spawn) this.pos.copy(this.mgr.spawn.pos);
    this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
    for (const wh of this.W) { wh.comp = wh.prevComp = 0; }
    if (!Number.isFinite(this.quat.w)) this.quat.identity();
  }

  _collide(off) {
    const cg = this.mgr.colliders;
    const p = _p.copy(this.pos).addScaledVector(this.fwdVec, off).addScaledVector(this.upVec, 0.5);
    const c = cg.sphere(p, 1.15);
    if (!c) return;
    this.pos.addScaledVector(c.normal, c.depth);
    const vn = this.vel.dot(c.normal);
    if (vn < 0) {
      this.vel.addScaledVector(c.normal, -vn * 1.25);
      this.vel.multiplyScalar(0.9);
      // yaw kick from off-centre impacts
      this.angVel.addScaledVector(this.upVec, -vn * 0.04 * Math.sign(off || 1) * Math.sign(c.normal.dot(this.rightVec)));
      if (vn < -4) { this.camera?.kick(Math.min(1.5, -vn * 0.07)); this.mgr.sparksAt(p.addScaledVector(c.normal, -1.0), c.normal, 16); this.mgr.audio('play', 'impact', { intensity: clamp(-vn / 18, 0, 1) }); }
    }
  }

  animate(dt, t) {
    const m = this.model, ch = this.mats.glow.userData.ch, sch = m.sprites?.userData.ch;
    const occ = this.occupied, night = G.uNight.value;
    const lightsOn = this.lights === 1 || (this.lights === -1 && occ && night > 0.35);
    // glow channels: 1 markers, 2 brake/tail, 3 headlights, 4 accent, 5 reverse, 6 dash, 7 light bar
    ch[0] = 1;
    ch[1] = occ ? (Math.sin(t * 4.2) > 0.2 ? 1.2 : 0.35) : 0.15;
    ch[2] = occ ? (this.brake > 0.05 || this.handbrake > 0.5 ? 2.2 : lightsOn ? 0.8 : 0.35) : 0.12;
    ch[3] = lightsOn ? 1.6 : occ ? 0.55 : 0.12;
    ch[4] = occ ? 0.9 + this.boost * 0.8 : 0.3;
    ch[5] = occ && this.gear < 0 ? 1.4 : 0.05;
    ch[6] = occ ? 1.0 : 0.15;
    ch[7] = lightsOn ? 1.5 : 0.08;
    if (sch) { sch[1] = ch[1] * (0.3 + night); sch[2] = ch[2] * (0.25 + night * 0.9); sch[3] = ch[3] * (0.12 + night); sch[7] = ch[7] * (0.1 + night); }
    for (let i = 0; i < m.beams.length; i++) m.beams[i].material.uniforms.uPower.value = lightsOn ? (0.12 + night * 0.4) * (i === 2 ? 0.7 : 1) : 0;
    for (const b of m.beams) b.visible = lightsOn;
    // wheels: suspension travel, steering, spin; shocks follow the hubs
    const r = ROVER.wheelR;
    for (let i = 0; i < 4; i++) {
      const wh = this.W[i], mw = m.wheels[i];
      mw.group.position.set(wh.hard.x, wh.hard.y - wh.s, wh.hard.z);
      mw.group.rotation.y = wh.front ? this.steerAngle : 0;
      wh.spin += wh.spinRate * dt;
      if (wh.spin > 1e4 || wh.spin < -1e4) wh.spin %= Math.PI * 2;
      mw.spin.rotation.x = wh.spin;
      const sh = m.shocks[i];
      _a.set(wh.hard.x * 0.86, wh.hard.y - wh.s + 0.05, wh.hard.z);
      _b.copy(sh.mount).sub(_a);
      const len = _b.length();
      sh.mesh.position.copy(_a);
      sh.mesh.quaternion.setFromUnitVectors(_Y, _b.divideScalar(len));
      sh.mesh.scale.set(1, len, 1);
    }
    void r;
    // body shake on rough ground feeds the camera
    let rough = 0;
    for (const wh of this.W) rough += Math.abs(wh.comp - wh.prevComp) * 60;
    this.rough = clamp(rough * 0.25, 0, 1) * clamp(this.speed / 12, 0, 1);
    this.engine = clamp(0.2 + Math.abs(this.throttle) * 0.6 + this.boost * 0.25 + (this.W[2].slip + this.W[3].slip) * 0.1, 0, 1);
    // headlight pool on the ground ahead
    const hk = lightsOn ? smoothstep(0.2, 0.7, night) : 0;
    this.headPool.visible = hk > 0.01 && this.visible;
    if (this.headPool.visible) {
      const grd = this.ground, R = this.world.body.radius;
      _p.copy(this.pos).addScaledVector(this.fwdVec, 11);
      const hh = grd.supportAt(_p);
      this.headPool.position.copy(_p).normalize().multiplyScalar(R + hh + 0.1);
      grd.normalAt(_p, 3, _a, true);
      orthoForward(_a, this.fwdVec, _f);
      quatFromFrame(_a, _f, this.headPool.quaternion);
      conformPool(this.headPool, grd, R);
      this.headPool.material.uniforms.uPower.value = hk * 0.75;
    }
    if (m.rider.visible) m.rider.rotation.z = clamp(this.angVel.dot(this.upVec) * 0.05, -0.08, 0.08);
    this.screen?.update(dt, occ && this.distToCam < 30, this._screenData());
    this._tracks(dt);
    this._fx(dt, t);
  }

  _fx(dt) {
    if (!this.visible || this.distToCam > 250) return;
    const mgr = this.mgr, rnd = this.rand, up = this.radialUp;
    const q = mgr.quality.particleScale ?? 1;
    const water = this.inWater;
    for (let i = 0; i < 4; i++) {
      const wh = this.W[i];
      if (!wh.contact) continue;
      const slip = wh.slip;
      const sp = Math.abs(wh.vLong);
      const surf = this.surfaceKind === 'rock' ? 0.25 : this.surfaceKind === 'sand' ? 1.3 : this.surfaceKind === 'snow' ? 1.0 : 0.55;
      const rate = (sp * 0.3 + slip * 22 + (sp > 4 ? 1 : 0)) * q * surf * (wh.front ? 0.6 : 1) * (water ? 1 : (this.dusty ?? 0.7));
      wh.emit += dt * rate;
      while (wh.emit >= 1) {
        wh.emit -= 1;
        const gp = _c.copy(wh.cp).addScaledVector(up, 0.12).addScaledVector(this.fwdVec, -0.3);
        const back = -(0.25 + rnd.next() * 0.3);
        const lift = 0.8 + rnd.next() * 1.8 + slip * 2.5;
        const side = rnd.signed() * (1.2 + slip * 2);
        const vx = this.vel.x * back + up.x * lift + this.rightVec.x * side;
        const vy = this.vel.y * back + up.y * lift + this.rightVec.y * side;
        const vz = this.vel.z * back + up.z * lift + this.rightVec.z * side;
        if (water) {
          _col.setRGB(0.82, 0.88, 0.92);
          mgr.fx.spray.spawn(gp.x, gp.y, gp.z, vx + up.x * 3, vy + up.y * 3, vz + up.z * 3, { life: 0.8 + rnd.next() * 0.6, size0: 0.3, size1: 1.8, alpha: 0.55, color: _col, drag: 1.0, grav: 8, rot: rnd.next() * 6, ground: wh.cp.length() });
        } else {
          _col.copy(this.dustColor).multiplyScalar(0.85 + rnd.next() * 0.3);
          mgr.fx.dust.spawn(gp.x, gp.y, gp.z, vx, vy, vz, { life: 1.2 + rnd.next() * 1.4 + slip, size0: 0.3, size1: 1.6 + sp * 0.05 + slip * 2.2, alpha: 0.26 + slip * 0.18, color: _col, drag: 1.4, grav: -0.15, rot: rnd.next() * 6, rotSpeed: rnd.signed() * 0.5, ground: wh.cp.length() });
        }
      }
    }
    // exhaust puffs
    if (this.occupied) {
      this.exT = (this.exT || 0) + dt * (2 + this.throttle * 10 + this.boost * 8) * q;
      while (this.exT >= 1) {
        this.exT -= 1;
        _p.copy(this.model.anchors.exhaust).applyQuaternion(this.quat).add(this.pos);
        _col.setRGB(0.22, 0.21, 0.2);
        mgr.fx.dust.spawn(_p.x, _p.y, _p.z, this.vel.x * 0.6 - this.fwdVec.x * 1.5 + up.x * 0.5, this.vel.y * 0.6 - this.fwdVec.y * 1.5 + up.y * 0.5, this.vel.z * 0.6 - this.fwdVec.z * 1.5 + up.z * 0.5,
          { life: 0.9 + rnd.next() * 0.8, size0: 0.1, size1: 0.6 + this.throttle * 0.5, alpha: 0.13 + this.throttle * 0.1, color: _col, drag: 1.5, grav: -0.6, rot: rnd.next() * 6 });
      }
    }
  }

  _tracks(dt) {
    const tr = this.tracks;
    if (!tr) return;
    const kind = this.surfaceKind;
    const base = kind === 'sand' ? 0.75 : kind === 'snow' ? 0.8 : kind === 'rock' ? 0.12 : 0.45;
    tr.mat.uniforms.uOpacity.value = 0.6;
    tr.color.copy(this.dustColor).multiplyScalar(kind === 'snow' ? 0.62 : 0.42);
    const moving = this.speed > 0.4 && this.awake;
    for (let i = 0; i < 4; i++) {
      const wh = this.W[i];
      if (!wh.contact || this.inWater || !moving) { if (!moving) continue; tr.cut(i); continue; }
      _p.copy(wh.cp).addScaledVector(this.radialUp, 0.045);
      tr.push(i, _p, wh.sw, clamp(base + wh.slip * 0.35, 0, 1));
    }
    tr.update(dt);
  }

  telemetry() {
    return { speed: fmtSpeed(this.speed), gear: this.gear < 0 ? 'R' : 'D', grip: this.surfaceKind };
  }

  getState() {
    return {
      ...super.getState(), contacts: this.contacts, gear: this.gear, steer: +this.steerAngle.toFixed(2),
      comp: this.W.map((w) => +w.comp.toFixed(2)), tilt: +this.upVec.dot(this.radialUp).toFixed(3), surface: this.surfaceKind,
    };
  }

  _screenData() {
    const up = this.radialUp, f = this.fwdVec;
    tangentBasis(up, _se, _sn);
    const d = this._sd ||= {};
    d.speed = this.speed; d.throttle = Math.abs(this.throttle); d.boost = this.boost; d.engine = this.engine;
    d.heading = Math.atan2(f.dot(_se), f.dot(_sn));
    d.pitch = Math.asin(clamp(f.dot(up), -1, 1));
    d.bank = Math.asin(clamp(-this.rightVec.dot(up), -1, 1));
    d.surface = this.surfaceKind; d.status = this.gear < 0 ? 'REVERSE' : this.handbrake > 0.5 && this.occupied ? 'HANDBRAKE' : '';
    return d;
  }

  dispose() {
    this.screen?.dispose();
    this.tracks?.dispose();
    this.headPool?.removeFromParent(); this.headPool?.geometry.dispose(); this.headPool?.material.dispose();
    for (const b of this.model?.beams || []) { b.geometry.dispose(); b.material.dispose(); }
    super.dispose();
  }
}

export { noise1, dampF };
