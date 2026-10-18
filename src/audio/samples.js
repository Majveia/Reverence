// Procedurally synthesized one-shot buffers (AUDIO track).
// Percussion, footsteps, foley, nature sounds are rendered ONCE per context in plain JS DSP and then
// played through cheap AudioBufferSourceNodes (random rate/gain/filter per hit → no repetition).
// Generated lazily on first use; a handful of variants per name.
import { rng, OnePole, Biquad } from './dsp.js';

const TAU = Math.PI * 2;

function buf(sr, sec) { return new Float32Array(Math.max(1, Math.floor(sr * sec))); }
function expEnv(t, d) { return Math.exp(-t / d); }
function att(t, a) { return t < a ? t / a : 1; }
function norm(x, peak = 0.9) { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); if (m > 0) { const k = peak / m; for (let i = 0; i < x.length; i++) x[i] *= k; } return x; }
function fadeOut(x, sr, sec = 0.01) { const n = Math.min(x.length, Math.floor(sr * sec)); for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n; return x; }

// metallic 808-style partial set
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
function metal(sr, sec, mult, decay, hpF, bpF, r) {
  const x = buf(sr, sec); const bp = new Biquad(sr, 'bp', bpF, 0.8); const hp = new Biquad(sr, 'hp', hpF, 0.7);
  const ph = METAL.map(() => r());
  for (let i = 0; i < x.length; i++) {
    const t = i / sr; let s = 0;
    for (let k = 0; k < METAL.length; k++) { const p = (ph[k] + METAL[k] * mult * t) % 1; s += p < 0.5 ? 1 : -1; }
    x[i] = hp.run(bp.run(s / 6)) * expEnv(t, decay);
  }
  return x;
}
function grains(x, sr, r, { count, t0 = 0, t1, f = 2500, q = 2, amp = 1, decay = 0.004, envFn }) {
  const bp = new Biquad(sr, 'bp', f, q);
  const imp = new Float32Array(x.length);
  for (let g = 0; g < count; g++) {
    const t = t0 + (t1 - t0) * Math.pow(r(), 1.4);
    const i = Math.floor(t * sr); if (i >= x.length) continue;
    const a = (r() * 2 - 1) * amp * (envFn ? envFn(t) : 1);
    const n = Math.floor(decay * sr * (0.5 + r()));
    for (let j = 0; j < n && i + j < x.length; j++) imp[i + j] += a * (r() * 2 - 1) * (1 - j / n);
  }
  for (let i = 0; i < x.length; i++) x[i] += bp.run(imp[i]);
  return x;
}

const GEN = {
  // ------------------------------------------------------------ drums
  kick(sr, r) { const x = buf(sr, 0.55); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / sr; const f = 46 + 80 * Math.exp(-t / 0.035); ph += f / sr; x[i] = Math.sin(TAU * ph) * expEnv(t, 0.2) + (r() * 2 - 1) * expEnv(t, 0.003) * 0.3; } return norm(x); },
  kickSoft(sr, r) { const x = buf(sr, 0.45); const lp = new OnePole(sr, 900); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / sr; const f = 52 + 45 * Math.exp(-t / 0.04); ph += f / sr; x[i] = Math.sin(TAU * ph) * expEnv(t, 0.16) * att(t, 0.004) + lp.run((r() * 2 - 1) * expEnv(t, 0.012)) * 0.4; } return norm(x, 0.8); },
  brushSwish(sr, r) { const x = buf(sr, 0.42); const bp = new Biquad(sr, 'bp', 4000, 0.6); for (let i = 0; i < x.length; i++) { const t = i / sr; bp.set(2500 + 3500 * (t / 0.42), 0.55); const e = Math.sin(Math.PI * Math.min(1, t / 0.4)) ** 1.5 * (0.7 + 0.3 * Math.sin(t * 90 + r() * 0.3)); x[i] = bp.run(r() * 2 - 1) * e; } return norm(x, 0.6); },
  brushTap(sr, r) { const x = buf(sr, 0.12); const hp = new Biquad(sr, 'hp', 2200, 0.7); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = hp.run(r() * 2 - 1) * expEnv(t, 0.022) + Math.sin(TAU * 185 * t) * expEnv(t, 0.02) * 0.35; } return norm(x, 0.6); },
  ride(sr, r) { const x = metal(sr, 1.6, 2.1, 0.55, 5200, 7800, r); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] += Math.sin(TAU * 3150 * t + 0.3 * Math.sin(TAU * 4700 * t)) * expEnv(t, 0.35) * 0.08 + (r() * 2 - 1) * expEnv(t, 0.004) * 0.3; } return norm(x, 0.5); },
  hat(sr, r) { return norm(metal(sr, 0.12, 2.6, 0.028, 7000, 10000, r), 0.5); },
  hatOpen(sr, r) { return norm(metal(sr, 0.5, 2.6, 0.16, 6500, 9500, r), 0.45); },
  rim(sr, r) { const x = buf(sr, 0.09); const bp = new Biquad(sr, 'bp', 1700, 3); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = bp.run(r() * 2 - 1) * expEnv(t, 0.012) * 2 + Math.sin(TAU * 420 * t) * expEnv(t, 0.018) * 0.6; } return norm(x, 0.7); },
  snareLofi(sr, r) { const x = buf(sr, 0.3); const bp = new Biquad(sr, 'bp', 1900, 0.8); const lp = new OnePole(sr, 5200); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = lp.run(bp.run(r() * 2 - 1) * expEnv(t, 0.07) * 1.3 + Math.sin(TAU * (185 + 60 * Math.exp(-t / 0.01)) * t) * expEnv(t, 0.05) * 0.7); } return norm(x, 0.7); },
  shaker(sr, r) { const x = buf(sr, 0.14); const hp = new Biquad(sr, 'hp', 5200, 0.8); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = hp.run(r() * 2 - 1) * att(t, 0.018) * expEnv(Math.max(0, t - 0.018), 0.03); } return norm(x, 0.45); },
  dum(sr, r) { const x = buf(sr, 0.9); const lp = new OnePole(sr, 700); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / sr; ph += (68 + 22 * Math.exp(-t / 0.05)) / sr; x[i] = Math.sin(TAU * ph) * expEnv(t, 0.3) + lp.run(r() * 2 - 1) * expEnv(t, 0.025) * 0.5 + Math.sin(TAU * ph * 2.3) * expEnv(t, 0.06) * 0.15; } return norm(x, 0.85); },
  tek(sr, r) { const x = buf(sr, 0.12); const bp = new Biquad(sr, 'bp', 3400, 2); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = bp.run(r() * 2 - 1) * expEnv(t, 0.014) * 2 + Math.sin(TAU * 880 * t) * expEnv(t, 0.02) * 0.35 + Math.sin(TAU * 1340 * t) * expEnv(t, 0.012) * 0.2; } return norm(x, 0.6); },
  ka(sr, r) { const x = buf(sr, 0.1); const bp = new Biquad(sr, 'bp', 2100, 1.5); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = bp.run(r() * 2 - 1) * expEnv(t, 0.012) * 2 + Math.sin(TAU * 610 * t) * expEnv(t, 0.02) * 0.3; } return norm(x, 0.45); },
  riq(sr, r) { const x = buf(sr, 0.35); const hp = new Biquad(sr, 'hp', 5500, 0.7); const fs = [6100, 7300, 8150, 9020, 10400].map((f) => f * (0.97 + r() * 0.06)); for (let i = 0; i < x.length; i++) { const t = i / sr; let s = 0; for (const f of fs) s += Math.sin(TAU * f * t + f); const flut = 0.6 + 0.4 * Math.sin(TAU * 38 * t); x[i] = hp.run(s * 0.2 * flut + (r() * 2 - 1) * 0.3) * expEnv(t, 0.08); } return norm(x, 0.35); },
  taiko(sr, r) { const x = buf(sr, 1.8); const lp = new OnePole(sr, 400); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / sr; ph += (42 + 30 * Math.exp(-t / 0.07)) / sr; x[i] = Math.sin(TAU * ph) * expEnv(t, 0.55) + lp.run(r() * 2 - 1) * expEnv(t, 0.05) * 0.8; } return norm(x, 0.9); },
  woodblock(sr, r) { const x = buf(sr, 0.12); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = Math.sin(TAU * 1180 * t) * expEnv(t, 0.03) + Math.sin(TAU * 2690 * t) * expEnv(t, 0.012) * 0.5 + (r() * 2 - 1) * expEnv(t, 0.002) * 0.3; } return norm(x, 0.6); },
  clap(sr, r) { const x = buf(sr, 0.35); const bp = new Biquad(sr, 'bp', 1250, 1.2); for (let i = 0; i < x.length; i++) { const t = i / sr; let e = 0; for (const o of [0, 0.011, 0.023]) if (t >= o) e = Math.max(e, expEnv(t - o, 0.006)); e = Math.max(e, t > 0.03 ? expEnv(t - 0.03, 0.09) * 0.7 : 0); x[i] = bp.run(r() * 2 - 1) * e; } return norm(x, 0.6); },
  bongo(sr, r) { const x = buf(sr, 0.35); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / sr; ph += (330 + 90 * Math.exp(-t / 0.01)) / sr; x[i] = Math.sin(TAU * ph) * expEnv(t, 0.08) + (r() * 2 - 1) * expEnv(t, 0.003) * 0.4; } return norm(x, 0.6); },

  // ------------------------------------------------------------ footsteps & foley (variants via seed)
  step_grass(sr, r) { const x = buf(sr, 0.32); const lp = new OnePole(sr, 260); const bp = new Biquad(sr, 'bp', 3200 + r() * 1500, 0.8); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = lp.run(r() * 2 - 1) * expEnv(t, 0.03) * 1.6 + bp.run(r() * 2 - 1) * att(t, 0.02) * expEnv(t, 0.08) * (0.6 + 0.4 * Math.sin(t * 160 * (1 + r() * 0.1))); } grains(x, sr, r, { count: 16, t1: 0.14, f: 4200, q: 1, amp: 0.8, decay: 0.002 }); return fadeOut(norm(x, 0.7), sr); },
  step_ground(sr, r) { const x = buf(sr, 0.25); const lp = new OnePole(sr, 200); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = lp.run(r() * 2 - 1) * expEnv(t, 0.035) * 2.2 + Math.sin(TAU * (95 - 30 * t) * t) * expEnv(t, 0.03) * 0.5; } grains(x, sr, r, { count: 22, t1: 0.1, f: 2400, q: 1.5, amp: 1.1, decay: 0.003 }); return fadeOut(norm(x, 0.7), sr); },
  step_sand(sr, r) { const x = buf(sr, 0.3); const lp = new OnePole(sr, 1800); const lp2 = new OnePole(sr, 180); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = lp.run(r() * 2 - 1) * att(t, 0.03) * expEnv(t, 0.07) * 0.9 + lp2.run(r() * 2 - 1) * expEnv(t, 0.04) * 1.2; } grains(x, sr, r, { count: 60, t1: 0.16, f: 3000, q: 0.8, amp: 0.25, decay: 0.0015 }); return fadeOut(norm(x, 0.55), sr); },
  step_snow(sr, r) { const x = buf(sr, 0.36); const lp = new OnePole(sr, 220); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = lp.run(r() * 2 - 1) * expEnv(t, 0.05) * 1.2; } grains(x, sr, r, { count: 90, t1: 0.22, f: 2100, q: 1.2, amp: 0.9, decay: 0.0025, envFn: (t) => Math.sin(Math.PI * Math.min(1, t / 0.22)) }); return fadeOut(norm(x, 0.65), sr); },
  step_rock(sr, r) { const x = buf(sr, 0.2); const bp = new Biquad(sr, 'bp', 2000 + r() * 1400, 3); const lp = new OnePole(sr, 300); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = bp.run(r() * 2 - 1) * expEnv(t, 0.01) * 2.5 + lp.run(r() * 2 - 1) * expEnv(t, 0.025) * 1.5; } grains(x, sr, r, { count: 8, t0: 0.02, t1: 0.12, f: 3500, q: 2, amp: 0.6, decay: 0.003 }); return fadeOut(norm(x, 0.7), sr); },
  step_wood(sr, r) { const x = buf(sr, 0.25); const bp = new Biquad(sr, 'bp', 320 + r() * 120, 5); const bp2 = new Biquad(sr, 'bp', 1150, 4); for (let i = 0; i < x.length; i++) { const t = i / sr; const n = (r() * 2 - 1) * expEnv(t, 0.006); x[i] = bp.run(n) * 5 + bp2.run(n) * 2; } return fadeOut(norm(x, 0.7), sr); },
  step_metal(sr, r) { const x = buf(sr, 0.45); const f0 = 480 + r() * 200; for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = (Math.sin(TAU * f0 * t) * 0.5 + Math.sin(TAU * f0 * 2.63 * t) * 0.35 + Math.sin(TAU * f0 * 4.9 * t) * 0.2) * expEnv(t, 0.08) + (r() * 2 - 1) * expEnv(t, 0.004); } return fadeOut(norm(x, 0.6), sr); },
  step_water(sr, r) { const x = buf(sr, 0.4); const bp = new Biquad(sr, 'bp', 900, 0.7); for (let i = 0; i < x.length; i++) { const t = i / sr; bp.set(700 + 2200 * Math.exp(-t / 0.06), 0.7); x[i] = bp.run(r() * 2 - 1) * att(t, 0.01) * expEnv(t, 0.08); } for (let b = 0; b < 3; b++) { const t0 = 0.03 + r() * 0.2, f = 500 + r() * 700, n = Math.floor(sr * 0.03), i0 = Math.floor(t0 * sr); for (let j = 0; j < n && i0 + j < x.length; j++) { const t = j / sr; x[i0 + j] += Math.sin(TAU * f * (1 + 8 * t) * t) * expEnv(t, 0.008) * 0.4; } } return fadeOut(norm(x, 0.6), sr); },
  thud(sr, r) { const x = buf(sr, 0.6); const lp = new OnePole(sr, 180); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / sr; ph += (38 + 55 * Math.exp(-t / 0.05)) / sr; x[i] = Math.sin(TAU * ph) * expEnv(t, 0.12) + lp.run(r() * 2 - 1) * expEnv(t, 0.06) * 2; } grains(x, sr, r, { count: 30, t0: 0.01, t1: 0.35, f: 2600, q: 1, amp: 0.35, decay: 0.004 }); return fadeOut(norm(x, 0.85), sr); },
  cloth(sr, r) { const x = buf(sr, 0.5); const bp = new Biquad(sr, 'bp', 900, 0.6); for (let i = 0; i < x.length; i++) { const t = i / sr; const flap = 0.5 + 0.5 * Math.sin(TAU * (26 - 20 * t) * t); x[i] = bp.run(r() * 2 - 1) * att(t, 0.02) * expEnv(t, 0.12) * flap; } return fadeOut(norm(x, 0.6), sr); },
  whoosh(sr, r) { const x = buf(sr, 1.1); const bp = new Biquad(sr, 'bp', 400, 0.9); for (let i = 0; i < x.length; i++) { const t = i / sr, u = t / 1.1; bp.set(300 + 2600 * Math.sin(Math.PI * Math.pow(u, 0.7)), 0.9); x[i] = bp.run(r() * 2 - 1) * Math.pow(Math.sin(Math.PI * u), 2); } return norm(x, 0.7); },
  splash(sr, r) { const x = buf(sr, 1.0); const bp = new Biquad(sr, 'bp', 1500, 0.5); for (let i = 0; i < x.length; i++) { const t = i / sr; bp.set(500 + 3000 * Math.exp(-t / 0.15), 0.5); x[i] = bp.run(r() * 2 - 1) * att(t, 0.005) * expEnv(t, 0.2); } for (let b = 0; b < 10; b++) { const t0 = 0.05 + r() * 0.7, f = 350 + r() * 900, n = Math.floor(sr * 0.04), i0 = Math.floor(t0 * sr); for (let j = 0; j < n && i0 + j < x.length; j++) { const t = j / sr; x[i0 + j] += Math.sin(TAU * f * (1 + 6 * t) * t) * expEnv(t, 0.01) * 0.25 * (1 - t0); } } return fadeOut(norm(x, 0.8), sr); },
  bubble(sr, r) { const x = buf(sr, 0.08); const f = 300 + r() * 700; let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / sr; ph += f * (1 + 10 * t) / sr; x[i] = Math.sin(TAU * ph) * att(t, 0.002) * expEnv(t, 0.015); } return norm(x, 0.5); },
  clunk(sr, r) { const x = buf(sr, 0.5); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = (Math.sin(TAU * 170 * t) * 0.8 + Math.sin(TAU * 437 * t) * 0.4 + Math.sin(TAU * 1130 * t) * 0.2) * expEnv(t, 0.09) + (r() * 2 - 1) * expEnv(t, 0.005) * 0.8; } return fadeOut(norm(x, 0.7), sr); },
  impact(sr, r) { const x = buf(sr, 0.9); const lp = new OnePole(sr, 900); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = lp.run(r() * 2 - 1) * expEnv(t, 0.08) * 1.5 + Math.sin(TAU * (60 + 40 * Math.exp(-t / 0.03)) * t) * expEnv(t, 0.15) + (Math.sin(TAU * 713 * t) + Math.sin(TAU * 1597 * t) * 0.6) * expEnv(t, 0.12) * 0.25; } grains(x, sr, r, { count: 40, t1: 0.5, f: 3000, q: 1, amp: 0.5, decay: 0.006 }); return fadeOut(norm(x, 0.9), sr); },

  // ------------------------------------------------------------ nature
  chirp(sr, r) { const x = buf(sr, 0.16); const f = 4300 + r() * 900; const pulses = 3 + Math.floor(r() * 2); for (let p = 0; p < pulses; p++) { const i0 = Math.floor((p * 0.034) * sr), n = Math.floor(0.018 * sr); for (let j = 0; j < n && i0 + j < x.length; j++) { const t = j / sr; x[i0 + j] += Math.sin(TAU * f * t) * Math.sin(Math.PI * j / n) * (1 + 0.3 * Math.sin(TAU * 300 * t)); } } return norm(x, 0.5); },
  croak(sr, r) { const x = buf(sr, 0.45); const f = 170 + r() * 160; const bp = new Biquad(sr, 'bp', f * 3, 3); const rate = 22 + r() * 20; let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / sr; ph += f * (1 - 0.1 * t) / sr; const saw = (ph % 1) * 2 - 1; const am = Math.max(0, Math.sin(TAU * rate * t)) ** 2; x[i] = bp.run(saw) * am * Math.sin(Math.PI * t / 0.45); } return norm(x, 0.55); },
  drip(sr, r) { const x = buf(sr, 0.05); const f = 2200 + r() * 1800; let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / sr; ph += f * (1 + 4 * t) / sr; x[i] = Math.sin(TAU * ph) * expEnv(t, 0.006) + (r() * 2 - 1) * expEnv(t, 0.0015) * 0.5; } return norm(x, 0.4); },
  thunder(sr, r) {
    const n = Math.floor(sr * 7), L = new Float32Array(n), R = new Float32Array(n);
    const lpL = new OnePole(sr, 900), lpR = new OnePole(sr, 900), lpS = new OnePole(sr, 60), crack = new Biquad(sr, 'hp', 1500, 0.7);
    const onsets = [0]; for (let k = 0; k < 5; k++) onsets.push(0.15 + r() * 2.5);
    for (let i = 0; i < n; i++) {
      const t = i / sr; let e = 0;
      for (const o of onsets) if (t >= o) e += expEnv(t - o, 0.4 + o * 0.4) * att(t - o, 0.03) * (o === 0 ? 1 : 0.55);
      e = e * 0.6 + expEnv(t, 2.2) * att(t, 0.4) * 0.6;
      lpL.set(sr, 120 + 900 * Math.exp(-t / 1.2)); lpR.set(sr, 120 + 900 * Math.exp(-t / 1.25));
      const c = crack.run(r() * 2 - 1) * expEnv(t, 0.08) * 0.4;
      const sub = lpS.run(r() * 2 - 1) * 6;
      L[i] = lpL.run(r() * 2 - 1) * e * 2 + c + sub * e; R[i] = lpR.run(r() * 2 - 1) * e * 2 + c * 0.8 + sub * e;
    }
    norm(L, 0.9); norm(R, 0.9); return [L, R];
  },
  bell(sr, r) { // church/temple bell (Risset partials), base 1 Hz-normalised to ~196 Hz
    const x = buf(sr, 6); const P = [[0.56, 1, 1.5], [0.92, 0.67, 1.2], [1.19, 1, 0.9], [1.71, 1.8, 0.7], [2, 2.67, 0.6], [2.74, 1.67, 0.45], [3, 1.46, 0.35], [3.76, 1.33, 0.25], [4.07, 1.33, 0.2]];
    const f0 = 196; for (let i = 0; i < x.length; i++) { const t = i / sr; let s = 0; for (const [m, a, d] of P) s += Math.sin(TAU * f0 * m * t + m) * a * expEnv(t, d * 2.2); x[i] = s * att(t, 0.003) + (r() * 2 - 1) * expEnv(t, 0.004) * 0.6; }
    return norm(x, 0.8);
  },
  crackle(sr, r) { const x = buf(sr, 4); const lp = new OnePole(sr, 3000); for (let i = 0; i < x.length; i++) { x[i] = lp.run(r() * 2 - 1) * 0.05; if (r() < 12 / sr) { const a = (r() * 2 - 1) * (0.3 + r() * 0.7); for (let j = 0; j < 30 && i + j < x.length; j++) x[i + j] += a * Math.exp(-j / 4); } } return x; },
  tick(sr, r) { const x = buf(sr, 0.08); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = (Math.sin(TAU * 2950 * t) * 0.6 + Math.sin(TAU * 1480 * t) * 0.5) * expEnv(t, 0.012) * att(t, 0.001); } return norm(x, 0.5); },
  // rhythmic machine clank (industrial settlements)
  clank(sr, r) { const x = buf(sr, 0.9); const f0 = 210 + r() * 120; for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = (Math.sin(TAU * f0 * t) * 0.6 + Math.sin(TAU * f0 * 2.76 * t) * 0.4 + Math.sin(TAU * f0 * 5.4 * t) * 0.3) * expEnv(t, 0.18) + (r() * 2 - 1) * expEnv(t, 0.006) * 0.7; } return fadeOut(norm(x, 0.6), sr); },
};

const VARIANTS = { step_grass: 6, step_ground: 6, step_sand: 5, step_snow: 5, step_rock: 6, step_wood: 4, step_metal: 4, step_water: 4, chirp: 4, croak: 4, drip: 6, bubble: 6, hat: 2, brushTap: 3, tek: 3, ka: 2, shaker: 3, clank: 3 };

const STORE = new WeakMap();

/** Get a variant AudioBuffer for a sample name (lazy, cached). */
export function sample(ctx, name, variant = -1) {
  let s = STORE.get(ctx); if (!s) { s = new Map(); STORE.set(ctx, s); }
  let list = s.get(name);
  if (!list) {
    const g = GEN[name]; if (!g) return null;
    const nv = VARIANTS[name] || 1;
    list = [];
    for (let v = 0; v < nv; v++) {
      const r = rng(0x51ed + v * 7919 + name.length * 131 + name.charCodeAt(0) * 17);
      const out = g(ctx.sampleRate, r);
      const chans = Array.isArray(out) ? out : [out];
      const b = ctx.createBuffer(chans.length, chans[0].length, ctx.sampleRate);
      chans.forEach((c, i) => b.copyToChannel(c, i));
      list.push(b);
    }
    s.set(name, list);
  }
  return list[variant >= 0 ? variant % list.length : Math.floor(Math.random() * list.length)];
}

export const SAMPLE_NAMES = Object.keys(GEN);
