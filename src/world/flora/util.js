// Flora — small allocation-free math helpers shared by generators, placement and layers.
// Quaternions are plain [x, y, z, w] arrays / typed-array slots (no THREE objects in hot loops).
import { hash32 } from '../../core/rng.js';

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Fast integer hash → float [0,1). Arguments must be int32-ish. */
export function h01(a, b = 0, c = 0, d = 0) {
  let h = hash32(a ^ 0x9e3779b9);
  h = hash32(h ^ (b + 0x7f4a7c15));
  h = hash32(h ^ (c + 0x94d049bb));
  h = hash32(h ^ (d + 0x2545f491));
  return h / 4294967296;
}

/** Tiny deterministic PRNG (mulberry32) for generators — cheaper than RNG for geometry noise. */
export function mulberry(seed) {
  let s = seed >>> 0;
  const f = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (a, b) => a + (b - a) * f();
  f.int = (a, b) => a + Math.floor(f() * (b - a + 1));
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.sign = () => (f() < 0.5 ? -1 : 1);
  f.gauss = () => { let u = 0; while (u === 0) u = f(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * f()); };
  return f;
}

// ---------------------------------------------------------------- quaternions ([x,y,z,w])
export function qFromUnitVectors(ax, ay, az, bx, by, bz, out) {
  // rotation taking unit a → unit b
  let r = ax * bx + ay * by + az * bz + 1;
  let x, y, z, w;
  if (r < 1e-6) {
    r = 0;
    if (Math.abs(ax) > Math.abs(az)) { x = -ay; y = ax; z = 0; w = r; }
    else { x = 0; y = -az; z = ay; w = r; }
  } else {
    x = ay * bz - az * by; y = az * bx - ax * bz; z = ax * by - ay * bx; w = r;
  }
  const l = Math.hypot(x, y, z, w);
  out[0] = x / l; out[1] = y / l; out[2] = z / l; out[3] = w / l;
  return out;
}
export function qAxisAngle(x, y, z, a, out) {
  const s = Math.sin(a * 0.5);
  out[0] = x * s; out[1] = y * s; out[2] = z * s; out[3] = Math.cos(a * 0.5);
  return out;
}
/** out = a * b (apply b first, then a) */
export function qMul(a, b, out) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = ax * bw + aw * bx + ay * bz - az * by;
  out[1] = ay * bw + aw * by + az * bx - ax * bz;
  out[2] = az * bw + aw * bz + ax * by - ay * bx;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}
/** rotate vector (x,y,z) by q, writes out[0..2] */
export function qRot(q, x, y, z, out) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

const _qa = [0, 0, 0, 1], _qb = [0, 0, 0, 1], _qc = [0, 0, 0, 1];
/**
 * Orientation of a plant standing on the planet at unit direction (ux,uy,uz):
 * model +Y → local up (optionally blended toward a terrain normal), yawed, with a small lean.
 */
export function plantQuat(ux, uy, uz, yaw, leanX, leanZ, out) {
  qFromUnitVectors(0, 1, 0, ux, uy, uz, _qa);
  qAxisAngle(0, 1, 0, yaw, _qb);
  if (leanX !== 0 || leanZ !== 0) {
    const a = Math.hypot(leanX, leanZ);
    qAxisAngle(leanX / a, 0, leanZ / a, a, _qc);
    qMul(_qc, _qb, _qb);
  }
  return qMul(_qa, _qb, out);
}

// ---------------------------------------------------------------- colors
const _hexCache = new Map();
/** sRGB hex → linear [r,g,b] */
export function hexLinear(hex) {
  let v = _hexCache.get(hex);
  if (v) return v;
  const s = String(hex).replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16) || 0;
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  v = [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
  _hexCache.set(hex, v);
  return v;
}
export function mix3(a, b, t, out = [0, 0, 0]) {
  out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}
export function scale3(a, s, out = [0, 0, 0]) { out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s; return out; }
export function luma(c) { return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722; }
/** shift hue/sat/value of a linear rgb color a little (for per-instance variety) */
export function jitterColor(c, rnd, amt = 0.08, out = [0, 0, 0]) {
  const l = luma(c);
  const v = 1 + (rnd() - 0.5) * amt * 2.5;
  const s = 1 + (rnd() - 0.5) * amt * 2;
  const warm = (rnd() - 0.5) * amt;
  out[0] = Math.max(0, (l + (c[0] - l) * s) * v * (1 + warm));
  out[1] = Math.max(0, (l + (c[1] - l) * s) * v);
  out[2] = Math.max(0, (l + (c[2] - l) * s) * v * (1 - warm));
  return out;
}
