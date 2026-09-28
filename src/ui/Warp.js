// Cinematic transitions: a warp-streak star field drawn above the director's fade veil while a
// mode switch happens (mode:leaving → mode:enter), plus the boot "REVERENCE" loader.
// Pure 2D canvas at CSS-pixel resolution (≤ ~360 streaks); the rAF loop only runs while visible.
import { events } from '../core/events.js';
import { escapeHtml } from './glyphs.js';
import { Params } from '../core/Params.js';

const RANK = { cosmic: 0, galaxy: 1, system: 2 };
const N = 340;

export class Warp {
  constructor(ui) {
    this.ui = ui;
    this.engine = ui.engine;
    this.enabled = !this.engine.shot;
    // capture/debug: &uipanel=warp shows the transition deterministically (driven by ui.update)
    this.simDriven = this.engine.shot && Params.raw.get('uipanel') === 'warp';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'rv-warp';
    this.label = document.createElement('div');
    this.label.className = 'rv-warp-label';
    this.label.innerHTML = '<div class="k"></div><div class="n"></div><div class="bar"><i></i></div>';
    document.body.appendChild(this.canvas);
    document.body.appendChild(this.label);
    this.ctx = null;
    this.stars = { x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N), pz: new Float32Array(N), hue: new Uint8Array(N) };
    this.phase = 'idle';     // idle | in | hold | out | boot
    this.t = 0;
    this.speed = 0;
    this.dir = 1;             // +1 forward (diving in), -1 backward (climbing out)
    this.alpha = 0;
    this.labelA = 0;
    this._raf = 0;
    this._last = 0;
    this._loop = (now) => this._frame(now);
    for (let i = 0; i < N; i++) this._reset(i, true);

    if (this.simDriven) {
      this.canvas.classList.add('rv-warp-force'); this.label.classList.add('rv-warp-force');
      this.phase = 'in'; this.dir = 1;
      const p = Object.fromEntries(Params.raw.entries());
      this._setLabel('Entering', this._destName(p.mode || 'system', p));
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
    const s = this.stars;
    const a = Math.random() * Math.PI * 2, r = 0.02 + Math.pow(Math.random(), 0.7) * 1.2;
    s.x[i] = Math.cos(a) * r; s.y[i] = Math.sin(a) * r;
    s.z[i] = anywhere ? 0.05 + Math.random() * 1.0 : (this.dir > 0 ? 1.0 + Math.random() * 0.1 : 0.03 + Math.random() * 0.05);
    s.pz[i] = s.z[i];
    s.hue[i] = Math.random() < 0.18 ? 1 : Math.random() < 0.12 ? 2 : 0;
  }

  boot() {
    this.phase = 'boot'; this.t = 0; this.dir = 1; this.speed = 0.05; this.alpha = 0;
    this._setLabel('Reverence', 'a universe, alive');
    this._start();
  }

  begin({ from, to, params } = {}) {
    if (!from) return; // initial boot enter handled by boot()
    const rf = RANK[from] ?? 1, rt = RANK[to] ?? 1;
    this.dir = rt >= rf ? 1 : -1;
    const toSame = to === from;
    this.phase = 'in'; this.t = 0;
    const name = this._destName(to, params);
    this._setLabel(this.dir > 0 ? (toSame ? 'Travelling to' : 'Entering') : 'Returning to', name);
    for (let i = 0; i < N; i++) this._reset(i, true);
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

  _setLabel(k, n) {
    this.label.querySelector('.k').textContent = String(k || '').toUpperCase();
    this.label.querySelector('.n').innerHTML = escapeHtml(n || '');
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
    let dt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    if (this._step(dt, true)) this._raf = requestAnimationFrame(this._loop);
  }

  _step(dt, draw) {
    this.t += dt;
    const ph = this.phase;
    let targetSpeed = 0, targetAlpha = 0, targetLabel = 0;
    if (ph === 'boot') { targetSpeed = 0.06; targetAlpha = 0.9; targetLabel = this.t > 0.25 ? 1 : 0; }
    else if (ph === 'in') { targetSpeed = Math.min(2.4, 0.15 + this.t * 2.2); targetAlpha = 1; targetLabel = this.t > 0.35 ? 1 : 0; }
    else if (ph === 'out') { targetSpeed = 0.02; targetAlpha = 0; targetLabel = 0; }
    const k = 1 - Math.exp(-dt * (ph === 'out' ? 3.2 : 4));
    this.speed += (targetSpeed - this.speed) * k;
    this.alpha += (targetAlpha - this.alpha) * (1 - Math.exp(-dt * (ph === 'out' ? 2.6 : 5)));
    this.labelA += (targetLabel - this.labelA) * (1 - Math.exp(-dt * (ph === 'out' ? 6 : 3)));
    if (ph === 'out' && this.alpha < 0.01 && this.labelA < 0.01) { this._stop(); return false; }
    this._draw(dt, draw);
    if (draw) {
      this.label.style.opacity = this.labelA.toFixed(3);
      const bar = this.label.querySelector('.bar i');
      if (bar) bar.style.setProperty('--x', `${((this.t * 0.8) % 1.4) * 100 - 40}%`);
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
    ctx.lineCap = 'round';
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
      const a = this.alpha * (0.15 + near * 0.85);
      const c = s.hue[i] === 1 ? '255,214,170' : s.hue[i] === 2 ? '170,205,255' : '235,240,255';
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
    // soft central bloom while accelerating
    const glow = Math.min(1, Math.abs(this.speed) / 2.4) * this.alpha;
    if (glow > 0.02 && draw) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, f * 0.5);
      g.addColorStop(0, `rgba(200,220,255,${(glow * 0.16).toFixed(3)})`);
      g.addColorStop(1, 'rgba(200,220,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
  }
}
