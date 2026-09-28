// Terrain worker: builds chunk meshes off the main thread (and bakes the detail textures once).
// OWNED BY THE TERRAIN TRACK. Imports the exact same SurfaceGen as the main thread, so the
// rendered terrain and CPU physics/placement agree.
import { SurfaceGen } from '../planet/SurfaceGen.js';
import { buildChunk, transferList } from './chunkBuild.js';
import { bakeDetail, DETAIL_SIZE } from './detailTex.js';

let gen = null;

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      gen = new SurfaceGen(m.cfg);
      self.postMessage({ type: 'init', ok: true });
    } else if (m.type === 'bake') {
      const data = bakeDetail(m.size || DETAIL_SIZE);
      self.postMessage({ type: 'bake', data, size: m.size || DETAIL_SIZE }, [data.buffer]);
    } else if (m.type === 'build') {
      if (!gen) throw new Error('terrain worker not initialised');
      const r = buildChunk(gen, m.job);
      r.type = 'build'; r.id = m.id; r.gen = m.gen;
      self.postMessage(r, transferList(r));
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m?.id, gen: m?.gen, message: String(e?.stack || e) });
  }
};
