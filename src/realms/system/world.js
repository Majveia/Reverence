// World: geometric queries against the active planet.  Scene space == the planet-fixed frame, origin at the
// planet's centre, so "up" is simply the normalised position.  All methods are allocation-free when given `out`.
import * as THREE from 'three';
import { createHeightField } from '../../planet/heightfield.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

export class World {
  constructor(body) {
    this.body = body;
    /** The planet's canonical height function (see src/planet/heightfield.js). */
    this.field = createHeightField(body);
    this.radius = body.radius;
    this.amplitude = this.field.amplitude;
    this.hasOcean = !!body.ocean;
    /** Sea-surface radius (m from centre), or 0 when the world has no ocean. */
    this.seaRadius = this.hasOcean ? body.radius + this.field.seaHeight : 0;
    this.hasAtmosphere = !!body.atmosphere;
    this.atmosphereRadius = this.hasAtmosphere ? body.radius * (1 + body.atmosphere.height) : body.radius;
    this.gravity = body.gravity;
    this.sites = this.field.sites;
    this.theme = body.theme;
  }

  /** Unit radial direction at pos. */
  up(pos, out = new THREE.Vector3()) { return out.copy(pos).normalize(); }

  /** Terrain radius (m from centre) beneath/above pos. */
  surfaceRadius(pos) { const l = pos.length() || 1; return this.radius + this.field.height(pos.x / l, pos.y / l, pos.z / l); }
  surfaceRadiusDir(x, y, z) { return this.radius + this.field.height(x, y, z); }

  /** Height of pos above the terrain (negative = underground). */
  altitude(pos) { return pos.length() - this.surfaceRadius(pos); }

  /** Height above whichever is higher: terrain or sea. */
  clearance(pos) { const l = pos.length(); return l - Math.max(this.surfaceRadius(pos), this.seaRadius); }

  /** Height of pos above sea level (or above the base radius on dry worlds). */
  heightAboveSea(pos) { return pos.length() - (this.hasOcean ? this.seaRadius : this.radius); }

  isUnderwater(pos) { return this.hasOcean && pos.length() < this.seaRadius; }

  /** Project pos radially onto the terrain (+offset metres). */
  groundPoint(pos, out = new THREE.Vector3(), offset = 0) { const r = this.surfaceRadius(pos) + offset; return out.copy(pos).setLength(r); }

  /** Orthonormal tangent frame at pos: east, north, up. */
  basis(pos, east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3()) {
    up.copy(pos).normalize();
    east.set(0, 1, 0).cross(up); if (east.lengthSq() < 1e-8) east.set(1, 0, 0); east.normalize();
    north.copy(up).cross(east).normalize();
    return { east, north, up };
  }

  /** Terrain normal at pos from central differences, sample spacing eps metres. */
  normal(pos, out = new THREE.Vector3(), eps = 1.5) {
    const { east, north, up } = this.basis(pos, _a, _b, _c);
    const l = pos.length();
    const hE = this.surfaceRadius(_d.copy(pos).addScaledVector(east, eps)), hW = this.surfaceRadius(_d.copy(pos).addScaledVector(east, -eps));
    const hN = this.surfaceRadius(_d.copy(pos).addScaledVector(north, eps)), hS = this.surfaceRadius(_d.copy(pos).addScaledVector(north, -eps));
    void l;
    return out.copy(up).multiplyScalar(2 * eps).addScaledVector(east, hW - hE).addScaledVector(north, hS - hN).normalize();
  }

  /** Slope 0 (flat) … 1 (vertical) at pos. */
  slope(pos) { const n = this.normal(pos, _d); return 1 - Math.max(0, n.dot(_a.copy(pos).normalize())); }

  /**
   * March a ray against terrain (and optionally sea).  Returns distance to the hit, or -1.
   * Robust enough for cameras, vehicles and placement; not a physics-grade exact intersection.
   */
  raycast(origin, dir, maxDist = 2000, { sea = false, step = 0.6 } = {}) {
    let t = 0;
    for (let i = 0; i < 96 && t < maxDist; i++) {
      _d.copy(origin).addScaledVector(dir, t);
      const h = sea ? this.clearance(_d) : this.altitude(_d);
      if (h < 0.02) {
        // refine by bisection
        let lo = Math.max(0, t - Math.max(1, t * 0.08)), hi = t;
        for (let k = 0; k < 8; k++) { const m = (lo + hi) * 0.5; _d.copy(origin).addScaledVector(dir, m); if ((sea ? this.clearance(_d) : this.altitude(_d)) < 0) hi = m; else lo = m; }
        return hi;
      }
      t += Math.max(0.25, h * step);
    }
    return -1;
  }

  /** Scene position of a site (surface), raised by `lift` metres. */
  sitePosition(site, out = new THREE.Vector3(), lift = 0) { return out.set(site.dir[0], site.dir[1], site.dir[2]).multiplyScalar(this.radius + site.height + lift); }

  /** Scene position for a unit direction, on the terrain, raised by lift. */
  surfacePosition(x, y, z, out = new THREE.Vector3(), lift = 0) { return out.set(x, y, z).normalize().multiplyScalar(this.radius + this.field.height(out.x, out.y, out.z) + lift); }
}
