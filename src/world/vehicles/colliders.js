// Spatial hash over world.colliders (static props: trees, rocks, buildings) + sphere queries.
// Collider contract (ARCHITECTURE.md): { type: 'sphere'|'capsule'|'box', pos (local), radius,
// height, halfExtents, quaternion, tag }. Capsules: base at pos, axis = radial up (or quaternion Y),
// length = height. Boxes: center pos, halfExtents, optional quaternion (planet-local).
import * as THREE from 'three';

const CELL = 24;
const _q = new THREE.Quaternion(), _l = new THREE.Vector3(), _c = new THREE.Vector3(), _ax = new THREE.Vector3();
const _d = new THREE.Vector3(), _cl = new THREE.Vector3();

function key(ix, iy, iz) { return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0; }

export class ColliderGrid {
  constructor(world) {
    this.world = world;
    this.cells = new Map();
    this.count = 0;
    this.stamp = 0;
    this._rebuildT = 0;
    this._visit = 1;
    this.contact = { normal: new THREE.Vector3(), depth: 0, collider: null };
  }

  _extent(c) {
    if (c.type === 'box') { const h = c.halfExtents; return h ? Math.hypot(h.x, h.y, h.z) : (c.radius || 1); }
    if (c.type === 'capsule') return (c.radius || 0.5) + (c.height || 0);
    return c.radius || 1;
  }

  _insert(c) {
    if (!c || !c.pos) return;
    if (c.tag && typeof c.tag === 'string' && c.tag.startsWith('vehicle')) return; // our own movers are handled separately
    const p = c.pos, r = this._extent(c);
    const x0 = Math.floor((p.x - r) / CELL), x1 = Math.floor((p.x + r) / CELL);
    const y0 = Math.floor((p.y - r) / CELL), y1 = Math.floor((p.y + r) / CELL);
    const z0 = Math.floor((p.z - r) / CELL), z1 = Math.floor((p.z + r) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 512) return; // absurdly large: skip
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const k = key(x, y, z);
      let a = this.cells.get(k);
      if (!a) { a = []; this.cells.set(k, a); }
      a.push(c);
    }
  }

  /** Keep the hash in sync with world.colliders (append-only fast path, periodic full rebuild). */
  sync(dt) {
    const list = this.world.colliders;
    if (!list) return;
    this._rebuildT += dt;
    if (list.length < this.count || (this._rebuildT > 8 && list.length !== this._lastFull)) {
      this.cells.clear(); this.count = 0; this._rebuildT = 0; this._lastFull = list.length;
    }
    const n = list.length;
    // time-slice big batches (thousands of trees arriving at once)
    const end = Math.min(n, this.count + 4000);
    for (let i = this.count; i < end; i++) this._insert(list[i]);
    this.count = end;
  }

  /**
   * Deepest penetration of a sphere against static colliders. Returns this.contact or null.
   * contact.normal points out of the collider (push direction), depth > 0.
   */
  sphere(center, radius) {
    if (this.cells.size === 0) return null;
    const vis = ++this._visit;
    let best = null, bestDepth = 0;
    const x0 = Math.floor((center.x - radius) / CELL), x1 = Math.floor((center.x + radius) / CELL);
    const y0 = Math.floor((center.y - radius) / CELL), y1 = Math.floor((center.y + radius) / CELL);
    const z0 = Math.floor((center.z - radius) / CELL), z1 = Math.floor((center.z + radius) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const a = this.cells.get(key(x, y, z));
      if (!a) continue;
      for (let i = 0; i < a.length; i++) {
        const c = a[i];
        if (c.__rvv === vis) continue;
        c.__rvv = vis;
        const depth = this._test(c, center, radius, _d);
        if (depth > bestDepth) { bestDepth = depth; best = c; this.contact.normal.copy(_d); }
      }
    }
    if (!best) return null;
    this.contact.depth = bestDepth; this.contact.collider = best;
    return this.contact;
  }

  _test(c, p, r, nOut) {
    const cp = c.pos;
    if (c.type === 'box' && c.halfExtents) {
      // transform into box space
      _l.copy(p).sub(cp);
      if (c.quaternion) { _q.copy(c.quaternion).invert(); _l.applyQuaternion(_q); }
      const h = c.halfExtents;
      _cl.set(Math.max(-h.x, Math.min(h.x, _l.x)), Math.max(-h.y, Math.min(h.y, _l.y)), Math.max(-h.z, Math.min(h.z, _l.z)));
      _d.copy(_l).sub(_cl);
      let dist = _d.length();
      if (dist > r) return 0;
      if (dist < 1e-6) {
        // center inside: push out along the axis of least penetration
        const px = h.x - Math.abs(_l.x), py = h.y - Math.abs(_l.y), pz = h.z - Math.abs(_l.z);
        if (px < py && px < pz) { nOut.set(Math.sign(_l.x) || 1, 0, 0); dist = -px; }
        else if (py < pz) { nOut.set(0, Math.sign(_l.y) || 1, 0); dist = -py; }
        else { nOut.set(0, 0, Math.sign(_l.z) || 1); dist = -pz; }
      } else nOut.copy(_d).divideScalar(dist);
      if (c.quaternion) nOut.applyQuaternion(c.quaternion);
      return r - dist;
    }
    if (c.type === 'capsule') {
      const cr = c.radius || 0.4, hgt = c.height || 0;
      if (c.quaternion) _ax.set(0, 1, 0).applyQuaternion(c.quaternion); else _ax.copy(cp).normalize();
      _l.copy(p).sub(cp);
      const t = Math.max(0, Math.min(hgt, _l.dot(_ax)));
      _c.copy(cp).addScaledVector(_ax, t);
      _d.copy(p).sub(_c);
      const dist = _d.length();
      if (dist >= r + cr) return 0;
      if (dist < 1e-6) nOut.copy(p).normalize(); else nOut.copy(_d).divideScalar(dist);
      return r + cr - dist;
    }
    const cr = c.radius || 1;
    _d.copy(p).sub(cp);
    const dist = _d.length();
    if (dist >= r + cr) return 0;
    if (dist < 1e-6) nOut.copy(p).normalize(); else nOut.copy(_d).divideScalar(dist);
    return r + cr - dist;
  }
}
