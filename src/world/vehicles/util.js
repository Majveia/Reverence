// Vehicles track — shared helpers (math scratch, deterministic cosmetic noise, frames).
// Everything here is allocation-free in hot paths: callers pass `out` objects.
import * as THREE from 'three';

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const dampF = (rate, dt) => 1 - Math.exp(-rate * dt);
export const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
export const sign = (x) => (x < 0 ? -1 : 1);

/** Deterministic xorshift PRNG for cosmetic effects (captures stay reproducible). */
export class FastRand {
  constructor(seed = 1) { this.s = (seed >>> 0) || 0x9e3779b9; }
  next() { let x = this.s; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.s = x; return x / 4294967296; }
  range(a, b) { return a + (b - a) * this.next(); }
  signed() { return this.next() * 2 - 1; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length) % arr.length]; }
}

// Smooth 1-D value noise (cubic) — camera shake, engine flicker. Deterministic.
function h1(i) { let x = (i | 0) * 374761393; x = (x ^ (x >>> 13)) * 1274126177; x ^= x >>> 16; return ((x >>> 0) / 4294967296) * 2 - 1; }
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return h1(i + seed * 7919) * (1 - u) + h1(i + 1 + seed * 7919) * u;
}
/** 2-octave smooth noise in ~[-1,1]. */
export function fbm1(x, seed = 0) { return noise1(x, seed) * 0.66 + noise1(x * 2.13 + 17.1, seed + 3) * 0.34; }

const _m = new THREE.Matrix4();
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

/** Remove the component of v along unit n (project onto the plane ⟂ n). */
export function projectOnPlane(v, n, out = v) {
  const d = v.x * n.x + v.y * n.y + v.z * n.z;
  return out.set(v.x - n.x * d, v.y - n.y * d, v.z - n.z * d);
}

/** Orthonormal forward ⟂ up from a hint; falls back gracefully when parallel. */
export function orthoForward(up, hint, out) {
  projectOnPlane(hint, up, out);
  if (out.lengthSq() < 1e-8) {
    _a.set(0, 1, 0);
    if (Math.abs(up.y) > 0.9) _a.set(1, 0, 0);
    out.crossVectors(up, _a);
  }
  return out.normalize();
}

/** Quaternion from a (right, up, forward) frame: local +X right, +Y up, +Z forward. */
export function quatFromFrame(up, forward, out) {
  _b.crossVectors(up, forward).normalize(); // right = up × forward
  _a.crossVectors(forward, _b).normalize(); // re-orthogonalised up
  _m.makeBasis(_b, _a, forward);
  return out.setFromRotationMatrix(_m);
}

/** Camera quaternion looking along `dir` with approximate `up` (camera looks down -Z). */
export function lookQuat(dir, up, out) {
  _a.copy(dir).normalize();
  _b.crossVectors(_a, up);
  if (_b.lengthSq() < 1e-10) _b.set(1, 0, 0);
  _b.normalize();                              // right
  const ux = _b.y * _a.z - _b.z * _a.y, uy = _b.z * _a.x - _b.x * _a.z, uz = _b.x * _a.y - _b.y * _a.x; // up' = right × dir
  _m.set(
    _b.x, ux, -_a.x, 0,
    _b.y, uy, -_a.y, 0,
    _b.z, uz, -_a.z, 0,
    0, 0, 0, 1,
  );
  return out.setFromRotationMatrix(_m);
}

/** Local east/north for a radial up (no allocation). */
export function tangentBasis(up, east, north) {
  if (Math.abs(up.y) > 0.999) east.set(1, 0, 0); else east.set(up.z, 0, -up.x).normalize(); // (0,1,0) × up
  north.crossVectors(up, east).normalize();
  return east;
}

/** Heading (yaw, degrees, 0 = north, 90 = east) → tangent direction at radial up. */
export function headingDir(up, yawDeg, out) {
  const e = _a, n = _b;
  tangentBasis(up, e, n);
  const y = yawDeg * Math.PI / 180;
  return out.set(0, 0, 0).addScaledVector(n, Math.cos(y)).addScaledVector(e, Math.sin(y)).normalize();
}

/** Critically-damped spring on a scalar (state object {x, v}). */
export function springStep(s, target, omega, dt) {
  const f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  const x = (f * s.x + dt * s.v + hhoo * target) * det;
  const v = (s.v + hoo * (target - s.x)) * det;
  s.x = x; s.v = v;
  return x;
}

/** Vector critically damped spring (pos, vel Vector3 in place). */
export function springVec(pos, vel, target, omega, dt) {
  const f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  const px = (f * pos.x + dt * vel.x + hhoo * target.x) * det;
  const py = (f * pos.y + dt * vel.y + hhoo * target.y) * det;
  const pz = (f * pos.z + dt * vel.z + hhoo * target.z) * det;
  vel.set((vel.x + hoo * (target.x - pos.x)) * det, (vel.y + hoo * (target.y - pos.y)) * det, (vel.z + hoo * (target.z - pos.z)) * det);
  pos.set(px, py, pz);
}

/** Safe call wrapper for optional neighbour APIs. */
export function tryCall(obj, fn, ...args) {
  try { const f = obj?.[fn]; return typeof f === 'function' ? f.apply(obj, args) : undefined; } catch (_) { return undefined; }
}

export function fmtSpeed(ms) { return `${Math.round(ms * 3.6)} km/h`; }
export function fmtDist(m) {
  const a = Math.abs(m);
  if (a < 1000) return `${Math.round(m)} m`;
  if (a < 1e6) return `${(m / 1000).toFixed(a < 1e4 ? 2 : 1)} km`;
  return `${(m / 1000).toFixed(0)} km`;
}
