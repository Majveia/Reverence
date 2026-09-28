// Procedural tree species. Each generator builds a deterministic skeleton from its rng, then emits
// geometry at two detail levels: detail 0 (full: bark tubes, branches, many leaf cards) and
// detail 1 (simplified: fewer radial segments, main limbs only, fewer & larger cards).
// Model space: +Y up, ground at y=0; trunks extend below ground to hide slope gaps.
import { PlantBuilder, KIND, bezierPath, norm3, cross3 } from './builder.js';
import { mix3, lerp, clamp, smooth } from '../util.js';

const up3 = [0, 1, 0];

function colorVar(rnd, a, b, bright = 1, t = rnd()) {
  const c = mix3(a, b, t);
  const v = bright * (0.93 + rnd() * 0.14);
  return [c[0] * v, c[1] * v, c[2] * v];
}

/** Leaf clump of camera-facing cluster cards with spherified shading normals. */
function leafClump(b, rnd, cl, o) {
  const detail = o.detail;
  const n = Math.max(2, Math.round(cl.r * cl.r * o.density * (detail ? 0.22 : 1)));
  const size = o.size * (detail ? 1.75 : 1) * (cl.sizeMul ?? 1);
  const cc = o.crown;
  for (let i = 0; i < n; i++) {
    let dx = rnd.gauss(), dy = rnd.gauss() * 0.85 + (o.upBias ?? 0.25), dz = rnd.gauss();
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    const rr = cl.r * (detail ? 0.55 : 0.35 + 0.65 * Math.pow(rnd(), 0.6));
    const px = cl.x + dx * rr, py = cl.y + dy * rr * (o.flat ?? 0.85), pz = cl.z + dz * rr;
    // spherified normal: blend clump + crown outward directions
    let ox = px - cc[0], oy = (py - cc[1]) / (o.crownFlat ?? 1), oz = pz - cc[2];
    const ol = Math.hypot(ox, oy, oz) || 1;
    const depth = clamp(ol / (o.crownR || 1), 0, 1.3);
    ox /= ol; oy /= ol; oz /= ol;
    const sh = norm3(dx * 0.45 + ox * 0.65, dy * 0.45 + oy * 0.65 + 0.18, dz * 0.45 + oz * 0.65);
    // AO: deep inside and underneath the crown is darker
    const under = smooth(-0.9, 0.5, sh[1]);
    const ao = clamp((0.25 + 0.75 * smooth(0.15, 1.0, depth)) * (0.55 + 0.45 * under), 0.12, 1);
    // sun-kissed tops are warmer/lighter
    const top = smooth(-0.2, 0.9, sh[1]);
    const col = colorVar(rnd, o.colA, o.colB, 0.92 + top * 0.18, clamp(0.1 + top * 0.6 + rnd() * 0.2, 0, 1));
    const s = size * (0.8 + rnd() * 0.45);
    b.bcard({
      c: [px, py, pz], w: s * 0.5, h: s * 0.5, roll: rnd() * Math.PI * 2, rect: o.rect(rnd),
      kind: o.kind ?? KIND.LEAF, flex: (cl.flex ?? 0.3) + 0.15, ao, phase: cl.phase ?? rnd(), color: col, shade: sh,
    });
  }
}

function trunkPath(rnd, H, r0, rTop, o = {}) {
  const pts = [];
  const n = o.segs ?? 12;
  const gn = o.gnarl ?? 0.15;
  const lx = o.leanX ?? 0, lz = o.leanZ ?? 0;
  const ph1 = rnd() * 6.28, ph2 = rnd() * 6.28;
  const sink = o.sink ?? 0.8;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const y = -sink + (H + sink) * t;
    const w = Math.sin(t * 5.1 + ph1) * gn * t + Math.sin(t * 11.3 + ph2) * gn * 0.35 * t;
    const x = lx * t * t * H + w * Math.cos(ph2), z = lz * t * t * H + w * Math.sin(ph1);
    let r = lerp(r0, rTop, Math.pow(t, o.taperPow ?? 0.8));
    const yy = Math.max(0, y);
    r *= 1 + (o.flare ?? 0.7) * Math.exp(-yy / (r0 * 2.2)); // root flare
    const flex = Math.pow(Math.max(0, y) / (H + 1e-3), 2) * (o.trunkFlex ?? 0.12);
    const ao = clamp(0.35 + 0.65 * smooth(-0.2, H * 0.35, y), 0.3, 1);
    pts.push({ x, y, z, r, flex, ao });
  }
  return pts;
}

function pointOn(path, t) {
  const f = clamp(t, 0, 1) * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(f)), u = f - i;
  const a = path[i], b = path[i + 1];
  return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u), r: lerp(a.r, b.r, u), flex: lerp(a.flex, b.flex, u) };
}

// ======================================================================== BROADLEAF (oak / BotW)
export function broadleaf(rnd, P) {
  const H = P.height * rnd.range(0.85, 1.15);           // overall height
  const crownR = P.crownR * rnd.range(0.85, 1.15);
  const crownH = crownR * (P.crownAspect ?? 0.8);
  const trunkH = H - crownH * 1.05;
  const r0 = P.trunkR * rnd.range(0.85, 1.2);
  const leanX = rnd.range(-1, 1) * (P.lean ?? 0.03), leanZ = rnd.range(-1, 1) * (P.lean ?? 0.03);
  const trunk = trunkPath(rnd, trunkH + crownH * 0.6, r0, r0 * 0.45, { gnarl: P.gnarl ?? 0.2, leanX, leanZ, segs: 12, flare: P.flare ?? 0.8 });
  const top = trunk[trunk.length - 1];
  const crown = [top.x, trunkH + crownH * 0.55, top.z];
  const limbs = [];
  const nL = P.limbs ?? rnd.int(4, 6);
  const phase0 = rnd() * 6.28;
  for (let k = 0; k < nL; k++) {
    const az = phase0 + (k / nL) * Math.PI * 2 + rnd.range(-0.35, 0.35);
    const t0 = rnd.range(0.62, 0.86);
    const s = pointOn(trunk, t0);
    const el = rnd.range(0.35, 0.85);                  // elevation above horizontal
    const L = crownR * rnd.range(0.7, 1.0);
    const ex = s.x + Math.cos(az) * Math.cos(el) * L, ey = s.y + Math.sin(el) * L * 0.9 + crownH * 0.15, ez = s.z + Math.sin(az) * Math.cos(el) * L;
    const mx = s.x + Math.cos(az) * L * 0.45, my = s.y + L * 0.2, mz = s.z + Math.sin(az) * L * 0.45;
    const phase = rnd();
    const path = bezierPath([[s.x, s.y, s.z], [mx, my + rnd.range(-0.4, 0.6), mz], [ex, ey, ez]], 6, s.r * 0.62, 0.06,
      { flex: (t) => s.flex + t * 0.35, ao: (t) => 0.55 + 0.45 * t });
    limbs.push({ path, phase, end: [ex, ey, ez], az });
  }
  // clumps: limb ends + sub-branch ends + top
  const clumps = [];
  const clR = P.clumpR ?? crownR * 0.48;
  for (const l of limbs) {
    const e = l.end;
    clumps.push({ x: e[0], y: e[1], z: e[2], r: clR * rnd.range(0.85, 1.15), flex: 0.45, phase: l.phase });
    const nb = rnd.int(1, 2);
    for (let q = 0; q < nb; q++) {
      const s = pointOn(l.path, rnd.range(0.45, 0.8));
      const a = l.az + rnd.range(-1.1, 1.1);
      const L = crownR * rnd.range(0.35, 0.6);
      const ex = s.x + Math.cos(a) * L, ey = s.y + L * rnd.range(0.2, 0.7), ez = s.z + Math.sin(a) * L;
      l.subs = l.subs || [];
      l.subs.push(bezierPath([[s.x, s.y, s.z], [(s.x + ex) / 2, (s.y + ey) / 2 + 0.3, (s.z + ez) / 2], [ex, ey, ez]], 4, s.r * 0.6, 0.04,
        { flex: (t) => 0.3 + t * 0.3, ao: () => 0.8 }));
      clumps.push({ x: ex, y: ey, z: ez, r: clR * rnd.range(0.7, 1.0), flex: 0.5, phase: l.phase });
    }
  }
  clumps.push({ x: crown[0], y: crown[1] + crownH * 0.45, z: crown[2], r: clR * 1.1, flex: 0.4, phase: rnd() });
  // fill clumps to round out the crown silhouette
  for (let k = 0; k < (P.fill ?? 3); k++) {
    const a = rnd() * 6.28, rr = crownR * rnd.range(0.3, 0.65);
    clumps.push({ x: crown[0] + Math.cos(a) * rr, y: crown[1] + rnd.range(-0.2, 0.5) * crownH, z: crown[2] + Math.sin(a) * rr, r: clR * 0.9, flex: 0.45, phase: rnd() });
  }
  const leafOpts = (detail) => ({
    detail, density: P.leafDensity ?? 7.5, size: P.leafSize ?? 1.6, crown, crownR, crownFlat: crownH / crownR,
    colA: P.leafA, colB: P.leafB, rect: (r) => P.rects[Math.floor(r() * P.rects.length)], flat: 0.8,
  });
  const emit = (detail) => {
    const b = new PlantBuilder();
    const seg = detail ? 5 : 10;
    b.tube(detail ? trunk.filter((_, i) => i % 2 === 0 || i === trunk.length - 1) : trunk, { segs: seg, color: P.bark, capTip: true });
    for (const l of limbs) {
      b.tube(detail ? l.path.filter((_, i) => i % 2 === 0) : l.path, { segs: detail ? 3 : 6, color: P.bark, phase: l.phase, capTip: true });
      if (!detail && l.subs) for (const sp of l.subs) b.tube(sp, { segs: 4, color: P.bark, phase: l.phase, capTip: true });
    }
    const r2 = mulberryFork(rnd, detail);
    const lo = leafOpts(detail);
    for (const c of clumps) leafClump(b, r2, c, lo);
    return b;
  };
  return {
    lod0: emit(0), lod1: emit(1),
    height: H, trunkR: r0, crownR, collider: { r: r0 * 1.1, h: trunkH },
  };
}

// deterministic sub-generator so LOD0/LOD1 leaf placement differ in count but stay stable
function mulberryFork(rnd, salt) {
  let s = (Math.floor(rnd() * 4294967296) ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  const f = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  f.range = (a, b) => a + (b - a) * f();
  f.int = (a, b) => a + Math.floor(f() * (b - a + 1));
  f.gauss = () => { let u = 0; while (u === 0) u = f(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185 * f()); };
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  return f;
}

// ======================================================================== CONIFER (spruce / fir / pine)
export function conifer(rnd, P) {
  const H = P.height * rnd.range(0.8, 1.2);
  const r0 = P.trunkR * rnd.range(0.85, 1.15) * (H / P.height);
  const base = H * (P.crownBase ?? 0.18) * rnd.range(0.7, 1.3);
  const maxL = (P.branchLen ?? H * 0.2) * rnd.range(0.85, 1.15);
  const trunk = trunkPath(rnd, H, r0, 0.03, { gnarl: 0.05, leanX: rnd.range(-0.01, 0.01), leanZ: rnd.range(-0.01, 0.01), segs: 16, flare: 0.5, taperPow: 1.0, trunkFlex: 0.2 });
  const whorlGap = P.whorlGap ?? 0.62;
  const whorls = [];
  let az = rnd() * 6.28;
  for (let y = base; y < H - 0.4; y += whorlGap * rnd.range(0.8, 1.2)) {
    const t = (y - base) / (H - base);
    const L = (maxL * Math.pow(1 - t, P.shapePow ?? 0.95) + 0.35) * rnd.range(0.85, 1.15);
    const n = P.perWhorl ?? rnd.int(5, 7);
    const br = [];
    for (let k = 0; k < n; k++) {
      if (rnd() < (P.gaps ?? 0.12)) continue;
      const a = az + (k / n) * Math.PI * 2 + rnd.range(-0.25, 0.25);
      const droop = (P.droop ?? 0.25) * (0.4 + 0.9 * (1 - t)) + rnd.range(-0.08, 0.08);
      const Lk = L * rnd.range(0.8, 1.1);
      br.push({ a, L: Lk, droop, phase: rnd() });
    }
    whorls.push({ y, t, br });
    az += 2.39996;
  }
  const s = trunk[trunk.length - 1];
  const colA = P.leafA, colB = P.leafB;
  const emit = (detail) => {
    const b = new PlantBuilder();
    b.tube(detail ? trunk.filter((_, i) => i % 3 === 0 || i === trunk.length - 1) : trunk, { segs: detail ? 5 : 8, color: P.bark, capTip: true });
    const r2 = mulberryFork(rnd, detail + 11);
    whorls.forEach((w, wi) => {
      if (detail && wi % 2 === 1) return;
      const tp = pointOn(trunk, (w.y + 0.8) / (H + 0.8));
      for (const B of w.br) {
        const ca = Math.cos(B.a), sa = Math.sin(B.a);
        const L = B.L * (detail ? 1.08 : 1);
        // branch: out and slightly down, tip curls up
        const p0 = [tp.x, w.y, tp.z];
        const p1 = [tp.x + ca * L * 0.5, w.y - B.droop * L * 0.55, tp.z + sa * L * 0.5];
        const p2 = [tp.x + ca * L, w.y - B.droop * L * 0.7 + L * 0.12, tp.z + sa * L];
        const flex0 = Math.pow(w.y / H, 2) * 0.2;
        if (!detail && L > 1.4) {
          b.tube(bezierPath([p0, p1, p2], 2, Math.max(0.025, r0 * 0.28 * (L / maxL)), 0.012, { flex: (t) => flex0 + t * 0.5, ao: (t) => 0.4 + 0.5 * t }),
            { segs: 3, color: P.bark, phase: B.phase });
        }
        // needle cards along the branch: flat sprays + a tilted duplicate for volume
        const nCards = detail ? 1 : Math.max(1, Math.round(L / 1.5));
        for (let q = 0; q < nCards; q++) {
          const t0 = nCards === 1 ? 0.12 : q / nCards * 0.85 + 0.08;
          const t1 = Math.min(1, t0 + (nCards === 1 ? 0.95 : 1.25 / nCards + 0.1));
          const pa = bez(p0, p1, p2, t0), pb = bez(p0, p1, p2, t1);
          const dir = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
          const len = Math.hypot(...dir);
          const side = norm3(-dir[2], 0, dir[0]);
          const wHalf = (0.28 + 0.32 * (1 - t0)) * L * 0.55 * (detail ? 1.3 : 1) + 0.25;
          const roll = r2.range(-0.35, 0.35);
          for (let dup = 0; dup < (detail ? 1 : 2); dup++) {
            const tilt = dup === 0 ? roll : roll + (r2() < 0.5 ? 0.9 : -0.9);
            // rotate side around dir by tilt
            const dn = norm3(...dir);
            const cs = Math.cos(tilt), sn = Math.sin(tilt);
            const cr = cross3(dn, side);
            const right = [(side[0] * cs + cr[0] * sn) * wHalf, (side[1] * cs + cr[1] * sn) * wHalf, (side[2] * cs + cr[2] * sn) * wHalf];
            const radial = norm3(pa[0] - tp.x, 0, pa[2] - tp.z);
            const out = (Math.hypot(pa[0] - tp.x, pa[2] - tp.z) + len * 0.5) / (maxL + 0.5);
            const shade = norm3(radial[0] * 0.8 + dn[0] * 0.2, 0.55 + (1 - w.t) * -0.25, radial[2] * 0.8 + dn[2] * 0.2);
            const ao = clamp((0.3 + 0.7 * smooth(0.0, 0.9, out)) * (0.55 + 0.45 * w.t) + 0.1, 0.15, 1);
            const col = colorVar(r2, colA, colB, 0.9 + 0.2 * w.t, clamp(out * 0.6 + r2() * 0.3, 0, 1));
            b.card({
              c: pa, right, up: [dir[0] * 1.05, dir[1] * 1.05, dir[2] * 1.05], rect: P.rect,
              kind: KIND.LEAF, flex0: flex0 + t0 * 0.5, flex1: flex0 + t1 * 0.55 + 0.1, ao0: ao * 0.85, ao1: ao, phase: B.phase,
              color: col, shade, bend: -len * 0.08 * (1 + B.droop), segs: len > 1.3 ? 2 : 1,
            });
          }
        }
      }
    });
    // leader tip
    const tipY = H;
    for (let k = 0; k < (detail ? 1 : 3); k++) {
      const a = k * 2.1 + r2();
      b.card({ c: [s.x, tipY - 1.6, s.z], right: [Math.cos(a) * 0.35, 0, Math.sin(a) * 0.35], up: [0, 1.9, 0], rect: P.rect, kind: KIND.LEAF,
        flex0: 0.2, flex1: 0.35, ao0: 0.8, ao1: 1, color: colorVar(r2, colA, colB, 1.05, 0.7), shade: [0, 1, 0] });
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H, trunkR: r0, crownR: maxL, collider: { r: r0 * 1.2, h: H * 0.5 } };
}
function bez(a, b, c, t) { const it = 1 - t; return [a[0] * it * it + 2 * b[0] * it * t + c[0] * t * t, a[1] * it * it + 2 * b[1] * it * t + c[1] * t * t, a[2] * it * it + 2 * b[2] * it * t + c[2] * t * t]; }

// ======================================================================== SLENDER (birch / poplar / aspen)
export function slender(rnd, P) {
  const H = P.height * rnd.range(0.85, 1.15);
  const r0 = P.trunkR * rnd.range(0.85, 1.15);
  const trunk = trunkPath(rnd, H * 0.92, r0, r0 * 0.25, { gnarl: 0.22, leanX: rnd.range(-0.04, 0.04), leanZ: rnd.range(-0.04, 0.04), segs: 14, flare: 0.35, trunkFlex: 0.25 });
  const crownR = P.crownR * rnd.range(0.8, 1.2);
  const clumps = [];
  const branches = [];
  const n = rnd.int(6, 9);
  for (let k = 0; k < n; k++) {
    const t = rnd.range(0.38, 0.95);
    const s = pointOn(trunk, t);
    const a = rnd() * 6.28, L = crownR * rnd.range(0.5, 1.0) * (1.1 - t * 0.5);
    const e = [s.x + Math.cos(a) * L, s.y + L * rnd.range(0.5, 1.1), s.z + Math.sin(a) * L];
    const phase = rnd();
    branches.push({ path: bezierPath([[s.x, s.y, s.z], [(s.x + e[0]) / 2, s.y + L * 0.2, (s.z + e[2]) / 2], e], 4, s.r * 0.5, 0.03, { flex: (u) => s.flex + u * 0.4, ao: () => 0.8 }), phase });
    clumps.push({ x: e[0], y: e[1], z: e[2], r: (P.clumpR ?? 1.3) * rnd.range(0.8, 1.2), flex: 0.5, phase });
  }
  const tp = trunk[trunk.length - 1];
  clumps.push({ x: tp.x, y: tp.y + 0.6, z: tp.z, r: (P.clumpR ?? 1.3) * 1.1, flex: 0.55, phase: rnd() });
  for (let k = 0; k < 3; k++) { const s = pointOn(trunk, 0.55 + k * 0.15); clumps.push({ x: s.x + rnd.range(-0.6, 0.6), y: s.y, z: s.z + rnd.range(-0.6, 0.6), r: (P.clumpR ?? 1.3) * 0.9, flex: 0.4, phase: rnd() }); }
  const crown = [tp.x, H * 0.66, tp.z];
  const emit = (detail) => {
    const b = new PlantBuilder();
    b.tube(detail ? trunk.filter((_, i) => i % 2 === 0 || i === trunk.length - 1) : trunk, { segs: detail ? 5 : 8, color: P.bark, capTip: true, vScale: 1.4 });
    for (const br of branches) b.tube(detail ? br.path.filter((_, i) => i % 2 === 0) : br.path, { segs: detail ? 3 : 4, color: P.bark, phase: br.phase, capTip: true });
    const r2 = mulberryFork(rnd, detail + 21);
    const lo = { detail, density: P.leafDensity ?? 8, size: P.leafSize ?? 1.1, crown, crownR: crownR * 1.2, crownFlat: 1.6, colA: P.leafA, colB: P.leafB, rect: () => P.rect, flat: 1.1, upBias: 0.1 };
    for (const c of clumps) leafClump(b, r2, c, lo);
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H, trunkR: r0, crownR, collider: { r: r0 * 1.15, h: H * 0.6 } };
}

// ======================================================================== ACACIA / UMBRELLA (savanna, Moebius)
export function umbrella(rnd, P) {
  const H = P.height * rnd.range(0.85, 1.15);
  const r0 = P.trunkR * rnd.range(0.85, 1.15);
  const fork = H * rnd.range(0.3, 0.45);
  const trunk = trunkPath(rnd, fork, r0, r0 * 0.75, { gnarl: 0.25, segs: 6, flare: 0.6 });
  const crownR = P.crownR * rnd.range(0.85, 1.2);
  const limbs = [], clumps = [];
  const n = rnd.int(3, 5);
  const tp = trunk[trunk.length - 1];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * 6.28 + rnd.range(-0.4, 0.4);
    const L = crownR * rnd.range(0.55, 0.9);
    const e = [tp.x + Math.cos(a) * L, H - rnd.range(0.2, 0.9), tp.z + Math.sin(a) * L];
    const phase = rnd();
    limbs.push({ path: bezierPath([[tp.x, tp.y, tp.z], [tp.x + Math.cos(a) * L * 0.25, (tp.y + e[1]) * 0.55, tp.z + Math.sin(a) * L * 0.25], e], 6, tp.r * 0.7, 0.07, { flex: (t) => 0.1 + t * 0.35, ao: () => 0.75 }), phase });
    clumps.push({ x: e[0], y: e[1] + 0.3, z: e[2], r: (P.clumpR ?? 1.8) * rnd.range(0.9, 1.2), flex: 0.45, phase });
    const m = [(tp.x + e[0]) / 2, e[1] - 0.2, (tp.z + e[2]) / 2];
    clumps.push({ x: m[0], y: m[1] + 0.4, z: m[2], r: (P.clumpR ?? 1.8) * 0.9, flex: 0.4, phase });
  }
  clumps.push({ x: tp.x, y: H - 0.1, z: tp.z, r: (P.clumpR ?? 1.8) * 1.1, flex: 0.35, phase: rnd() });
  const crown = [tp.x, H - 0.3, tp.z];
  const emit = (detail) => {
    const b = new PlantBuilder();
    b.tube(trunk, { segs: detail ? 5 : 9, color: P.bark });
    for (const l of limbs) b.tube(detail ? l.path.filter((_, i) => i % 2 === 0) : l.path, { segs: detail ? 3 : 6, color: P.bark, phase: l.phase, capTip: true });
    const r2 = mulberryFork(rnd, detail + 31);
    const lo = { detail, density: P.leafDensity ?? 7, size: P.leafSize ?? 1.5, crown, crownR, crownFlat: 0.35, colA: P.leafA, colB: P.leafB, rect: () => P.rect, flat: 0.38, upBias: 0.5 };
    for (const c of clumps) leafClump(b, r2, c, lo);
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H, trunkR: r0, crownR, collider: { r: r0 * 1.1, h: fork } };
}

// ======================================================================== PALM
export function palm(rnd, P) {
  const H = P.height * rnd.range(0.8, 1.2);
  const r0 = P.trunkR * rnd.range(0.85, 1.15);
  const lean = rnd.range(0.05, 0.22) * H, la = rnd() * 6.28;
  const top = [Math.cos(la) * lean, H, Math.sin(la) * lean];
  const trunk = bezierPath([[0, -0.6, 0], [Math.cos(la) * lean * 0.1, H * 0.45, Math.sin(la) * lean * 0.1], [Math.cos(la) * lean * 0.55, H * 0.8, Math.sin(la) * lean * 0.55], top], 14,
    (t) => r0 * (1 - t * 0.35) * (1 + 0.5 * Math.exp(-t * 18)), 0, { flex: (t) => t * t * 0.3, ao: (t) => 0.5 + 0.5 * smooth(0, 0.3, t) });
  const nF = P.fronds ?? rnd.int(9, 13);
  const fronds = [];
  for (let k = 0; k < nF; k++) {
    const a = (k / nF) * 6.28 + rnd.range(-0.2, 0.2);
    const el = rnd.range(-0.1, 0.75);
    fronds.push({ a, el, L: (P.frondLen ?? 5) * rnd.range(0.8, 1.15), w: (P.frondW ?? 1.1) * rnd.range(0.85, 1.15), phase: rnd() });
  }
  const emit = (detail) => {
    const b = new PlantBuilder();
    b.tube(detail ? trunk.filter((_, i) => i % 2 === 0) : trunk, { segs: detail ? 5 : 9, color: P.bark, vScale: 0.6 });
    const r2 = mulberryFork(rnd, detail + 41);
    for (const f of fronds) {
      if (detail && f.el < 0.05) continue;
      const segs = detail ? 3 : 6;
      // frond spine: arch outward then droop
      const ca = Math.cos(f.a), sa = Math.sin(f.a);
      const pts = [];
      for (let k = 0; k <= segs; k++) {
        const t = k / segs;
        const hx = t * f.L * Math.cos(f.el * (1 - t) ), hy = f.L * (Math.sin(f.el) * t - 0.55 * t * t);
        pts.push([top[0] + ca * hx, top[1] + hy, top[2] + sa * hx]);
      }
      const side = [-sa * f.w * 0.5, 0, ca * f.w * 0.5];
      for (let k = 0; k < segs; k++) {
        const pa = pts[k], pb = pts[k + 1];
        const t0 = k / segs, t1 = (k + 1) / segs;
        const rect = P.rect;
        const v0 = rect[3] + (rect[1] - rect[3]) * t0, v1 = rect[3] + (rect[1] - rect[3]) * t1;
        const shade = norm3(ca * 0.6, 0.8, sa * 0.6);
        const col = colorVar(r2, P.leafA, P.leafB, 1, 0.3 + t0 * 0.5);
        b.card({ c: pa, right: side, up: [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], rect: [rect[0], v1, rect[2], v0], kind: KIND.LEAF,
          flex0: 0.3 + t0 * 0.6, flex1: 0.3 + t1 * 0.6, ao0: 0.55 + 0.45 * t0, ao1: 0.55 + 0.45 * t1, phase: f.phase, color: col, shade });
      }
    }
    if (P.fruit) for (let k = 0; k < (detail ? 0 : 4); k++) {
      const a = k * 1.7 + r2();
      b.sphere({ c: [top[0] + Math.cos(a) * 0.3, top[1] - 0.35, top[2] + Math.sin(a) * 0.3], r: 0.17, wSegs: 6, hSegs: 4, color: P.fruit, kind: KIND.SOLID, flex: 0.3, ao: 0.7 });
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H + 1, trunkR: r0, crownR: P.frondLen ?? 5, collider: { r: r0 * 1.1, h: H * 0.8 } };
}

// ======================================================================== DEAD / GNARLED (Beksiński, dead forests)
export function deadTree(rnd, P) {
  const H = P.height * rnd.range(0.8, 1.25);
  const r0 = P.trunkR * rnd.range(0.85, 1.2);
  const trunk = trunkPath(rnd, H * 0.7, r0, r0 * 0.35, { gnarl: 0.45, leanX: rnd.range(-0.06, 0.06), leanZ: rnd.range(-0.06, 0.06), segs: 12, flare: 1.0 });
  const branches = [];
  const grow = (s, dir, L, r, depth, phase) => {
    const e = [s[0] + dir[0] * L, s[1] + dir[1] * L, s[2] + dir[2] * L];
    const m = [(s[0] + e[0]) / 2 + rnd.range(-0.3, 0.3) * L, (s[1] + e[1]) / 2 + rnd.range(-0.1, 0.25) * L, (s[2] + e[2]) / 2 + rnd.range(-0.3, 0.3) * L];
    branches.push({ path: bezierPath([s, m, e], depth > 1 ? 5 : 3, r, r * 0.45, { flex: (t) => (3 - depth) * 0.15 + t * 0.2, ao: () => 0.7 }), phase, depth });
    if (depth <= 0) return;
    const n = rnd.int(2, 3);
    for (let k = 0; k < n; k++) {
      const d = norm3(dir[0] + rnd.range(-0.9, 0.9), dir[1] + rnd.range(-0.2, 0.6), dir[2] + rnd.range(-0.9, 0.9));
      grow(e, d, L * rnd.range(0.5, 0.75), r * 0.5, depth - 1, phase);
    }
  };
  const nb = rnd.int(3, 5);
  for (let k = 0; k < nb; k++) {
    const s = pointOn(trunk, rnd.range(0.45, 0.95));
    const a = rnd() * 6.28;
    grow([s.x, s.y, s.z], norm3(Math.cos(a), rnd.range(0.3, 1.0), Math.sin(a)), H * rnd.range(0.2, 0.35), s.r * 0.55, 2, rnd());
  }
  const emit = (detail) => {
    const b = new PlantBuilder();
    b.tube(trunk, { segs: detail ? 5 : 9, color: P.bark, capTip: true });
    for (const br of branches) {
      if (detail && br.depth < 1) continue;
      b.tube(br.path, { segs: detail ? 3 : br.depth >= 2 ? 6 : 4, color: P.bark, phase: br.phase, capTip: true });
    }
    if (P.moss && !detail) {
      // hanging moss strands (vine cards) from branches
      const r2 = mulberryFork(rnd, 51);
      for (const br of branches) {
        if (br.depth !== 1 || r2() > 0.6) continue;
        const e = br.path[br.path.length - 1];
        b.card({ c: [e.x, e.y - 2.2, e.z], right: [0.6, 0, 0.2], up: [0, 2.2, 0], rect: P.mossRect, kind: KIND.LEAF, flex0: 0.6, flex1: 0.4, ao0: 0.6, ao1: 0.9, color: P.moss, phase: br.phase });
      }
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H, trunkR: r0, crownR: H * 0.35, collider: { r: r0 * 1.1, h: H * 0.6 } };
}

// ======================================================================== GIANT (Roger Dean / Avatar / legendary trees)
export function giantTree(rnd, P) {
  const H = P.height * rnd.range(0.9, 1.1);
  const r0 = P.trunkR * rnd.range(0.9, 1.1);
  const crownR = P.crownR * rnd.range(0.9, 1.15);
  const trunkH = H * 0.55;
  const trunk = trunkPath(rnd, trunkH + H * 0.1, r0, r0 * 0.5, { gnarl: r0 * 0.35, segs: 16, flare: 1.3, sink: 2.5, trunkFlex: 0.03 });
  const roots = [];
  const nr = rnd.int(6, 9);
  for (let k = 0; k < nr; k++) {
    const a = (k / nr) * 6.28 + rnd.range(-0.2, 0.2);
    const L = r0 * rnd.range(2.5, 4.2);
    const s = [Math.cos(a) * r0 * 0.5, r0 * rnd.range(1.4, 2.4), Math.sin(a) * r0 * 0.5];
    const e = [Math.cos(a) * L, -1.2, Math.sin(a) * L];
    roots.push(bezierPath([s, [Math.cos(a) * L * 0.55, r0 * 0.6, Math.sin(a) * L * 0.55], e], 7, r0 * 0.42, r0 * 0.08, { flex: () => 0, ao: (t) => 0.45 + 0.35 * t }));
  }
  const limbs = [], clumps = [];
  const nL = rnd.int(6, 9);
  for (let k = 0; k < nL; k++) {
    const a = (k / nL) * 6.28 + rnd.range(-0.3, 0.3);
    const s = pointOn(trunk, rnd.range(0.55, 0.92));
    const L = crownR * rnd.range(0.65, 1.0);
    const e = [s.x + Math.cos(a) * L, s.y + L * rnd.range(0.2, 0.55), s.z + Math.sin(a) * L];
    const phase = rnd();
    limbs.push({ path: bezierPath([[s.x, s.y, s.z], [s.x + Math.cos(a) * L * 0.4, s.y + L * 0.45, s.z + Math.sin(a) * L * 0.4], e], 8, s.r * 0.5, s.r * 0.08, { flex: (t) => 0.02 + t * 0.12, ao: (t) => 0.5 + 0.4 * t }), phase, a });
    clumps.push({ x: e[0], y: e[1], z: e[2], r: (P.clumpR ?? crownR * 0.42) * rnd.range(0.85, 1.15), flex: 0.2, phase });
    const s2 = pointOn(limbs[limbs.length - 1].path, 0.6);
    clumps.push({ x: s2.x + rnd.range(-2, 2), y: s2.y + (P.clumpR ?? crownR * 0.4) * 0.5, z: s2.z + rnd.range(-2, 2), r: (P.clumpR ?? crownR * 0.42) * 0.85, flex: 0.18, phase });
  }
  const tp = trunk[trunk.length - 1];
  clumps.push({ x: tp.x, y: tp.y + crownR * 0.45, z: tp.z, r: (P.clumpR ?? crownR * 0.42) * 1.2, flex: 0.15, phase: rnd() });
  const crown = [tp.x, tp.y + crownR * 0.2, tp.z];
  const emit = (detail) => {
    const b = new PlantBuilder();
    b.tube(trunk, { segs: detail ? 8 : 16, color: P.bark, capTip: true, vScale: 0.35 });
    for (const r of roots) b.tube(detail ? r.filter((_, i) => i % 2 === 0) : r, { segs: detail ? 5 : 9, color: P.bark, vScale: 0.5 });
    for (const l of limbs) b.tube(detail ? l.path.filter((_, i) => i % 2 === 0) : l.path, { segs: detail ? 5 : 10, color: P.bark, phase: l.phase, capTip: true, vScale: 0.5 });
    const r2 = mulberryFork(rnd, detail + 61);
    const lo = { detail, density: P.leafDensity ?? 3.2, size: P.leafSize ?? 3.2, crown, crownR: crownR * 1.1, crownFlat: 0.7, colA: P.leafA, colB: P.leafB, rect: (r) => P.rects[Math.floor(r() * P.rects.length)], flat: 0.75 };
    for (const c of clumps) leafClump(b, r2, c, lo);
    if (P.vines && P.vineRect) {
      const nv = detail ? 10 : 36;
      for (let k = 0; k < nv; k++) {
        const c = clumps[Math.floor(r2() * clumps.length)];
        const a = r2() * 6.28, rr = c.r * r2.range(0.3, 0.9);
        const len = r2.range(4, 11) * (P.vineLen ?? 1);
        const x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr, y = c.y - c.r * 0.4;
        const ra = r2() * 6.28;
        const glow = P.vineGlow && r2() < 0.5;
        b.card({ c: [x, y - len, z], right: [Math.cos(ra) * 0.7, 0, Math.sin(ra) * 0.7], up: [0, len, 0], rect: P.vineRect, kind: glow ? KIND.FLOWER : KIND.LEAF,
          flex0: 0.55, flex1: 0.2, ao0: 0.55, ao1: 0.8, phase: c.phase, color: glow ? P.vineGlow : colorVar(r2, P.leafA, P.leafB, 0.85), segs: 3, bend: r2.range(-0.4, 0.4) });
      }
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H + crownR * 0.5, trunkR: r0, crownR, collider: { r: r0 * 1.15, h: trunkH } };
}
