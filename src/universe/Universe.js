// Universe: deterministic seed hierarchy.
//   Universe(seed) → galaxy(g) → star(g, s) → system(g, s) → planets[] (+ moons[], belts[], comets[])
// Everything is a pure function of (seed, indices) and cached. No Math.random here.
//
// SCALE CONVENTIONS (game units = meters inside a star system):
//   rocky planet radius   25–110 km      (walkable, visible curvature from altitude)
//   gas giant radius      260–650 km
//   moon radius           6–30 km
//   star radius (G class) ~700 km        (appears 1–5° wide from inner planets)
//   orbits                ~2e7–6e8 m     (compressed solar system, Outer-Wilds-like)
//   atmosphere top        ~12% of planet radius (exaggerated for beauty)
//   day length            16–48 min of game time
import * as THREE from 'three';
import { RNG, hashCombine } from '../core/rng.js';
import { blackbody } from '../core/math.js';
import { galaxyName, starName, planetName, moonName, civName, placeName } from './names.js';
import { galaxyStar } from './GalaxyModel.js';
import { MU_SUN, orbitalPeriod } from './orbits.js';
import { pickArt } from './art.js';

export const GALAXY_TYPES = ['spiral', 'barred', 'spiral', 'barred', 'elliptical', 'lenticular', 'irregular', 'ring'];

export const PLANET_TYPES = {
  // type: { rocky, zone ('hot'|'warm'|'cold'|'any'), life chance, ocean chance }
  terran: { zone: 'warm', life: 0.95, ocean: 1.0 },
  ocean: { zone: 'warm', life: 0.9, ocean: 1.0 },
  archipelago: { zone: 'warm', life: 0.95, ocean: 1.0 },
  jungle: { zone: 'warm', life: 1.0, ocean: 0.8 },
  savanna: { zone: 'warm', life: 0.9, ocean: 0.6 },
  desert: { zone: 'hot', life: 0.55, ocean: 0.15 },
  volcanic: { zone: 'hot', life: 0.2, ocean: 0.5 },   // lava seas
  barren: { zone: 'any', life: 0.1, ocean: 0.0 },
  arctic: { zone: 'cold', life: 0.6, ocean: 0.7 },
  toxic: { zone: 'any', life: 0.7, ocean: 0.6 },
  crystal: { zone: 'cold', life: 0.5, ocean: 0.3 },
  exotic: { zone: 'any', life: 0.85, ocean: 0.6 },
  gas: { zone: 'cold', life: 0.0, ocean: 0.0 },
};

export class Universe {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this.rng = new RNG(this.seed);
    this._galaxies = new Map();
    this._stars = new Map();
    this._systems = new Map();
    // cosmic scale (the cosmic web box). Galaxies in the web are indexed 0..galaxyCount-1.
    this.cosmic = { boxSize: 500, galaxyCount: 4096 }; // Mpc/h (display scale is the cosmic track's choice)
  }

  // ------------------------------------------------------------------ galaxies
  galaxy(index) {
    if (this._galaxies.has(index)) return this._galaxies.get(index);
    const seed = hashCombine(this.seed, 0x6a1a, index);
    const r = new RNG(seed);
    const type = r.pick(GALAXY_TYPES);
    const spiralish = type === 'spiral' || type === 'barred' || type === 'ring';
    const g = {
      index, seed, type,
      name: galaxyName(seed),
      radius: r.range(35000, 90000),                 // ly
      thickness: r.range(700, 1600),                 // ly (disk scale height)
      arms: spiralish ? r.weighted([[2, 5], [3, 2], [4, 3], [5, 1], [6, 0.5]]) : type === 'lenticular' ? 0 : r.int(0, 2),
      pitch: r.range(10, 26),                        // degrees
      armStrength: spiralish ? r.range(0.55, 0.85) : type === 'lenticular' ? 0.05 : 0.2,
      bulgeFrac: type === 'lenticular' ? 0.35 : type === 'elliptical' ? 1 : r.range(0.08, 0.2),
      haloFrac: r.range(0.02, 0.05),
      barLength: type === 'barred' ? r.range(0.12, 0.3) : 0,
      flatten: type === 'elliptical' ? r.range(0.4, 0.95) : 1,
      rotation: r.range(0, Math.PI * 2),
      tilt: r.range(0, Math.PI),                     // orientation in cosmic web
      starCount: 2_000_000_000 + Math.floor(r.next() * 4e11), // "real" count (lore)
      displayStars: 1_200_000,                       // particles in galaxy mode at high quality
      colors: {
        core: new THREE.Color().setHSL(r.range(0.07, 0.12), r.range(0.5, 0.8), 0.7),
        arms: new THREE.Color().setHSL(r.range(0.55, 0.66), r.range(0.4, 0.8), 0.7),
        hii: new THREE.Color().setHSL(r.range(0.92, 0.99), r.range(0.6, 0.9), 0.6),
        dust: new THREE.Color().setHSL(r.range(0.05, 0.09), 0.5, 0.12),
      },
      blackHole: { mass: r.range(1e6, 5e9), spin: r.range(0.2, 0.99) }, // solar masses
      age: r.range(8, 13.5),                         // Gyr
    };
    this._galaxies.set(index, g);
    return g;
  }

  // ------------------------------------------------------------------ stars
  star(galaxyIndex, starIndex) {
    const key = galaxyIndex + ':' + starIndex;
    if (this._stars.has(key)) return this._stars.get(key);
    const g = this.galaxy(galaxyIndex);
    const gs = galaxyStar(g, starIndex);
    const seed = hashCombine(g.seed, 0x57a4, starIndex);
    const r = new RNG(seed);
    const color = blackbody(gs.temperature);
    const s = {
      galaxy: galaxyIndex, index: starIndex, seed,
      name: starName(seed),
      cls: gs.cls,
      temperature: gs.temperature,
      luminosity: gs.luminosity,                         // L☉
      radiusSolar: gs.radiusSolar,
      radius: 7e5 * Math.pow(gs.radiusSolar, 0.6),       // game meters (compressed)
      mass: Math.pow(Math.max(gs.luminosity, 1e-3), 0.25),   // M☉ (rough mass–luminosity)
      color,                                              // linear THREE.Color (normalized)
      position: new THREE.Vector3(gs.x, gs.y, gs.z),      // ly, galaxy frame
      component: gs.component,
      flare: r.range(0, 1),                               // activity (flares, prominences)
    };
    this._stars.set(key, s);
    return s;
  }

  // ------------------------------------------------------------------ systems
  system(galaxyIndex, starIndex) {
    const key = galaxyIndex + ':' + starIndex;
    if (this._systems.has(key)) return this._systems.get(key);
    const star = this.star(galaxyIndex, starIndex);
    const r = new RNG(hashCombine(star.seed, 0x5157));
    const mu = MU_SUN * star.mass;
    const lum = Math.max(0.02, Math.min(star.luminosity, 50));
    // habitable-zone center scales with sqrt(L) — in game meters
    const hz = 9e7 * Math.sqrt(lum);
    const nPlanets = r.weighted([[3, 2], [4, 3], [5, 3], [6, 2], [7, 1], [8, 0.5]]);
    let a = Math.max(star.radius * r.range(28, 45), hz * r.range(0.25, 0.45));
    const planets = [];
    let habitableAssigned = false;
    for (let i = 0; i < nPlanets; i++) {
      const zone = a < hz * 0.6 ? 'hot' : a < hz * 1.7 ? 'warm' : 'cold';
      planets.push(this._makePlanet(star, r, i, a, zone, mu, false));
      if (zone === 'warm') habitableAssigned = true;
      a *= r.range(1.45, 1.95);
    }
    // Guarantee at least one living world per system (the universe should never feel empty).
    if (!planets.some((p) => p.life.flora > 0.3)) {
      const idx = planets.reduce((best, p, k) => (Math.abs(Math.log(p.orbit.a / hz)) < Math.abs(Math.log(planets[best].orbit.a / hz)) ? k : best), 0);
      planets[idx] = this._makePlanet(star, new RNG(hashCombine(star.seed, 0xbeef, idx)), idx, planets[idx].orbit.a, 'warm', mu, true);
    }
    // Asteroid belts between planets
    const belts = [];
    const nb = r.weighted([[0, 1], [1, 3], [2, 1.5]]);
    for (let b = 0; b < nb; b++) {
      const k = r.int(0, planets.length - 2);
      const inner = planets[k].orbit.a, outer = planets[k + 1].orbit.a;
      const center = Math.sqrt(inner * outer);
      belts.push({ seed: hashCombine(star.seed, 0xbe17, b), radius: center, width: (outer - inner) * r.range(0.12, 0.3), thickness: center * r.range(0.01, 0.04), density: r.range(0.4, 1), count: r.int(3000, 12000), color: new THREE.Color().setHSL(r.range(0.05, 0.12), r.range(0.1, 0.35), r.range(0.3, 0.5)) });
    }
    const comets = [];
    const nc = r.int(0, 3);
    for (let c = 0; c < nc; c++) {
      const ca = planets[planets.length - 1].orbit.a * r.range(0.6, 1.4);
      comets.push({ seed: hashCombine(star.seed, 0xc0e7, c), orbit: { a: ca, e: r.range(0.75, 0.95), i: r.range(-0.6, 0.6), lan: r.range(0, 6.28), argp: r.range(0, 6.28), M0: r.range(0, 6.28), mu, period: orbitalPeriod(ca, mu) }, radius: r.range(800, 3000) });
    }
    const sys = { key, galaxy: galaxyIndex, star, planets, belts, comets, mu, hz, habitableAssigned };
    this._systems.set(key, sys);
    return sys;
  }

  _makePlanet(star, r, index, a, zone, mu, forceLife, isMoon = false, opts = {}) {
    const seed = opts.seed ?? hashCombine(star.seed, 0x91a7, index, forceLife ? 7 : 0);
    const pr = new RNG(seed);
    // choose type by zone
    const byZone = {
      hot: [['desert', 3], ['volcanic', 2.5], ['barren', 2], ['toxic', 1], ['savanna', 0.7], ['exotic', 0.6]],
      warm: [['terran', 4], ['jungle', 2.5], ['ocean', 2], ['archipelago', 2], ['savanna', 2], ['exotic', 1.5], ['desert', 1], ['toxic', 0.6], ['crystal', 0.4]],
      cold: [['gas', 4], ['arctic', 2.5], ['crystal', 1.2], ['barren', 1.5], ['toxic', 0.8], ['exotic', 0.6]],
    };
    let type = pr.weighted(byZone[zone]);
    if (forceLife) type = pr.weighted([['terran', 3], ['jungle', 2], ['archipelago', 2], ['savanna', 1.5], ['exotic', 1.2]]);
    if (opts.type) type = opts.type;
    const T = PLANET_TYPES[type];
    const isGas = type === 'gas';
    let radius = isGas ? pr.range(2.6e5, 6.5e5) : pr.range(2.8e4, 1.1e5);
    let gravity = isGas ? pr.range(15, 30) : 9.81 * pr.range(0.45, 1.35);
    if (opts.radius) radius = opts.radius;
    if (opts.gravity) gravity = opts.gravity;
    const lifeRoll = pr.next();
    const hasLife = forceLife || (!isGas && lifeRoll < T.life);
    const flora = hasLife ? pr.range(0.45, 1) : 0;
    const fauna = hasLife ? pr.range(0.3, 1) * flora : 0;
    const civLevel = !hasLife ? (pr.chance(0.18) && !isGas ? 1 : 0)
      : pr.weighted([[0, 0.6], [1, 1], [2, 1.6], [3, 2], [4, 1.6], [5, 0.8]]);
    const art = pickArt(pr, type);
    const hasOcean = !isGas && pr.next() < T.ocean;
    const name = planetName(star.name, index, seed);
    const atmDensity = isGas ? 1 : type === 'barren' ? pr.range(0, 0.15) : type === 'volcanic' ? pr.range(0.6, 1.6) : pr.range(0.6, 1.5);
    const p = {
      id: `${star.galaxy}-${star.index}-${index}`,
      index, seed, name, type, zone,
      isGas, isMoon: false,
      radius, gravity,
      mu: gravity * radius * radius,
      dayLength: isGas ? pr.range(600, 1400) : pr.range(16 * 60, 48 * 60),
      axialTilt: pr.range(0, 0.45),
      rotationPhase0: pr.range(0, Math.PI * 2),
      orbit: { a, e: pr.range(0, 0.08), i: pr.range(-0.05, 0.05), lan: pr.range(0, Math.PI * 2), argp: pr.range(0, Math.PI * 2), M0: pr.range(0, Math.PI * 2), mu, period: orbitalPeriod(a, mu) },
      atmosphere: {
        present: atmDensity > 0.05,
        density: atmDensity,
        height: radius * (isGas ? 0.06 : pr.range(0.1, 0.14)),
        // Rayleigh tint: blue for earthlike; art preset sky color can override hue
        tint: new THREE.Color(art.palette.sky),
        mie: pr.range(0.6, 1.6),
        mieG: pr.range(0.72, 0.85),
        haze: art.weather.dust ?? 0,
      },
      ocean: {
        present: hasOcean,
        level: hasOcean ? 0 : -1e9,
        liquid: type === 'volcanic' ? 'lava' : type === 'toxic' ? 'acid' : type === 'arctic' && pr.chance(0.4) ? 'ice' : 'water',
        shallow: new THREE.Color(art.palette.water),
        deep: new THREE.Color(art.palette.deep),
      },
      clouds: {
        coverage: isGas ? 1 : type === 'barren' ? 0 : pr.range(0.15, 0.7),
        type: art.clouds,
        altitude: radius * pr.range(0.02, 0.04),
      },
      terrain: {
        amplitude: isGas ? 0 : radius * pr.range(0.035, 0.07),   // max relief (m)
        continentFreq: pr.range(0.8, 2.2),
        mountainScale: pr.range(0.6, 1.4),
        roughness: pr.range(0.4, 0.7),
        oceanFraction: hasOcean ? (type === 'ocean' ? pr.range(0.75, 0.9) : type === 'archipelago' ? pr.range(0.65, 0.8) : pr.range(0.35, 0.6)) : 0,
        features: pickFeatures(pr, type),
      },
      life: { flora, fauna, style: art.flora },
      civ: {
        level: civLevel, // 0 none · 1 ruins · 2 villages · 3 towns · 4 cities · 5 megacity/spaceport
        style: art.civ,
        name: civLevel > 0 ? civName(seed) : null,
        settlements: civLevel === 0 ? 0 : Math.round([0, 3, 6, 9, 12, 16][civLevel] * pr.range(0.7, 1.3)),
        placeSeed: hashCombine(seed, 0x9a9),
      },
      rings: (isGas ? pr.chance(0.65) : pr.chance(0.08)) ? {
        inner: radius * pr.range(1.3, 1.7), outer: radius * pr.range(2.0, 2.9),
        color: new THREE.Color().setHSL(pr.range(0.05, 0.14), pr.range(0.15, 0.45), pr.range(0.55, 0.8)),
        opacity: pr.range(0.35, 0.85), tilt: pr.range(-0.4, 0.4),
      } : null,
      art,
      weather: { ...art.weather, aurora: pr.chance(0.35) ? pr.range(0.3, 1) : 0, storms: pr.chance(0.3) ? pr.range(0.2, 1) : 0 },
      moons: [],
    };
    // moons
    const nMoons = isMoon ? 0 : isGas ? pr.weighted([[1, 2], [2, 3], [3, 2], [4, 1]]) : pr.weighted([[0, 3], [1, 2.5], [2, 1]]);
    let ma = radius * (isGas ? pr.range(4, 6) : pr.range(9, 14));
    for (let m = 0; m < nMoons; m++) {
      p.moons.push(this._makeMoon(star, p, m, ma, pr));
      ma *= pr.range(1.5, 2.1);
    }
    return p;
  }

  _makeMoon(star, planet, m, a, pr) {
    const seed = hashCombine(planet.seed, 0x3001, m);
    const r = new RNG(seed);
    // Moons of gas giants in the warm zone can be lush worlds (Pandora!)
    const lushChance = planet.isGas && planet.zone !== 'hot' ? 0.45 : 0.12;
    const lush = r.chance(lushChance);
    const type = lush ? r.pick(['jungle', 'terran', 'exotic', 'archipelago']) : r.pick(['barren', 'arctic', 'volcanic', 'crystal', 'barren']);
    const radius = r.range(1.2e4, lush ? 4.5e4 : 3e4);
    const gravity = 9.81 * r.range(0.25, lush ? 0.9 : 0.5);
    const amp = r.range(0.04, 0.08);
    const moon = this._makePlanet(star, r, 20 + m, a, lush ? 'warm' : 'cold', planet.mu, lush, true, { type, radius, gravity, seed });
    moon.isGas = false;
    moon.isMoon = true;
    moon.parent = planet.index;
    moon.index = m;
    moon.id = `${planet.id}.${m}`;
    moon.name = moonName(planet.name, m, seed);
    moon.terrain.amplitude = moon.radius * amp;
    moon.orbit = { a, e: r.range(0, 0.05), i: r.range(-0.15, 0.15), lan: r.range(0, 6.28), argp: r.range(0, 6.28), M0: r.range(0, 6.28), mu: planet.mu, period: orbitalPeriod(a, planet.mu) };
    moon.moons = [];
    moon.rings = null;
    return moon;
  }

  /** Resolve "2" or "2.1" (planet 2, moon 1) within a system. */
  body(system, ref) {
    if (ref === undefined || ref === null || ref === '') return null;
    const [pi, mi] = String(ref).split('.').map((x) => parseInt(x, 10));
    const p = system.planets[Math.max(0, Math.min(system.planets.length - 1, pi || 0))];
    if (mi === undefined || Number.isNaN(mi)) return p;
    return p.moons[Math.max(0, Math.min(p.moons.length - 1, mi))] || p;
  }

  /** The most beautiful default landing target: prefer civilized living worlds. */
  bestPlanet(system) {
    let best = system.planets[0], score = -1;
    const all = system.planets.flatMap((p) => [p, ...p.moons]);
    for (const p of all) {
      if (p.isGas) continue;
      const s = p.life.flora * 2 + p.civ.level * 0.6 + (p.ocean.present ? 0.5 : 0) + (p.atmosphere.present ? 0.5 : 0);
      if (s > score) { score = s; best = p; }
    }
    return best;
  }

  placeName(planet, k) { return placeName(hashCombine(planet.civ.placeSeed, k)); }
}

function pickFeatures(r, type) {
  const all = {
    terran: ['rivers', 'cliffs', 'plateaus', 'canyons', 'lakes', 'terraces'],
    ocean: ['archipelago', 'atolls', 'seastacks', 'cliffs'],
    archipelago: ['archipelago', 'seastacks', 'atolls', 'arches'],
    jungle: ['karst', 'rivers', 'waterfalls', 'cliffs', 'sinkholes'],
    savanna: ['mesas', 'plateaus', 'rivers', 'kopjes'],
    desert: ['dunes', 'mesas', 'canyons', 'arches', 'saltflats'],
    volcanic: ['calderas', 'lavaflows', 'spires', 'craters'],
    barren: ['craters', 'canyons', 'mesas', 'rilles'],
    arctic: ['glaciers', 'fjords', 'icebergs', 'crevasses'],
    toxic: ['sinkholes', 'spires', 'pools', 'karst'],
    crystal: ['spires', 'crystals', 'terraces', 'craters'],
    exotic: ['floating', 'arches', 'spires', 'terraces', 'karst'],
    gas: [],
  }[type] || [];
  return r.shuffle([...all]).slice(0, Math.min(all.length, r.int(2, 4)));
}
