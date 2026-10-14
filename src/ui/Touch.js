// Touch layer for phones/tablets: renders the floating move stick from input.touchSticks and a
// tiny context-sensitive action cluster (hit areas ≥ 44 px, small visuals) that calls
// input.setVirtual(action, bool). Layout adapts to the input scheme and to the player/vehicle state.
import { icon } from './icons.js';
import { Params } from '../core/Params.js';

// Thumb arc around the primary button (bottom-right). Polar slots [radius px, angle deg] from the primary's
// centre (0° = right, 90° = up); the primary sits at PRIMARY from the safe bottom-right corner.
const PRIMARY = { land: [-80, -84], port: [-76, -100] };
const SLOTS = {
  A: [0, 0],        // primary (large)
  B: [86, 180],     // left of primary
  D: [86, 135],     // diagonal
  C: [86, 90],      // above primary
  E: [152, 166],    // outer, low-left (small)
  F: [152, 112],    // outer, high (small)
};

const LAYOUTS = {
  character: [
    { id: 'jump', slot: 'A', action: 'jump', icon: 'jump', size: 'lg', label: 'jump' },
    { id: 'slide', slot: 'B', action: 'descend', icon: 'slide', label: 'slide' },
    { id: 'vehicle', slot: 'C', action: 'vehicle', icon: 'vehicle', ctx: 'vehicle', label: 'ride' },
    { id: 'interact', slot: 'D', action: 'interact', icon: 'interact', ctx: 'interact', accent: true, label: 'use' },
    { id: 'view', slot: 'E', action: 'view', icon: 'view', size: 'sm', label: 'view' },
  ],
  vehicle: [
    { id: 'boost', slot: 'A', action: 'boost', icon: 'boost', size: 'lg', label: 'boost' },
    { id: 'jump', slot: 'B', action: 'jump', icon: 'jump', label: 'hop' },
    { id: 'exit', slot: 'C', action: 'vehicle', icon: 'exit', label: 'exit' },
    { id: 'view', slot: 'E', action: 'view', icon: 'view', size: 'sm', label: 'view' },
  ],
  flight: [
    { id: 'boost', slot: 'A', action: 'boost', icon: 'boost', size: 'lg', label: 'boost' },
    { id: 'down', slot: 'B', action: 'descend', icon: 'descend', label: 'down' },
    { id: 'up', slot: 'C', action: 'ascend', icon: 'ascend', label: 'up' },
    { id: 'exit', slot: 'F', action: 'vehicle', icon: 'exit', size: 'sm', label: 'exit' },
    { id: 'view', slot: 'E', action: 'view', icon: 'view', size: 'sm', label: 'view' },
  ],
  orbit: [],
};
const USED_KEY = 'rv.touchUsed';

// four tiny direction chevrons inside the ring (100×100 viewBox)
const TICKS = `<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M45 13l5-5 5 5"/><path d="M45 87l5 5 5-5"/><path d="M13 45l-5 5 5 5"/><path d="M87 45l5 5-5 5"/></svg>`;

/**
 * Resting anchor of the move stick: a fixed inset from the true bottom-left safe corner (never width-relative,
 * so it lands in the same thumb spot on every phone and stays out of the mid-ground). Vehicle/flight schemes
 * sit a little higher so the ring clears the vehicle silhouette and the bottom edge swipe zone.
 */
export function stickAnchor(W, H, safeL, safeB, scheme) {
  const portrait = H > W;
  const mx = portrait ? 86 : 104;
  const my = portrait ? 132 : (H < 460 ? 104 : 124);
  const lift = scheme === 'vehicle' || scheme === 'flight' ? (portrait ? 18 : 10) : 0;
  return [mx + safeL, H - my - lift - safeB];
}

export class Touch {
  constructor(ui, parent) {
    this.ui = ui;
    this.engine = ui.engine;
    this.input = ui.engine.input;
    const forced = Params.raw.get('touch');
    this.forced = forced === '1' || forced === 'true';
    this.el = document.createElement('div');
    this.el.className = 'rv-touch';
    this.el.style.display = 'none';
    this.el.innerHTML = `
      <div class="rv-stick rv-hide"><div class="rv-stick-ring"></div><div class="rv-stick-ticks">${TICKS}</div><div class="rv-stick-knob"></div><div class="rv-stick-lbl">move</div></div>
      <div class="rv-lookdot rv-hide"></div>
      <div class="rv-tbtns"></div>
      <div class="rv-pinch rv-hide"><span>${icon('pinch')}</span>pinch to zoom · drag to look</div>`;
    parent.appendChild(this.el);
    this.stickEl = this.el.querySelector('.rv-stick');
    this.knobEl = this.el.querySelector('.rv-stick-knob');
    this.stickLbl = this.el.querySelector('.rv-stick-lbl');
    this.ticksEl = this.el.querySelector('.rv-stick-ticks');
    this.lookEl = this.el.querySelector('.rv-lookdot');
    this.btnsEl = this.el.querySelector('.rv-tbtns');
    this.pinchEl = this.el.querySelector('.rv-pinch');
    this.scheme = null;
    this.buttons = [];
    this.visible = false;
    this.alpha = 0;
    this.stickA = 0; this.lookA = 0; this.pinchA = 0;
    this.usedStick = false; this.usedPinch = false; this.pinchT = 0;
    this._last = { sx: NaN, sy: NaN, kx: NaN, ky: NaN, lx: NaN, ly: NaN };
    this.sawDesktop = false;
    this.used = new Set();
    if (!this.engine.shot) { try { for (const k of JSON.parse(localStorage.getItem(USED_KEY) || '[]')) this.used.add(k); } catch (_) { /* ignore */ } }
    this._portrait = null;
    const desk = (e) => { if (!e.pointerType || e.pointerType === 'mouse') this.sawDesktop = true; };
    window.addEventListener('keydown', desk, true);
    window.addEventListener('pointerdown', desk, true);
    this.setScheme(this.input.scheme || 'orbit');
  }

  get active() {
    const q = this.engine.quality, dev = this.input.lastDevice;
    if (this.forced || dev === 'touch') return true;
    if (dev === 'gamepad') return false;
    // phones/tablets start in touch mode until a real keyboard/mouse event is seen
    return !!(q?.touch && q?.mobile && !this.sawDesktop);
  }

  setScheme(scheme) {
    if (scheme === this.scheme) return;
    this.scheme = scheme;
    // release anything held by the previous layout
    for (const b of this.buttons) if (b.down) this._release(b);
    this.btnsEl.innerHTML = '';
    this.buttons = [];
    const layout = LAYOUTS[scheme] || [];
    for (const d of layout) {
      const el = document.createElement('div');
      el.className = `rv-tb${d.size ? ' ' + d.size : ''}${d.accent ? ' accent' : ''}`;
      el.innerHTML = `<i class="rv-tb-pulse"></i><span>${icon(d.icon)}</span>${d.label ? `<div class="rv-tb-lbl">${d.label}</div>` : ''}`;
      const b = { ...d, el, span: el.querySelector('span'), ring: el.querySelector('.rv-tb-pulse'), lbl: el.querySelector('.rv-tb-lbl'), down: false, pid: -1, a: d.ctx ? 0 : 1, shown: true, curIcon: d.icon, pulse: 0, avail: false, lblA: this.used.has(d.id) ? 0 : 1 };
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); b.pid = e.pointerId; try { el.setPointerCapture(e.pointerId); } catch (_) {} this._press(b); });
      const up = (e) => { if (e.pointerId !== b.pid && b.pid !== -1) return; e.preventDefault(); this._release(b); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      this.btnsEl.appendChild(el);
      this.buttons.push(b);
    }
    this._portrait = null; // re-place on next update
    this.pinchT = 0;
  }

  _press(b) {
    if (b.down) return;
    b.down = true; b.el.classList.add('on');
    if (!this.used.has(b.id)) {
      this.used.add(b.id);
      if (!this.engine.shot) { try { localStorage.setItem(USED_KEY, JSON.stringify([...this.used])); } catch (_) { /* ignore */ } }
    }
    this.input.setVirtual(b.action, true);
    if (b.action === 'jump') this.input.setVirtual('glide', true);
    if (b.action === 'boost') this.input.setVirtual('sprint', true);
    try { navigator.vibrate?.(8); } catch (_) { /* ignore */ }
  }
  _release(b) {
    if (!b.down) return;
    b.down = false; b.pid = -1; b.el.classList.remove('on');
    this.input.setVirtual(b.action, false);
    if (b.action === 'jump') this.input.setVirtual('glide', false);
    if (b.action === 'boost') this.input.setVirtual('sprint', false);
  }

  releaseAll() { for (const b of this.buttons) this._release(b); }

  /** Position the cluster on its thumb arc (portrait and landscape use a slightly different primary inset). */
  _place(portrait) {
    this._portrait = portrait;
    const [px, py] = PRIMARY[portrait ? 'port' : 'land'];
    for (const b of this.buttons) {
      // portrait: the outer low slot climbs a little so it stays clear of the move stick
      const [r, deg] = portrait && b.slot === 'E' ? [140, 150] : SLOTS[b.slot] || [0, 0];
      const x = px + r * Math.cos(deg * Math.PI / 180), y = py - r * Math.sin(deg * Math.PI / 180);
      b.el.style.left = `calc(${x.toFixed(1)}px - var(--safe-right))`;
      b.el.style.top = `calc(${y.toFixed(1)}px - var(--safe-bottom))`;
    }
  }

  update(dt, ctx) {
    const show = this.active && !ctx.hidden;
    const tgt = show ? 1 : 0;
    this.alpha += (tgt - this.alpha) * (1 - Math.exp(-dt * 8));
    if (!show && this.alpha < 0.01) {
      if (this.visible) { this.el.style.display = 'none'; this.visible = false; this.releaseAll(); }
      return;
    }
    if (!this.visible) { this.el.style.display = ''; this.visible = true; }
    this.el.style.opacity = this.alpha.toFixed(3);
    const W = this.engine.width, H = this.engine.height;
    const sticks = this.input.touchSticks;
    const m = sticks?.move;
    const scheme = this.scheme;

    // ---- move stick (floating) or a ghost at rest in character-like schemes
    let sx, sy, kx = 0, ky = 0, sa = 0;
    if (m?.active) {
      sx = m.ox; sy = m.oy; kx = m.x * m.radius; ky = m.y * m.radius; sa = 1; this.usedStick = true;
      this.stickEl.classList.toggle('sprint', !!m.sprint);
    } else if (scheme !== 'orbit') {
      [sx, sy] = stickAnchor(W, H, ctx.safeL, ctx.safeB, scheme);
      sa = this.usedStick ? 0.5 : 0.9;
      this.stickEl.classList.remove('sprint');
    }
    this.stickA += (sa - this.stickA) * (1 - Math.exp(-dt * (sa > this.stickA ? 18 : 6)));
    if (this.stickA > 0.01 && sx !== undefined) {
      this.stickEl.classList.remove('rv-hide');
      if (sx !== this._last.sx || sy !== this._last.sy) { this.stickEl.style.transform = `translate3d(${sx}px,${sy}px,0)`; this._last.sx = sx; this._last.sy = sy; }
      if (kx !== this._last.kx || ky !== this._last.ky) { this.knobEl.style.transform = `translate3d(${kx}px,${ky}px,0)`; this._last.kx = kx; this._last.ky = ky; }
      this.stickEl.style.opacity = this.stickA.toFixed(3);
      const lo = this.usedStick ? '0' : '1';
      if (this._lblOp !== lo) { this.stickLbl.style.opacity = lo; this._lblOp = lo; }
      const to = m?.active ? '0.25' : '1';
      if (this._tkOp !== to) { this.ticksEl.style.opacity = to; this._tkOp = to; }
    } else this.stickEl.classList.add('rv-hide');

    // ---- look touch feedback
    const l = sticks?.look;
    const la = l?.active && scheme !== 'orbit' ? 0.8 : 0;
    this.lookA += (la - this.lookA) * (1 - Math.exp(-dt * 10));
    if (this.lookA > 0.01 && l) {
      this.lookEl.classList.remove('rv-hide');
      if (l.x !== this._last.lx || l.y !== this._last.ly) { this.lookEl.style.transform = `translate3d(${l.x}px,${l.y}px,0)`; this._last.lx = l.x; this._last.ly = l.y; }
      this.lookEl.style.opacity = this.lookA.toFixed(3);
    } else this.lookEl.classList.add('rv-hide');

    // ---- pinch/drag onboarding (orbit scheme, until first zoom)
    if (scheme === 'orbit') { this.pinchT += dt; if (Math.abs(this.input.zoom) > 0.01) this.usedPinch = true; }
    const pa = scheme === 'orbit' && !this.usedPinch && !ctx.hintVisible && this.pinchT > 1.2 && this.pinchT < 14 ? 0.9 : 0;
    this.pinchA += (pa - this.pinchA) * (1 - Math.exp(-dt * 3));
    if (this.pinchA > 0.01) { this.pinchEl.classList.remove('rv-hide'); this.pinchEl.style.opacity = this.pinchA.toFixed(3); }
    else this.pinchEl.classList.add('rv-hide');

    // ---- buttons: thumb arc from the bottom-right corner, context visibility + icon swaps
    const portrait = H > W;
    if (portrait !== this._portrait) this._place(portrait);
    for (const b of this.buttons) {
      let want = 1, avail = true;
      if (b.ctx === 'vehicle') {
        const near = ctx.prompts.has('vehicle') && !ctx.prompts.get('vehicle').dying;
        want = near ? 1 : 0.62; avail = near;
        const l = near ? 'ride' : 'hold · call';
        if (b.lbl && b.lblT !== l) { b.lbl.textContent = l; b.lblT = l; }
        if (near && !b.avail) b.lblA = 1; // the meaning changed: show the word again
      }
      if (b.ctx === 'interact') { want = ctx.promptActions.has('interact') ? 1 : 0; avail = want > 0; }
      if (b.id === 'slide') want = ctx.playerState === 'ground' || ctx.playerState === 'slide' ? 1 : 0.0;
      if (b.down) want = 1;
      // a context action just became available: one soft ring pulse draws the thumb to it
      if (b.ctx && avail && !b.avail) b.pulse = 1;
      b.avail = avail;
      b.a += (want - b.a) * (1 - Math.exp(-dt * 10));
      if (b.pulse > 0) {
        b.pulse = Math.max(0, b.pulse - dt / 1.1);
        const k = 1 - b.pulse;
        b.ring.style.opacity = (Math.sin(Math.min(1, k * 1.4) * Math.PI) * 0.8).toFixed(3);
        b.ring.style.transform = `scale(${(1 + k * 0.55).toFixed(3)})`;
      } else if (b.ring._on !== false) { b.ring.style.opacity = '0'; b.ring._on = false; }
      if (b.pulse > 0) b.ring._on = true;
      // labels teach the layout, then step aside once that button has been used
      if (b.lbl) {
        const lt = this.used.has(b.id) && !(b.ctx === 'vehicle' && b.lblT === 'ride' && b.lblA > 0.5) ? 0 : 1;
        b.lblA += (lt - b.lblA) * (1 - Math.exp(-dt * 3));
        const lo = b.lblA.toFixed(2);
        if (b._lo !== lo) { b._lo = lo; b.lbl.style.opacity = lo; }
      }
      const vis = b.a > 0.02;
      if (vis !== b.shown) { b.el.style.visibility = vis ? '' : 'hidden'; b.shown = vis; }
      if (b.id === 'jump' && scheme === 'character') {
        // two-state glyph: up-arrow on the ground, paraglider once airborne (tap again = open glider)
        const ic = ctx.playerState === 'air' || ctx.playerState === 'glide' || ctx.playerState === 'fall' ? 'glide' : ctx.playerState === 'swim' ? 'ascend' : 'jump';
        if (ic !== b.curIcon) {
          b.span.innerHTML = icon(ic); b.curIcon = ic; b.morph = 1;
          const l = ic === 'glide' ? 'glide' : ic === 'ascend' ? 'swim up' : 'jump';
          if (b.lbl) { b.lbl.textContent = l; if (ic !== 'jump') b.lblA = 1; }
        }
      }
      // icon morph: a quick shrink-and-grow of the glyph when its meaning changes
      let ms = 1;
      if (b.morph > 0) { b.morph = Math.max(0, b.morph - dt * 5); ms = 1 - Math.sin(b.morph * Math.PI) * 0.22; }
      if (vis) {
        b.el.style.opacity = b.a.toFixed(3);
        const st = b.down ? '' : `scale(${(0.82 + 0.18 * b.a).toFixed(3)})`;
        if (b._st !== st) { b._st = st; b.span.style.transform = st; }
        const svg = b.span.firstChild;
        if (svg && svg.style) { const t = ms < 0.999 ? `scale(${ms.toFixed(3)})` : ''; if (svg._rvT !== t) { svg.style.transform = t; svg._rvT = t; } }
      }
    }
  }
}
