// STARSHIP — NMS-style explorer: land anywhere, VTOL take-off, atmospheric flight with lift/drag
// feel, climb to orbit, pulse drive across the system (arrives at other planets/moons via a
// seamless world switch), reentry heat, contrails, engine plumes, chase + cockpit cameras.
//
// Flight model (arcade-physical):
//   • virtual-stick steering (mouse / right stick / touch drag) → pitch & yaw rates, A/D roll,
//     W/S throttle, Space/C vertical thrusters, Shift afterburner (atmosphere) / pulse (space)
//   • atmosphere density ρ(alt) drives aerodynamic grip (velocity follows the nose), wing lift
//     (support ∝ v² and attitude), energy trade (climbing bleeds speed, diving gains it),
//     over-speed drag ∝ ρv² → reentry deceleration + blackbody heat on windward surfaces
//   • auto-bank into turns and horizon auto-level in atmosphere; hover hold near the ground
//   • gear auto-deploys low & slow; touch down gently to land (aligns to the ground normal)
//   • space: flight assist, pulse drive speed scales with distance to the nearest body
import * as THREE from 'three';
import { Vehicle } from './Vehicle.js';
import { buildShip, SHIP } from './models/ship.js';
import { makeFlame, makePool } from './fx/glow.js';
import { Ribbon } from './fx/trails.js';
import { clamp, damp, dampF, smoothstep, orthoForward, quatFromFrame, FastRand, noise1, fmtSpeed, fmtDist } from './util.js';
import { Celestial } from '../Celestial.js';
import { G } from '../../core/Uniforms.js';
import { CockpitScreen } from './fx/screen.js';
import { tangentBasis } from './util.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _up = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3();
const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _col = new THREE.Color();
const _se = new THREE.Vector3(), _sn = new THREE.Vector3();

// hull probes (object space) for terrain contact; gear pads handled separately
const HULL = [[0, -0.1, 7.3], [0, 0.3, -6.3], [7.2, -0.4, -3.5], [-7.2, -0.4, -3.5], [2.75, -0.9, -1.9], [-2.75, -0.9, -1.9],
  [0, -0.8, 0], [0, 3.0, -5.6], [0, 1.9, 2.4]];
const PADS = [[0, SHIP.gearY, 4.6], [2.75, SHIP.gearY, -2.9], [-2.75, SHIP.gearY, -2.9]];

export class Starship extends Vehicle {
  constructor(mgr, opts) {
    super(mgr, 'ship', opts);
    this.promptText = 'Board';
    this.clearRadius = 8.5;
    this.displayName = 'Starship';
    this.inputScheme = 'flight';
    this.colliderRadius = 5.5;
    this.colliderLift = 0.3;
    this.enterRadius = 7.5;
    this.substeps = 2;
    this.cullDist = 60000;
    this.parkCull = 5000;
    this.restHeight = -SHIP.gearY;
    this.state = 'landed';
    this.gearT = 1;
    this.throttle = 0;
    this.stick = new THREE.Vector2();
    this.rate = new THREE.Vector3();
    this.pulse = 0; this.pulseHold = 0; this.pulseSpeed = 0; this.pulseOn = false;
    this.heat = 0; this.rho = 1; this.alt = 0; this.agl = 0;
    this.hover = 1; this.vtol = 0; this.boost = 0;
    this.horizon = 1;
    this.rand = new FastRand(777);
    const atm = this.world.body.atmosphere;
    this.atmoH = atm?.present ? Math.max(2000, atm.height || this.world.body.radius * 0.12) : 0;
    this.nearest = null; this.nearestD = Infinity; this.scanT = 0; this.travelling = false;
    this.dustT = 0; this.dustColor = new THREE.Color(0.6, 0.52, 0.4); this.dustSampleT = 0;
  }

  build() {
    const mgr = this.mgr, liv = mgr.livery('ship');
    const mats = mgr.makeMaterials('ship', { panelScale: 0.9, dirtLow: -2.5, dirtHigh: -0.6, dirtMul: 0.7, seed: 7.7 });
    this.mats = mats;
    this.materials = [mats.body, mats.glow, mats.decal, mats.glass];
    const m = buildShip(mats, liv);
    this.model = m;
    this.group.add(m.root);
    this.tris = m.tris;
    m.rider.visible = false;
    const g = liv.glow;
    // main engine plumes (cones along -Z)
    this.flames = m.anchors.nozzles.map((p, i) => {
      const f = makeFlame({ core: [g[0] * 2 + 1.5, g[1] * 2 + 1.5, g[2] * 2 + 1.5], outer: [g[0] * 0.7, g[1] * 0.7, g[2] * 0.8], diamonds: 1.2, seed: i * 2.3 + 0.7 }, G.uTime);
      f.position.copy(p);
      const r = m.anchors.nozzleR[i];
      f.userData.r = r;
      f.scale.set(r * 0.9, r * 0.9, r * 3);
      m.root.add(f);
      return f;
    });
    // VTOL jets pointing down
    this.vtolFlames = m.anchors.vtol.map((p, i) => {
      const f = makeFlame({ core: [g[0] * 1.5 + 1, g[1] * 1.5 + 1, g[2] * 1.5 + 1], outer: [g[0] * 0.5, g[1] * 0.5, g[2] * 0.6], diamonds: 0.6, seed: i * 5.1 + 3 }, G.uTime);
      f.position.copy(p);
      f.rotation.x = -Math.PI / 2;          // -Z → -Y
      f.scale.set(0.45, 0.45, 1.6);
      m.root.add(f);
      return f;
    });
    // reentry plasma sheath (bow shock) — a flame cone flipped to point forward over the nose
    this.plasma = makeFlame({ core: [3.2, 1.4, 0.6], outer: [1.6, 0.25, 0.35], diamonds: 0, seed: 9.1, radial: 24 }, G.uTime);
    this.plasma.rotation.y = Math.PI;
    this.plasma.position.set(0, 0.2, -3.0);
    this.plasma.scale.set(6.5, 4.2, 11.5);
    this.plasma.visible = false;
    m.root.add(this.plasma);
    // thruster wash on the ground
    this.pool = makePool({ size: 22, color: [g[0] * 0.8, g[1] * 0.8, g[2] * 0.8], shape: [1.3, 0] });
    this.world.root.add(this.pool);
    this.landPool = makePool({ size: 18, color: [1.0, 0.95, 0.85], shape: [1.4, 0.3] });
    this.world.root.add(this.landPool);
    // contrails (wing tips) + engine trails
    const q = mgr.quality;
    const n = q.mobile ? 36 : 64;
    this.trails = [
      new Ribbon(this.world, { max: n, color: [0.92, 0.95, 1.0], additive: false, life: 3.5, minDist: 6, name: 'ship-contrail-l' }),
      new Ribbon(this.world, { max: n, color: [0.92, 0.95, 1.0], additive: false, life: 3.5, minDist: 6, name: 'ship-contrail-r' }),
      new Ribbon(this.world, { max: n, color: [g[0] * 1.2, g[1] * 1.2, g[2] * 1.2], additive: true, life: 1.6, minDist: 5, name: 'ship-engine-trail-l' }),
      new Ribbon(this.world, { max: n, color: [g[0] * 1.2, g[1] * 1.2, g[2] * 1.2], additive: true, life: 1.6, minDist: 5, name: 'ship-engine-trail-r' }),
    ];
    const sa = m.anchors.screen;
    this.screen = new CockpitScreen({ tint: [0.35, 0.9, 1.0], width: sa.w, height: sa.h, kind: 'ship' });
    this.screen.mesh.position.copy(sa.pos);
    this.screen.mesh.rotation.set(sa.ax, Math.PI, 0);
    m.root.add(this.screen.mesh);
    this.initCamera({
      orbit: true, dist: 17.5, height: 4.4, pivot: 1.6, lookAhead: 10, pitch: -0.07, fovBase: 60, fovSpeed: 14, fovBoost: 12,
      speedRef: 220, rotLag: 4.2, distSpeed: 0.16, distBoost: 0.08, heightSpeed: 0.05, roll: 0, shake: 0.8, clearance: 1.5, posLag: 10,
      horizonBlend: () => this.horizon, aimHeight: 0.8, recenter: 1.6,
      cockpitEye: m.anchors.eye.toArray(), cockpitFov: 72, cockpitPitch: 0.05,
    });
    this.registerCollider();
  }

  // --------------------------------------------------------------------------- lifecycle
  onControlGained(prev) { super.onControlGained(prev); this.model.rider.visible = true; this.stick.set(0, 0); }
  onControlLost(next) {
    super.onControlLost(next);
    this.model.rider.visible = false;
    this.throttle = 0; this.pulseOn = false; this.pulse = 0;
    for (const t of this.trails) t.reset();
  }

  settle() {
    this.state = 'landed'; this.gearT = 1;
    this._landPose(1);
  }

  startFromParams(p) {
    const alt = p.alt !== undefined ? +p.alt : 0;
    if (!(alt > 3)) return;
    const R = this.world.body.radius;
    const up = _up.copy(this.pos).normalize();
    const h = this.ground.supportAt(this.pos);
    this.pos.copy(up).multiplyScalar(R + Math.max(h, 0) + alt);
    orthoForward(up, this.fwdVec, _f);
    quatFromFrame(up, _f, this.quat);
    if (p.pitch !== undefined && p.view === 'ship') {
      _q.setFromAxisAngle(_a.set(1, 0, 0), -(+p.pitch || 0) * Math.PI / 180);
      this.quat.multiply(_q);
    }
    this.state = 'flying';
    this.gearT = 0;
    const space = this.atmoH <= 0 || alt > this.atmoH;
    this.throttle = space ? 0.25 : 0.65;
    const v0 = p.speed !== undefined ? +p.speed : space ? 0 : 150;
    this._syncFrame();
    this.vel.copy(this.fwdVec).multiplyScalar(v0);
    if (p.pulse && space) { this.pulseOn = true; this.pulse = 1; this.pulseSpeed = +p.pulse > 10 ? +p.pulse : 20000; }
    this.syncTransform();
  }

  canExit() { return this.state === 'landed' || (this.speed < 3 && this.agl < 5); }
  get exitHint() { return 'Land first (hold C near the ground)'; }
  exitPoint(out) {
    // beside the nose, clear of the port nacelle and wing
    return out.copy(this.pos).addScaledVector(this.rightVec, -3.4).addScaledVector(this.fwdVec, 3.6);
  }

  // --------------------------------------------------------------------------- physics
  _rho(alt) {
    if (this.atmoH <= 0) return 0;
    const d = this.world.body.atmosphere?.density ?? 1;
    return clamp(d, 0.2, 2) * Math.exp(-Math.max(alt, 0) / (this.atmoH * 0.26)) * smoothstep(this.atmoH, this.atmoH * 0.8, alt);
  }

  _landPose(k) {
    const grd = this.ground, R = this.world.body.radius;
    const up = _up.copy(this.pos).normalize();
    grd.normalAt(this.pos, 5, _n, true);
    _n.lerp(up, 0.35).normalize();
    orthoForward(_n, this.fwdVec, _f);
    quatFromFrame(_n, _f, _q);
    this.quat.slerp(_q, k);
    // put the gear pads on the support surface (highest pad wins)
    let hMax = -Infinity;
    for (const pd of PADS) {
      _p.set(pd[0], 0, pd[2]).applyQuaternion(this.quat).add(this.pos);
      const h = grd.supportAt(_p);
      hMax = Math.max(hMax, h);
    }
    const h0 = grd.supportAt(this.pos);
    const hh = Math.max(h0, hMax - 0.35);
    this.pos.copy(up).multiplyScalar(R + hh - SHIP.gearY);
    this.vel.set(0, 0, 0); this.rate.set(0, 0, 0);
    this._syncFrame();
  }

  simulate(dt, input, last) {
    if (!(dt > 0)) return;
    const W = this.world, grd = this.ground, R = W.body.radius;
    const occ = this.occupied;
    const pos = this.pos, vel = this.vel;
    const up = _up.copy(pos).normalize();
    const r = pos.length();
    this.alt = r - R;
    const hS = grd.supportAt(pos);
    this.agl = this.alt - hS;
    const rho = this.rho = this._rho(this.alt);
    const space = this.atmoH <= 0 ? this.alt > 1500 : this.alt > this.atmoH;
    const g = clamp(W.body.gravity || 9.81, 1, 30) * (R / r) * (R / r);
    const speed = vel.length();

    // ---- inputs
    let thrIn = 0, rollIn = 0, asc = 0, desc = 0, boostHeld = false, lookX = 0, lookY = 0;
    if (occ && input) {
      const mv = input.axis('move');
      thrIn = mv.y; rollIn = mv.x;
      asc = input.held('ascend') ? 1 : 0;
      desc = input.held('descend') ? 1 : 0;
      boostHeld = input.held('boost');
      if (this._lookFrame !== W.engine?.time?.frame) {       // look deltas are per frame, not per substep
        this._lookFrame = W.engine?.time?.frame;
        const lk = input.axis('look');
        lookX = lk.x; lookY = lk.y;
      }
    }
    // landing gear target
    const wantGear = this.state === 'landed' || (this.agl < 45 && speed < 70) || (desc && this.agl < 90 && speed < 90);
    this.gearT = clamp(this.gearT + (wantGear ? dt : -dt) * 0.9, 0, 1);

    if (this.state === 'landed') {
      this.boost = damp(this.boost, 0, 3, dt);
      this.pulse = 0; this.pulseOn = false;
      this.throttle = 0;
      this.hover = damp(this.hover, 0, 2, dt);
      this.vtol = damp(this.vtol, 0, 3, dt);
      if (occ && input) {
        // taxi-turn on the spot, lift off with Space / W / boost
        if (Math.abs(rollIn) > 0.1) { _q.setFromAxisAngle(this.upVec, -rollIn * 0.6 * dt); this.quat.premultiply(_q); }
        if (asc || thrIn > 0.3 || boostHeld) {
          this.state = 'flying';
          vel.copy(up).multiplyScalar(5.5);
          this.throttle = thrIn > 0.3 ? 0.12 : 0;
          this.mgr.audio('play', 'takeoff', {});
          this.camera?.kick(0.4);
        }
      }
      if (this.state === 'landed') {
        this._landPose(dampF(3, dt));
        this.speed = 0; this.engine = occ ? 0.15 : 0;
        this.horizon = 1;
        if (!occ) { this.sleepT += dt; if (this.sleepT > 2) this.awake = false; }
        return;
      }
    }
    this.sleepT = 0;

    // ---- virtual stick (NMS-style mouse flight)
    const st = this.stick;
    if (lookX || lookY) { st.x += lookX * 2.4; st.y += lookY * 2.4; }
    if (st.lengthSq() > 1) st.normalize();
    st.multiplyScalar(Math.exp(-dt * (lookX || lookY ? 0.6 : 1.9)));
    this.throttle = clamp(this.throttle + thrIn * dt * 0.75, 0, 1);

    // ---- attitude
    const fwd = _f.set(0, 0, 1).applyQuaternion(this.quat);
    const sUp = _u.set(0, 1, 0).applyQuaternion(this.quat);
    const right = _r.set(-1, 0, 0).applyQuaternion(this.quat);
    const atmoK = space ? 0 : clamp(rho * 4, 0, 1);
    const agility = (this.pulseOn ? 0.3 : 1) * (1 - 0.3 * clamp((speed - 160) / 300, 0, 1) * atmoK);
    let pitchT = -st.y * 1.35 * agility;
    let yawT = -st.x * 0.8 * agility;
    let rollT = rollIn * 2.6;
    const upright = sUp.dot(up);
    if (atmoK > 0 && Math.abs(rollIn) < 0.1) {
      const bank = Math.asin(clamp(-right.dot(up), -1, 1));
      const want = st.x * 0.8;
      rollT += (want - bank) * 2.4 * atmoK * clamp(upright * 2 + 0.3, 0, 1);
    }
    // hover levelling near the ground at low speed
    const slow = 1 - smoothstep(25, 70, speed);
    if (slow > 0 && this.agl < 300 && !space && Math.abs(st.y) < 0.08) {
      const pitchAng = Math.asin(clamp(fwd.dot(up), -1, 1));
      pitchT += pitchAng * 1.6 * slow;
    }
    this.rate.x = damp(this.rate.x, pitchT, 5, dt);
    this.rate.y = damp(this.rate.y, yawT, 5, dt);
    this.rate.z = damp(this.rate.z, rollT, 6, dt);
    _e.set(this.rate.x * dt, this.rate.y * dt, this.rate.z * dt, 'YXZ');
    _q.setFromEuler(_e);
    this.quat.multiply(_q).normalize();
    fwd.set(0, 0, 1).applyQuaternion(this.quat);
    sUp.set(0, 1, 0).applyQuaternion(this.quat);

    // ---- pulse drive (space only): hold boost to spool, press again / S / descend to drop out
    if (space && occ) {
      if (!this.pulseOn) {
        this.pulseHold = boostHeld ? this.pulseHold + dt : 0;
        if (this.pulseHold > 0.6) {
          this.pulseOn = true; this.pulseSpeed = Math.max(speed, 900); this.pulseHold = 0;
          this._pulseArm = false;
          this.mgr.audio('play', 'pulse', { on: true });
          this.camera?.kick(0.6);
        }
      } else {
        if (!boostHeld) this._pulseArm = true;
        if ((this._pulseArm && input.down('boost')) || thrIn < -0.5 || desc) this._dropPulse(false);
      }
    }
    if (this.pulseOn) {
      const distAtm = Math.max(0, this.alt - this.atmoH);
      const lim = Math.min(Math.max(distAtm, 2000) * 1.5, this.nearestD * 0.35, 6e6);
      const target = clamp(lim, 3000, 6e6);
      this.pulseSpeed += (target - this.pulseSpeed) * dampF(this.pulseSpeed < target ? 0.7 : 3, dt);
      vel.copy(fwd).multiplyScalar(this.pulseSpeed);
      if (!space || (this.alt < this.atmoH * 1.25 && fwd.dot(up) < -0.05)) this._dropPulse(true);
      this.pulse = damp(this.pulse, 1, 3, dt);
    } else this.pulse = damp(this.pulse, 0, 2, dt);

    if (!this.pulseOn) {
      // ---- thrust toward the target speed along the nose
      const cap = space ? 900 : 190;
      const boostOn = boostHeld && occ && !space ? 1 : boostHeld && occ && space ? 1 : 0;
      this.boost = damp(this.boost, boostOn, boostOn ? 3 : 1.6, dt);
      const vT = Math.max(this.throttle * cap, this.boost * (space ? 3200 : 420));
      const acc = space ? 110 + this.boost * 420 : 24 + this.boost * 40;
      const vF = vel.dot(fwd);
      const dv = clamp(vT - vF, -acc * dt * (space ? 0.6 : 1.4), acc * dt);
      vel.addScaledVector(fwd, dv);
      // energy trade in atmosphere (climb bleeds speed, dive gains it)
      if (!space && vF > 30) vel.addScaledVector(fwd, -g * fwd.dot(up) * 0.6 * dt);
      // aerodynamic grip: the velocity turns toward the nose (lift); flight assist in space
      const airless = this.atmoH <= 0;
      const grip = space || airless ? 0.8 : 0.35 + 3.4 * clamp(rho, 0, 1.2);
      const vf2 = vel.dot(fwd);
      _a.copy(vel).addScaledVector(fwd, -vf2);                 // lateral / vertical slip
      if (!space) _a.addScaledVector(up, -_a.dot(up) * slow);  // keep hover vertical motion for VTOL
      vel.addScaledVector(_a, -dampF(grip, dt));
      // gravity vs. support (VTOL engines at low speed, wing lift at speed)
      const lift = smoothstep(35, 130, vf2) * clamp(upright * 1.25, 0, 1) * clamp(rho * 3, 0, 1);
      this.hover = damp(this.hover, space ? 0 : slow, 3, dt);
      const support = space ? 0.985 : clamp(0.3 + this.hover * 0.7 + lift * 0.7 + (airless ? 0.62 : 0), 0, 1);
      vel.addScaledVector(up, -g * (1 - support) * dt);
      // vertical thrusters
      const vIn = asc - desc;
      this.vtol = damp(this.vtol, Math.max(this.hover, Math.abs(vIn)) * (space ? 0.3 : 1), 4, dt);
      vel.addScaledVector(sUp, vIn * (space ? 30 : 17) * dt);
      if (!vIn && this.hover > 0.3) {
        const vr = vel.dot(up);
        vel.addScaledVector(up, -vr * dampF(2.2 * this.hover, dt));
      }
      // over-speed drag ∝ ρ v² (reentry deceleration)
      const sp = vel.length();
      if (!space && sp > cap * 1.05) {
        const dec = Math.min(sp - cap, rho * 0.00009 * sp * sp * dt + 4 * dt);
        vel.addScaledVector(vel, -dec / sp);
      }
    }

    // ---- integrate
    pos.addScaledVector(vel, dt);
    this.speed = vel.length();

    // ---- terrain / water contact
    this._contacts(dt, occ);

    // ---- heat (reentry): dynamic pressure at high speed in thin air
    const q = 0.5 * rho * this.speed * this.speed;
    const heatT = smoothstep(450, 1100, this.speed) * smoothstep(1.5e3, 6e4, q) * (space ? 0 : 1);
    this.heat = damp(this.heat, heatT, heatT > this.heat ? 2.5 : 0.8, dt);
    this.engine = clamp(0.2 + this.throttle * 0.55 + this.boost * 0.3 + this.vtol * 0.2 + this.pulse * 0.4, 0, 1);
    this.horizon = space ? 0 : this.atmoH <= 0 ? clamp(1 - this.agl / 1500, 0, 1) * 0.8 : clamp(1 - (this.speed - 40) / 160, 0.25, 1) * atmoK;
    this._syncFrame();

    // ---- travel: scan for other bodies (arrive by switching worlds)
    if (last) {
      this.scanT -= dt * this.substeps;
      if (this.scanT <= 0) { this.scanT = 0.25; this._scan(); }
    }
  }

  _dropPulse(hard) {
    this.pulseOn = false;
    const keep = Math.min(this.pulseSpeed, hard ? 2400 : 900);
    this.vel.setLength(keep);
    this.pulseSpeed = 0;
    this.throttle = Math.max(this.throttle, 0.5);
    this.mgr.audio('play', 'pulse', { on: false });
    this.camera?.kick(hard ? 1.2 : 0.5);
  }

  _contacts(dt, occ) {
    const grd = this.ground, R = this.world.body.radius, pos = this.pos, vel = this.vel;
    let maxD = 0, padHit = 0;
    const probe = (x, y, z, isPad) => {
      _p.set(x, y, z).applyQuaternion(this.quat).add(pos);
      const hs = grd.supportAt(_p);
      const d = R + hs - _p.length();
      if (d > maxD) maxD = d;
      if (isPad && d > -0.15) padHit++;
    };
    for (const h of HULL) probe(h[0], h[1], h[2], false);
    if (this.gearT > 0.6) for (const pd of PADS) probe(pd[0], pd[1] * (0.4 + 0.6 * this.gearT), pd[2], true);
    if (maxD <= 0 && padHit === 0) return;
    const up = _up.copy(pos).normalize();
    if (maxD > 0) pos.addScaledVector(up, maxD);
    const vr = vel.dot(up);
    const impact = -vr;
    if (vr < 0) vel.addScaledVector(up, -vr * 1.15);
    _a.copy(vel).addScaledVector(up, -vel.dot(up));
    vel.addScaledVector(_a, -dampF(padHit ? 2.5 : 1.2, dt));
    const upright = this.upVec.dot(up);
    if (padHit >= 2 && this.gearT > 0.85 && this.speed < 16 && upright > 0.75 && !this.pulseOn) {
      this.state = 'landed';
      this.throttle = 0; this.boost = 0;
      this.mgr.audio('play', 'land', { intensity: clamp(impact / 8, 0.1, 1) });
      this.camera?.kick(clamp(impact * 0.1, 0.15, 0.8));
      this.world.events?.emit?.('discovery', { kind: 'landing', name: 'Touchdown' });
      return;
    }
    if (impact > 7 && occ) {
      this.camera?.kick(Math.min(2, impact * 0.05));
      this.mgr.sparksAt(_p, up, 24);
      this.mgr.audio('play', 'impact', { intensity: clamp(impact / 40, 0.2, 1) });
      if (this.pulseOn) this._dropPulse(true);
    }
  }

  _scan() {
    const W = this.world, sys = W.system, cel = W.celestial;
    if (!sys || !cel) return;
    let best = null, bd = Infinity;
    for (const p of sys.planets) {
      for (const b of [p, ...(p.moons || [])]) {
        if (b === W.body) continue;
        try {
          cel.bodyLocal(b, _a);
          const d = _a.distanceTo(this.pos) - b.radius;
          if (d < bd) { bd = d; best = b; }
        } catch (_) { /* ignore */ }
      }
    }
    this.nearest = best; this.nearestD = bd;
    // arrival: close enough to another solid body → seamless hand-off to that world
    if (best && !this.travelling && this.occupied && !best.isGas) {
      const atm = best.atmosphere?.present ? best.atmosphere.height : 0;
      if (bd < best.radius * 1.6 + atm) this._travel(best, bd);
    }
    // gas giants: drop out of pulse before we hit them
    if (best && best.isGas && this.pulseOn && bd < best.radius * 1.2) this._dropPulse(true);
  }

  _travel(b, dist) {
    const W = this.world, eng = W.engine, dir = eng?.director;
    if (!dir?.go) return;
    this.travelling = true;
    try {
      // arrival direction in the destination's planet-local frame
      const cel = new Celestial(W.system, b);
      cel.update(W.time);
      W.celestial.toInertial(this.pos, _a);
      _b.copy(_a).sub(cel.bodyPos).applyQuaternion(cel.qInv).normalize();
      const lat = Math.asin(clamp(_b.y, -1, 1)) * 180 / Math.PI;
      const lon = Math.atan2(_b.x, _b.z) * 180 / Math.PI;
      const ref = b.isMoon ? `${b.parent}.${b.index}` : String(b.index);
      const atm = b.atmosphere?.present ? b.atmosphere.height : 0;
      const alt = Math.round(Math.max(atm * 1.5, Math.min(dist, b.radius * 0.5)));
      const keep = { galaxy: W.galaxyIndex, star: W.starIndex };
      if (W.params?.seed !== undefined) keep.seed = W.params.seed;
      if (W.params?.q) keep.q = W.params.q;
      this.world.events?.emit?.('discovery', { kind: 'landing', name: b.name });
      dir.go('system', { ...keep, planet: ref, view: 'ship', alt, lat: +lat.toFixed(3), lon: +lon.toFixed(3), speed: 600, pulse: 12000, time: +W.time.toFixed(1) },
        { transition: 'white', duration: 500, replace: true, push: false });
    } catch (e) { console.error('[vehicles] travel failed', e); this.travelling = false; }
  }

  // --------------------------------------------------------------------------- camera & fx
  updateCamera(dt, input) {
    if (!this.camera) return;
    const flying = this.state !== 'landed';
    this.camera.update(dt, {
      look: flying ? null : input.axis('look'), allowLook: !flying, zoom: input.zoom, speed: this.pulseOn ? 220 * (1 + this.pulse * 0.6) : this.speed,
      boost: Math.max(this.boost, this.pulse), rough: this.heat * 0.7 + (flying && !this.pulseOn ? clamp(this.rho * this.speed / 400, 0, 0.3) : 0) + this.pulse * 0.25,
      engine: this.engine, radialUp: this.radialUp,
    });
  }

  blurAmount() { return clamp((this.speed - 150) / 300, 0, 1) * 0.35 * (this.rho > 0.02 ? 1 : 0.3) + this.pulse * 0.28 + this.heat * 0.25; }
  streakAmount() {
    if (this.pulse > 0.05) return { power: this.pulse, mode: 'pulse' };
    return { power: clamp((this.speed - 110) / 220, 0, 1) * clamp(this.rho * 3, 0, 1) * 0.8, mode: 'wind' };
  }

  animate(dt, t) {
    const m = this.model, ch = this.mats.glow.userData.ch, sch = m.sprites?.userData.ch;
    const occ = this.occupied, night = G.uNight.value;
    const flying = this.state !== 'landed';
    const blink = (Math.sin(t * 2.3) > 0.85 ? 1 : 0);
    const fp = occ ? clamp((flying ? 0.25 : 0.08) + this.throttle * 0.7 + this.boost * 1.1 + this.pulse * 0.6, 0, 1.8) : 0;
    const flick = 0.92 + 0.08 * noise1(t * 24, 4);
    ch[0] = (occ ? 0.6 + fp * 0.8 : 0.25) * flick;   // nozzles
    ch[1] = occ || night > 0.3 ? 1.1 : 0.5;          // nav
    ch[2] = blink * 1.5;                             // strobes / beacon
    ch[3] = occ && (this.agl < 200 || !flying) ? 1.2 + night : 0.15;
    ch[4] = occ ? 1.0 + this.boost * 0.6 + this.pulse : 0.35;
    ch[5] = occ ? 0.4 + this.vtol * 1.4 : 0.1;
    ch[6] = occ ? 1.1 : 0.2;
    if (sch) { sch[0] = ch[0] * (0.25 + fp * 0.5); sch[1] = ch[1] * (0.35 + night); sch[2] = ch[2]; sch[3] = ch[3] * (0.15 + night); sch[5] = ch[5] * (0.3 + night * 0.5); }
    for (let i = 0; i < this.flames.length; i++) {
      const f = this.flames[i], r = f.userData.r;
      f.visible = fp > 0.04 && this.visible;
      f.material.uniforms.uPower.value = Math.min(1.6, fp);
      f.scale.set(r * 0.9, r * 0.9, r * (1.6 + fp * 4.5 + this.pulse * 3 + noise1(t * 28 + i, 2) * 0.3));
    }
    const vp = occ ? this.vtol * (flying ? 1 : 0) : 0;
    for (const f of this.vtolFlames) {
      f.visible = vp > 0.05 && this.visible;
      f.material.uniforms.uPower.value = vp;
      f.scale.set(0.45, 0.45, 0.8 + vp * 2.2 + noise1(t * 30, 6) * 0.15);
    }
    // gear deploy/retract: fold backwards and tuck away
    for (const g of m.gear) {
      const k = this.gearT;
      g.group.visible = k > 0.02;
      g.group.rotation.x = (1 - k) * 1.35;
      g.group.scale.y = 0.35 + 0.65 * k;
    }
    // reentry
    const u = this.mats.body.userData.u;
    if (u) {
      u.uHeat.value = this.heat;
      if (this.speed > 1) u.uHeatDir.value.copy(this.vel).normalize();
    }
    this.plasma.visible = this.heat > 0.02 && this.visible;
    if (this.plasma.visible) {
      this.plasma.material.uniforms.uPower.value = this.heat * 1.4;
      // orient the sheath along the airflow (model space)
      _q.copy(this.quat).invert();
      _a.copy(this.vel).normalize().applyQuaternion(_q);
      this.plasma.quaternion.setFromUnitVectors(_b.set(0, 0, -1), _a.negate());
      this.plasma.position.copy(_a).multiplyScalar(-3).add(_c.set(0, 0.2, 0));
    }
    this.screen?.update(dt, occ && this.distToCam < 40, this._screenData());
    this._pools(night);
    this._trails(dt);
    this._fx(dt);
  }

  _pools(night) {
    const grd = this.ground, R = this.world.body.radius;
    const hS = grd.supportAt(this.pos);
    const agl = this.pos.length() - (R + hS);
    const k = this.occupied ? clamp(1 - agl / 60, 0, 1) * this.vtol : 0;
    this.pool.visible = k > 0.01 && this.visible;
    if (this.pool.visible) {
      this.pool.position.copy(this.radialUp).multiplyScalar(R + hS + 0.12);
      grd.normalAt(this.pos, 6, _n, true);
      orthoForward(_n, this.fwdVec, _f);
      quatFromFrame(_n, _f, this.pool.quaternion);
      this.pool.material.uniforms.uPower.value = k * (0.2 + night * 1.2);
    }
    const lk = this.occupied && agl < 150 ? smoothstep(0.25, 0.7, night) * clamp(1 - agl / 150, 0, 1) : 0;
    this.landPool.visible = lk > 0.01 && this.visible;
    if (this.landPool.visible) {
      _p.copy(this.pos).addScaledVector(this.fwdVec, 6);
      const hh = grd.supportAt(_p);
      this.landPool.position.copy(_p).normalize().multiplyScalar(R + hh + 0.12);
      grd.normalAt(_p, 6, _n, true);
      orthoForward(_n, this.fwdVec, _f);
      quatFromFrame(_n, _f, this.landPool.quaternion);
      this.landPool.material.uniforms.uPower.value = lk * 0.6;
    }
  }

  _trails(dt) {
    const m = this.model;
    if (this.travelling) return;
    const flying = this.state !== 'landed' && this.occupied;
    // wingtip contrails: humid dense air, speed and G (pull) make them
    const pull = Math.abs(this.rate.x) + Math.abs(this.rate.y) * 0.5;
    const cA = flying && !this.pulseOn ? smoothstep(80, 200, this.speed) * clamp(this.rho * 2.2, 0, 1) * (0.35 + clamp(pull, 0, 1) * 0.65) : 0;
    for (let i = 0; i < 2; i++) {
      _p.copy(m.anchors.tips[i]).applyQuaternion(this.quat).add(this.pos);
      if (cA > 0.02) this.trails[i].push(_p, 0.35 + this.speed * 0.002, cA * 0.8);
      this.trails[i].update(dt);
    }
    // engine trails in thin air / space (and on boost)
    const eA = flying ? clamp((1 - clamp(this.rho * 3, 0, 1)) * this.throttle * 0.6 + this.boost * 0.6 + this.pulse, 0, 1.2) : 0;
    for (let i = 0; i < 2; i++) {
      _p.copy(m.anchors.nozzles[i]).applyQuaternion(this.quat).add(this.pos);
      if (eA > 0.02 && !this.pulseOn) this.trails[2 + i].push(_p, 0.5 + this.boost * 0.4, eA * 0.8);
      this.trails[2 + i].update(dt);
    }
  }

  _fx(dt) {
    if (!this.visible || !this.occupied || this.distToCam > 400) return;
    const mgr = this.mgr, grd = this.ground, R = this.world.body.radius, rnd = this.rand;
    const up = this.radialUp;
    const hS = grd.supportAt(this.pos);
    const water = grd.onWater;
    const agl = this.pos.length() - (R + hS);
    const k = clamp(1 - agl / 40, 0, 1) * (this.vtol * 0.8 + this.throttle * 0.4) * (this.state === 'landed' ? 0 : 1);
    this.dustSampleT -= dt;
    if (this.dustSampleT <= 0) { this.dustSampleT = 0.4; grd.dustColor(this.pos, this.dustColor); }
    const q = mgr.quality.particleScale ?? 1;
    this.dustT += dt * k * 60 * q;
    while (this.dustT >= 1) {
      this.dustT -= 1;
      const a = rnd.next() * Math.PI * 2, rr = rnd.next() * 4;
      _a.set(Math.cos(a), 0, Math.sin(a));
      _a.addScaledVector(up, -_a.dot(up)).normalize();
      const gp = _c.copy(this.pos).normalize().multiplyScalar(R + hS + 0.3).addScaledVector(_a, rr);
      const out = 8 + rnd.next() * 10;
      if (water) {
        _col.setRGB(0.86, 0.9, 0.95);
        mgr.fx.spray.spawn(gp.x, gp.y, gp.z, _a.x * out + up.x * 3, _a.y * out + up.y * 3, _a.z * out + up.z * 3, { life: 1 + rnd.next(), size0: 0.6, size1: 3.5, alpha: 0.5, color: _col, drag: 1.2, grav: 5, rot: rnd.next() * 6 });
      } else {
        _col.copy(this.dustColor).multiplyScalar(0.9 + rnd.next() * 0.25);
        mgr.fx.dust.spawn(gp.x, gp.y, gp.z, _a.x * out + up.x * 0.8, _a.y * out + up.y * 0.8, _a.z * out + up.z * 0.8, { life: 2 + rnd.next() * 1.5, size0: 1.0, size1: 5 + rnd.next() * 3, alpha: 0.45, color: _col, drag: 1.1, grav: -0.3, rot: rnd.next() * 6, rotSpeed: rnd.signed() * 0.4 });
      }
    }
    // reentry sparks/embers streaming off the hull
    if (this.heat > 0.1) {
      this.emT = (this.emT || 0) + dt * this.heat * 40 * q;
      while (this.emT >= 1) {
        this.emT -= 1;
        _p.set(rnd.signed() * 6, rnd.signed() * 1.2, rnd.range(-6, 6)).applyQuaternion(this.quat).add(this.pos);
        const vx = this.vel.x * 0.92 + rnd.signed() * 20, vy = this.vel.y * 0.92 + rnd.signed() * 20, vz = this.vel.z * 0.92 + rnd.signed() * 20;
        mgr.fx.sparks.spawn(_p.x, _p.y, _p.z, vx, vy, vz, { life: 0.3 + rnd.next() * 0.3, size0: 0.25, size1: 0.1, alpha: 1, color: _col.setRGB(8, 3.2, 1.0), drag: 3, grav: 0 });
      }
    }
  }

  telemetry() {
    const alt = this.alt;
    const tele = { speed: this.pulseOn ? `${(this.speed / 1000).toFixed(this.speed < 1e5 ? 1 : 0)} km/s` : fmtSpeed(this.speed), altitude: fmtDist(alt) };
    if (this.pulseOn) tele.drive = 'PULSE';
    else if (this.state === 'landed') tele.status = 'LANDED';
    else if (this.heat > 0.2) tele.status = 'REENTRY';
    if (this.nearest && this.alt > this.atmoH) tele.target = `${this.nearest.name} · ${fmtDist(this.nearestD)}`;
    return tele;
  }

  getState() {
    return {
      ...super.getState(), state: this.state, alt: Math.round(this.alt), agl: Math.round(this.agl), throttle: +this.throttle.toFixed(2),
      gear: +this.gearT.toFixed(2), pulse: this.pulseOn, pitch: Math.round(Math.asin(clamp(this.fwdVec.dot(this.radialUp), -1, 1)) * 57.3),
      bank: Math.round(Math.asin(clamp(-this.rightVec.dot(this.radialUp), -1, 1)) * 57.3), vUp: +this.vel.dot(this.radialUp).toFixed(1), heat: +this.heat.toFixed(2), rho: +this.rho.toFixed(3),
      nearest: this.nearest?.name ?? null, nearestKm: Number.isFinite(this.nearestD) ? Math.round(this.nearestD / 1000) : null,
    };
  }

  _screenData() {
    const up = this.radialUp, f = this.fwdVec;
    tangentBasis(up, _se, _sn);
    const d = this._sd ||= {};
    d.speed = this.speed; d.throttle = this.pulseOn ? 1 : this.throttle; d.boost = Math.max(this.boost, this.pulse); d.engine = this.engine;
    d.heading = Math.atan2(f.dot(_se), f.dot(_sn));
    d.pitch = Math.asin(clamp(f.dot(up), -1, 1));
    d.bank = Math.asin(clamp(-this.rightVec.dot(up), -1, 1));
    d.alt = this.alt; d.gear = this.gearT;
    d.status = this.pulseOn ? 'PULSE' : this.heat > 0.2 ? 'REENTRY' : this.state === 'landed' ? 'LANDED' : this.boost > 0.3 ? 'BOOST' : '';
    d.target = this.nearest && this.alt > this.atmoH ? `${this.nearest.name} ${fmtDist(this.nearestD)}` : '';
    return d;
  }

  dispose() {
    this.screen?.dispose();
    for (const p of [this.pool, this.landPool]) { p?.removeFromParent(); p?.geometry.dispose(); p?.material.dispose(); }
    for (const t of this.trails || []) t.dispose();
    for (const f of [...(this.flames || []), ...(this.vtolFlames || []), this.plasma]) { f?.geometry.dispose(); f?.material.dispose(); }
    super.dispose();
  }
}
