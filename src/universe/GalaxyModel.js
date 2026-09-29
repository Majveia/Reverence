// GalaxyModel — deterministic structure + stars of a galaxy. SHARED SOURCE OF TRUTH:
//  - GalaxyMode renders stars from it (star index i ↔ clickable star i ↔ Universe.star(g, i))
//  - SystemMode's sky can render the same galaxy as seen from the current star (Milky-Way band)
// Owned by the GALAXY track; other tracks call it read-only.
//
// Units: light-years, galaxy centered at origin, disk in XZ plane (+Y = galactic north).
// Canonical positions are the "pattern frame" at galactic time 0. In GalaxyMode the spiral
// pattern (arms, bar, clusters, nebulae, local stars) turns rigidly at the pattern speed, and
// old disk / bulge stars turn with the (flat) rotation curve — see rotationOmega / patternOmega.
//
// STAR INDEX SPACE
//   0 .. GLOBAL_STARS-1        representative population (render any prefix: a fair sample)
//   LOCAL_BASE + code          local-neighborhood stars, decodable to a 3-D cell (LOD):
//                              code = ((cy * GRID + cz) * GRID + cx) * LOCAL_K + k
// Class / temperature / luminosity / radius of global stars are bit-identical to the original
// placeholder model (showcase systems depend on them). Positions are the new structured model.
import { hash32, hashCombine, RNG } from '../core/rng.js';

const U = (h) => (h >>> 0) / 4294967296;
const TAU = Math.PI * 2;

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
export const CLASS_INDEX = { O: 0, B: 1, A: 2, F: 3, G: 4, K: 5, M: 6 };

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
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const sech2 = (x) => { const c = Math.cosh(Math.min(40, Math.abs(x))); return 1 / (c * c); };
// sample a sech²(y/h) vertical profile
const sech2Sample = (u, h) => h * Math.atanh(Math.min(0.9995, Math.max(-0.9995, 2 * u - 1)));

// ------------------------------------------------------------------ index space
export const GLOBAL_STARS = 1 << 22;
export const LOCAL_BASE = 1 << 30;
export const LOCAL_CELL = 200;               // ly (horizontal cell size)
export const LOCAL_GRID = 1024;              // cells per horizontal axis → ±102.4 kly
export const LOCAL_Y_EDGES = [-2400, -1200, -600, -200, 0, 200, 600, 1200, 2400]; // 8 vertical cells
export const LOCAL_K = 128;                  // max stars per cell
const LOCAL_HALF = LOCAL_GRID / 2;

export function localIndex(cx, cy, cz, k) {
  return LOCAL_BASE + (((cy * LOCAL_GRID + cz) * LOCAL_GRID + cx) * LOCAL_K + k);
}
export function isLocalStar(i) { return i >= LOCAL_BASE && i < LOCAL_BASE * 2; }
export function decodeLocal(i, out = {}) {
  let c = i - LOCAL_BASE;
  out.k = c % LOCAL_K; c = (c - out.k) / LOCAL_K;
  out.cx = c % LOCAL_GRID; c = (c - out.cx) / LOCAL_GRID;
  out.cz = c % LOCAL_GRID; c = (c - out.cz) / LOCAL_GRID;
  out.cy = c;
  return out;
}
/** Local cell containing a (pattern-frame) position in ly; returns null outside the grid. */
export function localCellOf(x, y, z, out = {}) {
  const cx = Math.floor(x / LOCAL_CELL) + LOCAL_HALF, cz = Math.floor(z / LOCAL_CELL) + LOCAL_HALF;
  if (cx < 0 || cz < 0 || cx >= LOCAL_GRID || cz >= LOCAL_GRID) return null;
  let cy = -1;
  for (let k = 0; k < 8; k++) if (y >= LOCAL_Y_EDGES[k] && y < LOCAL_Y_EDGES[k + 1]) { cy = k; break; }
  if (cy < 0) return null;
  out.cx = cx; out.cy = cy; out.cz = cz;
  return out;
}

// ------------------------------------------------------------------ shared hash / value noise
// Mirrored bit-exactly in GLSL (src/modes/galaxy/shaders/galaxyCommon.js): uint hash + value noise.
export function ihash2(x, y, seed) {
  return hash32((Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed) | 0);
}
export function vnoise2(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = ihash2(ix, iy, seed) / 4294967296, b = ihash2(ix + 1, iy, seed) / 4294967296;
  const c = ihash2(ix, iy + 1, seed) / 4294967296, d = ihash2(ix + 1, iy + 1, seed) / 4294967296;
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
export function fbm2(x, y, seed, oct) {
  let s = 0, a = 0.5, n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * vnoise2(x, y, (seed + o * 101) >>> 0); n += a;
    x = x * 2.03 + 17.1; y = y * 2.03 + 5.3; a *= 0.5;
  }
  return s / n;
}

// ------------------------------------------------------------------ structure
const _structs = new Map();

/**
 * Derived, deterministic structural parameters of a galaxy (cached). Everything here is a pure
 * function of the Universe galaxy record. Lengths in ly. Exposed for renderers (GalaxyMode,
 * night-sky renderers) — treat as read-only.
 */
export function galaxyStructure(galaxy) {
  const key = galaxy.seed + ':' + galaxy.index;
  let S = _structs.get(key);
  if (S) return S;
  S = buildStructure(galaxy);
  _structs.set(key, S);
  return S;
}

function buildStructure(g) {
  const r = new RNG(hashCombine(g.seed, 0x57c7));
  const R = g.radius, type = g.type;
  const spiralish = type === 'spiral' || type === 'barred' || type === 'ring';
  const S = { type, R, seed: g.seed >>> 0 };
  S.m = spiralish ? Math.max(1, g.arms | 0) : 0;
  S.pitch = g.pitch * Math.PI / 180;
  // Morphology variants from an independent hash (does not disturb the RNG stream below):
  //  barred → mostly 2 grand arms springing from the bar ends at an open pitch (NGC 1300 / 1365);
  //  ring   → 'cartwheel' (collisional ring + spokes + inner ring), 'hoag' (detached ring, no arms)
  //           or 'resonance' (inner ring + tightly wound arms + outer pseudo-ring).
  const hv = U(hash32(hashCombine(g.seed, 0xc0de)));
  if (type === 'barred') {
    if (hv < 0.8) S.m = 2;
    S.pitch = Math.max(S.pitch, (17 + 8 * U(hash32(hashCombine(g.seed, 0xb17c)))) * Math.PI / 180);
  }
  S.ringStyle = type === 'ring' ? (hv < 0.4 ? 'cartwheel' : hv < 0.7 ? 'hoag' : 'resonance') : null;
  if (S.ringStyle === 'hoag') S.m = 0;
  S.tanP = Math.tan(S.pitch); S.sinP = Math.sin(S.pitch);
  S.phi0 = g.rotation;
  S.seedWarp = hashCombine(g.seed, 0x3a39) >>> 0;
  S.seedFrag = hashCombine(g.seed, 0xf7a9) >>> 0;
  S.seedSite = hashCombine(g.seed, 0x5173) >>> 0;
  S.seedDust = hashCombine(g.seed, 0xd057) >>> 0;
  S.seedLocal = hashCombine(g.seed, 0x10ca1) >>> 0;

  // bar / rings / arm origin
  S.barA = type === 'barred' ? Math.max(0.1, g.barLength) * R * 1.35 : 0;   // semi-major axis
  S.barB = S.barA * r.range(0.26, 0.36) * 0.75;
  S.barC = S.barA * r.range(0.18, 0.26);
  S.ringIn = type === 'ring' ? R * r.range(0.3, 0.42) : 0;
  S.ringOut = type === 'ring' ? R * r.range(0.84, 0.95) : 0;
  S.r0 = type === 'barred' ? S.barA * 0.84 : type === 'ring' ? S.ringIn : R * r.range(0.07, 0.11);
  S.ringOff = [0, 0];                         // centre of the outer ring relative to the nucleus
  S.ringW = R * 0.03;                         // outer ring σ
  if (S.ringStyle === 'cartwheel') {
    // collisional ring: expanding outer ring (off-centre after the impact), inner ring round the
    // nucleus, faint spokes between (arm machinery with m spokes at a very open pitch)
    const h2 = (k) => U(hash32(hashCombine(g.seed, 0xca47 + k)));
    S.ringIn = R * (0.17 + 0.06 * h2(1));
    S.ringOut = R * (0.8 + 0.08 * h2(2));
    S.ringW = R * 0.034;
    const oa = h2(3) * TAU;
    S.ringOff = [Math.cos(oa) * R * 0.07, Math.sin(oa) * R * 0.07];
    S.m = 10 + Math.floor(h2(4) * 5);
    S.pitch = (66 + 10 * h2(5)) * Math.PI / 180;
    S.tanP = Math.tan(S.pitch); S.sinP = Math.sin(S.pitch);
    S.r0 = S.ringIn;
  } else if (S.ringStyle === 'hoag') {
    const h2 = (k) => U(hash32(hashCombine(g.seed, 0x40a6 + k)));
    S.ringIn = 0;
    S.ringOut = R * (0.62 + 0.1 * h2(1));
    S.ringW = R * (0.055 + 0.02 * h2(2));
  }

  // disk
  S.rd = R * (type === 'lenticular' ? r.range(0.2, 0.25) : r.range(0.25, 0.3)); // scale length (old disk)
  S.rdY = R * r.range(0.3, 0.38);                                             // young disk
  S.hOld = R * r.range(0.011, 0.015) * (0.75 + 0.25 * (g.thickness / 1100));  // sech² scale height
  S.hYoung = S.hOld * 0.22;
  S.hDust = S.hOld * 0.32;
  S.flare = r.range(0.5, 1.1);

  // spiral arms
  S.warpAmp = S.m ? r.range(0.14, 0.32) : 0;
  S.warpF = 1 / (R * r.range(0.22, 0.4));
  S.armW = R * r.range(0.013, 0.02) * (S.m <= 2 ? 1.45 : S.m === 3 ? 1.2 : 1);                 // young arm σ (perpendicular)
  S.fragAmp = S.m <= 2 ? r.range(0.1, 0.35) : r.range(0.35, 0.7);
  S.fragF = r.range(2.2, 4.2);
  S.armAmp = []; S.armEnd = [];
  for (let k = 0; k < Math.max(1, S.m); k++) {
    const strong = k < 2 || S.m <= 2;
    S.armAmp.push(strong ? r.range(0.85, 1) : r.range(0.4, 0.85));
    S.armEnd.push(R * (strong ? r.range(0.95, 1.15) : r.range(0.7, 1.05)));
  }
  if (S.ringStyle === 'cartwheel') {
    S.armW *= 0.45;
    // spokes run from the inner ring out to (not through) the collisional ring
    for (let k = 0; k < S.m; k++) { S.armEnd[k] = S.ringOut * 0.9; S.armAmp[k] = 0.35 + 0.45 * U(hash32(hashCombine(g.seed, 0x5b0c + k))); }
  }
  S.armCum = [];
  { let t = 0; for (const a of S.armAmp) { t += a; S.armCum.push(t); } for (let k = 0; k < S.armCum.length; k++) S.armCum[k] /= t; }
  S.spur = r.range(0.35, 1.0);
  S.floc = S.m >= 4 ? r.range(0.35, 0.8) : r.range(0.1, 0.45);

  // clusters / HII sites (jittered grid in the pattern plane)
  S.siteCell = R * 0.032;
  S.siteDensity = r.range(0.5, 0.8);
  S.hiiFrac = r.range(0.45, 0.8);
  S.clusterFrac = r.range(0.35, 0.6);

  // irregular clumps
  S.clumps = [];
  if (type === 'irregular') {
    const n = r.int(6, 12);
    const off = [r.range(-0.2, 0.2) * R, r.range(-0.2, 0.2) * R];
    for (let k = 0; k < n; k++) {
      const rr = R * Math.pow(r.next(), 0.8) * 0.75, a = r.range(0, TAU);
      S.clumps.push({ x: off[0] * 0.5 + rr * Math.cos(a), z: off[1] * 0.5 + rr * Math.sin(a) * 0.8, s: R * r.range(0.04, 0.13), w: r.range(0.4, 1) });
    }
    S.irrBar = { x: off[0], z: off[1], a: r.range(0, Math.PI), len: R * r.range(0.25, 0.45), w: R * r.range(0.05, 0.08) };
  }

  // bulge (sum of Plummer spheres ≈ Sérsic) and halo
  const big = type === 'lenticular' ? r.range(1.3, 2.0) : type === 'elliptical' ? 1 : r.range(0.8, 1.25);
  S.bulgeQ = type === 'lenticular' ? r.range(0.62, 0.8) : r.range(0.7, 0.92);
  S.bulgeComp = [
    { a: R * 0.006 * big, w: 0.12 },
    { a: R * 0.028 * big, w: 0.43 },
    { a: R * 0.085 * big, w: 0.45 },
  ];
  S.nucA = R * 0.0012;
  S.haloA = R * 0.32;
  S.ellA = R * r.range(0.085, 0.13);                      // elliptical Hernquist scale
  S.ellQ = [1, g.flatten, r.range(0.75, 0.95)];

  // dust
  let dust = { spiral: 1, barred: 1, ring: 0.85, lenticular: 0.12, elliptical: 0, irregular: 0.55 }[type] ?? 0.5;
  S.dustRing = null; S.dustLane = null;
  if (type === 'lenticular' && r.chance(0.75)) {   // Sombrero-like dust ring
    S.dustRing = { r: R * r.range(0.55, 0.78), w: R * r.range(0.05, 0.09), amp: r.range(1.0, 1.6) };
    dust = 0.35;
  }
  if (type === 'elliptical' && r.chance(0.4)) {   // Centaurus-A-like warped dust lane
    S.dustLane = { r: R * r.range(0.18, 0.28), w: R * r.range(0.05, 0.08), tilt: r.range(0.2, 0.7), yaw: r.range(0, Math.PI) };
  }
  S.dust = dust * r.range(0.8, 1.25);

  // shells (ellipticals)
  S.shells = [];
  if (type === 'elliptical' && r.chance(0.6)) {
    const n = r.int(3, 6), ax = r.range(0, TAU), ay = r.range(-0.4, 0.4);
    for (let k = 0; k < n; k++) S.shells.push({ r: R * (0.25 + 0.12 * k + r.range(0, 0.08)), side: k % 2 ? -1 : 1, open: r.range(0.5, 0.9), ax, ay });
  }

  // globular clusters
  const nGC = type === 'elliptical' ? r.int(220, 420) : type === 'lenticular' ? r.int(100, 200) : r.int(70, 160);
  S.gc = [];
  for (let k = 0; k < nGC; k++) {
    // power-law-ish spherical distribution
    const rr = R * Math.min(1.5, 0.04 + 0.5 * Math.pow(r.next(), 1.6) / Math.max(0.05, 1 - 0.85 * r.next()));
    const ct = r.range(-1, 1), ph = r.range(0, TAU), st = Math.sqrt(1 - ct * ct);
    S.gc.push({ x: rr * st * Math.cos(ph), y: rr * ct * 0.85, z: rr * st * Math.sin(ph), a: r.range(8, 30) });
  }

  // rotation: flat rotation curve, pattern rotates rigidly. Angles in rad per galactic-time second.
  // Negative = clockwise seen from +Y, which makes these log spirals trailing.
  S.patternPeriod = r.range(1000, 1600);
  S.omegaP = -TAU / S.patternPeriod;
  S.rc = R * r.range(0.65, 0.85);                 // corotation
  S.rt = R * 0.055;                               // rotation curve turnover
  S.v0 = Math.abs(S.omegaP) * S.rc / (1 - Math.exp(-S.rc / S.rt));

  // local LOD normalization (stars per ly³ → expected count). ~75 stars per mid-disk 200 ly cell.
  S.localNorm = 5e8 * (R / 55000) * (R / 55000);

  // palette (linear rgb) from the universe record
  const col = (c) => (c && c.isColor ? [c.r, c.g, c.b] : c ? [c.r, c.g, c.b] : [1, 1, 1]);
  S.colors = g.colors ? { core: col(g.colors.core), arms: col(g.colors.arms), hii: col(g.colors.hii), dust: col(g.colors.dust) } : null;
  S.blackHole = g.blackHole ? { mass: g.blackHole.mass, spin: g.blackHole.spin } : { mass: 4e6, spin: 0.6 };
  S._sites = new Map();
  return S;
}

// ------------------------------------------------------------------ arms & young structure
const _ai = { r: 0, k: 0, dperp: 0, u: 0 };

/** Nearest-arm info at pattern-frame (x, z) in ly: signed perpendicular distance (ly; + = upstream/dust side). */
export function armInfo(S, x, z, out = _ai) {
  const r = Math.hypot(x, z);
  const rr = Math.max(r, S.R * 0.02);
  if (!S.m) { out.r = r; out.k = 0; out.dperp = 1e9; out.u = 0; return out; }
  const th = Math.atan2(z, x);
  const lr = Math.log(rr / S.r0) / S.tanP;
  const w = S.warpAmp * (fbm2(x * S.warpF, z * S.warpF, S.seedWarp, 3) * 2 - 1);
  const psi = th - lr - S.phi0 + w;
  const s = psi * S.m / TAU;
  const n = Math.floor(s + 0.5);
  out.k = ((n % S.m) + S.m) % S.m;
  out.dperp = (s - n) * TAU / S.m * rr * S.sinP;
  out.r = r;
  out.u = Math.log(rr / S.r0);
  return out;
}

function armWindow(S, k, r) {
  return smooth(S.r0 * 0.7, S.r0 * 1.12, r) * (1 - smooth(S.armEnd[k] * 0.75, S.armEnd[k] * 1.05, r)) * S.armAmp[k];
}
function armFrag(S, k, u) {
  return 1 - S.fragAmp * (1 - smooth(0.3, 0.62, vnoise2(u * S.fragF, k * 7.31 + 3.7, S.seedFrag)));
}

/** Young-population surface density (0..~1) at pattern-frame (x, z): arms, rings, clumps. */
export function youngDensity(S, x, z) {
  const t = S.type;
  if (t === 'spiral' || t === 'barred' || t === 'ring') {
    const a = armInfo(S, x, z);
    const r = a.r;
    const sig = S.armW * (0.7 + 0.6 * r / S.R);
    const d = (a.dperp + 0.35 * sig) / sig;
    let v = armWindow(S, a.k, r) * armFrag(S, a.k, a.u) * Math.exp(-0.5 * d * d);
    if (t === 'ring') v = ringYoung(S, x, z, r, v);
    return v;
  }
  if (t === 'irregular') {
    let v = 0;
    for (const c of S.clumps) { const dx = x - c.x, dz = z - c.z; v += c.w * Math.exp(-0.5 * (dx * dx + dz * dz) / (c.s * c.s)); }
    return Math.min(1, v);
  }
  return 0;
}

/** Distance (ly) from the outer ring's centre (the ring of a collisional galaxy is off-centre). */
export function ringRadius(S, x, z) { return Math.hypot(x - S.ringOff[0], z - S.ringOff[1]); }

// young density of ring galaxies (mirrored in gx_young, galaxyCommon.js); v = arm density
function ringYoung(S, x, z, r, v) {
  const ro = ringRadius(S, x, z);
  const dout = (ro - S.ringOut) / S.ringW;
  if (S.ringStyle === 'hoag') return Math.exp(-0.5 * dout * dout);
  const di = (r - S.ringIn) / (S.R * 0.035);
  if (S.ringStyle === 'cartwheel') {
    const spokes = v * 0.4 * smooth(S.ringIn * 1.05, S.ringIn * 1.5, r) * (1 - smooth(S.ringOut * 0.92, S.ringOut, ro));
    return Math.max(spokes, 0.55 * Math.exp(-0.5 * di * di), Math.exp(-0.5 * dout * dout));
  }
  return Math.max(v * smooth(S.ringIn * 0.95, S.ringIn * 1.15, r), Math.exp(-0.5 * di * di), 0.7 * Math.exp(-0.5 * dout * dout));
}

const _site = { x: 0, z: 0, active: false, size: 0, bright: 0, hii: false };
/** Cluster / HII site of jittered-grid cell (cx, cz) in the pattern plane (mirrored in GLSL). */
export function clusterSite(S, cx, cz, out = _site) {
  const key = (cx + 32768) * 65536 + (cz + 32768);
  let c = S._sites.get(key);
  if (!c) {
    c = computeSite(S, cx, cz, {});
    if (S._sites.size > 200000) S._sites.clear();
    S._sites.set(key, c);
  }
  out.x = c.x; out.z = c.z; out.active = c.active; out.size = c.size; out.bright = c.bright; out.hii = c.hii;
  return out;
}
function computeSite(S, cx, cz, out) {
  const h = ihash2(cx, cz, S.seedSite);
  const hx = U(hash32(h + 1)), hz = U(hash32(h + 2)), ha = U(hash32(h + 3)), hs = U(hash32(h + 4)), hh = U(hash32(h + 5));
  out.x = (cx + 0.5 + 0.8 * (hx - 0.5)) * S.siteCell;
  out.z = (cz + 0.5 + 0.8 * (hz - 0.5)) * S.siteCell;
  const act = youngDensity(S, out.x, out.z);
  out.active = ha < act * S.siteDensity;
  out.size = S.siteCell * (0.05 + 0.14 * hs * hs);
  out.bright = 0.35 + 0.65 * hs;
  out.hii = hh < S.hiiFrac;
  return out;
}

function nearestActiveSite(S, x, z, out) {
  const cx = Math.floor(x / S.siteCell), cz = Math.floor(z / S.siteCell);
  let best = Infinity, bx = 0, bz = 0, bs = 0, bb = 0, found = false;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const s = clusterSite(S, cx + i, cz + j);
    if (!s.active) continue;
    const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
    if (d < best) { best = d; bx = s.x; bz = s.z; bs = s.size; bb = s.bright; found = true; }
  }
  if (!found) return false;
  out.x = bx; out.z = bz; out.size = bs; out.bright = bb;
  return true;
}

// ------------------------------------------------------------------ rotation
/** Angular velocity (rad / galactic-time second) of circular orbits at radius r (ly). */
export function rotationOmega(S, r) {
  const rr = Math.max(r, 1);
  return -S.v0 * (1 - Math.exp(-rr / S.rt)) / rr;
}
export function patternOmega(S) { return S.omegaP; }

// ------------------------------------------------------------------ stars
const _tmpSite = { x: 0, z: 0, size: 0, bright: 0 };
const SPREAD = [0.5, 0.65, 1.0, 1.7, 2.6, 3.2, 3.6];     // arm width multiplier by class (O..M)
const YOUTH = [1, 0.9, 0.65, 0.4, 0.25, 0.15, 0.12];

/**
 * Star i of galaxy g (galaxy = Universe.galaxy(k) data object).
 * Returns { x, y, z, cls, temperature, luminosity, radiusSolar, component, young, sub, follow }
 *   component: 'disk'|'arm'|'bulge'|'halo'|'spheroid'|'ring'   (unchanged vocabulary)
 *   sub:       finer structure: 'cluster','bar','nucleus','gc','shell','clump','field'
 *   follow:    0 = differential rotation, 1 = rigid with the spiral pattern, 2 = (almost) static halo
 */
export function galaxyStar(galaxy, i, out = {}) {
  if (i >= LOCAL_BASE) return localStar(galaxy, i, out);
  const S = galaxyStructure(galaxy);
  const s = hashCombine(galaxy.seed, i);
  const h = (k) => hash32(s + k * 0x9e3779b1);
  const type = galaxy.type;
  // ---- population & class: legacy-exact (DO NOT CHANGE — system generation depends on it)
  const comp = U(h(1));
  let young = 0, component = 'disk';
  if (type === 'elliptical') component = 'spheroid';
  else if (comp < galaxy.bulgeFrac) component = 'bulge';
  else if (comp < galaxy.bulgeFrac + galaxy.haloFrac) component = 'halo';
  else {
    const inArm = U(h(6)) < galaxy.armStrength;
    if (inArm && galaxy.arms > 0 && type !== 'irregular') { young = 0.6 + 0.4 * U(h(13)); component = 'arm'; }
    else if (type === 'irregular') young = 0.5 * U(h(13));
    else if (type === 'ring') { young = 0.7; component = 'ring'; }
  }
  const cls = pickClass(U(h(20)), young);
  const c = STAR_CLASSES[cls];
  const f = U(h(21));
  out.cls = cls;
  out.temperature = c.temp[0] + (c.temp[1] - c.temp[0]) * f;
  out.luminosity = c.lum[0] * Math.pow(c.lum[1] / c.lum[0], f);
  out.radiusSolar = c.rad[0] + (c.rad[1] - c.rad[0]) * f;
  out.component = component;
  out.young = young;
  // ---- position: structured model
  placeStar(S, component, CLASS_INDEX[cls], young, h, out);
  return out;
}

function sampleExpDisk(scale, u1, u2, maxR, u3) {
  // Gamma(2): surface density ∝ exp(-r/scale)
  let r = -scale * Math.log(Math.max(1e-12, u1 * u2));
  if (r > maxR) r = maxR * Math.sqrt(u3);
  return r;
}
function plummerR(a, u) { const q = Math.max(1e-6, Math.min(0.999, u)); return a / Math.sqrt(Math.pow(q, -2 / 3) - 1); }

function placeStar(S, component, ci, young, h, out) {
  const R = S.R;
  let x = 0, y = 0, z = 0, sub = 'field', follow = 0;
  // collisional / Hoag rings: most young "arm" stars live in the outer ring
  if (component === 'arm' && S.ringStyle && (S.m === 0 || (S.ringStyle === 'cartwheel' && U(h(60)) < 0.62))) component = 'ring';
  if (component === 'disk' && (S.ringStyle === 'cartwheel' || S.ringStyle === 'hoag')) {
    // the gap between nucleus and ring is swept clear: most old stars there were carried outward
    const r = sampleExpDisk(S.rd, U(h(2)), U(h(3)), 1.2 * R, U(h(22)));
    if (r > Math.max(S.ringIn * 1.35, R * 0.12) && r < S.ringOut * 0.88 && U(h(61)) < 0.7) {
      follow = 1;
      const th = U(h(7)) * TAU, rr = S.ringOut + S.ringW * 1.7 * gauss(h(62), h(63));
      x = S.ringOff[0] + rr * Math.cos(th); z = S.ringOff[1] + rr * Math.sin(th);
      y = sech2Sample(U(h(12)), S.hOld * 0.8);
      out.x = x; out.y = y; out.z = z; out.sub = 'field'; out.follow = follow;
      return;
    }
  }
  if (component === 'arm') {
    follow = 1;
    let r = sampleExpDisk(S.rdY, U(h(2)), U(h(3)), 1.15 * R, U(h(22)));
    if (r < 0.8 * S.r0) r = 0.8 * S.r0 + 0.8 * S.r0 * U(h(23));
    // arm choice weighted by strength
    const ua = U(h(8));
    let k = 0; while (k < S.armCum.length - 1 && ua > S.armCum[k]) k++;
    // collisional-ring spokes end at the ring
    if (S.ringStyle === 'cartwheel' && r > S.armEnd[k]) r = S.r0 + (S.armEnd[k] - S.r0) * U(h(38));
    // young stars avoid arm gaps (fragmentation): a few deterministic retries along the arm
    if (ci <= 3) {
      for (let j = 0; j < 3; j++) {
        const w = armWindow(S, k, r) / S.armAmp[k] * armFrag(S, k, Math.log(Math.max(r, R * 0.02) / S.r0));
        if (U(h(24 + j)) < w) break;
        r = sampleExpDisk(S.rdY, U(h(27 + j)), U(h(30 + j)), 1.1 * R, U(h(33 + j)));
        if (r < 0.8 * S.r0) r = 0.8 * S.r0 + 0.8 * S.r0 * U(h(36 + j));
      }
    }
    const rr = Math.max(r, R * 0.02);
    let th = Math.log(rr / S.r0) / S.tanP + S.phi0 + k * TAU / S.m;
    for (let it = 0; it < 2; it++) {
      const w = S.warpAmp * (fbm2(rr * Math.cos(th) * S.warpF, rr * Math.sin(th) * S.warpF, S.seedWarp, 3) * 2 - 1);
      th = Math.log(rr / S.r0) / S.tanP + S.phi0 + k * TAU / S.m - w;
    }
    const sigY = S.armW * (0.7 + 0.6 * r / R);
    const sig = sigY * SPREAD[ci];
    const mu = -0.35 * sigY * YOUTH[ci];
    const d = mu + sig * gauss(h(9), h(10));
    th += d / (rr * S.sinP);
    x = r * Math.cos(th); z = r * Math.sin(th);
    let hv = (ci <= 1 ? S.hYoung * 0.8 : ci === 2 ? S.hYoung * 1.1 : ci === 3 ? S.hYoung * 1.8 : S.hOld * 0.75);
    if (ci <= 2 && U(h(11)) < S.clusterFrac * YOUTH[ci] && nearestActiveSite(S, x, z, _tmpSite) && U(h(18)) < _tmpSite.bright ** 3 * 1.6) {
      const sz = _tmpSite.size;
      x = _tmpSite.x + sz * gauss(h(14), h(15)); z = _tmpSite.z + sz * gauss(h(16), h(17));
      hv = Math.min(hv, sz * 0.5);
      sub = 'cluster';
    }
    y = sech2Sample(U(h(12)), hv * (1 + S.flare * (r / R) * (r / R)));
  } else if (component === 'disk') {
    if (S.type === 'irregular') {
      follow = 1;
      const p = U(h(8));
      if (p < 0.4 + young && S.clumps.length) {
        const cl = S.clumps[Math.floor(U(h(9)) * S.clumps.length)];
        x = cl.x + cl.s * gauss(h(10), h(11)); z = cl.z + cl.s * gauss(h(12), h(14));
        y = cl.s * 0.35 * gauss(h(15), h(16));
        sub = 'clump';
      } else if (p < 0.72) {
        const b = S.irrBar, t = (U(h(9)) * 2 - 1) * b.len;
        const ox = b.w * gauss(h(10), h(11)), oz = b.w * gauss(h(12), h(14));
        x = b.x + Math.cos(b.a) * t + ox; z = b.z + Math.sin(b.a) * t + oz;
        y = b.w * 0.8 * gauss(h(15), h(16));
        sub = 'bar';
      } else {
        const r = sampleExpDisk(S.rd * 1.2, U(h(2)), U(h(3)), 1.1 * R, U(h(22)));
        const th = U(h(7)) * TAU;
        x = r * Math.cos(th) * 1.1; z = r * Math.sin(th) * 0.85;
        y = sech2Sample(U(h(12)), S.hOld * 2.2);
      }
    } else {
      follow = 0;
      let r = sampleExpDisk(S.rd, U(h(2)), U(h(3)), 1.2 * R, U(h(22)));
      // Sombrero-like S0: the stellar disk ends just outside its dust ring (bright lens inside)
      if (S.dustRing && r > S.dustRing.r * 1.02) r = S.dustRing.r * 1.02 * Math.sqrt(U(h(23)));
      let th = U(h(7)) * TAU;
      if (S.m && U(h(9)) < 0.3) {
        // weak old-star arm enhancement (broad)
        const k = Math.floor(U(h(8)) * S.m);
        const rr = Math.max(r, R * 0.02);
        th = Math.log(rr / S.r0) / S.tanP + S.phi0 + k * TAU / S.m + (S.armW * 4.5 * gauss(h(10), h(11))) / (rr * S.sinP);
        follow = 1;
      }
      x = r * Math.cos(th); z = r * Math.sin(th);
      y = sech2Sample(U(h(12)), S.hOld * (1 + S.flare * (r / R) * (r / R)));
    }
  } else if (component === 'ring') {
    follow = 1;
    const p = U(h(8));
    const pin = S.ringStyle === 'hoag' ? 0 : S.ringStyle === 'cartwheel' ? 0.28 : 0.62;
    const th = U(h(7)) * TAU;
    if (p < pin) {
      const r = S.ringIn * (1 + 0.05 * gauss(h(9), h(10)));
      x = r * Math.cos(th); z = r * Math.sin(th);
    } else {
      const r = S.ringOut + S.ringW * 0.9 * gauss(h(9), h(10));
      x = S.ringOff[0] + r * Math.cos(th); z = S.ringOff[1] + r * Math.sin(th);
    }
    let hv = S.hYoung * (ci <= 2 ? 0.9 : 1.6);
    if (ci <= 2 && U(h(11)) < 0.45 && nearestActiveSite(S, x, z, _tmpSite) && U(h(18)) < _tmpSite.bright ** 3 * 1.6) {
      const sz = _tmpSite.size;
      x = _tmpSite.x + sz * gauss(h(14), h(15)); z = _tmpSite.z + sz * gauss(h(16), h(17));
      hv = Math.min(hv, sz * 0.5);
      sub = 'cluster';
    }
    y = sech2Sample(U(h(12)), hv);
  } else if (component === 'bulge') {
    const p = U(h(8));
    if (S.barA > 0 && p < 0.55) {
      follow = 1; sub = 'bar';
      let ux = 0, uy = 0, uz = 0;
      for (let j = 0; j < 8; j++) {
        ux = U(h(40 + j * 4)) * 2 - 1; uy = U(h(41 + j * 4)) * 2 - 1; uz = U(h(42 + j * 4)) * 2 - 1;
        const m2 = ux * ux + uy * uy + uz * uz;
        if (m2 < 1 && U(h(43 + j * 4)) < 1 - m2) break;
      }
      const bx = ux * S.barA, bz = uz * S.barB;
      const ca = Math.cos(S.phi0), sa = Math.sin(S.phi0);
      x = bx * ca - bz * sa; z = bx * sa + bz * ca; y = uy * S.barC;
    } else if ((S.barA > 0 ? p - 0.55 : p) < 0.025) {
      sub = 'nucleus';
      const rr = plummerR(S.nucA, U(h(2)));
      const ct = U(h(4)) * 2 - 1, ph = U(h(5)) * TAU, st = Math.sqrt(1 - ct * ct);
      x = rr * st * Math.cos(ph); y = rr * ct * 0.8; z = rr * st * Math.sin(ph);
    } else {
      // Hernquist spheres (projected profile ≈ de Vaucouleurs: bright cusp, extended wings)
      const uc = U(h(9));
      const bc = uc < S.bulgeComp[0].w ? S.bulgeComp[0] : uc < S.bulgeComp[0].w + S.bulgeComp[1].w ? S.bulgeComp[1] : S.bulgeComp[2];
      const sq = Math.sqrt(Math.min(0.995, U(h(2))));
      let rr = bc.a * 0.6 * sq / (1 - sq);
      if (rr > R * 0.6) rr = R * 0.6 * Math.cbrt(U(h(3)));
      const ct = U(h(4)) * 2 - 1, ph = U(h(5)) * TAU, st = Math.sqrt(1 - ct * ct);
      x = rr * st * Math.cos(ph); y = rr * ct * S.bulgeQ; z = rr * st * Math.sin(ph);
    }
  } else if (component === 'halo') {
    follow = 2;
    if (U(h(8)) < 0.35 && S.gc.length) {
      const gc = S.gc[Math.floor(U(h(9)) * S.gc.length)];
      const rr = Math.min(gc.a * 8, plummerR(gc.a, U(h(2))));
      const ct = U(h(4)) * 2 - 1, ph = U(h(5)) * TAU, st = Math.sqrt(1 - ct * ct);
      x = gc.x + rr * st * Math.cos(ph); y = gc.y + rr * ct; z = gc.z + rr * st * Math.sin(ph);
      sub = 'gc';
    } else {
      let rr = plummerR(S.haloA, U(h(2)));
      if (rr > 1.6 * R) rr = 1.6 * R * Math.cbrt(U(h(3)));
      const ct = U(h(4)) * 2 - 1, ph = U(h(5)) * TAU, st = Math.sqrt(1 - ct * ct);
      x = rr * st * Math.cos(ph); y = rr * ct * 0.8; z = rr * st * Math.sin(ph);
    }
  } else { // spheroid (elliptical)
    follow = 2;
    const p = U(h(8));
    if (p < 0.035 && S.gc.length) {
      const gc = S.gc[Math.floor(U(h(9)) * S.gc.length)];
      const rr = Math.min(gc.a * 8, plummerR(gc.a, U(h(2))));
      const ct = U(h(4)) * 2 - 1, ph = U(h(5)) * TAU, st = Math.sqrt(1 - ct * ct);
      x = gc.x + rr * st * Math.cos(ph); y = gc.y + rr * ct; z = gc.z + rr * st * Math.sin(ph);
      sub = 'gc';
    } else if (S.shells.length && p < 0.1) {
      const sh = S.shells[Math.floor(U(h(9)) * S.shells.length)];
      const rr = sh.r * (1 + 0.015 * gauss(h(10), h(11)));
      // direction within a cone around the shell axis
      const ct = 1 - U(h(4)) * (1 - Math.cos(sh.open * 1.3)), ph = U(h(5)) * TAU, st = Math.sqrt(1 - ct * ct);
      const lx = ct * sh.side, ly = st * Math.cos(ph), lz = st * Math.sin(ph);
      const ca = Math.cos(sh.ax), sa = Math.sin(sh.ax), cb = Math.cos(sh.ay), sb = Math.sin(sh.ay);
      const tx = lx * cb - ly * sb, ty = lx * sb + ly * cb;
      x = rr * (tx * ca - lz * sa); y = rr * ty * S.ellQ[1]; z = rr * (tx * sa + lz * ca);
      sub = 'shell';
    } else {
      const u = U(h(2)), sq = Math.sqrt(Math.min(0.995, u));
      let rr = S.ellA * sq / (1 - sq);
      if (rr > 1.4 * R) rr = 1.4 * R * Math.cbrt(U(h(3)));
      const ct = U(h(4)) * 2 - 1, ph = U(h(5)) * TAU, st = Math.sqrt(1 - ct * ct);
      x = rr * st * Math.cos(ph) * S.ellQ[0]; y = rr * ct * S.ellQ[1]; z = rr * st * Math.sin(ph) * S.ellQ[2];
    }
  }
  out.x = x; out.y = y; out.z = z; out.sub = sub; out.follow = follow;
}

// ------------------------------------------------------------------ density field (CPU)
function plummerDensity(a, r2) { const q = 1 + r2 / (a * a); return 3 / (4 * Math.PI * a * a * a) / (q * q * Math.sqrt(q)); }

/**
 * Relative stellar number density (fraction of the galaxy's stars per ly³) at a pattern-frame
 * position, plus the young fraction and a dust estimate. Used for local LOD and sky renderers.
 */
export function galaxyDensity(galaxy, x, y, z, out = {}) {
  const S = galaxyStructure(galaxy);
  const R = S.R, r = Math.hypot(x, z), r2 = r * r + y * y;
  let bulge = 0, disk = 0, yng = 0, halo = 0, dust = 0;
  if (S.type === 'elliptical') {
    const qx = x / S.ellQ[0], qy = y / S.ellQ[1], qz = z / S.ellQ[2];
    const m = Math.sqrt(qx * qx + qy * qy + qz * qz), a = S.ellA;
    bulge = a / (2 * Math.PI * Math.max(m, a * 0.01) * Math.pow(m + a, 3)) / (S.ellQ[0] * S.ellQ[1] * S.ellQ[2]);
  } else {
    const fb = galaxy.bulgeFrac, fh = galaxy.haloFrac, fd = Math.max(0, 1 - fb - fh);
    const yq = y / S.bulgeQ, m2 = r * r + yq * yq;
    let b = 0;
    for (const c of S.bulgeComp) b += c.w * plummerDensity(c.a, m2);
    bulge = fb * (S.barA > 0 ? 0.45 : 1) * b / S.bulgeQ;
    if (S.barA > 0) {
      const ca = Math.cos(-S.phi0), sa = Math.sin(-S.phi0);
      const bx = (x * ca - z * sa) / S.barA, bz = (x * sa + z * ca) / S.barB, by = y / S.barC;
      const mm = bx * bx + by * by + bz * bz;
      if (mm < 1) bulge += fb * 0.55 * (1 - mm) * 15 / (8 * Math.PI * S.barA * S.barB * S.barC);
    }
    halo = fh * plummerDensity(S.haloA, r2) * (r2 < 2.6 * R * R ? 1 : 0);
    const hO = S.hOld * (1 + S.flare * (r / R) * (r / R));
    const sig0 = 1 / (2 * Math.PI * S.rd * S.rd);
    const cut = 1 - smooth(1.05 * R, 1.3 * R, r);
    const yd = youngDensity(S, x, z);
    disk = fd * sig0 * Math.exp(-r / S.rd) * cut * sech2(y / hO) / (2 * hO);
    if (S.ringStyle === 'cartwheel' || S.ringStyle === 'hoag') {
      const ro = ringRadius(S, x, z), dout = (ro - S.ringOut) / S.ringW;
      const gap = smooth(Math.max(S.ringIn * 1.25, R * 0.08), Math.max(S.ringIn * 1.8, R * 0.2), r) * (1 - smooth(S.ringOut - 2.6 * S.ringW, S.ringOut - 1.2 * S.ringW, ro));
      disk *= 1 - 0.8 * gap + 1.2 * Math.exp(-0.5 * dout * dout);
    }
    const hY = S.hYoung * (1 + S.flare * (r / R) * (r / R));
    yng = fd * 0.8 * sig0 * Math.exp(-r / S.rdY) * yd * cut * sech2(y / hY) / (2 * hY) * (S.type === 'irregular' ? 3 : 1.6);
    dust = S.dust * (0.3 * Math.exp(-r / S.rdY) + yd) * sech2(y / (S.hDust * (1 + S.flare * (r / R) * (r / R))));
  }
  out.stars = bulge + disk + yng + halo;
  out.young = out.stars > 0 ? yng / out.stars : 0;
  out.bulge = out.stars > 0 ? bulge / out.stars : 0;
  out.dust = dust;
  return out;
}

// ------------------------------------------------------------------ local LOD stars
const _dens = {};
const _dec = {};

/** Number of stars in local cell (cx, cy, cz) (0..LOCAL_K). */
export function localCellCount(galaxy, cx, cy, cz) {
  const S = galaxyStructure(galaxy);
  const x = (cx - LOCAL_HALF + 0.5) * LOCAL_CELL, z = (cz - LOCAL_HALF + 0.5) * LOCAL_CELL;
  const y0 = LOCAL_Y_EDGES[cy], y1 = LOCAL_Y_EDGES[cy + 1];
  // integrate density over the cell height with 3 samples (cells near the midplane are thin)
  let n = 0;
  for (let k = 0; k < 3; k++) {
    const yy = y0 + (y1 - y0) * (k + 0.5) / 3;
    galaxyDensity(galaxy, x, yy, z, _dens);
    n += _dens.stars;
  }
  const vol = LOCAL_CELL * LOCAL_CELL * (y1 - y0);
  const expected = n / 3 * vol * S.localNorm;
  const jitter = U(hash32(localIndex(cx, cy, cz, 0) ^ S.seedLocal));
  return Math.min(LOCAL_K, Math.floor(expected + jitter));
}

function localStar(galaxy, i, out) {
  const S = galaxyStructure(galaxy);
  const d = decodeLocal(i, _dec);
  const s = hashCombine(S.seedLocal, i);
  const h = (k) => hash32(s + k * 0x9e3779b1);
  const x0 = (d.cx - LOCAL_HALF) * LOCAL_CELL, z0 = (d.cz - LOCAL_HALF) * LOCAL_CELL;
  const y0 = LOCAL_Y_EDGES[d.cy] ?? 0, y1 = LOCAL_Y_EDGES[d.cy + 1] ?? 200;
  let x = x0 + U(h(1)) * LOCAL_CELL, z = z0 + U(h(2)) * LOCAL_CELL;
  // vertical: sample the old/young mixture profile truncated to the cell's slab
  galaxyDensity(galaxy, x0 + LOCAL_CELL / 2, (y0 + y1) / 2, z0 + LOCAL_CELL / 2, _dens);
  const young = _dens.young, bulgeFrac = _dens.bulge;
  const hv = U(h(3)) < young ? S.hYoung : S.hOld;
  const t0 = Math.tanh(y0 / hv), t1 = Math.tanh(y1 / hv);
  let y = hv * Math.atanh(Math.max(-0.9995, Math.min(0.9995, t0 + (t1 - t0) * U(h(4)))));
  let yb = young;
  let sub = 'field';
  // open clusters: stars near an active young site gather around it
  if (young > 0.05 && U(h(5)) < 0.3 + young * 0.5 && nearestActiveSite(S, x, z, _tmpSite)) {
    const dx = _tmpSite.x - x, dz = _tmpSite.z - z;
    if (dx * dx + dz * dz < (LOCAL_CELL * 2.5) ** 2) {
      const sz = Math.max(8, _tmpSite.size * 0.35);
      const nx = _tmpSite.x + sz * gauss(h(6), h(7)), nz = _tmpSite.z + sz * gauss(h(8), h(9));
      // keep the star inside its own cell's slab so enumeration by cell stays exact
      if (nx >= x0 && nx < x0 + LOCAL_CELL && nz >= z0 && nz < z0 + LOCAL_CELL) {
        x = nx; z = nz; y = Math.max(y0, Math.min(y1, sz * 0.4 * gauss(h(10), h(11)))); sub = 'cluster'; yb = 0.95;
      }
    }
  }
  const cls = pickClass(U(h(20)), Math.min(1, yb * 1.1));
  const c = STAR_CLASSES[cls];
  const f = U(h(21));
  out.x = x; out.y = y; out.z = z;
  out.cls = cls;
  out.temperature = c.temp[0] + (c.temp[1] - c.temp[0]) * f;
  out.luminosity = c.lum[0] * Math.pow(c.lum[1] / c.lum[0], f);
  out.radiusSolar = c.rad[0] + (c.rad[1] - c.rad[0]) * f;
  out.component = bulgeFrac > 0.5 ? 'bulge' : young > 0.35 ? 'arm' : 'disk';
  out.young = young;
  out.sub = sub;
  out.follow = 1;
  return out;
}

/** Enumerate the stars of one local cell: cb(index, star) (star object is reused). */
export function forEachLocalStar(galaxy, cx, cy, cz, cb, scratch = {}) {
  const n = localCellCount(galaxy, cx, cy, cz);
  for (let k = 0; k < n; k++) {
    const idx = localIndex(cx, cy, cz, k);
    cb(idx, localStar(galaxy, idx, scratch));
  }
  return n;
}

// ------------------------------------------------------------------ nebulae
const _nebCache = new Map();
const NEB_SYL = ['Ae', 'Cal', 'Ori', 'Vel', 'Lyr', 'Ner', 'Tha', 'Sel', 'Ist', 'Mor', 'Kae', 'Vey', 'Ond', 'Rhe', 'Zor', 'Ula'];
const NEB_SUF = ['ion', 'is', 'ara', 'eth', 'ula', 'or', 'yx', 'enne', 'aris', 'oth'];
const NEB_KIND = { emission: 'Nebula', pillars: 'Pillars', planetary: 'Planetary Nebula', remnant: 'Remnant', dark: 'Dark Cloud' };

/**
 * Notable nebulae of a galaxy (deterministic). Positions in ly (pattern frame, follow the pattern).
 * kind: 'emission' | 'pillars' | 'planetary' | 'remnant'
 */
export function galaxyNebulae(galaxy) {
  const key = galaxy.seed + ':' + galaxy.index;
  if (_nebCache.has(key)) return _nebCache.get(key);
  const S = galaxyStructure(galaxy);
  const r = new RNG(hashCombine(galaxy.seed, 0x7eb));
  const list = [];
  const name = (k) => `${NEB_SYL[r.int(0, NEB_SYL.length - 1)]}${NEB_SUF[r.int(0, NEB_SUF.length - 1)]} ${NEB_KIND[k]}`;
  // candidates: brightest active HII sites
  const cands = [];
  if (S.type !== 'elliptical' && S.type !== 'lenticular') {
    const n = Math.ceil(S.R * 1.05 / S.siteCell);
    for (let cz = -n; cz <= n; cz += 1) for (let cx = -n; cx <= n; cx += 1) {
      const st = clusterSite(S, cx, cz);
      if (!st.active || !st.hii) continue;
      const rr = Math.hypot(st.x, st.z);
      if (rr < S.R * 0.15 || rr > S.R * 0.95) continue;
      cands.push({ x: st.x, z: st.z, score: st.bright * st.size * (0.5 + U(ihash2(cx, cz, 77))) });
    }
    cands.sort((a, b) => b.score - a.score);
  }
  const kinds = ['emission', 'pillars', 'emission', 'planetary', 'emission', 'remnant', 'pillars', 'emission', 'planetary', 'emission'];
  let ci = 0;
  for (let k = 0; k < kinds.length; k++) {
    const kind = kinds[k];
    let x, z, y = 0;
    if ((kind === 'planetary' || kind === 'remnant' || !cands.length) || ci >= cands.length) {
      // anywhere in the disk (old population / supernova remnants)
      const rr = S.R * r.range(0.2, 0.7), a = r.range(0, TAU);
      x = rr * Math.cos(a); z = rr * Math.sin(a); y = r.range(-1, 1) * S.hYoung;
      if (S.type === 'elliptical') { y = r.range(-0.3, 0.3) * S.R * 0.2; }
    } else {
      const c = cands[Math.min(cands.length - 1, ci++ * 3)];
      x = c.x + r.range(-0.3, 0.3) * S.siteCell * 0.2; z = c.z + r.range(-0.3, 0.3) * S.siteCell * 0.2; y = r.range(-0.3, 0.3) * S.hYoung;
    }
    const radius = kind === 'planetary' ? r.range(1.2, 3.0) : kind === 'pillars' ? r.range(10, 18) : kind === 'remnant' ? r.range(40, 80) : r.range(60, 150);
    list.push({
      id: k, kind, name: name(kind), x, y, z, radius,
      seed: hashCombine(galaxy.seed, 0x7eb1, k) >>> 0,
      palette: r.chance(0.5) ? 'hubble' : 'natural',
      tilt: [r.range(0, TAU), r.range(-0.6, 0.6)],
    });
  }
  _nebCache.set(key, list);
  return list;
}

/** Globular clusters (ly, galaxy frame; halo — almost static). */
export function globularClusters(galaxy) { return galaxyStructure(galaxy).gc; }
