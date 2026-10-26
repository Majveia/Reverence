// Planet-scale HUD: compass/heading strip with POI ticks, world POI markers (fade in when
// relevant), sky-body markers when in space, and BotW-style location reveals + POI discovery.
// All math is planet-local (camera is a child of world.root, which never rotates).
import * as THREE from 'three';
import { events } from '../core/events.js';
import { escapeHtml } from './glyphs.js';
import { icon } from './icons.js';

const KIND_COL = {
  city: '#ffdca0', village: '#ffe9c4', monument: '#e6d4ff', ruin: '#d9ccb4', wonder: '#bff0c8',
  landing: '#aee0ff', creature: '#ffc9b8', default: '#ffffff',
};
const KIND_RANGE = { city: 14000, village: 7000, monument: 6000, ruin: 5000, wonder: 900, landing: 9000, creature: 1200 };
const KIND_LABEL = { city: 'City', village: 'Village', monument: 'Monument', ruin: 'Ruins', wonder: 'Natural wonder', landing: 'Landing site', creature: 'Creature' };
const MAX_MARKERS = 5;

const _up = new THREE.Vector3(), _n = new THREE.Vector3(), _e = new THREE.Vector3(), _f = new THREE.Vector3();
const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3();

export function fmtDist(m) {
  if (!(m >= 0)) return '';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 1e5) return `${(m / 1000).toFixed(1)} km`;
  if (m < 1e8) return `${Math.round(m / 1000).toLocaleString('en-US')} km`;
  if (m < 1.5e11 * 0.02) return `${(m / 1e9).toFixed(2)} Gm`;
  return `${(m / 1.496e11).toFixed(2)} AU`;
}

export class WorldHud {
  constructor(ui, parent, markerLayer) {
    this.ui = ui;
    this.engine = ui.engine;
    this.compassEl = document.createElement('div');
    this.compassEl.className = 'rv-compass rv-anim';
    this.compassEl.innerHTML = '<canvas></canvas>';
    parent.appendChild(this.compassEl);
    this.canvas = this.compassEl.querySelector('canvas');
    this.ctx2d = null;
    this.compassA = 0;
    this.heading = 0;
    this._lastDrawn = '';
    this.markerLayer = markerLayer;
    this.pool = [];
    for (let i = 0; i < MAX_MARKERS; i++) this.pool.push(this._mkMarker('poi'));
    this.bodyPool = [];
    for (let i = 0; i < 10; i++) this.bodyPool.push(this._mkMarker('body'));
    this.cands = [];
    this.selT = 0;
    this.discovered = new Set();
    this.discT = 0;
    this.world = null;
    this.compassPois = [];
    this.targetName = null;   // ship telemetry 'target' (nearest body) → bracketed body marker

    // location reveal
    this.reveal = document.createElement('div');
    this.reveal.className = 'rv-reveal rv-anim';
    this.reveal.style.display = 'none';
    this.reveal.innerHTML = '<div class="rv-reveal-row"><span class="rv-reveal-line"></span><span class="rv-reveal-name"></span><span class="rv-reveal-line r"></span></div><div class="rv-reveal-kind"></div>';
    parent.appendChild(this.reveal);
    this.revealQ = [];
    this.revealT = -1;
    this.revealDur = 5.2;

    events.on('mode:enter', () => { this.discovered.clear(); this.revealQ.length = 0; this.revealT = -1; this.reveal.style.display = 'none'; this.world = null; this.discT = -3.5; });
    // (the director may hold the veil a few seconds after 'mode:enter': discoveries start counting at the reveal)
    events.on('mode:shown', () => { this.discT = -3.5; });
  }

  _mkMarker(type) {
    const el = document.createElement('div');
    el.className = `rv-mk ${type}`;
    el.style.display = 'none';
    // name + distance sit on a small dark glass plate so they read over sunlit foliage, snow and bright planets
    el.innerHTML = type === 'body'
      ? `<span class="rv-mk-dot"></span><span class="rv-mk-lab"><span class="rv-mk-name"></span><span class="rv-mk-dist"></span></span><span class="rv-mk-tgt">${icon('target')}</span>`
      : '<span class="rv-mk-dia"></span><span class="rv-mk-lab"><span class="rv-mk-name"></span><span class="rv-mk-dist"></span></span>';
    this.markerLayer.appendChild(el);
    const lab = el.children[1];
    return { el, dia: el.firstChild, lab, name: lab.firstChild, dist: lab.lastChild, a: 0, shown: false, key: null, txt: '', dtxt: '', col: '', x: 0, y: 0 };
  }

  /** Queue a BotW-style location title ("— ASHVALE —  village"). */
  showReveal(name, kind) {
    if (!name) return;
    if (this.revealQ.length < 3) this.revealQ.push({ name, kind });
  }

  update(dt, ctx) {
    const mode = this.engine.director.current;
    const world = this.engine.director.currentName === 'system' ? mode?.world : null;
    this.world = world;
    let cA = 0;
    let space = 0;
    if (world && world.camera && world.body) {
      try {
        const cam = world.camera;
        const R = world.body.radius;
        const alt = cam.position.length() - R;
        space = Math.min(1, Math.max(0, (alt - R * 0.08) / (R * 0.25)));
        const pl = world.player;
        const onPlanet = alt < R * 0.06;
        const orbitView = pl?.view === 'orbit' && world.controller === pl;
        cA = onPlanet && !orbitView && !ctx.hidden ? ctx.hudAlpha : 0;
        this._heading(cam);
        // markers step back while an arrival title card is on screen (they would cross the caption)
        const tk = ctx.titleShown ? 0.25 : 1;
        this._pois(dt, world, cam, ctx, onPlanet && !orbitView && !ctx.hidden ? ctx.hudAlpha * tk : 0);
        this._discovery(dt, world, ctx);
        this._bodies(dt, world, cam, ctx, space * (ctx.hidden ? 0 : ctx.hudAlpha) * tk);
      } catch (e) {
        if (!this._warned) { console.warn('[ui] world hud', e); this._warned = true; }
      }
    } else {
      this._hideAll(this.pool, dt); this._hideAll(this.bodyPool, dt);
    }
    // compass fade
    this.compassA += (cA - this.compassA) * (1 - Math.exp(-dt * 4));
    if (this.compassA < 0.01) { if (this.compassEl.style.display !== 'none') this.compassEl.style.display = 'none'; }
    else {
      if (this.compassEl.style.display === 'none') { this.compassEl.style.display = ''; this._lastDrawn = ''; }
      this.compassEl.style.opacity = this.compassA.toFixed(3);
      this._drawCompass();
    }
    this._updateReveal(dt, ctx);
  }

  _heading(cam) {
    _up.copy(cam.position).normalize();
    _n.set(0, 1, 0).addScaledVector(_up, -_up.y);
    if (_n.lengthSq() < 1e-8) _n.set(0, 0, 1).addScaledVector(_up, -_up.z);
    _n.normalize();
    _e.crossVectors(_n, _up);
    cam.getWorldDirection(_f);
    const fx = _f.dot(_e), fy = _f.dot(_n);
    if (fx * fx + fy * fy > 1e-6) this.heading = Math.atan2(fx, fy);
  }

  _bearing(pos, cam) {
    _d.copy(pos).sub(cam.position);
    return Math.atan2(_d.dot(_e), _d.dot(_n));
  }

  _pois(dt, world, cam, ctx, alpha) {
    const pois = world.pois || [];
    this.selT -= dt;
    // re-rank candidates at ~6 Hz
    if (this.selT <= 0) {
      this.selT = 0.16;
      this.cands.length = 0;
      this.compassPois.length = 0;
      const names = this._names || (this._names = new Map());
      names.clear();
      for (let i = 0; i < pois.length; i++) {
        const p = pois[i];
        if (!p?.pos) continue;
        const dist = p.pos.distanceTo(cam.position);
        if (p.kind === 'wonder' || p.kind === 'creature') {
          const prev = names.get(p.name);
          if (prev !== undefined && prev <= dist) continue;
          names.set(p.name, dist);
        }
        const range = (KIND_RANGE[p.kind] ?? 6000) * (p.data?.capital ? 1.6 : 1);
        const inside = dist < Math.max(60, (p.radius || 0) * 0.9);
        if (dist < range * 1.6 && !inside) this.compassPois.push({ p, dist });
        if (inside || dist > range) continue;
        this.cands.push({ p, dist, score: dist / range * (p.data?.capital ? 0.6 : 1) });
      }
      // keep only the nearest instance of repeated names (e.g. many 'Elder Oak' wonders)
      if (names.size) {
        for (let i = this.cands.length - 1; i >= 0; i--) { const c = this.cands[i]; if (names.has(c.p.name) && names.get(c.p.name) < c.dist) this.cands.splice(i, 1); }
        for (let i = this.compassPois.length - 1; i >= 0; i--) { const c = this.compassPois[i]; if (names.has(c.p.name) && names.get(c.p.name) < c.dist) this.compassPois.splice(i, 1); }
      }
      this.cands.sort((a, b) => a.score - b.score);
      if (this.cands.length > MAX_MARKERS) this.cands.length = MAX_MARKERS;
      this.compassPois.sort((a, b) => a.dist - b.dist);
      if (this.compassPois.length > 8) this.compassPois.length = 8;
      this._lastDrawn = '';
    }
    const W = this.engine.width, H = this.engine.height;
    cam.updateMatrixWorld();
    for (let i = 0; i < this.pool.length; i++) {
      const m = this.pool[i];
      const c = this.cands[i];
      let want = 0, x = m.x, y = m.y;
      if (c && alpha > 0) {
        world.toScene ? world.toScene(c.p.pos, _p) : _p.copy(c.p.pos).sub(world.origin);
        // lift the marker above the site (buildings / trees)
        _q.copy(c.p.pos).normalize().multiplyScalar(Math.min(80, 12 + (c.p.radius || 30) * 0.25));
        _p.add(_q);
        _p.project(cam);
        if (_p.z < 1 && _p.z > -1 && Math.abs(_p.x) < 1.05 && Math.abs(_p.y) < 1.05) {
          x = (_p.x * 0.5 + 0.5) * W; y = (-_p.y * 0.5 + 0.5) * H;
          const centre = Math.max(0, 1 - Math.hypot(_p.x * 0.8, _p.y) * 0.9);
          const range = KIND_RANGE[c.p.kind] ?? 6000;
          const near = 1 - Math.min(1, c.dist / range);
          want = alpha * Math.min(1, 0.25 + centre * 0.55 + near * 0.6) * (i === 0 ? 1 : 0.8);
          // keep markers away from the HUD edges
          y = Math.max(70, Math.min(H - 110, y));
          x = Math.max(70, Math.min(W - 70, x));
        }
      }
      const key = c ? c.p : null;
      if (key !== m.key) { m.key = key; if (want > 0) m.a = Math.min(m.a, 0.05); }
      m.a += (want - m.a) * (1 - Math.exp(-dt * (want > m.a ? 8 : 5)));
      if (m.a < 0.01) { if (m.shown) { m.el.style.display = 'none'; m.shown = false; } continue; }
      if (!m.shown) { m.el.style.display = ''; m.shown = true; }
      m.x = x; m.y = y;
      const name = c ? (c.p.name || KIND_LABEL[c.p.kind] || '') : m.txt;
      if (name !== m.txt) { m.name.textContent = name; m.txt = name; }
      const cap = !!c?.p.data?.capital;
      const col = cap ? KIND_COL.city : KIND_COL[c?.p.kind] || KIND_COL.default;
      if (col !== m.col) { m.el.style.color = col; m.name.style.color = col; m.col = col; }
      if (c && cap !== m.cap) { m.el.classList.toggle('cap', cap); m.cap = cap; }
      const dt2 = c ? fmtDist(c.dist) : m.dtxt;
      if (dt2 !== m.dtxt) { m.dist.textContent = dt2; m.dtxt = dt2; }
      // label declutter: a plate needs a free ~140×46 px box (higher-priority markers claim theirs first)
      let lab = (i < 2 || m.cap) && m.a > 0.15;
      if (lab) {
        for (let j = 0; j < i; j++) {
          const o = this.pool[j];
          if (o.shown && o.full === '' && Math.abs(o.x - x) < 140 && Math.abs(o.y - y) < 46) { lab = false; break; }
        }
      }
      const full = lab ? '' : 'none';
      if (m.full !== full) { m.lab.style.display = full; m.full = full; }
      m.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-6px)`;
      m.el.style.opacity = m.a.toFixed(3);
    }
  }

  _bodies(dt, world, cam, ctx, alpha) {
    const sys = world.system, cel = world.celestial;
    const list = this._bodyList || (this._bodyList = []);
    if (this._bodySys !== sys) {
      this._bodySys = sys; list.length = 0;
      for (const p of sys?.planets || []) { list.push(p); for (const m of p.moons || []) list.push(m); }
      if (list.length > this.bodyPool.length) list.length = this.bodyPool.length;
      this._bodyC = list.map(() => ({ ok: false, x: 0, y: 0, dist: 0, label: false }));
    }
    const C = this._bodyC || [];
    const W = this.engine.width, H = this.engine.height;
    const R = world.body.radius;
    const camP = cam.position, camLen2 = camP.lengthSq();
    const on = alpha > 0.01 && cel?.bodyLocal;
    // 1) project + occlusion (hidden behind the current planet)
    for (let i = 0; i < list.length; i++) {
      const b = list[i], c = C[i];
      c.ok = false;
      if (!on || b === world.body) continue;
      cel.bodyLocal(b, _p);
      _d.copy(_p).sub(camP);
      const dist = _d.length();
      _d.multiplyScalar(1 / Math.max(1e-9, dist));
      const t = -camP.dot(_d);
      if (t > 0 && t < dist && camLen2 - t * t < R * R) continue;
      _p.sub(world.origin).project(cam);
      if (!(_p.z < 1 && _p.z > -1 && Math.abs(_p.x) < 0.98 && Math.abs(_p.y) < 0.95)) continue;
      c.ok = true; c.dist = dist; c.x = (_p.x * 0.5 + 0.5) * W; c.y = (-_p.y * 0.5 + 0.5) * H;
      // bodies inside the bottom instrument/hint band or the top breadcrumb band: dot only, dimmed
      c.band = c.y > H - 120 || c.y < 64;
    }
    // 2) declutter labels: planets first, then nearer bodies; a label needs a free ~140×30 px box
    const order = this._bodyOrder || (this._bodyOrder = []);
    order.length = 0;
    for (let i = 0; i < list.length; i++) if (C[i].ok) order.push(i);
    const tn = this.targetName;
    order.sort((a, b) => ((list[b].name === tn) - (list[a].name === tn)) || (list[a].isMoon - list[b].isMoon) || (C[a].dist - C[b].dist));
    for (let n = 0; n < order.length; n++) {
      const c = C[order[n]];
      c.label = !c.band || list[order[n]].name === tn;
      for (let m = 0; m < n; m++) {
        const o = C[order[m]];
        if (o.label && Math.abs(o.x - c.x) < 130 && Math.abs(o.y - c.y) < 34) { c.label = false; break; }
        if (!o.label && Math.abs(o.x - c.x) < 10 && Math.abs(o.y - c.y) < 10) { c.label = false; break; }
      }
    }
    // 3) write
    for (let i = 0; i < this.bodyPool.length; i++) {
      const m = this.bodyPool[i], c = C[i], b = list[i];
      const isT = !!tn && b?.name === tn;
      if (m.tgt !== isT) { m.el.classList.toggle('tgt', isT); m.tgt = isT; }
      const want = c?.ok ? alpha * (isT ? 1 : b.isMoon ? 0.7 : 0.92) * (c.band && !isT ? 0.45 : 1) : 0;
      m.a += (want - m.a) * (1 - Math.exp(-dt * (want > m.a ? 8 : 4)));
      if (m.a < 0.01 || !c) { if (m.shown) { m.el.style.display = 'none'; m.shown = false; } continue; }
      if (!m.shown) { m.el.style.display = ''; m.shown = true; }
      if (b.name !== m.txt) { m.name.textContent = b.name; m.txt = b.name; }
      const d = fmtDist(c.dist);
      if (d !== m.dtxt) { m.dist.textContent = d; m.dtxt = d; }
      const full = c.label ? '' : 'none';
      if (m.full !== full) { m.lab.style.display = full; m.full = full; }
      if (c.ok) m.el.style.transform = `translate3d(${c.x.toFixed(1)}px,${c.y.toFixed(1)}px,0) translate(-50%,-4px)`;
      m.el.style.opacity = m.a.toFixed(3);
    }
  }

  _hideAll(pool, dt) {
    for (const m of pool) {
      if (!m.shown) continue;
      m.a += (0 - m.a) * (1 - Math.exp(-dt * 6));
      if (m.a < 0.01) { m.el.style.display = 'none'; m.shown = false; } else m.el.style.opacity = m.a.toFixed(3);
    }
  }

  // ---------------------------------------------------------------- discovery by proximity
  _discovery(dt, world, ctx) {
    this.discT += dt;
    if (this.discT < 0.25) return;
    this.discT = 0;
    const pl = world.player;
    const pos = (world.controller && world.controller.pos) || pl?.pos || world.camera.position;
    for (const p of world.pois || []) {
      if (!p?.pos || !p.name || this.discovered.has(p)) continue;
      if (p.kind === 'creature') continue;
      if (p.kind === 'wonder' && this.discovered.has('name:' + p.name)) continue;
      const r = Math.max(140, (p.radius || 0) * 1.15);
      if (p.pos.distanceTo(pos) < r) {
        this.discovered.add(p);
        this.discovered.add('name:' + p.name);
        this.showReveal(p.name, KIND_LABEL[p.kind] ?? p.kind);
        try { events.emit('discovery', { kind: p.kind, name: p.name, source: 'ui', poi: p }); } catch (_) { /* ignore */ }
      }
    }
  }

  _updateReveal(dt, ctx) {
    if (this.revealT < 0) {
      if (!this.revealQ.length || ctx.titleBusy) return;
      const r = this.revealQ.shift();
      this.reveal.querySelector('.rv-reveal-name').textContent = r.name;
      this.reveal.querySelector('.rv-reveal-kind').textContent = r.kind || '';
      this.revealT = 0;
      this.reveal.style.display = '';
    }
    this.revealT += dt;
    const t = this.revealT, D = this.revealDur;
    const inA = Math.min(1, t / 0.9), outA = Math.min(1, Math.max(0, (D - t) / 1.2));
    const a = easeOut(inA) * outA * (ctx.hidden ? 0 : 1);
    this.reveal.style.opacity = a.toFixed(3);
    const ls = 0.3 + 0.18 * (1 - easeOut(inA));
    const nm = this.reveal.querySelector('.rv-reveal-name');
    nm.style.letterSpacing = `${ls.toFixed(3)}em`;
    nm.style.textIndent = `${ls.toFixed(3)}em`;
    const lines = this.reveal.querySelectorAll('.rv-reveal-line');
    const lw = (easeOut(Math.min(1, Math.max(0, (t - 0.2) / 1.1))) * 64).toFixed(1);
    lines.forEach((l) => { l.style.width = lw + 'px'; });
    if (t >= D) { this.revealT = -1; this.reveal.style.display = 'none'; }
  }

  get revealBusy() { return this.revealT >= 0; }

  // ---------------------------------------------------------------- compass drawing
  _drawCompass() {
    const cvs = this.canvas;
    const w = this.compassEl.clientWidth || 384, h = this.compassEl.clientHeight || 40;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const key = `${(this.heading * 573).toFixed(0)}|${w}|${h}|${this.compassPois.length}`;
    if (key === this._lastDrawn) return;
    this._lastDrawn = key;
    if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) { cvs.width = Math.round(w * dpr); cvs.height = Math.round(h * dpr); }
    const c = this.ctx2d || (this.ctx2d = cvs.getContext('2d'));
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const small = h < 38;
    const fov = Math.PI * 0.62; // visible heading span
    const pxPerRad = w / fov;
    const cx = w / 2, baseY = small ? 16 : 18;
    const hd = this.heading;
    const fade = (x) => { const t = Math.abs(x - cx) / (w / 2); return Math.max(0, 1 - t * t * 1.05); };
    // soft dark plate (an ellipse that fades out at the ends): keeps letters readable over sky and snow
    c.save();
    c.translate(cx, baseY + 4); c.scale(w / 2 / 16, 1);
    const pg = c.createRadialGradient(0, 0, 0, 0, 0, 16);
    pg.addColorStop(0, 'rgba(4,8,12,0.42)'); pg.addColorStop(0.6, 'rgba(4,8,12,0.26)'); pg.addColorStop(1, 'rgba(4,8,12,0)');
    c.fillStyle = pg; c.fillRect(-16, -16, 32, 32);
    c.restore();
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round';
    // ticks every 15°
    for (let deg = 0; deg < 360; deg += 15) {
      const a = deg * Math.PI / 180;
      let dA = a - hd; dA = Math.atan2(Math.sin(dA), Math.cos(dA));
      if (Math.abs(dA) > fov / 2) continue;
      const x = cx + dA * pxPerRad;
      const f = fade(x);
      const card = deg % 90 === 0, inter = deg % 45 === 0;
      const prox = Math.max(0, 1 - Math.abs(x - cx) / (w * 0.13));
      if (card || inter) {
        const fs = card ? (small ? 11 : 12) + prox * 4 : (small ? 8.5 : 9.5) + prox * 2;
        c.font = `${card ? 650 : 550} ${fs.toFixed(1)}px "RV Inter", system-ui, sans-serif`;
        const t = card ? 'NESW'[deg / 90] : ['NE', 'SE', 'SW', 'NW'][(deg - 45) / 90];
        c.lineWidth = 3; c.strokeStyle = `rgba(0,0,0,${(0.5 * f).toFixed(3)})`;
        c.strokeText(t, x, baseY);
        c.fillStyle = card ? `rgba(255,255,255,${(0.98 * f).toFixed(3)})` : `rgba(232,238,255,${((0.7 + 0.3 * prox) * f).toFixed(3)})`;
        c.fillText(t, x, baseY);
      } else {
        c.fillStyle = `rgba(0,0,0,${(0.35 * f).toFixed(3)})`;
        c.fillRect(x - 1.5, baseY - 4.5, 3, 9);
        c.fillStyle = `rgba(255,255,255,${(0.6 * f).toFixed(3)})`;
        c.fillRect(x - 0.6, baseY - 3.5, 1.2, 7);
      }
    }
    // POI ticks (outlined diamonds in the kind colour)
    const cam = this.world?.camera;
    const py = baseY + (small ? 12 : 13);
    if (cam) {
      for (const { p, dist } of this.compassPois) {
        let dA = this._bearing(p.pos, cam) - hd; dA = Math.atan2(Math.sin(dA), Math.cos(dA));
        const clamped = Math.max(-fov / 2 * 0.96, Math.min(fov / 2 * 0.96, dA));
        const x = cx + clamped * pxPerRad;
        const f = Math.max(0.4, fade(x));
        const near = 1 - Math.min(1, dist / (KIND_RANGE[p.kind] ?? 6000) / 1.6);
        c.save();
        c.globalAlpha = f * (0.55 + near * 0.45);
        c.translate(x, py);
        c.rotate(Math.PI / 4);
        const sz = 2.6 + near * 1.5 + (p.data?.capital ? 0.8 : 0);
        c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(-sz - 1.2, -sz - 1.2, (sz + 1.2) * 2, (sz + 1.2) * 2);
        c.fillStyle = (p.data?.capital ? KIND_COL.city : KIND_COL[p.kind]) || '#fff';
        c.fillRect(-sz, -sz, sz * 2, sz * 2);
        c.restore();
      }
    }
    // hairline + centre notch
    const g = c.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,.4)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, baseY + 7.5, w, 1);
    c.fillStyle = 'rgba(0,0,0,.45)';
    c.beginPath(); c.moveTo(cx - 5.5, 0); c.lineTo(cx + 5.5, 0); c.lineTo(cx, 7); c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,255,255,.98)';
    c.beginPath(); c.moveTo(cx - 4, 0.5); c.lineTo(cx + 4, 0.5); c.lineTo(cx, 5.6); c.closePath(); c.fill();
    void escapeHtml;
  }
}

function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
