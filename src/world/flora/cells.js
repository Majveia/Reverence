// Flora cell lattice on the cube-sphere (same face layout + tangent warp as the terrain track).
// A cell is (level L, face f, i, j) with 2^L cells per face side; cell size ≈ R·(π/2)/2^L meters.
// Every placement decision is a pure function of (planet seed, cell, candidate index), so the
// same trees appear no matter where the camera streams from.

const FN = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FU = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [1, 0, 0], [1, 0, 0], [-1, 0, 0]];
const FV = [[0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, 1, 0]];
const Q = Math.PI / 4;

/** face-uv in [-1,1]² → unit direction (writes out[0..2]) */
export function faceUVToDir(f, u, v, out) {
  const N = FN[f], U = FU[f], V = FV[f];
  const tu = Math.tan(u * Q), tv = Math.tan(v * Q);
  const x = N[0] + U[0] * tu + V[0] * tv;
  const y = N[1] + U[1] * tu + V[1] * tv;
  const z = N[2] + U[2] * tu + V[2] * tv;
  const l = Math.hypot(x, y, z);
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

/** face index whose region contains the direction */
export function dirFace(x, y, z) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) return x > 0 ? 0 : 1;
  if (ay >= az) return y > 0 ? 2 : 3;
  return z > 0 ? 4 : 5;
}

/** project direction onto face f → uv (may exceed [-1,1] outside the face); returns false if behind */
export function dirToFaceUV(f, x, y, z, out) {
  const N = FN[f], U = FU[f], V = FV[f];
  const dn = x * N[0] + y * N[1] + z * N[2];
  if (dn <= 1e-4) return false;
  const a = (x * U[0] + y * U[1] + z * U[2]) / dn;
  const b = (x * V[0] + y * V[1] + z * V[2]) / dn;
  out[0] = Math.atan(a) / Q; out[1] = Math.atan(b) / Q;
  return true;
}

export const cellKey = (L, f, i, j) => ((L * 6 + f) * 32768 + i) * 32768 + j;

/** lattice level whose cells are ≈ `meters` wide on a sphere of radius R */
export function levelFor(R, meters) {
  return Math.max(1, Math.min(14, Math.round(Math.log2((R * Math.PI / 2) / Math.max(1, meters)))));
}
/** nominal cell size (m) at level L */
export const cellSize = (R, L) => (R * Math.PI / 2) / (1 << L);

const _uv = [0, 0], _p = [0, 0, 0], _c = [0, 0, 0];
const RING = 20;

/**
 * Enumerate cells of level L whose centers lie within angular radius `ang` (radians) of unit
 * direction (dx,dy,dz). Calls fn(f, i, j, cx, cy, cz, angDist) for each. Handles face edges/corners.
 */
export function forEachCellInCap(L, dx, dy, dz, ang, fn) {
  const n = 1 << L;
  const cellAng = (Math.PI / 2) / n;
  const reach = ang + cellAng * 0.75;
  const cosReach = Math.cos(Math.min(Math.PI, reach));
  // tangent basis at the cap center for ring points
  let ex = -dz, ey = 0, ez = dx; // cross((0,1,0), d)
  let el = Math.hypot(ex, ey, ez);
  if (el < 1e-6) { ex = 1; ey = 0; ez = 0; el = 1; }
  ex /= el; ey /= el; ez /= el;
  const nx = dy * ez - dz * ey, ny = dz * ex - dx * ez, nz = dx * ey - dy * ex;
  const ca = Math.cos(Math.min(reach, 1.5)), sa = Math.sin(Math.min(reach, 1.5));
  for (let f = 0; f < 6; f++) {
    const N = FN[f];
    if (dx * N[0] + dy * N[1] + dz * N[2] < Math.cos(Math.min(Math.PI, 0.9553 + reach + 0.05))) continue;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    const acc = (x, y, z) => {
      if (x * N[0] + y * N[1] + z * N[2] < 0.15) return;
      if (!dirToFaceUV(f, x, y, z, _uv)) return;
      if (_uv[0] < u0) u0 = _uv[0]; if (_uv[0] > u1) u1 = _uv[0];
      if (_uv[1] < v0) v0 = _uv[1]; if (_uv[1] > v1) v1 = _uv[1];
    };
    acc(dx, dy, dz);
    for (let k = 0; k < RING; k++) {
      const t = (k / RING) * Math.PI * 2, c = Math.cos(t) * sa, s = Math.sin(t) * sa;
      acc(dx * ca + ex * c + nx * s, dy * ca + ey * c + ny * s, dz * ca + ez * c + nz * s);
    }
    if (u0 > u1) continue;
    const pad = 2 / n;
    u0 = Math.max(-1, u0 - pad); u1 = Math.min(1, u1 + pad);
    v0 = Math.max(-1, v0 - pad); v1 = Math.min(1, v1 + pad);
    if (u0 >= u1 || v0 >= v1) continue;
    const i0 = Math.max(0, Math.floor((u0 + 1) * 0.5 * n)), i1 = Math.min(n - 1, Math.floor((u1 + 1) * 0.5 * n));
    const j0 = Math.max(0, Math.floor((v0 + 1) * 0.5 * n)), j1 = Math.min(n - 1, Math.floor((v1 + 1) * 0.5 * n));
    for (let j = j0; j <= j1; j++) {
      const v = -1 + (j + 0.5) * 2 / n;
      for (let i = i0; i <= i1; i++) {
        const u = -1 + (i + 0.5) * 2 / n;
        faceUVToDir(f, u, v, _c);
        const dot = _c[0] * dx + _c[1] * dy + _c[2] * dz;
        if (dot < cosReach) continue;
        fn(f, i, j, _c[0], _c[1], _c[2], Math.acos(Math.min(1, dot)));
      }
    }
  }
}

/** Direction of a point inside cell (f,i,j) at level L, (a,b) ∈ [0,1]² local coords. */
export function cellPoint(L, f, i, j, a, b, out = _p) {
  const n = 1 << L;
  return faceUVToDir(f, -1 + (i + a) * 2 / n, -1 + (j + b) * 2 / n, out);
}
