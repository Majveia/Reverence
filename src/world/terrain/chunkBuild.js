// Terrain chunk builder — pure JS, runs in the terrain workers (and as a main-thread fallback).
// OWNED BY THE TERRAIN TRACK.
//
// A chunk is a (RES+1)^2 vertex patch of the cube-sphere (tangent-warped cube face) plus a skirt.
// Per vertex we produce everything the GPU needs for CDLOD geomorphing and the terrain material:
//   position  f32x3   relative to the chunk centre (planet-local metres)
//   aMorph    f32x4   xyz = delta to the PARENT level surface at this point, w = parent split distance
//   normal    i8x4    surface normal at this level
//   aMorphN   i8x4    surface normal of the parent level
//   aMat      u8x4    rock/cliff · sand · temperature · moisture
//   aMat2     u8x4    wet (river/lake) · glacier · curvature (0.5 flat, >0.5 concave) · mountain
//   aMat3     u8x4    talus / rubble apron · (reserved)
//   aUV       f32x3   local texture frame: cube-face u, v in metres (minus a per-chunk multiple of
//                     DETAIL_PERIOD, float64 on the CPU → mm precision) and altitude (m)
import { sstep } from '../planet/noise.js';

export const FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

const QP = Math.PI / 4;
/** cube face coords (u,v in [-1,1]) → unit direction (tangent-warped for uniform cells) */
export function cubeDir(face, u, v, out, o = 0) {
  const F = FACES[face];
  const tu = Math.tan(u * QP), tv = Math.tan(v * QP);
  const x = F.n[0] + F.u[0] * tu + F.v[0] * tv;
  const y = F.n[1] + F.u[1] * tu + F.v[1] * tv;
  const z = F.n[2] + F.u[2] * tu + F.v[2] * tv;
  const l = 1 / Math.hypot(x, y, z);
  out[o] = x * l; out[o + 1] = y * l; out[o + 2] = z * l;
  return out;
}

/** skirt/edge vertex order around the patch (shared with the index builder) */
export function edgeLoop(RES) {
  const N = RES + 1, e = [];
  for (let i = 0; i < N; i++) e.push(i, 0);
  for (let i = 1; i < N; i++) e.push(N - 1, i);
  for (let i = N - 2; i >= 0; i--) e.push(i, N - 1);
  for (let i = N - 2; i >= 1; i--) e.push(0, i);
  return e; // flat [i,j,...], 4*RES entries
}

/** Shared index buffer for every chunk of resolution RES (grid + closed skirt ring). */
export function buildIndices(RES) {
  const N = RES + 1;
  const loop = edgeLoop(RES), E = loop.length / 2;
  const idx = new Uint16Array(RES * RES * 6 + E * 6);
  let k = 0;
  for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idx[k++] = a; idx[k++] = b; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = c;
  }
  const s0 = N * N;
  for (let e = 0; e < E; e++) {
    const e1 = (e + 1) % E;
    const t0 = loop[e * 2 + 1] * N + loop[e * 2], t1 = loop[e1 * 2 + 1] * N + loop[e1 * 2];
    const a = s0 + e, b = s0 + e1;
    // skirt hangs below the edge; winding faces outward (culled from inside anyway, double-safe)
    idx[k++] = t0; idx[k++] = a; idx[k++] = t1; idx[k++] = t1; idx[k++] = a; idx[k++] = b;
  }
  return idx;
}

/** detail texture period (m) — must equal material.js DETAIL_PERIOD */
export const UV_PERIOD = 4096;
const q8 = (v) => { const x = Math.round(v * 127); return x < -127 ? -127 : x > 127 ? 127 : x; };
const u8 = (v) => { const x = Math.round(v * 255); return x < 0 ? 0 : x > 255 ? 255 : x; };

/**
 * Build one chunk.
 * job: { face, u0, v0, size, Dp, RES }  (Dp = parent split distance in metres; 0 for roots)
 * Returns { center:[x,y,z], radius, hMin, hMax, pos, morph, nrm, nrmP, mat, mat2 } (typed arrays)
 */
export function buildChunk(gen, job) {
  const RES = job.RES, N = RES + 1, R = gen.R;
  const { face, u0, v0, size } = job;
  const step = size / RES;
  // metres between vertices (tangent warp: cell size varies ±~30% across a face; use local)
  const cd = new Float64Array(3), cd2 = new Float64Array(3);
  cubeDir(face, u0 + size * 0.5, v0 + size * 0.5, cd);
  cubeDir(face, u0 + size * 0.5 + step, v0 + size * 0.5, cd2);
  const spacing = R * Math.acos(Math.min(1, cd[0] * cd2[0] + cd[1] * cd2[1] + cd[2] * cd2[2]));
  const lod = spacing * 1.5, lodP = lod * 2;

  // ---- child grid with a 1-vertex border
  const G = N + 2;
  const D = new Float64Array(G * G * 3);      // directions
  const Hh = new Float64Array(G * G);         // heights
  const info = {};
  const nInt = N * N;
  const infoArr = new Float32Array(nInt * 8);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const k = j * G + i;
    cubeDir(face, u0 + (i - 1) * step, v0 + (j - 1) * step, D, k * 3);
    const x = D[k * 3], y = D[k * 3 + 1], z = D[k * 3 + 2];
    const interior = i >= 1 && i <= N && j >= 1 && j <= N;
    if (interior) {
      const h = gen.evaluate(x, y, z, lod, info);
      Hh[k] = h;
      const vi = (j - 1) * N + (i - 1), o = vi * 8;
      infoArr[o] = info.rock > info.cliff ? info.rock : info.cliff;
      infoArr[o + 1] = info.sand;
      infoArr[o + 2] = info.c;
      infoArr[o + 3] = info.river > info.lake ? info.river : info.lake;
      infoArr[o + 4] = info.glacier || 0;
      infoArr[o + 5] = info.mtn;
      infoArr[o + 6] = info.dune || 0;
      infoArr[o + 7] = info.talus || 0;
    } else {
      Hh[k] = gen.evaluate(x, y, z, lod, null);
    }
  }
  // ---- parent grid (even vertices) with a 1-parent-vertex border
  const NP = RES / 2 + 1, GP = NP + 2;
  const HP = new Float64Array(GP * GP);
  const DP = new Float64Array(GP * GP * 3);
  const stepP = step * 2;
  const hasParent = job.Dp > 0;
  if (hasParent) {
    for (let j = 0; j < GP; j++) for (let i = 0; i < GP; i++) {
      const k = j * GP + i;
      cubeDir(face, u0 + (i - 1) * stepP, v0 + (j - 1) * stepP, DP, k * 3);
      HP[k] = gen.evaluate(DP[k * 3], DP[k * 3 + 1], DP[k * 3 + 2], lodP, null);
    }
  }

  // chunk centre
  const ci = (RES >> 1) + 1, ck = ci * G + ci;
  const hc = Hh[ck];
  const cx = D[ck * 3] * (R + hc), cy = D[ck * 3 + 1] * (R + hc), cz = D[ck * 3 + 2] * (R + hc);

  const VN = N * N + 4 * RES;
  const pos = new Float32Array(VN * 3);
  const morph = new Float32Array(VN * 4);
  const nrm = new Int8Array(VN * 4);
  const nrmP = new Int8Array(VN * 4);
  const mat = new Uint8Array(VN * 4);
  const mat2 = new Uint8Array(VN * 4);
  const mat3 = new Uint8Array(VN * 4);
  const uvw = new Float32Array(VN * 3);
  // cube-face coordinates in metres (arc length along the face's central great circles)
  const UM = R * Math.PI / 4;
  const baseU = Math.floor((u0 * UM) / UV_PERIOD) * UV_PERIOD, baseV = Math.floor((v0 * UM) / UV_PERIOD) * UV_PERIOD;

  const PX = (k) => D[k * 3] * (R + Hh[k]), PY = (k) => D[k * 3 + 1] * (R + Hh[k]), PZ = (k) => D[k * 3 + 2] * (R + Hh[k]);
  // parent positions & normals at the parent grid (interior NP x NP)
  const PPx = new Float64Array(NP * NP), PPy = new Float64Array(NP * NP), PPz = new Float64Array(NP * NP);
  const PNx = new Float32Array(NP * NP), PNy = new Float32Array(NP * NP), PNz = new Float32Array(NP * NP);
  if (hasParent) {
    const qx = (k) => DP[k * 3] * (R + HP[k]), qy = (k) => DP[k * 3 + 1] * (R + HP[k]), qz = (k) => DP[k * 3 + 2] * (R + HP[k]);
    for (let J = 0; J < NP; J++) for (let I = 0; I < NP; I++) {
      const k = (J + 1) * GP + (I + 1), p = J * NP + I;
      PPx[p] = qx(k); PPy[p] = qy(k); PPz[p] = qz(k);
      const kl = k - 1, kr = k + 1, kd = k - GP, ku = k + GP;
      const ax = qx(kr) - qx(kl), ay = qy(kr) - qy(kl), az = qz(kr) - qz(kl);
      const bx = qx(ku) - qx(kd), by = qy(ku) - qy(kd), bz = qz(ku) - qz(kd);
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const l = 1 / (Math.hypot(nx, ny, nz) || 1);
      nx *= l; ny *= l; nz *= l;
      if (nx * DP[k * 3] + ny * DP[k * 3 + 1] + nz * DP[k * 3 + 2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      PNx[p] = nx; PNy[p] = ny; PNz[p] = nz;
    }
  }

  let r2max = 0, mmax = 0, hMin = 1e9, hMax = -1e9;
  const Dp = hasParent ? job.Dp : 1e30;
  const clim = {};
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const v = j * N + i, k = (j + 1) * G + (i + 1);
    const px = PX(k), py = PY(k), pz = PZ(k);
    const h = Hh[k];
    if (h < hMin) hMin = h; if (h > hMax) hMax = h;
    const lx = px - cx, ly = py - cy, lz = pz - cz;
    pos[v * 3] = lx; pos[v * 3 + 1] = ly; pos[v * 3 + 2] = lz;
    const r2 = lx * lx + ly * ly + lz * lz; if (r2 > r2max) r2max = r2;
    // normal (central differences)
    const kl = k - 1, kr = k + 1, kd = k - G, ku = k + G;
    const ax = PX(kr) - PX(kl), ay = PY(kr) - PY(kl), az = PZ(kr) - PZ(kl);
    const bx = PX(ku) - PX(kd), by = PY(ku) - PY(kd), bz = PZ(ku) - PZ(kd);
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    let l = 1 / (Math.hypot(nx, ny, nz) || 1);
    nx *= l; ny *= l; nz *= l;
    const dx = D[k * 3], dy = D[k * 3 + 1], dz = D[k * 3 + 2];
    if (nx * dx + ny * dy + nz * dz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    nrm[v * 4] = q8(nx); nrm[v * 4 + 1] = q8(ny); nrm[v * 4 + 2] = q8(nz);
    // morph target: parent surface at this point (same diagonal as the index buffer: a→d)
    let tx = px, ty = py, tz = pz, mx = nx, my = ny, mz = nz;
    if (hasParent) {
      const I0 = i >> 1, J0 = j >> 1, oi = i & 1, oj = j & 1;
      const pA = J0 * NP + I0;
      const pB = (J0 + oj) * NP + (I0 + oi);
      tx = (PPx[pA] + PPx[pB]) * 0.5; ty = (PPy[pA] + PPy[pB]) * 0.5; tz = (PPz[pA] + PPz[pB]) * 0.5;
      mx = PNx[pA] + PNx[pB]; my = PNy[pA] + PNy[pB]; mz = PNz[pA] + PNz[pB];
      l = 1 / (Math.hypot(mx, my, mz) || 1); mx *= l; my *= l; mz *= l;
    }
    uvw[v * 3] = (u0 + i * step) * UM - baseU;
    uvw[v * 3 + 1] = (v0 + j * step) * UM - baseV;
    uvw[v * 3 + 2] = h;
    const mdx = tx - px, mdy = ty - py, mdz = tz - pz;
    morph[v * 4] = mdx; morph[v * 4 + 1] = mdy; morph[v * 4 + 2] = mdz; morph[v * 4 + 3] = Dp;
    const mm = mdx * mdx + mdy * mdy + mdz * mdz; if (mm > mmax) mmax = mm;
    nrmP[v * 4] = q8(mx); nrmP[v * 4 + 1] = q8(my); nrmP[v * 4 + 2] = q8(mz);
    // material hints
    const o = v * 8;
    gen.climate(dx, dy, dz, h, infoArr[o + 2], clim);
    // curvature = offset of the vertex from its neighbourhood mean measured ALONG THE NORMAL
    // ((hMean - h) · cos θ), relative to the vertex spacing; 3×3 kernel (edges 1, corners 0.5).
    // The old raw height Laplacian exploded on walls: a horizontal wobble Δx of an 84° face is a
    // height change of 10·Δx, so curvature saturated to ±1 and alternated from one vertex column
    // to the next → cavity / crest / AO / talus / streak masks drew fine vertical "comb" lines on
    // every cliff (and contour stripes on terraced slopes).
    const sp = Math.max(0.3, spacing);
    const hm = (Hh[kl] + Hh[kr] + Hh[kd] + Hh[ku] + 0.5 * (Hh[kd - 1] + Hh[kd + 1] + Hh[ku - 1] + Hh[ku + 1])) / 6;
    const gx = (Hh[kr] - Hh[kl]) / (2 * sp), gy = (Hh[ku] - Hh[kd]) / (2 * sp);
    const cosT = 1 / Math.sqrt(1 + gx * gx + gy * gy);
    const curv = Math.tanh(((hm - h) * cosT / sp) * 3.6);
    mat[v * 4] = u8(infoArr[o]);
    mat[v * 4 + 1] = u8(Math.max(infoArr[o + 1], infoArr[o + 6]));
    mat[v * 4 + 2] = u8((clim.temperature + 0.5) / 1.8);
    mat[v * 4 + 3] = u8(clim.moisture);
    mat2[v * 4] = u8(infoArr[o + 3]);
    mat2[v * 4 + 1] = u8(infoArr[o + 4]);
    mat2[v * 4 + 2] = u8(0.5 + 0.5 * curv);
    mat2[v * 4 + 3] = u8(sstep(0, 1, infoArr[o + 5]));
    mat3[v * 4] = u8(infoArr[o + 7]);
  }
  // ---- skirt ring: copies of the edge vertices. They keep the EDGE position (so shading, shadow
  //      lookups, altitude tints are exactly those of the edge — a crack filled by a skirt is then
  //      invisible instead of a dark shadowed line); the vertex shader lowers them along -up by the
  //      length encoded (log2) in aMorphN.w, only for rasterization.
  const loop = edgeLoop(RES), E = loop.length / 2;
  const skirt = Math.max(1.5, spacing * 2.5) + Math.sqrt(mmax);
  const skirtCode = Math.max(1, Math.min(127, Math.ceil(Math.log2(1 + skirt) / 16 * 127)));
  for (let e = 0; e < E; e++) {
    const i = loop[e * 2], j = loop[e * 2 + 1];
    const src = j * N + i, v = N * N + e;
    pos[v * 3] = pos[src * 3];
    pos[v * 3 + 1] = pos[src * 3 + 1];
    pos[v * 3 + 2] = pos[src * 3 + 2];
    for (let c = 0; c < 4; c++) {
      morph[v * 4 + c] = morph[src * 4 + c];
      nrm[v * 4 + c] = nrm[src * 4 + c]; nrmP[v * 4 + c] = nrmP[src * 4 + c];
      mat[v * 4 + c] = mat[src * 4 + c]; mat2[v * 4 + c] = mat2[src * 4 + c]; mat3[v * 4 + c] = mat3[src * 4 + c];
    }
    nrmP[v * 4 + 3] = skirtCode;
    uvw[v * 3] = uvw[src * 3]; uvw[v * 3 + 1] = uvw[src * 3 + 1]; uvw[v * 3 + 2] = uvw[src * 3 + 2];
  }
  const radius = Math.sqrt(r2max) + Math.sqrt(mmax) + skirt;
  return { center: [cx, cy, cz], radius, hMin, hMax, spacing, pos, morph, nrm, nrmP, mat, mat2, mat3, uvw };
}

export function transferList(r) {
  return [r.pos.buffer, r.morph.buffer, r.nrm.buffer, r.nrmP.buffer, r.mat.buffer, r.mat2.buffer, r.mat3.buffer, r.uvw.buffer];
}
