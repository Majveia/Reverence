// Water worker: texture synthesis (FFT spectrum, caustics, foam, crust) and bathymetry grids, off the
// main thread. Uses the same SurfaceGen as the terrain, so shore waves line up with the rendered coast.
import { SurfaceGen } from '../planet/SurfaceGen.js';
import { waveData, foamData, crustData } from './texdata.js';

let gen = null;

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      gen = m.cfg ? new SurfaceGen(m.cfg) : null;
      self.postMessage({ type: 'init', ok: !!gen });
    } else if (m.type === 'tex') {
      const waves = waveData(m.seed, m.N);
      const foam = foamData(m.seed, m.N);
      const crust = m.crust ? crustData(m.seed, m.N) : null;
      const tl = [waves.buffer, foam.buffer];
      if (crust) tl.push(crust.buffer);
      self.postMessage({ type: 'tex', waves, foam, crust, N: m.N }, tl);
    } else if (m.type === 'bathy') {
      if (!gen) throw new Error('water worker: no surface');
      const { N, A, T1, T2, qC, L, Rs, lod, sea } = m;
      const out = new Float32Array(N * N);
      for (let j = 0; j < N; j++) {
        const oy = ((j + 0.5) / N - 0.5) * 2 * L;
        for (let i = 0; i < N; i++) {
          const ox = ((i + 0.5) / N - 0.5) * 2 * L;
          // exact inverse of the wave-frame projection Q(X) = Rs·(X·T1, X·T2)
          const a = (qC[0] + ox) / Rs, b = (qC[1] + oy) / Rs;
          const c = Math.sqrt(Math.max(0, 1 - a * a - b * b));
          const x = a * T1[0] + b * T2[0] + c * A[0];
          const y = a * T1[1] + b * T2[1] + c * A[1];
          const z = a * T1[2] + b * T2[2] + c * A[2];
          out[j * N + i] = sea - gen.heightLod(x, y, z, lod);   // water depth (m), negative on land
        }
      }
      self.postMessage({ type: 'bathy', id: m.id, data: out, N, L, qC }, [out.buffer]);
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: String(e?.message || e) });
  }
};
