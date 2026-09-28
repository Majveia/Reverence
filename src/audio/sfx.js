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
      case 'warp': {
        const k = o.intensity ?? 1;
        const soft = t - this.lastWhoosh < 2;
        this.sweep(t, 2.2, 120, 8000, { vel: (soft ? 0.18 : 0.4) * k, q: 1.4, curve: 'rise', rev: 0.6 });
        this.sweep(t + 0.2, 2.0, 60, 400, { vel: 0.35 * k, q: 0.7, kind: 'brown', curve: 'rise', rev: 0.2 });
        this.tone(t, 2.1, 110, 880, { vel: 0.08 * k, type: 'triangle', attack: 1.6, rev: 0.7 });
        m.duck('music', 0.45, t + 0.3, 0.6, 1.4, 2.5); m.duck('amb', 0.6, t + 0.5, 0.5, 1.2, 2);
        break;
      }
      case 'arrive': {
        this.tone(t, 2.5, 70, 38, { vel: 0.4, rev: 0.4 });
        this.sweep(t, 2.8, 6000, 300, { vel: 0.14, q: 0.8, curve: 'decay', rev: 0.8 });
        this.host.music?.sting?.(this.stingStrip, t, 'arrive');
        break;
      }
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
    return { recent: this.recent.slice(), engines: eng };
  }
}
