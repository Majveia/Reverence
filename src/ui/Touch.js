// Touch layer for phones/tablets: renders the floating move stick from input.touchSticks and a
// tiny context-sensitive action cluster (hit areas ≥ 44 px, small visuals) that calls
// input.setVirtual(action, bool). Layout adapts to the input scheme and to the player/vehicle state.
import { icon } from './icons.js';
import { Params } from '../core/Params.js';

// Button slots around the bottom-right corner: [dx, dy] from the corner (px, before safe-area).
const SLOTS = {
  A: [-74, -86],    // primary (large)
  B: [-150, -58],   // left of primary
  C: [-50, -168],   // above primary
  D: [-134, -140],  // diagonal
  E: [-212, -38],   // far left low
};

const LAYOUTS = {
  character: [
    { id: 'jump', slot: 'A', action: 'jump', icon: 'jump', size: 'lg' },
    { id: 'slide', slot: 'B', action: 'descend', icon: 'slide', label: 'slide' },
    { id: 'vehicle', slot: 'C', action: 'vehicle', icon: 'vehicle', ctx: 'vehicle', label: 'ride' },
    { id: 'interact', slot: 'D', action: 'interact', icon: 'interact', ctx: 'interact', accent: true },
    { id: 'view', slot: 'E', action: 'view', icon: 'view', size: 'sm' },
  ],
  vehicle: [
    { id: 'boost', slot: 'A', action: 'boost', icon: 'boost', size: 'lg' },
    { id: 'jump', slot: 'B', action: 'jump', icon: 'jump' },
    { id: 'exit', slot: 'C', action: 'vehicle', icon: 'exit', size: 'sm', label: 'exit' },
    { id: 'view', slot: 'E', action: 'view', icon: 'view', size: 'sm' },
  ],
  flight: [
    { id: 'boost', slot: 'A', action: 'boost', icon: 'boost', size: 'lg' },
    { id: 'up', slot: 'B', action: 'ascend', icon: 'ascend' },
    { id: 'down', slot: 'D', action: 'descend', icon: 'descend' },
    { id: 'exit', slot: 'C', action: 'vehicle', icon: 'exit', size: 'sm', label: 'exit' },
    { id: 'view', slot: 'E', action: 'view', icon: 'view', size: 'sm' },
  ],
  orbit: [],
};

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
      <div class="rv-stick rv-hide"><div class="rv-stick-ring"></div><div class="rv-stick-knob"></div><div class="rv-stick-lbl">move</div></div>
      <div class="rv-lookdot rv-hide"></div>
      <div class="rv-tbtns"></div>
      <div class="rv-pinch rv-hide"><span>${icon('pinch')}</span>pinch to zoom · drag to look</div>`;
    parent.appendChild(this.el);
    this.stickEl = this.el.querySelector('.rv-stick');
    this.knobEl = this.el.querySelector('.rv-stick-knob');
    this.stickLbl = this.el.querySelector('.rv-stick-lbl');
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
      el.innerHTML = `<span>${icon(d.icon)}</span>${d.label ? `<div class="rv-tb-lbl">${d.label}</div>` : ''}`;
      const [dx, dy] = SLOTS[d.slot];
      el.style.left = `calc(${dx}px - var(--safe-right))`;
      el.style.top = `calc(${dy}px - var(--safe-bottom))`;
      const b = { ...d, el, span: el.firstChild, lbl: el.querySelector('.rv-tb-lbl'), down: false, pid: -1, a: d.ctx ? 0 : 1, shown: true, curIcon: d.icon };
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); b.pid = e.pointerId; try { el.setPointerCapture(e.pointerId); } catch (_) {} this._press(b); });
      const up = (e) => { if (e.pointerId !== b.pid && b.pid !== -1) return; e.preventDefault(); this._release(b); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      this.btnsEl.appendChild(el);
      this.buttons.push(b);
    }
    this.pinchT = 0;
  }

  _press(b) {
    if (b.down) return;
    b.down = true; b.el.classList.add('on');
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
      sx = Math.max(96, W * 0.16) + ctx.safeL; sy = H - Math.max(118, H * 0.24) - ctx.safeB;
      sa = this.usedStick ? 0.32 : 0.62;
      this.stickEl.classList.remove('sprint');
    }
    this.stickA += (sa - this.stickA) * (1 - Math.exp(-dt * (sa > this.stickA ? 18 : 6)));
    if (this.stickA > 0.01 && sx !== undefined) {
      this.stickEl.classList.remove('rv-hide');
      if (sx !== this._last.sx || sy !== this._last.sy) { this.stickEl.style.transform = `translate3d(${sx}px,${sy}px,0)`; this._last.sx = sx; this._last.sy = sy; }
      if (kx !== this._last.kx || ky !== this._last.ky) { this.knobEl.style.transform = `translate3d(${kx}px,${ky}px,0)`; this._last.kx = kx; this._last.ky = ky; }
      this.stickEl.style.opacity = this.stickA.toFixed(3);
      this.stickLbl.style.opacity = this.usedStick ? '0' : '1';
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
    const pa = scheme === 'orbit' && !this.usedPinch && this.pinchT > 1.2 && this.pinchT < 14 ? 0.9 : 0;
    this.pinchA += (pa - this.pinchA) * (1 - Math.exp(-dt * 3));
    if (this.pinchA > 0.01) { this.pinchEl.classList.remove('rv-hide'); this.pinchEl.style.opacity = this.pinchA.toFixed(3); }
    else this.pinchEl.classList.add('rv-hide');

    // ---- buttons: position relative to the bottom-right corner, context visibility + icon swaps
    for (const b of this.buttons) {
      let want = 1;
      if (b.ctx === 'vehicle') want = ctx.prompts.has('vehicle') ? 1 : 0.0;
      else if (b.ctx === 'interact') want = ctx.promptActions.has('interact') ? 1 : 0;
      if (b.id === 'slide') want = ctx.playerState === 'ground' || ctx.playerState === 'slide' ? 1 : 0.0;
      if (b.down) want = 1;
      b.a += (want - b.a) * (1 - Math.exp(-dt * 10));
      const vis = b.a > 0.02;
      if (vis !== b.shown) { b.el.style.visibility = vis ? '' : 'hidden'; b.shown = vis; }
      if (vis) { b.el.style.opacity = b.a.toFixed(3); b.el.style.transform = `scale(${(0.8 + 0.2 * b.a).toFixed(3)})`; }
      if (b.id === 'jump' && scheme === 'character') {
        const ic = ctx.playerState === 'air' || ctx.playerState === 'glide' ? 'glide' : ctx.playerState === 'swim' ? 'ascend' : 'jump';
        if (ic !== b.curIcon) { b.span.innerHTML = icon(ic); b.curIcon = ic; }
      }
    }
  }
}
