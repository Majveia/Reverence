// Terrain noise kernels — deterministic, dependency-free, worker-safe. OWNED BY THE TERRAIN TRACK.
//
// SNoise: 3D simplex noise with analytic derivatives (value + gradient), 1024-entry permutation
// (long lattice period so fine octaves do not visibly repeat) and cheap per-cell jitter tables for
// cellular features (craters, karst towers, gullies, sea stacks...).
//
// Everything here is plain JS math on float64: identical results on the main thread and in
// terrain workers, so CPU physics/placement and GPU chunks agree to the millimetre.

const F3 = 1 / 3, G3 = 1 / 6;
const PMASK = 1023;
// kernel radius^2 = 0.5 (0.6 leaks past the simplex neighbourhood → tiny discontinuities that
// masks amplify into metre-high steps). Scale chosen to keep std ≈ 0.4265 like the classic 0.6/32.
const NSCALE = 83.45;

// 12 cube-edge gradients (classic simplex set)
const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);
const GZ = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1]);

export class SNoise {
  constructor(seed = 1) {
    const N = PMASK + 1;
    const p = new Uint16Array(N);
    for (let i = 0; i < N; i++) p[i] = i;
    let s = (seed >>> 0) || 0x9e3779b9;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    for (let i = 0; i < 8; i++) rnd();
    for (let i = N - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    this.perm = new Uint16Array(N * 2);
    this.g12 = new Uint8Array(N * 2);
    for (let i = 0; i < N * 2; i++) { this.perm[i] = p[i & PMASK]; this.g12[i] = this.perm[i] % 12; }
    // jitter table for cellular noise: 3 floats in [0,1) per entry + 1 extra random
    this.jit = new Float64Array(N * 4);
    for (let i = 0; i < N * 4; i++) this.jit[i] = rnd();
  }

  /** hash of an integer lattice cell → 0..1023 */
  cell(ix, iy, iz) {
    const P = this.perm;
    return P[(P[(P[ix & PMASK] + iy) & PMASK] + iz) & PMASK];
  }

  /** 3D simplex noise in ~[-1,1] */
  n3(xin, yin, zin) {
    const perm = this.perm, gi = this.g12;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - i + t, y0 = yin - j + t, z0 = zin - k + t;
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 0.5, y3 = y0 - 0.5, z3 = z0 - 0.5;
    const ii = i & PMASK, jj = j & PMASK, kk = k & PMASK;
    let n = 0, tt, g;
    tt = 0.5 - x0 * x0 - y0 * y0 - z0 * z0;
    if (tt > 0) { g = gi[ii + perm[jj + perm[kk]]]; tt *= tt; n += tt * tt * (GX[g] * x0 + GY[g] * y0 + GZ[g] * z0); }
    tt = 0.5 - x1 * x1 - y1 * y1 - z1 * z1;
    if (tt > 0) { g = gi[ii + i1 + perm[jj + j1 + perm[kk + k1]]]; tt *= tt; n += tt * tt * (GX[g] * x1 + GY[g] * y1 + GZ[g] * z1); }
    tt = 0.5 - x2 * x2 - y2 * y2 - z2 * z2;
    if (tt > 0) { g = gi[ii + i2 + perm[jj + j2 + perm[kk + k2]]]; tt *= tt; n += tt * tt * (GX[g] * x2 + GY[g] * y2 + GZ[g] * z2); }
    tt = 0.5 - x3 * x3 - y3 * y3 - z3 * z3;
    if (tt > 0) { g = gi[ii + 1 + perm[jj + 1 + perm[kk + 1]]]; tt *= tt; n += tt * tt * (GX[g] * x3 + GY[g] * y3 + GZ[g] * z3); }
    return NSCALE * n;
  }

  /** 3D simplex noise with analytic gradient: returns value, writes d/dx,d/dy,d/dz into d[0..2] */
  n3d(xin, yin, zin, d) {
    const perm = this.perm, gi = this.g12;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - i + t, y0 = yin - j + t, z0 = zin - k + t;
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 0.5, y3 = y0 - 0.5, z3 = z0 - 0.5;
    const ii = i & PMASK, jj = j & PMASK, kk = k & PMASK;
    let n = 0, dx = 0, dy = 0, dz = 0, tt, t2, t4, g, gx, gy, gz, gd, m;
    tt = 0.5 - x0 * x0 - y0 * y0 - z0 * z0;
    if (tt > 0) {
      g = gi[ii + perm[jj + perm[kk]]]; gx = GX[g]; gy = GY[g]; gz = GZ[g];
      gd = gx * x0 + gy * y0 + gz * z0; t2 = tt * tt; t4 = t2 * t2; n += t4 * gd; m = -8 * t2 * tt * gd;
      dx += m * x0 + t4 * gx; dy += m * y0 + t4 * gy; dz += m * z0 + t4 * gz;
    }
    tt = 0.5 - x1 * x1 - y1 * y1 - z1 * z1;
    if (tt > 0) {
      g = gi[ii + i1 + perm[jj + j1 + perm[kk + k1]]]; gx = GX[g]; gy = GY[g]; gz = GZ[g];
      gd = gx * x1 + gy * y1 + gz * z1; t2 = tt * tt; t4 = t2 * t2; n += t4 * gd; m = -8 * t2 * tt * gd;
      dx += m * x1 + t4 * gx; dy += m * y1 + t4 * gy; dz += m * z1 + t4 * gz;
    }
    tt = 0.5 - x2 * x2 - y2 * y2 - z2 * z2;
    if (tt > 0) {
      g = gi[ii + i2 + perm[jj + j2 + perm[kk + k2]]]; gx = GX[g]; gy = GY[g]; gz = GZ[g];
      gd = gx * x2 + gy * y2 + gz * z2; t2 = tt * tt; t4 = t2 * t2; n += t4 * gd; m = -8 * t2 * tt * gd;
      dx += m * x2 + t4 * gx; dy += m * y2 + t4 * gy; dz += m * z2 + t4 * gz;
    }
    tt = 0.5 - x3 * x3 - y3 * y3 - z3 * z3;
    if (tt > 0) {
      g = gi[ii + 1 + perm[jj + 1 + perm[kk + 1]]]; gx = GX[g]; gy = GY[g]; gz = GZ[g];
      gd = gx * x3 + gy * y3 + gz * z3; t2 = tt * tt; t4 = t2 * t2; n += t4 * gd; m = -8 * t2 * tt * gd;
      dx += m * x3 + t4 * gx; dy += m * y3 + t4 * gy; dz += m * z3 + t4 * gz;
    }
    d[0] = NSCALE * dx; d[1] = NSCALE * dy; d[2] = NSCALE * dz;
    return NSCALE * n;
  }

  /** plain fbm in ~[-1,1] with an irrational lacunarity (breaks lattice alignment between octaves) */
  fbm(x, y, z, oct, gain = 0.5, lac = 2.03) {
    let a = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += a * this.n3(x, y, z);
      norm += a; a *= gain;
      x = x * lac + 17.13; y = y * lac + 3.71; z = z * lac + 11.37;
    }
    return sum / norm;
  }
}

/** smoothstep */
export function sstep(a, b, x) {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
export function lerp(a, b, t) { return a + (b - a) * t; }
/** weight of an octave of wavelength `wl` when sampling at resolution `lod` (continuous fade) */
export function lodW(wl, lod) { const r = wl / lod; return r >= 2 ? 1 : r <= 1 ? 0 : r - 1; }
