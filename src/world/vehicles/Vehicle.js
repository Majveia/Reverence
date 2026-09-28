// Base class for drivable vehicles. Implements the controller contract used by World.setController:
//   .pos .vel .forward .up .view .inputScheme, onControlGained(prev) / onControlLost(next)
// Subclasses provide: build(), simulate(dt, input, active), animate(dt, t), camCfg, exitOffset(),
// promptText, getState().
import * as THREE from 'three';
import { VehicleCamera, CINE } from './camera.js';
import { quatFromFrame, orthoForward } from './util.js';

const _v = new THREE.Vector3(), _q = new THREE.Quaternion();

export class Vehicle {
  constructor(mgr, type, opts = {}) {
    this.mgr = mgr;
    this.world = mgr.world;
    this.ground = mgr.ground;
    this.type = type;
    this.id = opts.id ?? type;
    this.inputScheme = 'vehicle';
    this.group = new THREE.Group();
    this.group.name = 'vehicle-' + this.id;
    this.world.root.add(this.group);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.fwdVec = new THREE.Vector3(0, 0, 1);
    this.upVec = new THREE.Vector3(0, 1, 0);
    this.rightVec = new THREE.Vector3(1, 0, 0);
    this.radialUp = new THREE.Vector3(0, 1, 0);
    this.occupied = false;
    this.awake = true;
    this.sleepT = 0;
    this.visible = true;
    this.bank = 0;
    this.speed = 0;
    this.view = 'chase';
    this.promptText = 'Enter';
    this.camera = null;
    this.collider = null;
    this.colliderRadius = 1.5;
    this.boost = 0;
    this.engine = 0;
    this.distToCam = 0;
    this.enterRadius = 3.5;
  }

  // ---- controller contract (read by other tracks: audio, UI, terrain focus…)
  get forward() { return this.fwdVec; }
  get up() { return this.upVec; }

  initCamera(cfg) {
    this.camera = new VehicleCamera(this.world, this, cfg);
    const cam = this.world.params?.cam;
    if (cam && CINE[cam]) this.camera.cine = CINE[cam];
    if (cam === 'cockpit') this.camera.mode = 'cockpit';
  }

  /** Place at a planet-local position with a heading (tangent) direction. */
  place(pos, heading) {
    this.pos.copy(pos);
    this.radialUp.copy(pos).normalize();
    orthoForward(this.radialUp, heading, this.fwdVec);
    quatFromFrame(this.radialUp, this.fwdVec, this.quat);
    this.vel.set(0, 0, 0);
    this._syncFrame();
    if (this.heading?.isVector3) this.heading.copy(this.fwdVec);
    this.syncTransform();
    this.wake();
  }

  _syncFrame() {
    this.fwdVec.set(0, 0, 1).applyQuaternion(this.quat);
    this.upVec.set(0, 1, 0).applyQuaternion(this.quat);
    this.rightVec.set(-1, 0, 0).applyQuaternion(this.quat); // driver's right (model −X when +Z is forward)
    this.radialUp.copy(this.pos).normalize();
  }

  syncTransform() {
    this.group.position.copy(this.pos);
    this.group.quaternion.copy(this.quat);
    if (this.collider) this.collider.pos.copy(this.pos).addScaledVector(this.upVec, this.colliderLift ?? 0.6);
  }

  wake() { this.awake = true; this.sleepT = 0; }

  registerCollider() {
    // lets the player (and other tracks) bump into parked vehicles; tag 'vehicle:*' so we ignore it ourselves
    this.collider = { type: 'sphere', pos: this.pos.clone(), radius: this.colliderRadius, tag: 'vehicle:' + this.type, vehicle: true };
    try { this.world.addCollider?.(this.collider); } catch (_) { this.collider = null; }
  }

  onControlGained() {
    this.occupied = true;
    this.wake();
    this.camera?.reset();
    this.mgr.onEnter(this);
  }
  onControlLost() {
    this.occupied = false;
    this.mgr.onExit(this);
  }

  /** Where the player stands after getting off (planet-local). */
  exitPoint(out) {
    return out.copy(this.pos).addScaledVector(this.rightVec, -(this.exitSide ?? 1.4));
  }

  // hooks
  build() {}
  simulate() {}
  animate() {}
  updateCamera(dt, input) {
    if (!this.camera) return;
    this.camera.update(dt, {
      look: input.axis('look'), zoom: input.zoom, speed: this.speed, boost: this.boost, rough: this.rough ?? 0,
      engine: this.engine, radialUp: this.radialUp,
    });
  }
  getState() { return { pos: this.pos.toArray().map((x) => Math.round(x)), speed: +this.speed.toFixed(2), occupied: this.occupied, awake: this.awake }; }

  dispose() {
    if (this.collider) { try { this.world.removeCollider?.(this.collider); } catch (_) { /* ignore */ } }
    this.group.traverse((o) => { o.geometry?.dispose?.(); });
    this.group.removeFromParent();
    for (const m of this.materials || []) m?.dispose?.();
  }
}

export function quatLookFrame(up, fwd) { return quatFromFrame(up, fwd, _q.clone()); }
export { _v as scratchV };
