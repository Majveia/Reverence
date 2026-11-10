// The Universe model: a deterministic, seed-driven description of everything that exists.
// Pure data — no three.js, no DOM — so it can be used from workers and tests.
//
//   universe.galaxy(id)            → GalaxyDesc
//   universe.starBrief(starSeed)   → { cls, temp, radius, lum, color } (cheap; for drawing 100k stars)
//   universe.system(ref)           → SystemDesc  (ref = { galaxyId, starSeed, name? } or 'home')
//
// GAME SCALE.  Distances are compressed so the sky is full and travel is a pleasure, but every orbit is a real
// Kepler ellipse.  Roughly 1:100 for bodies:  an Earth-like world is 60 km in radius with 1 g at the surface.

import { rng, hash32, lerp } from '../rng.js';
import { THEMES, GIANTS } from './themes.js';
import { starName, galaxyName, makeName, roman } from './names.js';

export { THEMES, GIANTS } from './themes.js';
export * from './kepler.js';

export const SCALE = {
  R_SUN: 7.0e6,      // m   radius of a Sun-like star
  AU: 1.5e9,         // m   habitable-zone distance of a Sun-like star
  YEAR: 10800,       // s   orbital period at 1 AU around 1 solar mass  (3 h)
  R_EARTH: 6.0e4,    // m   radius of an Earth-like world
  DAY: 1440,         // s   a standard day (24 min)
  G: 9.81,           // m/s²
};

const TAU = Math.PI * 2;

const STAR_CLASSES = [
  { cls: 'M', w: 34, temp: [2700, 3800], radius: [0.3, 0.6], lum: [0.03, 0.09], mass: [0.2, 0.5] },
  { cls: 'K', w: 22, temp: [3900, 5100], radius: [0.65, 0.9], lum: [0.15, 0.5], mass: [0.6, 0.85] },
  { cls: 'G', w: 18, temp: [5200, 6000], radius: [0.9, 1.15], lum: [0.7, 1.4], mass: [0.9, 1.1] },
  { cls: 'F', w: 10, temp: [6100, 7400], radius: [1.2, 1.5], lum: [1.8, 4], mass: [1.2, 1.5] },
  { cls: 'A', w: 6, temp: [7500, 10000], radius: [1.6, 2.2], lum: [6, 20], mass: [1.6, 2.4] },
  { cls: 'B', w: 3, temp: [11000, 26000], radius: [2.8, 5], lum: [60, 400], mass: [3, 12] },
  { cls: 'O', w: 0.8, temp: [30000, 42000], radius: [6, 10], lum: [2000, 9000], mass: [18, 50] },
  { cls: 'giant', w: 4, temp: [3200, 4600], radius: [10, 22], lum: [80, 500], mass: [1, 3] },
  { cls: 'dwarf', w: 1.6, temp: [9000, 26000], radius: [0.1, 0.16], lum: [0.004, 0.02], mass: [0.6, 1.0] },
  { cls: 'pulsar', w: 0.4, temp: [38000, 40000], radius: [0.035, 0.04], lum: [0.4, 1.5], mass: [1.4, 2.0] },
];
const STAR_W = STAR_CLASSES.map((c) => c.w);

/** Blackbody → linear-sRGB colour, max channel 1.  T in Kelvin. */
export function blackbody(T) {
  const t = Math.min(Math.max(T, 1000), 40000) / 100;
  let r, g, b;
  r = t <= 66 ? 1 : Math.min(1, Math.max(0, 1.29293618606 * Math.pow(t - 60, -0.1332047592)));
  g = t <= 66 ? Math.min(1, Math.max(0, 0.39008157876 * Math.log(t) - 0.63184144378)) : Math.min(1, Math.max(0, 1.12989086089 * Math.pow(t - 60, -0.0755148492)));
  b = t >= 66 ? 1 : t <= 19 ? 0 : Math.min(1, Math.max(0, 0.54320678911 * Math.log(t - 10) - 1.19625408914));
  return [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)];
}

const HABITABLE = ['pastoral', 'ocean', 'jungle', 'mist', 'desert', 'crystal'];

export class Universe {
  constructor(seed = 20261110) {
    this.seed = seed >>> 0;
    this._systems = new Map();
    this._galaxies = new Map();
    /** Where every journey begins. */
    this.home = { galaxyId: 'home', starSeed: 'home', bodyId: 'solenne' };
  }

  // ───────────────────────── galaxies ─────────────────────────
  /** @returns GalaxyDesc */
  galaxy(id = 'home') {
    let g = this._galaxies.get(id);
    if (g) return g;
    const seed = id === 'home' ? hash32(this.seed, 'canticle') : hash32(this.seed, 'galaxy', String(id));
    const r = rng(seed);
    const type = id === 'home' ? 'barred' : r.weighted(['spiral', 'barred', 'elliptical', 'lenticular', 'irregular', 'ring'], [36, 24, 16, 8, 10, 6]);
    const spiral = type === 'spiral' || type === 'barred';
    g = {
      id, seed, type,
      name: id === 'home' ? 'Canticle' : galaxyName(seed),
      radius: id === 'home' ? 26 : r.range(8, 48),               // kpc (visible disc radius)
      arms: spiral ? (id === 'home' ? 4 : r.weighted([2, 3, 4, 5, 6], [8, 3, 6, 2, 1])) : 0,
      pitch: spiral ? r.range(0.2, 0.46) : 0,                    // rad; tightness of the logarithmic arms
      bar: type === 'barred' ? r.range(0.18, 0.34) : 0,          // bar half-length / radius
      bulge: type === 'elliptical' ? r.range(0.5, 0.9) : r.range(0.1, 0.24),
      thickness: type === 'elliptical' ? r.range(0.5, 0.9) : type === 'irregular' ? r.range(0.15, 0.3) : r.range(0.03, 0.06),
      warp: r.range(0, 0.12), flocculence: r.range(0.15, 0.9),
      dust: type === 'elliptical' ? 0.05 : r.range(0.5, 1.0),
      starFormation: type === 'elliptical' || type === 'lenticular' ? r.range(0, 0.15) : r.range(0.4, 1.0),
      // orientation of the disc normal in the cosmos realm
      axis: r.dir(), spin: r.chance(0.5) ? 1 : -1,
      palette: {
        core: r.pick(['#ffd9a0', '#ffe2b8', '#ffcf9a', '#fff0d0']),
        arm: r.pick(['#8fb8ff', '#9ccaff', '#a8b8ff', '#7fd0ff']),
        hii: r.pick(['#ff5a8a', '#ff6fa8', '#ff4f6f']),
        dust: r.pick(['#3a1f14', '#2a1810', '#40261a']),
      },
      /** Supermassive black hole at the heart of every large galaxy. */
      core: { name: id === 'home' ? 'The Source' : `${makeName(seed + 5)} Deep`, mass: Math.pow(10, r.range(6, 9.6)) },
      starCount: Math.pow(10, r.range(9.5, 11.8)),
    };
    this._galaxies.set(id, g);
    return g;
  }

  /** Galaxy id hosted by a cosmic-web halo (the cosmos realm decides which halo is `home`). */
  galaxyIdForHalo(haloIndex) { return 'g' + hash32(this.seed, 'halo', haloIndex).toString(36); }

  // ───────────────────────── stars ─────────────────────────
  /** Cheap star properties from a seed (number or string).  Deterministic. */
  starBrief(starSeed) {
    if (starSeed === 'home') return { cls: 'G', temp: 5780, radius: SCALE.R_SUN, lum: 1, mass: 1, color: blackbody(5780) };
    const r = rng(hash32(this.seed, 'star', String(starSeed)));
    const c = r.weighted(STAR_CLASSES, STAR_W), k = r();
    const temp = lerp(c.temp[0], c.temp[1], k);
    return { cls: c.cls, temp, radius: SCALE.R_SUN * lerp(c.radius[0], c.radius[1], k), lum: lerp(c.lum[0], c.lum[1], k * k), mass: lerp(c.mass[0], c.mass[1], k), color: blackbody(temp) };
  }

  // ───────────────────────── star systems ─────────────────────────
  /** @param ref 'home' | { galaxyId, starSeed, name? }  @returns SystemDesc */
  system(ref = 'home') {
    if (ref === 'home' || ref?.starSeed === 'home') ref = { galaxyId: 'home', starSeed: 'home' };
    const key = `${ref.galaxyId}:${ref.starSeed}`;
    let s = this._systems.get(key);
    if (!s) { s = ref.starSeed === 'home' ? this._homeSystem() : this._generateSystem(ref); this._systems.set(key, s); }
    return s;
  }

  _body(sysSeed, o) {
    const seed = hash32(sysSeed, 'body', o.id);
    const t = o.theme ? THEMES[o.theme] : null;
    const b = {
      kind: 'planet', class: 'terrestrial', surface: !!t, seed,
      radius: SCALE.R_EARTH, gravity: SCALE.G, rotationPeriod: SCALE.DAY, tilt: 0.2, locked: false,
      rings: null, civ: null, moons: [], parent: null,
      ...o,
    };
    if (t) {
      b.themeData = t; b.label = t.label; b.homage = t.homage; b.mood = t.mood;
      b.palette = { ...t.palette, ...(o.palette || {}) };
      b.terrain = { ...t.terrain, ...(o.terrain || {}) };
      b.atmosphere = o.atmosphere === null ? null : (t.atmosphere ? { ...t.atmosphere, ...(o.atmosphere || {}), fog: { ...t.atmosphere.fog, ...(o.atmosphere?.fog || {}) }, clouds: { ...t.atmosphere.clouds, ...(o.atmosphere?.clouds || {}) } } : null);
      b.ocean = o.ocean === null ? null : (t.ocean ? { ...t.ocean, ...(o.ocean || {}) } : null);
      b.life = { ...t.life, ...(o.life || {}) };
      b.grade = { ...t.grade, ...(o.grade || {}) };
    } else if (o.giant) {
      b.class = 'giant'; b.giantData = GIANTS[o.giant]; b.label = GIANTS[o.giant].label; b.surface = false;
      b.atmosphere = { height: 0.03, haze: GIANTS[o.giant].haze };
    }
    return b;
  }

  _finish(sys) {
    const byId = new Map(sys.bodies.map((b) => [b.id, b]));
    for (const b of sys.bodies) { if (b.parent && byId.get(b.parent)) byId.get(b.parent).moons.push(b.id); }
    sys.body = (id) => byId.get(id);
    sys.landable = sys.bodies.filter((b) => b.surface);
    return sys;
  }

  _homeSystem() {
    const seed = hash32(this.seed, 'auriel');
    const B = (o) => this._body(seed, o);
    const AU = SCALE.AU, RE = SCALE.R_EARTH, DAY = SCALE.DAY, Y = SCALE.YEAR;
    const orbit = (aAU, e, inc, M0, extra = {}) => ({ a: aAU * AU, e, inc, node: M0 * 2.1, peri: M0 * 1.3, M0, period: Y * Math.pow(aAU, 1.5), ...extra });
    const moonOrbit = (parentR, k, period, e, inc, M0) => ({ a: parentR * k, e, inc, node: M0 * 1.7, peri: M0 * 0.9, M0, period });
    const HALCYON_R = RE * 11;
    const sys = {
      id: 'home:home', galaxyId: 'home', starSeed: 'home', seed, name: 'Auriel', home: true,
      star: { id: 'star', kind: 'star', name: 'Auriel', cls: 'G', temp: 5780, radius: SCALE.R_SUN, lum: 1, mass: 1, color: blackbody(5780), hz: AU },
      bodies: [
        B({ id: 'ember', name: 'Ember', theme: 'volcanic', radius: RE * 0.62, gravity: 7.4, rotationPeriod: DAY * 2.6, tilt: 0.05, orbit: orbit(0.34, 0.06, 0.03, 0.4),
          civ: { level: 1, style: 'forge', cities: 0, towns: 2, outposts: 3, monuments: 3 } }),
        B({ id: 'kharaa', name: 'Kharaa', theme: 'desert', radius: RE * 0.9, gravity: 8.9, rotationPeriod: DAY * 1.3, tilt: 0.12, orbit: orbit(0.62, 0.03, 0.02, 2.2),
          civ: { level: 2, style: 'monolith', cities: 2, towns: 4, outposts: 5, monuments: 6 } }),
        B({ id: 'solenne', name: 'Solenne', theme: 'pastoral', radius: RE, gravity: 9.81, rotationPeriod: DAY, tilt: 0.3, orbit: orbit(1.0, 0.017, 0.0, 0.0),
          civ: { level: 2, style: 'hilltown', cities: 3, towns: 7, outposts: 4, monuments: 5 } }),
        B({ id: 'pearl', name: 'Pearl', kind: 'moon', parent: 'solenne', theme: 'barren', radius: RE * 0.2, gravity: 1.9, locked: true, rotationPeriod: 2100, tilt: 0.02,
          orbit: moonOrbit(RE, 16, 2100, 0.03, 0.09, 1.1), civ: { level: 1, style: 'outpost', cities: 0, towns: 0, outposts: 2, monuments: 2 } }),
        B({ id: 'verdance', name: 'Verdance', theme: 'jungle', radius: RE * 1.15, gravity: 10.6, rotationPeriod: DAY * 0.85, tilt: 0.42, orbit: orbit(1.42, 0.04, 0.05, 4.1),
          civ: { level: 2, style: 'canopy', cities: 1, towns: 6, outposts: 3, monuments: 7 } }),
        B({ id: 'yugen', name: 'Yūgen', theme: 'mist', radius: RE * 0.95, gravity: 9.2, rotationPeriod: DAY * 1.1, tilt: 0.38, orbit: orbit(1.9, 0.05, 0.04, 5.3),
          civ: { level: 2, style: 'temple', cities: 1, towns: 6, outposts: 2, monuments: 9 } }),
        B({ id: 'halcyon', name: 'Halcyon', giant: 'saturnine', radius: HALCYON_R, gravity: 22, rotationPeriod: DAY * 0.42, tilt: 0.47, orbit: orbit(3.4, 0.05, 0.02, 1.2),
          rings: { inner: 1.35, outer: 2.45, color: '#e8d6ae', opacity: 0.9, seed: 7 } }),
        B({ id: 'nocturne', name: 'Nocturne', kind: 'moon', parent: 'halcyon', theme: 'neon', radius: RE * 0.8, gravity: 8.2, locked: true, rotationPeriod: 3900, tilt: 0.0,
          orbit: moonOrbit(HALCYON_R, 5.2, 3900, 0.01, 0.02, 0.3), civ: { level: 3, style: 'megacity', cities: 5, towns: 6, outposts: 4, monuments: 4 } }),
        B({ id: 'boreal', name: 'Boreal', kind: 'moon', parent: 'halcyon', theme: 'ice', radius: RE * 0.55, gravity: 5.2, locked: true, rotationPeriod: 6800, tilt: 0.0,
          orbit: moonOrbit(HALCYON_R, 7.6, 6800, 0.02, 0.06, 2.6), civ: { level: 1, style: 'dome', cities: 0, towns: 3, outposts: 4, monuments: 5 } }),
        B({ id: 'lumen', name: 'Lumen', kind: 'moon', parent: 'halcyon', theme: 'barren', radius: RE * 0.3, gravity: 2.6, locked: true, rotationPeriod: 2500, tilt: 0.0,
          orbit: moonOrbit(HALCYON_R, 3.5, 2500, 0.01, 0.01, 4.4), civ: { level: 1, style: 'monolith', cities: 0, towns: 0, outposts: 2, monuments: 6 } }),
        B({ id: 'prisma', name: 'Prisma', theme: 'crystal', radius: RE * 0.7, gravity: 6.9, rotationPeriod: DAY * 1.7, tilt: 0.2, orbit: orbit(2.5, 0.09, 0.11, 3.0),
          civ: { level: 1, style: 'spire', cities: 0, towns: 3, outposts: 3, monuments: 8 } }),
        B({ id: 'mirelle', name: 'Mirelle', giant: 'azure', radius: RE * 5.2, gravity: 12, rotationPeriod: DAY * 0.7, tilt: 1.1, orbit: orbit(5.6, 0.03, 0.03, 5.9),
          rings: { inner: 1.6, outer: 1.95, color: '#bfe8f2', opacity: 0.35, seed: 3 } }),
        B({ id: 'thalune', name: 'Thalune', kind: 'moon', parent: 'mirelle', theme: 'ocean', radius: RE * 0.75, gravity: 7.8, locked: false, rotationPeriod: DAY * 0.9, tilt: 0.15,
          orbit: moonOrbit(RE * 5.2, 7, 5200, 0.02, 0.04, 0.8), civ: { level: 2, style: 'harbor', cities: 1, towns: 8, outposts: 2, monuments: 4 } }),
      ],
      belts: [{ id: 'belt', name: 'The Scatter', a: 2.9 * AU, width: 0.32 * AU, thickness: 0.035 * AU, count: 1, seed: 11 }],
      comets: [{ id: 'wanderer', name: "Wanderer's Comet", orbit: { a: 4.2 * AU, e: 0.82, inc: 0.4, node: 1.0, peri: 2.0, M0: 0.15, period: Y * Math.pow(4.2, 1.5) }, radius: 2200, seed: 5 }],
    };
    return this._finish(sys);
  }

  _generateSystem(ref) {
    const seed = hash32(this.seed, 'system', String(ref.galaxyId), String(ref.starSeed));
    const r = rng(seed), brief = this.starBrief(ref.starSeed);
    const name = ref.name || starName(seed);
    const hz = SCALE.AU * Math.pow(brief.lum, 0.3);
    const star = { id: 'star', kind: 'star', name, ...brief, hz };
    const sys = { id: `${ref.galaxyId}:${ref.starSeed}`, galaxyId: ref.galaxyId, starSeed: ref.starSeed, seed, name, home: false, star, bodies: [], belts: [], comets: [] };
    const B = (o) => this._body(seed, o);
    const exotic = brief.cls === 'pulsar' || brief.cls === 'dwarf';
    const n = exotic ? r.int(1, 4) : r.int(3, 8);
    let a = hz * r.range(0.22, 0.36);
    const yearAt = (aM) => SCALE.YEAR * Math.pow(aM / SCALE.AU, 1.5) / Math.sqrt(brief.mass);
    for (let i = 0; i < n; i++) {
      const z = a / hz, id = 'p' + (i + 1), pname = `${name} ${roman(i)}`;
      const orbit = { a, e: r.range(0, 0.09), inc: r.gauss() * 0.04, node: r() * TAU, peri: r() * TAU, M0: r() * TAU, period: yearAt(a) };
      const giantChance = z > 2.4 ? 0.7 : z > 1.6 ? 0.3 : z < 0.5 ? 0.08 : 0.04;
      if (r.chance(giantChance)) {
        const giant = z < 0.6 ? 'crimson' : r.weighted(['jovian', 'saturnine', 'azure', 'viridian', 'amethyst'], [5, 3, 4, 2, 2]);
        const ice = giant === 'azure' || giant === 'viridian';
        const radius = SCALE.R_EARTH * (ice ? r.range(4, 6) : r.range(8, 13));
        const rings = r.chance(giant === 'saturnine' ? 1 : 0.4) ? { inner: r.range(1.25, 1.6), outer: r.range(1.9, 2.7), color: r.pick(['#e8d6ae', '#cfd6e2', '#e6c9b0', '#bfe8f2']), opacity: r.range(0.3, 0.95), seed: r.int(1, 999) } : null;
        sys.bodies.push(B({ id, name: makeName(seed + i * 17), giant, radius, gravity: r.range(11, 26), rotationPeriod: SCALE.DAY * r.range(0.35, 0.8), tilt: r.range(0, 0.6), orbit, rings }));
        const moons = r.int(1, 4); let k = r.range(3.2, 5);
        for (let m = 0; m < moons; m++) {
          const mth = z > 1.8 ? r.weighted(['ice', 'barren', 'volcanic', 'ocean', 'neon', 'crystal'], [5, 5, 2, 1, 0.6, 1])
            : r.weighted(['barren', 'volcanic', 'desert', 'jungle', 'ocean', 'mist', 'neon', 'crystal'], [4, 2, 2, 1.5, 1.5, 1, 0.8, 1]);
          const period = 2200 * Math.pow(k / 4, 1.5), locked = r.chance(0.7);
          sys.bodies.push(B(this._world(r, { id: `${id}m${m + 1}`, name: makeName(seed + i * 17 + m * 5 + 3), kind: 'moon', parent: id, theme: mth,
            radius: SCALE.R_EARTH * r.range(0.2, 0.8), locked, rotationPeriod: locked ? period : SCALE.DAY * r.range(0.7, 2), orbit: { a: radius * k, e: r.range(0, 0.04), inc: r.gauss() * 0.05, node: r() * TAU, peri: r() * TAU, M0: r() * TAU, period } })));
          k *= r.range(1.4, 1.9);
        }
      } else {
        const th = z < 0.5 ? r.weighted(['volcanic', 'barren', 'desert'], [5, 4, 2])
          : z < 0.75 ? r.weighted(['desert', 'barren', 'crystal', 'volcanic'], [5, 3, 2, 1])
            : z < 1.6 ? r.weighted([...HABITABLE, 'neon'], [5, 4, 4, 3, 3, 2, 1])
              : z < 2.6 ? r.weighted(['ice', 'barren', 'mist', 'crystal'], [5, 3, 2, 1.5])
                : r.weighted(['ice', 'barren'], [3, 2]);
        const radius = SCALE.R_EARTH * r.range(0.5, 1.4);
        sys.bodies.push(B(this._world(r, { id, name: r.chance(0.6) ? makeName(seed + i * 17) : pname, theme: th, radius, rotationPeriod: SCALE.DAY * r.range(0.6, 2.4), tilt: r.range(0, 0.5), orbit })));
        if (r.chance(0.45)) {
          const k = r.range(9, 20), period = 1500 * Math.pow(k / 10, 1.5);
          sys.bodies.push(B(this._world(r, { id: `${id}m1`, name: makeName(seed + i * 17 + 9), kind: 'moon', parent: id, theme: r.weighted(['barren', 'ice', 'volcanic'], [6, 2, 1]),
            radius: radius * r.range(0.15, 0.3), locked: true, rotationPeriod: period, orbit: { a: radius * k, e: r.range(0, 0.05), inc: r.gauss() * 0.08, node: r() * TAU, peri: r() * TAU, M0: r() * TAU, period } })));
        }
      }
      if (i === Math.floor(n / 2) && r.chance(0.55)) { const ba = a * r.range(1.35, 1.5); sys.belts.push({ id: 'belt' + i, name: `${makeName(seed + 99)} Belt`, a: ba, width: ba * 0.11, thickness: ba * 0.012, count: 1, seed: r.int(1, 999) }); a = ba * 1.12; }
      a *= r.range(1.42, 1.85);
    }
    if (r.chance(0.5)) { const ca = a * r.range(0.8, 1.4); sys.comets.push({ id: 'comet', name: `${makeName(seed + 222)}'s Comet`, orbit: { a: ca, e: r.range(0.7, 0.9), inc: r.range(-0.6, 0.6), node: r() * TAU, peri: r() * TAU, M0: r() * 0.4, period: yearAt(ca) }, radius: r.range(1200, 3000), seed: r.int(1, 999) }); }
    return this._finish(sys);
  }

  /** Fill in per-world physical properties + civilisation for a generated landable world. */
  _world(r, o) {
    const t = THEMES[o.theme];
    const rel = o.radius / SCALE.R_EARTH;
    const g = SCALE.G * Math.pow(rel, 0.8) * r.range(0.85, 1.15);
    const habitable = HABITABLE.includes(o.theme) || o.theme === 'neon';
    let civ = null;
    const p = o.theme === 'neon' ? 1 : habitable ? 0.55 : 0.25;
    if (r.chance(p)) {
      const level = o.theme === 'neon' ? 3 : habitable ? r.weighted([1, 2, 3], [4, 4, 1]) : 1;
      const style = { pastoral: 'hilltown', ocean: 'harbor', jungle: 'canopy', mist: 'temple', desert: 'monolith', crystal: 'spire', neon: 'megacity', ice: 'dome', volcanic: 'forge', barren: 'outpost' }[o.theme];
      civ = { level, style, cities: level === 3 ? r.int(3, 5) : level === 2 ? r.int(1, 3) : 0, towns: level >= 2 ? r.int(3, 7) : r.int(0, 3), outposts: r.int(1, 5), monuments: r.int(2, 8) };
    } else if (r.chance(0.5)) {
      civ = { level: 0, style: 'ruin', cities: 0, towns: 0, outposts: 0, monuments: r.int(2, 7) };   // someone was here, long ago
    }
    // gentle per-world variation of the theme's terrain so no two worlds are twins
    const terrain = { amplitude: t.terrain.amplitude * r.range(0.8, 1.25), seaLevel: Math.max(0, t.terrain.seaLevel + (t.ocean ? r.range(-0.08, 0.08) : 0)) };
    return { gravity: g, tilt: r.range(0, 0.5), civ, terrain, ...o };
  }

  /** Human-readable scale label for HUDs. */
  static scaleLabel(metres) {
    const LY = 9.4607e15, PC = 3.0857e16;
    if (metres < 1e3) return `${metres.toFixed(metres < 10 ? 1 : 0)} m`;
    if (metres < 1e7) return `${(metres / 1e3).toFixed(metres < 1e5 ? 1 : 0)} km`;
    if (metres < 1e12) return `${(metres / 1e6).toFixed(0)} Mm`;
    if (metres < LY) return `${(metres / 1.496e11).toFixed(1)} AU`;
    if (metres < 3262 * LY) return `${(metres / LY).toFixed(metres < 10 * LY ? 1 : 0)} ly`;
    if (metres < 1e6 * PC) return `${(metres / (1e3 * PC)).toFixed(1)} kpc`;
    return `${(metres / (1e6 * PC)).toFixed(metres < 1e8 * PC ? 1 : 0)} Mpc`;
  }
}
