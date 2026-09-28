// Ambience beds (AUDIO track). Lazily-built native-node chains driven by smoothed world params:
//   wind (low roar + gusting whistle + speed rush) · ocean (roar + scheduled breaking waves & backwash)
//   rain (hiss + body + drops) · thunder (on lightning flashes) · night insects (crickets, frogs)
//   day cicadas · procedural birdsong (per-world species; alien warbles on exotic worlds)
//   distant creature calls (whale-like moans, herd bellows) · settlement murmur + per-style city
//   flavour (bells, chimes, neon hum & spinner fly-bys, industrial clanks, horns) · underwater
//   (bubbles, pressure rumble) · space (beating deep hum, radio shimmer, whistlers, morse, pulsars)
import { noiseBuffer, rng, clamp, mtof, setT } from './dsp.js';
import { sample } from './samples.js';
import { pluck, Strip } from './instruments.js';

export class Ambience {
  constructor(host) {
    this.host = host; this.ctx = host.ctx; this.mix = host.mix;
    this.beds = {}; this.timers = {}; this.r = rng(99); this.species = null; this.counts = {};
    this.lastFlash = 0;
    // one strip for musical ambience (chimes, bells) so it rides the ambience bus
    this.out = this.mix.ambIn; this.rev = this.mix.ambRev;
    this.chimeStrip = new Strip(this.ctx, this.mix, { gain: 0.35, rev: 0.6, dest: this.mix.ambIn, revDest: this.mix.ambRev });
  }

  setWorld(seed = 1, info = {}) {
    this.r = rng(seed ^ 0xa11ce);
    this.info = info;
    const r = this.r, alien = !!info.alien;
    // 2-4 bird species per world: base pitch, motif shape, tempo
    this.species = [];
    const n = r.int(2, 4);
    for (let i = 0; i < n; i++) {
      const base = alien ? r.range(900, 4200) : r.range(2200, 5200);
      const notes = [];
      const len = r.int(3, alien ? 9 : 7);
      const kind = r.pick(alien ? ['warble', 'sweep', 'trill', 'bubble'] : ['whistle', 'trill', 'chirp', 'sweep']);
      let tt = 0;
      for (let k = 0; k < len; k++) {
        const f0 = base * r.range(0.75, 1.3), f1 = f0 * (kind === 'sweep' ? r.range(0.5, 1.8) : kind === 'whistle' ? r.range(0.9, 1.15) : r.range(0.8, 1.25));
        const dur = kind === 'trill' ? r.range(0.03, 0.05) : kind === 'chirp' ? r.range(0.04, 0.09) : r.range(0.08, 0.35);
        notes.push([tt, f0, f1, dur]);
        tt += dur + (kind === 'trill' ? r.range(0.01, 0.025) : r.range(0.04, 0.16));
      }
      this.species.push({ kind, notes, fm: alien ? r.range(20, 90) : 0, fmD: alien ? r.range(0.05, 0.3) : 0, rate: r.range(0.6, 1.6), level: r.range(0.5, 1) });
    }
    this.creature = { kind: alien ? r.pick(['moan', 'moan', 'bellow', 'warble']) : r.pick(['moan', 'bellow', 'howl']), f: alien ? r.range(70, 220) : r.range(90, 320) };
  }

  _bed(name, build) { if (!this.beds[name]) { try { this.beds[name] = build(); } catch (e) { console.warn('[audio] bed', name, e); this.beds[name] = { gain: this.ctx.createGain(), dead: true }; } } return this.beds[name]; }
  _g(v = 0) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  _f(type, f, q = 0.7) { const n = this.ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; }
  _noise(kind, t) { const s = this.ctx.createBufferSource(); s.buffer = noiseBuffer(this.ctx, kind); s.loop = true; s.start(t, this.r() * 3.5); return s; }
  _lvl(bed, v, t, tc = 0.5) { if (!bed || bed.dead) return; if (Math.abs((bed.v ?? -1) - v) < 0.002) return; bed.v = v; bed.gain.gain.setTargetAtTime(v, t, tc); }
  _every(name, t, lo, hi) { const n = this.timers[name]; if (n === undefined) { this.timers[name] = t + this.r.range(lo, hi) * 0.5; return false; } if (t >= n) { this.timers[name] = t + this.r.range(lo, hi); return true; } return false; }
  _count(name) { this.counts[name] = (this.counts[name] || 0) + 1; }

  // ------------------------------------------------------------------ update
  update(t, dt, P) {
    const r = this.r;
    const land = P.scene === 'surface' ? 1 - P.space : 0;
    const under = P.underwater;
    const dry = land * (1 - under);

    // ---------------- wind
    const windAmt = clamp((0.25 + P.wind * 0.75) * (0.55 + clamp(P.altitude / 600, 0, 1) * 0.6) * dry + P.space * 0 , 0, 1.3);
    const W = this._bed('wind', () => {
      const gain = this._g(0); gain.connect(this.out);
      const low = this._noise('brown', t), lowF = this._f('lowpass', 300, 0.5), lowG = this._g(0.9); low.connect(lowF); lowF.connect(lowG); lowG.connect(gain);
      const mkWh = (pan) => { const s = this._noise('pink', t); const f = this._f('bandpass', 700, 6); const g = this._g(0.3); const p = this.ctx.createStereoPanner(); p.pan.value = pan; s.connect(f); f.connect(g); g.connect(p); p.connect(gain); return { f, g, p }; };
      const wh = [mkWh(-0.6), mkWh(0.6)];
      const rush = this._noise('white', t), rushHP = this._f('highpass', 500, 0.5), rushLP = this._f('lowpass', 3500, 0.5), rushG = this._g(0);
      rush.connect(rushHP); rushHP.connect(rushLP); rushLP.connect(rushG); rushG.connect(this.mix.sfxIn);
      return { gain, lowF, lowG, wh, rushG, rushLP, gust: 0.5 };
    });
    if (this._every('gust', t, 0.7, 2.6)) {
      W.gust = clamp(W.gust * 0.4 + r() * 0.8 + (r.chance(0.12) ? 0.5 : 0), 0.1, 1.4);
      const gs = W.gust * (0.4 + P.wind);
      W.lowF.frequency.setTargetAtTime(160 + 600 * gs * (1 - P.snow * 0.4), t, 0.8);
      W.lowG.gain.setTargetAtTime(0.5 + 0.6 * gs, t, 0.7);
      W.wh.forEach((w, i) => {
        w.f.frequency.setTargetAtTime(r.range(380, 1300) * (0.7 + gs * 0.6), t, r.range(0.6, 1.6));
        w.f.Q.value = 4 + r() * 6;
        w.g.gain.setTargetAtTime(clamp((gs - 0.35) * 0.55, 0, 0.5) * (i ? r.range(0.5, 1) : 1), t, 0.9);
        w.p.pan.setTargetAtTime(r.range(-0.9, 0.9), t, 2);
      });
    }
    this._lvl(W, windAmt * 0.32, t, 0.8);
    // speed / glide / fall rush (air over the ears) — also in vehicles
    const rush = clamp(P.rush, 0, 1);
    setT(W.rushG.gain, rush * rush * 0.35 * (1 - under), t, 0.25);
    setT(W.rushLP.frequency, 1500 + 5000 * rush, t, 0.3, 0.02);

    // ---------------- ocean
    const shore = P.shore * dry;
    if (shore > 0.01 || this.beds.ocean) {
      const O = this._bed('ocean', () => {
        const gain = this._g(0); gain.connect(this.out); const send = this._g(0.25); gain.connect(send); send.connect(this.rev);
        const roar = this._noise('brown', t), rf = this._f('lowpass', 380, 0.5), rg = this._g(0.6); roar.connect(rf); rf.connect(rg); rg.connect(gain);
        const mk = (pan) => {
          const s = this._noise('pink', t), f = this._f('lowpass', 400, 0.8), g = this._g(0), p = this.ctx.createStereoPanner(); p.pan.value = pan;
          const w = this._noise('white', t), wf = this._f('bandpass', 3200, 0.6), wg = this._g(0);
          s.connect(f); f.connect(g); g.connect(p); w.connect(wf); wf.connect(wg); wg.connect(p); p.connect(gain);
          return { f, g, wg };
        };
        return { gain, ch: [mk(-0.45), mk(0.4)], k: 0 };
      });
      this._lvl(O, shore * 0.55, t, 1.2);
      if (shore > 0.02 && this._every('wave', t, 4.5, 10)) {
        const c = O.ch[O.k++ % 2], big = r.range(0.5, 1) * (0.6 + P.wind * 0.6);
        const rise = r.range(1.6, 3), crash = t + rise;
        c.f.frequency.cancelScheduledValues(t); c.g.gain.cancelScheduledValues(t); c.wg.gain.cancelScheduledValues(t);
        c.f.frequency.setValueAtTime(280, t); c.f.frequency.exponentialRampToValueAtTime(900 + 1600 * big, crash);
        c.f.frequency.setTargetAtTime(500, crash + 0.3, 1.4);
        c.g.gain.setValueAtTime(0.02, t); c.g.gain.linearRampToValueAtTime(0.5 * big, crash); c.g.gain.setTargetAtTime(0.0, crash + 0.2, 1.3);
        c.wg.gain.setValueAtTime(0, t); c.wg.gain.setValueAtTime(0, crash + 0.4); c.wg.gain.linearRampToValueAtTime(0.16 * big, crash + 1.6); c.wg.gain.setTargetAtTime(0, crash + 2.2, 1.2);
        this._count('waves');
      }
    }

    // ---------------- rain / snow hush
    const rain = P.rain * land;
    if (rain > 0.01 || this.beds.rain) {
      const R = this._bed('rain', () => {
        const gain = this._g(0); gain.connect(this.out);
        const h = this._noise('white', t), hf = this._f('highpass', 1400, 0.5), pk = this._f('peaking', 4200, 0.8), hl = this._f('lowpass', 9000, 0.5); pk.gain.value = 3; const hg = this._g(0.4);
        h.connect(hf); hf.connect(pk); pk.connect(hl); hl.connect(hg); hg.connect(gain);
        const b = this._noise('pink', t), bf = this._f('lowpass', 1100, 0.5), bg = this._g(0.5); b.connect(bf); bf.connect(bg); bg.connect(gain);
        return { gain };
      });
      this._lvl(R, (0.04 + rain * 0.14) * (rain > 0.01 ? 1 : 0) * (1 - under * 0.7), t, 1.5);
      const drops = rain * 18 * dt * clamp(this.host.quality, 0.4, 1);
      if (r() < drops) { this._oneshot('drip', t + r() * 0.05, r.range(0.05, 0.25) * rain, r.range(-0.9, 0.9), r.range(0.8, 1.3)); }
    }
    // thunder on lightning flashes (with distance delay)
    const flash = P.flash || 0;
    if (flash > 0.5 && this.lastFlash <= 0.5 && land > 0.5) {
      const delay = r.range(0.4, 3.5);
      this._oneshot('thunder', t + delay, clamp(0.5 + P.storm * 0.5, 0.3, 1) * (1.2 - delay / 4), r.range(-0.4, 0.4), r.range(0.75, 1.1), 900 + (1 - delay / 4) * 3000);
      this.mix.duck('music', 0.25, t + delay, 0.2, 2, 3);
      this._count('thunder');
    }
    this.lastFlash = flash;

    // ---------------- insects & frogs (night), cicadas (hot days), birds (day)
    const lifeOK = dry * (1 - P.snow) * (1 - clamp(P.altitude / 400, 0, 1)) * (1 - rain * 0.8);
    const crickets = lifeOK * P.night * clamp(P.flora * 1.5, 0, 1) * (P.cold ? 0.1 : 1);
    if (crickets > 0.05) {
      if (!this.crickets) this.crickets = Array.from({ length: 5 }, (_, i) => ({ next: t + r() * 2, per: r.range(0.45, 1.1), rate: r.range(0.85, 1.2), pan: r.range(-0.9, 0.9), v: r.range(0.3, 1), var: i }));
      for (const c of this.crickets) {
        if (t >= c.next) { this._oneshot('chirp', c.next, 0.07 * crickets * c.v, c.pan, c.rate, 0, c.var); c.next += c.per * r.range(0.9, 1.15); if (r.chance(0.05)) c.next += r.range(2, 6); if (c.next < t) c.next = t + c.per; }
      }
    }
    const frogs = lifeOK * P.night * clamp(P.shore * 1.5 + P.wet, 0, 1) * clamp(P.flora * 2, 0, 1);
    if (frogs > 0.1 && this._every('frog', t, 0.6, 3.5)) {
      const n = r.int(1, 4), pan = r.range(-0.8, 0.8), rate = r.range(0.8, 1.15);
      for (let i = 0; i < n; i++) this._oneshot('croak', t + i * r.range(0.35, 0.6), 0.12 * frogs, pan, rate, 0, r.int(0, 3));
      this._count('frogs');
    }
    const cicadaAmt = lifeOK * (1 - P.night) * P.hot * clamp(P.flora * 2, 0, 1);
    if (cicadaAmt > 0.03 || this.beds.cicada) {
      const C = this._bed('cicada', () => {
        const gain = this._g(0); gain.connect(this.out);
        const s = this._noise('white', t), f = this._f('bandpass', 5600, 5), f2 = this._f('bandpass', 7400, 6), am = this._g(0.5), lfo = this.ctx.createOscillator(), lg = this._g(0.5);
        lfo.type = 'square'; lfo.frequency.value = 48; lfo.connect(lg); lg.connect(am.gain); lfo.start(t);
        s.connect(f); s.connect(f2); f.connect(am); f2.connect(am); const sw = this._g(0); am.connect(sw); sw.connect(gain);
        return { gain, sw };
      });
      this._lvl(C, cicadaAmt * 0.1, t, 2);
      if (this._every('cicadaSwell', t, 5, 13)) { const up = r.range(1.5, 4); C.sw.gain.cancelScheduledValues(t); C.sw.gain.setTargetAtTime(r.range(0.5, 1), t, up / 3); C.sw.gain.setTargetAtTime(0.05, t + up + r.range(1, 4), 1.2); }
    }
    const birds = lifeOK * (1 - P.night) * clamp(P.flora * 1.4, 0, 1) * (1 + P.dawn * 1.5);
    if (birds > 0.05 && this.species && this._every('bird', t, 1.2 / (0.4 + birds), 5 / (0.4 + birds))) this._bird(t + 0.05, birds);

    // ---------------- distant creatures
    if (P.fauna > 0.05 && dry > 0.5 && this._every('creature', t, 22, 60)) this._creature(t + 0.1, P);

    // ---------------- settlements
    const city = P.city * dry;
    if (city > 0.02 || this.beds.city) this._city(t, dt, city, P);

    // ---------------- underwater
    if (under > 0.02 || this.beds.under) {
      const U = this._bed('under', () => {
        const gain = this._g(0); gain.connect(this.mix.pre);
        const s = this._noise('brown', t), f = this._f('lowpass', 160, 0.7); s.connect(f); f.connect(gain);
        return { gain };
      });
      this._lvl(U, under * 0.45, t, 0.3);
      if (under > 0.5 && this._every('bubble', t, 0.25, 1.6)) { const n = r.int(1, 5); for (let i = 0; i < n; i++) this._oneshot('bubble', t + i * r.range(0.03, 0.12), 0.15, r.range(-0.7, 0.7), r.range(0.7, 1.4), 0, r.int(0, 5), this.mix.pre); }
    }

    // ---------------- space
    const sp = P.space;
    if (sp > 0.02 || this.beds.space) this._space(t, sp, P);
  }

  _oneshot(name, t, vel, pan = 0, rate = 1, lp = 0, variant = -1, dest = null) {
    const b = sample(this.ctx, name, variant); if (!b) return;
    const s = this.ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rate;
    const g = this._g(vel); const p = this.ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
    let h = s; if (lp) { const f = this._f('lowpass', lp, 0.5); s.connect(f); h = f; }
    h.connect(g); g.connect(p); p.connect(dest || this.out);
    const send = this._g(0.25); p.connect(send); send.connect(this.rev);
    s.start(t); s.addEventListener('ended', () => { for (const n of [g, p, send, h]) try { n.disconnect(); } catch (_) { /* ignore */ } });
    this._count(name);
  }

  _bird(t, amt) {
    const r = this.r, sp = r.pick(this.species), ctx = this.ctx;
    const pan = r.range(-0.95, 0.95), dist = r.range(0.25, 1), rate = sp.rate * r.range(0.95, 1.05);
    const g = this._g(0.06 * sp.level * dist * clamp(amt, 0, 1.5)); const p = ctx.createStereoPanner(); p.pan.value = pan;
    const lp = this._f('lowpass', 3000 + 6000 * dist, 0.5);
    g.connect(lp); lp.connect(p); p.connect(this.out); const send = this._g(0.5 * (1.2 - dist)); p.connect(send); send.connect(this.rev);
    const reps = r.chance(0.4) ? 2 : 1;
    let last = t;
    for (let rep = 0; rep < reps; rep++) {
      const off = rep * (sp.notes[sp.notes.length - 1][0] + 0.4) / rate;
      for (const [tt, f0, f1, dur] of sp.notes) {
        const st = t + off + tt / rate, d = dur / rate;
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(f0, st); o.frequency.exponentialRampToValueAtTime(Math.max(50, f1), st + d);
        const eg = this._g(0); eg.gain.setValueAtTime(0, st); eg.gain.linearRampToValueAtTime(1, st + d * 0.2); eg.gain.linearRampToValueAtTime(0, st + d);
        if (sp.fm) { const m = ctx.createOscillator(); m.frequency.value = sp.fm; const mg = this._g(f0 * sp.fmD); m.connect(mg); mg.connect(o.frequency); m.start(st); m.stop(st + d + 0.01); }
        o.connect(eg); eg.connect(g); o.start(st); o.stop(st + d + 0.01);
        o.addEventListener('ended', () => { try { eg.disconnect(); } catch (_) { /* ignore */ } });
        last = Math.max(last, st + d);
      }
    }
    this.host.later(() => { for (const n of [g, lp, p, send]) try { n.disconnect(); } catch (_) { /* ignore */ } }, (last - this.ctx.currentTime + 2) * 1000);
    this._count('birds');
  }

  _creature(t, P) {
    const r = this.r, ctx = this.ctx, c = this.creature;
    const dur = r.range(2.5, 5.5), f = c.f * r.range(0.85, 1.2);
    const o = ctx.createOscillator(); o.type = c.kind === 'bellow' ? 'sawtooth' : 'triangle';
    const o2 = ctx.createOscillator(); o2.type = 'sine';
    const shape = c.kind === 'howl' ? [1, 1.6, 1.5, 1.1] : c.kind === 'bellow' ? [1, 0.9, 0.85, 0.7] : c.kind === 'warble' ? [1, 1.4, 0.8, 1.3] : [1, 1.35, 1.2, 0.8];
    for (const osc of [o, o2]) {
      const k = osc === o2 ? 2.01 : 1;
      osc.frequency.setValueAtTime(f * shape[0] * k, t);
      shape.slice(1).forEach((s, i) => osc.frequency.linearRampToValueAtTime(f * s * k, t + dur * (i + 1) / (shape.length - 1)));
    }
    const bp = this._f('bandpass', f * 3, 1.2), lp = this._f('lowpass', c.kind === 'bellow' ? 700 : 2400, 0.6);
    const g = this._g(0), g2 = this._g(0.35);
    const amp = 0.05 * clamp(P.fauna * 1.5, 0.3, 1);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + dur * 0.25); g.gain.setTargetAtTime(0, t + dur * 0.7, dur * 0.12);
    if (c.kind === 'bellow' || c.kind === 'warble') { const am = ctx.createOscillator(); am.frequency.value = c.kind === 'bellow' ? 11 : 7; const ag = this._g(amp * 0.6); am.connect(ag); ag.connect(g.gain); am.start(t); am.stop(t + dur + 0.5); }
    const p = ctx.createStereoPanner(); p.pan.value = r.range(-0.8, 0.8);
    o.connect(bp); o.connect(lp); o2.connect(g2); g2.connect(lp); bp.connect(g); lp.connect(g); g.connect(p); p.connect(this.out);
    const send = this._g(0.9); p.connect(send); send.connect(this.rev);
    for (const osc of [o, o2]) { osc.start(t); osc.stop(t + dur + 1); }
    o.addEventListener('ended', () => { for (const n of [bp, lp, g, g2, p, send]) try { n.disconnect(); } catch (_) { /* ignore */ } });
    this._count('creature');
  }

  _city(t, dt, city, P) {
    const r = this.r, st = P.cityStyle || 'village';
    const C = this._bed('city', () => {
      const gain = this._g(0); gain.connect(this.out);
      const voices = [];
      for (let i = 0; i < 3; i++) {
        const s = this._noise('pink', t), f = this._f('bandpass', 380 + i * 260, 1.8), g = this._g(0), p = this.ctx.createStereoPanner(); p.pan.value = (i - 1) * 0.6;
        s.connect(f); f.connect(g); g.connect(p); p.connect(gain); voices.push({ f, g });
      }
      const low = this._noise('brown', t), lf = this._f('lowpass', 220, 0.5), lg = this._g(0.35); low.connect(lf); lf.connect(lg); lg.connect(gain);
      // neon / electrical hum (only audible on neon & industrial styles)
      const hum = this.ctx.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = st === 'industrial' ? 50 : 60;
      const hf = this._f('lowpass', 420, 2), hg = this._g(0); hum.connect(hf); hf.connect(hg); hg.connect(gain); hum.start(t);
      return { gain, voices, hg };
    });
    const murmur = (1 - P.night * 0.6) * (st === 'ruins' ? 0 : 1);
    this._lvl(C, city * 0.4, t, 1.5);
    if (this._every('syll', t, 0.09, 0.22)) for (const v of C.voices) { v.g.gain.setTargetAtTime(r.chance(0.3) ? 0.02 : r.range(0.05, 0.28) * murmur, t, 0.05); v.f.frequency.setTargetAtTime(r.range(300, 1100), t, 0.1); }
    const neon = st === 'neon' || st === 'industrial' || st === 'brutalist';
    if (this._every('hum', t, 0.08, 0.3)) setT(C.hg.gain, neon ? 0.05 * (0.6 + 0.4 * r()) * city : 0, t, 0.05);
    if (city < 0.05) return;
    // flavour events
    if ((st === 'village' || st === 'monastery' || st === 'spire' || st === 'nomad') && this._every('bell', t, 35, 80)) {
      const n = r.int(2, 6), rate = st === 'monastery' ? r.range(0.5, 0.7) : r.range(0.8, 1.2);
      for (let i = 0; i < n; i++) this._oneshot('bell', t + i * r.range(2.2, 3), 0.18 * city, r.range(-0.3, 0.3), rate, 2500);
    }
    if ((st === 'organic' || st === 'village' || st === 'nomad' || st === 'spire') && P.wind > 0.2 && this._every('chime', t, 3, 9)) {
      const base = 72 + r.pick([0, 2, 4, 7, 9]);
      for (let i = 0; i < r.int(2, 5); i++) pluck(this.ctx, this.chimeStrip, 'glassBell', t + i * r.range(0.1, 0.4), base + r.pick([0, 2, 4, 7, 9, 12]), 0.25 * city, { pan: r.range(-0.5, 0.5), quality: this.host.quality });
    }
    if (neon && this._every('flyby', t, 12, 35)) { // spinner / hover-traffic doppler pass
      const b = sample(this.ctx, 'whoosh'); const s = this.ctx.createBufferSource(); s.buffer = b;
      s.playbackRate.setValueAtTime(1.35, t); s.playbackRate.linearRampToValueAtTime(0.7, t + 1.1);
      const g = this._g(0.35 * city); const p = this.ctx.createStereoPanner(); const dir = r.chance(0.5) ? 1 : -1;
      p.pan.setValueAtTime(-dir, t); p.pan.linearRampToValueAtTime(dir, t + 1.1);
      s.connect(g); g.connect(p); p.connect(this.out); s.start(t); this._count('flyby');
    }
    if ((st === 'industrial' || st === 'brutalist') && this._every('clank', t, 8, 20)) {
      const per = r.range(1.2, 2.2), n = r.int(3, 8), rate = r.range(0.6, 1.1);
      for (let i = 0; i < n; i++) this._oneshot('clank', t + i * per, 0.12 * city, 0.3, rate, 3000, i % 3);
    }
  }

  _space(t, sp, P) {
    const r = this.r, ctx = this.ctx;
    const S = this._bed('space', () => {
      const gain = this._g(0); gain.connect(this.out);
      const hum = [36, 36.35, 54.1].map((f, i) => { const o = ctx.createOscillator(); o.frequency.value = f; const g = this._g(i === 2 ? 0.25 : 0.4); o.connect(g); g.connect(gain); o.start(t); return o; });
      const rad = this._noise('pink', t), rf = this._f('bandpass', 1400, 14), rg = this._g(0.9); rad.connect(rf); rf.connect(rg); rg.connect(gain);
      const cab = this._noise('brown', t), cf = this._f('lowpass', 140, 0.6), cg = this._g(0); cab.connect(cf); cf.connect(cg); cg.connect(gain);
      return { gain, hum, rf, cg };
    });
    this._lvl(S, sp * 0.22, t, 2);
    setT(S.cg.gain, P.inShip ? 0.7 : 0, t, 1);
    if (this._every('radioSweep', t, 3, 8)) S.rf.frequency.setTargetAtTime(r.range(700, 3200), t, r.range(1, 3));
    if (sp < 0.3) return;
    if (this._every('radioEvt', t, 9, 26)) {
      const kind = r.pick(['whistler', 'morse', 'pulsar', 'whistler']);
      const g = this._g(0.05 * sp), p = ctx.createStereoPanner(); p.pan.value = r.range(-0.7, 0.7);
      const bp = this._f('bandpass', 1500, 1.5); g.connect(bp); bp.connect(p); p.connect(this.out); const send = this._g(0.6); p.connect(send); send.connect(this.rev);
      if (kind === 'whistler') { // VLF whistler: falling tone (plasma dispersion)
        const o = ctx.createOscillator(); o.frequency.setValueAtTime(r.range(5000, 7500), t); o.frequency.exponentialRampToValueAtTime(r.range(400, 900), t + r.range(1, 2.2));
        const eg = this._g(0); eg.gain.setValueAtTime(0, t); eg.gain.linearRampToValueAtTime(1, t + 0.1); eg.gain.setTargetAtTime(0, t + 1.2, 0.4);
        o.connect(eg); eg.connect(g); o.start(t); o.stop(t + 3); bp.frequency.value = 2200; bp.Q.value = 0.5;
      } else if (kind === 'morse') {
        const o = ctx.createOscillator(); o.frequency.value = r.range(700, 1100); const eg = this._g(0); o.connect(eg); eg.connect(g);
        let tt = t; for (let i = 0; i < r.int(8, 18); i++) { const d = r.chance(0.4) ? 0.21 : 0.07; eg.gain.setValueAtTime(0.8, tt); eg.gain.setValueAtTime(0, tt + d); tt += d + (r.chance(0.2) ? 0.21 : 0.07); }
        o.start(t); o.stop(tt + 0.1);
      } else { // pulsar: regular broadband ticks
        const per = r.range(0.25, 1.1); const b = sample(ctx, 'tick');
        for (let i = 0; i < 12; i++) { const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = 0.5; s.connect(g); s.start(t + i * per); }
        bp.frequency.value = 900; bp.Q.value = 0.7;
      }
      this.host.later(() => { for (const n of [g, bp, p, send]) try { n.disconnect(); } catch (_) { /* ignore */ } }, 16000);
      this._count('radio:' + kind);
    }
  }

  debug() {
    const beds = {}; for (const [k, b] of Object.entries(this.beds)) beds[k] = b.dead ? 'dead' : +(b.v ?? 0).toFixed(3);
    return { beds, events: { ...this.counts }, species: this.species?.map((s) => s.kind), creature: this.creature?.kind };
  }
}

export { mtof };
