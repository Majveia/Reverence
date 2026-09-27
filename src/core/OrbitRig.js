// Cinematic orbit camera rig for map-like scales (cosmic web, galaxy, system overview).
// Critically-damped, frame-rate independent; supports fly-to, zoom-to-cursor-free zoom,
// WASD pan, and an idle "breathing" drift so the view never feels static.
import * as THREE from 'three';
import { clamp, dampFactor, wrapAngle } from './math.js';

export class OrbitRig {
  constructor(camera, opts = {}) {
    this.camera = camera;
    this.target = new THREE.Vector3();
    this.yaw = opts.yaw ?? 0.6;
    this.pitch = opts.pitch ?? 0.35;
    this.distance = opts.distance ?? 100;
    this.minDistance = opts.minDistance ?? 0.1;
    this.maxDistance = opts.maxDistance ?? 1e6;
    this.minPitch = opts.minPitch ?? -1.45;
    this.maxPitch = opts.maxPitch ?? 1.45;
    this.panSpeed = opts.panSpeed ?? 1.0;
    this.idleDrift = opts.idleDrift ?? 0.02;   // rad/s auto-rotation when idle
    this.smooth = opts.smooth ?? 6;            // damping rate
    // current (smoothed) values
    this._yaw = this.yaw; this._pitch = this.pitch; this._dist = this.distance;
    this._target = this.target.clone();
    this._fly = null;
    this.idle = 0;
    this.up = new THREE.Vector3(0, 1, 0);
  }

  /** Smoothly travel to a new target/distance over `duration` seconds (ease in-out). */
  flyTo(target, distance = this.distance, duration = 2.0, { yaw, pitch } = {}) {
    this._fly = {
      from: this._target.clone(), to: target.clone(),
      d0: this._dist, d1: clamp(distance, this.minDistance, this.maxDistance),
      y0: this._yaw, y1: yaw ?? this._yaw, p0: this._pitch, p1: pitch ?? this._pitch,
      t: 0, dur: Math.max(0.01, duration),
    };
  }
  get flying() { return !!this._fly; }

  /** Apply input (look radians, zoom delta, move axis) — call each frame before update(). */
  handleInput(input, dt) {
    const look = input.axis('look');
    const move = input.axis('move');
    const active = look.lengthSq() > 0 || input.zoom !== 0 || move.lengthSq() > 0;
    if (active) { this.idle = 0; if (this._fly && (look.lengthSq() > 1e-6 || input.zoom)) this._fly = null; }
    this.yaw -= look.x;
    this.pitch = clamp(this.pitch + look.y, this.minPitch, this.maxPitch);
    if (input.zoom) this.distance = clamp(this.distance * Math.exp(-input.zoom * 1.1), this.minDistance, this.maxDistance);
    if (move.lengthSq() > 0) {
      // pan in the camera's horizontal plane, speed proportional to distance
      const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const sp = this.distance * 0.8 * this.panSpeed * dt * (input.held('boost') ? 3 : 1);
      this.target.addScaledVector(f, move.y * sp).addScaledVector(r, move.x * sp);
    }
    if (input.held('ascend')) this.target.y += this.distance * 0.6 * dt;
    if (input.held('descend')) this.target.y -= this.distance * 0.6 * dt;
  }

  update(dt) {
    this.idle += dt;
    if (this._fly) {
      const f = this._fly;
      f.t += dt;
      const u = clamp(f.t / f.dur, 0, 1);
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      // log-space distance interpolation feels natural across orders of magnitude
      const ld = Math.log(f.d0) + (Math.log(f.d1) - Math.log(f.d0)) * e;
      this.distance = this._dist = Math.exp(ld);
      this.target.lerpVectors(f.from, f.to, e); this._target.copy(this.target);
      this.yaw = this._yaw = f.y0 + wrapAngle(f.y1 - f.y0) * e;
      this.pitch = this._pitch = f.p0 + (f.p1 - f.p0) * e;
      if (u >= 1) this._fly = null;
    } else {
      if (this.idle > 4 && this.idleDrift) this.yaw += this.idleDrift * dt * Math.min(1, (this.idle - 4) / 3);
      const k = dampFactor(this.smooth, dt);
      this._yaw += wrapAngle(this.yaw - this._yaw) * k;
      this._pitch += (this.pitch - this._pitch) * k;
      this._dist = Math.exp(Math.log(this._dist) + (Math.log(this.distance) - Math.log(this._dist)) * k);
      this._target.lerp(this.target, k);
    }
    const cp = Math.cos(this._pitch), sp = Math.sin(this._pitch);
    const offset = new THREE.Vector3(Math.sin(this._yaw) * cp, sp, Math.cos(this._yaw) * cp).multiplyScalar(this._dist);
    this.camera.position.copy(this._target).add(offset);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this._target);
  }
}
