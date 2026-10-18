// Star generation worker for GalaxyMode. Pure functions of GalaxyModel (deterministic).
//   {type:'global', id, galaxy, start, count}            → packed buffers for star indices [start, start+count)
//   {type:'local', id, galaxy, center:[x,y,z] ly, radius, capacity} → local LOD stars around center
import { galaxyStar, forEachLocalStar, LOCAL_CELL, LOCAL_GRID, LOCAL_Y_EDGES, CLASS_INDEX } from '../../universe/GalaxyModel.js';
import { packStar, STRIDE_COL } from './starPack.js';

const s = {};

function genGlobal(m) {
  const { galaxy, start, count } = m;
  const pos = new Float32Array(count * 3), col = new Uint8Array(count * STRIDE_COL), lum = new Float32Array(count);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    galaxyStar(galaxy, start + i, s);
    sum += packStar(s, i, pos, col, lum);
  }
  return { msg: { type: 'global', id: m.id, start, count, pos, col, lum, sum }, transfer: [pos.buffer, col.buffer, lum.buffer] };
}

// ---- local LOD: per-cell cache
const cellCache = new Map();
let cacheGalaxy = null;
function cellStars(galaxy, cx, cy, cz) {
  const key = (cy * LOCAL_GRID + cz) * LOCAL_GRID + cx;
  let c = cellCache.get(key);
  if (c) return c;
  const idx = [], list = [];
  forEachLocalStar(galaxy, cx, cy, cz, (i, st) => { idx.push(i); list.push({ x: st.x, y: st.y, z: st.z, temperature: st.temperature, luminosity: st.luminosity, cls: st.cls, follow: 1, sub: st.sub }); });
  c = { idx, list };
  cellCache.set(key, c);
  if (cellCache.size > 60000) { // crude LRU: drop the oldest half
    let n = 0; for (const k of cellCache.keys()) { cellCache.delete(k); if (++n > 30000) break; }
  }
  return c;
}

function genLocal(m) {
  const { galaxy, center, radius, capacity } = m;
  if (cacheGalaxy !== galaxy.seed + ':' + galaxy.index) { cellCache.clear(); cacheGalaxy = galaxy.seed + ':' + galaxy.index; }
  const half = LOCAL_GRID / 2;
  const ccx = Math.floor(center[0] / LOCAL_CELL) + half, ccz = Math.floor(center[2] / LOCAL_CELL) + half;
  const n = Math.ceil(radius / LOCAL_CELL);
  // vertical cells overlapping [cy - radius, cy + radius]
  const ys = [];
  for (let k = 0; k < 8; k++) {
    const y0 = LOCAL_Y_EDGES[k], y1 = LOCAL_Y_EDGES[k + 1];
    if (y1 >= center[1] - radius && y0 <= center[1] + radius) ys.push(k);
  }
  const cells = [];
  for (let dz = -n; dz <= n; dz++) for (let dx = -n; dx <= n; dx++) {
    const cx = ccx + dx, cz = ccz + dz;
    if (cx < 0 || cz < 0 || cx >= LOCAL_GRID || cz >= LOCAL_GRID) continue;
    const px = (cx - half + 0.5) * LOCAL_CELL - center[0], pz = (cz - half + 0.5) * LOCAL_CELL - center[2];
    const d2 = px * px + pz * pz;
    if (d2 > (radius + LOCAL_CELL) * (radius + LOCAL_CELL)) continue;
    for (const cy of ys) {
      const py = (LOCAL_Y_EDGES[cy] + LOCAL_Y_EDGES[cy + 1]) / 2 - center[1];
      cells.push([d2 + py * py, cx, cy, cz]);
    }
  }
  cells.sort((a, b) => a[0] - b[0]);
  let total = 0;
  const chosen = [];
  for (const c of cells) {
    const cs = cellStars(galaxy, c[1], c[2], c[3]);
    if (total + cs.idx.length > capacity) break;
    chosen.push(cs); total += cs.idx.length;
  }
  const pos = new Float32Array(total * 3), col = new Uint8Array(total * STRIDE_COL), lum = new Float32Array(total), index = new Uint32Array(total);
  let o = 0;
  for (const cs of chosen) {
    for (let j = 0; j < cs.idx.length; j++, o++) { packStar(cs.list[j], o, pos, col, lum); index[o] = cs.idx[j]; }
  }
  return { msg: { type: 'local', id: m.id, count: total, pos, col, lum, index, center, radius }, transfer: [pos.buffer, col.buffer, lum.buffer, index.buffer] };
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    const r = m.type === 'global' ? genGlobal(m) : m.type === 'local' ? genLocal(m) : null;
    if (r) self.postMessage(r.msg, r.transfer);
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, error: String(err && err.stack || err) });
  }
};
export { CLASS_INDEX };
