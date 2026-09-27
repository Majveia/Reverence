// Player track — small shared helpers (allocation-free in hot paths; callers pass `out`).
import * as THREE from 'three';

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const dampF = (rate, dt) => 1 - Math.exp(-rate * dt);
export const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const wrapPi = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
export const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
export const easeInOut = (t) => t * t * (3 - 2 * t);

/** Critically-damped / under-damped scalar spring. */
export class Spring {
  constructor(x = 0, omega = 10, zeta = 1) { this.x = x; this.v = 0; this.omega = omega; this.zeta = zeta; }
  update(target, dt) {
    // semi-implicit integration, sub-stepped for stiffness
    const n = dt > 1 / 90 ? Math.ceil(dt * 120) : 1;
    const h = dt / n, w = this.omega, z = this.zeta;
    for (let i = 0; i < n; i++) {
      const a = w * w * (target - this.x) - 2 * z * w * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  reset(x = 0) { this.x = x; this.v = 0; }
}

/** Vector3 spring (critically damped by default). */
export class Spring3 {
  constructor(omega = 10, zeta = 1) { this.x = new THREE.Vector3(); this.v = new THREE.Vector3(); this.omega = omega; this.zeta = zeta; }
  update(target, dt) {
    const n = dt > 1 / 90 ? Math.ceil(dt * 120) : 1;
    const h = dt / n, w = this.omega, z = this.zeta;
    const x = this.x, v = this.v;
    for (let i = 0; i < n; i++) {
      v.x += (w * w * (target.x - x.x) - 2 * z * w * v.x) * h;
      v.y += (w * w * (target.y - x.y) - 2 * z * w * v.y) * h;
      v.z += (w * w * (target.z - x.z) - 2 * z * w * v.z) * h;
      x.x += v.x * h; x.y += v.y * h; x.z += v.z * h;
    }
    return x;
  }
  reset(p) { this.x.copy(p); this.v.set(0, 0, 0); }
}

/** Remove the component of v along unit n. */
export function projectOnPlane(v, n, out = v) {
  const d = v.x * n.x + v.y * n.y + v.z * n.z;
  return out.set(v.x - n.x * d, v.y - n.y * d, v.z - n.z * d);
}

const _ta = new THREE.Vector3();
/** East/north tangent basis at unit `up` (+Y is the north pole). */
export function tangentBasis(up, east, north) {
  if (Math.abs(up.y) > 0.999) _ta.set(0, 0, 1); else _ta.set(0, 1, 0);
  east.crossVectors(_ta, up).normalize();
  north.crossVectors(up, east).normalize();
}

/** Unit tangent forward ⟂ up from a hint (falls back gracefully). */
export function orthoForward(up, hint, out) {
  projectOnPlane(hint, up, out);
  if (out.lengthSq() < 1e-10) {
    _ta.set(0, 1, 0); if (Math.abs(up.y) > 0.9) _ta.set(1, 0, 0);
    out.crossVectors(up, _ta);
  }
  return out.normalize();
}

const _m4 = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3();
/** Quaternion for a character frame: local +Y = up, +Z = forward, +X = up × forward (character's left). */
export function quatFromUpForward(up, forward, out) {
  _x.crossVectors(up, forward);
  if (_x.lengthSq() < 1e-12) { orthoForward(up, forward, _y); _x.crossVectors(up, _y); }
  _x.normalize();
  _y.crossVectors(forward, _x).normalize(); // exact up
  const fz = _ta.crossVectors(_x, _y);        // exact forward
  _m4.makeBasis(_x, _y, fz);
  return out.setFromRotationMatrix(_m4);
}

/** Camera quaternion looking along `dir` with `up` hint (three cameras look down -Z). */
export function quatLookDir(dir, up, out) {
  _x.crossVectors(up, dir);
  if (_x.lengthSq() < 1e-12) { _x.set(1, 0, 0); }
  _x.normalize();                               // camera -X ... compute right = dir × up
  const right = _x.negate();                     // right = dir × up
  _y.crossVectors(right, dir).normalize();       // camera up
  _ta.copy(dir).negate();                        // camera +Z = -dir
  _m4.makeBasis(right, _y, _ta);
  return out.setFromRotationMatrix(_m4);
}

// Smooth 1-D value noise — shakes, flicker, idle variation. Deterministic.
function h1(i) { let x = Math.imul(i | 0, 374761393); x = Math.imul(x ^ (x >>> 13), 1274126177); x ^= x >>> 16; return ((x >>> 0) / 4294967296) * 2 - 1; }
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return h1(i + seed * 7919) * (1 - u) + h1(i + 1 + seed * 7919) * u;
}
export function fbm1(x, seed = 0) { return noise1(x, seed) * 0.62 + noise1(x * 2.13 + 17.1, seed + 3) * 0.28 + noise1(x * 4.37 + 3.3, seed + 5) * 0.1; }

/** Deterministic xorshift PRNG for cosmetic effects (captures stay reproducible). */
export class FastRand {
  constructor(seed = 1) { this.s = (seed >>> 0) || 0x9e3779b9; }
  next() { let x = this.s; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.s = x; return x / 4294967296; }
  range(a, b) { return a + (b - a) * this.next(); }
  signed() { return this.next() * 2 - 1; }
}

/** Safe call helper — never let an optional neighbour throw into the frame loop. */
export function safe(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}
