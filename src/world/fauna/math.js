// Allocation-free math on typed arrays for the fauna animation system.
// Quaternions are [x, y, z, w] stored at an offset in a Float64Array/Float32Array.
// Vectors are [x, y, z] at an offset. Every function writes into caller-provided storage.

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
export const wrapPi = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
export const fract = (x) => x - Math.floor(x);

/** o = a * b */
export function qmul(a, ai, b, bi, o, oi) {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  const bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  o[oi] = aw * bx + ax * bw + ay * bz - az * by;
  o[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  o[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
  o[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** rotate (vx,vy,vz) by q → o[oi..oi+2] */
export function qrot(q, qi, vx, vy, vz, o, oi) {
  const qx = q[qi], qy = q[qi + 1], qz = q[qi + 2], qw = q[qi + 3];
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  o[oi] = vx + qw * tx + (qy * tz - qz * ty);
  o[oi + 1] = vy + qw * ty + (qz * tx - qx * tz);
  o[oi + 2] = vz + qw * tz + (qx * ty - qy * tx);
}

export function qidentity(o, oi) { o[oi] = 0; o[oi + 1] = 0; o[oi + 2] = 0; o[oi + 3] = 1; }
export function qcopy(a, ai, o, oi) { o[oi] = a[ai]; o[oi + 1] = a[ai + 1]; o[oi + 2] = a[ai + 2]; o[oi + 3] = a[ai + 3]; }

export function qaxis(o, oi, ax, ay, az, angle) {
  const h = angle * 0.5, s = Math.sin(h);
  o[oi] = ax * s; o[oi + 1] = ay * s; o[oi + 2] = az * s; o[oi + 3] = Math.cos(h);
}

/** Local euler rotation in the creature body frame: q = Ry(yaw) * Rx(pitch) * Rz(roll).
 *  Body frame: +Z forward, +Y up, +X = creature's left. pitch > 0 tilts the forward axis DOWN. */
export function qeuler(o, oi, yaw, pitch, roll) {
  const cy = Math.cos(yaw * 0.5), sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5), sr = Math.sin(roll * 0.5);
  // Ry * Rx
  const x1 = cy * sp, y1 = sy * cp, z1 = -sy * sp, w1 = cy * cp;
  // (Ry*Rx) * Rz
  o[oi] = w1 * 0 + x1 * cr + y1 * sr - z1 * 0;
  o[oi + 1] = w1 * 0 - x1 * sr + y1 * cr + z1 * 0;
  o[oi + 2] = w1 * sr + x1 * 0 - y1 * 0 + z1 * cr;
  o[oi + 3] = w1 * cr - x1 * 0 - y1 * 0 - z1 * sr;
}

/** Quaternion from an orthonormal basis given as column vectors X, Y, Z (right-handed). */
export function qbasis(o, oi, xx, xy, xz, yx, yy, yz, zx, zy, zz) {
  // rotation matrix m (columns): m00=xx m10=xy m20=xz ; m01=yx m11=yy m21=yz ; m02=zx m12=zy m22=zz
  const tr = xx + yy + zz;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1.0);
    w = 0.25 / s; x = (yz - zy) * s; y = (zx - xz) * s; z = (xy - yx) * s;
  } else if (xx > yy && xx > zz) {
    const s = 2.0 * Math.sqrt(1.0 + xx - yy - zz);
    w = (yz - zy) / s; x = 0.25 * s; y = (yx + xy) / s; z = (zx + xz) / s;
  } else if (yy > zz) {
    const s = 2.0 * Math.sqrt(1.0 + yy - xx - zz);
    w = (zx - xz) / s; x = (yx + xy) / s; y = 0.25 * s; z = (zy + yz) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + zz - xx - yy);
    w = (xy - yx) / s; x = (zx + xz) / s; y = (zy + yz) / s; z = 0.25 * s;
  }
  const l = 1 / Math.hypot(x, y, z, w);
  o[oi] = x * l; o[oi + 1] = y * l; o[oi + 2] = z * l; o[oi + 3] = w * l;
}

/** Quaternion whose frame has +Z along (fx,fy,fz) and +Y as close as possible to (ux,uy,uz). */
export function qlook(o, oi, fx, fy, fz, ux, uy, uz) {
  let l = Math.hypot(fx, fy, fz) || 1; fx /= l; fy /= l; fz /= l;
  // X = up × forward (creature's left)
  let xx = uy * fz - uz * fy, xy = uz * fx - ux * fz, xz = ux * fy - uy * fx;
  l = Math.hypot(xx, xy, xz);
  if (l < 1e-8) { // forward parallel to up: pick any perpendicular
    if (Math.abs(fx) < 0.9) { xx = 0; xy = fz; xz = -fy; } else { xx = -fz; xy = 0; xz = fx; }
    l = Math.hypot(xx, xy, xz);
  }
  xx /= l; xy /= l; xz /= l;
  const yx = fy * xz - fz * xy, yy = fz * xx - fx * xz, yz = fx * xy - fy * xx;
  qbasis(o, oi, xx, xy, xz, yx, yy, yz, fx, fy, fz);
}

/** Normalized lerp between quaternions (shortest path). t=0 → a. */
export function qnlerp(a, ai, b, bi, t, o, oi) {
  let bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  if (a[ai] * bx + a[ai + 1] * by + a[ai + 2] * bz + a[ai + 3] * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
  const x = a[ai] + (bx - a[ai]) * t, y = a[ai + 1] + (by - a[ai + 1]) * t, z = a[ai + 2] + (bz - a[ai + 2]) * t, w = a[ai + 3] + (bw - a[ai + 3]) * t;
  const l = 1 / (Math.hypot(x, y, z, w) || 1);
  o[oi] = x * l; o[oi + 1] = y * l; o[oi + 2] = z * l; o[oi + 3] = w * l;
}

/** Rotate vector v (array) around unit axis a by angle (Rodrigues), in place. */
export function rotAxis(v, vi, ax, ay, az, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const x = v[vi], y = v[vi + 1], z = v[vi + 2];
  const d = (ax * x + ay * y + az * z) * (1 - c);
  v[vi] = x * c + (ay * z - az * y) * s + ax * d;
  v[vi + 1] = y * c + (az * x - ax * z) * s + ay * d;
  v[vi + 2] = z * c + (ax * y - ay * x) * s + az * d;
}

/** Small deterministic hash → [0,1) */
export function hash01(n) {
  n = (n | 0) ^ 0x9e3779b9;
  n = Math.imul(n ^ (n >>> 16), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

/** Cheap 1D smooth value noise in [-1,1] (for idle motion; cosmetic). */
export function vnoise1(x) {
  const i = Math.floor(x), f = x - i;
  const a = hash01(i) * 2 - 1, b = hash01(i + 1) * 2 - 1;
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}
