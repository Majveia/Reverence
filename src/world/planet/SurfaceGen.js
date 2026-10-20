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
    // debug A/B (URL `tgen=<bits>`): 1 = no steep-face buttresses/crag boost
    dbg: (() => { try { return +(new URLSearchParams(globalThis.location?.search || '').get('tgen') || 0); } catch (_) { return 0; } })(),
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
  // wall rock character: jointed blocks (granite, basalt) vs bedded ledges (sandstone, limestone)
  const layered = T === 'desert' || T === 'savanna' || T === 'barren' || ['moebius', 'bebop', 'villeneuve', 'nms', 'starfield', 'kubrick'].includes(art);
  st.wallBlocks = layered ? 0.75 : 1;
  st.wallLedges = layered ? 1 : 0.4;
  st.ledgeStep = layered ? 9 + r() * 7 : 16 + r() * 10;
  // per-world wall relief wavelengths (constant: see _eval)
  st.buttWl = Math.min(1400, Math.max(500, A * st.mtnHeight * 0.3));
  st.wallLam = Math.min(320, Math.max(90, A * 0.055));
  // wave-cut platforms at the foot of sea cliffs (no rng draw: keeps every other style value stable)
  st.shelf = T === 'ocean' || T === 'archipelago' ? 1 : 0.8;
  // ---- season regions (Ghost of Yotei painterly fields). Own rng: every value above is unchanged.
  //      ramp 0 spring green · 1/3 blossom (petal carpets) · 2/3 gold pampas · 1 crimson lilies / maples
  {
    const r2 = rng(cfg.seed ^ 0x5ea5011);
    st.seasonAmt = { terran: 1, ocean: 1, archipelago: 1, jungle: 0.7, savanna: 0.85, desert: 0.35, arctic: 0.55, exotic: 0.6, toxic: 0.45, crystal: 0.5, barren: 0, volcanic: 0.15 }[T] ?? 0.7;
    st.seasonBias = 0.15 + 0.7 * r2();
    st.seasonSpread = 0.45 + 0.25 * r2();
    const sb = { bierstadt: [0.68, 0.5], botw: [0.28, 0.55], ghibli: [0.3, 0.6], moebius: [0.7, 0.3], stalenhag: [0.72, 0.35], tarkovsky: [0.62, 0.4], friedrich: [0.75, 0.35], turner: [0.7, 0.4], outerwilds: [0.6, 0.5], rickmorty: [0.35, 0.6] }[art];
    if (sb) { st.seasonBias = sb[0]; st.seasonSpread = sb[1]; }
    if (T === 'desert' || T === 'savanna') st.seasonBias = Math.max(st.seasonBias, 0.62);
    st.greatTilt = r2();   // great mountain: lobe phase / small asymmetry
  }
  return st;
}

function smin(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }
function dirLL(latDeg, lonDeg) {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180, c = Math.cos(la);
  return [c * Math.sin(lo), Math.sin(la), c * Math.cos(lo)];
}
function llOf(d) {
  return { lat: Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180 / Math.PI, lon: Math.atan2(d[0], d[2]) * 180 / Math.PI };
}
/** east / north tangent basis at unit dir u (same convention as the player: east = Y × up). */
function enBasis(u) {
  let ex, ey, ez;
  if (Math.abs(u[1]) > 0.999) { ex = -u[1]; ey = u[0]; ez = 0; }   // (0,0,1) × up
  else { ex = u[2]; ey = 0; ez = -u[0]; }                          // (0,1,0) × up
  const l = Math.hypot(ex, ey, ez) || 1; ex /= l; ey /= l; ez /= l;
  const nx = u[1] * ez - u[2] * ey, ny = u[2] * ex - u[0] * ez, nz = u[0] * ey - u[1] * ex;
  return [[ex, ey, ez], [nx, ny, nz]];
}
/** unit dir at angular distance `ang` (rad) from u along compass bearing `b` (rad, 0 = north, π/2 = east). */
function offsetDir(u, b, ang) {
  const [e, n] = enBasis(u);
  const s = Math.sin(ang), c = Math.cos(ang), cb = Math.cos(b), sb = Math.sin(b);
  const d = [0, 1, 2].map((i) => u[i] * c + (n[i] * cb + e[i] * sb) * s);
  const l = Math.hypot(d[0], d[1], d[2]); return [d[0] / l, d[1] / l, d[2] / l];
}
/** compass bearing (rad) from u toward v and the angle between them. */
function bearingTo(u, v) {
  const [e, n] = enBasis(u);
  const c = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const f = [v[0] - u[0] * c, v[1] - u[1] * c, v[2] - u[2] * c];
  return { b: Math.atan2(f[0] * e[0] + f[1] * e[1] + f[2] * e[2], f[0] * n[0] + f[1] * n[1] + f[2] * n[2]), ang: Math.acos(Math.max(-1, Math.min(1, c))) };
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
    // ---- landmarks: one great snow-capped mountain per world + sacred sites (deterministic, flats-free:
    //      main thread and every worker compute the identical layout)
    this.great = null;
    this.landmarks = { mountain: null, sacred: [], spawn: null, views: {} };
    if (!(cfg.dbg & 64) && cfg.great !== false && this.type !== 'gas') {
      try { this._placeLandmarks(); } catch (e) { this.great = null; this.landmarks = { mountain: null, sacred: [], spawn: null, views: {}, error: String(e) }; }
    }
    if (this.great) this.maxHeight += this.great.H;
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

  // ------------------------------------------------------------------ great mountain & sacred sites
  /** Normalized radius (1 = edge of the cone's footprint, lobed) of unit dir from the great mountain; 9 = far. */
  _gr(x, y, z) {
    const GM = this.great;
    if (!GM) return 9;
    const cd = x * GM.x + y * GM.y + z * GM.z;
    if (cd <= GM.cosOut) return 9;
    const ang = Math.acos(cd < 1 ? cd : 1);
    const f = GM.lf, n = this.nF;
    const lobe = 1 + GM.lobeA * n.n3(x * f + 7.1, y * f + 3.3, z * f + 9.4) + 0.035 * n.n3(x * f * 2.9 + 1.7, y * f * 2.9 + 5.2, z * f * 2.9 + 0.3);
    return ang * this.R / (GM.Rb * lobe);
  }

  /** Where the player lands by default (Player._findLand from lat 12, lon 28; flats-free). */
  _spawnEst(d0) {
    if (!this.hasOcean) return d0;
    const [e, n] = enBasis(d0);
    let best = d0, bestS = -Infinity;
    const R = this.R, eps = 1.2 / R;
    for (let i = 0; i < 400; i++) {
      const t = i * 2.39996, r = Math.sqrt(i) * 0.02;
      let d = [0, 1, 2].map((k) => d0[k] + e[k] * Math.cos(t) * r + n[k] * Math.sin(t) * r);
      const l = Math.hypot(d[0], d[1], d[2]); d = [d[0] / l, d[1] / l, d[2] / l];
      const h = this._eval(d[0], d[1], d[2], 0.5, null);
      let s = h > 20 && h < this.A * 0.35 ? 1 - r : -1;
      if (s > 0) {
        const [e2, n2] = enBasis(d);
        const h1 = this._eval(d[0] + e2[0] * eps, d[1] + e2[1] * eps, d[2] + e2[2] * eps, 0.5, null);
        const h2 = this._eval(d[0] + n2[0] * eps, d[1] + n2[1] * eps, d[2] + n2[2] * eps, 0.5, null);
        const gx = (h1 - h) / 1.2, gy = (h2 - h) / 1.2;
        if (1 / Math.sqrt(1 + gx * gx + gy * gy) <= 0.9) s -= 0.6;
      }
      if (s > bestS) { bestS = s; best = d; if (s > 0.9) break; }
    }
    return best;
  }

  _placeLandmarks() {
    const R = this.R, A = this.A, w = this._g;
    const rnd = rng(this.cfg.seed ^ 0x9e3779b1);
    const H = Math.min(5600, Math.max(1800, A * 1.2)) * (this.cfg.isMoon ? 0.85 : 1);
    const Rb = H * 2.45;
    const sea = this.hasOcean ? 0 : -1e9;
    const d0 = dirLL(12, 28);
    const S = this._spawnEst(d0);
    // ---- the great mountain: a ring of candidate centres ~1.2 footprints from the default spawn (it must
    //      fill the first view: on a 30-100 km planet curvature hides everything beyond ~25 km), scored for
    //      land under the footprint, no competing range at its base and an open line of sight
    const land = (d) => {
      this._warp(d[0], d[1], d[2], w);
      const c = this._continent(w[0], w[1], w[2], 2000) - this.oceanBias;
      return { c, mm: this._mtnMask(w[0], w[1], w[2], c) };
    };
    let best = null;
    const ph = rnd() * TAU;
    for (let k = 0; k < 32; k++) {
      const b = ph + (k / 32) * TAU;
      for (const df of [1.14, 1.32]) {
        const C = offsetDir(S, b, (Rb * df) / R);
        const ll = llOf(C);
        let sc = 0, mm0 = 0;
        for (let j = 0; j < 7; j++) {
          const q = j === 0 ? C : offsetDir(C, (j / 6) * TAU, (Rb * 0.6) / R);
          const L = land(q);
          if (!this.hasOcean || L.c > 0.012) sc += j === 0 ? 2 : 1;
          if (j === 0) mm0 = L.mm;
        }
        const mid = land(offsetDir(S, b, (Rb * df * 0.5) / R));
        // (the cone must not raise new land closer to the player's search origin than the spawn itself, or
        //  the default spawn would move onto its flank)
        const cdd = Math.acos(Math.min(1, C[0] * d0[0] + C[1] * d0[1] + C[2] * d0[2])) * R;
        const sdd = Math.acos(Math.min(1, S[0] * d0[0] + S[1] * d0[1] + S[2] * d0[2])) * R;
        const clear = cdd > Rb * 1.18 + sdd ? 0 : 3;
        let score = sc / 8 - 0.7 * mm0 - 0.5 * mid.mm - (Math.abs(ll.lat) > 55 ? 1 : 0) + 0.12 * rnd() - 0.05 * (df - 1.14) - clear;
        if (!best || score > best.score) best = { score, C, b, df };
      }
    }
    const C = best.C;
    const lf = R / (Rb * 0.95);
    const rc = 0.045, cd = 0.055;
    const tr = 1 - rc;
    const pRim = 0.55 * Math.pow(tr, 2.2) + 0.45 * Math.pow(tr, 1.2);
    const snow = this.type === 'barren' ? 0 : this.type === 'volcanic' ? 0.6 : 1;
    this.great = {
      x: C[0], y: C[1], z: C[2], H, Rb, cosOut: Math.cos(Math.min(Math.PI * 0.9, (2.1 * Rb) / R)),
      lf, lobeA: 0.07, rc, cd, pRim, snow, snowLo: 0.47, snowHi: 0.53, e: enBasis(C)[0], n: enBasis(C)[1],
      gully: 1.7, gwl: Math.max(300, Rb * 0.12),
    };
    const hAt = (d, lod = 2) => this._eval(d[0], d[1], d[2], lod, null);
    // summit = highest point of the crater rim
    let peakH = -1e9;
    for (let j = 0; j < 12; j++) { const q = offsetDir(C, (j / 12) * TAU, (rc * Rb) / R); peakH = Math.max(peakH, hAt(q, 4)); }
    const mLL = llOf(C);
    // ---- sacred sites around the default spawn, composed against the mountain (bearing beta from the spawn)
    let S2 = this._spawnEst(d0);
    if (this._gr(S2[0], S2[1], S2[2]) < 1.05) S2 = S;
    const bt = bearingTo(S2, C);
    const beta = bt.b, distM = bt.ang * R;
    const dry = (d, flat) => {
      if (flat < 0) return this._gr(d[0], d[1], d[2]) > 1.05;   // (floating isles: over land or sea)
      const h = hAt(d, 1);
      if (h < sea + 5) return false;
      if (this._gr(d[0], d[1], d[2]) < 1.02) return false;
      if (!flat) return true;
      let mx = 0;
      for (let j = 0; j < 4; j++) { const q = offsetDir(d, j * Math.PI / 2, flat / R); mx = Math.max(mx, Math.abs(hAt(q, 1) - h)); }
      return mx < flat * 0.28;
    };
    const site = (kind, b, dm, flat = 0, extra = {}, O = S2) => {
      // nearest dry (and, if asked, flat) spot to the composed position: bearings fan out, then distances
      let d = null;
      for (const k of [1, 0.75, 1.3, 0.55, 1.7, 0.4, 2.2]) {
        for (let j = 0; j < 13 && !d; j++) {
          const db = (j & 1 ? 1 : -1) * Math.ceil(j / 2) * 0.12;
          const q = offsetDir(O, b + db, (dm * k) / R);
          if (dry(q, flat)) d = q;
        }
        if (d) break;
      }
      // last resort: a spiral around the spawn (always dry land)
      for (let i = 12; i < 400 && !d; i++) { const q = offsetDir(S2, b + i * 2.39996, (Math.sqrt(i) * 160) / R); if (dry(q, flat * 0.6)) d = q; }
      if (!d) d = S2;
      const ll = llOf(d);
      return { kind, lat: +ll.lat.toFixed(4), lon: +ll.lon.toFixed(4), dir: d, height: hAt(d, 0.5), ...extra };
    };
    // the shrine stands at the mountain's foot on the side facing the spawn (a processional way leads up)
    const shrine = site('shrine', bearingTo(C, S2).b + 0.32, 1.1 * Rb, 25, { radius: 60 }, C);
    const tree = site('tree', beta - 0.55, 1700, 18, { radius: 40 });
    const arch = site('arch', beta, 520, 40, { radius: 55, span: 58, rise: 50 });
    {
      const ab = bearingTo(arch.dir, C);   // the arch opens toward the mountain
      arch.yaw = +(ab.b * 180 / Math.PI).toFixed(2);
    }
    const flo = site('floating', beta + 0.95, 2600, -1, { radius: 400 });
    this._isles(flo, S2, rnd);
    const sLL = llOf(S2);
    const deg = (v) => +((v * 180 / Math.PI + 360) % 360).toFixed(1);
    const archBack = offsetDir(arch.dir, (arch.yaw * Math.PI / 180) + Math.PI, 115 / R);
    const abLL = llOf(archBack);
    this.landmarks = {
      mountain: { kind: 'volcano', lat: +mLL.lat.toFixed(4), lon: +mLL.lon.toFixed(4), dir: C, height: peakH, peak: H, radius: Rb, snowline: peakH - H * (1 - this.great.snowLo) },
      sacred: [shrine, tree, flo, arch],
      spawn: { lat: +sLL.lat.toFixed(4), lon: +sLL.lon.toFixed(4), dir: S2, toMountain: deg(beta), mountainDist: Math.round(distM) },
      views: {
        // capture presets (view=surface / fly): yaw in degrees from north
        mountain: { lat: +sLL.lat.toFixed(4), lon: +sLL.lon.toFixed(4), yaw: deg(beta), pitch: 8 },
        arch: { lat: +abLL.lat.toFixed(4), lon: +abLL.lon.toFixed(4), yaw: +((arch.yaw + 360) % 360).toFixed(1), pitch: 6 },
        floating: { lat: +sLL.lat.toFixed(4), lon: +sLL.lon.toFixed(4), yaw: deg(bearingTo(S2, flo.dir).b), pitch: 10 },
      },
    };
  }

  /** The floating isles: a receding line from the spawn (each further one paler in the haze). */
  _isles(flo, S2, rnd) {
    const R = this.R, sea = this.hasOcean ? 0 : -1e9;
    const hAt = (d, lod = 2) => this._eval(d[0], d[1], d[2], lod, null);
    const fb = bearingTo(S2, flo.dir).b;
    const isl = [];
    const dists = [0, 650, 1450, 2450, 3700, 5300];
    const sc = Math.min(1.3, Math.max(0.6, R / 70000));
    for (let i = 0; i < dists.length; i++) {
      const lat = (rnd() - 0.5) * 900 + (i % 2 ? 260 : -260);
      let q = offsetDir(flo.dir, fb, dists[i] / R);
      q = offsetDir(q, fb + Math.PI / 2, lat / R);
      const g = Math.max(hAt(q, 4), sea, flo.floor ?? -1e9);
      const r = (i === 0 ? 95 : 45 + rnd() * 70) * sc;
      const ll = llOf(q);
      const lift = flo.lift ? flo.lift * (0.75 + 0.5 * rnd()) + i * 40 : (130 + rnd() * 200 + i * 30) * sc;
      isl.push({ lat: +ll.lat.toFixed(4), lon: +ll.lon.toFixed(4), dir: q, ground: g, alt: g + lift, radius: r, seed: (rnd() * 1e9) >>> 0 });
    }
    flo.islands = isl;
  }

  /**
   * Capture / photo viewpoints that frame the great mountain with a clear line of sight (main thread only,
   * on demand: ~10-30 ms). For each candidate ground point the terrain profile toward the summit is marched
   * (curvature included); the score is the angular height of the mountain left above the nearest blocking
   * ridge, with an open foreground. Fills landmarks.views.mountain / .mountainNear (lat, lon, yaw, pitch,
   * dist, visible: degrees of mountain above the blocking horizon).
   */
  findViews() {
    const L = this.landmarks, GM = this.great;
    if (!L || !GM || L._viewsDone) return L?.views;
    L._viewsDone = true;
    const R = this.R, C = [GM.x, GM.y, GM.z];
    const sea = this.hasOcean ? 0 : -1e9;
    const top = L.mountain.height;
    const hAt = (d, lod) => this._eval(d[0], d[1], d[2], lod, null);
    const S2 = L.spawn.dir;
    const b0 = bearingTo(C, S2).b;
    const evalView = (V) => {
      const hv = hAt(V, 2);
      if (hv < sea + 3) return null;
      const bt = bearingTo(V, C), dist = bt.ang * R, eye = Math.max(hv, sea) + 2;
      // elevation angle of a point at arc distance s with height hq, seen from the eye (curvature included)
      const elev = (s, hq) => { const th = s / R, rq = R + hq; return Math.atan2(rq * Math.cos(th) - (R + eye), rq * Math.sin(th)); };
      const aTop = elev(dist, top);
      let aBlock = -1, fore = 0;
      const N = 44;
      for (let i = 1; i < N; i++) {
        const s = dist * Math.pow(i / N, 1.6);
        const q = offsetDir(V, bt.b, s / R);
        if (this._gr(q[0], q[1], q[2]) < 0.95) break;          // reached the cone itself
        const hq = Math.max(hAt(q, Math.max(4, s * 0.004)), sea);
        const a = elev(s, hq);
        if (a > aBlock) aBlock = a;
        if (s < 600 && hq > eye + 4) fore += (hq - eye) / 40;
      }
      const aBase = aBlock;
      const vis = aTop - aBase;
      return { V, b: bt.b, dist, vis, aTop, aBase, score: vis * 57.3 - fore * 3 - Math.max(0, dist / GM.Rb - 1.25) * 3 };
    };
    let best = null, near = null;
    for (const df of [1.06, 1.15, 1.26, 1.4]) {
      for (let k = -6; k <= 6; k++) {
        const V = offsetDir(C, b0 + k * 0.13, (GM.Rb * df) / R);
        const r = evalView(V);
        if (!r) continue;
        if (!best || r.score > best.score) best = r;
        if (df <= 1.15 && (!near || r.score > near.score)) near = r;
      }
    }
    const pack = (r, pitchK) => {
      const ll = llOf(r.V);
      return { lat: +ll.lat.toFixed(4), lon: +ll.lon.toFixed(4), yaw: +((r.b * 180 / Math.PI + 360) % 360).toFixed(1),
        pitch: +((r.aBase + (r.aTop - r.aBase) * pitchK) * 180 / Math.PI).toFixed(1), dist: Math.round(r.dist), visible: +(r.vis * 57.3).toFixed(1) };
    };
    if (best) L.views.mountain = pack(best, 0.55);
    if (near) L.views.mountainNear = pack(near, 0.6);
    // ---- the arch: find the spot near the spawn with the clearest view of the summit; the arch stands
    //      ~115 m ahead of it on flat dry ground and opens toward the mountain (the frame of rule 11)
    const arch = L.sacred.find((q) => q.kind === 'arch');
    if (arch) {
      let bestA = null;
      for (let i = 0; i < 90; i++) {
        const V = i === 0 ? S2 : offsetDir(S2, i * 2.39996, (Math.sqrt(i) * 420) / R);
        const r = evalView(V);
        if (!r || r.vis < 0.05) continue;
        const Ap = offsetDir(V, r.b, 115 / R);
        const ha = hAt(Ap, 1);
        if (ha < sea + 4) continue;
        let mx = 0;
        for (let j = 0; j < 4; j++) { const q = offsetDir(Ap, j * Math.PI / 2, 40 / R); mx = Math.max(mx, Math.abs(hAt(q, 1) - ha)); }
        const hv = hAt(V, 1);
        // (prefer the arch a little BELOW the viewpoint's eye line so its opening frames the far peak)
        const sc = r.score - mx * 0.4 - Math.max(0, ha - hv - 25) * 0.15 - Math.sqrt(i) * 0.15;
        if (mx < 16 && (!bestA || sc > bestA.sc)) bestA = { sc, r, Ap, ha };
      }
      if (bestA) {
        const ll = llOf(bestA.Ap), ab = bearingTo(bestA.Ap, C);
        Object.assign(arch, { lat: +ll.lat.toFixed(4), lon: +ll.lon.toFixed(4), dir: bestA.Ap, height: bestA.ha, yaw: +(ab.b * 180 / Math.PI).toFixed(2) });
        const v = pack(bestA.r, 0.5);
        L.views.arch = { lat: v.lat, lon: v.lon, yaw: v.yaw, pitch: v.pitch, dist: v.dist, visible: v.visible };
        // a wider framing (whole arch with its lintel, mountain in the opening): step back along the axis
        // while the ground behind stays below the eye and nothing between rises into the opening
        const V0 = bestA.r.V, hv0 = hAt(V0, 1);
        let wide = null;
        for (const back of [170, 130, 95, 60]) {
          const Vb = offsetDir(V0, bestA.r.b + Math.PI, back / R), hb = hAt(Vb, 1);
          if (hb < sea + 3 || hb > hv0 + 40) continue;
          // (the ground between must stay below the sight line from the eye to the arch's foot)
          let ok = true;
          const tot = back + 115;
          for (let k = 1; k < 8 && ok; k++) { const sk = tot * k / 8, q = offsetDir(Vb, bestA.r.b, sk / R); if (hAt(q, 1) > hb + 1.7 + (bestA.ha - hb - 1.7) * (sk / tot) + 3) ok = false; }
          if (ok) { wide = { Vb, back }; break; }
        }
        if (wide) { const ll = llOf(wide.Vb); L.views.archWide = { lat: +ll.lat.toFixed(4), lon: +ll.lon.toFixed(4), yaw: v.yaw, pitch: 9, dist: 115 + wide.back }; }
      }
    }
    // ---- the floating isles: over open low ground (a valley, a lake, the sea) in clear view of the spawn,
    //      ~40-110° off the mountain's bearing so they compose as a second focal group
    const flo = L.sacred.find((q) => q.kind === 'floating');
    if (flo && best) {
      // preferred: the isles hang in the mountain view, a little to one side of the summit, receding toward
      // the cone (each further one paler in the haze) and always above the blocking ridge line
      const V = best.V, side = best.b + 0.3;
      const hV = Math.max(hAt(V, 1), sea), eye = hV + 2;
      const tanB = Math.tan(Math.max(best.aBase, -0.05) + 0.03);
      const rr = rng(this.cfg.seed ^ 0x15e5);
      const dists = [1900, 2700, 3700, 5000, 6600, 8500];
      const sc = Math.min(1.3, Math.max(0.6, R / 70000));
      const isl = [];
      // (the whole line is compressed to fit before the cone: clamping each distance separately stacked
      //  the far isles on one spot on small worlds)
      const dk = Math.min(1, Math.max(400, best.dist - GM.Rb * 0.75) / dists[dists.length - 1]);
      for (let i = 0; i < dists.length; i++) {
        const dd = dists[i] * dk;
        // (fanned out sideways and in height so they never stack behind each other)
        const fan = (rr() - 0.5) * 0.06 + (i % 2 ? 1 : -1) * (0.05 + 0.035 * i);
        let q = offsetDir(V, side + fan, dd / R);
        if (this._gr(q[0], q[1], q[2]) < 1.02) q = offsetDir(V, side + 0.25 + Math.abs(fan), dd / R);
        const g = Math.max(hAt(q, 4), sea);
        const r = (i === 0 ? 90 : 50 + rr() * 70) * sc;
        const minAlt = eye + dd * tanB + dd * dd / (2 * R) + r * 2.2;
        const alt = Math.max(g + 140 * sc, minAlt) + (i % 3) * 140 * sc + rr() * 120 * sc + i * 30;
        const ll = llOf(q);
        isl.push({ lat: +ll.lat.toFixed(4), lon: +ll.lon.toFixed(4), dir: q, ground: g, alt, radius: r, seed: (rr() * 1e9) >>> 0 });
      }
      const q0 = isl[0].dir, ll0 = llOf(q0);
      Object.assign(flo, { lat: +ll0.lat.toFixed(4), lon: +ll0.lon.toFixed(4), dir: q0, height: isl[0].ground, islands: isl });
      const vv = pack(best, 0.45);
      L.views.floating = { lat: vv.lat, lon: vv.lon, yaw: +(((best.b + 0.17) * 180 / Math.PI + 360) % 360).toFixed(1), pitch: vv.pitch + 2 };
    } else if (flo) {
      const hS = Math.max(hAt(S2, 1), sea), eye = hS + 2;
      const bM = bearingTo(S2, C).b;
      let bestF = null;
      for (let k = 0; k < 32; k++) {
        const b = (k / 32) * TAU;
        const off = Math.abs(((b - bM + 3 * Math.PI) % TAU) - Math.PI);
        for (const dist of [1600, 2400, 3400]) {
          const q = offsetDir(S2, b, dist / R);
          if (this._gr(q[0], q[1], q[2]) < 1.15) continue;
          const g = Math.max(hAt(q, 4), sea);
          const el = (sd, hq) => { const th = sd / R, rq = R + hq; return Math.atan2(rq * Math.cos(th) - (R + eye), rq * Math.sin(th)); };
          let aB = -1, aBg = -1;
          for (let i = 1; i < 18; i++) { const sd = dist * i / 18; const p = offsetDir(S2, b, sd / R); aB = Math.max(aB, el(sd, Math.max(hAt(p, 6), sea))); }
          // background: the isles should stand against the SKY (or far haze), not against a ridge
          for (let i = 1; i <= 10; i++) { const sd = dist + i * 900; const p = offsetDir(S2, b, sd / R); aBg = Math.max(aBg, el(sd, Math.max(hAt(p, 12), sea))); }
          for (const lift of [200, 380, 600]) {
            const aT = el(dist, g + lift);
            const clear = (aT - aB) * 57.3, sky = (aT - aBg) * 57.3;
            if (clear < 1.5 || sky < 0.8) continue;
            const score = Math.min(clear, 10) + Math.min(sky, 4) + (g < hS - 20 ? 2 : 0) + (g <= sea + 1 ? 1.5 : 0) - Math.abs(off - 1.3) * 2 - dist / 2400 - lift / 300;
            if (!bestF || score > bestF.score) bestF = { score, q, g, b, lift };
            break;
          }
        }
      }
      if (bestF) {
        const ll = llOf(bestF.q);
        Object.assign(flo, { lat: +ll.lat.toFixed(4), lon: +ll.lon.toFixed(4), dir: bestF.q, height: bestF.g, floor: hS - 60, lift: bestF.lift });
        this._isles(flo, S2, rng(this.cfg.seed ^ 0x15e5));
        L.views.floating = { lat: L.spawn.lat, lon: L.spawn.lon, yaw: +((bestF.b * 180 / Math.PI + 360) % 360).toFixed(1), pitch: 7 };
      }
    }
    return L.views;
  }

  /**
   * Season region at unit dir (0 spring green · 1/3 blossom · 2/3 gold pampas · 1 crimson lilies / maples),
   * broad one-hue regions with soft borders. (px,py,pz) = continent-warped dir; h = height (m).
   */
  _season(px, py, pz, h) {
    const st = this.st, n = this.nB, R = this.R;
    const f1 = R / 11000, f2 = R / 3800;
    let s = st.seasonBias + st.seasonSpread * (0.95 * n.n3(px * f1 + 13.1, py * f1 + 7.7, pz * f1 + 3.9) + 0.32 * n.n3(px * f2 + 2.2, py * f2 + 9.1, pz * f2 + 5.5));
    s += 0.22 * sstep(0.15, 0.5, h / this.A);   // uplands turn first (autumn climbs down the hills)
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    const q = s * 3, fi = Math.floor(q > 2.999 ? 2.999 : q);
    return (fi + sstep(0.36, 0.64, q - fi)) / 3;
  }

  /** Public: season ramp value (see _season) + strength for this world at unit dir (x,y,z). */
  season(x, y, z) {
    const w = this._w2;
    this._warp(x, y, z, w);
    return this._season(w[0], w[1], w[2], this._eval(x, y, z, 30, null));
  }
  get seasonAmt() { return this.st.seasonAmt; }

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
    const px0 = x * f, py0 = y * f, pz0 = z * f;
    let wx = 0, wy = 0, wz = 0;
    {
      // two-scale domain warp: bends ridgelines so ranges branch and curve instead of running straight
      const w1 = 0.55, w2 = 0.22, qx = px0, qy = py0, qz = pz0;
      const ax0 = n.n3(qx * 0.45 + 11.3, qy * 0.45 + 2.9, qz * 0.45 + 7.7), ay0 = n.n3(qx * 0.45 + 4.2, qy * 0.45 + 9.4, qz * 0.45 + 1.3), az0 = n.n3(qx * 0.45 + 8.8, qy * 0.45 + 5.5, qz * 0.45 + 3.1);
      const bx0 = n.n3(qx * 1.7 + 1.9, qy * 1.7 + 6.1, qz * 1.7 + 2.4), by0 = n.n3(qx * 1.7 + 7.3, qy * 1.7 + 3.8, qz * 1.7 + 9.6), bz0 = n.n3(qx * 1.7 + 5.6, qy * 1.7 + 0.7, qz * 1.7 + 6.9);
      wx = w1 * ax0 + w2 * bx0; wy = w1 * ay0 + w2 * by0; wz = w1 * az0 + w2 * bz0;
    }
    // The warp displacement grows with the octave scale only for the first two octaves; finer octaves
    // see it as a (nearly) constant offset. Scaling it with every octave inherited the warp's full
    // Jacobian (anisotropy up to ~10:1 over large areas) at every scale: small ridges were stretched
    // into thin parallel stripes that aliased into combs/chevrons/needles on steep faces.
    let sb = 1, sw = 1, cx = 0, cy = 0, cz = 0;
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
      const v = n.n3d(px0 * sb + wx * sw + cx, py0 * sb + wy * sw + cy, pz0 * sb + wz * sw + cz, d);
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
      sb *= LAC; if (o < 2) sw *= LAC;
      cx = cx * LAC + 3.1; cy = cy * LAC + 1.7; cz = cz * LAC + 8.3;
    }
    g[0] = gx; g[1] = gy; g[2] = gz; g[3] = tx; g[4] = ty; g[5] = tz;
    return sum;
  }

  /** Rib/chute relief for big mountain walls (metres, ~zero-mean). */
  _buttress(x, y, z, lod, wl0 = 1400) {
    const n = this.nH;
    let wl = wl0, sum = 0;
    for (let o = 0; o < 4; o++) {
      const lw = lodW(wl * 0.5, lod);
      if (lw <= 0) break;
      const f = this.R / wl;
      const v = n.n3(x * f + 13.1 + o * 3.7, y * f + 5.3, z * f + 9.9 - o * 1.3);
      // softened ridge: sharp-ish ribs, rounded chutes (no razor creases). Mostly CARVING: the
      // positive rib part is damped — where ribs of several octaves crossed a mountain crest they
      // stacked into isolated needles / cones on the ridge line (critic: "fins stuck on the crest").
      const rb = (0.35 - Math.sqrt(v * v + 0.006)) * 1.7;
      sum += (o < 2 ? 0.09 : 0.05) * wl * lw * (rb > 0 ? rb * 0.3 : rb);
      wl *= 0.5;
    }
    return sum;
  }

  /** Forest belt on the great mountain's flanks (0..1 by normalized radius gr): between the tree line
   *  (bare ash / scree above gr ≈ 0.4) and a little beyond the foot of the cone. */
  _gBelt(gr) { return gr >= 1.3 ? 0 : sstep(0.28, 0.7, gr) * (1 - sstep(1.0, 1.3, gr)); }

  /** Ranges fade out around the great mountain so it stands alone (1 far away, 0 at its foot). */
  _gFade(x, y, z) { return this.great ? sstep(0.8, 1.65, this._gr(x, y, z)) : 1; }

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
      d1 = (this._mtnMask(w[0], w[1], w[2], this._continent(w[0], w[1], w[2], lod) - this.oceanBias) * this._gFade(qx, qy, qz) - mm) / 60;
    }
    {
      let qx = x + bx * e, qy = y + by * e, qz = z + bz * e; l = 1 / Math.hypot(qx, qy, qz); qx *= l; qy *= l; qz *= l;
      this._warp(qx, qy, qz, w);
      d2 = (this._mtnMask(w[0], w[1], w[2], this._continent(w[0], w[1], w[2], lod) - this.oceanBias) * this._gFade(qx, qy, qz) - mm) / 60;
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
  _gullies(x, y, z, lod, Gx, Gy, Gz, strength, wl0 = this.st.gullyWl) {
    const st = this.st, R = this.R, e = this._e;
    const SLOPE = 1.8, BRANCH = 0.5;
    let wl = wl0, a = st.gullyAmp * wl * strength;
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

  /**
   * 3D faceted field (q in cell units): every jittered cell carries a tilted plane; planes are blended
   * by a steep Gaussian kernel → piecewise-planar facets with soft seams. Cell boundaries of a 3D
   * Voronoi diagram are planes, so a wall cuts them along straight lines: polygonal joint blocks with
   * differently oriented faces (granite / basalt), not the curved crescents of ridged noise. ~[-0.6,0.6].
   */
  _facets3(qx, qy, qz, sharp) {
    const ix = Math.floor(qx), iy = Math.floor(qy), iz = Math.floor(qz);
    const fx = qx - ix, fy = qy - iy, fz = qz - iz;
    const P = this.nG.perm, J = this.nG.jit;
    const cut = Math.exp(-sharp * 1.21);
    let sw = 0, sv = 0;
    for (let k = -1; k <= 1; k++) {
      const pk = P[(iz + k + 300) & 1023];
      for (let j = -1; j <= 1; j++) {
        const pj = P[(pk + iy + j + 300) & 1023];
        for (let i = -1; i <= 1; i++) {
          const hsh = P[(pj + ix + i + 300) & 1023], h = hsh << 2, h2 = P[(hsh + 77) & 1023] << 2;
          const dx = fx - i - 0.1 - 0.8 * J[h], dy = fy - j - 0.1 - 0.8 * J[h + 1], dz = fz - k - 0.1 - 0.8 * J[h + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          // (kernel shifted to reach exactly 0 at d² = 1.21: every cell point outside the 3×3×3
          //  neighbourhood is ≥ 1.1 away on some axis, so the truncated sum is now continuous — the
          //  plain Gaussian left ~1 % weight jumps → 0.15 m steps on big walls)
          if (d2 >= 1.21) continue;
          const w = Math.exp(-sharp * d2) - cut;
          sw += w;
          sv += w * (J[h + 3] - 0.5 + 1.3 * ((J[h2] - 0.5) * dx + (J[h2 + 1] - 0.5) * dy + (J[h2 + 2] - 0.5) * dz));
        }
      }
    }
    return sw > 1e-12 ? sv / sw : 0;
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
    // + a low debris fan [-3,-2) (+6 % of the height, ~18-25°) so walls stand on rubble instead of
    //   meeting the plain in a crisp corner; it fades out up the cliff (keeps the profile monotonic)
    if (v >= 0) return 1 - 0.03 * Math.exp(-v * 18);
    if (v > -0.75) { const t = -v / 0.75; return 0.97 - 0.55 * (t * 0.85 + 0.15 * t * t) + 0.06 * t; }
    if (v > -2) { const t = (v + 2) / 1.25; return 0.42 * t * t + 0.06; }
    if (v > -3) { const t = v + 3; return 0.06 * t * t; }
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
      info.rock *= kk; info.cliff *= kk; info.river *= kk; info.lake *= kk; info.dune *= kk; info.sand *= kk; if (info.talus) info.talus *= kk;
    }
    return out;
  }

  _eval(x, y, z, lod = LOD_MIN, info = null) {
    const st = this.st, R = this.R, A = this.A, g = this._g;
    this._warp(x, y, z, g);
    const px = g[0], py = g[1], pz = g[2];
    let c = this._continent(px, py, pz, lod) - this.oceanBias;
    const nF = this.nF, nH = this.nH;
    let rock = 0, sand = 0, river = 0, lake = 0, cliff = 0, dune = 0, glacier = 0, talus = 0;
    // great mountain footprint: carving features (canyons, rivers, mesas, towers...) stay off its cone and
    // mountain ranges fade out around its base, so it stands alone over open land (Yotei, Fuji)
    const GM = this.great;
    const gr = GM ? this._gr(x, y, z) : 9;
    const gOut = gr > 1.1 ? 1 : sstep(0.6, 1.1, gr);
    const gFadeR = gr > 1.65 ? 1 : sstep(0.8, 1.65, gr);

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
    let mtn = 0, steep = 0, wallH = 0, wallS = 0;
    if (st.mountains > 0) {
      const mm = this._mtnMask(px, py, pz, c) * gFadeR;
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
        if (gs > 1e-4 && !(this.cfg.dbg & 4)) {
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
        const sMag = Math.hypot(g[3] * sc + mgx, g[4] * sc + mgy, g[5] * sc + mgz);
        steep = sstep(0.5, 1.3, sMag) * sstep(0.2, 0.55, mp);
        wallS = sMag;
        // buttresses & couloirs: relief proportional to the wall (≈9 % of each wavelength, 1.4 km →
        // 170 m) — on a steep heightfield face, height bumps become plan-view ribs and chutes
        wallH = H;
      }
    }

    // ---- the great mountain: a lone stratovolcano (concave cone, summit crater, radial gullies, snow cap)
    if (GM && gr < 1.0) {
      const H = GM.H, t = 1 - gr;
      const t12 = Math.pow(t, 1.2);
      let p = 0.55 * t12 * t + 0.45 * t12;                                        // 0.55 t^2.2 + 0.45 t^1.2
      const dp = 0.55 * 2.2 * t12 + 0.45 * 1.2 * Math.pow(t, 0.2);                // -dp/dgr
      p = smin(p, GM.pRim, 0.035);                                                // summit truncated at the rim
      if (gr < GM.rc) { const u = gr / GM.rc, b = 1 - u * u; p -= GM.cd * b * b; } // crater bowl
      let hc = H * p, gv = 0;
      // radial gullies / barrancos: the slope-aligned erosion filter steered by the cone's own slope
      const gs = GM.gully * sstep(0.035, 0.15, gr) * (1 - sstep(0.72, 0.99, gr));
      if (gs > 1e-3 && !(this.cfg.dbg & 4)) {
        const cdt = x * GM.x + y * GM.y + z * GM.z;
        let vx = x * cdt - GM.x, vy = y * cdt - GM.y, vz = z * cdt - GM.z;   // tangent, toward the centre
        const vl = Math.hypot(vx, vy, vz) || 1;
        const gm = (H * dp) / GM.Rb;
        gv = this._gullies(x, y, z, lod, (vx / vl) * gm, (vy / vl) * gm, (vz / vl) * gm, gs, GM.gwl);
        hc += gv;
      }
      h += hc;
      // snow: long fingers down the gullies and radial streaks (Fuji / Yotei in late spring), not a dome
      let streak = 0;
      {
        const cdt = x * GM.x + y * GM.y + z * GM.z;
        const vx = x - GM.x * cdt, vy = y - GM.y * cdt, vz = z - GM.z * cdt;
        const ve = vx * GM.e[0] + vy * GM.e[1] + vz * GM.e[2], vn = vx * GM.n[0] + vy * GM.n[1] + vz * GM.n[2];
        const vl = Math.hypot(ve, vn) || 1;
        const K = 7.5;
        streak = nF.n3((ve / vl) * K + 4.4, (vn / vl) * K + 1.9, gr * 2.2 + 7.3) * 0.75 + nF.n3((ve / vl) * K * 2.3 + 9.1, (vn / vl) * K * 2.3 + 3.3, gr * 3.5 + 0.7) * 0.35;
      }
      const pn = p + 0.03 * nF.n3(x * R / 700 + 3.1, y * R / 700 + 8.8, z * R / 700 + 1.4) + 0.17 * streak * sstep(0.0, 0.12, 0.62 - p) - 4.2 * gv / H;
      const cap = GM.snow * sstep(GM.snowLo, GM.snowHi, pn);
      if (cap > glacier) glacier = cap;
      const ash = sstep(0.36, 0.52, p) * 0.8 * (1 - 0.6 * cap);   // bare volcanic scree above the tree line
      if (ash > rock) rock = ash;
      const mg = sstep(0.22, 0.55, p);
      if (mg > mtn) mtn = mg;
    }

    const steepM = steep;   // mountain-face part of the steep hint (see the 3D wall relief)
    // wall height = steep-weighted MEAN of the contributing walls (mountain face, plateau / mesa /
    // canyon cliffs). Switching wallH to whichever hint was largest made h discontinuous (wallH
    // scales the buttress relief): 0.4 m zero-width steps → zig-zag banks on the rendered mesh.
    let wHw = steep + 1e-3, wHs = wallH * wHw;
    let steepNM = 0;   // non-mountain part (plateau / mesa / canyon walls), continuous
    // ---- plateaus (large tablelands) and mesas (isolated buttes), with strata terraces
    if ((st.plateaus > 0 || st.mesas > 0) && c > -0.02) {
      const inland = sstep(0.02, 0.12, c) * gOut;
      if (st.plateaus > 0) {
        const f = R / st.plateauWl;
        const wv = nF.n3(px * f * 0.5 + 3, py * f * 0.5 + 7, pz * f * 0.5 + 1) * 0.35;
        const dq = this._d;
        const pn = nF.n3d(px * f + wv, py * f + 11.1 - wv, pz * f + 4.4, dq) * 0.75 + nF.n3(px * f * 2.7, py * f * 2.7 + 5, pz * f * 2.7 + 9) * 0.25;
        const dpn = 0.75 * 0.8 * Math.hypot(dq[0], dq[1], dq[2]) / st.plateauWl;   // ≈ |∇pn| per metre
        const reg = sstep(-0.2, 0.3, nF.n3(px * 2.1 + 40, py * 2.1, pz * 2.1)) * st.plateaus;
        const v1 = (pn - 0.12) / 0.07, v2 = (pn - 0.42) / 0.06;
        const p1 = SurfaceGen.mesa(v1), p2 = SurfaceGen.mesa(v2);
        const add = st.plateauH * (p1 + 0.8 * p2) * reg * inland;
        h += add;
        // (hint scaled by how real the wall is: where the plateau region fades out its "cliffs" are a
        //  gentle few-metre step, and a reg-proportional rock hint painted broad rock strips on meadows)
        const cl = Math.min(1, SurfaceGen.band(v1, -1.0, -0.8, -0.02, 0.06) + SurfaceGen.band(v2, -1.0, -0.8, -0.02, 0.06)) * sstep(0.3, 0.75, reg * inland);
        // rubble apron at the cliff foot (the concave part of the mesa profile)
        const ta = Math.min(1, SurfaceGen.band(v1, -3.1, -2.6, -0.95, -0.7) + SurfaceGen.band(v2, -3.1, -2.6, -0.95, -0.7)) * reg * inland;
        if (ta > talus) talus = ta;
        // wall-relief / ledge weight follows the REAL slope of the cliff band (plateauH · |mesa'| · dv/dm):
        // where the noise gradient is small the "cliff" band is a broad 30-45° slope, and terracing it
        // drew contour stripes (dark wavy strokes on W3 badlands)
        const clW = cl * sstep(0.9, 1.7, st.plateauH * reg * inland * 0.65 * dpn / 0.065);
        wHs += clW * st.plateauH; wHw += clW;
        if (clW * 0.9 > steep) steep = clW * 0.9; if (clW * 0.9 > steepNM) steepNM = clW * 0.9;
        if (clW > cliff) cliff = clW;
        if (cl > rock) rock = cl;
        // caprock rim: the hard bed that holds the table up shows as a bare rock band along the edge
        // of the top (the flat tops otherwise read as one pale sand sheet, like snow from the air)
        const cap = Math.min(1, SurfaceGen.band(v1, -0.05, 0.02, 0.12, 0.35) + SurfaceGen.band(v2, -0.05, 0.02, 0.12, 0.35)) * 0.65 * sstep(0.3, 0.75, reg * inland);
        if (cap > rock) rock = cap;
      }
      if (st.mesas > 0) {
        const f = R / st.mesaWl;
        const wv = nF.n3(px * f * 0.7 + 9, py * f * 0.7 + 2, pz * f * 0.7 + 5) * 0.4;
        const dq = this._d;
        const mn = nF.n3d(px * f + 13 + wv, py * f + 2.5, pz * f + 6.5 - wv, dq);
        const dmn = 0.8 * Math.hypot(dq[0], dq[1], dq[2]) / st.mesaWl;
        const reg = sstep(-0.15, 0.35, nF.n3(px * 1.7 + 70, py * 1.7, pz * 1.7 + 3)) * st.mesas;
        const v = (mn - 0.48) / 0.05;
        const p = SurfaceGen.mesa(v);
        const mh = st.plateauH * (1.2 + 0.8 * sstep(-1, 1, nF.n3(px * f * 0.3, py * f * 0.3 + 3, pz * f * 0.3)));
        h += mh * p * reg * inland;
        const cl = SurfaceGen.band(v, -1.0, -0.8, 0.02, 0.12) * sstep(0.3, 0.75, reg * inland);
        const ta = SurfaceGen.band(v, -3.1, -2.6, -0.95, -0.7) * reg * inland;
        if (ta > talus) talus = ta;
        const clW = cl * sstep(0.9, 1.7, mh * reg * inland * 0.65 * dmn / 0.05);
        wHs += clW * mh; wHw += clW;
        if (clW * 0.9 > steep) steep = clW * 0.9; if (clW * 0.9 > steepNM) steepNM = clW * 0.9;
        if (clW > cliff) cliff = clW;
        if (cl > rock) rock = cl;
        const cap = SurfaceGen.band(v, -0.05, 0.02, 0.15, 0.4) * 0.65 * sstep(0.3, 0.75, reg * inland);
        if (cap > rock) rock = cap;
      }
    }

    // ---- canyons: meandering, terraced walls, flat floors
    if (st.canyons > 0 && c > 0.01) {
      const f = R / st.canyonWl;
      const wv = nF.n3(px * f * 0.6 + 8, py * f * 0.6 + 1, pz * f * 0.6 + 3);
      const wm = nF.n3(px * f * 2.6 + 4.4, py * f * 2.6 + 1.2, pz * f * 2.6 + 8.1);
      const cn = nF.n3(px * f + 0.9 * wv + 0.28 * wm, py * f + 2 - 0.5 * wv - 0.2 * wm, pz * f + 5 + 0.25 * wm) + 0.15 * nF.n3(px * f * 4, py * f * 4 + 1, pz * f * 4 + 2);
      const reg = sstep(-0.25, 0.25, nF.n3(px * 1.9 + 90, py * 1.9 + 3, pz * 1.9)) * st.canyons * sstep(0.02, 0.12, c) * gOut;
      const v = Math.abs(cn) / 0.11;
      if (v < 1 && reg > 0) {
        let prof;
        if (v < 0.18) prof = 1;
        else {
          // terraced strata walls in plateau country; smooth V walls where the canyon cuts a
          // mountain range (5 stepped ledges on a 60° mountainside read as a staircase of lines)
          const tv = (v - 0.18) / 0.82;
          prof = 1 - (SurfaceGen.terrace(tv, 5, 0.42) * (1 - mtn) + sstep(0, 1, tv) * mtn);
        }
        // debris apron at the foot of the walls: a concave rubble ramp instead of a crisp floor/wall
        // corner (tapers out up the wall so the rim is unchanged)
        const ap = sstep(0.08, 0.3, v);
        const apron = st.canyonDepth * reg * 0.075 * ap * ap * (1 - sstep(0.3, 0.9, v)) * (1 - mtn);
        const carve = st.canyonDepth * reg * prof - apron;
        const floor = this.hasOcean ? Math.min(h, 4) : -1e9;
        h = Math.max(h - carve, floor);
        const ta = SurfaceGen.band(v, 0.07, 0.16, 0.27, 0.36) * reg * (1 - 0.6 * mtn);
        if (ta > talus) talus = ta;
        // wall hints scaled by the real mean wall slope (depth / width ≈ depth / (0.05·wavelength)):
        // shallow canyons (faded regions, half-strength styles) have gentle terraced flanks that the
        // old reg-proportional hint painted as broad rock strips across meadows
        const wall = SurfaceGen.band(v, 0.1, 0.2, 0.85, 1.0) * sstep(0.45, 0.9, st.canyonDepth * reg / (0.05 * st.canyonWl));
        wHs += wall * st.canyonDepth; wHw += wall;
        if (wall * 0.8 > steep) steep = wall * 0.8; if (wall * 0.8 > steepNM) steepNM = wall * 0.8;
        if (wall > rock) rock = wall;
        if (wall * 0.8 > cliff) cliff = wall * 0.8;
        sand = Math.max(sand, 0.6 * reg * (1 - sstep(0.12, 0.22, v)));
      }
    }

    // ---- terraces (stepped hillsides, strata)
    if (st.terraces > 0 && h > 20) {
      const reg = sstep(0.0, 0.4, nF.n3(px * 2.4 + 17, py * 2.4 + 9, pz * 2.4 + 4)) * st.terraces * sstep(20, 80, h) * gOut;
      if (reg > 0) {
        const step = 42 + 30 * (0.5 + 0.5 * nF.n3(px * 6, py * 6 + 4, pz * 6 + 2));
        const t = SurfaceGen.terrace(h / step, 1, 0.28) * step;
        h = h + (t - h) * reg * 0.55;
      }
    }

    // ---- karst towers (Guilin / Ha Long): steep limestone towers with rounded tops
    if (st.karst > 0 && c > -0.03) {
      // (every feature is faded in by its region / continent value instead of hard `c > …` / `reg > 0.01`
      //  gates: those cut a step of 1 % of the feature height — or, at the coast gate, the whole
      //  feature — into the height field: zero-width cliffs up to 20 m tall)
      let reg = sstep(-0.1, 0.35, nF.n3(px * 3.1 + 5, py * 3.1 + 55, pz * 3.1)) * st.karst * sstep(-0.03, -0.015, c) * gOut;
      reg *= sstep(0.004, 0.03, reg);
      if (reg > 0.004) {
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
      let reg = sstep(0.0, 0.4, nF.n3(px * 2.6 + 44, py * 2.6 + 3, pz * 2.6 + 19)) * st.spires * sstep(0.0, 0.008, c) * gOut;
      reg *= sstep(0.004, 0.03, reg);
      if (reg > 0.004) {
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
      let reg = sstep(0.1, 0.5, nF.n3(px * 4 + 8, py * 4, pz * 4 + 33)) * st.kopjes * sstep(0.02, 0.035, c) * gOut;
      reg *= sstep(0.004, 0.03, reg);
      if (reg > 0.004) {
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
      const reg = sstep(-0.05, 0.35, nF.n3(px * 2.2 + 81, py * 2.2 + 8, pz * 2.2 + 1)) * st.dunes * (1 - mtn) * gOut;
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
        h += dh + reg * 2.2 * prof2 * prof2 * sstep(0.005, 0.05, c);
        dune = reg;
        sand = Math.max(sand, reg);
      }
    }

    // ---- craters (moons, barren worlds)
    if (st.craters > 0) {
      h += this._craters(x, y, z, lod) * st.craters * (0.25 + 0.75 * gOut);
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
      if (t > 0) { h += A * 0.75 * st.volcano * t * gOut; rock = Math.max(rock, sstep(0.2, 0.6, t) * gOut); }
      void lava;
    }

    // ---- sea stacks and cliff-lined coasts
    if (this.hasOcean && (cliffMask > 0 || st.seastacks > 0)) {
      if (cliffMask > 0 && c > -0.004) {
        const jag = 0.0025 * nF.n3(x * R / 420, y * R / 420, z * R / 420);
        const k = sstep(-0.0005, 0.0012, c + jag);
        const ch = (25 + 60 * sstep(-0.3, 0.7, nF.n3(px * 30, py * 30, pz * 30))) * cliffMask;
        h = Math.max(h, h * (1 - k) + (Math.max(h, 0) + ch) * k);
        // (rock hint = the riser itself: same jagged coordinate as k, ending just past its top — the old band
        //  ignored the ±0.0025 jag and ran far inland: wide "rock" strips painted on gentle meadows)
        const cb = SurfaceGen.band(c + jag, -0.0015, -0.0008, 0.0011, 0.0019) * cliffMask;
        if (cb > rock) rock = cb;
        if (cb > cliff) cliff = cb;
      }
      if (st.seastacks > 0 && c > -0.05 && c < 0.012) {
        const f = R / 380, J = this.nG.jit;
        const zone = sstep(-0.05, -0.012, c) * (1 - sstep(0.004, 0.012, c));
        let reg = sstep(-0.2, 0.3, nF.n3(px * 7 + 3, py * 7, pz * 7 + 1)) * st.seastacks * zone * (1 - sstep(4, 30, h));
        reg *= sstep(0.004, 0.03, reg);
        if (reg > 0.004) {
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
        h = Math.max(h, h + (target - h) * sstep(0.0, 0.3, t) * st.atolls * sstep(-0.22, -0.19, c) * (1 - sstep(-0.02, 0.0, c)));
        sand = Math.max(sand, sstep(0.2, 0.35, t));
      }
    }

    // ---- river valleys (dry valleys in highlands, sea-level channels in lowlands) + lakes
    if ((st.rivers > 0 || st.fjords > 0) && c > -0.01) {
      const f = R / st.riverWl;
      const wv = nF.n3(px * f * 0.45 + 2, py * f * 0.45 + 6, pz * f * 0.45 + 9);
      const rn = nF.n3(px * f + wv * 1.1, py * f + 30 + wv * 0.4, pz * f + 12) + 0.18 * nF.n3(px * f * 3.3 + 1, py * f * 3.3, pz * f * 3.3 + 4);
      const reg = sstep(-0.3, 0.2, nF.n3(px * 1.5 + 200, py * 1.5, pz * 1.5 + 7)) * Math.max(st.rivers, st.fjords) * sstep(-0.01, 0.0, c) * gOut;
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
          }
          // fjord walls: cliff hint on the valley sides, tapering out across the valley (it used to be
          // set only inside the channel test → cut to 0 at its edge: a jump in the wall-relief weight,
          // i.e. zero-width steps of up to ~30 m in h)
          if (st.fjords > 0 && low > 0) {
            const k = sstep(0.1, 0.3, mtn) * mtn * (1 - chan) * low * (1 - sstep(0.03, 0.07, av)) * sstep(0.0, 0.2, reg);
            if (k > cliff) cliff = k;
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
      let reg = st.lakes * sstep(-0.1, 0.3, nF.n3(px * 2.7 + 300, py * 2.7, pz * 2.7 + 1)) * sstep(0.01, 0.02, c) * (gr > 1.12 ? 1 : sstep(0.85, 1.12, gr));
      reg *= sstep(0.004, 0.03, reg);
      if (reg > 0.004 && h < 220) {
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
      let reg = sstep(0.0, 0.4, nF.n3(px * 3.3 + 2, py * 3.3 + 400, pz * 3.3)) * st.sinkholes * sstep(0.02, 0.035, c) * gOut;
      reg *= sstep(0.004, 0.03, reg);
      if (reg > 0.004) {
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
      const reg = sstep(-0.2, 0.5, this.nH.n3(x * R / 900 + 4, y * R / 900, z * R / 900 + 8)) * st.outcrops * sstep(0.02, 0.035, c);
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

    // ---- buttresses & chutes on big walls (mountain faces, mesa / plateau / canyon cliffs): relief
    //      proportional to the wall (≈9 % of each wavelength, first wavelength ~0.9 × wall height)
    wallH = wHs / wHw;
    if (this.cfg.dbg & 1) steep = 0;
    // (the wavelength is a per-world constant: a frequency that follows wallH — which tracks the
    //  range mask — rescales absolute noise coordinates of ~10³ units by a spatially varying factor,
    //  decorrelating the noise within metres: needle fins and combs where ranges ramp up)
    // (faded in with wallH: a hard `wallH > 60` gate made the height function DISCONTINUOUS — 0.4 m
    //  cliffs of zero width that rendered as zig-zag banks across meadows at the foot of ranges)
    const wHk = sstep(30, 110, wallH);
    // (also eased in from steep 0.004 → 0.03: the old `steep > 0.01` gate cut a buttress offset of
    //  0.01 × ~40 m off in one step)
    if (steep > 0.004 && wHk > 0 && !(this.cfg.dbg & 16)) {
      h += steep * sstep(0.004, 0.03, steep) * wHk * this._buttress(x, y, z, lod, st.buttWl) * Math.min(1, wallH / 1500 + 0.25);
    }

    // ---- 3D wall relief (blocks, joints, ledges). A heightfield wall is the region between two
    //      contour lines: any relief that depends only on the horizontal position is extruded into
    //      vertical stripes over the whole wall (the "draped fabric / combed" cliffs). Here the noise
    //      is evaluated at the 3D position of the wall surface (altitude included), and its height
    //      offset is scaled by the wall slope s: a height offset Δh on a face of slope s moves the
    //      face horizontally by Δh/s, so the result is an (approximately) isotropic 3D displacement
    //      along the wall normal — joints, blocks and bulges that vary DOWN the wall as well as across.
    //      Bounded so the profile never folds over (|dΔh/dh| ≲ 0.8).
    // (weight: generator cliff/steep hints, or the measured slope of the mountain surface itself —
    //  mountain walls reach slope 10 (84°) long before the range mask counts them as "steep")
    // (mountain "steep" is the LARGE-SCALE slope of the range, which starts at ~27°: on its own it
    //  terraced 30-45° meadow flanks at the foot of ranges into rice-paddy steps. Mountain walls only
    //  count from ~48° (full at ~63°) of that slope; mesa / plateau / canyon walls keep their hints.)
    // (was `steep > steepM ? steep : 0`: it jumped from steepM to 0 where a cliff hint fell below the
    //  mountain hint — an 8 m discontinuity in h through the wall relief)
    const steepO = this.cfg.dbg & 1 ? 0 : steepNM;
    const wM = steepM * sstep(1.1, 2.0, wallS);
    let wr = wM > steepO ? wM : steepO;
    if (cliff * 0.85 > wr) wr = cliff * 0.85;
    const wS = sstep(1.6, 3.2, wallS);
    if (wS > wr) wr = wS;
    if (this.cfg.dbg & 2) wr = 0;
    // (true wall slope: wallS is only measured on mountain ranges; non-mountain cliffs (mesa, plateau,
    //  canyon, coast) assume ~2.2. Was `wallS > 0 ? wallS : 2.2` — a jump wherever the mountain block
    //  switched off, i.e. a metre-scale step in h.)
    const sNM = 2.2 * sstep(0.0, 0.3, steepNM > cliff ? steepNM : cliff);
    const sW = wallS < 10 ? wallS : 10;
    const sTrue = sW > sNM ? sW : sNM > 0 ? sNM : 1e-3;
    const sEff = sTrue < 1.1 ? 1.1 : sTrue > 2.8 ? 2.8 : sTrue;
    if (wr > 0.02) {
      const rr = R + h;
      const nW = this.nW;
      let lam = st.wallLam;   // per-world constant (see the buttress note above)
      // vertical resolution of a mesh on a wall is ~ vertex spacing × slope: octaves finer than that
      // would be sampled once per vertex column → vertical comb / stripe aliasing. Fade them early.
      const lodV = lod * (sTrue > 1 ? sTrue : 1);
      let sum = 0;
      for (let o = 0; o < 3; o++) {
        const lw = lodW(lam * 0.5, lodV);
        if (lw <= 0) break;
        const f = rr / lam;
        if (o < 2) {
          // jointed blocks: planar facets (two scales), straight seams on the wall
          sum += lam * lw * this._facets3(x * f + 17.3 + o * 5.1, y * f + 3.1 - o * 2.9, z * f + 11.7 - o * 2.3, 7) * (o === 0 ? 0.2 : 0.16);
        } else {
          // fine cracks
          const nv = nW.n3(x * f + 17.3, y * f + 3.1, z * f + 11.7);
          sum += lam * lw * (0.3 - Math.sqrt(nv * nv + 0.0016)) * 0.1;
        }
        lam *= 0.4;
      }
      // (slope factor capped at 3.6: beyond that the displaced wall would fold over in the heightfield)
      h += wr * sstep(0.02, 0.07, wr) * (sTrue < 3.6 ? sEff > sTrue ? sEff : sTrue : 3.6) * sum * st.wallBlocks;
      // ledges (bedding planes / sheeting joints): terrace the wall in altitude. Terracing h is
      // monotonic (never folds) and turns every band into a riser + a narrow shelf. Ledge strength
      // and phase wander along the wall so they come and go like real strata.
      if (st.wallLedges > 0 && lod < st.ledgeStep * 0.6) {
        const lf = R / 260;
        const ln = nW.n3(x * lf + 5.5, y * lf + 8.1, z * lf + 1.9);
        const k = wr * st.wallLedges * sstep(-0.35, 0.35, ln) * lodW(st.ledgeStep * 0.6, lod);
        if (k > 0.005) {
          const kk = k * sstep(0.005, 0.03, k);
          const step = st.ledgeStep * (0.8 + 0.4 * (0.5 + 0.5 * nW.n3(x * lf * 0.5 + 9, y * lf * 0.5, z * lf * 0.5 + 4)));
          // (phase wanders slowly: strata are near-horizontal over hundreds of metres, not swirls)
          const ph = 0.3 * nW.n3(x * lf * 0.6 + 3, y * lf * 0.6 + 1, z * lf * 0.6 + 7);
          const t = (h / step + ph);
          const tt = SurfaceGen.terrace(t, 1, 0.55);
          h += (tt - t) * step * kk * 0.85;
        }
      }
    }

    // ---- wave-cut platforms: where steep rock plunges into the sea, waves erode a near-flat rock shelf
    //      just below the waterline. Heights in [-40, +2] m are pulled toward ≈ -0.6 m with a
    //      monotonic remap (f = h + (P - h)·k, P > h where k rises, P < h where it falls → never folds),
    //      so a wall of slope s gets a ~22/s m wide shelf (7-15 m on 55-70° faces) that the fractal
    //      detail below breaks into rocks; the water track draws surf on it. Patchy along the coast.
    if (this.hasOcean && h > -40 && h < 2.5 && st.shelf > 0) {
      const ks = Math.max(cliff, sstep(1.2, 2.6, wallS), steep * 0.8);
      if (ks > 0.02) {
        const f = R / 1800;
        const wk = ks * st.shelf * sstep(-0.25, 0.25, nF.n3(x * f + 2.7, y * f + 8.3, z * f + 4.1));
        if (wk > 0.01) {
          const k = sstep(-40, -22, h) * (1 - sstep(0.5, 2.5, h));
          const P = -0.7 + 0.25 * (h + 40) / 42;
          h += (P - h) * k * wk;
          const rk = k * wk;
          if (rk > rock) rock = rk;
          sand *= 1 - rk;
        }
      }
    }

    // ---- fractal detail: meso bumps → decimetre relief (rougher on rock)
    if (!(this.cfg.dbg & 8)) {
      const rk = rock > mtn ? rock : mtn;
      // (the great mountain's cone keeps a clean silhouette: its gullies carry the structure)
      const coneK = gr < 1 ? 1 - 0.55 * sstep(0.0, 0.25, 1 - gr) : 1;
      const roughK = st.rough * (0.35 + 2.6 * rk) * (1 - 0.6 * dune) * (1 - 0.5 * lake) * coneK;
      const rr = sstep(0.15, 0.5, rk);
      // starts at 720 m: the two big octaves only exist on rock (crags & buttresses on mountain faces)
      // On walls the octaves below 200 m are sampled at the 3D surface point (radius R + h) and scaled
      // by the slope, like the wall relief above: 2D detail on a heightfield wall is extruded into
      // vertical stripes (the "combed" cliffs). The radius blends continuously (R + wr·h), so ground
      // away from walls is unchanged. The big crag octaves stay 2D (plan-view ribs & couloirs ARE
      // vertical structures). Octaves finer than the wall's vertical mesh resolution are faded.
      const r3 = R + h, lodD = lod * (1 + wr * (sTrue > 1 ? sTrue - 1 : 0)), mW = 1 + wr * (sEff - 1) * 0.5;
      let wl = 720, a = wl * 0.0072 * roughK, sum = 0, cx = 0, cy = 0, cz = 0;
      for (let o = 0; o < 14; o++) {
        const isBig = wl > 200;
        const lw = lodW(wl, isBig ? lod : lodD);
        if (lw <= 0) break;
        const f = (isBig ? R : r3) / wl;
        const v = nH.n3(x * f + cx, y * f + cy, z * f + cz);
        // crags & buttresses: the big octaves are much stronger on rock (cliff faces get real
        // plan-view relief — chutes, ribs, buttresses — instead of reading as smooth clay walls)
        // on steep mountain faces the big octaves grow further (buttresses, ribs and chutes that break
        // kilometre-tall walls into readable structure instead of smooth clay slabs)
        const stB = this.cfg.dbg & 32 ? 0 : steep;
        const big = wl > 200 ? rr * (o === 0 ? 2.4 : 2.0) * (1 + 1.5 * stB) : wl > 120 ? (1 + 0.6 * rr) * (1 + 0.8 * stB) : wl > 60 ? (1 + 0.25 * rr) * (1 + 0.35 * stB) : 1;
        // rock gets sharper (ridged, zero-mean) micro relief, soil stays rounded
        // (big octaves use a softened |v|: a razor crease of a 700 m ridged octave reads as a seam)
        // (razor creases only where the mesh resolves them: an octave within ~6 vertex spacings of the
        //  mesh lod gets a softened |v| — sub-resolution creases shaded as thin dark "hair" strokes
        //  along every badlands gully)
        const ce = wl > 120 ? 0.004 : 0.0003 + 0.005 * Math.min(1, lod * 6 / wl);
        const av = Math.sqrt(v * v + ce);
        // (boosted crag octaves on steep faces mostly CARVE: their positive ridge crests crossing a
        //  mountain crest stacked into isolated needles along the ridge line)
        let rg = (0.342 - av) * 1.6;
        if (rg > 0 && wl > 120) rg *= 1 - 0.65 * stB;
        sum += a * lw * big * (isBig ? 1 : mW) * (v + (rg - v) * rr);
        a *= 0.49; wl *= ILAC;
        cx = cx * LAC + 1.9; cy = cy * LAC + 7.3; cz = cz * LAC + 3.7;
      }
      h += sum;
    }

    if (info) {
      // bare ground (worn soil / gravel patches, 10-60 m) — the same mask paints the terrain's soil
      // patches (per-vertex) and tells flora where grass thins (sample().bare). Only on land, more
      // around rock and talus, none on beaches / dunes. LOD-faded so far chunks don't speckle.
      let bare = 0;
      if (!this.hasOcean || h > 1.5) {
        const w1 = lodW(70, lod), w2 = lodW(20, lod);
        if (w1 > 0) {
          const f1 = R / 48, f2 = R / 13;
          const b1 = nH.n3(x * f1 + 31.7, y * f1 + 7.9, z * f1 + 19.3);
          const b2 = w2 > 0 ? nH.n3(x * f2 + 3.3, y * f2 + 41.1, z * f2 + 5.5) * w2 : 0;
          bare = w1 * sstep(0.3, 0.6, b1 * 0.8 + b2 * 0.3 + 0.3 * rock + 0.45 * talus) * (1 - sand) * (1 - dune) * (1 - lake);
          if (gr < 1.3) bare *= 1 - 0.85 * this._gBelt(gr);   // (no worn-soil patches in the mountain's forest)
        }
      }
      info.bare = bare;
      let sv = st.seasonAmt > 0 ? this._season(px, py, pz, h) : 0.5;
      // the great mountain's forest belt (Yotei: dark green flanks under the snow) turns spring green,
      // except on crimson-maple worlds where the forest stays red
      if (gr < 1.3 && sv < 0.83) sv *= 1 - 0.7 * this._gBelt(gr);
      info.season = sv;
      info.c = c; info.land = land; info.mtn = mtn; info.rock = rock; info.sand = sand;
      info.river = river; info.lake = lake; info.cliff = cliff; info.dune = dune; info.glacier = glacier;
      info.steep = steep; info.wallS = wallS; info.talus = talus;
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
    // orographic rain: the great mountain's flanks are forested (flora reads FOREST / TAIGA there)
    if (this.great) { const gr = this._gr(x, y, z); if (gr < 1.3) m += 0.34 * this._gBelt(gr); }
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
   *        rock, sand, snow, cliff, river, lake, mountain, continental, dune,
   *        talus (0..1: rubble / scree apron at the foot of mesa, plateau and canyon walls),
   *        bare (0..1: worn soil / gravel patches the terrain paints — thin grass there) }
   */
  sample(x, y, z, out = {}, withSlope = true) {
    const info = this._info;
    const h = this.evaluate(x, y, z, LOD_MIN, info);
    this.climate(x, y, z, h, info.c, out);
    out.height = h;
    out.rock = info.rock; out.sand = info.sand; out.cliff = info.cliff; out.river = info.river; out.lake = info.lake;
    out.mountain = info.mtn; out.continental = info.c; out.dune = info.dune; out.talus = info.talus || 0;
    out.bare = info.bare || 0;
    out.season = info.season ?? 0.5;
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
