// Control modes, interactables and simple static collision for the system realm.
import * as THREE from 'three';

/**
 * A Controller owns the camera while active.  Interface (duck-typed):
 *   id            'foot' | 'bike' | 'ship' | 'fly' | …
 *   position      THREE.Vector3   scene space (hub re-bases it when the reference frame changes)
 *   quaternion    THREE.Quaternion
 *   velocity      THREE.Vector3   scene space, m/s
 *   enter(handoff) called when it becomes active; handoff = { from, position, quaternion, velocity, … } or null
 *   exit()         called when it stops being active; may return extra handoff fields
 *   update(dt, frame)  read ctx.engine.input, move, and write frame.camera's position/quaternion/fov
 *   hud?()         optional → { speed, altitude, hint, … } for the UI
 */
export class ControlManager {
  constructor(ctx) { this.ctx = ctx; this.controllers = new Map(); this.active = null; this.activeId = null; }

  register(controller) { this.controllers.set(controller.id, controller); this.ctx.events.emit('control:registered', controller.id); return controller; }
  get(id) { return this.controllers.get(id); }
  has(id) { return this.controllers.has(id); }

  /** Switch the active controller.  `handoff` fields override what the previous controller reports. */
  switchTo(id, handoff = {}) {
    const next = this.controllers.get(id);
    if (!next) { console.warn('[control] no controller', id); return false; }
    const prev = this.active;
    let state = null;
    if (prev) {
      state = { from: prev.id, position: prev.position.clone(), quaternion: prev.quaternion.clone(), velocity: prev.velocity.clone() };
      try { Object.assign(state, prev.exit?.() || {}); } catch (e) { console.error(e); }
    }
    state = { ...(state || { from: null }), ...handoff };
    this.active = next; this.activeId = id;
    try { next.enter?.(state); } catch (e) { console.error('[control] enter failed', e); }
    this.ctx.events.emit('control:change', id, prev?.id ?? null);
    return true;
  }

  update(dt, frame) { if (this.active) this.active.update(dt, frame); }
}

/** Things the wanderer can use.  The nearest one in range is "focused"; pressing `interact` uses it. */
export class Interactables {
  constructor(ctx) { this.ctx = ctx; this.items = new Set(); this.focus = null; this._p = new THREE.Vector3(); }

  /**
   * @param o { position: Vector3 | () => Vector3, radius: number, label: string, verb?: string,
   *            onUse: () => void, enabled?: () => boolean, modes?: string[] (controller ids it applies to; default ['foot']) }
   * @returns handle with remove()
   */
  add(o) { const item = { radius: 3, verb: 'Use', modes: ['foot'], ...o }; this.items.add(item); item.remove = () => { this.items.delete(item); if (this.focus === item) this.focus = null; }; return item; }

  update(position, activeId, input) {
    let best = null, bestD = Infinity;
    for (const it of this.items) {
      if (!it.modes.includes(activeId)) continue;
      if (it.enabled && !it.enabled()) continue;
      const p = typeof it.position === 'function' ? it.position(this._p) : it.position;
      const d = p.distanceTo(position) - it.radius;
      if (d < 0 && d < bestD) { best = it; bestD = d; }
    }
    if (best !== this.focus) { this.focus = best; this.ctx.events.emit('interact:focus', best); }
    if (best && input.pressed('interact')) { try { best.onUse(); } catch (e) { console.error(e); } this.ctx.events.emit('interact:use', best); }
  }

  clear() { this.items.clear(); if (this.focus) { this.focus = null; this.ctx.events.emit('interact:focus', null); } }
}

/**
 * Static colliders (buildings, big rocks, trunks) on a spatial hash.  Shapes are upright prisms/cylinders whose
 * axis is the local "up", so characters can be pushed out sideways or stand on top:
 *   addCylinder({ base: Vector3 (centre of the bottom), up: Vector3 (unit), radius, height })
 *   addBox({ base: Vector3 (centre of the bottom face), up, forward: Vector3 (unit, ⟂ up), halfX, halfZ, height })
 * Each add* returns a handle with remove().  Use group tags + removeGroup(tag) to drop a whole chunk/site at once.
 */
export class Colliders {
  constructor(cell = 48) { this.cell = cell; this.grid = new Map(); this.count = 0; this._q = []; this._seen = new Set(); this._v = new THREE.Vector3(); this._r = new THREE.Vector3(); }

  _key(x, y, z) { return (Math.floor(x / this.cell) * 73856093) ^ (Math.floor(y / this.cell) * 19349663) ^ (Math.floor(z / this.cell) * 83492791); }

  _insert(s, reach) {
    const c = this.cell, b = s.base, keys = new Set();
    for (let x = b.x - reach; x <= b.x + reach + c; x += c) for (let y = b.y - reach; y <= b.y + reach + c; y += c) for (let z = b.z - reach; z <= b.z + reach + c; z += c) keys.add(this._key(Math.min(x, b.x + reach), Math.min(y, b.y + reach), Math.min(z, b.z + reach)));
    s._keys = keys;
    for (const k of keys) { let a = this.grid.get(k); if (!a) this.grid.set(k, (a = [])); a.push(s); }
    this.count++;
    s.remove = () => { for (const k of s._keys) { const a = this.grid.get(k); if (a) { const i = a.indexOf(s); if (i >= 0) a.splice(i, 1); if (!a.length) this.grid.delete(k); } } this.count--; };
    return s;
  }

  addCylinder({ base, up, radius, height, group = null, solid = true }) {
    return this._insert({ type: 'cyl', base: base.clone(), up: up.clone().normalize(), radius, height, group, solid }, Math.max(radius, height));
  }

  addBox({ base, up, forward, halfX, halfZ, height, group = null, solid = true }) {
    const u = up.clone().normalize(), f = forward.clone().addScaledVector(u, -forward.dot(u)).normalize(), r = new THREE.Vector3().crossVectors(f, u).normalize();
    return this._insert({ type: 'box', base: base.clone(), up: u, forward: f, right: r, halfX, halfZ, height, group, solid }, Math.max(Math.hypot(halfX, halfZ), height));
  }

  removeGroup(group) { const all = new Set(); for (const a of this.grid.values()) for (const s of a) if (s.group === group) all.add(s); for (const s of all) s.remove(); }
  clear() { this.grid.clear(); this.count = 0; }

  /** Shapes whose cells touch a sphere at pos. */
  query(pos, radius = 2, out = this._q) {
    out.length = 0; this._seen.clear(); const c = this.cell;
    for (let x = pos.x - radius; x <= pos.x + radius + c; x += c) for (let y = pos.y - radius; y <= pos.y + radius + c; y += c) for (let z = pos.z - radius; z <= pos.z + radius + c; z += c) {
      const a = this.grid.get(this._key(Math.min(x, pos.x + radius), Math.min(y, pos.y + radius), Math.min(z, pos.z + radius)));
      if (a) for (const s of a) if (!this._seen.has(s)) { this._seen.add(s); out.push(s); }
    }
    return out;
  }

  /**
   * Resolve an upright capsule/cylinder (feet at pos, given radius & height) against nearby shapes.
   * Mutates pos (pushes it out sideways).  Returns { hit, floor } where floor = height (m, along `up` from pos)
   * of the highest walkable top under the body, or -Infinity.  stepHeight lets the body climb small ledges.
   */
  resolve(pos, up, radius = 0.4, height = 1.8, stepHeight = 0.45) {
    const shapes = this.query(pos, radius + 1), v = this._v, res = (this._res ??= { hit: false, floor: -Infinity });
    res.hit = false; res.floor = -Infinity;
    for (const s of shapes) {
      if (!s.solid) continue;
      v.copy(pos).sub(s.base);
      const y = v.dot(s.up);                        // feet height relative to the shape's base
      if (y > s.height + 0.05 + 4) continue;        // far above
      if (y + height < 0) continue;                 // entirely below
      if (s.type === 'cyl') {
        const hx = v.x - s.up.x * y, hy = v.y - s.up.y * y, hz = v.z - s.up.z * y; const d = Math.hypot(hx, hy, hz);
        if (d > s.radius + radius) continue;
        if (y >= s.height - stepHeight) { if (d < s.radius + radius * 0.3) res.floor = Math.max(res.floor, s.height - y); continue; }
        const push = (s.radius + radius - d); const inv = d > 1e-5 ? 1 / d : 0;
        if (inv === 0) { this._r.crossVectors(s.up, new THREE.Vector3(1, 0, 0)).normalize(); pos.addScaledVector(this._r, push); }
        else { pos.x += hx * inv * push; pos.y += hy * inv * push; pos.z += hz * inv * push; }
        res.hit = true;
      } else {
        const lx = v.dot(s.right), lz = v.dot(s.forward);
        const ox = s.halfX + radius - Math.abs(lx), oz = s.halfZ + radius - Math.abs(lz);
        if (ox <= 0 || oz <= 0) continue;
        if (y >= s.height - stepHeight) { if (Math.abs(lx) < s.halfX + radius * 0.3 && Math.abs(lz) < s.halfZ + radius * 0.3) res.floor = Math.max(res.floor, s.height - y); continue; }
        if (ox < oz) pos.addScaledVector(s.right, Math.sign(lx || 1) * ox); else pos.addScaledVector(s.forward, Math.sign(lz || 1) * oz);
        res.hit = true;
      }
    }
    return res;
  }
}
