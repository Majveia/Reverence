// Player track — physics helpers (also usable by vehicles/camera via world.physics).
//
//   HeightSampler   cached heightfield around the player (lazy tangent-plane grid, bilinear),
//                   ground normals, water surface. Source of truth = world.surface (never GPU mesh).
//   ColliderIndex   spatial hash over world.colliders (append-only fast path, time-sliced rebuild),
//                   capsule / sphere resolution, ray casts (sphere, capsule, box).
//   AirField        wind + updrafts (thermal columns + ridge lift) for the paraglider.
//
// Collider contract (ARCHITECTURE.md, same interpretation as the vehicles track):
//   sphere : pos = center, radius
//   capsule: pos = base, axis = quaternion·Y or radial up, height = length, radius
//   box    : pos = center, halfExtents, optional quaternion (planet-local)
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { clamp, smoothstep, tangentBasis } from './util.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _e = new THREE.Vector3(), _f = new THREE.Vector3(), _q = new THREE.Quaternion(), _ax = new THREE.Vector3();
const _l0 = new THREE.Vector3(), _l1 = new THREE.Vector3(), _n = new THREE.Vector3();

// ---------------------------------------------------------------------------------------------
// Heightfield
// ---------------------------------------------------------------------------------------------
export class HeightSampler {
  constructor(world, { cell = 0.4, n = 160 } = {}) {
    this.world = world;
    this.S = world.surface || null;
    this.R = world.body.radius;
    this.cell = cell; this.n = n; this.half = n / 2;
    const N1 = n + 1;
    this.h = new Float64Array(N1 * N1);
    this.ok = new Uint8Array(N1 * N1);
    this.u = new THREE.Vector3(0, 1, 0); this.e = new THREE.Vector3(1, 0, 0); this.nv = new THREE.Vector3(0, 0, 1);
    this.anchored = false;
    const oc = world.body.ocean;
    this.hasOcean = !!(this.S && oc?.present && Number.isFinite(this.S.seaLevel) && this.S.seaLevel > -1e8);
    this.sea = this.hasOcean ? this.S.seaLevel : -Infinity;
    this.liquid = oc?.liquid || 'water';
    this._water = null; this._waterT = -99;
    this._s = {};
    this.stats = { raw: 0, cached: 0 };
  }

  /** Raw terrain height (m rel. radius) at a unit direction. */
  raw(x, y, z) {
    this.stats.raw++;
    if (!this.S) return 0;
    const h = this.S.height(x, y, z);
    return Number.isFinite(h) ? h : 0;
  }
  /** Raw height under any point (not necessarily unit). */
  rawAt(p) { const l = p.length() || 1; return this.raw(p.x / l, p.y / l, p.z / l); }

  /** Re-anchor the cache grid when `p` leaves its safe interior. */
  follow(p) {
    if (!this.anchored) { this._anchor(p); return; }
    const l = p.length() || 1;
    const c = (p.x * this.u.x + p.y * this.u.y + p.z * this.u.z) / l;
    if (c < 0.99) { this._anchor(p); return; }
    const k = this.R / c / l;
    const x = (p.x * this.e.x + p.y * this.e.y + p.z * this.e.z) * k;
    const y = (p.x * this.nv.x + p.y * this.nv.y + p.z * this.nv.z) * k;
    const lim = (this.half - 14) * this.cell;
    if (Math.abs(x) > lim || Math.abs(y) > lim) this._anchor(p);
  }
  _anchor(p) {
    this.u.copy(p).normalize();
    tangentBasis(this.u, this.e, this.nv);
    this.ok.fill(0);
    this.anchored = true;
  }
  _grid(i, j) {
    const N1 = this.n + 1, idx = j * N1 + i;
    if (this.ok[idx]) { this.stats.cached++; return this.h[idx]; }
    const x = (i - this.half) * this.cell, y = (j - this.half) * this.cell, R = this.R;
    const dx = this.u.x * R + this.e.x * x + this.nv.x * y;
    const dy = this.u.y * R + this.e.y * x + this.nv.y * y;
    const dz = this.u.z * R + this.e.z * x + this.nv.z * y;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const h = this.raw(dx / l, dy / l, dz / l);
    this.h[idx] = h; this.ok[idx] = 1;
    return h;
  }
  /** Terrain height (m rel. radius) under point p — cached bilinear near the anchor, raw elsewhere. */
  height(p) {
    if (!this.S) return 0;
    const l = p.length() || 1;
    if (this.anchored) {
      const c = (p.x * this.u.x + p.y * this.u.y + p.z * this.u.z) / l;
      if (c > 0.99) {
        const k = this.R / c / l;
        const gx = (p.x * this.e.x + p.y * this.e.y + p.z * this.e.z) * k / this.cell + this.half;
        const gy = (p.x * this.nv.x + p.y * this.nv.y + p.z * this.nv.z) * k / this.cell + this.half;
        if (gx >= 0 && gy >= 0 && gx < this.n && gy < this.n) {
          const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
          const h00 = this._grid(i, j), h10 = this._grid(i + 1, j), h01 = this._grid(i, j + 1), h11 = this._grid(i + 1, j + 1);
          return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
        }
      }
    }
    return this.raw(p.x / l, p.y / l, p.z / l);
  }
  /** Radius of the terrain surface under p. */
  groundR(p) { return this.R + this.height(p); }

  /** Terrain normal at p (unit, outward) via central differences over `eps` meters. */
  normal(p, out, eps = 0.6) {
    const up = _a.copy(p).normalize();
    tangentBasis(up, _e, _f);
    const base = _b.copy(up).multiplyScalar(this.R + this.height(p));
    const hx1 = this.height(_c.copy(base).addScaledVector(_e, eps));
    const hx0 = this.height(_c.copy(base).addScaledVector(_e, -eps));
    const hy1 = this.height(_c.copy(base).addScaledVector(_f, eps));
    const hy0 = this.height(_c.copy(base).addScaledVector(_f, -eps));
    const gx = (hx1 - hx0) / (2 * eps), gy = (hy1 - hy0) / (2 * eps);
    out.copy(up).addScaledVector(_e, -gx).addScaledVector(_f, -gy).normalize();
    return out;
  }

  /** Liquid surface height (m rel. radius) at p, or -Infinity. Uses the water track's waves if exposed. */
  water(p) {
    if (!this.hasOcean) return -Infinity;
    const t = this.world.time;
    if (t - this._waterT > 2 || t < this._waterT) {
      this._waterT = t;
      const w = this.world.get?.('water');
      this._water = w && (typeof w.heightAt === 'function' || typeof w.surfaceHeight === 'function') ? w : null;
    }
    const w = this._water;
    if (w) {
      try {
        const h = typeof w.heightAt === 'function' ? w.heightAt(p) : w.surfaceHeight(p);
        if (Number.isFinite(h) && Math.abs(h - this.sea) < 30) return h;
      } catch (_) { /* fall back to flat sea */ }
    }
    return this.sea;
  }

  /** Biome sample (throttle this — a few times per second). */
  sample(p) {
    if (!this.S || !this.S.sample) return null;
    const l = p.length() || 1;
    try { return this.S.sample(p.x / l, p.y / l, p.z / l, this._s); } catch (_) { return null; }
  }
}

// ---------------------------------------------------------------------------------------------
// Colliders
// ---------------------------------------------------------------------------------------------
const CELL = 12;
const hkey = (ix, iy, iz) => (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;

export class ColliderIndex {
  constructor(world) {
    this.world = world;
    this.cells = new Map();
    this.big = [];
    this.count = 0;
    this._list = null;
    this._last = null;
    this._visit = 1;
    this._rebuildT = 0;
    this.results = [];
    this.contacts = [];
    for (let i = 0; i < 8; i++) this.contacts.push({ normal: new THREE.Vector3(), depth: 0, collider: null, point: new THREE.Vector3() });
  }

  static bounds(c, center) {
    const p = c.pos;
    if (c.type === 'box') {
      center.copy(p);
      const h = c.halfExtents;
      return h ? Math.sqrt(h.x * h.x + h.y * h.y + h.z * h.z) : (c.radius || 1);
    }
    if (c.type === 'capsule') {
      const hgt = c.height || 0;
      if (c.quaternion) _ax.set(0, 1, 0).applyQuaternion(c.quaternion); else _ax.copy(p).normalize();
      center.copy(p).addScaledVector(_ax, hgt * 0.5);
      return (c.radius || 0.4) + hgt * 0.5 + 0.5;
    }
    center.copy(p);
    return c.radius || 1;
  }

  _insert(c) {
    if (!c || !c.pos || c.enabled === false) return;
    const r = ColliderIndex.bounds(c, _c);
    if (!(r < 1e6)) return;
    const x0 = Math.floor((_c.x - r) / CELL), x1 = Math.floor((_c.x + r) / CELL);
    const y0 = Math.floor((_c.y - r) / CELL), y1 = Math.floor((_c.y + r) / CELL);
    const z0 = Math.floor((_c.z - r) / CELL), z1 = Math.floor((_c.z + r) / CELL);
    // moving colliders (vehicles) and huge ones are tested directly every query → never stale
    if (c.vehicle || c.dynamic || (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 64) { this.big.push(c); return; }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const k = hkey(x, y, z);
      let a = this.cells.get(k);
      if (!a) { a = []; this.cells.set(k, a); }
      a.push(c);
    }
  }

  /** Keep in sync with world.colliders: append-only fast path, rebuild on removal, time-sliced. */
  sync(dt = 0) {
    const list = this.world.colliders;
    if (!Array.isArray(list)) return;
    this._rebuildT += dt;
    const changed = list !== this._list || list.length < this.count ||
      (this.count > 0 && list[this.count - 1] !== this._last) || (this._rebuildT > 10 && list.length !== this._fullLen);
    if (changed) {
      this.cells.clear(); this.big.length = 0; this.count = 0; this._list = list; this._rebuildT = 0; this._fullLen = list.length;
    }
    const end = Math.min(list.length, this.count + 5000);
    for (let i = this.count; i < end; i++) this._insert(list[i]);
    this.count = end;
    this._last = end > 0 ? list[end - 1] : null;
  }

  /** Colliders whose bounds may touch sphere (p, r). Returns a shared array. */
  query(p, r) {
    const out = this.results; out.length = 0;
    const vis = ++this._visit;
    if (this.cells.size) {
      const x0 = Math.floor((p.x - r) / CELL), x1 = Math.floor((p.x + r) / CELL);
      const y0 = Math.floor((p.y - r) / CELL), y1 = Math.floor((p.y + r) / CELL);
      const z0 = Math.floor((p.z - r) / CELL), z1 = Math.floor((p.z + r) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const a = this.cells.get(hkey(x, y, z));
        if (!a) continue;
        for (let i = 0; i < a.length; i++) { const c = a[i]; if (c.__rvp !== vis) { c.__rvp = vis; out.push(c); } }
      }
    }
    for (let i = 0; i < this.big.length; i++) {
      const c = this.big[i];
      const br = ColliderIndex.bounds(c, _c);
      if (_c.distanceToSquared(p) < (br + r) * (br + r)) out.push(c);
    }
    return out;
  }

  /**
   * Penetration of a capsule segment [a, b] (radius r) against collider c.
   * Returns depth (>0 if overlapping) and writes the push normal (out of the collider) and contact point.
   */
  static capsuleVs(c, a, b, r, nOut, pOut) {
    if (c.enabled === false || !c.pos) return 0;
    const cp = c.pos;
    if (c.type === 'box' && c.halfExtents) {
      const h = c.halfExtents;
      // segment in box space
      _l0.copy(a).sub(cp); _l1.copy(b).sub(cp);
      if (c.quaternion) { _q.copy(c.quaternion).invert(); _l0.applyQuaternion(_q); _l1.applyQuaternion(_q); }
      // sample the segment: ends, middle and the point nearest the box center
      let best = 0;
      const dx = _l1.x - _l0.x, dy = _l1.y - _l0.y, dz = _l1.z - _l0.z;
      const len2 = dx * dx + dy * dy + dz * dz;
      const tc = len2 > 1e-9 ? clamp(-(_l0.x * dx + _l0.y * dy + _l0.z * dz) / len2, 0, 1) : 0;
      for (let s = 0; s < 5; s++) {
        const t = s === 4 ? tc : s * (1 / 3);
        const qx = _l0.x + dx * t, qy = _l0.y + dy * t, qz = _l0.z + dz * t;
        const cx = clamp(qx, -h.x, h.x), cy = clamp(qy, -h.y, h.y), cz = clamp(qz, -h.z, h.z);
        let ex = qx - cx, ey = qy - cy, ez = qz - cz;
        let dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
        let depth;
        if (dist < 1e-6) {
          const px = h.x - Math.abs(qx), py = h.y - Math.abs(qy), pz = h.z - Math.abs(qz);
          if (px < py && px < pz) { ex = Math.sign(qx) || 1; ey = 0; ez = 0; depth = px + r; }
          else if (py < pz) { ex = 0; ey = Math.sign(qy) || 1; ez = 0; depth = py + r; }
          else { ex = 0; ey = 0; ez = Math.sign(qz) || 1; depth = pz + r; }
        } else {
          if (dist >= r) continue;
          depth = r - dist; ex /= dist; ey /= dist; ez /= dist;
        }
        if (depth > best) { best = depth; nOut.set(ex, ey, ez); pOut.set(cx, cy, cz); }
      }
      if (best > 0 && c.quaternion) { nOut.applyQuaternion(c.quaternion); pOut.applyQuaternion(c.quaternion); }
      if (best > 0) pOut.add(cp);
      return best;
    }
    if (c.type === 'capsule') {
      const cr = c.radius || 0.4, hgt = c.height || 0;
      if (c.quaternion) _ax.set(0, 1, 0).applyQuaternion(c.quaternion); else _ax.copy(cp).normalize();
      // collider segment (extend slightly below the base: trunks are rooted)
      _c.copy(cp).addScaledVector(_ax, -Math.min(1, hgt * 0.1));
      _d.copy(cp).addScaledVector(_ax, hgt);
      closestSegSeg(a, b, _c, _d, _l0, _l1);
      _n.copy(_l0).sub(_l1);
      const dist = _n.length();
      if (dist >= r + cr) return 0;
      if (dist < 1e-6) nOut.copy(a).sub(_c).projectOnPlane(_ax).normalize(); else nOut.copy(_n).divideScalar(dist);
      pOut.copy(_l1).addScaledVector(nOut, cr);
      return r + cr - dist;
    }
    const cr = c.radius || 1;
    closestPointSeg(cp, a, b, _l0);
    _n.copy(_l0).sub(cp);
    const dist = _n.length();
    if (dist >= r + cr) return 0;
    if (dist < 1e-6) nOut.copy(a).normalize(); else nOut.copy(_n).divideScalar(dist);
    pOut.copy(cp).addScaledVector(nOut, cr);
    return r + cr - dist;
  }

  /**
   * Resolve a vertical capsule (feet at `pos`, axis `up`) against nearby colliders.
   * Moves pos out of penetration; returns the number of contacts written to this.contacts.
   */
  resolveCapsule(pos, up, radius, height, iterations = 2) {
    let nc = 0;
    if (!this.cells.size && !this.big.length) return 0;
    _e.copy(pos).addScaledVector(up, height * 0.5);
    const list = this.query(_e, height * 0.5 + radius + 0.5);
    if (!list.length) return 0;
    const cand = this._cand || (this._cand = []);
    cand.length = 0;
    for (let i = 0; i < list.length && i < 48; i++) cand.push(list[i]);
    for (let it = 0; it < iterations; it++) {
      let any = false;
      for (let i = 0; i < cand.length; i++) {
        const c = cand[i];
        _a.copy(pos).addScaledVector(up, radius);
        _b.copy(pos).addScaledVector(up, Math.max(radius, height - radius));
        const ct = this.contacts[Math.min(nc, this.contacts.length - 1)];
        const depth = ColliderIndex.capsuleVs(c, _a, _b, radius, ct.normal, ct.point);
        if (depth > 1e-4) {
          pos.addScaledVector(ct.normal, depth + 1e-4);
          ct.depth = depth; ct.collider = c;
          if (nc < this.contacts.length - 1) nc++;
          any = true;
        }
      }
      if (!any) break;
    }
    return nc;
  }

  /** Ray vs colliders: nearest hit distance along unit dir (or Infinity). `pad` inflates shapes. */
  raycast(o, dir, maxDist, pad = 0, minSize = 0) {
    _e.copy(o).addScaledVector(dir, maxDist * 0.5);
    const list = this.query(_e, maxDist * 0.5 + pad + 1);
    let best = Infinity;
    for (let i = 0; i < list.length; i++) {
      if (minSize > 0 && ColliderIndex.bounds(list[i], _f) < minSize) continue;
      const t = rayCollider(list[i], o, dir, pad);
      if (t >= 0 && t < best && t <= maxDist) best = t;
    }
    return best;
  }

  /** Highest collider "floor" under the feet (for standing on boxes/props); returns up-offset or -Infinity. */
  static topAbove(c, pos, up) {
    if (c.type !== 'box' || !c.halfExtents) return -Infinity;
    const h = c.halfExtents;
    let ext;
    if (c.quaternion) {
      _q.copy(c.quaternion);
      _ax.set(1, 0, 0).applyQuaternion(_q); ext = Math.abs(_ax.dot(up)) * h.x;
      _ax.set(0, 1, 0).applyQuaternion(_q); ext += Math.abs(_ax.dot(up)) * h.y;
      _ax.set(0, 0, 1).applyQuaternion(_q); ext += Math.abs(_ax.dot(up)) * h.z;
    } else ext = Math.abs(up.x) * h.x + Math.abs(up.y) * h.y + Math.abs(up.z) * h.z;
    return _ax.copy(c.pos).sub(pos).dot(up) + ext;
  }
}

function closestPointSeg(p, a, b, out) {
  _f.copy(b).sub(a);
  const l2 = _f.lengthSq();
  const t = l2 > 1e-12 ? clamp(_d.copy(p).sub(a).dot(_f) / l2, 0, 1) : 0;
  return out.copy(a).addScaledVector(_f, t);
}

const _s1 = new THREE.Vector3(), _s2 = new THREE.Vector3(), _sr = new THREE.Vector3();
/** Closest points between segments p1q1 and p2q2 (Ericson). */
function closestSegSeg(p1, q1, p2, q2, c1, c2) {
  const d1 = _s1.copy(q1).sub(p1), d2 = _s2.copy(q2).sub(p2), r = _sr.copy(p1).sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) { c1.copy(p1); c2.copy(p2); return; }
  if (a <= 1e-9) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e <= 1e-9) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den !== 0 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  c1.copy(p1).addScaledVector(d1, s);
  c2.copy(p2).addScaledVector(d2, t);
}

const _ro = new THREE.Vector3(), _rd = new THREE.Vector3();
function raySphere(o, d, c, r) {
  _ro.copy(o).sub(c);
  const b = _ro.dot(d), cc = _ro.dot(_ro) - r * r;
  if (cc <= 0) return 0;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -1;
}
function rayCollider(c, o, d, pad) {
  if (!c.pos || c.enabled === false) return -1;
  if (c.type === 'box' && c.halfExtents) {
    const h = c.halfExtents;
    _ro.copy(o).sub(c.pos); _rd.copy(d);
    if (c.quaternion) { _q.copy(c.quaternion).invert(); _ro.applyQuaternion(_q); _rd.applyQuaternion(_q); }
    let tmin = -Infinity, tmax = Infinity;
    const hx = h.x + pad, hy = h.y + pad, hz = h.z + pad;
    const ax = [_ro.x, _ro.y, _ro.z], ad = [_rd.x, _rd.y, _rd.z], ah = [hx, hy, hz];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(ad[i]) < 1e-9) { if (Math.abs(ax[i]) > ah[i]) return -1; continue; }
      let t1 = (-ah[i] - ax[i]) / ad[i], t2 = (ah[i] - ax[i]) / ad[i];
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (tmax < 0) return -1;
    return tmin >= 0 ? tmin : 0;
  }
  if (c.type === 'capsule') {
    const cr = (c.radius || 0.4) + pad, hgt = c.height || 0;
    if (c.quaternion) _ax.set(0, 1, 0).applyQuaternion(c.quaternion); else _ax.copy(c.pos).normalize();
    // approximate: march 3 spheres along the axis
    let best = -1;
    for (let k = 0; k < 4; k++) {
      _c.copy(c.pos).addScaledVector(_ax, hgt * (k / 3));
      const t = raySphere(o, d, _c, cr);
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
    return best;
  }
  return raySphere(o, d, c.pos, (c.radius || 1) + pad);
}

// ---------------------------------------------------------------------------------------------
// Air: wind, thermals, ridge lift
// ---------------------------------------------------------------------------------------------
const TCELL = 380;
export class AirField {
  constructor(world, heights) {
    this.world = world;
    this.H = heights;
    this.seed = (world.body.seed ?? 1) | 0;
    this.cache = new Map();
    this.near = [];      // thermals near the last query (for FX)
    this._np = new THREE.Vector3(1e9, 0, 0);
    const atm = world.body.atmosphere;
    this.density = atm?.present ? clamp(atm.density ?? 1, 0.25, 2.5) : 0;
    this.windBase = 2.5 + 7 * (world.body.art?.weather?.wind ?? 0.35);
    this.dayFactor = 1;
  }

  /** Wind velocity (m/s, planet-local) at p. */
  wind(p, out) {
    const s = G.uWindStrength.value ?? 0.3;
    out.copy(G.uWindDir.value);
    const up = _a.copy(p).normalize();
    out.addScaledVector(up, -out.dot(up));
    const l = out.length();
    if (l < 1e-6) return out.set(0, 0, 0);
    return out.multiplyScalar(this.windBase * (0.4 + s) / l * (this.density > 0 ? 1 : 0));
  }

  _thermal(ix, iy, iz) {
    const k = hkey(ix, iy, iz) ^ this.seed;
    let t = this.cache.get(k);
    if (t !== undefined) return t;
    let h = Math.imul(k ^ (k >>> 15), 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    const r0 = ((h >>> 0) & 0xffff) / 65536, r1 = ((h >>> 16) & 0xffff) / 65536;
    let h2 = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b); h2 ^= h2 >>> 13;
    const r2 = ((h2 >>> 0) & 0xffff) / 65536, r3 = ((h2 >>> 16) & 0xffff) / 65536;
    t = null;
    if (r0 < 0.42) {
      const c = _b.set((ix + 0.15 + 0.7 * r1) * TCELL, (iy + 0.15 + 0.7 * r2) * TCELL, (iz + 0.15 + 0.7 * r3) * TCELL);
      const R = this.H.R;
      const rc = c.length();
      const dir = c.normalize();
      const hgt = this.H.raw(dir.x, dir.y, dir.z);
      // one radial layer only: the cell must straddle the ground surface
      if (Math.abs(rc - (R + hgt)) < TCELL * 0.62 && (hgt > this.H.sea + 2 || !this.H.hasOcean)) {
        const base = dir.clone().multiplyScalar(R + hgt);
        // only keep thermals whose base falls inside this cell's radial shell neighbourhood
        t = { base, up: dir.clone(), radius: 22 + 30 * r1, strength: 2.4 + 3.2 * r2, top: 260 + 420 * r3, seed: h >>> 0 };
      }
    }
    if (this.cache.size > 4000) this.cache.clear();
    this.cache.set(k, t);
    return t;
  }

  /** Vertical air speed (m/s) at p: thermals + ridge lift. `alt` = height above terrain. */
  updraft(p, alt, sunElev = 0.5) {
    if (this.density <= 0) return 0;
    let w = 0;
    const ix = Math.floor(p.x / TCELL), iy = Math.floor(p.y / TCELL), iz = Math.floor(p.z / TCELL);
    const day = smoothstep(-0.05, 0.25, sunElev);
    const needNear = this._np.distanceToSquared(p) > 60 * 60;
    if (needNear) { this.near.length = 0; this._np.copy(p); }
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const t = this._thermal(ix + dx, iy + dy, iz + dz);
      if (!t) continue;
      _c.copy(p).sub(t.base);
      const hAbove = _c.dot(t.up);
      _c.addScaledVector(t.up, -hAbove);
      const d = _c.length();
      if (needNear && d < 600) this.near.push(t);
      if (d > t.radius * 2.5 || hAbove < -20 || hAbove > t.top) continue;
      const core = Math.exp(-(d * d) / (t.radius * t.radius));
      const topFade = 1 - smoothstep(t.top * 0.65, t.top, hAbove);
      const lowFade = smoothstep(-10, 25, hAbove);
      w += t.strength * core * topFade * lowFade * (0.35 + 0.65 * day);
      // gentle sink ring around each thermal keeps the air honest
      w -= 0.5 * t.strength * Math.exp(-((d - t.radius * 1.7) ** 2) / (t.radius * t.radius * 0.5)) * topFade * 0.4;
    }
    // ridge lift: wind blowing up a slope
    const wv = this.wind(p, _d);
    const ws = wv.length();
    if (ws > 0.1 && alt < 260) {
      const up = _a.copy(p).normalize();
      _e.copy(wv).divideScalar(ws);
      const g = this.H.R + this.H.rawAt(_f.copy(up).multiplyScalar(this.H.R).addScaledVector(_e, -40));
      const g2 = this.H.R + this.H.rawAt(_f.copy(up).multiplyScalar(this.H.R).addScaledVector(_e, 30));
      const slope = (g2 - g) / 70; // rise per meter along the wind
      if (slope > 0) w += ws * clamp(slope, 0, 1.2) * 1.4 * (1 - smoothstep(60, 260, alt));
    }
    return w;
  }
}
