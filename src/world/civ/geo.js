// Civ geometry builder: appends procedural primitives (bevelled boxes, lathes, roofs, tubes,
// extrusions…) into compact typed attribute streams, then emits ONE BufferGeometry per settlement
// (all materials share the civ uber-shader: per-vertex albedo, roughness/metal/emission/pattern).
//
// Attributes: position (f32), normal (f32), uv (f32, meters or window-cell units), aCol (u8 sRGB),
// aMat (u8: rough*255, metal*255, emit*16, pattern id), aAux (f32: height above building base, seed).
import * as THREE from 'three';

const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _t = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

/** Pattern ids interpreted by the uber shader (material.js). */
export const PAT = {
  PLAIN: 0, WINDOWS: 1, PLANKS: 2, STONE: 3, PANELS: 4, TILES: 5, GLASS: 6, NEON: 7, LAMP: 8,
  THATCH: 9, CORRUGATED: 10, COBBLE: 11, ASPHALT: 12, DIRT: 13, GLYPH: 14, ARCHWIN: 15, CONCRETE: 16,
  HOLO: 17, FABRIC: 18, RUST: 19, CRYSTAL: 20, PAVING: 21, SLITS: 22, MOSS: 23,
};
/** Patterns whose uv is in window-cell units on vertical faces. */
const CELL_PATS = new Set([PAT.WINDOWS, PAT.GLASS, PAT.ARCHWIN, PAT.SLITS]);

class Grow {
  constructor(Type, n = 4096) { this.T = Type; this.a = new Type(n); this.n = 0; }
  need(k) {
    if (this.n + k <= this.a.length) return;
    let len = this.a.length * 2; while (len < this.n + k) len *= 2;
    const b = new this.T(len); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  view() { return this.a.slice(0, this.n); }
}

/** Material descriptor → packed values. color: hex/Color (sRGB). */
export function mat(color, rough = 0.8, metal = 0, pat = 0, emit = 0) {
  const c = new THREE.Color(color); const s = c.clone().convertLinearToSRGB();
  return { r: Math.round(s.r * 255), g: Math.round(s.g * 255), b: Math.round(s.b * 255),
    rough: Math.round(THREE.MathUtils.clamp(rough, 0, 1) * 255), metal: Math.round(THREE.MathUtils.clamp(metal, 0, 1) * 255),
    emit: Math.round(THREE.MathUtils.clamp(emit, 0, 15.9) * 16), pat, color: c };
}
/** Variant of a material with a tinted/shifted color. */
export function tint(M, k = 1, dh = 0, ds = 0) {
  const c = M.color.clone(); const hsl = {}; c.getHSL(hsl);
  c.setHSL((hsl.h + dh + 1) % 1, THREE.MathUtils.clamp(hsl.s + ds, 0, 1), THREE.MathUtils.clamp(hsl.l * k, 0, 1));
  const s = c.clone().convertLinearToSRGB();
  return { ...M, r: Math.round(s.r * 255), g: Math.round(s.g * 255), b: Math.round(s.b * 255), color: c };
}

export class Geo {
  constructor() {
    this.P = new Grow(Float32Array, 3 * 8192); this.N = new Grow(Float32Array, 3 * 8192);
    this.U = new Grow(Float32Array, 2 * 8192); this.C = new Grow(Uint8Array, 3 * 8192);
    this.Mt = new Grow(Uint8Array, 4 * 8192); this.X = new Grow(Float32Array, 2 * 8192);
    this.I = new Grow(Uint32Array, 3 * 8192);
    this.vc = 0;
    this.m = new THREE.Matrix4();
    this.nm = new THREE.Matrix3();
    this.stack = [];
    this.M = mat('#888888');
    this.bo = new THREE.Vector3(); this.bu = new THREE.Vector3(0, 1, 0); this.seed = 0;
    this.win = { sx: 2.6, fh: 3.4, y0: 0 };
    this.tris = 0;
    this.segK = 1;      // tessellation multiplier for round primitives (big sites use fewer segments)
    this.lights = [];   // glow sprites: {x,y,z (mesh space), r,g,b (linear * intensity), size, kind, phase}
    this.boxes = [];    // collider boxes: {c: Vector3 (mesh space), q: Quaternion, hx, hy, hz}
  }

  /** Glow sprite at a local point (current frame). color hex, intensity, size m, kind 0 lamp · 1 blink · 2 lantern · 3 cluster. */
  light(x, y, z, color, intensity = 4, size = 1.2, kind = 0) {
    _v.set(x, y, z).applyMatrix4(this.m);
    const c = typeof color === 'object' ? color : new THREE.Color(color);
    this.lights.push({ x: _v.x, y: _v.y, z: _v.z, r: c.r * intensity, g: c.g * intensity, b: c.b * intensity, size, kind, phase: (this.lights.length * 0.618) % 1 });
    return this;
  }
  /** Oriented collider box (local centre + half extents in the current frame). */
  collider(cx, cy, cz, hx, hy, hz) {
    const c = new THREE.Vector3(cx, cy, cz).applyMatrix4(this.m);
    const q = new THREE.Quaternion(); const p = new THREE.Vector3(), sc = new THREE.Vector3();
    this.m.decompose(p, q, sc);
    this.boxes.push({ c, q, hx: hx * sc.x, hy: hy * sc.y, hz: hz * sc.z });
    return this;
  }

  // ------------------------------------------------------------ state
  /** Start a building: frame origin/up in mesh space (aux.x = height above origin along up). */
  begin(matrix, seed = 0) {
    this.m.copy(matrix); this.stack.length = 0; this._nm();
    this.bo.setFromMatrixPosition(matrix);
    this.bu.set(matrix.elements[4], matrix.elements[5], matrix.elements[6]).normalize();
    this.seed = seed;
    return this;
  }
  _nm() { this.nm.getNormalMatrix(this.m); }
  push() { this.stack.push(this.m.clone()); return this; }
  pop() { this.m.copy(this.stack.pop()); this._nm(); return this; }
  translate(x, y, z) { this.m.multiply(_m.makeTranslation(x, y, z)); return this; }
  rotY(a) { this.m.multiply(_m.makeRotationY(a)); this._nm(); return this; }
  rotX(a) { this.m.multiply(_m.makeRotationX(a)); this._nm(); return this; }
  rotZ(a) { this.m.multiply(_m.makeRotationZ(a)); this._nm(); return this; }
  scale(x, y, z) { this.m.multiply(_m.makeScale(x, y ?? x, z ?? x)); this._nm(); return this; }
  /** Orient local +Y along dir (mesh-local vector in current frame). */
  alignY(dx, dy, dz) {
    _a.set(dx, dy, dz).normalize(); _q.setFromUnitVectors(_b.set(0, 1, 0), _a);
    this.m.multiply(_m.makeRotationFromQuaternion(_q)); this._nm(); return this;
  }
  set(M) { this.M = M; return this; }
  windows(sx, fh, y0 = 0) { this.win.sx = sx; this.win.fh = fh; this.win.y0 = y0; return this; }

  // ------------------------------------------------------------ low level
  vert(x, y, z, nx, ny, nz, u, v, M = this.M) {
    const P = this.P, N = this.N;
    P.need(3); N.need(3); this.U.need(2); this.C.need(3); this.Mt.need(4); this.X.need(2);
    _v.set(x, y, z).applyMatrix4(this.m);
    _n.set(nx, ny, nz).applyMatrix3(this.nm).normalize();
    let i = P.n; P.a[i] = _v.x; P.a[i + 1] = _v.y; P.a[i + 2] = _v.z; P.n += 3;
    i = N.n; N.a[i] = _n.x; N.a[i + 1] = _n.y; N.a[i + 2] = _n.z; N.n += 3;
    i = this.U.n; this.U.a[i] = u; this.U.a[i + 1] = v; this.U.n += 2;
    i = this.C.n; this.C.a[i] = M.r; this.C.a[i + 1] = M.g; this.C.a[i + 2] = M.b; this.C.n += 3;
    i = this.Mt.n; this.Mt.a[i] = M.rough; this.Mt.a[i + 1] = M.metal; this.Mt.a[i + 2] = M.emit; this.Mt.a[i + 3] = M.pat; this.Mt.n += 4;
    const hgt = (_v.x - this.bo.x) * this.bu.x + (_v.y - this.bo.y) * this.bu.y + (_v.z - this.bo.z) * this.bu.z;
    i = this.X.n; this.X.a[i] = hgt; this.X.a[i + 1] = this.seed; this.X.n += 2;
    return this.vc++;
  }
  tri(a, b, c) { const I = this.I; I.need(3); I.a[I.n++] = a; I.a[I.n++] = b; I.a[I.n++] = c; this.tris++; }
  quadIdx(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }

  /** Planar quad p0..p3 (CCW seen from the front), flat normal, uv per corner. */
  quad(p0, p1, p2, p3, uv = null, M = this.M) {
    _a.subVectors(p1, p0); _b.subVectors(p3, p0); _t.crossVectors(_a, _b).normalize();
    const nx = _t.x, ny = _t.y, nz = _t.z;
    const u = uv || [0, 0, _a.length(), 0, _a.length(), _b.length(), 0, _b.length()];
    const a = this.vert(p0.x, p0.y, p0.z, nx, ny, nz, u[0], u[1], M);
    const b = this.vert(p1.x, p1.y, p1.z, nx, ny, nz, u[2], u[3], M);
    const c = this.vert(p2.x, p2.y, p2.z, nx, ny, nz, u[4], u[5], M);
    const d = this.vert(p3.x, p3.y, p3.z, nx, ny, nz, u[6], u[7], M);
    this.quadIdx(a, b, c, d);
  }
  triFlat(p0, p1, p2, uv = null, M = this.M) {
    _a.subVectors(p1, p0); _b.subVectors(p2, p0); _t.crossVectors(_a, _b).normalize();
    const u = uv || [0, 0, _a.length(), 0, 0, _b.length()];
    const a = this.vert(p0.x, p0.y, p0.z, _t.x, _t.y, _t.z, u[0], u[1], M);
    const b = this.vert(p1.x, p1.y, p1.z, _t.x, _t.y, _t.z, u[2], u[3], M);
    const c = this.vert(p2.x, p2.y, p2.z, _t.x, _t.y, _t.z, u[4], u[5], M);
    this.tri(a, b, c);
  }

  // ------------------------------------------------------------ primitives
  /**
   * Box centred at (cx, y0 + h/2, cz): width w (x), height h (y), depth d (z). Base at y0.
   * bevel > 0 → chamfered edges (catches highlights; reads as crafted). Window patterns map uv in
   * cell units on the sides (cells centred on each face) and fall back to PLAIN on top/bottom.
   */
  box(cx, y0, cz, w, h, d, bevel = 0, M = this.M, opt = null) {
    const hx = w / 2, hy = h / 2, hz = d / 2, cy = y0 + hy;
    const cell = CELL_PATS.has(M.pat);
    const Mtop = cell ? (opt?.top || { ...M, pat: PAT.PLAIN }) : (opt?.top || M);
    const e = Math.min(w, h, d) < 0.3 ? 0 : Math.min(bevel, hx * 0.45, hy * 0.45, hz * 0.45);
    const sx = this.win.sx, fh = this.win.fh, wy0 = this.win.y0;
    const side = (len) => (cell ? Math.max(1, Math.round(len / sx)) / len : 1);
    // faces: [normal, tangent u, extent along u, extent along v(up for sides)]
    const F = [
      [1, 0, 0, 0, 0, -1, hz, hy, hx], [-1, 0, 0, 0, 0, 1, hz, hy, hx],
      [0, 0, 1, 1, 0, 0, hx, hy, hz], [0, 0, -1, -1, 0, 0, hx, hy, hz],
      [0, 1, 0, 1, 0, 0, hx, hz, hy], [0, -1, 0, 1, 0, 0, hx, hz, hy],
    ];
    for (let f = 0; f < 6; f++) {
      const [nx, ny, nz, tx, ty, tz, eu, ev, en] = F[f];
      // bitangent = n × t
      const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      const vert = f < 4;
      const MM = vert ? M : Mtop;
      const su = vert ? side(2 * eu) : 1;
      const cu = eu - e, cv = ev - e;
      const idx = [];
      for (let k = 0; k < 4; k++) {
        const s = (k === 0 || k === 3) ? -1 : 1, t = (k < 2) ? -1 : 1;
        const px = cx + nx * en + tx * s * cu + bx * t * cv;
        const py = cy + ny * en + ty * s * cu + by * t * cv;
        const pz = cz + nz * en + tz * s * cu + bz * t * cv;
        let u, v;
        if (vert) { u = cell ? (s * cu + eu) * su : s * cu + eu; v = cell ? (py - wy0) / fh : py; }
        else { u = s * cu; v = t * cv; }
        idx.push(this.vert(px, py, pz, nx, ny, nz, u, v, MM));
      }
      this.quadIdx(idx[0], idx[1], idx[2], idx[3]);
    }
    if (e > 0.001) this._bevelEdges(cx, cy, cz, hx, hy, hz, e, M, Mtop, cell, side);
    return this;
  }

  _bevelEdges(cx, cy, cz, hx, hy, hz, e, M, Mtop, cell, side) {
    // 12 chamfer strips + 8 corner triangles
    const sgn = [-1, 1];
    const P = (x, y, z) => new THREE.Vector3(cx + x, cy + y, cz + z);
    // vertical edges (along y)
    for (const sx of sgn) for (const sz of sgn) {
      const a = P(sx * hx, -hy + e, sz * (hz - e)), b = P(sx * (hx - e), -hy + e, sz * hz);
      const c = P(sx * (hx - e), hy - e, sz * hz), d = P(sx * hx, hy - e, sz * (hz - e));
      if (sx * sz > 0) this._strip(b, a, d, c, M); else this._strip(a, b, c, d, M);
    }
    // edges along x
    for (const sy of sgn) for (const sz of sgn) {
      const a = P(-hx + e, sy * hy, sz * (hz - e)), b = P(hx - e, sy * hy, sz * (hz - e));
      const c = P(hx - e, sy * (hy - e), sz * hz), d = P(-hx + e, sy * (hy - e), sz * hz);
      if (sy * sz < 0) this._strip(a, b, c, d, sy > 0 ? Mtop : M); else this._strip(b, a, d, c, sy > 0 ? Mtop : M);
    }
    // edges along z
    for (const sy of sgn) for (const sx of sgn) {
      const a = P(sx * (hx - e), sy * hy, -hz + e), b = P(sx * (hx - e), sy * hy, hz - e);
      const c = P(sx * hx, sy * (hy - e), hz - e), d = P(sx * hx, sy * (hy - e), -hz + e);
      if (sy * sx < 0) this._strip(b, a, d, c, sy > 0 ? Mtop : M); else this._strip(a, b, c, d, sy > 0 ? Mtop : M);
    }
    // corners
    for (const sx of sgn) for (const sy of sgn) for (const sz of sgn) {
      const a = P(sx * hx, sy * (hy - e), sz * (hz - e)), b = P(sx * (hx - e), sy * hy, sz * (hz - e)), c = P(sx * (hx - e), sy * (hy - e), sz * hz);
      const flip = sx * sy * sz < 0;
      if (flip) this.triFlat(a, c, b, null, sy > 0 ? Mtop : M); else this.triFlat(a, b, c, null, sy > 0 ? Mtop : M);
    }
  }
  _strip(a, b, c, d, M) {
    const uvs = [0, a.y, a.distanceTo(b), b.y, a.distanceTo(b), c.y, 0, d.y];
    const Mp = CELL_PATS.has(M.pat) ? { ...M, pat: PAT.PLAIN } : M;
    this.quad(a, b, c, d, uvs, Mp);
  }

  /** Cylinder/cone frustum along +y from y0, radii r0 (bottom) r1 (top). */
  _seg(seg) { return seg >= 16 ? Math.max(12, Math.round(seg * this.segK)) : seg >= 8 ? Math.max(7, Math.round(seg * this.segK)) : seg; }
  cyl(cx, y0, cz, r0, r1, h, seg = 12, caps = true, M = this.M, opt = null) {
    seg = this._seg(seg);
    const cell = CELL_PATS.has(M.pat);
    const circ = Math.PI * (r0 + r1);
    const ncol = cell ? Math.max(3, Math.round(circ / this.win.sx)) : 0;
    const slope = (r0 - r1) / h;
    const base = this.vc;
    const a0 = opt?.a0 ?? 0, a1 = opt?.a1 ?? Math.PI * 2, full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-4;
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (a1 - a0) * i / seg, ca = Math.cos(a), sa = Math.sin(a);
      const nl = Math.hypot(1, slope);
      const u = cell ? ncol * i / seg : circ * i / seg;
      const yv0 = cell ? (y0 - this.win.y0) / this.win.fh : y0, yv1 = cell ? (y0 + h - this.win.y0) / this.win.fh : y0 + h;
      this.vert(cx + ca * r0, y0, cz + sa * r0, ca / nl, slope / nl, sa / nl, u, yv0, M);
      this.vert(cx + ca * r1, y0 + h, cz + sa * r1, ca / nl, slope / nl, sa / nl, u, yv1, M);
    }
    for (let i = 0; i < seg; i++) { const k = base + i * 2; this.quadIdx(k, k + 1, k + 3, k + 2); }
    if (caps && full) {
      const Mc = cell ? { ...M, pat: PAT.PLAIN } : (opt?.cap || M);
      if (r1 > 0.001) this._disc(cx, y0 + h, cz, r1, seg, 1, Mc);
      if (r0 > 0.001 && opt?.bottom !== false) this._disc(cx, y0, cz, r0, seg, -1, Mc);
    }
    return this;
  }
  _disc(cx, y, cz, r, seg, dir, M) {
    const c = this.vert(cx, y, cz, 0, dir, 0, 0, 0, M);
    const base = this.vc;
    for (let i = 0; i <= seg; i++) { const a = i / seg * Math.PI * 2; this.vert(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, 0, dir, 0, Math.cos(a) * r, Math.sin(a) * r, M); }
    for (let i = 0; i < seg; i++) { if (dir > 0) this.tri(c, base + i + 1, base + i); else this.tri(c, base + i, base + i + 1); }
  }

  /** Surface of revolution: pts = [[r, y], ...] bottom → top, smooth normals. */
  lathe(cx, cy, cz, pts, seg = 16, M = this.M, opt = null) {
    seg = this._seg(seg);
    const n = pts.length, base = this.vc;
    const a0 = opt?.a0 ?? 0, a1 = opt?.a1 ?? Math.PI * 2;
    // profile normals
    const pn = [];
    let acc = 0; const vs = [0];
    for (let j = 0; j < n; j++) {
      const p = pts[Math.max(0, j - 1)], q = pts[Math.min(n - 1, j + 1)];
      const dr = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dr, dy) || 1;
      pn.push([dy / l, -dr / l]);
      if (j > 0) { acc += Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]); vs.push(acc); }
    }
    const rmax = Math.max(...pts.map((p) => p[0]));
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (a1 - a0) * i / seg, ca = Math.cos(a), sa = Math.sin(a);
      for (let j = 0; j < n; j++) {
        const [r, y] = pts[j];
        this.vert(cx + ca * r, cy + y, cz + sa * r, ca * pn[j][0], pn[j][1], sa * pn[j][0], (a - a0) * rmax, opt?.vY ? cy + y : vs[j], M);
      }
    }
    for (let i = 0; i < seg; i++) for (let j = 0; j < n - 1; j++) {
      const k = base + i * n + j; this.quadIdx(k, k + 1, k + n + 1, k + n);
    }
    return this;
  }
  sphere(cx, cy, cz, r, seg = 12, rings = 8, M = this.M, top = 1) {
    const pts = [];
    for (let j = 0; j <= rings; j++) { const t = -Math.PI / 2 + (Math.PI / 2 + top * Math.PI / 2) * j / rings; pts.push([Math.cos(t) * r, Math.sin(t) * r]); }
    if (top < 1) pts[0] = [r, pts[0][1]];
    return this.lathe(cx, cy, cz, pts, seg, M);
  }
  dome(cx, cy, cz, r, seg = 16, rings = 6, M = this.M, squash = 1) {
    const pts = [];
    for (let j = 0; j <= rings; j++) { const t = (Math.PI / 2) * j / rings; pts.push([Math.cos(t) * r, Math.sin(t) * r * squash]); }
    return this.lathe(cx, cy, cz, pts, seg, M);
  }

  /** Gable roof along x: base at y0 over w×d footprint, ridge height h, overhang o, slab thickness t. */
  gable(cx, y0, cz, w, d, h, o = 0.4, t = 0.2, M = this.M, Mwall = null) {
    const hx = w / 2 + o, hz = d / 2 + o * 1.2;
    const slope = Math.hypot(hz, h);
    const drop = o * h / (d / 2 || 1);
    const V = (x, y, z) => new THREE.Vector3(cx + x, y, cz + z);
    for (const s of [-1, 1]) {
      const a = V(-hx, y0 - drop, s * hz), b = V(hx, y0 - drop, s * hz), c = V(hx, y0 + h, 0), dd = V(-hx, y0 + h, 0);
      const uv = [0, 0, 2 * hx, 0, 2 * hx, slope, 0, slope];
      if (s > 0) this.quad(a, b, c, dd, uv, M); else this.quad(b, a, dd, c, uv, M);
      // underside
      const a2 = V(-hx, y0 - drop - t, s * hz), b2 = V(hx, y0 - drop - t, s * hz), c2 = V(hx, y0 + h - t, 0), d2 = V(-hx, y0 + h - t, 0);
      if (s > 0) this.quad(b2, a2, d2, c2, null, M); else this.quad(a2, b2, c2, d2, null, M);
      // fascia
      if (s > 0) this.quad(a2, b2, b, a, null, M); else this.quad(b2, a2, a, b, null, M);
      // verge
      for (const e of [-1, 1]) {
        const p = V(e * hx, y0 - drop, s * hz), q = V(e * hx, y0 + h, 0), p2 = V(e * hx, y0 - drop - t, s * hz), q2 = V(e * hx, y0 + h - t, 0);
        if (e * s > 0) this.quad(p, p2, q2, q, null, M); else this.quad(p2, p, q, q2, null, M);
      }
    }
    // gable end walls (triangles)
    if (Mwall) {
      for (const e of [-1, 1]) {
        const a = V(e * w / 2, y0, -d / 2), b = V(e * w / 2, y0, d / 2), c = V(e * w / 2, y0 + h * (d / 2) / (d / 2 + o * 1.2) * 1.0, 0);
        if (e > 0) this.triFlat(a, c, b, [0, y0, d / 2, c.y, d, y0], Mwall); else this.triFlat(a, b, c, [0, y0, d, y0, d / 2, c.y], Mwall);
      }
    }
    return this;
  }

  /** Hip / pyramid roof over w×d at y0, apex height h (ridge length = max(0, w-d)). */
  hip(cx, y0, cz, w, d, h, o = 0.4, M = this.M) {
    const hx = w / 2 + o, hz = d / 2 + o, r = Math.max(0, (w - d) / 2);
    const V = (x, y, z) => new THREE.Vector3(cx + x, y, cz + z);
    const A = V(-hx, y0, -hz), B = V(hx, y0, -hz), C = V(hx, y0, hz), D = V(-hx, y0, hz);
    const R0 = V(-r, y0 + h, 0), R1 = V(r, y0 + h, 0);
    const sl = Math.hypot(hz, h);
    this.quad(D, C, R1, R0, [0, 0, 2 * hx, 0, hx + r, sl, hx - r, sl], M);
    this.quad(B, A, R0, R1, [0, 0, 2 * hx, 0, hx + r, sl, hx - r, sl], M);
    this.triFlat(C, B, R1, [0, 0, 2 * hz, 0, hz, sl], M);
    this.triFlat(A, D, R0, [0, 0, 2 * hz, 0, hz, sl], M);
    // soffit
    this.quad(A, B, C, D, null, M);
    return this;
  }

  /** Extrude a 2D polygon (x,z CCW from above) from y0 to y1 with caps. */
  prism(poly, y0, y1, M = this.M, capTop = true, Mtop = null) {
    const n = poly.length;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % n];
      const l = Math.hypot(x1 - x0, z1 - z0);
      const a = new THREE.Vector3(x0, y0, z0), b = new THREE.Vector3(x1, y0, z1), c = new THREE.Vector3(x1, y1, z1), d = new THREE.Vector3(x0, y1, z0);
      const cell = CELL_PATS.has(M.pat);
      const uv = cell ? (() => { const k = Math.max(1, Math.round(l / this.win.sx)); const v0 = (y0 - this.win.y0) / this.win.fh, v1 = (y1 - this.win.y0) / this.win.fh; return [0, v0, k, v0, k, v1, 0, v1]; })()
        : [acc, y0, acc + l, y0, acc + l, y1, acc, y1];
      this.quad(a, d, c, b, [uv[0], uv[1], uv[6], uv[7], uv[4], uv[5], uv[2], uv[3]], M);
      acc += l;
    }
    if (capTop) {
      const Mt = Mtop || (CELL_PATS.has(M.pat) ? { ...M, pat: PAT.PLAIN } : M);
      const c = this.vert(poly.reduce((s, p) => s + p[0], 0) / n, y1, poly.reduce((s, p) => s + p[1], 0) / n, 0, 1, 0, 0, 0, Mt);
      const base = this.vc;
      for (let i = 0; i < n; i++) this.vert(poly[i][0], y1, poly[i][1], 0, 1, 0, poly[i][0], poly[i][1], Mt);
      for (let i = 0; i < n; i++) this.tri(c, base + (i + 1) % n, base + i);
    }
    return this;
  }

  /** Tube along a polyline of Vector3 (current frame), radius r (number or fn(t)). */
  tube(path, r, seg = 6, M = this.M, closed = false) {
    if (this.segK < 0.8 && seg > 4) seg = Math.max(4, Math.round(seg * this.segK));
    const n = path.length; if (n < 2) return this;
    const base = this.vc;
    const T = new THREE.Vector3(), Nn = new THREE.Vector3(), B = new THREE.Vector3(), prevN = new THREE.Vector3();
    let len = 0;
    for (let i = 0; i < n; i++) {
      const p = path[i];
      if (i < n - 1) T.subVectors(path[i + 1], p); else T.subVectors(p, path[i - 1]);
      if (i > 0 && i < n - 1) T.normalize().add(_c.subVectors(p, path[i - 1]).normalize());
      T.normalize();
      if (i === 0) { Nn.set(0, 1, 0); if (Math.abs(T.y) > 0.9) Nn.set(1, 0, 0); }
      else Nn.copy(prevN);
      B.crossVectors(T, Nn).normalize(); Nn.crossVectors(B, T).normalize(); prevN.copy(Nn);
      if (i > 0) len += p.distanceTo(path[i - 1]);
      const rr = typeof r === 'function' ? r(i / (n - 1)) : r;
      for (let k = 0; k <= seg; k++) {
        const a = k / seg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const nx = Nn.x * ca + B.x * sa, ny = Nn.y * ca + B.y * sa, nz = Nn.z * ca + B.z * sa;
        this.vert(p.x + nx * rr, p.y + ny * rr, p.z + nz * rr, nx, ny, nz, k / seg * rr * 6.28, len, M);
      }
    }
    for (let i = 0; i < n - 1; i++) for (let k = 0; k < seg; k++) {
      const a = base + i * (seg + 1) + k, b = a + seg + 1; this.quadIdx(a, a + 1, b + 1, b);
    }
    return this;
  }

  /** Flat double-sided-ish panel (sign / blade): centred at (cx,cy,cz) facing +z, w×h, thickness t. */
  panel(cx, cy, cz, w, h, t, M, Mback = null) {
    this.box(cx, cy - h / 2, cz, w, h, t, 0, Mback || M);
    const V = (x, y, z) => new THREE.Vector3(cx + x, cy + y, cz + z);
    const z = t / 2 + 0.02;
    this.quad(V(-w / 2, -h / 2, z), V(w / 2, -h / 2, z), V(w / 2, h / 2, z), V(-w / 2, h / 2, z), [0, 0, 1, 0, 1, 1, 0, 1], M);
    return this;
  }

  /** Mesh-local triangle soup from raw arrays (used by kits for special shapes). */
  get count() { return this.vc; }

  build() {
    if (this.vc === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.P.view(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.N.view(), 3));
    g.setAttribute('aUv', new THREE.BufferAttribute(this.U.view(), 2));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.C.view(), 3, true));
    g.setAttribute('aMat', new THREE.BufferAttribute(this.Mt.view(), 4, false));
    g.setAttribute('aAux', new THREE.BufferAttribute(this.X.view(), 2));
    g.setIndex(new THREE.BufferAttribute(this.I.view(), 1));
    g.computeBoundingSphere();
    return g;
  }
}
