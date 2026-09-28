// Unified input: keyboard + mouse (pointer lock) + touch (floating sticks, drag, pinch, tap)
// + gamepad → semantic actions and axes. Controllers never read DOM events directly.
//
//   input.axis('move')  → THREE.Vector2  (x = strafe right, y = forward), length ≤ 1
//   input.axis('look')  → THREE.Vector2  per-frame look delta in RADIANS (x = yaw right, y = pitch up)
//   input.held('jump') / input.down('jump') / input.up('jump')
//   input.zoom          → per-frame zoom delta (+ = zoom in / closer)
//   input.pointer       → { x, y, nx, ny, clicked, doubleClicked, dragging, onCanvas }
//   input.setScheme('orbit' | 'character' | 'vehicle' | 'flight')
//
// Touch schemes:
//   orbit      : 1-finger drag = look/rotate, pinch = zoom, tap = click, double-tap = focus
//   character/vehicle/flight : left-half floating move stick, right-half drag = look,
//                pinch (2 fingers on right) = zoom; buttons are DOM elements owned by the UI
//                track which call input.setVirtual(action, bool).
//
// The UI track renders the sticks from input.touchSticks (pure state, no DOM here).
import * as THREE from 'three';
import { events } from './events.js';

export const DEFAULT_BINDINGS = {
  // action: [key codes | 'Mouse0'.. | 'Pad<n>']
  jump: ['Space', 'Pad0'],
  ascend: ['Space', 'Pad0'],
  descend: ['ControlLeft', 'KeyC', 'Pad1'],
  sprint: ['ShiftLeft', 'ShiftRight', 'Pad10', 'Pad4'],
  boost: ['ShiftLeft', 'ShiftRight', 'Pad7'],
  interact: ['KeyE', 'Pad2'],
  vehicle: ['KeyF', 'Pad3'],
  view: ['KeyV', 'Pad11'],
  map: ['KeyM', 'Tab', 'Pad8'],
  menu: ['Escape', 'Pad9'],
  back: ['Backspace'],
  primary: ['Mouse0', 'Pad5'],
  secondary: ['Mouse2', 'Pad6'],
  photo: ['KeyH'],
  time: ['KeyT'],
  glide: ['Space', 'Pad0'],
  rollLeft: ['KeyQ', 'Pad14'],
  rollRight: ['KeyE', 'Pad15'],
  up: ['KeyW', 'ArrowUp', 'Pad12'],
  down: ['KeyS', 'ArrowDown', 'Pad13'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
};

const GAME_KEYS = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace']);

export class Input {
  constructor(element) {
    this.el = element;
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    this.settings = { mouseSens: 0.0022, touchSens: 0.0052, stickSens: 2.6, invertY: false, invertOrbitY: false };
    this.scheme = 'orbit';

    this.keys = new Set();
    this._pressed = new Set();
    this._released = new Set();
    this.mouse = { x: 0, y: 0, dx: 0, dy: 0, buttons: 0, locked: false };
    this.zoom = 0;
    this.pointer = { x: 0, y: 0, nx: 0, ny: 0, clicked: false, doubleClicked: false, dragging: false, onCanvas: false, button: 0 };

    this._move = new THREE.Vector2();
    this._look = new THREE.Vector2();
    this._lookAccum = new THREE.Vector2();   // radians accumulated from events this frame
    this.virtual = { move: new THREE.Vector2(), look: new THREE.Vector2(), buttons: new Set() };
    this._virtualPrev = new Set();

    // Touch state
    this.touches = new Map(); // id -> {x,y,sx,sy,t0,role}
    this.touchSticks = {
      move: { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0, radius: 56, sprint: false },
      look: { active: false, id: -1, x: 0, y: 0 },
    };
    this._pinchDist = 0;
    this._lastTapTime = 0;
    this._lastTapPos = { x: 0, y: 0 };

    // Gamepad
    this.gamepad = { connected: false, axes: [0, 0, 0, 0], buttons: new Array(17).fill(0), prev: new Array(17).fill(0) };
    this.lastDevice = 'keyboard'; // 'keyboard' | 'touch' | 'gamepad'

    // Deterministic simulation (tests / shot mode)
    this._sim = []; // {code, remaining}
    this._simMove = null; // {x,y,remaining}
    this._simLook = new THREE.Vector2();

    this._bind();
  }

  // ------------------------------------------------------------------ public API
  setScheme(s) {
    if (this.scheme === s) return;
    this.scheme = s;
    if (s === 'orbit' && this.mouse.locked) this.exitPointerLock();
    this._resetTouch();
    events.emit('input:scheme', { scheme: s });
  }

  /** Is a raw key code / binding code currently held? */
  code(code) { return this.keys.has(code); }

  held(action) {
    if (this.virtual.buttons.has(action)) return true;
    for (const c of this.bindings[action] || []) if (this._codeHeld(c)) return true;
    return false;
  }
  down(action) {
    if (this.virtual.buttons.has(action) && !this._virtualPrev.has(action)) return true;
    for (const c of this.bindings[action] || []) if (this._pressed.has(c)) return true;
    return false;
  }
  up(action) {
    if (!this.virtual.buttons.has(action) && this._virtualPrev.has(action)) return true;
    for (const c of this.bindings[action] || []) if (this._released.has(c)) return true;
    return false;
  }
  axis(name) {
    if (name === 'move') return this._move;
    if (name === 'look') return this._look;
    return this._move;
  }
  /** Analog trigger 0..1 from gamepad (e.g. 'Pad7' = RT); keyboard fallback returns 1 when bound action held. */
  analog(action) {
    let v = this.held(action) ? 1 : 0;
    for (const c of this.bindings[action] || []) {
      if (c.startsWith('Pad')) v = Math.max(v, this.gamepad.buttons[+c.slice(3)] || 0);
    }
    return v;
  }

  /** Called by UI touch buttons. */
  setVirtual(action, on) {
    if (on) this.virtual.buttons.add(action); else this.virtual.buttons.delete(action);
    this.lastDevice = 'touch';
  }

  requestPointerLock() {
    if (this.mouse.locked || !this.el.requestPointerLock) return;
    try { const p = this.el.requestPointerLock({ unadjustedMovement: true }); p?.catch?.(() => { try { this.el.requestPointerLock(); } catch (_) {} }); } catch (_) {}
  }
  exitPointerLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  // --- deterministic simulation for tests/shot mode ---
  simHold(codeOrAction, seconds) {
    const codes = this.bindings[codeOrAction] ? [this.bindings[codeOrAction][0]] : [codeOrAction];
    for (const c of codes) { this._sim.push({ code: c, remaining: seconds }); this.keys.add(c); this._pressed.add(c); }
  }
  simPress(codeOrAction) { this.simHold(codeOrAction, 1 / 60); }
  simMove(x, y, seconds) { this._simMove = { x, y, remaining: seconds }; }
  simLook(dxRad, dyRad) { this._simLook.x += dxRad; this._simLook.y += dyRad; }
  simClick(px, py) {
    this.pointer.x = px; this.pointer.y = py; this._updatePointerNorm();
    this.pointer.clicked = true; this._clickedPending = true;
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    this._pollGamepad();

    // simulated keys
    for (let i = this._sim.length - 1; i >= 0; i--) {
      const s = this._sim[i];
      s.remaining -= dt;
      if (s.remaining <= 0) { this.keys.delete(s.code); this._released.add(s.code); this._sim.splice(i, 1); }
    }

    // --- move axis
    let mx = 0, my = 0;
    if (this.held('right')) mx += 1;
    if (this.held('left')) mx -= 1;
    if (this.held('up')) my += 1;
    if (this.held('down')) my -= 1;
    const gp = this.gamepad;
    if (gp.connected) {
      const [lx, ly] = radialDeadzone(gp.axes[0], gp.axes[1], 0.15);
      mx += lx; my -= ly;
    }
    mx += this.virtual.move.x; my += this.virtual.move.y;
    if (this._simMove) {
      mx += this._simMove.x; my += this._simMove.y;
      this._simMove.remaining -= dt;
      if (this._simMove.remaining <= 0) this._simMove = null;
    }
    this._move.set(mx, my);
    if (this._move.lengthSq() > 1) this._move.normalize();

    // --- look axis (radians this frame)
    this._look.copy(this._lookAccum);
    if (gp.connected) {
      const [rx, ry] = radialDeadzone(gp.axes[2], gp.axes[3], 0.12);
      // response curve for fine aim
      const cx = Math.sign(rx) * rx * rx, cy = Math.sign(ry) * ry * ry;
      this._look.x += cx * this.settings.stickSens * dt;
      this._look.y -= cy * this.settings.stickSens * dt * (this.settings.invertY ? -1 : 1);
      // gamepad zoom on dpad in orbit
      if (this.scheme === 'orbit') {
        if (gp.buttons[12]) this.zoom += 2 * dt;
        if (gp.buttons[13]) this.zoom -= 2 * dt;
      }
    }
    this._look.add(this.virtual.look);
    this._look.add(this._simLook);
    this._simLook.set(0, 0);
  }

  endFrame() {
    this._pressed.clear();
    this._released.clear();
    this._lookAccum.set(0, 0);
    this.virtual.look.set(0, 0);
    this.zoom = 0;
    this.pointer.clicked = false;
    this.pointer.doubleClicked = false;
    this.mouse.dx = 0; this.mouse.dy = 0;
    this._virtualPrev = new Set(this.virtual.buttons);
    for (let i = 0; i < this.gamepad.buttons.length; i++) this.gamepad.prev[i] = this.gamepad.buttons[i];
  }

  // ------------------------------------------------------------------ internals
  _codeHeld(c) {
    if (c.startsWith('Pad')) return this.gamepad.connected && this.gamepad.buttons[+c.slice(3)] > 0.5;
    if (c.startsWith('Mouse')) return (this.mouse.buttons & (1 << (+c.slice(5) === 2 ? 1 : +c.slice(5) === 1 ? 2 : 0))) !== 0;
    return this.keys.has(c);
  }

  _updatePointerNorm() {
    const r = this.el.getBoundingClientRect();
    this.pointer.nx = ((this.pointer.x - r.left) / r.width) * 2 - 1;
    this.pointer.ny = -(((this.pointer.y - r.top) / r.height) * 2 - 1);
  }

  _bind() {
    const el = this.el;
    const opts = { passive: false };

    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this._pressed.add(e.code);
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
      events.emit('input:gesture');
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this._released.add(e.code);
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.buttons = 0; this._resetTouch(); });

    document.addEventListener('pointerlockchange', () => {
      this.mouse.locked = document.pointerLockElement === el;
      events.emit('input:pointerlock', { locked: this.mouse.locked });
    });

    // ---------- mouse (pointer events, mouse only)
    let downX = 0, downY = 0, downT = 0, moved = 0, lastClickT = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      el.focus?.();
      this.mouse.buttons = e.buttons;
      const code = 'Mouse' + e.button;
      this.keys.add(code); this._pressed.add(code);
      downX = e.clientX; downY = e.clientY; downT = performance.now(); moved = 0;
      this.pointer.button = e.button;
      this.lastDevice = 'keyboard';
      events.emit('input:gesture');
      if (this.scheme !== 'orbit' && e.button === 0 && !this.mouse.locked) this.requestPointerLock();
    });
    window.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.mouse.buttons = e.buttons;
      const code = 'Mouse' + e.button;
      this.keys.delete(code); this._released.add(code);
      const dtms = performance.now() - downT;
      if (moved < 6 && dtms < 400 && e.target === el) {
        this.pointer.clicked = true;
        const now = performance.now();
        if (now - lastClickT < 320) this.pointer.doubleClicked = true;
        lastClickT = now;
      }
      this.pointer.dragging = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.pointer.x = e.clientX; this.pointer.y = e.clientY; this.pointer.onCanvas = true;
      this._updatePointerNorm();
      const mx = e.movementX || 0, my = e.movementY || 0;
      this.mouse.dx += mx; this.mouse.dy += my;
      if (this.mouse.locked) {
        this._lookAccum.x += mx * this.settings.mouseSens;
        this._lookAccum.y -= my * this.settings.mouseSens * (this.settings.invertY ? -1 : 1);
      } else if (e.buttons & 1 || e.buttons & 2 || e.buttons & 4) {
        moved += Math.abs(mx) + Math.abs(my);
        if (moved > 5) this.pointer.dragging = true;
        // orbit / unlocked drag-look
        const k = this.scheme === 'orbit' ? 0.005 : this.settings.mouseSens * 1.4;
        this._lookAccum.x += mx * k;
        this._lookAccum.y -= my * k * (this.settings.invertOrbitY && this.scheme === 'orbit' ? -1 : 1);
      }
    });
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.pointer.onCanvas = false; });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      this.zoom += -d * 0.0015;
    }, opts);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    // ---------- touch
    el.addEventListener('touchstart', (e) => this._onTouchStart(e), opts);
    el.addEventListener('touchmove', (e) => this._onTouchMove(e), opts);
    el.addEventListener('touchend', (e) => this._onTouchEnd(e), opts);
    el.addEventListener('touchcancel', (e) => this._onTouchEnd(e), opts);

    window.addEventListener('gamepadconnected', () => { this.gamepad.connected = true; this.lastDevice = 'gamepad'; events.emit('input:device', { device: 'gamepad' }); });
    window.addEventListener('gamepaddisconnected', () => { this.gamepad.connected = false; });
  }

  _resetTouch() {
    this.touches.clear();
    const m = this.touchSticks.move; m.active = false; m.id = -1; m.x = m.y = 0; m.sprint = false;
    const l = this.touchSticks.look; l.active = false; l.id = -1;
    this.virtual.move.set(0, 0);
    this._pinchDist = 0;
  }

  _onTouchStart(e) {
    e.preventDefault();
    this.lastDevice = 'touch';
    events.emit('input:gesture');
    const w = window.innerWidth;
    for (const t of e.changedTouches) {
      const rec = { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, t0: performance.now(), role: 'look', moved: 0 };
      if (this.scheme !== 'orbit' && t.clientX < w * 0.45 && !this.touchSticks.move.active) {
        rec.role = 'move';
        const m = this.touchSticks.move;
        m.active = true; m.id = t.identifier; m.ox = t.clientX; m.oy = t.clientY; m.x = 0; m.y = 0; m.sprint = false;
      } else if (!this.touchSticks.look.active) {
        const l = this.touchSticks.look; l.active = true; l.id = t.identifier; l.x = t.clientX; l.y = t.clientY;
      }
      this.touches.set(t.identifier, rec);
    }
    // pinch detection: two non-move touches
    const lookTouches = [...this.touches.values()].filter((r) => r.role !== 'move');
    if (lookTouches.length === 2) {
      this._pinchDist = Math.hypot(lookTouches[0].x - lookTouches[1].x, lookTouches[0].y - lookTouches[1].y);
    }
    this.pointer.x = e.changedTouches[0].clientX; this.pointer.y = e.changedTouches[0].clientY; this._updatePointerNorm();
  }

  _onTouchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const rec = this.touches.get(t.identifier);
      if (!rec) continue;
      const dx = t.clientX - rec.x, dy = t.clientY - rec.y;
      rec.x = t.clientX; rec.y = t.clientY;
      rec.moved += Math.abs(dx) + Math.abs(dy);
      if (rec.role === 'move') {
        const m = this.touchSticks.move;
        let ox = t.clientX - m.ox, oy = t.clientY - m.oy;
        const len = Math.hypot(ox, oy);
        m.sprint = len > m.radius * 1.35;
        // stick origin follows the finger when dragged far beyond the radius (floating stick)
        if (len > m.radius * 1.9) {
          const k = (len - m.radius * 1.9) / len;
          m.ox += ox * k; m.oy += oy * k;
          ox = t.clientX - m.ox; oy = t.clientY - m.oy;
        }
        const l2 = Math.min(1, Math.hypot(ox, oy) / m.radius);
        const ang = Math.atan2(oy, ox);
        m.x = Math.cos(ang) * l2; m.y = Math.sin(ang) * l2;
        this.virtual.move.set(m.x, -m.y);
        if (m.sprint) this.virtual.buttons.add('sprint'); else this.virtual.buttons.delete('sprint');
      }
    }
    const lookTouches = [...this.touches.entries()].filter(([, r]) => r.role !== 'move');
    if (lookTouches.length >= 2) {
      const [a, b] = [lookTouches[0][1], lookTouches[1][1]];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this._pinchDist > 0) this.zoom += (d - this._pinchDist) * 0.006;
      this._pinchDist = d;
    } else if (lookTouches.length === 1) {
      const [id, r] = lookTouches[0];
      const t = [...e.changedTouches].find((tt) => tt.identifier === id);
      if (t) {
        // use the recorded delta via previous position stored in touchSticks.look
        const l = this.touchSticks.look;
        const dx = t.clientX - l.x, dy = t.clientY - l.y;
        l.x = t.clientX; l.y = t.clientY;
        const k = this.scheme === 'orbit' ? 0.006 : this.settings.touchSens;
        this._lookAccum.x += dx * k;
        this._lookAccum.y -= dy * k * (this.settings.invertY && this.scheme !== 'orbit' ? -1 : 1);
        if (r.moved > 8) this.pointer.dragging = true;
      }
    }
  }

  _onTouchEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const rec = this.touches.get(t.identifier);
      if (!rec) continue;
      const dur = performance.now() - rec.t0;
      if (rec.role !== 'move' && rec.moved < 10 && dur < 280) {
        // tap → click at position
        this.pointer.x = t.clientX; this.pointer.y = t.clientY; this._updatePointerNorm();
        this.pointer.clicked = true;
        const now = performance.now();
        if (now - this._lastTapTime < 330 && Math.hypot(t.clientX - this._lastTapPos.x, t.clientY - this._lastTapPos.y) < 40) this.pointer.doubleClicked = true;
        this._lastTapTime = now; this._lastTapPos = { x: t.clientX, y: t.clientY };
      }
      if (rec.role === 'move') {
        const m = this.touchSticks.move; m.active = false; m.id = -1; m.x = m.y = 0; m.sprint = false;
        this.virtual.move.set(0, 0);
        this.virtual.buttons.delete('sprint');
      }
      if (this.touchSticks.look.id === t.identifier) {
        this.touchSticks.look.active = false; this.touchSticks.look.id = -1;
      }
      this.touches.delete(t.identifier);
    }
    // re-home look stick to a remaining non-move touch
    const remaining = [...this.touches.entries()].filter(([, r]) => r.role !== 'move');
    if (remaining.length && !this.touchSticks.look.active) {
      const [id, r] = remaining[0];
      Object.assign(this.touchSticks.look, { active: true, id, x: r.x, y: r.y });
    }
    if (remaining.length < 2) this._pinchDist = 0;
    if (this.touches.size === 0) this.pointer.dragging = false;
  }

  _pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    const g = this.gamepad;
    if (!pad) { g.connected = false; return; }
    g.connected = true;
    for (let i = 0; i < 4; i++) g.axes[i] = pad.axes[i] || 0;
    let any = false;
    for (let i = 0; i < g.buttons.length; i++) {
      const b = pad.buttons[i];
      const v = b ? (typeof b === 'object' ? b.value : b) : 0;
      g.buttons[i] = v;
      if (v > 0.5 && !(g.prev[i] > 0.5)) { this._pressed.add('Pad' + i); any = true; }
      if (!(v > 0.5) && g.prev[i] > 0.5) this._released.add('Pad' + i);
    }
    if (any || Math.abs(g.axes[0]) + Math.abs(g.axes[1]) + Math.abs(g.axes[2]) + Math.abs(g.axes[3]) > 0.5) this.lastDevice = 'gamepad';
  }
}

function radialDeadzone(x, y, dz) {
  const len = Math.hypot(x, y);
  if (len < dz) return [0, 0];
  const k = Math.min(1, (len - dz) / (1 - dz)) / len;
  return [x * k, y * k];
}
