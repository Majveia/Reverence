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
//
// Never a black screen (live play): a scale that fails to open is torn down and the director returns to the
// previous one ('mode:failed'); recover() rebuilds the current scale in place after a GPU reset; bail() leaves
// a scale that keeps throwing.
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
   *                         hold: max ms to keep the veil up while the new mode streams in (0 = reveal at once),
   *                         recover: true (live play: a failed enter returns to the previous scale, see _recover),
   *                         quiet: false (no warp cutscene / sound: a rebuild of the same place),
   *                         onShown: called when the new mode is revealed }
   * Returns true when `name` was entered. A failure in live play is recovered (previous scale, else the cosmic
   * web) and still returns false; check `director.current?.entered` for "is anything on screen".
   */
  async go(name, params = {}, opts = {}) {
    if (this.busy) return false;
    if (!this.loaders[name]) { console.error(`[director] unknown mode "${name}"`); return false; }
    const ok = await this._go(name, params, opts);
    const f = this._failure;
    this._failure = null;
    if (ok || !f) return ok;
    const engine = this.engine;
    // captures keep the old behaviour (the harness / boot falls back itself); a lost GPU context is rebuilt
    // by the engine once it is restored (engine._onContextRestored → recover())
    const dead = engine.gfx?.lost || engine.gfx?.halted;
    if (engine.shot || opts.recover === false || dead) {
      if (!dead) this.fade(0, 0);   // (a dead canvas stays behind the veil)
      return false;
    }
    await this._recover(f, opts);
    return false;
  }

  async _go(name, params, opts) {
    this.busy = true;
    const engine = this.engine;
    const transition = engine.params.shot ? 'none' : (opts.transition ?? 'fade');
    const dur = opts.duration ?? 700;
    let mode = null, exited = false;
    try {
      events.emit('mode:leaving', { from: opts.quiet ? null : this.currentName, to: name, params, quiet: !!opts.quiet });
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
      exited = true;   // (from here on the previous scale is gone: a failure must not leave a black screen)
      const mod = (await code) || await this.loaders[name]();
      const ModeClass = mod.default;
      mode = new ModeClass(engine);
      // (`resume` — where a rebuilt scale picks up, see recover() — is for this entry only: never remembered)
      const keep = params.resume === undefined ? params : { ...params };
      delete keep.resume;
      this.current = mode; this.currentName = name; this.currentParams = keep;
      mode.onResize(engine.width, engine.height);
      engine.input.setScheme(mode.inputScheme);
      await mode.enter(params);
      // (a GPU reset during enter: the scale is dead on arrival and is never run; recover() rebuilds it)
      mode.entered = !mode.stale;
      engine.pipeline.setLook(mode.look || {});
      events.emit('mode:enter', { name, params, mode });
      if (transition !== 'none') {
        await this.settle(mode, opts.hold);
        events.emit('mode:shown', { name, params, mode });
        try { opts.onShown?.(mode); } catch (e) { console.error('[director] onShown', e); }
        if (transition === 'white') await this.flash();
        await this.fade(0, dur * 1.3, transition === 'white' ? '#fff' : '#000');
      } else {
        this.fade(0, 0);
        events.emit('mode:shown', { name, params, mode });
        try { opts.onShown?.(mode); } catch (e) { console.error('[director] onShown', e); }
      }
      return true;
    } catch (e) {
      console.error(`[director] failed to enter mode "${name}"`, e);
      // the half-built mode never runs: free what it allocated (its exit() tolerates a partial enter)
      if (mode) {
        mode.entered = false;
        try { mode.exit(); } catch (err) { console.warn('[director] exit of the failed mode', err); }
        engine.pipeline.effects.length = 0;
        engine.pipeline.resetLook();
      }
      engine.loading = false;
      this._failure = { name, params, error: e, exited, mode };
      // (live play keeps the veil closed while _recover opens another scale; nothing torn down → reopen it)
      if (engine.shot || !exited) this.fade(0, 0);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /**
   * A scale failed to open (live play): the screen must not stay black. The old scale has already exited, so
   * go back to the previous scale on the stack (else the cosmic web; a failing cosmic web is retried once at
   * a lower tier). An allocation failure, or the second failure this session, also lowers the quality tier.
   */
  async _recover(f, opts) {
    const engine = this.engine;
    this.failures = (this.failures || 0) + 1;
    const err = f.error;
    const memory = err instanceof RangeError || /memory|alloc/i.test(String(err?.message || err));
    if (memory || this.failures === 2) engine.degrade?.('memory');
    if (!f.exited && this.current?.entered) return true;   // nothing was torn down: the old scale is still on screen
    // the previous scale (after a second failure, never the same kind of scale again), else the cosmic web —
    // which itself is retried once (at the lower tier) before giving up
    let target = null;
    while (this.stack.length && !target) {
      const prev = this.stack.pop();
      if (prev.name !== f.name || this.failures < 2) target = prev;
    }
    const retried = !!opts.retried || f.name === 'cosmic';
    if (!target && !(f.name === 'cosmic' && opts.retried)) target = { name: 'cosmic', params: {} };
    const what = { cosmic: 'the cosmic web', galaxy: 'this galaxy', system: 'this world' }[f.name] || 'this place';
    const where = { cosmic: 'the cosmic web', galaxy: 'the galaxy', system: 'your last world' }[target?.name] || target?.name;
    engine._emit?.('mode:failed', { name: f.name, error: String(err?.message || err), to: target?.name ?? null },
      () => engine.ui?.toast?.(target ? `Could not open ${what} — returned to ${where}` : `Could not open ${what}`, { eyebrow: 'Travel', ms: 5200 }));
    if (!target) { this.fade(0, 0); return false; }
    return this.go(target.name, { ...target.params, returning: true }, { push: false, transition: 'fade', retried, onShown: opts.onShown });
  }

  /**
   * Rebuild the current scale where the player is (after a GPU reset: everything it baked on the GPU is
   * gone). Waits for a transition in flight, then re-enters the scale with its own resume state
   * (`mode.resumeState()`: camera, timeline …) and the UI's share state (planet position, view, time of day).
   */
  async recover(opts = {}) {
    this.markStale();
    for (let i = 0; this.busy && i < 1200; i++) await wait(50);
    if (this.busy) return false;
    const name = this.currentName || 'cosmic', m = this.current;
    if (m) m.entered = false;
    const params = { ...(this.currentParams || {}) };
    try {
      const ui = this.engine.ui;
      const st = ui && !ui.isNoop && name === 'system' ? ui.shareState?.() : null;
      if (st && typeof st === 'object') for (const k of ['lat', 'lon', 'yaw', 'view', 'tod']) if (st[k] !== undefined) params[k] = st[k];
    } catch (_) { /* optional */ }
    try { Object.assign(params, m?._resume || m?.resumeState?.() || {}); } catch (_) { /* optional */ }
    if (m) params.returning = true;   // (no title card, camera memory)
    return this.go(name, params, { push: false, replace: true, transition: 'fade', quiet: true, hold: opts.hold, onShown: opts.onShown, recover: true });
  }

  /** The current scale was built on a lost GPU context: never update or draw it again (recover() replaces it). */
  markStale() {
    const m = this.current;
    if (!m || m.stale) return;
    // where to pick up again, captured before anything else runs on the dead scale
    try { m._resume = m.resumeState?.() || null; } catch (_) { m._resume = null; }
    m.stale = true;
    m.entered = false;
  }

  /**
   * The current scale keeps throwing every frame (engine step guard): leave it — up to the previous scale,
   * else rebuild the cosmic web.
   */
  async bail() {
    if (this.busy) return false;
    const engine = this.engine, from = this.currentName;
    const prev = this.stack.pop();
    engine._emit?.('mode:failed', { name: from, error: 'update', to: prev?.name ?? 'cosmic' }, () => engine.ui?.toast?.('Something went wrong here — taking you back', { eyebrow: 'Travel', ms: 5200 }));
    if (prev) return this.go(prev.name, { ...prev.params, returning: true }, { push: false, transition: 'fade' });
    return this.go('cosmic', {}, { push: false, replace: true, transition: 'fade' });
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
        // (a GPU reset meanwhile: this scale is dead, the engine rebuilds it once the context is back)
        if (this.current !== mode || !mode.entered || engine.gfx?.lost) return;
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
    if (!m || !m.entered || m.stale) return;
    m.update(dt, t);
  }

  render() {
    const m = this.current;
    if (!m || !m.entered || m.stale) return;
    m.render(this.engine.pipeline);
  }
}
