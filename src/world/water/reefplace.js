// Seabed life placement — THREE-free (runs in the water worker, which owns a SurfaceGen).
//
// A planet-global lattice (cube-sphere faces, gnomonic cells of ~C metres) so placement is deterministic
// and never pops when the camera moves or the wave frame re-anchors: every cell hashes to the same
// candidates wherever it is requested from. Candidates are classified by depth, temperature, sand/rock
// cover and slope into seagrass meadows, kelp forests, coral heads (branching, brain, fan), tube
// sponges and boulders, with km/100 m-scale patchiness so reefs alternate with open sand.
import { RNG, hashCombine, hash32 } from '../../core/rng.js';

export const REEF_TYPES = ['grass', 'kelp', 'branch', 'brain', 'fan', 'rock', 'sponge'];
export const T_GRASS = 0, T_KELP = 1, T_BRANCH = 2, T_BRAIN = 3, T_FAN = 4, T_ROCK = 5, T_SPONGE = 6;

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function faceUV(x, y, z) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) return [x > 0 ? 0 : 1, y / ax, z / ax];
  if (ay >= az) return [y > 0 ? 2 : 3, x / ay, z / ay];
  return [z > 0 ? 4 : 5, x / az, y / az];
}
function fromFace(f, u, v, out) {
  let x, y, z;
  if (f < 2) { x = f === 0 ? 1 : -1; y = u; z = v; }
  else if (f < 4) { y = f === 2 ? 1 : -1; x = u; z = v; }
  else { z = f === 4 ? 1 : -1; x = u; y = v; }
  const l = Math.hypot(x, y, z);
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}
// smooth value noise on the lattice (per face), for reef / meadow patchiness
function vnoise(seed, f, u, v) {
  const x0 = Math.floor(u), y0 = Math.floor(v), tx = u - x0, ty = v - y0;
  const h = (i, j) => hash32(hashCombine(seed, f, x0 + i, y0 + j)) / 4294967296;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  return (h(0, 0) * (1 - sx) + h(1, 0) * sx) * (1 - sy) + (h(0, 1) * (1 - sx) + h(1, 1) * sx) * sy;
}

/**
 * m: { dir:[x,y,z] (camera nadir, unit), R (m), C (cell m), radius (body radius), sea (m), seed, per (candidates
 *      per cell), caps:[per type], warmBias }
 * → { pos: Float64Array (x,y,z planet-local), attr: Float32Array (type, yaw, scale, variant, depth) , n }
 */
export function reefPlacement(gen, m) {
  const { dir, R, C, radius, sea, seed } = m;
  const per = m.per ?? 5;
  const caps = m.caps || [3000, 500, 600, 400, 250, 600, 400];
  const du = C / radius;                      // cell size in gnomonic units (≈ metres / radius)
  // tangent frame at the camera nadir
  const [dx, dy, dz] = dir;
  let ex = -dz, ey = 0, ez = dx;
  let el = Math.hypot(ex, ez);
  if (el < 1e-6) { ex = 1; ez = 0; el = 1; }
  ex /= el; ez /= el;
  const nx = dy * ez - dz * ey, ny = dz * ex - dx * ez, nz = dx * ey - dy * ex;
  const cells = new Map();
  const step = C * 0.6;
  for (let gy = -R; gy <= R; gy += step) {
    for (let gx = -R; gx <= R; gx += step) {
      if (gx * gx + gy * gy > (R + C) * (R + C)) continue;
      const px = dx + (gx * ex + gy * nx) / radius, py = dy + (gx * ey + gy * ny) / radius, pz = dz + (gx * ez + gy * nz) / radius;
      const [f, u, v] = faceUV(px, py, pz);
      const ix = Math.floor(u / du), iy = Math.floor(v / du);
      const key = f + ':' + ix + ':' + iy;
      if (!cells.has(key)) cells.set(key, [f, ix, iy, gx * gx + gy * gy]);
    }
  }
  const cosR = Math.cos(R / radius);
  const counts = new Int32Array(REEF_TYPES.length);
  const posL = [], attrL = [];
  const s = {};
  const d3 = [0, 0, 0];
  const warmBias = m.warmBias ?? 0;
  const w = new Float64Array(8);
  // nearest cells first: when a type hits its cap, the far edge is what gets dropped (never one side)
  const list = Array.from(cells.values()).sort((a, b) => a[3] - b[3]);
  for (const [f, ix, iy] of list) {
    const rng = new RNG(hashCombine(seed, 0x4eef, f, ix, iy));
    // patchiness: reefs (~120 m), meadows (~60 m) and a finer clumping (~20 m)
    const cu = (ix + 0.5) * du, cv = (iy + 0.5) * du;
    const reefP = sstep(0.42, 0.72, vnoise(seed + 11, f, cu * radius / 120, cv * radius / 120) * 0.75 + vnoise(seed + 12, f, cu * radius / 22, cv * radius / 22) * 0.35);
    const grassP = sstep(0.38, 0.66, vnoise(seed + 21, f, cu * radius / 60, cv * radius / 60) * 0.8 + vnoise(seed + 22, f, cu * radius / 14, cv * radius / 14) * 0.3);
    const kelpP = sstep(0.4, 0.7, vnoise(seed + 31, f, cu * radius / 90, cv * radius / 90));
    const nk = Math.round(per * (0.55 + 0.9 * Math.max(reefP, grassP * 0.8, kelpP * 0.7)));
    for (let k = 0; k < nk; k++) {
      const u = (ix + rng.next()) * du, v = (iy + rng.next()) * du;
      const r0 = rng.next(), r1 = rng.next(), r2 = rng.next(), r3 = rng.next();
      fromFace(f, u, v, d3);
      if (d3[0] * dx + d3[1] * dy + d3[2] * dz < cosR) continue;
      gen.sample(d3[0], d3[1], d3[2], s, true);
      const depth = sea - s.height;
      if (depth < 0.45 || depth > 46) continue;
      const warm = sstep(0.35, 0.7, (s.temperature ?? 0.5) + warmBias);
      const sand = s.sand ?? 0, rock = Math.max(s.rock ?? 0, sstep(0.25, 0.5, s.slope ?? 0));
      w[T_GRASS] = depth < 10 ? 3.2 * grassP * sstep(0.45, 1.2, depth) * (1 - sstep(6, 10, depth)) * (1 - rock * 0.8) : 0;
      w[T_KELP] = depth > 3 && depth < 34 ? 1.6 * kelpP * (1 - warm * 0.75) * sstep(3, 7, depth) * (0.4 + rock) : 0;
      w[T_BRANCH] = depth > 0.8 && depth < 22 ? 2.2 * reefP * (0.25 + warm) * (1 - sstep(14, 22, depth)) : 0;
      w[T_BRAIN] = depth > 0.8 && depth < 28 ? 1.5 * reefP * (0.3 + warm) : 0;
      w[T_FAN] = depth > 3 && depth < 40 ? 0.7 * (0.3 + reefP) * (0.35 + warm * 0.65) : 0;
      w[T_ROCK] = 0.25 + rock * 1.6 + reefP * 0.3;
      w[T_SPONGE] = depth > 1.5 && depth < 42 ? 0.55 * (0.3 + reefP) : 0;
      w[7] = 2.6 * (1 - Math.max(reefP, grassP * 0.9, kelpP * 0.6)) + sand * 0.6;   // open sand
      let tot = 0;
      for (let i = 0; i < 8; i++) tot += w[i];
      let pick = r0 * tot, t = 0;
      for (; t < 7; t++) { if ((pick -= w[t]) <= 0) break; }
      if (t >= 7) continue;
      if (counts[t] >= caps[t]) continue;
      counts[t]++;
      let scale;
      switch (t) {
        case T_GRASS: scale = 0.55 + r2 * 0.7; break;
        case T_KELP: scale = Math.min(depth + 1.5, 4 + r2 * 12); break;         // stipe height (reaches toward the light)
        case T_BRANCH: scale = (0.8 + r2 * r2 * 1.8) * (0.7 + 0.5 * reefP); break;
        case T_BRAIN: scale = (0.7 + r2 * r2 * 2.4) * (0.7 + 0.5 * reefP); break;
        case T_FAN: scale = 0.9 + r2 * 1.4; break;
        case T_ROCK: scale = 0.5 + r2 * r2 * 3.0 * (0.5 + rock); break;
        default: scale = 0.7 + r2 * 1.2;
      }
      const rr = radius + s.height;
      posL.push(d3[0] * rr, d3[1] * rr, d3[2] * rr);
      attrL.push(t, r1 * Math.PI * 2, scale, r3, depth);
    }
  }
  const n = posL.length / 3;
  return { pos: Float64Array.from(posL), attr: Float32Array.from(attrL), n, counts: Array.from(counts) };
}
