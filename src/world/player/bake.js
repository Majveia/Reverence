// Player track — offline-style surface bake for the Explorer (runs once at build, ~30-60 ms).
//
// The suit is modelled as separate shells (fabric undersuit, bevelled armour plates, straps, pack...).
// What makes such a model read as a real, worn object at game distance is not texel detail but the
// large-scale shading that artists bake: ambient occlusion in the gaps between plates and fabric,
// dirt collecting in crevices and on the lower legs, paint chipped off convex plate edges, and
// slightly uneven albedo. This module computes all of that per vertex:
//   • AO        : voxelise every surface (1.2 cm grid), then march 14 cosine-weighted hemisphere rays per
//                 vertex against the occupancy grid (plates occlude the fabric under them, the pack
//                 occludes the back, arms occlude the flanks ...).
//   • convexity : mesh-adjacency curvature (normal · edge) → bevel edges of plates.
//   • grime     : height gradient (boots/shins), AO cavities and low-frequency noise splotches.
// Results are written into the vertex colours and a `aWear` attribute (x = dirt, y = edge wear) that
// the materials use to vary roughness / clearcoat per vertex (see Explorer.makeMaterials).
import * as THREE from 'three';

const VOX = 0.012;
const X0 = -0.42, Y0 = -0.04, Z0 = -0.42;
const NX = Math.ceil(0.84 / VOX), NY = Math.ceil(2.0 / VOX), NZ = Math.ceil(0.8 / VOX);

// cached per tessellation level (geometry is deterministic for a given LOD; colours are not)
const _aoCache = new Map();

// hemisphere directions (Fibonacci sphere, 40 points; the ones facing the normal are used)
const DIRS = (() => {
  const out = [], n = 40, ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i + 0.5) * 2 / n, r = Math.sqrt(1 - y * y), a = i * ga;
    out.push(Math.cos(a) * r, y, Math.sin(a) * r);
  }
  return new Float32Array(out);
})();

function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}
const fbm3 = (x, y, z) => vnoise(x, y, z) * 0.55 + vnoise(x * 2.1 + 5.2, y * 2.1 + 1.7, z * 2.1 + 9.1) * 0.3 + vnoise(x * 4.3 + 2.1, y * 4.3 + 7.3, z * 4.3 + 3.9) * 0.15;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function voxelize(geos) {
  const occ = new Uint8Array(NX * NY * NZ);
  const mark = (x, y, z) => {
    const i = ((x - X0) / VOX) | 0, j = ((y - Y0) / VOX) | 0, k = ((z - Z0) / VOX) | 0;
    if (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ) return;
    occ[(j * NZ + k) * NX + i] = 1;
  };
  for (const [slot, g] of geos) {
    if (slot === 'glow') continue;
    const P = g.attributes.position.array, I = g.index.array;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ax = P[a], ay = P[a + 1], az = P[a + 2];
      const ex = P[b] - ax, ey = P[b + 1] - ay, ez = P[b + 2] - az;
      const fx = P[c] - ax, fy = P[c + 1] - ay, fz = P[c + 2] - az;
      const L = Math.max(Math.hypot(ex, ey, ez), Math.hypot(fx, fy, fz), Math.hypot(ex - fx, ey - fy, ez - fz));
      const n = Math.max(1, Math.ceil(L / (VOX * 0.7)));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n;
        mark(ax + ex * u + fx * v, ay + ey * u + fy * v, az + ez * u + fz * v);
      }
    }
  }
  return occ;
}

function bakeAO(geos, occ) {
  const res = new Map();
  const maxD = 0.16, steps = Math.ceil(maxD / VOX);
  for (const [slot, g] of geos) {
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    const n = P.length / 3;
    const ao = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      if (slot === 'glow') { ao[v] = 1; continue; }
      const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
      const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
      let occl = 0, wsum = 0;
      for (let d = 0; d < DIRS.length; d += 3) {
        const dx = DIRS[d], dy = DIRS[d + 1], dz = DIRS[d + 2];
        const cs = dx * nx + dy * ny + dz * nz;
        if (cs < 0.12) continue;
        wsum += cs;
        // start 1.6 voxels off the surface so the shell does not occlude itself
        let x = px + nx * VOX * 1.6, y = py + ny * VOX * 1.6, z = pz + nz * VOX * 1.6;
        for (let s = 1; s <= steps; s++) {
          x += dx * VOX; y += dy * VOX; z += dz * VOX;
          const i = ((x - X0) / VOX) | 0, j = ((y - Y0) / VOX) | 0, k = ((z - Z0) / VOX) | 0;
          if (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ) break;
          if (occ[(j * NZ + k) * NX + i]) { occl += cs * (1 - 0.55 * (s / steps)); break; }
        }
      }
      ao[v] = wsum > 0 ? 1 - occl / wsum : 1;
    }
    res.set(slot, ao);
  }
  return res;
}

function convexity(g) {
  const P = g.attributes.position.array, N = g.attributes.normal.array, I = g.index.array;
  const n = P.length / 3;
  const acc = new Float32Array(n), cnt = new Float32Array(n);
  const edge = (i, j) => {
    const dx = P[j * 3] - P[i * 3], dy = P[j * 3 + 1] - P[i * 3 + 1], dz = P[j * 3 + 2] - P[i * 3 + 2];
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) return;
    acc[i] += -(N[i * 3] * dx + N[i * 3 + 1] * dy + N[i * 3 + 2] * dz) / l; cnt[i]++;
  };
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    edge(a, b); edge(b, a); edge(b, c); edge(c, b); edge(a, c); edge(c, a);
  }
  for (let i = 0; i < n; i++) acc[i] = cnt[i] ? acc[i] / cnt[i] : 0;
  return acc;
}

/**
 * Bake AO / grime / edge wear into the Explorer geometries (Map slot → BufferGeometry, rest pose).
 * @param P  hero palette (uses P.dust)
 * @param lodKey cache key for the AO (tessellation level)
 */
export function bakeSurface(geos, P, lodKey = 1) {
  let aoMap = _aoCache.get(lodKey);
  if (!aoMap) {
    const occ = voxelize(geos);
    aoMap = bakeAO(geos, occ);
    _aoCache.set(lodKey, aoMap);
  }
  const dust = P.dust || new THREE.Color(0.45, 0.4, 0.33);
  const c = new THREE.Color(), hsl = { h: 0, s: 0, l: 0 };
  for (const [slot, g] of geos) {
    const ao = aoMap.get(slot);
    if (!ao || ao.length * 3 !== g.attributes.position.array.length) continue;
    const Pp = g.attributes.position.array, C = g.attributes.color.array;
    const n = ao.length;
    const cv = slot === 'hard' || slot === 'metal' ? convexity(g) : null;
    const wear = new Float32Array(n * 2);
    for (let v = 0; v < n; v++) {
      const x = Pp[v * 3], y = Pp[v * 3 + 1], z = Pp[v * 3 + 2];
      c.setRGB(C[v * 3], C[v * 3 + 1], C[v * 3 + 2]);
      if (slot === 'glow') continue;
      const a = ao[v];
      // splotchy grime mask (low frequency) + fine speckle
      const nz = fbm3(x * 9 + 3.1, y * 9, z * 9 - 1.7);
      const speck = vnoise(x * 70, y * 70, z * 70);
      const low = sstep(0.62, 0.02, y);                      // boots & shins collect dust
      const cav = sstep(0.95, 0.45, a);                       // crevices collect grime
      let dirt = low * (0.35 + 0.65 * sstep(0.35, 0.7, nz)) * 0.85 + cav * 0.55 + sstep(0.62, 0.85, nz) * 0.18;
      if (slot === 'visor') dirt *= 0.15;
      dirt = Math.min(1, dirt);
      // edge wear on convex plate edges (patchy)
      let ew = 0;
      if (cv) ew = sstep(0.1, 0.45, cv[v]) * sstep(0.35, 0.7, fbm3(x * 26 + 7, y * 26, z * 26)) * (0.55 + 0.45 * speck);
      // --- colour
      c.getHSL(hsl);
      const lum = hsl.l;
      // subtle large-scale albedo variation
      const mott = 1 + (nz - 0.5) * (slot === 'fabric' ? 0.12 : 0.08) + (speck - 0.5) * 0.04;
      c.multiplyScalar(mott);
      // chipped paint: bright shells reveal a greyer primer, dark parts reveal bare metal
      if (ew > 0.01) {
        const tgtL = lum > 0.35 ? 0.62 : 0.5;
        const k = ew * (slot === 'metal' ? 0.4 : 0.65);
        c.r += (tgtL - c.r) * k * 0.8; c.g += (tgtL - c.g) * k * 0.8; c.b += (tgtL * 1.02 - c.b) * k * 0.8;
      }
      // dust / grime tint (dust darkens light surfaces and lightens dark ones → reads as a film of dirt)
      const dk = dirt * (slot === 'metal' ? 0.35 : slot === 'fabric' ? 0.5 : 0.55);
      c.r += (dust.r - c.r) * dk; c.g += (dust.g - c.g) * dk; c.b += (dust.b - c.b) * dk;
      // ambient occlusion (kept out of the specular path: vertex colour only darkens diffuse)
      const occl = 0.3 + 0.7 * Math.pow(a, 1.35);
      c.multiplyScalar(occl);
      C[v * 3] = c.r; C[v * 3 + 1] = c.g; C[v * 3 + 2] = c.b;
      wear[v * 2] = dirt; wear[v * 2 + 1] = ew;
    }
    g.attributes.color.needsUpdate = true;
    g.setAttribute('aWear', new THREE.BufferAttribute(wear, 2));
  }
}
