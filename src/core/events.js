// Minimal synchronous event bus.
export class Events {
  constructor() { this._m = new Map(); }

  on(type, fn) {
    let s = this._m.get(type);
    if (!s) this._m.set(type, (s = new Set()));
    s.add(fn);
    return () => s.delete(fn);
  }

  once(type, fn) {
    const off = this.on(type, (...a) => { off(); fn(...a); });
    return off;
  }

  off(type, fn) { this._m.get(type)?.delete(fn); }

  emit(type, ...args) {
    const s = this._m.get(type);
    if (!s) return;
    for (const fn of [...s]) {
      try { fn(...args); } catch (e) { console.error(`[events] handler for "${type}" threw`, e); }
    }
  }
}
