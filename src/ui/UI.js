// UI host. Owned by the UI track (src/ui/*). This is the API CONTRACT other tracks call —
// keep these method signatures stable (add, don't rename). Everything is DOM in #rv-ui.
//
//   ui.setLocation({ scale, title, subtitle })   breadcrumb: 'cosmic'|'galaxy'|'system'|'planet'|'surface'
//   ui.showTitle(title, subtitle, ms)            big cinematic title card (fades)
//   ui.prompt(id, text, action)                  contextual action prompt ("Enter bike" [F])
//   ui.clearPrompt(id)
//   ui.toast(text, { kind, ms })                 discovery / notification
//   ui.hint(text, ms)                            subtle help line
//   ui.setTelemetry({ speed, altitude, ... })    tiny readout (null to hide)
//   ui.setMarkers([{ id, x, y, visible, label, kind, distance }])  screen-space px
//   ui.setControls(scheme)                       'orbit'|'character'|'vehicle'|'flight' (touch layout)
//   ui.update(dt), ui.onResize(w, h)
import { events } from '../core/events.js';

export class UI {
  constructor(engine) {
    this.engine = engine;
    this.root = document.getElementById('rv-ui');
    this.root.innerHTML = `
      <div class="rvx-loc" style="position:absolute;left:calc(18px + var(--safe-left));top:calc(14px + var(--safe-top));font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--rv-fg-dim)"></div>
      <div class="rvx-title" style="position:absolute;left:0;right:0;top:38%;text-align:center;opacity:0;transition:opacity 1.2s"></div>
      <div class="rvx-prompts" style="position:absolute;left:50%;bottom:calc(64px + var(--safe-bottom));transform:translateX(-50%);display:flex;gap:10px"></div>
      <div class="rvx-hint" style="position:absolute;left:0;right:0;bottom:calc(20px + var(--safe-bottom));text-align:center;font-size:11px;letter-spacing:.12em;color:var(--rv-fg-faint);transition:opacity .8s"></div>
      <div class="rvx-toasts" style="position:absolute;right:calc(18px + var(--safe-right));top:calc(14px + var(--safe-top));display:flex;flex-direction:column;gap:6px;align-items:flex-end"></div>
      <div class="rvx-tele" style="position:absolute;right:calc(18px + var(--safe-right));bottom:calc(18px + var(--safe-bottom));font:11px var(--rv-mono);color:var(--rv-fg-dim);text-align:right"></div>
      <div class="rvx-markers"></div>`;
    this.el = {
      loc: this.root.querySelector('.rvx-loc'), title: this.root.querySelector('.rvx-title'),
      prompts: this.root.querySelector('.rvx-prompts'), hint: this.root.querySelector('.rvx-hint'),
      toasts: this.root.querySelector('.rvx-toasts'), tele: this.root.querySelector('.rvx-tele'),
      markers: this.root.querySelector('.rvx-markers'),
    };
    this._prompts = new Map();
    this._markerEls = new Map();
    events.on('discovery', (d) => this.toast(d.name ? `${d.kind ?? 'Discovered'} · ${d.name}` : String(d.kind)));
  }
  setLocation({ scale, title, subtitle } = {}) {
    this.el.loc.textContent = [scale, title, subtitle].filter(Boolean).join('  ·  ');
  }
  showTitle(title, subtitle = '', ms = 3500) {
    const t = this.el.title;
    t.innerHTML = `<div style="font-size:28px;font-weight:200;letter-spacing:.5em">${title}</div><div style="margin-top:10px;font-size:11px;letter-spacing:.3em;color:var(--rv-fg-dim)">${subtitle}</div>`;
    t.style.opacity = 1;
    clearTimeout(this._titleT);
    this._titleT = setTimeout(() => (t.style.opacity = 0), ms);
  }
  prompt(id, text, action) {
    let p = this._prompts.get(id);
    if (!p) { p = document.createElement('div'); p.style.cssText = 'font-size:12px;letter-spacing:.08em;padding:6px 10px;border-radius:999px;background:var(--rv-glass);border:1px solid var(--rv-glass-border);backdrop-filter:blur(8px)'; this.el.prompts.appendChild(p); this._prompts.set(id, p); }
    p.textContent = action ? `${text}` : text;
  }
  clearPrompt(id) { this._prompts.get(id)?.remove(); this._prompts.delete(id); }
  toast(text, { ms = 4000 } = {}) {
    const d = document.createElement('div');
    d.style.cssText = 'font-size:11px;letter-spacing:.1em;padding:6px 10px;border-radius:8px;background:var(--rv-glass);border:1px solid var(--rv-glass-border);transition:opacity .6s';
    d.textContent = text;
    this.el.toasts.appendChild(d);
    setTimeout(() => { d.style.opacity = 0; setTimeout(() => d.remove(), 700); }, ms);
  }
  hint(text, ms = 6000) {
    this.el.hint.textContent = text; this.el.hint.style.opacity = 1;
    clearTimeout(this._hintT);
    if (ms > 0) this._hintT = setTimeout(() => (this.el.hint.style.opacity = 0), ms);
  }
  setTelemetry(obj) {
    if (!obj) { this.el.tele.textContent = ''; return; }
    this.el.tele.textContent = Object.entries(obj).map(([k, v]) => `${k} ${v}`).join('   ');
  }
  setMarkers(list = []) {
    const seen = new Set();
    for (const m of list) {
      seen.add(m.id);
      let e = this._markerEls.get(m.id);
      if (!e) { e = document.createElement('div'); e.style.cssText = 'position:absolute;font-size:10px;letter-spacing:.12em;color:var(--rv-fg-dim);transform:translate(-50%,-50%);white-space:nowrap'; this.el.markers.appendChild(e); this._markerEls.set(m.id, e); }
      e.style.display = m.visible ? 'block' : 'none';
      e.style.left = m.x + 'px'; e.style.top = m.y + 'px';
      e.textContent = `◦ ${m.label ?? ''}`;
    }
    for (const [id, e] of this._markerEls) if (!seen.has(id)) { e.remove(); this._markerEls.delete(id); }
  }
  setControls(scheme) { this.scheme = scheme; }
  update(dt) {}
  onResize(w, h) {}
}
