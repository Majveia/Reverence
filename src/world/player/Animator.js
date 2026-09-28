// Player track — procedural animation for the Explorer.
//
// Effector-space blending: every locomotion layer (ground gait/idle, air, boost, glide, slide, swim,
// climb, hard landing) outputs a Pose = spine/head angles + FOOT and HAND targets (+ poles). Layers are
// blended by smoothed state weights, then solved with analytic two-bone IK:
//   • legs: group space, terrain-adapted (heightfield under each foot, pelvis drop, foot tilt to slope)
//   • arms: chest space (so arm swing follows spine lean/twist)
// Additive: landing squash spring, lean into acceleration/turns, breathing, head look toward the camera
// view/POIs, backpack & antenna jiggle, finger curl.
import * as THREE from 'three';
import { B, REST_POS, PARENT, BONE_NAMES, DIM } from './Explorer.js';
import { clamp, lerp, smoothstep, saturate, dampF, Spring, noise1 } from './util.js';

const TAU = Math.PI * 2;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _t = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _n2 = new THREE.Vector3();

/** Pose = everything a layer outputs (blended linearly). Angles are YXZ eulers (x pitch, y yaw, z roll). */
class Pose {
  constructor() {
    this.rootRot = new THREE.Vector3(); this.pivot = new THREE.Vector3(0, 0, 0);
    this.hipsPos = new THREE.Vector3(); this.hipsRot = new THREE.Vector3();
    this.spine = new THREE.Vector3(); this.chest = new THREE.Vector3(); this.neck = new THREE.Vector3(); this.head = new THREE.Vector3();
    this.footL = new THREE.Vector3(); this.footR = new THREE.Vector3();
    this.footRotL = new THREE.Vector3(); this.footRotR = new THREE.Vector3();
    this.kneeL = new THREE.Vector3(); this.kneeR = new THREE.Vector3();
    this.handL = new THREE.Vector3(); this.handR = new THREE.Vector3();
    this.handRotL = new THREE.Vector3(); this.handRotR = new THREE.Vector3();
    this.elbowL = new THREE.Vector3(); this.elbowR = new THREE.Vector3();
    this.shoulderL = new THREE.Vector3(); this.shoulderR = new THREE.Vector3();
    this.fingers = 0; this.terrain = 0; this.pack = 0;
    this._vecs = Object.values(this).filter((v) => v && v.isVector3);
  }
  zero() { for (const v of this._vecs) v.set(0, 0, 0); this.fingers = 0; this.terrain = 0; this.pack = 0; return this; }
  add(o, w) {
    const a = this._vecs, b = o._vecs;
    for (let i = 0; i < a.length; i++) a[i].addScaledVector(b[i], w);
    this.fingers += o.fingers * w; this.terrain += o.terrain * w; this.pack += o.pack * w;
    return this;
  }
}

// shoulder / hip joint positions (rest, group space & chest space)
const CHEST_REST = REST_POS.chest;
const SHOULDER_C = { L: REST_POS.upperArmL.clone().sub(CHEST_REST), R: REST_POS.upperArmR.clone().sub(CHEST_REST) };
const HIP_G = { L: REST_POS.thighL.clone(), R: REST_POS.thighR.clone() };

/** Hand target (chest space) from arm angles: swing θ (fwd +), elbow φ (bend +), abduction α (out +). */
function armTarget(side, theta, phi, alpha, out, fwdOffset = 0) {
  const s = side === 'L' ? 1 : -1;
  const S = SHOULDER_C[side];
  // upper arm direction
  const ux = Math.sin(alpha) * s, uy = -Math.cos(alpha) * Math.cos(theta), uz = Math.cos(alpha) * Math.sin(theta);
  const t2 = theta + phi;
  const fx = Math.sin(alpha * 0.6) * s, fy = -Math.cos(alpha * 0.6) * Math.cos(t2), fz = Math.cos(alpha * 0.6) * Math.sin(t2);
  return out.set(S.x + (ux * DIM.upper + fx * DIM.fore), S.y + (uy * DIM.upper + fy * DIM.fore), S.z + (uz * DIM.upper + fz * DIM.fore) + fwdOffset);
}
/** Foot (ankle) target (group space) from hip flexion θ (fwd +), knee bend φ, abduction α. */
function legTarget(side, theta, phi, alpha, hipY, out) {
  const s = side === 'L' ? 1 : -1;
  const H = HIP_G[side];
  const ux = Math.sin(alpha) * s, uy = -Math.cos(alpha) * Math.cos(theta), uz = Math.cos(alpha) * Math.sin(theta);
  const t2 = theta - phi;
  const fx = Math.sin(alpha) * s, fy = -Math.cos(alpha) * Math.cos(t2), fz = Math.cos(alpha) * Math.sin(t2);
  return out.set(H.x + ux * DIM.thigh + fx * DIM.shin, H.y + hipY + uy * DIM.thigh + fy * DIM.shin, H.z + uz * DIM.thigh + fz * DIM.shin);
}

function quatFromDown(down, fwd, out) {
  _y.copy(down).negate();
  _z.copy(fwd).addScaledVector(_y, -fwd.dot(_y));
  if (_z.lengthSq() < 1e-10) { _z.set(0, 0, 1).addScaledVector(_y, -_y.z); if (_z.lengthSq() < 1e-10) _z.set(1, 0, 0); }
  _z.normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

export class Animator {
  constructor(rig, heights) {
    this.rig = rig;
    this.H = heights;
    this.bones = rig.bones;
    const n = BONE_NAMES.length;
    this.lq = []; this.gq = []; this.gp = []; this.lp = [];
    for (let i = 0; i < n; i++) {
      this.lq.push(new THREE.Quaternion()); this.gq.push(new THREE.Quaternion());
      this.gp.push(new THREE.Vector3()); this.lp.push(this.bones[i].position.clone());
    }
    this.parentIdx = BONE_NAMES.map((nm) => (PARENT[nm] ? B[PARENT[nm]] : -1));
    this.order = BONE_NAMES.map((nm, i) => i).sort((a, b) => depth(a, this.parentIdx) - depth(b, this.parentIdx));
    this.pose = new Pose();
    this.layers = { ground: new Pose(), air: new Pose(), glide: new Pose(), slide: new Pose(), swim: new Pose(), climb: new Pose(), crouch: new Pose() };
    this.w = { ground: 1, air: 0, glide: 0, slide: 0, swim: 0, climb: 0, crouch: 0 };
    this.phase = 0; this.swimPhase = 0; this.climbPhase = 0; this.idleT = 0;
    this.squash = new Spring(0, 16, 0.42);
    this.leanX = new Spring(0, 7, 0.9); this.leanZ = new Spring(0, 7, 0.9);
    this.pelvisDrop = new Spring(0, 14, 1);
    this.packY = new Spring(0, 22, 0.35); this.packX = new Spring(0, 20, 0.35);
    this.antX = new Spring(0, 26, 0.18); this.antZ = new Spring(0, 26, 0.18);
    this.lookYaw = new Spring(0, 7, 1); this.lookPitch = new Spring(0, 7, 1);
    this.footGround = { L: 0, R: 0 };
    this.footN = { L: new THREE.Vector3(0, 1, 0), R: new THREE.Vector3(0, 1, 0) };
    this.stepEvents = []; // footfalls emitted this frame: { side, pos(local) }
    this._lastStance = { L: true, R: true };
    this.exertion = 0;
    this.breath = 0;
    this.gpos = new THREE.Vector3(); this.gquat = new THREE.Quaternion(); this.gup = new THREE.Vector3();
    this.headHidden = false;
    this.footWorld = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  }

  /**
   * @param dt seconds
   * @param S  animation state from the Player (see Player._animState)
   * @param gpos, gquat  group (character root) transform, planet-local
   */
  update(dt, S, gpos, gquat) {
    dt = Math.min(dt, 1 / 20);
    this.gpos.copy(gpos); this.gquat.copy(gquat); this.gup.set(0, 1, 0).applyQuaternion(gquat);
    this.stepEvents.length = 0;
    // ---- state weights
    const target = S.state === 'ground' ? (S.crouch ? 'crouch' : 'ground') : S.state;
    const rate = S.state === 'swim' || S.state === 'climb' ? 7 : 11;
    for (const k in this.w) this.w[k] += ((k === target ? 1 : 0) - this.w[k]) * dampF(k === 'glide' ? 8 : rate, dt);
    this.exertion = clamp(this.exertion + dt * (S.speed > 8 ? 0.12 : S.speed > 4 ? 0.02 : -0.06), 0, 1);
    this.breath += dt * (1.6 + this.exertion * 3.5);

    // ---- gait clock (shared by ground/crouch layers) + footfall events
    {
      const v = S.speed;
      const walkT = smoothstep(0.15, 1.4, v), runT = smoothstep(2.6, 5.6, v), sprintT = smoothstep(7.2, 10.2, v);
      this.cadence = lerp(lerp(lerp(0.85, 0.92, walkT), 1.38, runT), 1.62, sprintT);
      this.duty = lerp(lerp(0.62, 0.36, runT), 0.27, sprintT);
      if (v > 0.05 && (this.w.ground + this.w.crouch) > 0.05) this.phase += this.cadence * dt;
      for (const [side, off] of [['L', 0], ['R', 0.5]]) {
        const p = ((this.phase + off) % 1 + 1) % 1;
        const st = p < this.duty;
        if (st && !this._lastStance[side] && v > 0.6 && S.state === 'ground') this.stepEvents.push(side);
        this._lastStance[side] = st;
      }
    }
    // ---- layers
    const P = this.pose.zero();
    let wsum = 0;
    for (const k in this.w) {
      const w = this.w[k];
      if (w < 1e-3) continue;
      const L = this.layers[k].zero();
      this['_' + k](L, S, dt);
      P.add(L, w); wsum += w;
    }
    if (wsum > 0 && Math.abs(wsum - 1) > 1e-4) {
      const inv = 1 / wsum;
      for (const v of P._vecs) v.multiplyScalar(inv);
      P.fingers *= inv; P.terrain *= inv; P.pack *= inv;
    }
    // ---- hard landing overlay
    if (S.hardLand > 0.001) this._hardLand(P, S.hardLand);

    // ---- additive: squash, lean, breathing, look
    if (S.landImpact > 0) { this.squash.v -= Math.min(S.landImpact, 22) * 0.16; S.landImpact = 0; }
    this.squash.update(0, dt);
    const sq = clamp(this.squash.x, -0.28, 0.08);
    P.hipsPos.y += sq;
    P.spine.x += -sq * 0.9; P.chest.x += -sq * 0.5;
    P.head.x += sq * 0.8;
    const groundish = this.w.ground + this.w.slide * 0.8 + this.w.crouch;
    const lx = clamp(S.accelLocal.z * 0.018 + S.speed * 0.006, -0.25, 0.3) * groundish;
    const lz = clamp(-S.turnRate * S.speed * 0.022, -0.42, 0.42) * (groundish + this.w.glide * 0.6);
    this.leanX.update(lx, dt); this.leanZ.update(lz, dt);
    P.rootRot.x += this.leanX.x; P.rootRot.z += this.leanZ.x;
    const br = Math.sin(this.breath) * (0.012 + this.exertion * 0.02);
    P.chest.x -= br; P.shoulderL.z += br * 0.5; P.shoulderR.z -= br * 0.5; P.neck.x += br * 0.6;
    // look (yaw/pitch in character space), distributed chest 20% / neck 35% / head 45%
    const lookW = S.fp ? 1 : clamp(1 - this.w.swim * 0.5 - this.w.climb * 0.6, 0, 1);
    let ly = clamp(S.lookYaw, -1.25, 1.25), lp = clamp(S.lookPitch, -0.7, 0.55);
    if (!S.fp && Math.abs(S.lookYaw) > 1.9) { ly = 0; lp *= 0.3; } // don't twist the head around backwards
    this.lookYaw.update(ly * lookW, dt); this.lookPitch.update(lp * lookW, dt);
    P.chest.y += this.lookYaw.x * 0.2; P.neck.y += this.lookYaw.x * 0.35; P.head.y += this.lookYaw.x * 0.45;
    P.neck.x -= this.lookPitch.x * 0.4; P.head.x -= this.lookPitch.x * 0.6;

    // ---- secondary motion: backpack + antenna
    this.packY.update(clamp(-S.accelUp * 0.0022, -0.03, 0.03), dt);
    this.packX.update(clamp(-S.accelLocal.x * 0.0015, -0.02, 0.02), dt);
    this.antX.update(clamp(-S.accelLocal.z * 0.02 + this.leanX.v * 0.05, -0.4, 0.4), dt);
    this.antZ.update(clamp(S.accelLocal.x * 0.02 - this.leanZ.v * 0.05, -0.4, 0.4), dt);

    this._apply(P, S, dt);
  }

  // =============================================================================== layers
  _ground(L, S, dt) {
    const v = S.speed;
    const walkT = smoothstep(0.15, 1.4, v), runT = smoothstep(2.6, 5.6, v), sprintT = smoothstep(7.2, 10.2, v);
    const cadence = this.cadence, duty = this.duty;
    const stride = v / cadence;
    const ph = this.phase;
    const lift = lerp(lerp(0.1, 0.24, runT), 0.36, sprintT);
    const width = lerp(0.105, 0.085, runT);
    const bobWalk = -0.025 * Math.cos(ph * TAU * 2) * walkT * (1 - runT);
    const bobRun = 0.035 * Math.cos(ph * TAU * 2) * runT;
    L.hipsPos.y = (bobWalk + bobRun) - 0.02 * runT - 0.03 * sprintT;
    L.hipsPos.x = Math.sin(ph * TAU) * 0.014 * walkT * (1 - runT * 0.6);
    // idle weight shift
    this.idleT += dt;
    const idle = 1 - walkT;
    L.hipsPos.x += idle * 0.012 * Math.sin(this.idleT * 0.45);
    L.hipsRot.z = idle * 0.025 * Math.sin(this.idleT * 0.45) + walkT * 0.045 * Math.sin(ph * TAU + Math.PI / 2) * (1 - runT * 0.5);
    L.hipsRot.y = 0.16 * Math.sin(ph * TAU) * walkT * (1 - sprintT * 0.3);
    L.spine.x = 0.035 * walkT + 0.08 * runT + 0.07 * sprintT;
    L.chest.x = 0.02 * walkT + 0.05 * runT + 0.04 * sprintT - idle * 0.03;
    L.chest.y = -L.hipsRot.y * 1.25;
    L.spine.y = -L.hipsRot.y * 0.3;
    L.head.x = -(L.spine.x + L.chest.x) * 0.7;
    // legs
    for (const [side, off] of [['L', 0], ['R', 0.5]]) {
      const p = ((ph + off) % 1 + 1) % 1;
      const foot = side === 'L' ? L.footL : L.footR;
      const frot = side === 'L' ? L.footRotL : L.footRotR;
      let z, y, pitch;
      const stanceLen = stride * duty;
      if (p < duty) {
        const s = p / duty;
        z = stanceLen * (0.5 - s) + 0.03 * runT;
        y = 0;
        pitch = lerp(0.12 * walkT, 0, smoothstep(0, 0.25, s)) - smoothstep(0.55, 1, s) * (0.35 * walkT + 0.35 * runT);
      } else {
        const s = (p - duty) / (1 - duty);
        const e = s * s * (3 - 2 * s);
        z = stanceLen * (-0.5 + e) + 0.03 * runT + Math.sin(s * Math.PI) * 0.06 * runT;
        // heel kick-back early in swing when running
        const kick = runT * 0.18 * Math.sin(Math.min(1, s * 1.6) * Math.PI) * (1 - e);
        y = lift * Math.pow(Math.sin(s * Math.PI), 0.9) + kick;
        z -= kick * 0.5;
        pitch = lerp(-0.5 * (walkT * 0.6 + runT * 0.4), 0.18 * walkT, smoothstep(0.35, 0.95, s));
      }
      // idle stance: feet slightly staggered and turned out
      const idleZ = side === 'L' ? 0.05 : -0.035;
      z = lerp(idleZ, z, walkT);
      const x = (side === 'L' ? 1 : -1) * lerp(0.115, width, walkT);
      foot.set(x, DIM.ankle + y * walkT, z);
      frot.set(pitch * walkT, (side === 'L' ? 0.12 : -0.12) * idle, 0);
      const knee = side === 'L' ? L.kneeL : L.kneeR;
      knee.set((side === 'L' ? 0.2 : -0.2), 0, 1);
    }
    L.terrain = 1;
    // arms: counter-swing to legs
    const armAmp = lerp(lerp(0.05, 0.32, walkT), 0.62, runT) + 0.2 * sprintT;
    const elbow = lerp(lerp(0.22, 0.3, walkT), 1.45, runT) + 0.25 * sprintT;
    for (const [side, off] of [['L', 0.5], ['R', 0]]) {
      const p = ph + off;
      const sw = Math.sin(p * TAU) * armAmp;
      const th = sw + 0.04 + 0.12 * runT;
      const ph2 = elbow + (sw > 0 ? sw * 0.5 : 0) * runT;
      const al = lerp(0.1, 0.16, runT) - 0.05 * sprintT + idle * 0.015 * Math.sin(this.idleT * 0.8 + (side === 'L' ? 0 : 2));
      armTarget(side, th, ph2, al, side === 'L' ? L.handL : L.handR, 0);
      // hands come in toward the midline in front when sprinting
      if (sw > 0) (side === 'L' ? L.handL : L.handR).x -= (side === 'L' ? 1 : -1) * 0.05 * runT * (sw / Math.max(0.01, armAmp));
      (side === 'L' ? L.elbowL : L.elbowR).set(side === 'L' ? 0.4 : -0.4, 0, -1);
      (side === 'L' ? L.handRotL : L.handRotR).set(-0.1 * runT, 0, 0);
    }
    L.fingers = lerp(0.25, 0.9, runT);
    L.shoulderL.z = -0.02 * runT; L.shoulderR.z = 0.02 * runT;
    L.pack = 1;
  }

  _crouch(L, S, dt) {
    // slow sneak / slide-ready crouch (used when descend is held on ground)
    this._ground(L, S, dt);
    L.hipsPos.y -= 0.3; L.spine.x += 0.25; L.chest.x += 0.1; L.head.x -= 0.3;
    L.footL.z += 0.08; L.footR.z -= 0.08;
  }

  _air(L, S, dt) {
    const up = S.vy > 0 ? smoothstep(0, 4, S.vy) : 0;
    const fall = smoothstep(0, 10, -S.vy);
    const longFall = smoothstep(1.2, 2.6, S.airTime) * fall;
    const run = smoothstep(2, 8, S.speed);
    const boost = S.boost;
    const t = S.time;
    // legs: tuck on rise, extend and split on fall, pedal slowly in long falls
    const pedal = Math.sin(t * 5.5) * 0.35 * longFall;
    const thL = lerp(lerp(0.3 + 0.35 * run, 0.9, up), 0.25 + pedal, fall);
    const thR = lerp(lerp(-0.25 + 0.15 * run, 0.35, up), -0.2 - pedal, fall);
    const knL = lerp(lerp(0.9, 1.5, up), 0.5 + 0.2 * Math.max(0, pedal), fall);
    const knR = lerp(lerp(1.2, 1.3, up), 0.9 - 0.3 * Math.min(0, pedal), fall);
    legTarget('L', lerp(thL, 0.05, boost), lerp(knL, 0.12, boost), 0.05 + 0.1 * longFall, 0, L.footL);
    legTarget('R', lerp(thR, -0.05, boost), lerp(knR, 0.18, boost), 0.05 + 0.1 * longFall, 0, L.footR);
    L.footRotL.set(lerp(-0.2, -0.6, boost), 0.05, 0); L.footRotR.set(lerp(-0.35, -0.6, boost), -0.05, 0);
    L.kneeL.set(0.2, 0, 1); L.kneeR.set(-0.2, 0, 1);
    // arms: up and out for balance; flail gently on long falls; tucked back while boosting
    const flail = Math.sin(t * 3.1) * 0.35 * longFall;
    armTarget('L', lerp(0.5, 0.2 + flail, fall), lerp(0.8, 0.5, fall), lerp(0.35, 0.95 + flail * 0.5, fall), L.handL);
    armTarget('R', lerp(0.3, 0.2 - flail, fall), lerp(0.9, 0.5, fall), lerp(0.35, 0.95 - flail * 0.5, fall), L.handR);
    if (boost > 0) {
      _v.copy(L.handL); armTarget('L', -0.45, 0.2, 0.28, _w); L.handL.lerpVectors(_v, _w, boost);
      _v.copy(L.handR); armTarget('R', -0.45, 0.2, 0.28, _w); L.handR.lerpVectors(_v, _w, boost);
    }
    L.elbowL.set(0.6, -0.2, -1); L.elbowR.set(-0.6, -0.2, -1);
    L.spine.x = lerp(0.1, -0.05, fall) + boost * 0.18;
    L.chest.x = lerp(0.05, -0.08, fall);
    L.head.x = lerp(-0.1, 0.12, fall);
    L.hipsPos.y = lerp(0.05, 0, fall);
    L.fingers = 0.3 + 0.4 * (1 - fall);
    L.pack = 1;
  }

  _glide(L, S, dt) {
    const g = S.glide;
    const t = S.time;
    // hands on the glider bar (chest space), body hangs below with a pendulum
    const sway = Math.sin(t * 1.3) * 0.02;
    L.handL.set(0.215, 0.575 + sway, 0.08); L.handR.set(-0.215, 0.575 - sway, 0.08);
    L.elbowL.set(1, 0.1, -0.5); L.elbowR.set(-1, 0.1, -0.5);
    L.handRotL.set(0, 0, 0.2); L.handRotR.set(0, 0, -0.2);
    L.fingers = 1;
    // legs dangle, slightly bent and trailing; kick gently
    const k = Math.sin(t * 2.2) * 0.08;
    legTarget('L', 0.08 + k - g.pitch * 0.2, 0.35 + k, 0.04, 0, L.footL);
    legTarget('R', -0.02 - k - g.pitch * 0.2, 0.5 - k, 0.04, 0, L.footR);
    L.footRotL.set(-0.5, 0, 0); L.footRotR.set(-0.55, 0, 0);
    L.kneeL.set(0.15, 0, 1); L.kneeR.set(-0.15, 0, 1);
    // pendulum: body swings about the hands (pivot at the bar), less banked than the wing
    L.pivot.set(0, 1.88, 0.05);
    L.rootRot.z = -g.bank * 0.35 + g.swayZ;
    L.rootRot.x = -g.pitch * 0.25 + g.swayX;
    L.spine.x = 0.05; L.chest.x = -0.05; L.head.x = 0.1 + g.pitch * 0.2;
    L.shoulderL.z = 0.12; L.shoulderR.z = -0.12;
    L.pack = 1;
  }

  _slide(L, S, dt) {
    // surfing stance: body sideways to the motion, knees bent, arms out for balance
    const c = clamp(S.slide.carve, -1, 1);
    const sp = smoothstep(2, 14, S.speed);
    L.hipsPos.y = -0.24 - 0.06 * sp;
    L.hipsRot.y = 0.85;
    L.spine.y = 0.1; L.chest.y = -0.55; L.neck.y = -0.25; L.head.y = -0.2;
    L.spine.x = 0.28; L.chest.x = 0.12; L.head.x = -0.3;
    L.hipsRot.z = -c * 0.1;
    // feet: wide stance along the motion (lead foot = left)
    L.footL.set(0.07, DIM.ankle, 0.34); L.footR.set(-0.08, DIM.ankle, -0.3);
    L.footRotL.set(0, 0.8, 0); L.footRotR.set(0, 0.9, 0);
    L.kneeL.set(0.9, 0, 0.6); L.kneeR.set(0.7, 0, 0.8);
    L.terrain = 1;
    const wob = Math.sin(S.time * 7) * 0.05 * sp;
    armTarget('L', 0.55 + wob, 0.35, 0.75 + c * 0.2, L.handL);
    armTarget('R', -0.2 - wob, 0.45, 1.0 - c * 0.2, L.handR);
    L.elbowL.set(0.5, -0.4, -1); L.elbowR.set(-0.5, -0.4, -1);
    L.fingers = 0.2;
    L.pack = 1;
  }

  _swim(L, S, dt) {
    const mv = smoothstep(0.3, 1.6, S.speed);
    const fast = smoothstep(2.5, 4.0, S.speed);
    this.swimPhase += dt * lerp(0.55, 0.62 + fast * 0.25, mv) ;
    const ph = this.swimPhase;
    // body attitude: upright treading → horizontal crawl (pivot at the chest, which stays at the surface)
    L.pivot.set(0, 1.28, 0);
    L.rootRot.x = lerp(0.12, 1.32, mv);
    L.rootRot.z = Math.sin(ph * TAU) * 0.28 * mv; // body roll with the stroke
    L.head.x = lerp(0.05, -0.9, mv); L.neck.x = lerp(0, -0.35, mv);
    L.head.y = Math.max(0, Math.sin(ph * TAU)) * 0.5 * mv; // breathe to the side
    // arms
    for (const [side, off] of [['L', 0], ['R', 0.5]]) {
      const p = ((ph + off) % 1 + 1) % 1;
      const hand = side === 'L' ? L.handL : L.handR;
      const sgn = side === 'L' ? 1 : -1;
      // crawl path (chest space; body frame before tilt: +Y along the body, +Z = below after tilting)
      let cx, cy, cz;
      if (p < 0.55) { // catch + pull under the body
        const s = p / 0.55;
        cx = sgn * lerp(0.16, 0.1, s); cy = lerp(0.62, -0.28, s); cz = 0.2 * Math.sin(s * Math.PI) + 0.06;
      } else { // recovery above the water, elbow high
        const s = (p - 0.55) / 0.45;
        cx = sgn * (0.2 + 0.12 * Math.sin(s * Math.PI)); cy = lerp(-0.28, 0.62, s); cz = -0.22 * Math.sin(s * Math.PI) - 0.02;
      }
      // treading: sculling circles in front of the chest
      const tx = sgn * (0.26 + 0.06 * Math.cos(S.time * 3 + off * 6)), ty = 0.02, tz = 0.22 + 0.06 * Math.sin(S.time * 3 + off * 6);
      hand.set(lerp(tx, cx, mv), lerp(ty, cy, mv), lerp(tz, cz, mv));
      (side === 'L' ? L.elbowL : L.elbowR).set(sgn * 0.8, lerp(-0.3, 0.2, mv), lerp(-0.6, -0.8, mv));
      (side === 'L' ? L.handRotL : L.handRotR).set(0, 0, 0);
    }
    // legs: flutter kick (moving) / egg-beater (treading)
    const kick = Math.sin(S.time * lerp(3.5, 9, mv)) * lerp(0.25, 0.22, mv);
    legTarget('L', lerp(0.35 + kick * 0.6, 0.02 + kick, mv), lerp(1.1, 0.25, mv), lerp(0.28, 0.05, mv), 0, L.footL);
    legTarget('R', lerp(0.35 - kick * 0.6, 0.02 - kick, mv), lerp(1.1, 0.25, mv), lerp(0.28, 0.05, mv), 0, L.footR);
    L.footRotL.set(lerp(-0.2, -0.8, mv), 0, 0); L.footRotR.set(lerp(-0.2, -0.8, mv), 0, 0);
    L.kneeL.set(lerp(0.8, 0.1, mv), 0, 1); L.kneeR.set(lerp(-0.8, -0.1, mv), 0, 1);
    L.fingers = 0.05;
    L.pack = 0.3;
  }

  _climb(L, S, dt) {
    const c = S.climb;
    this.climbPhase += c.move * dt * 1.3;
    const ph = this.climbPhase;
    // lean into the wall (group faces the wall); body parallel to the rock
    L.rootRot.x = c.lean;
    L.pivot.set(0, 0.2, 0.1);
    L.hipsPos.z = 0.02;
    L.spine.x = 0.05; L.chest.x = 0.02; L.head.x = -0.45; L.neck.x = -0.2;
    // four-limb cycle: RH, LF, LH, RF
    const limb = (off) => { const p = ((ph + off) % 1 + 1) % 1; return p < 0.5 ? Math.sin(p * 2 * Math.PI) : 0; };
    const reachL = limb(0.5) * 0.28 * c.dirY, reachR = limb(0) * 0.28 * c.dirY;
    const latL = limb(0.5) * 0.12 * c.dirX, latR = limb(0) * 0.12 * c.dirX;
    const lift = (x) => Math.max(0, x);
    // hands on the wall (chest space: wall is ahead at z≈0.26)
    L.handL.set(0.24 + latL, 0.34 + reachL + Math.sin((ph + 0.5) * TAU) * 0.08 * c.move, 0.27 + lift(limb(0.5)) * -0.06);
    L.handR.set(-0.24 + latR, 0.26 + reachR + Math.sin(ph * TAU) * 0.08 * c.move, 0.27 + lift(limb(0)) * -0.06);
    L.elbowL.set(0.9, -0.5, -0.3); L.elbowR.set(-0.9, -0.5, -0.3);
    L.handRotL.set(-1.2, 0, 0.2); L.handRotR.set(-1.2, 0, -0.2);
    L.fingers = 0.75;
    // feet (group space) pushing on the wall, knees out
    const fL = limb(0.25) * 0.22 * c.dirY, fR = limb(0.75) * 0.22 * c.dirY;
    L.footL.set(0.15, 0.36 + fL, 0.24); L.footR.set(-0.15, 0.28 + fR, 0.24);
    L.footRotL.set(-0.6, 0, 0); L.footRotR.set(-0.6, 0, 0);
    L.kneeL.set(1, 0, 0.6); L.kneeR.set(-1, 0, 0.6);
    L.pack = 0.6;
  }

  _hardLand(P, w) {
    // superhero landing: deep crouch, one knee down, right hand to the ground
    const T = this.layers.crouch; // reuse storage
    T.zero();
    T.hipsPos.set(0, -0.48, -0.05);
    T.spine.x = 0.45; T.chest.x = 0.2; T.head.x = -0.55;
    T.footL.set(0.13, DIM.ankle, 0.22); T.footR.set(-0.1, DIM.ankle + 0.02, -0.42);
    T.footRotR.set(-0.9, 0, 0); T.footRotL.set(0.1, 0.1, 0);
    T.kneeL.set(0.4, 0, 1); T.kneeR.set(-0.2, -0.3, 1);
    armTarget('R', 0.95, 0.15, 0.25, T.handR, 0.05); T.handR.y -= 0.12;
    armTarget('L', 0.2, 0.9, 0.55, T.handL);
    T.elbowL.set(0.7, 0, -1); T.elbowR.set(-0.5, 0, -1);
    T.fingers = 0.2; T.terrain = 1; T.pack = 1;
    for (let i = 0; i < P._vecs.length; i++) P._vecs[i].lerp(T._vecs[i], w);
    P.fingers = lerp(P.fingers, T.fingers, w); P.terrain = lerp(P.terrain, 1, w);
  }

  // =============================================================================== solve & apply
  _setLocalEuler(b, v) { _e.set(v.x, v.y, v.z, 'YXZ'); this.lq[b].setFromEuler(_e); }

  _fk(b) {
    const p = this.parentIdx[b];
    if (p < 0) { this.gq[b].copy(this.lq[b]); this.gp[b].copy(this.lp[b]); return; }
    this.gq[b].multiplyQuaternions(this.gq[p], this.lq[b]);
    this.gp[b].copy(this.lp[b]).applyQuaternion(this.gq[p]).add(this.gp[p]);
  }

  /** Two-bone IK in group space. pole = direction the middle joint should point. endQ optional. */
  _ik(bu, bl, be, T, pole, l1, l2, poleIsFront) {
    const A = this.gp[bu];
    _v.subVectors(T, A);
    let d = _v.length();
    if (d < 1e-5) _v.set(0, -1, 0); else _v.divideScalar(d);
    d = clamp(d, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.9993);
    const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const a = Math.acos(cosA);
    _u.copy(pole).addScaledVector(_v, -pole.dot(_v));
    if (_u.lengthSq() < 1e-8) { _u.set(0, 0, 1).addScaledVector(_v, -_v.z); }
    _u.normalize();
    // upper bone direction and middle joint
    _w.copy(_v).multiplyScalar(Math.cos(a)).addScaledVector(_u, Math.sin(a)); // upper dir
    const K = _t.copy(A).addScaledVector(_w, l1);
    const pu = this.parentIdx[bu];
    // bones' rest +Z: legs → knee side (front); arms → opposite of the elbow (front)
    const fwd = poleIsFront ? _u : _n2.copy(_u).negate();
    quatFromDown(_w, fwd, this.gq[bu]);
    _qi.copy(this.gq[pu]).invert();
    this.lq[bu].multiplyQuaternions(_qi, this.gq[bu]);
    // lower
    _w.copy(A).addScaledVector(_v, d).sub(K).normalize();
    this.gp[bl].copy(K);
    quatFromDown(_w, fwd, this.gq[bl]);
    _qi.copy(this.gq[bu]).invert();
    this.lq[bl].multiplyQuaternions(_qi, this.gq[bl]);
    this.gp[be].copy(A).addScaledVector(_v, d);
  }

  _apply(P, S, dt) {
    const lq = this.lq;
    // root: rotation about pivot
    _e.set(P.rootRot.x, P.rootRot.y, P.rootRot.z, 'YXZ');
    lq[B.root].setFromEuler(_e);
    this.lp[B.root].copy(P.pivot).sub(_v.copy(P.pivot).applyQuaternion(lq[B.root]));
    // hips
    this.pelvisDrop.update(this._pelvisTarget ?? 0, dt);
    this.lp[B.hips].copy(REST_POS.hips).add(P.hipsPos);
    this.lp[B.hips].y += this.pelvisDrop.x * P.terrain;
    this._setLocalEuler(B.hips, P.hipsRot);
    this._setLocalEuler(B.spine, P.spine);
    this._setLocalEuler(B.chest, P.chest);
    this._setLocalEuler(B.neck, P.neck);
    this._setLocalEuler(B.head, P.head);
    this._setLocalEuler(B.shoulderL, P.shoulderL);
    this._setLocalEuler(B.shoulderR, P.shoulderR);
    lq[B.pack].identity();
    this.lp[B.pack].copy(REST_POS.pack).sub(REST_POS.chest);
    this.lp[B.pack].y += this.packY.x * P.pack; this.lp[B.pack].x += this.packX.x * P.pack;
    _e.set(this.antX.x, 0, this.antZ.x, 'YXZ'); lq[B.antenna].setFromEuler(_e);
    // FK down to shoulders/thighs
    for (const b of [B.root, B.hips, B.spine, B.chest, B.neck, B.head, B.shoulderL, B.shoulderR, B.pack, B.antenna]) this._fk(b);
    this._fk(B.upperArmL); this._fk(B.upperArmR); this._fk(B.thighL); this._fk(B.thighR);

    // ---- legs with terrain adaptation
    const terr = P.terrain;
    let minDh = 0;
    for (const side of ['L', 'R']) {
      const foot = side === 'L' ? P.footL : P.footR;
      // terrain layers place feet in group (ground) space; others ride with the root (swim/glide/climb tilt)
      _t.copy(foot).applyQuaternion(this.gq[B.root]).add(this.gp[B.root]).lerp(foot, clamp(terr, 0, 1));
      if (terr > 0.01 && this.H) {
        // world point under the foot (group space → planet-local)
        _v.set(foot.x, 0, foot.z).applyQuaternion(this.gquat).add(this.gpos);
        const gR = this.H.groundR(_v);
        _w.copy(_v).normalize().multiplyScalar(gR);
        let dh = _w.sub(this.gpos).dot(this.gup);
        dh = clamp(dh, -0.6, 0.6);
        this.footGround[side] = dh;
        _t.y += dh * terr;
        if (dh < minDh) minDh = dh;
        this.H.normal(_v, this.footN[side], 0.35);
      } else this.footGround[side] = 0;
      // don't let feet sink below ground in other states (except swim/climb)
      this.footWorld[side].copy(_t).applyQuaternion(this.gquat).add(this.gpos);
      const bu = side === 'L' ? B.thighL : B.thighR, bl = side === 'L' ? B.shinL : B.shinR, be = side === 'L' ? B.footL : B.footR;
      // hips moved: target relative to animated root space (group) — IK works in group space
      _z.copy(side === 'L' ? P.kneeL : P.kneeR);
      if (_z.lengthSq() < 1e-6) _z.set(0, 0, 1);
      _z.normalize().applyQuaternion(_q.setFromAxisAngle(_y.set(0, 1, 0), P.hipsRot.y * 0.6 + P.rootRot.y));
      this._ik(bu, bl, be, _t, _z, DIM.thigh, DIM.shin, true);
      // foot orientation: yaw from hips, tilt from terrain normal, pitch from gait
      const fr = side === 'L' ? P.footRotL : P.footRotR;
      _e.set(fr.x, fr.y + P.hipsRot.y * 0.3, fr.z, 'YXZ');
      _q.setFromEuler(_e);
      if (terr > 0.01 && this.H) {
        _u.copy(this.footN[side]).applyQuaternion(_qi.copy(this.gquat).invert());
        _q2.setFromUnitVectors(_y.set(0, 1, 0), _u);
        _q2.slerp(_qi.identity(), 1 - terr * 0.85);
        _q.premultiply(_q2);
      }
      this.gq[be].copy(_q);
      _qi.copy(this.gq[bl]).invert();
      lq[be].multiplyQuaternions(_qi, _q);
    }
    this._pelvisTarget = minDh < 0 ? minDh * 0.95 : 0;

    // ---- arms (targets in chest space → group space)
    for (const side of ['L', 'R']) {
      const hand = side === 'L' ? P.handL : P.handR;
      _t.copy(hand).applyQuaternion(this.gq[B.chest]).add(this.gp[B.chest]);
      const bu = side === 'L' ? B.upperArmL : B.upperArmR, bl = side === 'L' ? B.foreArmL : B.foreArmR, be = side === 'L' ? B.handL : B.handR;
      _z.copy(side === 'L' ? P.elbowL : P.elbowR);
      if (_z.lengthSq() < 1e-6) _z.set(0, 0, -1);
      _z.normalize().applyQuaternion(this.gq[B.chest]);
      this._ik(bu, bl, be, _t, _z, DIM.upper, DIM.fore, false);
      const hr = side === 'L' ? P.handRotL : P.handRotR;
      _e.set(hr.x, hr.y, hr.z, 'YXZ');
      lq[be].setFromEuler(_e);
      // fingers curl toward the palm
      const f = clamp(P.fingers, 0, 1.2);
      _e.set(0.15 * f, 0, (side === 'L' ? -1 : 1) * 0.9 * f, 'YXZ');
      lq[side === 'L' ? B.fingersL : B.fingersR].setFromEuler(_e);
      this._fk(be); this._fk(side === 'L' ? B.fingersL : B.fingersR);
    }

    // ---- write bones
    const bones = this.bones;
    for (let i = 0; i < bones.length; i++) {
      bones[i].quaternion.copy(lq[i]);
      if (i === B.hips || i === B.root || i === B.pack) bones[i].position.copy(this.lp[i]);
    }
    // first person: hide head (collapse head bone)
    const hs = this.headHidden ? 0.0001 : 1;
    bones[B.neck].scale.setScalar(hs); // collar ring + helmet collapse (first person)
    bones[B.antenna].scale.setScalar(this.headHidden ? 0.0001 : 1);
  }

  /** Eye position in group space (after update) — for the first-person camera. */
  eyeGroup(out) {
    return out.set(0, 0.075, 0.1).applyQuaternion(this.gq[B.head]).add(this.gp[B.head]);
  }
  /** Group-space transform of a bone (after update). */
  boneGroup(b, pos, quat) { if (pos) pos.copy(this.gp[b]); if (quat) quat.copy(this.gq[b]); }
  finishFK() { for (const b of this.order) this._fk(b); }
}

function depth(i, parents) { let d = 0; for (let p = parents[i]; p >= 0; p = parents[p]) d++; return d; }
