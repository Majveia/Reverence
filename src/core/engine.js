// Engine: renderer, main loop, realm management, travel transitions, module loading, quality scaling.
import * as THREE from 'three';
import { Events } from './events.js';
import { Input } from './input.js';
import { PostPipeline, defaultGrade } from './post/pipeline.js';
import { Universe } from './universe/index.js';

const QUALITY = {
  low: { dpr: 1.0, scale: 0.8, shadowMap: 1024, detail: 0.5, fxaa: true },
  medium: { dpr: 1.5, scale: 1.0, shadowMap: 2048, detail: 0.75, fxaa: true },
  high: { dpr: 2.0, scale: 1.0, shadowMap: 2048, detail: 1.0, fxaa: true },
  ultra: { dpr: 3.0, scale: 1.0, shadowMap: 4096, detail: 1.5, fxaa: true },
};

const ease = {
  linear: (t) => t,
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
};

export class Engine {
  constructor(canvas, params = {}) {
    this.canvas = canvas;
    /** Parsed URL parameters (strings). */
    this.params = params;
    this.harness = params.harness === '1';
    this.events = new Events();
    this.universe = new Universe(params.seed ? Number(params.seed) || undefined : undefined);
    this.ease = ease;

    const touch = (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
    const qName = params.q && QUALITY[params.q] ? params.q : this.harness ? 'high' : touch ? 'medium' : 'high';
    /** { name, dpr, scale, shadowMap, detail }  — `detail` scales instance counts / densities (0.5 … 1.5). */
    this.quality = { name: qName, ...QUALITY[qName] };

    const depthMode = params.depth || 'auto';   // auto | log | standard
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false, depth: false, powerPreference: 'high-performance',
      reversedDepthBuffer: depthMode === 'auto' || depthMode === 'reversed',
      logarithmicDepthBuffer: depthMode !== 'standard',
      preserveDrawingBuffer: this.harness,
    });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;          // tone mapping happens in the post pipeline
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap;
    r.info.autoReset = false;
    r.setClearColor(0x000000, 1);
    this.depthMode = r.capabilities.reversedDepthBuffer ? 'reversed' : r.capabilities.logarithmicDepthBuffer ? 'log' : 'standard';

    this.post = new PostPipeline(r, { fxaa: params.fxaa !== '0' && this.quality.fxaa });
    this.input = new Input(canvas, { harness: this.harness });

    this.realms = {};
    /** The realm currently being simulated and drawn. */
    this.realm = null;
    this.location = { realm: null };
    this.audio = null; this.ui = null; this.intro = null;

    this.time = 0;            // seconds since start (paused time excluded)
    this.dt = 0.016;
    this.frame = 0;
    this.paused = false;
    this.fixedDt = this.harness ? (Number(params.dt) || 1 / 60) : 0;
    this.pending = 0;         // async work in flight (see loading.begin/end)
    this._pendingTags = new Map();
    this._tweens = [];
    this._settle = [];
    this._idleFrames = 0;
    this._fps = { acc: 0, n: 0, value: 60, slow: 0, fast: 0 };
    this._traveling = false;
    this._last = performance.now();
    this._tick = this._tick.bind(this);

    /** Reference-count async work so loading UI and the screenshot harness know when the world has settled. */
    this.loading = {
      begin: (tag = 'work') => { this.pending++; this._pendingTags.set(tag, (this._pendingTags.get(tag) || 0) + 1); this.events.emit('loading', this.pending, tag); },
      end: (tag = 'work') => { this.pending = Math.max(0, this.pending - 1); const n = (this._pendingTags.get(tag) || 1) - 1; if (n <= 0) this._pendingTags.delete(tag); else this._pendingTags.set(tag, n); this.events.emit('loading', this.pending, tag); },
      get tags() { return null; },
    };

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    window.visualViewport?.addEventListener('resize', this._onResize);
    this.resize();
  }

  /** Dynamic import that never throws: a missing/broken optional module logs and yields null. */
  async load(path, label = path) {
    try { return await import(/* @vite-ignore */ new URL('../' + path, import.meta.url).href); }
    catch (e) { console.error(`[engine] module "${label}" failed to load:`, e); return null; }
  }

  registerRealm(realm) { this.realms[realm.name] = realm; return realm; }

  resize() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.dpr);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.width = w; this.height = h; this.aspect = w / h;
    this.post.setSize(Math.floor(w * dpr), Math.floor(h * dpr), this.quality.scale);
    for (const k in this.realms) this.realms[k].resize?.(w, h);
    this.events.emit('resize', w, h);
  }

  /** Tween helper driven by the main loop (deterministic in harness mode).  Resolves when done. */
  tween(duration, onUpdate, easing = ease.inOutCubic) {
    return new Promise((resolve) => {
      if (duration <= 0) { onUpdate(1); resolve(); return; }
      this._tweens.push({ t: 0, duration, onUpdate, easing, resolve });
    });
  }
  wait(seconds) { return this.tween(seconds, () => {}, ease.linear); }

  /**
   * Travel to another realm / place with a warp transition.
   * @param target { realm: 'cosmos'|'galaxy'|'system'|…, …realm-specific fields }
   * @param opts   { instant?: boolean, duration?: seconds, style?: 'warp'|'fade' }
   */
  async travel(target, { instant = false, duration = 2.6, style = 'warp' } = {}) {
    const next = this.realms[target.realm];
    if (!next) { console.warn('[engine] unknown realm', target.realm); return false; }
    if (this._traveling) return false;
    this._traveling = true;
    const post = this.post, prev = this.realm;
    this.events.emit('travel:start', target, prev?.name);
    const out = (v) => { if (style === 'warp') post.warp = v; else post.fade = v; };
    try {
      if (!instant && prev) await this.tween(duration * 0.42, (t) => out(t), ease.inCubic);
      if (!instant && prev) { post.fade = style === 'warp' ? 0 : 1; }
      prev?.exit?.(target);
      this.loading.begin('travel');
      try { await next.enter(target, prev?.name ?? null); } finally { this.loading.end('travel'); }
      this.realm = next;
      this.location = { ...target };
      next.resize?.(this.width, this.height);
      this.events.emit('realm', next.name, target);
      if (!instant && prev) await this.tween(duration * 0.58, (t) => out(1 - t), ease.outCubic);
      post.warp = 0; if (style !== 'warp') post.fade = 0;
    } catch (e) {
      console.error('[engine] travel failed', e); post.warp = 0; post.fade = 0;
      if (!this.realm) this.realm = prev;
    }
    this._traveling = false;
    this.events.emit('travel:end', target);
    return true;
  }
  get traveling() { return this._traveling; }

  start() { this._last = performance.now(); requestAnimationFrame(this._tick); }

  _tick(now) {
    requestAnimationFrame(this._tick);
    let dt = this.fixedDt || Math.min((now - this._last) / 1000, 0.1);
    const realDt = (now - this._last) / 1000;
    this._last = now;
    if (this.paused) dt = 0;
    this.dt = dt; this.time += dt; this.frame++;

    this.input.update();
    for (let i = this._tweens.length - 1; i >= 0; i--) {
      const tw = this._tweens[i]; tw.t += dt;
      const k = Math.min(1, tw.t / tw.duration);
      try { tw.onUpdate(tw.easing(k)); } catch (e) { console.error(e); }
      if (k >= 1) { this._tweens.splice(i, 1); tw.resolve(); }
    }

    const realm = this.realm;
    this.renderer.info.reset();
    if (realm) {
      try { realm.update(dt, this.time); } catch (e) { if (!this._errOnce) { this._errOnce = true; console.error('[engine] realm.update threw', e); } }
    }
    try { this.intro?.update?.(dt, this.time); this.audio?.update?.(dt, this.time); this.ui?.update?.(dt, this.time); } catch (e) { if (!this._errOnce2) { this._errOnce2 = true; console.error('[engine] module update threw', e); } }
    if (realm && realm.scene && realm.camera) {
      this.post.render({ scene: realm.scene, camera: realm.camera, passes: realm.passes || [], grade: realm.grade || (this._grade ??= defaultGrade()), dt, time: this.time });
    } else {
      this.renderer.setRenderTarget(null); this.renderer.clear();
    }
    this.events.emit('frame', dt, this.time);

    // settle bookkeeping (harness / loading screens)
    this._idleFrames = this.pending === 0 && !this._traveling ? this._idleFrames + 1 : 0;
    if (this._settle.length) {
      for (let i = this._settle.length - 1; i >= 0; i--) { const s = this._settle[i]; if (this._idleFrames >= s.frames) { this._settle.splice(i, 1); s.resolve(); } }
    }

    // adaptive resolution (real displays only)
    if (!this.harness && !this.paused && realDt > 0) {
      const f = this._fps; f.acc += realDt; f.n++;
      if (f.acc >= 1) {
        f.value = f.n / f.acc; f.acc = 0; f.n = 0;
        if (f.value < 42) { f.slow++; f.fast = 0; } else if (f.value > 57) { f.fast++; f.slow = 0; } else { f.slow = f.fast = 0; }
        const s = this.post.renderScale;
        if (f.slow >= 2 && s > 0.5) { this.post.setSize(this.post.width, this.post.height, Math.max(0.5, s - 0.1)); f.slow = 0; }
        else if (f.fast >= 6 && s < this.quality.scale) { this.post.setSize(this.post.width, this.post.height, Math.min(this.quality.scale, s + 0.05)); f.fast = 0; }
      }
    }
  }

  /** Resolves after the world has been idle (no pending async work) for `frames` consecutive rendered frames. */
  settle(frames = 30) { return new Promise((resolve) => this._settle.push({ frames, resolve })); }

  stats() {
    const i = this.renderer.info;
    return { frame: this.frame, time: +this.time.toFixed(2), realm: this.realm?.name, calls: i.render.calls, triangles: i.render.triangles, points: i.render.points, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length, fps: +this._fps.value.toFixed(1), renderScale: this.post.renderScale, size: [this.post.rw, this.post.rh], depth: this.depthMode, pending: [...this._pendingTags.keys()] };
  }
}
