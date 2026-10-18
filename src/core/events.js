// Tiny event bus. Used for decoupled cross-track communication, e.g.
//   events.emit('discovery', { kind: 'city', name })   → UI toast + audio sting
//   events.emit('mode:enter', { name })
//   events.emit('vehicle:enter', { type: 'bike' })
// Keep payloads plain objects. Document new event names in ARCHITECTURE.md.

export class Events {
  constructor() { this.map = new Map(); }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name).add(fn);
    return () => this.off(name, fn);
  }
  once(name, fn) {
    const off = this.on(name, (p) => { off(); fn(p); });
    return off;
  }
  off(name, fn) { this.map.get(name)?.delete(fn); }
  emit(name, payload) {
    const set = this.map.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error(`[events] handler for "${name}" failed`, e); }
    }
  }
}

export const events = new Events();
