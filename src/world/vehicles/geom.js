// Procedural hard-surface modeling toolkit for vehicles.
//   Builder      accumulates parts (geometry + surface preset + color) → ONE merged mesh per material
//   loft()       smooth hull from superellipse cross-sections (Catmull-Rom between sections) with an
//                evaluator for conformal decals and greebles
//   rbox/bcyl/extrude/tube/lathe helpers with bevels & creased normals (no faceted look)
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { SURF } from './materials.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _c = new THREE.Color();

/** Compose a transform matrix: position [x,y,z], rotation euler [x,y,z] (radians), scale number|[x,y,z]. */
export function T(pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
  const m = new THREE.Matrix4();
  _q.setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'YXZ'));
  if (Array.isArray(scale)) _s.set(scale[0], scale[1], scale[2]); else _s.set(scale, scale, scale);
  return m.compose(_p.set(pos[0], pos[1], pos[2]), _q, _s);
}

function ensureIndex(g) {
  if (g.index) return g;
  const n = g.attributes.position.count;
  const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
function flipWinding(g) {
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  g.index.needsUpdate = true;
}

/** Strip to position/normal (+uv) and bake per-part attributes. */
function prep(geo, matrix, surf, color, extra) {
  let g = geo.index ? geo.clone() : geo.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.morphAttributes = {};
  g.clearGroups();
  ensureIndex(g);
  if (matrix) {
    g.applyMatrix4(matrix);
    if (matrix.determinant() < 0) flipWinding(g);
  }
  const n = g.attributes.position.count;
  if (surf) {
    const S = typeof surf === 'string' ? SURF[surf] : surf;
    const col = new Float32Array(n * 3), a1 = new Float32Array(n * 4), a2 = new Float32Array(n * 4);
    _c.set(color ?? 0xffffff);
    for (let i = 0; i < n; i++) {
      col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
      a1[i * 4] = S.r; a1[i * 4 + 1] = S.m; a1[i * 4 + 2] = S.p; a1[i * 4 + 3] = S.cc;
      a2[i * 4] = S.w; a2[i * 4 + 1] = S.d; a2[i * 4 + 2] = S.e; a2[i * 4 + 3] = S.ru;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSurf', new THREE.BufferAttribute(a1, 4));
    g.setAttribute('aSurf2', new THREE.BufferAttribute(a2, 4));
  }
  if (extra) extra(g, n);
  return g;
}

export class Builder {
  constructor() { this.parts = []; this.glows = []; this.decals = []; this.tris = 0; }

  /** Add a part. surf = SURF key or object; color = hex/Color. */
  add(geo, surf, color, matrix) { this.parts.push(prep(geo, matrix, surf, color)); return this; }
  /** Add the part and its mirror across X = 0. */
  addSym(geo, surf, color, matrix) {
    this.add(geo, surf, color, matrix);
    const mm = new THREE.Matrix4().makeScale(-1, 1, 1).multiply(matrix || new THREE.Matrix4());
    this.add(geo, surf, color, mm);
    return this;
  }
  /** Emissive part: HDR color [r,g,b] (linear, may exceed 1), channel 0..7. */
  glow(geo, rgb, channel = 0, matrix) {
    const g = prep(geo, matrix, null, null, (gg, n) => {
      const col = new Float32Array(n * 3), ch = new Float32Array(n);
      for (let i = 0; i < n; i++) { col[i * 3] = rgb[0]; col[i * 3 + 1] = rgb[1]; col[i * 3 + 2] = rgb[2]; ch[i] = channel; }
      gg.setAttribute('color', new THREE.BufferAttribute(col, 3));
      gg.setAttribute('aCh', new THREE.BufferAttribute(ch, 1));
    });
    this.glows.push(g);
    return this;
  }
  glowSym(geo, rgb, channel, matrix) {
    this.glow(geo, rgb, channel, matrix);
    this.glow(geo, rgb, channel, new THREE.Matrix4().makeScale(-1, 1, 1).multiply(matrix || new THREE.Matrix4()));
    return this;
  }
  /** Mirror-aware glow with separate colors for left (-X) and right (+X), e.g. nav lights. */
  glowPair(geo, rgbRight, rgbLeft, channel, matrix) {
    this.glow(geo, rgbRight, channel, matrix);
    this.glow(geo, rgbLeft, channel, new THREE.Matrix4().makeScale(-1, 1, 1).multiply(matrix || new THREE.Matrix4()));
    return this;
  }

  /**
   * Flat decal quad. cell = atlas cell 0..15, center/normal/up are Vector3-like arrays (object space),
   * size = [w, h] meters, color tint, sub = [u0, v0, u1, v1] fraction of the cell.
   */
  decal(cell, center, normal, up, size, color = 0xffffff, sub = [0, 0, 1, 1], mirror = false) {
    const n = new THREE.Vector3(...normal).normalize();
    const u0 = new THREE.Vector3(...up);
    const r = new THREE.Vector3().crossVectors(u0, n).normalize();
    const u = new THREE.Vector3().crossVectors(n, r).normalize();
    const c = new THREE.Vector3(...center).addScaledVector(n, 0.004);
    const hw = size[0] / 2, hh = size[1] / 2;
    const cx = (cell % 4) / 4, cy = Math.floor(cell / 4) / 4;
    const U = (f) => cx + (sub[0] + (sub[2] - sub[0]) * f) / 4;
    const V = (f) => 1 - (cy + (sub[1] + (sub[3] - sub[1]) * (1 - f)) / 4);
    const pts = [[-hw, -hh, 0, 0], [hw, -hh, 1, 0], [hw, hh, 1, 1], [-hw, hh, 0, 1]];
    const pos = [], nor = [], uv = [], col = [];
    _c.set(color);
    for (const [x, y, fu, fv] of pts) {
      const p = c.clone().addScaledVector(r, x).addScaledVector(u, y);
      pos.push(p.x, p.y, p.z); nor.push(n.x, n.y, n.z); uv.push(U(fu), V(fv)); col.push(_c.r, _c.g, _c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.decals.push(g);
    if (mirror) {
      // mirrored copy on -X that still reads correctly (not mirrored text): flip the right axis
      const g2 = g.clone();
      const p = g2.attributes.position, nn = g2.attributes.normal, t = g2.attributes.uv;
      for (let i = 0; i < 4; i++) { p.setX(i, -p.getX(i)); nn.setX(i, -nn.getX(i)); }
      // swap u so text stays readable, keep winding front-facing
      const us = [t.getX(1), t.getX(0), t.getX(3), t.getX(2)];
      for (let i = 0; i < 4; i++) t.setX(i, us[i]);
      g2.setIndex([0, 2, 1, 0, 3, 2]);
      this.decals.push(g2);
    }
    return this;
  }
  /** Conformal decal on a loft surface patch (t0..t1 along, a0..a1 around). */
  decalPatch(lft, cell, t0, t1, a0, a1, color = 0xffffff, sub = [0, 0, 1, 1], seg = [6, 4], offset = 0.004, flipU = false) {
    const [nu, nv] = seg;
    const pos = [], nor = [], uv = [], col = [], idx = [];
    const P = new THREE.Vector3(), N = new THREE.Vector3();
    _c.set(color);
    const cx = (cell % 4) / 4, cy = Math.floor(cell / 4) / 4;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const fu = i / nu, fv = j / nv;
      lft.evaluate(t0 + (t1 - t0) * fu, a0 + (a1 - a0) * fv, P, N);
      P.addScaledVector(N, offset);
      pos.push(P.x, P.y, P.z); nor.push(N.x, N.y, N.z);
      const uu = flipU ? 1 - fu : fu;
      uv.push(cx + (sub[0] + (sub[2] - sub[0]) * uu) / 4, 1 - (cy + (sub[1] + (sub[3] - sub[1]) * (1 - fv)) / 4));
      col.push(_c.r, _c.g, _c.b);
    }
    // winding: u runs along the loft (+Z), v around it; decide front face from the actual geometry
    const pa = new THREE.Vector3(pos[0], pos[1], pos[2]);
    const pb = new THREE.Vector3(pos[3], pos[4], pos[5]);
    const pc = new THREE.Vector3(pos[(nu + 1) * 3], pos[(nu + 1) * 3 + 1], pos[(nu + 1) * 3 + 2]);
    const fn = new THREE.Vector3().crossVectors(pb.sub(pa), pc.sub(pa));
    const outward = fn.dot(new THREE.Vector3(nor[0], nor[1], nor[2])) > 0;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c2 = a + nu + 1, d = c2 + 1;
      if (outward) idx.push(a, b, d, a, d, c2); else idx.push(a, d, b, a, c2, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    this.decals.push(g);
    return this;
  }

  _merge(list) {
    if (!list.length) return null;
    const g = mergeGeometries(list, false);
    if (!g) return null;
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
  /** Build meshes. Returns { body, glow, decals } (any may be null). */
  build(mats, { castShadow = true, receiveShadow = true, name = 'vehicle' } = {}) {
    const out = {};
    const bg = this._merge(this.parts);
    if (bg) { out.body = new THREE.Mesh(bg, mats.body); out.body.castShadow = castShadow; out.body.receiveShadow = receiveShadow; out.body.name = name + '-body'; this.tris += (bg.index ? bg.index.count : bg.attributes.position.count) / 3; }
    const gg = this._merge(this.glows);
    if (gg && mats.glow) { out.glow = new THREE.Mesh(gg, mats.glow); out.glow.name = name + '-glow'; }
    const dg = this._merge(this.decals.map((g) => { for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k); return g; }));
    if (dg && mats.decal) { out.decals = new THREE.Mesh(dg, mats.decal); out.decals.name = name + '-decals'; out.decals.renderOrder = 2; out.decals.receiveShadow = true; }
    for (const g of [...this.parts, ...this.glows, ...this.decals]) g.dispose();
    this.parts = []; this.glows = []; this.decals = [];
    return out;
  }
}

// ------------------------------------------------------------------ primitives
export function rbox(w, h, d, r = 0.02, seg = 2) {
  const rr = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  if (rr <= 0.0005) return new THREE.BoxGeometry(w, h, d);
  return new RoundedBoxGeometry(w, h, d, seg, rr);
}

/** Beveled cylinder along Y (lathe with rounded rims). */
export function bcyl(r, h, bevel = 0.01, seg = 24, rTop = r) {
  const b = Math.min(bevel, r * 0.45, rTop * 0.45, h * 0.45);
  const hh = h / 2;
  const pts = [];
  pts.push(new THREE.Vector2(0.0001, -hh));
  if (b > 0.0005) {
    pts.push(new THREE.Vector2(r - b, -hh));
    pts.push(new THREE.Vector2(r - b * 0.3, -hh + b * 0.3));
    pts.push(new THREE.Vector2(r, -hh + b));
    pts.push(new THREE.Vector2(rTop, hh - b));
    pts.push(new THREE.Vector2(rTop - b * 0.3, hh - b * 0.3));
    pts.push(new THREE.Vector2(rTop - b, hh));
  } else {
    pts.push(new THREE.Vector2(r, -hh)); pts.push(new THREE.Vector2(r, -hh)); pts.push(new THREE.Vector2(rTop, hh)); pts.push(new THREE.Vector2(rTop, hh));
  }
  pts.push(new THREE.Vector2(0.0001, hh));
  return new THREE.LatheGeometry(pts, seg);
}

/** Lathe from [[r, y], ...] (around Y). */
export function lathe(profile, seg = 32) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y)), seg);
}

/** Extrude a 2D outline (in XY) along Z, centered, with smooth bevels. */
export function extrude(pts, depth, bevel = 0.01, { bevelSeg = 3, curveSeg = 12, crease = 35 } = {}) {
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const b = Math.max(0, bevel);
  let g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.0005, depth - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b * 0.9,
    bevelSegments: bevelSeg, curveSegments: curveSeg, steps: 1,
  });
  g.translate(0, 0, -(depth - 2 * b) / 2);
  g.deleteAttribute('uv');
  g = toCreasedNormals(g, (crease * Math.PI) / 180);
  return g;
}
/** Extrude a shape with holes: outer [[x,y]], holes [[[x,y]...]]. */
export function extrudeHoles(outer, holes, depth, bevel = 0.01, opts = {}) {
  const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  const b = bevel;
  let g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.0005, depth - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b * 0.9,
    bevelSegments: opts.bevelSeg ?? 2, curveSegments: opts.curveSeg ?? 12, steps: 1,
  });
  g.translate(0, 0, -(depth - 2 * b) / 2);
  g.deleteAttribute('uv');
  return toCreasedNormals(g, ((opts.crease ?? 35) * Math.PI) / 180);
}

/** Tube through points [[x,y,z]...]. */
export function tube(points, r, seg = 24, radial = 10, closed = false, tension = 0.5) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), closed, 'catmullrom', tension);
  return new THREE.TubeGeometry(curve, seg, r, radial, closed);
}

/** Rounded-rect outline points (for extrusions). */
export function roundRect(w, h, r, seg = 4) {
  const pts = [];
  const hw = w / 2, hh = h / 2;
  r = Math.min(r, hw, hh);
  const corners = [[hw - r, hh - r, 0], [-hw + r, hh - r, Math.PI / 2], [-hw + r, -hh + r, Math.PI], [hw - r, -hh + r, Math.PI * 1.5]];
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= seg; i++) { const a = a0 + (i / seg) * Math.PI / 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return pts;
}

/** Slatted vent grille: N thin bars within w×h (in XY), depth d. */
export function slats(w, h, n, d = 0.02, barFrac = 0.45) {
  const list = [];
  const step = h / n;
  for (let i = 0; i < n; i++) {
    const g = rbox(w, step * barFrac, d, Math.min(step * barFrac * 0.3, 0.004), 1);
    g.rotateX(-0.35);
    g.translate(0, -h / 2 + step * (i + 0.5), 0);
    list.push(g);
  }
  const m = mergeGeometries(list.map((g) => { g.deleteAttribute('uv'); return ensureIndex(g); }));
  list.forEach((g) => g.dispose());
  return m;
}

// ------------------------------------------------------------------ loft
function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * Loft through superellipse sections along Z.
 * section: { z, w (half-width), ht (height above center), hb (height below center), y (center y),
 *            x (center x), n (superellipse exponent, 2 = ellipse, 4 = squircle), nb (bottom exponent) }
 * Returns { geometry, evaluate(t, a, outP, outN) } where t ∈ [0,1] along, a ∈ [0,1] around
 * (a = 0 → +X side, 0.25 → top, 0.5 → -X, 0.75 → bottom).
 */
export function loft(sections, { radial = 40, along = 48, capStart = true, capEnd = true } = {}) {
  const S = sections.map((s) => ({ z: s.z, w: s.w, ht: s.ht ?? s.h ?? s.w, hb: s.hb ?? s.h ?? s.w, y: s.y ?? 0, x: s.x ?? 0, n: s.n ?? 2.2, nb: s.nb ?? s.n ?? 2.2 }));
  const K = ['z', 'w', 'ht', 'hb', 'y', 'x', 'n', 'nb'];
  const cur = {};
  const param = (t) => {
    const f = Math.min(Math.max(t, 0), 1) * (S.length - 1);
    const i = Math.min(S.length - 2, Math.floor(f));
    const u = f - i;
    const a = S[Math.max(0, i - 1)], b = S[i], c = S[i + 1], d = S[Math.min(S.length - 1, i + 2)];
    for (const k of K) cur[k] = cr(a[k], b[k], c[k], d[k], u);
    cur.w = Math.max(cur.w, 0); cur.ht = Math.max(cur.ht, 0); cur.hb = Math.max(cur.hb, 0);
    return cur;
  };
  const point = (t, a, out) => {
    const s = param(t);
    const th = a * Math.PI * 2;
    const c = Math.cos(th), sn = Math.sin(th);
    const top = sn >= 0;
    const ex = 2 / (top ? s.n : s.nb);
    const px = s.x + s.w * Math.sign(c) * Math.pow(Math.abs(c), ex);
    const py = s.y + (top ? s.ht : s.hb) * Math.sign(sn) * Math.pow(Math.abs(sn), ex);
    return out.set(px, py, s.z);
  };
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), D = new THREE.Vector3();
  const evaluate = (t, a, outP, outN) => {
    point(t, a, outP);
    const et = 0.002, ea = 0.002;
    point(Math.min(1, t + et), a, A); point(Math.max(0, t - et), a, B);
    point(t, a + ea, C); point(t, a - ea, D);
    A.sub(B); C.sub(D);
    outN.crossVectors(C, A);
    if (outN.lengthSq() < 1e-14) {
      // degenerate at a pointy tip: use the axis direction
      outN.set(0, 0, t < 0.5 ? -1 : 1);
    } else outN.normalize();
    return outP;
  };
  const cols = radial + 1, rows = along + 1;
  const pos = new Float32Array(cols * rows * 3), nor = new Float32Array(cols * rows * 3), uv = new Float32Array(cols * rows * 2);
  const P = new THREE.Vector3(), N = new THREE.Vector3();
  for (let j = 0; j < rows; j++) {
    const t = j / along;
    for (let i = 0; i < cols; i++) {
      const a = i / radial;
      evaluate(t, a, P, N);
      const k = j * cols + i;
      pos[k * 3] = P.x; pos[k * 3 + 1] = P.y; pos[k * 3 + 2] = P.z;
      nor[k * 3] = N.x; nor[k * 3 + 1] = N.y; nor[k * 3 + 2] = N.z;
      uv[k * 2] = a; uv[k * 2 + 1] = t;
    }
  }
  const idx = [];
  for (let j = 0; j < along; j++) for (let i = 0; i < radial; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
    // winding so normals face outward (sections progress +Z, angle CCW seen from +Z)
    idx.push(a, b, d, a, d, c);
  }
  const parts = [];
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  body.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  body.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  body.setIndex(idx);
  parts.push(body);
  // caps (flat) where the end section is open
  const cap = (t, dir) => {
    const s = param(t);
    if (s.w < 1e-3 && s.ht < 1e-3 && s.hb < 1e-3) return;
    const cp = [], cn = [], cu = [], ci = [];
    cp.push(s.x, s.y, s.z); cn.push(0, 0, dir); cu.push(0.5, 0.5);
    for (let i = 0; i <= radial; i++) {
      point(t, i / radial, P);
      cp.push(P.x, P.y, P.z); cn.push(0, 0, dir); cu.push(0, 0);
    }
    for (let i = 1; i <= radial; i++) { if (dir > 0) ci.push(0, i, i + 1); else ci.push(0, i + 1, i); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(cn, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(cu, 2));
    g.setIndex(ci);
    parts.push(g);
  };
  if (capStart) cap(0, -1);
  if (capEnd) cap(1, 1);
  const geometry = parts.length > 1 ? mergeGeometries(parts) : body;
  if (parts.length > 1) parts.forEach((g) => g.dispose());
  return { geometry, evaluate, param };
}

/** Check winding of a loft: returns +1 if normals point away from the section center. */
export function loftOrientation(lft) {
  const P = new THREE.Vector3(), N = new THREE.Vector3();
  lft.evaluate(0.5, 0.0, P, N);
  const s = lft.param(0.5);
  return (P.x - s.x) * N.x + (P.y - s.y) * N.y >= 0 ? 1 : -1;
}

export { mergeGeometries };
