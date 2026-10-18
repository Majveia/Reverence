// Celestial frame for the current body (planet or moon).
//  - Inertial frame: star at origin, ecliptic = XZ plane (see universe/orbits.js)
//  - Planet-local frame: planet center at origin, +Y = north pole, fixed to the rotating ground
// In the planet-local frame the ground never moves; instead the sun, moons, planets and the
// star field rotate across the sky (day/night cycle, tilted by the axial tilt).
import * as THREE from 'three';
import { orbitPosition } from '../universe/orbits.js';

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const _v = new THREE.Vector3();

export class Celestial {
  constructor(system, body) {
    this.system = system;
    this.body = body;
    this.phaseOffset = 0;
    this.t = 0;
    this.q = new THREE.Quaternion();      // planet-local → inertial
    this.qInv = new THREE.Quaternion();   // inertial → planet-local
    this.bodyPos = new THREE.Vector3();   // inertial position of current body
    this.sunDir = new THREE.Vector3(0, 1, 0);  // planet-local unit vector toward the star
    this.sunDistance = 1;
    this.tiltQ = new THREE.Quaternion().setFromAxisAngle(X, body.axialTilt || 0);
    this._spin = new THREE.Quaternion();
  }

  /** Inertial position of any body (planet or moon) at time t. */
  bodyInertial(b, t, out = new THREE.Vector3()) {
    if (b.isMoon) {
      const parent = this.system.planets[b.parent];
      orbitPosition(parent.orbit, t, out);
      return out.add(orbitPosition(b.orbit, t, _v));
    }
    return orbitPosition(b.orbit, t, out);
  }

  rotationAngle(t) {
    return (this.body.rotationPhase0 || 0) + (Math.PI * 2 * t) / (this.body.dayLength || 1800) + this.phaseOffset;
  }

  update(t) {
    this.t = t;
    this.bodyInertial(this.body, t, this.bodyPos);
    this._spin.setFromAxisAngle(Y, this.rotationAngle(t));
    this.q.copy(this.tiltQ).multiply(this._spin);
    this.qInv.copy(this.q).invert();
    _v.copy(this.bodyPos).negate();
    this.sunDistance = _v.length();
    this.sunDir.copy(_v).normalize().applyQuaternion(this.qInv);
  }

  /** inertial position → planet-local position */
  toLocal(inertialPos, out = new THREE.Vector3()) { return out.copy(inertialPos).sub(this.bodyPos).applyQuaternion(this.qInv); }
  /** inertial direction → planet-local direction (e.g. star field orientation) */
  toLocalDir(dir, out = new THREE.Vector3()) { return out.copy(dir).applyQuaternion(this.qInv); }
  /** planet-local position → inertial */
  toInertial(local, out = new THREE.Vector3()) { return out.copy(local).applyQuaternion(this.q).add(this.bodyPos); }
  /** Position of another body in planet-local coordinates. */
  bodyLocal(b, out = new THREE.Vector3()) { return this.toLocal(this.bodyInertial(b, this.t, _v.clone()), out); }

  /** Hour angle based local solar time at a planet-local direction: 0 midnight, .25 sunrise, .5 noon, .75 sunset. */
  localTime(dirLocal) {
    const sunLon = Math.atan2(this.sunDir.x, this.sunDir.z);
    const lon = Math.atan2(dirLocal.x, dirLocal.z);
    let h = (lon - sunLon) / (Math.PI * 2) + 0.5;
    h -= Math.floor(h);
    return h;
  }

  /** Adjust the rotation phase so that local time at dirLocal equals tod (keeps time flowing afterwards). */
  setLocalTime(dirLocal, tod) {
    const cur = this.localTime(dirLocal);
    let d = tod - cur;
    d -= Math.round(d);
    this.phaseOffset += d * Math.PI * 2;
    this.update(this.t);
  }

  /** Sun elevation (radians) above the local horizon at a planet-local position. */
  sunElevation(localPos) {
    const up = _v.copy(localPos).normalize();
    return Math.asin(THREE.MathUtils.clamp(up.dot(this.sunDir), -1, 1));
  }
}
