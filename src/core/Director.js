// Director: owns the active Mode, runs transitions between scales, and keeps a
// navigation stack so "back" climbs up the scale hierarchy (surface → system → galaxy → cosmic).
//
// Modes are discovered automatically: every folder src/modes/<name>/index.js that
// `export default class extends Mode` becomes director.go('<name>').
import { events } from './events.js';

const MODE_LOADERS = import.meta.glob('../modes/*/index.js');

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
    for (const [path, loader] of Object.entries(MODE_LOADERS)) {
      const name = path.split('/').slice(-2)[0];
      this.loaders[name] = loader;
    }
  }

  get modeNames() { return Object.keys(this.loaders); }

  /**
   * Switch to a mode.
   * @param {string} name  mode folder name
   * @param {object} params  passed to mode.enter()
   * @param {object} opts  { transition: 'fade'|'white'|'none', duration, push: true, replace: false }
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
      if (this.current && transition !== 'none') await this.fade(1, dur, transition === 'white' ? '#fff' : '#000');
      if (this.current) {
        if (opts.push !== false && !opts.replace) this.stack.push({ name: this.currentName, params: this.currentParams });
        try { this.current.exit(); } catch (e) { console.error('[director] exit failed', e); }
        engine.pipeline.effects.length = 0;
        engine.pipeline.resetLook();
      }
      const mod = await this.loaders[name]();
      const ModeClass = mod.default;
      const mode = new ModeClass(engine);
      this.current = mode; this.currentName = name; this.currentParams = params;
      mode.onResize(engine.width, engine.height);
      engine.input.setScheme(mode.inputScheme);
      await mode.enter(params);
      mode.entered = true;
      engine.pipeline.setLook(mode.look || {});
      events.emit('mode:enter', { name, params, mode });
      if (transition !== 'none') await this.fade(0, dur * 1.3);
      else this.fade(0, 0);
      return true;
    } catch (e) {
      console.error(`[director] failed to enter mode "${name}"`, e);
      this.fade(0, 0);
      return false;
    } finally {
      this.busy = false;
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
    el.style.background = color;
    el.style.transitionDuration = ms + 'ms';
    // force style flush so transition runs
    void el.offsetWidth;
    el.style.opacity = String(to);
    if (ms <= 0) return Promise.resolve();
    return new Promise((res) => setTimeout(res, ms + 30));
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
