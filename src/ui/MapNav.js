// Map / scale navigation (M · Tab · pad View): a quiet overlay with the scale ladder
// (Universe › Galaxy › Star › World) and quick jumps at the current level:
//   cosmic → a few galaxies · galaxy → notable star systems · system → an orrery of the system's bodies.
import { icon } from './icons.js';
import { glyphFor, escapeHtml } from './glyphs.js';

const SHOWCASE_STARS = [6, 11, 9, 2, 1, 3, 17, 0];

const TYPE_COL = {
  gas: ['#e9d2a8', '#b98d5c', '#4a3322'], ice: ['#eaf6ff', '#9cc3dc', '#25405a'], volcanic: ['#ffb070', '#8a3b22', '#1f0c08'],
  barren: ['#d8d4cc', '#8d8a86', '#24221f'], toxic: ['#e6f09a', '#98a84a', '#23290e'], arctic: ['#ffffff', '#c9dbe8', '#3b5266'],
  desert: ['#ffe2b0', '#d09a5a', '#3d2412'], ocean: ['#9fd4ff', '#2c6fa0', '#0a1e33'], terran: ['#d6f0b0', '#4f8f52', '#0e2a1c'],
};

/** CSS radial-gradient for a lit sphere (light from the left, where the star is). */
export function sphereCSS(body) {
  let c = TYPE_COL[body?.type] || (body?.isGas ? TYPE_COL.gas : TYPE_COL.terran);
  const p = body?.art?.palette;
  if (p && !body.isGas) {
    const base = body.ocean?.present ? (p.water || c[1]) : (p.grass || p.rock || c[1]);
    const hi = p.sand || p.grass2 || c[0];
    const lo = body.ocean?.present ? (p.deep || c[2]) : (p.rock ? shade(p.rock, 0.35) : c[2]);
    c = [hi, base, lo];
  }
  return `radial-gradient(circle at 30% 34%, ${c[0]} 0%, ${c[1]} 38%, ${c[2]} 78%, #050608 100%)`;
}
function shade(hex, k) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(n)) return hex;
  const r = ((n >> 16) & 255) * k, g = ((n >> 8) & 255) * k, b = (n & 255) * k;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
function starCSS(star) {
  const c = star?.color;
  const rgb = c ? `${Math.min(255, c.r * 255) | 0},${Math.min(255, c.g * 255) | 0},${Math.min(255, c.b * 255) | 0}` : '255,236,210';
  return `radial-gradient(circle, #fff 0%, rgba(${rgb},1) 22%, rgba(${rgb},.35) 42%, rgba(${rgb},0) 70%)`;
}

export class MapNav {
  constructor(ui, parent) {
    this.ui = ui;
    this.engine = ui.engine;
    this.open = false;
    this.a = 0;
    this.wrap = document.createElement('div');
    this.wrap.className = 'rv-panel-wrap';
    this.wrap.style.display = 'none';
    this.wrap.innerHTML = `<div class="rv-map"><div class="rv-map-scrim"></div><div class="rv-map-in"></div>
      <button class="rv-ibtn rv-map-close" aria-label="Close map"><span>${icon('close')}</span></button></div>`;
    parent.appendChild(this.wrap);
    this.inner = this.wrap.querySelector('.rv-map-in');
    this.scrim = this.wrap.querySelector('.rv-map-scrim');
    this.scrim.addEventListener('pointerdown', (e) => { e.preventDefault(); this.close(); });
    this.wrap.querySelector('.rv-map-close').addEventListener('click', () => this.close());
    this.focusIdx = -1;
  }

  toggle() { if (this.open) this.close(); else this.show(); }
  show() {
    if (this.open) return;
    this.open = true;
    this.wrap.classList.add('open');
    this.wrap.style.display = '';
    this.ui.onPanel(true, 'map');
    this.render();
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.wrap.classList.remove('open');
    this.ui.onPanel(false, 'map');
  }

  _go(name, params) {
    this.close();
    const d = this.engine.director;
    if (d.busy) return;
    const shot = this.engine.shot;
    const tr = name === 'system' && d.currentName === 'galaxy' ? 'white' : 'fade';
    Promise.resolve(d.go(name, params, { transition: tr, duration: 900 })).then((ok) => {
      if (ok && shot) this.engine.isReady = false;
    }).catch((e) => console.warn('[ui] map travel failed', e));
  }

  render() {
    const e = this.engine, U = e.universe, d = e.director;
    const mode = d.currentName;
    const m = d.current;
    const world = m?.world;
    const gi = world?.star?.galaxy ?? m?.galaxyIndex ?? (parseInt(d.currentParams?.galaxy ?? 0, 10) || 0);
    const steps = [];
    steps.push({ k: 'Universe', n: 'Cosmic Web', ic: 'cosmic', cur: mode === 'cosmic', go: () => this._go('cosmic', { returning: true }) });
    if (mode !== 'cosmic') {
      let gname = '';
      try { gname = U.galaxy(gi).name; } catch (_) {}
      steps.push({ k: 'Galaxy', n: gname, ic: 'galaxy', cur: mode === 'galaxy', go: () => this._go('galaxy', { galaxy: gi, returning: true }) });
    }
    if (mode === 'system' && world) {
      steps.push({ k: 'Star', n: world.star?.name ?? '', ic: 'star', cur: false, go: () => this._go('system', { galaxy: gi, star: world.star.index, view: 'orbit', planet: this.ui.bodyRef(world) }) });
      steps.push({ k: world.body?.isMoon ? 'Moon' : 'World', n: world.body?.name ?? '', ic: 'planet', cur: true });
    }
    const dev = e.input.lastDevice;
    let html = `<div class="rv-ladder">${steps.map((s, i) => `${i ? '<span class="rv-step-sep"></span>' : ''}<button class="rv-step${s.cur ? ' cur' : ''}" data-step="${i}"><span class="ic">${icon(s.ic)}</span><span class="k">${s.k}</span><span class="n">${escapeHtml(s.n)}</span></button>`).join('')}</div>`;
    this._steps = steps;
    this._targets = [];

    if (mode === 'system' && world?.system) {
      html += `<div class="rv-map-title">${escapeHtml(world.star?.name ?? '')} system</div>` + this._orrery(world);
    } else if (mode === 'galaxy') {
      html += `<div class="rv-map-title">Notable systems</div><div class="rv-cards">`;
      for (const si of SHOWCASE_STARS) {
        try {
          const sys = U.system(gi, si), star = U.star(gi, si), best = U.bestPlanet(sys);
          const idx = this._targets.push(() => this._go('system', { galaxy: gi, star: si })) - 1;
          html += `<button class="rv-card" data-t="${idx}"><span class="sph" style="background:${sphereCSS(best)}"></span><span class="t"><span class="n">${escapeHtml(best?.name ?? star.name)}</span><span class="s">${escapeHtml(star.name)} · ${escapeHtml(best?.art?.name ?? best?.type ?? '')}</span></span></button>`;
        } catch (_) { /* skip */ }
      }
      html += `</div>`;
    } else if (mode === 'cosmic') {
      html += `<div class="rv-map-title">Galaxies</div><div class="rv-cards">`;
      for (let i = 0; i < 6; i++) {
        try {
          const g = U.galaxy(i);
          const c = g.colors?.core, a = g.colors?.arms;
          const col = (x, f = 255) => x ? `rgb(${Math.min(255, x.r * f) | 0},${Math.min(255, x.g * f) | 0},${Math.min(255, x.b * f) | 0})` : '#ccd';
          const idx = this._targets.push(() => this._go('galaxy', { galaxy: i })) - 1;
          html += `<button class="rv-card" data-t="${idx}"><span class="sph" style="background:radial-gradient(ellipse 60% 30% at 50% 50%, #fff 0%, ${col(c)} 18%, ${col(a)} 45%, transparent 72%)"></span><span class="t"><span class="n">${escapeHtml(g.name)}</span><span class="s">${escapeHtml(g.type)} · ${(g.starCount / 1e9).toFixed(0)} bn stars</span></span></button>`;
        } catch (_) { /* skip */ }
      }
      html += `</div>`;
    }
    const kd = dev === 'gamepad' ? 'gamepad' : 'keyboard';
    if (dev !== 'touch') html += `<div class="rv-map-foot"><span>${glyphFor(e.input, 'map', kd)} close</span><span>${glyphFor(e.input, 'menu', kd)} menu</span></div>`;
    this.inner.innerHTML = html;
    this.inner.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { const s = this._steps[+b.dataset.step]; if (!s.cur) s.go?.(); }));
    this.inner.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); this._targets[+b.dataset.t]?.(); }));
    this.focusIdx = -1;
  }

  _orrery(world) {
    const sys = world.system, star = world.star, U = this.engine.universe;
    const planets = sys.planets || [];
    const gi = star.galaxy, si = star.index;
    const W = Math.min(1040, Math.max(320, (this.engine.width || 1280) - 80));
    const narrow = W < 560;
    const a0 = Math.log(planets[0]?.orbit?.a || 1), a1 = Math.log(planets[planets.length - 1]?.orbit?.a || 2);
    const x0 = narrow ? 58 : 110, x1 = W - (narrow ? 26 : 50);
    let html = `<div class="rv-orrery" style="width:${W}px;margin-left:auto;margin-right:auto"><div class="rv-orbit-line"></div>
      <div class="rv-sun" style="left:${narrow ? 12 : 34}px;background:${starCSS(star)};width:${narrow ? 70 : 96}px;height:${narrow ? 70 : 96}px;margin:${narrow ? -35 : -48}px 0 0 ${narrow ? -35 : -48}px"></div>`;
    planets.forEach((p, i) => {
      const t = planets.length > 1 ? (Math.log(p.orbit.a) - a0) / Math.max(1e-6, a1 - a0) : 0.5;
      const x = x0 + t * (x1 - x0);
      const r = Math.max(5, Math.min(narrow ? 13 : 19, Math.sqrt(p.radius / 1000) * (narrow ? 1.1 : 1.6)));
      const cur = world.body === p;
      const idx = this._targets.push(() => this._go('system', { galaxy: gi, star: si, planet: String(i), view: p.isGas ? 'orbit' : 'surface' })) - 1;
      const life = (p.life?.flora > 0.3 ? '<i></i>' : '') + (p.civ?.level > 0 ? '<i class="c"></i>' : '');
      html += `<button class="rv-body${cur ? ' cur' : ''}" data-t="${idx}" style="left:${x.toFixed(1)}px;transform:translate(-50%,-${r}px)">
        <span class="sph" style="width:${2 * r}px;height:${2 * r}px;background:${sphereCSS(p)}">${p.rings ? `<span class="ring" style="width:${r * 3.4}px;height:${r * 3.4}px"></span>` : ''}${cur ? `<span class="here" style="width:${2 * r + 12}px;height:${2 * r + 12}px"></span>` : ''}</span>
        ${narrow && !cur ? '' : `<span class="nm">${escapeHtml(p.name)}</span><span class="ar">${escapeHtml(p.art?.name ?? p.type)}</span>`}${life && !narrow ? `<span class="lf">${life}</span>` : ''}
      </button>`;
      if (p.moons?.length && !narrow) {
        html += `<div class="rv-moons" style="position:absolute;left:${x.toFixed(1)}px;top:86px">`;
        p.moons.slice(0, 4).forEach((mn, j) => {
          const mi = this._targets.push(() => this._go('system', { galaxy: gi, star: si, planet: `${i}.${j}`, view: 'surface' })) - 1;
          html += `<button class="rv-moon" data-t="${mi}"${world.body === mn ? ' style="color:var(--ui-gold)"' : ''}><span class="sph" style="background:${sphereCSS(mn)}"></span>${escapeHtml(mn.name)}</button>`;
        });
        html += `</div>`;
      }
    });
    html += `</div>`;
    void U;
    return html;
  }

  nav(dir) {
    const items = [...this.inner.querySelectorAll('.rv-step:not(.cur), .rv-body, .rv-card, .rv-moon')];
    if (!items.length) return;
    items.forEach((i) => i.classList.remove('focus'));
    this.focusIdx = (this.focusIdx + dir + items.length) % items.length;
    items[this.focusIdx].classList.add('focus');
  }
  activate() {
    const items = [...this.inner.querySelectorAll('.rv-step:not(.cur), .rv-body, .rv-card, .rv-moon')];
    items[this.focusIdx]?.click?.();
  }

  update(dt) {
    const tgt = this.open ? 1 : 0;
    if (tgt === 0 && this.a <= 0.001) { if (this.wrap.style.display !== 'none') this.wrap.style.display = 'none'; return; }
    this.a += (tgt - this.a) * (1 - Math.exp(-dt * 10));
    if (Math.abs(tgt - this.a) < 0.002) this.a = tgt;
    this.wrap.style.opacity = this.a.toFixed(3);
    this.inner.style.transform = `translate3d(0,${((1 - this.a) * 14).toFixed(2)}px,0)`;
  }
}
