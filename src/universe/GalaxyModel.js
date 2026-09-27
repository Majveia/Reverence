// GalaxyModel: deterministic star distribution for a galaxy. SHARED SOURCE OF TRUTH:
//  - GalaxyMode renders stars from it (star index i ↔ clickable star i ↔ Universe.star(g, i))
//  - SystemMode's sky renders the same galaxy as seen from the current star (Milky-Way band)
// Owned by the GALAXY track; other tracks call it read-only.
//
// Units: light-years, galaxy centered at origin, disk in XZ plane (+Y = galactic north).
import { hash32, hashCombine } from '../core/rng.js';

const U = (h) => (h >>> 0) / 4294967296;

// Stellar classes with (relative display weight, temperature range K, luminosity (L☉) range, radius (R☉))
export const STAR_CLASSES = {
  O: { temp: [30000, 45000], lum: [3e4, 8e5], rad: [6.6, 15], weight: 0.004 },
  B: { temp: [10000, 30000], lum: [25, 3e4], rad: [1.8, 6.6], weight: 0.03 },
  A: { temp: [7500, 10000], lum: [5, 25], rad: [1.4, 1.8], weight: 0.06 },
  F: { temp: [6000, 7500], lum: [1.5, 5], rad: [1.15, 1.4], weight: 0.1 },
  G: { temp: [5200, 6000], lum: [0.6, 1.5], rad: [0.96, 1.15], weight: 0.18 },
  K: { temp: [3700, 5200], lum: [0.08, 0.6], rad: [0.7, 0.96], weight: 0.24 },
  M: { temp: [2400, 3700], lum: [0.001, 0.08], rad: [0.1, 0.7], weight: 0.386 },
};
const CLASS_ORDER = ['O', 'B', 'A', 'F', 'G', 'K', 'M'];

function pickClass(u, youngBias) {
  // youngBias 0..1 shifts probability toward hot blue stars (spiral arms / star-forming regions)
  let total = 0;
  const w = CLASS_ORDER.map((c, i) => {
    const base = STAR_CLASSES[c].weight;
    const boost = youngBias > 0 ? Math.pow(1 + youngBias * 6, (6 - i) / 6) : Math.pow(1.5, (i - 3) / 3);
    const v = base * boost; total += v; return v;
  });
  let r = u * total;
  for (let i = 0; i < w.length; i++) { if ((r -= w[i]) <= 0) return CLASS_ORDER[i]; }
  return 'M';
}

function gauss(h1, h2) {
  const u = Math.max(1e-9, U(h1)), v = U(h2);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Star i of galaxy g (galaxy = Universe.galaxy(k) data object).
 * Returns { x, y, z, cls, temperature, luminosity, radiusSolar, component }
 */
export function galaxyStar(galaxy, i, out = {}) {
  const s = hashCombine(galaxy.seed, i);
  const h = (k) => hash32(s + k * 0x9e3779b1);
  const R = galaxy.radius;             // ly
  const type = galaxy.type;
  const comp = U(h(1));
  let x = 0, y = 0, z = 0, young = 0, component = 'disk';

  if (type === 'elliptical') {
    // Sérsic-ish triaxial spheroid
    const r = R * 0.5 * Math.pow(U(h(2)), 1.8) / (1 - 0.8 * U(h(3)));
    const ct = U(h(4)) * 2 - 1, ph = U(h(5)) * Math.PI * 2, st = Math.sqrt(1 - ct * ct);
    x = r * st * Math.cos(ph); y = r * ct * galaxy.flatten; z = r * st * Math.sin(ph) * 0.85;
    component = 'spheroid';
  } else if (comp < galaxy.bulgeFrac) {
    // bulge: exponential sphere, slightly flattened; bar stretch
    const r = -Math.log(Math.max(1e-6, U(h(2)))) * R * 0.06;
    const ct = U(h(4)) * 2 - 1, ph = U(h(5)) * Math.PI * 2, st = Math.sqrt(1 - ct * ct);
    x = r * st * Math.cos(ph); y = r * ct * 0.6; z = r * st * Math.sin(ph);
    if (galaxy.barLength > 0) { x *= 1 + galaxy.barLength * 2.2; z *= 0.7; }
    component = 'bulge';
  } else if (comp < galaxy.bulgeFrac + galaxy.haloFrac) {
    const r = R * (0.2 + 1.3 * Math.pow(U(h(2)), 0.6));
    const ct = U(h(4)) * 2 - 1, ph = U(h(5)) * Math.PI * 2, st = Math.sqrt(1 - ct * ct);
    x = r * st * Math.cos(ph); y = r * ct * 0.8; z = r * st * Math.sin(ph);
    component = 'halo';
  } else {
    // disk with logarithmic spiral arms (density-wave), exponential radial profile
    const scaleLen = R * 0.28;
    let r = -Math.log(Math.max(1e-6, 1 - U(h(2)) * (1 - Math.exp(-R / scaleLen)))) * scaleLen;
    r = Math.max(r, R * 0.03);
    const inArm = U(h(6)) < galaxy.armStrength;
    let theta = U(h(7)) * Math.PI * 2;
    if (inArm && galaxy.arms > 0 && type !== 'irregular') {
      const arm = Math.floor(U(h(8)) * galaxy.arms);
      const pitch = galaxy.pitch * Math.PI / 180;
      const r0 = R * 0.08 + galaxy.barLength * R * 0.25;
      theta = Math.log(Math.max(r, r0) / r0) / Math.tan(pitch) + arm * (Math.PI * 2 / galaxy.arms) + galaxy.rotation;
      const spread = 0.35 * (0.4 + 0.6 * (1 - r / R));
      theta += gauss(h(9), h(10)) * spread * 0.5;
      r *= 1 + gauss(h(11), h(12)) * 0.05;
      young = 0.6 + 0.4 * U(h(13));
      component = 'arm';
    } else if (type === 'irregular') {
      theta += Math.sin(r * 0.0003 + galaxy.rotation) * 1.3;
      young = 0.5 * U(h(13));
    } else if (type === 'ring') {
      r = R * (0.62 + gauss(h(11), h(12)) * 0.06);
      young = 0.7;
      component = 'ring';
    }
    x = r * Math.cos(theta); z = r * Math.sin(theta);
    const thick = galaxy.thickness * (young > 0.5 ? 0.45 : 1.0) * (0.5 + 0.5 * Math.exp(-r / (R * 0.5)));
    y = gauss(h(14), h(15)) * thick;
  }

  const cls = pickClass(U(h(20)), young);
  const c = STAR_CLASSES[cls];
  const f = U(h(21));
  out.x = x; out.y = y; out.z = z;
  out.cls = cls;
  out.temperature = c.temp[0] + (c.temp[1] - c.temp[0]) * f;
  out.luminosity = c.lum[0] * Math.pow(c.lum[1] / c.lum[0], f);
  out.radiusSolar = c.rad[0] + (c.rad[1] - c.rad[0]) * f;
  out.component = component;
  out.young = young;
  return out;
}
