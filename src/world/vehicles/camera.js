// Vehicle camera rig: spring chase camera with heading lag, speed-based FOV + boost kick,
// procedural shake (engine rumble, terrain, impacts), free look that re-centres, cockpit views,
// cinematic presets for captures (cam=side|front|low|high|top), terrain clearance.
import * as THREE from 'three';
import { clamp, damp, dampF, fbm1, lookQuat, orthoForward, projectOnPlane, smoothstep } from './util.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();
const _r = new THREE.Vector3(), _t = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();

export const CAM_MODES = ['chase', 'cockpit'];

export class VehicleCamera {
  /**
   * cfg: { dist, height, pivot, lookAhead, fovBase, fovSpeed, fovBoost, speedRef, yawLag, distSpeed,
   *        heightSpeed, roll, shake, cockpitEye [x,y,z], cockpitFov, orbit (ship: follow full orientation) }
   */
  constructor(world, vehicle, cfg) {
    this.world = world;
    this.v = vehicle;
    this.cfg = cfg;
    this.cam = world.camera;
    this.mode = 'chase';
    this.cine = null;          // cinematic preset from URL (cam=side etc.)
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = new THREE.Vector3(0, 0, 1);
    this.camUp = new THREE.Vector3(0, 1, 0);
    this.quat = new THREE.Quaternion();
    this.lookYaw = 0; this.lookPitch = 0; this.idle = 0;
    this.zoom = 1;
    this.fov = cfg.fovBase ?? 62;
    this.shakeT = 0;
    this.impact = 0;
    this.boostKick = 0;
    this.roll = 0;
    this.snapped = false;
    this.focus = new THREE.Vector3();
  }

  reset() { this.snapped = false; this.lookYaw = 0; this.lookPitch = 0; }
  kick(amount) { this.impact = Math.min(2, this.impact + amount); }

  toggle() {
    this.mode = this.mode === 'chase' ? 'cockpit' : 'chase';
    this.snapped = false;
    this.lookYaw = 0; this.lookPitch = 0;
  }

  /**
   * Update the world camera. `look` = input look delta (radians), `allowLook` false when look steers
   * the vehicle (ship in flight). speed01 in 0..1, boost 0..1, rough = terrain roughness shake.
   */
  update(dt, { look, allowLook = true, zoom = 0, speed = 0, boost = 0, rough = 0, engine = 0, radialUp }) {
    const c = this.cfg, v = this.v, cam = this.cam;
    const sp01 = clamp(speed / (c.speedRef || 40), 0, 1.6);
    if (zoom) this.zoom = clamp(this.zoom * Math.exp(-zoom * 0.6), 0.55, 2.4);

    // free look (re-centres after idle)
    if (allowLook && look && (look.x !== 0 || look.y !== 0)) {
      this.lookYaw = clamp(this.lookYaw + look.x, -Math.PI * 0.95, Math.PI * 0.95);
      this.lookPitch = clamp(this.lookPitch + look.y, -0.9, 0.75);
      this.idle = 0;
    } else {
      this.idle += dt;
      const recenter = this.mode === 'cockpit' ? 0.6 : (c.recenter ?? 1.1);
      if (this.idle > recenter && speed > 2) {
        this.lookYaw = damp(this.lookYaw, 0, 2.2, dt);
        this.lookPitch = damp(this.lookPitch, 0, 2.2, dt);
      }
    }

    const up = radialUp || _u.copy(v.pos).normalize();
    const vUp = v.upVec, vFwd = v.fwdVec;

    // ---- shake (rotation offsets)
    this.shakeT += dt;
    this.impact = Math.max(0, this.impact - dt * 2.5);
    const sh = (c.shake ?? 1) * (0.02 * engine + 0.06 * sp01 * sp01 + 0.12 * boost + 0.25 * rough + this.impact * 0.9);
    const t = this.shakeT;
    const shYaw = fbm1(t * 9.0, 1) * sh * 0.018;
    const shPitch = fbm1(t * 11.0, 2) * sh * 0.022;
    const shRoll = fbm1(t * 7.0, 3) * sh * 0.012;

    // ---- FOV
    this.boostKick = damp(this.boostKick, boost, boost > this.boostKick ? 6 : 2.5, dt);
    const fovT = this.mode === 'cockpit'
      ? (c.cockpitFov ?? 70) + (c.fovSpeed ?? 14) * 0.6 * Math.min(1, sp01) + (c.fovBoost ?? 10) * 0.7 * this.boostKick
      : (c.fovBase ?? 62) + (c.fovSpeed ?? 14) * Math.min(1.0, sp01) + (c.fovBoost ?? 10) * this.boostKick;
    this.fov = damp(this.fov, fovT, 3.0, dt);

    if (this.mode === 'cockpit' && c.cockpitEye) {
      // rigid head in the vehicle frame + look
      _v.set(c.cockpitEye[0], c.cockpitEye[1], c.cockpitEye[2]).applyQuaternion(v.quat);
      this.pos.copy(v.pos).add(_v);
      _e.set(this.lookPitch * 0.8 + shPitch * 0.5 + (c.cockpitPitch ?? -0.06), this.lookYaw + shYaw * 0.5 + Math.PI, shRoll * 0.5, 'YXZ');
      _q.setFromEuler(_e);
      this.quat.copy(v.quat).multiply(_q);
      cam.position.copy(this.pos);
      cam.quaternion.copy(this.quat);
      this._applyFov(cam);
      this.snapped = true;
      return;
    }

    // ---- chase
    const cine = this.cine;
    if (c.orbit) {
      // ship: follow full orientation with lag (rolls with the ship)
      if (!this.snapped) this.quat.copy(v.quat);
      const rate = c.rotLag ?? 4.5;
      this.quat.slerp(v.quat, dampF(rate, dt));
      _f.set(0, 0, 1).applyQuaternion(this.quat);
      _w.set(0, 1, 0).applyQuaternion(this.quat);
      // blend camera up toward radial up in atmosphere / near ground for a stable horizon
      const hb = c.horizonBlend ? c.horizonBlend() : 0;
      if (hb > 0) { _w.lerp(up, hb).normalize(); }
      this.heading.copy(_f);
      this.camUp.copy(_w);
    } else {
      // ground vehicles: heading in the tangent plane follows the vehicle with lag
      orthoForward(up, vFwd, _f);
      if (!this.snapped) this.heading.copy(_f);
      projectOnPlane(this.heading, up).normalize();
      const lag = (c.yawLag ?? 5) * (0.6 + 0.4 * (1 - Math.min(1, sp01)));
      this.heading.lerp(_f, dampF(lag, dt)).normalize();
      if (this.heading.lengthSq() < 0.5) this.heading.copy(_f);
      this.camUp.copy(up);
    }

    // orientation around the pivot: heading, then free-look yaw/pitch
    const H = this.heading, U = this.camUp;
    _r.crossVectors(H, U).normalize();               // right
    let pitch = (c.pitch ?? -0.12) + this.lookPitch;
    let yaw = this.lookYaw;
    let dist = (c.dist ?? 6) * this.zoom * (1 + (c.distSpeed ?? 0.15) * Math.min(1.2, sp01)) * (1 + this.boostKick * (c.distBoost ?? 0.06));
    let height = (c.height ?? 1.8) * this.zoom * (1 - (c.heightSpeed ?? 0.12) * Math.min(1, sp01));
    let side = 0;
    if (cine) {
      yaw += cine.yaw; pitch += cine.pitch; dist *= cine.dist; height *= cine.height; side = cine.side ?? 0;
    }
    // direction from pivot to camera
    _v.copy(H).multiplyScalar(-Math.cos(yaw)).addScaledVector(_r, -Math.sin(yaw));
    _v.multiplyScalar(Math.cos(pitch)).addScaledVector(U, -Math.sin(pitch));
    const pivot = _t.copy(v.pos).addScaledVector(c.orbit ? vUp : U, c.pivot ?? 1.0);
    const desired = _w.copy(pivot).addScaledVector(_v, dist).addScaledVector(U, height * 0.35).addScaledVector(_r, side);

    // spring toward desired (position lag gives a sense of mass/speed)
    if (!this.snapped) { this.pos.copy(desired); this.vel.set(0, 0, 0); }
    else {
      const k = c.posLag ?? 14;
      // follow the vehicle rigidly along its velocity so fast motion never leaves the camera behind
      this.pos.addScaledVector(v.vel, dt);
      this.pos.lerp(desired, dampF(k, dt));
    }

    // terrain clearance
    const ground = this.v.ground;
    if (ground && ground.solid) {
      const h = ground.supportAt(this.pos);
      const r = this.world.body.radius + h + (c.clearance ?? 0.6);
      const l = this.pos.length();
      if (l < r) this.pos.multiplyScalar(r / l);
    }

    // aim: look at pivot + ahead
    const ahead = (c.lookAhead ?? 3) * (0.5 + 0.5 * Math.min(1, sp01)) * (cine ? cine.ahead ?? 1 : 1);
    this.focus.copy(pivot).addScaledVector(H, ahead * Math.cos(yaw)).addScaledVector(_r, ahead * Math.sin(yaw) * 0.5);
    if (c.aimHeight) this.focus.addScaledVector(U, c.aimHeight);
    _v.copy(this.focus).sub(this.pos);
    if (_v.lengthSq() < 1e-6) _v.copy(H);
    _v.normalize();
    // camera roll with vehicle bank
    this.roll = damp(this.roll, (v.bank ?? 0) * (c.roll ?? 0), 4, dt);
    _u.copy(U).applyAxisAngle(_v, this.roll + shRoll).normalize();
    lookQuat(_v, _u, this.quat);
    _e.set(shPitch, shYaw, 0, 'YXZ');
    _q2.setFromEuler(_e);
    this.quat.multiply(_q2);
    cam.position.copy(this.pos);
    cam.quaternion.copy(this.quat);
    this._applyFov(cam);
    this.snapped = true;
  }

  _applyFov(cam) {
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }
}

/** Cinematic camera presets (URL cam=...). yaw/pitch in radians relative to heading. */
export const CINE = {
  side: { yaw: Math.PI * 0.52, pitch: -0.02, dist: 0.95, height: 0.4, ahead: 0.3 },
  front: { yaw: Math.PI * 0.86, pitch: -0.06, dist: 1.0, height: 0.5, ahead: 0.1 },
  low: { yaw: Math.PI * 0.18, pitch: 0.1, dist: 0.9, height: 0.05, ahead: 1.0 },
  high: { yaw: Math.PI * 0.12, pitch: -0.55, dist: 1.5, height: 1.4, ahead: 0.8 },
  top: { yaw: 0.0, pitch: -1.2, dist: 1.7, height: 0.2, ahead: 0.2 },
  quarter: { yaw: Math.PI * 0.72, pitch: -0.12, dist: 1.05, height: 0.6, ahead: 0.3 },
  rear: { yaw: Math.PI * 0.08, pitch: -0.05, dist: 0.8, height: 0.3, ahead: 1.2 },
};

export { smoothstep };
