// Director: owns the active Mode, runs transitions between scales, and keeps a
// navigation stack so "back" climbs up the scale hierarchy (surface → system → galaxy → cosmic).
//
// Modes are discovered automatically: every folder src/modes/<name>/index.js that
// `export default class extends Mode` becomes director.go('<name>').
//
// A transition (live play): the veil closes over the old scale while the warp cutscene starts (ui/Warp.js,
// 'mode:leaving'); the new mode is built (`enter`), its shaders compiled (`warmup`) and it streams in behind the
// veil with generous per-frame budgets (`engine.loading`) until it reports ready — so it is revealed whole, not
// popping in — then 'mode:shown' ends the warp and the veil opens. Code for the next scale is fetched ahead of
// time with preload() (fly-tos, idle time), so a transition does not wait on the network.
import { events } from './events.js';

const MODE_LOADERS = import.meta.glob('../modes/*/index.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export class Director {
  constructor(engine) {
    this.engine = engine;
    this.current = null;
    this.currentName = null;
    this.currentParams = null;
    this.stack = [];
    this.busy = false;
    this.fadeEl = document.getElementById('rv-fade');
    this.loaders = {};
    this._pre = {};
    for (const [path, loader] of Object.entries(MODE_LOADERS)) {
      const name = path.split('/').slice(-2)[0];
      this.loaders[name] = loader;
    }
  }

  get modeNames() { return Object.keys(this.loaders); }

  /**
   * Fetch a mode's code — and whatever it loads when entered (its module's own `preload` export, e.g. every
   * world subsystem for 'system') — ahead of time. Safe to call repeatedly; returns the module.
   */
  preload(name) {
    const load = this.loaders[name];
    if (!load) return Promise.resolve(null);
    if (!this._pre[name]) {
      this._pre[name] = load()
        .then(async (mod) => { try { await mod.preload?.(); } catch (_) { /* optional */ } return mod; })
        .catch((e) => { delete this._pre[name]; console.warn(`[director] preload "${name}" failed`, e); return null; });
    }
    return this._pre[name];
  }

  /** preload() once the browser is idle (after `delay` ms), so it never competes with the current scale. */
  preloadIdle(name, delay = 0) {
    if (this._pre[name] || !this.loaders[name] || this.engine.shot) return;
    const go = () => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => this.preload(name), { timeout: 4000 });
      else this.preload(name);
    };
    if (delay > 0) setTimeout(go, delay); else go();
  }

  /**
   * Switch to a mode.
   * @param {string} name  mode folder name
   * @param {object} params  passed to mode.enter()
   * @param {object} opts  { transition: 'fade'|'white'|'none', duration, push: true, replace: false,
   *                         hold: max ms to keep the veil up while the new mode streams in (0 = reveal at once) }
   */
  async go(name, params = {}, opts = {}) {
    if (this.busy) return false;
    if (!this.loaders[name]) { console.error(`[director] unknown mode "${name}"`); return false; }
    this.busy = true;
    const engine = this.engine;
    const transition = engine.params.shot ? 'none' : (opts.transition ?? 'fade');
    const dur = opts.duration ?? 700;
    try {
      events.emit('mode:leaving', { from: this.currentName, to: name, params });
      const code = this.preload(name);   // (usually already fetched; otherwise it downloads during the fade)
      // the veil closes black; a 'white' arrival flashes white only when the new world is revealed
      if (this.current && transition !== 'none') await this.fade(1, dur, '#000');
      if (this.current) {
        if (opts.push !== false && !opts.replace) this.stack.push({ name: this.currentName, params: this.currentParams });
        try { this.current.exit(); } catch (e) { console.error('[director] exit failed', e); }
        // an exited mode is never updated, rendered or asked whether it is ready again (the next scale's
        // code may still be downloading)
        this.current.entered = false;
        engine.pipeline.effects.length = 0;
        engine.pipeline.resetLook();
      }
      const mod = (await code) || await this.loaders[name]();
      const ModeClass = mod.default;
      const mode = new ModeClass(engine);
      this.current = mode; this.currentName = name; this.currentParams = params;
      mode.onResize(engine.width, engine.height);
      engine.input.setScheme(mode.inputScheme);
      await mode.enter(params);
      mode.entered = true;
      engine.pipeline.setLook(mode.look || {});
      events.emit('mode:enter', { name, params, mode });
      if (transition !== 'none') {
        await this.settle(mode, opts.hold);
        events.emit('mode:shown', { name, params, mode });
        if (transition === 'white') await this.flash();
        await this.fade(0, dur * 1.3, transition === 'white' ? '#fff' : '#000');
      } else {
        this.fade(0, 0);
        events.emit('mode:shown', { name, params, mode });
      }
      return true;
    } catch (e) {
      console.error(`[director] failed to enter mode "${name}"`, e);
      this.fade(0, 0);
      engine.loading = false;
      return false;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Behind the veil: compile the new scale's shaders, then let it stream in (terrain, vegetation, towns, stars …)
   * with generous budgets until it reports ready or `hold` ms have passed (default: the mode's `holdMs`, else
   * 6.5 s). Modes with `revealWhenReady === false` are shown at once.
   */
  async settle(mode, hold) {
    const engine = this.engine;
    const cap = hold ?? mode.holdMs ?? 6500;
    if (!(cap > 0) || mode.revealWhenReady === false) return;
    const t0 = performance.now();
    engine.loading = true;
    try {
      if (mode.warmup) await Promise.race([Promise.resolve().then(() => mode.warmup()).catch((e) => console.warn('[director] warmup', e)), wait(cap)]);
      // at least two rendered frames (first-use uploads, the post pipeline's programs), then until ready
      for (let frames = 0; performance.now() - t0 < cap; frames++) {
        await nextFrame();
        if (this.current !== mode) return;
        let ready = true;
        try { ready = mode.isReady() !== false; } catch (_) { ready = true; }
        if (ready && frames >= 2) break;
      }
    } finally {
      engine.loading = false;
      mode.settleMs = Math.round(performance.now() - t0);
    }
  }

  /** Go up one level in the navigation stack. */
  async back() {
    if (this.busy) return false;
    if (this.current?.onBack?.()) return true;
    const prev = this.stack.pop();
    if (!prev) return false;
    return this.go(prev.name, { ...prev.params, returning: true }, { push: false, transition: 'fade' });
  }

  fade(to, ms = 700, color = '#000') {
    const el = this.fadeEl;
    if (!el) return Promise.resolve();
    el.style.transitionProperty = 'opacity';
    el.style.background = color;
    el.style.transitionDuration = ms + 'ms';
    // force style flush so transition runs
    void el.offsetWidth;
    el.style.opacity = String(to);
    if (ms <= 0) return Promise.resolve();
    return new Promise((res) => setTimeout(res, ms + 30));
  }

  /** Arrival flash: the closed veil blooms from black to white (the reveal then fades from white). */
  flash(ms = 160) {
    const el = this.fadeEl;
    if (!el) return Promise.resolve();
    el.style.transitionProperty = 'opacity, background-color';
    el.style.transitionDuration = ms + 'ms';
    void el.offsetWidth;
    el.style.opacity = '1';
    el.style.background = '#fff';
    return wait(ms + 20);
  }

  update(dt, t) {
    const m = this.current;
    if (!m || !m.entered) return;
    m.update(dt, t);
  }

  render() {
    const m = this.current;
    if (!m || !m.entered) return;
    m.render(this.engine.pipeline);
  }
}
