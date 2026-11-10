// Unified input: keyboard, mouse (drag + pointer-lock), basic touch, gamepad, plus a virtual layer
// the touch UI feeds.  Gameplay code reads *actions and axes*, never raw devices.
//
//   input.move            {x, y}   strafe (+x right) / forward (+y)  — WASD, left stick, virtual stick
//   input.look            {x, y}   look/orbit delta this frame, in "pixels" (mouse-equivalent)
//   input.zoom            number   wheel / pinch / triggers this frame (+ = zoom out / away)
//   input.down(a)         held     input.pressed(a) / input.released(a) → edge this frame
//   input.pointer         {x, y, nx, ny, down}  last pointer position (css px and NDC −1..1)
//   input.taps            [{x, y, nx, ny, button}]  clicks/taps (no drag) this frame
//   input.setVirtualAxis('move', x, y) / setVirtualButton(a, bool) / addLook(dx, dy) / addZoom(d) / addTap(x, y)

const DEFAULT_BINDINGS = {
  moveF: ['KeyW', 'ArrowUp'], moveB: ['KeyS', 'ArrowDown'], moveL: ['KeyA', 'ArrowLeft'], moveR: ['KeyD', 'ArrowRight'],
  jump: ['Space', 'Pad0'], sprint: ['ShiftLeft', 'ShiftRight', 'Pad10'], crouch: ['KeyC', 'ControlLeft', 'Pad1'],
  interact: ['KeyE', 'Pad2'], view: ['KeyV', 'Pad3'], map: ['KeyM', 'Tab', 'Pad12'], summon: ['KeyF', 'Pad13'],
  time: ['KeyT'], photo: ['KeyP'], pause: ['Escape', 'Pad9'], light: ['KeyG', 'Pad11'], scan: ['KeyR', 'Pad14'],
  boost: ['ShiftLeft', 'ShiftRight', 'Pad7'], brake: ['KeyX', 'Pad6'], rollL: ['KeyQ', 'Pad4'], rollR: ['KeyZ', 'Pad5'],
  up: ['Space', 'Pad0'], down: ['ControlLeft', 'KeyC', 'Pad1'], land: ['KeyL', 'Pad15'], confirm: ['Enter', 'Pad0'], back: ['Backspace', 'Pad1'],
  primary: ['Mouse0'], secondary: ['Mouse2'],
};

export class Input {
  constructor(canvas, { harness = false } = {}) {
    this.canvas = canvas;
    this.harness = harness;
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    this.move = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    this.zoom = 0;
    this.pointer = { x: 0, y: 0, nx: 0, ny: 0, down: false, button: 0 };
    this.taps = [];
    this.locked = false;
    /** Set true by a realm that wants mouse-look (FPS style).  Canvas clicks then request pointer lock. */
    this.wantLock = false;
    /** Set true by the touch UI when it takes over all touch handling. */
    this.externalTouch = false;
    this.isTouch = (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
    this.lastDevice = this.isTouch ? 'touch' : 'keyboard';
    this.enabled = true;
    this.sensitivity = 1;

    this._codes = new Set();          // currently held raw codes
    this._now = new Set();            // actions held this frame
    this._prev = new Set();           // actions held last frame
    this._virtualButtons = new Set();
    this._virtualAxes = { move: { x: 0, y: 0 } };
    this._accLook = { x: 0, y: 0 };
    this._accZoom = 0;
    this._accTaps = [];
    this._drag = null;                // {id, x, y, sx, sy, moved, button}
    this._touches = new Map();
    this._pinch = 0;
    this._listeners = [];
    this._bind();
  }

  // ── queries ──
  down(a) { return this._now.has(a); }
  pressed(a) { return this._now.has(a) && !this._prev.has(a); }
  released(a) { return !this._now.has(a) && this._prev.has(a); }

  // ── virtual layer (touch UI, scripted input, tests) ──
  setVirtualAxis(name, x, y) { (this._virtualAxes[name] ??= { x: 0, y: 0 }); this._virtualAxes[name].x = x; this._virtualAxes[name].y = y; if (x || y) this.lastDevice = 'touch'; }
  setVirtualButton(a, on) { if (on) { this._virtualButtons.add(a); this.lastDevice = 'touch'; } else this._virtualButtons.delete(a); }
  /** Fire an action for exactly one frame. */
  tapAction(a) { this._virtualButtons.add(a); (this._oneShot ??= new Set()).add(a); }
  addLook(dx, dy) { this._accLook.x += dx; this._accLook.y += dy; }
  addZoom(d) { this._accZoom += d; }
  addTap(x, y, button = 0) { this._accTaps.push(this._pt(x, y, button)); }

  requestLock() {
    if (this.harness || this.isTouch || this.locked) return;
    try { const p = this.canvas.requestPointerLock?.({ unadjustedMovement: true }); p?.catch?.(() => { try { this.canvas.requestPointerLock(); } catch {} }); } catch {}
  }
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  _pt(x, y, button = 0) {
    const r = this.canvas.getBoundingClientRect();
    return { x, y, nx: ((x - r.left) / r.width) * 2 - 1, ny: -(((y - r.top) / r.height) * 2 - 1), button };
  }

  _on(target, type, fn, opts) { target.addEventListener(type, fn, opts); this._listeners.push([target, type, fn, opts]); }

  _bind() {
    const c = this.canvas;
    this._on(window, 'keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this._codes.add(e.code); this.lastDevice = 'keyboard';
    });
    this._on(window, 'keyup', (e) => this._codes.delete(e.code));
    this._on(window, 'blur', () => { this._codes.clear(); this._drag = null; this.pointer.down = false; });
    this._on(c, 'contextmenu', (e) => e.preventDefault());

    this._on(c, 'mousedown', (e) => {
      this.lastDevice = 'keyboard';
      this._codes.add('Mouse' + e.button);
      this._drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0, button: e.button };
      Object.assign(this.pointer, this._pt(e.clientX, e.clientY, e.button), { down: true });
      if (this.wantLock && !this.locked && e.button === 0) this.requestLock();
    });
    this._on(window, 'mousemove', (e) => {
      Object.assign(this.pointer, this._pt(e.clientX, e.clientY, this.pointer.button), { down: this.pointer.down });
      if (this.locked) { this._accLook.x += e.movementX; this._accLook.y += e.movementY; return; }
      if (this._drag) {
        const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
        this._drag.x = e.clientX; this._drag.y = e.clientY; this._drag.moved += Math.abs(dx) + Math.abs(dy);
        this._accLook.x += dx; this._accLook.y += dy;
      }
    });
    this._on(window, 'mouseup', (e) => {
      this._codes.delete('Mouse' + e.button);
      if (this._drag && this._drag.moved < 6 && !this.locked) this._accTaps.push(this._pt(e.clientX, e.clientY, e.button));
      this._drag = null; this.pointer.down = false;
    });
    this._on(c, 'wheel', (e) => { e.preventDefault(); this._accZoom += Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 240) / 120; }, { passive: false });
    this._on(document, 'pointerlockchange', () => { this.locked = document.pointerLockElement === c; if (!this.locked) this._codes.delete('Mouse0'); });

    // Basic touch (used only until the touch UI sets externalTouch = true): 1 finger = look/orbit, 2 = pinch zoom, tap = tap.
    const touchPos = (t) => ({ x: t.clientX, y: t.clientY });
    this._on(c, 'touchstart', (e) => {
      this.lastDevice = 'touch'; this.isTouch = true;
      if (this.externalTouch) return;
      e.preventDefault();
      for (const t of e.changedTouches) this._touches.set(t.identifier, { ...touchPos(t), sx: t.clientX, sy: t.clientY, moved: 0, t0: performance.now() });
      this._pinch = 0;
    }, { passive: false });
    this._on(c, 'touchmove', (e) => {
      if (this.externalTouch) return;
      e.preventDefault();
      if (this._touches.size >= 2 && e.touches.length >= 2) {
        const a = e.touches[0], b = e.touches[1];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (this._pinch) this._accZoom += (this._pinch - d) / 60;
        this._pinch = d;
        for (const t of e.changedTouches) { const s = this._touches.get(t.identifier); if (s) { s.moved += 10; s.x = t.clientX; s.y = t.clientY; } }
        return;
      }
      for (const t of e.changedTouches) {
        const s = this._touches.get(t.identifier); if (!s) continue;
        const dx = t.clientX - s.x, dy = t.clientY - s.y; s.x = t.clientX; s.y = t.clientY; s.moved += Math.abs(dx) + Math.abs(dy);
        this._accLook.x += dx * 1.4; this._accLook.y += dy * 1.4;
      }
    }, { passive: false });
    const end = (e) => {
      if (this.externalTouch) return;
      for (const t of e.changedTouches) {
        const s = this._touches.get(t.identifier);
        if (s && s.moved < 10 && performance.now() - s.t0 < 400) this._accTaps.push(this._pt(t.clientX, t.clientY, 0));
        this._touches.delete(t.identifier);
      }
      this._pinch = 0;
    };
    this._on(c, 'touchend', end); this._on(c, 'touchcancel', end);
  }

  /** Call once at the start of every frame. */
  update() {
    const prev = this._prev; this._prev = this._now; this._now = prev; this._now.clear();
    if (!this.enabled) { this.move.x = this.move.y = this.look.x = this.look.y = this.zoom = 0; this.taps.length = 0; this._accLook.x = this._accLook.y = this._accZoom = 0; this._accTaps.length = 0; return; }

    // gamepad → pseudo codes + axes
    let gx = 0, gy = 0, glx = 0, gly = 0, gz = 0;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
      gx += dz(p.axes[0] || 0); gy -= dz(p.axes[1] || 0);
      glx += dz(p.axes[2] || 0); gly += dz(p.axes[3] || 0);
      p.buttons.forEach((b, i) => { if (b.pressed || b.value > 0.5) { this._codes.add('Pad' + i); this.lastDevice = 'gamepad'; } else this._codes.delete('Pad' + i); });
      gz += ((p.buttons[6]?.value || 0) - (p.buttons[7]?.value || 0)) * 0;
      if (gx || gy || glx || gly) this.lastDevice = 'gamepad';
    }

    for (const a in this.bindings) { for (const code of this.bindings[a]) { if (this._codes.has(code)) { this._now.add(a); break; } } }
    for (const a of this._virtualButtons) this._now.add(a);
    if (this._oneShot) { for (const a of this._oneShot) this._virtualButtons.delete(a); this._oneShot.clear(); }

    let mx = (this._now.has('moveR') ? 1 : 0) - (this._now.has('moveL') ? 1 : 0) + gx + this._virtualAxes.move.x;
    let my = (this._now.has('moveF') ? 1 : 0) - (this._now.has('moveB') ? 1 : 0) + gy + this._virtualAxes.move.y;
    const m = Math.hypot(mx, my); if (m > 1) { mx /= m; my /= m; }
    this.move.x = mx; this.move.y = my;

    this.look.x = (this._accLook.x + glx * 14) * this.sensitivity; this.look.y = (this._accLook.y + gly * 14) * this.sensitivity;
    this.zoom = this._accZoom + gz;
    this._accLook.x = this._accLook.y = 0; this._accZoom = 0;
    this.taps = this._accTaps; this._accTaps = [];
  }

  dispose() { for (const [t, type, fn, opts] of this._listeners) t.removeEventListener(type, fn, opts); this._listeners.length = 0; }
}
