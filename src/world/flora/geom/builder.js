// PlantBuilder — accumulates plant geometry with the flora vertex format:
//   position, normal (geometric), uv (atlas / bark coords),
//   aInfo  = (kind*16 + pattern, windFlex, ao, windPhase)
//   aShade = shading normal for foliage (spherified canopy normal); = normal for solids
//   aColor = linear rgb tint
// Kinds: 0 bark · 1 leaf card · 2 flower/petal card · 3 solid · 4 glow solid · 5 crystal
import * as THREE from 'three';

export const KIND = { BARK: 0, LEAF: 1, FLOWER: 2, SOLID: 3, GLOW: 4, CRYSTAL: 5 };
export const PAT = { NONE: 0, SPOTS: 1, STRIPES: 2, POLKA: 3, EYE: 4, GILLS: 5, BANDS: 6, RIBS: 7 };

const _t = new THREE.Vector3(), _n = new THREE.Vector3(), _b = new THREE.Vector3(), _tmp = new THREE.Vector3();

export class PlantBuilder {
  constructor() {
    this.p = []; this.n = []; this.uv = []; this.info = []; this.sh = []; this.c = []; this.cr = []; this.idx = [];
    this.count = 0;
    this.maxCard = 0;
  }

  vert(px, py, pz, nx, ny, nz, u, v, kind, flex, ao, phase, sx, sy, sz, r, g, b) {
    this.p.push(px, py, pz); this.n.push(nx, ny, nz); this.uv.push(u, v);
    this.info.push(kind, flex, ao, phase); this.sh.push(sx, sy, sz); this.c.push(r, g, b); this.cr.push(0, 0, 0);
    return this.count++;
  }

  /**
   * Camera-facing leaf-cluster card (billboarded in the vertex shader around its center; faces the
   * light in shadow passes). o: { c:[x,y,z] center, w, h (half extents), roll, rect, kind, flex, ao,
   * phase, color, shade:[x,y,z] shading normal }
   */
  bcard(o) {
    const kind = (o.kind ?? KIND.LEAF) * 16 + (o.pattern ?? 0);
    const [cx, cy, cz] = o.c, rect = o.rect, sh = o.shade || [0, 1, 0], col = o.color || [0.2, 0.4, 0.15];
    const cr = Math.cos(o.roll || 0), sr = Math.sin(o.roll || 0);
    const base = this.count;
    const W = o.w, H = o.h ?? o.w;
    this.maxCard = Math.max(this.maxCard, Math.hypot(W, H));
    const corners = [[-1, -1, rect[0], rect[3]], [1, -1, rect[2], rect[3]], [-1, 1, rect[0], rect[1]], [1, 1, rect[2], rect[1]]];
    for (const [sx, sy, u, v] of corners) {
      const x = sx * W, y = sy * H;
      this.vert(cx, cy, cz, sh[0], sh[1], sh[2], u, v, kind, o.flex ?? 0, o.ao ?? 1, o.phase ?? 0, sh[0], sh[1], sh[2], col[0], col[1], col[2]);
      const k = (this.count - 1) * 3;
      this.cr[k] = x * cr - y * sr; this.cr[k + 1] = x * sr + y * cr; this.cr[k + 2] = 1;
    }
    this.tri(base, base + 1, base + 3); this.tri(base, base + 3, base + 2);
  }
  tri(a, b, c) { this.idx.push(a, b, c); }

  /**
   * Generalized cylinder along a path.
   * pts: [{x,y,z,r,flex,ao}] (≥2). opts: {segs, kind, pattern, color:[r,g,b] | fn(t)->rgb, phase, vScale, capTip, uOffset}
   */
  tube(pts, opts = {}) {
    const segs = Math.max(3, opts.segs ?? 6);
    const kind = (opts.kind ?? KIND.BARK) * 16 + (opts.pattern ?? 0);
    const phase = opts.phase ?? 0;
    const vScale = opts.vScale ?? 1;
    const n = pts.length;
    if (n < 2) return;
    // parallel-transport frame
    const T = [], N = [], B = [];
    for (let k = 0; k < n; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
      T.push(new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).normalize());
    }
    let n0 = Math.abs(T[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    n0 = new THREE.Vector3().crossVectors(T[0], n0).normalize();
    N.push(n0); B.push(new THREE.Vector3().crossVectors(T[0], n0).normalize());
    for (let k = 1; k < n; k++) {
      const axis = _tmp.crossVectors(T[k - 1], T[k]);
      const nk = N[k - 1].clone();
      if (axis.length() > 1e-6) nk.applyAxisAngle(axis.normalize(), Math.acos(Math.max(-1, Math.min(1, T[k - 1].dot(T[k])))));
      nk.addScaledVector(T[k], -nk.dot(T[k])).normalize();
      N.push(nk); B.push(new THREE.Vector3().crossVectors(T[k], nk).normalize());
    }
    let vAcc = 0;
    const base = this.count;
    const uOff = opts.uOffset ?? 0;
    for (let k = 0; k < n; k++) {
      const q = pts[k];
      if (k > 0) {
        const pq = pts[k - 1];
        const len = Math.hypot(q.x - pq.x, q.y - pq.y, q.z - pq.z);
        const rr = Math.max(0.02, (q.r + pq.r) * 0.5);
        vAcc += (len / (Math.PI * 2 * rr)) * 0.5 * vScale;
      }
      const col = typeof opts.color === 'function' ? opts.color(k / (n - 1), q) : (q.color || opts.color || [0.3, 0.25, 0.2]);
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const nx = N[k].x * ca + B[k].x * sa, ny = N[k].y * ca + B[k].y * sa, nz = N[k].z * ca + B[k].z * sa;
        const r = q.r;
        this.vert(q.x + nx * r, q.y + ny * r, q.z + nz * r, nx, ny, nz, s / segs + uOff, vAcc,
          kind, q.flex ?? 0, q.ao ?? 1, phase, nx, ny, nz, col[0], col[1], col[2]);
      }
    }
    for (let k = 0; k < n - 1; k++) {
      for (let s = 0; s < segs; s++) {
        const a = base + k * (segs + 1) + s, b = a + 1, c = a + segs + 1, d = c + 1;
        this.tri(a, b, c); this.tri(b, d, c);
      }
    }
    if (opts.capTip) {
      const q = pts[n - 1], t = T[n - 1];
      const col = typeof opts.color === 'function' ? opts.color(1, q) : (q.color || opts.color || [0.3, 0.25, 0.2]);
      const tip = this.vert(q.x + t.x * q.r, q.y + t.y * q.r, q.z + t.z * q.r, t.x, t.y, t.z, 0.5, vAcc + 0.05, kind, q.flex ?? 0, q.ao ?? 1, phase, t.x, t.y, t.z, col[0], col[1], col[2]);
      const ring = base + (n - 1) * (segs + 1);
      for (let s = 0; s < segs; s++) this.tri(ring + s, ring + s + 1, tip);
    }
  }

  /**
   * Leaf/flower card: a (possibly bent) quad strip.
   * o: { c:[x,y,z] base-center, right:[x,y,z] (half width vector), up:[x,y,z] (full length vector),
   *      rect:[u0,v0,u1,v1] (v down), kind, flex0, flex1, ao0, ao1, phase, color, shade:[x,y,z] | fn(p)->[x,y,z],
   *      bend (m, along card normal at tip), segs, u0/u1 sub-range, curl }
   */
  card(o) {
    const segs = o.segs ?? 1;
    const kind = (o.kind ?? KIND.LEAF) * 16 + (o.pattern ?? 0);
    const [cx, cy, cz] = o.c, [rx, ry, rz] = o.right, [ux, uy, uz] = o.up;
    // normal = right × up
    let nx = ry * uz - rz * uy, ny = rz * ux - rx * uz, nz = rx * uy - ry * ux;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const rect = o.rect;
    const su0 = o.su0 ?? 0, su1 = o.su1 ?? 1;
    const U0 = rect[0] + (rect[2] - rect[0]) * su0, U1 = rect[0] + (rect[2] - rect[0]) * su1;
    const base = this.count;
    const col = o.color || [0.2, 0.4, 0.15];
    const bend = o.bend ?? 0;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const off = bend * t * t;
      const px = cx + ux * t + nx * off, py = cy + uy * t + ny * off, pz = cz + uz * t + nz * off;
      const v = rect[3] + (rect[1] - rect[3]) * t;
      const flex = (o.flex0 ?? 0) + ((o.flex1 ?? o.flex0 ?? 0) - (o.flex0 ?? 0)) * t;
      const ao = (o.ao0 ?? 1) + ((o.ao1 ?? o.ao0 ?? 1) - (o.ao0 ?? 1)) * t;
      // bent normal: tilt by derivative of the bend
      const dOff = 2 * bend * t;
      const ul = Math.hypot(ux, uy, uz) || 1;
      let bnx = nx - (ux / ul) * dOff / ul, bny = ny - (uy / ul) * dOff / ul, bnz = nz - (uz / ul) * dOff / ul;
      const bl = Math.hypot(bnx, bny, bnz) || 1; bnx /= bl; bny /= bl; bnz /= bl;
      for (let s = 0; s < 2; s++) {
        const sgn = s === 0 ? -1 : 1;
        const curl = (o.curl ?? 0) * t;
        const wx = px + rx * sgn + nx * curl, wy = py + ry * sgn + ny * curl, wz = pz + rz * sgn + nz * curl;
        let sh = o.shade;
        if (typeof sh === 'function') sh = sh(wx, wy, wz);
        if (!sh) sh = [bnx, bny, bnz];
        const cc = typeof col === 'function' ? col(t, s) : col;
        this.vert(wx, wy, wz, bnx, bny, bnz, s === 0 ? U0 : U1, v, kind, flex, ao, o.phase ?? 0, sh[0], sh[1], sh[2], cc[0], cc[1], cc[2]);
      }
    }
    for (let k = 0; k < segs; k++) {
      const a = base + k * 2, b = a + 1, c = a + 2, d = a + 3;
      this.tri(a, b, d); this.tri(a, d, c);
    }
  }

  /** UV sphere / ellipsoid (solid kinds). o: { c, r:[rx,ry,rz], wSegs, hSegs, kind, pattern, color(fn|rgb), flex, ao, phase, rot } */
  sphere(o) {
    const W = o.wSegs ?? 12, H = o.hSegs ?? 8;
    const kind = (o.kind ?? KIND.SOLID) * 16 + (o.pattern ?? 0);
    const [cx, cy, cz] = o.c;
    const r = Array.isArray(o.r) ? o.r : [o.r, o.r, o.r];
    const base = this.count;
    for (let j = 0; j <= H; j++) {
      const th = (j / H) * Math.PI;
      const st = Math.sin(th), ct = Math.cos(th);
      for (let i = 0; i <= W; i++) {
        const ph = (i / W) * Math.PI * 2;
        const x = st * Math.cos(ph), y = ct, z = st * Math.sin(ph);
        let nx = x / r[0], ny = y / r[1], nz = z / r[2];
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        const col = typeof o.color === 'function' ? o.color(x, y, z) : (o.color || [0.5, 0.5, 0.5]);
        const flex = typeof o.flex === 'function' ? o.flex(y) : (o.flex ?? 0);
        const ao = typeof o.ao === 'function' ? o.ao(y) : (o.ao ?? 1);
        this.vert(cx + x * r[0], cy + y * r[1], cz + z * r[2], nx, ny, nz, i / W, j / H, kind, flex, ao, o.phase ?? 0, nx, ny, nz, col[0], col[1], col[2]);
      }
    }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const a = base + j * (W + 1) + i, b = a + 1, c = a + W + 1, d = c + 1;
      this.tri(a, b, c); this.tri(b, d, c);
    }
  }

  /** Surface of revolution around +Y through c. prof: [{r, y, n:[nr, ny] optional}], segs radial. */
  lathe(c, prof, o = {}) {
    const segs = o.segs ?? 16;
    const kind = (o.kind ?? KIND.SOLID) * 16 + (o.pattern ?? 0);
    const base = this.count;
    const m = prof.length;
    for (let k = 0; k < m; k++) {
      const q = prof[k];
      // profile normal from neighbors (outward)
      const a = prof[Math.max(0, k - 1)], b = prof[Math.min(m - 1, k + 1)];
      let dr = b.r - a.r, dy = b.y - a.y;
      let pnr = -dy, pny = dr; // outward for profiles running axis→rim, top→down
      const pl = Math.hypot(pnr, pny) || 1; pnr /= pl; pny /= pl;
      if (o.flip) { pnr = -pnr; pny = -pny; }
      for (let s = 0; s <= segs; s++) {
        const ph = (s / segs) * Math.PI * 2 + (o.phi0 ?? 0);
        const cph = Math.cos(ph), sph = Math.sin(ph);
        const col = typeof o.color === 'function' ? o.color(k / (m - 1), s / segs) : (o.color || [0.5, 0.5, 0.5]);
        const nx = pnr * cph, ny = pny, nz = pnr * sph;
        this.vert(c[0] + q.r * cph, c[1] + q.y, c[2] + q.r * sph, nx, ny, nz, s / segs, k / (m - 1), kind,
          q.flex ?? o.flex ?? 0, q.ao ?? o.ao ?? 1, o.phase ?? 0, nx, ny, nz, col[0], col[1], col[2]);
      }
    }
    for (let k = 0; k < m - 1; k++) for (let s = 0; s < segs; s++) {
      const a = base + k * (segs + 1) + s, b = a + 1, cc = a + segs + 1, d = cc + 1;
      if (o.flip) { this.tri(a, cc, b); this.tri(b, cc, d); } else { this.tri(a, b, cc); this.tri(b, d, cc); }
    }
  }

  /** Merge another builder's data (already in this model's space). */
  append(other) {
    const off = this.count;
    this.p.push(...other.p); this.n.push(...other.n); this.uv.push(...other.uv);
    this.info.push(...other.info); this.sh.push(...other.sh); this.c.push(...other.c); this.cr.push(...other.cr);
    this.maxCard = Math.max(this.maxCard, other.maxCard);
    for (let i = 0; i < other.idx.length; i++) this.idx.push(other.idx[i] + off);
    this.count += other.count;
  }

  bounds() {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const p = this.p, cr = this.cr;
    for (let i = 0; i < p.length; i += 3) {
      const e = Math.hypot(cr[i], cr[i + 1]);
      if (p[i] - e < x0) x0 = p[i] - e; if (p[i] + e > x1) x1 = p[i] + e;
      if (p[i + 1] - e < y0) y0 = p[i + 1] - e; if (p[i + 1] + e > y1) y1 = p[i + 1] + e;
      if (p[i + 2] - e < z0) z0 = p[i + 2] - e; if (p[i + 2] + e > z1) z1 = p[i + 2] + e;
    }
    return { min: [x0, y0, z0], max: [x1, y1, z1] };
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info, 4));
    g.setAttribute('aShade', new THREE.Float32BufferAttribute(this.sh, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(this.cr, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    g.boundingSphere.radius += this.maxCard;
    g.boundingBox.expandByScalar(this.maxCard);
    g.userData.maxCard = this.maxCard;
    return g;
  }
}

/** Evaluate a quadratic/cubic bezier path into points with lerped radius etc. */
export function bezierPath(P, nSeg, r0, r1, extra = {}) {
  const out = [];
  const cubic = P.length === 4;
  for (let k = 0; k <= nSeg; k++) {
    const t = k / nSeg, it = 1 - t;
    let x, y, z;
    if (cubic) {
      const a = it * it * it, b = 3 * it * it * t, c = 3 * it * t * t, d = t * t * t;
      x = P[0][0] * a + P[1][0] * b + P[2][0] * c + P[3][0] * d;
      y = P[0][1] * a + P[1][1] * b + P[2][1] * c + P[3][1] * d;
      z = P[0][2] * a + P[1][2] * b + P[2][2] * c + P[3][2] * d;
    } else {
      const a = it * it, b = 2 * it * t, c = t * t;
      x = P[0][0] * a + P[1][0] * b + P[2][0] * c;
      y = P[0][1] * a + P[1][1] * b + P[2][1] * c;
      z = P[0][2] * a + P[1][2] * b + P[2][2] * c;
    }
    const r = typeof r0 === 'function' ? r0(t) : r0 + (r1 - r0) * t;
    out.push({ x, y, z, r, t, flex: extra.flex ? extra.flex(t) : 0, ao: extra.ao ? extra.ao(t) : 1 });
  }
  return out;
}

export const norm3 = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
