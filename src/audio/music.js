// Generative Composer (AUDIO track).
// Bar-by-bar look-ahead scheduling on the AudioContext clock (works identically on an OfflineAudioContext).
//  * Harmony: mode + tonic per world (seeded), Markov progressions per style, colour extensions,
//    smooth voice leading (PadBank voices glide between voicings), modulations every few sections
//    (relative modes, 4ths, chromatic mediants), darker modes at night / in danger.
//  * Form: sections of 4/8 bars with an energy-driven arrangement (layers join/leave), resting "breath"
//    sections (BotW-style silence), intro bars after every style change, cadences at section ends.
//  * Melody: motif development (repeat / sequence / invert / rhythm / truncate / ornament) in 4-bar
//    phrases a-a'-b-cadence, chord tones on strong beats, melodic gravity, call-and-response counter lines.
//  * Performance: humanized timing (σ ≈ 8 ms), swing, phrase-arc dynamics, accents, grace notes.
import { rng, hashStr, clamp } from './dsp.js';
import { Harmony, PROGRESSIONS, BRIGHTNESS, nextDegree, voiceLead, makeMotif, varyMotif, pcName } from './theory.js';
import { Strip, PadBank, MonoVoice, pluck, hit, grain } from './instruments.js';

const LOOKAHEAD = 1.2;
const DIM_OK = new Set(['jazz', 'planing']);

export class Composer {
  constructor(host) {
    this.host = host; this.ctx = host.ctx; this.mix = host.mix;
    this.layers = []; this.style = null; this.h = new Harmony(48, 'ionian');
    this.r = rng(1); this.energy = 0.3; this.night = 0; this.danger = 0; this.growth = 0;
    this.bar = 0; this.nextBar = 0; this.section = null; this.sectionCount = 0;
    this.chord = null; this.queue = []; this.chordBarsLeft = 0; this.chordChanged = false;
    this.history = []; this.gain = 1;
  }

  get beat() { return 60 / this.bpm; }
  get barDur() { return this.meter * this.beat; }

  // ------------------------------------------------------------------ style
  setStyle(style, seed = 1, t = this.ctx.currentTime) {
    for (const L of this.layers) this._dropLayer(L, t);
    this.layers = [];
    this.style = style;
    const r = this.r = rng((seed >>> 0) ^ hashStr(style.key + ':' + (style.art || '')));
    this.baseBpm = r.range(style.bpm[0], style.bpm[1]);
    this.meter = Array.isArray(style.meter) ? r.weighted(style.meter) : style.meter;
    this.swing = style.swing ?? 0.5;
    this.prog = PROGRESSIONS[style.prog] || PROGRESSIONS.tonal;
    this.homeTonic = r.int(style.tonic[0], style.tonic[1]);
    this._pickMode(true);
    this.bpm = this.baseBpm * (1 - 0.08 * this.night);
    const m = this.mix;
    m.setReverb(style.reverb, t); m.setReverbLevel(style.revLevel ?? 0.6, t);
    const e = style.echo || { beats: 0.75, fb: 0.3, mix: 0.1 };
    m.setEcho(this.beat * e.beats, e.fb, e.mix, t);
    m.setInsert(style.insert || {}, t);
    m.musicTrim.gain.setTargetAtTime(style.trim ?? 1, t, 0.8);
    const q = this.host.quality;
    for (const def of style.layers) {
      const L = { def, on: false, voicing: null, motif: null, anchor: null, last: null };
      L.strip = new Strip(this.ctx, m, { gain: 0, pan: def.pan ?? 0, rev: def.rev ?? 0.3, echo: def.echo ?? 0, lp: def.lp || 0 });
      if (def.type === 'pad' || def.type === 'drone') {
        const nv = def.type === 'drone' ? def.notes.length : Math.max(2, Math.round(def.voices * (q < 0.5 ? 0.67 : 1)));
        L.bank = new PadBank(this.ctx, L.strip, def.timbre, nv, t);
      }
      if (def.mono) L.mono = new MonoVoice(this.ctx, L.strip, def.mono, t);
      this.layers.push(L);
    }
    this.bar = 0; this.section = null; this.sectionCount = 0; this.queue = []; this.chord = null; this.chordBarsLeft = 0;
    this.nextBar = t + 0.25;
  }

  _pickMode(first = false) {
    const st = this.style, r = this.r;
    let list = (this.night > 0.5 ? st.modes.night : st.modes.day) || st.modes.day;
    if (this.danger > 0.5) list = [...list].sort((a, b) => (BRIGHTNESS[a] ?? 0) - (BRIGHTNESS[b] ?? 0)).slice(0, 1);
    const mode = r.pick(list);
    let tonic = first ? this.homeTonic : this.h.tonic;
    if (!first && r.chance(st.modulate ?? 0.2)) {
      const moves = st.mediant ? [5, -2, 4, -4, 3, -3] : [5, -5, 2, -2, 7, 0];
      tonic += r.pick(moves);
      while (tonic > st.tonic[1] + 2) tonic -= 12; while (tonic < st.tonic[0] - 2) tonic += 12;
    }
    this.h.set(tonic, mode);
    this.modeName = mode;
  }

  _dropLayer(L, t) {
    L.strip.fade(t, 0, 0.8);
    L.bank?.stop(t + 1.5); L.mono?.stop(t + 1.5);
    const s = L.strip; this.host.later(() => s.dispose(), 9000);
  }

  stop(t = this.ctx.currentTime) { for (const L of this.layers) this._dropLayer(L, t); this.layers = []; this.style = null; }

  // ------------------------------------------------------------------ scheduling
  tick(now) {
    if (!this.style) return;
    if (this.nextBar < now - 0.5) this.nextBar = now + 0.1; // tab was suspended: skip ahead
    let guard = 0;
    while (this.nextBar < now + LOOKAHEAD && guard++ < 4) {
      try { this._playBar(this.nextBar); } catch (e) { console.warn('[audio] bar failed', e); }
      this.nextBar += this.barDur;
    }
  }

  _time(t0, b) { // beat position → time (with swing on 8th off-beats)
    const bi = Math.floor(b + 1e-6), fr = b - bi;
    let f = fr;
    if (this.swing !== 0.5 && Math.abs(fr - 0.5) < 1e-3) f = this.swing;
    return t0 + (bi + f) * this.beat;
  }
  _hz(t, s = 0.008) { return t + this.r.gauss() * s; }

  // ------------------------------------------------------------------ form
  _newSection(t0) {
    const st = this.style, r = this.r, E = this.energy;
    this.sectionCount++;
    if (this.sectionCount > 1 && this.sectionCount % 3 === 0) this._pickMode(false);
    else if ((this.night > 0.5) !== this._wasNight || (this.danger > 0.5) !== this._wasDanger) this._pickMode(false);
    this._wasNight = this.night > 0.5; this._wasDanger = this.danger > 0.5;
    this.bpm = this.baseBpm * (1 - 0.08 * this.night) * (1 + 0.06 * this.danger) * (0.97 + r() * 0.06);
    let kind = 'play', bars = r.weighted([[4, 2], [8, 3]]);
    if (this.sectionCount === 1) { kind = 'intro'; bars = st.bpm[1] > 70 ? 2 : 1; }
    else if (this.sectionCount > 2 && this.section?.kind === 'play' && r.chance((st.breath ?? 0.1) * (1.25 - E))) { kind = 'breath'; bars = r.weighted([[1, 1], [2, 3], [4, 1]]); }
    const on = new Set();
    if (kind === 'intro' || kind === 'breath') {
      for (const L of this.layers) {
        const d = L.def, bed = d.type === 'pad' || d.type === 'drone' || d.type === 'grains';
        if (kind === 'intro') { if ((bed && !(d.minE > 0.3)) || (!(d.minE > 0.02) && d.type !== 'perc' && d.type !== 'melody')) on.add(L); }
        else if ((d.type === 'drone' || (d.type === 'pad' && !(d.minE > 0.05))) && r.chance(0.75)) on.add(L);
        else if (d.core && !this.layers.some((o) => o.def.type === 'pad' || o.def.type === 'drone') && d.type !== 'bass') on.add(L);
      }
    } else {
      // arrangement: energy decides HOW MANY layers play; importance (minE) + chance decide WHICH
      for (const L of this.layers) if (L.def.type === 'drone' || (L.def.core && (L.def.minE ?? 0) <= E + 0.1)) on.add(L);
      const elig = this.layers.filter((L) => !on.has(L) && (L.def.minE ?? 0) <= E + 0.12);
      if (!elig.length && !on.size) elig.push(...this.layers.filter((L) => !on.has(L)).slice(0, 1));
      const nCore = [...on].filter((L) => L.def.type !== 'drone').length;
      const k = Math.max(nCore ? 0 : 1, Math.min(elig.length, Math.round((nCore ? 0.3 : 1) + E * elig.length * 1.2 + r.range(-0.7, 0.7))));
      const ranked = elig.map((L) => [L, (L.def.minE ?? 0) + r.range(0, 0.3) + (1 - (L.def.prob ?? 1)) * r.range(0, 0.6) - (L.def.type === 'melody' && !L.def.answer ? 0.18 : 0)]).sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < k && i < ranked.length; i++) on.add(ranked[i][0]);
      // contrast: never repeat the exact same arrangement twice in a row
      const prev = this.layers.filter((L) => L.on && L.def.type !== 'drone').map((L) => L.def.id).sort().join();
      const cur = [...on].filter((L) => L.def.type !== 'drone').map((L) => L.def.id).sort().join();
      if (prev === cur && this.section?.kind === 'play' && elig.length > 1) {
        const pick = r.pick(elig.slice(Math.min(1, elig.length - 1)));
        if (on.has(pick) && on.size > 1) on.delete(pick); else on.add(pick);
      }
    }
    for (const L of this.layers) {
      const was = L.on; L.on = on.has(L);
      const lvl = L.def.level * (kind === 'breath' ? 0.55 : 1);
      if (L.on) L.strip.fade(t0, lvl, was ? 1.2 : (L.def.type === 'pad' || L.def.type === 'drone' ? 1.5 : 0.05));
      else if (was) { L.strip.fade(t0, 0, L.def.type === 'pad' ? 2 : 0.8); L.mono?.silence(t0); }
      if (L.def.type === 'melody') { L.motif = makeMotif(r, this.meter, clamp((L.def.density ?? 0.4) * (0.7 + 0.6 * E), 0.1, 0.95), r.chance(0.2) ? 'triplet' : 'straight'); L.motifB = null; }
      if (L.def.type === 'arp') { L.rate = r.int(L.def.rate[0], Math.round(L.def.rate[0] + (L.def.rate[1] - L.def.rate[0]) * clamp(E * 1.3, 0, 1))); L.pattern = r.pick(L.def.patterns); }
      if (L.def.type === 'perc') L.fill = r.chance(0.5);
    }
    this.section = { kind, bars, left: bars, idx: this.sectionCount, energy: E };
    if (this.log) this.log.push([+t0.toFixed(3), '§' + kind, bars, +E.toFixed(2), this.layers.filter((L) => L.on).map((L) => L.def.id).join(',')]);
  }

  _nextChord() {
    const st = this.style, r = this.r, n = this.h.size;
    const prev = this.queue.length ? this.queue[this.queue.length - 1] : this.chord;
    let deg = prev ? nextDegree(this.prog, prev.deg % n, r, n) : 0;
    let ext = r.weighted(st.exts);
    // avoid diminished triads outside jazz / planing unless a 7th makes them half-diminished colour
    for (let k = 0; k < 4 && !DIM_OK.has(st.prog); k++) {
      const fifth = (this.h.deg(deg + 4) - this.h.deg(deg) + 12) % 12;
      if (n >= 7 && fifth === 6) deg = nextDegree(this.prog, deg, r, n); else break;
    }
    if (n < 7 && deg >= n) deg %= n;
    const bars = r.weighted(st.chordBars);
    return { deg, ext, bars };
  }

  // ------------------------------------------------------------------ bar
  _playBar(t0) {
    if (!this.section || this.section.left <= 0) this._newSection(t0);
    const sec = this.section, r = this.r;
    const phraseBar = (sec.bars - sec.left) % 4;
    const lastBar = sec.left === 1;
    // chord
    this.chordChanged = false;
    if (this.chordBarsLeft <= 0 || !this.chord) {
      while (this.queue.length < 2) this.queue.push(this._nextChord());
      this.chord = this.queue.shift();
      // cadence: section ends home for tonal progressions
      if (lastBar && (this.style.prog === 'tonal' || this.style.prog === 'jazz') && r.chance(0.5)) this.chord = { deg: 0, ext: this.chord.ext, bars: 1 };
      if (sec.kind === 'intro' || (sec.kind === 'breath' && r.chance(0.5))) this.chord = { deg: 0, ext: r.weighted(this.style.exts), bars: 1 };
      this.chordBarsLeft = Math.min(this.chord.bars, sec.left);
      this.chordChanged = true;
      this.chordMidis = this.h.chord(this.chord.deg, this.chord.ext);
      this.history.push(this.h.label(this.chord.deg, this.chord.ext)); if (this.history.length > 8) this.history.shift();
    }
    const next = this.queue[0] || this.chord;
    this.nextChordMidis = this.h.chord(next.deg, next.ext);
    // phrase-arc dynamics
    const arc = 0.78 + 0.22 * Math.sin(Math.PI * (phraseBar + 0.5) / 4);
    const ctx = { t0, phraseBar, lastBar, arc, E: this.energy };
    for (const L of this.layers) {
      if (!L.on && !(L.def.type === 'pad' || L.def.type === 'drone')) continue;
      try { this['_' + L.def.type]?.(L, ctx); } catch (e) { console.warn('[audio] layer', L.def.id, e); }
    }
    this.chordBarsLeft--; sec.left--; this.bar++;
  }

  // ---- pads & drones
  _pad(L, c) {
    const d = L.def;
    if (!this.chordChanged && L.voicing) {
      if (L.bank.timbre === 'choir' && this.r.chance(0.25)) L.bank.vowel(c.t0, this.r.pick(d.vowels || ['a', 'o']), 1.5);
      return;
    }
    const n = L.bank.n;
    L.voicing = voiceLead(L.voicing, this.chordMidis, n, d.range[0], d.range[1], this.r);
    const bright = this.style.key === 'cosmic' ? 0.55 + 0.9 * this.growth : 0.75 + 0.4 * c.E - 0.25 * this.night;
    L.bank.setChord(c.t0, L.voicing, { glide: d.glide ?? 0.4, level: 0.8 + 0.2 * c.E, attack: d.attack ?? 1, bright });
    if (L.bank.timbre === 'choir' && d.vowels) L.bank.vowel(c.t0, this.r.pick(d.vowels), 2);
  }
  _drone(L, c) {
    const d = L.def;
    if (L.droneTonic !== this.h.tonic) {
      L.droneTonic = this.h.tonic;
      let base = this.h.tonic; while (base > 45) base -= 12;
      const notes = d.notes.map((n) => { let m = base + n; while (m < 33) m += 12; return m; });
      L.bank.setChord(c.t0, notes, { glide: 3, level: 1, attack: 3, bright: 1 });
    }
    if (d.sweep || this.style.key === 'cosmic') L.bank.bright(c.t0, (this.style.key === 'cosmic' ? 0.6 + 1.4 * this.growth : 0.7) + this.r.range(-0.2, 0.9), this.barDur * 0.4);
  }

  // ---- pools
  _pool(lo, hi, midis = this.chordMidis) {
    const pcs = new Set(midis.map((m) => ((m % 12) + 12) % 12)); const out = [];
    for (let m = lo; m <= hi; m++) if (pcs.has(((m % 12) + 12) % 12)) out.push(m);
    return out;
  }
  _scalePool(lo, hi) { const out = []; for (let m = lo; m <= hi; m++) if (this.h.snap(m) === m) out.push(m); return out; }

  // ---- arpeggios
  _arp(L, c) {
    const d = L.def, r = this.r, q = this.host.quality;
    const pool = this._pool(d.range[0], d.range[1]); if (!pool.length) return;
    const steps = this.meter * L.rate;
    const pat = L.pattern || 'up';
    const mid = Math.floor(pool.length * 0.35);
    let idx = L.idx ?? mid, dir = L.dir ?? 1;
    const sparse = d.sparse ?? 0.08;
    for (let s = 0; s < steps; s++) {
      const b = s / L.rate;
      const onBeat = s % L.rate === 0;
      let m;
      if (pat === 'travis') { // thumb alternates bass on beats, fingers pinch high chord tones on off-beats
        if (onBeat) { const low = pool.filter((x) => x < pool[0] + 12); m = low[(Math.floor(b) % 2) * Math.min(low.length - 1, 1 + (low.length > 2 ? 1 : 0))] ?? pool[0]; }
        else m = pool[Math.min(pool.length - 1, mid + 1 + ((s * 3) % Math.max(1, pool.length - mid - 1)))];
      } else if (pat === 'drone') { // oud: tonic tremolo with scale neighbours
        const sc = this._scalePool(d.range[0], d.range[1]);
        const home = sc.reduce((a, x) => (Math.abs(x - (this.h.tonic + 12)) < Math.abs(a - (this.h.tonic + 12)) ? x : a), sc[0]);
        const hi = sc.indexOf(home);
        m = onBeat || r.chance(0.5) ? home : sc[clamp(hi + r.pick([1, 2, -1, 3]), 0, sc.length - 1)];
      } else {
        if (pat === 'up') { idx++; if (idx >= pool.length || idx > mid + 6) idx = Math.max(0, mid - 2); }
        else if (pat === 'updown') { idx += dir; if (idx >= Math.min(pool.length - 1, mid + 6) || idx <= Math.max(0, mid - 3)) dir = -dir; }
        else if (pat === 'broken') { const cyc = [0, 2, 1, 3, 2, 4, 1, 3]; idx = mid - 1 + cyc[s % cyc.length]; }
        else { idx += r.pick([-2, -1, 1, 1, 2]); }
        idx = clamp(idx, 0, pool.length - 1);
        m = pool[idx];
      }
      if (!onBeat && r.chance(sparse)) continue;
      if (onBeat && s > 0 && r.chance(sparse * 0.5)) continue;
      const accent = onBeat ? (s === 0 ? 1 : 0.85) : 0.68;
      const vel = clamp(accent * c.arc * (0.75 + 0.25 * c.E) * r.range(0.85, 1.05), 0.05, 1);
      const tn = this._hz(this._time(c.t0, b)); this._log(L, tn, m, 0, vel);
      pluck(this.ctx, L.strip, d.inst, tn, m, vel, { pan: r.range(-0.45, 0.45), quality: q, bright: 0.8 + 0.3 * c.E });
    }
    L.idx = idx; L.dir = dir;
  }

  // ---- melody (motif development in 4-bar phrases)
  _melody(L, c) {
    const d = L.def, r = this.r;
    if (!L.motif) L.motif = makeMotif(r, this.meter, d.density ?? 0.4);
    const partner = this.layers.find((o) => o !== L && o.on && o.def.type === 'melody' && (d.answer ? !o.def.answer : o.def.answer));
    // call & response: the lead sings bars 0/2 (and holds into 1/3), the answer line replies in bars 1/3
    if (d.answer && partner && (c.phraseBar === 0 || c.phraseBar === 2)) { L.mono?.silence(c.t0); return; }
    const replying = !d.answer && partner && (c.phraseBar === 1 || c.phraseBar === 3);
    let m;
    switch (c.phraseBar) {
      case 0: m = L.motif; break;
      case 1: m = varyMotif(L.motif, r, r.pick(['repeat', 'sequence', 'sequence', 'ornament', 'rhythm'])); break;
      case 2: m = L.motifB || (L.motifB = r.chance(0.55) ? varyMotif(L.motif, r, r.pick(['invert', 'rhythm', 'sequence'])) : makeMotif(r, this.meter, d.density ?? 0.4)); break;
      default: m = varyMotif(L.motif, r, 'truncate');
    }
    if (c.lastBar && this.section.kind !== 'intro') m = varyMotif(m, r, 'truncate');
    if (replying) { m = { rh: [[0, this.meter * 0.75]], steps: [m.steps[0]] }; } // hold one long note under the reply
    const lo = d.range[0], hi = d.range[1], n = this.h.size;
    if (L.anchor == null || L.sectionSeen !== this.section.idx) { // new register per section (±a third)
      L.sectionSeen = this.section.idx;
      const mid = this.h.degreeOf(Math.round(lo + (hi - lo) * r.range(0.3, 0.55)));
      L.anchor = L.anchor == null ? mid : Math.round((L.anchor + mid) / 2) + r.pick([-2, -1, 0, 1, 2]);
      L.arc = r.pick([[0, 2, 4, 1], [0, 1, 3, 0], [2, 3, 1, 0], [0, 3, 2, -1], [1, 0, 2, 0]]); // phrase contour (degrees)
    }
    const base = L.anchor + (L.arc?.[c.phraseBar] ?? 0);
    const chordPcs = new Set(this.chordMidis.map((x) => ((x % 12) + 12) % 12));
    const notes = [];
    let prevMidi = null;
    for (let i = 0; i < m.rh.length; i++) {
      const [b, dur] = m.rh[i];
      let deg = base + m.steps[i];
      let midi = this.h.deg(deg);
      while (midi > hi) { midi -= 12; deg -= n; } while (midi < lo) { midi += 12; deg += n; }
      const strong = Math.abs(b - Math.round(b)) < 1e-3 && (Math.round(b) % 2 === 0 || dur >= 1);
      if (strong && !chordPcs.has(((midi % 12) + 12) % 12)) { // lean onto a chord tone, preferring the direction of motion
        const dir = prevMidi == null ? 1 : Math.sign(midi - prevMidi) || 1;
        for (const k of [dir, -dir, 2 * dir, -2 * dir]) { const mm = this.h.deg(deg + k); if (chordPcs.has(((mm % 12) + 12) % 12) && mm >= lo && mm <= hi) { midi = mm; break; } }
      }
      if (prevMidi != null && midi === prevMidi && r.chance(0.5)) { const mm = this.h.deg(this.h.degreeOf(midi) + r.pick([1, -1])); if (mm >= lo && mm <= hi) midi = mm; } // avoid static repetition
      if (prevMidi != null && Math.abs(midi - prevMidi) > 7) { // no wild leaps: fold the octave, else step toward it
        const f = midi + (midi > prevMidi ? -12 : 12);
        midi = Math.abs(f - prevMidi) <= 7 && f >= lo && f <= hi ? f : this.h.deg(this.h.degreeOf(prevMidi) + Math.sign(midi - prevMidi) * 2);
      }
      midi = Math.max(lo, Math.min(hi, midi));
      notes.push([b, dur, midi]); prevMidi = midi;
    }
    // cadence: last note of the phrase lands long on a stable chord tone (root or third preferred)
    if (c.phraseBar === 3 && notes.length && !replying) {
      const lastN = notes[notes.length - 1];
      const stable = this._pool(lo, hi, [this.chordMidis[0], this.chordMidis[1]]);
      const pool = stable.length ? stable : this._pool(lo, hi);
      if (pool.length) lastN[2] = pool.reduce((a, x) => (Math.abs(x - lastN[2]) < Math.abs(a - lastN[2]) ? x : a), pool[0]);
      lastN[1] = Math.max(lastN[1], this.meter - lastN[0]);
    }
    const legatoK = d.mono ? 0.98 : 1;
    for (let i = 0; i < notes.length; i++) {
      const [b, dur, midi] = notes[i];
      const t = this._hz(this._time(c.t0, b), d.mono ? 0.012 : 0.009);
      const accent = (Math.abs(b) < 1e-3 ? 1 : Math.abs(b - Math.round(b)) < 1e-3 ? 0.9 : 0.78);
      const vel = clamp(accent * c.arc * (0.7 + 0.3 * c.E) * r.range(0.88, 1.05), 0.1, 1);
      const durS = dur * this.beat;
      if (L.mono) {
        const nxt = notes[i + 1];
        const legato = nxt && Math.abs(nxt[0] - (b + dur)) < 0.02 && r.chance(0.8);
        if (d.ornament && durS > 0.6 && r.chance(0.45)) { // grace note from above (duduk / oud idiom)
          const g = this.h.deg(this.h.degreeOf(midi) + 1);
          L.mono.note(t - 0.07, g, 0.07, vel * 0.8, { legato: true, glide: 0.02 });
        }
        L.mono.note(t, midi, durS * legatoK, vel, { legato }); this._log(L, t, midi, durS, vel);
      } else this._log(L, t, midi, durS, vel), pluck(this.ctx, L.strip, d.inst, t, midi, vel, { pan: r.range(-0.15, 0.15), quality: this.host.quality, dur: d.inst === 'rhodes' || d.inst === 'vibes' ? durS : 0 });
    }
  }

  // ---- bass
  _bass(L, c) {
    const d = L.def, r = this.r, B = this.beat, t0 = c.t0;
    let root = this.chordMidis[0]; while (root > d.range[1]) root -= 12; while (root < d.range[0]) root += 12;
    const fifth = root + 7 <= d.range[1] + 2 ? root + 7 : root - 5;
    const vel = clamp(0.8 * c.arc * r.range(0.9, 1.05), 0.2, 1);
    const P = (b, m, v = vel, dur = 0) => this._log(L, this._time(t0, b), m, dur, v) || pluck(this.ctx, L.strip, d.inst, this._hz(this._time(t0, b), 0.006), m, v, { dur, quality: this.host.quality, bright: 0.8 });
    switch (d.style) {
      case 'walk': {
        let nr = this.nextChordMidis[0]; while (nr > root + 7) nr -= 12; while (nr < root - 7) nr += 12;
        const scale = this._scalePool(d.range[0], d.range[1] + 5);
        const tones = [root];
        let cur = root;
        for (let k = 1; k < this.meter; k++) {
          const remaining = this.meter - k;
          if (remaining === 1 && this.chordBarsLeft <= 1) { tones.push(nr + (r.chance(0.5) ? 1 : -1)); break; } // chromatic approach
          const target = nr + (cur < nr ? -2 : 2) * (remaining - 1);
          const cands = scale.filter((x) => Math.abs(x - cur) <= 4 && x !== cur);
          cur = cands.length ? cands.reduce((a, x) => (Math.abs(x - target) < Math.abs(a - target) ? x : a), cands[0]) : cur;
          if (k === 2 && r.chance(0.35)) { const c5 = this.chordMidis.map((x) => { let y = x; while (y > root + 12) y -= 12; while (y < root) y += 12; return y; })[2]; if (c5 != null && c5 !== tones[tones.length - 1]) cur = c5; }
          tones.push(cur);
        }
        tones.forEach((m, k) => P(k, m, vel * (k === 0 ? 1 : 0.85), B * 0.95));
        if (r.chance(0.15 * c.E)) P(this.meter - 1 + 0.5, tones[tones.length - 1] + (r.chance(0.5) ? 12 : 0), vel * 0.5, B * 0.3); // ghost skip
        break;
      }
      case 'rootFifth': P(0, root); if (this.meter === 4) P(2, fifth, vel * 0.85); else { P(1, fifth, vel * 0.6); P(2, fifth, vel * 0.6); } break;
      case 'long': if (this.chordChanged) P(0, root, vel, this.barDur * this.chordBarsLeft * 0.98); break;
      case 'pulse': for (let k = 0; k < this.meter * 2; k++) if (!(k % 2) || r.chance(0.8)) P(k / 2, k === this.meter * 2 - 1 && r.chance(0.3) ? root + 12 : root, vel * (k % 2 ? 0.6 : 0.85), B * 0.42); break;
      case 'bounce': {
        const pat = [0, null, 12, 0, null, 7, 12, 10];
        pat.forEach((iv, k) => { if (iv === null || k >= this.meter * 2) return; if (k && r.chance(0.12)) return; P(k / 2, root + iv, vel * (k % 2 ? 0.7 : 0.95), B * 0.35); });
        break;
      }
      default: P(0, root, vel); if (this.meter === 4 && c.E > 0.5 && r.chance(0.5)) P(2, r.chance(0.5) ? fifth : root, vel * 0.7);
    }
  }

  // ---- chord comping
  _comp(L, c) {
    const d = L.def, r = this.r;
    // rootless voicing for 4+ note chords (jazz), full triad otherwise
    const src = this.chordMidis.length >= 4 ? this.chordMidis.slice(1) : this.chordMidis;
    L.voicing = voiceLead(L.voicing, src, Math.min(4, src.length + (src.length < 4 ? 1 : 0)), d.range[0], d.range[1], r);
    const hitAt = (b, vel, dur, strum = 0, up = false) => {
      const notes = up ? [...L.voicing].reverse() : L.voicing;
      this._log(L, this._time(c.t0, b), L.voicing[L.voicing.length - 1], dur, vel);
      notes.forEach((m, i) => pluck(this.ctx, L.strip, d.inst, this._hz(this._time(c.t0, b)) + i * strum, m, vel * r.range(0.85, 1), { dur, quality: this.host.quality, pan: (i / notes.length - 0.5) * 0.4 }));
    };
    const B = this.beat;
    if (d.rhythm === 'charleston') {
      const v = 0.55 * c.arc;
      const variant = r.int(0, 3);
      if (variant === 0) { hitAt(0, v, B * 1.4); hitAt(1.5, v * 0.8, B * 0.4); }
      else if (variant === 1) { hitAt(0.5, v * 0.85, B * 0.9); hitAt(2.5, v * 0.8, B * 1.2); }
      else if (variant === 2) { hitAt(0, v, B * 2.8); if (r.chance(0.5)) hitAt(3.5, v * 0.7, B * 0.4); }
      else { hitAt(1.5, v * 0.85, B * 0.5); hitAt(3, v * 0.7, B * 0.9); }
    } else { // strum: D . D U . U D U
      const pat = this.meter === 3 ? [[0, 0], [1, 0], [1.5, 1], [2, 0], [2.5, 1]] : [[0, 0], [1, 0], [1.5, 1], [2.5, 1], [3, 0], [3.5, 1]];
      for (const [b, up] of pat) if (!(b % 1) || r.chance(0.75)) hitAt(b, (up ? 0.35 : 0.5) * c.arc, 0, 0.014, !!up);
    }
  }

  // ---- percussion kits
  _perc(L, c) {
    const r = this.r, S = L.strip, ctx = this.ctx, t0 = c.t0, M = this.meter, E = c.E;
    const H = (name, b, v, o = {}) => hit(ctx, S, name, this._hz(this._time(t0, b), 0.005), clamp(v * r.range(0.82, 1.05), 0.02, 1), o);
    const fill = c.lastBar && L.fill;
    switch (L.def.kit) {
      case 'brush':
        for (let k = 0; k < M; k++) {
          H(k % 2 ? 'brushTap' : 'brushSwish', k, k % 2 ? 0.45 : 0.5, { pan: -0.2 });
          H('ride', k, 0.3 + (k % 2 ? 0.08 : 0), { pan: 0.35, rate: 1 });
          if (k % 2 === 1) H('ride', k + 0.5, 0.2, { pan: 0.35 });
          if (k % 2 === 1) H('hat', k, 0.22, { pan: 0.25, lp: 7000 });
        }
        H('kickSoft', 0, 0.35); if (r.chance(0.4)) H('kickSoft', 2.5, 0.25);
        if (fill) for (let b = M - 1; b < M; b += 1 / 3) H('brushTap', b, 0.3 + (b - M + 1) * 0.4, { pan: r.range(-0.3, 0.3) });
        break;
      case 'desert': { // maqsum: D T . T D . T .
        const pat = [['dum', 0, 0.9], ['tek', 0.5, 0.6], ['tek', 1.5, 0.65], ['dum', 2, 0.8], ['tek', 3, 0.7]];
        for (const [n, b, v] of pat) if (b < M) H(n, b, v, { pan: n === 'dum' ? 0 : 0.2 });
        if (E > 0.45) for (let b = 0; b < M; b += 0.25) if (r.chance(0.7)) H('shaker', b, (b % 1 ? 0.18 : 0.26), { pan: -0.4 });
        if (E > 0.6) for (let b = 0.5; b < M; b += 1) if (r.chance(0.5)) H('ka', b + 0.25, 0.3, { pan: 0.35 });
        if (E > 0.7 && r.chance(0.5)) H('riq', 0, 0.35, { pan: -0.3 });
        if (fill) for (let b = M - 1; b < M; b += 0.25) H('tek', b, 0.4 + (b - M + 1) * 0.5, { pan: 0.2 });
        break;
      }
      case 'taiko':
        H('taiko', 0, 0.9);
        if (r.chance(0.5)) H('taiko', 1.5, 0.5, { rate: 1.12 });
        if (M > 2 && r.chance(0.6)) H('taiko', 2, 0.7, { rate: 0.94 });
        if (fill || r.chance(0.2)) for (let b = M - 1; b < M; b += 0.25) H('dum', b, 0.3 + (b - M + 1) * 0.6);
        break;
      case 'timpani':
        if (fill) for (let b = M - 2; b < M; b += 0.125) H('taiko', b, 0.12 + (b - M + 2) * 0.35, { rate: 1.7, lp: 1200 });
        else if (c.phraseBar === 0) H('taiko', 0, 0.6, { rate: 1.7, lp: 1500 });
        break;
      case 'soft':
        H('kickSoft', 0, 0.55); if (M === 4 && E > 0.85) H('kickSoft', 2, 0.4);
        for (let b = 0.5; b < M; b += 1) H('shaker', b, 0.3);
        if (M === 4) H('rim', 2, 0.18, { lp: 4000 });
        if (fill) H('rim', M - 0.5, 0.25, { lp: 4000 });
        break;
      case 'slowbeat':
        H('kick', 0, 0.6); if (r.chance(0.6)) H('kick', 1.5, 0.35);
        if (M === 4) H('snareLofi', 2, 0.45, { lp: 6000 });
        for (let b = 0; b < M; b += 0.5) H('hat', b, b % 1 ? 0.1 : 0.16, { lp: 6000, pan: 0.3 });
        break;
      case 'drift':
        H('kickSoft', 0, 0.6); if (r.chance(0.5)) H('kickSoft', 2.5, 0.4); else if (M === 4) H('kickSoft', 2, 0.45);
        if (M === 4) { H('clap', 1, 0.3, { lp: 5000 }); H('clap', 3, 0.3, { lp: 5000 }); }
        for (let b = 0; b < M; b += 0.5) if (r.chance(0.85)) H('hat', b, b % 1 ? 0.18 : 0.1, { lp: 8000, pan: 0.25 });
        break;
      case 'toy':
        H('bongo', 0, 0.5, { rate: 1 }); H('woodblock', 0.75, 0.35, { pan: 0.4 });
        H('bongo', 1.5, 0.4, { rate: 1.33, pan: -0.3 }); H('clap', M - 1, 0.35);
        if (r.chance(0.5)) H('woodblock', 2.5, 0.3, { rate: 1.5, pan: -0.4 });
        for (let b = 0; b < M; b += 0.5) if (r.chance(0.4)) H('shaker', b + 0.25, 0.2);
        if (fill) for (let b = M - 1; b < M; b += 0.25) H('bongo', b, 0.35, { rate: 1 + (b - M + 1) });
        break;
      default: break;
    }
  }

  // ---- granular shimmer
  _grains(L, c) {
    const d = L.def, r = this.r;
    const g = this.style.key === 'cosmic' ? 0.25 + this.growth : 0.5 + c.E * 0.5;
    const n = Math.round(r.range(d.rate[0], d.rate[1]) * g * this.barDur * clamp(this.host.quality, 0.35, 1));
    const chord = this._pool(d.range[0], d.range[1]), scale = this._scalePool(d.range[0], d.range[1]);
    if (!scale.length) return;
    for (let i = 0; i < n; i++) {
      const t = c.t0 + r() * this.barDur;
      const m = (chord.length && r.chance(0.65)) ? r.pick(chord) : r.pick(scale);
      const dur = r.range(d.dur[0], d.dur[1]);
      grain(this.ctx, L.strip, t, m, dur, r.range(0.3, 1) * 0.5, r.range(-0.9, 0.9), d.wave || 'sine');
    }
  }

  // ---- sparse bells / single notes
  _bells(L, c) {
    const d = L.def, r = this.r;
    for (let b = 0; b < this.meter; b++) {
      if (!r.chance((d.prob ?? 0.1) * (0.6 + c.E))) continue;
      const pool = r.chance(0.7) ? this._pool(d.range[0], d.range[1]) : this._scalePool(d.range[0], d.range[1]);
      if (!pool.length) continue;
      const m = r.pick(pool); const t = this._hz(this._time(c.t0, b + (r.chance(0.3) ? 0.5 : 0)), 0.02);
      const vel = r.range(0.35, 0.8);
      pluck(this.ctx, L.strip, d.inst, t, m, vel, { pan: r.range(-0.6, 0.6), quality: this.host.quality });
      if (r.chance(0.25)) pluck(this.ctx, L.strip, d.inst, t + r.range(0.02, 0.4), m + r.pick([7, 12, -5]), vel * 0.7, { pan: r.range(-0.6, 0.6), quality: this.host.quality });
    }
  }

  /** Discovery sting in the current key on the next beat: rising arpeggio + bell bloom (separate strip, not ducked). */
  sting(strip, t, kind = 'discover') {
    const h = this.h, r = this.r;
    const b = this.beat || 0.8;
    const t1 = this.style ? Math.max(t + 0.05, this.nextBar - Math.floor((this.nextBar - t) / b) * b) : t + 0.05;
    const root = h.tonic + 12;
    const bright = ['lydian', 'ionian', 'mixolydian', 'lydianDom', 'yo', 'pentaMaj'].includes(this.modeName);
    const chord = bright ? [0, 4, 7, 11, 14] : [0, 3, 7, 10, 14];
    const insts = kind === 'city' ? ['harp', 'bell'] : kind === 'monument' || kind === 'wonder' ? ['celesta', 'glassBell'] : ['celesta', 'bell'];
    const step = Math.min(0.14, b / 4);
    chord.forEach((iv, i) => pluck(this.ctx, strip, insts[0], t1 + i * step, root + iv, 0.55 + i * 0.06, { pan: -0.5 + i * 0.25, quality: 1 }));
    pluck(this.ctx, strip, insts[1], t1 + chord.length * step, root + 24, 0.6, { pan: 0.2, quality: 1 });
    pluck(this.ctx, strip, 'harp', t1, root - 12, 0.6, { quality: 1 });
    for (let i = 0; i < 10; i++) grain(this.ctx, strip, t1 + 0.4 + r() * 1.8, root + 24 + r.pick(chord), r.range(0.2, 0.7), 0.25, r.range(-0.9, 0.9), 'glass');
    return t1;
  }

  _log(L, t, midi, dur, vel) { if (this.log && this.log.length < 4000) this.log.push([+t.toFixed(3), L.def.id, midi, +dur.toFixed(2), +vel.toFixed(2)]); }

  debug() {
    const sec = this.section;
    return {
      style: this.style?.key, art: this.style?.art, label: this.style?.label, note: this.style?.note,
      key: `${pcName(this.h.tonic)} ${this.modeName}`, bpm: +(this.bpm || 0).toFixed(1), meter: this.meter, swing: this.swing,
      chord: this.chord ? this.h.label(this.chord.deg, this.chord.ext) : null, recentChords: this.history.slice(),
      section: sec ? { kind: sec.kind, bars: sec.bars, left: sec.left, idx: sec.idx } : null, bar: this.bar,
      energy: +this.energy.toFixed(2), layers: this.layers.map((L) => ({ id: L.def.id, type: L.def.type, inst: L.def.mono || L.def.inst || L.def.timbre || L.def.kit || L.def.wave, on: L.on })),
    };
  }
}
