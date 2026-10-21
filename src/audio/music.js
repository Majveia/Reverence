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
import { Harmony, PROGRESSIONS, BRIGHTNESS, nextDegree, voiceLead, makeMotif, varyMotif, pcName, MAIN_THEME, JINGLE, themeProg, themeMotif } from './theory.js';
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
    // moods (0..1, set by the host every frame): settled (in a town), lift (gliding / drifting),
    // med (Commune: meditating), rest (sitting and looking out)
    this.settled = 0; this.lift = 0; this.med = 0; this.rest = 0;
    this.hm = new Harmony(48, 'yo');          // melodic pentatonic of the current mode (flute, koto, theme)
    this.themeCount = 0; this._lastTheme = -99; this._themeRot = 0;
    // persistent accent strip (katana, resonance chimes, jingles, taiko swells) and the Commune voice
    this.accentStrip = new Strip(this.ctx, this.mix, { gain: 0.85, rev: 0.55, echo: 0.12 });
    this.medStrip = null;
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
    m.musicOut?.gain.setTargetAtTime(style.out ?? 1, t, 0.8);   // loudness normaliser (dry + reverb + echo)
    const q = this.host.quality;
    for (const def of style.layers) {
      const L = { def, on: false, voicing: null, motif: null, anchor: null, last: null };
      L.strip = new Strip(this.ctx, m, { gain: 0, pan: def.pan ?? 0, rev: def.rev ?? 0.3, echo: def.echo ?? 0, lp: def.lp || 0, dest: def.pump ? m.pumpIn : null });
      if (def.type === 'pad' || def.type === 'drone') {
        const nv = def.type === 'drone' ? def.notes.length : Math.max(2, Math.round(def.voices * (q < 0.5 ? 0.67 : 1)));
        L.bank = new PadBank(this.ctx, L.strip, def.timbre, nv, t);
      }
      if (def.mono) L.mono = new MonoVoice(this.ctx, L.strip, def.mono, t);
      if (def.autopan) { // suitcase-Rhodes stereo vibrato
        const o = this.ctx.createOscillator(); o.frequency.value = def.autopan[0]; const g = this.ctx.createGain(); g.gain.value = def.autopan[1];
        o.connect(g); g.connect(L.strip.pan.pan); o.start(t); L.autopan = o;
      }
      this.layers.push(L);
    }
    this.bar = 0; this.section = null; this.sectionCount = 0; this.queue = []; this.chord = null; this.chordBarsLeft = 0;
    this._lastTheme = -99; this._insertKey = null; this._themeRot = r.int(0, 5);
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
    this.hm.melodicOf(this.h);
    this.modeName = mode;
  }

  _dropLayer(L, t) {
    L.strip.fade(t, 0, 0.8);
    if (L.autopan) try { L.autopan.stop(t + 9); } catch (_) { /* ignore */ }
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

  /** Next point on the music's grid after t (div = 4 → 16ths), for accents that should land in time. */
  grid(t, div = 4) {
    if (!this.style || !this.barDur) return t;
    let t0 = this.nextBar; while (t0 > t) t0 -= this.barDur;
    const g = this.beat / div;
    return t0 + Math.ceil((t - t0) / g - 1e-6) * g;
  }

  /** Mood flags with hysteresis; a change ends the current section so the arrangement answers within a bar. */
  _moods() {
    const hyst = (x, on) => (x > 0.55 ? true : x < 0.35 ? false : !!on);
    const med = hyst(this.med, this._medOn), lift = hyst(this.lift, this._liftOn), settled = hyst(this.settled, this._settledOn);
    let changed = false;
    if (med !== this._medOn) { if (this._medOn && !med) this._resolvePending = true; this._medOn = med; changed = true; }
    if (lift !== this._liftOn) { this._liftOn = lift; changed = changed || !med; }
    if (settled !== this._settledOn) { this._settledOn = settled; }
    if (changed && this.section && this.section.bars - this.section.left >= 1) this.section.left = 0;
  }

  _allowed(L) {
    const d = L.def, night = this.night > 0.5;
    if (this._medOn) return d.type === 'pad' || d.type === 'drone' || !!d.med;
    if (d.themeOnly) return false;
    if (d.nightOnly && !night) return false;
    if (d.nightOff && night) return false;
    if (d.settledOnly && !this._settledOn) return false;
    if (d.liftOff && this._liftOn) return false;
    if (d.liftOnly && !this._liftOn) return false;
    return true;
  }

  /** Per-mood colour of the tape insert ("from another room": darker at night, warmer in town). */
  _moodInsert(t) {
    const ins = this.style.insert || {};
    if (!ins.lp) return;
    const night = this.night > 0.5, k = this._medOn ? 0.75 : night ? (this.style.nightLp ?? 0.7) : this._settledOn ? 1.15 : 1;
    const key = k.toFixed(2);
    if (key === this._insertKey) return;
    this._insertKey = key;
    this.mix.setInsert({ ...ins, lp: ins.lp * k, crackle: (ins.crackle || 0) * (night ? 1.2 : 1) }, t);
  }

  // ------------------------------------------------------------------ form
  _newSection(t0) {
    const st = this.style, r = this.r, E = this.energy;
    this.sectionCount++;
    this._moodInsert(t0);
    this.mix.musicOut?.gain.setTargetAtTime((st.out ?? 1) * (this._liftOn ? 0.84 : 1) * (this.night > 0.5 && st.nightLp ? 1.22 : 1), t0, 1.2);
    if (this.sectionCount > 1 && this.sectionCount % 3 === 0) this._pickMode(false);
    else if ((this.night > 0.5) !== this._wasNight || (this.danger > 0.5) !== this._wasDanger) this._pickMode(false);
    this._wasNight = this.night > 0.5; this._wasDanger = this.danger > 0.5;
    this.bpm = this.baseBpm * (1 - 0.08 * this.night) * (1 + 0.06 * this.danger) * (1 + 0.035 * (this._settledOn ? 1 : 0)) * (0.97 + r() * 0.06);
    let kind = 'play', bars = r.weighted([[4, 2], [8, 3]]);
    // the main theme returns every few sections (sooner while resting or meditating), on a rotating instrument
    const themeLs = this.layers.filter((L) => L.def.theme && (L.def.themeOnly || this._allowed(L)));
    const every = (st.themeEvery ?? 4) * (this.rest > 0.5 ? 0.5 : 1);
    const themeDue = themeLs.length && this.sectionCount > 1 && !this._medOn && this.sectionCount - this._lastTheme >= every && (this._lastTheme > 0 || this.sectionCount >= (st.themeFirst ?? 3));
    if (this.sectionCount === 1) { kind = 'intro'; bars = st.bpm[1] > 70 ? 2 : 1; }
    else if (this._medOn) { kind = 'commune'; bars = 8; }
    else if (this._resolvePending) { kind = 'resolve'; bars = 2; this._resolvePending = false; }
    else if (themeDue) { kind = 'theme'; bars = this.meter === 4 ? 8 : 8; }
    else if (this.sectionCount > 2 && this.section?.kind === 'play' && r.chance((st.breath ?? 0.1) * (1.25 - E))) { kind = 'breath'; bars = r.weighted([[1, 1], [2, 3], [4, 1]]); }
    for (const L of this.layers) L.themeRole = null;
    this.themeSec = kind === 'theme';
    if (kind === 'theme') {
      this._lastTheme = this.sectionCount; this.themeCount++;
      const lead = themeLs[this._themeRot++ % themeLs.length];
      lead.themeRole = 'lead';
      const echoes = themeLs.filter((L) => L !== lead);
      if (echoes.length && r.chance(0.7)) r.pick(echoes).themeRole = 'echo';
    }
    const on = new Set();
    if (kind === 'commune') {
      for (const L of this.layers) if (L.def.type === 'pad' || L.def.type === 'drone') on.add(L);
    } else if (kind === 'intro' || kind === 'breath' || kind === 'resolve') {
      for (const L of this.layers) {
        if (!this._allowed(L)) continue;
        const d = L.def, bed = d.type === 'pad' || d.type === 'drone' || d.type === 'grains';
        if (kind === 'intro' || kind === 'resolve') { if ((bed && !(d.minE > 0.3)) || (!(d.minE > 0.02) && d.type !== 'perc' && d.type !== 'melody' && d.type !== 'bass') || (kind === 'resolve' && d.breath)) on.add(L); }
        else if (d.breath && r.chance(0.85)) on.add(L);
        else if ((d.type === 'drone' || (d.type === 'pad' && !(d.minE > 0.05))) && r.chance(0.75)) on.add(L);
        else if (d.core && !this.layers.some((o) => o.def.type === 'pad' || o.def.type === 'drone') && d.type !== 'bass') on.add(L);
      }
    } else {
      // arrangement: energy decides HOW MANY layers play; importance (minE) + chance decide WHICH
      const ok = (L) => this._allowed(L) && !(kind === 'theme' && L.def.type === 'melody' && !L.themeRole);
      for (const L of this.layers) if (L.themeRole) on.add(L);
      for (const L of this.layers) if (ok(L) && (L.def.type === 'drone' || (L.def.core && (L.def.minE ?? 0) <= E + 0.1))) on.add(L);
      if (kind === 'theme') for (const L of this.layers) if (L.def.bloom && ok(L)) on.add(L);
      if (this._liftOn) for (const L of this.layers) if (L.def.lift && ok(L)) on.add(L);
      const elig = this.layers.filter((L) => !on.has(L) && ok(L) && (L.def.minE ?? 0) <= E + 0.12);
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
      const lvl = L.def.level * (kind === 'breath' ? 0.55 : kind === 'commune' ? 0.45 : 1) * (kind === 'theme' && L.def.bloom ? 1.6 : 1) * (this.night > 0.5 ? L.def.nightLevel ?? 1 : 1);
      if (L.on) L.strip.fade(t0, lvl, was ? 1.2 : (L.def.type === 'pad' || L.def.type === 'drone' ? 1.5 : 0.05));
      else if (was) { L.strip.fade(t0, 0, L.def.type === 'pad' ? 2 : 0.8); L.mono?.silence(t0); }
      if (L.def.type === 'melody') { L.motif = (L.def.penta && r.chance(0.45) && themeMotif(r, this.meter)) || makeMotif(r, this.meter, clamp((L.def.density ?? 0.4) * (0.7 + 0.6 * E), 0.1, 0.95), r.chance(0.2) ? 'triplet' : 'straight'); L.motifB = null; }
      if (L.def.type === 'arp') { L.rate = r.int(L.def.rate[0], Math.round(L.def.rate[0] + (L.def.rate[1] - L.def.rate[0]) * clamp(E * 1.3, 0, 1))); L.pattern = r.pick(L.def.patterns); }
      if (L.def.type === 'perc') L.fill = r.chance(0.5);
    }
    this.section = { kind, bars, left: bars, idx: this.sectionCount, energy: E };
    this._commune(t0, kind);
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
    this._moods();
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
      if (sec.kind === 'intro' || sec.kind === 'resolve' || (sec.kind === 'breath' && r.chance(0.5))) this.chord = { deg: 0, ext: sec.kind === 'resolve' ? 'add9' : r.weighted(this.style.exts), bars: sec.kind === 'resolve' ? 2 : 1 };
      if (sec.kind === 'theme') { this.chord = { deg: themeProg(this.modeName)[phraseBar] % this.h.size, ext: r.weighted(this.style.exts), bars: 1 }; this.queue.length = 0; }
      if (sec.kind === 'commune') { // hold home; now and then lean to a consonant neighbour (never a diminished triad)
        const alt = [3, 5, 6, 4].filter((k) => k < this.h.size && (this.h.deg(k + 4) - this.h.deg(k) + 12) % 12 === 7);
        this.chord = { deg: r.chance(0.7) || !alt.length ? 0 : r.pick(alt), ext: r.pick(['add9', 'sus2']), bars: 2 };
      }
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
    if (sec.kind === 'resolve' && sec.left === sec.bars) this.accent('resolve', t0);
    if (sec.kind === 'commune') this._communeBar(ctx, sec);
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
  _pentaPool(lo, hi) { const H = this.hm, out = []; for (let m = lo; m <= hi; m++) if (H.snap(m) === m) out.push(m); return out; }

  /** Koto idiom: short pentatonic figures with rests — falling runs, broken octaves, a long note pressed
   *  (oshi-de) a semitone up, sukui grace notes. */
  _koto(L, c) {
    const d = L.def, r = this.r, q = this.host.quality;
    const pool = this._pentaPool(d.range[0], d.range[1]); if (pool.length < 3) return;
    if (L.ki == null) L.ki = Math.floor(pool.length * 0.5);
    if (r.chance(d.sparse ?? 0.3)) return;                         // a bar of space
    const P = (b, m, v, o = {}) => { const t = this._hz(this._time(c.t0, b), 0.01); this._log(L, t, m, 0, v); pluck(this.ctx, L.strip, d.inst || 'koto', t, m, clamp(v * c.arc, 0.05, 1), { pan: r.range(-0.5, 0.5), quality: q, ...o }); };
    const fig = r.weighted([['fall', 3], ['octave', 2], ['long', 2], ['answer', 2]]);
    const b0 = r.pick(this.meter === 4 ? [0, 0.5, 1, 2] : [0, 0.5, 1]);
    L.ki = clamp(L.ki + r.pick([-2, -1, 0, 1, 2]), 2, pool.length - 1);
    const at = (k) => pool[clamp(k, 0, pool.length - 1)];
    if (fig === 'fall') { for (let k = 0; k < 3; k++) P(b0 + k * 0.5, at(L.ki - k), 0.62 - k * 0.08); }
    else if (fig === 'octave') { const m = at(L.ki); P(b0, m - 12 >= d.range[0] ? m - 12 : m, 0.55); P(b0 + 0.25, m, 0.5); if (r.chance(0.5)) P(b0 + 1, at(L.ki - 1), 0.45); }
    else if (fig === 'long') { if (r.chance(0.5)) P(b0 - 0.12 < 0 ? b0 : b0 - 0.12, at(L.ki + 1), 0.3); P(b0, at(L.ki), 0.66, { bend: r.chance(0.6) ? 1 : 0 }); }
    else { P(b0, at(L.ki), 0.55); P(b0 + 0.5, at(L.ki + 1), 0.5); P(b0 + 1.5, at(L.ki - 1), 0.58); }
  }

  _arp(L, c) {
    const d = L.def, r = this.r, q = this.host.quality;
    if (L.pattern === 'koto' || d.patterns?.[0] === 'koto') return this._koto(L, c);
    const pool = d.scale === 'penta' ? this._pentaPool(d.range[0], d.range[1]) : this._pool(d.range[0], d.range[1]); if (!pool.length) return;
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
  /** The main theme, phrase by phrase: the lead sings bars 0-3 (call, answer); an echo layer (another
   *  instrument) restates it in bars 4-7, else the lead returns, ornamented. */
  _themeBar(L, c) {
    const d = L.def, r = this.r, H = this.hm, n = H.size;
    const pb = (this.section.bars - this.section.left);
    const second = pb >= 4;
    const sings = L.themeRole === 'lead' ? (!second || !this.layers.some((o) => o.themeRole === 'echo' && o.on)) : second;
    if (!sings) { if (L.mono && pb === 4) L.mono.silence(c.t0); return; }
    const half = (pb % 4) < 2 ? MAIN_THEME.call : MAIN_THEME.answer;
    const sub = (pb % 2) * 4, k = this.meter / 4, slow = d.themeSlow || 1;
    const notes = half.filter(([b]) => b >= sub && b < sub + 4);
    // register: the tonic octave that best fits the theme's span (indices 0..6) inside the layer range
    const lo = d.range[0], hi = d.range[1];
    let tonic = H.tonic; while (tonic < lo) tonic += 12; while (H.deg(n + 1) - H.tonic + tonic > hi && tonic - 12 >= lo - 2) tonic -= 12;
    const shift = Math.round((tonic - H.tonic) / 12) * n + (second && L.themeRole === 'echo' && d.echoUp ? n : 0);
    const orn = second && L.themeRole === 'lead';
    for (let i = 0; i < notes.length; i++) {
      const [b, dur, p] = notes[i];
      let midi = H.deg(p + shift); while (midi > hi + 2) midi -= 12;
      const tb = (b - sub) * k * slow, durS = dur * k * slow * this.beat;
      if (tb >= this.meter) break;
      const t = this._hz(this._time(c.t0, tb), 0.01);
      const vel = clamp((0.62 + 0.18 * (dur >= 2 ? 1 : 0) + 0.12 * c.E) * r.range(0.92, 1.04), 0.2, 1);
      const last = i === notes.length - 1;
      if (L.mono) {
        if (orn && dur >= 1.5 && r.chance(0.6)) L.mono.note(t - 0.08, H.deg(p + shift + 1), 0.08, vel * 0.7, { legato: true, glide: 0.03 });
        L.mono.note(t, midi, durS * 0.97, vel, { legato: !last && notes[i + 1] && Math.abs(notes[i + 1][0] - (b + dur)) < 0.01, fall: last && dur >= 2, scoop: dur >= 1.5 ? -200 : undefined });
      } else {
        pluck(this.ctx, L.strip, d.inst, t, midi, vel, { pan: r.range(-0.12, 0.12), quality: this.host.quality, dur: d.inst === 'rhodes' || d.inst === 'vibes' ? durS : 0, bend: d.inst === 'koto' && dur >= 2 && r.chance(0.5) ? 1 : 0 });
        if (d.inst === 'koto' && dur >= 2) pluck(this.ctx, L.strip, d.inst, t + durS * 0.5, midi, vel * 0.45, { quality: this.host.quality }); // a quiet re-pluck sustains it
      }
      this._log(L, t, midi, durS, vel);
    }
  }

  _melody(L, c) {
    const d = L.def, r = this.r;
    if (L.themeRole) return this._themeBar(L, c);
    if (d.themeOnly) return;
    const H = d.penta ? this.hm : this.h;
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
    const lo = d.range[0], hi = d.range[1], n = H.size;
    if (L.anchor == null || L.sectionSeen !== this.section.idx || L.anchorH !== H.mode) { // new register per section (±a third)
      if (L.anchorH !== H.mode) L.anchor = null;
      L.sectionSeen = this.section.idx; L.anchorH = H.mode;
      const mid = H.degreeOf(Math.round(lo + (hi - lo) * r.range(0.3, 0.55)));
      L.anchor = L.anchor == null ? mid : Math.round((L.anchor + mid) / 2) + r.pick([-2, -1, 0, 1, 2]);
      L.arc = r.pick([[0, 2, 4, 1], [0, 1, 3, 0], [2, 3, 1, 0], [0, 3, 2, -1], [1, 0, 2, 0]]); // phrase contour (degrees)
    }
    const base = L.anchor + (L.arc?.[c.phraseBar] ?? 0);
    const chordPcs = new Set(this.chordMidis.map((x) => ((x % 12) + 12) % 12));
    const notes = [];
    let prevMidi = null;
    for (let i = 0; i < m.rh.length; i++) {
      const [b, dur] = m.rh[i];
      if (i > 0 && d.rests && r.chance(d.rests)) continue; // BotW: phrases with breath between the notes
      let deg = base + m.steps[i];
      let midi = H.deg(deg);
      while (midi > hi) { midi -= 12; deg -= n; } while (midi < lo) { midi += 12; deg += n; }
      const strong = Math.abs(b - Math.round(b)) < 1e-3 && (Math.round(b) % 2 === 0 || dur >= 1);
      if (strong && !chordPcs.has(((midi % 12) + 12) % 12)) { // lean onto a chord tone, preferring the direction of motion
        const dir = prevMidi == null ? 1 : Math.sign(midi - prevMidi) || 1;
        for (const k of [dir, -dir, 2 * dir, -2 * dir]) { const mm = H.deg(deg + k); if (chordPcs.has(((mm % 12) + 12) % 12) && mm >= lo && mm <= hi) { midi = mm; break; } }
      }
      if (prevMidi != null && midi === prevMidi && r.chance(0.5)) { const mm = H.deg(H.degreeOf(midi) + r.pick([1, -1])); if (mm >= lo && mm <= hi) midi = mm; } // avoid static repetition
      if (prevMidi != null && Math.abs(midi - prevMidi) > 7) { // no wild leaps: fold the octave, else step toward it
        const f = midi + (midi > prevMidi ? -12 : 12);
        midi = Math.abs(f - prevMidi) <= 7 && f >= lo && f <= hi ? f : H.deg(H.degreeOf(prevMidi) + Math.sign(midi - prevMidi) * 2);
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
          const g = H.deg(H.degreeOf(midi) + 1);
          L.mono.note(t - 0.07, g, 0.07, vel * 0.8, { legato: true, glide: 0.02 });
        }
        L.mono.note(t, midi, durS * legatoK, vel, { legato }); this._log(L, t, midi, durS, vel);
      } else this._log(L, t, midi, durS, vel), pluck(this.ctx, L.strip, d.inst, t, midi, vel, { pan: r.range(-0.15, 0.15), quality: this.host.quality, dur: d.inst === 'rhodes' || d.inst === 'vibes' ? durS : 0, bend: d.inst === 'koto' && durS > 1.2 && r.chance(0.3) ? 1 : 0 });
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
      case 'lofi': { // warm sub: a long root on 1, a lazy fifth/octave on 2&, a slide into the next chord
        const night = this.night > 0.5;
        P(0, root, vel, B * (night ? 3.2 : 1.7));
        if (!night && r.chance(0.7)) P(r.chance(0.6) ? 1.5 : 2, r.chance(0.55) ? fifth : root + 12, vel * 0.62, B * 0.8);
        if (!night && this.meter === 4 && r.chance(0.35)) P(2.5, root, vel * 0.55, B * 0.6);
        if (this.chordBarsLeft <= 1 && this.meter === 4 && r.chance(night ? 0.25 : 0.55)) {
          let nr = this.nextChordMidis[0]; while (nr > root + 7) nr -= 12; while (nr < root - 7) nr += 12;
          if (nr !== root) P(3.5, nr + (nr > root ? -1 : 1) * (r.chance(0.5) ? 1 : 2), vel * 0.5, B * 0.45); // approach
        }
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
    // rootless voicing for 4+ note chords (jazz), full triad otherwise; 9/11 chords: close 3-7-9-11 voicings
    const cm = this.chordMidis;
    const src = cm.length >= 6 ? [cm[1], cm[3], cm[4], cm[5]] : cm.length === 5 ? [cm[1], cm[2], cm[3], cm[4]] : cm.length >= 4 ? cm.slice(1) : cm;
    L.voicing = voiceLead(L.voicing, src, Math.min(4, src.length + (src.length < 4 ? 1 : 0)), d.range[0], d.range[1], r);
    const hitAt = (b, vel, dur, strum = 0, up = false) => {
      const notes = up ? [...L.voicing].reverse() : L.voicing;
      this._log(L, this._time(c.t0, b), L.voicing[L.voicing.length - 1], dur, vel);
      notes.forEach((m, i) => pluck(this.ctx, L.strip, d.inst, this._hz(this._time(c.t0, b)) + i * strum, m, vel * r.range(0.85, 1), { dur, quality: this.host.quality, pan: (i / Math.max(1, notes.length - 1) - 0.5) * 0.8 }));
    };
    const B = this.beat;
    if (d.rhythm === 'lofi') { // sustained, rolled Rhodes chords that breathe with the kick; pushes on the 4&
      const v = (this.night > 0.5 ? 0.42 : 0.5) * c.arc;
      const roll = r.range(0.012, 0.035);
      const variant = this.night > 0.5 ? r.pick([0, 0, 3]) : this.lift > 0.5 ? 3 : r.weighted([[0, 3], [1, 2], [2, 2], [3, 1]]);
      if (!this.chordChanged && r.chance(0.35)) { if (r.chance(0.5)) hitAt(2.5, v * 0.7, B * 1.2, roll); return; } // let a held chord ring
      if (variant === 0) { hitAt(0, v, B * 3.4, roll); }
      else if (variant === 1) { hitAt(0, v, B * 1.4, roll); hitAt(1.5, v * 0.72, B * 0.45); hitAt(2.5, v * 0.85, B * 1.3, roll * 0.6); }
      else if (variant === 2) { hitAt(0, v, B * 2.2, roll); if (this.meter === 4) hitAt(3.5, v * 0.75, B * 0.9, roll * 0.5); }
      else { hitAt(0, v * 0.85, B * this.meter * 0.98, roll * 2.2); }
    } else if (d.rhythm === 'charleston') {
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
      case 'chill': { // laid-back lofi: soft kick 1 + 2&, rim (cross-stick) on 2 & 4 a hair late, shuffled hats
        const night = this.night > 0.5, town = this._settledOn, lift = this._liftOn;
        const K = (b, v) => { const t = this._hz(this._time(t0, b), 0.004); hit(ctx, S, 'kickSoft', t, clamp(v * r.range(0.9, 1.04), 0.05, 1), { lp: 2400 }); this.mix.pumpAt(t, 0.26 * (L.def.pump ?? 1), 0.24); };
        const late = (b) => this._time(t0, b) + 0.016 + r.gauss() * 0.004;
        const SN = (b, v, o = {}) => hit(ctx, S, town ? 'snareLofi' : 'rim', late(b), clamp(v * r.range(0.85, 1.03), 0.02, 1), { lp: town ? 4800 : 3800, pan: 0.05, ...o });
        if (lift) { // gliding: the floor drops away — only air (hats, shaker) and a swell into the next phrase
          for (let b = 0; b < M; b += 0.5) if (r.chance(0.8)) H('hat', b, b % 1 ? 0.11 : 0.07, { lp: 9000, pan: 0.3 });
          if (c.phraseBar === 3) H('hatOpen', M - 0.5, 0.12, { lp: 8000, pan: -0.2 });
          break;
        }
        K(0, 0.82);
        if (M === 4) {
          if (r.chance(night ? 0.45 : 0.8)) K(1.5, 0.55);
          if (!night && r.chance(0.28)) K(2.75, 0.42);
          if (!night && r.chance(0.12)) K(3.5, 0.4);
          SN(1, 0.62); SN(3, 0.66);
          if (!night && town) { hit(ctx, S, 'rim', late(1), 0.25, { lp: 3800 }); hit(ctx, S, 'brushSwish', late(2.5), 0.2, { pan: -0.2 }); }
          if (r.chance(0.5)) hit(ctx, S, 'rim', late(r.pick([2.75, 3.75, 1.75])), 0.14, { lp: 3000, rate: 1.05 });   // ghost note
        } else { SN(1, 0.5); SN(2, 0.55); }
        if (!night) {
          for (let b = 0; b < M; b += 0.5) {
            if (r.chance(0.08)) continue;
            const on = !(b % 1);
            H('hat', b, (on ? 0.3 : 0.19) * (town ? 1.15 : 1), { lp: 12000, pan: 0.32, variant: on ? 0 : 1 });
            if (town && !on && r.chance(0.5)) H('shaker', b + 0.25, 0.12, { pan: -0.35 });
          }
          if (r.chance(0.25)) H('hat', M - 0.25, 0.08, { lp: 7800, pan: 0.28 });
          if (M === 4 && r.chance(0.18)) H('hatOpen', 3.5, 0.08, { lp: 7000, pan: 0.3 });
        } else if (r.chance(0.5)) H('shaker', M - 0.5, 0.1, { pan: -0.3 });
        if (fill) { SN(M - 0.5, 0.35); SN(M - 0.25, 0.28); }
        break;
      }
      case 'taikoSwell': { // distant taiko at the big moments: a low don, then a rolling crescendo into the next phrase
        const D = (b, v, rate = 0.78) => H('taiko', b, v, { rate, lp: 900 });
        if (c.phraseBar === 0) { D(0, 0.75, 0.7); if (r.chance(0.5)) D(M - 1, 0.35, 0.84); }
        else if (c.phraseBar === 2) { D(0, 0.55); D(0.75, 0.32, 0.86); }
        if (c.lastBar || c.phraseBar === 3) for (let b = M - 2; b < M; b += 0.25) D(b, 0.08 + 0.42 * ((b - M + 2) / 2) ** 1.6, 1.1);
        break;
      }
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

  // ------------------------------------------------------------------ Commune (meditation)
  /** The Commune voice: a breathing drone (tonic, fifth, octave, ninth) and a shakuhachi that sings the main
   *  theme slowly over it. Built lazily, kept across styles; faded out on release. */
  _commune(t0, kind) {
    const on = kind === 'commune';
    if (on && !this.medStrip) {
      this.medStrip = new Strip(this.ctx, this.mix, { gain: 0, rev: 0.75, echo: 0.22 });
      this.medBank = new PadBank(this.ctx, this.medStrip, 'warm', 4, t0);
      this.medFlute = new MonoVoice(this.ctx, this.medStrip, 'shakuhachi', t0);
      this.medFluteGain = 0.9;
    }
    if (!this.medStrip) return;
    if (on && !this._medWasOn) { this.medStrip.fade(t0, 0.33, 2.5); this._medBar = 0; }
    else if (this._medWasOn) { this.medStrip.fade(t0, 0, 3); this.medFlute.silence(t0); this.medBank.release(t0 + 2, 2); }
    this._medWasOn = on;
  }

  _communeBar(c, sec) {
    if (!this.medBank) return;
    const H = this.hm, r = this.r, t0 = c.t0, B = this.beat;
    let root = this.h.tonic; while (root > 45) root -= 12; while (root < 36) root += 12;
    if (this.chordChanged || this._medBar === 0) {
      const top = this.chord?.deg ? this.h.deg(this.chord.deg) % 12 : 0;
      this.medBank.setChord(t0, [root, root + 7, root + 12, root + 14 + (top ? 0 : 0)], { glide: 2.5, level: 0.9, attack: 3, bright: 0.6 });
    }
    // breathing: inhale over one bar, exhale over the next (≈ the breath of someone sitting very still)
    const inhale = this._medBar % 2 === 0;
    this.medStrip.out.gain.setTargetAtTime(inhale ? 0.4 : 0.25, t0, this.barDur * 0.45);
    this.medBank.bright(t0, inhale ? 0.95 : 0.55, this.barDur * 0.4);
    // the theme at half speed: each theme bar takes two bars; a bar of silence between the call and the answer
    const k = this._medBar % 10;
    if (k < 8) {
      const half = k < 4 ? MAIN_THEME.call : MAIN_THEME.answer;
      const tb0 = ((k % 4) >> 1) * 4 + (k % 2) * 2;     // theme beats [tb0, tb0 + 2) play in this bar, doubled in length
      let tonic = H.tonic; while (tonic < 62) tonic += 12; while (tonic > 70) tonic -= 12;
      const shift = Math.round((tonic - H.tonic) / 12) * H.size;
      for (const [b, dur, p] of half) {
        if (b < tb0 || b >= tb0 + 2) continue;
        const t = this._hz(t0 + (b - tb0) * 2 * B, 0.015);
        const midi = H.deg(p + shift);
        this.medFlute.note(t, midi, dur * 2 * B * 0.96, 0.62 * r.range(0.9, 1.05), { scoop: dur >= 1 ? -220 : -120, fall: dur >= 2 });
        this._log({ def: { id: 'commune' } }, t, midi, dur * 2 * B, 0.6);
      }
    }
    // a rin bowl every few bars, on the tonic, far away
    if (this._medBar % 4 === 0) pluck(this.ctx, this.medStrip, 'rin', this._hz(t0 + B * 0.02, 0.01), root + 24, 0.4, { quality: 1, pan: -0.25 });
    this._medBar++;
  }

  // ------------------------------------------------------------------ accents (explorer moments)
  /**
   * Musical accents that land on the grid, in the current key:
   *  'draw'    shamisen: root + fifth with a bachi snap on the next 16th (the katana leaves the scabbard)
   *  'sheathe' a koto harmonic on the tonic (the click home)
   *  'iai'     shamisen double-stop + a distant taiko (the flash cut)
   *  'pulse'   Resonance: a rin on the tonic and the current chord tones rung as chimes, low to high
   *  'blink'   two glass chimes (fifth → octave)
   *  'resolve' Commune ends: a low rin + koto tonic, cadence home
   */
  accent(kind, t) {
    const S = this.accentStrip, r = this.r, H = this.hm, h = this.h;
    let root = h.tonic; while (root < 52) root += 12; while (root > 63) root -= 12;
    const q = this.host.quality;
    switch (kind) {
      case 'draw': {
        const tq = this.grid(t + 0.02, 4);
        pluck(this.ctx, S, 'shamisen', tq, root, 0.82, { bachi: 1, quality: q, pan: -0.1 });
        pluck(this.ctx, S, 'shamisen', tq + 0.012, root + 7, 0.6, { bachi: 0.4, quality: q, pan: 0.1 });
        if (r.chance(0.5)) pluck(this.ctx, S, 'shamisen', this.grid(tq + 0.05, 4), root + 12, 0.45, { slide: 1, quality: q, pan: 0.15 });
        return tq;
      }
      case 'sheathe': {
        const tq = this.grid(t + 0.01, 4);
        pluck(this.ctx, S, 'koto', tq, root + 12, 0.42, { quality: q, pan: 0.2 });
        return tq;
      }
      case 'iai': {
        const tq = this.grid(t + 0.01, 4);
        pluck(this.ctx, S, 'shamisen', tq, root - 12, 0.9, { bachi: 1, quality: q });
        pluck(this.ctx, S, 'shamisen', tq + 0.01, root - 5, 0.8, { bachi: 0.6, quality: q });
        pluck(this.ctx, S, 'shamisen', tq + 0.02, root, 0.7, { quality: q });
        hit(this.ctx, S, 'taiko', tq, 0.75, { rate: 0.72, lp: 900 });
        return tq;
      }
      case 'pulse': {
        const tq = this.grid(t + 0.02, 2);
        pluck(this.ctx, S, 'rin', tq, root + 12, 0.7, { quality: 1 });
        const chord = (this.chordMidis || [root, root + 4, root + 7]).map((m) => { let x = m; while (x < root + 12) x += 12; while (x > root + 26) x -= 12; return x; }).sort((a, b) => a - b);
        chord.forEach((m, i) => pluck(this.ctx, S, 'chime', tq + 0.09 + i * 0.075, m + 12, 0.42 - i * 0.04, { quality: 1, pan: -0.5 + i * 0.3 }));
        return tq;
      }
      case 'blink': {
        const tq = this.grid(t + 0.01, 4);
        pluck(this.ctx, S, 'chime', tq, root + 31, 0.3, { quality: 1, pan: -0.4 });
        pluck(this.ctx, S, 'chime', tq + 0.08, root + 36, 0.26, { quality: 1, pan: 0.4 });
        return tq;
      }
      case 'resolve': {
        pluck(this.ctx, S, 'rin', t + 0.02, root, 0.6, { quality: 1 });
        pluck(this.ctx, S, 'koto', t + 0.05, H.tonic + (root - h.tonic), 0.5, { quality: q });
        return t;
      }
      default: return t;
    }
  }

  /** Distant taiko swell (discoveries of monuments / wonders, vistas): don … don-don … DON. */
  taiko(t) {
    const S = this.accentStrip, tq = this.grid(t + 0.05, 1), B = this.beat || 0.75;
    for (let i = 0; i < 12; i++) hit(this.ctx, S, 'taiko', tq + i * B / 4, 0.06 + 0.3 * (i / 11) ** 1.8, { rate: 1.12, lp: 700 });
    hit(this.ctx, S, 'taiko', tq + 3 * B, 0.9, { rate: 0.68, lp: 1000 });
    return tq + 3 * B;
  }

  /** Discovery JINGLE in the current key (its own short rising shape, not the theme): koto + celesta, the last
   *  note blooming into a rin and glass shimmer over a low open fifth. Big finds get a taiko swell first. */
  sting(strip, t, kind = 'discover') {
    const H = this.hm, r = this.r, q = 1;
    const big = kind === 'monument' || kind === 'wonder' || kind === 'vista' || kind === 'sacred';
    let t1 = this.style ? this.grid(t + 0.04, 2) : t + 0.05;
    if (big) t1 = this.taiko(t1) - (this.beat || 0.75) * 0.02;
    const step = clamp((this.beat || 0.75) / 4, 0.11, 0.17);
    let tonic = H.tonic; while (tonic < 64) tonic += 12; while (tonic > 72) tonic -= 12;
    const shift = Math.round((tonic - H.tonic) / 12) * H.size;
    const insts = kind === 'city' || kind === 'village' ? ['koto', 'harp'] : kind === 'creature' ? ['koto', 'kalimba'] : ['koto', 'celesta'];
    let last = t1;
    JINGLE.forEach(([b, p], i) => {
      const tn = t1 + b * step, m = H.deg(p + shift), fin = i === JINGLE.length - 1;
      pluck(this.ctx, strip, insts[0], tn, m, fin ? 0.75 : 0.6, { pan: -0.4 + i * 0.25, quality: q, bend: fin && r.chance(0.5) ? 1 : 0 });
      pluck(this.ctx, strip, insts[1], tn + 0.004, m + 12, fin ? 0.5 : 0.35, { pan: 0.3 - i * 0.2, quality: q });
      last = tn;
    });
    pluck(this.ctx, strip, 'rin', last, H.tonic + (tonic - H.tonic) + 12, 0.45, { quality: 1 });
    pluck(this.ctx, strip, 'koto', t1, tonic - 24, 0.55, { quality: q });
    pluck(this.ctx, strip, 'koto', t1 + 0.02, tonic - 17, 0.45, { quality: q });
    for (let i = 0; i < 10; i++) grain(this.ctx, strip, last + 0.1 + r() * 1.8, H.deg(r.int(0, H.size * 2) + shift + H.size), r.range(0.2, 0.7), 0.22, r.range(-0.9, 0.9), 'glass');
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
      energy: +this.energy.toFixed(2), melodic: `${pcName(this.hm.tonic)} ${this.hm.mode}`,
      moods: { night: +this.night.toFixed(2), settled: !!this._settledOn, lift: !!this._liftOn, commune: !!this._medOn, rest: +this.rest.toFixed(2) },
      theme: { statements: this.themeCount, lastSection: this._lastTheme, leads: this.layers.filter((L) => L.themeRole).map((L) => L.def.id + ':' + L.themeRole) },
      layers: this.layers.map((L) => ({ id: L.def.id, type: L.def.type, inst: L.def.mono || L.def.inst || L.def.timbre || L.def.kit || L.def.wave, on: L.on })),
    };
  }
}
