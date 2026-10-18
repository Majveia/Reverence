// Procedural names. Deterministic from a seed. Aim: evocative, pronounceable, varied.
import { RNG } from '../core/rng.js';

const ONSETS = ['', 'b', 'br', 'c', 'ch', 'd', 'dr', 'f', 'g', 'gl', 'h', 'j', 'k', 'kr', 'l', 'm', 'n', 'p', 'pr', 'qu', 'r', 's', 'sh', 'st', 't', 'th', 'tr', 'v', 'vr', 'w', 'x', 'y', 'z', 'zh', 'sol', 'el', 'ar', 'ae'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ai', 'au', 'ea', 'ei', 'ia', 'io', 'ou', 'y', 'aa', 'ee'];
const CODAS = ['', '', '', 'n', 'r', 's', 'th', 'l', 'x', 'm', 'nd', 'rn', 'st', 'sh', 'k', 'ph', 'ra', 'ris', 'nia', 'lon', 'vel'];
const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Sigma', 'Tau', 'Omega'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const GALAXY_WORDS = ['Veil', 'Crown', 'Loom', 'Wheel', 'Choir', 'Lantern', 'Spindle', 'Reliquary', 'Tide', 'Garden', 'Cathedral', 'Ember', 'Orrery', 'Hymn', 'Aurora', 'Cradle'];
const CIV_WORDS = ['Concord', 'Covenant', 'Chorus', 'Hegemony', 'Commune', 'Dominion', 'Lineage', 'Assembly', 'Collective', 'Remnant', 'Synod', 'Guild', 'Hearth', 'Diaspora'];

export function word(rng, minSyl = 2, maxSyl = 3) {
  const n = rng.int(minSyl, maxSyl);
  let s = '';
  for (let i = 0; i < n; i++) {
    s += rng.pick(ONSETS) + rng.pick(VOWELS);
    if (i === n - 1 || rng.chance(0.25)) s += rng.pick(CODAS);
  }
  s = s.replace(/(.)\1\1+/g, '$1$1');
  if (s.length > 11) s = s.slice(0, 11);
  if (s.length < 3) s += rng.pick(VOWELS) + rng.pick(['n', 'r', 's', 'th']);
  return s[0].toUpperCase() + s.slice(1);
}

export function galaxyName(seed) {
  const r = new RNG(seed ^ 0x6a1);
  const style = r.int(0, 3);
  if (style === 0) return `The ${r.pick(GALAXY_WORDS)} of ${word(r, 2, 3)}`;
  if (style === 1) return `${word(r, 2, 3)} ${r.pick(GALAXY_WORDS)}`;
  if (style === 2) return `${word(r)} Nebular`;
  return `${word(r, 2, 2)}-${r.int(100, 9999)}`;
}

export function starName(seed) {
  const r = new RNG(seed ^ 0x57a);
  const style = r.int(0, 4);
  if (style === 0) return `${r.pick(GREEK)} ${word(r, 2, 3)}`;
  if (style === 1) return `${word(r, 2, 3)}`;
  if (style === 2) return `${word(r, 1, 2)} ${r.int(2, 999)}`;
  if (style === 3) return `${word(r, 2, 2)}'${word(r, 1, 1).toLowerCase()}`;
  return `${word(r, 2, 3)} Prime`;
}

export function planetName(starNameStr, index, seed) {
  const r = new RNG(seed ^ 0x91a);
  if (r.chance(0.45)) return `${starNameStr.split(' ')[0]} ${ROMAN[index] || index + 1}`;
  return word(r, 2, 3);
}

export function moonName(planetNameStr, index, seed) {
  const r = new RNG(seed ^ 0x3001);
  if (r.chance(0.5)) return `${planetNameStr} ${String.fromCharCode(97 + index)}`;
  return word(r, 2, 2);
}

export function civName(seed) {
  const r = new RNG(seed ^ 0xc1f);
  return r.chance(0.5) ? `The ${word(r, 2, 3)} ${r.pick(CIV_WORDS)}` : `${r.pick(CIV_WORDS)} of ${word(r, 2, 3)}`;
}

export function placeName(seed) {
  const r = new RNG(seed ^ 0x9a9);
  const w = word(r, 2, 3);
  const suffix = r.pick(['', '', '', ' Hollow', ' Reach', ' Spire', ' Crossing', ' Terrace', ' Harbor', ' Sanctum', ' Rest', ' Falls', ' Gate', ' Vale']);
  return w + suffix;
}
