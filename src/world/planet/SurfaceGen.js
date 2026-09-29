// SurfaceGen — THREE-free, worker-safe planet landform generator. OWNED BY THE TERRAIN TRACK.
//
// This is the deterministic "physics truth" of a rocky body's shape. PlanetSurface (main thread)
// extends it with THREE conveniences; terrain workers import it directly to build chunks.
//
// Units: meters. Input is a UNIT direction (x,y,z) in the planet-local frame (+Y north).
// height(...) is meters relative to body.radius (sea level = 0 on ocean worlds).
//
// Landform stack (each layer is LOD-aware: octaves finer than `lod` meters are skipped/faded,
// which is what makes chunk generation cheap far away and seamless up close):
//   continents (domain-warped fbm, calibrated ocean fraction) → coastal shelf / beaches / cliffs
//   → mountain ranges (eroded ridged multifractal + gully erosion filter = dendritic valleys)
//   → rolling hills → plateaus & mesas (caprock, cliff, talus) → canyons (terraced strata walls)
//   → karst towers / spires / kopjes / sea stacks / atolls → dunes → craters → volcanoes
//   → river valleys & lakes (carved below sea level in lowlands so the ocean fills them)
//   → glacial valleys / fjords → rock outcrops → fractal detail down to decimetres.
import { SNoise, sstep, clamp01, lodW } from './noise.js';

export const BIOMES = {
  OCEAN: 0, BEACH: 1, DESERT: 2, SAVANNA: 3, GRASSLAND: 4, FOREST: 5,
  JUNGLE: 6, TAIGA: 7, TUNDRA: 8, SNOW: 9, ROCK: 10, VOLCANIC: 11, CRYSTAL: 12, TOXIC: 13,
};
export const BIOME_NAMES = Object.fromEntries(Object.entries(BIOMES).map(([k, v]) => [v, k.toLowerCase()]));

/** Finest wavelength synthesized by height() — the geometry the player stands on. */
export const LOD_MIN = 0.22;

const TAU = Math.PI * 2;
const LAC = 2.03, ILAC = 1 / 2.03;

function hash32(x) {
  x |= 0; x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
  return x >>> 0;
}
function rng(seed) {
  let s = hash32(seed) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// live surfaces per body (so surfaceConfig(body) can include runtime flatten stamps for workers
// created after civ graded its plazas)
const LIVE = new WeakMap();
export function registerLiveSurface(body, surface) { try { LIVE.set(body, surface); } catch (_) { /* non-object */ } }

/** Plain, structured-cloneable config (what workers receive). */
export function surfaceConfig(body) {
  const T = body.terrain || {};
  const pal = body.art?.palette || {};
  return {
    seed: body.seed >>> 0,
    radius: body.radius,
    type: body.type,
    isMoon: !!body.isMoon,
    amplitude: T.amplitude || body.radius * 0.05,
    continentFreq: T.continentFreq ?? 1.4,
    mountainScale: T.mountainScale ?? 1,
    roughness: T.roughness ?? 0.5,
    oceanFraction: T.oceanFraction ?? 0,
    features: [...(T.features || [])],
    hasOcean: !!body.ocean?.present,
    liquid: body.ocean?.liquid || 'water',
    art: body.art?.key || 'default',
    palette: { ...pal, flora: [...(pal.flora || [])] },
    life: body.life?.flora ?? 0,
    flats: (LIVE.get(body)?.flats || []).map((f) => ({ ...f })),
  };
}

// ------------------------------------------------------------------ landform style per world
function computeStyle(cfg) {
  const r = rng(cfg.seed ^ 0x51f15e);
  const F = new Set(cfg.features);
  const T = cfg.type, art = cfg.art;
  const A = cfg.amplitude, R = cfg.radius;
  const ms = cfg.mountainScale;
  const st = {
    warp: 0.26 + r() * 0.12,
    mountains: 1, mtnHeight: 0.8 + 0.3 * ms, mtnWl: A * (3.6 + r() * 1.4) / Math.sqrt(ms),
    mtnGain: 0.47, mtnDamp: 0.6, rangeLo: 0.26 + r() * 0.1, rangeHi: 0.92, massifs: 0.5,
    erosion: 1, gullyWl: 0, gullyAmp: 0.07,
    hills: 1, hillAmp: 0.02, hillWl: 1600 + r() * 900, uplands: 1,
    rough: 0.6 + cfg.roughness, outcrops: 0.6,
    beach: 0.75, beachH: 5 + r() * 4, cliffs: 0.15,
    plateaus: 0, mesas: 0, canyons: 0, terraces: 0, rivers: 0, lakes: 0, dunes: 0, craters: 0, karst: 0,
    spires: 0, seastacks: 0, atolls: 0, islands: 0, fjords: 0, glaciers: 0, volcano: 0, kopjes: 0,
    sinkholes: 0, saltflats: 0, rilles: 0,
    tempBias: 0, moistBias: 0, snowLine: 0.62,
  };
  switch (T) {
    case 'ocean': st.islands = 0.7; st.mountains = 0.85; st.cliffs = 0.35; st.hills = 1.1; break;
    case 'archipelago': st.islands = 1; st.mountains = 0.7; st.hills = 1.25; st.beach = 1; st.atolls = 0.3; break;
    case 'jungle': st.hills = 1.35; st.mountains = 0.85; st.rough += 0.2; st.moistBias = 0.3; st.tempBias = 0.12; break;
    case 'savanna': st.hills = 0.7; st.mountains = 0.55; st.uplands = 0.7; st.moistBias = -0.14; st.tempBias = 0.1; break;
    case 'desert': st.hills = 0.55; st.mountains = 0.75; st.moistBias = -0.45; st.tempBias = 0.25; st.rough += 0.1; break;
    case 'volcanic': st.mountains = 1.25; st.volcano = 1; st.rough += 0.35; st.tempBias = 0.3; st.moistBias = -0.2; break;
    case 'barren': st.mountains = 0.65; st.hills = 0.45; st.rough += 0.2; st.moistBias = -0.5; st.craters = 0.55; break;
    case 'arctic': st.mountains = 1.15; st.tempBias = -0.5; st.snowLine = 0.35; st.glaciers = 0.5; break;
    case 'toxic': st.hills = 1.15; st.moistBias = 0.1; st.mountains = 0.8; break;
    case 'crystal': st.mountains = 0.9; st.tempBias = -0.25; st.spires = 0.4; break;
    case 'exotic': st.hills = 1.2; st.mountains = 0.9; break;
    default: break;
  }
  if (cfg.isMoon && (T === 'barren' || T === 'arctic' || T === 'crystal' || T === 'volcanic')) st.craters = Math.max(st.craters, 0.7);
  if (F.has('plateaus')) st.plateaus = 1;
  if (F.has('mesas')) st.mesas = 1;
  if (F.has('canyons')) st.canyons = 1;
  if (F.has('terraces')) st.terraces = 1;
  if (F.has('rivers')) st.rivers = 1;
  if (F.has('lakes') || F.has('pools')) st.lakes = 1;
  if (F.has('dunes')) st.dunes = 1;
  if (F.has('craters')) st.craters = Math.max(st.craters, 1);
  if (F.has('karst') || F.has('arches')) st.karst = F.has('karst') ? 1 : 0.55;
  if (F.has('spires') || F.has('crystals')) st.spires = Math.max(st.spires, 1);
  if (F.has('seastacks')) st.seastacks = 1;
  if (F.has('atolls')) st.atolls = 1;
  if (F.has('archipelago')) st.islands = Math.max(st.islands, 1);
  if (F.has('fjords')) st.fjords = 1;
  if (F.has('glaciers') || F.has('icebergs')) st.glaciers = 1;
  if (F.has('calderas') || F.has('lavaflows')) st.volcano = 1;
  if (F.has('kopjes')) st.kopjes = 1;
  if (F.has('sinkholes')) st.sinkholes = 1;
  if (F.has('saltflats')) st.saltflats = 1;
  if (F.has('cliffs')) st.cliffs = Math.max(st.cliffs, 0.8);
  if (F.has('rilles')) st.rilles = 1;
  if (F.has('crevasses')) st.glaciers = Math.max(st.glaciers, 0.7);
  if (F.has('waterfalls')) st.cliffs = Math.max(st.cliffs, 0.5);
  // art direction: each preset nudges the landforms toward its painter's / director's world
  const artMods = {
    bierstadt: () => { st.terraces = 0; st.canyons *= 0.5; st.mtnHeight *= 1.2; st.mountains *= 1.2; st.rangeLo -= 0.04; st.erosion = 1.25; st.glaciers = Math.max(st.glaciers, 0.4); },
    botw: () => { st.hills *= 1.25; st.plateaus = Math.max(st.plateaus, 0.6); st.outcrops = 1; st.rivers = Math.max(st.rivers, 0.7); },
    ghibli: () => { st.hills *= 1.35; st.outcrops = 0.9; st.rivers = Math.max(st.rivers, 0.6); },
    moebius: () => { st.mesas = Math.max(st.mesas, 1); st.spires = Math.max(st.spires, 0.6); st.hills *= 0.7; },
    villeneuve: () => { st.dunes = Math.max(st.dunes, 0.8); st.mesas = Math.max(st.mesas, 0.5); },
    rogerdean: () => { st.seastacks = Math.max(st.seastacks, 1); st.karst = Math.max(st.karst, 0.7); st.cliffs = Math.max(st.cliffs, 0.7); },
    stalenhag: () => { st.hills *= 0.75; st.mountains *= 0.7; st.lakes = Math.max(st.lakes, 0.5); },
    tarkovsky: () => { st.mountains *= 0.75; st.hills *= 0.9; st.lakes = Math.max(st.lakes, 0.8); },
    friedrich: () => { st.mountains *= 1.2; st.mtnHeight *= 1.1; st.cliffs = Math.max(st.cliffs, 0.5); },
    kubrick: () => { st.craters = Math.max(st.craters, 1); st.hills *= 0.6; },
    rickmorty: () => { st.karst = Math.max(st.karst, 1); st.hills *= 1.2; },
    nms: () => { st.terraces = Math.max(st.terraces, 0.5); st.karst = Math.max(st.karst, 0.5); },
    outerwilds: () => { st.cliffs = Math.max(st.cliffs, 0.6); st.hills *= 1.15; },
    nausicaa: () => { st.terraces = Math.max(st.terraces, 0.6); st.sinkholes = Math.max(st.sinkholes, 0.5); },
    bebop: () => { st.mesas = Math.max(st.mesas, 0.8); st.canyons = Math.max(st.canyons, 0.6); },
    turner: () => { st.cliffs = Math.max(st.cliffs, 0.7); },
    starfield: () => { st.mountains *= 1.15; st.erosion = 1.2; },
    beksinski: () => { st.spires = Math.max(st.spires, 0.8); },
    crystal: () => { st.spires = Math.max(st.spires, 0.9); st.terraces = Math.max(st.terraces, 0.4); },
  };
  artMods[art]?.();
  // sizes relative to the planet so small moons stay walkable and big worlds stay epic
  const scale = Math.max(0.45, Math.min(1.25, R / 70000));
  st.gullyWl = Math.min(3000, st.mtnWl * 0.16);
  st.plateauWl = 9000 * scale * (0.8 + r() * 0.5);
  st.plateauH = A * (0.07 + r() * 0.05);
  st.mesaWl = 3200 * scale * (0.8 + r() * 0.5);
  st.canyonWl = 11000 * scale * (0.8 + r() * 0.4);
  st.canyonDepth = A * (0.09 + r() * 0.05);
  st.riverWl = 9000 * scale * (0.8 + r() * 0.5);
  st.duneWl = 160 + r() * 140;
  st.duneH = 14 + r() * 22;
  st.karstWl = 700 * scale * (0.8 + r() * 0.5);
  st.karstH = Math.min(A * 0.09, 380) * (0.8 + r() * 0.4);
  st.spireWl = 1500 * scale;
  st.spireH = Math.min(A * 0.1, 420);
  st.craterWl = [R * 0.34, R * 0.12, R * 0.04, R * 0.013, R * 0.0042];
  st.duneDir = [r() - 0.5, r() - 0.5, r() - 0.5];
  const dl = Math.hypot(...st.duneDir) || 1; st.duneDir = st.duneDir.map((v) => v / dl);
  st.strataPhase = r() * 100;
  return st;
}

export class SurfaceGen {
  /** @param cfg output of surfaceConfig(body) (or a body — it is converted) */
  constructor(cfg) {
    if (cfg && cfg.terrain) cfg = surfaceConfig(cfg);
    this.cfg = cfg;
    this.radius = cfg.radius;
    this.R = cfg.radius;
    this.amp = cfg.amplitude;
    this.A = cfg.amplitude;
    this.type = cfg.type;
    this.hasOcean = cfg.hasOcean;
    this.seaLevel = this.hasOcean ? 0 : -Infinity;
    this.features = new Set(cfg.features);
    this.cf = cfg.continentFreq;
    this.st = computeStyle(cfg);
    const s = cfg.seed >>> 0;
    this.nC = new SNoise(s ^ 0x1c0ffee);   // continents
    this.nW = new SNoise(s ^ 0x2b7e1516);  // warps
    this.nM = new SNoise(s ^ 0x3243f6a8);  // mountains
    this.nH = new SNoise(s ^ 0x4a7c15f9);  // hills + detail
    this.nF = new SNoise(s ^ 0x5d2c3e11);  // features
    this.nG = new SNoise(s ^ 0x6e3779b9);  // cellular (gullies, craters, towers)
    this.nB = new SNoise(s ^ 0x7f4a7c15);  // climate / biomes
    this._g = new Float64Array(6);
    this._w2 = new Float64Array(3);
    this._mg = new Float64Array(3);
    this._d = new Float64Array(3);
    this._e = new Float64Array(1);
    this._info = {};
    this.oceanBias = 0;
    this._calibrate();
    this.maxHeight = this.A * 1.25 + (this.st.spires ? this.st.spireH : 0) + (this.st.karst ? this.st.karstH : 0);
    this.minHeight = -this.A * 0.62;
    this.flats = [];
    this._flatId = 1;
    this._flatListeners = [];
    if (cfg.flats?.length) this.setFlattens(cfg.flats);
  }

  // ------------------------------------------------------------------ flatten stamps (civ plazas, pads)
  /**
   * Grade the terrain toward a constant height inside a disc (plazas, building pads, landing pads).
   * { dir: unit vector (Vector3 or [x,y,z]), radius (m, fully flat), height (m rel. radius; default:
   * current height at dir), falloff (m, smooth blend ring; default 0.6·radius) } → id.
   * Physics (height/sample) updates immediately; the terrain rebuilds the affected chunks.
   */
  addFlatten(o) {
    if (!o || !o.dir) return 0;
    const d = Array.isArray(o.dir) ? o.dir : [o.dir.x, o.dir.y, o.dir.z];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    const x = d[0] / l, y = d[1] / l, z = d[2] / l;
    const radius = Math.max(0.5, +o.radius || 10);
    const falloff = Math.max(0.5, o.falloff !== undefined ? +o.falloff : radius * 0.6);
    const height = Number.isFinite(+o.height) && o.height !== null && o.height !== undefined ? +o.height : this._eval(x, y, z, LOD_MIN, null);
    const f = { id: this._flatId++, x, y, z, radius, falloff, height };
    this._prepFlat(f);
    this.flats.push(f);
    this._flatChanged(f);
    return f.id;
  }
  removeFlatten(id) {
    const i = this.flats.findIndex((f) => f.id === id);
    if (i < 0) return false;
    const [f] = this.flats.splice(i, 1);
    this._flatChanged(f);
    return true;
  }
  /** Replace all stamps (workers receive them this way). */
  setFlattens(list) {
    this.flats = (list || []).map((f) => { const g = { ...f }; this._prepFlat(g); return g; });
    this._flatId = this.flats.reduce((m, f) => Math.max(m, f.id || 0), 0) + 1;
  }
  /** cb(stamp) whenever a stamp is added/removed (terrain rebuilds chunks, other workers resync). */
  onFlattenChange(cb) { this._flatListeners.push(cb); return () => { this._flatListeners = this._flatListeners.filter((c) => c !== cb); }; }
  _prepFlat(f) {
    f.cosOuter = Math.cos(Math.min(Math.PI, (f.radius + f.falloff) / this.R));
  }
  _flatChanged(f) { for (const cb of this._flatListeners) { try { cb(f, this.flats); } catch (_) { /* listener errors never break physics */ } } }

  // ------------------------------------------------------------------ continents
  _warp(x, y, z, out) {
    const n = this.nW, f = 1.45, W = this.st.warp;
    const f2 = 3.1, W2 = W * 0.33;
    const qx = x + W * n.n3(x * f + 1.7, y * f + 9.2, z * f + 3.3) + W2 * n.n3(x * f2 + 5.1, y * f2 + 1.1, z * f2 + 8.8);
    const qy = y + W * n.n3(x * f + 8.3, y * f + 2.8, z * f + 7.1) + W2 * n.n3(x * f2 + 2.2, y * f2 + 6.4, z * f2 + 0.9);
    const qz = z + W * n.n3(x * f + 4.1, y * f + 6.6, z * f + 0.4) + W2 * n.n3(x * f2 + 9.3, y * f2 + 3.7, z * f2 + 4.6);
    out[0] = qx; out[1] = qy; out[2] = qz;
  }

  _continent(px, py, pz, lod) {
    const n = this.nC, cf = this.cf, R = this.R;
    let a = 1, sum = 0, norm = 0, wl = R / cf, x = px * cf, y = py * cf, z = pz * cf;
    const cut = Math.max(lod, 900);
    for (let o = 0; o < 7; o++) {
      const w = lodW(wl, cut);
      if (w > 0) sum += a * w * n.n3(x, y, z);
      norm += a; a *= 0.52; wl *= ILAC;
      x = x * LAC + 17.13; y = y * LAC + 3.71; z = z * LAC + 11.37;
    }
    let c = sum / norm;
    const st = this.st;
    if (st.islands > 0) {
      // island clusters: medium-frequency lumps that break coasts into archipelagos
      const fi = R / (6500 * Math.max(0.5, R / 70000));
      const isl = n.n3(px * fi + 31.7, py * fi + 7.7, pz * fi + 2.2) * 0.65 + n.n3(px * fi * 2.1 + 3.3, py * fi * 2.1, pz * fi * 2.1 + 9.9) * 0.35;
      const region = sstep(-0.35, 0.25, n.n3(px * cf * 1.3 + 50, py * cf * 1.3, pz * cf * 1.3));
      c += st.islands * isl * 0.16 * region;
    }
    return c;
  }

  _calibrate() {
    // choose oceanBias so that the requested fraction of the sphere lies below sea level
    const target = this.hasOcean ? this.cfg.oceanFraction : 0;
    if (!this.hasOcean) { this.oceanBias = -0.6; return; }
    const N = 1400, vals = new Float64Array(N), w = this._g;
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), t = ga * i;
      const x = Math.cos(t) * r, z = Math.sin(t) * r;
      this._warp(x, y, z, w);
      vals[i] = this._continent(w[0], w[1], w[2], 2000);
    }
    vals.sort();
    this.oceanBias = vals[Math.min(N - 1, Math.max(0, Math.floor(target * N)))] ?? 0;
  }

  // ------------------------------------------------------------------ mountains
  /** Eroded ridged multifractal. Returns ~[0,1]; writes d/dp (unit-sphere units) into g. */
  _mountain(x, y, z, lod, g) {
    const st = this.st, n = this.nM, d = this._d;
    let wl = st.mtnWl, f = this.R / wl;
    let qx = x * f, qy = y * f, qz = z * f;
    {
      // two-scale domain warp: bends ridgelines so ranges branch and curve instead of running straight
      const w1 = 0.55, w2 = 0.22;
      const ax0 = n.n3(qx * 0.45 + 11.3, qy * 0.45 + 2.9, qz * 0.45 + 7.7), ay0 = n.n3(qx * 0.45 + 4.2, qy * 0.45 + 9.4, qz * 0.45 + 1.3), az0 = n.n3(qx * 0.45 + 8.8, qy * 0.45 + 5.5, qz * 0.45 + 3.1);
      const bx0 = n.n3(qx * 1.7 + 1.9, qy * 1.7 + 6.1, qz * 1.7 + 2.4), by0 = n.n3(qx * 1.7 + 7.3, qy * 1.7 + 3.8, qz * 1.7 + 9.6), bz0 = n.n3(qx * 1.7 + 5.6, qy * 1.7 + 0.7, qz * 1.7 + 6.9);
      qx += w1 * ax0 + w2 * bx0; qy += w1 * ay0 + w2 * by0; qz += w1 * az0 + w2 * bz0;
    }
    let sum = 0, a = 0.5, wgt = 1, gx = 0, gy = 0, gz = 0, ax = 0, ay = 0, az = 0, tx = 0, ty = 0, tz = 0;
    const damp = st.mtnDamp;
    const gMin = st.gullyWl * 1.9;
    let dm = 1;
    for (let o = 0; o < 12; o++) {
      if (wl < 50) break;
      const lw = lodW(wl, lod);
      if (lw <= 0) {
        // expected value of the octaves we skip (keeps coarse LODs at the same mean height)
        let ta = 0; for (let w2 = wl, a2 = a; w2 >= 50; w2 *= ILAC, a2 *= st.mtnGain) ta += a2;
        sum += 0.499 * 0.8 * ta * wgt * dm;
        break;
      }
      const v = n.n3d(qx, qy, qz, d);
      // smooth |v| keeps crest derivatives continuous (no damping/gully jumps across ridgelines)
      const av = Math.sqrt(v * v + 0.0036);
      const r1 = 1.06 - av;
      const r = r1 * r1;
      const k = -2 * r1 * v / av;
      let rx = k * d[0], ry = k * d[1], rz = k * d[2];
      const rd = rx * x + ry * y + rz * z; rx -= rd * x; ry -= rd * y; rz -= rd * z;
      // damping follows the slope of the underlying (smooth) noise, NOT of the ridged value: the ridge
      // derivative flips across every crest, which made the damping jump and grew needle walls there
      let nx = d[0], ny = d[1], nz = d[2];
      const nd = nx * x + ny * y + nz * z; nx -= nd * x; ny -= nd * y; nz -= nd * z;
      ax += nx * a * 0.5; ay += ny * a * 0.5; az += nz * a * 0.5;
      dm = 1 / (1 + damp * (ax * ax + ay * ay + az * az));
      const s = a * wgt * dm * lw;
      sum += s * r + a * wgt * dm * (1 - lw) * 0.499;
      // only the large-scale slope drives the gully filter (LOD-independent input)
      const sf = s * f;
      if (wl >= gMin) { gx += sf * rx; gy += sf * ry; gz += sf * rz; }
      tx += sf * rx; ty += sf * ry; tz += sf * rz;   // full (LOD-faded) slope: steep-face detection
      wgt = r * 1.7; if (wgt > 1) wgt = 1;
      a *= st.mtnGain; wl *= ILAC; f *= LAC;
      qx = qx * LAC + 3.1; qy = qy * LAC + 1.7; qz = qz * LAC + 8.3;
    }
    g[0] = gx; g[1] = gy; g[2] = gz; g[3] = tx; g[4] = ty; g[5] = tz;
    return sum;
  }

  /** Rib/chute relief for big mountain walls (metres, ~zero-mean). */
  _buttress(x, y, z, lod) {
    const n = this.nH;
    let wl = 1400, sum = 0;
    for (let o = 0; o < 4; o++) {
      const lw = lodW(wl * 0.5, lod);
      if (lw <= 0) break;
      const f = this.R / wl;
      const v = n.n3(x * f + 13.1 + o * 3.7, y * f + 5.3, z * f + 9.9 - o * 1.3);
      // softened ridge: sharp-ish ribs, rounded chutes (no razor creases)
      sum += 0.09 * wl * lw * ((0.35 - Math.sqrt(v * v + 0.006)) * 1.7);
      wl *= 0.5;
    }
    return sum;
  }

  /** Mountain-range presence mask (0..1) at a warped point with continental value c. */
  _mtnMask(px, py, pz, c) {
    const st = this.st, rf = this.cf * 1.9;
    const rn = this.nM.n3(px * rf + 5.3, py * rf + 2.1, pz * rf + 8.8) + 0.45 * this.nM.n3(px * rf * 2.3 + 1.1, py * rf * 2.3 + 4.4, pz * rf * 2.3 + 2.2);
    const spine = 1 - Math.sqrt(rn * rn + 0.004) * 0.9;
    let mm = sstep(st.rangeLo, st.rangeHi, spine);
    const massif = sstep(0.3, 0.9, this.nM.n3(px * this.cf * 0.9 + 21, py * this.cf * 0.9 + 4, pz * this.cf * 0.9 + 13)) * st.massifs;
    if (massif > mm) mm = massif;
    mm *= sstep(0.0, 0.1, c) * st.mountains;
    return mm > 1 ? 1 : mm;
  }

  /** Tangent gradient (per metre, world axes) of the mountain mask at unit dir (x,y,z); mm = mask there. */
  _mgrad(x, y, z, lod, mm) {
    const R = this.R, w = this._w2, out = this._mg;
    const e = 60 / R;
    // tangent basis
    let ax, ay, az;
    if (Math.abs(y) < 0.9) { ax = z; ay = 0; az = -x; } else { ax = 0; ay = -z; az = y; }
    let l = 1 / Math.hypot(ax, ay, az); ax *= l; ay *= l; az *= l;
    const bx = y * az - z * ay, by = z * ax - x * az, bz = x * ay - y * ax;
    let d1, d2;
    {
      let qx = x + ax * e, qy = y + ay * e, qz = z + az * e; l = 1 / Math.hypot(qx, qy, qz); qx *= l; qy *= l; qz *= l;
      this._warp(qx, qy, qz, w);
      d1 = (this._mtnMask(w[0], w[1], w[2], this._continent(w[0], w[1], w[2], lod) - this.oceanBias) - mm) / 60;
    }
    {
      let qx = x + bx * e, qy = y + by * e, qz = z + bz * e; l = 1 / Math.hypot(qx, qy, qz); qx *= l; qy *= l; qz *= l;
      this._warp(qx, qy, qz, w);
      d2 = (this._mtnMask(w[0], w[1], w[2], this._continent(w[0], w[1], w[2], lod) - this.oceanBias) - mm) / 60;
    }
    out[0] = ax * d1 + bx * d2; out[1] = ay * d1 + by * d2; out[2] = az * d1 + bz * d2;
    return out;
  }

  /** One octave of the slope-aligned gully filter (3D, compact-support cells). (dx,dy,dz) = stripe dir. */
  _eroCell(qx, qy, qz, dx, dy, dz, out) {
    const ix = Math.floor(qx), iy = Math.floor(qy), iz = Math.floor(qz);
    const fx = qx - ix, fy = qy - iy, fz = qz - iz;
    const P = this.nG.perm, J = this.nG.jit;
    let va = 0, gs = 0, wt = 0;
    for (let k = -1; k <= 1; k++) {
      const pk = P[(iz + k) & 1023];
      const oz0 = fz - k;
      for (let j = -1; j <= 1; j++) {
        const pj = P[(pk + iy + j) & 1023];
        const oy0 = fy - j;
        for (let i = -1; i <= 1; i++) {
          const h = P[(pj + ix + i) & 1023] << 2;
          const ox = fx - i - J[h], oy = oy0 - J[h + 1], oz = oz0 - J[h + 2];
          const d2 = ox * ox + oy * oy + oz * oz;
          if (d2 >= 1) continue;
          const w0 = 1 - d2, w = w0 * w0 * w0;
          const mag = (ox * dx + oy * dy + oz * dz) * TAU;
          va += Math.cos(mag) * w;
          gs -= Math.sin(mag) * w;
          wt += w;
        }
      }
    }
    // generous regularizer: where few kernels overlap the value fades out smoothly instead of
    // snapping from cos() to 0 over a few metres (that snap made needle walls on steep faces)
    const inv = 1 / (wt + 0.08);
    out[0] = gs * inv * TAU;
    return va * inv;
  }

  /**
   * Gully erosion: stripes aligned with the downhill direction, branching per octave
   * (after Fewes / clayjohn "eroded terrain noise", adapted to 3D on a sphere).
   * G = height gradient in m/m (tangent). Returns a height offset in meters (~[-1,1]*amp).
   */
  _gullies(x, y, z, lod, Gx, Gy, Gz, strength) {
    const st = this.st, R = this.R, e = this._e;
    const SLOPE = 1.8, BRANCH = 0.5;
    let wl = st.gullyWl, a = st.gullyAmp * wl * strength;
    let h = 0, ex = 0, ey = 0, ez = 0;
    const gMag = Math.hypot(Gx, Gy, Gz);
    for (let o = 0; o < 5; o++) {
      const lw = lodW(wl * 0.33, lod);
      if (lw <= 0) break;
      // branching is scaled by the base slope: at ridge crests (G → 0, direction flipping) the
      // accumulated octave derivatives must not steer the stripes, or they turn chaotic
      const bk = BRANCH * Math.min(1, gMag / 0.35);
      let sx = Gx + ex * bk, sy = Gy + ey * bk, sz = Gz + ez * bk;
      // clamp the slope magnitude: stripe frequency must stay ~1-3 per cell or steep faces alias
      // into needles (the filter only needs the downhill DIRECTION + a soft strength)
      const sl = Math.hypot(sx, sy, sz);
      if (sl > 1.1) { const k = 1.1 / sl; sx *= k; sy *= k; sz *= k; }
      // perpendicular to the slope within the tangent plane: up × S
      const dx = (y * sz - z * sy) * SLOPE, dy = (z * sx - x * sz) * SLOPE, dz = (x * sy - y * sx) * SLOPE;
      const f = R / wl;
      const v = this._eroCell(x * f + o * 7.1, y * f + o * 3.3, z * f + o * 5.9, dx, dy, dz, e);
      const c = a * lw;
      const k2 = dx * dx + dy * dy + dz * dz;
      h += c * (v - Math.exp(-2.45 * k2 - 1.5 * k2 * k2));
      // gradient of this octave in m/m, along dir: d/dm = c * e * dir / wl
      const gk = (c * e[0]) / wl;
      ex += gk * dx; ey += gk * dy; ez += gk * dz;
      a *= 0.46; wl *= 0.5;
    }
    return h;
  }

  // ------------------------------------------------------------------ cellular features
  /**
   * Visits the jittered 3D cell points around q (= p*f on the sphere of radius f), projected onto
   * that sphere. cb(dist, hashIndex) gets the surface distance in cell units. Returns max of cb.
   */
  _cells(qx, qy, qz, f, jitter, cb) {
    const ix = Math.floor(qx), iy = Math.floor(qy), iz = Math.floor(qz);
    const P = this.nG.perm, J = this.nG.jit;
    const j0 = (1 - jitter) * 0.5;
    let best = 0;
    for (let k = -1; k <= 1; k++) {
      const pk = P[(iz + k + 512) & 1023];
      for (let j = -1; j <= 1; j++) {
        const pj = P[(pk + iy + j + 512) & 1023];
        for (let i = -1; i <= 1; i++) {
          const hsh = P[(pj + ix + i + 512) & 1023];
          const h = hsh << 2;
          let cx = ix + i + j0 + jitter * J[h], cy = iy + j + j0 + jitter * J[h + 1], cz = iz + k + j0 + jitter * J[h + 2];
          const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
          // only points in a half-cell shell around the sphere: guarantees every projected point
          // that can influence q lives in the 3x3x3 neighbourhood (continuity)
          if (cl - f > 0.5 || f - cl > 0.5) continue;
          const s = f / cl;
          cx = cx * s - qx; cy = cy * s - qy; cz = cz * s - qz;
          const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
          if (d < 1.2) { const v = cb(d, h); if (v > best) best = v; }
        }
      }
    }
    return best;
  }

  _craters(x, y, z, lod) {
    const st = this.st, J = this.nG.jit, wls = st.craterWl;
    let h = 0;
    for (let s = 0; s < wls.length; s++) {
      const wl = wls[s];
      if (wl * 0.25 < lod) break;
      const f = this.R / wl;
      const qx = x * f, qy = y * f, qz = z * f;
      const depth = Math.min(this.A * 0.35, wl * 0.11);
      let acc = 0;
      const ix = Math.floor(qx), iy = Math.floor(qy), iz = Math.floor(qz);
      const P = this.nG.perm;
      for (let k = -1; k <= 1; k++) {
        const pk = P[(iz + k + 97 * s + 512) & 1023];
        for (let j = -1; j <= 1; j++) {
          const pj = P[(pk + iy + j + 512) & 1023];
          for (let i = -1; i <= 1; i++) {
            const h4 = P[(pj + ix + i + 512) & 1023] << 2;
            if (J[h4 + 3] > 0.55 * st.craters + 0.12) continue;           // presence
            let cx = ix + i + J[h4], cy = iy + j + J[h4 + 1], cz = iz + k + J[h4 + 2];
            const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1, sc = f / cl;
            if (cl - f > 0.5 || f - cl > 0.5) continue;
            cx = cx * sc - qx; cy = cy * sc - qy; cz = cz * sc - qz;
            const rad = 0.16 + 0.26 * J[(h4 + 5) & 4095];
            const d = Math.sqrt(cx * cx + cy * cy + cz * cz) / rad;
            if (d > 1.9) continue;
            const age = J[(h4 + 6) & 4095];                                // old craters are softer
            const dd = depth * rad * (0.55 + 0.45 * (1 - age));
            let p;
            if (d < 1) {
              p = (d * d - 1) * (1 - 0.25 * age);                         // bowl
              p = p * (1 - 0.35 * sstep(0.0, 0.5, 1 - d) * (s < 2 ? 1 : 0)); // flat floor on big ones
              if (s < 2 && d < 0.22) p += 0.35 * (1 - d / 0.22) * (1 - d / 0.22); // central peak
              p += 0.28 * d * d * d * d;                                     // rim wall rise
            } else {
              const t = (d - 1) / 0.9;
              p = 0.28 * Math.exp(-t * t * 3.2) * (1 - t * 0.2) * (1 - sstep(0.55, 1, t)); // rim + ejecta
            }
            acc += p * dd;
          }
        }
      }
      h += acc;
    }
    return h;
  }

  // ------------------------------------------------------------------ profiles
  static mesa(v) {
    // v >= 0 caprock top, [-0.75,0) steep cliff (~70-80°: steep but still a well-conditioned
    // heightfield — true verticals shade as vertical stripes), [-2,-0.75) concave talus apron
    if (v >= 0) return 1 - 0.03 * Math.exp(-v * 18);
    if (v > -0.75) { const t = -v / 0.75; return 0.97 - 0.55 * (t * 0.85 + 0.15 * t * t); }
    if (v > -2) { const t = (v + 2) / 1.25; return 0.42 * t * t; }
    return 0;
  }

  /** smooth plateau-shaped window: 0 below a, 1 on [b,c], 0 above d */
  static band(x, a, b, c, d) { return sstep(a, b, x) * (1 - sstep(c, d, x)); }

  static terrace(t, steps, sharp) {
    const s = t * steps, f = Math.floor(s);
    let r = s - f;
    r = sstep(1 - sharp, 1, r);
    return (f + r) / steps;
  }

  // ------------------------------------------------------------------ main evaluation
  /**
   * Full evaluation. lod = finest wavelength to synthesize (m). info (optional) receives
   * { c, land, mtn, rock, sand, river, lake, snow, cliff, dune, strata } material hints (0..1).
   */
  /** Height (m) at unit direction with octaves finer than `lod` removed; fills `info` hints. */
  evaluate(x, y, z, lod = LOD_MIN, info = null) {
    const h = this._eval(x, y, z, lod, info);
    const F = this.flats;
    if (!F.length) return h;
    let out = h, k = 0;
    for (let i = 0; i < F.length; i++) {
      const f = F[i];
      const c = x * f.x + y * f.y + z * f.z;
      if (c <= f.cosOuter) continue;
      const d = Math.acos(c < 1 ? c : 1) * this.R;
      const t = d <= f.radius ? 1 : 1 - sstep(0, 1, (d - f.radius) / f.falloff);
      out += (f.height - out) * t;
      if (t > k) k = t;
    }
    if (info && k > 0) {
      const kk = 1 - k;
      info.rock *= kk; info.cliff *= kk; info.river *= kk; info.lake *= kk; info.dune *= kk; info.sand *= kk;
    }
    return out;
  }

  _eval(x, y, z, lod = LOD_MIN, info = null) {
    const st = this.st, R = this.R, A = this.A, g = this._g;
    this._warp(x, y, z, g);
    const px = g[0], py = g[1], pz = g[2];
    let c = this._continent(px, py, pz, lod) - this.oceanBias;
    const nF = this.nF, nH = this.nH;
    let rock = 0, sand = 0, river = 0, lake = 0, cliff = 0, dune = 0, glacier = 0;

    // ---- coastal cliffs along a perturbed coastline (before the base profile)
    let cliffMask = 0;
    if (st.cliffs > 0 && this.hasOcean) {
      cliffMask = st.cliffs * sstep(-0.15, 0.35, nF.n3(px * 9 + 3.3, py * 9 + 1.2, pz * 9 + 7.7));
    }

    // ---- base elevation from the continental value
    let h;
    const land = sstep(-0.01, 0.1, c);
    if (c < 0) {
      const dd = -c;
      h = -A * (0.08 * dd + 0.02 * sstep(0, 0.06, dd) + 0.3 * sstep(0.03, 0.4, dd));
    } else {
      h = A * (0.12 * c + 0.3 * c * c) * st.uplands;
    }

    // ---- rolling hills (IQ derivative-damped fbm), faded at the coast
    if (st.hills > 0) {
      const d = this._d;
      let wl = st.hillWl, f = R / wl, qx = x * f, qy = y * f, qz = z * f;
      let a = 1, sum = 0, dxs = 0, dys = 0, dzs = 0;
      for (let o = 0; o < 5; o++) {
        const lw = lodW(wl, lod);
        if (lw <= 0) break;
        const v = nH.n3d(qx, qy, qz, d);
        dxs += d[0]; dys += d[1]; dzs += d[2];
        const rd = dxs * x + dys * y + dzs * z;
        const tx = dxs - rd * x, ty = dys - rd * y, tz = dzs - rd * z;
        sum += a * lw * v / (1 + 0.6 * (tx * tx + ty * ty + tz * tz));
        a *= 0.47; wl *= ILAC; f *= LAC;
        qx = qx * LAC + 5.2; qy = qy * LAC + 1.3; qz = qz * LAC + 9.1;
      }
      const hillMask = 0.35 + 0.65 * sstep(-0.4, 0.5, nH.n3(px * 5 + 1, py * 5 + 2, pz * 5 + 3));
      const coastFade = sstep(0.0, 0.07, c);
      h += A * st.hillAmp * st.hills * hillMask * coastFade * (sum * 1.1 + 0.25);
    }

    // ---- mountain ranges
    let mtn = 0, steep = 0;
    if (st.mountains > 0) {
      const mm = this._mtnMask(px, py, pz, c);
      const mp0 = Math.pow(mm, 1.35);
      if (A * st.mtnHeight * mp0 > 0.02) {
        const mv = this._mountain(x, y, z, lod, g);
        const gxm = g[0], gym = g[1], gzm = g[2];
        const mp = mp0;
        const H = A * st.mtnHeight * mp;
        let hm = H * mv;
        const sc = H / R;
        // slope of the range MASK (m/m): where a range rises out of the lowlands/coast over a few
        // hundred metres, H·mv·∇mask makes kilometre-tall walls that the ridge-noise gradient
        // knows nothing about. Finite differences of the mask (only inside its ramp) feed the
        // steep-face detection, so those walls grow buttresses and crags instead of reading as
        // smooth clay slabs.
        let mgx = 0, mgy = 0, mgz = 0;
        if (mm > 0.004 && mm < 0.996 && lod < 400) {
          const m = this._mgrad(x, y, z, lod, mm);
          // faded at both ends of the ramp (the mask is clamped at 1: its gradient jumps to 0 there,
          // and a discontinuous slope would re-orient the gully stripes abruptly → seam lines)
          const k = A * st.mtnHeight * mv * 1.35 * Math.pow(mm, 0.35) * sstep(0.004, 0.06, mm) * (1 - sstep(0.8, 0.99, mm));
          mgx = m[0] * k; mgy = m[1] * k; mgz = m[2] * k;
        }
        // gully erosion filter where the mountain mass is significant (strength fades continuously)
        const gs = st.erosion * sstep(0.0, 0.5, mp) * Math.min(1, H / 700);
        if (gs > 1e-4) {
          // (the gullies keep the ridge-noise slope only: steered by the mask slope, whose direction
          //  rotates around troughs on the apron, the stripes curled into concentric rings)
          hm += this._gullies(x, y, z, lod, gxm * sc, gym * sc, gzm * sc, gs);
        }
        // glacial valleys: flatten valley floors of high cold ranges into U-shapes
        if (st.glaciers > 0) {
          const lat = Math.abs(y);
          const cold = sstep(0.25, 0.75, lat + st.glaciers * 0.35 - st.tempBias * 0.5);
          const u = sstep(0.18, 0.02, mv) * cold * mp;
          if (u > 0) { hm = hm * (1 - 0.55 * u) + H * 0.05 * u; glacier = u; }
        }
        h += hm;
        mtn = mp * sstep(0.08, 0.35, mv);
        // steep mountain faces (large-scale slope of the range, m/m): drives buttresses & couloirs
        steep = sstep(0.5, 1.3, Math.hypot(g[3] * sc + mgx, g[4] * sc + mgy, g[5] * sc + mgz)) * sstep(0.2, 0.55, mp);
        // buttresses & couloirs: relief proportional to the wall (≈9 % of each wavelength, 1.4 km →
        // 170 m) — on a steep heightfield face, height bumps become plan-view ribs and chutes
        if (steep > 0.01) h += steep * this._buttress(x, y, z, lod) * Math.min(1, H / 1500);
      }
    }

    // ---- plateaus (large tablelands) and mesas (isolated buttes), with strata terraces
    if ((st.plateaus > 0 || st.mesas > 0) && c > -0.02) {
      const inland = sstep(0.02, 0.12, c);
      if (st.plateaus > 0) {
        const f = R / st.plateauWl;
        const wv = nF.n3(px * f * 0.5 + 3, py * f * 0.5 + 7, pz * f * 0.5 + 1) * 0.35;
        const pn = nF.n3(px * f + wv, py * f + 11.1 - wv, pz * f + 4.4) * 0.75 + nF.n3(px * f * 2.7, py * f * 2.7 + 5, pz * f * 2.7 + 9) * 0.25;
        const reg = sstep(-0.2, 0.3, nF.n3(px * 2.1 + 40, py * 2.1, pz * 2.1)) * st.plateaus;
        const v1 = (pn - 0.12) / 0.07, v2 = (pn - 0.42) / 0.06;
        const p1 = SurfaceGen.mesa(v1), p2 = SurfaceGen.mesa(v2);
        const add = st.plateauH * (p1 + 0.8 * p2) * reg * inland;
        h += add;
        const cl = Math.min(1, SurfaceGen.band(v1, -1.0, -0.8, -0.02, 0.06) + SurfaceGen.band(v2, -1.0, -0.8, -0.02, 0.06)) * reg * inland;
        if (cl > cliff) cliff = cl;
        if (cl > rock) rock = cl;
      }
      if (st.mesas > 0) {
        const f = R / st.mesaWl;
        const wv = nF.n3(px * f * 0.7 + 9, py * f * 0.7 + 2, pz * f * 0.7 + 5) * 0.4;
        const mn = nF.n3(px * f + 13 + wv, py * f + 2.5, pz * f + 6.5 - wv);
        const reg = sstep(-0.15, 0.35, nF.n3(px * 1.7 + 70, py * 1.7, pz * 1.7 + 3)) * st.mesas;
        const v = (mn - 0.48) / 0.05;
        const p = SurfaceGen.mesa(v);
        const mh = st.plateauH * (1.2 + 0.8 * sstep(-1, 1, nF.n3(px * f * 0.3, py * f * 0.3 + 3, pz * f * 0.3)));
        h += mh * p * reg * inland;
        const cl = SurfaceGen.band(v, -1.0, -0.8, 0.02, 0.12) * reg * inland;
        if (cl > cliff) cliff = cl;
        if (cl > rock) rock = cl;
      }
    }

    // ---- canyons: meandering, terraced walls, flat floors
    if (st.canyons > 0 && c > 0.01) {
      const f = R / st.canyonWl;
      const wv = nF.n3(px * f * 0.6 + 8, py * f * 0.6 + 1, pz * f * 0.6 + 3);
      const wm = nF.n3(px * f * 2.6 + 4.4, py * f * 2.6 + 1.2, pz * f * 2.6 + 8.1);
      const cn = nF.n3(px * f + 0.9 * wv + 0.28 * wm, py * f + 2 - 0.5 * wv - 0.2 * wm, pz * f + 5 + 0.25 * wm) + 0.15 * nF.n3(px * f * 4, py * f * 4 + 1, pz * f * 4 + 2);
      const reg = sstep(-0.25, 0.25, nF.n3(px * 1.9 + 90, py * 1.9 + 3, pz * 1.9)) * st.canyons * sstep(0.02, 0.12, c);
      const v = Math.abs(cn) / 0.11;
      if (v < 1 && reg > 0) {
        let prof;
        if (v < 0.18) prof = 1;
        else prof = 1 - SurfaceGen.terrace((v - 0.18) / 0.82, 5, 0.42);
        const carve = st.canyonDepth * reg * prof;
        const floor = this.hasOcean ? Math.min(h, 4) : -1e9;
        h = Math.max(h - carve, floor);
        const wall = SurfaceGen.band(v, 0.1, 0.2, 0.85, 1.0) * reg;
        if (wall > rock) rock = wall;
        if (wall * 0.8 > cliff) cliff = wall * 0.8;
        sand = Math.max(sand, 0.6 * reg * (1 - sstep(0.12, 0.22, v)));
      }
    }

    // ---- terraces (stepped hillsides, strata)
    if (st.terraces > 0 && h > 20) {
      const reg = sstep(0.0, 0.4, nF.n3(px * 2.4 + 17, py * 2.4 + 9, pz * 2.4 + 4)) * st.terraces * sstep(20, 80, h);
      if (reg > 0) {
        const step = 42 + 30 * (0.5 + 0.5 * nF.n3(px * 6, py * 6 + 4, pz * 6 + 2));
        const t = SurfaceGen.terrace(h / step, 1, 0.28) * step;
        h = h + (t - h) * reg * 0.55;
      }
    }

    // ---- karst towers (Guilin / Ha Long): steep limestone towers with rounded tops
    if (st.karst > 0 && c > -0.03) {
      const reg = sstep(-0.1, 0.35, nF.n3(px * 3.1 + 5, py * 3.1 + 55, pz * 3.1)) * st.karst;
      if (reg > 0.01) {
        const f = R / st.karstWl, J = this.nG.jit;
        const kh = st.karstH;
        const t = this._cells(x * f, y * f, z * f, f, 0.75, (d, hh) => {
          const rad = 0.22 + 0.16 * J[hh + 3];
          const q = d / rad;
          if (q >= 1.5) return 0;
          const ht = 0.45 + 0.55 * J[(hh + 4) & 4095];
          let p;
          if (q < 1) p = 0.12 + 0.88 * Math.pow(1 - q * q * q * q, 0.65);
          else { const u = (q - 1) / 0.5; p = 0.12 * (1 - u) * (1 - u); }
          return p * ht;
        });
        if (t > 0) {
          h += kh * reg * t;
          rock = Math.max(rock, reg * sstep(0.15, 0.4, t));
          cliff = Math.max(cliff, reg * SurfaceGen.band(t, 0.2, 0.5, 0.85, 0.97));
        }
      }
    }

    // ---- spires / crystal needles / hoodoos
    if (st.spires > 0 && c > 0) {
      const reg = sstep(0.0, 0.4, nF.n3(px * 2.6 + 44, py * 2.6 + 3, pz * 2.6 + 19)) * st.spires;
      if (reg > 0.01) {
        const f = R / st.spireWl, J = this.nG.jit;
        const t = this._cells(x * f + 3.3, y * f, z * f + 1.1, f, 0.8, (d, hh) => {
          if (J[(hh + 7) & 4095] > 0.55) return 0;
          const rad = 0.07 + 0.08 * J[hh + 3];
          const q = d / rad;
          if (q >= 1.8) return 0;
          const ht = 0.35 + 0.65 * J[(hh + 4) & 4095];
          const p = q < 1 ? 0.05 + 0.95 * Math.pow(1 - q, 0.55) : 0.05 * (1.8 - q) / 0.8;
          return p * ht;
        });
        if (t > 0) { h += st.spireH * reg * t; const k = reg * sstep(0.03, 0.12, t); if (k > rock) rock = k; if (k * 0.8 > cliff) cliff = k * 0.8; }
      }
    }

    // ---- kopjes: granite boulder hills on savanna plains
    if (st.kopjes > 0 && c > 0.02) {
      const f = R / 900, J = this.nG.jit;
      const reg = sstep(0.1, 0.5, nF.n3(px * 4 + 8, py * 4, pz * 4 + 33)) * st.kopjes;
      if (reg > 0.01) {
        const t = this._cells(x * f + 7.7, y * f, z * f, f, 0.7, (d, hh) => {
          if (J[(hh + 9) & 4095] > 0.4) return 0;
          const q = d / (0.18 + 0.12 * J[hh + 3]);
          return q < 1 ? Math.sqrt(1 - q * q) * (0.5 + 0.5 * J[hh + 2]) : 0;
        });
        if (t > 0) {
          const bumps = 0.6 + 0.4 * Math.abs(nF.n3(x * R / 18, y * R / 18, z * R / 18));
          h += 45 * reg * t * bumps;
          rock = Math.max(rock, reg * sstep(0.05, 0.3, t));
        }
      }
    }

    // ---- dunes: transverse crests with sharp slip faces, sinuous, in dry basins
    if (st.dunes > 0 && c > 0.005) {
      const reg = sstep(-0.05, 0.35, nF.n3(px * 2.2 + 81, py * 2.2 + 8, pz * 2.2 + 1)) * st.dunes * (1 - mtn);
      if (reg > 0.01) {
        const D = st.duneDir, wl = st.duneWl;
        const f = R / wl;
        const warpA = nF.n3(x * R / (wl * 7), y * R / (wl * 7) + 3, z * R / (wl * 7) + 8);
        const phase = (x * D[0] + y * D[1] + z * D[2]) * f + 1.6 * warpA + 0.35 * nF.n3(x * R / (wl * 2.2), y * R / (wl * 2.2), z * R / (wl * 2.2));
        const s = phase - Math.floor(phase);
        const prof = s < 0.78 ? sstep(0, 1, s / 0.78) : 1 - sstep(0, 1, (s - 0.78) / 0.22);
        const crestVar = 0.55 + 0.45 * nF.n3(x * R / (wl * 3.3) + 5, y * R / (wl * 3.3), z * R / (wl * 3.3));
        const dh = st.duneH * reg * crestVar * prof * sstep(0.005, 0.05, c);
        // secondary smaller dunes
        const phase2 = (x * D[2] - y * D[0] + z * D[1]) * f * 3.1 + warpA * 2;
        const s2 = phase2 - Math.floor(phase2);
        const prof2 = s2 < 0.7 ? s2 / 0.7 : (1 - s2) / 0.3;
        h += dh + reg * 2.2 * prof2 * prof2;
        dune = reg;
        sand = Math.max(sand, reg);
      }
    }

    // ---- craters (moons, barren worlds)
    if (st.craters > 0) {
      h += this._craters(x, y, z, lod) * st.craters;
    }

    // ---- volcanoes with calderas
    if (st.volcano > 0 && c > -0.05) {
      const f = R / (R * 0.28), J = this.nG.jit;
      let lava = 0;
      const t = this._cells(x * f + 2, y * f + 4, z * f + 6, f, 0.8, (d, hh) => {
        if (J[(hh + 11) & 4095] > 0.6) return 0;
        const rad = 0.3 + 0.15 * J[hh + 3];
        const q = d / rad;
        if (q >= 1) return 0;
        let p = Math.pow(1 - q, 1.6);
        const cr = 0.14 + 0.05 * J[hh + 1];
        if (q < cr) { p = Math.pow(1 - cr, 1.6) - 0.5 * (1 - q / cr) * (1 - q / cr) * 0.35; lava = 1; }
        return p;
      });
      if (t > 0) { h += A * 0.75 * st.volcano * t; rock = Math.max(rock, sstep(0.2, 0.6, t)); }
      void lava;
    }

    // ---- sea stacks and cliff-lined coasts
    if (this.hasOcean && (cliffMask > 0 || st.seastacks > 0)) {
      if (cliffMask > 0 && c > -0.004) {
        const jag = 0.0025 * nF.n3(x * R / 420, y * R / 420, z * R / 420);
        const k = sstep(-0.0005, 0.0012, c + jag);
        const ch = (25 + 60 * sstep(-0.3, 0.7, nF.n3(px * 30, py * 30, pz * 30))) * cliffMask;
        h = Math.max(h, h * (1 - k) + (Math.max(h, 0) + ch) * k);
        const cb = SurfaceGen.band(c, -0.0015, -0.0008, 0.003, 0.005) * cliffMask;
        if (cb > rock) rock = cb;
        if (cb > cliff) cliff = cb;
      }
      if (st.seastacks > 0 && c > -0.05 && c < 0.012) {
        const f = R / 380, J = this.nG.jit;
        const zone = sstep(-0.05, -0.012, c) * (1 - sstep(0.004, 0.012, c));
        const reg = sstep(-0.2, 0.3, nF.n3(px * 7 + 3, py * 7, pz * 7 + 1)) * st.seastacks * zone * (1 - sstep(4, 30, h));
        if (reg > 0.01) {
          const t = this._cells(x * f, y * f + 7, z * f, f, 0.8, (d, hh) => {
            if (J[(hh + 13) & 4095] > 0.5) return 0;
            const q = d / (0.13 + 0.1 * J[hh + 3]);
            if (q >= 1.3) return 0;
            const ht = 0.45 + 0.55 * J[hh + 2];
            return (q < 1 ? 0.06 + 0.94 * Math.pow(1 - Math.pow(q, 5), 0.6) : 0.06 * (1.3 - q) / 0.3) * ht;
          });
          if (t > 0) {
            const top = 40 + 110 * (st.seastacks > 0.9 ? 1 : 0.6);
            h = Math.max(h, h + (top - h + 4) * t * reg);
            const k = reg * sstep(0.04, 0.14, t);
            if (k > rock) rock = k;
            if (k > cliff) cliff = k;
          }
        }
      }
    }

    // ---- atolls: coral rings with lagoons in warm shallow seas
    if (st.atolls > 0 && this.hasOcean && c < 0.0 && c > -0.22) {
      const f = R / 4200, J = this.nG.jit;
      const t = this._cells(x * f + 9, y * f + 3, z * f + 1, f, 0.8, (d, hh) => {
        if (J[(hh + 15) & 4095] > 0.45) return 0;
        const rr = 0.28 + 0.12 * J[hh + 3];
        const q = (d - rr) / 0.06;
        const ring = Math.exp(-q * q);
        const inside = d < rr ? 0.55 : 0;
        return Math.max(ring, inside * 0.2);
      });
      if (t > 0) {
        const bump = 2.2 + 3 * nF.n3(x * R / 300, y * R / 300, z * R / 300);
        const target = -6 - 10 * (1 - t) + (bump + 6 + 10 * (1 - t)) * sstep(0.2, 0.32, t);
        h = Math.max(h, h + (target - h) * sstep(0.0, 0.3, t) * st.atolls);
        sand = Math.max(sand, sstep(0.2, 0.35, t));
      }
    }

    // ---- river valleys (dry valleys in highlands, sea-level channels in lowlands) + lakes
    if ((st.rivers > 0 || st.fjords > 0) && c > -0.01) {
      const f = R / st.riverWl;
      const wv = nF.n3(px * f * 0.45 + 2, py * f * 0.45 + 6, pz * f * 0.45 + 9);
      const rn = nF.n3(px * f + wv * 1.1, py * f + 30 + wv * 0.4, pz * f + 12) + 0.18 * nF.n3(px * f * 3.3 + 1, py * f * 3.3, pz * f * 3.3 + 4);
      const reg = sstep(-0.3, 0.2, nF.n3(px * 1.5 + 200, py * 1.5, pz * 1.5 + 7)) * Math.max(st.rivers, st.fjords);
      const av = Math.abs(rn);
      if (reg > 0 && av < 0.16) {
        const valley = 1 - sstep(0.0, 0.16, av);
        const vshape = valley * valley * (3 - 2 * valley);
        const hv = h * (1 - 0.62 * vshape * reg);
        h = hv;
        if (this.hasOcean) {
          const chan = 1 - sstep(0.012, 0.03, av);
          const low = 1 - sstep(st.fjords > 0 ? 400 : 45, st.fjords > 0 ? 1200 : 160, hv);
          if (chan > 0 && low > 0) {
            const bed = st.fjords > 0 ? -40 * mtn - 4 : -3.5;
            const k = chan * low * reg;
            h = h + (bed - h) * k;
            river = k;
            if (st.fjords > 0) { const k = sstep(0.1, 0.3, mtn) * mtn * (1 - chan) * low; if (k > cliff) cliff = k; }
          }
        } else {
          const chan = 1 - sstep(0.01, 0.028, av);
          h -= 6 * chan * reg;
          river = chan * reg * 0.6;
        }
        sand = Math.max(sand, (1 - sstep(0.015, 0.05, av)) * reg * 0.8);
      }
    }
    if (st.lakes > 0 && this.hasOcean && c > 0.01) {
      const f = R / (5200 * Math.max(0.5, R / 70000)), J = this.nG.jit;
      const reg = st.lakes * sstep(-0.1, 0.3, nF.n3(px * 2.7 + 300, py * 2.7, pz * 2.7 + 1));
      if (reg > 0.02 && h < 220) {
        const warpL = 0.12 * nF.n3(px * R / 900, py * R / 900, pz * R / 900);
        const t = this._cells(px * f, py * f + 5, pz * f + 11, f, 0.7, (d, hh) => {
          if (J[(hh + 17) & 4095] > 0.55) return 0;
          const rr = 0.2 + 0.2 * J[hh + 3];
          const q = (d + warpL) / rr;
          return q < 1.6 ? 1 - sstep(0.55, 1.6, q) : 0;
        });
        if (t > 0) {
          const low = 1 - sstep(60, 220, h);
          const k = t * low * reg;
          const target = -2 - 14 * sstep(0.6, 1, t);
          h = h + (target - h) * sstep(0.0, 0.6, k);
          lake = sstep(0.3, 0.7, k);
        }
      }
    }

    // ---- sinkholes / cenotes
    if (st.sinkholes > 0 && c > 0.02) {
      const f = R / 1100, J = this.nG.jit;
      const reg = sstep(0.0, 0.4, nF.n3(px * 3.3 + 2, py * 3.3 + 400, pz * 3.3)) * st.sinkholes;
      if (reg > 0.02) {
        const t = this._cells(x * f + 1, y * f + 2, z * f + 3, f, 0.8, (d, hh) => {
          if (J[(hh + 19) & 4095] > 0.35) return 0;
          const q = d / (0.08 + 0.07 * J[hh + 3]);
          return q < 1 ? Math.pow(1 - q * q * q * q * q * q, 0.5) : 0;
        });
        if (t > 0) { h -= 70 * reg * t; const k = reg * SurfaceGen.band(t, 0.05, 0.15, 0.93, 0.99); if (k > rock) rock = k; if (k > cliff) cliff = k; }
      }
    }

    // ---- rilles (lunar sinuous channels)
    if (st.rilles > 0) {
      const f = R / 5000;
      const rn = nF.n3(px * f + 3, py * f + 3 + 0.5 * nF.n3(px * f * 0.4, py * f * 0.4, pz * f * 0.4), pz * f);
      const v = Math.abs(rn) / 0.03;
      if (v < 1) h -= 60 * (1 - v * v) * st.rilles * sstep(-0.2, 0.3, nF.n3(px * 2, py * 2 + 9, pz * 2));
    }

    // ---- rock outcrops scattered through grassland & hills (BotW-style)
    if (st.outcrops > 0 && c > 0.02 && lod < 60) {
      const f = R / 70;
      const on = this.nH.n3(x * f + 7, y * f + 3, z * f + 5) * 0.7 + this.nH.n3(x * f * 2.3, y * f * 2.3, z * f * 2.3) * 0.3;
      const reg = sstep(-0.2, 0.5, this.nH.n3(x * R / 900 + 4, y * R / 900, z * R / 900 + 8)) * st.outcrops;
      const t = sstep(0.42, 0.62, on) * reg * (1 - dune) * (1 - river);
      if (t > 0) { h += t * (2.2 + 3.5 * reg) * lodW(28, lod); rock = Math.max(rock, sstep(0.1, 0.5, t)); }
    }

    // ---- beaches: compress heights near sea level into wide flat sands / shallow shelves
    if (this.hasOcean && h > -st.beachH * 2 && h < st.beachH * 2) {
      const bk = st.beach * (1 - cliff) * (1 - sstep(0.3, 0.8, rock));
      if (bk > 0) {
        const H = st.beachH * 2;
        const t = Math.abs(h) / H;
        const f = 0.25 * t + 1.5 * t * t - 0.75 * t * t * t;
        const hb = (h < 0 ? -f : f) * H;
        h = h + (hb - h) * bk;
      }
      sand = Math.max(sand, (1 - sstep(st.beachH * 0.15, st.beachH * 0.55, h)) * (1 - cliff));
    }

    // ---- fractal detail: meso bumps → decimetre relief (rougher on rock)
    {
      const rk = rock > mtn ? rock : mtn;
      const roughK = st.rough * (0.35 + 2.6 * rk) * (1 - 0.6 * dune) * (1 - 0.5 * lake);
      const rr = sstep(0.15, 0.5, rk);
      // starts at 720 m: the two big octaves only exist on rock (crags & buttresses on mountain faces)
      let wl = 720, f = R / wl, qx = x * f, qy = y * f, qz = z * f, a = wl * 0.0072 * roughK, sum = 0;
      for (let o = 0; o < 14; o++) {
        const lw = lodW(wl, lod);
        if (lw <= 0) break;
        const v = nH.n3(qx, qy, qz);
        // crags & buttresses: the big octaves are much stronger on rock (cliff faces get real
        // plan-view relief — chutes, ribs, buttresses — instead of reading as smooth clay walls)
        // on steep mountain faces the big octaves grow further (buttresses, ribs and chutes that break
        // kilometre-tall walls into readable structure instead of smooth clay slabs)
        const big = wl > 200 ? rr * (o === 0 ? 2.4 : 2.0) * (1 + 1.8 * steep) : wl > 120 ? (1 + 0.6 * rr) * (1 + 1.2 * steep) : wl > 60 ? (1 + 0.25 * rr) * (1 + 0.6 * steep) : 1;
        // rock gets sharper (ridged, zero-mean) micro relief, soil stays rounded
        // (big octaves use a softened |v|: a razor crease of a 700 m ridged octave reads as a seam)
        const av = wl > 120 ? Math.sqrt(v * v + 0.004) : (v < 0 ? -v : v);
        sum += a * lw * big * (v + ((0.342 - av) * 1.6 - v) * rr);
        a *= 0.49; wl *= ILAC;
        qx = qx * LAC + 1.9; qy = qy * LAC + 7.3; qz = qz * LAC + 3.7;
      }
      h += sum;
    }

    if (info) {
      info.c = c; info.land = land; info.mtn = mtn; info.rock = rock; info.sand = sand;
      info.river = river; info.lake = lake; info.cliff = cliff; info.dune = dune; info.glacier = glacier;
      info.steep = steep;
    }
    return h;
  }

  /** Full-detail height (m) at unit direction. The exact surface the player stands on. */
  height(x, y, z) { return this.evaluate(x, y, z, LOD_MIN, null); }
  /** Cheaper height with octaves finer than `lod` meters removed (for distant queries). */
  heightLod(x, y, z, lod) { return this.evaluate(x, y, z, lod > LOD_MIN ? lod : LOD_MIN, null); }

  // ------------------------------------------------------------------ climate & biomes
  /** temperature (≈-0.5..1.3) and moisture (≈0..1) for a point with known height/continentality */
  climate(x, y, z, h, c, out) {
    const st = this.st, nB = this.nB, A = this.A;
    const lat = Math.abs(y);
    let t = 1.02 - 1.15 * Math.pow(lat, 1.25) - Math.max(0, h) / A * 0.95 + st.tempBias;
    t += 0.1 * nB.n3(x * 2.1 + 3, y * 2.1, z * 2.1 + 1) + 0.04 * nB.n3(x * 9, y * 9 + 2, z * 9);
    let m = 0.5 + 0.38 * nB.fbm(x * 2.4 + 11, y * 2.4, z * 2.4, 3) + 0.12 * nB.n3(x * 11 + 4, y * 11, z * 11);
    if (this.hasOcean) m += 0.22 * (1 - sstep(0.0, 0.3, c)) - 0.05;
    else m -= 0.12;
    m += st.moistBias;
    m -= 0.25 * sstep(0.2, 0.7, Math.max(0, h) / A);
    out.temperature = t;
    out.moisture = m < 0 ? 0 : m > 1 ? 1 : m;
    return out;
  }

  classify(h, t, m, rock = 0, sand = 0) {
    const B = BIOMES;
    if (this.hasOcean && h < this.seaLevel) return B.OCEAN;
    const T = this.type;
    if (T === 'volcanic') return h > this.A * 0.45 || rock > 0.6 ? B.ROCK : B.VOLCANIC;
    if (T === 'barren') return h > this.A * 0.4 || rock > 0.5 ? B.ROCK : B.DESERT;
    if (T === 'crystal' && m > 0.55 && h > 0) return B.CRYSTAL;
    if (T === 'toxic' && m > 0.5) return B.TOXIC;
    if (this.hasOcean && (h < 2.5 || sand > 0.65) && h < 25) return B.BEACH;
    if (t < 0.08) return B.SNOW;
    if (rock > 0.65) return t < 0.25 ? B.SNOW : B.ROCK;
    if (h > this.A * this.st.snowLine) return t < 0.32 ? B.SNOW : B.ROCK;
    if (t < 0.22) return B.TUNDRA;
    if (t < 0.38) return m > 0.45 ? B.TAIGA : B.TUNDRA;
    if (m < 0.25 || sand > 0.7) return B.DESERT;
    if (m < 0.4) return B.SAVANNA;
    if (t > 0.72 && m > 0.62) return B.JUNGLE;
    if (m > 0.56) return B.FOREST;
    return B.GRASSLAND;
  }

  /**
   * Point query used by flora / civ / fauna placement.
   * out: { height, biome, moisture, temperature, slope (0 flat..1 vertical; only if withSlope),
   *        rock, sand, snow, cliff, river, lake, mountain, continental }
   */
  sample(x, y, z, out = {}, withSlope = true) {
    const info = this._info;
    const h = this.evaluate(x, y, z, LOD_MIN, info);
    this.climate(x, y, z, h, info.c, out);
    out.height = h;
    out.rock = info.rock; out.sand = info.sand; out.cliff = info.cliff; out.river = info.river; out.lake = info.lake;
    out.mountain = info.mtn; out.continental = info.c; out.dune = info.dune;
    if (withSlope) {
      // finite differences over ~1.5 m on a tangent frame
      const e = 1.5 / this.R;
      let ex = -z, ey = 0, ez = x; // east-ish (y × p)
      let el = Math.hypot(ex, ez);
      if (el < 1e-6) { ex = 1; ez = 0; el = 1; }
      ex /= el; ez /= el;
      const nx = y * ez - z * ey, ny = z * ex - x * ez, nz = x * ey - y * ex;
      const h1 = this.evaluate(x + ex * e, y + ey * e, z + ez * e, 0.8, null);
      const h2 = this.evaluate(x + nx * e, y + ny * e, z + nz * e, 0.8, null);
      const h0 = this.evaluate(x, y, z, 0.8, null);
      const sx = (h1 - h0) / 1.5, sz = (h2 - h0) / 1.5;
      out.slope = 1 - 1 / Math.sqrt(1 + sx * sx + sz * sz);
    }
    const rockEff = Math.max(info.rock, out.slope !== undefined ? sstep(0.35, 0.6, out.slope) : 0);
    out.biome = this.classify(h, out.temperature, out.moisture, rockEff, info.sand);
    out.snow = this.hasOcean || this.type !== 'barren' ? clamp01((0.1 - out.temperature) * 5) : 0;
    return out;
  }
}
