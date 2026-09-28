// DSP utilities for the procedural audio engine (AUDIO track).
// Everything here is pure JS math or WebAudio node helpers — no audio files anywhere.
//
//   rng(seed)                 deterministic PRNG (mulberry32) with helpers
//   noiseBuffer(ctx, kind)    looped white / pink / brown noise (stereo decorrelated), cached per ctx
//   impulseResponse(ctx, o)   generated stereo reverb IR: early reflections, frequency-dependent decay
//   waves(ctx)                cached PeriodicWaves (warm saw, reed, brass, organ, …)
//   satCurve(amount)          tanh waveshaper curve
//   env(param, t, …)          ADSR helpers on AudioParams
//   JS one-pole / biquad filters used by the sample synthesizer (samples.js)

export function rng(seed = 1) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const f = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (lo, hi) => lo + (hi - lo) * f();
  f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1));
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.chance = (p) => f() < p;
  f.gauss = () => { let s = 0; for (let i = 0; i < 4; i++) s += f(); return (s - 2) * 0.866; };
  f.weighted = (pairs) => { // [[value, weight], …]
    let tot = 0; for (const p of pairs) tot += p[1];
    let r = f() * tot;
    for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
    return pairs[pairs.length - 1][0];
  };
  return f;
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const dbToGain = (db) => Math.pow(10, db / 20);
export const smooth = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

// ------------------------------------------------------------------ caches per context
const CACHE = new WeakMap();
function cache(ctx) { let c = CACHE.get(ctx); if (!c) { c = {}; CACHE.set(ctx, c); } return c; }

/** Looping noise buffer (stereo, decorrelated channels). kind: white | pink | brown */
export function noiseBuffer(ctx, kind = 'white', seconds = 4) {
  const c = cache(ctx);
  const key = 'noise_' + kind;
  if (c[key]) return c[key];
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  const r = rng(kind === 'white' ? 11 : kind === 'pink' ? 23 : 37);
  const f = Math.min(n >> 3, Math.floor(ctx.sampleRate * 0.05));
  const x = new Float32Array(n + f);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < n + f; i++) {
      const w = r() * 2 - 1;
      if (kind === 'pink') { // Paul Kellet's refined pink filter
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02; x[i] = last * 3.5;
      } else x[i] = w * 0.7;
    }
    // seamless loop: the head crossfades from the samples that follow the tail
    for (let i = 0; i < n; i++) d[i] = x[i];
    for (let i = 0; i < f; i++) { const k = i / f; d[i] = x[i] * k + x[n + i] * (1 - k); }
  }
  c[key] = buf;
  return buf;
}

/** Start a looping noise source at a random offset. Returns the source node. */
export function noiseSource(ctx, kind, t = ctx.currentTime, offset = Math.random() * 3) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx, kind);
  s.loop = true;
  s.start(t, offset % 3.9);
  return s;
}

/**
 * Generated stereo impulse response.
 * o: { seconds, rt60, preDelay, damping (0 bright … 1 dark), early (0..1), width (0..1), seed, bloom }
 * Frequency-dependent decay: a one-pole low-pass whose cutoff falls over the tail (air absorption),
 * sparse early reflections, a short fade-in (bloom) for lush pads.
 */
export function impulseResponse(ctx, o = {}) {
  const sr = ctx.sampleRate;
  const seconds = o.seconds ?? 4, rt60 = o.rt60 ?? seconds * 0.8;
  const pre = Math.floor((o.preDelay ?? 0.02) * sr);
  const n = Math.floor(seconds * sr) + pre;
  const buf = ctx.createBuffer(2, n, sr);
  const r = rng(o.seed ?? 7);
  const damping = o.damping ?? 0.5, early = o.early ?? 0.4, width = o.width ?? 1;
  const bloom = Math.max(1, Math.floor((o.bloom ?? 0.03) * sr));
  const taps = [];
  const ntaps = 10 + Math.floor(early * 14);
  for (let i = 0; i < ntaps; i++) taps.push([Math.floor(r.range(0.004, 0.09) * sr), r.range(0.2, 0.9) * early * (1 - i / ntaps), r() < 0.5 ? 0 : 1]);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let lpL = 0, lpR = 0, e = 0;
  const fStart = 0.92 - damping * 0.45, fEnd = 0.25 - damping * 0.2;
  for (let i = 0; i < n - pre; i++) {
    const t = i / sr;
    const amp = Math.pow(10, -3 * t / rt60) * Math.min(1, i / bloom);
    const k = Math.max(0.02, fStart + (fEnd - fStart) * Math.min(1, t / rt60)); // lp coefficient over time
    const a = r() * 2 - 1, b = r() * 2 - 1;
    const m = (a + b) * 0.5;
    const sL = m + (a - m) * width, sR = m + (b - m) * width;
    lpL += (sL - lpL) * k; lpR += (sR - lpR) * k;
    L[i + pre] = lpL * amp; R[i + pre] = lpR * amp;
  }
  for (const [d, g, ch] of taps) { const idx = pre + d; if (idx < n) { (ch ? R : L)[idx] += g; (ch ? L : R)[Math.min(n - 1, idx + 37)] += g * 0.5; } }
  // normalize energy
  for (let i = 0; i < n; i++) e += L[i] * L[i] + R[i] * R[i];
  const norm = 1 / Math.sqrt(e / 2 + 1e-9) * 0.9;
  for (let i = 0; i < n; i++) { L[i] *= norm; R[i] *= norm; }
  return buf;
}

/** Cached PeriodicWaves with musical spectra (band-limited, no aliasing). */
export function waves(ctx) {
  const c = cache(ctx);
  if (c.waves) return c.waves;
  const mk = (fn, N = 48) => {
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) im[n] = fn(n);
    return ctx.createPeriodicWave(re, im, { disableNormalization: false });
  };
  c.waves = {
    warm: mk((n) => (1 / n) * Math.exp(-n * 0.09)),                    // soft saw (analog pad)
    saw: mk((n) => 1 / n),
    brass: mk((n) => (1 / n) * (n < 12 ? 1 : Math.exp(-(n - 12) * 0.25)) * (1 + 0.3 * (n % 2))),
    reed: mk((n) => (n % 2 ? 1 : 0.45) / Math.pow(n, 1.1) * Math.exp(-n * 0.05)), // duduk / harmonica
    organ: mk((n) => ({ 1: 1, 2: 0.6, 3: 0.35, 4: 0.3, 6: 0.18, 8: 0.14 }[n] || 0), 12),
    flute: mk((n) => (n === 1 ? 1 : n === 2 ? 0.22 : n === 3 ? 0.08 : n === 4 ? 0.03 : 0), 8),
    glass: mk((n) => (n === 1 ? 1 : n === 2 ? 0.12 : n === 3 ? 0.18 : n === 5 ? 0.06 : 0), 8),
    choir: mk((n) => (1 / Math.pow(n, 0.9)) * Math.exp(-n * 0.03)),
    square: mk((n) => (n % 2 ? 1 / n : 0)),
    pulse: mk((n) => Math.sin(Math.PI * n * 0.25) / n),                  // 25 % pulse (quirky)
    tri: mk((n) => (n % 2 ? (((n - 1) / 2) % 2 ? -1 : 1) / (n * n) : 0)),
  };
  return c.waves;
}

/** tanh saturation curve for WaveShaperNode */
export function satCurve(amount = 1, n = 1024) {
  const k = new Float32Array(n);
  const d = Math.max(0.01, amount);
  const norm = Math.tanh(d);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; k[i] = Math.tanh(x * d) / norm; }
  return k;
}

// ------------------------------------------------------------------ AudioParam envelopes
/** Attack-decay envelope with exponential decay (plucked/struck). */
export function adEnv(p, t, peak, a, d, floor = 0.0001) {
  p.cancelScheduledValues(t);
  p.setValueAtTime(floor, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setTargetAtTime(floor * 0.1, t + a, d / 4.6);
}
/** ADSR with a known duration (sustained notes). */
export function adsr(p, t, dur, peak, a, d, s, r) {
  p.cancelScheduledValues(t);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setTargetAtTime(peak * s, t + a, d / 3);
  const end = t + Math.max(dur, a + 0.01);
  p.setTargetAtTime(0, end, r / 4.6);
  return end + r;
}

/** Disconnect a set of nodes when a source ends (garbage-free voice cleanup). */
export function cleanupOnEnd(src, nodes) {
  src.addEventListener('ended', () => { for (const n of nodes) { try { n.disconnect(); } catch (_) { /* ignore */ } } });
}

// ------------------------------------------------------------------ JS filters (for samples.js)
export class OnePole {
  constructor(sr, fc, hp = false) { this.hp = hp; this.set(sr, fc); this.y = 0; }
  set(sr, fc) { this.a = 1 - Math.exp(-2 * Math.PI * fc / sr); }
  run(x) { this.y += (x - this.y) * this.a; return this.hp ? x - this.y : this.y; }
}
export class Biquad { // RBJ band-pass (constant 0 dB peak) / low-pass / high-pass
  constructor(sr, type, f, q) { this.sr = sr; this.type = type; this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(f, q); }
  set(f, q) {
    const w = 2 * Math.PI * Math.min(f, this.sr * 0.45) / this.sr, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
    let b0, b1, b2; const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    if (this.type === 'bp') { b0 = al; b1 = 0; b2 = -al; }
    else if (this.type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    else { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
  }
}

/** setTargetAtTime that skips redundant automation events (per-frame param updates stay cheap). */
export function setT(p, v, t, tc, eps = 0.003) {
  if (!Number.isFinite(v)) return;
  if (p._rv !== undefined && Math.abs(p._rv - v) <= eps * Math.max(1, Math.abs(v))) return;
  p._rv = v; p.setTargetAtTime(v, t, tc);
}
