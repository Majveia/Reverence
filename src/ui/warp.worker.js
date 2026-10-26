// Warp cutscene, off the main thread (see Warp.js): owns the transferred OffscreenCanvas and runs its own
// animation loop, so the tunnel keeps its frame rate while the main thread builds the next scale.
//   in:  { type: 'init', canvas, w, h, dpr, mobile } · { type: 'resize', w, h, dpr }
//        { type: 'boot', gen } · { type: 'begin', gen, dir, dest } · { type: 'end' }
//   out: { type: 'idle', gen, stats } once the warp has faded out (the page then hides the canvas);
//        stats = { frames, seconds, maxGapMs, slow } (frames slower than 50 ms) for profiling
import { WarpRenderer } from './warpRender.js';

const raf = typeof self.requestAnimationFrame === 'function'
  ? (f) => self.requestAnimationFrame(f)
  : (f) => setTimeout(() => f(performance.now()), 16);
let R = null, gen = 0, running = false, last = 0;
let stats = null;

function loop(now) {
  const gap = now - last;
  const dt = Math.min(0.25, Math.max(0, gap / 1000));   // (the renderer caps it per phase)
  last = now;
  stats.frames++; stats.maxGapMs = Math.max(stats.maxGapMs, gap); if (gap > 50) stats.slow++;
  if (R.step(dt, true)) raf(loop);
  else {
    running = false;
    stats.seconds = +((now - stats.t0) / 1000).toFixed(2); stats.maxGapMs = Math.round(stats.maxGapMs);
    self.postMessage({ type: 'idle', gen, stats });
  }
}

function start() {
  if (running) return;
  running = true; last = performance.now();
  stats = { frames: 0, seconds: 0, maxGapMs: 0, slow: 0, t0: last };
  raf(loop);
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      R = new WarpRenderer(m.canvas, { mk: (w, h) => new OffscreenCanvas(w, h), mobile: !!m.mobile });
      R.resize(m.w, m.h, m.dpr);
    } else if (!R) return;
    else if (m.type === 'resize') R.resize(m.w, m.h, m.dpr);
    else if (m.type === 'boot') { gen = m.gen; R.boot(); start(); }
    else if (m.type === 'begin') { gen = m.gen; R.begin(m.dir, m.dest); start(); }
    else if (m.type === 'end') R.end();
  } catch (err) { self.postMessage({ type: 'error', message: String(err?.message || err) }); }
};
