// PlanetSurface — CPU source of truth for the shape and biomes of a rocky body.
// OWNED BY THE TERRAIN TRACK. Every other track uses it read-only for placement & physics:
//
//   surface.height(x, y, z)          meters relative to body.radius at unit direction (x,y,z)
//   surface.sample(x, y, z, out)     { height, biome, moisture, temperature, slope?(if computed), rock }
//   surface.normal(dir, out, eps)    geometric normal (finite differences), unit
//   surface.seaLevel                 meters (0 if ocean present, -Infinity otherwise)
//   surface.maxHeight                approx max relief (m)
//   surface.biomeColor(biome)        THREE.Color (linear) from the art-direction palette
//
// MUST be deterministic and worker-safe (no DOM, no THREE scene access) so terrain workers can
// import it. Keep it fast: it's called ~10^6 times per second while streaming.
import * as THREE from 'three';
import { Noise } from '../../core/noise.js';

export const BIOMES = {
  OCEAN: 0, BEACH: 1, DESERT: 2, SAVANNA: 3, GRASSLAND: 4, FOREST: 5,
  JUNGLE: 6, TAIGA: 7, TUNDRA: 8, SNOW: 9, ROCK: 10, VOLCANIC: 11, CRYSTAL: 12, TOXIC: 13,
};
export const BIOME_NAMES = Object.fromEntries(Object.entries(BIOMES).map(([k, v]) => [v, k.toLowerCase()]));

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class PlanetSurface {
  /** @param body planet/moon data from Universe */
  constructor(body) {
    this.body = body;
    this.radius = body.radius;
    const T = body.terrain;
    this.amp = T.amplitude;
    this.maxHeight = T.amplitude * 1.1;
    this.cf = T.continentFreq;
    this.ms = T.mountainScale;
    this.hasOcean = body.ocean.present;
    this.seaLevel = this.hasOcean ? 0 : -Infinity;
    // bias so that roughly oceanFraction of the surface lies below sea level
    this.oceanBias = this.hasOcean ? (T.oceanFraction - 0.5) * 0.9 : -0.6;
    this.n1 = new Noise(body.seed);
    this.n2 = new Noise(body.seed ^ 0x5bd1e995);
    this.n3 = new Noise(body.seed ^ 0x2545f491);
    this.type = body.type;
    this.features = new Set(T.features || []);
    // detail frequency in "per unit sphere" terms so features have real-world sizes
    this.fDetail = this.radius / 900;   // ~900 m hills
    this.fFine = this.radius / 90;      // ~90 m bumps
  }

  height(x, y, z) {
    const n1 = this.n1, n2 = this.n2, cf = this.cf;
    // domain warp for organic continents
    const wx = n2.noise3(x * 1.3 + 3.1, y * 1.3, z * 1.3) * 0.35;
    const wy = n2.noise3(x * 1.3, y * 1.3 + 7.7, z * 1.3) * 0.35;
    const wz = n2.noise3(x * 1.3, y * 1.3, z * 1.3 + 1.9) * 0.35;
    let c = n1.fbm3((x + wx) * cf, (y + wy) * cf, (z + wz) * cf, 5, 2.0, 0.5) - this.oceanBias;
    // continental shelf shaping: flatten near 0 for coastlines, steeper inland
    const land = smooth(-0.02, 0.25, c);
    let h = c < 0 ? c * 0.55 : c * 0.35;
    // mountains: ridged, masked to land interior
    const mr = n2.ridged3(x * 3.2 * this.ms, y * 3.2 * this.ms, z * 3.2 * this.ms, 5, 2.1, 0.5);
    h += mr * mr * 1.1 * land * this.ms;
    // hills & detail
    const fd = this.fDetail;
    h += n1.fbm3(x * fd, y * fd, z * fd, 3) * 0.035 * (0.3 + land);
    const ff = this.fFine;
    h += this.n3.noise3(x * ff, y * ff, z * ff) * 0.004;
    // feature shaping
    if (this.features.has('mesas') || this.features.has('terraces') || this.features.has('plateaus')) {
      if (h > 0.05) { const steps = 7; const t = h * steps; const fl = Math.floor(t); h = (fl + smooth(0.75, 1.0, t - fl)) / steps; }
    }
    if (this.features.has('dunes') && h > 0) {
      const d = 1 - Math.abs(n2.noise3(x * this.radius / 350, y * this.radius / 900, z * this.radius / 350));
      h += d * d * 0.006 * smooth(0.0, 0.1, h);
    }
    return h * this.amp;
  }

  sample(x, y, z, out = {}) {
    const h = this.height(x, y, z);
    const lat = Math.abs(y);
    const hn = Math.max(0, h) / this.amp;
    const temperature = 1 - lat * 1.05 - hn * 0.9 + this.n3.noise3(x * 2, y * 2, z * 2) * 0.12;
    const moisture = 0.5 + 0.5 * this.n2.fbm3(x * 2.3 + 11, y * 2.3, z * 2.3, 3) + (this.hasOcean ? 0.1 : -0.25);
    out.height = h; out.temperature = temperature; out.moisture = moisture;
    out.biome = this.classify(h, temperature, moisture);
    return out;
  }

  classify(h, t, m) {
    const B = BIOMES;
    if (this.hasOcean && h < this.seaLevel) return B.OCEAN;
    if (this.type === 'volcanic') return h > this.amp * 0.5 ? B.ROCK : B.VOLCANIC;
    if (this.type === 'crystal' && m > 0.55) return B.CRYSTAL;
    if (this.type === 'toxic' && m > 0.45) return B.TOXIC;
    if (this.type === 'barren') return h > this.amp * 0.45 ? B.ROCK : B.DESERT;
    if (this.hasOcean && h < 12) return B.BEACH;
    if (t < 0.1) return B.SNOW;
    if (h > this.amp * 0.62) return t < 0.3 ? B.SNOW : B.ROCK;
    if (t < 0.25) return B.TUNDRA;
    if (t < 0.4) return m > 0.45 ? B.TAIGA : B.TUNDRA;
    if (m < 0.28) return B.DESERT;
    if (m < 0.42) return B.SAVANNA;
    if (t > 0.72 && m > 0.62) return B.JUNGLE;
    if (m > 0.55) return B.FOREST;
    return B.GRASSLAND;
  }

  normal(dir, out = new THREE.Vector3(), eps = 2.0) {
    // tangent basis
    const d = dir.clone().normalize();
    const ref = Math.abs(d.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const t1 = new THREE.Vector3().crossVectors(ref, d).normalize();
    const t2 = new THREE.Vector3().crossVectors(d, t1);
    const a = eps / this.radius;
    const P = (v) => { const u = v.clone().normalize(); return u.multiplyScalar(this.radius + this.height(u.x, u.y, u.z)); };
    const p0 = P(d);
    const p1 = P(d.clone().addScaledVector(t1, a));
    const p2 = P(d.clone().addScaledVector(t2, a));
    return out.crossVectors(p1.sub(p0), p2.sub(p0)).normalize();
  }

  biomeColor(biome, out = new THREE.Color()) {
    const p = this.body.art.palette;
    const B = BIOMES;
    const map = {
      [B.OCEAN]: p.sand, [B.BEACH]: p.sand, [B.DESERT]: p.sand, [B.SAVANNA]: p.grass2, [B.GRASSLAND]: p.grass,
      [B.FOREST]: p.flora?.[0] ?? p.grass, [B.JUNGLE]: p.flora?.[1] ?? p.grass, [B.TAIGA]: p.flora?.[0] ?? p.grass,
      [B.TUNDRA]: p.grass2, [B.SNOW]: p.snow, [B.ROCK]: p.rock, [B.VOLCANIC]: '#2a2220', [B.CRYSTAL]: p.grass2, [B.TOXIC]: p.grass,
    };
    return out.set(map[biome] ?? p.rock);
  }
}
