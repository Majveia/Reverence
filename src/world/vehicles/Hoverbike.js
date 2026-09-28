// HOVERBIKE — the flow-state king. Arcade repulsor physics tuned for carving:
//   • predictive 5-point repulsor probe (terrain AND liquid surfaces), anti-gravity lift + spring
//     so it floats exactly at ride height and launches off crests (floaty air time, air control)
//   • throttle curve, boost (Shift/RT), hop (Space/A), speed-sensitive steering, lateral grip that
//     loosens at speed for slight power-slides, banking into turns, nose pitch on accel/brake
//   • dust rooster tails in the ground's own color, water spray + wake, repulsor light pools,
//     exhaust flames on boost, Akira-style tail-light ribbons at dusk, speed-blur + FOV kick
import * as THREE from 'three';
import { Vehicle } from './Vehicle.js';
import { buildBike } from './models/bike.js';
import { makeFlame, makePool } from './fx/glow.js';
import { Ribbon } from './fx/trails.js';
import { clamp, damp, dampF, smoothstep, orthoForward, quatFromFrame, FastRand, noise1 } from './util.js';
import { G } from '../../core/Uniforms.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _n = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _p = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _col = new THREE.Color();
const _pF = new THREE.Vector3(), _pB = new THREE.Vector3(), _pL = new THREE.Vector3(), _pR = new THREE.Vector3();

const HOVER_H = 1.02;       // ride height of the origin above support
const RANGE = 3.4;          // repulsor field range
const VMAX = 44, VBOOST = 74;

export class Hoverbike extends Vehicle {
  constructor(mgr, opts) {
    super(mgr, 'bike', opts);
    this.promptText = 'Ride';
    this.inputScheme = 'vehicle';
    this.colliderRadius = 1.0;
    this.colliderLift = 0.1;
    this.enterRadius = 3.4;
    this.exitSide = 1.3;
    this.heading = new THREE.Vector3(0, 0, 1);
    this.gnd = new THREE.Vector3(0, 1, 0);        // smoothed ground normal
    this.visUp = new THREE.Vector3(0, 1, 0);
    this.steer = 0; this.throttle = 0; this.pitchVis = 0; this.agl = HOVER_H; this.air = 0;
    this.boostHeld = 0; this.onWater = false; this.hopCd = 0;
    this.rand = new FastRand(4242);
    this.dustT = 0; this.dustColor = new THREE.Color(0.6, 0.52, 0.4); this.dustSampleT = 0;
    this.rough = 0;
    this.bobT = opts?.seed ?? 0;
    this.restHeight = HOVER_H;
    this.clearRadius = 1.4;
    this.displayName = 'Hoverbike';
  }

  startFromParams(p) {
    const v0 = p.speed !== undefined ? +p.speed : 0;
    if (v0 > 0) { this.vel.copy(this.fwdVec).multiplyScalar(v0); this.throttle = 1; }
  }

  build() {
    const mgr = this.mgr, liv = mgr.livery('bike');
    const mats = mgr.makeMaterials('bike', { panelScale: 0.22, dirtLow: -0.35, dirtHigh: 0.35, seed: 3.3 });
    this.mats = mats;
    this.materials = [mats.body, mats.glow, mats.decal, mats.glass];
    const m = buildBike(mats, liv);
    this.model = m;
    this.group.add(m.root);
    this.tris = m.tris;
    m.rider.visible = false;
    // exhaust flames (boost)
    this.flames = m.anchors.exhaust.map((p, i) => {
      const f = makeFlame({ core: [liv.glow[0] * 2 + 1, liv.glow[1] * 2 + 1, liv.glow[2] * 2 + 1], outer: [liv.glow[0] * 0.5, liv.glow[1] * 0.5, liv.glow[2] * 0.6], seed: i * 3.1 + 1 }, G.uTime);
      f.position.copy(p);
      f.scale.set(0.07, 0.07, 0.5);
      m.root.add(f);
      return f;
    });
    // repulsor wash on the ground (placed each frame in planet-local space)
    this.pool = makePool({ size: 5.5, color: [liv.glow[0] * 0.7, liv.glow[1] * 0.7, liv.glow[2] * 0.7], shape: [1.5, 0] });
    this.world.root.add(this.pool);
    this.headPool = makePool({ size: 14, color: [1.0, 0.92, 0.8], shape: [1.9, 0.35] });
    this.world.root.add(this.headPool);
    // light ribbons (tail + vane tips)
    const q = this.mgr.quality;
    if (!q.mobile) {
      this.ribbons = [
        new Ribbon(this.world, { max: 40, color: [3.5, 0.25, 0.12], additive: true, life: 0.7, minDist: 0.8, name: 'bike-tail-ribbon' }),
      ];
    } else this.ribbons = [];
    this.initCamera({
      dist: 3.9, height: 1.2, pivot: 0.8, lookAhead: 7, pitch: -0.06, fovBase: 62, fovSpeed: 11, fovBoost: 8, minDist: 2.8,
      speedRef: 44, yawLag: 5.5, distSpeed: 0.22, heightSpeed: 0.18, roll: 0.28, shake: 1.0, clearance: 0.5,
      cockpitEye: [0, 0.98, -0.12], cockpitFov: 78, cockpitPitch: 0.08, posLag: 16,
    });
    this.registerCollider();
  }

  onControlGained(prev) {
    super.onControlGained(prev);
    this.model.rider.visible = true;
  }
  onControlLost(next) {
    super.onControlLost(next);
    this.model.rider.visible = false;
    for (const r of this.ribbons) r.reset();
  }

  simulate(dt, input) {
    const W = this.world, grd = this.ground, R = W.body.radius;
    const gAcc = clamp(W.body.gravity || 9.81, 2, 25);
    const occ = this.occupied;
    const mv = occ ? input.axis('move') : null;
    const up = _a.copy(this.pos).normalize();
    this.radialUp.copy(up);

    // ---- controls
    const thr = occ ? clamp(mv.y, -1, 1) : 0;
    const steerIn = occ ? clamp(mv.x, -1, 1) : 0;
    const boostIn = occ ? Math.max(input.held('boost') ? 1 : 0, input.analog ? input.analog('boost') : 0) : 0;
    this.throttle = damp(this.throttle, thr, 6, dt);
    this.steer = damp(this.steer, steerIn, steerIn === 0 ? 7 : 5.5, dt);
    this.boost = damp(this.boost, boostIn && thr > -0.2 ? 1 : 0, boostIn ? 4 : 2.2, dt);
    this.hopCd = Math.max(0, this.hopCd - dt);

    // ---- repulsor probe (predictive: sample slightly ahead along velocity)
    orthoForward(up, this.heading, _f);
    this.heading.copy(_f);
    _r.crossVectors(_f, up).normalize(); // driver's right
    const vT = _b.copy(this.vel).addScaledVector(up, -this.vel.dot(up));
    const look = clamp(vT.length() * 0.09, 0, 3.5);
    const vDir = vT.lengthSq() > 1 ? _c.copy(vT).normalize() : _c.copy(_f);
    _pF.copy(this.pos).addScaledVector(_f, 1.05).addScaledVector(vDir, look);
    _pB.copy(this.pos).addScaledVector(_f, -1.0);
    _pL.copy(this.pos).addScaledVector(_r, -0.55).addScaledVector(vDir, look * 0.5);
    _pR.copy(this.pos).addScaledVector(_r, 0.55).addScaledVector(vDir, look * 0.5);
    const hC = grd.supportAt(this.pos);
    const water = grd.onWater;
    const hF = grd.supportAt(_pF), hB = grd.supportAt(_pB), hL = grd.supportAt(_pL), hR = grd.supportAt(_pR);
    this.onWater = water;
    const r = this.pos.length();
    const hEff = Math.max(hC, (hF + hB) * 0.5, hF - 0.35);
    const agl = r - (R + hEff);
    this.agl = agl;
    // ground normal from the probes
    _pF.normalize().multiplyScalar(R + hF); _pB.normalize().multiplyScalar(R + hB);
    _pL.normalize().multiplyScalar(R + hL); _pR.normalize().multiplyScalar(R + hR);
    _n.crossVectors(_d.copy(_pF).sub(_pB), _p.copy(_pR).sub(_pL));
    if (_n.lengthSq() < 1e-9) _n.copy(up); else _n.normalize();
    if (_n.dot(up) < 0) _n.negate();
    if (_n.dot(up) < 0.35) _n.lerp(up, 0.5).normalize();
    this.rough = clamp(Math.abs(hF - hB) * 0.35 + Math.abs(hL - hR) * 0.3, 0, 1) * clamp(this.speed / 20, 0, 1);

    // ---- vertical: anti-gravity lift + spring-damper inside the field
    const vUp = this.vel.dot(up);
    const inField = agl < RANGE;
    const w = inField ? smoothstep(RANGE, RANGE * 0.45, agl) : 0;
    const omega = 9.5, zeta = 0.42;
    let aUp = -gAcc * (inField ? 1 : 0.82);          // floaty air time
    if (inField) {
      aUp += gAcc * w;                                   // anti-gravity
      aUp += (omega * omega * (HOVER_H - agl) - 2 * zeta * omega * vUp) * w;
      // idle breathing bob
      aUp += noise1(this.bobT * 0.9, 7) * 0.6 * w;
    }
    this.bobT += dt;
    aUp = clamp(aUp, -gAcc * 2.5, gAcc * 5);
    this.vel.addScaledVector(up, aUp * dt);
    // hop
    if (occ && this.hopCd <= 0 && agl < RANGE * 0.85 && input.down('jump')) {
      this.vel.addScaledVector(up, 7.5 - Math.min(0, vUp));
      this.hopCd = 0.6; this.air = 0.2;
      this.mgr.audio('play', 'jump');
    }
    this.air = inField && agl < HOVER_H * 1.6 ? 0 : this.air + dt;

    // ---- planar: thrust along the ground plane, grip, drag
    orthoForward(_n, _f, _d);      // forward on the ground plane
    const fwdG = _d;
    const rightG = _p.crossVectors(fwdG, _n).normalize();
    const vF = this.vel.dot(fwdG);
    const vmax = VMAX + (VBOOST - VMAX) * this.boost;
    const grounded = w > 0.2;
    const ctl = grounded ? 1 : 0.35;
    let aF = 0;
    if (this.throttle > 0.02) {
      const A = 15 + 14 * this.boost;
      aF = this.throttle * A * clamp(1 - (vF / vmax) * (vF / vmax), -0.6, 1);
    } else if (this.throttle < -0.02) {
      aF = vF > 1.5 ? this.throttle * 24 : this.throttle * 7 * clamp(1 + vF / 9, 0, 1);
    }
    if (this.boost > 0.05 && this.throttle <= 0.02 && occ && input.held('boost')) aF += 20 * this.boost * clamp(1 - vF / VBOOST, 0, 1);
    this.vel.addScaledVector(fwdG, aF * ctl * dt);
    // lateral grip: strong carve, loosens at speed with hard steer (slight power-slide)
    const vL = this.vel.dot(rightG);
    const slide = clamp(Math.abs(this.steer) * clamp((this.speed - 25) / 30, 0, 1), 0, 0.6);
    const grip = grounded ? 7.5 * (1 - slide) + 0.8 : 0.6;
    this.vel.addScaledVector(rightG, -vL * dampF(grip, dt));
    // drag (air + repulsor), stronger when coasting
    const sp = this.vel.length();
    const coast = Math.abs(this.throttle) < 0.05 ? (occ ? 0.35 : 1.6) : 0.02;
    const drag = coast + 0.0011 * sp + (water ? 0.05 : 0);
    const tang = _b.copy(this.vel).addScaledVector(up, -this.vel.dot(up));
    this.vel.addScaledVector(tang, -(1 - Math.exp(-drag * dt)));

    // ---- steering (yaw about local up)
    tang.copy(this.vel).addScaledVector(up, -this.vel.dot(up));
    const spd = tang.length();
    const rate = (2.05 - 1.0 * clamp(spd / 45, 0, 1)) * (grounded ? 1 : 0.65) * (1 - 0.25 * this.boost);
    const yaw = -this.steer * rate * dt * (spd < 1 && Math.abs(this.throttle) < 0.05 ? 0.7 : 1);
    this.heading.applyAxisAngle(up, yaw);
    // velocity follows heading a little (repulsor vectoring), keeps carving crisp
    if (grounded && spd > 2) {
      const cur = _c.copy(tang).normalize();
      const tgt = _f.copy(this.heading).multiplyScalar(Math.sign(vF) || 1);
      const k = dampF(2.2 * (1 - slide), dt);
      cur.lerp(tgt, k).normalize();
      this.vel.addScaledVector(tang, -1).addScaledVector(cur, spd);
    }

    // ---- integrate + hard floor
    this.pos.addScaledVector(this.vel, dt);
    const hNow = grd.supportAt(this.pos);
    const floorR = R + hNow + 0.32;
    const rr = this.pos.length();
    if (rr < floorR) {
      this.pos.multiplyScalar(floorR / rr);
      const upN = _a.copy(this.pos).normalize();
      const vu = this.vel.dot(upN);
      if (vu < 0) {
        if (vu < -6) { this.camera?.kick(Math.min(1.2, -vu * 0.08)); this.mgr.audio('play', 'land', { intensity: clamp(-vu / 15, 0, 1) }); this.mgr.sparksAt(this.pos, upN, 10); }
        this.vel.addScaledVector(upN, -vu * 1.25);
      }
    }
    // static colliders (trees, rocks, buildings) — front and rear spheres
    this._collide(0.95); this._collide(-0.9);

    this.speed = this.vel.length();
    this.engine = clamp(0.25 + Math.abs(this.throttle) * 0.55 + this.boost * 0.25, 0, 1);

    // ---- visual orientation: ground normal blend + bank + pitch
    const gw = clamp(w * 1.4, 0, 1);
    _c.copy(up).lerp(_n, 0.8 * gw).normalize();
    this.visUp.lerp(_c, dampF(8, dt)).normalize();
    const lat = this.steer * clamp(spd / 18, 0, 1);
    const bankT = clamp(lat * 0.62 + slide * Math.sign(this.steer) * 0.15, -0.8, 0.8);
    this.bank = damp(this.bank, bankT, 5.5, dt);
    const pitchT = clamp(-aF * 0.012, -0.12, 0.12) + (this.air > 0.25 ? clamp(-vUp * 0.02, -0.25, 0.2) : 0);
    this.pitchVis = damp(this.pitchVis, pitchT, 4, dt);
    orthoForward(this.visUp, this.heading, _f);
    quatFromFrame(this.visUp, _f, this.quat);
    _q.setFromAxisAngle(_b.set(0, 0, 1), this.bank);
    _q2.setFromAxisAngle(_b.set(1, 0, 0), this.pitchVis);
    this.quat.multiply(_q2).multiply(_q);
    this._syncFrame();

    // sleep when parked & settled
    if (!occ) {
      if (this.speed < 0.08 && Math.abs(agl - HOVER_H) < 0.05) { this.sleepT += dt; if (this.sleepT > 3) this.awake = false; }
      else this.sleepT = 0;
    }
  }

  _collide(off) {
    const cg = this.mgr.colliders;
    const p = _p.copy(this.pos).addScaledVector(this.fwdVec, off);
    const c = cg.sphere(p, 0.55);
    if (!c) return;
    this.pos.addScaledVector(c.normal, c.depth);
    const vn = this.vel.dot(c.normal);
    if (vn < 0) {
      this.vel.addScaledVector(c.normal, -vn * 1.3);
      this.vel.multiplyScalar(0.85);
      if (vn < -5) { this.camera?.kick(Math.min(1.5, -vn * 0.06)); this.mgr.sparksAt(p.addScaledVector(c.normal, -0.5), c.normal, 14); this.mgr.audio('play', 'impact', { intensity: clamp(-vn / 20, 0, 1) }); }
    }
  }

  animate(dt, t) {
    const m = this.model, ch = this.mats.glow.userData.ch, sch = m.sprites?.userData.ch;
    const occ = this.occupied;
    const night = G.uNight.value;
    // channel intensities: 0 engine, 1 markers, 2 brake, 3 headlight, 4 accent, 5 repulsors
    const flick = 0.92 + 0.08 * noise1(t * 20, 3);
    const eng = (occ ? 0.7 + this.throttle * 0.6 + this.boost * 1.6 : 0.35) * flick;
    ch[0] = eng; ch[1] = 0.6 + 0.4 * (Math.sin(t * 3.0) > 0.6 ? 1 : 0);
    ch[2] = occ ? (this.throttle < -0.1 ? 1.8 : 0.55) : 0.25;
    ch[3] = occ ? 1.0 + night * 0.6 : 0.2;
    ch[4] = occ ? 0.9 + this.boost * 0.6 : 0.4;
    ch[5] = (occ ? 0.9 + 0.4 * this.boost : 0.55) * (0.9 + 0.1 * noise1(t * 13, 5));
    if (sch) { sch[0] = eng * (0.25 + this.boost * 0.8); sch[2] = ch[2] * (0.3 + night); sch[3] = ch[3] * (0.15 + night); sch[5] = ch[5] * (0.12 + night * 0.5); }
    // vanes steer & flutter
    for (const vg of m.vanes) {
      vg.rotation.y = 0.06 * Math.sign(vg.position.x) - this.steer * 0.22;
      vg.rotation.x = -this.pitchVis * 0.5 + noise1(t * 6 + vg.position.x * 10, 9) * 0.01 * clamp(this.speed / 30, 0, 1);
    }
    // rider lean (counter-lean into the turn) & tuck on boost
    if (m.rider.visible) {
      m.rider.rotation.z = this.bank * 0.35;
      m.rider.rotation.x = this.boost * 0.12;
      m.rider.position.z = -this.boost * 0.05;
    }
    // exhaust flames
    const fp = occ ? clamp(0.15 + this.throttle * 0.4 + this.boost * 1.2, 0, 1.6) : 0;
    for (const f of this.flames) {
      f.visible = fp > 0.05;
      f.material.uniforms.uPower.value = fp;
      f.scale.set(0.065, 0.065, 0.25 + fp * 0.9 + noise1(t * 30, 2) * 0.05);
    }
    // repulsor wash on the ground
    const grd = this.ground, R = this.world.body.radius;
    const up = this.radialUp;
    const hC = grd.supportAt(this.pos);
    const aglNow = this.pos.length() - (R + hC);
    const poolK = clamp(1 - (aglNow - HOVER_H) / 2.5, 0, 1);
    this.pool.visible = poolK > 0.01 && this.visible;
    if (this.pool.visible) {
      grd.normalAt(this.pos, 1.4, _n, true);
      this.pool.position.copy(up).multiplyScalar(R + hC + 0.07);
      orthoForward(_n, this.heading, _f);
      quatFromFrame(_n, _f, this.pool.quaternion);
      this.pool.material.uniforms.uPower.value = poolK * (occ ? 0.5 + 0.35 * this.boost : 0.3) * (0.1 + night * 1.3);
    }
    // headlight pool at night
    const hk = occ ? smoothstep(0.25, 0.7, night) : 0;
    this.headPool.visible = hk > 0.01 && this.visible;
    if (this.headPool.visible) {
      _p.copy(this.pos).addScaledVector(this.fwdVec, 6.5);
      const hh = grd.supportAt(_p);
      this.headPool.position.copy(_p).normalize().multiplyScalar(R + hh + 0.08);
      grd.normalAt(_p, 3, _n, true);
      orthoForward(_n, this.heading, _f);
      quatFromFrame(_n, _f, this.headPool.quaternion);
      this.headPool.material.uniforms.uPower.value = hk * 0.6;
    }
    // ribbons
    if (this.ribbons.length) {
      const show = occ && this.speed > 12;
      const a = show ? clamp((this.speed - 12) / 25, 0, 1) * smoothstep(0.15, 0.6, night) * 1.2 : 0;
      _p.copy(m.anchors.tail).applyQuaternion(this.quat).add(this.pos);
      if (show) this.ribbons[0].push(_p, 0.05 + this.boost * 0.03, a);
      for (const r of this.ribbons) r.update(dt);
    }
    this._fx(dt);
  }

  _fx(dt) {
    const mgr = this.mgr, grd = this.ground, R = this.world.body.radius;
    if (!this.visible) return;
    this.dustSampleT -= dt;
    if (this.dustSampleT <= 0) { this.dustSampleT = 0.35; grd.dustColor(this.pos, this.dustColor); }
    const up = this.radialUp;
    const hC = grd.supportAt(this.pos);
    const water = grd.onWater;
    const agl = this.pos.length() - (R + hC);
    const near = clamp(1 - (agl - HOVER_H) / 2.2, 0, 1);
    if (near <= 0) return;
    const sp = this.speed;
    const q = mgr.quality.particleScale ?? 1;
    const rate = (this.occupied ? (6 + sp * 1.4 + this.boost * 30) : 2.5) * near * q;
    this.dustT += dt * rate;
    const rnd = this.rand;
    const tang = _b.copy(this.vel).addScaledVector(up, -this.vel.dot(up));
    while (this.dustT >= 1) {
      this.dustT -= 1;
      // emit under a repulsor (alternate), on the support surface
      const back = rnd.next() < 0.6;
      _p.copy(this.pos).addScaledVector(this.fwdVec, back ? -0.75 : 0.6);
      const gp = _c.copy(_p).normalize().multiplyScalar(R + hC + 0.15);
      const ang = rnd.next() * Math.PI * 2;
      _d.set(Math.cos(ang), 0, Math.sin(ang));
      // radial outward in the tangent plane
      _a.copy(_d).addScaledVector(up, -_d.dot(up)).normalize();
      const out = 3 + rnd.next() * 3 + sp * 0.08;
      if (water) {
        // spray: fast, white, falls back; plus wake mist
        _col.setRGB(0.85, 0.9, 0.95);
        const vx = _a.x * out * 0.6 - tang.x * 0.15 + up.x * (2.5 + sp * 0.12);
        const vy = _a.y * out * 0.6 - tang.y * 0.15 + up.y * (2.5 + sp * 0.12);
        const vz = _a.z * out * 0.6 - tang.z * 0.15 + up.z * (2.5 + sp * 0.12);
        mgr.fx.spray.spawn(gp.x, gp.y, gp.z, vx, vy, vz, { life: 0.9 + rnd.next() * 0.6, size0: 0.25, size1: 1.6 + sp * 0.03, alpha: 0.55, color: _col, drag: 1.2, grav: 7, rot: rnd.next() * 6, rotSpeed: rnd.signed() });
      } else {
        _col.copy(this.dustColor).multiplyScalar(0.95 + rnd.next() * 0.3);
        const vx = _a.x * out - tang.x * 0.12 + up.x * (0.6 + rnd.next() * 1.2);
        const vy = _a.y * out - tang.y * 0.12 + up.y * (0.6 + rnd.next() * 1.2);
        const vz = _a.z * out - tang.z * 0.12 + up.z * (0.6 + rnd.next() * 1.2);
        mgr.fx.dust.spawn(gp.x, gp.y, gp.z, vx, vy, vz, { life: 1.4 + rnd.next() * 1.4 + sp * 0.02, size0: 0.4, size1: 2.4 + sp * 0.045 + this.boost * 1.5, alpha: 0.42 + 0.2 * this.boost, color: _col, drag: 1.4, grav: -0.25, rot: rnd.next() * 6, rotSpeed: rnd.signed() * 0.6 });
      }
    }
    // rooster tail behind at speed
    if (this.occupied && sp > 16) {
      this.tailT = (this.tailT || 0) + dt * (sp - 14) * 0.9 * near * q;
      while (this.tailT >= 1) {
        this.tailT -= 1;
        _p.copy(this.pos).addScaledVector(this.fwdVec, -1.3);
        const gp = _c.copy(_p).normalize().multiplyScalar(R + hC + 0.2);
        const k = 0.25 + rnd.next() * 0.2;
        const lift = 1.5 + rnd.next() * 2.5 + this.boost * 2;
        const side = rnd.signed() * 1.5;
        _a.copy(this.rightVec).multiplyScalar(side);
        if (water) {
          _col.setRGB(0.9, 0.94, 0.98);
          mgr.fx.spray.spawn(gp.x, gp.y, gp.z, tang.x * k + up.x * lift * 2 + _a.x, tang.y * k + up.y * lift * 2 + _a.y, tang.z * k + up.z * lift * 2 + _a.z,
            { life: 1.1 + rnd.next() * 0.5, size0: 0.35, size1: 2.2 + sp * 0.03, alpha: 0.6, color: _col, drag: 1.0, grav: 8.5, rot: rnd.next() * 6 });
        } else {
          _col.copy(this.dustColor).multiplyScalar(0.8 + rnd.next() * 0.35);
          mgr.fx.dust.spawn(gp.x, gp.y, gp.z, tang.x * k + up.x * lift + _a.x, tang.y * k + up.y * lift + _a.y, tang.z * k + up.z * lift + _a.z,
            { life: 2.2 + rnd.next() * 1.8, size0: 0.6, size1: 3.5 + sp * 0.06 + this.boost * 2, alpha: 0.45 + this.boost * 0.15, color: _col, drag: 1.1, grav: -0.35, rot: rnd.next() * 6, rotSpeed: rnd.signed() * 0.4 });
        }
      }
    }
  }

  getState() {
    return { ...super.getState(), agl: +this.agl.toFixed(2), boost: +this.boost.toFixed(2), water: this.onWater, air: +this.air.toFixed(2), bank: +this.bank.toFixed(2) };
  }

  dispose() {
    this.pool?.removeFromParent(); this.pool?.geometry.dispose(); this.pool?.material.dispose();
    this.headPool?.removeFromParent(); this.headPool?.geometry.dispose(); this.headPool?.material.dispose();
    for (const r of this.ribbons || []) r.dispose();
    for (const f of this.flames || []) f.material.dispose();
    super.dispose();
  }
}
