// Worker: bakes the host galaxy's night sky (see skyBake.js). OWNED BY THE SPACE TRACK.
import { bakeSky } from './skyBake.js';

self.onmessage = (e) => {
  try {
    const r = bakeSky(e.data);
    self.postMessage({ ok: true, r }, [r.band.buffer, r.stars.dir.buffer, r.stars.col.buffer, r.stars.flux.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.stack || err) });
  }
};
