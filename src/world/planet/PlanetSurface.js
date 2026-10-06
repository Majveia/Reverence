// PlanetSurface — CPU source of truth for the shape and biomes of a rocky body.
// OWNED BY THE TERRAIN TRACK. Every other track uses it read-only for placement & physics:
//
//   surface.height(x, y, z)          meters relative to body.radius at unit direction (x,y,z)
//   surface.heightLod(x, y, z, lod)  cheaper height without octaves finer than `lod` meters
//   surface.sample(x, y, z, out)     { height, biome, moisture, temperature, slope, rock, sand,
//                                      snow, cliff, river, lake, mountain, continental, dune,
//                                      talus (rubble apron at wall feet: keep grass off it) }
//   surface.normal(dir, out, eps)    geometric normal (finite differences), unit
//   surface.seaLevel                 meters (0 if ocean present, -Infinity otherwise)
//   surface.maxHeight / minHeight    approx relief bounds (m)
//   surface.amp                      terrain amplitude (m)
//   surface.biomeColor(biome, out)   THREE.Color (linear) from the art-direction palette
//   surface.BIOMES / BIOMES export   biome ids
//   surface.addFlatten({dir, radius, height, falloff}) → id   grade terrain flat (plazas, pads);
//   surface.removeFlatten(id), surface.flats, surface.onFlattenChange(cb)
//
// The actual landform generator lives in SurfaceGen.js (THREE-free, worker-safe) — terrain
// workers import it directly and produce bit-identical heights.
import * as THREE from 'three';
import { SurfaceGen, BIOMES, BIOME_NAMES, LOD_MIN, surfaceConfig, registerLiveSurface } from './SurfaceGen.js';

export { BIOMES, BIOME_NAMES, LOD_MIN, surfaceConfig };

const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _d = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

export class PlanetSurface extends SurfaceGen {
  /** @param body planet/moon data from Universe */
  constructor(body) {
    super(surfaceConfig(body));
    this.body = body;
    this.BIOMES = BIOMES;
    this._colCache = new Map();
    registerLiveSurface(body, this);
  }

  /** Geometric surface normal at a direction (finite differences over `eps` meters). */
  normal(dir, out = new THREE.Vector3(), eps = 2.0) {
    const d = _d.copy(dir).normalize();
    const ref = Math.abs(d.y) > 0.99 ? _t1.set(1, 0, 0) : _t1.set(0, 1, 0);
    const t1 = _t2.crossVectors(ref, d).normalize();
    const t2 = _t1.crossVectors(d, t1);
    const a = eps / this.radius;
    const P = (x, y, z, o) => {
      const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
      const r = this.radius + this.height(x, y, z);
      return o.set(x * r, y * r, z * r);
    };
    const p0 = P(d.x, d.y, d.z, _a);
    const p1 = P(d.x + t1.x * a, d.y + t1.y * a, d.z + t1.z * a, _b).sub(p0);
    const p2 = P(d.x + t2.x * a, d.y + t2.y * a, d.z + t2.z * a, _c).sub(p0);
    out.crossVectors(p1, p2).normalize();
    if (out.dot(d) < 0) out.negate();
    return out;
  }

  /** Representative (linear) color of a biome from the art palette. */
  biomeColor(biome, out = new THREE.Color()) {
    const hit = this._colCache.get(biome);
    if (hit) return out.copy(hit);
    const p = this.body.art?.palette || {};
    const B = BIOMES;
    const map = {
      [B.OCEAN]: p.deep ?? p.sand, [B.BEACH]: p.sand, [B.DESERT]: p.sand, [B.SAVANNA]: p.grass2, [B.GRASSLAND]: p.grass,
      [B.FOREST]: p.flora?.[0] ?? p.grass, [B.JUNGLE]: p.flora?.[1] ?? p.grass, [B.TAIGA]: p.flora?.[0] ?? p.grass,
      [B.TUNDRA]: p.grass2, [B.SNOW]: p.snow, [B.ROCK]: p.rock, [B.VOLCANIC]: '#2a2220', [B.CRYSTAL]: p.accent ?? p.grass2,
      [B.TOXIC]: p.grass,
    };
    const c = new THREE.Color();
    try { c.set(map[biome] ?? p.rock ?? '#8a8070'); } catch (_) { c.set('#8a8070'); }
    this._colCache.set(biome, c);
    return out.copy(c);
  }
}

export { SurfaceGen };
