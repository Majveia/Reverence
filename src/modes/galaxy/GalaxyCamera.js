// GalaxyCamera — orbit rig for galactic scales. Log-distance zoom spanning ~15 orders of magnitude
// (whole galaxy → accretion disk), zoom-toward-cursor on the galactic plane, cinematic flyTo with
// log-space interpolation, idle drift. The target lives in the PATTERN frame so a focused region
// co-rotates with the spiral pattern.
import * as THREE from 'three';
import { clamp, dampFactor, wrapAngle } from '../../core/math.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _r = new THREE.Ray();

export function rotTheta(v, a, out = v) {
  const c = Math.cos(a), s = Math.sin(a);
  const x = v.x * c - v.z * s, z = v.x * s + v.z * c;
  return out.set(x, v.y, z);
}

export class GalaxyCamera {
  constructor(camera, opts = {}) {
    this.camera = camera;
    this.target = new THREE.Vector3();     // pattern frame (kly)
    this.yaw = opts.yaw ?? 0.6;
    this.pitch = opts.pitch ?? 0.6;
    this.logDist = Math.log(opts.distance ?? 100);
    this.minLogDist = Math.log(opts.minDistance ?? 1e-9);
    this.maxLogDist = Math.log(opts.maxDistance ?? 1000);
    this.maxTarget = opts.maxTarget ?? 150;
    this._yaw = this.yaw; this._pitch = this.pitch; this._logDist = this.logDist;
    this._target = this.target.clone();
    this.fly = null;
    this.idle = 0;
    this.idleDrift = opts.idleDrift ?? 0.012;
    this.world = new THREE.Vector3();      // smoothed target in world frame (after update)
    this.pat = 0;
  }

  get distance() { return Math.exp(this._logDist); }
  get targetDistance() { return Math.exp(this.logDist); }

  setView({ target, distance, yaw, pitch }) {
    if (target) { this.target.copy(target); this._target.copy(target); }
    if (distance) { this.logDist = this._logDist = Math.log(distance); }
    if (yaw !== undefined) this.yaw = this._yaw = yaw;
    if (pitch !== undefined) this.pitch = this._pitch = pitch;
    this.fly = null;
  }

  flyTo(target, distance, duration = 3, { yaw, pitch, arc = 0.25 } = {}) {
    this.fly = {
      from: this._target.clone(), to: target.clone(),
      l0: this._logDist, l1: clamp(Math.log(distance), this.minLogDist, this.maxLogDist),
      y0: this._yaw, y1: yaw ?? this._yaw, p0: this._pitch, p1: pitch ?? this._pitch,
      t: 0, dur: Math.max(0.05, duration), arc,
    };
  }
  get flying() { return !!this.fly; }

  /**
   * @param ctx.cursorPoint(nx, ny) → pattern-frame point under the cursor (or null)
   */
  handleInput(input, dt, ctx = {}) {
    const look = input.axis('look'), move = input.axis('move');
    const active = look.lengthSq() > 1e-8 || input.zoom !== 0 || move.lengthSq() > 0 || input.held('ascend') || input.held('descend');
    if (active) { this.idle = 0; if (this.fly && (look.lengthSq() > 1e-6 || input.zoom)) this.fly = null; }
    if (this.fly) return;
    this.yaw -= look.x;
    this.pitch = clamp(this.pitch + look.y, -1.52, 1.52);
    if (input.zoom) {
      const old = this.logDist;
      this.logDist = clamp(this.logDist - input.zoom * 1.1, this.minLogDist, this.maxLogDist);
      const k = 1 - Math.exp(this.logDist - old);     // fraction of the way to the cursor point
      if (k > 0 && ctx.cursorPoint && !ctx.lockTarget) {
        const p = ctx.cursorPoint(input.pointer.nx, input.pointer.ny);
        if (p) this.target.lerp(p, clamp(k, 0, 0.6));
      }
    }
    if (move.lengthSq() > 0) {
      // pan in the camera's horizontal plane (world), converted to the pattern frame
      const d = Math.exp(this.logDist);
      const f = _v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const r = _v2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const sp = d * 0.9 * dt * (input.held('boost') ? 3 : 1);
      const w = f.multiplyScalar(move.y * sp).add(r.multiplyScalar(move.x * sp));
      rotTheta(w, -this.pat);
      this.target.add(w);
    }
    const d = Math.exp(this.logDist);
    if (input.held('ascend')) this.target.y += d * 0.6 * dt;
    if (input.held('descend')) this.target.y -= d * 0.6 * dt;
    if (this.target.length() > this.maxTarget) this.target.setLength(this.maxTarget);
  }

  update(dt, pat) {
    this.pat = pat;
    this.idle += dt;
    if (this.fly) {
      const f = this.fly;
      f.t += dt;
      const u = clamp(f.t / f.dur, 0, 1);
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      // zoom out a little mid-flight when travelling far (cinematic arc)
      const travel = f.from.distanceTo(f.to);
      const bump = f.arc * Math.log(1 + travel / Math.exp(Math.min(f.l0, f.l1))) * Math.sin(Math.PI * e);
      this.logDist = this._logDist = f.l0 + (f.l1 - f.l0) * e + bump;
      // move the target in log-distance-aware fashion: the target converges faster when zooming in
      const et = f.l1 < f.l0 ? 1 - Math.pow(1 - e, 1.6) : e;
      this.target.lerpVectors(f.from, f.to, et); this._target.copy(this.target);
      this.yaw = this._yaw = f.y0 + wrapAngle(f.y1 - f.y0) * e;
      this.pitch = this._pitch = f.p0 + (f.p1 - f.p0) * e;
      if (u >= 1) this.fly = null;
    } else {
      if (this.idle > 6 && this.idleDrift) this.yaw += this.idleDrift * dt * Math.min(1, (this.idle - 6) / 4);
      const k = dampFactor(7, dt);
      this._yaw += wrapAngle(this.yaw - this._yaw) * k;
      this._pitch += (this.pitch - this._pitch) * k;
      this._logDist += (this.logDist - this._logDist) * dampFactor(6, dt);
      this._target.lerp(this.target, dampFactor(5, dt));
    }
    const dist = Math.exp(this._logDist);
    rotTheta(this._target, pat, this.world);
    const cp = Math.cos(this._pitch), sp = Math.sin(this._pitch);
    this.camera.position.set(Math.sin(this._yaw) * cp, sp, Math.cos(this._yaw) * cp).multiplyScalar(dist).add(this.world);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.world);
    // clip planes follow the scale (reversed-Z float depth keeps precision)
    const near = Math.max(dist * 2e-5, 1e-14), far = Math.max(dist * 200, 4000);
    if (Math.abs(this.camera.near / near - 1) > 0.05 || Math.abs(this.camera.far / far - 1) > 0.05) {
      this.camera.near = near; this.camera.far = far; this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  /** World-space pick ray through normalized device coords. */
  ray(nx, ny, out = _r) {
    _v.set(nx, ny, 0.5).unproject(this.camera);
    out.origin.copy(this.camera.position);
    out.direction.copy(_v).sub(this.camera.position).normalize();
    return out;
  }
}
