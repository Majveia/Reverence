// Built-in free camera ("spirit" mode).  Always available: the fallback when no avatar/vehicle module is loaded,
// the photo-mode camera, and the camera the screenshot harness positions.  Speed scales with altitude so the same
// controls work from a flower to low orbit.
import * as THREE from 'three';
import { damp } from '../../core/rng.js';

const _up = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3();

export class FlyCam {
  constructor(ctx) {
    this.ctx = ctx; this.id = 'fly';
    this.position = new THREE.Vector3(0, 0, 1e5);
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.fov = 55;
    this.speedScale = 1;
    this._look = new THREE.Vector3(0, 0, -1);    // view direction, scene space
  }

  enter(h) {
    if (h?.position) this.position.copy(h.position);
    if (h?.quaternion) { this.quaternion.copy(h.quaternion); this._look.set(0, 0, -1).applyQuaternion(this.quaternion); }
    if (h?.cameraPosition) this.position.copy(h.cameraPosition);
    if (h?.cameraQuaternion) { this.quaternion.copy(h.cameraQuaternion); this._look.set(0, 0, -1).applyQuaternion(this.quaternion); }
    this.velocity.set(0, 0, 0);
    this.ctx.engine.input.wantLock = false;
  }
  exit() { return {}; }

  /** Point the camera at a scene-space target. */
  lookAt(target) { this._look.copy(target).sub(this.position).normalize(); this._sync(); }
  setPose(position, target) { this.position.copy(position); this.lookAt(target); }

  _localUp(out) {
    const w = this.ctx.world;
    if (w) return out.copy(this.position).normalize();
    return out.set(0, 1, 0);
  }

  _sync() {
    this._localUp(_up);
    _f.copy(this._look).normalize();
    _r.crossVectors(_f, _up); if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0).cross(_f); _r.normalize();
    _v.crossVectors(_r, _f);
    _m.makeBasis(_r, _v, _f.clone().negate());
    this.quaternion.setFromRotationMatrix(_m);
  }

  update(dt, frame) {
    const input = this.ctx.engine.input, w = this.ctx.world;
    this._localUp(_up);
    // look
    const lx = input.look.x * 0.0022, ly = input.look.y * 0.0022;
    if (lx || ly) {
      _r.crossVectors(this._look, _up).normalize();
      _q.setFromAxisAngle(_up, -lx); this._look.applyQuaternion(_q);
      const pitch = Math.asin(THREE.MathUtils.clamp(this._look.dot(_up), -1, 1));
      const np = THREE.MathUtils.clamp(pitch - ly, -1.5, 1.5);
      _q.setFromAxisAngle(_r, np - pitch); this._look.applyQuaternion(_q).normalize();
    }
    // keep the view direction's pitch stable as "up" turns while we travel round the globe
    this._sync();

    if (input.zoom) this.speedScale = THREE.MathUtils.clamp(this.speedScale * Math.pow(1.25, -input.zoom), 0.02, 400);
    const alt = w ? Math.max(1.5, w.clearance(this.position)) : Math.max(1e3, this.position.length() * 0.2);
    const base = THREE.MathUtils.clamp(alt * 0.9, 6, 4e7) * this.speedScale * (input.down('boost') ? 4 : 1);
    _f.copy(this._look); _r.crossVectors(_f, _up).normalize();
    _v.set(0, 0, 0).addScaledVector(_f, input.move.y).addScaledVector(_r, input.move.x).addScaledVector(_up, (input.down('up') ? 1 : 0) - (input.down('down') ? 1 : 0));
    if (_v.lengthSq() > 1) _v.normalize();
    _v.multiplyScalar(base);
    const k = 1 - Math.exp(-dt * 5);
    this.velocity.lerp(_v, k);
    this.position.addScaledVector(this.velocity, dt);
    if (w) { const c = w.clearance(this.position); if (c < 0.6) this.position.addScaledVector(_up.copy(this.position).normalize(), 0.6 - c); }
    this.fov = damp(this.fov, 55, 4, dt);

    const cam = frame.camera;
    cam.position.copy(this.position); cam.quaternion.copy(this.quaternion);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  hud() { return { mode: 'Spirit', speed: this.velocity.length() }; }
}
