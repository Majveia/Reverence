// Music theory for the generative composer (AUDIO track).
// Modes, diatonic chord construction by stacked thirds, colour extensions, functional / modal
// progression graphs (weighted Markov), smooth voice leading, motif development.

export const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],   // harmonic minor
  hijaz: [0, 1, 4, 5, 7, 8, 10],      // phrygian dominant (maqam hijaz on the tonic)
  lydianDom: [0, 2, 4, 6, 7, 9, 10],  // acoustic scale — Moebius wonder
  wholetone: [0, 2, 4, 6, 8, 10],
  pentaMaj: [0, 2, 4, 7, 9],
  pentaMin: [0, 3, 5, 7, 10],
  in: [0, 1, 5, 7, 8],                 // Japanese In scale (koto, eerie)
  yo: [0, 2, 5, 7, 9],                 // Japanese Yo scale (bright folk)
};

/** Relative darkness of each mode (used to shift toward darker modes at night / danger). */
export const BRIGHTNESS = { lydian: 3, lydianDom: 2.5, ionian: 2, mixolydian: 1, yo: 1.5, pentaMaj: 2, dorian: 0, aeolian: -1, pentaMin: -0.5, harmonic: -1.5, phrygian: -2, hijaz: -2, in: -2.5, wholetone: 0.5 };

export const pcName = (pc) => ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][((pc % 12) + 12) % 12];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

export class Harmony {
  constructor(tonic = 50, mode = 'ionian') { this.set(tonic, mode); }
  set(tonic, mode) { this.tonic = tonic; this.mode = MODES[mode] ? mode : 'ionian'; this.scale = MODES[this.mode]; return this; }
  get size() { return this.scale.length; }
  /** Pitch (midi) of scale degree d (any integer, wraps octaves) relative to tonic. */
  deg(d) {
    const n = this.size; const o = Math.floor(d / n); const i = ((d % n) + n) % n;
    return this.tonic + this.scale[i] + 12 * o;
  }
  /** Nearest scale degree index for a midi pitch (returns fractional-free degree). */
  degreeOf(midi) {
    const n = this.size; const rel = midi - this.tonic; const o = Math.floor(rel / 12); const pc = ((rel % 12) + 12) % 12;
    let best = 0, bd = 99; for (let i = 0; i < n; i++) { const d = Math.abs(this.scale[i] - pc); if (d < bd) { bd = d; best = i; } }
    return best + o * n;
  }
  /** Snap a midi note into the scale. */
  snap(midi) { return this.deg(this.degreeOf(midi)); }
  /**
   * Chord on scale degree `root` as midi pitches (root position, around tonic octave).
   * ext: 'triad'|'7'|'9'|'sus2'|'sus4'|'add9'|'6'|'quartal'|'cluster'|'power'
   */
  chord(root, ext = 'triad') {
    const d = (k) => this.deg(root + k);
    const n = this.size;
    if (n < 7) { // pentatonic / hexatonic: stack every other scale tone
      const base = [d(0), d(2), d(4)];
      if (ext === '7' || ext === '9') base.push(d(6));
      return base;
    }
    switch (ext) {
      case '7': return [d(0), d(2), d(4), d(6)];
      case '9': return [d(0), d(2), d(4), d(6), d(8)];
      case 'sus2': return [d(0), d(1), d(4)];
      case 'sus4': return [d(0), d(3), d(4)];
      case 'add9': return [d(0), d(2), d(4), d(8)];
      case '6': return [d(0), d(2), d(4), d(5)];
      case 'quartal': return [d(0), d(3), d(6), d(9)];
      case 'cluster': return [d(0), d(1), d(2), d(4)];
      case 'power': return [d(0), d(4), d(7)];
      default: return [d(0), d(2), d(4)];
    }
  }
  label(root, ext) {
    const n = this.size;
    const i = ((root % n) + n) % n;
    const third = (this.deg(root + 2) - this.deg(root) + 12) % 12;
    const fifth = (this.deg(root + 4) - this.deg(root) + 12) % 12;
    let r = ROMAN[i] || String(i + 1);
    if (n >= 7 && third === 3) r = r.toLowerCase();
    if (n >= 7 && fifth === 6) r += '°';
    return `${pcName(this.deg(root))} ${r}${ext && ext !== 'triad' ? ext : ''}`;
  }
}

// ------------------------------------------------------------------ progression graphs
// Weighted Markov transitions between scale degrees (0-based). Each style picks one.
export const PROGRESSIONS = {
  // functional major (Ghibli / BotW / Bierstadt): I IV V vi ii iii
  tonal: { 0: [[3, 3], [4, 2], [5, 2.5], [1, 1.2], [2, 0.6]], 1: [[4, 3], [3, 1], [6, 0.3]], 2: [[5, 2], [3, 2]], 3: [[0, 2.2], [4, 2], [1, 1.2], [5, 0.8]], 4: [[0, 3], [5, 1.8], [3, 0.8]], 5: [[3, 2.5], [1, 2], [4, 1], [2, 0.5]], 6: [[0, 2], [2, 1]] },
  // lydian float (Roger Dean / cosmic): I II vii iii V — the raised 4th shimmer
  lydian: { 0: [[1, 3], [4, 1.5], [6, 1], [2, 1]], 1: [[0, 3], [4, 1], [2, 1]], 2: [[1, 1.5], [5, 2], [0, 1]], 4: [[0, 2], [1, 1.5], [5, 1]], 5: [[1, 2], [4, 1.5], [0, 1]], 6: [[0, 2], [2, 1]] },
  // modal minor (Stålenhag, Friedrich, Nausicaä): i VI III VII iv v
  aeolian: { 0: [[5, 3], [3, 2], [6, 2], [2, 1]], 2: [[6, 2], [5, 1.5], [3, 1]], 3: [[0, 2], [6, 1.5], [4, 1], [5, 1]], 4: [[0, 2], [5, 1.5]], 5: [[2, 2], [6, 2.5], [3, 1.5], [0, 1]], 6: [[0, 3], [2, 1.5], [5, 1]] },
  // dorian (Bebop groove, Tarkovsky): i IV ii v VII
  dorian: { 0: [[3, 3], [6, 1.5], [1, 1.5], [4, 1]], 1: [[4, 2], [0, 1.5]], 2: [[3, 2], [1, 1]], 3: [[0, 3], [6, 1], [4, 1]], 4: [[0, 2], [3, 1]], 6: [[0, 2], [3, 2]] },
  // mixolydian (Outer Wilds campfire, Rick & Morty bounce): I bVII IV v
  mixolydian: { 0: [[6, 3], [3, 2.5], [4, 1], [5, 0.8]], 3: [[0, 3], [6, 1]], 4: [[0, 2], [3, 1.5]], 5: [[3, 2], [6, 1]], 6: [[3, 2.5], [0, 2]] },
  // desert drone: stays home, leans on bII and bVII (hijaz / phrygian)
  drone: { 0: [[0, 2], [1, 2.5], [6, 2], [3, 1]], 1: [[0, 4], [6, 1]], 3: [[1, 1.5], [0, 2]], 6: [[0, 3], [1, 1]] },
  // jazz: ii-V-I chains, iii-vi turnarounds (use with '7'/'9' chords)
  jazz: { 0: [[5, 2], [1, 2.5], [3, 1.5], [2, 1]], 1: [[4, 5], [6, 0.5]], 2: [[5, 3], [1, 1]], 3: [[4, 1.5], [1, 1.5], [0, 1], [6, 0.8]], 4: [[0, 4], [5, 1.5], [2, 0.6]], 5: [[1, 4], [3, 1]], 6: [[2, 2], [0, 1]] },
  // planing / non-functional (eerie, Kubrick): any step, mostly by 2nds and 3rds
  planing: { 0: [[1, 1], [2, 1], [5, 1], [6, 1], [4, 0.5]], 1: [[0, 1], [3, 1], [6, 1]], 2: [[0, 1], [4, 1], [5, 1]], 3: [[1, 1], [5, 1], [0, 1]], 4: [[2, 1], [6, 1], [0, 1]], 5: [[3, 1], [0, 1], [2, 1]], 6: [[4, 1], [1, 1], [0, 1]] },
};

export function nextDegree(graph, cur, r, size = 7) {
  const opts = graph[cur] || graph[0];
  let d = r.weighted(opts);
  if (d >= size) d = d % size;
  return d;
}

// ------------------------------------------------------------------ voice leading
/**
 * Choose a voicing of `pcsMidi` (chord pitches, any octave) with `n` voices inside [lo, hi] that
 * minimises total motion from `prev` (array of midi, same length), avoids voice crossings,
 * keeps spacing open at the bottom (no thirds below ~C3) and doubles the root rather than the third.
 */
export function voiceLead(prev, chord, n, lo, hi, r) {
  const pcs = [...new Set(chord.map((m) => ((m % 12) + 12) % 12))];
  const rootPc = ((chord[0] % 12) + 12) % 12;
  const cands = [];
  for (let m = lo; m <= hi; m++) if (pcs.includes(((m % 12) + 12) % 12)) cands.push(m);
  if (!cands.length) return prev?.slice() || [];
  if (!prev || prev.length !== n) {
    // initial: spread evenly in range
    const out = []; for (let i = 0; i < n; i++) { const tgt = lo + (hi - lo) * (i + 0.5) / n; out.push(cands.reduce((a, b) => (Math.abs(b - tgt) < Math.abs(a - tgt) ? b : a))); }
    return out.sort((a, b) => a - b);
  }
  // greedy + 2-pass refinement: each voice moves to nearest candidate, then fix coverage
  const out = prev.map((p) => cands.reduce((a, b) => (Math.abs(b - p) < Math.abs(a - p) ? b : a)));
  // ensure every chord tone (up to n) is present: replace the most-doubled voice nearest the missing pc
  for (let pass = 0; pass < 3; pass++) {
    const have = out.map((m) => ((m % 12) + 12) % 12);
    const missing = pcs.filter((pc) => !have.includes(pc)).slice(0, Math.max(0, n - 1));
    if (!missing.length) break;
    for (const pc of missing) {
      const counts = {}; for (const h of out.map((m) => ((m % 12) + 12) % 12)) counts[h] = (counts[h] || 0) + 1;
      let best = -1, bestCost = 1e9, bestM = 0;
      for (let i = 0; i < n; i++) {
        const h = ((out[i] % 12) + 12) % 12;
        if (counts[h] < 2) continue;
        for (let m = lo; m <= hi; m++) if (((m % 12) + 12) % 12 === pc) { const c = Math.abs(m - prev[i]) + (h === rootPc ? 1.5 : 0); if (c < bestCost) { bestCost = c; best = i; bestM = m; } }
      }
      if (best >= 0) out[best] = bestM;
    }
  }
  out.sort((a, b) => a - b);
  // open bottom spacing: lowest interval >= 5 semitones below midi 52
  if (out.length > 1 && out[0] < 52 && out[1] - out[0] < 5 && out[0] + 12 <= hi) { out[0] += 12; out.sort((a, b) => a - b); }
  // no unisons
  for (let i = 1; i < out.length; i++) if (out[i] === out[i - 1]) { const up = cands.find((c) => c > out[i]); if (up !== undefined && up <= hi) out[i] = up; }
  return out.sort((a, b) => a - b);
}

// ------------------------------------------------------------------ motifs
/**
 * A motif = rhythm (onsets/durations in beats within one bar) + contour (scale steps).
 * Development: repeat, sequence (transpose to fit chord), invert, augment/diminish, truncate, answer.
 */
export function makeMotif(r, beats = 4, density = 0.5, feel = 'straight') {
  const grid = feel === 'triplet' ? 1 / 3 : 0.5;
  const rh = [];
  let t = r.chance(0.3) ? grid : 0;
  while (t < beats - 0.01) {
    const long = r.chance(0.45 - density * 0.3);
    let d = long ? r.pick([1, 1.5, 2]) : r.pick([grid, grid, 1]);
    if (t + d > beats) d = beats - t;
    if (r.chance(0.85 - (1 - density) * 0.35)) rh.push([t, d]);
    t += d;
  }
  if (!rh.length) rh.push([0, beats * 0.5]);
  // contour: mostly steps, occasional leaps followed by opposite step (melodic gravity)
  const steps = [0];
  let prevLeap = 0;
  for (let i = 1; i < rh.length; i++) {
    let s;
    if (prevLeap) { s = -Math.sign(prevLeap) * r.pick([1, 1, 2]); prevLeap = 0; }
    else if (r.chance(0.25)) { s = r.pick([-4, -3, 3, 4, 5]); prevLeap = s; }
    else s = r.pick([-1, -1, 1, 1, 2, -2, 0]);
    steps.push(steps[i - 1] + s);
  }
  return { rh, steps };
}

export function varyMotif(m, r, kind) {
  const k = kind || r.pick(['repeat', 'sequence', 'invert', 'rhythm', 'truncate', 'ornament']);
  const rh = m.rh.map((x) => x.slice()); let steps = m.steps.slice();
  switch (k) {
    case 'invert': steps = steps.map((s) => -s); break;
    case 'sequence': { const o = r.pick([-2, -1, 1, 2, 3]); steps = steps.map((s) => s + o); break; }
    case 'rhythm': for (const x of rh) if (r.chance(0.3)) x[1] = Math.max(0.5, x[1] * r.pick([0.5, 2])); break;
    case 'truncate': { const n = Math.max(1, Math.ceil(rh.length * 0.6)); rh.length = n; steps.length = n; rh[n - 1][1] = Math.max(rh[n - 1][1], 1.5); break; }
    case 'ornament': { const i = r.int(0, rh.length - 1); if (rh[i][1] >= 1) { const [t, d] = rh[i]; rh.splice(i, 1, [t, 0.5], [t + 0.5, d - 0.5]); steps.splice(i + 1, 0, steps[i] + r.pick([1, -1])); } break; }
    default: break;
  }
  return { rh, steps, kind: k };
}
