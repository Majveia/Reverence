// Engine: renderer, loop, quality, resize, and the glue between Director (modes),
// Input, Pipeline (post), UI and Audio.
//
// Normal mode: rAF loop, variable dt (clamped), dynamic resolution.
// Shot mode (?shot=1): deterministic. Sim time is frozen until the mode reports ready; the
// harness then drives time via window.__rv.advance(seconds) and captures frames.
import * as THREE from 'three';
import { Params } from './Params.js';
import { detectQuality } from './Quality.js';
import { Input } from './Input.js';
import { Director } from './Director.js';
import { G, updateCameraUniforms } from './Uniforms.js';
import { events } from './events.js';
import { Pipeline } from '../post/Pipeline.js';
import { Universe } from '../universe/Universe.js';
import { installTestAPI } from './TestAPI.js';

// No-op proxy used if an optional subsystem (UI/Audio) fails to load: any call is ignored.
function noopProxy(name) {
  const handler = { get: (t, k) => (k === 'isNoop' ? true : k in t ? t[k] : (() => noop)) };
  const noop = new Proxy(function () {}, { get: handler.get, apply: () => noop });
  console.warn(`[engine] ${name} unavailable — using no-op stub`);
  return new Proxy({}, handler);
}

export class Engine {
  constructor() {
    this.params = Params;
    this.canvas = document.getElementById('rv-canvas');
    this.events = events;
    this.G = G;

    // Renderer: reversed-Z (with float depth in the pipeline) gives precise depth from 5 cm to 10^10 m.
    const probe = document.createElement('canvas').getContext('webgl2');
    const clipControl = !!probe?.getExtension('EXT_clip_control');
    probe?.getExtension('WEBGL_lose_context')?.loseContext();
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: Params.shot,
      reversedDepthBuffer: clipControl,
    });
    this.reversedDepth = clipControl;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping; // pipeline tonemaps
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(0x000000, 1);

    this.quality = detectQuality(Params.quality, this.renderer);
    this.renderScale = 1.0;       // dynamic resolution multiplier
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);

    this.universe = new Universe(Params.seed);
    this.input = new Input(this.canvas);
    this.pipeline = new Pipeline(this);
    this.director = new Director(this);
    this.ui = null;
    this.audio = null;

    this.time = { t: Params.time ?? 0, dt: 0, frame: 0, scale: 1, real: 0 };
    this.fixedDt = 1 / 60;
    this.shot = Params.shot;
    this.running = false;
    this._frameTimes = [];
    this._dynTimer = 0;
    this._readyFrames = 0;
    this.isReady = false;
    // a mode is streaming in behind the transition veil (Director.go): nobody sees the frame rate, so
    // streaming subsystems may spend far more per frame (terrain uploads, flora jobs, civ placement)
    this.loading = false;

    if (this.shot) {
      document.body.classList.add('rv-shot');
      if (Params.ui) document.body.classList.add('rv-shot-ui');
    }

    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => { this._lastNow = performance.now(); });

    events.on('input:gesture', () => this.audio?.unlock?.());
  }

  get aspect() { return this.width / Math.max(1, this.height); }

  async init() {
    // Optional subsystems — loaded defensively so one broken track never blanks the app.
    try { const { UI } = await import('../ui/UI.js'); this.ui = new UI(this); }
    catch (e) { console.error('[engine] UI failed to load', e); this.ui = noopProxy('UI'); }
    try { const { Audio } = await import('../audio/Audio.js'); this.audio = new Audio(this); }
    catch (e) { console.error('[engine] Audio failed to load', e); this.audio = noopProxy('Audio'); }

    installTestAPI(this);
    if (Params.stats) this._installStats();
    this.resize();
    this._autoAudio();
  }

  /**
   * Music from the first moment: the audio context starts at boot, which plays at once wherever the browser
   * (or the page embedding us) allows sound without a gesture. Browsers that hold sound back until the
   * visitor interacts get it on the very first click, tap or key anywhere on the page (not only the canvas),
   * and a short notice says so.
   */
  _autoAudio() {
    const a = this.audio;
    if (!a || a.isNoop || this.shot || !a.unlock) return;
    const types = ['pointerdown', 'pointerup', 'mousedown', 'touchstart', 'touchend', 'keydown', 'click'];
    const running = () => a.ctx?.state === 'running';
    const off = () => { for (const t of types) document.removeEventListener(t, kick, true); };
    const kick = () => { a.unlock(); if (running()) off(); };
    for (const t of types) document.addEventListener(t, kick, { capture: true, passive: true });
    a.unlock();
    if (a.ctx) a.ctx.addEventListener?.('statechange', () => { if (running()) off(); });
    setTimeout(() => {
      if (running() || !a.ctx) return;
      const touch = this.quality.touch && !matchMedia?.('(pointer: fine)')?.matches;
      this.ui?.toast?.(touch ? 'Tap anywhere to start the music' : 'Click anywhere or press a key to start the music', { eyebrow: 'Sound', icon: 'tap', ms: 6000 });
    }, 1800);
  }

  resize() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    this.width = w; this.height = h;
    const pr = this.quality.pixelRatio * this.renderScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    G.uResolution.value.copy(db);
    G.uPixelRatio.value = pr;
    this.pipeline.setSize(db.x, db.y);
    this.director.current?.onResize(w, h);
    this.ui?.onResize?.(w, h);
  }

  start() {
    this.running = true;
    this._lastNow = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      if (this.shot) { this._shotTick(); return; }
      let dt = (now - this._lastNow) / 1000;
      this._lastNow = now;
      if (!(dt > 0)) dt = 0;
      dt = Math.min(dt, 0.1);
      this._trackPerf(dt);
      this.step(dt, true);
    };
    requestAnimationFrame(loop);
  }

  /** Advance simulation by dt (seconds) and optionally render. */
  step(dt, render = true) {
    const time = this.time;
    time.real += dt;
    time.dt = dt * time.scale;
    time.t += time.dt;
    time.frame++;
    G.uTime.value = time.t;
    G.uFrame.value = time.frame;

    this.input.update(dt);
    if (this.input.down('back') && !this.director.busy) this.director.back();
    this.director.update(time.dt, time.t);
    this.ui?.update?.(dt);
    this.audio?.update?.(dt);
    if (render) this.render();
    this.input.endFrame();
  }

  render() {
    const mode = this.director.current;
    if (!mode || !mode.entered) return;
    this.renderer.info.reset();
    mode.camera.updateMatrixWorld();
    updateCameraUniforms(mode.camera);
    this.director.render();
    this._statsFrame?.();
  }

  // ---------------------------------------------------------------- shot mode
  _shotTick() {
    // Before ready: keep streaming (dt = 0 → frozen sim), render occasionally so the page shows progress.
    if (this._advancing) return;
    const mode = this.director.current;
    if (!mode) return;
    // Before ready: render rarely (progress only). After ready: never render idly — frames are
    // rendered only by advance()/render(), so screenshots never queue behind idle software frames.
    this.step(0, !this.isReady && (this.time.frame % 60) === 0);
    // (never ready mid-transition: the mode switching out still reports its own readiness)
    if (!this.isReady && mode.entered && !this.director.busy) {
      if (mode.isReady()) { if (++this._readyFrames >= 3) { this.isReady = true; this.render(); events.emit('ready'); } }
      else this._readyFrames = 0;
    }
  }

  /** Deterministically simulate `seconds` at fixed dt, rendering the final frame. */
  async advance(seconds = 0, { render = true } = {}) {
    this._advancing = true;
    try {
      const n = Math.max(0, Math.round(seconds / this.fixedDt));
      for (let i = 0; i < n; i++) {
        this.step(this.fixedDt, false);
        // yield occasionally so workers/async loads can progress and the page stays responsive
        if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
      }
      // let streaming settle at the final position
      const mode = this.director.current;
      for (let k = 0; k < 600 && mode && mode.entered && !mode.isReady(); k++) {
        this.step(0, false);
        await new Promise((r) => setTimeout(r, 5));
      }
      if (render) { this.render(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }
    } finally {
      this._advancing = false;
    }
  }

  // ---------------------------------------------------------------- perf
  _trackPerf(dt) {
    const ft = this._frameTimes;
    // behind the transition veil frames are deliberately heavy (streaming with big budgets): they say nothing
    // about the scene's real cost, and must not leave the revealed world at a low resolution
    if (this.loading) { ft.length = 0; this._dynTimer = 0; return; }
    ft.push(dt);
    if (ft.length > 90) ft.shift();
    this._dynTimer += dt;
    const target = 1 / 55;
    // a device that is far too slow (under ~27 fps over the last 20 frames) is answered within half a
    // second and a bigger step, instead of lagging for several seconds while the 1.5 s average catches up
    const n = ft.length;
    let recent = 0;
    if (n >= 20) { for (let i = n - 20; i < n; i++) recent += ft[i]; recent /= 20; }
    const slow = n >= 20 && recent > target * 2 && this._dynTimer >= 0.5;
    if (!slow && (this._dynTimer < 1.5 || n < 60)) return;
    this._dynTimer = 0;
    const avg = slow ? recent : ft.reduce((a, b) => a + b, 0) / n;
    let s = this.renderScale;
    if (avg > target * 1.18 && s > 0.5) s = Math.max(0.5, s - (avg > target * 2 ? 0.2 : 0.1));
    else if (avg < target * 0.72 && s < 1) s = Math.min(1, s + 0.05);
    if (s !== this.renderScale) { this.renderScale = s; this.resize(); ft.length = 0; }
  }
  get fps() {
    const ft = this._frameTimes;
    if (!ft.length) return 0;
    return 1 / (ft.reduce((a, b) => a + b, 0) / ft.length);
  }

  _installStats() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:100;font:11px/1.35 ui-monospace,monospace;color:#9fd8ff;background:rgba(0,0,0,.45);padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre';
    document.body.appendChild(el);
    let acc = 0;
    this._statsFrame = () => {
      acc++;
      if (acc % 15) return;
      const i = this.renderer.info;
      el.textContent = `${this.fps.toFixed(0)} fps  scale ${this.renderScale.toFixed(2)}  q ${this.quality.tier}\n` +
        `calls ${i.render.calls}  tris ${(i.render.triangles / 1000).toFixed(0)}k  pts ${(i.render.points / 1000).toFixed(0)}k\n` +
        `geo ${i.memory.geometries}  tex ${i.memory.textures}  prog ${i.programs?.length ?? 0}`;
    };
  }
}
