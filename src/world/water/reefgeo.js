// Procedural seabed-life geometry (built once per planet, instanced by reef.js).
// Every vertex carries: colour (base → tip gradient, multiplied by the instance colour), `sway` (0 at the
// anchored base … 1 at free tips — drives the surge/current animation) and `glow` (bioluminescent tips).
import * as THREE from 'three';
import { RNG } from '../../core/rng.js';

class GB {
  constructor() { this.p = []; this.n = []; this.c = []; this.s = []; this.g = []; this.i = []; }
  v(x, y, z, nx, ny, nz, c, s, g) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(c[0], c[1], c[2]); this.s.push(s); this.g.push(g);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  /** tube along a polyline: pts [{x,y,z,r,c,s,g}], `sides` segments, optional round tip */
  tube(pts, sides, tip = true) {
    const n = pts.length;
    let px = 1, py = 0, pz = 0;                     // reference vector for the frame (parallel transport-ish)
    const base = this.p.length / 3;
    for (let k = 0; k < n; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
      let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      // u = normalize(ref − t (ref·t)), w = t × u
      let d = px * tx + py * ty + pz * tz;
      let ux = px - tx * d, uy = py - ty * d, uz = pz - tz * d;
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-4) { ux = 0; uy = 0; uz = 1; d = tz; ux -= tx * d; uy -= ty * d; uz -= tz * d; ul = Math.hypot(ux, uy, uz) || 1; }
      ux /= ul; uy /= ul; uz /= ul;
      px = ux; py = uy; pz = uz;
      const wx = ty * uz - tz * uy, wy = tz * ux - tx * uz, wz = tx * uy - ty * ux;
      const q = pts[k];
      for (let j = 0; j < sides; j++) {
        const an = (j / sides) * Math.PI * 2, ca = Math.cos(an), sa = Math.sin(an);
        const nx = ux * ca + wx * sa, ny = uy * ca + wy * sa, nz = uz * ca + wz * sa;
        this.v(q.x + nx * q.r, q.y + ny * q.r, q.z + nz * q.r, nx, ny, nz, q.c, q.s, q.g);
      }
    }
    for (let k = 0; k < n - 1; k++) {
      for (let j = 0; j < sides; j++) {
        const a = base + k * sides + j, b = base + k * sides + (j + 1) % sides;
        const c = a + sides, d = b + sides;
        this.tri(a, c, b); this.tri(b, c, d);
      }
    }
    if (tip) {
      const q = pts[n - 1], a = pts[n - 2];
      let tx = q.x - a.x, ty = q.y - a.y, tz = q.z - a.z;
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const t = this.v(q.x + tx * q.r, q.y + ty * q.r, q.z + tz * q.r, tx, ty, tz, q.c, q.s, q.g);
      const last = base + (n - 1) * sides;
      for (let j = 0; j < sides; j++) this.tri(last + j, t, last + (j + 1) % sides);
    }
  }
  /** flat ribbon (double-sided material) along pts with half-width w and side vector (sx,sy,sz) */
  ribbon(pts, side) {
    const base = this.p.length / 3;
    const n = pts.length;
    for (let k = 0; k < n; k++) {
      const q = pts[k];
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
      let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
      // normal = side × tangent
      let nx = side[1] * tz - side[2] * ty, ny = side[2] * tx - side[0] * tz, nz = side[0] * ty - side[1] * tx;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      this.v(q.x - side[0] * q.r, q.y - side[1] * q.r, q.z - side[2] * q.r, nx, ny, nz, q.c, q.s, q.g);
      this.v(q.x + side[0] * q.r, q.y + side[1] * q.r, q.z + side[2] * q.r, nx, ny, nz, q.c, q.s, q.g);
    }
    for (let k = 0; k < n - 1; k++) {
      const a = base + k * 2;
      this.tri(a, a + 2, a + 1); this.tri(a + 1, a + 2, a + 3);
    }
  }
  build(name) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(this.s, 1));
    g.setAttribute('glow', new THREE.Float32BufferAttribute(this.g, 1));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    g.name = name;
    return g;
  }
}

const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** seagrass clump: 7–9 curved tapering blades, ~0.9 m tall (unit scale) */
function seagrass(rng) {
  const B = new GB();
  const nb = 8;
  for (let b = 0; b < nb; b++) {
    const ang = rng.range(0, Math.PI * 2), rad = rng.range(0, 0.22);
    const bx = Math.cos(ang) * rad, bz = Math.sin(ang) * rad;
    const h = rng.range(0.55, 1.1), lean = rng.range(0.1, 0.35), la = rng.range(0, Math.PI * 2);
    const side = [Math.cos(la + 1.57), 0, Math.sin(la + 1.57)];
    const pts = [];
    const segs = 4;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const off = lean * t * t;
      pts.push({ x: bx + Math.cos(la) * off, y: h * t, z: bz + Math.sin(la) * off, r: 0.022 * (1 - t * 0.85),
        c: mixc([0.55, 0.62, 0.35], [1.05, 1.05, 0.7], t), s: t, g: 0 });
    }
    B.ribbon(pts, side);
  }
  return B.build('reef-grass');
}

/** kelp: a stipe with alternating blades and gas bladders; unit height (instance scale = height in m) */
function kelp(rng) {
  const B = new GB();
  const segs = 10;
  const pts = [];
  const wob = rng.range(0, 6);
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    pts.push({ x: Math.sin(t * 3 + wob) * 0.03, y: t, z: Math.cos(t * 2.3 + wob) * 0.03, r: 0.006, c: [0.7, 0.62, 0.35], s: t, g: 0 });
  }
  B.tube(pts, 4, false);
  // blades: long ribbons hanging off the stipe (in unit-height space they are thin & long)
  for (let k = 1; k < segs; k++) {
    for (const sgn of [-1, 1]) {
      if (rng.next() < 0.25) continue;
      const t0 = k / segs + rng.range(-0.02, 0.02);
      const a = rng.range(0, Math.PI * 2);
      const dx = Math.cos(a), dz = Math.sin(a);
      const L = rng.range(0.1, 0.17), w = rng.range(0.012, 0.02);
      const bp = [];
      for (let j = 0; j <= 4; j++) {
        const u = j / 4;
        bp.push({ x: pts[k].x + dx * L * u * sgn, y: t0 + L * u * 0.8 - u * u * 0.03, z: pts[k].z + dz * L * u * sgn,
          r: w * Math.sin(Math.PI * Math.min(1, u * 1.1 + 0.08)), c: mixc([0.75, 0.65, 0.3], [1.0, 0.85, 0.42], u), s: Math.min(1, t0 + u * 0.1), g: 0 });
      }
      B.ribbon(bp, [-dz, 0.25, dx]);
    }
  }
  return B.build('reef-kelp');
}

/** branching (staghorn / alien tree) coral, ~0.8 m (unit scale) */
function branchCoral(rng) {
  const B = new GB();
  const grow = (x, y, z, dx, dy, dz, len, r, depth) => {
    const pts = [];
    const segs = 2;
    let cx = x, cy = y, cz = z;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const tipness = depth === 0 ? t : 1;
      pts.push({ x: cx, y: cy, z: cz, r: r * (1 - 0.35 * t), c: mixc([0.55, 0.5, 0.5], [1.12, 1.08, 1.0], Math.min(1, (3 - depth + t) / 3.5)), s: Math.min(1, cy / 0.9) * 0.25, g: depth === 0 ? tipness : 0 });
      cx += dx * len / segs; cy += dy * len / segs; cz += dz * len / segs;
      dx += rng.range(-0.15, 0.15); dz += rng.range(-0.15, 0.15); dy += 0.08;
      const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    }
    B.tube(pts, 5, depth === 0);
    if (depth > 0) {
      const nb = rng.next() < 0.45 ? 3 : 2;
      for (let b = 0; b < nb; b++) {
        const a = rng.range(0, Math.PI * 2), sp = rng.range(0.35, 0.7);
        let ndx = dx + Math.cos(a) * sp, ndy = dy + 0.15, ndz = dz + Math.sin(a) * sp;
        const l = Math.hypot(ndx, ndy, ndz);
        grow(cx, cy, cz, ndx / l, ndy / l, ndz / l, len * rng.range(0.6, 0.8), r * 0.72, depth - 1);
      }
    }
  };
  const nTrunk = rng.int(4, 6);
  for (let i = 0; i < nTrunk; i++) {
    const a = rng.range(0, Math.PI * 2), sp = rng.range(0.2, 0.7);
    let dx = Math.cos(a) * sp, dz = Math.sin(a) * sp, dy = 1;
    const l = Math.hypot(dx, dy, dz);
    grow(Math.cos(a) * 0.05, -0.05, Math.sin(a) * 0.05, dx / l, dy / l, dz / l, rng.range(0.22, 0.32), 0.048, 2);
  }
  return B.build('reef-branch');
}

/** brain / boulder coral: a lumpy dome with meandering grooves (vertex colour), unit radius ~0.5 m */
function brainCoral(rng) {
  const ico = new THREE.IcosahedronGeometry(0.5, 2);
  const pos = ico.getAttribute('position');
  const B = new GB();
  const ph = [rng.range(0, 9), rng.range(0, 9), rng.range(0, 9)];
  const n = pos.count;
  const map = new Map();
  const idx = [];
  for (let i = 0; i < n; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    if (map.has(key)) { idx.push(map.get(key)); continue; }
    const l = Math.hypot(x, y, z);
    const nx = x / l, ny = y / l, nz = z / l;
    const lump = 1 + 0.12 * Math.sin(nx * 4 + ph[0]) * Math.sin(nz * 3.5 + ph[1]) + 0.06 * Math.sin(ny * 7 + ph[2]);
    const groove = Math.sin(nx * 23 + Math.sin(nz * 9 + ph[0]) * 2.2) * Math.sin(nz * 21 + Math.sin(nx * 8 + ph[1]) * 2.4);
    const gr = 0.5 + 0.5 * groove;
    const rr = 0.5 * lump * (1 - 0.025 * (1 - gr));
    let yy = ny * rr * 0.72;
    if (yy < -0.06) yy = -0.06;                             // flat base (sits on the bed, sinks a little)
    const c = mixc([0.55, 0.5, 0.48], [1.1, 1.05, 0.98], gr * 0.7 + 0.3 * Math.max(0, ny));
    const vi = B.v(nx * rr, yy, nz * rr, nx, ny * 1.3, nz, c, 0, gr * gr * 0.4 * Math.max(0, ny));
    map.set(key, vi); idx.push(vi);
  }
  for (let i = 0; i < idx.length; i += 3) B.tri(idx[i], idx[i + 1], idx[i + 2]);
  ico.dispose();
  const g = B.build('reef-brain');
  g.computeVertexNormals();
  return g;
}

/** gorgonian sea fan: a flat fractal lattice of thin ribbons in one plane, ~1 m (unit) */
function seaFan(rng) {
  const B = new GB();
  const grow = (x, y, a, len, w, depth) => {
    const pts = [];
    const segs = 3;
    let cx = x, cy = y;
    for (let k = 0; k <= segs; k++) {
      pts.push({ x: cx, y: cy, z: 0, r: w, c: mixc([0.6, 0.55, 0.55], [1.1, 1.05, 1.0], Math.min(1, cy)), s: Math.min(1, cy), g: depth === 0 ? 0.8 : 0.1 });
      cx += Math.sin(a) * len / segs; cy += Math.cos(a) * len / segs;
      a += rng.range(-0.12, 0.12);
    }
    // fan branches lie in the XY plane: the ribbon side vector is Z
    B.ribbon(pts, [0, 0, 1]);
    if (depth > 0) {
      grow(cx, cy, a - rng.range(0.25, 0.55), len * 0.78, w * 0.8, depth - 1);
      grow(cx, cy, a + rng.range(0.25, 0.55), len * 0.78, w * 0.8, depth - 1);
    }
  };
  grow(0, 0, rng.range(-0.1, 0.1), 0.28, 0.018, 4);
  const g = B.build('reef-fan');
  return g;
}

/** boulder: displaced, flattened icosahedron (unit radius ~0.5 m) */
function boulder(rng) {
  const ico = new THREE.IcosahedronGeometry(0.5, 2);
  const pos = ico.getAttribute('position');
  const ph = [rng.range(0, 9), rng.range(0, 9), rng.range(0, 9)];
  const B = new GB();
  const map = new Map(); const idx = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    if (map.has(key)) { idx.push(map.get(key)); continue; }
    const l = Math.hypot(x, y, z);
    const nx = x / l, ny = y / l, nz = z / l;
    const d = 1 + 0.18 * Math.sin(nx * 3 + ph[0]) * Math.cos(nz * 2.6 + ph[1]) + 0.08 * Math.sin(ny * 6 + nx * 4 + ph[2]);
    let yy = ny * 0.5 * d * 0.62;
    if (yy < -0.12) yy = -0.12;
    const top = Math.max(0, ny);
    // algae / encrusting growth on top
    const c = mixc([0.62, 0.6, 0.56], [0.52, 0.62, 0.42], top * top);
    const vi = B.v(nx * 0.5 * d, yy, nz * 0.5 * d, nx, ny, nz, c, 0, 0);
    map.set(key, vi); idx.push(vi);
  }
  for (let i = 0; i < idx.length; i += 3) B.tri(idx[i], idx[i + 1], idx[i + 2]);
  ico.dispose();
  const g = B.build('reef-rock');
  g.computeVertexNormals();
  return g;
}

/** tube sponges / anemone cluster: open-lipped tubes with glowing rims */
function sponge(rng) {
  const B = new GB();
  const nt = rng.int(3, 5);
  for (let i = 0; i < nt; i++) {
    const a = rng.range(0, Math.PI * 2), rad = rng.range(0, 0.18);
    const h = rng.range(0.3, 0.8), r = rng.range(0.04, 0.08);
    const lx = rng.range(-0.15, 0.15), lz = rng.range(-0.15, 0.15);
    const pts = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      pts.push({ x: Math.cos(a) * rad + lx * t * t, y: h * t, z: Math.sin(a) * rad + lz * t * t, r: r * (1 + 0.35 * t * t), c: mixc([0.6, 0.55, 0.55], [1.1, 1.05, 1.0], t), s: t * 0.35, g: t > 0.9 ? 1 : 0 });
    }
    B.tube(pts, 5, false);
  }
  return B.build('reef-sponge');
}

export function buildReefGeometries(seed) {
  const rng = new RNG((seed ^ 0x2eef) >>> 0);
  return [seagrass(rng), kelp(rng), branchCoral(rng), brainCoral(rng), seaFan(rng), boulder(rng), sponge(rng)];
}
