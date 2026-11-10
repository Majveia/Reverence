// Procedural naming — soft, pronounceable, a little mythic.
import { rng } from '../rng.js';

const ONSETS = ['', '', 'b', 'c', 'd', 'f', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z', 'th', 'sh', 'ch', 'br', 'dr', 'kr', 'tr', 'vr', 'el', 'al', 'or', 'ys', 'ae'];
const NUCLEI = ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'o', 'ae', 'ia', 'io', 'ei', 'ou', 'y', 'ea', 'ua'];
const CODAS = ['', '', '', 'n', 'r', 's', 'l', 'm', 'th', 'x', 'sh', 'nd', 'rn', 'ss', 'ph'];
const SUFFIX = ['', '', '', 'a', 'is', 'on', 'ar', 'e', 'os', 'ia', 'el', 'une', 'ara', 'ine', 'ys'];
const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Sigma', 'Tau', 'Omega'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function makeName(seed, { syllables } = {}) {
  const r = rng(seed);
  const n = syllables || r.weighted([2, 3, 4], [5, 4, 1]);
  let s = '';
  for (let i = 0; i < n; i++) s += r.pick(ONSETS) + r.pick(NUCLEI) + (i === n - 1 ? r.pick(CODAS) : (r.chance(0.25) ? r.pick(CODAS) : ''));
  s = s.replace(/([aeiouy])\1+/g, '$1').replace(/(.)\1\1+/g, '$1$1');
  if (r.chance(0.35)) s += r.pick(SUFFIX);
  if (s.length < 3) s += r.pick(['ra', 'on', 'is']);
  return cap(s.slice(0, 11));
}

export function starName(seed) {
  const r = rng(seed + 7);
  const base = makeName(seed);
  const k = r();
  if (k < 0.55) return base;
  if (k < 0.8) return `${r.pick(GREEK)} ${base}`;
  return `${base}-${r.int(2, 899)}`;
}

export function galaxyName(seed) {
  const r = rng(seed + 3);
  const k = r();
  if (k < 0.5) return makeName(seed, { syllables: r.int(2, 3) });
  if (k < 0.75) return `${makeName(seed, { syllables: 2 })} ${r.pick(['Spiral', 'Whirl', 'Veil', 'Crown', 'Lantern', 'Wheel', 'Garden', 'Drift', 'Reach'])}`;
  return `${r.pick(['RV', 'NGX', 'MJ', 'UC'])} ${r.int(100, 9999)}`;
}

export const roman = (i) => ROMAN[i] || String(i + 1);

export function placeName(seed) {
  const r = rng(seed + 11);
  const base = makeName(seed, { syllables: r.int(2, 3) });
  const k = r();
  if (k < 0.55) return base;
  if (k < 0.8) return `${base} ${r.pick(['Reach', 'Hollow', 'Rest', 'Gate', 'Hearth', 'Spire', 'Crossing', 'Garden', 'Vigil', 'Harbor', 'Terrace'])}`;
  return `${r.pick(['Port', 'Fort', 'New', 'Old', 'High', 'Saint'])} ${base}`;
}
