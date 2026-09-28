// Audio host (WebAudio, fully procedural — no audio files). Owned by the AUDIO track.
// API CONTRACT (keep stable):
//   audio.unlock()                      call on first user gesture (engine does this)
//   audio.setScene(name, params)        'cosmic'|'galaxy'|'space'|'surface'|'city'|'underwater'  (params.body)
//   audio.setParam(name, value)         'speed' m/s, 'altitude' m, 'wind' 0..1, 'engine' 0..1, 'boost' 0..1,
//                                       'glide', 'swim', 'rain', 'night', 'danger', 'discovery', 'cosmicGrowth',
//                                       'volume' 0..1  (unknown names are stored and shown in audioDebug)
//   audio.play(name, opts)              one-shots: step {surface,speed,side} · jump · land {intensity} · glider {open}
//                                       boost · splash · vehicle.enter/exit {type} · takeoff · pulse {on} · impact
//                                       whoosh · warp · arrive · select / ui.* · discover {kind} · photo
//   audio.setVolume(v)                  master volume 0..1
//   audio.update(dt)
//   Audio.renderOffline(opts)           render a scene through an OfflineAudioContext (tools/audio_render.mjs)
//   window.__rv.audioDebug()            current graph state (scene, style, key, chord, section, layers, beds, levels…)
//   window.__rv.audioSet({...})         override derived params live (night, rain, shore, city, …) for testing
//
// Modules: mix.js (buses, IR reverb, limiter) · music.js + styles.js + theory.js (generative composer)
//          instruments.js (synth voices) · ambience.js (world beds) · sfx.js (foley, UI, engines) · samples.js
import { G } from '../core/Uniforms.js';
import { events } from '../core/events.js';
import { Mixer } from './mix.js';
import { Composer } from './music.js';
import { resolveStyle } from './styles.js';
import { Ambience } from './ambience.js';
import { Sfx } from './sfx.js';
import { VOICES } from './instruments.js';
import { clamp, smooth, hashStr } from './dsp.js';

const ALIEN_ART = new Set(['rickmorty', 'nms', 'crystal', 'nausicaa', 'rogerdean', 'beksinski']);
const HOT_ART = new Set(['moebius', 'villeneuve', 'bebop', 'ghibli', 'bierstadt', 'nms', 'rickmorty', 'botw']);
const QUALITY = { low: 0.45, med: 0.7, medium: 0.7, high: 1, ultra: 1 };

export class Audio {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.ctx = null;
    this.params = { speed: 0, altitude: 0, wind: 0, engine: 0, boost: 0, glide: 0, swim: 0, danger: 0, discovery: 0, cosmicGrowth: 0, volume: 1 };
    this.scene = null; this.sceneParams = {};
    this.over = {};            // test overrides of derived params
    this.P = { scene: 'cosmic', wind: 0.3, rush: 0, altitude: 0, rain: 0, snow: 0, storm: 0, flash: 0, night: 0, shore: 0, city: 0, cityStyle: 'village', underwater: 0, swim: 0, wading: 0, flora: 0, fauna: 0, hot: 0, cold: false, wet: 0, space: 0, inShip: false, dawn: 0 };
    this.offline = opts.offline || null;
    this._vt = 0; this.flow = 0; this.discoveryPulse = 0; this.sub = null; this._worldT = 0; this._dist = null;
    this.volume = 1;
    const tier = engine?.quality?.tier || 'high';
    this.quality = (QUALITY[tier] ?? 1) * (engine?.quality?.mobile ? 0.6 : 1);
    if (!this.offline) this._listen();
  }

  // ------------------------------------------------------------------ lifecycle
  unlock() {
    if (this.offline) return;
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'playback' });
      this._build(this.ctx);
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch (e) { console.warn('[audio] unavailable', e); this.ctx = null; }
  }

  _build(ctx) {
    this.ctx = ctx;
    VOICES.max = Math.round(40 + 60 * this.quality);
    this.mix = new Mixer(ctx, { quality: this.quality });
    this.master = this.mix.master; // legacy: Menu falls back to master.gain
    this.mix.setVolume(this.volume, this.now());
    this.music = new Composer(this);
    this.amb = new Ambience(this);
    this.sfx = new Sfx(this);
    this._styleKey = null;
    this._applyScene();
  }

  now() { return this.offline ? this._vt : (this.ctx ? this.ctx.currentTime : 0); }
  later(fn, ms) { if (!this.offline) setTimeout(fn, ms); }

  _listen() {
    try {
      events.on('mode:leaving', (p) => { if (p?.from) this.play('warp', { intensity: p.to === 'system' ? 1 : 0.8 }); });
      events.on('mode:enter', () => { this._arrivePending = 0.35; });
      events.on('discovery', (p) => { this.play('discover', { kind: p?.kind }); this.discoveryPulse = 1; });
      events.on('vehicle:enter', () => { this.discoveryPulse = Math.max(this.discoveryPulse, 0.4); });
      if (typeof document !== 'undefined') {
        document.addEventListener('pointerdown', (e) => {
          const el = e.target?.closest?.('button,[role="button"],.rv-btn,[data-sfx]');
          if (el && this.ctx) this.play(el.dataset?.sfx || 'ui.click');
        }, { capture: true, passive: true });
        document.addEventListener('visibilitychange', () => {
          if (!this.ctx) return;
          try { if (document.hidden) this.ctx.suspend(); else this.ctx.resume(); } catch (_) { /* ignore */ }
        });
      }
      const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
      if (q?.get('audio') === '1' && !this.engine?.shot) this.unlock();
      if (q?.get('audiodebug')) this._overlayWanted = true;
    } catch (e) { console.warn('[audio] listen', e); }
  }

  // ------------------------------------------------------------------ API
  setScene(name, params = {}) {
    this.scene = name; this.sceneParams = params || {};
    this.sub = null;
    if (this.ctx) this._applyScene();
  }

  setParam(name, value) {
    this.params[name] = value;
    if (name === 'volume') this.setVolume(value);
  }

  setVolume(v) {
    this.volume = clamp(+v || 0, 0, 1);
    try { this.mix?.setVolume(this.volume, this.now()); } catch (_) { /* ignore */ }
  }

  play(name, opts = {}) {
    if (!this.ctx || !this.sfx) return;
    try { this.sfx.play(name, opts || {}, this.now() + (this.offline ? 0 : 0.01)); } catch (e) { console.warn('[audio] play', name, e); }
  }

  // ------------------------------------------------------------------ scenes & styles
  _body() { return this.sceneParams?.body || this.engine?.director?.current?.world?.body || null; }

  _applyScene() {
    if (!this.ctx) return;
    const name = this.scene || this.engine?.director?.currentName || 'cosmic';
    const body = this._body();
    const art = body?.art?.key || this.sceneParams.art || null;
    let kind = name === 'system' ? 'surface' : name;
    if (kind === 'surface' || kind === 'city' || kind === 'underwater') kind = this.sub === 'space' ? 'space' : 'surface';
    const key = kind + ':' + (kind === 'surface' ? art : '');
    const t = this.now();
    if (kind === 'underwater' || name === 'underwater') this.over.underwater = 1;
    if (key === this._styleKey) return;
    this._styleKey = key;
    const seed = (body?.seed ?? hashStr(String(this.engine?.params?.seed ?? 'rv'))) >>> 0;
    const style = resolveStyle(kind, art);
    this.music.setStyle(style, seed, t + 0.05);
    this.P.scene = name === 'system' || name === 'city' || name === 'underwater' ? 'surface' : name;
    const life = body?.life || {};
    this.amb.setWorld(seed, {
      alien: ALIEN_ART.has(art) || body?.type === 'exotic' || body?.type === 'toxic',
      flora: life.flora ?? 0, fauna: life.fauna ?? 0,
    });
    this.P.flora = life.flora ?? 0; this.P.fauna = life.fauna ?? 0;
    this.P.cityStyle = body?.civ?.style || body?.art?.civ || 'village';
    this.P.hot = HOT_ART.has(art) ? 0.8 : body?.type === 'desert' || body?.type === 'savanna' ? 0.7 : 0.2;
    this.P.cold = body?.type === 'arctic' || art === 'friedrich';
    this._dist = null;
  }

  // ------------------------------------------------------------------ world sensing (time-sliced, ~4 Hz)
  _sense(dt) {
    const P = this.P, p = this.params;
    const mode = this.engine?.director?.currentName;
    const world = this.engine?.director?.current?.world;
    this._worldT -= dt;
    if (mode === 'system' && world) {
      const atmoH = Math.max(1, (G.uAtmosphereRadius.value - G.uPlanetRadius.value) || 5000);
      const camAlt = G.uCameraAltitude.value || 0;
      const sp = clamp((camAlt / atmoH - 0.55) / 0.4, 0, 1);
      P.space = smooth(P.space, sp, 1.5, dt);
      P.night = G.uNight.value || 0;
      P.wind = G.uWindStrength.value ?? 0.3;
      P.wet = G.uWetness.value || 0;
      const atmo = world.get?.('atmosphere');
      const W = atmo?.weather;
      if (W) { P.rain = W.rain || 0; P.snow = W.snow || 0; P.storm = W.storm || 0; P.flash = W.flash || 0; }
      if (this._worldT <= 0) {
        this._worldT = 0.25;
        try { this._senseSlow(world); } catch (e) { if (!this._senseErr) { this._senseErr = 1; console.warn('[audio] sense', e); } }
      }
      const c = world.controller;
      P.inShip = c?.type === 'ship';
      const alt = p.altitude || 0;
      P.altitude = alt;
      // flow: how "in motion" the player is (drives arrangement density)
      let act;
      if (c && c.type && c !== world.player) act = 0.45 + clamp((p.speed || 0) / 120, 0, 0.45) + (p.boost || 0) * 0.15;
      else act = (p.glide ? 0.65 : 0) + clamp((p.speed || 0) / 14, 0, 0.5) + (p.swim ? 0.1 : 0);
      this.flow = smooth(this.flow, clamp(act, 0, 1), 0.12, dt);
      const onFoot = !(c && c.type && c !== world.player);
      P.rush = onFoot ? clamp(((p.wind || 0) - 0.25) / 0.75, 0, 1) * 0.9 + (p.glide ? 0.25 : 0) : clamp(((p.speed || 0) - 10) / 90, 0, 1) * (1 - P.space);
      P.swim = p.swim || 0;
      const water = world.get?.('water');
      P.underwater = smooth(P.underwater, water?.under ? 1 : 0, 6, dt);
    } else {
      P.space = mode === 'galaxy' ? 0.35 : mode === 'cosmic' ? 0.2 : 0; P.rush = 0; P.underwater = 0; P.inShip = false;
      this.flow = smooth(this.flow, clamp(p.cosmicGrowth || 0, 0, 1), 0.2, dt);
    }
    P.dawn = clamp(1 - Math.abs(P.night - 0.35) / 0.25, 0, 1);
    Object.assign(P, this.over);
  }

  _senseSlow(world) {
    const P = this.P, S = world.surface, body = world.body;
    const c = world.controller && world.controller !== world.player ? world.controller : world.player;
    const pos = c?.pos;
    if (!pos || !S) return;
    const len = pos.length() || 1;
    const dx = pos.x / len, dy = pos.y / len, dz = pos.z / len;
    // shore proximity: ring samples at 120 m and 420 m — count points under the sea level
    const hasSea = body?.ocean?.present && Number.isFinite(S.seaLevel);
    if (hasSea) {
      const R = body.radius || len;
      let under = 0, n = 0;
      // tangent basis
      let tx = -dz, ty = 0, tz = dx; let tl = Math.hypot(tx, ty, tz); if (tl < 1e-6) { tx = 1; tz = 0; tl = 1; } tx /= tl; tz /= tl;
      const bx = dy * tz - dz * ty, by = dz * tx - dx * tz, bz = dx * ty - dy * tx;
      const here = S.height(dx, dy, dz) - S.seaLevel;
      for (const dist of [60, 180, 480]) {
        const a = dist / R;
        for (let k = 0; k < 6; k++) {
          const th = (k / 6) * Math.PI * 2 + dist;
          const ox = Math.cos(th) * tx + Math.sin(th) * bx, oy = Math.cos(th) * ty + Math.sin(th) * by, oz = Math.cos(th) * tz + Math.sin(th) * bz;
          let x = dx + ox * a, y = dy + oy * a, z = dz + oz * a; const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
          if (S.height(x, y, z) < S.seaLevel) under += dist < 100 ? 1.6 : dist < 300 ? 1.2 : 0.7;
          n++;
        }
      }
      const alt = len - R - Math.max(0, here);
      P.shore = clamp(under / (n * 0.55), 0, 1) * clamp(1 - Math.max(0, here - 20) / 140, 0, 1) * clamp(1 - alt / 250, 0, 1);
      P.wading = here < 0.4 && here > -1.5 ? 1 : 0;
    } else { P.shore = 0; P.wading = 0; }
    // settlements
    let best = 0, style = null;
    for (const poi of world.pois || []) {
      if (!poi?.pos || !(poi.kind === 'city' || poi.kind === 'village')) continue;
      const d = poi.pos.distanceTo ? poi.pos.distanceTo(pos) : Infinity;
      const rad = poi.radius || 200;
      const f = clamp(1 - (d - rad * 0.6) / (rad * 1.6 + 250), 0, 1) * (poi.kind === 'city' ? 1 : 0.7);
      if (f > best) { best = f; style = poi.data?.style || null; }
    }
    P.city = best; if (style) P.cityStyle = style;
    // local biome (temperature/flora proxy)
    try {
      const s = S.sample(dx, dy, dz, this._samp || (this._samp = {}));
      if (s && Number.isFinite(s.temperature)) P.hot = clamp((s.temperature - 0.5) * 2.5 + (HOT_ART.has(body?.art?.key) ? 0.3 : 0), 0, 1);
      if (s && Number.isFinite(s.snow)) P.cold = s.snow > 0.4 || P.cold;
    } catch (_) { /* optional */ }
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    this._hookDebug();
    if (!this.ctx || !this.music) return;
    if (!this.offline && this.ctx.state !== 'running') return;
    try {
      dt = Math.min(Math.max(dt || 0, 0), 0.25);
      const t = this.now();
      if (this.offline) this._senseOffline(dt); else this._sense(dt);
      const P = this.P;
      // sub-scene: planet surface ⇄ space (hysteresis)
      if (this.scene === 'surface' || this.scene === 'city' || this.scene === 'underwater' || this.scene === 'system') {
        const want = P.space > 0.85 ? 'space' : P.space < 0.5 ? 'surface' : this.sub;
        if (want !== this.sub) { this.sub = want; this._applyScene(); }
      }
      if (this._arrivePending > 0) { this._arrivePending -= dt; if (this._arrivePending <= 0) this.play('arrive'); }
      // energy for the composer
      this.discoveryPulse = Math.max(0, this.discoveryPulse - dt / 20);
      const M = this.music;
      M.night = P.night; M.danger = this.params.danger || 0; M.growth = this.params.cosmicGrowth || 0;
      const E = 0.24 + 0.6 * this.flow + 0.35 * M.danger + 0.25 * this.discoveryPulse + (this.params.discovery || 0) * 0.2 - 0.1 * P.night;
      M.energy = clamp(E, 0, 1);
      M.tick(t);
      this.mix.setMuffle(P.underwater, t);
      this.amb.update(t, dt, P);
      // vehicles (doppler from camera ↔ vehicle radial velocity)
      const world = this.engine?.director?.current?.world;
      const c = world?.controller;
      const veh = c && c.type && c !== world?.player ? c : null;
      let dop = 1;
      if (veh?.pos && world.camera) {
        const d = world.camera.position.distanceTo(veh.pos);
        if (this._dist != null && dt > 0) { const vr = clamp((d - this._dist) / dt, -120, 120); dop = smooth(this._dop || 1, 343 / (343 + vr), 4, dt); }
        this._dist = d; this._dop = dop;
      } else this._dist = null;
      this.sfx.updateEngines(t, dt, { type: veh?.type || (this.params.engine > 0 ? this.params.engineType : null), engine: veh ? (this.params.engine ?? 0) : (this.params.engineType ? this.params.engine : 0), speed: this.params.speed, boost: this.params.boost, doppler: dop, grounded: veh?.grounded });
      if (this._overlay) this._overlay.update(dt);
    } catch (e) {
      if (!this._err) { this._err = 1; console.warn('[audio] update failed', e); }
    }
  }

  // ------------------------------------------------------------------ debug
  debug() {
    const base = { unlocked: !!this.ctx, state: this.ctx?.state || 'locked', scene: this.scene, sub: this.sub, quality: this.quality, params: { ...this.params } };
    if (!this.ctx || !this.music) {
      let st = null; try { const b = this._body(); st = resolveStyle(this.scene === 'cosmic' || this.scene === 'galaxy' || this.scene === 'space' ? this.scene : 'surface', b?.art?.key); } catch (_) { /* ignore */ }
      return { ...base, pendingStyle: st ? { key: st.key, label: st.label, note: st.note, layers: st.layers.map((l) => l.id) } : null, hint: 'audio locked until the first user gesture (or add &audio=1)' };
    }
    const P = {}; for (const [k, v] of Object.entries(this.P)) P[k] = typeof v === 'number' ? +v.toFixed(3) : v;
    return {
      ...base, sampleRate: this.ctx.sampleRate, time: +this.now().toFixed(2), baseLatency: this.ctx.baseLatency,
      flow: +this.flow.toFixed(2), derived: P, music: this.music.debug(), ambience: this.amb.debug(), sfx: this.sfx.debug(),
      voices: { ...VOICES },
      mix: { reverb: this.mix.reverbName, reverbSeconds: +(this.mix.reverbSeconds || 0).toFixed(2), echo: this.mix.echo, insert: this.mix.insert, muffle: this.mix._muffle, volume: this.volume, levels: this.offline ? null : this.mix.levels() },
    };
  }

  _hookDebug() {
    if (this._hooked || this.offline || typeof window === 'undefined' || !window.__rv) return;
    this._hooked = true;
    const rv = window.__rv;
    rv.audioDebug = () => this.debug();
    rv.audioSet = (o = {}) => { Object.assign(this.over, o); return this.debug(); };
    rv.audioUnlock = () => { this.unlock(); return this.debug(); };
    rv.audioRender = (opts) => Audio.renderOffline(opts);
    if (this._overlayWanted) import('./overlay.js').then((m) => { this._overlay = new m.AudioOverlay(this); }).catch((e) => console.warn('[audio] overlay', e));
  }

  // ------------------------------------------------------------------ offline rendering (tests / critics)
  /**
   * Render N seconds of a scene. opts: { seconds, sampleRate, scene: 'cosmic'|'galaxy'|'space'|'surface',
   *   art: art key, seed, over: {derived param overrides: night, rain, wind, shore, city, cityStyle, flora, fauna, space,
   *   underwater, hot, flash}, params: {speed, glide, engine, engineType, boost, cosmicGrowth, danger},
   *   walk: steps/s (footsteps on `surface`), surface, events: [{t, play, opts} | {t, param, value} | {t, over:{}}] }
   * Returns { sampleRate, channels: [Float32Array, Float32Array], debug, timeline }.
   */
  static async renderOffline(opts = {}) {
    const seconds = opts.seconds ?? 20, sr = opts.sampleRate ?? 44100;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(2, Math.ceil(seconds * sr), sr);
    const a = new Audio({ quality: { tier: opts.quality || 'high' }, params: { seed: opts.seed ?? 1 } }, { offline: ctx });
    const scene = opts.scene || 'surface';
    const art = opts.art || 'ghibli';
    const civ = { village: 'village', neon: 'neon', industrial: 'industrial', monastery: 'monastery' };
    const body = { seed: opts.seed ?? 1234, art: { key: art }, type: opts.type || 'terran', life: { flora: opts.over?.flora ?? 0.8, fauna: opts.over?.fauna ?? 0.6 }, civ: { style: civ[opts.over?.cityStyle] || opts.over?.cityStyle || 'village' }, ocean: { present: true } };
    a.scene = scene; a.sceneParams = scene === 'surface' ? { body } : {};
    a._build(ctx);
    Object.assign(a.params, opts.params || {});
    a.over = { ...(opts.over || {}) };
    for (const [bus, v] of Object.entries(opts.buses || {})) a.mix.setBus(bus, v, 0, 0.001);
    const evs = (opts.events || []).map((e) => ({ ...e })).sort((x, y) => x.t - y.t);
    const timeline = [];
    const dt = 1 / 30;
    let nextStep = 0.5, side = 1;
    for (let t = 0; t < seconds; t += dt) {
      a._vt = t;
      for (const e of evs) {
        if (e.done || e.t > t) continue;
        e.done = true;
        if (e.play) a.play(e.play, e.opts || {});
        if (e.param) a.setParam(e.param, e.value);
        if (e.over) Object.assign(a.over, e.over);
        if (e.scene) a.setScene(e.scene, e.art ? { body: { ...body, art: { key: e.art } } } : a.sceneParams);
        timeline.push([+t.toFixed(2), e.play || e.param || e.scene || 'over']);
      }
      if (opts.walk && t >= nextStep) { a.play('step', { surface: opts.surface || 'grass', speed: opts.params?.speed ?? 3, side }); side = -side; nextStep += 1 / opts.walk; }
      a.update(dt);
    }
    const debug = a.debug();
    const buf = await ctx.startRendering();
    return { sampleRate: sr, channels: [buf.getChannelData(0), buf.getChannelData(1)], debug, timeline };
  }

  _senseOffline(dt) {
    const P = this.P, p = this.params;
    P.scene = this.scene === 'surface' ? 'surface' : this.scene;
    if (this.scene !== 'surface') { P.space = this.scene === 'space' ? 1 : this.scene === 'galaxy' ? 0.35 : 0.2; }
    const act = (p.glide ? 0.65 : 0) + clamp((p.speed || 0) / 14, 0, 0.5) + (p.engine ? 0.3 : 0);
    this.flow = smooth(this.flow, clamp(this.scene === 'cosmic' ? p.cosmicGrowth || 0 : act, 0, 1), 0.2, dt);
    P.rush = clamp(((p.speed || 0) - 8) / 60, 0, 1);
    Object.assign(P, this.over);
  }
}
