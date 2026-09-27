// Understory & ground plants: bushes, ferns, flower patches, reeds/cattails, tall grass tufts,
// alien fronds & bulbs, cacti, small mushrooms, dry shrubs, moss mounds.
// Each returns { lod0: PlantBuilder, lod1: PlantBuilder, height, radius }.
import { PlantBuilder, KIND, PAT, bezierPath, norm3 } from './builder.js';
import { mix3, clamp, smooth } from '../util.js';

const cv = (rnd, a, b, t = rnd(), v = 1) => { const c = mix3(a, b, t); const k = v * (0.85 + rnd() * 0.3); return [c[0] * k, c[1] * k, c[2] * k]; };

// -------------------------------------------------------------------------------- bush
export function bush(rnd, P) {
  const R = P.radius * rnd.range(0.8, 1.2);
  const n = rnd.int(2, 4);
  const clumps = [];
  for (let k = 0; k < n; k++) {
    const a = rnd() * 6.28, d = R * rnd.range(0.1, 0.55);
    clumps.push({ x: Math.cos(a) * d, y: R * rnd.range(0.45, 0.8), z: Math.sin(a) * d, r: R * rnd.range(0.55, 0.8), phase: rnd() });
  }
  const emit = (detail) => {
    const b = new PlantBuilder();
    if (!detail) for (const c of clumps) {
      b.tube(bezierPath([[0, -0.2, 0], [c.x * 0.3, c.y * 0.5, c.z * 0.3], [c.x, c.y, c.z]], 3, 0.05 * R, 0.015, { flex: (t) => t * 0.3, ao: () => 0.4 }), { segs: 3, color: P.bark || [0.08, 0.06, 0.04] });
    }
    for (const c of clumps) {
      const m = Math.max(2, Math.round(c.r * c.r * (P.density ?? 14) * (detail ? 0.25 : 1)));
      for (let i = 0; i < m; i++) {
        let dx = rnd.gauss(), dy = Math.abs(rnd.gauss()) * 0.7 + 0.1, dz = rnd.gauss();
        const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
        const rr = c.r * (0.3 + 0.7 * Math.sqrt(rnd()));
        const px = c.x + dx * rr, py = Math.max(0.12, c.y + dy * rr * 0.8), pz = c.z + dz * rr;
        const sh = norm3(px * 0.8, (py - R * 0.3) * 1.2 + 0.3, pz * 0.8);
        const top = smooth(-0.3, 1, sh[1]);
        const ao = clamp(0.35 + 0.65 * smooth(0, R * 1.1, py) * (0.6 + 0.4 * top), 0.2, 1);
        const s = (P.leafSize ?? 0.8) * R * (detail ? 1.6 : 1) * rnd.range(0.8, 1.2);
        const flower = P.flowerRect && rnd() < (P.flowerChance ?? 0.25);
        b.bcard({ c: [px, py, pz], w: s * 0.5, h: s * 0.5, roll: rnd() * 6.28, rect: flower ? P.flowerRect : P.rect,
          kind: flower ? KIND.FLOWER : KIND.LEAF, flex: 0.25 + py / R * 0.3, ao, phase: c.phase,
          color: flower ? cv(rnd, P.flowerA, P.flowerB, rnd(), 1.1) : cv(rnd, P.leafA, P.leafB, top * 0.6 + rnd() * 0.4, 0.9 + top * 0.2), shade: sh });
      }
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: R * 1.4, radius: R };
}

// -------------------------------------------------------------------------------- fern (radial arching fronds)
export function fern(rnd, P) {
  const L = P.length * rnd.range(0.8, 1.2);
  const n = P.fronds ?? rnd.int(7, 11);
  const fr = [];
  for (let k = 0; k < n; k++) fr.push({ a: (k / n) * 6.28 + rnd.range(-0.25, 0.25), el: rnd.range(0.55, 1.15), L: L * rnd.range(0.75, 1.1), phase: rnd() });
  const emit = (detail) => {
    const b = new PlantBuilder();
    for (const f of fr) {
      if (detail && fr.indexOf(f) % 2) continue;
      const segs = detail ? 2 : 4;
      const ca = Math.cos(f.a), sa = Math.sin(f.a);
      const pts = [];
      for (let k = 0; k <= segs; k++) {
        const t = k / segs;
        const h = t * f.L;
        pts.push([ca * h * Math.cos(f.el * (1 - t * 0.9)), f.L * (Math.sin(f.el) * t - 0.45 * t * t) + 0.02, sa * h * Math.cos(f.el * (1 - t * 0.9))]);
      }
      const w = f.L * (P.widthRatio ?? 0.32);
      const side = [-sa * w, 0, ca * w];
      for (let k = 0; k < segs; k++) {
        const pa = pts[k], pb = pts[k + 1];
        const t0 = k / segs, t1 = (k + 1) / segs;
        const r = P.rect;
        const v0 = r[3] + (r[1] - r[3]) * t0, v1 = r[3] + (r[1] - r[3]) * t1;
        b.card({ c: pa, right: side, up: [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], rect: [r[0], v1, r[2], v0], kind: KIND.LEAF,
          flex0: 0.15 + t0 * 0.5, flex1: 0.15 + t1 * 0.5, ao0: 0.45 + 0.4 * t0, ao1: 0.45 + 0.4 * t1, phase: f.phase,
          color: cv(rnd, P.leafA, P.leafB, t0 * 0.5 + rnd() * 0.4), shade: norm3(ca * 0.5, 0.85, sa * 0.5) });
      }
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: L * 0.8, radius: L };
}

// -------------------------------------------------------------------------------- flower patch
export function flowerPatch(rnd, P) {
  const n = P.count ?? rnd.int(4, 9);
  const R = P.radius ?? 0.5;
  const fl = [];
  for (let k = 0; k < n; k++) {
    const a = rnd() * 6.28, d = R * Math.sqrt(rnd());
    fl.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, h: (P.height ?? 0.45) * rnd.range(0.7, 1.3), phase: rnd(), c: cv(rnd, P.colA, P.colB) });
  }
  const emit = (detail) => {
    const b = new PlantBuilder();
    for (const f of fl) {
      if (detail && fl.indexOf(f) % 2) continue;
      const lean = [rnd.range(-0.1, 0.1) * f.h, 0, rnd.range(-0.1, 0.1) * f.h];
      const top = [f.x + lean[0], f.h, f.z + lean[2]];
      if (P.type === 'spike' || P.type === 'cup') {
        // two crossed vertical cards (stem + blossoms painted in the texture)
        const w = f.h * (P.type === 'spike' ? 0.32 : 0.42);
        for (let q = 0; q < (detail ? 1 : 2); q++) {
          const a = q * 1.5708 + f.phase * 3;
          b.card({ c: [f.x, -0.03, f.z], right: [Math.cos(a) * w, 0, Math.sin(a) * w], up: [lean[0], f.h, lean[2]], rect: P.rect, kind: KIND.FLOWER,
            flex0: 0, flex1: 0.7, ao0: 0.45, ao1: 1, phase: f.phase, color: f.c, shade: [0, 1, 0], segs: 2 });
        }
      } else {
        // stem + camera-facing blossom head
        if (!detail) b.tube([{ x: f.x, y: -0.02, z: f.z, r: 0.008, flex: 0, ao: 0.5 }, { x: top[0], y: top[1], z: top[2], r: 0.006, flex: 0.7, ao: 0.9 }], { segs: 3, kind: KIND.SOLID, color: P.stem || [0.05, 0.12, 0.03], phase: f.phase });
        const s = (P.headSize ?? 0.09) * rnd.range(0.8, 1.25);
        b.bcard({ c: top, w: s, h: s, roll: rnd() * 6.28, rect: P.rect, kind: KIND.FLOWER, flex: 0.75, ao: 1, phase: f.phase, color: f.c, shade: [0, 1, 0] });
      }
    }
    if (P.leafRect && !detail) {
      for (let k = 0; k < 3; k++) {
        const a = rnd() * 6.28;
        b.card({ c: [0, 0, 0], right: [Math.cos(a) * 0.12, 0, Math.sin(a) * 0.12], up: [Math.sin(a) * 0.25, 0.22, -Math.cos(a) * 0.25], rect: P.leafRect, kind: KIND.LEAF,
          flex0: 0, flex1: 0.4, ao0: 0.4, ao1: 0.8, color: P.leaf || [0.06, 0.12, 0.03], phase: rnd(), bend: -0.05 });
      }
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: (P.height ?? 0.45) * 1.3, radius: R };
}

// -------------------------------------------------------------------------------- reeds / cattails / tall grass tufts
export function reeds(rnd, P) {
  const n = P.count ?? rnd.int(5, 9);
  const R = P.radius ?? 0.6;
  const st = [];
  for (let k = 0; k < n; k++) {
    const a = rnd() * 6.28, d = R * Math.sqrt(rnd());
    st.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, h: P.height * rnd.range(0.65, 1.2), a: rnd() * 3.14, phase: rnd(), cat: P.cattail && rnd() < 0.45 });
  }
  const emit = (detail) => {
    const b = new PlantBuilder();
    for (const s of st) {
      if (detail && st.indexOf(s) % 2) continue;
      const w = s.h * (P.widthRatio ?? 0.28);
      const lean = [rnd.range(-0.12, 0.12) * s.h, 0, rnd.range(-0.12, 0.12) * s.h];
      for (let q = 0; q < (detail ? 1 : 2); q++) {
        const a = s.a + q * 1.5708;
        b.card({ c: [s.x, -0.05, s.z], right: [Math.cos(a) * w, 0, Math.sin(a) * w], up: [lean[0], s.h, lean[2]], rect: P.rect, kind: KIND.LEAF,
          flex0: 0, flex1: P.flex ?? 0.8, ao0: 0.4, ao1: 1, phase: s.phase, color: cv(rnd, P.colA, P.colB), shade: norm3(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3), segs: 2, bend: rnd.range(-0.1, 0.1) * s.h });
      }
      if (s.cat && !detail) {
        const top = [s.x + lean[0] * 1.05, s.h * 1.02, s.z + lean[2] * 1.05];
        b.tube([{ x: s.x, y: 0, z: s.z, r: 0.008, flex: 0, ao: 0.6 }, { x: top[0], y: top[1] + 0.25, z: top[2], r: 0.006, flex: 0.9, ao: 1 }], { segs: 3, kind: KIND.SOLID, color: [0.07, 0.1, 0.03], phase: s.phase });
        b.tube([{ x: top[0], y: top[1] - 0.05, z: top[2], r: 0.03, flex: 0.8, ao: 0.8 }, { x: top[0], y: top[1] + 0.2, z: top[2], r: 0.032, flex: 0.9, ao: 1 }], { segs: 5, kind: KIND.SOLID, color: [0.12, 0.06, 0.025], phase: s.phase, capTip: true });
      }
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: P.height * 1.2, radius: R };
}

// -------------------------------------------------------------------------------- alien frond plant (NMS)
export function alienFronds(rnd, P) {
  const n = rnd.int(5, 9);
  const L = P.length * rnd.range(0.8, 1.2);
  const fr = [];
  for (let k = 0; k < n; k++) fr.push({ a: (k / n) * 6.28 + rnd.range(-0.3, 0.3), el: rnd.range(0.7, 1.35), L: L * rnd.range(0.7, 1.1), phase: rnd(), c: cv(rnd, P.colA, P.colB) });
  const emit = (detail) => {
    const b = new PlantBuilder();
    for (const f of fr) {
      const ca = Math.cos(f.a), sa = Math.sin(f.a);
      const w = f.L * 0.33;
      const segs = detail ? 1 : 3;
      const pts = [];
      for (let k = 0; k <= segs; k++) {
        const t = k / segs;
        pts.push([ca * f.L * t * Math.cos(f.el) * 1.1, f.L * (Math.sin(f.el) * t - 0.3 * t * t), sa * f.L * t * Math.cos(f.el) * 1.1]);
      }
      for (let k = 0; k < segs; k++) {
        const pa = pts[k], pb = pts[k + 1], r = P.rect;
        const t0 = k / segs, t1 = (k + 1) / segs;
        b.card({ c: pa, right: [-sa * w, 0, ca * w], up: [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], rect: [r[0], r[3] + (r[1] - r[3]) * t1, r[2], r[3] + (r[1] - r[3]) * t0],
          kind: KIND.LEAF, flex0: 0.2 + t0 * 0.4, flex1: 0.2 + t1 * 0.4, ao0: 0.5 + 0.5 * t0, ao1: 0.5 + 0.5 * t1, phase: f.phase, color: f.c, shade: norm3(ca * 0.6, 0.8, sa * 0.6) });
      }
    }
    if (P.bulb) {
      const h = L * rnd.range(0.8, 1.3);
      b.tube(bezierPath([[0, 0, 0], [0.05, h * 0.5, 0], [0, h, 0.05]], detail ? 2 : 5, 0.04 * L, 0.025 * L, { flex: (t) => t * 0.5, ao: () => 0.8 }), { segs: 4, kind: KIND.SOLID, color: P.stem || [0.1, 0.2, 0.05] });
      b.sphere({ c: [0, h + 0.12 * L, 0.05], r: [0.14 * L, 0.18 * L, 0.14 * L], wSegs: detail ? 6 : 10, hSegs: detail ? 4 : 7, kind: KIND.GLOW, pattern: PAT.BANDS, color: P.bulb, flex: 0.5, ao: 1 });
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: L * 1.2, radius: L };
}

// -------------------------------------------------------------------------------- glowing bulb stalks
export function bulbs(rnd, P) {
  const n = P.count ?? rnd.int(3, 7);
  const st = [];
  for (let k = 0; k < n; k++) {
    const a = rnd() * 6.28, d = (P.radius ?? 0.5) * Math.sqrt(rnd());
    st.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, h: P.height * rnd.range(0.5, 1.2), phase: rnd(), c: cv(rnd, P.colA, P.colB, rnd(), 1.1), bend: rnd.range(-0.3, 0.3) });
  }
  const emit = (detail) => {
    const b = new PlantBuilder();
    for (const s of st) {
      const top = [s.x + s.bend * s.h * 0.4, s.h, s.z + s.bend * s.h * 0.2];
      b.tube(bezierPath([[s.x, -0.05, s.z], [s.x, s.h * 0.6, s.z], top], detail ? 2 : 5, 0.025 * P.height + 0.01, 0.012, { flex: (t) => t * 0.7, ao: (t) => 0.5 + 0.5 * t }),
        { segs: detail ? 3 : 5, kind: KIND.SOLID, color: P.stem || [0.08, 0.15, 0.06], phase: s.phase });
      const r = (P.bulbR ?? 0.12) * rnd.range(0.7, 1.4);
      b.sphere({ c: [top[0], top[1] + r * 0.8, top[2]], r: [r, r * 1.25, r], wSegs: detail ? 6 : 10, hSegs: detail ? 4 : 7, kind: KIND.GLOW, pattern: PAT.BANDS, color: s.c, flex: 0.75, ao: 1, phase: s.phase });
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: P.height * 1.3, radius: P.radius ?? 0.5 };
}

// -------------------------------------------------------------------------------- cactus (saguaro / barrel)
export function cactus(rnd, P) {
  const H = P.height * rnd.range(0.7, 1.3);
  const r = P.radius * rnd.range(0.8, 1.2);
  const arms = [];
  const na = H > 2.5 ? rnd.int(0, 3) : 0;
  for (let k = 0; k < na; k++) arms.push({ a: rnd() * 6.28, y: H * rnd.range(0.35, 0.6), L: H * rnd.range(0.2, 0.35), up: H * rnd.range(0.2, 0.35) });
  const emit = (detail) => {
    const b = new PlantBuilder();
    const segs = detail ? 6 : 12;
    b.tube(bezierPath([[0, -0.3, 0], [0, H * 0.5, 0], [0, H, 0]], detail ? 3 : 8, (t) => r * (1 - Math.pow(t, 6) * 0.5), 0), { segs, kind: KIND.SOLID, pattern: PAT.RIBS, color: P.color, capTip: true, vScale: 0.4 });
    for (const a of arms) {
      const ca = Math.cos(a.a), sa = Math.sin(a.a);
      const p0 = [ca * r * 0.6, a.y, sa * r * 0.6];
      const p1 = [ca * (r + a.L), a.y + 0.05, sa * (r + a.L)];
      const p2 = [ca * (r + a.L), a.y + a.up, sa * (r + a.L)];
      b.tube(bezierPath([p0, p1, p2], detail ? 3 : 7, r * 0.6, r * 0.45), { segs: detail ? 5 : 9, kind: KIND.SOLID, pattern: PAT.RIBS, color: P.color, capTip: true, vScale: 0.4 });
    }
    if (P.flower && !detail) b.sphere({ c: [0, H + r * 0.1, 0], r: [r * 0.35, r * 0.2, r * 0.35], wSegs: 8, hSegs: 4, kind: KIND.SOLID, color: P.flower, ao: 1 });
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H, radius: r * 3, collider: { r: r, h: H } };
}

// -------------------------------------------------------------------------------- small mushroom cluster
export function mushroomCluster(rnd, P) {
  const n = P.count ?? rnd.int(3, 8);
  const ms = [];
  for (let k = 0; k < n; k++) {
    const a = rnd() * 6.28, d = (P.radius ?? 0.35) * Math.sqrt(rnd());
    ms.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, h: P.height * rnd.range(0.5, 1.3), cr: P.capR * rnd.range(0.6, 1.3), tilt: rnd.range(-0.2, 0.2), c: cv(rnd, P.capA, P.capB) });
  }
  const emit = (detail) => {
    const b = new PlantBuilder();
    for (const m of ms) {
      const top = [m.x + m.tilt * m.h, m.h, m.z];
      b.tube([{ x: m.x, y: -0.02, z: m.z, r: m.cr * 0.28, flex: 0, ao: 0.6 }, { x: top[0], y: top[1], z: top[2], r: m.cr * 0.22, flex: 0.1, ao: 0.9 }], { segs: detail ? 4 : 7, kind: KIND.SOLID, color: P.stem || [0.6, 0.55, 0.45] });
      const prof = [];
      const N = detail ? 3 : 6;
      for (let k = 0; k <= N; k++) { const t = k / N; prof.push({ r: m.cr * Math.sin(t * 1.5708), y: m.cr * 0.55 * Math.cos(t * 1.5708) }); }
      b.lathe(top, prof, { segs: detail ? 6 : 12, kind: P.glow ? KIND.GLOW : KIND.SOLID, pattern: PAT.SPOTS, color: m.c, flex: 0.1, ao: 1 });
      if (!detail) b.lathe([top[0], top[1] - 0.005, top[2]], [{ r: m.cr * 0.98, y: 0 }, { r: m.cr * 0.25, y: m.cr * 0.12 }], { segs: 12, kind: P.glow ? KIND.GLOW : KIND.SOLID, pattern: PAT.GILLS, color: P.gill || [0.8, 0.75, 0.6], flip: true, ao: 0.6 });
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: P.height * 1.4, radius: (P.radius ?? 0.35) + P.capR };
}

// -------------------------------------------------------------------------------- moss mound / low ground cover
export function mossMound(rnd, P) {
  const R = P.radius * rnd.range(0.8, 1.3);
  const emit = (detail) => {
    const b = new PlantBuilder();
    const m = Math.round(R * R * (P.density ?? 18) * (detail ? 0.3 : 1)) + 3;
    for (let i = 0; i < m; i++) {
      const a = rnd() * 6.28, d = R * Math.sqrt(rnd());
      const y = (R * 0.35) * (1 - (d / R) ** 2) + 0.05;
      const sh = norm3(Math.cos(a) * d / R, 1.2, Math.sin(a) * d / R);
      const s = (P.leafSize ?? 0.5) * (detail ? 1.5 : 1) * rnd.range(0.8, 1.2);
      b.bcard({ c: [Math.cos(a) * d, y, Math.sin(a) * d], w: s * 0.5, h: s * 0.4, roll: rnd() * 6.28, rect: P.rect, kind: KIND.LEAF, flex: 0.1, ao: 0.55 + 0.45 * (y / (R * 0.4)), phase: rnd(), color: cv(rnd, P.colA, P.colB), shade: sh });
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: R * 0.5, radius: R };
}
