// Cinematic transitions, drawn above the director's fade veil while a mode switch happens
// (mode:leaving → mode:enter), plus the boot "REVERENCE" loader.
//
// Layers (2D canvas at CSS resolution × ≤1.5 dpr; everything pre-rendered to sprites once per transition):
//   1. a tinted nebula tunnel — soft gas clouds in the destination's palette rushing past the camera
//   2. the destination itself looming out of the dark: a procedural portrait of the target galaxy
//      (its real arm count / pitch / colours / type from Universe.galaxy), the target star (blackbody
//      colour, diffraction spikes, orbit + planet crescent) or the cosmic web (filaments + clusters)
//   3. star streaks (≤ 340, seeded → deterministic captures)
//   4. "ENTERING · <destination>" caption
// The rAF loop only runs while visible; `&uipanel=warp` in shot mode drives it from ui.update (deterministic).
import { events } from '../core/events.js';
import { escapeHtml } from './glyphs.js';
import { Params } from '../core/Params.js';

const RANK = { cosmic: 0, galaxy: 1, system: 2 };
const N = 340;
const NB = 9; // nebula clouds

function rng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
/** THREE.Color-like (linear) or {r,g,b} → 'r,g,b' sRGB 0..255 string, optionally lifted towards white. */
function rgbStr(c, lift = 0, lin = true) {
  const f = (v) => Math.round(255 * Math.min(1, (lin ? Math.pow(Math.max(0, v), 1 / 2.2) : v) * (1 - lift) + lift));
  return `${f(c.r)},${f(c.g)},${f(c.b)}`;
}
function hexStr(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
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
    this.ctx = null;
    this.rand = rng(0x5eed);
    this.stars = { x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N), pz: new Float32Array(N), hue: new Uint8Array(N) };
    this.neb = { a: new Float32Array(NB), r: new Float32Array(NB), z: new Float32Array(NB), c: new Uint8Array(NB), s: new Float32Array(NB) };
    this.phase = 'idle';     // idle | in | out | boot
    this.t = 0;
    this.speed = 0;
    this.dir = 1;             // +1 forward (diving in), -1 backward (climbing out)
    this.alpha = 0;
    this.labelA = 0;
    this.dest = null;         // { kind, sprite, pal:[r,g,b strings], spin }
    this.destA = 0;
    this._raf = 0;
    this._last = 0;
    this._loop = (now) => this._frame(now);
    this._pal(null);
    for (let i = 0; i < N; i++) this._reset(i, true);
    for (let i = 0; i < NB; i++) this._resetNeb(i, true);

    if (this.simDriven) {
      this.canvas.classList.add('rv-warp-force'); this.label.classList.add('rv-warp-force');
      this.phase = 'in'; this.dir = 1;
      const p = Object.fromEntries(Params.raw.entries());
      const to = p.mode || 'system';
      this._prepare(to, p);
      this._setLabel('Entering', this._destName(to, p), this.dest?.sub);
      this.canvas.style.display = 'block'; this.label.style.display = 'block';
      this.ctx = this.canvas.getContext('2d', { alpha: true });
      return;
    }
    if (!this.enabled) return;
    events.on('mode:leaving', (e) => { try { this.begin(e); } catch (err) { console.warn('[ui] warp', err); } });
    events.on('mode:enter', () => { try { this.end(); } catch (err) { console.warn('[ui] warp', err); } });
    // Boot: the fade veil is opaque until the first mode enters → show the wordmark loader.
    this.boot();
  }

  _reset(i, anywhere) {
    const s = this.stars, R = this.rand;
    const a = R() * Math.PI * 2, r = 0.02 + Math.pow(R(), 0.7) * 1.2;
    s.x[i] = Math.cos(a) * r; s.y[i] = Math.sin(a) * r;
    s.z[i] = anywhere ? 0.05 + R() * 1.0 : (this.dir > 0 ? 1.0 + R() * 0.1 : 0.03 + R() * 0.05);
    s.pz[i] = s.z[i];
    s.hue[i] = R() < 0.22 ? 1 : R() < 0.16 ? 2 : 0;
  }

  _resetNeb(i, anywhere) {
    const n = this.neb, R = this.rand;
    n.a[i] = R() * Math.PI * 2;
    n.r[i] = 0.25 + R() * 0.75;
    n.z[i] = anywhere ? 0.25 + R() * 1.1 : (this.dir > 0 ? 1.2 + R() * 0.3 : 0.2 + R() * 0.1);
    n.c[i] = Math.floor(R() * 3);
    n.s[i] = 0.5 + R() * 0.8;
  }

  boot() {
    this.phase = 'boot'; this.t = 0; this.dir = 1; this.speed = 0.05; this.alpha = 0;
    this._setLabel('Reverence', 'a universe, alive', '');
    this.dest = null; this._pal(null);
    this._start();
  }

  begin({ from, to, params } = {}) {
    if (!from) return; // initial boot enter handled by boot()
    const rf = RANK[from] ?? 1, rt = RANK[to] ?? 1;
    this.dir = rt >= rf ? 1 : -1;
    const toSame = to === from;
    this.phase = 'in'; this.t = 0; this.destA = 0;
    this._prepare(to, params || {});
    const name = this._destName(to, params);
    this._setLabel(this.dir > 0 ? (toSame ? 'Travelling to' : 'Entering') : 'Returning to', name, this.dest?.sub);
    for (let i = 0; i < N; i++) this._reset(i, true);
    for (let i = 0; i < NB; i++) this._resetNeb(i, true);
    this._start();
  }

  end() {
    if (this.phase === 'idle') return;
    this.phase = 'out'; this.t = 0;
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

  // ------------------------------------------------------------------ destination portrait
  _pal(cols) {
    // three nebula tints ('r,g,b'); default: cool cosmic violet / blue / warm dust
    this.palette = cols || ['92,70,170', '60,110,200', '190,120,90'];
    this.nebSprites = this.palette.map((c) => this._blob(c));
  }

  _blob(c) {
    const S = 128, cv = mkCanvas(S, S), x = cv.getContext('2d');
    const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, `rgba(${c},0.55)`); g.addColorStop(0.35, `rgba(${c},0.26)`); g.addColorStop(0.7, `rgba(${c},0.07)`); g.addColorStop(1, `rgba(${c},0)`);
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    return cv;
  }

  _prepare(to, p = {}) {
    this.dest = null;
    try {
      const U = this.engine.universe;
      if (to === 'galaxy') {
        const g = U.galaxy(parseInt(p.galaxy ?? 0, 10) || 0);
        this.dest = { kind: 'galaxy', sprite: this._galaxySprite(g), spin: 0.05, tilt: 0.42 + 0.4 * Math.abs(Math.cos(g.tilt || 0)), rot: g.rotation || 0,
          sub: `${g.type} galaxy` };
        this._pal([rgbStr(g.colors.arms), rgbStr(g.colors.hii), rgbStr(g.colors.core)]);
      } else if (to === 'system') {
        const gi = parseInt(p.galaxy ?? 0, 10) || 0, si = parseInt(p.star ?? 0, 10) || 0;
        const sys = U.system(gi, si);
        const st = sys.star || U.star(gi, si);
        const col = st.color ? rgbStr(st.color, 0.15) : '255,236,210';
        let body = null;
        try { body = p.planet !== undefined && p.planet !== null && p.planet !== '' ? U.body(sys, p.planet) : U.bestPlanet(sys); } catch (_) { body = null; }
        this.dest = { kind: 'system', sprite: this._starSprite(col, body, st.seed ?? si), spin: 0, tilt: 1, rot: 0,
          sub: st.name ? `${st.name}${st.cls ? ` · class ${st.cls}` : ''}${st.temperature ? ` · ${Math.round(st.temperature / 100) * 100} K` : ''}` : '' };
        this._pal([col, '70,90,150', '120,80,140']);
      } else if (to === 'cosmic') {
        this.dest = { kind: 'cosmic', sprite: this._webSprite(), spin: 0.012, tilt: 1, rot: 0, sub: 'large-scale structure' };
        this._pal(null);
      }
    } catch (e) { console.warn('[ui] warp dest', e); this.dest = null; this._pal(null); }
  }

  _galaxySprite(g) {
    const S = 512, cv = mkCanvas(S, S), x = cv.getContext('2d'), R = rng((g.seed >>> 0) ^ 0xa11ce);
    const cx = S / 2, rad = S * 0.46;
    const core = rgbStr(g.colors.core, 0.25), arms = rgbStr(g.colors.arms, 0.2), hii = rgbStr(g.colors.hii, 0.1);
    x.globalCompositeOperation = 'lighter';
    // diffuse disc / halo
    const flat = g.type === 'elliptical' ? (g.flatten || 0.7) : 1;
    x.save(); x.translate(cx, cx); x.scale(1, flat);
    let gr = x.createRadialGradient(0, 0, 0, 0, 0, rad);
    gr.addColorStop(0, `rgba(${core},0.55)`); gr.addColorStop(0.18, `rgba(${core},0.22)`); gr.addColorStop(0.5, `rgba(${arms},0.06)`); gr.addColorStop(1, `rgba(${arms},0)`);
    x.fillStyle = gr; x.fillRect(-rad, -rad, rad * 2, rad * 2);
    x.restore();
    const armsN = g.arms || 0, spiral = armsN >= 2 && g.type !== 'elliptical' && g.type !== 'irregular';
    const ring = g.type === 'ring', irr = g.type === 'irregular';
    const k = 1 / Math.tan(((g.pitch || 16) * Math.PI) / 180);
    const n = spiral || ring ? 3200 : 2000;
    const glowA = this._blob(arms), glowH = this._blob(hii), glowC = this._blob(core);
    const clumps = irr ? Array.from({ length: 7 }, () => [(R() - 0.5) * rad * 1.1, (R() - 0.5) * rad * 0.8, 0.08 + R() * 0.18]) : null;
    for (let i = 0; i < n; i++) {
      let px, py, col, a, sz, glow = null;
      if (ring && R() < 0.6) {
        const th = R() * Math.PI * 2, rr = rad * (0.62 + (R() + R() - 1) * 0.07);
        px = Math.cos(th) * rr; py = Math.sin(th) * rr;
        const knot = R() < 0.1;
        col = knot ? hii : arms; a = knot ? 0.85 : 0.4 + R() * 0.3; sz = knot ? 1.3 + R() * 1.5 : 0.6 + R() * 1.2;
        if (i % 9 === 0) glow = knot ? glowH : glowA;
      } else if (irr && R() < 0.75) {
        const c = clumps[Math.floor(R() * clumps.length)];
        px = c[0] + (R() + R() - 1) * rad * c[2]; py = c[1] + (R() + R() - 1) * rad * c[2];
        const knot = R() < 0.12;
        col = knot ? hii : R() < 0.5 ? arms : core; a = 0.35 + R() * 0.4; sz = 0.6 + R() * 1.4;
        if (i % 8 === 0) glow = knot ? glowH : glowA;
      } else if (spiral && R() < (g.armStrength || 0.7)) {
        const arm = Math.floor(R() * armsN);
        const t = Math.pow(R(), 0.8);
        const r = (0.08 + t * 0.92) * rad;
        const th = (arm / armsN) * Math.PI * 2 + Math.log(r / (rad * 0.08)) * k * 0.55;
        const sc = (0.04 + t * 0.08) * rad * (R() + R() - 1);
        px = Math.cos(th) * r + Math.cos(th + Math.PI / 2) * sc;
        py = Math.sin(th) * r + Math.sin(th + Math.PI / 2) * sc;
        const knot = R() < 0.07 && t > 0.25;
        col = knot ? hii : t < 0.2 ? core : arms;
        a = knot ? 0.8 : 0.3 + 0.5 * (1 - t);
        sz = knot ? 1.4 + R() * 1.6 : 0.6 + R() * 1.3;
        if (i % 7 === 0) glow = knot ? glowH : t < 0.25 ? glowC : glowA;
      } else {
        // bulge / elliptical population (gaussian)
        const u = R() + R() + R() - 1.5, v = R() + R() + R() - 1.5;
        const s = rad * (spiral ? 0.26 : 0.55) * (g.bulgeFrac ? 0.6 + g.bulgeFrac : 1);
        px = u * s; py = v * s * flat;
        col = core; a = 0.18 + R() * 0.3; sz = 0.5 + R() * 1.1;
      }
      if (glow) { const gs = 14 + R() * 26; x.globalAlpha = 0.16; x.drawImage(glow, cx + px - gs, cx + py - gs, gs * 2, gs * 2); x.globalAlpha = 1; }
      x.fillStyle = `rgba(${col},${a.toFixed(3)})`;
      x.beginPath(); x.arc(cx + px, cx + py, sz, 0, Math.PI * 2); x.fill();
    }
    // dust lanes (subtractive) trailing the arms
    if (spiral) {
      x.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 260; i++) {
        const arm = Math.floor(R() * armsN), t = 0.12 + R() * 0.6, r = (0.08 + t * 0.92) * rad;
        const th = (arm / armsN) * Math.PI * 2 + Math.log(r / (rad * 0.08)) * k * 0.55 - 0.16;
        const gs = 5 + R() * 9;
        x.globalAlpha = 0.18; x.drawImage(this._dust || (this._dust = this._blob('0,0,0')), cx + Math.cos(th) * r - gs, cx + Math.sin(th) * r - gs, gs * 2, gs * 2);
      }
      x.globalAlpha = 1; x.globalCompositeOperation = 'lighter';
    }
    // bar
    if (g.barLength > 0) {
      x.save(); x.translate(cx, cx); x.rotate(0.3);
      gr = x.createLinearGradient(-rad * g.barLength * 1.6, 0, rad * g.barLength * 1.6, 0);
      gr.addColorStop(0, `rgba(${core},0)`); gr.addColorStop(0.5, `rgba(${core},0.35)`); gr.addColorStop(1, `rgba(${core},0)`);
      x.fillStyle = gr; x.fillRect(-rad * g.barLength * 1.6, -rad * 0.035, rad * g.barLength * 3.2, rad * 0.07);
      x.restore();
    }
    // bright nucleus
    gr = x.createRadialGradient(cx, cx, 0, cx, cx, rad * 0.14);
    gr.addColorStop(0, 'rgba(255,248,236,0.95)'); gr.addColorStop(0.3, `rgba(${core},0.5)`); gr.addColorStop(1, `rgba(${core},0)`);
    x.fillStyle = gr; x.fillRect(cx - rad * 0.14, cx - rad * 0.14, rad * 0.28, rad * 0.28);
    return cv;
  }

  _starSprite(col, body, seed) {
    const S = 512, cv = mkCanvas(S, S), x = cv.getContext('2d'), R = rng((seed >>> 0) ^ 0x57a2);
    const cx = S / 2;
    x.globalCompositeOperation = 'lighter';
    let gr = x.createRadialGradient(cx, cx, 0, cx, cx, S * 0.5);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.035, `rgba(${col},0.95)`); gr.addColorStop(0.12, `rgba(${col},0.32)`);
    gr.addColorStop(0.35, `rgba(${col},0.07)`); gr.addColorStop(1, `rgba(${col},0)`);
    x.fillStyle = gr; x.fillRect(0, 0, S, S);
    // diffraction spikes (6, telescope-like) + a faint anamorphic streak
    x.save(); x.translate(cx, cx);
    for (let i = 0; i < 6; i++) {
      x.rotate(Math.PI / 3);
      const L = S * (i % 3 === 0 ? 0.48 : 0.3);
      gr = x.createLinearGradient(0, 0, L, 0);
      gr.addColorStop(0, `rgba(${col},0.55)`); gr.addColorStop(1, `rgba(${col},0)`);
      x.fillStyle = gr; x.beginPath(); x.moveTo(0, -1.6); x.lineTo(L, 0); x.lineTo(0, 1.6); x.fill();
    }
    x.restore();
    gr = x.createLinearGradient(0, cx, S, cx);
    gr.addColorStop(0, 'rgba(160,190,255,0)'); gr.addColorStop(0.5, 'rgba(170,200,255,0.25)'); gr.addColorStop(1, 'rgba(160,190,255,0)');
    x.fillStyle = gr; x.fillRect(0, cx - 1, S, 2);
    x.globalCompositeOperation = 'source-over';
    // orbit hairline + the destination world as a lit crescent on it
    x.save(); x.translate(cx, cx); x.scale(1, 0.34);
    x.strokeStyle = 'rgba(255,255,255,0.13)'; x.lineWidth = 1.2;
    x.beginPath(); x.arc(0, 0, S * 0.36, 0, Math.PI * 2); x.stroke();
    x.restore();
    const pa = -0.35 + R() * 0.2;
    const px = cx + Math.cos(pa) * S * 0.36, py = cx + Math.sin(pa) * S * 0.36 * 0.34;
    const pr = 9;
    const pal = body?.art?.palette;
    const base = hexStr(pal?.water && (body?.ocean || body?.hasOcean || body?.seaLevel) ? pal.water : pal?.grass || pal?.rock) || '130,150,170';
    x.fillStyle = 'rgba(0,0,0,0.9)'; x.beginPath(); x.arc(px, py, pr, 0, Math.PI * 2); x.fill();
    const lx = (cx - px), ly = (cx - py), ll = Math.hypot(lx, ly) || 1;
    gr = x.createRadialGradient(px + lx / ll * pr * 0.7, py + ly / ll * pr * 0.7, 0, px, py, pr * 1.05);
    gr.addColorStop(0, `rgba(${base},1)`); gr.addColorStop(0.55, `rgba(${base},0.55)`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr; x.beginPath(); x.arc(px, py, pr, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(150,200,255,0.35)'; x.lineWidth = 1;
    x.beginPath(); x.arc(px, py, pr + 0.8, Math.atan2(ly, lx) - 1.2, Math.atan2(ly, lx) + 1.2); x.stroke();
    return cv;
  }

  _webSprite() {
    const S = 512, cv = mkCanvas(S, S), x = cv.getContext('2d'), R = rng(0xc05a1c);
    x.globalCompositeOperation = 'lighter';
    const nodes = [];
    for (let i = 0; i < 46; i++) {
      const a = R() * Math.PI * 2, r = Math.pow(R(), 0.6) * S * 0.46;
      nodes.push([S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 0.4 + R() * 0.6]);
    }
    x.lineCap = 'round';
    for (let i = 0; i < nodes.length; i++) {
      const d = nodes.map((n, j) => [j, Math.hypot(n[0] - nodes[i][0], n[1] - nodes[i][1])]).sort((a, b) => a[1] - b[1]);
      for (let k = 1; k <= 3; k++) {
        const j = d[k][0], L = d[k][1];
        if (L > S * 0.24) continue;
        const [x0, y0] = nodes[i], [x1, y1] = nodes[j];
        for (let w = 0; w < 3; w++) {
          x.strokeStyle = `rgba(${w ? '110,90,210' : '170,150,255'},${(w ? 0.05 : 0.14).toFixed(3)})`;
          x.lineWidth = w ? 5 + w * 4 : 1.2;
          x.beginPath(); x.moveTo(x0, y0);
          x.quadraticCurveTo((x0 + x1) / 2 + (R() - 0.5) * L * 0.3, (y0 + y1) / 2 + (R() - 0.5) * L * 0.3, x1, y1); x.stroke();
        }
      }
    }
    for (const [nx, ny, m] of nodes) {
      const r = 6 + m * 16;
      const gr = x.createRadialGradient(nx, ny, 0, nx, ny, r);
      gr.addColorStop(0, `rgba(255,236,220,${(0.5 * m).toFixed(3)})`); gr.addColorStop(0.3, `rgba(190,150,255,${(0.25 * m).toFixed(3)})`); gr.addColorStop(1, 'rgba(120,90,220,0)');
      x.fillStyle = gr; x.fillRect(nx - r, ny - r, r * 2, r * 2);
    }
    return cv;
  }

  _setLabel(k, n, sub) {
    this.label.querySelector('.k').textContent = String(k || '').toUpperCase();
    this.label.querySelector('.n').innerHTML = escapeHtml(n || '');
    this.label.querySelector('.s').textContent = sub ? String(sub) : '';
  }

  _start() {
    if (!this.ctx) this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.canvas.style.display = 'block';
    this.label.style.display = 'block';
    this._resize();
    if (!this._raf) { this._last = performance.now(); this._raf = requestAnimationFrame(this._loop); }
  }

  _resize() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    this.dpr = dpr;
  }

  _stop() {
    cancelAnimationFrame(this._raf); this._raf = 0;
    this.canvas.style.display = 'none'; this.label.style.display = 'none';
    this.phase = 'idle';
  }

  /** Deterministic stepping for captures (&uipanel=warp in shot mode). */
  tick(dt) {
    if (!this.simDriven) return;
    let left = dt;
    while (left > 1e-6) { const h = Math.min(1 / 30, left); left -= h; this._step(h, left <= 1e-6); }
  }

  _frame(now) {
    this._raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    if (this._step(dt, true)) this._raf = requestAnimationFrame(this._loop);
  }

  _step(dt, draw) {
    this.t += dt;
    const ph = this.phase;
    let targetSpeed = 0, targetAlpha = 0, targetLabel = 0, targetDest = 0;
    if (ph === 'boot') { targetSpeed = 0.06; targetAlpha = 0.9; targetLabel = this.t > 0.25 ? 1 : 0; }
    else if (ph === 'in') { targetSpeed = Math.min(2.4, 0.15 + this.t * 2.2); targetAlpha = 1; targetLabel = this.t > 0.35 ? 1 : 0; targetDest = 1; }
    else if (ph === 'out') { targetSpeed = 0.02; targetAlpha = 0; targetLabel = 0; targetDest = 0; }
    const k = 1 - Math.exp(-dt * (ph === 'out' ? 3.2 : 4));
    this.speed += (targetSpeed - this.speed) * k;
    this.alpha += (targetAlpha - this.alpha) * (1 - Math.exp(-dt * (ph === 'out' ? 2.6 : 5)));
    this.labelA += (targetLabel - this.labelA) * (1 - Math.exp(-dt * (ph === 'out' ? 6 : 3)));
    this.destA += (targetDest - this.destA) * (1 - Math.exp(-dt * (ph === 'out' ? 3 : 1.6)));
    if (ph === 'out' && this.alpha < 0.01 && this.labelA < 0.01) { this._stop(); return false; }
    this._draw(dt, draw);
    if (draw) {
      this.label.style.opacity = this.labelA.toFixed(3);
      if (this.barEl) this.barEl.style.setProperty('--x', `${((this.t * 0.8) % 1.4) * 100 - 40}%`);
    }
    return true;
  }

  _draw(dt, draw = true) {
    this._resize();
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    if (draw) ctx.clearRect(0, 0, W, H);
    if (this.alpha < 0.004) return;
    const cx = W / 2, cy = H / 2, f = Math.max(W, H) * 0.5;
    const s = this.stars, v = this.speed * this.dir;
    const bg = this.engine.director?.fadeEl?.style?.background || '';
    const onWhite = /255, 255, 255|#fff/i.test(bg);
    const A = this.alpha;

    // ---- 1. nebula tunnel (tinted gas rushing past) — additive sprites over a faint destination haze
    if (!onWhite) {
      const nb = this.neb;
      if (draw) {
        ctx.globalCompositeOperation = 'lighter';
        const hz = Math.max(W, H) * 0.9;
        ctx.globalAlpha = A * 0.28; ctx.drawImage(this.nebSprites[0], cx - hz * 0.9, cy - hz * 0.55, hz * 1.4, hz * 1.0);
        ctx.globalAlpha = A * 0.2; ctx.drawImage(this.nebSprites[1], cx - hz * 0.3, cy - hz * 0.35, hz * 1.3, hz * 0.9);
      }
      for (let i = 0; i < NB; i++) {
        nb.z[i] -= v * dt * 0.55;
        if (nb.z[i] < 0.12 || nb.z[i] > 1.6) { this._resetNeb(i, false); continue; }
        if (!draw) continue;
        const z = nb.z[i];
        const r = nb.r[i] / z * f * 0.9;
        const px = cx + Math.cos(nb.a[i]) * r, py = cy + Math.sin(nb.a[i]) * r;
        const size = nb.s[i] / z * f * 0.75;
        const near = clamp01((1.5 - z) / 1.2);
        const a = A * near * (1 - clamp01((0.35 - z) / 0.23)) * 0.95 * (0.4 + 0.6 * clamp01(Math.abs(this.speed) / 1.2 + 0.3));
        if (a < 0.01) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(this.nebSprites[nb.c[i] % this.nebSprites.length], px - size, py - size * 0.8, size * 2, size * 1.6);
      }
      if (draw) { ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
    }

    // ---- 2. destination portrait looming out of the dark
    const D = this.dest;
    if (D && draw && !onWhite && this.destA > 0.01) {
      const p = 1 - Math.exp(-this.t * 0.75);
      const base = Math.min(W, H);
      const scale = this.phase === 'out' ? 1 : 1;
      const size = (this.dir > 0 ? 0.1 + p * 0.62 : 1.25 - p * 0.72) * base * scale * (D.kind === 'system' ? 1.3 : 1);
      const ga = A * this.destA * (D.kind === 'system' ? 1 : 0.92);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, ga);
      ctx.rotate(D.rot + this.t * D.spin);
      ctx.scale(1, D.tilt);
      ctx.drawImage(D.sprite, -size / 2, -size / 2, size, size);
      ctx.restore();
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }

    // ---- 3. star streaks
    ctx.lineCap = 'round';
    const pal = this.palette;
    for (let i = 0; i < N; i++) {
      s.pz[i] = s.z[i];
      s.z[i] -= v * dt * 0.9;
      if (s.z[i] < 0.03 || s.z[i] > 1.12) { this._reset(i, false); continue; }
      if (!draw) continue;
      const z = s.z[i], pz = Math.min(1.12, Math.max(0.03, s.pz[i] + v * 0.035)); // stretch tail for streaks
      const x1 = cx + (s.x[i] / z) * f, y1 = cy + (s.y[i] / z) * f;
      const x0 = cx + (s.x[i] / pz) * f, y0 = cy + (s.y[i] / pz) * f;
      if (x1 < -50 || x1 > W + 50 || y1 < -50 || y1 > H + 50) { if (this.dir > 0) this._reset(i, false); continue; }
      const near = Math.min(1, (1.1 - z) / 1.05);
      const a = A * (0.15 + near * 0.85);
      const c = s.hue[i] === 1 ? '255,214,170' : s.hue[i] === 2 ? (pal[0] || '170,205,255') : '235,240,255';
      ctx.strokeStyle = onWhite ? `rgba(90,110,150,${(a * 0.55).toFixed(3)})` : `rgba(${c},${a.toFixed(3)})`;
      ctx.lineWidth = (0.6 + near * 1.6) * this.dpr;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 + 0.01, y1); ctx.stroke();
    }
    // quiet band behind the destination label
    if (draw && this.labelA > 0.02 && !onWhite) {
      const ly = H - H * 0.14 - 40 * this.dpr, rx = Math.min(W * 0.4, 360 * this.dpr);
      ctx.save(); ctx.translate(cx, ly); ctx.scale(1, 0.28);
      const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g2.addColorStop(0, `rgba(0,0,0,${(0.85 * this.labelA).toFixed(3)})`); g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2; ctx.fillRect(-rx, -rx, rx * 2, rx * 2); ctx.restore();
    }
    // soft central bloom while accelerating (tinted by the destination)
    const glow = Math.min(1, Math.abs(this.speed) / 2.4) * A;
    if (glow > 0.02 && draw) {
      const c0 = D ? pal[0] : '200,220,255';
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, f * 0.55);
      g.addColorStop(0, `rgba(${c0},${(glow * 0.14).toFixed(3)})`);
      g.addColorStop(1, `rgba(${c0},0)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    // cinematic vignette
    if (draw && !onWhite) {
      const vg = this._vig && this._vigW === W && this._vigH === H ? this._vig : (() => {
        const g = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.35, cx, cy, Math.hypot(W, H) * 0.6);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.6)');
        this._vig = g; this._vigW = W; this._vigH = H; return g;
      })();
      ctx.globalAlpha = A; ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    }
  }
}
