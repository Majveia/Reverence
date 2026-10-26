// UI host. Owned by the UI track (src/ui/*). This is the API CONTRACT other tracks call —
// keep these method signatures stable (add, don't rename). Everything is DOM in #rv-ui.
//
//   ui.setLocation({ scale, title, subtitle })   breadcrumb (Universe › Galaxy › Star › World is derived
//                                                from the director; args are used as fallback/subtitle)
//   ui.showTitle(title, subtitle, ms)            big cinematic title card (fades)
//   ui.prompt(id, text, action)                  contextual action prompt with a device-adaptive glyph
//                                                ("Ride" + [F] / (Y) / touch icon). "A · Key   B · Key" = compound
//   ui.clearPrompt(id)
//   ui.toast(text, { kind, ms, eyebrow, icon })  discovery / notification capsule (top-right)
//   ui.hint(text, ms)                            subtle help line (ms <= 0 → stays until replaced)
//   ui.setTelemetry({ speed, altitude, ... })    tiny instrument readout, first entry emphasised (null hides)
//   ui.setMarkers([{ id, x, y, visible, label, kind, distance, sub }])  screen-space px (external markers)
//   ui.setControls(scheme)                       'orbit'|'character'|'vehicle'|'flight' (touch layout)
//   ui.update(dt), ui.onResize(w, h)
// Added:
//   ui.openMenu() / closeMenu() / toggleMenu()   pause menu (Esc · Start · ≡ button)
//   ui.openMap() / closeMap() / toggleMap()      scale navigation (M · Tab · View · ◇ button)
//   ui.setPhoto(bool)                            photo mode (hide all UI; H)
//   ui.reveal(name, kind)                        BotW-style location title
//   ui.shareState() → params for buildQuery()    ui.locationInfo() → { title, subtitle, crumbs, up }
//   ui.visible (bool)                            false while in photo mode
// URL helpers for captures: &touch=1 (force touch layer) · &uipanel=menu|map|controls
import './ui.css';
import { events } from '../core/events.js';
import { Params } from '../core/Params.js';
import { icon } from './icons.js';
import { glyphFor, promptHTML, escapeHtml } from './glyphs.js';
import { Touch } from './Touch.js';
import { Menu } from './Menu.js';
import { MapNav } from './MapNav.js';
import { WorldHud, fmtDist } from './WorldHud.js';
import { Warp } from './Warp.js';
import { G } from '../core/Uniforms.js';
import * as THREE from 'three';

const DEG = 180 / Math.PI;
const KIND_TOAST = {
  creature: ['New species', 'creature'], city: ['City discovered', 'city'], village: ['Settlement', 'village'],
  monument: ['Monument', 'monument'], ruin: ['Ruins', 'ruin'], wonder: ['Natural wonder', 'wonder'],
  landing: ['Landing site', 'landing'], summoned: ['Vehicle', 'vehicle'],
};
const TELE_LABEL = { speed: 'Speed', altitude: 'Alt', alt: 'Alt', z: 'Redshift', age: 'Cosmic age', heading: 'Hdg', throttle: 'Thr', gear: 'Gear', mode: 'Mode', grip: 'Surface', target: 'Target' };
// string keys rendered as a small status pill instead of a labelled value (ship: drive 'PULSE', status 'LANDED')
const BADGE_KEYS = new Set(['drive', 'status']);
// creature archetypes (fauna 'discovery' events) → icon + eyebrow word
const ARCHETYPE = {
  grazer: 'Grazer', giant: 'Colossus', hexapod: 'Hexapod', hopper: 'Hopper', critter: 'Critter',
  bird: 'Avian', ray: 'Sky ray', whale: 'Leviathan', jelly: 'Drifter', fish: 'Aquatic',
};
const BAR_KEYS = new Set(['boost', 'throttle', 'fuel', 'energy', 'charge', 'heat']);
const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const approach = (v, t, rate, dt) => v + (t - v) * (1 - Math.exp(-dt * rate));
/** Write opacity only when it changes (avoids redundant style invalidation every frame). */
export function op(el, v) { const s = typeof v === 'string' ? v : v.toFixed(3); if (el._rvOp !== s) { el._rvOp = s; el.style.opacity = s; } }

export class UI {
  constructor(engine) {
    this.engine = engine;
    this.input = engine.input;
    this.root = document.getElementById('rv-ui');
    this.root.innerHTML = `
      <div class="rv-markers"></div>
      <div class="rv-shade top" style="opacity:0"></div><div class="rv-shade bot" style="opacity:0"></div>
      <div class="rv-hud">
        <div class="rv-crumbs rv-anim"><div class="rv-crumb-row"></div><div class="rv-crumb-sub"></div></div>
        <div class="rv-title rv-anim" style="display:none"><div class="rv-title-main"></div><div class="rv-title-rule"></div><div class="rv-title-sub"></div></div>
        <div class="rv-toasts"></div>
        <div class="rv-prompts"></div>
        <div class="rv-hint rv-anim" style="opacity:0"></div>
        <div class="rv-onboard rv-anim" style="display:none"></div>
        <div class="rv-tele rv-anim" style="display:none"></div>
        <div class="rv-reticle" style="opacity:0"><i></i><i></i><i></i><i></i><b></b></div>
      </div>
      <div class="rv-fx"></div>
      <div class="rv-topbtns">
        <button class="rv-ibtn" data-b="map" data-sfx="ui.open" aria-label="Map"><span>${icon('map')}</span></button>
        <button class="rv-ibtn" data-b="menu" data-sfx="ui.open" aria-label="Menu"><span>${icon('menu')}</span></button>
      </div>
      <button class="rv-ibtn rv-photo-exit" data-sfx="ui.back" style="display:none" aria-label="Exit photo mode"><span>${icon('close')}</span></button>`;
    const q = (s) => this.root.querySelector(s);
    this.el = {
      hud: q('.rv-hud'), crumbs: q('.rv-crumbs'), crumbRow: q('.rv-crumb-row'), crumbSub: q('.rv-crumb-sub'),
      title: q('.rv-title'), titleMain: q('.rv-title-main'), titleRule: q('.rv-title-rule'), titleSub: q('.rv-title-sub'),
      toasts: q('.rv-toasts'), prompts: q('.rv-prompts'), hint: q('.rv-hint'), onboard: q('.rv-onboard'), tele: q('.rv-tele'),
      markers: q('.rv-markers'), fx: q('.rv-fx'), topbtns: q('.rv-topbtns'), photoExit: q('.rv-photo-exit'),
      shadeTop: q('.rv-shade.top'), shadeBot: q('.rv-shade.bot'), reticle: q('.rv-reticle'),
    };
    // ---- state
    this.device = 'keyboard';
    this.scheme = this.input.scheme || 'orbit';
    this.loc = { scale: '', title: '', subtitle: '' };
    this.crumbA = 0; this.crumbT = 0;
    this.titleS = null;
    this.toasts = [];
    this._recentToasts = new Map();
    this._prompts = new Map();
    this.hintS = { a: 0, t: 0, ms: 0, text: '' };
    this.teleS = { a: 0, data: null, keys: '', els: null };
    this.obS = { a: 0, t: 0, moved: 0, active: false, key: '' };
    this.idle = 0;
    this.hudA = 1;
    this.photo = false;
    this.photoBtnT = 0;
    this.visible = true;
    this.pauseCount = 0;
    this._markerEls = new Map();
    this._ctx = { hidden: false, hudAlpha: 1, prompts: this._prompts, promptActions: new Set(), playerState: null, safeL: 0, safeB: 0, titleBusy: false };
    this._safe = { l: 0, r: 0, t: 0, b: 0 };

    // ---- input bindings: Esc / Start open the menu (Backspace keeps director 'back')
    try {
      const b = this.input.bindings;
      b.back = (b.back || []).filter((c) => c !== 'Escape' && c !== 'Pad9');
      b.menu = ['Escape', 'Pad9'];
    } catch (_) { /* ignore */ }

    // ---- modules (each guarded: a broken module must never take the HUD down)
    this.world = this._try(() => new WorldHud(this, this.el.hud, this.el.markers));
    this.touch = this._try(() => new Touch(this, this.root));
    this.menu = this._try(() => new Menu(this, this.root));
    this.map = this._try(() => new MapNav(this, this.root));
    this.warp = this._try(() => new Warp(this));
    if (this.touch) this.root.insertBefore(this.touch.el, this.el.topbtns);

    // ---- DOM events
    this.el.topbtns.querySelector('[data-b="menu"]').addEventListener('click', (e) => { e.stopPropagation(); this.toggleMenu(); });
    this.el.topbtns.querySelector('[data-b="map"]').addEventListener('click', (e) => { e.stopPropagation(); this.toggleMap(); });
    this.el.photoExit.addEventListener('click', () => this.setPhoto(false));
    this.el.crumbRow.addEventListener('click', (e) => {
      const c = e.target.closest('[data-crumb]');
      if (!c) return;
      const info = this.locationInfo();
      info.crumbs[+c.dataset.crumb]?.go?.();
    });
    this.el.crumbs.addEventListener('pointerenter', () => { this.crumbT = 0; });
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Enter' || e.repeat) return;
      const P = this.menu?.open ? this.menu : this.map?.open ? this.map : null;
      if (P && P.focusIdx >= 0) { e.preventDefault(); P.activate(); }
    });

    // ---- engine events
    events.on('discovery', (d) => this._onDiscovery(d));
    events.on('mode:enter', () => { this._dofSet = undefined; this.crumbT = 0; this._renderCrumbs(); this._clearTransient(); this._applyUiPanelParam(); });
    events.on('input:scheme', ({ scheme }) => this.setControls(scheme));
    events.on('input:pointerlock', ({ locked }) => this._onPointerLock(locked));
    events.on('vehicle:exit', () => this.setTelemetry(null));

    // font warm-up (keeps canvas compass text crisp once the webfont arrives)
    try { document.fonts?.load?.('500 10px "RV Inter"'); } catch (_) { /* ignore */ }
    this._measureSafe();
  }

  _try(fn) { try { return fn(); } catch (e) { console.error('[ui] module failed', e); return null; } }

  // =================================================================== API contract
  setLocation({ scale, title, subtitle } = {}) {
    this.loc = { scale: scale ?? '', title: title ?? '', subtitle: subtitle ?? '' };
    this.crumbT = 0;
    this._renderCrumbs();
  }

  showTitle(title, subtitle = '', ms = 3500) {
    this.el.titleMain.textContent = String(title ?? '');
    this.el.titleSub.textContent = String(subtitle ?? '');
    this.titleS = { t: 0, dur: Math.max(1.5, ms / 1000), wait: 0 };
    this.el.title.style.display = '';
    this.el.title.style.opacity = '0';
  }

  prompt(id, text, action) {
    let p = this._prompts.get(id);
    if (!p) {
      const el = document.createElement('div');
      el.className = 'rv-prompt rv-anim';
      el.style.opacity = '0';
      this.el.prompts.appendChild(el);
      p = { el, text: null, action: null, dev: null, a: 0, dying: false };
      this._prompts.set(id, p);
    }
    if (p.dying) p._settled = false;
    p.dying = false;
    if (p.text !== text || p.action !== action || p.dev !== this.device) {
      p.text = text; p.action = action; p.dev = this.device;
      p.el.innerHTML = promptHTML(this.input, text, action, this.device);
      p.a = Math.min(p.a, 0.2); p._settled = false;
    }
    this._refreshPromptActions();
  }

  clearPrompt(id) {
    const p = this._prompts.get(id);
    if (p) { p.dying = true; p._settled = false; }
    this._refreshPromptActions();
  }

  /**
   * Discovery / notification toast. One toast is visible at a time (top-centre, under the compass); the rest
   * wait in a short queue and follow with a small gap, so a burst of discoveries never stacks over the view.
   */
  toast(text, { kind = 'info', ms = 4200, eyebrow, icon: ic } = {}) {
    const key = `${kind}|${text}`;
    const now = this.engine.time?.real ?? 0;
    if (this._recentToasts.has(key) && now - this._recentToasts.get(key) < 6) return;
    this._recentToasts.set(key, now);
    const info = KIND_TOAST[String(kind).toLowerCase()];
    const el = document.createElement('div');
    const isInfo = !info && (kind === 'info' || !kind);
    el.className = `rv-toast rv-anim${isInfo ? ' info' : ''}`;
    el.style.opacity = '0';
    el.style.display = 'none';
    const eb = eyebrow ?? (info ? info[0] : (kind && kind !== 'info' ? String(kind) : 'Notice'));
    el.innerHTML = `<span class="rv-toast-ic">${icon(ic ?? (info ? info[1] : 'discovery'))}</span>`
      + `<span class="rv-toast-eyebrow">${escapeHtml(eb)}</span><span class="rv-toast-dot"></span><span class="rv-toast-name">${escapeHtml(text)}</span>`;
    this.el.toasts.appendChild(el);
    this.toasts.push({ el, t: -1, dur: Math.max(1.6, Math.min(6, ms / 1000)), w: 0 });
    // keep the queue short: drop the oldest waiting ones (never the visible one)
    while (this.toasts.length > 4) { const i = this.toasts[0].t >= 0 ? 1 : 0; const o = this.toasts.splice(i, 1)[0]; o.el.remove(); }
    this._layoutDirty = true;
  }

  hint(text, ms = 6000) {
    const h = this.hintS;
    if (!text) { h.ms = 0.001; h.t = 1; return; }
    if (text !== h.text) { h.text = text; this._renderHint(); h.a = Math.min(h.a, 0.1); }
    h.t = 0; h.ms = ms > 0 ? ms / 1000 : Infinity;
  }

  setTelemetry(obj) {
    const s = this.teleS;
    if (!obj || typeof obj !== 'object') { if (s.data) this._layoutDirty = true; s.data = null; if (this.world) this.world.targetName = null; return; }
    if (!s.data) this._layoutDirty = true;
    s.data = obj;
    const keys = Object.keys(obj).join('|');
    if (keys !== s.keys) {
      s.keys = keys;
      this._layoutDirty = true;
      this.el.tele.innerHTML = Object.keys(obj).map((k, i) => {
        const cls = BADGE_KEYS.has(k) ? ' badge' : k === 'target' ? ' tgt' : i === 0 ? ' big' : '';
        const lbl = BADGE_KEYS.has(k) ? '' : `<span class="rv-tv-k">${k === 'target' ? `<i class="rv-tv-ic">${icon('target')}</i>` : ''}${escapeHtml(TELE_LABEL[k] ?? k)}</span>`;
        const arc = cls === ' big' && k === 'speed' ? ARC_SVG : '';
        return `<div class="rv-tv${cls}" data-k="${escapeHtml(k)}">${arc}${lbl}<span class="rv-tv-v"></span>${BAR_KEYS.has(k) ? '<span class="rv-tv-bar"><i></i></span>' : ''}</div>`;
      }).join('');
      s.els = [...this.el.tele.querySelectorAll('.rv-tv')].map((el) => ({ el, v: el.querySelector('.rv-tv-v'), bar: el.querySelector('.rv-tv-bar i'), arc: el.querySelector('.rv-arc .val'), tick: el.querySelector('.rv-arc .tick'), last: null, frac: -1 }));
    }
    const pulse = !!obj.drive;
    if (pulse !== s.pulse) { s.pulse = pulse; this.el.tele.classList.toggle('pulse', pulse); }
    const vals = Object.values(obj);
    let tgtName = null;
    s.els?.forEach((e, i) => {
      const k = e.el.dataset.k;
      const v = vals[i];
      let html;
      if (k === 'target' && v) {
        const parts = String(v).split(' · ');
        tgtName = parts[0];
        html = `${escapeHtml(parts[0])}${parts[1] ? `<small>${escapeHtml(parts.slice(1).join(' · '))}</small>` : ''}`;
      } else if (BADGE_KEYS.has(k)) html = escapeHtml(String(v ?? ''));
      else if (BAR_KEYS.has(k) && typeof v === 'number' && v >= 0 && v <= 1.001) {
        html = `${Math.round(v * 100)}<small>%</small>`;
        if (e.bar) e.bar.style.width = `${(v * 100).toFixed(1)}%`;
      } else html = fmtTele(v);
      if (html !== e.last) { e.v.innerHTML = html; e.last = html; }
      if (e.arc) {
        // thin arc gauge over the main readout: soft-saturating scale per unit (km/h, m/s, km/s …)
        const f = Math.round(gaugeFrac(v) * 200) / 200;
        if (f !== e.frac) {
          e.frac = f;
          e.arc.setAttribute('stroke-dasharray', `${(f * 100).toFixed(1)} 100`);
          const ph = (210 + 120 * f) * Math.PI / 180;
          e.tick.setAttribute('cx', (50 + 50 * Math.cos(ph)).toFixed(1));
          e.tick.setAttribute('cy', (58 + 50 * Math.sin(ph)).toFixed(1));
        }
      }
    });
    if (this.world) this.world.targetName = tgtName;
  }

  setMarkers(list = []) {
    const seen = this._seenMarkers || (this._seenMarkers = new Set());
    seen.clear();
    for (const m of list || []) {
      if (!m || m.id === undefined) continue;
      seen.add(m.id);
      let e = this._markerEls.get(m.id);
      if (!e) {
        const el = document.createElement('div');
        el.className = 'rv-mk ext';
        el.innerHTML = '<span class="rv-mk-name"></span><span class="rv-mk-sub"></span>';
        this.el.markers.appendChild(el);
        e = { el, name: el.firstChild, sub: el.lastChild, a: 0, label: null, subT: null, vis: false, x: 0, y: 0 };
        this._markerEls.set(m.id, e);
      }
      const kc = m.kind ? `rv-mk ext k-${String(m.kind).replace(/[^a-z0-9_-]/gi, '')}` : 'rv-mk ext';
      if (e.cls !== kc) { e.el.className = kc; e.cls = kc; }
      e.vis = !!m.visible; e.x = m.x; e.y = m.y; e.dead = false;
      const parts = String(m.label ?? '').replace(/^\s*[◦•·∘○]\s*/, '').split(' · ');
      const label = parts[0];
      let sub = m.sub ?? (parts.length > 1 ? parts.slice(1).join(' · ') : '');
      if (!sub && typeof m.distance === 'string') sub = m.distance;
      else if (!sub && m.unit && typeof m.distance === 'number') sub = `${m.distance.toFixed(m.distance < 10 ? 1 : 0)} ${m.unit}`;
      else if (!sub && m.kind && m.kind !== 'cosmic') sub = m.kind;
      if (label !== e.label) { e.name.textContent = label; e.label = label; }
      if (sub !== e.subT) { e.sub.textContent = sub; e.subT = sub; e.sub.style.display = sub ? '' : 'none'; }
    }
    for (const [id, e] of this._markerEls) if (!seen.has(id)) e.dead = true;
  }

  setControls(scheme) {
    if (!scheme) return;
    this.scheme = scheme;
    this.touch?.setScheme(scheme);
    this.obS.key = '';
  }

  // =================================================================== added API
  openMenu() { this.map?.close(); this.menu?.show(); }
  closeMenu() { this.menu?.close(); }
  toggleMenu() { if (this.menu?.open) this.menu.close(); else this.openMenu(); }
  openMap() { this.menu?.close(); this.map?.show(); }
  closeMap() { this.map?.close(); }
  toggleMap() { if (this.map?.open) this.map.close(); else this.openMap(); }
  reveal(name, kind) { this.world?.showReveal(name, kind); }

  setPhoto(on) {
    this.photo = !!on;
    this.visible = !this.photo;
    this.root.classList.toggle('rv-photo', this.photo);
    this.el.topbtns.style.display = this.photo ? 'none' : '';
    this.photoBtnT = this.photo ? 3 : 0;
    if (this.photo) { this.menu?.close(); this.map?.close(); }
    this._syncDof();
  }

  /**
   * Cinematic depth of field (post track: pipeline.setLook({ dof })) while the pause menu is open (the
   * world goes soft behind the glass) and in photo mode (auto-focus centre). Only on high/ultra and only
   * on planets (perspective scenes with meaningful depth); the previous setting is restored exactly.
   */
  _syncDof() {
    try {
      const pl = this.engine.pipeline, st = pl?.settings;
      if (!st?.dof || typeof pl.setLook !== 'function') return;
      const tier = this.engine.quality?.tier;
      const want = this.engine.director.currentName === 'system' && (tier === 'high' || tier === 'ultra') && (this.photo || !!this.menu?.open);
      const val = this.photo ? true : 'menu';
      if (want) {
        if (this._dofSet === undefined) this._dofPrev = st.dof.enabled;
        pl.setLook({ dof: this.photo ? { enabled: true, focus: 0, aperture: 1 } : { enabled: true, focus: 0, aperture: 1.6 } });
        this._dofSet = val;
      } else if (this._dofSet !== undefined) {
        if (st.dof.enabled === true) pl.setLook({ dof: { enabled: this._dofPrev ?? false, aperture: 1 } });
        this._dofSet = undefined;
      }
    } catch (_) { /* post is optional */ }
  }

  onPanel(open, which) {
    this.pauseCount = Math.max(0, this.pauseCount + (open ? 1 : -1));
    const t = this.engine.time;
    if (!this.engine.shot) {
      if (this.pauseCount > 0 && this._prevScale === undefined) { this._prevScale = t.scale; t.scale = 0; }
      else if (this.pauseCount === 0 && this._prevScale !== undefined) { t.scale = this._prevScale || 1; this._prevScale = undefined; }
    }
    this.touch?.releaseAll();
    if (open && this.input.mouse?.locked) { this._expectUnlock = true; try { this.input.exitPointerLock(); } catch (_) { /* ignore */ } }
    void which;
    this._syncDof();
  }

  bodyRef(world) {
    const sys = world?.system, b = world?.body;
    if (!sys || !b) return undefined;
    for (let i = 0; i < sys.planets.length; i++) {
      const p = sys.planets[i];
      if (p === b) return String(i);
      for (let j = 0; j < (p.moons?.length || 0); j++) if (p.moons[j] === b) return `${i}.${j}`;
    }
    return undefined;
  }

  locationInfo() {
    const e = this.engine, U = e.universe, d = e.director;
    const name = d.currentName, m = d.current, p = d.currentParams || {};
    const crumbs = [];
    const go = (mode, params) => () => { if (!d.busy) d.go(mode, params, { transition: 'fade', duration: 900 }); };
    crumbs.push({ label: 'Universe', ic: 'cosmic', go: name !== 'cosmic' ? go('cosmic', { returning: true }) : null });
    let title = this.loc.title || 'Reverence', subtitle = this.loc.subtitle || '', up = null, coords = '';
    try {
      if (name === 'cosmic') {
        title = 'The Cosmic Web';
        crumbs[0].label = 'Cosmic Web';
      } else if (name === 'galaxy') {
        const gi = m?.galaxyIndex ?? (parseInt(p.galaxy ?? 0, 10) || 0);
        const g = U.galaxy(gi);
        title = g.name; subtitle = `${g.type} galaxy · ${(g.starCount / 1e9).toFixed(0)} billion stars`;
        crumbs.push({ label: g.name, ic: 'galaxy' });
        up = { label: 'Back to the cosmic web', go: go('cosmic', { returning: true }) };
      } else if (name === 'system' && m?.world) {
        const w = m.world, b = w.body, st = w.star;
        const gi = st?.galaxy ?? 0;
        const g = U.galaxy(gi);
        title = b?.name ?? '';
        subtitle = [b?.art?.name, b ? `${b.type}${b.isMoon ? ' moon' : ''}` : '', b?.civ?.level > 0 && b.civ.name ? b.civ.name : ''].filter(Boolean).join(' · ');
        crumbs.push({ label: g.name, ic: 'galaxy', go: go('galaxy', { galaxy: gi, returning: true }) });
        crumbs.push({ label: st?.name ?? '', ic: 'star', go: go('system', { galaxy: gi, star: st.index, planet: this.bodyRef(w), view: 'orbit' }) });
        crumbs.push({ label: b?.name ?? '', ic: 'planet' });
        up = { label: `Back to ${g.name}`, go: go('galaxy', { galaxy: gi, returning: true }) };
        const pos = (w.controller && w.controller.pos) || w.player?.pos || w.camera?.position;
        if (pos) {
          const r = pos.length() || 1;
          const lat = Math.asin(Math.max(-1, Math.min(1, pos.y / r))) * DEG, lon = Math.atan2(pos.x, pos.z) * DEG;
          coords = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
        }
      }
    } catch (_) { /* partial info is fine */ }
    return { title, subtitle, crumbs, up, coords };
  }

  shareState() {
    const e = this.engine, d = e.director, name = d.currentName, m = d.current;
    const st = { mode: name };
    if (e.universe?.seed !== undefined && e.universe.seed !== 1) st.seed = e.universe.seed;
    try {
      if (name === 'galaxy') st.galaxy = m?.galaxyIndex ?? d.currentParams?.galaxy;
      if (name === 'system' && m?.world) {
        const w = m.world;
        st.galaxy = w.star?.galaxy; st.star = w.star?.index; st.planet = this.bodyRef(w);
        const c = w.controller, pl = w.player;
        const pos = (c && c.pos) || pl?.pos || w.camera.position;
        const r = pos.length() || 1;
        st.lat = Math.asin(Math.max(-1, Math.min(1, pos.y / r))) * DEG;
        st.lon = Math.atan2(pos.x, pos.z) * DEG;
        if (this.world) st.yaw = ((this.world.heading * DEG) + 360) % 360;
        const vt = c && c !== pl ? String(c.type || '') : '';
        st.view = /ship/.test(vt) ? 'ship' : /rover/.test(vt) ? 'rover' : /bike/.test(vt) ? 'bike' : (pl?.view || 'surface');
        const tod = w.celestial?.localTime?.(pos.clone().normalize());
        if (Number.isFinite(tod)) st.tod = tod;
      }
    } catch (_) { /* ignore */ }
    if (Params.quality) st.q = Params.quality;
    return st;
  }

  // =================================================================== frame
  update(dt) {
    try { this._update(Math.min(0.1, Math.max(0, dt || 0))); }
    catch (e) { if (!this._warned) { console.error('[ui] update failed', e); this._warned = true; } }
  }

  _update(dt) {
    const input = this.input;
    // ---- device changes → re-render glyphs
    const dev = this.touch?.active ? 'touch' : (input.lastDevice || 'keyboard');
    if (dev !== this.device) {
      this.device = dev;
      this.root.classList.toggle('rv-touchmode', dev === 'touch');
      for (const [, p] of this._prompts) if (!p.dying) { p.el.innerHTML = promptHTML(input, p.text, p.action, dev); p.dev = dev; }
      this.obS.key = '';
      if (this.hintS.text) this._renderHint();
      if (this.menu?.open) this.menu.render();
    }

    // ---- global actions
    const panelOpen = !!(this.menu?.open || this.map?.open);
    if (input.down('menu')) {
      if (this.photo) this.setPhoto(false);
      else if (this.map?.open) this.map.close();
      else this.toggleMenu();
    } else if (input.down('map') && !this.menu?.open && !this.photo) this.toggleMap();
    else if (input.down('photo') && !panelOpen) this.setPhoto(!this.photo);
    if (panelOpen) {
      const P = this.menu?.open ? this.menu : this.map;
      if (input.down('up') || input.down('left')) P.nav(-1);
      if (input.down('down') || input.down('right')) P.nav(1);
      if (input.down('interact') || (input.down('jump') && dev === 'gamepad')) P.activate();
    }

    // ---- idle / activity
    const mv = input.axis('move'), lk = input.axis('look');
    const active = mv.lengthSq() > 0.01 || Math.abs(lk.x) + Math.abs(lk.y) > 1e-4 || Math.abs(input.zoom) > 1e-4 || input.pointer.clicked || (input.mouse && (input.mouse.dx || input.mouse.dy)) || input.keys.size > 0;
    this.idle = active ? 0 : this.idle + dt;
    if (active && !input.mouse?.locked && input.mouse && (input.mouse.dx || input.mouse.dy) && input.pointer.y < 90 && input.pointer.x < 420) this.crumbT = Math.min(this.crumbT, 2);
    const hidden = this.photo || !!(this.map?.open) || !!(this.menu?.open);
    const idleHide = this.idle > 36 && !this.engine.shot;
    this.hudA = approach(this.hudA, idleHide ? 0 : 1, idleHide ? 0.8 : 6, dt);
    const ctx = this._ctx;
    ctx.hidden = hidden; ctx.hudAlpha = this.hudA; ctx.safeL = this._safe.l; ctx.safeB = this._safe.b;
    ctx.titleBusy = !!this.titleS;
    ctx.titleShown = !!this.titleS && this.titleS.t > 0;
    ctx.hintVisible = this.hintS.a > 0.08;
    const w = this.engine.director.current?.world;
    ctx.playerState = w?.player && w.controller === w.player ? w.player.state : null;

    // photo mode: exit button shows briefly after a tap
    if (this.photo) {
      if (input.pointer.clicked) this.photoBtnT = 3;
      this.photoBtnT -= dt;
      const show = this.photoBtnT > 0;
      this.el.photoExit.style.display = show ? '' : 'none';
    } else if (this.el.photoExit.style.display !== 'none') this.el.photoExit.style.display = 'none';

    op(this.el.hud, hidden ? '0' : this.hudA);
    const vis = hidden ? 'hidden' : '';
    if (this.el.hud._rvVis !== vis) { this.el.hud._rvVis = vis; this.el.hud.style.visibility = vis; }
    // top-right buttons: always (dimmed) on touch; on desktop they appear with pointer movement / Esc
    const ms = input.mouse;
    if ((ms && !ms.locked && (ms.dx || ms.dy) && !input.pointer.dragging) || input.down('menu') || panelOpen) this._ptrT = 3.5;
    this._ptrT = Math.max(0, (this._ptrT || 0) - dt);
    const tbA = dev === 'touch' ? 0.45 + 0.55 * this.hudA : dev === 'gamepad' ? 0 : ease(this._ptrT / 0.6);
    this.topA = approach(this.topA ?? tbA, tbA, tbA > (this.topA ?? 0) ? 10 : 3, dt);
    op(this.el.topbtns, this.topA);

    this._updateShade(dt, hidden, w);
    // flight reticle (ship): a small centre mark so steering has a reference point
    this.retA = approach(this.retA || 0, this.scheme === 'flight' && !hidden ? this.hudA : 0, 5, dt);
    op(this.el.reticle, this.retA < 0.01 ? 0 : this.retA);
    this._updateCrumbs(dt);
    this._updateTitle(dt);
    this._updateToasts(dt);
    this._updatePrompts(dt);
    this._anchorPrompts(dt, w, hidden);
    this._updateHint(dt);
    this._updateTele(dt);
    this._updateOnboard(dt);
    this._layoutToasts(dt);
    this._updateMarkers(dt, hidden);
    try { this.world?.update(dt, ctx); } catch (e) { if (!this._ww) { console.warn('[ui] world hud', e); this._ww = true; } }
    try { this.touch?.update(dt, ctx); } catch (e) { if (!this._tw) { console.warn('[ui] touch', e); this._tw = true; } }
    this.menu?.update(dt);
    this.map?.update(dt);
    this.warp?.tick(dt);
  }

  onResize(w, h) {
    this._measureSafe();
    this._layoutDirty = true;
    if (this.map?.open) this.map.render();
    void w; void h;
  }

  // =================================================================== internals
  _measureSafe() {
    try {
      const p = this._safeProbe || (this._safeProbe = Object.assign(document.createElement('div'), { style: 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0) env(safe-area-inset-right,0) env(safe-area-inset-bottom,0) env(safe-area-inset-left,0)' }));
      if (!p.isConnected) document.body.appendChild(p);
      const cs = getComputedStyle(p);
      this._safe = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
    } catch (_) { /* ignore */ }
  }

  _applyUiPanelParam() {
    if (this._panelParamDone) return;
    this._panelParamDone = true;
    const p = Params.raw.get('uipanel');
    if (p === 'menu') this.openMenu();
    else if (p === 'controls') { this.openMenu(); this.menu?.show('controls'); }
    else if (p === 'map') this.openMap();
    else if (p === 'photo') this.setPhoto(true);
  }

  _clearTransient() {
    for (const [, p] of this._prompts) { p.dying = true; p._settled = false; }
    this.setTelemetry(null);
    this.setMarkers([]);
    this.touch?.releaseAll();
  }

  _onPointerLock(locked) {
    if (locked) { this._expectUnlock = false; return; }
    if (this._expectUnlock) { this._expectUnlock = false; return; }
    if (this.engine.shot || this.photo) return;
    if (this.input.scheme === 'orbit') return;
    if (!this.menu?.open && !this.map?.open) this.openMenu();
  }

  _onDiscovery(d) {
    if (!d) return;
    if (d.source === 'ui') return; // location reveal already shows it
    const kind = String(d.kind ?? 'discovery').toLowerCase();
    const arch = d.archetype && ARCHETYPE[d.archetype] ? d.archetype : null;
    const opts = { kind, ms: 5200 };
    if (arch) { opts.icon = arch; opts.eyebrow = `New species · ${ARCHETYPE[arch]}`; }
    this.toast(d.name ? String(d.name) : String(d.kind ?? ''), opts);
  }

  _refreshPromptActions() {
    const s = this._ctx.promptActions;
    s.clear();
    for (const [, p] of this._prompts) if (!p.dying && p.action) s.add(p.action);
  }

  _renderCrumbs() {
    try {
      const info = this.locationInfo();
      const n = info.crumbs.length;
      const first = info.crumbs[0];
      this.el.crumbRow.innerHTML = `<span class="rv-crumb-ic">${icon(info.crumbs[n - 1].ic)}</span>` + info.crumbs.map((c, i) => {
        const far = i < n - 2 ? ' far' : '';
        return `${i ? `<span class="rv-crumb-sep${i <= n - 2 ? ' far' : ''}"></span>` : ''}<span class="rv-crumb${i === n - 1 ? ' cur' : ''}${far}" data-crumb="${i}">${escapeHtml(c.label)}</span>`;
      }).join('');
      void first;
      this.el.crumbSub.textContent = info.subtitle || this.loc.subtitle || '';
    } catch (e) { console.warn('[ui] crumbs', e); }
  }

  _updateCrumbs(dt) {
    this.crumbT += dt;
    const t = this.crumbT;
    const want = t < 9 ? 1 : 0.5;
    this.crumbA = approach(this.crumbA, want, t < 9 ? 3 : 0.8, dt);
    op(this.el.crumbs, this.crumbA);
    op(this.el.crumbSub, Math.max(0, Math.min(1, (9.5 - t) / 1.5)));
  }

  _updateTitle(dt) {
    const s = this.titleS;
    if (!s) return;
    // Hold the card until the scene behind it has something to show: never during a director transition (it
    // keeps the veil up while the new world streams in), and on the cosmic web until structure has visibly
    // formed (z < ~26; the first seconds are a near-uniform primordial fog). Max 5 s of that second hold so a
    // slow/failed renderer never swallows the title.
    if (s.t === 0 && this.engine.director.busy) return;
    if (s.t === 0 && s.wait < 5) {
      const d = this.engine.director;
      let hold = false;
      if (d.currentName === 'cosmic') {
        const m = d.current;
        const a = m?.a;
        hold = !(m?.icStage >= 1) || (Number.isFinite(a) && a > 0 && 1 / a - 1 > 26);
      }
      if (hold) { s.wait += dt; return; }
    }
    const el = this.el;
    if (s.t === 0) {
      // the opening (cosmic) card is the hero: centred, large, glowing. Every other arrival card is a compact
      // lower-third caption that holds ~2.5 s and gets out of the way of the view it introduces.
      s.hero = this.engine.director.currentName === 'cosmic';
      el.title.classList.toggle('hero', s.hero);
      el.title.classList.toggle('lower', !s.hero);
      if (!s.hero) s.dur = Math.min(s.dur, 4.4);
    }
    s.t += dt;
    const t = s.t, D = s.dur;
    const a = ease(t / (s.hero ? 1.0 : 0.8)) * Math.min(1, Math.max(0, (D - t) / (s.hero ? 1.4 : 1.1)));
    el.title.style.opacity = a.toFixed(3);
    const k = ease(t / 2.0);
    const ls = s.hero ? 0.36 + (1 - k) * 0.14 : 0.3 + (1 - k) * 0.12;
    el.titleMain.style.letterSpacing = `${ls.toFixed(3)}em`;
    el.titleMain.style.textIndent = `${ls.toFixed(3)}em`;
    const blur = (1 - ease(t / 1.1)) * 8;
    el.titleMain.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
    el.titleRule.style.width = `${(ease((t - 0.35) / 1.4) * (s.hero ? 150 : 84)).toFixed(1)}px`;
    el.titleSub.style.opacity = ease((t - 0.6) / 1.0).toFixed(3);
    if (t >= D) { this.titleS = null; el.title.style.display = 'none'; }
  }

  _updateToasts(dt) {
    this._toastGap = Math.max(0, (this._toastGap || 0) - dt);
    const o = this.toasts[0];
    if (!o) return;
    if (o.t < 0) {
      if (this._toastGap > 0) return;
      o.t = 0; o.el.style.display = ''; this._layoutDirty = true;
    }
    // something is waiting: the visible toast gives way after ~2.6 s
    if (this.toasts.length > 1 && !o.yielded) { o.yielded = true; o.dur = Math.min(o.dur, Math.max(2.6, o.t + 0.55)); }
    o.t += dt;
    const inA = ease(o.t / 0.5), outA = Math.min(1, Math.max(0, (o.dur - o.t) / 0.55));
    const a = inA * outA;
    op(o.el, a);
    const y = (1 - inA) * -8 + (1 - outA) * -5;
    const tr = `translate3d(0,${y.toFixed(2)}px,0) scale(${(0.97 + 0.03 * inA).toFixed(4)})`;
    if (o._tr !== tr) { o._tr = tr; o.el.style.transform = tr; }
    if (!o.w) o.w = o.el.offsetWidth || 220;
    const sh = -80 + ease((o.t - 0.2) / 1.2) * (o.w + 160);
    o.el.style.setProperty('--sh', `${sh.toFixed(1)}px`);
    if (o.t >= o.dur) { o.el.remove(); this.toasts.shift(); this._toastGap = 0.45; }
  }

  /**
   * Hint vs instruments: the free-text hint is centred at the bottom; when telemetry sits bottom-right
   * (desktop vehicles) and the two would overlap, the hint becomes a left-aligned footnote that wraps
   * within the space left of the instruments. Measured only when either changes (text, keys, resize).
   */
  _layoutHint() {
    const h = this.el.hint, tele = this.el.tele;
    const key = `${this.hintS.text}|${this.teleS.keys}|${!!this.teleS.data}|${this.device}|${this.root.clientWidth}x${this.root.clientHeight}`;
    if (key === this._hintKey) return;
    this._hintKey = key;
    let side = false, maxW = '';
    if (this.teleS.data && this.hintS.text && this.device !== 'touch' && tele.style.display !== 'none') {
      h.classList.remove('side'); h.style.maxWidth = '';
      const hr = h.getBoundingClientRect(), tr = tele.getBoundingClientRect();
      if (hr.width && tr.width && hr.right > tr.left - 12 && hr.bottom > tr.top - 4) {
        side = true;
        const gut = this.root.clientWidth <= 760 ? 14 : 18;
        maxW = `${Math.max(160, Math.floor(tr.left - 2 * gut - this._safe.l - 24))}px`;
      }
    }
    h.classList.toggle('side', side);
    h.style.maxWidth = maxW;
  }

  /**
   * Toast anchor: top-centre, just under whatever occupies the top-centre band (compass on planets, the
   * telemetry block in phone portrait). Measured only when a toast appears or the layout changed.
   */
  _layoutToasts(dt) {
    this._layoutT = (this._layoutT ?? 0) - dt;
    if (this.hintS.a > 0.01 || this.teleS.a > 0.01) this._layoutHint();
    if (!this.toasts.length) { this._layoutDirty = false; return; }
    if (!this._layoutDirty && this._layoutT > 0) return;
    this._layoutT = 0.5; this._layoutDirty = false;
    const H = this.root.clientHeight || window.innerHeight, W = this.root.clientWidth || window.innerWidth;
    let top = this._safe.t + (H <= 460 ? 10 : 16);
    const below = (el) => { if (!el || el.style.display === 'none') return; const r = el.getBoundingClientRect(); if (r.height > 0 && r.left < W * 0.62 && r.right > W * 0.38 && r.top < H * 0.4) top = Math.max(top, r.bottom + 6); };
    if (this.world?.compassA > 0.05) below(this.world.compassEl);
    if (this.teleS.data) below(this.el.tele);
    const T = this.el.toasts, px = `${Math.round(top)}px`;
    if (T.style.top !== px) T.style.top = px;
  }

  /**
   * Contrast protection. Thin light HUD type needs a dark ground over sunlit terrain, snow and sky: a soft
   * top gradient (behind breadcrumb + compass) and a bottom one (legend, hint, instruments, touch controls)
   * whose strength follows the light at the camera (G.uNight from the atmosphere) — barely there at night,
   * in space and in the black cosmic/galaxy modes, ~55 % at the top edge in full daylight.
   */
  _updateShade(dt, hidden, w) {
    let top = 0, bot = 0;
    if (w?.camera && w.body && !hidden) {
      const R = w.body.radius, alt = w.camera.position.length() - R;
      const onPlanet = 1 - Math.min(1, Math.max(0, (alt - R * 0.04) / (R * 0.1)));
      const day = 1 - Math.min(1, Math.max(0, G.uNight?.value ?? 0));
      const k = onPlanet * (0.3 + 0.7 * day);
      top = k;
      const bottomUsed = this.obS.a > 0.05 || this.teleS.a > 0.05 || this.hintS.a > 0.05 || this.device === 'touch';
      bot = bottomUsed ? k * 0.9 : 0;
    }
    this.shadeA = approach(this.shadeA ?? top, top * this.hudA, 2.5, dt);
    this.shadeB = approach(this.shadeB ?? bot, bot * this.hudA, 2.5, dt);
    op(this.el.shadeTop, this.shadeA);
    op(this.el.shadeBot, this.shadeB);
  }

  /**
   * BotW-style prompts: on foot in third person, the action pill sits beside the character (projected
   * from the player's hip), so it is read where the eye already is. Otherwise (first person, vehicles,
   * galaxy/cosmic) it falls back to the bottom-centre anchor.
   */
  _anchorPrompts(dt, w, hidden) {
    const P = this.el.prompts;
    let ok = false, x = 0, y = 0;
    const pl = w?.player;
    if (!hidden && this._prompts.size && pl?.pos && w.controller === pl && pl.view === 'surface' && w.camera) {
      const v = this._pv || (this._pv = new THREE.Vector3()), u = this._pu || (this._pu = new THREE.Vector3());
      u.copy(pl.pos).normalize();
      v.copy(pl.pos).addScaledVector(u, 0.95);
      if (w.toScene) w.toScene(v, v); else v.sub(w.origin);
      w.camera.updateMatrixWorld();
      v.project(w.camera);
      const W = this.engine.width, H = this.engine.height;
      if (v.z > -1 && v.z < 1 && Math.abs(v.x) < 0.8 && Math.abs(v.y) < 0.9) {
        ok = true;
        const pw = this._promptW || 160;
        x = Math.min(W - pw - 24 - this._safe.r, (v.x * 0.5 + 0.5) * W + Math.max(34, W * 0.035));
        y = Math.max(90, Math.min(H - 150, (-v.y * 0.5 + 0.5) * H));
      }
    }
    if (ok !== this._pAnch) {
      this._pAnch = ok;
      P.classList.toggle('anch', ok);
      if (!ok) { P.style.transform = ''; this._pX = undefined; }
    }
    if (!ok) return;
    const wk = [...this._prompts.values()].map((p) => p.text).join('|');
    if (wk !== this._promptWKey) { this._promptWKey = wk; this._promptW = P.offsetWidth || 160; }
    if (this._pX === undefined) { this._pX = x; this._pY = y; }
    this._pX = approach(this._pX, x, 14, dt); this._pY = approach(this._pY, y, 14, dt);
    const tr = `translate3d(${this._pX.toFixed(1)}px,${this._pY.toFixed(1)}px,0) translateY(-50%)`;
    if (this._pTr !== tr) { this._pTr = tr; P.style.transform = tr; }
  }

  _updatePrompts(dt) {
    for (const [id, p] of this._prompts) {
      const want = p.dying ? 0 : 1;
      p.a = approach(p.a, want, p.dying ? 10 : 9, dt);
      if (p.dying && p.a < 0.02) { p.el.remove(); this._prompts.delete(id); this._refreshPromptActions(); continue; }
      if (p.a > 0.999 && p._settled) continue;
      p._settled = p.a > 0.999;
      op(p.el, p._settled ? 1 : p.a);
      p.el.style.transform = p._settled ? 'none' : `translate3d(0,${((1 - p.a) * 6).toFixed(2)}px,0) scale(${(0.96 + 0.04 * p.a).toFixed(4)})`;
    }
  }

  _renderHint() {
    const h = this.el.hint;
    h.innerHTML = hintHTML(this._adaptHint(String(this.hintS.text || '')), this.device);
    this._hintChips = [...h.querySelectorAll('.rv-hc')];
    this._hintKey = '';
  }

  /** Drop keyboard-only phrases from free-text hints when the touch layer is active. */
  _adaptHint(text) {
    if (this.device !== 'touch') return text;
    const segs = text.replace(/scroll or pinch/g, 'pinch').split(/\s·\s/);
    const keep = segs.filter((x) => !/WASD|scroll|mouse|Shift|Space|Esc\b|\b[A-Z]\/[A-Z]\b|\b(?:[A-Z]|Ctrl)\s+(?:to\s)?[a-z]+$|^[A-Z]\s|\s[A-Z]$/.test(x));
    return keep.join(' · ').replace(/\bclick\b/g, 'tap');
  }

  _updateHint(dt) {
    const h = this.hintS;
    h.t += dt;
    const want = h.text && h.t < h.ms ? 1 : 0;
    // onboarding hints fade early once the user is clearly playing
    const early = h.t > 3.5 && this.idle === 0 && h.ms !== Infinity ? 0.35 : 1;
    h.a = approach(h.a, want * early, want ? 3 : 1.6, dt);
    op(this.el.hint, h.a);
    // chips arrive one after another (only during the first second of a new hint)
    const C = this._hintChips;
    if (C && C.length && h.t < C.length * 0.14 + 0.8) {
      for (let i = 0; i < C.length; i++) {
        const k = ease((h.t - i * 0.14) / 0.55);
        op(C[i], k);
        C[i].style.transform = k < 1 ? `translate3d(0,${((1 - k) * 5).toFixed(2)}px,0)` : '';
      }
    }
  }

  _updateTele(dt) {
    const s = this.teleS;
    s.a = approach(s.a, s.data ? 1 : 0, s.data ? 6 : 4, dt);
    if (s.a < 0.01) { if (this.el.tele.style.display !== 'none') this.el.tele.style.display = 'none'; return; }
    if (this.el.tele.style.display === 'none') this.el.tele.style.display = '';
    op(this.el.tele, s.a);
  }

  _updateOnboard(dt) {
    const s = this.obS;
    const dev = this.device;
    const wv = this.engine.director.current?.world;
    const onFoot = !!(wv?.player && wv.controller === wv.player && wv.player.view !== 'orbit');
    const want = this.scheme === 'character' && onFoot && dev !== 'touch' && !this.engine.director.busy;
    const key = want ? `${this.scheme}|${dev}` : '';
    if (key !== s.key) {
      s.key = key;
      if (want) {
        const g = (a) => glyphFor(this.input, a, dev);
        const items = dev === 'gamepad'
          ? [['move', g('sprint') ? 'LS' : ''], ['jump', g('jump')], ['sprint', g('sprint')], ['ride', g('vehicle')], ['map', g('map')], ['menu', g('menu')]]
          : [['move', `<span class="rv-keys">${['up', 'left', 'down', 'right'].map(g).join('')}</span>`], ['jump', g('jump')], ['sprint', g('sprint')], ['ride', g('vehicle')], ['map', g('map')], ['menu', g('menu')]];
        this.el.onboard.innerHTML = items.map(([l, gl]) => `<span class="rv-ob">${gl.startsWith('<') ? gl : `<span class="rv-g rv-g-pad rv-g-shoulder">${gl}</span>`}${l}</span>`).join('');
        if (!this._obCounted) {
          this._obCounted = true;
          let n = 0;
          try { n = +(localStorage.getItem('rv.onboard') || 0); localStorage.setItem('rv.onboard', String(n + 1)); } catch (_) { /* ignore */ }
          s.retired = n >= 4 && !this.engine.shot;
        }
        s.t = 0; s.moved = 0;
      }
    }
    s.t += dt;
    if (this.idle === 0 && s.t > 1.2) s.moved += dt;
    // legend: visible until ~8 s of actual play (or 40 s), then gone; comes back only if the player stands
    // idle for 20 s early in the session (a "how do I…?" moment), never during cinematic idle later on.
    const early = s.moved < 8 && s.t < 40;
    const recall = this.idle > 20 && s.moved < 45 && this.idle < 34;
    const show = want && !s.retired && s.t > 1.2 && (early || recall);
    s.a = approach(s.a, show ? 0.9 : 0, show ? 2.5 : 1.2, dt);
    if (s.a < 0.01) { if (this.el.onboard.style.display !== 'none') this.el.onboard.style.display = 'none'; return; }
    if (this.el.onboard.style.display === 'none') this.el.onboard.style.display = '';
    op(this.el.onboard, s.a);
  }

  _updateMarkers(dt, hidden) {
    for (const [id, e] of this._markerEls) {
      const want = e.dead || !e.vis || hidden ? 0 : 1;
      e.a = approach(e.a, want, want ? 10 : 8, dt);
      if (e.dead && e.a < 0.02) { e.el.remove(); this._markerEls.delete(id); continue; }
      e.el.style.opacity = e.a.toFixed(3);
      e.el.style.transform = `translate3d(${(+e.x || 0).toFixed(1)}px,${(+e.y || 0).toFixed(1)}px,0) translate(-50%,-100%)`;
    }
  }
}

// Hint segments → chips. "W/S throttle" → [W][S] throttle · "drag to orbit" → (mouse) orbit · "Mouse steer" …
const KEY_RE = /^((?:[A-Z]\/[A-Z])|WASD|Shift|Space|Ctrl|Esc|Tab|Mouse|LS|RS|LT|RT|LB|RB|[A-Z])\s+(?:to\s+)?(.+)$/;
const VERB_RE = /^(drag|scroll or pinch|scroll|pinch|double-tap|double-click|tap|click)\s+(?:to\s+)?(.+)$/i;
const PAD_TOKENS = new Set(['LS', 'RS', 'LT', 'RT', 'LB', 'RB']);
const FACE = { A: 'a', B: 'b', X: 'x', Y: 'y' };
const kc = (l) => `<span class="rv-g rv-g-key${l.length > 1 ? ' wide' : ''}">${escapeHtml(l)}</span>`;
const mouseG = (cls = '') => `<span class="rv-g rv-g-mouse${cls}"><i></i></span>`;
function hintChip(seg, dev) {
  let g = '', label = seg;
  let m = seg.match(VERB_RE);
  if (m) {
    const v = m[1].toLowerCase();
    label = m[2];
    if (dev === 'touch') g = `<span class="rv-g rv-g-touch">${icon(v === 'drag' ? 'drag' : /pinch|scroll/.test(v) ? 'pinch' : 'tap')}</span>`;
    else if (dev === 'gamepad') g = v === 'drag' ? '<span class="rv-g rv-g-pad rv-g-shoulder">RS</span>' : /pinch|scroll/.test(v) ? '<span class="rv-g rv-g-pad rv-g-shoulder">LT·RT</span>' : '<span class="rv-g rv-g-pad rv-g-face rv-g-a">A</span>';
    else g = v === 'drag' ? mouseG(' drag') : /pinch|scroll/.test(v) ? mouseG(' w') : mouseG();
    if (/^double/.test(v)) g = `<span class="rv-g-x2">2×</span>${g}`;
  } else if ((m = seg.match(KEY_RE))) {
    const k = m[1];
    label = m[2];
    if (k === 'Mouse') g = mouseG(' drag');
    else if (k === 'WASD') g = `<span class="rv-keys">${'WASD'.split('').map(kc).join('')}</span>`;
    else if (PAD_TOKENS.has(k)) g = `<span class="rv-g rv-g-pad rv-g-shoulder">${k}</span>`;
    else if (dev === 'gamepad' && FACE[k]) g = `<span class="rv-g rv-g-pad rv-g-face rv-g-${FACE[k]}">${k}</span>`;
    else if (k.includes('/')) g = `<span class="rv-keys">${k.split('/').map(kc).join('')}</span>`;
    else g = kc(k);
  }
  return `<span class="rv-hc">${g}<span class="rv-hl">${escapeHtml(label)}</span></span>`;
}
function hintHTML(t, dev) {
  return String(t).split(/\s·\s/).filter(Boolean).map((x) => hintChip(x.trim(), dev)).join('');
}

const ARC_SVG = '<svg class="rv-arc" viewBox="0 0 100 36" aria-hidden="true"><path class="trk" d="M6.7 33A50 50 0 0 1 93.3 33"/><path class="val" pathLength="100" stroke-dasharray="0 100" d="M6.7 33A50 50 0 0 1 93.3 33"/><circle class="tick" r="2.4" cx="6.7" cy="33"/></svg>';
const GAUGE_REF = { 'km/h': 140, 'm/s': 45, 'km/s': 260, 'mph': 90, 'kn': 80 };
function gaugeFrac(v) {
  let n = typeof v === 'number' ? v : NaN, unit = 'm/s';
  if (typeof v === 'string') {
    const m = v.replace(/,/g, '').match(/^\s*([-+]?[\d.]+)\s*(.*)$/);
    if (m) { n = parseFloat(m[1]); unit = (m[2] || '').trim().toLowerCase(); }
    if (/^mm\/s|^c\b|au/.test(unit)) return 1;
  }
  if (!Number.isFinite(n)) return 0;
  const ref = GAUGE_REF[unit] ?? 100;
  return 1 - Math.exp(-Math.abs(n) / ref);
}

function fmtTele(v) {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '–';
    const a = Math.abs(v);
    return a >= 1000 ? Math.round(v).toLocaleString('en-US') : a >= 10 ? v.toFixed(0) : v.toFixed(a >= 1 ? 1 : 2);
  }
  const s = String(v);
  const m = s.match(/^\s*([-+]?[\d.,]+)\s*([^\d\s].*)?$/);
  if (m) return `${escapeHtml(m[1])}${m[2] ? `<small>${escapeHtml(m[2])}</small>` : ''}`;
  return escapeHtml(s);
}
void fmtDist;
