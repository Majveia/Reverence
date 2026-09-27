// Procedural creature geometry builder.
// Produces a BufferGeometry with:
//   position (rest pose, body frame: +Z forward, +Y up, +X left, meters)
//   normal   (smooth, computed)
//   aSkin    vec4 (bone0, bone1, weight0, flags) — weight1 = 1 - weight0
//   aInfo    vec4 (part*8 + material, u, dorsality, ambientOcclusion)
// Parts are lofted tubes (parallel-transport frames, superellipse sections), membranes
// (double-sided sheets), lathes and ellipsoids. All deterministic (no randomness here).
import * as THREE from 'three';

// part ids (shader decodes floor(aInfo.x / 8))
export const PART = { BODY: 0, HEAD: 1, LEG: 2, EAR: 3, HORN: 4, EYE: 5, FIN: 6, SPIKE: 7, TENTACLE: 8, SHELL: 9 };
// material ids (aInfo.x mod 8)
export const MAT = { SKIN: 0, KERATIN: 1, EYE: 2, MEMBRANE: 3, CARAPACE: 4, GLOW: 5, JELLY: 6, DARK: 7 };

const _skin = [0, 0, 1];
const _info = [0, 0, 0, 1];

export class MeshBuilder {
  constructor() {
    this.pos = []; this.skin = []; this.info = []; this.idx = [];
    this.nv = 0;
  }

  v(x, y, z, b0, b1, w0, i0, i1, i2, i3, flags = 0) {
    this.pos.push(x, y, z);
    this.skin.push(b0, b1, w0, flags);
    this.info.push(i0, i1, i2, i3);
    return this.nv++;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }

  /**
   * Loft a tube along a path.
   * o.pts: [[x,y,z],...]   o.w/o.ht/o.hb: per-point half width / top / bottom half-heights
   * o.segs: sides   o.power: superellipse exponent (2 = ellipse)
   * o.up: initial section-up hint [x,y,z]
   * o.skin(i, t, out3)       → bone0, bone1, w0 for ring i (t = normalized arc length 0..1)
   * o.info(i, t, s, out4)    → per vertex info (s = sin(theta): +1 top, -1 bottom)
   * o.capStart/o.capEnd: pole caps (length factor of the end radius)
   * o.bulge(i, t, cth, sth) optional radial multiplier per vertex (ridges, grooves)
   */
  loft(o) {
    const pts = o.pts, n = pts.length, segs = o.segs, p = o.power ?? 2;
    const ex = 2 / p;
    // arc length
    const sArr = new Float64Array(n);
    for (let i = 1; i < n; i++) sArr[i] = sArr[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    const total = sArr[n - 1] || 1;
    // tangents
    const T = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
      const l = Math.hypot(tx, ty, tz) || 1;
      T.push([tx / l, ty / l, tz / l]);
    }
    // initial frame
    const up = o.up || [0, 1, 0];
    let Y = [up[0], up[1], up[2]];
    let d = Y[0] * T[0][0] + Y[1] * T[0][1] + Y[2] * T[0][2];
    Y = [Y[0] - T[0][0] * d, Y[1] - T[0][1] * d, Y[2] - T[0][2] * d];
    let l = Math.hypot(Y[0], Y[1], Y[2]);
    if (l < 1e-6) { Y = Math.abs(T[0][1]) < 0.9 ? [0, 1, 0] : [0, 0, 1]; d = Y[0] * T[0][0] + Y[1] * T[0][1] + Y[2] * T[0][2]; Y = [Y[0] - T[0][0] * d, Y[1] - T[0][1] * d, Y[2] - T[0][2] * d]; l = Math.hypot(Y[0], Y[1], Y[2]); }
    Y = [Y[0] / l, Y[1] / l, Y[2] / l];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let X = cross(Y, T[0]);
    const rings = [];
    const cosT = new Float64Array(segs), sinT = new Float64Array(segs), cxs = new Float64Array(segs), cys = new Float64Array(segs);
    for (let k = 0; k < segs; k++) {
      const th = (k / segs) * Math.PI * 2 + (o.phase ?? 0);
      const c = Math.cos(th), s = Math.sin(th);
      cosT[k] = c; sinT[k] = s;
      cxs[k] = Math.sign(c) * Math.pow(Math.abs(c), ex);
      cys[k] = Math.sign(s) * Math.pow(Math.abs(s), ex);
    }
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        // parallel transport X, Y from T[i-1] to T[i]
        const a = T[i - 1], b = T[i];
        const ax = cross(a, b);
        const sn = Math.hypot(ax[0], ax[1], ax[2]);
        if (sn > 1e-9) {
          const cs = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
          const ang = Math.atan2(sn, cs);
          const k0 = ax[0] / sn, k1 = ax[1] / sn, k2 = ax[2] / sn;
          const rot = (v) => {
            const c = Math.cos(ang), s = Math.sin(ang);
            const dd = (k0 * v[0] + k1 * v[1] + k2 * v[2]) * (1 - c);
            return [v[0] * c + (k1 * v[2] - k2 * v[1]) * s + k0 * dd, v[1] * c + (k2 * v[0] - k0 * v[2]) * s + k1 * dd, v[2] * c + (k0 * v[1] - k1 * v[0]) * s + k2 * dd];
          };
          X = rot(X); Y = rot(Y);
        }
      }
      const t = sArr[i] / total;
      o.skin(i, t, _skin);
      const ring = new Int32Array(segs);
      const w = o.w[i], ht = o.ht ? o.ht[i] : w, hb = o.hb ? o.hb[i] : (o.ht ? o.ht[i] : w);
      const P = pts[i];
      for (let k = 0; k < segs; k++) {
        const s = sinT[k];
        let rx = w * cxs[k], ry = (s >= 0 ? ht : hb) * cys[k];
        if (o.bulge) { const m = o.bulge(i, t, cosT[k], s); rx *= m; ry *= m; }
        const x = P[0] + X[0] * rx + Y[0] * ry, y = P[1] + X[1] * rx + Y[1] * ry, z = P[2] + X[2] * rx + Y[2] * ry;
        o.info(i, t, s, _info, cosT[k]);
        ring[k] = this.v(x, y, z, _skin[0], _skin[1], _skin[2], _info[0], _info[1], _info[2], _info[3]);
      }
      rings.push(ring);
    }
    for (let i = 0; i < n - 1; i++) {
      const r0 = rings[i], r1 = rings[i + 1];
      for (let k = 0; k < segs; k++) {
        const k1 = (k + 1) % segs;
        this.tri(r0[k], r0[k1], r1[k]);
        this.tri(r0[k1], r1[k1], r1[k]);
      }
    }
    const cap = (i, dir) => {
      const P = pts[i], Tt = T[i];
      const len = (o.w[i] + (o.ht ? o.ht[i] : o.w[i])) * 0.5 * (dir < 0 ? (o.capStart === true ? 0.6 : o.capStart) : (o.capEnd === true ? 0.6 : o.capEnd));
      const t = i === 0 ? 0 : 1;
      o.skin(i, t, _skin);
      o.info(i, t, 0, _info, 1);
      const pole = this.v(P[0] + Tt[0] * len * dir, P[1] + Tt[1] * len * dir, P[2] + Tt[2] * len * dir, _skin[0], _skin[1], _skin[2], _info[0], _info[1], _info[2], _info[3]);
      const r = rings[i];
      for (let k = 0; k < segs; k++) {
        const k1 = (k + 1) % segs;
        if (dir < 0) this.tri(pole, r[k1], r[k]); else this.tri(pole, r[k], r[k1]);
      }
    };
    if (o.capStart) cap(0, -1);
    if (o.capEnd) cap(n - 1, 1);
    return rings;
  }

  /**
   * Double-sided membrane from a grid of points grid[i][j] (i: span, j: chord).
   * skin(i, j, out3), info(i, j, side, out4).  thickness: separation of the two sides.
   */
  membrane(grid, skin, info, thickness = 0.0) {
    const ni = grid.length, nj = grid[0].length;
    // approximate normals via cross of grid derivatives
    const nrm = [];
    for (let i = 0; i < ni; i++) {
      const row = [];
      for (let j = 0; j < nj; j++) {
        const a = grid[Math.min(ni - 1, i + 1)][j], b = grid[Math.max(0, i - 1)][j];
        const c = grid[i][Math.min(nj - 1, j + 1)], e = grid[i][Math.max(0, j - 1)];
        const du = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dv = [c[0] - e[0], c[1] - e[1], c[2] - e[2]];
        let nx = du[1] * dv[2] - du[2] * dv[1], ny = du[2] * dv[0] - du[0] * dv[2], nz = du[0] * dv[1] - du[1] * dv[0];
        const l = Math.hypot(nx, ny, nz) || 1;
        row.push([nx / l, ny / l, nz / l]);
      }
      nrm.push(row);
    }
    for (const side of [1, -1]) {
      const ids = [];
      for (let i = 0; i < ni; i++) {
        const row = new Int32Array(nj);
        for (let j = 0; j < nj; j++) {
          const P = grid[i][j], N = nrm[i][j], off = thickness * 0.5 * side;
          skin(i, j, _skin); info(i, j, side, _info);
          row[j] = this.v(P[0] + N[0] * off, P[1] + N[1] * off, P[2] + N[2] * off, _skin[0], _skin[1], _skin[2], _info[0], _info[1], _info[2], _info[3]);
        }
        ids.push(row);
      }
      for (let i = 0; i < ni - 1; i++) for (let j = 0; j < nj - 1; j++) {
        const a = ids[i][j], b = ids[i + 1][j], c = ids[i][j + 1], dd = ids[i + 1][j + 1];
        if (side > 0) { this.tri(a, b, c); this.tri(b, dd, c); } else { this.tri(a, c, b); this.tri(b, c, dd); }
      }
    }
  }

  /** Lathe around an axis through `center` along `axis` (unit). profile: [[r, h], ...]. */
  lathe(center, axis, profile, segs, skin, info, capTop = false) {
    // build basis
    const ax = axis;
    const ref = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let ux = ref[1] * ax[2] - ref[2] * ax[1], uy = ref[2] * ax[0] - ref[0] * ax[2], uz = ref[0] * ax[1] - ref[1] * ax[0];
    let l = Math.hypot(ux, uy, uz); ux /= l; uy /= l; uz /= l;
    const vx = ax[1] * uz - ax[2] * uy, vy = ax[2] * ux - ax[0] * uz, vz = ax[0] * uy - ax[1] * ux;
    const rings = [];
    for (let i = 0; i < profile.length; i++) {
      const [r, h] = profile[i];
      const ring = new Int32Array(segs);
      for (let k = 0; k < segs; k++) {
        const th = (k / segs) * Math.PI * 2;
        const c = Math.cos(th), s = Math.sin(th);
        const x = center[0] + ax[0] * h + (ux * c + vx * s) * r;
        const y = center[1] + ax[1] * h + (uy * c + vy * s) * r;
        const z = center[2] + ax[2] * h + (uz * c + vz * s) * r;
        skin(i, k, _skin); info(i, k, _info);
        ring[k] = this.v(x, y, z, _skin[0], _skin[1], _skin[2], _info[0], _info[1], _info[2], _info[3]);
      }
      rings.push(ring);
    }
    for (let i = 0; i < rings.length - 1; i++) {
      const r0 = rings[i], r1 = rings[i + 1];
      for (let k = 0; k < segs; k++) {
        const k1 = (k + 1) % segs;
        this.tri(r0[k], r0[k1], r1[k]);
        this.tri(r0[k1], r1[k1], r1[k]);
      }
    }
    if (capTop) {
      const [, h] = profile[profile.length - 1];
      skin(profile.length - 1, 0, _skin); info(profile.length - 1, 0, _info);
      const pole = this.v(center[0] + ax[0] * h, center[1] + ax[1] * h, center[2] + ax[2] * h, _skin[0], _skin[1], _skin[2], _info[0], _info[1], _info[2], _info[3]);
      const r = rings[rings.length - 1];
      for (let k = 0; k < segs; k++) this.tri(pole, r[k], r[(k + 1) % segs]);
    }
    return rings;
  }

  /** Ellipsoid centered at c with semi-axes along body axes (x,y,z) optionally rotated by a basis. */
  ellipsoid(c, rx, ry, rz, segs, rings, skin, info, basis = null) {
    const pts = [], w = [], ht = [];
    for (let i = 0; i <= rings; i++) {
      const t = i / rings, a = -1 + 2 * t;
      const r = Math.sqrt(Math.max(0, 1 - a * a));
      pts.push([0, 0, a * rz]); w.push(Math.max(1e-4, r * rx)); ht.push(Math.max(1e-4, r * ry));
    }
    // transform along an arbitrary basis
    const B = basis || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const tp = pts.map((p) => [c[0] + B[2][0] * p[2], c[1] + B[2][1] * p[2], c[2] + B[2][2] * p[2]]);
    return this.loft({ pts: tp, w, ht, hb: ht, segs, up: B[1], skin: (i, t, o) => skin(t, o), info: (i, t, s, o, cth) => info(t, s, o, cth), capStart: false, capEnd: false });
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aSkin', new THREE.Float32BufferAttribute(this.skin, 4));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info, 4));
    g.setIndex(this.nv > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ path helpers

/** Catmull-Rom through control points; attrs interpolated too. Returns {pts, attrs[k][]} resampled by arc length. */
export function spline(ctrl, n, attrKeys = []) {
  // ctrl: [{p:[x,y,z], ...attrs}]
  const dense = [];
  const m = ctrl.length;
  const get = (i) => ctrl[Math.max(0, Math.min(m - 1, i))];
  const cr = (a, b, c, d, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  };
  const SUB = 24;
  for (let i = 0; i < m - 1; i++) {
    const A = get(i - 1), B = get(i), C = get(i + 1), D = get(i + 2);
    for (let k = 0; k < SUB; k++) {
      const t = k / SUB;
      const p = [0, 1, 2].map((j) => cr(A.p[j], B.p[j], C.p[j], D.p[j], t));
      const at = {};
      for (const key of attrKeys) at[key] = cr(A[key], B[key], C[key], D[key], t);
      dense.push({ p, at });
    }
  }
  const L = ctrl[m - 1];
  const lastAt = {}; for (const key of attrKeys) lastAt[key] = L[key];
  dense.push({ p: [...L.p], at: lastAt });
  // arc length resample
  const s = [0];
  for (let i = 1; i < dense.length; i++) s.push(s[i - 1] + Math.hypot(dense[i].p[0] - dense[i - 1].p[0], dense[i].p[1] - dense[i - 1].p[1], dense[i].p[2] - dense[i - 1].p[2]));
  const total = s[s.length - 1];
  const out = { pts: [], s: [], total };
  for (const key of attrKeys) out[key] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    while (j < dense.length - 2 && s[j + 1] < target) j++;
    const seg = s[j + 1] - s[j] || 1;
    const f = Math.max(0, Math.min(1, (target - s[j]) / seg));
    const a = dense[j], b = dense[j + 1];
    out.pts.push([a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f, a.p[2] + (b.p[2] - a.p[2]) * f]);
    out.s.push(target);
    for (const key of attrKeys) out[key].push(a.at[key] + (b.at[key] - a.at[key]) * f);
  }
  return out;
}

/**
 * Chain skinning helper. joints: ascending arc-length positions of joints; owners: bone owning
 * each interval (length joints.length + 1). blend: half-width of the blend zone (same units as s).
 */
export function chainSkin(s, joints, owners, blend, out) {
  let k = 0;
  while (k < joints.length && s >= joints[k]) k++;
  // interval k is owned by owners[k]; nearest joint is joints[k-1] (below) or joints[k] (above)
  const below = k > 0 ? joints[k - 1] : -Infinity, above = k < joints.length ? joints[k] : Infinity;
  const bw = Array.isArray(blend) ? blend : null;
  const bb = bw ? bw[Math.max(0, k - 1)] : blend, ba = bw ? bw[Math.min(bw.length - 1, k)] : blend;
  if (s - below < bb && k > 0) {
    // blend with previous interval owner
    const t = 0.5 + 0.5 * (s - below) / bb; // 0.5 at joint → 1 at edge of zone
    const w = t * t * (3 - 2 * t);
    out[0] = owners[k]; out[1] = owners[k - 1]; out[2] = w;
  } else if (above - s < ba && k < joints.length) {
    const t = 0.5 + 0.5 * (above - s) / ba;
    const w = t * t * (3 - 2 * t);
    out[0] = owners[k]; out[1] = owners[k + 1]; out[2] = w;
  } else {
    out[0] = owners[k]; out[1] = owners[k]; out[2] = 1;
  }
  return out;
}
