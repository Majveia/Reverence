// Sound effects (AUDIO track): foley one-shots, UI, discovery stings, warp transitions and
// continuous vehicle engines (hoverbike whine with doppler, rover rumble with gear shifts,
// starship thrusters / reactor / pulse drive).
import { noiseBuffer, clamp, mtof, rng, setT } from './dsp.js';
import { sample } from './samples.js';
import { Strip } from './instruments.js';

const SURF = { ground: 'step_ground', grass: 'step_grass', dirt: 'step_ground', sand: 'step_sand', snow: 'step_snow', rock: 'step_rock', stone: 'step_rock', wood: 'step_wood', metal: 'step_metal', water: 'step_water', ice: 'step_rock' };

export class Sfx {
  constructor(host) {
    this.host = host; this.ctx = host.ctx; this.mix = host.mix; this.r = rng(4242);
    this.engines = {}; this.recent = []; this.lastWhoosh = -9; this._varIdx = 0;
    this.stingStrip = new Strip(this.ctx, this.mix, { gain: 0.8, rev: 0.7, echo: 0.2, dest: this.mix.uiIn });
  }

  _log(name) { this.recent.push(name); if (this.recent.length > 12) this.recent.shift(); }
  _g(v = 0) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  _f(type, f, q = 0.7) { const n = this.ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; }

  /** Play a sample buffer through the sfx (or ui) bus. */
  buf(name, t, { vel = 0.8, rate = 1, pan = 0, lp = 0, hp = 0, dest = null, rev = 0.12, variant = -1 } = {}) {
    const b = sample(this.ctx, name, variant >= 0 ? variant : this._varIdx++); if (!b) return null;
    const s = this.ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rate;
    let h = s; const nodes = [];
    if (lp) { const f = this._f('lowpass', lp, 0.5); h.connect(f); h = f; nodes.push(f); }
    if (hp) { const f = this._f('highpass', hp, 0.5); h.connect(f); h = f; nodes.push(f); }
    const g = this._g(vel), p = this.ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
    h.connect(g); g.connect(p); p.connect(dest || this.mix.sfxIn); nodes.push(g, p);
    if (rev) { const sd = this._g(rev); p.connect(sd); sd.connect(this.mix.ambRev); nodes.push(sd); }
    s.start(t); s.addEventListener('ended', () => { for (const n of nodes) try { n.disconnect(); } catch (_) { /* ignore */ } });
    return s;
  }

  /** Noise sweep (band-pass) — whooshes, warps, thrusters. */
  sweep(t, dur, f0, f1, { vel = 0.5, q = 1.2, pan0 = 0, pan1 = 0, kind = 'pink', dest = null, curve = 'bell', rev = 0.3 } = {}) {
    const s = this.ctx.createBufferSource(); s.buffer = noiseBuffer(this.ctx, kind); s.loop = true;
    const f = this._f('bandpass', f0, q), g = this._g(0), p = this.ctx.createStereoPanner();
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    if (curve === 'bell') { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + dur * 0.55); g.gain.linearRampToValueAtTime(0, t + dur); }
    else if (curve === 'rise') { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + dur * 0.92); g.gain.linearRampToValueAtTime(0, t + dur); }
    else { g.gain.setValueAtTime(vel, t); g.gain.setTargetAtTime(0, t, dur / 4); }
    p.pan.setValueAtTime(pan0, t); p.pan.linearRampToValueAtTime(pan1, t + dur);
    s.connect(f); f.connect(g); g.connect(p); p.connect(dest || this.mix.sfxIn);
    const sd = this._g(rev); p.connect(sd); sd.connect(this.mix.ambRev);
    s.start(t, this.r() * 3); s.stop(t + dur + 0.05);
    s.addEventListener('ended', () => { for (const n of [f, g, p, sd]) try { n.disconnect(); } catch (_) { /* ignore */ } });
  }

  /** Tonal glide (sine/triangle) for risers, sub drops, UI blips. */
  tone(t, dur, f0, f1, { vel = 0.3, type = 'sine', dest = null, attack = 0.01, rev = 0.2 } = {}) {
    const o = this.ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    const g = this._g(0); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + attack); g.gain.setTargetAtTime(0, t + attack, dur / 3);
    o.connect(g); g.connect(dest || this.mix.sfxIn);
    const sd = this._g(rev); g.connect(sd); sd.connect(this.mix.ambRev);
    o.start(t); o.stop(t + dur + 0.3);
    o.addEventListener('ended', () => { for (const n of [g, sd]) try { n.disconnect(); } catch (_) { /* ignore */ } });
  }

  // ------------------------------------------------------------------ one-shots
  play(name, o = {}, t = this.ctx.currentTime) {
    const r = this.r, m = this.mix;
    this._log(name);
    switch (name) {
      case 'step': {
        const surf = this.host.P.swim > 0.5 || this.host.P.wading > 0.5 ? 'water' : (o.surface || 'ground');
        const sp = clamp((o.speed ?? 3) / 7, 0.15, 1.3);
        const side = o.side ?? (r.chance(0.5) ? 1 : -1);
        this.buf(SURF[surf] || 'step_ground', t, { vel: (0.1 + 0.2 * sp) * r.range(0.85, 1.1), rate: r.range(0.92, 1.08) * (sp > 1 ? 1.05 : 1), pan: side * 0.12, rev: 0.05, lp: 4500 + 3500 * Math.min(1, sp) });
        if (surf === 'grass' && this.host.P.flora > 0.3 && r.chance(0.5)) this.buf('step_sand', t + 0.02, { vel: 0.08 * sp, rate: 1.4, hp: 2500, rev: 0 });
        break;
      }
      case 'jump': this.buf('cloth', t, { vel: 0.25, rate: 1.35 }); this.buf(SURF[o.surface] || 'step_ground', t, { vel: 0.3, rate: 0.9 }); break;
      case 'land': {
        const k = clamp(o.intensity ?? 0.5, 0, 1);
        this.buf('thud', t, { vel: 0.25 + 0.6 * k, rate: 1.15 - 0.3 * k, rev: 0.1 });
        this.buf(SURF[o.surface] || 'step_ground', t + 0.01, { vel: 0.35 + 0.3 * k, rate: 0.85 });
        if (k > 0.6) m.duck('music', 0.15 * k, t, 0.02, 0.2, 0.8);
        break;
      }
      case 'glider': case 'glide':
        this.buf('cloth', t, { vel: o.open === false ? 0.3 : 0.55, rate: o.open === false ? 1.2 : 0.75, rev: 0.15 });
        if (o.open !== false) this.sweep(t, 0.6, 400, 1600, { vel: 0.18, q: 0.8 });
        break;
      case 'boost': this.sweep(t, 0.9, 300, 3200, { vel: 0.3 * (o.intensity ?? 0.6), q: 0.9, curve: 'bell' }); this.tone(t, 0.6, 110, 220, { vel: 0.12, type: 'triangle' }); break;
      case 'splash': { const k = clamp(o.intensity ?? 0.5, 0.1, 1); this.buf('splash', t, { vel: 0.3 + 0.5 * k, rate: 1.2 - 0.35 * k, rev: 0.2 }); break; }
      case 'vehicle.enter':
        this.buf('clunk', t, { vel: 0.5, rate: 1 }); this.buf('clunk', t + 0.12, { vel: 0.3, rate: 1.4 });
        this.tone(t + 0.15, 1.2, 80, o.type === 'ship' ? 160 : 320, { vel: 0.12, type: 'sawtooth', rev: 0.1 });
        break;
      case 'vehicle.exit':
        this.buf('clunk', t, { vel: 0.45, rate: 0.85 });
        this.tone(t, 1.0, o.type === 'ship' ? 160 : 300, 60, { vel: 0.1, type: 'sawtooth', rev: 0.1 });
        break;
      case 'takeoff':
        this.sweep(t, 3.5, 120, 900, { vel: 0.55, q: 0.6, kind: 'brown', curve: 'rise' });
        this.buf('thud', t, { vel: 0.6, rate: 0.5, rev: 0.3 });
        m.duck('music', 0.3, t, 0.1, 2.5, 2);
        break;
      case 'pulse':
        if (o.on !== false) {
          this.sweep(t, 1.6, 200, 7000, { vel: 0.35, q: 2, curve: 'rise', rev: 0.5 });
          [0, 7, 12, 19].forEach((iv, i) => this.tone(t + i * 0.08, 2.2, mtof(45 + iv), mtof(57 + iv), { vel: 0.07, type: 'sawtooth', attack: 0.4, rev: 0.6 }));
          this.tone(t + 1.5, 1.8, 90, 30, { vel: 0.5, rev: 0.3 });
          m.duck('music', 0.35, t, 0.2, 2, 2.5);
        } else { this.sweep(t, 1.4, 5000, 150, { vel: 0.3, q: 1.5, curve: 'decay' }); this.tone(t, 1.2, 220, 55, { vel: 0.12, type: 'sawtooth' }); }
        break;
      case 'impact': { const k = clamp(o.intensity ?? 0.5, 0.1, 1); this.buf('impact', t, { vel: 0.3 + 0.6 * k, rate: 1.2 - 0.4 * k, rev: 0.2 }); if (k > 0.5) m.duck('music', 0.2, t, 0.02, 0.3, 1); break; }
      case 'whoosh': {
        const k = o.gain ?? o.intensity ?? 0.6;
        this.sweep(t, 1.4, 180, 4200, { vel: 0.35 * k, q: 0.9, pan0: -0.6, pan1: 0.6 });
        this.buf('whoosh', t + 0.1, { vel: 0.3 * k, rate: r.range(0.8, 1.05), rev: 0.4 });
        this.lastWhoosh = t;
        break;
      }
      case 'warp': this._warp(t, o.intensity ?? 1); break;
      case 'arrive': this._arrive(t); break;
      case 'select': case 'ui.select': case 'ui.click':
        this.buf('tick', t, { vel: 0.35, rate: r.range(0.97, 1.03), dest: m.uiIn, rev: 0.1 });
        this.tone(t, 0.5, mtof(this._keyNote(84)), mtof(this._keyNote(84)), { vel: 0.05, dest: m.uiIn, rev: 0.4 });
        break;
      case 'ui.hover': this.buf('tick', t, { vel: 0.1, rate: 1.4, dest: m.uiIn, rev: 0 }); break;
      case 'ui.back': case 'ui.close': this.buf('tick', t, { vel: 0.3, rate: 0.72, dest: m.uiIn, rev: 0.1 }); break;
      case 'ui.open': this.buf('tick', t, { vel: 0.3, rate: 0.9, dest: m.uiIn }); this.tone(t, 0.5, mtof(this._keyNote(76)), mtof(this._keyNote(76)), { vel: 0.05, dest: m.uiIn, rev: 0.4 }); break;
      case 'photo': this.buf('tick', t, { vel: 0.5, rate: 0.6, dest: m.uiIn }); this.sweep(t + 0.02, 0.12, 6000, 2500, { vel: 0.2, curve: 'decay', dest: m.uiIn, kind: 'white' }); break;
      case 'discover': case 'discovery': {
        const kind = o.kind || 'discover';
        if (t - (this.lastSting ?? -99) < 6) { this.tone(t, 1.2, mtof(this._keyNote(88)), mtof(this._keyNote(88)), { vel: 0.05, dest: m.uiIn, rev: 0.6 }); break; }
        this.lastSting = t;
        this.host.music?.sting?.(this.stingStrip, t, kind);
        m.duck('music', 0.45, t, 0.15, 2.2, 2.5);
        break;
      }
      default:
        if (sample(this.ctx, name)) this.buf(name, t, { vel: o.gain ?? 0.5 });
        else this._log('?' + name);
    }
  }

  // ------------------------------------------------------------------ warp transition
  /**
   * Warp (director 'mode:leaving'): three layers that swell into a sustained tunnel until the arrival.
   *   1. reversed-envelope noise riser — band-pass Q 1 → 12, cutoff 200 Hz → 8 kHz, 12 dB/oct low-pass at 9 kHz
   *   2. detuned 3-saw stack on an exponential pitch curve (55 → 440 Hz), filter opening with it
   *   3. sub swell under both; the impact (40 Hz thump + convolved hit) lands on 'arrive'
   * The music bus is side-chained −6 dB for ~1.2 s; the composer re-keys to the new world on the cut.
   */
  _warp(t, k = 1) {
    const ctx = this.ctx, m = this.mix, R = 1.5;
    if (this.warpState) this._warpRelease(t, 0.05);
    const soft = t - this.lastWhoosh < 2 ? 0.55 : 1;
    const vel = 0.42 * k * soft;
    const out = this._g(1); const lp9 = this._f('lowpass', 9000, 0.707); out.connect(lp9); lp9.connect(m.sfxIn);
    const send = this._g(0.45); out.connect(send); send.connect(m.ambRev);
    const nodes = [out, lp9, send], srcs = [];
    // 1. noise riser
    const n = ctx.createBufferSource(); n.buffer = noiseBuffer(ctx, 'pink'); n.loop = true;
    const bp = this._f('bandpass', 200, 1), ng = this._g(0.0001);
    bp.frequency.setValueAtTime(200, t); bp.frequency.exponentialRampToValueAtTime(8000, t + R);
    bp.Q.setValueAtTime(1, t); bp.Q.linearRampToValueAtTime(12, t + R);
    ng.gain.setValueAtTime(0.0001, t); ng.gain.exponentialRampToValueAtTime(vel * 1.6, t + R);   // reverse-decay swell
    // tunnel: after the peak the riser settles into a resonant, slowly drifting rush
    bp.frequency.setTargetAtTime(2600, t + R, 0.5); bp.Q.setTargetAtTime(5, t + R, 0.5); ng.gain.setTargetAtTime(vel * 0.55, t + R, 0.35);
    n.connect(bp); bp.connect(ng); ng.connect(out); n.start(t, this.r() * 3); srcs.push(n); nodes.push(bp, ng);
    // 2. detuned saw stack
    const sg = this._g(0.0001), slp = this._f('lowpass', 300, 1.2);
    slp.frequency.setValueAtTime(300, t); slp.frequency.exponentialRampToValueAtTime(5200, t + R);
    sg.gain.setValueAtTime(0.0001, t); sg.gain.exponentialRampToValueAtTime(vel * 0.22, t + R * 0.9); sg.gain.setTargetAtTime(vel * 0.07, t + R, 0.4);
    for (const det of [-14, 0, 11]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.detune.value = det;
      o.frequency.setValueAtTime(55, t); o.frequency.exponentialRampToValueAtTime(440, t + R); o.frequency.setTargetAtTime(470, t + R, 1.5);
      o.connect(slp); o.start(t); srcs.push(o);
    }
    slp.connect(sg); sg.connect(out); nodes.push(sg, slp);
    // 3. sub swell
    const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.setValueAtTime(32, t); sub.frequency.exponentialRampToValueAtTime(58, t + R);
    const subG = this._g(0.0001); subG.gain.setValueAtTime(0.0001, t); subG.gain.exponentialRampToValueAtTime(vel * 0.7, t + R); subG.gain.setTargetAtTime(vel * 0.2, t + R, 0.4);
    sub.connect(subG); subG.connect(m.sfxIn); sub.start(t); srcs.push(sub); nodes.push(subG);
    m.duck('music', 0.5, t + 0.1, 0.25, 1.2, 2.4); m.duck('amb', 0.55, t + 0.3, 0.4, 1.2, 2);
    this.warpState = { t0: t, peak: t + R, srcs, nodes, gains: [ng, sg, subG], bp, vel };
    // no arrival within ~6 s (load stalled, or a warp inside one mode): fade the tunnel out on its own
    this.warpState.auto = t + R + 4.5;
    this._warpRelease(t + R + 4.5, 1.5, true);
  }

  _warpRelease(t, tc = 0.08, scheduledOnly = false) {
    const W = this.warpState; if (!W) return;
    for (const g of W.gains) { if (!scheduledOnly) g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, tc); }
    const end = t + tc * 7 + 0.05;
    for (const s of W.srcs) { try { s.stop(end); } catch (_) { /* ignore */ } }
    if (!scheduledOnly) {
      const nodes = W.nodes; W.srcs[0].onended = () => { for (const nd of nodes) try { nd.disconnect(); } catch (_) { /* ignore */ } };
      this.warpState = null;
    } else W.srcs[0].onended = () => { for (const nd of W.nodes) try { nd.disconnect(); } catch (_) { /* ignore */ } if (this.warpState === W) this.warpState = null; };
  }

  /** Arrival ('mode:enter'): the tunnel makes one last swell, then the impact lands ~100 ms after its peak. */
  _arrive(t) {
    const ctx = this.ctx, m = this.mix, W = this.warpState;
    let hit = t + 0.05;
    if (W && t < W.auto) {
      const pk = t + 0.22;
      for (const g of W.gains) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(W.vel * (g === W.gains[0] ? 1.4 : g === W.gains[2] ? 0.8 : 0.2), t, 0.07); }
      W.bp.frequency.cancelScheduledValues(t); W.bp.frequency.setTargetAtTime(7000, t, 0.1);
      this._warpRelease(pk, 0.05);
      hit = pk + 0.1;
    }
    // sub thump (≈ 40 Hz) + convolved impact + a dark, 9 kHz-limited noise bloom fading exponentially over ~1.5 s
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(72, hit); o.frequency.exponentialRampToValueAtTime(36, hit + 0.45);
    const og = this._g(0); og.gain.setValueAtTime(0, hit); og.gain.linearRampToValueAtTime(0.75, hit + 0.012); og.gain.setTargetAtTime(0, hit + 0.02, 0.32);
    o.connect(og); og.connect(m.sfxIn); o.start(hit); o.stop(hit + 2.2); o.onended = () => { try { og.disconnect(); } catch (_) { /* ignore */ } };
    this.buf('impact', hit, { vel: 0.55, rate: 0.55, rev: 0.9, lp: 5000 });
    const nb = ctx.createBufferSource(); nb.buffer = noiseBuffer(ctx, 'pink'); nb.loop = true;
    const f1 = this._f('lowpass', 9000, 0.707), f2 = this._f('lowpass', 9000, 0.707), ngn = this._g(0);
    f1.frequency.setValueAtTime(9000, hit); f1.frequency.exponentialRampToValueAtTime(350, hit + 1.5);
    ngn.gain.setValueAtTime(0, hit); ngn.gain.linearRampToValueAtTime(0.22, hit + 0.02); ngn.gain.setTargetAtTime(0, hit + 0.03, 0.3);
    const sd = this._g(0.6); nb.connect(f1); f1.connect(f2); f2.connect(ngn); ngn.connect(m.sfxIn); ngn.connect(sd); sd.connect(m.ambRev);
    nb.start(hit, this.r() * 3); nb.stop(hit + 1.8); nb.onended = () => { for (const nd of [f1, f2, ngn, sd]) try { nd.disconnect(); } catch (_) { /* ignore */ } };
    m.duck('music', 0.5, hit, 0.02, 0.6, 2.5);
    this.host.music?.sting?.(this.stingStrip, hit + 0.15, 'arrive');
  }

  _keyNote(near) { const h = this.host.music?.h; return h ? h.snap(near) : near; }

  // ------------------------------------------------------------------ engines
  _engine(type, t) {
    if (this.engines[type]) return this.engines[type];
    const ctx = this.ctx, g = this._g(0); g.connect(this.mix.sfxIn);
    const E = { type, g, oscs: [], params: {} };
    if (type === 'bike') { // turbine whine + electric hum + intake hiss
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
      const o2 = ctx.createOscillator(); o2.type = 'square';
      const o3 = ctx.createOscillator(); o3.type = 'sine';
      const bp = this._f('bandpass', 800, 2.5), lp = this._f('lowpass', 2600, 0.8), og = this._g(0.25), o2g = this._g(0.06), subg = this._g(0.12);
      o1.connect(bp); bp.connect(og); o2.connect(o2g); o2g.connect(lp); og.connect(lp); lp.connect(g); o3.connect(subg); subg.connect(g);
      const n = ctx.createBufferSource(); n.buffer = noiseBuffer(ctx, 'white'); n.loop = true;
      const nf = this._f('bandpass', 1500, 5), ng = this._g(0.12); n.connect(nf); nf.connect(ng); ng.connect(g);
      [o1, o2, o3].forEach((o) => o.start(t)); n.start(t);
      Object.assign(E, { o1, o2, o3, bp, nf, ng, lp, oscs: [o1, o2, o3, n] });
    } else if (type === 'rover') { // combustion-ish rumble with gear shifts + gravel
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
      const o2 = ctx.createOscillator(); o2.type = 'square';
      const lp = this._f('lowpass', 320, 3), og = this._g(0.4), o2g = this._g(0.15);
      const am = ctx.createOscillator(); am.frequency.value = 18; const amg = this._g(0.2); am.connect(amg); amg.connect(og.gain);
      o1.connect(og); o2.connect(o2g); o2g.connect(og); og.connect(lp); lp.connect(g);
      const n = ctx.createBufferSource(); n.buffer = noiseBuffer(ctx, 'brown'); n.loop = true;
      const nf = this._f('bandpass', 900, 0.8), ng = this._g(0); n.connect(nf); nf.connect(ng); ng.connect(g);
      [o1, o2, am].forEach((o) => o.start(t)); n.start(t);
      Object.assign(E, { o1, o2, am, lp, ng, nf, oscs: [o1, o2, am, n] });
    } else { // ship: reactor hum + thruster roar + high hiss
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 48;
      const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 72.3;
      const lp = this._f('lowpass', 240, 1.5), og = this._g(0.18); o1.connect(lp); o2.connect(lp); lp.connect(og); og.connect(g);
      const n = ctx.createBufferSource(); n.buffer = noiseBuffer(ctx, 'brown'); n.loop = true;
      const nf = this._f('lowpass', 400, 0.7), ng = this._g(0); n.connect(nf); nf.connect(ng); ng.connect(g);
      const h = ctx.createBufferSource(); h.buffer = noiseBuffer(ctx, 'white'); h.loop = true;
      const hf = this._f('highpass', 3200, 0.7), hg = this._g(0); h.connect(hf); hf.connect(hg); hg.connect(g);
      [o1, o2].forEach((o) => o.start(t)); n.start(t); h.start(t, 1.3);
      Object.assign(E, { o1, o2, lp, og, nf, ng, hg, oscs: [o1, o2, n, h] });
    }
    this.engines[type] = E;
    return E;
  }

  /** Continuous engines. v: { type, engine 0..1, speed m/s, boost 0..1, doppler factor, altitude } */
  updateEngines(t, dt, v) {
    for (const [type, E] of Object.entries(this.engines)) if (type !== v.type || v.engine <= 0.001) setT(E.g.gain, 0, t, 0.35);
    if (!v.type || v.engine <= 0.001) return;
    const E = this._engine(v.type, t);
    const sp = Math.abs(v.speed || 0), bo = v.boost || 0, en = clamp(v.engine, 0, 1), dop = clamp(v.doppler || 1, 0.75, 1.3);
    if (v.type === 'bike') {
      const f = (95 + sp * 4.2 + bo * 90) * (0.8 + 0.2 * en) * dop;
      setT(E.o1.frequency, f, t, 0.12); setT(E.o2.frequency, f * 1.5, t, 0.12); setT(E.o3.frequency, 48 + sp * 0.3, t, 0.2);
      setT(E.bp.frequency, f * 2.2, t, 0.15); setT(E.nf.frequency, 900 + sp * 45 + bo * 1500, t, 0.2);
      setT(E.ng.gain, 0.06 + 0.12 * clamp(sp / 60, 0, 1) + 0.15 * bo, t, 0.2);
      setT(E.lp.frequency, 1800 + sp * 40 + bo * 2500, t, 0.2);
      setT(E.g.gain, 0.14 + 0.2 * en + 0.12 * bo, t, 0.2);
    } else if (v.type === 'rover') {
      const gearW = 9, gear = Math.min(4, Math.floor(sp / gearW)), within = (sp - gear * gearW) / gearW;
      const rpm = 0.35 + 0.65 * (gear >= 4 ? clamp(sp / 60, 0, 1) : within) * en;
      const f = (30 + rpm * 38) * dop;
      setT(E.o1.frequency, f, t, 0.08); setT(E.o2.frequency, f * 0.5, t, 0.08); setT(E.am.frequency, f * 0.5, t, 0.1);
      setT(E.lp.frequency, 220 + rpm * 700 + bo * 400, t, 0.1);
      setT(E.ng.gain, clamp(sp / 25, 0, 1) * 0.35 * (v.grounded === false ? 0.1 : 1), t, 0.15); setT(E.nf.frequency, 500 + sp * 20, t, 0.2);
      setT(E.g.gain, 0.16 + 0.22 * en, t, 0.2);
    } else {
      const thrust = clamp(en * 0.7 + bo * 0.6, 0, 1.3);
      setT(E.nf.frequency, 180 + thrust * 1400, t, 0.2);
      setT(E.ng.gain, thrust * 0.5, t, 0.25);
      setT(E.hg.gain, bo * 0.12 + thrust * 0.03, t, 0.3);
      setT(E.o1.frequency, 48 * (1 + thrust * 0.12) * dop, t, 0.3); setT(E.o2.frequency, 72.3 * (1 + thrust * 0.15) * dop, t, 0.3);
      setT(E.lp.frequency, 200 + thrust * 300, t, 0.3);
      setT(E.g.gain, 0.18 + 0.3 * en, t, 0.3);
    }
  }

  debug() {
    const eng = {}; for (const [k, E] of Object.entries(this.engines)) eng[k] = +E.g.gain.value.toFixed(3);
    return { recent: this.recent.slice(), engines: eng, warp: this.warpState ? 'tunnel' : null };
  }
}
