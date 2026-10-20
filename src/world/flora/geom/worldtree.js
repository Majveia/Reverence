// The World Tree of light (season 2: "a vast tree made of light" — one per world, at the terrain's
// sacred 'tree' site). A braided trunk of four strands spiralling around each other over a ring of
// arching roots, five to seven great limbs spreading into a flattened dome of pale, luminous foliage,
// curtains of glowing strands hanging from the limbs, and veins of light running up the grooves of
// the trunk and out along the limbs (glow solids: they also bake bounce light onto the bark).
// Model space: +Y up, ground at y = 0, metres. Same vertex format as every flora plant (PlantBuilder).
import { PlantBuilder, KIND, bezierPath, norm3 } from './builder.js';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * P: { height (crown top, m), crownR, trunkR, rects: { leaf, glow, vine }, leafA, leafB, glowC, veinC, bark }
 * returns { lod0, lod1, height, crownR, trunkR, veins: [[x,y,z]…] }
 */
export function worldTree(rnd, P) {
  const H = P.height ?? 150;
  const crownR = P.crownR ?? H * 0.58;
  const r0 = P.trunkR ?? H * 0.07;
  const forkY = H * 0.46;
  const strands = [], veins = [], roots = [], limbs = [], clumps = [], hangs = [];
  // ---- braided trunk: four strands twisting a half turn around the axis, merging at the base flare
  const NS = 4;
  for (let s = 0; s < NS; s++) {
    const a0 = (s / NS) * Math.PI * 2 + rnd.range(-0.15, 0.15);
    const pts = [];
    const n = 14;
    for (let k = 0; k <= n; k++) {
      const t = k / n, y = -4 + (forkY + 6) * t;
      const a = a0 + t * Math.PI * 0.85;
      const off = r0 * lerp(0.62, 0.44, t) * (1 + 0.5 * Math.exp(-Math.max(0, y) / (r0 * 0.9)));
      const rr = r0 * lerp(0.58, 0.36, Math.pow(t, 0.9)) * (1 + 0.55 * Math.exp(-Math.max(0, y) / (r0 * 0.8)));
      pts.push({ x: Math.cos(a) * off, y, z: Math.sin(a) * off, r: rr, flex: 0, ao: clamp(0.35 + 0.65 * (y + 4) / (forkY * 0.6), 0.35, 1) });
    }
    strands.push(pts);
    // a vein of light in the groove after this strand (between it and the next)
    const vp = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n, y = -1 + (forkY + 4) * t;
      const a = a0 + t * Math.PI * 0.85 + Math.PI / NS;
      const off = r0 * lerp(0.86, 0.58, t) * (1 + 0.45 * Math.exp(-Math.max(0, y) / (r0 * 0.9)));
      vp.push({ x: Math.cos(a) * off, y, z: Math.sin(a) * off, r: r0 * 0.045 * (1.1 - 0.4 * t), flex: 0, ao: 1 });
    }
    veins.push(vp);
  }
  // ---- roots: wide arches into the ground (the sacred ground under the tree)
  const NR = 11;
  for (let k = 0; k < NR; k++) {
    const a = (k / NR) * Math.PI * 2 + rnd.range(-0.18, 0.18);
    const L = r0 * rnd.range(3.2, 5.2);
    const ca = Math.cos(a), sa = Math.sin(a);
    const path = bezierPath([[ca * r0 * 0.7, r0 * rnd.range(1.0, 1.8), sa * r0 * 0.7], [ca * L * 0.45, r0 * rnd.range(0.7, 1.3), sa * L * 0.45], [ca * L * 0.8, r0 * 0.25, sa * L * 0.8], [ca * L, -r0 * 0.4, sa * L]], 9,
      (t) => r0 * lerp(0.42, 0.06, Math.pow(t, 0.8)), 0, { flex: () => 0, ao: (t) => 0.4 + 0.4 * t });
    roots.push(path);
    if (k % 2 === 0) veins.push(path.map((p, i) => ({ x: p.x, y: p.y + p.r * 0.92, z: p.z, r: Math.max(0.12, p.r * 0.09), flex: 0, ao: 1, t: i })).slice(0, 8));
  }
  // ---- great limbs from the fork: rise, arch outward, droop at the ends (a dome, not a lollipop)
  const NL = rnd.int(6, 7);
  const ph0 = rnd() * Math.PI * 2;
  for (let k = 0; k < NL; k++) {
    const a = ph0 + (k / NL) * Math.PI * 2 + rnd.range(-0.25, 0.25);
    const ca = Math.cos(a), sa = Math.sin(a);
    const L = crownR * rnd.range(0.78, 1.0);
    const sy = forkY + rnd.range(-2, 6);
    const ey = H * rnd.range(0.66, 0.8);
    const s0 = [ca * r0 * 0.3, sy, sa * r0 * 0.3];
    const path = bezierPath([s0, [ca * L * 0.25, sy + (ey - sy) * 0.95, sa * L * 0.25], [ca * L * 0.7, ey + H * 0.06, sa * L * 0.7], [ca * L, ey - H * 0.05, sa * L]], 12,
      (t) => r0 * lerp(0.5, 0.06, Math.pow(t, 0.75)), 0, { flex: (t) => 0.004 + t * 0.03, ao: (t) => 0.55 + 0.45 * t });
    const phase = rnd();
    limbs.push({ path, a, phase });
    veins.push(path.filter((_, i) => i <= 10).map((p) => ({ x: p.x, y: p.y + p.r * 0.95, z: p.z, r: Math.max(0.14, p.r * 0.1), flex: p.flex, ao: 1 })));
    // sub-limbs fanning out toward the crown rim
    for (let q = 0; q < 3; q++) {
      const t0 = rnd.range(0.35, 0.8);
      const sp = path[Math.round(t0 * (path.length - 1))];
      const b = a + rnd.range(-0.9, 0.9);
      const l2 = crownR * rnd.range(0.3, 0.5);
      const e = [sp.x + Math.cos(b) * l2, sp.y + rnd.range(2, 12), sp.z + Math.sin(b) * l2];
      const sub = bezierPath([[sp.x, sp.y, sp.z], [(sp.x + e[0]) / 2, Math.max(sp.y, e[1]) + 4, (sp.z + e[2]) / 2], e], 6, sp.r * 0.5, sp.r * 0.08,
        { flex: (t) => 0.02 + t * 0.04, ao: () => 0.85 });
      limbs.push({ path: sub, a: b, phase, sub: true });
      clumps.push({ x: e[0], y: e[1] + 3, z: e[2], r: crownR * rnd.range(0.2, 0.27), phase });
    }
    const e = path[path.length - 1];
    clumps.push({ x: e.x, y: e.y + 4, z: e.z, r: crownR * rnd.range(0.24, 0.3), phase });
    const m = path[Math.round(path.length * 0.55)];
    clumps.push({ x: m.x, y: m.y + crownR * 0.16, z: m.z, r: crownR * 0.26, phase });
    // curtains of light hanging from the outer limb
    for (let q = 0; q < 7; q++) {
      const tq = rnd.range(0.5, 1.0);
      const hp = path[Math.round(tq * (path.length - 1))];
      hangs.push({ x: hp.x + rnd.range(-6, 6), y: hp.y - 2, z: hp.z + rnd.range(-6, 6), L: rnd.range(0.25, 0.55) * hp.y, phase, seed: rnd() });
    }
  }
  // crown top and fill: a broad, slightly flattened dome
  clumps.push({ x: 0, y: H * 0.86, z: 0, r: crownR * 0.34, phase: rnd() });
  for (let k = 0; k < 5; k++) {
    const a = rnd() * Math.PI * 2, rr = crownR * rnd.range(0.25, 0.7);
    clumps.push({ x: Math.cos(a) * rr, y: H * rnd.range(0.74, 0.88), z: Math.sin(a) * rr, r: crownR * 0.26, phase: rnd() });
  }
  const crownC = [0, H * 0.78, 0];

  const emit = (detail) => {
    const b = new PlantBuilder();
    const bark = P.bark || [0.07, 0.055, 0.05];
    for (const s of strands) b.tube(detail ? s.filter((_, i) => i % 2 === 0 || i === s.length - 1) : s, { segs: detail ? 8 : 16, color: bark, vScale: 0.12, capTip: false });
    for (const r of roots) b.tube(detail ? r.filter((_, i) => i % 2 === 0 || i === r.length - 1) : r, { segs: detail ? 6 : 10, color: bark, vScale: 0.2 });
    for (const l of limbs) {
      if (detail && l.sub) continue;
      b.tube(detail ? l.path.filter((_, i) => i % 2 === 0 || i === l.path.length - 1) : l.path, { segs: detail ? 6 : (l.sub ? 8 : 12), color: bark, phase: l.phase, capTip: true, vScale: 0.25 });
    }
    // veins of light (glow solids → emitters for the bounce-light bake)
    const vc = P.veinC || [1.0, 0.78, 0.4];
    for (const v of veins) {
      b.tube(v, { segs: detail ? 3 : 5, kind: KIND.GLOW, color: vc, capTip: true });
      // (small, sparse emitters: the bark stays dark, lit only along the grooves the veins run in)
      for (let i = 1; i < v.length; i += 4) b.emitter([v[i].x, v[i].y, v[i].z], Math.max(1.2, v[i].r * 5), [vc[0] * 0.5, vc[1] * 0.5, vc[2] * 0.5]);
    }
    // luminous foliage: domed clumps of pale cards, some of them glowing light-cards
    const R = P.rects;
    for (const c of clumps) {
      const n = Math.round((detail ? 0.35 : 1) * c.r * c.r * 0.16);
      const size = crownR * (detail ? 0.16 : 0.105);
      for (let i = 0; i < n; i++) {
        let dx = rnd.gauss(), dy = rnd.gauss() * 0.7 + 0.25, dz = rnd.gauss();
        const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
        const rr = c.r * (0.3 + 0.7 * Math.pow(rnd(), 0.6));
        const px = c.x + dx * rr, py = c.y + dy * rr * (dy < 0 ? 0.55 : 0.8), pz = c.z + dz * rr;
        let ox = px - crownC[0], oy = (py - crownC[1]) / 0.6, oz = pz - crownC[2];
        const ol = Math.hypot(ox, oy, oz) || 1; ox /= ol; oy /= ol; oz /= ol;
        const sh = norm3(dx * 0.55 + ox * 0.55, dy * 0.55 + oy * 0.55 + 0.15, dz * 0.55 + oz * 0.55);
        const top = clamp((sh[1] + 0.4) / 1.3, 0, 1);
        const ao = clamp((0.35 + 0.65 * clamp(ol / crownR, 0, 1)) * (0.55 + 0.45 * top), 0.18, 1);
        const glow = rnd() < (P.glowFrac ?? 0.3);
        const t = rnd();
        const ca = P.leafA, cb = P.leafB, cg = P.glowC || [1, 0.85, 0.5];
        const v = 0.85 + top * 0.25;
        const col = glow ? [cg[0] * (0.8 + 0.4 * t), cg[1] * (0.8 + 0.4 * t), cg[2] * (0.8 + 0.4 * t)] : [lerp(ca[0], cb[0], t) * v, lerp(ca[1], cb[1], t) * v, lerp(ca[2], cb[2], t) * v];
        const s = size * (0.75 + rnd() * 0.5);
        b.bcard({ c: [px, py, pz], w: s * 0.5, h: s * 0.5, roll: rnd() * 6.283, rect: glow ? R.glow : (rnd() < 0.5 ? R.leaf : R.leaf2 || R.leaf),
          kind: glow ? KIND.FLOWER : KIND.LEAF, flex: 0.18, ao, phase: c.phase, color: col, shade: sh });
      }
    }
    // hanging strands of light (Tree of Souls / weeping willow of light)
    if (R.vine) {
      hangs.forEach((h, hi) => {
        if (detail && hi % 2) return;
        const ra = h.seed * 6.283;
        const w = crownR * 0.018;
        b.card({ c: [h.x, h.y - h.L, h.z], right: [Math.cos(ra) * w, 0, Math.sin(ra) * w], up: [0, h.L, 0], rect: R.vine, kind: KIND.FLOWER,
          flex0: 0.5, flex1: 0.05, ao0: 0.9, ao1: 0.7, phase: h.phase, color: P.glowC || [1, 0.85, 0.5], segs: detail ? 2 : 4, bend: 0 });
      });
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H, crownR, trunkR: r0 * 1.1, forkY };
}
