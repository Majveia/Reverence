// Rocks & boulders: noise-displaced icospheres with art-directed shape families.
// Vertex format (rock material): position, normal, aRock = (cavity AO, strata coordinate, moss bias, seed).
// LOD0 = subdivided (smooth, detailed silhouette); LOD1 = same displacement on a coarse sphere.
import * as THREE from 'three';
import { Noise } from '../../../core/noise.js';

function icosphere(detail) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const m = mergeVerts(g);
  g.dispose();
  return m;
}
// IcosahedronGeometry is non-indexed; weld identical positions so displacement stays watertight.
function mergeVerts(g) {
  const pos = g.getAttribute('position');
  const map = new Map();
  const verts = [];
  const idx = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let id = map.get(k);
    if (id === undefined) { id = verts.length / 3; map.set(k, id); verts.push(x, y, z); }
    idx.push(id);
  }
  return { verts, idx };
}

/**
 * shape: 'boulder' | 'angular' | 'slab' | 'spire' | 'layered' | 'pebble'
 * returns { lod0: BufferGeometry, lod1: BufferGeometry, radius, height, sink }
 */
export function makeRock(seed, shape = 'boulder', detail0 = 4, detail1 = 1) {
  const n = new Noise(seed);
  const n2 = new Noise(seed ^ 0x51ab);
  const r = (k) => { const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
  let sx = 1, sy = 0.7, sz = 1;
  if (shape === 'boulder') { sx = 0.9 + r(1) * 0.4; sy = 0.55 + r(2) * 0.35; sz = 0.8 + r(3) * 0.4; }
  else if (shape === 'angular') { sx = 0.9 + r(1) * 0.5; sy = 0.7 + r(2) * 0.4; sz = 0.8 + r(3) * 0.4; }
  else if (shape === 'slab') { sx = 1.3 + r(1) * 0.5; sy = 0.28 + r(2) * 0.15; sz = 1.0 + r(3) * 0.4; }
  else if (shape === 'spire') { sx = 0.55 + r(1) * 0.2; sy = 1.8 + r(2) * 1.4; sz = 0.55 + r(3) * 0.2; }
  else if (shape === 'layered') { sx = 1.1 + r(1) * 0.4; sy = 0.75 + r(2) * 0.4; sz = 1.0 + r(3) * 0.3; }
  else if (shape === 'pebble') { sx = 1; sy = 0.55; sz = 0.8; }
  const strataTilt = [r(4) - 0.5, 1, r(5) - 0.5];
  const tl = Math.hypot(...strataTilt); strataTilt[0] /= tl; strataTilt[1] /= tl; strataTilt[2] /= tl;
  const ang = shape === 'angular' || shape === 'layered' || shape === 'spire';
  const disp = (x, y, z) => {
    // x,y,z on unit sphere
    let d = 1;
    d += n.fbm3(x * 1.1 + 3, y * 1.1, z * 1.1, 3) * 0.28;
    if (ang) {
      // faceted: ridged noise quantized into planar-ish chips
      const rr = n2.ridged3(x * 1.6, y * 1.6, z * 1.6, 3);
      d += (rr - 0.5) * 0.22;
      d = Math.round(d * 7) / 7 * 0.6 + d * 0.4;
    } else {
      d += n2.fbm3(x * 3.1, y * 3.1, z * 3.1, 3) * 0.08;
    }
    d += n.noise3(x * 7.3, y * 7.3, z * 7.3) * 0.025;
    return d;
  };
  const build = (detail, fine) => {
    const { verts, idx } = icosphere(detail);
    const N = verts.length / 3;
    const P = new Float32Array(N * 3);
    const A = new Float32Array(N * 4);
    const D = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
      let d = disp(x, y, z);
      if (fine) d += n2.noise3(x * 13, y * 13, z * 13) * 0.012;
      D[i] = d;
      let px = x * d * sx, py = y * d * sy, pz = z * d * sz;
      if (shape === 'layered') {
        // terraced strata along a tilted axis
        const s = px * strataTilt[0] + py * strataTilt[1] + pz * strataTilt[2];
        const q = Math.round(s * 5) / 5;
        const k = 0.35;
        px -= strataTilt[0] * (s - q) * k; py -= strataTilt[1] * (s - q) * k; pz -= strataTilt[2] * (s - q) * k;
      }
      // flatten the underside so rocks sit on the ground
      if (py < -0.15 * sy) py = -0.15 * sy + (py + 0.15 * sy) * 0.35;
      P[i * 3] = px; P[i * 3 + 1] = py; P[i * 3 + 2] = pz;
      const s = px * strataTilt[0] + py * strataTilt[1] + pz * strataTilt[2];
      A[i * 4 + 1] = s;
      A[i * 4 + 3] = (x * 12.9898 + y * 78.233 + z * 37.719) % 1;
    }
    // cavity AO: compare displacement with neighbor average (concave → darker)
    const sum = new Float32Array(N), cnt = new Float32Array(N);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      sum[a] += D[b] + D[c]; cnt[a] += 2; sum[b] += D[a] + D[c]; cnt[b] += 2; sum[c] += D[a] + D[b]; cnt[c] += 2;
    }
    for (let i = 0; i < N; i++) {
      const avg = sum[i] / Math.max(1, cnt[i]);
      const cav = Math.max(0, Math.min(1, 0.72 + (D[i] - avg) * (fine ? 9 : 4)));
      const bottom = Math.max(0, Math.min(1, (P[i * 3 + 1] / sy + 0.2) * 1.6));
      A[i * 4] = cav * (0.55 + 0.45 * bottom);
      A[i * 4 + 2] = Math.max(0, verts[i * 3 + 1]); // moss bias: up-facing on the base sphere
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('aRock', new THREE.BufferAttribute(A, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };
  const lod0 = build(detail0, true), lod1 = build(detail1, false);
  const bb = new THREE.Box3().setFromBufferAttribute(lod0.getAttribute('position'));
  return { lod0, lod1, radius: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.5, height: bb.max.y, bottom: bb.min.y };
}
