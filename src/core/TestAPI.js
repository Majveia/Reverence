// window.__rv — deterministic test / capture API used by tools/shoot.mjs and critic agents.
//
//   __rv.ready                      true once the current mode reported ready (shot mode)
//   await __rv.advance(sec)         simulate sec seconds at fixed 60 Hz, render final frame
//   __rv.hold('KeyW', sec)          hold a key / action for sec of SIM time (use before advance)
//   __rv.press('KeyE')              tap a key / action
//   __rv.move(x, y, sec)            analog move axis for sec (x strafe, y forward)
//   __rv.look(dxDeg, dyDeg)         rotate view (degrees) on next frame
//   __rv.click(px, py)              simulate a click/tap at pixel coords
//   await __rv.go('galaxy', {...})  switch mode (no transition in shot mode)
//   __rv.state()                    JSON snapshot: mode, time, fps, + mode.getState()
//   __rv.render()                   force a render
//   __rv.engine / __rv.mode         live objects for debugging
import { events } from './events.js';

export function installTestAPI(engine) {
  const api = {
    get ready() { return engine.isReady; },
    get engine() { return engine; },
    get mode() { return engine.director.current; },
    get world() { return engine.director.current?.world; },
    advance: (sec, opts) => engine.advance(sec, opts),
    hold: (code, sec = 1) => engine.input.simHold(code, sec),
    press: (code) => engine.input.simPress(code),
    move: (x, y, sec = 1) => engine.input.simMove(x, y, sec),
    look: (dxDeg, dyDeg) => engine.input.simLook(dxDeg * Math.PI / 180, dyDeg * Math.PI / 180),
    click: (px, py) => engine.input.simClick(px, py),
    render: () => engine.render(),
    async go(name, params = {}) {
      engine.isReady = false;
      engine._readyFrames = 0;
      const ok = await engine.director.go(name, params, { transition: 'none' });
      return ok;
    },
    state() {
      const m = engine.director.current;
      let ms = {};
      try { ms = m?.getState?.() ?? {}; } catch (e) { ms = { error: String(e) }; }
      return {
        mode: engine.director.currentName,
        t: +engine.time.t.toFixed(3),
        frame: engine.time.frame,
        ready: engine.isReady,
        quality: engine.quality.tier,
        reversedDepth: engine.reversedDepth,
        draw: { calls: engine.renderer.info.render.calls, tris: engine.renderer.info.render.triangles, points: engine.renderer.info.render.points },
        ...ms,
      };
    },
    events,
  };
  window.__rv = api;
  return api;
}
