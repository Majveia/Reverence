// Creature voices (AUDIO track): spatialized calls driven by the real fauna of the world
// (world.get('fauna').creatures). Every archetype gets its own synthesized voice, every species its
// own pitch / contour / formants / song, and every call comes from where the animal actually is:
//   bird    per-species song motifs from flocks (+ wing flutter when a flock passes close)
//   whale   humpback-like song: a per-pod theme of upsweeps, moans, cries and grunts repeated with
//           variation, answered by other pod members, drenched in reverb
//   ray     breathy low "whoom" hoots        jelly  soft inharmonic glass chimes snapped to the music key
//   fish    small surface splashes           grazer formant lows / grunts (vowel morph), herd call-and-response
//   giant   infrasonic bellows + ground-shaking footfalls   hexapod  chitter & stridulation
//   hopper  trilled bleats                    critter squeaks
// Spatialization: equal-power pan from the camera basis, inverse-distance gain, air-absorption
// low-pass, rear shading, distance-scaled reverb send, pan ramps along the animal's velocity.
// Scanning is time-sliced (host calls sense() at ~4 Hz); per call 8–14 short-lived native nodes.
import { clamp, rng, hashStr, noiseBuffer, mtof } from './dsp.js';
import { sample } from './samples.js';
import { canVoice } from './instruments.js';

//             audible range m · reference distance m · call interval s · level · reverb send
export const ARCH = {
  bird: { range: 380, ref: 14, every: [1.6, 5], lvl: 0.1, rev: 0.35 },
  ray: { range: 1500, ref: 70, every: [8, 20], lvl: 0.12, rev: 0.7 },
  whale: { range: 5000, ref: 300, every: [16, 30], lvl: 0.16, rev: 0.95 },
  jelly: { range: 280, ref: 16, every: [1.4, 4.5], lvl: 0.05, rev: 0.8 },
  fish: { range: 70, ref: 8, every: [2.5, 8], lvl: 0.07, rev: 0.2 },
  grazer: { range: 600, ref: 22, every: [4, 11], lvl: 0.11, rev: 0.45 },
  giant: { range: 2400, ref: 90, every: [11, 24], lvl: 0.17, rev: 0.75 },
  hexapod: { range: 280, ref: 14, every: [3, 9], lvl: 0.07, rev: 0.3 },
  hopper: { range: 320, ref: 12, every: [3, 10], lvl: 0.08, rev: 0.35 },
  critter: { range: 100, ref: 5, every: [2, 7], lvl: 0.06, rev: 0.2 },
};
const NAMES = Object.keys(ARCH);
const MEMBERS = 4;

function mkEmitter(arch) {
  return { arch, on: false, sid: 0, dist: 1e9, pan: 0, pan1: 0, front: 1, size: 1, speed: 0, n: 0, members: Array.from({ length: MEMBERS }, () => ({ dist: 0, pan: 0 })), m: 0 };
}

export class Creatures {
  constructor(host) {
    this.host = host; this.ctx = host.ctx; this.mix = host.mix;
    this.out = this.mix.ambIn; this.rev = this.mix.ambRev;
    this.r = rng(777);
    this.em = {}; for (const a of NAMES) this.em[a] = mkEmitter(a);
    this.next = {}; this.voices = new Map(); this.counts = {}; this.seed = 1;
    this.live = false;           // true while a fauna subsystem feeds real animals
    this._cr = [0, 0, 0]; this._cf = [0, 0, -1];
  }

  setWorld(seed) { this.seed = seed >>> 0; this.voices.clear(); this.r = rng(seed ^ 0xfa0a); this.next = {}; }

  /** Species voice (deterministic per world seed + species id). */
  voice(arch, sid) {
    const k = arch + ':' + sid;
    let v = this.voices.get(k);
    if (v) return v;
    const r = rng((this.seed ^ hashStr(k)) >>> 0);
    v = { pitch: r.range(0.72, 1.4), shape: r.int(0, 3), form: r.range(0.8, 1.25), rate: r.range(0.85, 1.2), r };
    if (arch === 'bird') { // song motif: [t, f0, f1, dur]
      const kind = r.pick(['whistle', 'trill', 'chirp', 'sweep', 'warble']); const base = r.range(1900, 5200); const notes = [];
      let tt = 0; const n = r.int(3, 8);
      for (let i = 0; i < n; i++) {
        const f0 = base * r.range(0.78, 1.28), f1 = f0 * (kind === 'sweep' ? r.range(0.5, 1.9) : kind === 'whistle' ? r.range(0.92, 1.12) : r.range(0.8, 1.25));
        const d = kind === 'trill' ? r.range(0.025, 0.05) : kind === 'chirp' ? r.range(0.04, 0.09) : r.range(0.08, 0.32);
        notes.push([tt, f0, f1, d]); tt += d + (kind === 'trill' ? r.range(0.008, 0.02) : r.range(0.03, 0.14));
      }
      Object.assign(v, { kind, notes, fm: kind === 'warble' ? r.range(18, 60) : 0 });
    } else if (arch === 'whale') { // song theme: units [type, f0, f1, dur]
      const base = r.range(70, 190), units = [];
      for (let i = 0, n = r.int(3, 6); i < n; i++) {
        const type = r.pick(['up', 'down', 'moan', 'cry', 'grunt', 'up']);
        const f0 = base * (type === 'cry' ? r.range(3, 5.5) : r.range(0.8, 2.2));
        const f1 = type === 'up' ? f0 * r.range(1.6, 3) : type === 'down' ? f0 * r.range(0.35, 0.6) : type === 'cry' ? f0 * r.range(0.8, 1.3) : f0 * r.range(0.85, 1.15);
        units.push([type, f0, f1, type === 'grunt' ? r.range(0.35, 0.7) : r.range(1.1, 3.2)]);
      }
      Object.assign(v, { units });
    }
    this.voices.set(k, v);
    return v;
  }

  // ------------------------------------------------------------------ sensing (host, ~4 Hz)
  /** Scan the fauna subsystem around the camera. */
  sense(fauna, cam) {
    const list = fauna?.creatures;
    for (const a of NAMES) { const e = this.em[a]; e.on = false; e.n = 0; e.m = 0; e.dist = 1e9; }
    if (!list || !list.length || !cam) { this.live = false; return; }
    this.live = true;
    const me = cam.matrixWorld?.elements; const cp = cam.position;
    const R = this._cr, F = this._cf;
    if (me) { R[0] = me[0]; R[1] = me[1]; R[2] = me[2]; F[0] = -me[8]; F[1] = -me[9]; F[2] = -me[10]; }
    for (let i = 0; i < list.length; i++) {
      const c = list[i], sp = c.species; if (!sp || !c.pos) continue;
      const e = this.em[sp.archetype]; if (!e) continue;
      const A = ARCH[sp.archetype];
      const dx = c.pos[0] - cp.x, dy = c.pos[1] - cp.y, dz = c.pos[2] - cp.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      if (d > A.range) continue;
      e.n++;
      const pan = (dx * R[0] + dy * R[1] + dz * R[2]) / d;
      if (d < e.dist) {
        // nearest individual becomes the caller; the previous nearest becomes a responder
        if (e.on && e.m < MEMBERS) { const mm = e.members[e.m++]; mm.dist = e.dist; mm.pan = e.pan; }
        e.on = true; e.dist = d; e.pan = pan; e.front = (dx * F[0] + dy * F[1] + dz * F[2]) / d; e.sid = sp.id ?? 0;
        e.size = (sp.genome?.S ?? sp.genome?.L ?? 1) * (c.scale || 1); e.speed = c.speed || Math.hypot(c.vel?.[0] || 0, c.vel?.[1] || 0, c.vel?.[2] || 0);
        // pan one second ahead along the velocity (fly-bys sweep across the stereo field)
        if (c.vel) { const px = dx + c.vel[0], py = dy + c.vel[1], pz = dz + c.vel[2]; const dl = Math.hypot(px, py, pz) || 1; e.pan1 = (px * R[0] + py * R[1] + pz * R[2]) / dl; } else e.pan1 = pan;
      } else if (e.m < MEMBERS) { const mm = e.members[e.m++]; mm.dist = d; mm.pan = pan; }
    }
  }

  /** Offline / test: a static set of emitters [{archetype, dist, az (deg, + right), species, size, speed, n}]. */
  setStatic(list = []) {
    for (const a of NAMES) this.em[a].on = false;
    for (const s of list) {
      const e = this.em[s.archetype]; if (!e) continue;
      const pan = Math.sin((s.az || 0) * Math.PI / 180);
      Object.assign(e, { on: true, dist: s.dist ?? 50, pan, pan1: s.az1 != null ? Math.sin(s.az1 * Math.PI / 180) : pan, front: Math.cos((s.az || 0) * Math.PI / 180), sid: s.species ?? 0, size: s.size ?? 1, speed: s.speed ?? 0.5, n: s.n ?? 4, m: 0 });
      for (let k = 0; k < Math.min(MEMBERS, (s.n ?? 4) - 1); k++) { const mm = e.members[e.m++]; mm.dist = e.dist * this.r.range(0.8, 1.5); mm.pan = clamp(pan + this.r.range(-0.5, 0.5), -1, 1); }
    }
    this.live = list.length > 0;
  }

  // ------------------------------------------------------------------ per frame
  update(t, dt, P) {
    if (!this.live) return;
    const r = this.r, dry = 1 - (P.underwater || 0);
    for (const a of NAMES) {
      const e = this.em[a]; if (!e.on) continue;
      const A = ARCH[a];
      if (this.next[a] === undefined) { this.next[a] = t + r.range(0.3, A.every[1] * 0.5); continue; }
      if (t < this.next[a]) continue;
      const near = clamp(e.dist / A.range, 0, 1);
      // closer and bigger groups call more often (log-ish in group size so a 30-bird flock is not a wall)
      let k = (0.7 + 1.3 * near) / clamp(1 + Math.log2(Math.max(1, e.n)) * 0.25, 1, 1.8);
      if (a === 'bird') k *= P.night > 0.5 ? 4 : 1 - P.dawn * 0.4;
      if (a === 'grazer' || a === 'hopper') k *= P.night > 0.6 ? 1.8 : 1;
      if ((P.rain || 0) > 0.4 && a !== 'whale' && a !== 'fish') k *= 1.8;
      this.next[a] = t + r.range(A.every[0], A.every[1]) * k;
      if (a !== 'whale' && a !== 'fish' && dry < 0.5) continue;
      this.call(a, t + 0.02);
    }
    // giant footfalls: the ground shakes when a walking giant is near
    const g = this.em.giant;
    if (g.on && g.dist < 320 && g.speed > 0.25 && dry > 0.5) {
      if (!(this._foot > t)) {
        const per = clamp(1.9 - g.speed * 0.25, 0.9, 2.2) * (g.size > 6 ? 1.2 : 1);
        this._foot = t + per * r.range(0.9, 1.1);
        this._footfall(t + 0.01, g);
      }
    }
    // a bird flock sweeping past close by: wing flutter
    const b = this.em.bird;
    if (b.on && b.dist < 32 && b.speed > 3 && b.n >= 3 && !(this._flut > t)) { this._flut = t + r.range(2.5, 5); this._flutter(t + 0.01, b); }
  }

  /** Make the nearest animal of an archetype call now (used by discovery events too). */
  call(arch, t, opts = {}) {
    const e = this.em[arch]; if (!e || !e.on) return false;
    if (!canVoice(0.5, t)) return false;
    const v = this.voice(arch, e.sid);
    const loud = opts.loud || 1;
    try {
      switch (arch) {
        case 'bird': this._bird(t, e, v, loud); if (e.m && this.r.chance(0.45)) this._bird(t + this.r.range(0.5, 1.6), this._as(e, this.r.int(0, e.m - 1)), v, loud * 0.8); break;
        case 'whale': this._whale(t, e, v, loud); break;
        case 'ray': this._ray(t, e, v, loud); break;
        case 'jelly': this._jelly(t, e, v, loud); break;
        case 'fish': this._fish(t, e, loud); break;
        case 'grazer': this._low(t, e, v, loud, 'grazer'); if (e.m && this.r.chance(0.6)) this._low(t + this.r.range(0.9, 2.2), this._as(e, this.r.int(0, e.m - 1)), v, loud * 0.85, 'grazer', 1.06); break;
        case 'giant': this._low(t, e, v, loud, 'giant'); break;
        case 'hopper': this._low(t, e, v, loud, 'hopper'); if (e.m && this.r.chance(0.5)) this._low(t + this.r.range(0.4, 1.1), this._as(e, this.r.int(0, e.m - 1)), v, loud * 0.8, 'hopper', 1.1); break;
        case 'hexapod': this._chitter(t, e, v, loud); break;
        case 'critter': this._squeak(t, e, v, loud); break;
        default: return false;
      }
    } catch (err) { if (!this._err) { this._err = 1; console.warn('[audio] creature', arch, err); } return false; }
    this.counts[arch] = (this.counts[arch] || 0) + 1;
    return true;
  }

  _as(e, i) { // emitter view of a responder (same species, another member)
    const m = e.members[i], o = this._tmp || (this._tmp = mkEmitter(e.arch));
    Object.assign(o, e); o.dist = m.dist; o.pan = m.pan; o.pan1 = m.pan; return o;
  }

  // ------------------------------------------------------------------ spatial chain
  _chain(t, e, dur, lvl, rev) {
    const ctx = this.ctx, A = ARCH[e.arch];
    const d = Math.max(1, e.dist);
    const att = clamp(A.ref / Math.max(A.ref, d), 0, 1);
    const inp = ctx.createGain(); inp.gain.value = 1;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5;
    // air absorption (+ head shadow for sources behind the listener)
    lp.frequency.value = clamp(17000 * Math.exp(-d / (A.range * 0.45)) * (e.front < -0.3 ? 0.55 : 1), 450, 17000);
    const g = ctx.createGain(); g.gain.value = lvl * att;
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(clamp(e.pan * 0.9, -0.95, 0.95), t);
    if (Math.abs(e.pan1 - e.pan) > 0.05) p.pan.linearRampToValueAtTime(clamp(e.pan1 * 0.9, -0.95, 0.95), t + Math.min(dur, 3));
    const send = ctx.createGain(); send.gain.value = clamp(rev * (0.35 + 0.9 * (1 - att)), 0, 1.1) * lvl * Math.sqrt(att);
    inp.connect(lp); lp.connect(g); g.connect(p); p.connect(this.out); lp.connect(send); send.connect(this.rev);
    return { inp, nodes: [inp, lp, g, p, send] };
  }
  _end(src, nodes) { src.addEventListener('ended', () => { for (const n of nodes) try { n.disconnect(); } catch (_) { /* ignore */ } }); }
  _osc(type, f, t) { const o = this.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); return o; }
  _gain(v) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  _bp(f, q) { const b = this.ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q; return b; }

  // ------------------------------------------------------------------ voices
  _bird(t, e, v, loud) {
    const reps = this.r.chance(0.35) ? 2 : 1, rate = v.rate * this.r.range(0.96, 1.04);
    const len = v.notes[v.notes.length - 1][0] + v.notes[v.notes.length - 1][3];
    const dur = (len * reps + 0.4 * (reps - 1)) / rate;
    const ch = this._chain(t, e, dur, ARCH.bird.lvl * loud * clamp(1.1 - e.size * 0.05, 0.6, 1.1), ARCH.bird.rev);
    let last = null;
    for (let rep = 0; rep < reps; rep++) {
      const off = rep * (len + 0.4) / rate;
      for (const [tt, f0, f1, d0] of v.notes) {
        const st = t + off + tt / rate, d = d0 / rate;
        const o = this._osc('sine', f0, st); o.frequency.exponentialRampToValueAtTime(Math.max(60, f1), st + d);
        const eg = this._gain(0); eg.gain.setValueAtTime(0, st); eg.gain.linearRampToValueAtTime(1, st + d * 0.2); eg.gain.linearRampToValueAtTime(0, st + d);
        let m = null, mg = null;
        if (v.fm) { m = this._osc('sine', v.fm, st); mg = this._gain(f0 * 0.12); m.connect(mg); mg.connect(o.frequency); m.start(st); m.stop(st + d + 0.02); }
        o.connect(eg); eg.connect(ch.inp); o.start(st); o.stop(st + d + 0.02);
        this._end(o, [eg, mg].filter(Boolean)); last = o;
      }
    }
    if (last) this._end(last, ch.nodes);
  }

  _flutter(t, e) {
    const ctx = this.ctx, dur = 1.6;
    const ch = this._chain(t, e, dur, 0.09, 0.2);
    const s = ctx.createBufferSource(); s.buffer = noiseBuffer(ctx, 'pink'); s.loop = true;
    const bp = this._bp(900, 0.7), am = this._gain(0), lfo = this._osc('triangle', this.r.range(9, 15), t), lg = this._gain(0.5);
    const env = this._gain(0); env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + dur * 0.4); env.gain.linearRampToValueAtTime(0, t + dur);
    lfo.connect(lg); lg.connect(am.gain); s.connect(bp); bp.connect(am); am.connect(env); env.connect(ch.inp);
    s.start(t, this.r() * 3); s.stop(t + dur + 0.05); lfo.start(t); lfo.stop(t + dur + 0.05);
    this._end(s, [bp, am, lg, env, ...ch.nodes]);
    this.counts.flutter = (this.counts.flutter || 0) + 1;
  }

  /** Humpback-like phrase: the pod theme with variation; another member may answer an octave-ish away. */
  _whale(t, e, v, loud) {
    const r = this.r; let tt = t; const units = v.units.slice();
    if (r.chance(0.4)) units.push(units[r.int(0, units.length - 1)]);     // theme repetition
    const total = units.reduce((s, u) => s + u[3] + 0.5, 0);
    const ch = this._chain(t, e, total, ARCH.whale.lvl * loud, ARCH.whale.rev);
    let last = null;
    for (const [type, f0a, f1a, da] of units) {
      const k = r.range(0.94, 1.06), f0 = f0a * k * v.pitch, f1 = f1a * k * v.pitch, d = da * r.range(0.85, 1.15);
      last = this._whaleUnit(tt, d, type, f0, f1, ch.inp);
      tt += d + r.range(0.25, 0.9);
    }
    if (last) this._end(last, ch.nodes);
    if (e.m && r.chance(0.55)) { // answer from another pod member
      const o = this._as(e, r.int(0, e.m - 1)); const [type, f0, f1, d] = units[r.int(0, units.length - 1)];
      const ch2 = this._chain(tt + 0.6, o, d, ARCH.whale.lvl * loud * 0.7, ARCH.whale.rev);
      const l2 = this._whaleUnit(tt + 0.6, d * 1.1, type, f0 * v.pitch * 0.94, f1 * v.pitch * 0.94, ch2.inp); this._end(l2, ch2.nodes);
    }
  }

  _whaleUnit(t, d, type, f0, f1, dest) {
    const ctx = this.ctx;
    const o = this._osc(type === 'grunt' ? 'sawtooth' : 'sine', f0, t), o2 = this._osc('triangle', f0 * 2.003, t);
    const cv = (osc, m) => {
      if (type === 'moan' || type === 'cry') { osc.frequency.linearRampToValueAtTime(f0 * m * 1.12, t + d * 0.4); osc.frequency.linearRampToValueAtTime(f1 * m, t + d); }
      else osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * m), t + d);
    };
    cv(o, 1); cv(o2, 2.003);
    const vib = this._osc('sine', type === 'cry' ? 5.5 : 3.2, t), vg = this._gain(f0 * (type === 'cry' ? 0.018 : 0.008)); vib.connect(vg); vg.connect(o.frequency);
    const h2 = this._gain(type === 'cry' ? 0.18 : 0.32);
    const f1b = this._bp(Math.min(3000, f0 * 2.5 + 200), 1.4), fx = this._gain(0.6), dry = this._gain(0.55);
    const env = this._gain(0);
    const a = type === 'grunt' ? 0.04 : d * 0.3;
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(type === 'grunt' ? 0.8 : 1, t + a); env.gain.setTargetAtTime(0, t + d * 0.72, d * 0.12);
    o.connect(dry); o2.connect(h2); h2.connect(dry); o.connect(f1b); o2.connect(f1b); f1b.connect(fx);
    dry.connect(env); fx.connect(env); env.connect(dest);
    for (const n of [o, o2, vib]) { n.start(t); n.stop(t + d + 0.6); }
    this._end(o, [o2, vib, vg, h2, f1b, fx, dry, env]);
    return o;
  }

  _ray(t, e, v, loud) {
    const ctx = this.ctx, d = this.r.range(1.8, 3.2), f = 120 * v.pitch / clamp(Math.sqrt(e.size), 0.7, 2.5);
    const ch = this._chain(t, e, d, ARCH.ray.lvl * loud, ARCH.ray.rev);
    const o = this._osc('sine', f, t); o.frequency.linearRampToValueAtTime(f * 1.35, t + d * 0.35); o.frequency.exponentialRampToValueAtTime(f * 0.7, t + d);
    const o2 = this._osc('sine', f * 3.01, t); o2.frequency.linearRampToValueAtTime(f * 4.05, t + d * 0.35); o2.frequency.exponentialRampToValueAtTime(f * 2.1, t + d);
    const g2 = this._gain(0.12);
    const s = ctx.createBufferSource(); s.buffer = noiseBuffer(ctx, 'pink'); s.loop = true;
    const bp = this._bp(f * 4, 3), ng = this._gain(0.9);
    const env = this._gain(0); env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + d * 0.3); env.gain.setTargetAtTime(0, t + d * 0.6, d * 0.15);
    o.connect(env); o2.connect(g2); g2.connect(env); s.connect(bp); bp.connect(ng); ng.connect(env); env.connect(ch.inp);
    for (const n of [o, o2]) { n.start(t); n.stop(t + d + 0.5); } s.start(t, this.r() * 3); s.stop(t + d + 0.5);
    this._end(o, [o2, g2, s, bp, ng, env, ...ch.nodes]);
  }

  _jelly(t, e, v, loud) {
    const h = this.host.music?.h, n = this.r.int(1, 3);
    const ch = this._chain(t, e, 4, ARCH.jelly.lvl * loud, ARCH.jelly.rev);
    let last = null;
    for (let i = 0; i < n; i++) {
      const st = t + i * this.r.range(0.12, 0.5);
      let midi = 84 + Math.round(12 * Math.log2(v.pitch)) + this.r.pick([0, 2, 4, 7, 9, 12]);
      if (h?.snap) midi = h.snap(midi);
      const f = mtof(midi);
      for (const [m, a, dec] of [[1, 1, 2.2], [2.76, 0.35, 1.1], [5.4, 0.15, 0.6]]) {
        const o = this._osc('sine', f * m, st), g = this._gain(0);
        g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(a * 0.5, st + 0.01); g.gain.setTargetAtTime(0, st + 0.02, dec / 3);
        o.connect(g); g.connect(ch.inp); o.start(st); o.stop(st + dec + 0.1); this._end(o, [g]); last = o;
      }
    }
    if (last) this._end(last, ch.nodes);
  }

  _fish(t, e, loud) {
    const b = sample(this.ctx, 'splash'); if (!b) return;
    const ch = this._chain(t, e, 1, ARCH.fish.lvl * loud, ARCH.fish.rev);
    const s = this.ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = this.r.range(1.6, 2.6);
    s.connect(ch.inp); s.start(t); this._end(s, ch.nodes);
  }

  /** Formant-synthesized vocalization: grazer lows / giant bellows / hopper bleats. */
  _low(t, e, v, loud, kind, pitchK = 1) {
    const ctx = this.ctx, r = this.r;
    const sz = clamp(e.size, 0.3, 12);
    let f0, d, F, vib, am, wave = 'sawtooth';
    if (kind === 'giant') { f0 = clamp(62 / Math.sqrt(sz / 3), 24, 70); d = r.range(2.6, 4.8); F = [[260, 330, 5], [560, 720, 6], [1100, 1200, 8]]; vib = [2.5, 0.02]; am = [r.range(9, 14), 0.25]; }
    else if (kind === 'hopper') { f0 = clamp(360 / Math.sqrt(sz), 180, 620); d = r.range(0.45, 0.9); F = [[520, 640, 5], [1650, 1900, 7], [2600, 2700, 9]]; vib = [7.5, 0.05]; am = [r.range(16, 26), 0.55]; }
    else { f0 = clamp(145 / Math.sqrt(sz), 60, 220); d = r.range(0.9, 1.9); F = [[420, 720, 5], [880, 1150, 7], [2300, 2450, 9]]; vib = [4.5, 0.012]; am = null; }
    f0 *= v.pitch * pitchK * r.range(0.96, 1.04);
    const fs = v.form / Math.pow(sz, 0.12);
    const ch = this._chain(t, e, d, ARCH[kind].lvl * loud, ARCH[kind].rev);
    const o = this._osc(wave, f0, t);
    // pitch contour per species shape: rise-fall · fall · rise · wobble
    const S = [[1, 1.18, 0.82], [1.1, 1, 0.7], [0.85, 1.05, 1.15], [1, 1.12, 0.95]][v.shape];
    o.frequency.linearRampToValueAtTime(f0 * S[1], t + d * 0.35); o.frequency.linearRampToValueAtTime(f0 * S[2], t + d);
    const lfo = this._osc('sine', vib[0], t), lg = this._gain(f0 * vib[1]); lfo.connect(lg); lg.connect(o.frequency);
    const sum = this._gain(1), nodes = [lfo, lg, sum];
    for (const [fa, fb, q] of F) { // vowel morph (e.g. "mm-ah-oh") through parallel formant band-passes
      const b = this._bp(fa * fs, q); b.frequency.linearRampToValueAtTime(fb * fs, t + d * 0.4); b.frequency.linearRampToValueAtTime(fa * fs * 0.92, t + d);
      const g = this._gain(fa < 700 ? 1.4 : fa < 1500 ? 0.8 : 0.35); o.connect(b); b.connect(g); g.connect(sum); nodes.push(b, g);
    }
    if (kind === 'giant') { const sub = this._osc('sine', f0 * 0.5, t); sub.frequency.linearRampToValueAtTime(f0 * 0.5 * S[2], t + d); const sg = this._gain(0.7); sub.connect(sg); sg.connect(sum); sub.start(t); sub.stop(t + d + 0.6); nodes.push(sub, sg); }
    const env = this._gain(0); nodes.push(env);
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + d * (kind === 'hopper' ? 0.08 : 0.2)); env.gain.setTargetAtTime(0, t + d * 0.75, d * 0.1);
    if (am) { const a = this._osc('sine', am[0], t), ag = this._gain(am[1]); const trem = this._gain(1 - am[1] * 0.5); a.connect(ag); ag.connect(trem.gain); sum.connect(trem); trem.connect(env); a.start(t); a.stop(t + d + 0.5); nodes.push(a, ag, trem); }
    else sum.connect(env);
    env.connect(ch.inp);
    o.start(t); o.stop(t + d + 0.6); lfo.start(t); lfo.stop(t + d + 0.6);
    this._end(o, [...nodes, ...ch.nodes]);
  }

  _footfall(t, e) {
    const b = sample(this.ctx, 'thud'); if (!b) return;
    const ch = this._chain(t, e, 1.5, 0.36, 0.4);
    const s = this.ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = this.r.range(0.32, 0.42);
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
    s.connect(lp); lp.connect(ch.inp); s.start(t);
    this._end(s, [lp, ...ch.nodes]);
    this.counts.footfall = (this.counts.footfall || 0) + 1;
  }

  _chitter(t, e, v, loud) {
    const r = this.r, ctx = this.ctx, n = r.int(6, 18), per = r.range(0.018, 0.045) / v.rate;
    const b = sample(ctx, 'tick'); if (!b) return;
    const ch = this._chain(t, e, n * per + 0.3, ARCH.hexapod.lvl * loud, ARCH.hexapod.rev);
    const bp = this._bp(r.range(1800, 4200) * v.form, 4); bp.connect(ch.inp);
    let last = null;
    for (let i = 0; i < n; i++) {
      const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = r.range(1.2, 2) * v.pitch;
      const g = this._gain(0.4 + 0.6 * Math.sin(Math.PI * i / n)); s.connect(g); g.connect(bp); s.start(t + i * per * r.range(0.8, 1.25)); this._end(s, [g]); last = s;
    }
    if (last) this._end(last, [bp, ...ch.nodes]);
  }

  _squeak(t, e, v, loud) {
    const r = this.r, n = r.int(1, 4);
    const ch = this._chain(t, e, 1, ARCH.critter.lvl * loud, ARCH.critter.rev);
    let last = null;
    for (let i = 0; i < n; i++) {
      const st = t + i * r.range(0.09, 0.2), d = r.range(0.05, 0.12), f = r.range(2400, 4600) * v.pitch;
      const o = this._osc('triangle', f, st); o.frequency.exponentialRampToValueAtTime(f * (v.shape & 1 ? 1.3 : 0.75), st + d);
      const g = this._gain(0); g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(0.8, st + 0.01); g.gain.linearRampToValueAtTime(0, st + d);
      o.connect(g); g.connect(ch.inp); o.start(st); o.stop(st + d + 0.02); this._end(o, [g]); last = o;
    }
    if (last) this._end(last, ch.nodes);
  }

  debug() {
    const near = {};
    for (const a of NAMES) { const e = this.em[a]; if (e.on) near[a] = { d: Math.round(e.dist), n: e.n, pan: +e.pan.toFixed(2) }; }
    return { live: this.live, near, calls: { ...this.counts } };
  }
}
