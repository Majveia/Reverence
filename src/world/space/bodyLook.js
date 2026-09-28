// Per-body art parameters for the space renderer (palette, oceans, ice, clouds, lights, bands,
// storms, ring profile). Deterministic from the body record. OWNED BY THE SPACE TRACK.
import * as THREE from 'three';
import { RNG, hashCombine } from '../../core/rng.js';

const lin = (hex) => new THREE.Color(hex); // three converts sRGB hex → linear
const v3 = (c) => new THREE.Vector3(c.r, c.g, c.b);

// inverse normal CDF (Acklam, short) for the ocean threshold
function probit(p) {
  p = Math.min(0.999, Math.max(0.001, p));
  const a = [-39.696830, 220.946098, -275.928510, 138.357751, -30.664798, 2.506628];
  const b = [-54.476098, 161.585836, -155.698979, 66.801311, -13.280681];
  const c = [-0.007784894, -0.32239645, -2.40075827, -2.54973253, 4.37466414, 2.93816398];
  const d = [0.00778469571, 0.3224671290, 2.445134137, 3.754408661];
  const pl = 0.02425;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Rocky-body look → uniform values. */
export function rockyLook(b) {
  const r = new RNG(hashCombine(b.seed >>> 0, 0x5ace));
  const P = b.art?.palette || {};
  const type = b.type;
  const L = {};
  L.seedOff = new THREE.Vector3(r.range(-50, 50), r.range(-50, 50), r.range(-50, 50));
  const oceanFrac = b.ocean?.present ? (b.terrain?.oceanFraction ?? 0.5) : 0;
  L.ocean = oceanFrac > 0.01 ? 1 : 0;
  // fbm(6) of simplex ≈ N(0, 0.2)
  L.seaT = oceanFrac > 0.01 ? probit(oceanFrac) * 0.2 : -0.05;   // no ocean: heights relative to the median
  const liquid = b.ocean?.liquid || 'water';
  L.liquid = liquid === 'lava' ? 1 : liquid === 'acid' ? 2 : liquid === 'ice' ? 3 : 0;
  L.deep = v3(lin(P.deep || '#0c2a44'));
  L.shallow = v3(lin(P.water || '#2a6a90'));
  if (L.liquid === 3) { L.deep = v3(lin('#a8c4d8')); L.shallow = v3(lin('#dfeaf2')); }
  L.sand = v3(lin(P.sand || '#c8b890'));
  L.grass = v3(lin(P.grass || '#6a8a4a'));
  L.grass2 = v3(lin(P.grass2 || P.grass || '#8aa060'));
  L.rock = v3(lin(P.rock || '#6a6258'));
  L.snow = v3(lin(P.snow || '#f0f4f8'));
  const flora = P.flora || [];
  const veg = lin(flora[0] || P.grass || '#3a6a30');
  // forests read darker from orbit
  L.veg = v3(veg.clone().multiplyScalar(b.life?.flora > 0.2 ? 0.75 : 1));
  L.vegAmt = THREE.MathUtils.clamp(b.life?.flora ?? 0, 0, 1);
  L.accent = v3(lin(P.accent || '#ffb060'));
  // ice caps (|y| threshold)
  L.ice = type === 'arctic' ? r.range(0.15, 0.35) : b.zone === 'cold' ? r.range(0.45, 0.65) : b.zone === 'hot' ? 1.2 : r.range(0.72, 0.86);
  if (type === 'volcanic' || type === 'desert') L.ice = Math.max(L.ice, 1.0);
  // barren / airless → craters; desert → dunes of sand everywhere
  const atm = b.atmosphere?.present ? (b.atmosphere.density ?? 1) : 0;
  L.craters = (type === 'barren' || type === 'crystal' || (b.isMoon && atm < 0.3)) ? r.range(0.6, 1) : type === 'desert' || type === 'volcanic' ? 0.25 : 0;
  L.lava = type === 'volcanic' ? r.range(0.6, 1.0) : 0;
  L.crystal = type === 'crystal' ? 1 : 0;
  L.desert = type === 'desert' ? 1 : type === 'savanna' ? 0.45 : type === 'barren' ? 0.7 : 0;
  L.freq = r.range(1.6, 2.6) * (b.terrain?.continentFreq ?? 1.2) / 1.2;
  // clouds
  const ct = b.clouds?.type || 'cumulus';
  L.cloudCov = b.clouds?.coverage ?? 0;
  if (!b.atmosphere?.present || ct === 'none') L.cloudCov = 0;
  L.cloudStreak = ct === 'wisp' ? 3.0 : ct === 'stratus' ? 2.0 : ct === 'haze' ? 2.5 : 1.0;
  L.cloudSoft = ct === 'haze' || ct === 'fogsea' ? 1 : 0;
  L.cloudCol = v3(ct === 'storm' ? lin('#aeb4c0') : ct === 'haze' ? lin(P.fog || '#e8dcc8') : lin('#ffffff'));
  L.storm = ct === 'storm' ? 1 : (b.weather?.storms ?? 0) * 0.6;
  L.cyclones = [];
  for (let k = 0; k < 4; k++) {
    const hemi = r.chance(0.5) ? 1 : -1;
    L.cyclones.push(new THREE.Vector4(hemi * r.range(0.35, 1.0), r.range(0, Math.PI * 2), r.range(0.12, 0.3), hemi * r.range(2.5, 5.0) * (0.6 + L.storm * 0.6)));
  }
  // atmosphere
  L.atmo = atm;
  L.atmoCol = v3(lin(P.sky || '#7ab8ff'));
  // civilisation lights at night
  const civ = b.civ?.level ?? 0;
  L.city = civ >= 3 ? 0.6 + (civ - 3) * 0.6 : civ === 2 ? 0.15 : 0;
  const cs = b.civ?.style;
  L.cityCol = v3(cs === 'neon' ? lin('#ff5ab8') : cs === 'nasapunk' || cs === 'crystal' ? lin('#cfe4ff') : lin('#ffb566'));
  L.cityCol2 = v3(cs === 'neon' ? lin('#40f0ff') : lin('#ffd9a0'));
  // albedo summary for dots
  L.albedo = type === 'arctic' || type === 'crystal' ? 0.6 : L.ocean ? 0.3 : 0.25;
  return L;
}

/** Gas giant look: band palette texture, storms, jets. */
export function gasLook(b) {
  const r = new RNG(hashCombine(b.seed >>> 0, 0x6a5));
  const P = b.art?.palette || {};
  // family by temperature zone and dice: jovian / saturnian / ice giant / exotic (art-directed)
  const fam = b.zone === 'cold' && b.orbit.a > 2e8 ? r.weighted([['ice', 3], ['saturn', 1], ['jovian', 0.6]])
    : r.weighted([['jovian', 3], ['saturn', 2], ['exotic', 1.4], ['ice', 0.6]]);
  const pal = {
    jovian: ['#f1e6cf', '#d9b98c', '#a8703f', '#c98f55', '#efe2c6', '#7a4a2c', '#e5c9a0', '#b9825a'],
    saturn: ['#efe0b8', '#e2c58e', '#cfae76', '#f3e7c6', '#bf9d64', '#e9d3a2', '#d8b77f', '#f6ecd0'],
    ice: ['#9fd3e6', '#7fb6d6', '#b9e2ee', '#5e94c4', '#cdeef4', '#6aa6cf', '#a4d6e8', '#4f86b8'],
    exotic: [P.accent || '#ff7a59', P.sky || '#9fd4e8', P.sand || '#f3dcc0', P.rock || '#c98f6e', P.fog || '#f4e3cf', P.water || '#58b8b0', '#f4efe6', P.deep || '#1c5c66'],
  }[fam].map((h) => lin(h));
  // art tint: pull slightly toward the planet's art palette so every giant is art-directed
  const tint = lin(P.accent || '#ffffff');
  const N = 256;
  const data = new Uint8Array(N * 4);
  // random band layout: alternating zones (light) and belts (dark), finer sub-bands
  const edges = [];
  let y = 0;
  while (y < 1) { edges.push(y); y += r.range(0.025, 0.09); }
  edges.push(1.0001);
  const bandCols = [];
  for (let i = 0; i < edges.length; i++) {
    const base = pal[r.int(0, pal.length - 1)].clone();
    const zone = i % 2 === 0;
    base.multiplyScalar(zone ? r.range(0.95, 1.1) : r.range(0.62, 0.85));
    base.lerp(tint, fam === 'exotic' ? 0.12 : 0.05);
    bandCols.push(base);
  }
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    // symmetric-ish about the equator (real giants roughly are)
    const ts = Math.abs(t - 0.5) * 2 * 0.85 + (t - 0.5) * 0.15 + 0.5 * 0.15;
    let k = 0; while (k < edges.length - 2 && edges[k + 1] <= ts) k++;
    const f = (ts - edges[k]) / Math.max(1e-4, edges[k + 1] - edges[k]);
    const s = f * f * (3 - 2 * f);
    c.copy(bandCols[k]).lerp(bandCols[k + 1] || bandCols[k], s * s * 0.8);
    // polar darkening/greying
    const lat = Math.abs(t - 0.5) * 2;
    const pol = THREE.MathUtils.smoothstep(lat, 0.72, 0.98);
    c.lerp(new THREE.Color(c.r * 0.55, c.g * 0.6, c.b * 0.7), pol);
    const sub = 0.94 + 0.12 * Math.sin(t * 190 + r.range(0, 6)) * Math.sin(t * 57);
    data[i * 4] = Math.min(255, c.r * sub * 255);
    data[i * 4 + 1] = Math.min(255, c.g * sub * 255);
    data[i * 4 + 2] = Math.min(255, c.b * sub * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  const storms = [];
  const ns = r.int(2, 6);
  for (let i = 0; i < ns; i++) {
    const big = i === 0 && r.chance(0.75);
    storms.push(new THREE.Vector4(
      (r.range(-0.55, 0.55)) * (big ? 0.6 : 1),        // latitude (rad)
      r.range(0, Math.PI * 2),                          // longitude
      big ? r.range(0.09, 0.16) : r.range(0.025, 0.06), // size (rad)
      (r.chance(0.5) ? 1 : -1) * r.range(1.2, 2.6),     // swirl
    ));
  }
  const stormCol = fam === 'ice' ? lin('#e8f6ff') : r.chance(0.6) ? lin('#c0583a') : lin('#f6efe2');
  return {
    fam, tex,
    storms, stormCol: v3(stormCol),
    jets: r.range(9, 16),
    flow: r.range(0.0025, 0.006),
    turb: r.range(0.7, 1.4),
    seedOff: new THREE.Vector3(r.range(-40, 40), r.range(-40, 40), r.range(-40, 40)),
    haze: v3(fam === 'ice' ? lin('#9fd8ff') : lin('#f4e2c0').lerp(lin(P.sky || '#9fc8ff'), 0.4)),
    albedo: fam === 'ice' ? 0.5 : 0.45,
  };
}

/** Ring radial profile texture: rgb = albedo (linear), a = normal optical opacity. */
export function ringTexture(b) {
  const ring = b.rings;
  const r = new RNG(hashCombine(b.seed >>> 0, 0x417));
  const N = 2048;
  const data = new Uint8Array(N * 4);
  const base = ring.color ? ring.color.clone() : new THREE.Color(0.8, 0.7, 0.55);
  // structure: faint inner ring, dense main ring, a Cassini-like division, outer ring with a gap, a thin F ring
  const cIn = r.range(0.14, 0.26), cass = r.range(0.52, 0.64), cassW = r.range(0.025, 0.05);
  const encke = r.range(0.82, 0.92), enckeW = r.range(0.004, 0.01);
  const fRing = r.chance(0.7) ? r.range(0.965, 0.99) : -1;
  const ph = [r.range(0, 99), r.range(0, 99), r.range(0, 99)];
  const noise1 = (x, k) => Math.sin(x * 1.0 + ph[k]) * 0.5 + Math.sin(x * 2.31 + ph[k] * 1.7) * 0.3 + Math.sin(x * 5.13 + ph[k] * 2.3) * 0.2;
  const col = new THREE.Color();
  // ringlet table: many narrow ringlets with independent opacity & albedo (the "grooves" look)
  const nl = 140;
  const lo = [], la = [];
  for (let k = 0; k < nl; k++) { const g = r.next(); lo.push(g < 0.12 ? r.range(0.15, 0.45) : r.range(0.6, 1.3)); la.push(r.range(0.78, 1.22)); }
  const tintB = base.clone().lerp(new THREE.Color(1, 0.95, 0.85), 0.35);          // bright icy B ring
  const tintC = new THREE.Color(0.52, 0.5, 0.49).lerp(base, 0.25);                  // dusky C ring
  const tintA = base.clone().lerp(new THREE.Color(0.85, 0.83, 0.8), 0.3);           // greyer A ring
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    let op, c;
    if (t < cIn) { op = 0.06 + 0.14 * (t / cIn); c = tintC; }
    else if (t < cass) { op = 0.55 + 0.4 * THREE.MathUtils.smoothstep(t, cIn, cIn + 0.12); c = tintB; }
    else if (t < cass + cassW) { op = 0.03 + 0.04 * Math.abs(Math.sin(t * 900)); c = tintC; }
    else { op = 0.52 - 0.15 * (t - cass) / (1 - cass); c = tintA; }
    if (Math.abs(t - encke) < enckeW) op *= 0.06;
    if (t > 0.955) op *= fRing > 0 ? 0.04 : (1 - THREE.MathUtils.smoothstep(t, 0.955, 1.0));
    if (fRing > 0 && Math.abs(t - fRing) < 0.0035) { op = 0.6; c = tintB; }
    const lk = Math.min(nl - 1, Math.floor(t * nl));
    const lf = t * nl - lk;
    const ls = Math.min(1, Math.max(0, (lf - 0.42) * 6)); // crisp ringlet edges
    const lop = lo[lk] + (lo[Math.min(nl - 1, lk + 1)] - lo[lk]) * ls * ls;
    op *= lop;
    op *= 0.7 + 0.3 * (noise1(t * 260, 1) * 0.5 + 0.5);
    op *= 0.72 + 0.28 * (noise1(t * 1100, 2) * 0.5 + 0.5);
    op *= THREE.MathUtils.smoothstep(t, 0.0, 0.02);
    op = THREE.MathUtils.clamp(op * (0.7 + (ring.opacity ?? 0.6) * 0.45), 0, 0.97);
    col.copy(c);
    const v = (la[lk] + (la[Math.min(nl - 1, lk + 1)] - la[lk]) * ls) * (0.9 + 0.12 * noise1(t * 40, 2));
    data[i * 4] = Math.min(255, col.r * v * 235);
    data[i * 4 + 1] = Math.min(255, col.g * v * 235);
    data[i * 4 + 2] = Math.min(255, col.b * v * 235);
    data[i * 4 + 3] = Math.round(op * 255);
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
