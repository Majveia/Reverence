// Player track — camera rig for the explorer.
//
//   third person : spring-arm with a critically-damped pivot, over-the-shoulder framing, look-ahead,
//                  terrain + collider collision (pull in fast, ease out slow), auto-recenter behind
//                  motion, pitch drift, FOV kick (sprint / glide / dive), trauma-based shake, glide roll.
//   first person : eye from the animated head (stabilised), body stays visible below (body awareness).
//   fly / orbit  : debug free-flight and planet overview (kept from the baseline for URL compatibility).
//
// The camera heading is a tangent vector (`fwd`) parallel-transported over the sphere every frame,
// so there is no gimbal / pole trouble anywhere on the planet. All math is planet-local float64.
import * as THREE from 'three';
import { clamp, dampF, damp, lerp, smoothstep, saturate, Spring3, Spring, projectOnPlane, orthoForward, quatLookDir, fbm1, wrapPi } from './util.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _r = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export class CameraRig {
  constructor(world, player) {
    this.world = world;
    this.player = player;
    this.cam = world.camera;
    this.fwd = new THREE.Vector3(0, 0, 1);   // tangent heading
    this.pitch = -0.14;
    this.zoom = 1;                          // user zoom multiplier (wheel / pinch)
    this.dist = 4.6;                        // current (collision-limited) arm length
    this.pivot = new Spring3(14, 1);
    this.pivotInit = false;
    this.fovBase = 58;
    this.fov = new Spring(58, 5, 1);
    this.trauma = 0;
    this.t = 0;
    this.idleLook = 99;                     // seconds since the last manual look input
    this.roll = 0;
    this.lift = 0;
    this.shoulder = 0.55;
    this.fpEye = new THREE.Vector3();
    this.fpInit = false;
    this.hideBody = false;
    this.camF = new THREE.Vector3();
    this.camRight = new THREE.Vector3();
    this.orbit = { yaw: 0, pitch: 0.25, dist: 0 };
  }

  /** Parallel-transport the heading onto the tangent plane of `up` (call once per frame). */
  transport(up) { orthoForward(up, this.fwd, this.fwd); }

  /** Apply look input (radians; x = yaw right, y = pitch up). */
  look(up, dx, dy, fp) {
    if (dx || dy) this.idleLook = 0;
    if (dx) this.fwd.applyAxisAngle(up, -dx);
    this.pitch = clamp(this.pitch + dy, fp ? -1.45 : -1.25, fp ? 1.45 : 1.05);
  }

  addTrauma(x) { this.trauma = Math.min(1, this.trauma + x); }

  /** Camera look direction (unit) and right vector at `up`. */
  frame(up) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.camF.copy(this.fwd).multiplyScalar(cp).addScaledVector(up, sp).normalize();
    this.camRight.crossVectors(this.fwd, up).normalize();
    return this.camF;
  }

  /** Rotate the heading toward a tangent direction `dir` at `rate` (rad/s-ish), used for recentering. */
  recenter(up, dir, rate, dt, maxAngle = 2.7) {
    _a.copy(dir); projectOnPlane(_a, up);
    if (_a.lengthSq() < 1e-6) return;
    _a.normalize();
    const ang = Math.atan2(_b.crossVectors(this.fwd, _a).dot(up), this.fwd.dot(_a));
    if (Math.abs(ang) > maxAngle) return;
    this.fwd.applyAxisAngle(up, ang * dampF(rate, dt));
  }

  // ---------------------------------------------------------------------------------- third person
  /**
   * @param ctx { pos (feet), up, vel, state, speed, sprint, glide, dive, grounded, heights, colliders, dt, fpBlend }
   */
  thirdPerson(dt, ctx) {
    this.t += dt;
    this.idleLook += dt;
    const up = ctx.up;
    const st = ctx.state;
    // ---- auto recenter behind motion (never fights the player: waits after manual look)
    const vt = _d.copy(ctx.vel); projectOnPlane(vt, up);
    const sp = vt.length();
    if (this.idleLook > 0.9 && sp > 1.5 && st !== 'climb') {
      const k = st === 'glide' ? 1.1 : st === 'slide' ? 1.3 : st === 'swim' ? 0.6 : 0.55;
      this.recenter(up, vt, k * smoothstep(1.5, 7, sp), dt, st === 'glide' || st === 'slide' ? 3.0 : 2.3);
    }
    const vyC = ctx.vel.dot(up);
    if (this.idleLook > 0.9 && sp > 2.5 && (st === 'slide' || st === 'ground')) {
      // follow the grade of the motion: look down the slope you're surfing / running down
      const target = clamp(-0.13 + Math.atan2(vyC, sp) * 0.75, -0.95, 0.25);
      this.pitch = damp(this.pitch, target, 1.6 * smoothstep(2.5, 9, sp), dt);
    } else if (this.idleLook > 2.2) {
      const target = st === 'glide' ? -0.2 : st === 'swim' ? -0.1 : st === 'slide' ? -0.2 : sp > 7 ? -0.16 : -0.12;
      this.pitch = damp(this.pitch, target, 0.5, dt);
    }
    // ---- arm length by state
    const glideK = st === 'glide' ? 1 : 0;
    let arm = 3.7 + 0.45 * smoothstep(6, 11, sp) * (1 - glideK) + glideK * (1.3 + (ctx.dive ? 0.9 : 0)) + (st === 'swim' ? -0.4 : 0) + (st === 'climb' ? 1.0 : 0);
    // looking up from low: shorten the arm so the camera does not dig into the ground (BotW)
    arm *= 1 - 0.35 * smoothstep(0.05, 0.9, this.pitch);
    arm *= this.zoom;
    // ---- pivot (critically damped; looser in the air so jumps don't jerk the frame)
    const pivotH = st === 'swim' ? 1.6 : st === 'slide' ? 1.2 : st === 'glide' ? 1.75 : 1.45;
    this.pivot.omega = st === 'glide' ? 10 : st === 'air' ? 12 : st === 'slide' ? 14 : 18;
    // velocity feed-forward cancels the spring's steady-state lag (2v/ω): fast falls / glides / sprints stay
    // framed, while small hops (|vy| < 4 m/s) keep their vertical smoothing
    const vy = ctx.vel.dot(up);
    const ff = 2 / this.pivot.omega;
    const tgt = _a.copy(ctx.pos).addScaledVector(up, pivotH).addScaledVector(vt, 0.1 + ff * 0.85)
      .addScaledVector(up, vy * ff * smoothstep(4, 12, Math.abs(vy)));
    if (!this.pivotInit) { this.pivot.reset(tgt); this.pivotInit = true; }
    this.pivot.update(tgt, dt);
    // never let the pivot drift too far (teleports / high speeds)
    if (this.pivot.x.distanceToSquared(tgt) > 16) this.pivot.x.lerp(tgt, 0.5);
    const pivot = _b.copy(this.pivot.x);
    // ---- desired camera position
    const camF = this.frame(up);
    const right = this.camRight;
    const sh = this.shoulder * clamp(arm / 4.5, 0.5, 1.2) * (st === 'glide' ? 0.35 : 1);
    const want = _c.copy(pivot).addScaledVector(camF, -arm).addScaledVector(right, sh);
    // ---- collision: first try to rise over terrain along the arm (BotW), then pull in as a fallback
    const H = ctx.heights;
    let lift = 0;
    if (H) {
      const N = 9;
      for (let k = 1; k <= N; k++) {
        const t = k / N;
        _f.copy(pivot).lerp(want, t);
        const deficit = H.groundR(_f) + 0.45 - _f.length();
        if (deficit > 0) lift = Math.max(lift, deficit / t);
      }
    }
    lift = Math.min(lift, 3.2);
    this.lift = lift > this.lift ? damp(this.lift, lift, 16, dt) : damp(this.lift, lift, 1.8, dt);
    want.addScaledVector(up, this.lift);
    const dir = _r.copy(want).sub(pivot);
    const len = dir.length();
    dir.divideScalar(len || 1);
    let allowed = len;
    if (H) {
      const N = 9;
      for (let k = 1; k <= N; k++) {
        const t = k / N;
        _f.copy(pivot).addScaledVector(dir, len * t);
        const gr = H.groundR(_f) + 0.3;
        if (_f.length() < gr) { allowed = Math.min(allowed, Math.max(0.6, len * (k - 0.8) / N)); break; }
      }
    }
    if (ctx.colliders) {
      const hit = ctx.colliders.raycast(pivot, dir, len, 0.28, 2.2); // small props/vehicles don't block the lens
      if (hit < allowed) allowed = Math.max(1.1, hit - 0.12);
    }
    // pull in fast, ease back out slowly
    this.dist = allowed < this.dist ? damp(this.dist, allowed, 28, dt) : damp(this.dist, allowed, 2.6, dt);
    const pos = _f.copy(pivot).addScaledVector(dir, this.dist);
    // final ground clearance (also over the terrain directly beneath the lens)
    if (H) {
      const gr = H.groundR(pos) + 0.28;
      if (pos.length() < gr) pos.setLength(gr);
      if (H.hasOcean) { // the lens never dips under the sea surface
        const sea = H.R + H.sea + (st === 'swim' ? 0.25 : 0.2);
        if (pos.length() < sea) pos.setLength(sea);
      }
    }
    // ---- shake
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const tr = this.trauma * this.trauma;
    if (tr > 1e-4) {
      const t = this.t * 22;
      pos.addScaledVector(right, fbm1(t, 1) * 0.16 * tr).addScaledVector(up, fbm1(t, 2) * 0.12 * tr);
    }
    this.cam.position.copy(pos);
    // ---- orientation: keep the heading (so the shoulder offset frames the hero off-centre)
    const rollT = st === 'glide' ? clamp(-ctx.bank * 0.12, -0.12, 0.12) : st === 'slide' ? clamp(-ctx.carve * 0.05, -0.06, 0.06) : 0;
    this.roll = damp(this.roll, rollT, 3, dt);
    const rollJ = tr > 1e-4 ? fbm1(this.t * 19, 3) * 0.018 * tr : 0;
    // tilt down to keep the hero framed when the lens rose over terrain
    const look = this.lift > 0.02 ? _d.copy(camF).addScaledVector(up, -this.lift * 0.75 / Math.max(arm, 1)).normalize() : camF;
    quatLookDir(look, up, this.cam.quaternion);
    if (this.roll || rollJ) { _q.setFromAxisAngle(_u.set(0, 0, 1), this.roll + rollJ); this.cam.quaternion.multiply(_q); }
    // ---- FOV kick
    const fovT = this.fovBase + 5 * smoothstep(6.5, 11, sp) * (st === 'ground' || st === 'slide' ? 1 : 0.4)
      + (st === 'glide' ? 6 + 8 * smoothstep(10, 24, sp) : 0) + (st === 'slide' ? 4 * smoothstep(6, 18, sp) : 0)
      + (st === 'air' ? 5 * smoothstep(12, 30, sp) : 0) + ctx.boost * 5;
    this._setFov(this.fov.update(fovT, dt));
    this.hideBody = this.dist < 0.75;
    this.fpInit = false;
  }

  // ---------------------------------------------------------------------------------- first person
  firstPerson(dt, ctx, eyeLocal) {
    this.t += dt;
    this.idleLook += dt;
    const up = ctx.up;
    // stabilise the animated eye (keep ~35% of the head motion: alive but not nauseating)
    const stable = _a.copy(ctx.pos).addScaledVector(up, ctx.state === 'swim' ? 1.4 : ctx.state === 'slide' ? 1.25 : 1.64);
    const eye = _b.copy(stable).lerp(eyeLocal, 0.4);
    if (!this.fpInit) { this.fpEye.copy(eye); this.fpInit = true; }
    this.fpEye.lerp(eye, dampF(30, dt));
    if (this.fpEye.distanceToSquared(eye) > 1) this.fpEye.copy(eye);
    const camF = this.frame(up);
    // push the lens slightly forward so the neck ring never clips into view
    const pos = _c.copy(this.fpEye).addScaledVector(this.fwd, 0.14);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const tr = this.trauma * this.trauma;
    this.cam.position.copy(pos);
    quatLookDir(camF, up, this.cam.quaternion);
    const roll = (ctx.state === 'glide' ? clamp(-ctx.bank * 0.15, -0.15, 0.15) : 0) + (tr > 1e-4 ? fbm1(this.t * 19, 3) * 0.02 * tr : 0);
    this.roll = damp(this.roll, roll, 4, dt);
    if (Math.abs(this.roll) > 1e-5) { _q.setFromAxisAngle(_u.set(0, 0, 1), this.roll); this.cam.quaternion.multiply(_q); }
    if (tr > 1e-4) { _q.setFromAxisAngle(_u.set(1, 0, 0), fbm1(this.t * 21, 5) * 0.02 * tr); this.cam.quaternion.multiply(_q); }
    const sp = Math.hypot(ctx.vel.x, ctx.vel.y, ctx.vel.z);
    const fovT = 72 + 6 * smoothstep(6.5, 11, sp) + (ctx.state === 'glide' ? 8 : 0) + ctx.boost * 4;
    this._setFov(this.fov.update(fovT, dt));
    this.hideBody = false;
    this.pivotInit = false;
  }

  _setFov(f) {
    if (Math.abs(this.cam.fov - f) > 0.01) { this.cam.fov = f; this.cam.updateProjectionMatrix(); }
  }

  // ---------------------------------------------------------------------------------- orbit / fly
  orbitView(dt, input, R) {
    const o = this.orbit, look = input.axis('look');
    if (!o.dist) o.dist = R * 3.2;
    o.yaw -= look.x; o.pitch = clamp(o.pitch + look.y, -1.4, 1.4);
    if (input.zoom) o.dist = clamp(o.dist * Math.exp(-input.zoom), R * 1.05, R * 40);
    const cp = Math.cos(o.pitch);
    this.cam.position.set(Math.sin(o.yaw) * cp, Math.sin(o.pitch), Math.cos(o.yaw) * cp).multiplyScalar(o.dist);
    // planet-local orientation (camera is a child of world.root, which only translates): look at the centre
    _a.copy(this.cam.position).negate().normalize();
    _u.set(0, 1, 0);
    if (Math.abs(_a.y) > 0.999) _u.set(0, 0, 1);
    quatLookDir(_a, _u, this.cam.quaternion);
    this._setFov(this.fov.update(55, dt));
  }

  flyView(dt, pos, up) {
    const camF = this.frame(up);
    this.cam.position.copy(pos);
    quatLookDir(camF, up, this.cam.quaternion);
    this._setFov(this.fov.update(62, dt));
  }
}
