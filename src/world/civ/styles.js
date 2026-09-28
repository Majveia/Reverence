// Architecture kits. Each style = { mats(body, rng) → materials, look → night/window params,
// profile → layout knobs + lot sizer, build(g, lot, ctx) → procedural building, lamp, road }.
// Buildings are modelled in a local frame: y = 0 at floor level, +z = front (faces the street).
import * as THREE from 'three';
import { PAT, mat, tint } from './geo.js';
import * as P from './parts.js';

const CELLS = new Set([PAT.WINDOWS, PAT.GLASS, PAT.ARCHWIN, PAT.SLITS]);
const plain = (M) => (CELLS.has(M.pat) ? { ...M, pat: PAT.PLAIN } : M);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// =============================================================================== generic builders
/** Parametric house: walls with window grid, base course, trims, roof, door, extras. */
export function house(g, ctx, o) {
  const { M, rng } = ctx;
  const w = o.w, d = o.d, fl = o.floors ?? 1, fh = o.fh ?? 3.0, H = fl * fh;
  const wall = o.wall ?? M.wall;
  g.windows(o.winSx ?? 2.2, fh, o.winY0 ?? 0);
  if (o.base !== false) g.box(0, -0.05, 0, w + 0.16, 0.65, d + 0.16, 0.05, o.baseM ?? M.found);
  if (o.upper && fl > 1) {
    // ground floor stone, upper floors plaster/timber (jettied)
    g.box(0, 0, 0, w, fh, d, 0.05, o.lower ?? M.stoneWin ?? wall);
    g.windows(o.winSx ?? 2.2, fh, fh);
    g.box(0, fh, 0, w + 0.3, H - fh, d + 0.3, 0.05, wall);
    g.box(0, fh - 0.1, 0, w + 0.45, 0.22, d + 0.45, 0.03, M.wood);
  } else g.box(0, 0, 0, w, H, d, 0.05, wall);
  if (o.timber) {
    for (const s of [-1, 1]) { g.push().translate(0, o.upper ? fh : 0, s * ((d + (o.upper ? 0.3 : 0)) / 2 + 0.03)).rotY(s > 0 ? 0 : Math.PI); P.timberFrame(g, w + (o.upper ? 0.3 : 0), o.upper ? H - fh : H, 0, M.beam ?? M.wood, o.upper ? fl - 1 : fl); g.pop(); }
  }
  if (o.quoins) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      for (let y = 0.6; y < H - 0.3; y += 0.7) g.box(sx * w / 2, y, sz * d / 2, 0.5, 0.32, 0.5, 0.03, M.trim);
    }
  }
  if (o.band) for (let f = 1; f < fl; f++) g.box(0, f * fh - 0.12, 0, w + 0.14, 0.2, d + 0.14, 0.03, M.trim);
  // roof
  const rt = o.roof ?? 'gable', rh = o.roofH ?? Math.min(w, d) * 0.45, roofM = o.roofM ?? M.roof;
  const ew = plain(o.upper ? wall : wall);
  if (rt === 'gable') {
    g.gable(0, H, 0, w + (o.upper ? 0.3 : 0), d + (o.upper ? 0.3 : 0), rh, o.eave ?? 0.45, 0.22, roofM, ew);
    g.box(0, H + rh - 0.05, 0, w + 1.0, 0.22, 0.3, 0.04, M.ridge ?? tint(roofM, 0.7));
  } else if (rt === 'hip') g.hip(0, H, 0, w + 0.1, d + 0.1, rh, o.eave ?? 0.5, roofM);
  else if (rt === 'flat') {
    g.box(0, H, 0, w + 0.3, 0.35, d + 0.3, 0.05, M.trim);
    g.box(0, H + 0.35, 0, w - 0.2, 0.08, d - 0.2, 0, M.roofFlat ?? tint(M.found, 0.8));
  } else if (rt === 'dome') {
    g.push().translate(0, H, 0); g.dome(0, 0, 0, Math.min(w, d) * 0.5, 16, 6, roofM, o.squash ?? 0.8); g.pop();
  } else if (rt === 'cone') {
    g.cyl(0, H, 0, Math.max(w, d) * 0.62, 0.05, rh, 14, true, roofM);
  } else if (rt === 'shed') {
    g.push().translate(0, H, 0).rotX(Math.atan2(rh, d)); g.box(0, 0, 0, w + 0.8, 0.2, Math.hypot(d, rh) + 0.8, 0.04, roofM); g.pop();
  }
  // door
  if (o.door !== false) P.door(g, o.doorX ?? 0, d / 2 + (o.upper ? 0 : 0), o.doorW ?? 1.1, o.doorH ?? 2.2, M, M.trim ?? M.wood, o.doorLamp ? M.lampGlow : null);
  if (o.chimney) P.chimney(g, w * 0.28, H, -d * 0.18, rh * 0.8 + 1.2, M.stone ?? M.found, M.found);
  if (o.flowers) for (let f = 0; f < Math.min(2, fl); f++) { const n = Math.max(1, Math.round(w / (o.winSx ?? 2.2))); for (let i = 0; i < n; i++) { const x = -w / 2 + (i + 0.5) * w / n; if (Math.abs(x) < 0.9 && f === 0) continue; if (rng.next() < 0.6) P.flowerBox(g, x, f * fh + 0.62 * fh * 0.4 + 0.1, d / 2 + (f > 0 && o.upper ? 0.15 : 0), 1.0, M, rng); } }
  if (o.balcony && fl > 1) P.balcony(g, 0, fh, d / 2 + (o.upper ? 0.15 : 0), Math.min(w * 0.6, 4), 1.1, M.wood, M.iron ?? M.wood);
  g.collider(0, H / 2, 0, w / 2 + 0.2, H / 2, d / 2 + 0.2);
  return H + (rt === 'flat' ? 0.4 : rh);
}

/** Parametric high-rise: podium, shaft with setbacks & ledges, crown. */
export function tower(g, ctx, o) {
  const { M, rng } = ctx;
  let w = o.w, d = o.d; const fh = o.fh ?? 3.6;
  const H = o.h;
  const segs = o.segs ?? Math.max(1, Math.min(4, Math.round(H / 45)));
  let y = 0;
  if (o.podium) {
    g.windows(o.podWin ?? 4, 4.2, 0);
    g.box(0, 0, 0, w + 6, 8.4, d + 6, 0.08, o.podM ?? M.wall2 ?? M.wall);
    g.box(0, 8.4, 0, w + 6.4, 0.5, d + 6.4, 0.05, M.trim);
    y = 8.9;
  }
  const segH = (H - y) / segs;
  for (let i = 0; i < segs; i++) {
    const wm = i === 0 ? (o.wall ?? M.wall) : (o.wallUp ?? o.wall ?? M.wall);
    g.windows(o.winSx ?? 2.4, fh, y);
    if (o.round) g.cyl(0, y, 0, w / 2, w / 2 * (o.taper ?? 1), segH, 20, false, wm);
    else g.box(0, y, 0, w, segH, d, o.bevel ?? 0.12, wm);
    y += segH;
    // ledge
    if (o.round) g.cyl(0, y, 0, w / 2 + 0.4, w / 2 + 0.4, 0.5, 20, true, M.trim);
    else g.box(0, y, 0, w + 0.6, 0.5, d + 0.6, 0.05, M.trim);
    y += 0.5;
    if (o.neon && ctx.neonM) {
      const nm = ctx.neonM[(i + (o.seedN ?? 0)) % ctx.neonM.length];
      if (o.round) g.cyl(0, y - 1.2, 0, w / 2 + 0.1, w / 2 + 0.1, 0.25, 20, false, nm);
      else { g.box(0, y - 1.3, d / 2 + 0.05, w + 0.2, 0.22, 0.1, 0, nm); g.box(w / 2 + 0.05, y - 1.3, 0, 0.1, 0.22, d + 0.2, 0, nm); g.box(-w / 2 - 0.05, y - 1.3, 0, 0.1, 0.22, d + 0.2, 0, nm); }
    }
    w *= o.shrink ?? 0.82; d *= o.shrink ?? 0.82;
  }
  g.collider(0, H / 2, 0, o.w / 2, H / 2, o.d / 2);
  // crown
  if (o.crown === 'antenna' || o.crown === undefined) {
    g.box(0, y, 0, w * 0.5, 3, d * 0.5, 0.05, M.metal);
    P.antenna(g, w * 0.15, y + 3, 0, Math.max(6, H * 0.12), M.metal);
    if (rng.next() < 0.5) P.dish(g, -w * 0.25, y + 3, d * 0.1, 1.6, M.metal, 0.6, rng.range(0, 6));
  } else if (o.crown === 'spire') {
    g.cyl(0, y, 0, Math.min(w, d) * 0.35, 0.05, H * 0.25, 12, true, M.trim);
  } else if (o.crown === 'dome') {
    g.push().translate(0, y, 0); g.dome(0, 0, 0, Math.min(w, d) * 0.5, 16, 6, M.roof, 1.2); g.pop();
  }
  return y;
}

// =============================================================================== styles
const S = {};

// ------------------------------------------------------------------------------- village (Ghibli)
S.village = {
  look: { winCol: '#ffb25e', winCol2: '#ffd9a0', litFrac: 0.62, age: 0.3, winRect: [0.3, 0.28, 0.7, 0.78], emit: 1 },
  mats(body, rng) {
    const pal = body.art?.palette || {};
    const roofs = ['#a8492f', '#b5623a', '#6a7078', '#8a3d2e', '#4d6a8a'];
    return {
      wall: mat('#ebdfc6', 0.88, 0, PAT.WINDOWS), wallAlt: mat('#f2e8d0', 0.88, 0, PAT.WINDOWS), wallPink: mat('#efd2c0', 0.88, 0, PAT.WINDOWS),
      stoneWin: mat('#b9ac98', 0.9, 0, PAT.WINDOWS),
      stone: mat('#a89b86', 0.92, 0, PAT.STONE), found: mat('#8e8474', 0.95, 0, PAT.STONE),
      roof: mat(roofs[0], 0.75, 0, PAT.TILES), roofs: roofs.map((c) => mat(c, 0.72, 0, PAT.TILES)), thatch: mat('#b89a5c', 1, 0, PAT.THATCH),
      wood: mat('#6b4a32', 0.8, 0, PAT.PLANKS), beam: mat('#4a3122', 0.8, 0, PAT.PLANKS), trim: mat('#f4efe4', 0.7),
      door: mat('#5a7a8a', 0.6, 0, PAT.PLANKS), iron: mat('#2c2c2e', 0.5, 0.7), metal: mat('#3a3a3c', 0.5, 0.7),
      leaf: mat(pal.flora?.[1] ?? '#5f9a3a', 0.9), bark: mat('#5a4030', 0.95), sail: mat('#e8e0cc', 0.95, 0, PAT.FABRIC),
      canvas: mat('#e8e0cc', 0.95, 0, PAT.FABRIC), lampGlow: mat('#ffc27a', 0.4, 0, PAT.LAMP, 6),
      road: mat('#8f8574', 0.9, 0, PAT.COBBLE), path: mat(pal.sand ?? '#a8916c', 0.95, 0, PAT.DIRT), plaza: mat('#b3a68e', 0.85, 0, PAT.PAVING),
      statue: mat('#d8d2c4', 0.7, 0, PAT.STONE), glow: mat('#ffe0a0', 0.4, 0, PAT.LAMP, 8),
    };
  },
  profile: {
    roadW: 4.2, streetW: 3.0, slopeTol: 0.4, slopeAdd: 2.2, density: 0.95, infill: 3.5, lampSpacing: 22,
    lot(t, rng, kind, road) {
      if (t > 0.95 || road === 'infill') { const r = rng.next(); if (r < 0.12) return { w: 8, d: 8, type: 'mill' }; if (r < 0.45) return { w: rng.range(12, 18), d: rng.range(9, 13), type: 'farm' }; if (r < 0.7) return { w: rng.range(8, 12), d: rng.range(8, 12), type: 'garden' }; }
      const core = t < 0.4 && kind !== 'village';
      return { w: rng.range(core ? 8 : 6.5, core ? 12 : 9.5), d: rng.range(5.5, 8), type: core ? 'big' : 'house', setback: core ? 1.2 : rng.range(2, 4) };
    },
  },
  lampKind: 'lantern',
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w, d } = lot;
    if (lot.type === 'landmark') return templeTower(g, ctx, w, d);
    if (lot.type === 'mill') { P.windmill(g, M, rng.range(10, 13), rng.range(0, 1.5)); return 14; }
    if (lot.type === 'garden') { garden(g, ctx, w, d); return 3; }
    if (lot.type === 'farm') return barn(g, ctx, w, d);
    const big = lot.type === 'big';
    const fl = big ? rng.int(2, 3) : rng.int(1, 2);
    const walls = [M.wall, M.wallAlt, M.wallPink, M.wall];
    const roofM = rng.next() < 0.15 && !big ? M.thatch : M.roofs[rng.int(0, M.roofs.length - 1)];
    const wallM = walls[rng.int(0, 3)];
    const rh = Math.min(w, d) * rng.range(0.45, 0.68);
    const hgt = house(g, ctx, { w, d, floors: fl, fh: 2.9, wall: wallM, roofM, roofH: rh,
      timber: rng.next() < 0.45, upper: fl > 1 && rng.next() < 0.6, chimney: rng.next() < 0.85, flowers: true, balcony: big && rng.next() < 0.5,
      doorLamp: true, quoins: !big && rng.next() < 0.2, eave: 0.55 });
    const H = fl * 2.9;
    // side wing (L-plan) with its own lower roof
    if (rng.next() < 0.45 && w > 7) {
      const ww = rng.range(3.5, 5), wd = rng.range(4, 6), side = rng.next() < 0.5 ? -1 : 1;
      g.push().translate(side * (w / 2 + ww / 2 - 0.2), 0, -d / 2 + wd / 2 + 0.4 - rng.range(0, 1.5));
      g.windows(2.2, 2.9, 0);
      g.box(0, -0.05, 0, ww + 0.16, 0.65, wd + 0.16, 0.05, M.found);
      g.box(0, 0, 0, ww, 2.9, wd, 0.05, wallM);
      g.push().rotY(Math.PI / 2); g.gable(0, 2.9, 0, wd, ww, ww * 0.5, 0.4, 0.2, roofM, { ...wallM, pat: PAT.PLAIN }); g.pop();
      g.collider(0, 1.5, 0, ww / 2, 1.5, wd / 2);
      g.pop();
    }
    // dormers on the front slope
    if (rng.next() < 0.4 && d > 5.5) {
      const nd = w > 8 ? 2 : 1;
      for (let i = 0; i < nd; i++) {
        const x = nd === 1 ? 0 : (i ? 1 : -1) * w * 0.22;
        g.push().translate(x, H + rh * 0.25, d * 0.18);
        g.windows(1.2, 1.3, 0.15);
        g.box(0, 0, 0, 1.4, 1.4, 1.8, 0.03, { ...wallM, pat: PAT.WINDOWS });
        g.gable(0, 1.4, 0, 1.4, 1.8, 0.6, 0.15, 0.1, roofM);
        g.pop();
      }
    }
    // front yard: picket fence or low stone wall, bushes, bench, woodpile
    if (!big && rng.next() < 0.6) {
      const yd = rng.range(2.5, 4);
      g.push().translate(0, 0, d / 2 + yd / 2 + 0.2);
      const fm = rng.next() < 0.5 ? mat('#e8e4d8', 0.8, 0, PAT.PLANKS) : M.stone;
      P.fence(g, w + 1.2, yd, fm === M.stone ? 0.7 : 1.0, fm, fm !== M.stone);
      for (let i = 0; i < 3; i++) if (rng.next() < 0.7) g.sphere(rng.range(-w / 2, w / 2), 0.2, rng.range(-yd / 3, yd / 3), rng.range(0.35, 0.6), 6, 3, rng.next() < 0.3 ? mat(['#e2506a', '#f4c14a', '#f08bd0', '#ffffff'][rng.int(0, 3)], 0.9) : M.leaf);
      g.pop();
    }
    if (rng.next() < 0.35) { g.push().translate(-w / 2 - 0.6, 0, -d / 4).rotY(Math.PI / 2); for (let i = 0; i < 2; i++) for (let j = 0; j < 3 - i; j++) { g.push().translate(-0.75 + j * 0.5 + i * 0.25, 0.2 + i * 0.36, 0).rotX(Math.PI / 2); g.cyl(0, -0.6, 0, 0.18, 0.18, 1.2, 5, true, M.wood); g.pop(); } g.pop(); }
    if (rng.next() < 0.5) { g.push().translate(0, 0, -d / 2 - 2.6); P.tree(g, rng.range(-w / 3, w / 3), 0, 0, rng.range(5, 8), M, rng); g.pop(); }
    if (rng.next() < 0.3) P.clutter(g, w / 2 + 0.8, d / 2 - 0.5, M, rng, 2);
    return hgt;
  },
  road: (r) => (r.type === 'spoke' || r.type === 'ring' ? 'road' : 'path'),
};

function templeTower(g, ctx, w, d) {
  const { M, rng } = ctx;
  // nave
  g.windows(3.2, 7, 0);
  g.box(0, -0.05, -2, w * 0.55 + 0.3, 0.7, d * 0.8 + 0.3, 0.05, M.found);
  g.box(0, 0, -2, w * 0.55, 9, d * 0.8, 0.08, { ...M.stone, pat: PAT.ARCHWIN });
  g.gable(0, 9, -2, w * 0.55, d * 0.8, 6, 0.6, 0.25, M.roofs?.[2] ?? M.roof, M.stone);
  // tower at the front
  const tw = Math.min(w, d) * 0.32, th = 22;
  g.windows(tw / 2, 5, 0);
  g.box(0, 0, d / 2 - tw / 2 - 0.5, tw, th, tw, 0.08, { ...M.stone, pat: PAT.STONE });
  for (let y = 5; y < th; y += 5) g.box(0, y, d / 2 - tw / 2 - 0.5, tw + 0.3, 0.25, tw + 0.3, 0.03, M.trim);
  // belfry openings (dark insets)
  for (const s of [-1, 1]) {
    g.box(0, th - 4.5, d / 2 - tw / 2 - 0.5 + s * (tw / 2 + 0.01), tw * 0.45, 3, 0.05, 0, mat('#1a1a1a', 0.9));
    g.box(s * (tw / 2 + 0.01), th - 4.5, d / 2 - tw / 2 - 0.5, 0.05, 3, tw * 0.45, 0, mat('#1a1a1a', 0.9));
  }
  g.cyl(0, th, d / 2 - tw / 2 - 0.5, tw * 0.74, 0.05, tw * 2.2, 4, true, M.roofs?.[2] ?? M.roof, { a0: Math.PI / 4, a1: Math.PI / 4 + Math.PI * 2 });
  g.light(0, th + tw * 2.3, d / 2 - tw / 2 - 0.5, '#ffd9a0', 4, 1.2, 0);
  // clock
  g.cyl(0, th - 8, d / 2 - 0.45, 1.1, 1.1, 0.1, 16, true, M.trim);
  g.push().translate(0, th - 8, d / 2 - 0.45).rotX(Math.PI / 2); g.cyl(0, -0.2, 0, 1.0, 1.0, 0.2, 16, true, mat('#f4ecd8', 0.5, 0, PAT.LAMP, 1.5)); g.pop();
  P.door(g, 0, d / 2 - 0.5, 1.8, 3.2, M, M.stone, M.lampGlow);
  g.collider(0, 4.5, -2, w * 0.28, 4.5, d * 0.4);
  g.collider(0, th / 2, d / 2 - tw / 2 - 0.5, tw / 2, th / 2, tw / 2);
  void rng;
  return th + tw * 2.2;
}

function garden(g, ctx, w, d) {
  const { M, rng } = ctx;
  P.fence(g, w, d, 0.9, M.wood, true);
  const rows = Math.floor(d / 1.4);
  const crop = [mat('#5f9a3a', 0.9), mat('#7aa84a', 0.9), mat('#a8b85a', 0.9), mat('#c89a4a', 0.9)][rng.int(0, 3)];
  const soil = mat('#5a4430', 1, 0, PAT.DIRT);
  for (let i = 0; i < rows; i++) {
    const z = -d / 2 + 0.9 + i * 1.4;
    g.box(0, -0.2, z, w - 1.4, 0.35, 0.7, 0.1, soil);
    for (let x = -w / 2 + 1.2; x < w / 2 - 1; x += 1.1) g.sphere(x, 0.2, z, rng.range(0.3, 0.42), 5, 3, crop);
  }
  if (rng.next() < 0.5) P.tree(g, w / 2 - 1.5, 0, -d / 2 + 1.5, rng.range(4, 6), M, rng);
}

function barn(g, ctx, w, d) {
  const { M, rng } = ctx;
  const red = mat(rng.next() < 0.5 ? '#8a2e22' : '#6a4a32', 0.85, 0, PAT.PLANKS);
  g.windows(4, 5, 0);
  g.box(0, -0.05, 0, w + 0.2, 0.5, d * 0.7 + 0.2, 0.04, M.found);
  g.box(0, 0, 0, w, 5, d * 0.7, 0.05, red);
  g.gable(0, 5, 0, w, d * 0.7, 3.5, 0.6, 0.2, M.roofs?.[2] ?? M.roof, red);
  g.box(0, 0, d * 0.35 + 0.05, 3.2, 3.6, 0.12, 0, mat('#e8e0cc', 0.8, 0, PAT.PLANKS));
  // hay bales
  for (let i = 0; i < 4; i++) g.push().translate(-w / 2 + 1 + i * 1.4, 0.55, d * 0.35 + 2.5).rotZ(Math.PI / 2).cyl(0, -0.6, 0, 0.55, 0.55, 1.2, 10, true, M.thatch).pop();
  g.collider(0, 2.5, 0, w / 2, 2.5, d * 0.35);
  void rng;
  return 8.5;
}

// ------------------------------------------------------------------------------- hearth (Outer Wilds)
S.hearth = {
  foundation: 'stilts',
  look: { winCol: '#ff9c48', winCol2: '#ffd28a', litFrac: 0.7, age: 0.25, winRect: [0.28, 0.3, 0.72, 0.8], emit: 1.1 },
  mats(body) {
    return {
      wall: mat('#7a5236', 0.85, 0, PAT.PLANKS), wallWin: mat('#7a5236', 0.85, 0, PAT.WINDOWS), wall2: mat('#94663f', 0.85, 0, PAT.PLANKS),
      stone: mat('#77736a', 0.92, 0, PAT.STONE), found: mat('#6a665e', 0.95, 0, PAT.STONE),
      roof: mat('#39596a', 0.55, 0.4, PAT.CORRUGATED), roofs: [mat('#39596a', 0.55, 0.4, PAT.CORRUGATED), mat('#9a4a2a', 0.6, 0.3, PAT.CORRUGATED), mat('#4c6a4a', 0.6, 0.3, PAT.CORRUGATED)],
      wood: mat('#5e3e28', 0.85, 0, PAT.PLANKS), beam: mat('#3e2a1c', 0.85, 0, PAT.PLANKS), trim: mat('#d9c7a2', 0.7, 0, PAT.PLANKS),
      door: mat('#c86a32', 0.7, 0, PAT.PLANKS), metal: mat('#6f7a80', 0.45, 0.8, PAT.PANELS), iron: mat('#2a2826', 0.6, 0.6),
      glass: mat('#8ab8c8', 0.08, 0.3, PAT.GLASS), orange: mat('#e8742a', 0.6, 0.2, PAT.PANELS),
      leaf: mat('#2f5a36', 0.9), bark: mat('#4a3424', 0.95), canvas: mat('#d8c8a0', 0.95, 0, PAT.FABRIC),
      lampGlow: mat('#ffab5a', 0.4, 0, PAT.LAMP, 6), road: mat('#7a6a50', 0.95, 0, PAT.DIRT), path: mat('#7a6a50', 0.95, 0, PAT.DIRT),
      plaza: mat('#8a7a60', 0.95, 0, PAT.DIRT), glow: mat('#ffb060', 0.4, 0, PAT.LAMP, 8), statue: mat('#8a8478', 0.8, 0, PAT.STONE),
      sail: mat('#d8c8a0', 0.95, 0, PAT.FABRIC),
    };
  },
  profile: {
    roadW: 3.4, streetW: 2.6, slopeTol: 0.6, slopeAdd: 3.5, density: 0.85, infill: 3, lampSpacing: 18,
    lot(t, rng, kind, road) {
      if (road === 'infill' || t > 0.9) { const r = rng.next(); if (r < 0.25) return { w: 7, d: 7, type: 'lookout' }; if (r < 0.45) return { w: 9, d: 9, type: 'garden' }; }
      return { w: rng.range(6, 9), d: rng.range(5.5, 8), type: t < 0.35 ? 'big' : 'house', setback: rng.range(1.5, 3.5) };
    },
  },
  lampKind: 'lantern',
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w, d } = lot;
    if (lot.type === 'landmark') return observatory(g, ctx, w, d);
    if (lot.type === 'spaceport') return launchTower(g, ctx);
    if (lot.type === 'garden') { garden(g, ctx, w, d); return 3; }
    if (lot.type === 'lookout') {
      // stilted lookout / water tower
      for (const [x, z] of [[-2, -2], [2, -2], [2, 2], [-2, 2]]) g.tube([V(x, -1, z), V(x * 0.7, 9, z * 0.7)], 0.18, 5, M.wood);
      g.box(0, 9, 0, 5, 0.3, 5, 0.04, M.wood);
      g.box(0, 9.3, 0, 3.4, 2.6, 3.4, 0.05, M.wall2);
      g.cyl(0, 11.9, 0, 3.0, 0.1, 1.8, 8, true, M.roofs[1]);
      g.light(1.9, 10.6, 0, '#ffab5a', 4, 1, 2);
      g.collider(0, 5.5, 0, 2.2, 5.5, 2.2);
      return 13.7;
    }
    const big = lot.type === 'big';
    const fl = big ? 2 : rng.int(1, 2);
    const stilt = lot.hMax - lot.hMin > 1.5;
    const h = house(g, ctx, { w, d, floors: fl, fh: 2.8, wall: M.wallWin, roofM: M.roofs[rng.int(0, 2)], roofH: Math.min(w, d) * rng.range(0.35, 0.5),
      winSx: 2.4, chimney: rng.next() < 0.8, eave: 0.7, base: !stilt, baseM: M.stone, doorLamp: true, balcony: fl > 1 && rng.next() < 0.6, trim: M.trim });
    // porch deck with posts
    g.box(0, -0.1, d / 2 + 1.2, w + 0.6, 0.22, 2.4, 0.03, M.wood);
    for (const s of [-1, 1]) g.cyl(s * (w / 2 + 0.1), 0, d / 2 + 2.2, 0.1, 0.1, 2.5, 6, true, M.beam);
    g.push().translate(0, 2.5, d / 2 + 1.2).rotX(0.22); g.box(0, 0, 0, w + 0.8, 0.12, 2.6, 0.02, M.roofs[0]); g.pop();
    if (rng.next() < 0.5) P.cable(g, [w / 2 + 0.1, 2.4, d / 2 + 2.2], [w / 2 + 6, 2.2, d / 2 + 5], 0.5, 0.02, M.iron, 2);
    P.clutter(g, -w / 2 - 0.8, d / 2 + 0.6, M, rng, 2);
    return h;
  },
  road: () => 'path',
};

function observatory(g, ctx, w, d) {
  const { M } = ctx;
  const r = Math.min(w, d) * 0.42;
  g.windows(3, 4, 0);
  g.cyl(0, -0.3, 0, r + 0.8, r + 0.8, 1.2, 20, true, M.stone);
  g.cyl(0, 0.9, 0, r, r, 7, 20, false, M.wallWin);
  g.cyl(0, 7.9, 0, r + 0.3, r + 0.3, 0.4, 20, true, M.trim);
  // glass dome with ribs
  g.push().translate(0, 8.3, 0);
  g.dome(0, 0, 0, r, 20, 7, mat('#9ec8d8', 0.06, 0.5, PAT.GLASS), 0.95);
  for (let i = 0; i < 10; i++) { g.push().rotY(i / 10 * Math.PI * 2); g.lathe(0, 0, 0, [[r + 0.08, 0], [r * 0.7 + 0.08, r * 0.68], [0.05, r * 0.96]], 2, M.metal, { a0: -0.03, a1: 0.03 }); g.pop(); }
  g.pop();
  // telescope
  g.push().translate(r * 0.2, 8.3 + r * 0.7, 0).rotZ(-0.7);
  g.cyl(0, 0, 0, 0.8, 1.0, r * 1.6, 12, true, mat('#e0dcd0', 0.4, 0.3, PAT.PANELS));
  g.cyl(0, r * 1.6, 0, 1.05, 1.05, 0.4, 12, true, M.orange);
  g.pop();
  P.door(g, 0, r + 0.02, 1.6, 2.6, M, M.wood, M.lampGlow);
  g.collider(0, 5, 0, r, 5, r);
  return 8.3 + r;
}

function launchTower(g, ctx) {
  const { M } = ctx;
  // concrete pad + launch tower (wooden lattice) + little rocket ship (Outer Wilds!)
  g.cyl(0, -1.5, 0, 26, 26, 1.9, 28, true, mat('#8a8478', 0.9, 0, PAT.CONCRETE));
  g.cyl(0, 0.4, 0, 9, 9, 0.2, 24, true, mat('#c8a040', 0.7, 0, PAT.PANELS));
  g.push().translate(-12, 0.4, 0); P.lattice(g, 48, 7, 5, M.wood, 10, 0.28); g.pop();
  for (let y = 8; y < 48; y += 10) g.box(-12, y + 0.4, 0, 7.5, 0.3, 7.5, 0.02, M.wood);
  g.box(-12, 48.4, 0, 9, 0.5, 9, 0.04, M.wood);
  g.cyl(-12, 48.9, 0, 6, 0.3, 3, 4, true, M.roofs[1], { a0: Math.PI / 4, a1: Math.PI / 4 + Math.PI * 2 });
  // gantry arm
  g.box(-5, 30, 0, 10, 0.8, 1.6, 0.05, M.wood);
  // the ship: capsule body, legs, cockpit, thrusters
  g.push().translate(0, 0.6, 0);
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.78; g.tube([V(Math.cos(a) * 2.2, 5, Math.sin(a) * 2.2), V(Math.cos(a) * 5, 0.2, Math.sin(a) * 5)], 0.25, 6, M.metal); g.cyl(Math.cos(a) * 5, 0, Math.sin(a) * 5, 0.9, 0.7, 0.35, 10, true, M.metal); }
  g.lathe(0, 3, 0, [[1.4, 0], [2.6, 1.2], [3.1, 4], [3.0, 8], [2.4, 11], [1.2, 13], [0.1, 13.6]], 18, mat('#cfcac0', 0.35, 0.6, PAT.PANELS));
  g.cyl(0, 11.2, 0, 2.3, 1.7, 1.2, 18, false, mat('#e8742a', 0.5, 0.2, PAT.PANELS));
  g.push().translate(0, 8.5, 2.3).rotX(-0.25); g.sphere(0, 0, 0, 1.3, 14, 8, mat('#2a4a5a', 0.05, 0.6, PAT.PLAIN), 0.5); g.pop();
  g.cyl(0, 1.6, 0, 1.3, 1.9, 1.5, 14, true, mat('#3a3a3c', 0.4, 0.8));
  g.pop();
  g.light(0, 14.8, 0, '#ff3a2a', 5, 1.2, 1);
  g.light(-12, 52, 0, '#ff3a2a', 8, 1.8, 1);
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; g.light(Math.cos(a) * 24, 0.6, Math.sin(a) * 24, '#ffb060', 4, 1.2, 0); }
  g.collider(-12, 24, 0, 4, 24, 4);
  g.collider(0, 8, 0, 3.2, 8, 3.2);
  return 52;
}

// ------------------------------------------------------------------------------- harbor (village + docks)
S.harbor = { ...S.village, look: { ...S.village.look, winCol: '#ffc070' }, profile: { ...S.village.profile, water: true },
  waterBase(g, lot, ctx, depth) {
    const { M } = ctx;
    g.box(0, -0.35, 0, lot.w + 2.4, 0.3, lot.d + 2.4, 0.03, M.wood);
    for (let x = -1; x <= 1; x += 0.5) for (const z of [-1, 1]) g.cyl(x * (lot.w / 2 + 0.9), -depth, z * (lot.d / 2 + 0.9), 0.22, 0.2, depth - 0.3, 6, false, M.beam || M.wood);
  },
};

// ------------------------------------------------------------------------------- spire (Moebius)
S.spire = {
  look: { winCol: '#ffcf9a', winCol2: '#9ff0e8', litFrac: 0.5, age: 0.08, winRect: [0.34, 0.2, 0.66, 0.8], emit: 1 },
  mats(body) {
    const pal = body.art?.palette || {};
    return {
      wall: mat('#f4efe6', 0.6, 0, PAT.ARCHWIN), wall2: mat('#efe3d4', 0.6, 0, PAT.ARCHWIN), white: mat('#f6f2ea', 0.55, 0, PAT.PLAIN),
      trim: mat(pal.accent ?? '#ff7a59', 0.5, 0.1), accent2: mat('#86c6b7', 0.5, 0.1),
      stone: mat('#e8dcc8', 0.85, 0, PAT.STONE), roof: mat('#e98f75', 0.5, 0.05), found: mat('#e6d2b2', 0.9, 0, PAT.STONE), roofs: [mat('#e98f75', 0.5), mat('#86c6b7', 0.5), mat('#f5d38c', 0.5)],
      metal: mat('#c8c4bc', 0.3, 0.8), iron: mat('#8a8680', 0.4, 0.7), wood: mat('#b89878', 0.8, 0, PAT.PLANKS), door: mat('#5a8a90', 0.5),
      glass: mat('#8ad8d0', 0.06, 0.6, PAT.GLASS), leaf: mat('#86c6b7', 0.9), bark: mat('#c9a080', 0.9), canvas: mat('#f0e0c8', 0.95, 0, PAT.FABRIC),
      lampGlow: mat('#ffe0b0', 0.3, 0, PAT.LAMP, 6), road: mat('#e8d8bc', 0.9, 0, PAT.PAVING), path: mat('#e0c8a0', 0.95, 0, PAT.DIRT), plaza: mat('#efe2c8', 0.85, 0, PAT.PAVING),
      statue: mat('#f4efe6', 0.6), glow: mat('#9ff0e8', 0.3, 0, PAT.LAMP, 8),
    };
  },
  profile: {
    roadW: 5, streetW: 3.4, slopeTol: 0.35, slopeAdd: 2.5, density: 0.8, infill: 2, lampSpacing: 30,
    lot(t, rng, kind) {
      if (t < 0.5 && rng.next() < (kind === 'village' ? 0.15 : 0.45)) return { w: rng.range(9, 13), d: rng.range(9, 13), type: 'tower', setback: 3 };
      return { w: rng.range(7, 11), d: rng.range(7, 11), type: 'dome', setback: rng.range(2, 4) };
    },
  },
  lampKind: 'modern',
  roundTypes: new Set(['dome', 'tower']),
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w, d } = lot;
    const r = Math.min(w, d) / 2;
    if (lot.type === 'landmark') return needle(g, ctx, r * 1.1, ctx.level >= 4 ? 140 : 95);
    if (lot.type === 'spaceport') return spaceportPad(g, ctx);
    if (lot.type === 'tower') {
      const h = rng.range(22, 55) * (ctx.level >= 4 ? 1.4 : 1);
      g.cyl(0, -0.4, 0, r * 0.95, r * 0.9, 1.0, 16, true, M.found);
      g.windows(2.2, 4, 0);
      g.lathe(0, 0, 0, [[r * 0.72, 0], [r * 0.6, h * 0.3], [r * 0.42, h * 0.82], [r * 0.5, h * 0.88]], 18, M.white);
      g.cyl(0, 0.5, 0, r * 0.62, r * 0.44, h * 0.8, 18, false, M.wall, {});
      // bulb top with ring balcony
      g.push().translate(0, h * 0.88, 0);
      g.lathe(0, 0, 0, [[r * 0.5, 0], [r * 1.0, r * 0.5], [r * 1.05, r * 0.9], [r * 0.7, r * 1.5], [0.1, r * 1.9]], 18, rng.next() < 0.5 ? M.white : M.roofs[rng.int(0, 2)]);
      g.cyl(0, r * 0.62, 0, r * 1.25, r * 1.25, 0.2, 18, true, M.trim);
      g.windows(1.6, r * 0.5, r * 0.62);
      g.cyl(0, r * 0.62, 0, r * 1.06, r * 1.06, r * 0.45, 18, false, M.glass);
      g.cyl(0, r * 1.9, 0, 0.08, 0.02, r * 1.4, 5, false, M.metal);
      g.pop();
      g.light(0, h * 0.88 + r * 3.3, 0, '#9ff0e8', 4, 1.2, 1);
      g.collider(0, h / 2, 0, r * 0.6, h / 2, r * 0.6);
      P.door(g, 0, r * 0.66, 1.2, 2.4, M, M.trim, M.lampGlow);
      return h + r * 1.9;
    }
    // domed adobe house (rounded, pastel, round windows)
    g.cyl(0, -0.4, 0, r + 0.3, r + 0.3, 0.8, 16, true, M.found);
    g.windows(2.4, 3.2, 0);
    const hh = rng.range(3.2, 6.4);
    g.cyl(0, 0.4, 0, r, r * 0.96, hh, 16, false, rng.next() < 0.5 ? M.wall : M.wall2);
    g.push().translate(0, 0.4 + hh, 0); g.dome(0, 0, 0, r * 0.97, 16, 6, rng.next() < 0.45 ? M.roofs[rng.int(0, 2)] : M.white, rng.range(0.55, 0.9)); g.pop();
    g.cyl(0, 0.4 + hh - 0.2, 0, r + 0.12, r + 0.12, 0.3, 16, true, M.trim);
    // chimney-vent / little turret
    if (rng.next() < 0.6) { g.cyl(r * 0.4, 0.4 + hh, 0, 0.5, 0.45, r * 0.7 + 1.5, 8, true, M.white); g.sphere(r * 0.4, 0.4 + hh + r * 0.7 + 1.6, 0, 0.6, 8, 5, M.roofs[rng.int(0, 2)]); }
    // arched door canopy
    P.door(g, 0, r * 0.98, 1.2, 2.3, M, M.trim, M.lampGlow);
    if (rng.next() < 0.5) P.tree(g, r + 1.5, 0, -r * 0.5, rng.range(4, 6), M, rng);
    g.collider(0, hh / 2, 0, r, hh / 2 + 1, r);
    return hh + r;
  },
  road: (r) => (r.type === 'spoke' ? 'road' : 'path'),
};

function needle(g, ctx, r, h) {
  const { M } = ctx;
  // Moebius needle: base flare, slender shaft, rings, bulb, tip
  g.cyl(0, -0.5, 0, r * 1.6, r * 1.5, 1.5, 24, true, M.found);
  g.lathe(0, 0, 0, [[r * 1.3, 0], [r * 0.9, h * 0.08], [r * 0.45, h * 0.3], [r * 0.32, h * 0.7], [r * 0.4, h * 0.78], [r * 0.18, h]], 22, M.white);
  for (const y of [0.35, 0.55, 0.72]) {
    g.cyl(0, h * y, 0, r * 1.1 * (1.1 - y * 0.6), r * 1.1 * (1.1 - y * 0.6), 0.6, 22, true, M.trim);
    g.cyl(0, h * y + 0.6, 0, r * 0.6 * (1.1 - y * 0.6), r * 1.08 * (1.1 - y * 0.6), 1.2, 22, false, M.white);
    g.light(r * (1.1 - y * 0.6), h * y + 0.3, 0, '#9ff0e8', 5, 1.4, 0);
  }
  g.push().translate(0, h * 0.8, 0); g.sphere(0, 0, 0, r * 0.7, 18, 10, M.glass); g.pop();
  g.cyl(0, h, 0, 0.2, 0.02, h * 0.12, 6, false, M.metal);
  g.light(0, h * 1.12, 0, '#ff6a4a', 10, 3, 1);
  g.windows(2.6, 4, 0);
  g.cyl(0, 0, 0, r * 0.95, r * 0.8, h * 0.08, 22, false, M.wall);
  g.collider(0, h / 2, 0, r * 0.6, h / 2, r * 0.6);
  P.door(g, 0, r * 0.97, 2.2, 3.6, M, M.trim, M.lampGlow);
  return h * 1.12;
}

function spaceportPad(g, ctx) {
  const { M, rng } = ctx;
  const deck = mat('#9a9890', 0.8, 0.1, PAT.PANELS);
  g.box(0, -2.5, 0, 100, 2.9, 100, 0.2, mat('#7a7870', 0.9, 0, PAT.CONCRETE));
  for (const [x, z] of [[-24, -24], [24, -24], [-24, 24], [24, 24]]) {
    g.cyl(x, 0.4, z, 13, 13, 0.4, 24, true, deck);
    g.cyl(x, 0.8, z, 10, 10, 0.05, 24, true, mat('#e8c040', 0.6, 0, PAT.PLAIN));
    g.cyl(x, 0.82, z, 9.4, 9.4, 0.05, 24, true, deck);
    for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; g.light(x + Math.cos(a) * 12.5, 1.0, z + Math.sin(a) * 12.5, i % 2 ? '#40c8ff' : '#ffb040', 5, 0.9, i % 3 === 0 ? 1 : 0); }
  }
  // control tower
  g.windows(2.4, 3.5, 0);
  g.cyl(44, 0.4, -40, 3, 2.4, 26, 12, false, M.wall2 ?? M.wall);
  g.cyl(44, 26.4, -40, 6, 7, 4, 12, false, M.glass ?? M.wall);
  g.cyl(44, 30.4, -40, 7, 3, 1.5, 12, true, M.trim);
  P.antenna(g, 44, 31.9, -40, 10, M.metal);
  P.dish(g, 36, 0.4, -44, 4, M.metal, 0.9, rng.range(0, 6));
  g.collider(44, 15, -40, 3.5, 15, 3.5);
  return 42;
}

// ------------------------------------------------------------------------------- neon (Blade Runner)
S.neon = {
  look: { winCol: '#ffd7a0', winCol2: '#7fdcff', litFrac: 0.46, age: 0.5, winRect: [0.14, 0.3, 0.86, 0.82], emit: 1.1 },
  pave: true,
  mats(body) {
    const pal = body.art?.palette || {};
    return {
      wall: mat('#3a3c44', 0.35, 0.5, PAT.GLASS), wall2: mat('#4a4a50', 0.8, 0.2, PAT.WINDOWS), wallUp: mat('#2c3038', 0.3, 0.6, PAT.GLASS),
      concrete: mat('#5a5a5e', 0.9, 0, PAT.CONCRETE), found: mat('#46464a', 0.9, 0, PAT.CONCRETE), stone: mat('#505054', 0.9, 0, PAT.CONCRETE),
      trim: mat('#2a2a2e', 0.5, 0.7, PAT.PANELS), metal: mat('#5c5e64', 0.4, 0.8, PAT.PANELS), iron: mat('#2e2e30', 0.5, 0.7), rust: mat('#5a4a40', 0.8, 0.4, PAT.RUST),
      roof: mat('#303034', 0.7, 0.4, PAT.PANELS), wood: mat('#3a3030', 0.8), door: mat('#202024', 0.5, 0.6),
      neon: [mat(pal.accent ?? '#ff2e88', 0.3, 0, PAT.NEON, 9), mat('#23ffd5', 0.3, 0, PAT.NEON, 8), mat('#5a7cff', 0.3, 0, PAT.NEON, 9), mat('#ffb02e', 0.3, 0, PAT.NEON, 8)],
      holo: [mat('#ff4aa8', 0.3, 0, PAT.HOLO, 7), mat('#3affd8', 0.3, 0, PAT.HOLO, 7), mat('#ffcf4a', 0.3, 0, PAT.HOLO, 6), mat('#6a8aff', 0.3, 0, PAT.HOLO, 7)],
      glass: mat('#223040', 0.05, 0.7, PAT.GLASS), leaf: mat('#1f6b5a', 0.9), bark: mat('#2a2a2a', 0.9),
      lampGlow: mat('#ffd9a0', 0.3, 0, PAT.LAMP, 7), road: mat('#2a2a2e', 0.85, 0, PAT.ASPHALT), path: mat('#3a3a3e', 0.85, 0, PAT.PAVING), plaza: mat('#3c3c40', 0.8, 0, PAT.PAVING),
      statue: mat('#6a6a70', 0.4, 0.6, PAT.PANELS), glow: mat('#ff2e88', 0.3, 0, PAT.NEON, 10), canvas: mat('#3a3a40', 0.9, 0, PAT.FABRIC),
    };
  },
  profile: {
    roadW: 9, streetW: 6, slopeTol: 0.35, slopeAdd: 3, density: 1, infill: 0, lampSpacing: 22, grid: true, block: 64,
    lot(t, rng, kind) {
      const big = kind === 'city' || kind === 'metropolis';
      if (t < 0.7 && big) return { w: rng.range(18, 30), d: rng.range(18, 30), type: 'tower', setback: 2, gap: 3 };
      if (t < 0.45) return { w: rng.range(14, 22), d: rng.range(14, 22), type: 'tower', setback: 2, gap: 3 };
      return { w: rng.range(10, 16), d: rng.range(10, 14), type: 'block', setback: 1.5, gap: 2 };
    },
  },
  lampKind: 'neon',
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w, d, t } = lot;
    ctx.neonM = M.neon;
    if (lot.type === 'landmark') return arcology(g, ctx, w, d);
    if (lot.type === 'spaceport') return spaceportPad(g, ctx);
    if (lot.type === 'tower') {
      const lvl = ctx.level;
      const H = (lvl >= 5 ? 1.3 : 1) * (t < 0.25 ? rng.range(110, 220) : t < 0.5 ? rng.range(60, 130) : rng.range(35, 75)) * (ctx.kind === 'town' ? 0.55 : 1);
      const y = tower(g, ctx, { w, d, h: H, fh: 3.6, podium: true, podM: M.wall2, wall: rng.next() < 0.5 ? M.wall : M.wall2, wallUp: M.wallUp, neon: true, seedN: rng.int(0, 3), shrink: rng.range(0.72, 0.88), winSx: 2.2 });
      neonDress(g, ctx, w, d, H);
      return y;
    }
    // low block: shops with signage, stacked AC units, pipes
    const H = rng.range(10, 22);
    g.windows(2.2, 3.4, 0);
    g.box(0, -0.2, 0, w + 0.4, 0.6, d + 0.4, 0.05, M.found);
    g.box(0, 0, 0, w, H, d, 0.08, rng.next() < 0.5 ? M.wall2 : M.concrete);
    g.box(0, H, 0, w + 0.3, 0.6, d + 0.3, 0.05, M.trim);
    neonDress(g, ctx, w, d, H);
    g.collider(0, H / 2, 0, w / 2, H / 2, d / 2);
    return H + 0.6;
  },
  road: () => 'road',
};

function neonDress(g, ctx, w, d, H) {
  const { M, rng } = ctx;
  // shopfront: glowing band, awnings, vertical kanji-like sign, holo billboard, AC units, pipes
  const nm = M.neon[rng.int(0, M.neon.length - 1)];
  g.box(0, 3.4, d / 2 + 0.2, w * 0.9, 0.35, 0.2, 0, nm);
  g.box(0, 0, d / 2 + 0.05, w * 0.85, 3.2, 0.1, 0, mat('#2a3440', 0.1, 0.4, PAT.GLASS));
  P.awning(g, 0, 3.2, d / 2 + 0.2, w * 0.8, M.canvas);
  g.light(0, 3.3, d / 2 + 1.2, nm.color, 3, 3, 0);
  if (rng.next() < 0.8) {
    const sx = (rng.next() < 0.5 ? -1 : 1) * (w / 2 - 1.2);
    const sh = rng.range(6, 14);
    const hm = M.holo[rng.int(0, M.holo.length - 1)];
    g.push().translate(sx, rng.range(5, Math.max(6, Math.min(H - sh, 22))), d / 2 + 1.1).rotY(Math.PI / 2);
    g.box(0, 0, 0, 1.6, sh, 0.25, 0.03, M.metal);
    g.box(0, 0.2, 0.14, 1.3, sh - 0.4, 0.06, 0, hm);
    g.box(0, 0.2, -0.14, 1.3, sh - 0.4, 0.06, 0, hm);
    g.pop();
    g.light(sx, 10, d / 2 + 1.2, hm.color, 4, 4, 0);
  }
  if (H > 30 && rng.next() < 0.7) {
    const bw = Math.min(w * 0.8, 16), bh = bw * 0.55;
    const hm = M.holo[rng.int(0, M.holo.length - 1)];
    const by = rng.range(14, Math.min(H * 0.6, 60));
    g.push().translate(0, by, d / 2 + 0.6);
    g.box(0, -0.3, -0.2, bw + 0.6, bh + 0.6, 0.3, 0.03, M.metal);
    g.box(0, 0, 0.0, bw, bh, 0.08, 0, hm);
    g.pop();
    g.light(0, by + bh / 2, d / 2 + 3, hm.color, 6, bw * 0.5, 0);
  }
  // AC units + pipes on the side
  for (let i = 0; i < 4; i++) {
    const y = rng.range(4, Math.max(5, H * 0.5));
    g.box(w / 2 + 0.4, y, rng.range(-d / 3, d / 3), 0.8, 0.7, 1.1, 0.05, M.metal);
  }
  P.pipes(g, [[-w / 2 - 0.3, 0, d / 2 - 1], [-w / 2 - 0.3, Math.min(H, 24), d / 2 - 1], [-w / 2 - 0.3, Math.min(H, 24) + 1, d / 2 - 2]], 0.18, M.rust);
  // rooftop red aviation lights
  g.light(w / 2 - 0.3, H + 0.8, d / 2 - 0.3, '#ff2a1a', 5, 1.4, 1);
  g.light(-w / 2 + 0.3, H + 0.8, -d / 2 + 0.3, '#ff2a1a', 5, 1.4, 1);
}

function arcology(g, ctx, w, d) {
  const { M } = ctx;
  // Tyrell-style stepped pyramid with lit windows and flame vents
  const B = Math.max(w, d) * 1.9, H = B * 0.95;
  const steps = 7;
  for (let i = 0; i < steps; i++) {
    const s = B * (1 - i / steps * 0.85), h = H / steps;
    g.windows(3.0, 4.0, i * h);
    g.box(0, i * h, 0, s, h, s, 0.2, i % 2 ? M.wall2 : M.wall);
    g.box(0, (i + 1) * h - 0.6, 0, s + 0.8, 0.6, s + 0.8, 0.05, M.trim);
  }
  g.box(0, H, 0, B * 0.2, 12, B * 0.2, 0.1, M.metal);
  for (const s of [-1, 1]) { g.light(s * B * 0.08, H + 14, 0, '#ffae3a', 30, 8, 2); g.cyl(s * B * 0.08, H + 12, 0, 1, 1.2, 1.5, 8, true, M.metal); }
  for (let i = 0; i < 4; i++) g.box(0, 2 + i * 6, B / 2 + 0.3, B * 0.3, 0.4, 0.2, 0, M.neon[i % 4]);
  g.collider(0, H / 2, 0, B / 2, H / 2, B / 2);
  return H + 14;
}

// ------------------------------------------------------------------------------- industrial (Stålenhag / Pacific Drive)
S.industrial = {
  pave: true,
  look: { winCol: '#ffc98a', winCol2: '#d8e8ff', litFrac: 0.45, age: 0.6, winRect: [0.25, 0.3, 0.75, 0.8], emit: 1 },
  mats() {
    return {
      wall: mat('#8a2e22', 0.85, 0, PAT.PLANKS), wallWin: mat('#8a2e22', 0.85, 0, PAT.WINDOWS), wallRed: mat('#8e3326', 0.85, 0, PAT.PLANKS),
      brick: mat('#7a4a3a', 0.9, 0, PAT.STONE), brickWin: mat('#7a4a3a', 0.9, 0, PAT.WINDOWS), concrete: mat('#8a8a86', 0.9, 0, PAT.CONCRETE),
      shed: mat('#8c9294', 0.55, 0.6, PAT.CORRUGATED), shed2: mat('#5c6a5a', 0.6, 0.5, PAT.CORRUGATED), rust: mat('#6a5042', 0.8, 0.5, PAT.RUST),
      metal: mat('#9a9c98', 0.45, 0.8, PAT.PANELS), iron: mat('#3a3a38', 0.5, 0.7), trim: mat('#e8e4dc', 0.7, 0, PAT.PLANKS),
      found: mat('#8e8c86', 0.95, 0, PAT.CONCRETE), stone: mat('#7a7874', 0.9, 0, PAT.STONE), roof: mat('#3a3c3e', 0.6, 0.4, PAT.CORRUGATED),
      roofs: [mat('#3a3c3e', 0.6, 0.4, PAT.CORRUGATED), mat('#5a3a30', 0.8, 0, PAT.TILES)], wood: mat('#5a4a3a', 0.85, 0, PAT.PLANKS), door: mat('#e8e4dc', 0.6, 0, PAT.PLANKS),
      yellow: mat('#d8a830', 0.6, 0.3, PAT.RUST), glass: mat('#506070', 0.1, 0.4, PAT.GLASS), leaf: mat('#3e5238', 0.9), bark: mat('#4a3a2e', 0.95),
      lampGlow: mat('#ffcf8a', 0.3, 0, PAT.LAMP, 6), road: mat('#4a4a4a', 0.85, 0, PAT.ASPHALT), path: mat('#7a705c', 0.95, 0, PAT.DIRT), plaza: mat('#6a6a66', 0.9, 0, PAT.CONCRETE),
      statue: mat('#8a8c88', 0.4, 0.7, PAT.PANELS), glow: mat('#ffd08a', 0.3, 0, PAT.LAMP, 8), canvas: mat('#8a8470', 0.95, 0, PAT.FABRIC), crate: mat('#4a6a8a', 0.6, 0.4, PAT.CORRUGATED),
    };
  },
  profile: {
    roadW: 6.5, streetW: 4.5, slopeTol: 0.4, slopeAdd: 3.5, density: 0.9, infill: 1.2, lampSpacing: 34, grid: true, block: 72, powerLines: true,
    lot(t, rng, kind, road) {
      const r = rng.next();
      if (t > 0.85 || road === 'infill') { if (r < 0.25) return { w: 16, d: 16, type: 'cooling' }; if (r < 0.45) return { w: 12, d: 12, type: 'silo' }; if (r < 0.55) return { w: 8, d: 8, type: 'pylon' }; if (r < 0.75) return { w: 12, d: 8, type: 'containers', setback: 2 }; return { w: rng.range(10, 16), d: rng.range(8, 12), type: 'shed', setback: 2 }; }
      if (t < 0.55 && r < 0.45) return { w: rng.range(22, 34), d: rng.range(16, 24), type: 'factory', setback: 3, gap: 4 };
      if (r < 0.62) return { w: rng.range(10, 16), d: rng.range(8, 12), type: 'shed', setback: 2 };
      if (r < 0.7) return { w: 12, d: 8, type: 'containers', setback: 2 };
      return { w: rng.range(7, 10), d: rng.range(6, 8), type: 'house', setback: rng.range(2, 5) };
    },
  },
  lampKind: 'modern',
  roundTypes: new Set(['cooling', 'landmark']),
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w, d } = lot;
    if (lot.type === 'landmark') return (ctx.kind === 'city' || ctx.kind === 'metropolis') ? loopReactor(g, ctx, w) : radarDish(g, ctx, w);
    if (lot.type === 'spaceport') return spaceportPad(g, ctx);
    if (lot.type === 'house') return house(g, ctx, { w, d, floors: rng.int(1, 2), fh: 2.8, wall: M.wallWin, roofM: M.roofs[rng.int(0, 1)], roofH: Math.min(w, d) * 0.5, chimney: true, band: true, winSx: 2.2, doorLamp: true, eave: 0.35 });
    if (lot.type === 'shed') {
      const H = rng.range(5, 8);
      g.windows(6, H, 0);
      g.box(0, -0.2, 0, w + 0.3, 0.5, d + 0.3, 0.03, M.found);
      g.box(0, 0, 0, w, H, d, 0.04, rng.next() < 0.5 ? M.shed : M.shed2);
      g.gable(0, H, 0, w, d, d * 0.22, 0.3, 0.12, M.roof);
      g.box(0, 0, d / 2 + 0.05, w * 0.45, H * 0.7, 0.1, 0, M.rust);
      g.light(w * 0.3, H * 0.75, d / 2 + 0.3, '#ffcf8a', 3, 1, 0);
      P.clutter(g, w / 2 + 1, 0, { ...M, barrel: M.rust }, rng, 3);
      g.collider(0, H / 2, 0, w / 2, H / 2, d / 2);
      return H + d * 0.22;
    }
    if (lot.type === 'containers') {
      const cols = ['#4a6a8a', '#8a3a2a', '#c8a040', '#3a6a4a', '#8a8a8a'];
      for (let i = 0; i < 5; i++) { const lv = i < 3 ? 0 : 1; g.push().translate(-w / 2 + 2 + (i % 3) * 3.6 + lv * 1.8, lv * 2.6, rng.range(-1, 1)).rotY(rng.range(-0.1, 0.1)); g.box(0, 0, 0, 2.5, 2.6, 6.1, 0.05, mat(cols[rng.int(0, 4)], 0.6, 0.5, PAT.CORRUGATED)); g.pop(); }
      g.collider(0, 2.6, 0, w / 2, 2.6, 3.2);
      return 5.2;
    }
    if (lot.type === 'factory') return factory(g, ctx, w, d);
    if (lot.type === 'cooling') {
      const r = w * 0.45, h = w * 1.3;
      g.lathe(0, 0, 0, [[r, 0], [r * 0.78, h * 0.45], [r * 0.62, h * 0.72], [r * 0.66, h]], 24, M.concrete);
      g.lathe(0, 0, 0, [[r * 0.62, h], [r * 0.58, h * 0.75], [r * 0.7, h * 0.45], [r * 0.9, 0]], 24, mat('#3a3a38', 0.95));
      g.collider(0, h / 2, 0, r * 0.7, h / 2, r * 0.7);
      g.light(r * 0.66, h + 0.5, 0, '#ff2a1a', 5, 1.4, 1);
      return h;
    }
    if (lot.type === 'silo') {
      for (let i = 0; i < 3; i++) { const x = (i - 1) * 3.6, hh = rng.range(12, 18); g.cyl(x, 0, 0, 1.7, 1.7, hh, 14, false, M.metal); g.cyl(x, hh, 0, 1.75, 0.3, 1.4, 14, true, M.shed); }
      P.lattice(g, 16, 1.2, 1.2, M.iron, 6, 0.06);
      g.collider(0, 8, 0, 5.4, 8, 1.8);
      return 18;
    }
    // pylon
    P.lattice(g, 26, 5, 1.2, M.iron, 7, 0.12);
    for (const y of [18, 23]) { g.box(0, y, 0, 9, 0.3, 0.4, 0.02, M.iron); for (const s of [-1, 1]) g.cyl(s * 4.3, y - 1.2, 0, 0.12, 0.12, 1.2, 6, true, mat('#c8d0d0', 0.2, 0, PAT.PLAIN)); }
    g.light(0, 26.4, 0, '#ff2a1a', 5, 1.4, 1);
    g.collider(0, 13, 0, 2.5, 13, 2.5);
    return 26;
  },
  road: (r) => (r.type === 'avenue' || r.type === 'street' ? 'road' : 'road'),
};

function factory(g, ctx, w, d) {
  const { M, rng } = ctx;
  const H = rng.range(9, 14);
  g.windows(3.2, H / 2, 0);
  g.box(0, -0.3, 0, w + 0.6, 0.6, d + 0.6, 0.05, M.found);
  g.box(0, 0, 0, w, H, d, 0.06, M.brickWin);
  // saw-tooth roof
  const n = Math.max(2, Math.round(w / 6));
  for (let i = 0; i < n; i++) { g.push().translate(-w / 2 + (i + 0.5) * w / n, H, 0).rotZ(0.5); g.box(0, 0, 0, w / n * 1.1, 0.25, d, 0.02, M.roof); g.pop(); g.box(-w / 2 + (i + 1) * w / n - 0.4, H, 0, 0.3, w / n * 0.5, d, 0, mat('#8ab0c0', 0.1, 0.5, PAT.GLASS)); }
  // chimneys
  const cn = rng.int(1, 3);
  for (let i = 0; i < cn; i++) {
    const x = w / 2 - 2.5 - i * 3.5, ch = H + rng.range(14, 26);
    g.cyl(x, 0, -d / 2 + 2, 1.3, 0.9, ch, 12, false, M.brick);
    for (let y = 4; y < ch; y += 5) g.cyl(x, y, -d / 2 + 2, 1.35, 1.35, 0.3, 12, false, M.iron);
    g.light(x, ch + 0.4, -d / 2 + 2, '#ff2a1a', 5, 1.2, 1);
  }
  // pipes & tanks
  P.pipes(g, [[-w / 2 - 1, 0.5, d / 3], [-w / 2 - 1, H * 0.7, d / 3], [-w / 2 + 3, H * 0.7, d / 2 + 1.5], [w / 3, H * 0.7, d / 2 + 1.5]], 0.35, M.rust);
  g.cyl(-w / 2 - 3.5, 0, -d / 4, 2.4, 2.4, 6, 14, true, M.metal);
  g.box(0, 0, d / 2 + 0.05, 5, 5, 0.12, 0, M.shed);
  g.light(0, 5.6, d / 2 + 0.6, '#ffcf8a', 5, 1.4, 0);
  g.collider(0, H / 2, 0, w / 2, H / 2, d / 2);
  return H + 20;
}

function loopReactor(g, ctx, w) {
  // Stålenhag's "Loop": a colossal sphere cradled in a concrete ring, gantries, pipes, warning lights
  const { M, rng } = ctx;
  const R = Math.max(22, w * 0.9);
  const base = mat('#8a8a86', 0.9, 0, PAT.CONCRETE);
  g.cyl(0, -2, 0, R * 1.35, R * 1.25, R * 0.35 + 2, 32, true, base);
  g.cyl(0, R * 0.35, 0, R * 1.26, R * 1.26, 1.2, 32, true, M.rust);
  g.push().translate(0, R * 0.95, 0);
  g.sphere(0, 0, 0, R, 32, 18, mat('#b8bcbc', 0.35, 0.85, PAT.PANELS));
  // equatorial ring + meridian bands
  const ring = [];
  for (let i = 0; i <= 48; i++) { const a = i / 48 * Math.PI * 2; ring.push(new THREE.Vector3(Math.cos(a) * R * 1.04, 0, Math.sin(a) * R * 1.04)); }
  g.tube(ring, 1.4, 8, M.iron);
  for (let k = 0; k < 6; k++) { const pts = []; for (let i = 0; i <= 24; i++) { const a = -Math.PI / 2 + i / 24 * Math.PI; pts.push(new THREE.Vector3(Math.cos(a) * Math.cos(k * Math.PI / 6) * R * 1.01, Math.sin(a) * R * 1.01, Math.cos(a) * Math.sin(k * Math.PI / 6) * R * 1.01)); } g.tube(pts, 0.35, 5, M.iron); }
  g.pop();
  // gantries and stair towers around
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * Math.PI * 2 + 0.4;
    g.push().translate(Math.cos(a) * R * 1.3, R * 0.35, Math.sin(a) * R * 1.3).rotY(-a);
    P.lattice(g, R * 1.2, 4, 3, M.iron, 7, 0.18);
    g.light(0, R * 1.2 + 0.5, 0, '#ff2a1a', 8, 1.8, 1);
    g.pop();
  }
  // big pipes snaking out
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2 + rng.next();
    P.pipes(g, [[Math.cos(a) * R * 0.7, R * 0.6, Math.sin(a) * R * 0.7], [Math.cos(a) * R * 1.4, R * 0.5, Math.sin(a) * R * 1.4], [Math.cos(a) * R * 1.7, 1.5, Math.sin(a) * R * 1.7], [Math.cos(a + 0.2) * R * 2.3, 1.5, Math.sin(a + 0.2) * R * 2.3]], 1.1, M.rust);
  }
  g.light(0, R * 1.97, 0, '#ffd08a', 14, 5, 0);
  g.collider(0, R, 0, R * 1.1, R, R * 1.1);
  return R * 2;
}

function radarDish(g, ctx, w) {
  const { M } = ctx;
  const r = w * 0.55;
  g.cyl(0, -0.5, 0, r * 0.5, r * 0.5, 1.2, 16, true, M.concrete);
  P.lattice(g, r * 0.9, r * 0.6, r * 0.25, M.iron, 5, 0.25);
  g.push().translate(0, r * 0.95, 0).rotX(-0.65);
  g.lathe(0, 0, 0, [[0.2, r * 0.3], [r * 0.4, r * 0.24], [r * 0.75, r * 0.12], [r, 0], [r * 0.98, 0.15], [r * 0.72, r * 0.1], [0.2, r * 0.22]].map(([a, b]) => [a, r * 0.3 - b]), 28, M.metal);
  g.tube([V(0, r * 0.3, 0), V(0, r * 0.9, 0)], 0.3, 6, M.iron);
  for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2; g.tube([V(Math.cos(a) * r * 0.9, r * 0.3, Math.sin(a) * r * 0.9), V(0, r * 0.9, 0)], 0.12, 4, M.iron); }
  g.pop();
  g.light(0, r * 1.9, 0, '#ff2a1a', 8, 2, 1);
  g.collider(0, r * 0.5, 0, r * 0.3, r * 0.5, r * 0.3);
  return r * 1.9;
}

// ------------------------------------------------------------------------------- organic (Roger Dean)
S.organic = {
  look: { winCol: '#ffe6a0', winCol2: '#7fffe0', litFrac: 0.55, age: 0.12, winRect: [0.35, 0.3, 0.65, 0.75], emit: 1.1 },
  mats(body) {
    const pal = body.art?.palette || {};
    const fl = pal.flora || ['#2e7d5b', '#5fbf8f', '#e27fb0', '#7fd2ff', '#ffd36b'];
    return {
      shell: mat('#e8dcc4', 0.55, 0.05), shell2: mat('#d8c8b0', 0.6), wall: mat('#efe4cf', 0.6, 0, PAT.ARCHWIN),
      pods: fl.map((c) => tint(mat(c, 0.45, 0.1), 0.85, 0, -0.18)), stem: mat('#8a7a68', 0.8, 0, PAT.STONE), found: mat('#9a8a78', 0.9, 0, PAT.STONE), stone: mat('#b8a890', 0.85, 0, PAT.STONE),
      trim: mat(pal.accent ?? '#6fffe9', 0.4, 0.2), metal: mat('#a8a098', 0.35, 0.7), iron: mat('#6a6258', 0.5, 0.5), wood: mat('#8a6a4a', 0.8, 0, PAT.PLANKS),
      roof: mat(fl[2] ?? '#e27fb0', 0.5), glass: mat('#7fd2ff', 0.05, 0.5, PAT.GLASS), door: mat('#4a3a2a', 0.6),
      leaf: mat(fl[1] ?? '#5fbf8f', 0.9), bark: mat('#6a5a48', 0.9), canvas: mat('#f0e8d8', 0.95, 0, PAT.FABRIC), glowPod: mat(pal.accent ?? '#6fffe9', 0.3, 0, PAT.LAMP, 5),
      lampGlow: mat('#c8fff4', 0.3, 0, PAT.LAMP, 6), road: mat('#c8b898', 0.85, 0, PAT.PAVING), path: mat('#b8a888', 0.9, 0, PAT.DIRT), plaza: mat('#d8c8a8', 0.85, 0, PAT.PAVING),
      statue: mat('#e8dcc4', 0.55), glow: mat('#6fffe9', 0.3, 0, PAT.LAMP, 8),
    };
  },
  profile: {
    roadW: 4, streetW: 3, slopeTol: 0.5, slopeAdd: 3, density: 0.8, infill: 2.5, lampSpacing: 26,
    lot(t, rng) {
      if (t < 0.45 && rng.next() < 0.35) return { w: 14, d: 14, type: 'stalk', setback: 3 };
      if (rng.next() < 0.15) return { w: 16, d: 8, type: 'arch', setback: 2 };
      return { w: rng.range(8, 12), d: rng.range(8, 12), type: 'pod', setback: 3 };
    },
  },
  lampKind: 'modern',
  roundTypes: new Set(['pod', 'stalk']),
  waterBase(g, lot, ctx, depth, above) {
    // Roger Dean: a sculpted shell disc on a single flared stem rising from the sea
    const { M, rng } = ctx;
    const r = Math.max(lot.w, lot.d) / 2 + 1.2;
    g.lathe(0, -depth, 0, [[r * 0.28, 0], [r * 0.22, depth - above - 1], [r * 0.3, depth - 2.2], [r * 0.75, depth - 1.0], [r, depth - 0.7], [r * 0.98, depth - 0.45], [r * 0.2, depth - 0.4]], 18, M.shell);
    g.cyl(0, -0.45, 0, r * 0.99, r * 0.97, 0.45, 18, true, M.shell2);
    g.cyl(0, -0.3, 0, r * 1.0, r * 1.0, 0.08, 18, false, M.glowPod);
    if (rng.next() < 0.3) g.light(r, -0.3, 0, '#6fffe9', 3, 1.2, 0);
  },
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w, d } = lot;
    const r = Math.min(w, d) / 2;
    if (lot.type === 'landmark') return greatArch(g, ctx, w);
    if (lot.type === 'spaceport') return spaceportPad(g, ctx);
    if (lot.type === 'arch') {
      const pts = [];
      for (let i = 0; i <= 16; i++) { const a = i / 16 * Math.PI; pts.push(V(-Math.cos(a) * w / 2, Math.sin(a) * w * 0.55 - 0.5, 0)); }
      g.tube(pts, (t) => 0.9 + 0.8 * Math.pow(Math.abs(t - 0.5) * 2, 2), 10, M.shell);
      g.sphere(0, w * 0.55 + 0.4, 0, 1.2, 10, 6, M.pods[rng.int(0, M.pods.length - 1)]);
      return w * 0.55;
    }
    if (lot.type === 'stalk') {
      // tall stem with stacked pod dwellings (mushroom-tower)
      const h = rng.range(22, 42) * (ctx.level >= 5 ? 1.4 : 1);
      g.lathe(0, -1, 0, [[r * 0.55, 0], [r * 0.3, h * 0.2], [r * 0.22, h * 0.7], [r * 0.35, h]], 14, M.stem);
      const n = rng.int(2, 4);
      for (let i = 0; i < n; i++) {
        const y = h * (0.45 + i / n * 0.55), pr = r * rng.range(0.5, 0.85);
        const pm = M.pods[rng.int(0, M.pods.length - 1)];
        g.push().translate(0, y, 0);
        g.lathe(0, 0, 0, [[0.2, -pr * 0.5], [pr * 0.8, -pr * 0.35], [pr * 1.05, 0], [pr * 0.9, pr * 0.35], [pr * 0.4, pr * 0.6], [0.05, pr * 0.62]], 18, pm);
        g.windows(2.2, pr * 0.5, -pr * 0.18);
        g.cyl(0, -pr * 0.18, 0, pr * 1.02, pr * 0.98, pr * 0.3, 18, false, mat('#20302e', 0.1, 0.5, PAT.GLASS));
        g.light(pr * 0.9, 0, 0, '#ffe6a0', 3, 1.5, 0);
        g.pop();
      }
      g.collider(0, h / 2, 0, r * 0.35, h / 2, r * 0.35);
      return h + r;
    }
    // pod house: tall teardrop shell grown from a flared root, tinted in the world palette, arched window band,
    // crest fin, balcony lip — Roger Dean's grown architecture
    const pm = M.pods[rng.int(0, M.pods.length - 1)];
    const shell = tint(pm, 1.25, 0, -0.2);
    const hh = rng.range(6.5, 11);
    const rr = r * 0.85;
    g.lathe(0, -0.6, 0, [[rr * 0.9, 0], [rr * 0.7, hh * 0.08], [rr * 0.95, hh * 0.3], [rr, hh * 0.5], [rr * 0.82, hh * 0.72], [rr * 0.45, hh * 0.9], [0.05, hh * 1.0]], 20, shell);
    g.push().translate(0, hh * 0.55, 0).rotY(rng.range(0, 6.28));
    const fin = [];
    for (let i = 0; i <= 10; i++) { const t = i / 10; fin.push(V(0, t * hh * 0.62, -rr * (0.9 - t * 0.9) - Math.sin(t * 3.1) * rr * 0.25)); }
    g.tube(fin, (t) => 0.55 * (1 - t) + 0.08, 8, tint(pm, 0.75));
    g.pop();
    g.windows(2.4, 2.2, hh * 0.3);
    g.cyl(0, hh * 0.3, 0, rr * 1.0, rr * 0.98, 2.0, 20, false, { ...M.wall, pat: PAT.ARCHWIN }, { a0: -2.2, a1: 0.9 });
    g.cyl(0, hh * 0.3 - 0.25, 0, rr * 1.12, rr * 1.12, 0.25, 20, true, M.shell2);
    g.cyl(0, hh * 0.24, 0, rr * 0.98, rr * 0.99, 0.2, 20, false, M.glowPod);
    P.door(g, 0, rr * 0.9, 1.2, 2.2, M, M.shell2, M.lampGlow);
    if (rng.next() < 0.5) P.tree(g, -r - 1.5, 0, 0, rng.range(5, 8), M, rng);
    g.collider(0, hh / 2, 0, rr, hh / 2, rr);
    return hh;
  },
  road: () => 'road',
};

function greatArch(g, ctx, w) {
  const { M } = ctx;
  const span = w * 2.2, h = w * 1.8;
  const pts = [];
  for (let i = 0; i <= 24; i++) { const a = i / 24 * Math.PI; pts.push(V(-Math.cos(a) * span / 2, Math.sin(a) * h + Math.sin(a * 3) * 2, Math.sin(a * 2) * 3)); }
  g.tube(pts, (t) => 2.2 + 3.5 * Math.pow(Math.abs(t - 0.5) * 2, 2.5), 14, M.shell);
  // pods clinging to the arch
  for (let i = 3; i < 22; i += 4) { const p = pts[i]; g.sphere(p.x, p.y + 2.2, p.z, 2.6, 12, 7, M.pods[i % M.pods.length]); g.light(p.x, p.y + 2.2, p.z + 2.6, '#ffe6a0', 4, 2, 0); }
  g.light(0, h + 4, 0, '#6fffe9', 14, 5, 0);
  g.collider(-span / 2, h / 4, 0, 4, h / 4, 4); g.collider(span / 2, h / 4, 0, 4, h / 4, 4);
  return h + 5;
}

// ------------------------------------------------------------------------------- monastery (Tarkovsky / Friedrich)
S.monastery = {
  look: { winCol: '#ffc680', winCol2: '#ffe8c0', litFrac: 0.5, age: 0.45, winRect: [0.34, 0.2, 0.66, 0.8], emit: 1 },
  mats() {
    return {
      wall: mat('#e6e2d8', 0.85, 0, PAT.ARCHWIN), wallS: mat('#b8b2a4', 0.9, 0, PAT.STONE), stoneWin: mat('#a8a294', 0.9, 0, PAT.ARCHWIN), stone: mat('#9e988a', 0.92, 0, PAT.STONE),
      found: mat('#7e7a70', 0.95, 0, PAT.MOSS), trim: mat('#f2efe8', 0.7), roof: mat('#3e4a48', 0.6, 0.3, PAT.TILES), roofs: [mat('#3e4a48', 0.6, 0.3, PAT.TILES), mat('#4a5a44', 0.6, 0.3, PAT.TILES)],
      dome: mat('#c8a048', 0.25, 0.9), domeG: mat('#3a6a5a', 0.4, 0.6), wood: mat('#5a4636', 0.85, 0, PAT.PLANKS), door: mat('#4a3626', 0.7, 0, PAT.PLANKS),
      metal: mat('#6a6a68', 0.4, 0.7), iron: mat('#2e2e2e', 0.5, 0.7), glass: mat('#506070', 0.1, 0.4, PAT.GLASS), leaf: mat('#3f5a45', 0.9), bark: mat('#4a3e34', 0.95),
      lampGlow: mat('#ffc680', 0.4, 0, PAT.LAMP, 6), road: mat('#8e887a', 0.9, 0, PAT.COBBLE), path: mat('#7e7864', 0.95, 0, PAT.DIRT), plaza: mat('#9a9486', 0.9, 0, PAT.PAVING),
      statue: mat('#d8d4ca', 0.7, 0, PAT.STONE), glow: mat('#ffd8a0', 0.4, 0, PAT.LAMP, 8), canvas: mat('#d8d0c0', 0.95, 0, PAT.FABRIC),
    };
  },
  profile: {
    roadW: 3.6, streetW: 2.6, slopeTol: 0.8, slopeAdd: 5, density: 0.85, infill: 2, lampSpacing: 24,
    lot(t, rng) {
      if (rng.next() < 0.12) return { w: 8, d: 8, type: 'chapel', setback: 2 };
      return { w: rng.range(7, 12), d: rng.range(6, 9), type: t < 0.4 ? 'big' : 'house', setback: rng.range(1.5, 3) };
    },
  },
  lampKind: 'lantern',
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w, d } = lot;
    if (lot.type === 'landmark') return cathedral(g, ctx, w, d);
    if (lot.type === 'spaceport') return spaceportPad(g, ctx);
    if (lot.type === 'chapel') {
      g.windows(1.6, 5, 0);
      g.box(0, -0.2, 0, 5.6, 0.6, 5.6, 0.05, M.found);
      g.box(0, 0, 0, 5, 6, 5, 0.06, M.wall);
      g.cyl(0, 6, 0, 2.2, 2.2, 3, 10, false, M.wall);
      onion(g, 0, 9, 0, 2.3, rng.next() < 0.5 ? M.dome : M.domeG, M);
      P.door(g, 0, 2.5, 1.1, 2.4, M, M.stone, M.lampGlow);
      g.collider(0, 4.5, 0, 2.6, 4.5, 2.6);
      return 15;
    }
    const big = lot.type === 'big';
    const fl = big ? rng.int(2, 3) : rng.int(1, 2);
    const extraFound = Math.max(0, lot.hMax - lot.hMin);
    return house(g, ctx, { w, d, floors: fl, fh: 3.2, wall: rng.next() < 0.6 ? M.wall : M.stoneWin, roofM: M.roofs[rng.int(0, 1)], roofH: Math.min(w, d) * rng.range(0.6, 0.85),
      winSx: 2.4, chimney: rng.next() < 0.5, eave: 0.3, band: true, doorLamp: true, baseM: M.found, quoins: extraFound < 2 && rng.next() < 0.3 });
  },
  road: (r) => (r.type === 'spoke' ? 'road' : 'path'),
};

function onion(g, x, y, z, r, M, MM) {
  g.lathe(x, y, z, [[r * 0.75, 0], [r * 1.05, r * 0.55], [r * 0.9, r * 1.05], [r * 0.45, r * 1.5], [r * 0.12, r * 1.85], [0.04, r * 2.1]], 16, M);
  g.cyl(x, y + r * 2.1, z, 0.06, 0.04, r * 0.9, 4, false, MM.metal);
  g.box(x, y + r * 2.1 + r * 0.55, z, r * 0.5, 0.08, 0.08, 0, MM.metal);
}

function cathedral(g, ctx, w, d) {
  const { M } = ctx;
  const W = w * 0.8, D = d * 0.9, H = 14;
  g.windows(3.0, H / 2, 0);
  g.box(0, -0.5, 0, W + 2, 1.0, D + 2, 0.1, M.found);
  g.box(0, 0.5, 0, W, H, D, 0.1, M.wall);
  g.hip(0, H + 0.5, 0, W, D, 3, 0.4, M.roof);
  // drum + central onion dome + 4 corner domes
  g.cyl(0, H + 2.5, 0, W * 0.2, W * 0.2, 7, 16, false, M.wall);
  onion(g, 0, H + 9.5, 0, W * 0.22, M.dome, M);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    g.cyl(sx * W * 0.32, H + 2.5, sz * D * 0.32, W * 0.09, W * 0.09, 4, 12, false, M.wall);
    onion(g, sx * W * 0.32, H + 6.5, sz * D * 0.32, W * 0.1, M.domeG, M);
  }
  // bell tower
  const bx = W / 2 + 4;
  g.box(bx, 0, D / 2 - 4, 6, 26, 6, 0.08, M.wall);
  for (const s of [-1, 1]) g.box(bx, 18, D / 2 - 4 + s * 3.01, 3, 4.5, 0.05, 0, mat('#1a1a1a', 0.9));
  g.cyl(bx, 26, D / 2 - 4, 4.2, 0.1, 10, 4, true, M.roof, { a0: Math.PI / 4, a1: Math.PI / 4 + Math.PI * 2 });
  g.light(bx, 20, D / 2 - 4, '#ffc680', 5, 2, 0);
  // enclosure wall
  P.door(g, 0, D / 2 + 0.02, 2.4, 4.2, M, M.stone, M.lampGlow);
  g.collider(0, H / 2, 0, W / 2, H / 2 + 1, D / 2);
  g.collider(bx, 13, D / 2 - 4, 3, 13, 3);
  return H + 9.5 + W * 0.22 * 2.1;
}

// ------------------------------------------------------------------------------- ruins (BotW)
S.ruins = {
  look: { winCol: '#ff9a3a', winCol2: '#3ad8ff', litFrac: 0.25, age: 1.0, winRect: [0.34, 0.2, 0.66, 0.8], emit: 1.2 },
  mats() {
    return {
      stone: mat('#a49c8c', 0.92, 0, PAT.MOSS), stone2: mat('#8e887a', 0.92, 0, PAT.MOSS), wall: mat('#b0a898', 0.9, 0, PAT.MOSS), found: mat('#7e786c', 0.95, 0, PAT.MOSS),
      ancient: mat('#3a3a40', 0.5, 0.3, PAT.GLYPH, 4), ancientDark: mat('#2c2e34', 0.45, 0.4, PAT.PANELS), trim: mat('#c8c0b0', 0.8, 0, PAT.STONE),
      glowBlue: mat('#3ad8ff', 0.3, 0, PAT.NEON, 5), glowOrange: mat('#ff8a2a', 0.3, 0, PAT.NEON, 6), roof: mat('#6a5a4a', 0.9, 0, PAT.THATCH), roofs: [mat('#b89a5c', 1, 0, PAT.THATCH)],
      wood: mat('#6b4a32', 0.85, 0, PAT.PLANKS), wallLive: mat('#d8ccb0', 0.9, 0, PAT.WINDOWS), door: mat('#5a4a3a', 0.8, 0, PAT.PLANKS), metal: mat('#5a5850', 0.5, 0.6, PAT.RUST),
      iron: mat('#3a3a38', 0.6, 0.6), leaf: mat('#5a8a3a', 0.9), bark: mat('#5a4030', 0.95), canvas: mat('#d8c8a0', 0.95, 0, PAT.FABRIC),
      lampGlow: mat('#ffb060', 0.4, 0, PAT.LAMP, 6), road: mat('#9a9280', 0.9, 0, PAT.PAVING), path: mat('#8a7a5a', 0.95, 0, PAT.DIRT), plaza: mat('#a09888', 0.9, 0, PAT.MOSS),
      statue: mat('#b8b0a0', 0.85, 0, PAT.MOSS), glow: mat('#3ad8ff', 0.3, 0, PAT.NEON, 8),
    };
  },
  profile: {
    roadW: 5, streetW: 3.2, slopeTol: 0.6, slopeAdd: 4, density: 0.6, infill: 2.2, lampSpacing: 60,
    lot(t, rng, kind) {
      const r = rng.next();
      if (kind === 'village' && r < 0.75) return { w: rng.range(6, 8), d: rng.range(5, 7), type: 'hut', setback: 2 };
      if (r < 0.1) return { w: 7, d: 7, type: 'guardian' };
      if (r < 0.2) return { w: 10, d: 10, type: 'shrine' };
      if (r < 0.45 && t < 0.6) return { w: rng.range(8, 12), d: rng.range(8, 12), type: 'tower' };
      if (r < 0.6) return { w: 14, d: 4, type: 'colonnade' };
      return { w: rng.range(9, 15), d: rng.range(7, 12), type: 'shell' };
    },
  },
  lampKind: 'torch',
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w, d } = lot;
    if (lot.type === 'landmark') return citadel(g, ctx, w, d);
    if (lot.type === 'hut') {
      return house(g, ctx, { w, d, floors: 1, fh: 2.8, wall: M.wallLive, roofM: M.roofs[0], roofH: Math.min(w, d) * 0.7, winSx: 2.6, chimney: false, eave: 0.8, doorLamp: true, timber: true, baseM: M.found });
    }
    if (lot.type === 'guardian') return guardian(g, ctx);
    if (lot.type === 'shrine') {
      g.box(0, -0.4, 0, 9, 1.0, 9, 0.2, M.stone);
      g.box(0, 0.6, 0, 7, 0.3, 7, 0.05, M.ancientDark);
      g.push().translate(0, 0.9, 0);
      g.lathe(0, 0, 0, [[3, 0], [3.2, 1.4], [2.6, 3.2], [1.2, 4.6], [0.1, 5.0]], 6, M.ancient);
      g.cyl(0, 1.2, 0, 3.22, 3.22, 0.3, 6, false, M.glowOrange);
      g.pop();
      g.light(0, 2.6, 3.3, '#ff8a2a', 8, 3, 0);
      g.light(0, 6.5, 0, '#ff8a2a', 6, 2.5, 0);
      g.collider(0, 3, 0, 3.2, 3, 3.2);
      return 6;
    }
    if (lot.type === 'colonnade') {
      const n = 5;
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + (i + 0.5) * w / n, h = rng.next() < 0.35 ? rng.range(2, 5) : 9;
        g.cyl(x, 0, 0, 0.75, 0.65, h, 10, true, M.stone);
        g.box(x, -0.2, 0, 2, 0.6, 2, 0.05, M.found);
        if (h > 8) g.box(x, h, 0, 1.9, 0.6, 1.9, 0.05, M.trim);
        g.collider(x, h / 2, 0, 0.8, h / 2, 0.8);
      }
      g.box(-w / 4, 9.6, 0, w / 2, 1.1, 1.7, 0.1, M.stone2);
      // fallen drums
      for (let i = 0; i < 3; i++) g.push().translate(rng.range(-w / 2, w / 2), 0.65, rng.range(2, 4)).rotY(rng.range(0, 3)).rotZ(Math.PI / 2).cyl(0, -1, 0, 0.7, 0.7, 2, 10, true, M.stone).pop();
      return 10.7;
    }
    if (lot.type === 'tower') {
      const r = Math.min(w, d) / 2, h = rng.range(14, 30);
      g.windows(2.6, 4.5, 0);
      g.cyl(0, -0.5, 0, r * 1.1, r * 1.05, 1.3, 14, true, M.found);
      g.cyl(0, 0.8, 0, r, r * 0.92, h, 14, false, { ...M.wall, pat: PAT.ARCHWIN });
      // broken crown: jagged merlons of varying heights
      for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2, mh = rng.range(0.3, 3.5); g.push().translate(Math.cos(a) * r * 0.86, h + 0.8, Math.sin(a) * r * 0.86).rotY(-a); g.box(0, 0, 0, 0.9, mh, r * 0.55, 0.08, M.stone); g.pop(); }
      g.collider(0, h / 2, 0, r, h / 2, r);
      if (rng.next() < 0.5) P.tree(g, r * 0.3, h + 0.8, 0, rng.range(4, 6), M, rng);
      return h + 3;
    }
    // shell: roofless broken walls with arched windows, rubble, vines
    const h = rng.range(5, 10);
    g.windows(2.8, h, 0);
    const wm = { ...M.wall, pat: PAT.ARCHWIN };
    g.box(0, 0, -d / 2 + 0.5, w, h, 1.0, 0.1, wm);
    g.box(-w / 2 + 0.5, 0, 0, 1.0, h * rng.range(0.5, 0.9), d, 0.1, wm);
    g.box(w / 2 - 0.5, 0, -d / 4, 1.0, h * rng.range(0.3, 0.7), d / 2, 0.1, wm);
    g.box(-w / 4, 0, d / 2 - 0.5, w / 2, h * rng.range(0.25, 0.6), 1.0, 0.1, M.stone);
    for (let i = 0; i < 7; i++) { g.push().translate(rng.range(-w / 2, w / 2), 0, rng.range(-d / 2, d / 2)).rotY(rng.range(0, 3)).rotZ(rng.range(-0.3, 0.3)); g.box(0, -0.2, 0, rng.range(0.6, 1.6), rng.range(0.4, 1.0), rng.range(0.5, 1.2), 0.1, M.stone2); g.pop(); }
    g.collider(0, h / 2, -d / 2 + 0.5, w / 2, h / 2, 0.5);
    if (rng.next() < 0.6) P.tree(g, rng.range(-w / 4, w / 4), 0, rng.range(-d / 4, d / 4), rng.range(5, 9), M, rng);
    return h;
  },
  road: () => 'road',
};

function guardian(g, ctx) {
  const { M, rng } = ctx;
  // BotW decayed guardian: dome head w/ eye, body shell, broken legs, moss
  g.push().translate(0, 0, 0).rotZ(rng.range(-0.25, 0.25)).rotX(rng.range(-0.2, 0.1));
  g.lathe(0, 0.6, 0, [[3.2, 0], [3.4, 0.8], [3.0, 2.0], [2.2, 2.6], [0.05, 2.8]], 16, M.ancientDark);
  g.cyl(0, 0.4, 0, 3.3, 3.3, 0.5, 16, false, M.glowOrange);
  g.push().translate(0, 3.2, 0.4);
  g.dome(0, 0, 0, 1.9, 16, 6, M.ancient, 0.9);
  g.cyl(0, -0.2, 0, 1.95, 1.95, 0.4, 16, false, M.ancientDark);
  g.push().translate(0, 0.9, 1.5).rotX(Math.PI / 2); g.cyl(0, 0, 0, 0.45, 0.45, 0.25, 12, true, M.glowBlue); g.pop();
  g.pop();
  g.light(0, 4.1, 2.1, '#3ad8ff', 7, 1.6, 0);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2 + 0.3;
    const len = rng.next() < 0.5 ? 5 : 2.5;
    g.tube([V(Math.cos(a) * 2.8, 1.2, Math.sin(a) * 2.8), V(Math.cos(a) * 4.2, 2.2, Math.sin(a) * 4.2), V(Math.cos(a) * (3 + len * 0.6), 0.1, Math.sin(a) * (3 + len * 0.6))], 0.35, 6, M.ancientDark);
  }
  g.pop();
  g.collider(0, 2.5, 0, 3.4, 2.5, 3.4);
  return 6;
}

function citadel(g, ctx, w, d) {
  const { M, rng } = ctx;
  // ruined castle keep: curtain walls, 4 towers, great keep with a glowing ancient core
  const W = w * 1.6;
  for (const [x, z, l, rot] of [[0, -W / 2, W, 0], [W / 2, 0, W, Math.PI / 2], [-W / 2, 0, W, Math.PI / 2], [-W / 3, W / 2, W / 3, 0], [W / 3, W / 2, W / 3, 0]]) {
    g.push().translate(x, 0, z).rotY(rot);
    const hh = rng.range(7, 11);
    g.box(0, -1, 0, l, hh + 1, 2.4, 0.15, M.wall);
    for (let i = -l / 2 + 1; i < l / 2; i += 2.2) if (rng.next() < 0.7) g.box(i, hh, 0, 1.1, 1.2, 2.5, 0.08, M.stone);
    g.collider(0, hh / 2, 0, l / 2, hh / 2, 1.2);
    g.pop();
  }
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const h = rng.range(16, 26);
    g.windows(2.4, 4, 0);
    g.cyl(sx * W / 2, -1, sz * W / 2, 3.4, 3.1, h, 12, false, { ...M.wall, pat: PAT.ARCHWIN });
    g.cyl(sx * W / 2, h - 1, sz * W / 2, 3.8, 3.8, 1.2, 12, true, M.stone);
    if (rng.next() < 0.6) g.cyl(sx * W / 2, h + 0.2, sz * W / 2, 4.0, 0.2, 6, 12, true, mat('#4a5a6a', 0.6, 0.3, PAT.TILES));
    g.collider(sx * W / 2, h / 2, sz * W / 2, 3.4, h / 2, 3.4);
  }
  // keep
  const kh = 34;
  g.windows(3, 5, 0);
  g.box(0, -1, -2, 14, kh, 12, 0.2, { ...M.wall, pat: PAT.ARCHWIN });
  g.box(0, kh - 1, -2, 15, 1.2, 13, 0.1, M.stone);
  g.cyl(4, kh, 0, 3, 2.6, 14, 12, false, M.wall);
  g.cyl(4, kh + 14, 0, 3.4, 0.2, 7, 12, true, mat('#3e5a78', 0.55, 0.3, PAT.TILES));
  g.cyl(-4, kh, -5, 2.2, 2.0, 8, 10, false, M.stone2);
  // ancient core glow ring around the keep (Calamity-like)
  g.cyl(0, 12, -2, 9.5, 9.5, 0.6, 24, false, M.glowOrange);
  g.light(0, 12.3, 7.6, '#ff6a2a', 10, 5, 0);
  g.light(4, kh + 21, 0, '#ff6a2a', 12, 3, 1);
  g.collider(0, kh / 2, -2, 7, kh / 2, 6);
  return kh + 21;
}

// ------------------------------------------------------------------------------- nomad (Nausicaä)
S.nomad = {
  look: { winCol: '#ffc070', winCol2: '#eaff8a', litFrac: 0.6, age: 0.35, winRect: [0.3, 0.3, 0.7, 0.75], emit: 1 },
  mats(body) {
    const pal = body.art?.palette || {};
    return {
      tent: [mat('#e8dcc0', 0.95, 0, PAT.FABRIC, 1.2), mat('#c8a878', 0.95, 0, PAT.FABRIC, 1.2), mat('#a86a4a', 0.95, 0, PAT.FABRIC, 1.2), mat('#6a8a8a', 0.95, 0, PAT.FABRIC, 1.2)],
      wood: mat('#7a5a3a', 0.85, 0, PAT.PLANKS), beam: mat('#5a4028', 0.85, 0, PAT.PLANKS), found: mat('#8a7a5a', 0.95, 0, PAT.DIRT), stone: mat('#9a8a70', 0.9, 0, PAT.STONE),
      metal: mat('#8a8070', 0.5, 0.6, PAT.RUST), iron: mat('#3a3630', 0.6, 0.5), trim: mat(pal.accent ?? '#eaff8a', 0.6), wall: mat('#d8c8a0', 0.9, 0, PAT.WINDOWS),
      roof: mat('#a86a4a', 0.95, 0, PAT.FABRIC), door: mat('#5a4028', 0.8), sail: mat('#f0e8d0', 0.95, 0, PAT.FABRIC), canvas: mat('#e8dcc0', 0.95, 0, PAT.FABRIC),
      leaf: mat('#8a9a5a', 0.9), bark: mat('#5a4a3a', 0.95), lampGlow: mat('#ffc070', 0.4, 0, PAT.LAMP, 6), road: mat('#a89a78', 0.95, 0, PAT.DIRT), path: mat('#a89a78', 0.95, 0, PAT.DIRT),
      plaza: mat('#9a8c6c', 0.95, 0, PAT.DIRT), statue: mat('#c8b890', 0.8, 0, PAT.STONE), glow: mat('#ffc070', 0.4, 0, PAT.LAMP, 8),
      pennants: ['#c83a2a', '#e8c040', '#3a6aa8', '#e8e0d0'].map((c) => mat(c, 0.95, 0, PAT.FABRIC)),
    };
  },
  profile: {
    roadW: 3.4, streetW: 2.6, slopeTol: 0.5, slopeAdd: 2.5, density: 0.85, infill: 4, lampSpacing: 20,
    lot(t, rng, kind, road) {
      const r = rng.next();
      if (r < 0.12) return { w: 6, d: 6, type: 'windtower' };
      if (r < 0.26) return { w: 10, d: 4, type: 'wagon', setback: 1.5 };
      if (r < 0.34 && road === 'infill') return { w: 6, d: 6, type: 'pole' };
      return { w: rng.range(6, 10), d: rng.range(6, 10), type: rng.next() < 0.4 ? 'yurt' : 'tent', setback: rng.range(1.5, 3.5) };
    },
  },
  lampKind: 'torch',
  foundation: 'deck',
  roundTypes: new Set(['yurt', 'windtower']),
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w, d } = lot;
    const r = Math.min(w, d) / 2;
    const tm = M.tent[rng.int(0, M.tent.length - 1)];
    if (lot.type === 'landmark') return valleyMill(g, ctx, 30);
    if (lot.type === 'spaceport') return spaceportPad(g, ctx);
    if (lot.type === 'windtower') return valleyMill(g, ctx, rng.range(12, 18));
    if (lot.type === 'pole') { pennantPole(g, ctx, rng.range(7, 11)); return 11; }
    if (lot.type === 'wagon') {
      g.box(0, 0.9, 0, 7, 0.3, 2.6, 0.04, M.wood);
      for (const [x, z] of [[-2.5, -1.4], [2.5, -1.4], [-2.5, 1.4], [2.5, 1.4]]) { g.push().translate(x, 0.8, z).rotX(Math.PI / 2); g.cyl(0, -0.12, 0, 0.8, 0.8, 0.24, 12, true, M.beam); g.pop(); }
      g.push().translate(0, 1.2, 0); g.lathe(0, 0, 0, [[1.4, 0], [1.4, 1.2], [1.0, 2.0], [0.05, 2.3]].map(([a, b]) => [a, b]), 10, tm, { a0: 0, a1: Math.PI }); g.pop();
      g.push().translate(0, 1.2, 0).rotX(Math.PI / 2).rotZ(Math.PI / 2); g.pop();
      g.box(0, 1.2, 0, 6, 1.4, 2.4, 0.04, tm);
      g.push().translate(0, 2.6, 0).rotZ(Math.PI / 2); g.cyl(0, -3, 0, 1.25, 1.25, 6, 12, false, tm, { a0: -Math.PI / 2, a1: Math.PI / 2 }); g.pop();
      g.light(3.6, 2.2, 0, '#ffc070', 3, 0.9, 2);
      g.collider(0, 1.8, 0, 3.5, 1.8, 1.3);
      return 4;
    }
    if (lot.type === 'yurt') {
      g.cyl(0, 0, 0, r, r, 2.4, 16, false, tm);
      g.cyl(0, 2.4, 0, r + 0.3, 0.6, r * 0.55, 16, true, M.tent[(rng.int(0, 3))]);
      g.cyl(0, 2.4 + r * 0.55, 0, 0.6, 0.5, 0.5, 8, true, M.wood);
      for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; g.box(Math.cos(a) * (r + 0.02), 0, Math.sin(a) * (r + 0.02), 0.12, 2.4, 0.12, 0, M.beam); }
      P.door(g, 0, r, 1.0, 1.8, M, M.trim, null);
      g.light(0, 1.2, r + 0.4, '#ffc070', 3, 1.0, 2);
      g.collider(0, 1.5, 0, r, 1.5, r);
      return 2.4 + r * 0.55;
    }
    // ridge tent with poles, guy ropes, flap
    const h = rng.range(2.8, 3.8);
    g.push().rotY(rng.next() < 0.5 ? 0 : Math.PI / 2);
    for (const s of [-1, 1]) {
      g.quad(V(-w / 2, 0, s * d / 2), V(w / 2, 0, s * d / 2), V(w / 2, h, 0), V(-w / 2, h, 0), null, tm);
      g.quad(V(w / 2, 0, s * d / 2), V(-w / 2, 0, s * d / 2), V(-w / 2, h, 0), V(w / 2, h, 0), null, tm);
    }
    for (const e of [-1, 1]) g.triFlat(V(e * w / 2, 0, -d / 2), V(e * w / 2, 0, d / 2), V(e * w / 2, h, 0), null, M.tent[(rng.int(0, 3))]);
    for (const e of [-1, 1]) { g.cyl(e * (w / 2 + 0.1), 0, 0, 0.07, 0.06, h + 0.6, 5, true, M.beam); g.tube([V(e * (w / 2 + 0.1), h + 0.4, 0), V(e * (w / 2 + 2.2), 0, 0)], 0.02, 3, M.iron); }
    g.box(0, h - 0.05, 0, w + 0.4, 0.1, 0.1, 0, M.beam);
    g.pop();
    g.light(0, 1.0, d / 2 + 0.8, '#ffc070', 2.5, 0.9, 2);
    g.collider(0, h / 2, 0, w / 2, h / 2, d / 2);
    return h + 0.6;
  },
  road: () => 'path',
};

function pennantPole(g, ctx, h) {
  const { M, rng } = ctx;
  g.cyl(0, 0, 0, 0.12, 0.08, h, 6, true, M.beam);
  for (let i = 0; i < 3; i++) {
    const y = h - 0.4 - i * 1.4;
    g.push().translate(0, y, 0).rotY(rng.range(0, 6.28));
    g.triFlat(V(0, 0, 0), V(0, -0.8, 0), V(0, -0.4, 2.4), null, M.pennants[rng.int(0, 3)]);
    g.triFlat(V(0, 0, 0), V(0, -0.4, 2.4), V(0, -0.8, 0), null, M.pennants[rng.int(0, 3)]);
    g.pop();
  }
}

function valleyMill(g, ctx, h) {
  const { M, rng } = ctx;
  // Valley-of-the-Wind windmill: tapered timber tower, big propeller, lookout
  g.cyl(0, -0.4, 0, 2.6, 2.6, 1.0, 10, true, M.stone);
  g.lathe(0, 0.6, 0, [[2.2, 0], [1.4, h * 0.6], [1.0, h]], 8, M.wood);
  g.box(0, h + 0.6, 0, 3.2, 0.3, 3.2, 0.03, M.beam);
  g.box(0, h + 0.9, 0, 2.2, 2, 2.2, 0.03, M.tent[0]);
  g.cyl(0, h + 2.9, 0, 1.8, 0.1, 1.4, 8, true, M.roof);
  g.push().translate(0, h + 1.8, 1.3).rotZ(rng.range(0, 6.28));
  g.cyl(0, 0, 0, 0.3, 0.3, 0.5, 8, true, M.iron, {});
  for (let i = 0; i < 3; i++) { g.push().rotZ(i * Math.PI * 2 / 3); g.box(0, 0.3, 0.2, 0.5, h * 0.45, 0.08, 0.02, M.sail); g.pop(); }
  g.pop();
  pennantPole(g, ctx, 3);
  g.light(0, h + 1.8, 1.2, '#ffc070', 4, 1.2, 2);
  g.collider(0, h / 2, 0, 1.8, h / 2, 1.8);
  return h + 4.3;
}

// ------------------------------------------------------------------------------- frontier (Cowboy Bebop Mars)
S.frontier = {
  pave: true,
  look: { winCol: '#ffb870', winCol2: '#ff5a8a', litFrac: 0.5, age: 0.6, winRect: [0.28, 0.3, 0.72, 0.8], emit: 1.1 },
  mats(body) {
    return {
      wall: mat('#c89a70', 0.9, 0, PAT.WINDOWS), wall2: mat('#b88a64', 0.9, 0, PAT.WINDOWS), adobe: mat('#c89a70', 0.95, 0, PAT.PLAIN),
      found: mat('#8a6a50', 0.95, 0, PAT.CONCRETE), stone: mat('#9a7a5a', 0.9, 0, PAT.STONE), trim: mat('#e8d8c0', 0.7), metal: mat('#9a9690', 0.45, 0.7, PAT.PANELS),
      rust: mat('#7a5040', 0.8, 0.4, PAT.RUST), iron: mat('#3a3430', 0.6, 0.6), roof: mat('#6a6058', 0.6, 0.4, PAT.CORRUGATED), roofs: [mat('#6a6058', 0.6, 0.4, PAT.CORRUGATED)],
      wood: mat('#6a4a32', 0.85, 0, PAT.PLANKS), door: mat('#4a3a2a', 0.8, 0, PAT.PLANKS), glass: mat('#405060', 0.1, 0.5, PAT.GLASS),
      neon: [mat('#ff4a8a', 0.3, 0, PAT.NEON, 8), mat('#4affd0', 0.3, 0, PAT.NEON, 7), mat('#ffb040', 0.3, 0, PAT.NEON, 8)],
      holo: [mat('#ff4a8a', 0.3, 0, PAT.HOLO, 6), mat('#ffcf4a', 0.3, 0, PAT.HOLO, 6)], canvas: mat('#b8a080', 0.95, 0, PAT.FABRIC),
      leaf: mat('#6a7a4a', 0.9), bark: mat('#5a4a3a', 0.95), lampGlow: mat('#ffb870', 0.4, 0, PAT.LAMP, 6), road: mat('#6a5a4a', 0.9, 0, PAT.ASPHALT), path: mat('#a0785a', 0.95, 0, PAT.DIRT),
      plaza: mat('#8a6a50', 0.9, 0, PAT.CONCRETE), statue: mat('#9a9690', 0.4, 0.7, PAT.PANELS), glow: mat('#ffb870', 0.4, 0, PAT.LAMP, 8), crate: mat('#8a4a2a', 0.6, 0.4, PAT.CORRUGATED), concrete: mat('#9a8a78', 0.9, 0, PAT.CONCRETE),
    };
  },
  profile: {
    roadW: 7, streetW: 5, slopeTol: 0.35, slopeAdd: 2.5, density: 0.85, infill: 1, lampSpacing: 30, grid: true, block: 60,
    lot(t, rng) {
      const r = rng.next();
      if (r < 0.1) return { w: 12, d: 8, type: 'containers', setback: 2 };
      if (r < 0.18) return { w: 8, d: 8, type: 'watertower' };
      if (r < 0.26) return { w: 22, d: 22, type: 'pad', setback: 3 };
      return { w: rng.range(9, 15), d: rng.range(8, 12), type: 'saloon', setback: 2 };
    },
  },
  lampKind: 'neon',
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w, d } = lot;
    ctx.neonM = M.neon;
    if (lot.type === 'landmark') return S.industrial.build(g, { ...lot, type: 'landmark' }, ctx);
    if (lot.type === 'spaceport') return spaceportPad(g, ctx);
    if (lot.type === 'containers') return S.industrial.build(g, lot, { ...ctx, M: { ...M } });
    if (lot.type === 'watertower') {
      for (const [x, z] of [[-1.8, -1.8], [1.8, -1.8], [1.8, 1.8], [-1.8, 1.8]]) g.tube([V(x, -0.5, z), V(x * 0.8, 9, z * 0.8)], 0.15, 5, M.iron);
      g.cyl(0, 9, 0, 2.6, 2.6, 4, 14, false, M.rust);
      g.cyl(0, 13, 0, 2.8, 0.2, 1.4, 14, true, M.roof);
      g.collider(0, 7, 0, 2.6, 7, 2.6);
      return 14.4;
    }
    if (lot.type === 'pad') {
      g.cyl(0, -1, 0, 10, 10, 1.3, 20, true, M.concrete);
      g.cyl(0, 0.3, 0, 7.5, 7.5, 0.05, 20, true, mat('#e8c040', 0.6));
      g.cyl(0, 0.32, 0, 7, 7, 0.05, 20, true, M.concrete);
      for (let i = 0; i < 8; i++) { const a = i / 8 * 6.28; g.light(Math.cos(a) * 9.5, 0.5, Math.sin(a) * 9.5, '#ffb040', 4, 0.9, i % 2); }
      smallShip(g, ctx);
      return 6;
    }
    // saloon / bar / garage: flat roof, false front, neon sign, awning, AC, antenna
    const H = rng.range(4.5, 8);
    g.windows(2.4, H, 0);
    g.box(0, -0.2, 0, w + 0.3, 0.5, d + 0.3, 0.04, M.found);
    g.box(0, 0, 0, w, H, d, 0.1, rng.next() < 0.5 ? M.wall : M.wall2);
    g.box(0, H, d / 2 - 0.3, w + 0.2, 2.0, 0.4, 0.05, M.adobe);
    g.box(0, H, 0, w + 0.2, 0.4, d + 0.2, 0.04, M.trim);
    P.awning(g, 0, 3, d / 2, w * 0.8, M.canvas);
    const nm = M.neon[rng.int(0, 2)];
    g.box(0, H + 0.5, d / 2 - 0.05, w * 0.6, 1.0, 0.1, 0, nm);
    g.light(0, H + 1, d / 2 + 1, nm.color, 4, 3, 0);
    P.door(g, 0, d / 2, 1.4, 2.4, M, M.wood, M.lampGlow);
    if (rng.next() < 0.6) P.antenna(g, w / 3, H + 0.4, -d / 4, rng.range(4, 9), M.metal);
    if (rng.next() < 0.4) P.dish(g, -w / 3, H + 0.4, -d / 4, 1.3, M.metal, 0.7, rng.range(0, 6));
    g.box(w / 2 + 0.5, 1.0, 0, 1.0, 1.0, 1.4, 0.05, M.metal);
    g.collider(0, H / 2, 0, w / 2, H / 2, d / 2);
    return H + 2;
  },
  road: (r) => (r.type === 'avenue' ? 'road' : 'path'),
};

function smallShip(g, ctx) {
  const { M } = ctx;
  // swordfish-like small ship on the pad
  g.push().translate(0, 1.8, 0);
  g.lathe(0, 0, -5, [[0.05, 0], [1.1, 1.5], [1.4, 5], [1.2, 8], [0.4, 10]].map(([a, b]) => [a, b]), 12, mat('#c83a2a', 0.4, 0.5, PAT.PANELS), {});
  g.pop();
  g.push().translate(0, 2.6, 0).rotX(Math.PI / 2);
  g.lathe(0, -5, 0, [[0.05, 0], [1.1, 1.5], [1.4, 5], [1.2, 8], [0.4, 10]], 12, mat('#c83a2a', 0.4, 0.5, PAT.PANELS));
  g.pop();
  g.box(0, 2.3, 0.5, 9, 0.2, 2.5, 0.05, mat('#d8d4cc', 0.4, 0.6, PAT.PANELS));
  g.push().translate(0, 3.4, 2.5); g.sphere(0, 0, 0, 0.9, 10, 6, mat('#203040', 0.05, 0.7), 0.3); g.pop();
  for (const s of [-1, 1]) g.cyl(s * 1.4, 0.3, -1, 0.1, 0.1, 2.2, 5, true, M.iron);
  g.cyl(0, 0.3, 3, 0.1, 0.1, 2.2, 5, true, M.iron);
}

// ------------------------------------------------------------------------------- outpost / nasapunk (NMS / Starfield)
S.outpost = {
  pave: true,
  look: { winCol: '#e8f4ff', winCol2: '#ffb040', litFrac: 0.7, age: 0.15, winRect: [0.2, 0.35, 0.8, 0.75], emit: 1.1 },
  mats(body) {
    const pal = body.art?.palette || {};
    const acc = body.art?.key === 'starfield' ? '#e8e8e8' : (pal.accent ?? '#ff5a8a');
    return {
      wall: mat('#dcdcd6', 0.45, 0.2, PAT.PANELS), wallWin: mat('#dcdcd6', 0.45, 0.2, PAT.WINDOWS), wall2: mat('#b8bcc0', 0.45, 0.3, PAT.PANELS),
      stripe: mat(body.art?.key === 'starfield' ? '#2a5aa8' : '#e8a020', 0.5, 0.2, PAT.PANELS), accent: mat(acc, 0.5, 0.2, PAT.PANELS),
      metal: mat('#8a8e94', 0.4, 0.8, PAT.PANELS), iron: mat('#3a3c40', 0.5, 0.7), found: mat('#6a6c70', 0.8, 0.2, PAT.CONCRETE), stone: mat('#7a7a78', 0.9, 0, PAT.CONCRETE),
      trim: mat('#4a4c52', 0.4, 0.6, PAT.PANELS), roof: mat('#9a9ea4', 0.45, 0.6, PAT.PANELS), glass: mat('#304858', 0.05, 0.6, PAT.GLASS), door: mat('#3a3c40', 0.4, 0.6),
      concrete: mat('#8a8a86', 0.9, 0, PAT.CONCRETE), rust: mat('#7a6050', 0.7, 0.5, PAT.RUST), leaf: mat('#6a8a5a', 0.9), bark: mat('#4a4a44', 0.9), canvas: mat('#c8c4b8', 0.9, 0, PAT.FABRIC),
      neon: [mat('#40c8ff', 0.3, 0, PAT.NEON, 6), mat('#ffb040', 0.3, 0, PAT.NEON, 6)], holo: [mat('#40c8ff', 0.3, 0, PAT.HOLO, 5)],
      lampGlow: mat('#e8f4ff', 0.3, 0, PAT.LAMP, 6), road: mat('#5a5c60', 0.8, 0, PAT.PANELS), path: mat('#7a7a76', 0.9, 0, PAT.PAVING), plaza: mat('#6a6c70', 0.7, 0.2, PAT.PANELS),
      statue: mat('#c8ccd0', 0.4, 0.7, PAT.PANELS), glow: mat('#40c8ff', 0.3, 0, PAT.NEON, 8),
    };
  },
  profile: {
    roadW: 6, streetW: 4, slopeTol: 0.35, slopeAdd: 2.5, density: 0.8, infill: 1, lampSpacing: 26, grid: true, block: 70,
    lot(t, rng) {
      const r = rng.next();
      if (r < 0.15) return { w: 16, d: 16, type: 'pad', setback: 3 };
      if (r < 0.3) return { w: 10, d: 10, type: 'dome' };
      if (r < 0.42 && t < 0.6) return { w: 12, d: 12, type: 'tower' };
      return { w: rng.range(10, 16), d: rng.range(7, 10), type: 'hab', setback: 2 };
    },
  },
  lampKind: 'modern',
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w, d } = lot;
    ctx.neonM = M.neon;
    if (lot.type === 'landmark') return tradeTower(g, ctx);
    if (lot.type === 'spaceport') return spaceportPad(g, ctx);
    if (lot.type === 'pad') return S.frontier.build(g, lot, ctx);
    if (lot.type === 'dome') {
      const r = w / 2;
      g.cyl(0, -0.3, 0, r + 0.4, r + 0.4, 1.1, 18, true, M.found);
      g.cyl(0, 0.8, 0, r, r, 1.6, 18, false, M.wall2);
      g.push().translate(0, 2.4, 0); g.dome(0, 0, 0, r, 18, 7, M.glass, 0.8); g.pop();
      for (let i = 0; i < 6; i++) { g.push().rotY(i / 6 * Math.PI * 2); g.lathe(0, 2.4, 0, [[r + 0.05, 0], [r * 0.7, r * 0.56], [0.05, r * 0.8]], 2, M.metal, { a0: -0.04, a1: 0.04 }); g.pop(); }
      g.light(0, 3, 0, '#9fe8ff', 4, r, 0);
      P.tree(g, 0, 0.8, 0, r * 0.9, M, rng);
      g.collider(0, 2.4, 0, r, 2.4, r);
      return 2.4 + r * 0.8;
    }
    if (lot.type === 'tower') return tower(g, ctx, { w: 9, d: 9, h: rng.range(22, 40), fh: 3.6, wall: M.wallWin, wallUp: M.wall2, podium: false, segs: 2, crown: 'antenna', shrink: 0.8, neon: true });
    // habitat module: horizontal capsule on struts + stripes + airlock + solar panels
    const r = Math.min(d / 2, 3.2), L = w - 2;
    g.push().translate(0, r + 1.2, 0).rotZ(Math.PI / 2);
    g.windows(2.2, 1.4, -0.7);
    g.cyl(0, -L / 2, 0, r, r, L, 16, false, M.wallWin);
    g.sphere(0, L / 2, 0, r, 16, 6, M.wall, 1 * 0.5); g.push().rotX(Math.PI); g.sphere(0, L / 2, 0, r, 16, 6, M.wall, 0.5); g.pop();
    for (const y of [-L / 2 + 0.6, L / 2 - 0.6]) g.cyl(0, y, 0, r + 0.08, r + 0.08, 0.5, 16, false, M.stripe);
    g.pop();
    for (const x of [-L / 3, L / 3]) for (const s of [-1, 1]) g.tube([V(x, 0, s * r * 0.8), V(x, r + 0.6, s * r * 0.3)], 0.15, 5, M.iron);
    g.box(0, 0, r + 0.4, 2.2, r * 1.6, 1.8, 0.1, M.accent);
    P.door(g, 0, r + 1.3, 1.2, 2.1, M, M.trim, M.lampGlow);
    g.push().translate(-L / 2 + 1, 2 * r + 1.4, 0).rotX(-0.5); g.box(0, 0, 0, 3.5, 0.08, 2.2, 0.02, mat('#1a2a4a', 0.15, 0.6, PAT.GLASS)); g.pop();
    P.antenna(g, L / 3, 2 * r + 1.2, 0, rng.range(3, 6), M.metal);
    g.light(L / 2 + r * 0.6, r + 1.2, 0, '#ff3a2a', 4, 0.9, 1);
    g.collider(0, r + 1.2, 0, w / 2, r + 1.2, r + 0.5);
    return 2 * r + 2;
  },
  road: () => 'road',
};
S.nasapunk = S.outpost;

function tradeTower(g, ctx) {
  const { M } = ctx;
  // NMS trading post / Starfield comms spire
  g.cyl(0, -0.5, 0, 12, 12, 1.4, 24, true, M.found);
  g.windows(2.4, 4, 0);
  g.cyl(0, 0.9, 0, 7, 6, 10, 20, false, M.wallWin);
  g.cyl(0, 10.9, 0, 8, 8, 0.8, 20, true, M.stripe);
  g.cyl(0, 11.7, 0, 3, 2.4, 22, 14, false, M.wall2);
  g.push().translate(0, 33.7, 0);
  g.sphere(0, 0, 0, 5.5, 20, 12, M.wall);
  g.cyl(0, -0.8, 0, 5.6, 5.6, 1.6, 20, false, M.glass);
  g.pop();
  P.antenna(g, 0, 39, 0, 14, M.metal);
  g.light(0, 34, 5.6, '#40c8ff', 8, 3, 0);
  g.collider(0, 20, 0, 6, 20, 6);
  return 53;
}

// ------------------------------------------------------------------------------- brutalist (Villeneuve)
S.brutalist = {
  pave: true,
  look: { winCol: '#ffb060', winCol2: '#ffd8a0', litFrac: 0.35, age: 0.5, winRect: [0.46, 0.12, 0.54, 0.88], emit: 1.1 },
  mats() {
    return {
      wall: mat('#9a8e7e', 0.9, 0, PAT.SLITS), concrete: mat('#8a7e6e', 0.9, 0, PAT.CONCRETE), found: mat('#6a5e50', 0.95, 0, PAT.CONCRETE), stone: mat('#8a7a64', 0.9, 0, PAT.STONE),
      trim: mat('#7a6e60', 0.9, 0, PAT.CONCRETE), metal: mat('#5a5048', 0.5, 0.6, PAT.PANELS), iron: mat('#2a2622', 0.6, 0.6), roof: mat('#6a5e50', 0.9, 0, PAT.CONCRETE),
      wood: mat('#5a4a3a', 0.85), door: mat('#2a2622', 0.6, 0.5), glass: mat('#302820', 0.1, 0.5, PAT.GLASS), leaf: mat('#6b5a3a', 0.9), bark: mat('#4a3a2a', 0.9),
      canvas: mat('#b09070', 0.95, 0, PAT.FABRIC), lampGlow: mat('#ffb060', 0.4, 0, PAT.LAMP, 6), road: mat('#7a6a58', 0.9, 0, PAT.PAVING), path: mat('#a08060', 0.95, 0, PAT.DIRT),
      plaza: mat('#8a7a66', 0.9, 0, PAT.CONCRETE), statue: mat('#6a5e50', 0.9, 0, PAT.CONCRETE), glow: mat('#ff9a3c', 0.4, 0, PAT.LAMP, 8),
    };
  },
  profile: {
    roadW: 8, streetW: 5, slopeTol: 0.3, slopeAdd: 3, density: 0.7, infill: 0.5, lampSpacing: 40, grid: true, block: 90,
    lot(t, rng) { return t < 0.5 && rng.next() < 0.5 ? { w: rng.range(20, 34), d: rng.range(16, 26), type: 'monolith', setback: 4, gap: 5 } : { w: rng.range(12, 20), d: rng.range(10, 16), type: 'block', setback: 3 }; },
  },
  lampKind: 'modern',
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w, d } = lot;
    if (lot.type === 'landmark') { const H = 60; g.windows(2, 6, 0); g.box(0, -1, 0, w * 1.4, H, w * 0.5, 0.2, M.wall); g.box(0, H - 1, 0, w * 1.5, 2, w * 0.6, 0.1, M.concrete); g.light(0, H + 1.5, 0, '#ff9a3c', 12, 4, 1); g.collider(0, H / 2, 0, w * 0.7, H / 2, w * 0.25); return H + 1; }
    if (lot.type === 'spaceport') return spaceportPad(g, ctx);
    if (lot.type === 'monolith') {
      const H = rng.range(30, 70) * (ctx.level >= 5 ? 1.5 : 1);
      g.windows(1.8, 5, 0);
      g.box(0, -0.5, 0, w + 2, 1.5, d + 2, 0.1, M.found);
      // stepped ziggurat base + slab tower
      for (let i = 0; i < 3; i++) g.box(0, 1 + i * 4, 0, w - i * 3, 4, d - i * 3, 0.1, M.concrete);
      g.box(0, 13, 0, w * 0.5, H, d * 0.7, 0.15, M.wall);
      g.box(0, 13 + H, 0, w * 0.6, 1.5, d * 0.8, 0.1, M.trim);
      g.light(0, 13 + H + 2, 0, '#ff2a1a', 5, 1.4, 1);
      g.collider(0, (13 + H) / 2, 0, w / 2, (13 + H) / 2, d / 2);
      return 14.5 + H;
    }
    const H = rng.range(8, 16);
    g.windows(2.2, 4, 0);
    g.box(0, -0.4, 0, w + 0.6, 1, d + 0.6, 0.05, M.found);
    g.box(0, 0.6, 0, w, H, d, 0.1, M.wall);
    g.box(0, H + 0.6, 0, w + 1.5, 0.8, d + 1.5, 0.05, M.trim);
    P.door(g, 0, d / 2, 1.8, 2.8, M, M.concrete, M.lampGlow);
    g.collider(0, H / 2, 0, w / 2, H / 2, d / 2);
    return H + 1.4;
  },
  road: () => 'road',
};

// ------------------------------------------------------------------------------- crystal (Annihilation)
S.crystal = {
  look: { winCol: '#d8f0ff', winCol2: '#ff9ad5', litFrac: 0.6, age: 0.1, winRect: [0.34, 0.2, 0.66, 0.8], emit: 1.2 },
  mats(body) {
    const fl = body.art?.palette?.flora || ['#ff9ad5', '#9ad5ff', '#d5ff9a', '#fff09a', '#c09aff'];
    return {
      crystals: fl.map((c) => mat(c, 0.1, 0.3, PAT.CRYSTAL, 3)), wall: mat('#f0ecf6', 0.5, 0, PAT.ARCHWIN), white: mat('#f4f0fa', 0.5), found: mat('#c8c0d8', 0.8, 0, PAT.STONE),
      stone: mat('#d8d0e4', 0.8, 0, PAT.STONE), trim: mat('#a6f0ff', 0.3, 0.2), metal: mat('#c8c8d8', 0.3, 0.8), iron: mat('#6a6a7a', 0.4, 0.7), roof: mat('#c09aff', 0.3, 0.2),
      wood: mat('#8a7a8a', 0.8), door: mat('#5a4a6a', 0.5), glass: mat('#a6f0ff', 0.05, 0.5, PAT.GLASS), leaf: mat('#9ad5ff', 0.5), bark: mat('#8a7a9a', 0.8),
      canvas: mat('#e0d8f0', 0.9, 0, PAT.FABRIC), lampGlow: mat('#d8f0ff', 0.3, 0, PAT.LAMP, 6), road: mat('#d0c8e0', 0.8, 0, PAT.PAVING), path: mat('#c0b8d0', 0.9, 0, PAT.PAVING),
      plaza: mat('#e0d8f0', 0.7, 0, PAT.PAVING), statue: mat('#f4f0fa', 0.4), glow: mat('#a6f0ff', 0.3, 0, PAT.LAMP, 8),
    };
  },
  profile: { roadW: 4.5, streetW: 3, slopeTol: 0.4, slopeAdd: 2.5, density: 0.8, infill: 2, lampSpacing: 26,
    lot(t, rng) { return rng.next() < 0.4 ? { w: rng.range(8, 12), d: rng.range(8, 12), type: 'shard' } : { w: rng.range(7, 10), d: rng.range(7, 10), type: 'dome', setback: 2 }; } },
  lampKind: 'modern',
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const { w } = lot;
    const r = w / 2;
    if (lot.type === 'spaceport') return spaceportPad(g, ctx);
    if (lot.type === 'shard' || lot.type === 'landmark') {
      const big = lot.type === 'landmark';
      const n = big ? 7 : rng.int(3, 5);
      let top = 0;
      for (let i = 0; i < n; i++) {
        const h = (big ? 40 : 10) * rng.range(0.6, 1.6), rr = (big ? 4 : 1.4) * rng.range(0.7, 1.2);
        const cm = M.crystals[rng.int(0, M.crystals.length - 1)];
        g.push().translate(rng.range(-r * 0.4, r * 0.4), -0.5, rng.range(-r * 0.4, r * 0.4)).rotZ(rng.range(-0.3, 0.3)).rotX(rng.range(-0.3, 0.3));
        g.lathe(0, 0, 0, [[rr, 0], [rr * 1.05, h * 0.8], [0.02, h]], 6, cm);
        g.pop();
        g.light(0, h * 0.5, 0, cm.color, big ? 8 : 3, big ? 6 : 2, 0);
        top = Math.max(top, h);
      }
      g.collider(0, top / 2, 0, r * 0.5, top / 2, r * 0.5);
      return top;
    }
    g.cyl(0, -0.3, 0, r + 0.3, r + 0.3, 0.8, 6, true, M.found);
    g.windows(2.4, 3, 0);
    g.cyl(0, 0.5, 0, r, r * 0.9, 4, 6, false, M.wall);
    g.cyl(0, 4.5, 0, r * 0.95, 0.1, r * 1.4, 6, true, M.crystals[rng.int(0, M.crystals.length - 1)]);
    P.door(g, 0, r * 0.9, 1.2, 2.3, M, M.trim, M.lampGlow);
    g.collider(0, 2.5, 0, r, 2.5, r);
    return 4.5 + r * 1.4;
  },
  road: () => 'road',
};

// ------------------------------------------------------------------------------- monolith (Kubrick)
S.monolith = {
  ...S.brutalist,
  look: { winCol: '#ffffff', winCol2: '#ffffff', litFrac: 0.2, age: 0.0, winRect: [0.46, 0.12, 0.54, 0.88], emit: 1 },
  mats() { const m = S.brutalist.mats(); m.black = mat('#050506', 0.08, 0.2); m.statue = m.black; return m; },
  build(g, lot, ctx) {
    const { M } = ctx;
    if (lot.type === 'landmark' || lot.type === 'monolith') { g.box(0, -1, 0, 4, 37, 1, 0.02, M.black); g.collider(0, 17.5, 0, 2, 18.5, 0.5); return 36; }
    return S.brutalist.build(g, lot, ctx);
  },
};

// ------------------------------------------------------------------------------- bizarre (Rick and Morty)
S.bizarre = {
  look: { winCol: '#b6ff4a', winCol2: '#ff5fb0', litFrac: 0.6, age: 0.2, winRect: [0.3, 0.3, 0.7, 0.75], emit: 1.2 },
  mats(body) {
    const fl = body.art?.palette?.flora || ['#ff5fb0', '#6af0ff', '#b6ff4a', '#ffd23f', '#9b5cff'];
    return {
      blobs: fl.map((c) => mat(c, 0.35, 0.05)), wall: mat('#f0e0c0', 0.6, 0, PAT.WINDOWS), found: mat('#8a6fc0', 0.8, 0, PAT.STONE), stone: mat('#a08ad0', 0.8, 0, PAT.STONE),
      trim: mat('#4dff88', 0.4), metal: mat('#b0b8c0', 0.3, 0.8, PAT.PANELS), iron: mat('#4a4a5a', 0.5, 0.6), roof: mat('#ff5fb0', 0.4), wood: mat('#8a5a3a', 0.8, 0, PAT.PLANKS),
      door: mat('#3a2a5a', 0.5), glass: mat('#4dff88', 0.05, 0.3, PAT.GLASS), portal: mat('#4dff88', 0.2, 0, PAT.NEON, 10), eye: mat('#ffffff', 0.2), pupil: mat('#101010', 0.2),
      leaf: mat('#b6ff4a', 0.8), bark: mat('#8a6fc0', 0.8), canvas: mat('#ffd23f', 0.9, 0, PAT.FABRIC), lampGlow: mat('#b6ff4a', 0.3, 0, PAT.LAMP, 6),
      road: mat('#c0a8e0', 0.8, 0, PAT.PAVING), path: mat('#d8c080', 0.9, 0, PAT.DIRT), plaza: mat('#e0c8f0', 0.8, 0, PAT.PAVING), statue: mat('#ffd23f', 0.4, 0.3), glow: mat('#4dff88', 0.3, 0, PAT.NEON, 8),
    };
  },
  profile: { roadW: 4.5, streetW: 3, slopeTol: 0.45, slopeAdd: 2.5, density: 0.85, infill: 2.5, lampSpacing: 24,
    lot(t, rng) { const r = rng.next(); return r < 0.2 ? { w: 9, d: 9, type: 'eye' } : r < 0.3 ? { w: 8, d: 8, type: 'portal' } : { w: rng.range(7, 11), d: rng.range(7, 11), type: 'blob', setback: 2 }; } },
  lampKind: 'modern',
  build(g, lot, ctx) {
    const { M, rng } = ctx;
    const r = Math.min(lot.w, lot.d) / 2;
    if (lot.type === 'spaceport') return spaceportPad(g, ctx);
    if (lot.type === 'portal' || lot.type === 'landmark') {
      const pr = lot.type === 'landmark' ? 9 : 2.6;
      g.push().translate(0, pr + 0.4, 0).rotX(Math.PI / 2);
      g.cyl(0, -0.15, 0, pr, pr, 0.3, 24, true, M.portal);
      g.pop();
      g.light(0, pr + 0.4, 0.6, '#4dff88', lot.type === 'landmark' ? 25 : 10, pr * 1.6, 0);
      return pr * 2 + 0.4;
    }
    if (lot.type === 'eye') {
      const h = rng.range(8, 16);
      g.lathe(0, 0, 0, [[r * 0.5, 0], [r * 0.25, h * 0.5], [r * 0.35, h]], 10, M.blobs[rng.int(0, 4)]);
      g.push().translate(0, h + r * 0.7, 0).rotY(rng.range(0, 6.28));
      g.sphere(0, 0, 0, r * 0.75, 16, 10, M.eye);
      g.push().rotX(Math.PI / 2); g.cyl(0, r * 0.62, 0, r * 0.3, r * 0.3, 0.15, 14, true, M.pupil); g.pop();
      g.pop();
      g.collider(0, h / 2, 0, r * 0.4, h / 2, r * 0.4);
      return h + r * 1.5;
    }
    // squishy blob house with wobbly stacked lobes
    const bm = M.blobs[rng.int(0, M.blobs.length - 1)];
    const hh = rng.range(4, 7);
    g.lathe(0, -0.3, 0, [[r * 0.8, 0], [r * 1.05, hh * 0.3], [r * 0.9, hh * 0.7], [r * 0.5, hh * 0.95], [0.05, hh]], 14, bm);
    g.sphere(r * 0.3, hh * 0.95, 0, r * 0.45, 12, 7, M.blobs[rng.int(0, 4)]);
    g.windows(2.2, 2.2, 1.2);
    g.cyl(0, 1.2, 0, r * 1.04, r * 1.04, 1.4, 14, false, M.wall, { a0: -2.2, a1: 0.6 });
    P.door(g, 0, r, 1.2, 2.1, M, M.trim, M.lampGlow);
    g.collider(0, hh / 2, 0, r, hh / 2, r);
    return hh + r * 0.5;
  },
  road: () => 'road',
};

export const STYLES = S;
export function getStyle(name) { return S[name] || S.village; }

/** Lamp prop builder per style. */
export function buildLamp(g, style, M) { P.lamp(g, 0, 0, style.lampKind || 'modern', M, style.look?.winCol ?? '#ffc27a'); }
export { P as parts };
