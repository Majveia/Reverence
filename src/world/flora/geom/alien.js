// Alien & fantastical flora: giant fungi (Nausicaä), shelf-fungus towers, coral trees, crystal
// spires (VanderMeer), Rick & Morty wackiness (lollipop trees, tentacles, eyestalks, balloon trees).
import { PlantBuilder, KIND, PAT, bezierPath, norm3 } from './builder.js';
import { mix3, clamp, smooth } from '../util.js';

const cv = (rnd, a, b, t = rnd(), v = 1) => { const c = mix3(a, b, t); const k = v * (0.88 + rnd() * 0.24); return [c[0] * k, c[1] * k, c[2] * k]; };

function capProfile(R, H, lip = 0.12, N = 8) {
  const prof = [];
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const a = t * Math.PI * 0.5;
    prof.push({ r: R * Math.sin(a), y: H * Math.cos(a) });
  }
  prof.push({ r: R * 1.02, y: -H * lip });
  return prof;
}

// ---------------------------------------------------------------------- giant mushroom
export function giantMushroom(rnd, P) {
  const H = P.height * rnd.range(0.75, 1.25);
  const R = P.capR * rnd.range(0.8, 1.2) * (H / P.height) ** 0.6;
  const sr = P.stemR * rnd.range(0.85, 1.15);
  const ph = rnd() * 6.28, bend = rnd.range(0.05, 0.18) * H;
  const top = [Math.cos(ph) * bend, H, Math.sin(ph) * bend];
  const stem = bezierPath([[0, -0.8, 0], [0, H * 0.4, 0], [top[0] * 0.3, H * 0.75, top[2] * 0.3], top], 12,
    (t) => sr * (1 + 0.6 * Math.exp(-t * 7) + 0.12 * Math.sin(t * 17)) * (1 - t * 0.25), 0,
    { flex: (t) => t * t * 0.08, ao: (t) => 0.5 + 0.5 * smooth(0, 0.3, t) });
  const capH = R * rnd.range(0.35, 0.6);
  const tiltX = rnd.range(-0.12, 0.12), tiltZ = rnd.range(-0.12, 0.12);
  const capColor = P.capA, capColor2 = P.capB;
  const rings = P.rings ? rnd.int(1, 3) : 0;
  const emit = (detail) => {
    const b = new PlantBuilder();
    b.tube(detail ? stem.filter((_, i) => i % 3 === 0 || i === stem.length - 1) : stem, { segs: detail ? 6 : 12, kind: KIND.SOLID, pattern: PAT.RIBS, color: (t) => mix3(P.stemA, P.stemB, t), vScale: 0.5 });
    const N = detail ? 4 : 9;
    const prof = capProfile(R, capH, 0.1, N);
    const tilted = (x, y, z) => [x, y + x * tiltX + z * tiltZ, z];
    // top of cap
    const b2 = new PlantBuilder();
    b2.lathe([0, 0, 0], prof, { segs: detail ? 10 : 24, kind: KIND.SOLID, pattern: P.pattern ?? PAT.SPOTS, color: (t) => mix3(capColor, capColor2, smooth(0.2, 1, t)), flex: 0.08, ao: 1 });
    // gills underneath (glowing at night for bioluminescent styles)
    b2.lathe([0, -capH * 0.08, 0], [{ r: R * 1.0, y: 0 }, { r: sr * 0.9, y: capH * 0.25 }], { segs: detail ? 10 : 24, kind: P.glow ? KIND.GLOW : KIND.SOLID, pattern: PAT.GILLS, color: P.gill, flip: true, flex: 0.08, ao: 0.7 });
    for (let i = 0; i < b2.p.length; i += 3) {
      const t = tilted(b2.p[i], b2.p[i + 1], b2.p[i + 2]);
      b2.p[i] = t[0] + top[0]; b2.p[i + 1] = t[1] + top[1] - capH * 0.15; b2.p[i + 2] = t[2] + top[2];
    }
    b.append(b2);
    // ring skirts on the stem (annulus)
    for (let k = 0; k < rings && !detail; k++) {
      const t = 0.55 + k * 0.12;
      const q = stem[Math.floor(t * (stem.length - 1))];
      b.lathe([q.x, q.y, q.z], [{ r: q.r * 0.95, y: 0.05 }, { r: q.r * 2.2, y: -q.r * 0.6 }], { segs: 14, kind: KIND.SOLID, color: P.stemB, ao: 0.8 });
    }
    // glowing spore dots hanging under the cap
    if (P.spores && !detail) {
      for (let k = 0; k < 10; k++) {
        const a = rnd() * 6.28, d = R * rnd.range(0.4, 0.9);
        b.sphere({ c: [top[0] + Math.cos(a) * d, top[1] - capH * 0.2 - rnd() * 1.2, top[2] + Math.sin(a) * d], r: 0.08 + rnd() * 0.1, wSegs: 5, hSegs: 3, kind: KIND.GLOW, color: P.spores, flex: 0.3 });
      }
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H + capH, crownR: R, trunkR: sr, collider: { r: sr * 1.1, h: H } };
}

// ---------------------------------------------------------------------- shelf-fungus tower (Sea of Corruption)
export function fungusTower(rnd, P) {
  const H = P.height * rnd.range(0.8, 1.25);
  const sr = P.stemR * rnd.range(0.85, 1.2);
  const ph = rnd() * 6.28;
  const stem = bezierPath([[0, -1, 0], [Math.cos(ph) * H * 0.08, H * 0.4, Math.sin(ph) * H * 0.08], [-Math.cos(ph) * H * 0.05, H * 0.8, 0], [0, H, 0]], 14,
    (t) => sr * (1 + 0.8 * Math.exp(-t * 6)) * (1 - t * 0.55), 0, { flex: (t) => t * t * 0.1, ao: (t) => 0.45 + 0.55 * t });
  const shelves = [];
  const n = rnd.int(4, 8);
  for (let k = 0; k < n; k++) {
    const t = 0.3 + (k / n) * 0.68 + rnd.range(-0.03, 0.03);
    const q = stem[Math.floor(t * (stem.length - 1))];
    shelves.push({ q, a: rnd() * 6.28, R: (P.shelfR ?? 2.5) * rnd.range(0.6, 1.2) * (1.2 - t * 0.5), full: rnd() < 0.3 });
  }
  const emit = (detail) => {
    const b = new PlantBuilder();
    b.tube(detail ? stem.filter((_, i) => i % 3 === 0 || i === stem.length - 1) : stem, { segs: detail ? 6 : 11, kind: KIND.SOLID, pattern: PAT.RIBS, color: (t) => mix3(P.stemA, P.stemB, t), capTip: true, vScale: 0.4 });
    for (const s of shelves) {
      const R = s.R, h = R * 0.22;
      const segs = detail ? 8 : 18;
      const b2 = new PlantBuilder();
      const prof = [{ r: 0, y: h }, { r: R * 0.5, y: h * 0.9 }, { r: R * 0.85, y: h * 0.45 }, { r: R, y: 0 }, { r: R * 0.9, y: -h * 0.25 }];
      b2.lathe([0, 0, 0], prof, { segs, kind: KIND.SOLID, pattern: PAT.BANDS, color: (t) => mix3(P.capA, P.capB, t), ao: 1, flex: 0.02 });
      b2.lathe([0, -h * 0.2, 0], [{ r: R * 0.9, y: 0 }, { r: 0.2, y: h * 0.3 }], { segs, kind: P.glow ? KIND.GLOW : KIND.SOLID, pattern: PAT.GILLS, color: P.gill, flip: true, ao: 0.6, flex: 0.02 });
      // squash into a half-shelf attached to the stem side
      const ca = Math.cos(s.a), sa = Math.sin(s.a);
      for (let i = 0; i < b2.p.length; i += 3) {
        let x = b2.p[i], z = b2.p[i + 2];
        if (!s.full) { const along = x * ca + z * sa; if (along < 0) { x -= ca * along * 0.8; z -= sa * along * 0.8; } }
        b2.p[i] = s.q.x + x + ca * s.q.r * 0.6; b2.p[i + 1] += s.q.y; b2.p[i + 2] = s.q.z + z + sa * s.q.r * 0.6;
      }
      b.append(b2);
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H + 1, crownR: P.shelfR ?? 2.5, trunkR: sr, collider: { r: sr * 1.2, h: H } };
}

// ---------------------------------------------------------------------- coral tree (alien branching with bulbous tips)
export function coralTree(rnd, P) {
  const H = P.height * rnd.range(0.8, 1.2);
  const r0 = P.trunkR * rnd.range(0.85, 1.2);
  const branches = [];
  const tips = [];
  const grow = (s, dir, L, r, depth, phase) => {
    const e = [s[0] + dir[0] * L, s[1] + dir[1] * L, s[2] + dir[2] * L];
    const m = [(s[0] + e[0]) / 2 + rnd.range(-0.2, 0.2) * L, (s[1] + e[1]) / 2, (s[2] + e[2]) / 2 + rnd.range(-0.2, 0.2) * L];
    branches.push({ path: bezierPath([s, m, e], 5, r, r * 0.7, { flex: (t) => (3 - depth) * 0.1 + t * 0.12, ao: (t) => 0.5 + 0.5 * t }), depth, phase });
    if (depth <= 0) { tips.push({ p: e, r: r * rnd.range(1.4, 2.3), phase }); return; }
    const n = rnd.int(2, 3);
    for (let k = 0; k < n; k++) {
      const d = norm3(dir[0] + rnd.range(-0.8, 0.8), dir[1] + rnd.range(0.1, 0.7), dir[2] + rnd.range(-0.8, 0.8));
      grow(e, d, L * rnd.range(0.55, 0.8), r * 0.62, depth - 1, phase);
    }
  };
  grow([0, -0.8, 0], norm3(rnd.range(-0.1, 0.1), 1, rnd.range(-0.1, 0.1)), H * 0.4, r0, 3, rnd());
  const emit = (detail) => {
    const b = new PlantBuilder();
    for (const br of branches) {
      if (detail && br.depth === 0) continue;
      b.tube(detail ? br.path.filter((_, i) => i % 2 === 0) : br.path, { segs: detail ? 4 : 8, kind: KIND.SOLID, pattern: PAT.BANDS, color: (t) => mix3(P.colA, P.colB, clamp((3 - br.depth + t) / 4, 0, 1)), phase: br.phase, capTip: true });
    }
    for (const t of tips) b.sphere({ c: t.p, r: t.r, wSegs: detail ? 6 : 10, hSegs: detail ? 4 : 7, kind: P.glow ? KIND.GLOW : KIND.SOLID, pattern: PAT.POLKA, color: P.tip, flex: 0.35, phase: t.phase, ao: 1 });
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H, crownR: H * 0.45, trunkR: r0, collider: { r: r0, h: H * 0.4 } };
}

// ---------------------------------------------------------------------- crystal cluster / spire
export function crystalCluster(rnd, P) {
  const n = P.count ?? rnd.int(4, 11);
  const H = P.height * rnd.range(0.7, 1.3);
  const cr = [];
  for (let k = 0; k < n; k++) {
    const main = k === 0;
    const a = rnd() * 6.28, d = main ? 0 : rnd.range(0.2, 1.0) * (P.spread ?? 1.2);
    const h = main ? H : H * rnd.range(0.25, 0.75);
    const tilt = main ? rnd.range(0, 0.12) : rnd.range(0.15, 0.6);
    const dir = norm3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    cr.push({ base: [Math.cos(a) * d, -0.4, Math.sin(a) * d], dir, h, r: (P.radius ?? 0.45) * (main ? 1.3 : rnd.range(0.4, 0.9)) * (h / H + 0.4), c: cv(rnd, P.colA, P.colB), rot: rnd() * 6.28 });
  }
  const emit = (detail) => {
    const b = new PlantBuilder();
    for (const c of cr) {
      const segs = 6;
      const [bx, by, bz] = c.base, [dx, dy, dz] = c.dir;
      // orthonormal frame
      const t1 = norm3(-dz, 0, dx); if (!isFinite(t1[0]) || Math.hypot(...t1) < 0.5) { t1[0] = 1; t1[1] = 0; t1[2] = 0; }
      const t2 = [dy * t1[2] - dz * t1[1], dz * t1[0] - dx * t1[2], dx * t1[1] - dy * t1[0]];
      const shaft = c.h * 0.82;
      const baseIdx = b.count;
      const ring = (y, r, v) => {
        for (let s = 0; s <= segs; s++) {
          const a = c.rot + (s / segs) * 6.2832;
          const ca = Math.cos(a), sa = Math.sin(a);
          const nx = t1[0] * ca + t2[0] * sa, ny = t1[1] * ca + t2[1] * sa, nz = t1[2] * ca + t2[2] * sa;
          b.vert(bx + dx * y + nx * r, by + dy * y + ny * r, bz + dz * y + nz * r, nx, ny, nz, s / segs, v, KIND.CRYSTAL * 16 + PAT.BANDS, 0, 0.5 + 0.5 * y / c.h, 0, nx, ny, nz, c.c[0], c.c[1], c.c[2]);
        }
      };
      ring(0, c.r, 0); ring(shaft, c.r * 0.92, 0.82);
      for (let s = 0; s < segs; s++) { const a = baseIdx + s, bb = a + 1, cc = a + segs + 1, d = cc + 1; b.tri(a, bb, cc); b.tri(bb, d, cc); }
      // pyramid tip (flat-shaded facets)
      for (let s = 0; s < segs; s++) {
        const a0 = c.rot + (s / segs) * 6.2832, a1 = c.rot + ((s + 1) / segs) * 6.2832;
        const r = c.r * 0.92;
        const p0 = [bx + dx * shaft + (t1[0] * Math.cos(a0) + t2[0] * Math.sin(a0)) * r, by + dy * shaft + (t1[1] * Math.cos(a0) + t2[1] * Math.sin(a0)) * r, bz + dz * shaft + (t1[2] * Math.cos(a0) + t2[2] * Math.sin(a0)) * r];
        const p1 = [bx + dx * shaft + (t1[0] * Math.cos(a1) + t2[0] * Math.sin(a1)) * r, by + dy * shaft + (t1[1] * Math.cos(a1) + t2[1] * Math.sin(a1)) * r, bz + dz * shaft + (t1[2] * Math.cos(a1) + t2[2] * Math.sin(a1)) * r];
        const tp = [bx + dx * c.h, by + dy * c.h, bz + dz * c.h];
        const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [tp[0] - p0[0], tp[1] - p0[1], tp[2] - p0[2]];
        const fn = norm3(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
        const i0 = b.vert(...p0, ...fn, 0, 0.85, KIND.CRYSTAL * 16 + PAT.BANDS, 0, 0.9, 0, ...fn, ...c.c);
        const i1 = b.vert(...p1, ...fn, 1, 0.85, KIND.CRYSTAL * 16 + PAT.BANDS, 0, 0.9, 0, ...fn, ...c.c);
        const i2 = b.vert(...tp, ...fn, 0.5, 1, KIND.CRYSTAL * 16 + PAT.BANDS, 0, 1, 0, ...fn, ...c.c);
        b.tri(i0, i1, i2);
      }
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H, crownR: (P.spread ?? 1.2) + 0.5, trunkR: 0.6, collider: { r: (P.radius ?? 0.45) * 1.5, h: H } };
}

// ---------------------------------------------------------------------- Rick & Morty: lollipop tree
export function lollipopTree(rnd, P) {
  const H = P.height * rnd.range(0.8, 1.2);
  const r0 = P.trunkR * rnd.range(0.85, 1.2);
  const ph = rnd() * 6.28, sw = rnd.range(0.4, 1.4);
  const trunk = bezierPath([[0, -0.6, 0], [Math.cos(ph) * sw, H * 0.35, Math.sin(ph) * sw], [-Math.cos(ph) * sw, H * 0.7, -Math.sin(ph) * sw], [0, H, 0]], 14, (t) => r0 * (1 - t * 0.4), 0,
    { flex: (t) => t * t * 0.25, ao: (t) => 0.55 + 0.45 * t });
  const R = P.crownR * rnd.range(0.8, 1.25);
  const blobs = [{ c: [0, H + R * 0.7, 0], r: R }];
  const nb = rnd.int(0, 3);
  for (let k = 0; k < nb; k++) { const a = rnd() * 6.28; blobs.push({ c: [Math.cos(a) * R * 0.75, H + R * rnd.range(0.3, 1.1), Math.sin(a) * R * 0.75], r: R * rnd.range(0.45, 0.7) }); }
  const cA = P.colA, cB = P.colB;
  const emit = (detail) => {
    const b = new PlantBuilder();
    b.tube(detail ? trunk.filter((_, i) => i % 2 === 0) : trunk, { segs: detail ? 6 : 12, kind: KIND.SOLID, pattern: PAT.STRIPES, color: P.trunk, vScale: 1.2 });
    for (const bl of blobs) b.sphere({ c: bl.c, r: [bl.r, bl.r * 0.92, bl.r], wSegs: detail ? 10 : 22, hSegs: detail ? 7 : 16, kind: P.glow ? KIND.GLOW : KIND.SOLID, pattern: PAT.POLKA,
      color: (x, y) => mix3(cA, cB, smooth(-1, 1, y)), flex: (y) => 0.25 + 0.1 * y, ao: (y) => 0.65 + 0.35 * smooth(-1, 0.3, y) });
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H + R * 1.7, crownR: R, trunkR: r0, collider: { r: r0 * 1.1, h: H } };
}

// ---------------------------------------------------------------------- Rick & Morty: tentacle plant
export function tentaclePlant(rnd, P) {
  const n = rnd.int(3, 6);
  const tt = [];
  for (let k = 0; k < n; k++) {
    const a = rnd() * 6.28, d = rnd.range(0, 0.6) * P.radius;
    const H = P.height * rnd.range(0.55, 1.2);
    const curl = rnd.range(1.5, 3.5) * (rnd() < 0.5 ? -1 : 1);
    const pts = [];
    const N = 22;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const ang = a + curl * t * t * 2.2;
      const rad = P.radius * 0.1 + t * t * H * 0.35;
      pts.push({ x: Math.cos(a) * d + Math.cos(ang) * rad * t, y: -0.3 + H * (t - 0.35 * t * t * t), z: Math.sin(a) * d + Math.sin(ang) * rad * t, r: P.thick * (1 - t * 0.9) + 0.015, flex: t * 0.8, ao: 0.5 + 0.5 * t });
    }
    tt.push({ pts, phase: rnd() });
  }
  const emit = (detail) => {
    const b = new PlantBuilder();
    for (const t of tt) b.tube(detail ? t.pts.filter((_, i) => i % 3 === 0) : t.pts, { segs: detail ? 5 : 9, kind: KIND.SOLID, pattern: PAT.POLKA, color: (u) => mix3(P.colA, P.colB, u), phase: t.phase, capTip: true, vScale: 2 });
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: P.height, crownR: P.radius, trunkR: P.thick, collider: { r: P.radius * 0.5, h: P.height * 0.7 } };
}

// ---------------------------------------------------------------------- Rick & Morty: eyestalk
export function eyeStalk(rnd, P) {
  const n = rnd.int(1, 3);
  const st = [];
  for (let k = 0; k < n; k++) {
    const a = rnd() * 6.28, d = k ? rnd.range(0.3, 0.8) : 0;
    const H = P.height * rnd.range(0.6, 1.2);
    st.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, H, bend: rnd.range(-0.25, 0.25) * H, bz: rnd.range(-0.25, 0.25) * H, r: P.eyeR * rnd.range(0.6, 1.2), phase: rnd(), look: rnd() * 6.28 });
  }
  const emit = (detail) => {
    const b = new PlantBuilder();
    for (const s of st) {
      const top = [s.x + s.bend, s.H, s.z + s.bz];
      b.tube(bezierPath([[s.x, -0.2, s.z], [s.x, s.H * 0.6, s.z], top], detail ? 3 : 8, s.r * 0.35, s.r * 0.2, { flex: (t) => t * 0.6, ao: (t) => 0.5 + 0.5 * t }), { segs: detail ? 5 : 8, kind: KIND.SOLID, color: P.stalk, phase: s.phase });
      // eyeball: sphere rotated so the iris (uv top pole) looks sideways
      const b2 = new PlantBuilder();
      b2.sphere({ c: [0, 0, 0], r: s.r, wSegs: detail ? 8 : 16, hSegs: detail ? 6 : 12, kind: KIND.SOLID, pattern: PAT.EYE, color: P.iris, flex: 0.65, phase: s.phase, ao: 1 });
      const ca = Math.cos(s.look), sa = Math.sin(s.look);
      // rotate the +Y pole (iris) to the horizontal look direction: 90° about k = Y × d
      const kx = sa, kz = -ca;
      const rot = (x, y, z) => { const kv = kx * x + kz * z; return [-kz * y + kx * kv, kz * x - kx * z, kx * y + kz * kv]; };
      for (let i = 0; i < b2.p.length; i += 3) {
        const p = rot(b2.p[i], b2.p[i + 1], b2.p[i + 2]);
        b2.p[i] = p[0] + top[0]; b2.p[i + 1] = p[1] + top[1] + s.r * 0.6; b2.p[i + 2] = p[2] + top[2];
        const q = rot(b2.n[i], b2.n[i + 1], b2.n[i + 2]);
        b2.n[i] = q[0]; b2.n[i + 1] = q[1]; b2.n[i + 2] = q[2]; b2.sh[i] = q[0]; b2.sh[i + 1] = q[1]; b2.sh[i + 2] = q[2];
      }
      b.append(b2);
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: P.height * 1.3, crownR: P.eyeR * 2, trunkR: P.eyeR * 0.4, collider: { r: P.eyeR * 0.5, h: P.height } };
}

// ---------------------------------------------------------------------- balloon / bulb tree (wacky + bioluminescent)
export function balloonTree(rnd, P) {
  const H = P.height * rnd.range(0.8, 1.2);
  const r0 = P.trunkR * rnd.range(0.85, 1.2);
  const trunk = bezierPath([[0, -0.6, 0], [rnd.range(-0.5, 0.5), H * 0.5, rnd.range(-0.5, 0.5)], [0, H * 0.75, 0]], 10, r0, r0 * 0.5, { flex: (t) => t * t * 0.2, ao: (t) => 0.5 + 0.5 * t });
  const tp = trunk[trunk.length - 1];
  const arms = [];
  const n = rnd.int(4, 8);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * 6.28 + rnd.range(-0.3, 0.3);
    const L = H * rnd.range(0.2, 0.45);
    const e = [tp.x + Math.cos(a) * L, tp.y + L * rnd.range(0.3, 1.1), tp.z + Math.sin(a) * L];
    arms.push({ path: bezierPath([[tp.x, tp.y, tp.z], [tp.x + Math.cos(a) * L * 0.5, tp.y + L * 0.05, tp.z + Math.sin(a) * L * 0.5], e], 6, r0 * 0.45, r0 * 0.12, { flex: (t) => 0.1 + t * 0.4, ao: () => 0.8 }), e, r: (P.bulbR ?? H * 0.11) * rnd.range(0.7, 1.35), c: cv(rnd, P.colA, P.colB), phase: rnd() });
  }
  const emit = (detail) => {
    const b = new PlantBuilder();
    b.tube(trunk, { segs: detail ? 5 : 9, kind: KIND.SOLID, pattern: P.trunkPattern ?? PAT.RIBS, color: P.trunk });
    for (const a of arms) {
      b.tube(detail ? a.path.filter((_, i) => i % 2 === 0) : a.path, { segs: detail ? 4 : 6, kind: KIND.SOLID, color: P.trunk, phase: a.phase });
      b.sphere({ c: [a.e[0], a.e[1] + a.r * 0.8, a.e[2]], r: [a.r, a.r * 1.15, a.r], wSegs: detail ? 8 : 14, hSegs: detail ? 6 : 10, kind: P.glow ? KIND.GLOW : KIND.SOLID, pattern: P.bulbPattern ?? PAT.BANDS, color: a.c, flex: 0.5, phase: a.phase, ao: 1 });
    }
    return b;
  };
  return { lod0: emit(0), lod1: emit(1), height: H * 1.3, crownR: H * 0.5, trunkR: r0, collider: { r: r0 * 1.1, h: H * 0.7 } };
}
