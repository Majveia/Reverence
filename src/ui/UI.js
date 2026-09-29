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
      <div class="rv-hud">
        <div class="rv-crumbs rv-anim"><div class="rv-crumb-row"></div><div class="rv-crumb-sub"></div></div>
        <div class="rv-title rv-anim" style="display:none"><div class="rv-title-main"></div><div class="rv-title-rule"></div><div class="rv-title-sub"></div></div>
        <div class="rv-toasts"></div>
        <div class="rv-prompts"></div>
        <div class="rv-hint rv-anim" style="opacity:0"></div>
        <div class="rv-onboard rv-anim" style="display:none"></div>
        <div class="rv-tele rv-anim" style="display:none"></div>
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

  toast(text, { kind = 'info', ms = 4200, eyebrow, icon: ic } = {}) {
    this._layoutDirty = true;
    const key = `${kind}|${text}`;
    const now = this.engine.time?.real ?? 0;
    if (this._recentToasts.has(key) && now - this._recentToasts.get(key) < 6) return;
    this._recentToasts.set(key, now);
    const info = KIND_TOAST[String(kind).toLowerCase()];
    const el = document.createElement('div');
    const isInfo = !info && (kind === 'info' || !kind);
    el.className = `rv-toast rv-anim${isInfo ? ' info' : ''}`;
    el.style.opacity = '0';
    const eb = eyebrow ?? (info ? info[0] : (kind && kind !== 'info' ? String(kind) : 'Notice'));
    el.innerHTML = `<span class="rv-toast-ic">${icon(ic ?? (info ? info[1] : isInfo ? 'discovery' : 'discovery'))}</span>
      <span class="rv-toast-txt"><span class="rv-toast-eyebrow">${escapeHtml(eb)}</span><span class="rv-toast-name">${escapeHtml(text)}</span></span>`;
    this.el.toasts.appendChild(el);
    this.toasts.push({ el, t: 0, dur: Math.max(1.5, ms / 1000), w: 0 });
    while (this.toasts.length > 4) { const o = this.toasts.shift(); o.el.remove(); }
  }

  hint(text, ms = 6000) {
    const h = this.hintS;
    if (!text) { h.ms = 0.001; h.t = 1; return; }
    if (text !== h.text) { this.el.hint.innerHTML = hintHTML(this._adaptHint(String(text))); h.text = text; h.a = Math.min(h.a, 0.1); }
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
        return `<div class="rv-tv${cls}" data-k="${escapeHtml(k)}">${lbl}<span class="rv-tv-v"></span>${BAR_KEYS.has(k) ? '<span class="rv-tv-bar"><i></i></span>' : ''}</div>`;
      }).join('');
      s.els = [...this.el.tele.querySelectorAll('.rv-tv')].map((el) => ({ el, v: el.querySelector('.rv-tv-v'), bar: el.querySelector('.rv-tv-bar i'), last: null }));
    }
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
      if (this.hintS.text) this.el.hint.innerHTML = hintHTML(this._adaptHint(this.hintS.text));
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
    const idleHide = this.idle > 24 && !this.engine.shot;
    this.hudA = approach(this.hudA, idleHide ? 0 : 1, idleHide ? 0.8 : 6, dt);
    const ctx = this._ctx;
    ctx.hidden = hidden; ctx.hudAlpha = this.hudA; ctx.safeL = this._safe.l; ctx.safeB = this._safe.b;
    ctx.titleBusy = !!this.titleS;
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
    op(this.el.topbtns, 0.35 + 0.65 * this.hudA);

    this._updateCrumbs(dt);
    this._updateTitle(dt);
    this._updateToasts(dt);
    this._updatePrompts(dt);
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
    // Hold the card until the scene behind it has something to show: never during a director fade, and on
    // the cosmic web until structure has visibly formed (z < ~26; the first seconds are a near-uniform
    // primordial fog). Max 5 s of hold so a slow/failed renderer never swallows the title.
    if (s.t === 0 && s.wait < 5) {
      const d = this.engine.director;
      let hold = !!d.busy;
      if (!hold && d.currentName === 'cosmic') {
        const m = d.current;
        const a = m?.a;
        hold = !(m?.icStage >= 1) || (Number.isFinite(a) && a > 0 && 1 / a - 1 > 26);
      }
      if (hold) { s.wait += dt; return; }
    }
    s.t += dt;
    const t = s.t, D = s.dur;
    const a = ease(t / 1.0) * Math.min(1, Math.max(0, (D - t) / 1.4));
    const el = this.el;
    el.title.style.opacity = a.toFixed(3);
    const k = ease(t / 2.2);
    const ls = 0.46 + (1 - k) * 0.22;
    el.titleMain.style.letterSpacing = `${ls.toFixed(3)}em`;
    el.titleMain.style.textIndent = `${ls.toFixed(3)}em`;
    const blur = (1 - ease(t / 1.1)) * 8;
    el.titleMain.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
    el.titleRule.style.width = `${(ease((t - 0.35) / 1.4) * 140).toFixed(1)}px`;
    el.titleSub.style.opacity = ease((t - 0.6) / 1.0).toFixed(3);
    if (t >= D) { this.titleS = null; el.title.style.display = 'none'; }
  }

  _updateToasts(dt) {
    const side = this._toastSide === 'left' ? -1 : 1;
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const o = this.toasts[i];
      o.t += dt;
      const inA = ease(o.t / 0.55), outA = Math.min(1, Math.max(0, (o.dur - o.t) / 0.7));
      o.el.style.opacity = (inA * outA).toFixed(3);
      o.el.style.transform = `translate3d(${(side * ((1 - inA) * 18 + (1 - outA) * 8)).toFixed(2)}px,0,0)`;
      if (!o.w) o.w = o.el.offsetWidth || 220;
      const sh = -80 + ease((o.t - 0.25) / 1.3) * (o.w + 160);
      o.el.style.setProperty('--sh', `${sh.toFixed(1)}px`);
      if (o.t >= o.dur) { o.el.remove(); this.toasts.splice(i, 1); this._layoutDirty = true; }
    }
  }

  /**
   * Collision-free placement of the toast stack. The HUD has several fixed anchors (telemetry, touch
   * cluster, compass, top buttons, stick …) whose free space depends on the viewport, safe areas and
   * input scheme, so fixed CSS offsets cannot guarantee separation (e.g. iPhone landscape: 390 px tall).
   * Every 0.25 s while toasts exist (or when something moved) we scan the right column, then the left
   * column under the breadcrumb, for the first vertical gap tall enough; if neither fits every toast, the
   * side with more room wins and the oldest toasts retire early. Never overlaps, never per-frame layout.
   */
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

  _layoutToasts(dt) {
    this._layoutT = (this._layoutT ?? 0) - dt;
    if (this.hintS.a > 0.01 || this.teleS.a > 0.01) this._layoutHint();
    if (!this.toasts.length) { this._layoutDirty = false; return; }
    if (!this._layoutDirty && this._layoutT > 0) return;
    this._layoutT = 0.25; this._layoutDirty = false;
    const root = this.root, W = root.clientWidth || window.innerWidth, H = root.clientHeight || window.innerHeight;
    if (!W || !H) return;
    const sf = this._safe, gut = W <= 760 || H <= 460 ? 14 : 18;
    let th = 0, tw = 0;
    for (const o of this.toasts) { th = Math.max(th, o.el.offsetHeight || 0); tw = Math.max(tw, o.w || o.el.offsetWidth || 0); }
    th = th || 44; tw = Math.min(tw || 220, W - 2 * gut);
    const GAP = 8, n = this.toasts.length;
    const need = (k) => k * (th + GAP) - GAP;
    // obstacles (viewport rects of visible HUD blocks)
    const obs = this._obs || (this._obs = []);
    obs.length = 0;
    const add = (el) => {
      if (!el || !el.isConnected) return;
      const cs = el.style;
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.classList.contains('rv-hide')) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) obs.push(r);
    };
    if (this.teleS.data) add(this.el.tele);
    add(this.el.topbtns); add(this.el.crumbRow);
    if (this.el.onboard.style.display !== 'none') add(this.el.onboard);
    if (this.world?.compassA > 0.05) add(this.world.compassEl);
    if (this._prompts.size) add(this.el.prompts);
    if (this.touch?.visible) {
      add(this.touch.stickEl);
      for (const b of this.touch.buttons) if (b.shown) add(b.el);
    }
    const crumbBottom = (this.el.crumbs.getBoundingClientRect().bottom || 50);
    const scan = (x0, x1, top) => {
      const iv = obs.filter((r) => r.right > x0 - 4 && r.left < x1 + 4 && r.bottom > top).sort((a, b) => a.top - b.top);
      let start = top, best = { top, cap: 0 };
      const bottomLimit = H - sf.b - 12;
      const consider = (end) => {
        const cap = Math.max(0, Math.floor((end - start + GAP) / (th + GAP)));
        if (cap >= n && best.cap < n) best = { top: start, cap };
        else if (cap > best.cap && best.cap < n) best = { top: start, cap };
      };
      for (const r of iv) {
        if (r.top > start) consider(Math.min(r.top - GAP, bottomLimit));
        if (best.cap >= n) return best;
        start = Math.max(start, r.bottom + GAP);
      }
      consider(bottomLimit);
      return best;
    };
    const rX1 = W - sf.r - gut, rTop = Math.max(sf.t + 50, (this.el.topbtns.getBoundingClientRect().bottom || 48) + 6);
    const right = scan(rX1 - tw, rX1, rTop);
    let pick = right, side = 'right';
    if (right.cap < n) {
      const lX0 = sf.l + gut;
      // the breadcrumb subtitle fades after ~9 s; keep clear of it anyway (it is short)
      const left = scan(lX0, lX0 + tw, crumbBottom + 10);
      if (left.cap > right.cap) { pick = left; side = 'left'; }
    }
    // keep the stack readable in the upper half when there is room (don't drift to mid-screen)
    const T = this.el.toasts;
    if (this._toastSide !== side) { this._toastSide = side; T.classList.toggle('left', side === 'left'); }
    const top = `${Math.round(pick.top)}px`;
    if (T.style.top !== top) T.style.top = top;
    // retire the oldest toasts that cannot fit
    const cap = Math.max(1, pick.cap);
    for (let i = 0; i < n - cap; i++) { const o = this.toasts[i]; o.dur = Math.min(o.dur, o.t + 0.3); }
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
    if (this.input.axis('move').lengthSq() > 0.05) s.moved += dt;
    const show = want && !s.retired && s.t > 1.2 && s.t < 22 && !(s.moved > 3 && s.t > 7);
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

/** Hint text → segments that never break internally (a wrapped hint breaks only at ' · '). */
function hintHTML(t) {
  return String(t).split(/\s·\s/).map((x) => `<span class="rv-hseg">${escapeHtml(x)}</span>`).join('<span class="rv-hdot"> · </span>');
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
