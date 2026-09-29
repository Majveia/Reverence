// Flora placement — THREE-free, worker-safe. A pure function of (planet, style table, cell):
// the same trees appear wherever the camera streams from, on the main thread or in a worker.
//
// Output per cell (packed, transferable):
//   { n, anchor:[x,y,z] (planet-local, float64), inst: Float32Array(n*STRIDE), model: Uint16Array(n) }
//   inst layout: [ox, oy, oz, scale, qx, qy, qz, qw, seed, rank, tint, aux]   (o* relative to anchor)
// Grass cells return patches in the same layout (model = 0 dense / 1 sparse is chosen at draw time)
// plus flower instances in a second packed block.
import { h01, plantQuat, clamp, saturate, smooth } from './util.js';
import { cellPoint, cellSize } from './cells.js';

export const STRIDE = 12;
const B = { OCEAN: 0, BEACH: 1, DESERT: 2, SAVANNA: 3, GRASSLAND: 4, FOREST: 5, JUNGLE: 6, TAIGA: 7, TUNDRA: 8, SNOW: 9, ROCK: 10, VOLCANIC: 11, CRYSTAL: 12, TOXIC: 13 };

// ------------------------------------------------------------------ 3D gradient noise (meters)
// Gradient (Perlin) noise on a rotated domain: value noise on an axis-aligned lattice showed up as
// a faint grid/diamond pattern in grass coverage and forest edges; gradient noise has no lattice
// plateaus and the per-octave rotation hides the remaining axis alignment.
const GX = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0], GY = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1], GZ = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];
function grad(seed, i, j, k, x, y, z) {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x6c8e9cf5) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  const g = ((h >>> 0) % 12);
  return GX[g] * x + GY[g] * y + GZ[g] * z;
}
function gnoise(seed, x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const n000 = grad(seed, xi, yi, zi, fx, fy, fz), n100 = grad(seed, xi + 1, yi, zi, fx - 1, fy, fz);
  const n010 = grad(seed, xi, yi + 1, zi, fx, fy - 1, fz), n110 = grad(seed, xi + 1, yi + 1, zi, fx - 1, fy - 1, fz);
  const n001 = grad(seed, xi, yi, zi + 1, fx, fy, fz - 1), n101 = grad(seed, xi + 1, yi, zi + 1, fx - 1, fy, fz - 1);
  const n011 = grad(seed, xi, yi + 1, zi + 1, fx, fy - 1, fz - 1), n111 = grad(seed, xi + 1, yi + 1, zi + 1, fx - 1, fy - 1, fz - 1);
  const x00 = n000 + (n100 - n000) * ux, x10 = n010 + (n110 - n010) * ux;
  const x01 = n001 + (n101 - n001) * ux, x11 = n011 + (n111 - n011) * ux;
  const y0 = x00 + (x10 - x00) * uy, y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz; // ≈ [-1, 1]
}
/** 2-octave gradient noise at planet-local meters p/scale, mapped to ≈[0,1] (mean 0.5) */
export function fieldNoise(seed, px, py, pz, scale) {
  const s = 1 / scale;
  const x = px * s, y = py * s, z = pz * s;
  // two fixed rotations (orthonormal) so octaves never share lattice axes
  const a = gnoise(seed, 0.80 * x + 0.36 * y - 0.48 * z, -0.60 * x + 0.48 * y - 0.64 * z, 0.80 * y + 0.60 * z);
  const b = gnoise(seed + 17, 2.7 * (0.36 * x - 0.48 * y + 0.80 * z) + 5.3, 2.7 * (0.93 * x + 0.24 * y - 0.28 * z), 2.7 * (0.0 * x + 0.84 * y + 0.54 * z) + 1.7);
  const v = 0.5 + (a * 0.72 + b * 0.36);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ------------------------------------------------------------------ LOD-aware surface sample
/** Like SurfaceGen.sample but with an evaluation LOD (m) for far placement. */
export function sampleLod(gen, x, y, z, lod, out, slopeStep = 1.5) {
  const info = gen._info || (gen._info = {});
  const h = gen.evaluate(x, y, z, lod, info);
  gen.climate(x, y, z, h, info.c, out);
  out.height = h;
  out.rock = info.rock || 0; out.sand = info.sand || 0; out.lake = info.lake || 0; out.river = info.river || 0; out.cliff = info.cliff || 0;
  const e = slopeStep / gen.R;
  let ex = -z, ez = x;
  let el = Math.hypot(ex, ez);
  if (el < 1e-6) { ex = 1; ez = 0; el = 1; }
  ex /= el; ez /= el;
  const nx = y * ez, ny = z * ex - x * ez, nz = -y * ex;
  const lodS = Math.max(lod, slopeStep * 0.5);
  const h0 = lodS === lod ? h : gen.evaluate(x, y, z, lodS, null);
  const h1 = gen.evaluate(x + ex * e, y, z + ez * e, lodS, null);
  const h2 = gen.evaluate(x + nx * e, y + ny * e, z + nz * e, lodS, null);
  const sx = (h1 - h0) / slopeStep, sz = (h2 - h0) / slopeStep;
  out.slope = 1 - 1 / Math.sqrt(1 + sx * sx + sz * sz);
  // downhill tangent direction (for rock/grass tilt)
  out.gx = -(ex * sx + nx * sz); out.gy = -(ny * sz); out.gz = -(ez * sx + nz * sz);
  const rockEff = Math.max(out.rock, smooth(0.35, 0.6, out.slope));
  out.biome = gen.classify(h, out.temperature, out.moisture, rockEff, out.sand);
  return out;
}

// ------------------------------------------------------------------ species selection
function rangeW(v, r, soft) {
  if (!r) return 1;
  if (v < r[0]) return saturate(1 - (r[0] - v) / soft);
  if (v > r[1]) return saturate(1 - (v - r[1]) / soft);
  return 1;
}
function zoneW(z, n) {
  if (z < 0) return 1;
  const c = z === 0 ? 0.2 : z === 1 ? 0.5 : 0.8;
  const d = Math.abs(n - c);
  return 0.12 + 0.88 * (1 - smooth(0.12, 0.3, d));
}

const _s = {}, _q = [0, 0, 0, 1], _p = [0, 0, 0];

/**
 * Place one layer's instances in a cell.
 * T: table (see index.js makeTable), layer: T.layers[name], cell: {L,f,i,j}, opt: { lod, spacingMul, scaleMul, cap }
 */
export function placeLayer(gen, T, layerName, cell, opt = {}) {
  const Ly = T.layers[layerName];
  if (!Ly || !Ly.species.length) return null;
  const { L, f, i, j } = cell;
  const R = T.R;
  const size = cellSize(R, L);
  const spacing = Ly.spacing * (opt.spacingMul || 1) / Math.sqrt(Math.max(0.05, T.density));
  const n = Math.max(1, Math.min(opt.maxGrid || 96, Math.round(size / spacing)));
  const lod = opt.lod ?? 0.5;
  if (Ly.maxCover === undefined) Ly.maxCover = Math.max(...Ly.cover);
  const cap = n * n;
  const inst = new Float32Array(cap * STRIDE);
  const model = new Uint16Array(cap);
  cellPoint(L, f, i, j, 0.5, 0.5, _p);
  const ax = _p[0] * R, ay = _p[1] * R, az = _p[2] * R;
  const seed = (T.seed ^ Ly.salt) | 0;
  const sea = T.sea, altSpan = T.altSpan;
  const W = Ly.wbuf || (Ly.wbuf = new Float32Array(Ly.species.length));
  let cnt = 0;
  const cellId = ((f * 8191 + i) * 131071 + j) | 0;
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const k = gy * n + gx;
      const r0 = h01(seed, cellId, k, L);
      const r1 = h01(seed + 1, cellId, k, L);
      const r2 = h01(seed + 2, cellId, k, L);
      const a = (gx + 0.1 + 0.8 * r0) / n, b = (gy + 0.1 + 0.8 * r1) / n;
      cellPoint(L, f, i, j, a, b, _p);
      const dx = _p[0], dy = _p[1], dz = _p[2];
      const px = dx * R, py = dy * R, pz = dz * R;
      // coverage × clustering (forests with clearings, groves in meadows)
      const clus = fieldNoise(seed + 5, px, py, pz, Ly.clusterScale);
      const cf = Ly.clusterAmt > 0 ? clamp(0.25 + (clus - 0.5) * Ly.clusterAmt * 2.2 + 0.5, 0, 1.6) : 1;
      if (r2 >= Ly.maxCover * cf) continue;             // cheap reject before touching the surface
      const s = sampleLod(gen, dx, dy, dz, lod, _s, opt.slopeStep || 1.5);
      const h = s.height;
      if (h < sea + (Ly.minAboveSea ?? 0.25)) {
        if (!(Ly.allowShallow && h > sea - 0.4)) continue;
      }
      const cov = Ly.cover[s.biome] * cf;
      if (r2 >= cov) continue;
      const alt = (h - T.altBase) / altSpan;
      const shoreDist = h - sea;
      const zn = fieldNoise(seed + 9, px, py, pz, Ly.zoneScale);
      let wsum = 0;
      for (let q = 0; q < Ly.species.length; q++) {
        const sp = Ly.species[q];
        let w = sp.biomes[s.biome] * sp.dens;
        if (w > 0) {
          w *= rangeW(s.moisture, sp.m, 0.12) * rangeW(s.temperature, sp.t, 0.1);
          w *= s.slope < sp.slope ? 1 - smooth(sp.slope * 0.7, sp.slope, s.slope) * 0.8 : 0;
          if (sp.alt) w *= rangeW(alt, T.hasSea ? sp.alt : [-9, sp.alt[1]], 0.02);
          if (sp.shore) w *= T.hasSea ? (1 - smooth(sp.shore * 0.5, sp.shore, shoreDist)) : saturate((s.lake + s.river) * 2);
          w *= zoneW(sp.zone, zn);
        }
        W[q] = w; wsum += w;
      }
      if (wsum <= 1e-6) continue;
      let pick = h01(seed + 3, cellId, k, L) * wsum, q = 0;
      for (; q < Ly.species.length - 1; q++) { pick -= W[q]; if (pick <= 0) break; }
      const sp = Ly.species[q];
      const r3 = h01(seed + 4, cellId, k, L), r4 = h01(seed + 6, cellId, k, L), r5 = h01(seed + 7, cellId, k, L);
      const variant = Math.min(sp.models.length - 1, Math.floor(r3 * sp.models.length));
      const scale = (sp.scale[0] + (sp.scale[1] - sp.scale[0]) * r4 * r4) * (opt.scaleMul || 1);
      const yaw = r5 * 6.283185;
      const lr = h01(seed + 8, cellId, k, L) * 6.283185, lm = sp.lean * h01(seed + 10, cellId, k, L);
      let ux = dx, uy = dy, uz = dz;
      if (sp.align > 0 && s.slope > 0.02) {
        // tilt toward the terrain normal (rocks, ground cover)
        const t = sp.align * Math.min(0.8, s.slope * 1.6);
        const gl = Math.hypot(s.gx, s.gy, s.gz) || 1;
        ux += (s.gx / gl) * t; uy += (s.gy / gl) * t; uz += (s.gz / gl) * t;
        const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
      }
      plantQuat(ux, uy, uz, yaw, Math.cos(lr) * lm, Math.sin(lr) * lm, _q);
      const sink = sp.sink * scale;
      const rr = R + h - sink;
      const o = cnt * STRIDE;
      inst[o] = dx * rr - ax; inst[o + 1] = dy * rr - ay; inst[o + 2] = dz * rr - az; inst[o + 3] = scale;
      inst[o + 4] = _q[0]; inst[o + 5] = _q[1]; inst[o + 6] = _q[2]; inst[o + 7] = _q[3];
      inst[o + 8] = h01(seed + 11, cellId, k, L);                      // seed
      inst[o + 9] = h01(seed + 12, cellId, k, L);                      // rank (distance thinning)
      inst[o + 10] = saturate(0.5 + (s.moisture - 0.5) * 0.8 + (h01(seed + 13, cellId, k, L) - 0.5) * 0.5); // tint
      inst[o + 11] = s.biome;
      model[cnt] = sp.models[variant];
      cnt++;
    }
  }
  return { n: cnt, anchor: [ax, ay, az], inst: inst.slice(0, cnt * STRIDE), model: model.slice(0, cnt) };
}

/**
 * Grass patches (+ flowers) in a small cell. Each patch: [ox,oy,oz, scale, q(4), seed, density, height, dry]
 * Flowers are plant instances (model ids from T.grass.flowers).
 */
export function placeGrass(gen, T, cell) {
  const G = T.grass;
  const { L, f, i, j } = cell;
  const R = T.R;
  const size = cellSize(R, L);
  const n = Math.max(1, Math.min(48, Math.round(size / G.spacing)));
  const inst = new Float32Array(n * n * STRIDE);
  const fl = new Float32Array(n * n * STRIDE);
  const flm = new Uint16Array(n * n);
  cellPoint(L, f, i, j, 0.5, 0.5, _p);
  const ax = _p[0] * R, ay = _p[1] * R, az = _p[2] * R;
  const seed = (T.seed ^ 0x6a55) | 0;
  const cellId = ((f * 8191 + i) * 131071 + j) | 0;
  let cnt = 0, fc = 0;
  const sea = T.sea;
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const k = gy * n + gx;
      const r0 = h01(seed, cellId, k), r1 = h01(seed + 1, cellId, k);
      const a = (gx + r0) / n, b = (gy + r1) / n;
      cellPoint(L, f, i, j, a, b, _p);
      const dx = _p[0], dy = _p[1], dz = _p[2];
      const s = sampleLod(gen, dx, dy, dz, 0.22, _s, 1.0);
      const h = s.height;
      if (h < sea + 0.15) continue;
      const px = dx * R, py = dy * R, pz = dz * R;
      let cov = G.cover[s.biome];
      if (cov <= 0.01) continue;
      // patchiness: mostly continuous meadow with swales of taller/denser grass and a few bare
      // spots; steep slopes, rock and sand thin it out
      const pn = fieldNoise(seed + 3, px, py, pz, 9);
      const pn2 = fieldNoise(seed + 4, px, py, pz, 31);
      const pat = pn * 0.55 + pn2 * 0.45;
      let dens = cov * (0.58 + 0.42 * smooth(0.12, 0.5, pat + cov * 0.3)) * (1 - smooth(0.3, 0.55, s.slope)) * (1 - smooth(0.35, 0.7, s.rock));
      dens *= 1 - smooth(0.4, 0.8, s.sand);
      if (cov < 0.999 && pat < 0.3 * (1 - cov)) dens *= 0.3; // sparse biomes keep real bare ground
      if (dens < 0.04) continue;
      const moist = s.moisture;
      const dry = saturate(G.dryAmount + (0.45 - moist) * 0.9 + (pn2 - 0.5) * 0.6);
      const hgt = (0.55 + 0.75 * smooth(0.2, 0.9, pn) * (0.6 + moist * 0.6)) * (1 - smooth(0.25, 0.5, s.slope) * 0.5);
      // tilt patches with the terrain so blades root on slopes
      let ux = dx, uy = dy, uz = dz;
      if (s.slope > 0.01) {
        const t = Math.min(0.9, s.slope * 1.4);
        const gl = Math.hypot(s.gx, s.gy, s.gz) || 1;
        ux += (s.gx / gl) * t; uy += (s.gy / gl) * t; uz += (s.gz / gl) * t;
        const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
      }
      plantQuat(ux, uy, uz, h01(seed + 2, cellId, k) * 6.283185, 0, 0, _q);
      const rr = R + h - 0.04;
      let o = cnt * STRIDE;
      inst[o] = dx * rr - ax; inst[o + 1] = dy * rr - ay; inst[o + 2] = dz * rr - az; inst[o + 3] = 1;
      inst[o + 4] = _q[0]; inst[o + 5] = _q[1]; inst[o + 6] = _q[2]; inst[o + 7] = _q[3];
      inst[o + 8] = h01(seed + 5, cellId, k); inst[o + 9] = dens; inst[o + 10] = hgt; inst[o + 11] = dry;
      cnt++;
      // flowers: drifts in meadows
      if (G.flowers.length) {
        const fn = fieldNoise(seed + 7, px, py, pz, 14);
        const fchance = G.flowerAmt * smooth(0.5, 0.78, fn) * dens * (1 - dry * 0.7);
        if (h01(seed + 8, cellId, k) < fchance) {
          const fsel = fieldNoise(seed + 11, px, py, pz, 22);
          let pick = fsel * G.flowerWsum, q = 0;
          for (; q < G.flowers.length - 1; q++) { pick -= G.flowers[q].freq; if (pick <= 0) break; }
          const F = G.flowers[q];
          const mv = F.models[Math.floor(h01(seed + 9, cellId, k) * F.models.length) % F.models.length];
          o = fc * STRIDE;
          const oa = h01(seed + 12, cellId, k) * 6.283, od = 0.3;
          plantQuat(dx, dy, dz, oa, 0, 0, _q);
          fl[o] = dx * rr - ax + Math.cos(oa) * od * 0; fl[o + 1] = dy * rr - ay; fl[o + 2] = dz * rr - az;
          fl[o + 3] = 0.75 + h01(seed + 13, cellId, k) * 0.6;
          fl[o + 4] = _q[0]; fl[o + 5] = _q[1]; fl[o + 6] = _q[2]; fl[o + 7] = _q[3];
          fl[o + 8] = h01(seed + 14, cellId, k); fl[o + 9] = h01(seed + 15, cellId, k); fl[o + 10] = 0.5; fl[o + 11] = s.biome;
          flm[fc] = mv; fc++;
        }
      }
    }
  }
  return {
    n: cnt, anchor: [ax, ay, az], inst: inst.slice(0, cnt * STRIDE),
    fn: fc, finst: fl.slice(0, fc * STRIDE), fmodel: flm.slice(0, fc),
  };
}

export function runJob(g, T, job) {
  if (job.kind === 'grass') return placeGrass(g, T, job.cell);
  return placeLayer(g, T, job.layer, job.cell, job.opt);
}

export { B as BIOME_IDS };
