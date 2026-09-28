// Synth instruments for the generative music (AUDIO track). All native WebAudio nodes:
//   Strip       mixer channel: gain → (lowpass) → pan → music bus  (+ reverb / echo sends)
//   PadBank     persistent polyphonic voices that GLIDE between voicings (CS-80 style legato),
//               timbres: warm · strings · brass · choir (formant bank) · glass · organ · drone · pulse
//   MonoVoice   persistent expressive lead: duduk · flute · harmonica · cs80 · theremin · horn · cello ·
//               lead · whistle · bowed — portamento, delayed vibrato, breath noise, pitch scoops
//   pluck()     struck / plucked notes: piano · harp · koto · banjo · guitar · upright · synthBass ·
//               synthPluck · rhodes (FM) · marimba · kalimba · bell · celesta · vibes
//   hit()       sample-based percussion (samples.js) · grain() shimmer grains
import { waves, noiseBuffer, mtof, clamp, cleanupOnEnd } from './dsp.js';
import { sample } from './samples.js';

const VOWELS = { a: [700, 1220, 2600], o: [570, 840, 2410], u: [320, 870, 2240], e: [530, 1840, 2480], i: [300, 2200, 2950] };

// ------------------------------------------------------------------ strip
export class Strip {
  constructor(ctx, mix, { gain = 0.5, pan = 0, rev = 0.3, echo = 0, lp = 0, dest = null, revDest = null } = {}) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.out = ctx.createGain(); this.out.gain.value = gain;
    let n = this.input;
    if (lp) { this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = lp; this.lp.Q.value = 0.5; n.connect(this.lp); n = this.lp; }
    this.pan = ctx.createStereoPanner(); this.pan.pan.value = pan;
    n.connect(this.out); this.out.connect(this.pan); this.pan.connect(dest || mix.musicIn);
    this.rev = ctx.createGain(); this.rev.gain.value = rev; this.out.connect(this.rev); this.rev.connect(revDest || mix.reverbIn);
    this.echo = ctx.createGain(); this.echo.gain.value = echo; this.out.connect(this.echo); this.echo.connect(mix.echoIn);
    this.level = gain;
  }
  fade(t, g, tc = 1) { this.out.gain.setTargetAtTime(g, t, tc); }
  dispose() { for (const n of [this.input, this.lp, this.out, this.pan, this.rev, this.echo]) try { n?.disconnect(); } catch (_) { /* ignore */ } }
}

// ------------------------------------------------------------------ voice accounting
export const VOICES = { active: 0, max: 64, created: 0, dropped: 0 };
// Voice accounting by scheduled end time (works for look-ahead and offline pre-scheduling alike).
const ENDS = [];
function track(src, end) { VOICES.created++; ENDS.push(end); }
export function canVoice(vel = 1, t = 0) {
  let w = 0; for (let i = 0; i < ENDS.length; i++) if (ENDS[i] > t) ENDS[w++] = ENDS[i];
  ENDS.length = w; VOICES.active = w;
  if (w < VOICES.max * (0.6 + 0.4 * vel)) return true; VOICES.dropped++; return false;
}

// ------------------------------------------------------------------ PadBank
const PAD = {
  warm: { wave: 'warm', det: 7, cutoff: 1400, q: 0.7, vib: 0.1, vibD: 3, lvl: 1 },
  strings: { wave: 'saw', det: 9, cutoff: 2600, q: 0.5, vib: 5.2, vibD: 7, lvl: 0.7, att: 1.2 },
  brass: { wave: 'brass', det: 6, cutoff: 1600, q: 2.2, vib: 5.5, vibD: 5, lvl: 0.75, brass: true },
  choir: { wave: 'choir', det: 11, cutoff: 3600, q: 0.3, vib: 5.0, vibD: 9, lvl: 1.4, formant: true },
  glass: { wave: 'glass', det: 4, cutoff: 5000, q: 0.3, vib: 0.3, vibD: 6, lvl: 1.1 },
  organ: { wave: 'reed', det: 5, cutoff: 2200, q: 0.6, vib: 5.8, vibD: 4, lvl: 0.8 },
  drone: { wave: 'warm', det: 3, cutoff: 420, q: 1.2, vib: 0.07, vibD: 4, lvl: 0.8 },
  pulse: { wave: 'pulse', det: 10, cutoff: 1800, q: 1.2, vib: 4.5, vibD: 6, lvl: 0.6 },
};

export class PadBank {
  constructor(ctx, strip, timbre = 'warm', voices = 4, t = ctx.currentTime) {
    this.ctx = ctx; this.cfg = PAD[timbre] || PAD.warm; this.timbre = timbre; this.n = voices;
    const W = waves(ctx), c = this.cfg;
    this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.frequency.value = c.cutoff; this.filter.Q.value = c.q;
    this.out = ctx.createGain(); this.out.gain.value = c.lvl;
    this.lfo = ctx.createOscillator(); this.lfo.frequency.value = c.vib;
    this.lfoG = ctx.createGain(); this.lfoG.gain.value = c.vibD; this.lfo.connect(this.lfoG);
    this.voices = [];
    for (let i = 0; i < voices; i++) {
      const g = ctx.createGain(); g.gain.value = 0;
      const pan = ctx.createStereoPanner(); pan.pan.value = voices > 1 ? (i / (voices - 1) - 0.5) * 0.9 : 0;
      const oscs = [];
      for (let k = 0; k < 2; k++) {
        const o = ctx.createOscillator(); o.setPeriodicWave(W[c.wave] || W.warm);
        o.detune.value = (k ? 1 : -1) * c.det * (0.7 + 0.6 * ((i * 7 + k * 3) % 5) / 5);
        o.frequency.value = 110; this.lfoG.connect(o.detune); o.connect(g); o.start(t); oscs.push(o);
      }
      g.connect(pan); pan.connect(this.filter);
      this.voices.push({ oscs, g, pan, midi: 0 });
    }
    let tail = this.filter;
    if (c.formant) { // choir: fixed formant resonances on the summed voices (physically correct)
      this.formants = [];
      const sum = ctx.createGain(); sum.gain.value = 0.25; this.filter.connect(sum); sum.connect(this.out);
      [1, 0.55, 0.3].forEach((amp, k) => {
        const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = VOWELS.a[k]; f.Q.value = 7 + k * 3;
        const g = ctx.createGain(); g.gain.value = amp * 2.4; this.filter.connect(f); f.connect(g); g.connect(this.out); this.formants.push(f);
      });
      tail = null;
    }
    if (tail) tail.connect(this.out);
    this.out.connect(strip.input);
    this.lfo.start(t);
    this.level = 0; this.cur = [];
  }
  /** Glide to a new voicing. level: overall 0..1. */
  setChord(t, midis, { glide = 0.3, level = 1, attack = 0.8, bright = 1 } = {}) {
    const c = this.cfg, n = Math.min(midis.length, this.n);
    const per = level / Math.sqrt(Math.max(1, n)) * 0.5;
    for (let i = 0; i < this.n; i++) {
      const v = this.voices[i];
      if (i < n) {
        const f = mtof(midis[i]);
        for (const o of v.oscs) { if (!v.midi) o.frequency.setValueAtTime(f, t); else o.frequency.setTargetAtTime(f, t, glide / 3); }
        v.g.gain.setTargetAtTime(per * (i === 0 ? 1.1 : 1), t, (c.att ?? attack) / 3);
        v.midi = midis[i];
      } else v.g.gain.setTargetAtTime(0, t, 0.5);
    }
    const fc = c.cutoff * bright;
    if (c.brass) { // CS-80 brass swell: filter opens with the chord, pitch leans in
      this.filter.frequency.setTargetAtTime(fc * 0.25, t, 0.02);
      this.filter.frequency.setTargetAtTime(fc * 1.8, t + 0.05, attack * 0.35);
      this.filter.frequency.setTargetAtTime(fc, t + attack, 1.2);
    } else this.filter.frequency.setTargetAtTime(fc, t, 1.5);
    this.cur = midis.slice(0, n);
  }
  vowel(t, v, tc = 2) { if (!this.formants) return; const F = VOWELS[v] || VOWELS.a; this.formants.forEach((f, k) => f.frequency.setTargetAtTime(F[k], t, tc)); }
  bright(t, x, tc = 2) { this.filter.frequency.setTargetAtTime(clamp(this.cfg.cutoff * x, 60, this.ctx.sampleRate * 0.45), t, tc); }
  release(t, tc = 1.5) { for (const v of this.voices) v.g.gain.setTargetAtTime(0, t, tc); }
  stop(t) {
    this.release(t, 0.8);
    const end = t + 5;
    for (const v of this.voices) for (const o of v.oscs) { try { o.stop(end); } catch (_) { /* ignore */ } }
    try { this.lfo.stop(end); } catch (_) { /* ignore */ }
    const nodes = [this.filter, this.out, this.lfoG, ...(this.formants || []), ...this.voices.flatMap((v) => [v.g, v.pan])];
    this.voices[0].oscs[0].onended = () => { for (const n of nodes) try { n.disconnect(); } catch (_) { /* ignore */ } };
  }
}

// ------------------------------------------------------------------ MonoVoice
const MONO = {
  duduk: { wave: 'reed', lp: 2600, q: 0.8, form: [[620, 3, 1.4], [1250, 4, 0.8], [2600, 5, 0.3]], vib: 5.2, vibD: 18, breath: 0.07, breathF: 1500, att: 0.14, rel: 0.25, scoop: -70, glide: 0.09, lvl: 0.9 },
  flute: { wave: 'flute', lp: 5200, q: 0.3, vib: 5.0, vibD: 12, breath: 0.12, breathF: 2600, att: 0.08, rel: 0.18, scoop: -25, glide: 0.06, lvl: 0.8 },
  whistle: { wave: 'flute', lp: 7000, q: 0.3, vib: 5.8, vibD: 16, breath: 0.05, breathF: 3500, att: 0.05, rel: 0.12, scoop: -40, glide: 0.08, lvl: 0.55 },
  harmonica: { wave: 'reed', lp: 3200, q: 1.2, form: [[900, 2.5, 1], [2100, 3, 0.5]], vib: 6.2, vibD: 14, breath: 0.06, breathF: 2000, att: 0.05, rel: 0.12, scoop: -60, glide: 0.05, lvl: 0.55 },
  cs80: { wave: 'brass', lp: 2400, q: 3, vib: 5.4, vibD: 16, breath: 0, att: 0.28, rel: 0.9, scoop: -30, glide: 0.35, lvl: 0.55, fenv: 2.2 },
  theremin: { wave: 'flute', lp: 4000, q: 0.4, vib: 6.4, vibD: 40, breath: 0, att: 0.12, rel: 0.3, scoop: 0, glide: 0.18, lvl: 0.7 },
  horn: { wave: 'brass', lp: 1100, q: 0.8, vib: 4.8, vibD: 6, breath: 0.02, breathF: 900, att: 0.22, rel: 0.5, scoop: -20, glide: 0.12, lvl: 0.9, fenv: 1.6 },
  cello: { wave: 'saw', lp: 1900, q: 1.2, form: [[480, 2, 1], [1400, 2.5, 0.4]], vib: 5.3, vibD: 17, breath: 0.03, breathF: 3000, att: 0.2, rel: 0.4, scoop: -15, glide: 0.1, lvl: 0.55 },
  lead: { wave: 'square', lp: 2400, q: 1.5, vib: 5.5, vibD: 10, breath: 0, att: 0.03, rel: 0.25, scoop: 0, glide: 0.07, lvl: 0.35, fenv: 1.5 },
  bowed: { wave: 'glass', lp: 3000, q: 8, vib: 0.4, vibD: 8, breath: 0.25, breathF: 0, att: 1.2, rel: 2.5, scoop: 0, glide: 0.6, lvl: 0.7 },
};

export class MonoVoice {
  constructor(ctx, strip, timbre = 'flute', t = ctx.currentTime) {
    const c = this.cfg = MONO[timbre] || MONO.flute; this.ctx = ctx; this.timbre = timbre;
    const W = waves(ctx);
    this.osc = ctx.createOscillator(); this.osc.setPeriodicWave(W[c.wave] || W.flute); this.osc.frequency.value = 220;
    this.osc2 = ctx.createOscillator(); this.osc2.setPeriodicWave(W[c.wave] || W.flute); this.osc2.frequency.value = 220; this.osc2.detune.value = 4;
    const mixg = ctx.createGain(); mixg.gain.value = 0.5; this.osc.connect(mixg); this.osc2.connect(mixg);
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = c.lp; this.lp.Q.value = c.q;
    this.amp = ctx.createGain(); this.amp.gain.value = 0;
    this.lfo = ctx.createOscillator(); this.lfo.frequency.value = c.vib; this.vib = ctx.createGain(); this.vib.gain.value = 0;
    this.lfo.connect(this.vib); this.vib.connect(this.osc.detune); this.vib.connect(this.osc2.detune);
    let head = mixg;
    if (c.form) {
      const sum = ctx.createGain(); sum.gain.value = 0.35; mixg.connect(sum);
      for (const [f, q, g] of c.form) { const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q; const gg = ctx.createGain(); gg.gain.value = g * 1.6; mixg.connect(b); b.connect(gg); gg.connect(sum); }
      head = sum;
    }
    head.connect(this.lp); this.lp.connect(this.amp); this.amp.connect(strip.input);
    this.nodes = [mixg, this.lp, this.amp, this.vib, head];
    if (c.breath) {
      this.noise = ctx.createBufferSource(); this.noise.buffer = noiseBuffer(ctx, 'white'); this.noise.loop = true;
      this.bf = ctx.createBiquadFilter(); this.bf.type = 'bandpass'; this.bf.frequency.value = c.breathF || 1000; this.bf.Q.value = c.breathF ? 1.2 : 30;
      this.bg = ctx.createGain(); this.bg.gain.value = 0;
      this.noise.connect(this.bf); this.bf.connect(this.bg); this.bg.connect(this.amp);
      this.noise.start(t); this.nodes.push(this.bf, this.bg);
    }
    this.osc.start(t); this.osc2.start(t); this.lfo.start(t);
    this.lastEnd = 0; this.midi = 0;
  }
  /** Schedule one note. legato: the next note follows immediately (no release). */
  note(t, midi, dur, vel = 0.8, { legato = false, glide } = {}) {
    const c = this.cfg; const f = mtof(midi);
    const connected = this.midi && t - this.lastEnd < 0.08;
    const g = glide ?? c.glide;
    for (const o of [this.osc, this.osc2]) {
      if (connected) o.frequency.setTargetAtTime(f, t, g / 3);
      else o.frequency.setValueAtTime(f, t);
      if (c.scoop && !connected) { o.detune.setValueAtTime(c.scoop + (o === this.osc2 ? 4 : 0), t); o.detune.setTargetAtTime(o === this.osc2 ? 4 : 0, t, 0.05); }
    }
    if (this.bf && !c.breathF) this.bf.frequency.setTargetAtTime(f * 2, t, 0.02);
    const pk = vel * c.lvl;
    if (!connected) { this.amp.gain.setTargetAtTime(0, t - 0.02, 0.008); }
    this.amp.gain.setTargetAtTime(pk, t, c.att / 3);
    // delayed vibrato: bloom after ~0.35 s on long notes
    this.vib.gain.setTargetAtTime(0, t, 0.05);
    if (dur > 0.5) this.vib.gain.setTargetAtTime(c.vibD * (0.6 + 0.5 * vel), t + Math.min(0.4, dur * 0.4), 0.25);
    if (this.bg) { this.bg.gain.setTargetAtTime(c.breath * (connected ? 0.4 : 1.4), t, 0.02); this.bg.gain.setTargetAtTime(c.breath * 0.5, t + 0.08, 0.1); }
    if (c.fenv) { this.lp.frequency.setTargetAtTime(c.lp * 0.35, t, 0.01); this.lp.frequency.setTargetAtTime(c.lp * c.fenv, t + 0.02, c.att * 0.5); this.lp.frequency.setTargetAtTime(c.lp, t + c.att, 0.6); }
    const end = t + dur;
    if (!legato) { this.amp.gain.setTargetAtTime(0, end, c.rel / 3); if (this.bg) this.bg.gain.setTargetAtTime(0, end, 0.05); }
    this.lastEnd = end; this.midi = midi;
  }
  silence(t) { this.amp.gain.setTargetAtTime(0, t, 0.3); this.midi = 0; }
  stop(t) {
    this.silence(t); const end = t + 3;
    for (const o of [this.osc, this.osc2, this.lfo, this.noise]) try { o?.stop(end); } catch (_) { /* ignore */ }
    this.osc.onended = () => { for (const n of this.nodes) try { n.disconnect(); } catch (_) { /* ignore */ } };
  }
}

// ------------------------------------------------------------------ plucked / struck
const PLUCK_WAVES = new WeakMap();
function pluckWaves(ctx) {
  let w = PLUCK_WAVES.get(ctx); if (w) return w;
  const mk = (fn, N = 40) => { const re = new Float32Array(N), im = new Float32Array(N); for (let n = 1; n < N; n++) im[n] = fn(n); return ctx.createPeriodicWave(re, im); };
  w = {
    piano: mk((n) => 1 / Math.pow(n, 1.35) * (n === 1 ? 1 : 0.8 + 0.2 * Math.cos(n * 1.7))),
    harp: mk((n) => 1 / Math.pow(n, 1.8)),
    koto: mk((n) => Math.abs(Math.sin(Math.PI * n * 0.17)) / n),
    banjo: mk((n) => Math.abs(Math.sin(Math.PI * n * 0.09)) / Math.pow(n, 0.8)),
    guitar: mk((n) => Math.abs(Math.sin(Math.PI * n * 0.22)) / Math.pow(n, 1.1)),
    upright: mk((n) => [0, 1, 0.55, 0.3, 0.15, 0.08, 0.04][n] || 0, 8),
    synth: mk((n) => 1 / n),
  };
  PLUCK_WAVES.set(ctx, w);
  return w;
}

// decay (s) of the fundamental at midi 60, and pitch-dependence
const PL = {
  piano: { w: 'piano', dec: 3.2, lp: 7, lpEnd: 1.6, att: 0.003, det: 1.6, hammer: 0.1, lvl: 0.55 },
  harp: { w: 'harp', dec: 2.6, lp: 9, lpEnd: 2.5, att: 0.004, det: 0.6, lvl: 0.6 },
  koto: { w: 'koto', dec: 1.8, lp: 14, lpEnd: 3, att: 0.002, det: 0, bend: 22, lvl: 0.55 },
  oud: { w: 'koto', dec: 1.2, lp: 7, lpEnd: 2, att: 0.003, det: 3, bend: 12, lvl: 0.6 },
  banjo: { w: 'banjo', dec: 0.9, lp: 18, lpEnd: 4, att: 0.001, det: 2, lvl: 0.4 },
  guitar: { w: 'guitar', dec: 2.2, lp: 8, lpEnd: 2, att: 0.002, det: 1.2, lvl: 0.55 },
  upright: { w: 'upright', dec: 1.1, lp: 5, lpEnd: 2.4, att: 0.012, det: 0, lvl: 0.95, thump: true },
  synthBass: { w: 'synth', dec: 0.9, lp: 6, lpEnd: 1.4, att: 0.005, det: 6, q: 4, lvl: 0.55 },
  synthPluck: { w: 'synth', dec: 0.5, lp: 10, lpEnd: 1.2, att: 0.002, det: 9, q: 5, lvl: 0.35 },
};
// inharmonic modal instruments: [ratio, amp, decayScale]
const MODAL = {
  marimba: { p: [[1, 1, 1], [3.93, 0.3, 0.2], [9.2, 0.08, 0.06]], dec: 1.0, att: 0.002, lvl: 0.6 },
  kalimba: { p: [[1, 1, 1], [5.95, 0.22, 0.15], [2.02, 0.05, 0.4]], dec: 1.5, att: 0.001, lvl: 0.6 },
  bell: { p: [[1, 1, 1], [2.0, 0.45, 0.6], [2.76, 0.35, 0.45], [5.4, 0.18, 0.2], [8.93, 0.08, 0.1]], dec: 4.5, att: 0.002, lvl: 0.35 },
  celesta: { p: [[1, 1, 1], [4, 0.18, 0.25], [10, 0.04, 0.08]], dec: 2.0, att: 0.002, lvl: 0.45 },
  vibes: { p: [[1, 1, 1], [3.98, 0.25, 0.3], [9.9, 0.05, 0.08]], dec: 3.2, att: 0.003, lvl: 0.45, trem: 5.5 },
  glassBell: { p: [[1, 1, 1], [2.32, 0.4, 0.5], [4.25, 0.25, 0.3], [6.63, 0.1, 0.15]], dec: 5.0, att: 0.01, lvl: 0.3 },
};

export const PLUCKS = [...Object.keys(PL), 'rhodes', ...Object.keys(MODAL)];

/**
 * Play a plucked / struck note. Returns nothing. `quality` scales partial counts.
 */
export function pluck(ctx, strip, inst, t, midi, vel = 0.7, { pan = 0, dur = 0, bright = 1, quality = 1 } = {}) {
  if (!canVoice(vel, t)) return;
  const f = mtof(midi);
  const out = ctx.createGain(); out.gain.value = 0;
  const pn = ctx.createStereoPanner(); pn.pan.value = clamp(pan, -1, 1);
  out.connect(pn); pn.connect(strip.input);
  const pitchK = Math.pow(2, -(midi - 60) / 30); // low notes ring longer
  let stopAt;
  const nodes = [out, pn];
  if (inst === 'rhodes') { // 2-op FM electric piano with tine bark
    const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain();
    car.frequency.value = f; mod.frequency.value = f; car.detune.value = (Math.random() - 0.5) * 4;
    const idx = f * (0.9 + 2.2 * vel * vel) * bright;
    mg.gain.setValueAtTime(idx, t); mg.gain.setTargetAtTime(f * 0.25, t, 0.15);
    mod.connect(mg); mg.connect(car.frequency); car.connect(out);
    const tine = ctx.createOscillator(); tine.frequency.value = f * 7.02; const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.08 * vel, t); tg.gain.setTargetAtTime(0, t, 0.03); tine.connect(tg); tg.connect(out);
    const dec = 2.6 * pitchK;
    out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(0.5 * vel, t + 0.004);
    out.gain.setTargetAtTime(0.28 * vel, t + 0.004, 0.25);
    const rel = dur ? t + dur : t + dec * 2;
    out.gain.setTargetAtTime(0, rel, dur ? 0.12 : dec / 4);
    stopAt = rel + (dur ? 0.8 : dec);
    for (const o of [car, mod, tine]) { o.start(t); o.stop(stopAt); }
    nodes.push(mg, tg); track(car, stopAt); cleanupOnEnd(car, nodes);
    return;
  }
  const M = MODAL[inst];
  if (M) {
    const dec = M.dec * pitchK;
    const np = Math.max(1, Math.round(M.p.length * clamp(quality, 0.5, 1)));
    let first = null;
    for (let i = 0; i < np; i++) {
      const [ratio, amp, ds] = M.p[i];
      if (f * ratio > 16000) continue;
      const o = ctx.createOscillator(); o.frequency.value = f * ratio;
      const g = ctx.createGain(); const a = amp * vel * (i ? Math.pow(bright, 0.8) : 1);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a, t + M.att + i * 0.0005);
      g.gain.setTargetAtTime(0, t + M.att, dec * ds / 3.5);
      if (dur) g.gain.setTargetAtTime(0, t + dur, 0.08);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + (dur ? Math.min(dur + 0.5, dec * ds * 2.5) : dec * ds * 2.5) + 0.05);
      nodes.push(g); if (!first) { first = o; track(o, t + dec * 1.5); }
    }
    out.gain.value = M.lvl;
    if (M.trem) { // vibraphone motor tremolo
      const lfo = ctx.createOscillator(); lfo.frequency.value = M.trem; const lg = ctx.createGain(); lg.gain.value = 0.3 * M.lvl;
      lfo.connect(lg); lg.connect(out.gain); lfo.start(t); lfo.stop(t + dec * 2.5); nodes.push(lg);
    }
    if (first) cleanupOnEnd(first, nodes);
    return;
  }
  const P = PL[inst] || PL.piano;
  const W = pluckWaves(ctx);
  const dec = P.dec * pitchK;
  const o1 = ctx.createOscillator(); o1.setPeriodicWave(W[P.w]); o1.frequency.value = f;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = P.q ?? 0.6;
  const ny = ctx.sampleRate * 0.45, c0 = clamp(f * P.lp * (0.45 + 0.75 * vel) * bright, 200, ny), c1 = clamp(f * P.lpEnd, 120, ny * 0.66);
  lp.frequency.setValueAtTime(c0, t); lp.frequency.setTargetAtTime(c1, t + P.att, dec * 0.25);
  o1.connect(lp);
  const oscs = [o1];
  if (P.det && quality > 0.5) { const o2 = ctx.createOscillator(); o2.setPeriodicWave(W[P.w]); o2.frequency.value = f; o2.detune.value = P.det; o1.detune.value = -P.det * 0.5; o2.connect(lp); oscs.push(o2); }
  if (P.bend) for (const o of oscs) { o.detune.setValueAtTime(P.bend, t); o.detune.setTargetAtTime(0, t, 0.025); }
  lp.connect(out);
  out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(P.lvl * vel, t + P.att);
  out.gain.setTargetAtTime(0, t + P.att, dec / 3.2);
  if (dur) out.gain.setTargetAtTime(0, t + dur, 0.07);
  stopAt = t + (dur ? Math.min(dur + 0.4, dec * 2.2) : dec * 2.2) + 0.05;
  for (const o of oscs) { o.start(t); o.stop(stopAt); }
  nodes.push(lp);
  if ((P.hammer || P.thump) && quality > 0.4) { // hammer felt / finger thump transient
    const nb = ctx.createBufferSource(); nb.buffer = noiseBuffer(ctx, P.thump ? 'brown' : 'pink');
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = P.thump ? 180 : clamp(f * 3, 800, 5000); nf.Q.value = 1.2;
    const ng = ctx.createGain(); ng.gain.setValueAtTime((P.hammer || 0.25) * vel, t); ng.gain.setTargetAtTime(0, t, 0.008);
    nb.connect(nf); nf.connect(ng); ng.connect(out); nb.start(t, Math.random() * 3); nb.stop(t + 0.06);
    nodes.push(nf, ng);
  }
  track(o1, stopAt); cleanupOnEnd(o1, nodes);
}

/** Sample-based percussion hit. */
export function hit(ctx, strip, name, t, vel = 0.8, { pan = 0, rate = 1, variant = -1, lp = 0 } = {}) {
  if (!canVoice(vel * 0.8, t)) return;
  const b = sample(ctx, name, variant); if (!b) return;
  const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rate;
  const g = ctx.createGain(); g.gain.value = vel;
  const pn = ctx.createStereoPanner(); pn.pan.value = clamp(pan, -1, 1);
  let head = s; const nodes = [g, pn];
  if (lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; s.connect(f); head = f; nodes.push(f); }
  head.connect(g); g.connect(pn); pn.connect(strip.input);
  s.start(t); track(s, t + b.duration / rate); cleanupOnEnd(s, nodes);
}

/** Short enveloped tone grain (granular shimmer, sparkles, stars twinkling). */
export function grain(ctx, strip, t, midi, dur, vel, pan = 0, wave = 'sine') {
  if (!canVoice(vel * 0.5, t)) return;
  const o = ctx.createOscillator();
  if (wave === 'sine' || wave === 'triangle') o.type = wave; else o.setPeriodicWave(waves(ctx)[wave] || waves(ctx).glass);
  o.frequency.value = mtof(midi);
  o.detune.value = (Math.random() - 0.5) * 8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + dur * 0.35); g.gain.linearRampToValueAtTime(0, t + dur);
  const pn = ctx.createStereoPanner(); pn.pan.value = clamp(pan, -1, 1);
  o.connect(g); g.connect(pn); pn.connect(strip.input);
  o.start(t); o.stop(t + dur + 0.02); track(o, t + dur); cleanupOnEnd(o, [g, pn]);
}
