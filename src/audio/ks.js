// Karplus-Strong plucked strings (AUDIO track): koto, shamisen, felt-muted guitar.
// Each (instrument, pitch) is rendered ONCE per AudioContext in plain JS (a real KS delay-line loop with a
// fractional all-pass tuner, a brightness-controlled loop filter and pluck-position comb), then played through
// AudioBufferSourceNodes: playbackRate bends give the koto's oshi-de press and the shamisen's suri slides.
// A native DelayNode loop cannot do this (its minimum feedback delay is one 128-sample render quantum).
import { rng, mtof, clamp, cleanupOnEnd } from './dsp.js';

// t60: seconds to fall 60 dB at midi 60 (lower strings ring longer) · bright 0..1 · pick: pluck position along
// the string (0.5 = middle, small = near the bridge, nasal) · buzz: sawari (shamisen bridge buzz) · body: [f, q, gain]
export const KS = {
  koto: { t60: 3.4, bright: 0.62, pick: 0.13, buzz: 0.0, dur: 3.2, lvl: 0.7, body: [[340, 1.6, 0.35], [1150, 2.4, 0.18]] },
  shamisen: { t60: 0.85, bright: 0.85, pick: 0.09, buzz: 0.55, dur: 1.3, lvl: 0.62, body: [[240, 2.2, 0.5], [2600, 3, 0.15]] },
  biwa: { t60: 1.8, bright: 0.55, pick: 0.11, buzz: 0.35, dur: 2.2, lvl: 0.65, body: [[200, 1.8, 0.4]] },
  nylon: { t60: 2.6, bright: 0.38, pick: 0.2, buzz: 0, dur: 2.6, lvl: 0.62, body: [[110, 1.4, 0.3], [220, 2, 0.2]] },
};

const STORE = new WeakMap();

function render(sr, inst, midi) {
  const c = KS[inst] || KS.koto;
  const f = mtof(midi);
  const pitchK = Math.pow(2, -(midi - 60) / 24);
  const t60 = c.t60 * pitchK;
  const n = Math.floor(sr * Math.min(c.dur * pitchK + 0.2, 4.5));
  const out = new Float32Array(n);
  const r = rng(0x5eed ^ (midi * 131) ^ inst.length * 7);
  // loop filter H(z) = (1-S) + S z^-1 (phase delay S); smaller S → brighter
  const S = clamp(0.5 - 0.42 * c.bright, 0.05, 0.5);
  const L = sr / f - S;
  const N = Math.max(2, Math.floor(L - 0.001));
  const frac = L - N;
  const C = (1 - frac) / (1 + frac);            // first-order all-pass fractional tuner
  const g = Math.pow(10, -3 / (t60 * f));        // loss per period
  const buf = new Float32Array(N);
  // excitation: lowpassed noise burst, comb-filtered by the pluck position
  let lp = 0; const a = 0.35 + 0.6 * c.bright;
  for (let i = 0; i < N; i++) { lp += a * ((r() * 2 - 1) - lp); buf[i] = lp; }
  const pk = Math.max(1, Math.round(c.pick * N));
  const tmp = buf.slice();
  for (let i = 0; i < N; i++) buf[i] = tmp[i] - 0.9 * tmp[(i - pk + N) % N];
  let mean = 0; for (let i = 0; i < N; i++) mean += buf[i]; mean /= N; for (let i = 0; i < N; i++) buf[i] -= mean;
  let idx = 0, prev = 0, apX = 0, apY = 0;
  for (let i = 0; i < n; i++) {
    const x = buf[idx];
    const y = ((1 - S) * x + S * prev) * g; prev = x;
    // all-pass: v = C*y + apX - C*apY
    const v = C * y + apX - C * apY; apX = y; apY = v;
    buf[idx] = v;
    idx++; if (idx >= N) idx = 0;
    out[i] = x;
  }
  // sawari: a bridge buzz — rectified energy re-injected as upper partials that follow the string's envelope
  if (c.buzz > 0) {
    let hp = 0, last = 0;
    for (let i = 0; i < n; i++) { const x = out[i]; const b = Math.abs(x) * x * 2.2; hp = 0.92 * (hp + b - last); last = b; out[i] = x + c.buzz * hp; }
  }
  // body resonances (wood / skin)
  if (c.body) {
    const dry = out.slice();
    for (const [bf, q, bg] of c.body) {
      const w = 2 * Math.PI * bf / sr, al = Math.sin(w) / (2 * q), cw = Math.cos(w);
      const b0 = al / (1 + al), a1 = -2 * cw / (1 + al), a2 = (1 - al) / (1 + al);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < n; i++) { const x = dry[i]; const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] += y * bg * 2; }
    }
  }
  // gentle fade at the end, normalise
  const fo = Math.min(n, Math.floor(sr * 0.08)); for (let i = 0; i < fo; i++) out[n - 1 - i] *= i / fo;
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(out[i])); if (m > 0) for (let i = 0; i < n; i++) out[i] *= 0.9 / m;
  return out;
}

function buffer(ctx, inst, midi) {
  let s = STORE.get(ctx); if (!s) { s = new Map(); STORE.set(ctx, s); }
  const key = inst + ':' + midi;
  let b = s.get(key);
  if (!b) {
    const d = render(ctx.sampleRate, inst, midi);
    b = ctx.createBuffer(1, d.length, ctx.sampleRate); b.copyToChannel(d, 0);
    s.set(key, b);
  }
  return b;
}

export const KS_INSTS = Object.keys(KS);

/**
 * Play a KS string note into `dest` (a node). opts: pan, dur (damp after), bend (semitones press after the pluck,
 * koto oshi-de), slide (semitones the note slides INTO, shamisen suri), bachi (shamisen plectrum snap 0..1), bright.
 * Returns the end time (or 0 when no voice was available).
 */
export function ksPluck(ctx, dest, inst, t, midi, vel = 0.7, o = {}) {
  const c = KS[inst] || KS.koto;
  const m = Math.round(midi);
  const b = buffer(ctx, inst, m);
  const s = ctx.createBufferSource(); s.buffer = b;
  const rate0 = Math.pow(2, (midi - m) / 12);
  s.playbackRate.setValueAtTime(rate0 * (o.slide ? Math.pow(2, -o.slide / 12) : 1), t);
  if (o.slide) s.playbackRate.setTargetAtTime(rate0, t + 0.01, 0.035);
  if (o.bend) { s.playbackRate.setTargetAtTime(rate0 * Math.pow(2, o.bend / 12), t + (o.bendAt ?? 0.18), 0.06); }
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
  lp.frequency.value = clamp(mtof(midi) * (3 + 14 * vel * (o.bright ?? 1)), 400, ctx.sampleRate * 0.45); lp.Q.value = 0.5;
  const g = ctx.createGain(); g.gain.value = c.lvl * vel;
  const p = ctx.createStereoPanner(); p.pan.value = clamp(o.pan || 0, -1, 1);
  s.connect(lp); lp.connect(g); g.connect(p); p.connect(dest);
  const nodes = [lp, g, p];
  let end = t + b.duration / rate0;
  if (o.dur) { g.gain.setTargetAtTime(0, t + o.dur, 0.06); end = Math.min(end, t + o.dur + 0.4); }
  // bachi: the plectrum strikes string AND skin — a bright click plus a short membrane "pa"
  if (o.bachi) {
    const k = o.bachi * vel;
    const n = ctx.createBufferSource(); n.buffer = clickBuf(ctx);
    const ng = ctx.createGain(); ng.gain.value = 0.55 * k;
    n.connect(ng); ng.connect(p); n.start(t); nodes.push(ng);
    cleanupOnEnd(n, [ng]);
  }
  s.start(t); s.stop(end + 0.05);
  cleanupOnEnd(s, nodes);
  return end;
}

const CLICK = new WeakMap();
function clickBuf(ctx) {
  let b = CLICK.get(ctx); if (b) return b;
  const sr = ctx.sampleRate, n = Math.floor(sr * 0.07), d = new Float32Array(n), r = rng(77);
  let hp = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, w = r() * 2 - 1;
    hp = 0.6 * (hp + w - last); last = w;
    d[i] = hp * Math.exp(-t / 0.004) * 0.9 + Math.sin(2 * Math.PI * (210 + 90 * Math.exp(-t / 0.01)) * t) * Math.exp(-t / 0.022) * 0.6;
  }
  b = ctx.createBuffer(1, n, sr); b.copyToChannel(d, 0); CLICK.set(ctx, b);
  return b;
}
