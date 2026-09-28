// Species roster — deterministic per planet (body.seed), art-directed by body.art.
// Each species: { id, name, archetype, layer, genome, look, habitat, group, temper, glow, ... }
import * as THREE from 'three';
import { RNG, hashCombine } from '../../core/rng.js';
import { word } from '../../universe/names.js';
import { BIOMES } from '../planet/PlanetSurface.js';
import { leggedGenome } from './bodies/legged.js';
import { chainGenome } from './bodies/chain.js';

// how wild / stylized each art preset's creatures are (0 naturalistic … 1 outlandish), glow propensity
const STYLE = {
  ghibli: { exotic: 0.25, glow: 0.15, sat: 1.0 }, moebius: { exotic: 0.7, glow: 0.2, sat: 0.9 },
  villeneuve: { exotic: 0.15, glow: 0.05, sat: 0.6 }, bladerunner: { exotic: 0.55, glow: 0.95, sat: 1.1 },
  stalenhag: { exotic: 0.2, glow: 0.05, sat: 0.7 }, rogerdean: { exotic: 0.8, glow: 0.7, sat: 1.15 },
  tarkovsky: { exotic: 0.1, glow: 0.05, sat: 0.6 }, friedrich: { exotic: 0.05, glow: 0.0, sat: 0.6 },
  bierstadt: { exotic: 0.1, glow: 0.05, sat: 0.85 }, beksinski: { exotic: 0.6, glow: 0.3, sat: 0.6 },
  nausicaa: { exotic: 0.75, glow: 0.5, sat: 0.9 }, bebop: { exotic: 0.25, glow: 0.05, sat: 0.8 },
  rickmorty: { exotic: 1.0, glow: 0.45, sat: 1.35 }, kubrick: { exotic: 0.2, glow: 0.0, sat: 0.4 },
  turner: { exotic: 0.1, glow: 0.05, sat: 0.8 }, crystal: { exotic: 0.8, glow: 0.8, sat: 1.1 },
  botw: { exotic: 0.2, glow: 0.1, sat: 1.05 }, outerwilds: { exotic: 0.35, glow: 0.25, sat: 1.0 },
  nms: { exotic: 0.9, glow: 0.5, sat: 1.25 }, starfield: { exotic: 0.3, glow: 0.1, sat: 0.8 },
};

const NOUNS = {
  grazer: ['Strider', 'Grazer', 'Runner', 'Hornback', 'Browser', 'Antelope', 'Plainswalker', 'Longstep', 'Duneleaper', 'Meadowkin'],
  giant: ['Colossus', 'Longneck', 'Titan', 'Behemoth', 'Skystrider', 'Treeshaker', 'Thunderfoot'],
  hexapod: ['Crawler', 'Carapace', 'Mantid', 'Scuttler', 'Shellback', 'Sixfoot', 'Chitterling'],
  hopper: ['Hopper', 'Leaper', 'Springtail', 'Bounder', 'Pouncer'],
  critter: ['Skitter', 'Burrowling', 'Nibbler', 'Scamp', 'Dustmouse', 'Whisker'],
  bird: ['Swift', 'Glider', 'Kite', 'Wingling', 'Heron', 'Skylark', 'Windrider'],
  ray: ['Skyray', 'Manta', 'Veilwing', 'Cloudray', 'Driftwing'],
  whale: ['Leviathan', 'Skywhale', 'Cloudwhale', 'Sky Leviathan', 'Aerowhale'],
  jelly: ['Driftbell', 'Lanternjelly', 'Floater', 'Glowbell', 'Aerojelly'],
  fish: ['Finling', 'Darter', 'Shoaler', 'Glassfin', 'Reefswimmer'],
  serpent: ['Serpent', 'Coilback', 'Wyrm', 'Slitherer', 'Ribbonsnake'],
};

const B = BIOMES;
const HABITAT = {
  grazer: { [B.GRASSLAND]: 1, [B.SAVANNA]: 1, [B.FOREST]: 0.35, [B.TUNDRA]: 0.5, [B.TAIGA]: 0.3, [B.DESERT]: 0.25, [B.BEACH]: 0.2, [B.JUNGLE]: 0.25, [B.CRYSTAL]: 0.4, [B.TOXIC]: 0.3, [B.SNOW]: 0.15 },
  giant: { [B.GRASSLAND]: 0.8, [B.SAVANNA]: 1, [B.FOREST]: 0.6, [B.JUNGLE]: 0.8, [B.DESERT]: 0.2, [B.TUNDRA]: 0.2, [B.CRYSTAL]: 0.3, [B.TOXIC]: 0.4 },
  hexapod: { [B.DESERT]: 1, [B.SAVANNA]: 0.6, [B.ROCK]: 0.6, [B.JUNGLE]: 0.6, [B.TOXIC]: 1, [B.CRYSTAL]: 0.8, [B.FOREST]: 0.4, [B.VOLCANIC]: 0.6, [B.BEACH]: 0.5, [B.GRASSLAND]: 0.3 },
  hopper: { [B.GRASSLAND]: 0.8, [B.SAVANNA]: 1, [B.DESERT]: 0.7, [B.TUNDRA]: 0.5, [B.FOREST]: 0.4, [B.BEACH]: 0.3 },
  critter: { [B.GRASSLAND]: 1, [B.SAVANNA]: 0.8, [B.FOREST]: 1, [B.JUNGLE]: 1, [B.DESERT]: 0.6, [B.TUNDRA]: 0.6, [B.TAIGA]: 0.8, [B.BEACH]: 0.7, [B.ROCK]: 0.4, [B.TOXIC]: 0.5, [B.CRYSTAL]: 0.5, [B.SNOW]: 0.3 },
};

// HSL is authored in sRGB (three's setHSL defaults to the linear working space → washed-out colours)
const col = (h, s, l) => new THREE.Color().setHSL(((h % 1) + 1) % 1, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)), THREE.SRGBColorSpace);
const hexCol = (hex) => new THREE.Color(hex);
function hslOf(c) { const o = {}; c.getHSL(o, THREE.SRGBColorSpace); return o; }

/** Colors & surface params for a species. */
export function makeLook(rng, art, archetype, st, glowing) {
  const pal = art.palette;
  const exotic = st.exotic;
  const sat = st.sat;
  let back, belly, pattern, accent, keratin, eye, glow;
  const flora = (pal.flora || []).map(hexCol);
  const accentC = hexCol(pal.accent || '#ffffff');
  const wild = rng.next() < exotic * 0.85;
  if (!wild) {
    // naturalistic mammal / reptile palettes: browns, tans, rufous, greys, cream, charcoal
    const fam = rng.weighted([['tan', 3], ['rufous', 2], ['grey', 1.5], ['dark', 1], ['cream', 0.8], ['olive', 1]]);
    const H = { tan: [0.075, 0.11], rufous: [0.03, 0.065], grey: [0.05, 0.12], dark: [0.04, 0.1], cream: [0.09, 0.13], olive: [0.13, 0.2] }[fam];
    const h = rng.range(H[0], H[1]);
    const S = { tan: [0.45, 0.68], rufous: [0.55, 0.8], grey: [0.06, 0.18], dark: [0.15, 0.35], cream: [0.3, 0.5], olive: [0.25, 0.45] }[fam];
    const L = { tan: [0.26, 0.38], rufous: [0.2, 0.32], grey: [0.2, 0.34], dark: [0.07, 0.14], cream: [0.46, 0.58], olive: [0.18, 0.28] }[fam];
    const s = Math.min(0.9, rng.range(S[0], S[1]) * sat), l = rng.range(L[0], L[1]);
    back = col(h, s, l);
    belly = col(h + 0.01, s * 0.5, Math.min(0.72, l + rng.range(0.14, 0.3)));
    pattern = rng.chance(0.6) ? col(h - 0.01, s * 0.85, l * rng.range(0.25, 0.5)) : col(h + 0.01, s * 0.35, Math.min(0.8, l + rng.range(0.25, 0.4)));
    accent = accentC.clone().lerp(back, 0.5);
    keratin = col(rng.range(0.07, 0.11), rng.range(0.1, 0.35), rng.range(0.55, 0.8));
    eye = col(rng.range(0.05, 0.12), 0.6, rng.range(0.15, 0.35));
    glow = accentC.clone();
  } else {
    // stylized: build from the world's flora / accent colors
    const base = flora.length ? rng.pick(flora).clone() : accentC.clone();
    const hb = hslOf(base);
    back = col(hb.h + rng.range(-0.05, 0.05), Math.min(0.9, Math.max(0.35, hb.s) * rng.range(0.8, 1.1) * sat), rng.range(0.2, 0.4));
    const other = flora.length > 1 ? rng.pick(flora).clone() : accentC.clone();
    const ho = hslOf(other);
    belly = rng.chance(0.5) ? col(ho.h, ho.s * 0.55, rng.range(0.5, 0.7)) : col(hb.h + 0.08, hb.s * 0.4, rng.range(0.52, 0.7));
    pattern = rng.chance(0.5) ? col(ho.h, Math.min(0.9, ho.s * 1.1), rng.range(0.15, 0.4)) : col(hb.h + 0.5, hb.s * 0.7, rng.range(0.2, 0.55));
    accent = accentC.clone();
    keratin = rng.chance(0.5) ? col(ho.h, 0.35, rng.range(0.55, 0.8)) : col(0.1, 0.25, rng.range(0.65, 0.85));
    eye = col(rng.range(0, 1), rng.range(0.5, 0.9), rng.range(0.3, 0.55));
    glow = rng.chance(0.5) ? accentC.clone() : (flora.length ? rng.pick(flora).clone() : accentC.clone());
  }
  // ensure glow colors are saturated & bright (emissive)
  const hg = hslOf(glow);
  glow = col(hg.h, Math.max(0.65, hg.s), 0.55);
  const patternType = archetype === 'hexapod' ? rng.weighted([[4, 3], [2, 2], [1, 1], [6, 1], [0, 1]])
    : archetype === 'giant' ? rng.weighted([[1, 2], [7, 1.5], [3, 1.2], [4, 2], [0, 1.2], [2, 1]])
    : rng.weighted([[0, 1.3], [1, 1.2 + exotic], [2, 1.2], [3, 0.6 + exotic * 0.6], [4, 2], [5, 1.2], [7, 0.6]]);
  const scaleByType = { 0: 1, 1: rng.range(1.4, 2.6), 2: rng.range(2.2, 4.0), 3: rng.range(1.8, 3.2), 4: rng.range(1.5, 2.5), 5: rng.range(2.5, 4.0), 6: rng.range(1.5, 3), 7: rng.range(0.9, 1.8) };
  const sizeK = { giant: 0.35, critter: 3.5, hopper: 1.6, bird: 2.2, ray: 0.45, whale: 0.09, fish: 4, jelly: 1.2 }[archetype] ?? 1;
  const fur = archetype === 'grazer' || archetype === 'hopper' || archetype === 'critter' || archetype === 'bird';
  return {
    back, belly, pattern, accent, keratin, eye, glow,
    patternParams: [patternType, scaleByType[patternType] * sizeK, rng.range(0.1, 0.45), patternType ? rng.range(0.55, 0.95) : 0],
    glowParams: [glowing ? rng.range(1.2, 2.6) : 0, rng.int(1, 4), rng.range(0.6, 2.2), rng.range(0.4, 1.0)],
    surf: [fur ? rng.range(0.72, 0.88) : rng.range(0.45, 0.7), fur ? rng.range(0.55, 0.9) : rng.range(0.1, 0.35), fur ? rng.range(0.8, 1.2) : rng.range(0.9, 1.6), fur ? rng.range(0.6, 1.3) : rng.range(0.1, 0.4)],
    extra: [rng.chance(0.5) ? rng.range(0.4, 0.95) : 0, archetype === 'hexapod' ? rng.range(0.3, 0.9) : 0, rng.range(0.6, 1.1), rng.range(0.7, 1.2)],
  };
}

function speciesName(rng, archetype) {
  const w = word(rng, 2, 3);
  return `${w} ${rng.pick(NOUNS[archetype] || ['Creature'])}`;
}

/** Build the fauna roster of a body. Returns [] for lifeless bodies. */
export function makeRoster(body) {
  const F = body.life?.fauna ?? 0;
  if (F <= 0.01 || body.isGas) return [];
  const art = body.art || {};
  const st = STYLE[art.key] || { exotic: 0.4, glow: 0.3, sat: 1 };
  const rng = new RNG(hashCombine(body.seed, 0xfa1a));
  const list = [];
  const add = (archetype, layer, extra = {}) => {
    const r = rng.fork(archetype + list.length);
    const glowing = r.next() < st.glow * (extra.glowBias ?? 1);
    const sp = {
      id: list.length, archetype, layer,
      name: speciesName(r, archetype),
      seed: hashCombine(body.seed, 0x5fec, list.length),
      glowing,
      temper: extra.temper ?? r.weighted([['skittish', 3], ['calm', 2], ['curious', 1]]),
      nocturnal: glowing && r.chance(0.35),
      ...extra,
    };
    if (['grazer', 'giant', 'hexapod', 'hopper', 'critter'].includes(archetype)) {
      sp.genome = leggedGenome(r, archetype, st);
      sp.habitat = HABITAT[archetype];
    } else {
      sp.genome = chainGenome(r, archetype, st);
      sp.chain = true;
    }
    sp.look = makeLook(r, art, archetype, st, glowing);
    list.push(sp);
    return sp;
  };
  const cold = body.type === 'arctic';
  // ground
  add('grazer', 'ground', { group: [5, 12], density: 1.0, temper: rng.weighted([['skittish', 3], ['calm', 2]]) });
  if (rng.chance(0.55 + F * 0.3)) add('grazer', 'ground', { group: [3, 8], density: 0.7 });
  if (rng.chance(0.45 + F * 0.4) && !cold) add('giant', 'ground', { group: [2, 5], density: 0.5, temper: 'calm' });
  if (rng.chance(0.35 + st.exotic * 0.5)) add('hexapod', 'ground', { group: [2, 6], density: 0.55, temper: rng.weighted([['calm', 2], ['curious', 2], ['skittish', 1]]) });
  if (rng.chance(0.4 + F * 0.3)) add('hopper', 'ground', { group: [3, 7], density: 0.5, temper: 'skittish' });
  add('critter', 'ground', { group: [1, 3], density: 0.8, temper: 'skittish' });
  // air / sky / water
  const atmo = body.atmosphere?.present !== false;
  if (atmo) {
    add('bird', 'air', { group: [9, 22], density: 1.0, temper: 'skittish' });
    if (rng.chance(0.35 + st.exotic * 0.3)) add('bird', 'air', { group: [4, 9], density: 0.6, temper: 'skittish' });
    if (rng.chance(0.2 + st.exotic * 0.55)) add('ray', 'air', { group: [3, 7], density: 0.5, temper: 'calm', glowBias: 1.4 });
    if (st.exotic >= 0.7 || rng.chance(0.18 + F * 0.15)) add('whale', 'sky', { group: [1, 3], density: 0.6, temper: 'calm', glowBias: 1.2 });
    if (rng.chance(0.15 + st.glow * 0.7)) add('jelly', 'float', { group: [6, 14], density: 0.5, temper: 'calm', glowBias: 99 });
  }
  if (body.ocean?.present && (body.ocean.liquid ?? 'water') === 'water') add('fish', 'water', { group: [14, 30], density: 1, temper: 'skittish', glowBias: 0.6 });
  return list;
}

export const STYLES = STYLE;
