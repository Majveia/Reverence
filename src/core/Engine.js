// Engine: renderer, loop, quality, resize, and the glue between Director (modes),
// Input, Pipeline (post), UI and Audio.
//
// Normal mode: rAF loop, variable dt (clamped), dynamic resolution.
// Shot mode (?shot=1): deterministic. Sim time is frozen until the mode reports ready; the
// harness then drives time via window.__rv.advance(seconds) and captures frames.
//
// Staying alive (live play):
//   GPU reset    'webglcontextlost' stops every GL call (the loop keeps input, UI and audio running) and emits
//                'gfx:lost'; on 'webglcontextrestored' the quality drops one tier, the pipeline is rebuilt and the
//                current scale is re-entered where the player was (director.recover) → 'gfx:restored' +
//                'gfx:degraded'. No restore within 4 s, a second loss within a minute, or a failed context
//                creation → 'gfx:failed' (the UI offers engine.reloadLower()).
//   errors       an update/render that throws is logged once; 30 failing frames in a row (or 3 s) leave the
//                scale (director.bail). Shot mode lets errors through to the harness, as before.
//   crashes      core/Sentinel.js (main.js): a page that died boots one tier lower ('gfx:degraded' reason 'crash').
import * as THREE from 'three';
import { Params, buildQuery } from './Params.js';
import { detectQuality, applyTier, lowerTier } from './Quality.js';
import { Sentinel } from './Sentinel.js';
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

const TIER_LABEL = { low: 'Low', med: 'Medium', high: 'High', ultra: 'Ultra' };

export class Engine {
  /** @param {object} opts  { crashTier, tierCap } from the crash sentinel (main.js) */
  constructor(opts = {}) {
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

    this.quality = detectQuality(Params.quality, this.renderer, { crashTier: opts.crashTier, cap: opts.tierCap });
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

    // GPU resets. three registered its own listeners first (WebGLRenderer constructor), so when ours run on
    // 'webglcontextrestored' its state is already re-initialised.
    this.gfx = { lost: false, failed: false, halted: false, recovering: false, losses: 0, lostAt: 0, restoredAt: 0 };
    this._errRun = 0;
    this.canvas.addEventListener('webglcontextlost', (e) => this._onContextLost(e), false);
    this.canvas.addEventListener('webglcontextrestored', () => { this._onContextRestored(); }, false);
    this.canvas.addEventListener('webglcontextcreationerror', () => this._gfxFailed('creation'), false);

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
    const m = this.director.current;
    if (m && !m.stale) m.onResize(w, h);   // (a scale built on a lost GPU context is about to be replaced)
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
    // without a GPU context nothing may touch GL: the scale waits, the UI and the music go on
    const gl = !this.gfx.lost && !this.gfx.halted;
    let ok = true;
    try {
      if (gl) {
        if (this.input.down('back') && !this.director.busy) this.director.back();
        ok = this._guard('update', () => this.director.update(time.dt, time.t));
      }
      this.ui?.update?.(dt);
      this.audio?.update?.(dt);
      if (render && gl) ok = this._guard('render', () => this.render()) && ok;
    } finally {
      this.input.endFrame();
    }
    // a scale that throws on every frame for ~30 frames (or 3 s on a slow device) is left: director.bail()
    if (ok) this._errRun = 0;
    else {
      if (this._errRun++ === 0) this._errSince = time.real;
      if ((this._errRun >= 30 || (this._errRun >= 5 && time.real - this._errSince > 3)) && !this.director.busy) {
        this._errRun = 0;
        this.director.bail();
      }
    }
  }

  /** Live play: run fn, log the first error of a failing run of frames (shot mode: errors reach the harness). */
  _guard(where, fn) {
    if (this.shot) { fn(); return true; }
    try { fn(); return true; } catch (e) {
      if (this._errRun === 0) console.error(`[engine] ${where} failed (${this.director.currentName})`, e);
      return false;
    }
  }

  render() {
    const mode = this.director.current;
    if (!mode || !mode.entered || mode.stale) return;
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

  // ---------------------------------------------------------------- staying alive
  /** Emit `name`; when nobody listens (the UI did not load, or predates the event) run `fallback` instead. */
  _emit(name, payload, fallback) {
    const heard = events.count(name) > 0;
    events.emit(name, payload);
    if (!heard && fallback) { try { fallback(); } catch (_) { /* optional */ } }
  }

  _toast(text, ms = 5200) { try { if (this.ui && !this.ui.isNoop) this.ui.toast?.(text, { eyebrow: 'Graphics', ms }); } catch (_) { /* optional */ } }

  _onContextLost(e) {
    e?.preventDefault?.();   // (three does too) — without it the browser never restores the context
    const g = this.gfx, now = performance.now();
    // a second reset within a minute of the last one (or of its recovery): this GPU cannot hold the scene
    const again = g.losses > 0 && now - Math.max(g.lostAt, g.restoredAt) < 60000;
    g.lost = true; g.losses++; g.lostAt = now;
    console.warn(`[engine] WebGL context lost (#${g.losses})`);
    this.loading = false;
    // the scale's GPU state is gone: never update or draw it again (the dead canvas shows blank; the rebuild
    // runs behind the transition veil, so the UI's card belongs above it)
    this.director.markStale();
    this._emit('gfx:lost', {}, () => this._toast('Graphics reset — restoring…', 6000));
    clearTimeout(this._gfxTimer);
    if (again) { this._gfxFailed('repeat'); return; }
    this._gfxTimer = setTimeout(() => { if (g.lost) this._gfxFailed('timeout'); }, 4000);
  }

  async _onContextRestored() {
    const g = this.gfx;
    clearTimeout(this._gfxTimer);
    if (g.halted) { console.warn('[engine] WebGL context restored after a failure: staying stopped (reload to continue)'); return; }
    console.warn('[engine] WebGL context restored: rebuilding one tier lower');
    g.lost = false; g.failed = false; g.recovering = true;
    this.director.markStale();
    this.renderer.setClearColor(0x000000, 1);
    const from = this.quality.tier;
    const tier = this.degrade('context', { notify: false }) || from;
    let shown = false;
    const done = () => {
      if (shown) return;
      shown = true;
      g.restoredAt = performance.now();
      this._emit('gfx:restored', { tier }, () => this._toast('Graphics restored', 3000));
      if (tier !== from) this._notifyDegraded('context', from);
    };
    try { await this.director.recover({ onShown: done }); } catch (e) { console.error('[engine] rebuild after the GPU reset failed', e); }
    g.recovering = false;
    if (!shown) { if (this.director.current?.entered) done(); else if (!g.lost) this._gfxFailed('rebuild'); }
  }

  /** The GPU could not be brought back: tell the UI (it offers engine.reloadLower()). */
  _gfxFailed(reason) {
    const g = this.gfx;
    if (reason === 'repeat' || reason === 'creation' || reason === 'rebuild') g.halted = true;
    if (g.failed) return;
    g.failed = true;
    const tier = this.quality.tier, next = lowerTier(tier);
    console.error(`[engine] graphics could not be restored (${reason})`);
    if (!this.shot) Sentinel.setCap(next);   // a manual reload now boots lower too
    this._emit('gfx:failed', { tier, next, reason }, () => {
      this.director.fade(0, 300);   // (nobody shows a card: let the toast through the veil)
      this._toast('Graphics stopped responding — reload the page to continue at a lower quality', 12000);
    });
  }

  /**
   * 'gfx:degraded' { tier, reason, from } — reason 'crash' (the previous page died), 'context' (after a GPU
   * reset) or 'memory' (a failed allocation) — or a toast when nobody listens.
   */
  _notifyDegraded(reason, from = null) {
    const tier = this.quality.tier, label = TIER_LABEL[tier] || tier;
    const text = reason === 'crash' ? (from && from !== tier ? `Reverence restarted after running out of memory — quality lowered to ${label}` : 'Reverence restarted after running out of memory — memory use reduced')
      : `Quality lowered to ${label} to keep the game running`;
    this._emit('gfx:degraded', { tier, reason, from }, () => this._toast(text, 7000));
  }

  /**
   * Lower the quality one tier now (a GPU reset, a failed allocation). The quality object changes in place
   * (cosmic web 64³, `quality.safe`), the pipeline drops its tier-dependent targets and the drawing buffer is
   * resized; the current scale keeps what it built — the next scale entered (or the rebuilt one) uses the new
   * tier. Returns the new tier, or null when already at 'low'.
   */
  degrade(reason = 'memory', { notify = true } = {}) {
    const q = this.quality, from = q.tier, to = lowerTier(from);
    applyTier(q, to, { safe: true });
    try { this.pipeline.rebuild?.(); } catch (e) { console.warn('[engine] pipeline rebuild', e); }
    this.resize();
    if (!this.shot) { Sentinel.update({ tier: to }); Sentinel.setCap(to); }
    if (to === from) return null;
    console.warn(`[engine] quality lowered ${from} → ${to} (${reason})`);
    if (notify) this._notifyDegraded(reason, from);
    return to;
  }

  /** The next boot is not a crash (call before a deliberate reload, e.g. the menu's quality change). */
  markCleanExit() { Sentinel.markCleanExit(); }

  /** Reload the page at the next lower tier, at the same place (the menu's hash-reload path). */
  reloadLower() {
    const tier = lowerTier(this.quality.tier);
    let st = null;
    try { if (this.ui && !this.ui.isNoop) st = this.ui.shareState?.(); } catch (_) { st = null; }
    if (!st || typeof st !== 'object' || !st.mode) {
      const d = this.director, p = d.currentParams || {};
      st = { mode: d.currentName || 'cosmic' };
      for (const k of ['galaxy', 'star', 'planet']) if (p[k] !== undefined && p[k] !== null) st[k] = p[k];
    }
    st.q = tier;
    if (!this.shot) Sentinel.setCap(tier);
    this.markCleanExit();
    // reload via the hash: embedded hosts (artifact previews, file shares) may drop ?query (core/hashParams.js)
    const q = buildQuery(st).slice(1);
    try { history.replaceState(null, '', location.pathname + '#' + q); location.reload(); }
    catch (_) { location.href = location.pathname + '?' + q; }
  }

  // ---------------------------------------------------------------- perf
  _trackPerf(dt) {
    const ft = this._frameTimes;
    // behind the transition veil frames are deliberately heavy (streaming with big budgets): they say nothing
    // about the scene's real cost, and must not leave the revealed world at a low resolution
    if (this.loading || this.gfx.lost || this.gfx.recovering) { ft.length = 0; this._dynTimer = 0; return; }
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
