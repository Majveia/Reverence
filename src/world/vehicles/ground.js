// Ground probe for vehicles: CPU terrain height (world.surface = source of truth), liquid surface
// (sea level, or the water track's wave height if it exposes one), normals and biome colors.
// Never raycasts the GPU mesh (ARCHITECTURE rule).
import * as THREE from 'three';
import { tangentBasis } from './util.js';

const _e = new THREE.Vector3(), _n = new THREE.Vector3(), _u = new THREE.Vector3();
const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3();

export class Ground {
  constructor(world) {
    this.world = world;
    this.S = world.surface || null;
    this.R = world.body.radius;
    const oc = world.body.ocean;
    this.hasOcean = !!(this.S && oc?.present && Number.isFinite(this.S.seaLevel) && this.S.seaLevel > -1e8);
    this.sea = this.hasOcean ? this.S.seaLevel : -Infinity;
    this.liquid = oc?.liquid || 'water';
    this.onWater = false;
    this.waterDepth = 0;
    this._s = {};
    this._water = null;
    this._waterCheckT = -1;
  }

  /** Terrain height (m, relative to radius) under any planet-local point (need not be unit length). */
  terrainH(x, y, z) {
    if (!this.S) return 0;
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    return this.S.height(x / l, y / l, z / l);
  }
  terrainAt(p) { return this.terrainH(p.x, p.y, p.z); }

  _waterSys() {
    // re-resolve occasionally: the water subsystem may appear later / expose different APIs
    const t = this.world.time;
    if (t - this._waterCheckT > 2 || this._waterCheckT < 0) {
      this._waterCheckT = t;
      const w = this.world.get?.('water');
      this._water = w && (typeof w.heightAt === 'function' || typeof w.surfaceHeight === 'function') ? w : null;
    }
    return this._water;
  }

  /** Liquid surface height (m rel. radius) at p, or -Infinity when the body has no ocean. */
  waterAt(p) {
    if (!this.hasOcean) return -Infinity;
    const w = this._waterSys();
    if (w) {
      try {
        const h = typeof w.heightAt === 'function' ? w.heightAt(p) : w.surfaceHeight(p);
        if (Number.isFinite(h) && Math.abs(h - this.sea) < 50) return h;
      } catch (_) { /* fall back */ }
    }
    return this.sea;
  }

  /** Height of whatever supports a hovering craft (terrain or liquid). Sets onWater / waterDepth. */
  supportAt(p) {
    const t = this.terrainH(p.x, p.y, p.z);
    if (this.hasOcean) {
      const w = this.waterAt(p);
      if (w > t) { this.onWater = true; this.waterDepth = w - t; return w; }
    }
    this.onWater = false; this.waterDepth = 0;
    return t;
  }

  /** Solid ground normal (outward, unit) at p via finite differences over `eps` meters. */
  normalAt(p, eps, out, withWater = false) {
    const up = _u.copy(p).normalize();
    tangentBasis(up, _e, _n);
    const R = this.R;
    const hf = withWater ? (q) => this.supportAt(q) : (q) => this.terrainH(q.x, q.y, q.z);
    const h0 = hf(up);
    _p0.copy(up).multiplyScalar(R + h0);
    _p1.copy(up).multiplyScalar(R).addScaledVector(_e, eps); const h1 = hf(_p1); _p1.normalize().multiplyScalar(R + h1);
    _p2.copy(up).multiplyScalar(R).addScaledVector(_n, eps); const h2 = hf(_p2); _p2.normalize().multiplyScalar(R + h2);
    _p1.sub(_p0); _p2.sub(_p0);
    out.crossVectors(_p1, _p2);
    if (out.lengthSq() < 1e-12) return out.copy(up);
    out.normalize();
    if (out.dot(up) < 0) out.negate();
    return out;
  }

  /** Biome info at p (cheap enough every few frames). */
  sample(p) {
    if (!this.S) return null;
    const l = p.length() || 1;
    try { return this.S.sample(p.x / l, p.y / l, p.z / l, this._s); } catch (_) { return null; }
  }

  /** Dust / debris color for the ground at p (linear THREE.Color). */
  dustColor(p, out) {
    const s = this.sample(p);
    if (!s || !this.S.biomeColor) return out.set(0.55, 0.48, 0.38);
    try { this.S.biomeColor(s.biome, out); } catch (_) { out.set(0.55, 0.48, 0.38); }
    // dust is lighter & less saturated than the living surface color (kicked-up soil + pollen)
    const l = out.r * 0.3 + out.g * 0.59 + out.b * 0.11;
    out.r = out.r * 0.4 + l * 0.6; out.g = out.g * 0.4 + l * 0.6; out.b = out.b * 0.4 + l * 0.6;
    // bias toward a warm pale soil tone so dust reads against vegetation
    out.r = out.r * 0.7 + 0.62 * 0.3; out.g = out.g * 0.7 + 0.55 * 0.3; out.b = out.b * 0.7 + 0.44 * 0.3;
    return out.multiplyScalar(1.5);
  }

  /** True if the body has a real solid surface. */
  get solid() { return !!this.S; }
}
