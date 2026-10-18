// Player track — procedural hard-surface / soft-body modelling toolkit.
//
//   loft(sections, opts)        superellipse tube along +Y (limbs, torso, neck) — full loop, seam-safe normals
//   loftSurface(sections)       S(a, y, out) evaluator for plates on a loft body
//   ellipsoidSurface(c, r, fn)  S(az, el, out) evaluator for helmet/visor patches
//   patch(S, opts)              armor plate on any surface: offset, squircle outline, beveled lip, optional back
//   ellipsoid / lathe / box / torus / tube helpers (rest-pose character space)
//   Assembler                   collects parts per material slot, assigns skin weights + vertex colors,
//                               merges into one SkinnedMesh per slot (few draw calls).
//
// Conventions: character rest pose, meters, +Y up, +Z forward (front), +X = character's left.
// Loft angle a: a = 0 → front (+Z), a = +π/2 → left (+X), a = π → back.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

const TAU = Math.PI * 2;
const spow = (v, p) => (v < 0 ? -Math.pow(-v, p) : Math.pow(v, p));
const KEYS = ['y', 'rx', 'rz', 'ox', 'oz', 'e', 'fz', 'bz'];

function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function norm(s) { return { y: s.y, rx: s.rx, rz: s.rz ?? s.rx, ox: s.ox ?? 0, oz: s.oz ?? 0, e: s.e ?? 2, fz: s.fz ?? 0, bz: s.bz ?? 0 }; }

/** Section at height y (Catmull-Rom across the section list, which must be sorted by y). */
export function sectionAt(secs, y, out = {}) {
  const n = secs.length;
  if (y <= secs[0].y) { Object.assign(out, secs[0]); out.y = y; return out; }
  if (y >= secs[n - 1].y) { Object.assign(out, secs[n - 1]); out.y = y; return out; }
  let i = 0;
  while (i < n - 2 && y > secs[i + 1].y) i++;
  const s0 = secs[Math.max(0, i - 1)], s1 = secs[i], s2 = secs[i + 1], s3 = secs[Math.min(n - 1, i + 2)];
  const t = (y - s1.y) / (s2.y - s1.y);
  for (const k of KEYS) out[k] = k === 'y' ? y : cr(s0[k], s1[k], s2[k], s3[k], t);
  return out;
}

function sePoint(s, a, out) {
  const sa = Math.sin(a), ca = Math.cos(a), p = 2 / Math.max(0.6, s.e);
  let z = s.oz + s.rz * spow(ca, p);
  if (ca > 0) z += s.fz * ca * ca; else z -= s.bz * ca * ca;
  return out.set(s.ox + s.rx * spow(sa, p), s.y, z);
}

/** Surface evaluator for a loft: S(a, y, out). */
export function loftSurface(sections) {
  const secs = sections.map(norm);
  const tmp = {};
  const S = (a, y, out) => sePoint(sectionAt(secs, y, tmp), a, out);
  S.inside = (a, y, out) => { const s = sectionAt(secs, y, tmp); return out.set(s.ox, y, s.oz); };
  S.secs = secs;
  return S;
}

/** Full tube along +Y through sections. Returns indexed geometry with position/normal/uv/uv1. */
export function loft(sections, { radial = 24, rings = 0, sub = 3, closeBottom = false, closeTop = false, ripple = null } = {}) {
  const secs = sections.map(norm);
  const y0 = secs[0].y, y1 = secs[secs.length - 1].y;
  const nr = rings || Math.max(2, (secs.length - 1) * sub);
  const pos = [], uv = [], uv1 = [];
  const s = {}, p = new THREE.Vector3(), q = new THREE.Vector3();
  let vAcc = 0; let prevMid = null;
  for (let j = 0; j <= nr; j++) {
    const y = y0 + (y1 - y0) * (j / nr);
    sectionAt(secs, y, s);
    if (ripple) { const k = ripple(y); s.rx *= k; s.rz *= k; }
    // perimeter for uv1
    let per = 0; sePoint(s, 0, q);
    for (let i = 1; i <= radial; i++) { sePoint(s, (i / radial) * TAU, p); per += p.distanceTo(q); q.copy(p); }
    sePoint(s, Math.PI / 2, p);
    if (prevMid) vAcc += Math.hypot(p.x - prevMid.x, p.y - prevMid.y, p.z - prevMid.z);
    prevMid = p.clone();
    let uAcc = 0; sePoint(s, 0, q);
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * TAU;
      sePoint(s, a, p);
      if (i > 0) uAcc += p.distanceTo(q);
      q.copy(p);
      pos.push(p.x, p.y, p.z);
      uv.push(i / radial, j / nr);
      uv1.push(uAcc, vAcc);
    }
  }
  const idx = [];
  const W = radial + 1;
  for (let j = 0; j < nr; j++) for (let i = 0; i < radial; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const addCap = (j, top) => {
    sectionAt(secs, j === 0 ? y0 : y1, s);
    const ci = pos.length / 3;
    pos.push(s.ox, j === 0 ? y0 : y1, s.oz); uv.push(0.5, j === 0 ? 0 : 1); uv1.push(0, j === 0 ? 0 : vAcc);
    for (let i = 0; i < radial; i++) {
      const a = j * W + i, b = a + 1;
      if (top) idx.push(a, b, ci); else idx.push(b, a, ci);
    }
  };
  if (closeBottom) addCap(0, false);
  if (closeTop) addCap(nr, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // seam: average normals of first/last column
  const n = g.attributes.normal;
  for (let j = 0; j <= nr; j++) {
    const a = j * W, b = j * W + radial;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

/** Surface evaluator on an ellipsoid (az around +Y from +Z toward +X, el from equator). fn may deform. */
export function ellipsoidSurface(center, radii, deform = null) {
  const S = (az, el, out) => {
    const ce = Math.cos(el);
    out.set(Math.sin(az) * ce * radii.x, Math.sin(el) * radii.y, Math.cos(az) * ce * radii.z);
    if (deform) deform(out, az, el);
    return out.add(center);
  };
  S.inside = (az, el, out) => out.copy(center);
  return S;
}

/**
 * Plate/patch on surface S(u, v). Squircle outline, offset `off` along the surface normal, beveled lip of
 * depth `thick`. `uvRect` = [u0, v0, u1, v1] target in the panel atlas. Returns indexed geometry.
 * `taper(t)` → [u0, u1] per row (t 0..1 along v) for trapezoid plates; `bulge` puffs the center outward.
 */
export function patch(S, {
  u0, u1, v0, v1, nu = 12, nv = 12, off = 0.006, thick = 0.012, bevel = 0.006, round = 6, back = false,
  uvRect = [0.25, 0.25, 0.25, 0.25], taper = null, bulge = 0,
} = {}) {
  const P = new THREE.Vector3(), Pu = new THREE.Vector3(), Pv = new THREE.Vector3(), N = new THREE.Vector3(), C = new THREE.Vector3();
  const du = (u1 - u0) * 1e-3 || 1e-4, dv = (v1 - v0) * 1e-3 || 1e-4;
  const pos = [], nor = [], uv = [], uv1 = [];
  const W = nu + 1;
  const sq = (s, t) => {
    if (!round) return [s, t];
    const l = Math.hypot(s, t);
    if (l < 1e-9) return [0, 0];
    const m = Math.max(Math.abs(s), Math.abs(t));
    const cs = Math.abs(s) / l, ct = Math.abs(t) / l;
    const rho = Math.pow(Math.pow(cs, round) + Math.pow(ct, round), -1 / round);
    const k = (m * rho) / l;
    return [s * k, t * k];
  };
  const uvOf = (s, t) => {
    let u = u0 + (u1 - u0) * (s + 1) / 2;
    const v = v0 + (v1 - v0) * (t + 1) / 2;
    if (taper) { const [a, b] = taper((t + 1) / 2); u = a + (b - a) * (s + 1) / 2; }
    return [u, v];
  };
  // orientation: does Pu x Pv point outward (away from S.inside)?
  let orient = 1;
  {
    const [u, v] = uvOf(0, 0);
    S(u, v, P); S(u + du, v, Pu); S(u, v + dv, Pv); Pu.sub(P); Pv.sub(P);
    N.crossVectors(Pu, Pv); S.inside(u, v, C);
    if (N.dot(C.sub(P)) > 0) orient = -1;
  }
  const evalAt = (s, t, outP, outN) => {
    const [u, v] = uvOf(s, t);
    S(u, v, outP); S(u + du, v, Pu); S(u, v + dv, Pv);
    Pu.sub(outP); Pv.sub(outP);
    outN.crossVectors(Pu, Pv).normalize().multiplyScalar(orient);
    const bl = bulge * (1 - s * s) * (1 - t * t);
    outP.addScaledVector(outN, off + bl);
    return outP;
  };
  let rowLen = 0, colLen = 0;
  { const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
    evalAt(-1, 0, a, n); evalAt(1, 0, b, n); rowLen = a.distanceTo(b);
    evalAt(0, -1, a, n); evalAt(0, 1, b, n); colLen = a.distanceTo(b); }
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const [s, t] = sq(-1 + 2 * i / nu, -1 + 2 * j / nv);
    evalAt(s, t, P, N);
    pos.push(P.x, P.y, P.z); nor.push(N.x, N.y, N.z);
    const us = (s + 1) / 2, vt = (t + 1) / 2;
    uv.push(uvRect[0] + (uvRect[2] - uvRect[0]) * us, uvRect[1] + (uvRect[3] - uvRect[1]) * vt);
    uv1.push(us * rowLen, vt * colLen);
  }
  const idx = [];
  const tri = (a, b, c) => { if (orient > 0) idx.push(a, b, c); else idx.push(a, c, b); };
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    tri(a, b, c); tri(b, d, c);
  }
  // boundary loop, CCW in (s, t)
  const loop = [];
  for (let i = 0; i < nu; i++) loop.push(i);
  for (let j = 0; j < nv; j++) loop.push(j * W + nu);
  for (let i = nu; i > 0; i--) loop.push(nv * W + i);
  for (let j = nv; j > 0; j--) loop.push(j * W);
  const L = loop.length;
  const tN = new THREE.Vector3(), tO = new THREE.Vector3(), pa = new THREE.Vector3(), pb = new THREE.Vector3(), bn = new THREE.Vector3();
  const ringStart = pos.length / 3;
  const rings = [[0.55, 0.42], [0.85, 1.0]]; // [outward fraction of bevel, depth fraction of thick]
  for (let r = 0; r < rings.length; r++) {
    for (let k = 0; k < L; k++) {
      const vi = loop[k];
      const px = pos[vi * 3], py = pos[vi * 3 + 1], pz = pos[vi * 3 + 2];
      tN.set(nor[vi * 3], nor[vi * 3 + 1], nor[vi * 3 + 2]);
      const vp = loop[(k - 1 + L) % L], vn = loop[(k + 1) % L];
      pa.set(pos[vp * 3], pos[vp * 3 + 1], pos[vp * 3 + 2]);
      pb.set(pos[vn * 3], pos[vn * 3 + 1], pos[vn * 3 + 2]);
      // CCW loop tangent x (Pu x Pv) points outward; N = orient * (Pu x Pv)
      tO.copy(pb).sub(pa).cross(tN).multiplyScalar(orient).normalize();
      const [fo, fd] = rings[r];
      pos.push(px + tO.x * bevel * fo - tN.x * thick * fd, py + tO.y * bevel * fo - tN.y * thick * fd, pz + tO.z * bevel * fo - tN.z * thick * fd);
      if (r === 0) bn.copy(tO).multiplyScalar(0.8).addScaledVector(tN, 0.6).normalize();
      else bn.copy(tO).addScaledVector(tN, -0.15).normalize();
      nor.push(bn.x, bn.y, bn.z);
      uv.push(uv[vi * 2], uv[vi * 2 + 1]);
      uv1.push(uv1[vi * 2], uv1[vi * 2 + 1]);
    }
  }
  // bevel faces: loop → ring0 → ring1 (outer side faces outward)
  for (let k = 0; k < L; k++) {
    const k2 = (k + 1) % L;
    const a0 = loop[k], a1 = loop[k2];
    const b0 = ringStart + k, b1 = ringStart + k2;
    const c0 = ringStart + L + k, c1 = ringStart + L + k2;
    tri(a0, b0, a1); tri(a1, b0, b1);
    tri(b0, c0, b1); tri(b1, c0, c1);
  }
  if (back) {
    const bs = pos.length / 3;
    const n0 = (nv + 1) * W;
    for (let v = 0; v < n0; v++) {
      pos.push(pos[v * 3] - nor[v * 3] * thick, pos[v * 3 + 1] - nor[v * 3 + 1] * thick, pos[v * 3 + 2] - nor[v * 3 + 2] * thick);
      nor.push(-nor[v * 3], -nor[v * 3 + 1], -nor[v * 3 + 2]);
      uv.push(0.25, 0.25); uv1.push(uv1[v * 2], uv1[v * 2 + 1]);
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = bs + j * W + i, b = a + 1, c = a + W, d = c + 1;
      tri(a, c, b); tri(b, c, d);
    }
    for (let k = 0; k < L; k++) {
      const k2 = (k + 1) % L;
      const c0 = ringStart + L + k, c1 = ringStart + L + k2;
      const d0 = bs + loop[k], d1 = bs + loop[k2];
      tri(c0, d0, c1); tri(c1, d0, d1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
  g.setIndex(idx);
  return g;
}

/** Atlas quadrant rect for the panel normal map (q: 0..3), with a margin. */
export function quad(q, m = 0.004) {
  const x = (q & 1) * 0.5, y = (q >> 1) * 0.5;
  return [x + m, y + m, x + 0.5 - m, y + 0.5 - m];
}

// ------------------------------------------------------------------ simple solids (all get uv + uv1)
function addUv1(g, scale = 1) {
  if (!g.attributes.uv) {
    const n = g.attributes.position.count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2).fill(0.5), 2));
  }
  if (!g.attributes.uv1) {
    const p = g.attributes.position, n = p.count, a = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { a[i * 2] = (p.getX(i) + p.getZ(i)) * scale; a[i * 2 + 1] = p.getY(i) * scale; }
    g.setAttribute('uv1', new THREE.BufferAttribute(a, 2));
  }
  return g;
}
/** Neutralize panel uv (center of quadrant 0 → flat normal) for parts that shouldn't get panel grooves. */
export function flatUv(g) {
  const n = g.attributes.position.count;
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2).fill(0.25), 2));
  return g;
}

export function ellipsoid(rx, ry, rz, ws = 20, hs = 14, { deform = null, e = 2 } = {}) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    if (e !== 2) { const k = 2 / e; v.set(spow(v.x, k), spow(v.y, k), spow(v.z, k)); }
    v.set(v.x * rx, v.y * ry, v.z * rz);
    if (deform) deform(v);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  flatUv(g);
  return addUv1(g);
}
export function box(w, h, d, r = 0.01, segs = 2) {
  const g = new RoundedBoxGeometry(w, h, d, segs, Math.min(r, Math.min(w, h, d) * 0.49));
  flatUv(g);
  return addUv1(g);
}
/** Lathe around +Y. profile: [[r, y], ...] bottom → top. */
export function lathe(profile, segs = 20, phiStart = 0, phiLen = TAU) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
  const g = new THREE.LatheGeometry(pts, segs, phiStart, phiLen);
  flatUv(g);
  return addUv1(g);
}
export function torus(R, r, rs = 8, ts = 24, arc = TAU) {
  const g = new THREE.TorusGeometry(R, r, rs, ts, arc);
  flatUv(g);
  return addUv1(g);
}
export function cylinder(rt, rb, h, rs = 12, open = false) {
  const g = new THREE.CylinderGeometry(rt, rb, h, rs, 1, open);
  flatUv(g);
  return addUv1(g);
}
export function tube(points, radius, segs = 24, rs = 6, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.5);
  const g = new THREE.TubeGeometry(curve, segs, radius, rs, closed);
  flatUv(g);
  return addUv1(g);
}

const _m = new THREE.Matrix4(), _qq = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _t = new THREE.Vector3();
/** Transform a geometry in place: translate (x,y,z), rotate (Euler rx,ry,rz), scale (sx,sy,sz). */
export function xf(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz); _qq.setFromEuler(_e);
  _m.compose(_t.set(x, y, z), _qq, _s.set(sx, sy, sz));
  g.applyMatrix4(_m);
  return g;
}
/** Mirror geometry across X (character left ↔ right), fixing winding. */
export function mirrorX(g) {
  const c = g.clone();
  c.applyMatrix4(_m.makeScale(-1, 1, 1));
  const idx = c.index;
  if (idx) { for (let i = 0; i < idx.count; i += 3) { const b = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, b); } }
  return c;
}

// ------------------------------------------------------------------ assembler
/** Skin helpers: return a function (x,y,z,out[4]) → [i0,w0,i1,w1]. */
export const rigid = (b) => (x, y, z, o) => { o[0] = b; o[1] = 1; o[2] = b; o[3] = 0; return o; };
/** blend between bone lo (below y0) and hi (above y1) along Y. */
export const blendY = (lo, hi, y0, y1) => (x, y, z, o) => {
  let t = (y - y0) / (y1 - y0); t = t < 0 ? 0 : t > 1 ? 1 : t; t = t * t * (3 - 2 * t);
  o[0] = lo; o[1] = 1 - t; o[2] = hi; o[3] = t; return o;
};
/** Piecewise bands along Y: [[bone, y], ...] ascending; linear blend between consecutive centers. */
export const bandsY = (bands) => (x, y, z, o) => {
  if (y <= bands[0][1]) { o[0] = bands[0][0]; o[1] = 1; o[2] = bands[0][0]; o[3] = 0; return o; }
  for (let i = 0; i < bands.length - 1; i++) {
    const [b0, y0] = bands[i], [b1, y1] = bands[i + 1];
    if (y <= y1) { let t = (y - y0) / (y1 - y0); t = t * t * (3 - 2 * t); o[0] = b0; o[1] = 1 - t; o[2] = b1; o[3] = t; return o; }
  }
  const l = bands[bands.length - 1][0]; o[0] = l; o[1] = 1; o[2] = l; o[3] = 0; return o;
};

export class Assembler {
  constructor() { this.slots = new Map(); this.tris = 0; }
  /** Add geometry to a material slot with a vertex color (THREE.Color/hex) and a skin function. */
  add(slot, geo, color, skin, { mask = 0 } = {}) {
    if (!this.slots.has(slot)) this.slots.set(slot, []);
    this.slots.get(slot).push({ geo, color: color instanceof THREE.Color ? color : new THREE.Color(color), skin, mask });
    return geo;
  }
  build() {
    const out = new Map();
    const w = [0, 0, 0, 0];
    for (const [slot, parts] of this.slots) {
      let nv = 0, ni = 0;
      for (const p of parts) { nv += p.geo.attributes.position.count; ni += p.geo.index ? p.geo.index.count : p.geo.attributes.position.count; }
      const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), UV = new Float32Array(nv * 2), UV1 = new Float32Array(nv * 2);
      const C = new Float32Array(nv * 3), SI = new Uint16Array(nv * 4), SW = new Float32Array(nv * 4);
      const I = new Uint32Array(ni);
      let vo = 0, io = 0;
      for (const p of parts) {
        const g = p.geo;
        if (!g.attributes.normal) g.computeVertexNormals();
        const pa = g.attributes.position, na = g.attributes.normal, ua = g.attributes.uv, u1 = g.attributes.uv1;
        const n = pa.count;
        for (let i = 0; i < n; i++) {
          const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
          P[(vo + i) * 3] = x; P[(vo + i) * 3 + 1] = y; P[(vo + i) * 3 + 2] = z;
          N[(vo + i) * 3] = na.getX(i); N[(vo + i) * 3 + 1] = na.getY(i); N[(vo + i) * 3 + 2] = na.getZ(i);
          UV[(vo + i) * 2] = ua ? ua.getX(i) : 0.25; UV[(vo + i) * 2 + 1] = ua ? ua.getY(i) : 0.25;
          UV1[(vo + i) * 2] = u1 ? u1.getX(i) : 0; UV1[(vo + i) * 2 + 1] = u1 ? u1.getY(i) : 0;
          C[(vo + i) * 3] = p.color.r; C[(vo + i) * 3 + 1] = p.color.g; C[(vo + i) * 3 + 2] = p.color.b;
          p.skin(x, y, z, w);
          SI[(vo + i) * 4] = w[0]; SW[(vo + i) * 4] = w[1];
          SI[(vo + i) * 4 + 1] = w[2]; SW[(vo + i) * 4 + 1] = w[3];
        }
        if (g.index) { const ia = g.index; for (let k = 0; k < ia.count; k++) I[io + k] = ia.getX(k) + vo; io += ia.count; }
        else { for (let k = 0; k < n; k++) I[io + k] = k + vo; io += n; }
        vo += n;
        g.dispose();
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
      geo.setAttribute('uv1', new THREE.BufferAttribute(UV1, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(SI, 4));
      geo.setAttribute('skinWeight', new THREE.BufferAttribute(SW, 4));
      geo.setIndex(new THREE.BufferAttribute(I, 1));
      geo.computeBoundingSphere();
      this.tris += ni / 3;
      out.set(slot, geo);
    }
    return out;
  }
}
