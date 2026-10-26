// Cinematic transitions, drawn above the director's fade veil while a mode switch happens
// (mode:leaving → mode:shown — the director keeps the veil up until the new scale has streamed in),
// plus the boot "REVERENCE" loader. The layers themselves live in warpRender.js:
//   1. a tinted nebula tunnel, 2. the destination portrait (target galaxy / star / cosmic web),
//   3. black-body star streaks with a radial zoom blur, and here 4. the "ENTERING · <destination>" caption.
//
// Live play draws in a worker on an OffscreenCanvas (warp.worker.js): the transition is exactly when the main
// thread is busiest (building a planet), and a main-thread loop froze the tunnel mid-flight. The caption then
// animates with CSS (opacity / transform run on the compositor). Captures (`&uipanel=warp` in shot mode,
// deterministic, driven from ui.update) and browsers without OffscreenCanvas draw on the main thread.
import { events } from '../core/events.js';
import { escapeHtml } from './glyphs.js';
import { Params } from '../core/Params.js';
import { WarpRenderer, describeDest } from './warpRender.js';

const RANK = { cosmic: 0, galaxy: 1, system: 2 };

function mkCanvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

export class Warp {
  constructor(ui) {
    this.ui = ui;
    this.engine = ui.engine;
    let reduce = false;
    try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { /* ignore */ }
    this.enabled = !this.engine.shot && !reduce;
    // capture/debug: &uipanel=warp shows the transition deterministically (driven by ui.update)
    this.simDriven = this.engine.shot && Params.raw.get('uipanel') === 'warp';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'rv-warp';
    this.label = document.createElement('div');
    this.label.className = 'rv-warp-label';
    this.label.innerHTML = '<div class="k"></div><div class="n"></div><div class="s"></div><div class="bar"><i></i></div>';
    document.body.appendChild(this.canvas);
    document.body.appendChild(this.label);
    this.barEl = this.label.querySelector('.bar i');
    this.mobile = !!this.engine.quality?.mobile;
    this.phase = 'idle';     // idle | in | out | boot (mirrors the renderer, for the director / tests)
    this.R = null;           // main-thread renderer (captures, fallback)
    this.worker = null;      // off-thread renderer (live play)
    this.gen = 0;
    this._raf = 0;
    this._last = 0;
    this._loop = (now) => this._frame(now);

    if (this.simDriven) {
      this.R = new WarpRenderer(this.canvas, { mk: mkCanvas, mobile: this.mobile });
      this.canvas.classList.add('rv-warp-force'); this.label.classList.add('rv-warp-force');
      const p = Object.fromEntries(Params.raw.entries());
      const to = p.mode || 'system';
      const dest = describeDest(this.engine.universe, to, p);
      this.R.phase = 'in'; this.R.dir = 1; this.phase = 'in';
      this.R.setDest(dest);
      this._setLabel('Entering', this._destName(to, p), dest?.sub);
      this.canvas.style.display = 'block'; this.label.style.display = 'block';
      this._resize();
      return;
    }
    if (!this.enabled) return;
    if (!this._startWorker()) this.R = new WarpRenderer(this.canvas, { mk: mkCanvas, mobile: this.mobile });
    window.addEventListener('resize', () => this._resize());
    events.on('mode:leaving', (e) => { try { this.begin(e); } catch (err) { console.warn('[ui] warp', err); } });
    events.on('mode:shown', () => { try { this.end(); } catch (err) { console.warn('[ui] warp', err); } });
    // Boot: the fade veil is opaque until the first mode enters → show the wordmark loader.
    this.boot();
  }

  /**
   * Move drawing to a worker (OffscreenCanvas). Returns false when unsupported — and on software GL (VMs, remote
   * desktops, blocklisted GPUs): there one CPU-emulated GPU serves both, and a warp drawing every frame starved
   * the scale being built (~24 s more to load a galaxy). The main-thread warp only draws while that thread is
   * free. (`&warpworker=1` forces the worker, for tests.)
   */
  _startWorker() {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || !this.canvas.transferControlToOffscreen) return false;
    if (this.engine.quality?.software && Params.raw.get('warpworker') !== '1') return false;
    try {
      const off = this.canvas.transferControlToOffscreen();
      const w = new Worker(new URL('./warp.worker.js', import.meta.url), { type: 'module' });
      const { cw, ch, dpr } = this._size();
      w.postMessage({ type: 'init', canvas: off, w: cw, h: ch, dpr, mobile: this.mobile }, [off]);
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m?.type === 'idle' && m.gen === this.gen) { this.lastStats = m.stats; this._hide(); }
        else if (m?.type === 'error') this._workerFailed(m.message);
      };
      w.onerror = (ev) => { ev.preventDefault?.(); this._workerFailed(ev.message); };
      this.worker = w;
      this.label.classList.add('rv-warp-css');
      return true;
    } catch (e) {
      console.warn('[ui] warp worker unavailable, drawing on the main thread', e);
      return false;
    }
  }

  /** The worker died (or never loaded): continue on the main thread with a fresh canvas. */
  _workerFailed(msg) {
    if (!this.worker) return;
    console.warn('[ui] warp worker failed, drawing on the main thread', msg || '');
    try { this.worker.terminate(); } catch (_) { /* ignore */ }
    this.worker = null;
    const c = mkCanvas(1, 1); c.className = 'rv-warp'; c.style.display = this.canvas.style.display;
    this.canvas.replaceWith(c); this.canvas = c;
    this.label.classList.remove('rv-warp-css', 'rv-warp-on', 'rv-warp-off');
    this.R = new WarpRenderer(this.canvas, { mk: mkCanvas, mobile: this.mobile });
    this._resize();
    if (this.phase === 'in' || this.phase === 'boot') { if (this.phase === 'boot') this.R.boot(); else this.R.begin(this._dir, this._dest); this._startLocal(); }
  }

  boot() {
    this.phase = 'boot';
    this._setLabel('Reverence', 'a universe, alive', '');
    this._show();
    if (this.worker) this.worker.postMessage({ type: 'boot', gen: ++this.gen });
    else { this.R.boot(); this._startLocal(); }
  }

  begin({ from, to, params } = {}) {
    if (!from) return; // initial boot enter handled by boot()
    const rf = RANK[from] ?? 1, rt = RANK[to] ?? 1;
    const dir = rt >= rf ? 1 : -1;
    const toSame = to === from;
    const dest = describeDest(this.engine.universe, to, params || {});
    this.phase = 'in'; this._dir = dir; this._dest = dest;
    this._setLabel(dir > 0 ? (toSame ? 'Travelling to' : 'Entering') : 'Returning to', this._destName(to, params), dest?.sub);
    this._show();
    if (this.worker) this.worker.postMessage({ type: 'begin', gen: ++this.gen, dir, dest });
    else { this.R.begin(dir, dest); this._startLocal(); }
  }

  end() {
    if (this.phase === 'idle') return;
    this.phase = 'out';
    if (this.worker) {
      this.worker.postMessage({ type: 'end' });
      this.label.classList.remove('rv-warp-on'); this.label.classList.add('rv-warp-off');
    } else this.R?.end();
  }

  _destName(to, p = {}) {
    const U = this.engine.universe;
    try {
      if (to === 'cosmic') return 'The Cosmic Web';
      if (to === 'galaxy') return U.galaxy(parseInt(p.galaxy ?? 0, 10) || 0).name;
      if (to === 'system') {
        const g = parseInt(p.galaxy ?? 0, 10) || 0, s = parseInt(p.star ?? 0, 10) || 0;
        const sys = U.system(g, s);
        const b = p.planet !== undefined && p.planet !== null && p.planet !== '' ? U.body(sys, p.planet) : U.bestPlanet(sys);
        return b ? b.name : sys.star?.name ?? U.star(g, s).name;
      }
    } catch (_) { /* ignore */ }
    return '';
  }

  _setLabel(k, n, sub) {
    this.label.querySelector('.k').textContent = String(k || '').toUpperCase();
    this.label.querySelector('.n').innerHTML = escapeHtml(n || '');
    this.label.querySelector('.s').textContent = sub ? String(sub) : '';
  }

  _show() {
    this.canvas.style.display = 'block';
    this.label.style.display = 'block';
    if (this.worker) {
      // caption: CSS animations (compositor) instead of per-frame opacity from a main-thread loop
      this.label.classList.remove('rv-warp-off', 'rv-warp-on');
      void this.label.offsetWidth;   // restart the fade-in animation
      this.label.classList.add('rv-warp-on');
    }
    this._resize();
  }

  _hide() {
    this.canvas.style.display = 'none'; this.label.style.display = 'none';
    this.label.classList.remove('rv-warp-on', 'rv-warp-off');
    this.phase = 'idle';
  }

  _size() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    // ≤ 1.5 device px per CSS px and ≤ ~2.2 MP in all: the tunnel is motion-blurred light over black, and on big
    // or HiDPI screens its full-screen composites (zoom blur) would cost real GPU time while a world loads
    const dpr = Math.min(1.5, window.devicePixelRatio || 1, Math.sqrt(2.2e6 / (w * h)));
    return { cw: w, ch: h, dpr };
  }

  _resize() {
    const { cw, ch, dpr } = this._size();
    if (this.worker) this.worker.postMessage({ type: 'resize', w: cw, h: ch, dpr });
    else this.R?.resize(cw, ch, dpr);
  }

  // ------------------------------------------------------------------ main-thread loop (fallback, captures)
  _startLocal() {
    if (!this._raf) { this._last = performance.now(); this._raf = requestAnimationFrame(this._loop); }
  }

  /** Deterministic stepping for captures (&uipanel=warp in shot mode). */
  tick(dt) {
    if (!this.simDriven) return;
    let left = dt;
    while (left > 1e-6) { const h = Math.min(1 / 30, left); left -= h; this._step(h, left <= 1e-6); }
  }

  _frame(now) {
    this._raf = 0;
    if (!this.R) return;
    const dt = Math.min(0.25, Math.max(0, (now - this._last) / 1000));   // (the renderer caps it per phase)
    this._last = now;
    if (this._step(dt, true)) this._raf = requestAnimationFrame(this._loop);
  }

  _step(dt, draw) {
    const R = this.R;
    if (draw) {
      // the renderer draws for the current window size and veil colour
      this._resize();
      const bg = this.engine.director?.fadeEl?.style?.background || '';
      R.white = /255, 255, 255|#fff/i.test(bg);
    }
    if (!R.step(dt, draw)) { this._hide(); return false; }
    this.phase = R.phase;
    if (draw) {
      this.label.style.opacity = R.labelA.toFixed(3);
      if (this.barEl) this.barEl.style.setProperty('--x', `${((R.t * 0.8) % 1.4) * 100 - 40}%`);
    }
    return true;
  }
}
