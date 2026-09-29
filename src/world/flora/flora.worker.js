// Flora placement worker: owns a SurfaceGen (same deterministic surface as the main thread) and the
// serialisable style table; turns cell jobs into packed instance arrays.
import { SurfaceGen } from '../planet/SurfaceGen.js';
import { runJob } from './placement.js';

let gen = null, table = null;

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      gen = new SurfaceGen(m.cfg);
      table = m.table;
      self.postMessage({ type: 'init', ok: true });
    } else if (m.type === 'flats') {
      // terrain flatten stamps (civ plazas/pads) so trees sit on graded ground
      if (gen?.setFlattens) gen.setFlattens(m.flats || []);
    } else if (m.type === 'job') {
      if (!gen) throw new Error('flora worker not initialised');
      const t0 = performance.now();
      const r = runJob(gen, table, m.job);
      if (r) r.ms = performance.now() - t0;
      const tr = [];
      if (r) for (const k of ['inst', 'model', 'finst', 'fmodel']) if (r[k]) tr.push(r[k].buffer);
      self.postMessage({ type: 'job', id: m.id, res: r }, tr);
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m?.id, message: String(e?.stack || e) });
  }
};

