// Settlement layout in the site's tangent plane (x = east, z = north, meters):
// plaza → roads (organic spokes + rings, or a rotated grid for modern styles) → lots along the
// roads (facing them, terrain-checked, non-overlapping) → props (lamps, stalls, benches) → NPC paths.
import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { offsetDir } from './planner.js';

const _d = new THREE.Vector3();

export const GRID_STYLES = new Set(['neon', 'industrial', 'outpost', 'nasapunk', 'brutalist', 'frontier']);
export const WATER_STYLES = new Set(['neon', 'harbor', 'organic']);

export class Ground {
  constructor(site, S, deck = 0) {
    this.site = site; this.S = S; this.sea = S.seaLevel > -1e8 ? S.seaLevel : -Infinity;
    this.deck = deck; this.cache = new Map();
  }
  /** raw terrain height at tangent offset */
  h(x, z) {
    const k = Math.round(x * 4) * 131071 + Math.round(z * 4);
    let v = this.cache.get(k);
    if (v === undefined) { offsetDir(this.site, x, z, _d); v = this.S.height(_d.x, _d.y, _d.z); this.cache.set(k, v); if (this.cache.size > 60000) this.cache.clear(); }
    return v;
  }
  /** walkable/buildable height: terrain, or deck over water for water styles */
  g(x, z) { const h = this.h(x, z); return this.deck > 0 ? Math.max(h, this.sea + this.deck) : h; }
  wet(x, z) { return this.h(x, z) < this.sea + 0.8; }
}

class Occ {
  constructor(R, cell = 2.5) {
    this.cell = cell; this.half = Math.ceil(R * 1.35 / cell); this.n = this.half * 2;
    this.a = new Uint8Array(this.n * this.n);
  }
  idx(x, z) { const i = Math.floor(x / this.cell) + this.half, j = Math.floor(z / this.cell) + this.half; return (i < 0 || j < 0 || i >= this.n || j >= this.n) ? -1 : j * this.n + i; }
  /** rotated rectangle test/mark */
  rect(cx, cz, w, d, rot, mark, val = 1, mask = 255) {
    const c = Math.cos(rot), s = Math.sin(rot);
    const st = this.cell * 0.7;
    for (let lx = -w / 2; lx <= w / 2 + 1e-6; lx += Math.min(st, w / 2)) {
      for (let lz = -d / 2; lz <= d / 2 + 1e-6; lz += Math.min(st, d / 2)) {
        const x = cx + lx * c + lz * s, z = cz - lx * s + lz * c;
        const i = this.idx(x, z);
        if (i < 0) { if (!mark) return false; continue; }
        if (mark) this.a[i] |= val; else if (this.a[i] & mask) return false;
      }
    }
    return true;
  }
  disc(cx, cz, r, val = 1) {
    for (let x = -r; x <= r; x += this.cell * 0.7) for (let z = -r; z <= r; z += this.cell * 0.7) {
      if (x * x + z * z > r * r) continue;
      const i = this.idx(cx + x, cz + z); if (i >= 0) this.a[i] |= val;
    }
  }
}

function polyLen(pts) { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); return l; }

/** Sample a polyline at arc length s → {x, z, tx, tz} */
function along(pts, s) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + l >= s || i === pts.length - 1) {
      const t = l > 0 ? Math.min(1, (s - acc) / l) : 0;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, tx: (b.x - a.x) / (l || 1), tz: (b.z - a.z) / (l || 1) };
    }
    acc += l;
  }
  const p = pts[pts.length - 1]; return { x: p.x, z: p.z, tx: 1, tz: 0 };
}

/**
 * Build the layout. prof: style profile from styles.js
 *   { grid, roadW, streetW, lot(t, rng, kind) → {w, d, type}, slopeTol, density, plazaR }
 */
export function layoutSite(site, S, prof, quality = 1) {
  const rng = new RNG(site.seed ^ 0x1a7);
  const R = site.radius;
  const water = WATER_STYLES.has(site.style) && prof.water !== false;
  const G = new Ground(site, S, water ? 3.5 : 0);
  const occ = new Occ(R);
  const kind = site.kind;
  const big = kind === 'city' || kind === 'metropolis';
  const roads = [], lots = [], props = [], paths = [];
  const plazaR = prof.plazaR?.(kind) ?? (kind === 'metropolis' ? 42 : kind === 'city' ? 32 : kind === 'town' ? 22 : 13);
  const heading = site.heading;
  const ok = (x, z) => water || !G.wet(x, z);

  // ------------------------------------------------ roads
  const addRoad = (pts, w, type) => {
    // split at water / steep jumps
    let cur = [];
    const flush = () => { if (cur.length >= 2 && polyLen(cur) > 12) roads.push({ pts: cur, w, type }); cur = []; };
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!ok(p.x, p.z)) { flush(); continue; }
      if (cur.length) { const q = cur[cur.length - 1]; if (Math.abs(G.g(p.x, p.z) - G.g(q.x, q.z)) > Math.hypot(p.x - q.x, p.z - q.z) * 0.45) { flush(); } }
      cur.push(p);
    }
    flush();
  };
  if (prof.grid && kind !== 'village' && kind !== 'camp' && kind !== 'ruin') {
    const sp = prof.block || (big ? 78 : 64);
    const c = Math.cos(heading), s = Math.sin(heading);
    const L = R * 1.05;
    for (let k = -Math.floor(L / sp); k <= Math.floor(L / sp); k++) {
      for (const axis of [0, 1]) {
        const pts = [];
        const off = k * sp;
        const lim = Math.sqrt(Math.max(0, L * L - off * off));
        for (let t = -lim; t <= lim; t += 8) {
          const lx = axis ? off : t, lz = axis ? t : off;
          pts.push({ x: lx * c + lz * s, z: -lx * s + lz * c });
        }
        addRoad(pts, k === 0 ? prof.roadW * 1.35 : prof.roadW, k === 0 ? 'avenue' : 'street');
      }
    }
  } else {
    const ns = kind === 'metropolis' ? 8 : kind === 'city' ? 6 : kind === 'town' ? 5 : kind === 'camp' ? 3 : kind === 'ruin' ? 3 : 4;
    for (let i = 0; i < ns; i++) {
      let a = heading + i / ns * Math.PI * 2 + rng.range(-0.25, 0.25);
      const pts = [];
      let x = Math.cos(a) * plazaR * 0.8, z = Math.sin(a) * plazaR * 0.8;
      const len = R * rng.range(0.95, 1.15);
      const curl = rng.range(-0.012, 0.012);
      for (let s = 0; s < len; s += 9) {
        pts.push({ x, z });
        // follow the contour a little: steer away from steep uphill
        const hx = G.g(x + 6, z) - G.g(x - 6, z), hz = G.g(x, z + 6) - G.g(x, z - 6);
        const dxn = Math.cos(a), dzn = Math.sin(a);
        const up = (hx * dxn + hz * dzn) / 12;
        a += curl + rng.range(-0.05, 0.05) - Math.sign(-dzn * hx + dxn * hz) * Math.min(0.08, Math.abs(up) * 0.3);
        x += Math.cos(a) * 9; z += Math.sin(a) * 9;
      }
      addRoad(pts, i % 2 === 0 ? prof.roadW : prof.streetW, 'spoke');
    }
    const rings = kind === 'metropolis' ? [0.36, 0.62, 0.88] : kind === 'city' ? [0.42, 0.78] : kind === 'town' ? [0.5] : [];
    for (const rf of rings) {
      const pts = []; const rr = R * rf;
      const ph = rng.range(0, 6.28);
      for (let a = 0; a <= Math.PI * 2 + 0.001; a += 9 / rr) {
        const w = rr * (1 + 0.06 * Math.sin(a * 3 + ph) + 0.03 * Math.sin(a * 7 + ph * 2));
        pts.push({ x: Math.cos(a) * w, z: Math.sin(a) * w });
      }
      addRoad(pts, prof.streetW, 'ring');
    }
  }
  // secondary lanes branching off spokes and rings (organic layouts): denser, more intimate towns
  if (!(prof.grid && kind !== 'village' && kind !== 'camp' && kind !== 'ruin') && prof.lanes !== false) {
    const base = roads.slice();
    for (const r of base) {
      const Lr = polyLen(r.pts);
      let side = rng.next() < 0.5 ? 1 : -1;
      for (let s = rng.range(25, 45); s < Lr - 20; s += rng.range(38, 62) * (kind === 'village' || kind === 'camp' ? 1.25 : 1)) {
        const p = along(r.pts, s);
        if (Math.hypot(p.x, p.z) < plazaR + 20) continue;
        let a = Math.atan2(p.tx * side, -p.tz * side);
        const nx = -p.tz * side, nz = p.tx * side;
        a = Math.atan2(nz, nx) + rng.range(-0.3, 0.3);
        const pts = [];
        let x = p.x + nx * r.w * 0.5, z = p.z + nz * r.w * 0.5;
        const len = rng.range(30, 85);
        for (let t = 0; t < len; t += 8) { pts.push({ x, z }); a += rng.range(-0.12, 0.12); x += Math.cos(a) * 8; z += Math.sin(a) * 8; if (Math.hypot(x, z) > R * 1.1) break; }
        if (pts.length >= 3) addRoad(pts, prof.streetW * 0.85, 'lane');
        side = -side;
      }
    }
  }
  // mark roads
  for (const r of roads) {
    const L = polyLen(r.pts);
    for (let s = 0; s <= L; s += 1.5) { const p = along(r.pts, s); occ.disc(p.x, p.z, r.w / 2 + 0.6, 2); }
  }
  // fortified enclosure (monastery kremlins, citadels): a ring wall with gates where roads cross.
  // Reserved in the occupancy grid before any lot is placed, so houses never straddle the wall.
  let wall = null;
  if (prof.wall && (kind === 'town' || kind === 'city' || kind === 'metropolis') && !water) {
    const wr = R * (prof.wall.r ?? 0.5);
    const gates = [];
    for (const r of roads) {
      for (let i = 1; i < r.pts.length; i++) {
        const a = r.pts[i - 1], b = r.pts[i];
        const da = Math.hypot(a.x, a.z) - wr, db = Math.hypot(b.x, b.z) - wr;
        if (da * db > 0) continue;
        const t = da / (da - db);
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const ang = Math.atan2(z, x);
        if (!gates.some((g) => Math.abs(Math.atan2(Math.sin(g.a - ang), Math.cos(g.a - ang))) * wr < 16)) gates.push({ a: ang, w: r.w, main: r.type === 'spoke' || r.type === 'avenue' });
      }
    }
    for (let a = 0; a < Math.PI * 2; a += 2 / wr) occ.disc(Math.cos(a) * wr, Math.sin(a) * wr, 3.2, 2);
    wall = { r: wr, gates, h: prof.wall.h ?? 7 };
  }
  // plaza
  occ.disc(0, 0, plazaR, 4);
  const plaza = { x: 0, z: 0, r: plazaR, h: G.g(0, 0) };

  // ------------------------------------------------ special lots (landmarks)
  const tryLot = (L, force = false) => {
    const { x, z, w, d, rot } = L;
    if (Math.hypot(x, z) > R * 1.15 && !force) return false;
    if (!occ.rect(x, z, w, d, rot, false, 0, 7)) return false;
    if (!occ.rect(x, z, w + (L.gap ?? 2), d + (L.gap ?? 2), rot, false, 0, 1)) return false;
    // terrain
    const c = Math.cos(rot), s = Math.sin(rot);
    let mn = Infinity, mx = -Infinity, wet = 0;
    for (const [fx, fz] of [[0, 0], [-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0.5], [0, -0.5], [0.5, 0], [-0.5, 0]]) {
      const lx = fx * w, lz = fz * d;
      const px = x + lx * c + lz * s, pz = z - lx * s + lz * c;
      const g = G.g(px, pz);
      if (!water && G.wet(px, pz)) wet++;
      if (g < mn) mn = g; if (g > mx) mx = g;
    }
    if (wet > 0) return false;
    const tol = (prof.slopeTol ?? 0.3) * Math.min(w, d) + (prof.slopeAdd ?? 1.5);
    if (mx - mn > tol && !force) return false;
    L.hMin = mn; L.hMax = mx; L.hC = G.g(x, z);
    L.water = water && G.wet(x, z);
    occ.rect(x, z, w + 1, d + 1, rot, true, 1);
    lots.push(L);
    return true;
  };
  // landmark on the plaza edge, facing the plaza
  if (prof.landmark !== false) {
    for (let k = 0; k < 10; k++) {
      const a = heading + Math.PI + k * 0.63;
      const size = big ? 34 : kind === 'town' ? 24 : 16;
      const dist = plazaR + size / 2 + 3;
      const x = Math.cos(a) * dist, z = Math.sin(a) * dist;
      if (tryLot({ x, z, w: size, d: size, rot: Math.atan2(-x, -z), t: 0, type: 'landmark', gap: 0 }, k > 6)) break;
    }
  }
  // spaceport / launch site beyond the town
  if (site.spaceport) {
    for (let k = 0; k < 16; k++) {
      const a = heading + 0.8 + k * 0.4;
      const dist = R * 0.95 + 70;
      const x = Math.cos(a) * dist, z = Math.sin(a) * dist;
      if (tryLot({ x, z, w: 110, d: 110, rot: heading, t: 1, type: 'spaceport', gap: 4 }, k > 12)) break;
    }
  }

  // ------------------------------------------------ lots along roads
  const density = (prof.density ?? 1) * quality;
  for (const r of roads) {
    const L = polyLen(r.pts);
    for (const side of [1, -1]) {
      let s = rng.range(2, 8);
      while (s < L) {
        const p = along(r.pts, s);
        const dist = Math.hypot(p.x, p.z);
        const t = Math.min(1.2, dist / R);
        const spec = prof.lot(t, rng, kind, r.type);
        if (!spec || rng.next() > density * (prof.fill?.(t) ?? 1)) { s += (spec?.w ?? 8) + 3; continue; }
        const nx = -p.tz * side, nz = p.tx * side; // left normal * side
        const off = r.w / 2 + (spec.setback ?? 2) + spec.d / 2;
        const x = p.x + nx * off, z = p.z + nz * off;
        const rot = Math.atan2(-nx, -nz); // front (+z local) faces the road
        const L2 = { x, z, w: spec.w, d: spec.d, rot, t, type: spec.type, spec, gap: spec.gap ?? 2 };
        if (tryLot(L2) && prof.backRow !== false && !prof.grid && rng.next() < (prof.backRow ?? 0.55)) {
          // second row behind (backyards, alleys) — denser, more organic towns
          const s2 = prof.lot(Math.min(1.2, t + 0.05), rng, kind, r.type);
          if (s2) {
            const off2 = off + spec.d / 2 + rng.range(3, 6) + s2.d / 2;
            const lx = p.x + nx * off2 + p.tx * rng.range(-3, 3), lz = p.z + nz * off2 + p.tz * rng.range(-3, 3);
            tryLot({ x: lx, z: lz, w: s2.w, d: s2.d, rot: rot + rng.range(-0.2, 0.2), t, type: s2.type, spec: s2, gap: s2.gap ?? 2 });
          }
        }
        s += spec.w + (spec.gap ?? 2) + rng.range(0, 3);
      }
    }
  }
  // infill (gardens, farms, scattered houses) for organic layouts
  const infill = Math.round((prof.infill ?? 0) * quality * (R / 100) * (R / 100));
  for (let i = 0; i < infill; i++) {
    const a = rng.range(0, Math.PI * 2), dd = Math.sqrt(rng.next()) * R * 1.05;
    const x = Math.cos(a) * dd, z = Math.sin(a) * dd;
    const spec = prof.lot(dd / R, rng, kind, 'infill');
    if (!spec) continue;
    tryLot({ x, z, w: spec.w, d: spec.d, rot: rng.range(0, Math.PI * 2), t: dd / R, type: spec.type, spec, gap: spec.gap ?? 3 });
  }

  // ------------------------------------------------ props: lamps, benches, stalls
  const lampSp = prof.lampSpacing ?? 26;
  for (const r of roads) {
    const L = polyLen(r.pts);
    let side = 1;
    for (let s = rng.range(4, 12); s < L; s += lampSp * rng.range(0.85, 1.15)) {
      const p = along(r.pts, s);
      const nx = -p.tz * side, nz = p.tx * side;
      const x = p.x + nx * (r.w / 2 + 0.7), z = p.z + nz * (r.w / 2 + 0.7);
      if (!ok(x, z)) continue;
      props.push({ type: 'lamp', x, z, rot: Math.atan2(-nx, -nz), h: G.g(x, z) });
      side = -side;
    }
    // NPC walking paths: short road pieces, busier toward the centre and on main roads
    const busy = r.type === 'avenue' || r.type === 'spoke' ? 0.6 : 1;
    for (let s = rng.range(0, 12); s < L - 14; s += rng.range(9, 26) * busy * (0.6 + 0.8 * Math.min(1, Math.hypot(along(r.pts, s).x, along(r.pts, s).z) / R))) {
      const a = along(r.pts, s), b = along(r.pts, s + rng.range(10, 16));
      const off = (rng.next() < 0.5 ? -1 : 1) * r.w * 0.3;
      const ax = a.x - a.tz * off, az = a.z + a.tx * off, bx = b.x - b.tz * off, bz = b.z + b.tx * off;
      paths.push({ ax, az, ah: G.g(ax, az), bx, bz, bh: G.g(bx, bz) });
    }
  }
  // plaza props
  const nst = kind === 'village' || kind === 'camp' ? 3 : kind === 'ruin' ? 0 : 6;
  for (let i = 0; i < nst; i++) {
    const a = heading + 0.4 + i / nst * Math.PI * 2, dd = plazaR * 0.72;
    const x = Math.cos(a) * dd, z = Math.sin(a) * dd;
    props.push({ type: 'stall', x, z, rot: Math.atan2(-x, -z), h: G.g(x, z) });
  }
  // plaza crowd: strollers crossing the square + idlers chatting in small groups around the stalls
  const crowd = kind === 'metropolis' ? 56 : kind === 'city' ? 44 : kind === 'town' ? 30 : kind === 'ruin' ? 0 : 14;
  for (let i = 0; i < crowd; i++) {
    const a = rng.range(0, 6.28), dd = rng.range(plazaR * 0.3, plazaR * 0.85);
    const ax = Math.cos(a) * dd, az = Math.sin(a) * dd, a2 = a + rng.range(0.6, 1.6), bx = Math.cos(a2) * dd * 0.8, bz = Math.sin(a2) * dd * 0.8;
    paths.push({ ax, az, ah: G.g(ax, az), bx, bz, bh: G.g(bx, bz) });
  }
  return { roads, lots, props, paths, plaza, ground: G, water, wall };
}

export { polyLen, along };
