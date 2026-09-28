// Chain-rig creatures: birds, sky rays, sky whales, fish, jellyfish.
// genome (deterministic from RNG) → rig (bones, pivots) + geometry (LOD0, LOD1), same contract as
// bodies/legged.js so the Crowd renderer (GPU skinning + instancing) draws them unchanged.
//
// Body frame: +Z forward (nose), +Y up (dorsal), +X = creature's left, origin at the centre of mass.
// Bones (all kinds): 0 root · 1 head · 2..(1+nT) tail chain · then per-kind extras:
//   bird : wL1 wL2 wR1 wR2              ray  : wL1 wL2 wR1 wR2
//   whale: finL finR fin2L fin2R          fish : (none)
//   jelly: bell rim tentA0..2 tentB0..2 (head unused; per-bone scale c.bs pulses the bell)
import { MeshBuilder, spline, chainSkin, PART, MAT } from '../MeshBuilder.js';

const r2 = (rng, a, b) => rng.range(a, b);
const V = (x, y, z) => [x, y, z];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const code = (part, mat) => part * 8 + mat;

// ------------------------------------------------------------------------------------ genomes
export function chainGenome(rng, kind, style = {}) {
  const ex = style.exotic ?? 0.3;
  const g = { kind };
  if (kind === 'bird') {
    g.span = r2(rng, 1.4, 2.6) * (1 + ex * r2(rng, 0, 1.4));
    g.bodyLen = g.span * r2(rng, 0.3, 0.4);
    g.bodyW = g.bodyLen * r2(rng, 0.11, 0.15);
    g.neck = r2(rng, 0.05, 0.25);
    g.headK = r2(rng, 0.8, 1.05);
    g.beak = rng.weighted([['short', 3], ['long', 1.5], ['hook', 1.5], ['crest', ex * 2]]);
    g.beakLen = g.beak === 'long' ? r2(rng, 1.2, 2.0) : r2(rng, 0.5, 0.9);
    g.chord = r2(rng, 0.2, 0.28) * g.span * 0.5;
    g.tipK = r2(rng, 0.25, 0.55);
    g.sweep = r2(rng, 0.2, 0.7);
    g.hand = r2(rng, 0.45, 0.55);
    g.fingers = rng.chance(0.5 + ex * 0.2) ? rng.int(4, 7) : 0;
    g.tail = rng.weighted([['fan', 3], ['fork', 1.5], ['streamer', 0.6 + ex]]);
    g.tailLen = r2(rng, 0.3, 0.55) * (g.tail === 'streamer' ? 2.4 : 1);
    g.flapHz = 3.4 / Math.sqrt(g.span);
    g.speed = r2(rng, 9, 15) * Math.sqrt(g.span / 2);
    g.nT = 2;
  } else if (kind === 'ray') {
    g.span = r2(rng, 5, 11) * (0.8 + ex * 0.6);
    g.bodyLen = g.span * r2(rng, 0.45, 0.62);
    g.thick = g.span * r2(rng, 0.045, 0.065);
    g.tipT = r2(rng, 0.48, 0.62);
    g.tipSharp = r2(rng, 0.8, 1.4);
    g.lobes = rng.chance(0.6);
    g.tailLen = g.bodyLen * r2(rng, 0.8, 1.8);
    g.flapHz = r2(rng, 0.25, 0.4);
    g.speed = r2(rng, 5, 8);
    g.nT = 3;
  } else if (kind === 'whale') {
    g.L = r2(rng, 36, 70) * (0.85 + ex * 0.5);
    g.R = g.L * r2(rng, 0.125, 0.16);
    g.flatK = r2(rng, 0.8, 1.0);
    g.headK = r2(rng, 0.9, 1.15);
    g.finLen = g.L * r2(rng, 0.18, 0.32);
    g.fin2 = rng.chance(0.3 + ex * 0.5);
    g.fluke = g.L * r2(rng, 0.13, 0.19);
    g.ridge = rng.chance(0.4 + ex * 0.4) ? rng.int(6, 12) : 0;
    g.grooves = rng.chance(0.7);
    g.speed = r2(rng, 5, 9);
    g.nT = 4;
  } else if (kind === 'fish') {
    g.L = r2(rng, 0.45, 1.2);
    g.H = r2(rng, 0.16, 0.3);
    g.W = r2(rng, 0.07, 0.11);
    g.tail = rng.weighted([['fork', 3], ['fan', 1.5], ['lunate', 1]]);
    g.dorsal = r2(rng, 0.4, 1);
    g.speed = r2(rng, 1.5, 2.6);
    g.nT = 3;
  } else if (kind === 'jelly') {
    g.R = r2(rng, 0.8, 1.8) * (1 + ex * 0.8);
    g.H = g.R * r2(rng, 0.7, 1.15);
    g.tent = rng.int(8, 14);
    g.tentLen = g.R * r2(rng, 2.5, 5);
    g.arms = rng.int(3, 5);
    g.lobes = rng.int(6, 12);
    g.pulseHz = r2(rng, 0.35, 0.6);
    g.speed = r2(rng, 0.6, 1.4);
    g.nT = 0;
  }
  return g;
}

// ------------------------------------------------------------------------------------ rigs
export function chainRig(g) {
  const bones = [];
  const bone = (name, parent, pivot) => { bones.push({ name, parent, pivot }); return bones.length - 1; };
  const rig = { g, kind: g.kind, bones, tail: [], extra: {} };
  bone('root', -1, V(0, 0, 0));
  if (g.kind === 'jelly') {
    const R = g.R, H = g.H;
    bone('head', 0, V(0, H * 0.5, 0));
    rig.extra.bell = bone('bell', 0, V(0, H * 0.35, 0));
    rig.extra.rim = bone('rim', rig.extra.bell, V(0, H * 0.3, 0));
    const Lt = g.tentLen;
    rig.extra.tentA = []; rig.extra.tentB = [];
    for (const arr of [rig.extra.tentA, rig.extra.tentB]) {
      let parent = rig.extra.bell;
      for (let k = 0; k < 3; k++) { parent = bone('tent' + k, parent, V(0, H * 0.3 - Lt * [0.05, 0.36, 0.7][k], 0)); arr.push(parent); }
    }
    rig.length = R * 2; rig.height = H + Lt; rig.radius = Math.max(R, (H + Lt) * 0.5); rig.center = -Lt * 0.35;
  } else {
    let L, zHead, tailZ;
    if (g.kind === 'bird') { L = g.bodyLen; zHead = L * 0.24; tailZ = [-L * 0.22, -L * 0.42]; }
    else if (g.kind === 'ray') { L = g.bodyLen; zHead = L * 0.25; tailZ = [-L * 0.45, -L * 0.45 - g.tailLen * 0.33, -L * 0.45 - g.tailLen * 0.66]; }
    else if (g.kind === 'whale') { L = g.L; zHead = L * 0.22; tailZ = [-L * 0.08, -L * 0.2, -L * 0.31, -L * 0.41]; }
    else { L = g.L; zHead = L * 0.18; tailZ = [-L * 0.05, -L * 0.2, -L * 0.34]; }
    bone('head', 0, V(0, 0, zHead));
    let parent = 0;
    for (const z of tailZ) { parent = bone('tail', parent, V(0, 0, z)); rig.tail.push(parent); }
    rig.zHead = zHead; rig.tailZ = tailZ;
    if (g.kind === 'bird') {
      const W = g.bodyW, zA = L * 0.08, half = g.span * 0.5;
      const elbowX = W * 0.8 + (half - W * 0.8) * g.hand;
      rig.extra.wL1 = bone('wL1', 0, V(W * 0.8, W * 0.35, zA));
      rig.extra.wL2 = bone('wL2', rig.extra.wL1, V(elbowX, W * 0.35, zA - g.sweep * g.chord * 0.3));
      rig.extra.wR1 = bone('wR1', 0, V(-W * 0.8, W * 0.35, zA));
      rig.extra.wR2 = bone('wR2', rig.extra.wR1, V(-elbowX, W * 0.35, zA - g.sweep * g.chord * 0.3));
      rig.zA = zA; rig.elbowX = elbowX;
      rig.length = L * (1 + g.tailLen); rig.height = W * 2; rig.radius = half * 1.05;
    } else if (g.kind === 'ray') {
      const half = g.span * 0.5;
      rig.extra.wL1 = bone('wL1', 0, V(half * 0.2, 0, 0));
      rig.extra.wL2 = bone('wL2', rig.extra.wL1, V(half * 0.55, 0, -L * 0.05));
      rig.extra.wR1 = bone('wR1', 0, V(-half * 0.2, 0, 0));
      rig.extra.wR2 = bone('wR2', rig.extra.wR1, V(-half * 0.55, 0, -L * 0.05));
      rig.length = L + g.tailLen; rig.height = g.thick * 2; rig.radius = Math.max(half, (L + g.tailLen) * 0.5);
    } else if (g.kind === 'whale') {
      const R = g.R;
      rig.extra.finL = bone('finL', 0, V(R * 0.75, -R * 0.35, L * 0.12));
      rig.extra.finR = bone('finR', 0, V(-R * 0.75, -R * 0.35, L * 0.12));
      rig.extra.fin2L = bone('fin2L', rig.tail[0], V(R * 0.6, -R * 0.3, -L * 0.14));
      rig.extra.fin2R = bone('fin2R', rig.tail[0], V(-R * 0.6, -R * 0.3, -L * 0.14));
      rig.length = L; rig.height = R * 2; rig.radius = L * 0.55;
    } else {
      rig.length = L; rig.height = g.H; rig.radius = L * 0.6;
    }
    rig.center = 0;
  }
  rig.nb = bones.length;
  rig.pivots = new Float32Array(rig.nb * 3);
  bones.forEach((b, i) => { rig.pivots[i * 3] = b.pivot[0]; rig.pivots[i * 3 + 1] = b.pivot[1]; rig.pivots[i * 3 + 2] = b.pivot[2]; });
  return rig;
}

/** skin by body-axis z (joints between tail chain / root / head) */
function zSkinner(rig, blend) {
  const tz = rig.tailZ;
  const joints = [], owners = [];
  for (let i = tz.length - 1; i >= 0; i--) joints.push(tz[i]);
  joints.push(rig.zHead);
  owners.push(rig.tail[tz.length - 1]);
  for (let i = tz.length - 2; i >= 0; i--) owners.push(rig.tail[i]);
  owners.push(0, 1);
  return (z, out) => chainSkin(z, joints, owners, blend, out);
}

// ------------------------------------------------------------------------------------ geometry
export function chainGeometry(rig, lod = 0) {
  const g = rig.g;
  const mb = new MeshBuilder();
  const hi = lod === 0;
  if (g.kind === 'bird') birdGeo(mb, rig, hi);
  else if (g.kind === 'ray') rayGeo(mb, rig, hi);
  else if (g.kind === 'whale') whaleGeo(mb, rig, hi);
  else if (g.kind === 'fish') fishGeo(mb, rig, hi);
  else if (g.kind === 'jelly') jellyGeo(mb, rig, hi);
  return mb.build();
}

function eye(mb, c, r, outDir, bone, hi) {
  const z = outDir;
  const ref = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let x = [ref[1] * z[2] - ref[2] * z[1], ref[2] * z[0] - ref[0] * z[2], ref[0] * z[1] - ref[1] * z[0]];
  const l = Math.hypot(...x); x = x.map((v) => v / l);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  mb.ellipsoid(c, r, r, r, hi ? 10 : 5, hi ? 6 : 3, (t, o) => { o[0] = bone; o[1] = bone; o[2] = 1; },
    (t, s, o) => { o[0] = code(PART.EYE, MAT.EYE); o[1] = t; o[2] = 0; o[3] = 1; }, [x, y, z]);
}

/** loft a body along a z-spline; ctrl: [{z, y, w, ht, hb}] tail→nose */
function bodyLoft(mb, ctrl, n, segs, skinZ, info, opts = {}) {
  const sp = spline(ctrl.map((c) => ({ p: [c.x || 0, c.y || 0, c.z], w: c.w, ht: c.ht, hb: c.hb ?? c.ht })), n, ['w', 'ht', 'hb']);
  mb.loft({
    pts: sp.pts, w: sp.w, ht: sp.ht, hb: sp.hb, segs, power: opts.power ?? 2, up: [0, 1, 0],
    skin: (i, t, out) => skinZ(sp.pts[i][2], out),
    info: (i, t, s, out, c) => info(i, t, s, out, c, sp.pts[i]),
    bulge: opts.bulge ? (i, t, c, s) => opts.bulge(sp.pts[i], t, c, s) : undefined,
    capStart: opts.capStart ?? 0.6, capEnd: opts.capEnd ?? 0.6,
  });
  return sp;
}

function birdGeo(mb, rig, hi) {
  const g = rig.g, L = g.bodyLen, W = g.bodyW;
  const skinZ = zSkinner(rig, W * 0.9);
  const hW = W * 0.62 * g.headK;
  const zN = L * (0.36 + g.neck * 0.3);
  const ctrl = [
    { z: -L * 0.46, y: W * 0.12, w: W * 0.22, ht: W * 0.14 },
    { z: -L * 0.3, y: W * 0.05, w: W * 0.6, ht: W * 0.5, hb: W * 0.45 },
    { z: -L * 0.08, y: 0, w: W * 0.98, ht: W * 0.95, hb: W * 1.05 },
    { z: L * 0.12, y: 0, w: W * 0.95, ht: W * 0.95, hb: W * 1.15 },
    { z: L * 0.25, y: W * 0.2, w: W * 0.62, ht: W * 0.62, hb: W * 0.7 },
    { z: zN - hW * 0.6, y: W * 0.35, w: hW * 0.95, ht: hW * 0.95, hb: hW * 0.9 },
    { z: zN, y: W * 0.38, w: hW, ht: hW * 0.95, hb: hW * 0.85 },
    { z: zN + hW * 0.75, y: W * 0.3, w: hW * 0.6, ht: hW * 0.55, hb: hW * 0.55 },
  ];
  bodyLoft(mb, ctrl, hi ? 40 : 10, hi ? 16 : 7, skinZ, (i, t, s, out, c, p) => {
    out[0] = code(p[2] > L * 0.25 ? PART.HEAD : PART.BODY, MAT.SKIN); out[1] = t; out[2] = s; out[3] = 0.6 + 0.4 * Math.max(0, s);
  }, { capStart: 0.8, capEnd: 0.5 });
  // beak
  const bz = zN + hW * 0.6, bl = hW * 1.6 * g.beakLen;
  const bctrl = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const droop = g.beak === 'hook' ? Math.pow(t, 3) * bl * 0.45 : g.beak === 'long' ? t * bl * 0.08 : 0;
    bctrl.push({ z: bz + bl * t, y: W * 0.28 - droop, w: hW * 0.5 * (1 - t * 0.85), ht: hW * 0.38 * (1 - t * 0.8) });
  }
  bodyLoft(mb, bctrl, hi ? 10 : 4, hi ? 8 : 4, (z, o) => { o[0] = 1; o[1] = 1; o[2] = 1; }, (i, t, s, out) => { out[0] = code(PART.HORN, MAT.KERATIN); out[1] = t; out[2] = s; out[3] = 1; }, { capStart: false, capEnd: 0.3 });
  if (g.beak === 'crest') {
    const cc = [];
    for (let i = 0; i <= 5; i++) { const t = i / 5; cc.push({ z: zN - hW * 0.2 - t * L * 0.35, y: W * 0.38 + hW * 0.8 + t * hW * 1.2, w: hW * 0.12 * (1 - t * 0.7), ht: hW * 0.35 * (1 - t * 0.8) }); }
    bodyLoft(mb, cc, hi ? 10 : 4, hi ? 6 : 3, (z, o) => { o[0] = 1; o[1] = 1; o[2] = 1; }, (i, t, s, out) => { out[0] = code(PART.SPIKE, MAT.MEMBRANE); out[1] = t; out[2] = 1; out[3] = 1; }, { capStart: 0.4, capEnd: 0.3 });
  }
  // eyes
  for (const side of [1, -1]) eye(mb, [side * hW * 0.72, W * 0.5, zN + hW * 0.1], hW * 0.26, [side * 0.9, 0.2, 0.35].map((v, i, a) => v / Math.hypot(...a)), 1, hi);
  // wings (loft along span, section = airfoil in the chord plane)
  const half = g.span * 0.5, c0 = g.chord;
  for (const side of [1, -1]) {
    const w1 = side > 0 ? rig.extra.wL1 : rig.extra.wR1, w2 = side > 0 ? rig.extra.wL2 : rig.extra.wR2;
    const n = hi ? 22 : 7;
    const pts = [], w = [], ht = [];
    const x0 = W * 0.55;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + (half - x0) * t;
      const chord = c0 * (1 - (1 - g.tipK) * Math.pow(t, 1.3)) * (t > 0.85 ? Math.sqrt(Math.max(0.02, 1 - (t - 0.85) / 0.155)) : 1) * (0.92 + 0.12 * Math.sin(Math.PI * Math.min(1, t * 2.2)));
      const zLE = rig.zA + c0 * 0.5 - g.sweep * c0 * 1.2 * Math.pow(t, 1.6);
      const y = W * 0.35 + Math.sin(t * Math.PI * 0.9) * half * 0.03;
      pts.push([side * x, y, zLE - chord * 0.5]);
      w.push(Math.max(0.004, chord * 0.5));
      ht.push(Math.max(0.003, W * 0.28 * (1 - t * 0.85)));
    }
    const elbow = rig.elbowX;
    const fingers = g.fingers;
    mb.loft({
      pts, w, ht, hb: ht, segs: hi ? 12 : 6, power: 2, up: [0, 1, 0],
      skin: (i, t, out) => {
        const x = Math.abs(pts[i][0]);
        if (x < W * 1.3) { const k = sstep(W * 0.55, W * 1.3, x); out[0] = w1; out[1] = 0; out[2] = k; }
        else chainSkin(x, [elbow], [w1, w2], half * 0.08, out);
      },
      info: (i, t, s, out) => { out[0] = code(PART.FIN, MAT.SKIN); out[1] = t; out[2] = s * 0.95; out[3] = 0.75 + 0.25 * Math.max(0, s); },
      // scalloped trailing edge → primary / secondary feather tips
      bulge: hi ? (i, t, c, s) => {
        const trailing = side > 0 ? Math.max(0, c) : Math.max(0, -c);
        const f = fingers ? Math.pow(Math.abs(Math.sin(t * Math.PI * (fingers * 2.2))), 0.6) * sstep(0.6, 0.8, t) * 0.4 : 0;
        const sc = Math.pow(Math.abs(Math.sin(t * Math.PI * 14)), 0.5) * 0.06 * (1 - sstep(0.6, 0.8, t));
        return 1 - trailing * trailing * (f + sc);
      } : undefined,
      capStart: false, capEnd: 0.4,
    });
  }
  // tail
  const tb = rig.tail[0], te = rig.tail[1];
  const tl = L * g.tailLen;
  const tz0 = -L * 0.36;
  const tailPiece = (xoff, spread, wid) => {
    const tc = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      tc.push({ x: xoff * t, z: tz0 - tl * t, y: W * 0.12, w: Math.max(0.004, wid * (0.35 + spread * t) * (t > 0.9 ? 0.6 : 1)), ht: W * 0.06 * (1 - t * 0.7) });
    }
    bodyLoft(mb, tc, hi ? 12 : 4, hi ? 8 : 4, (z, o) => chainSkin(z, [rig.tailZ[1], rig.tailZ[0]], [te, tb, 0], W * 0.5, o),
      (i, t, s, out) => { out[0] = code(PART.FIN, MAT.SKIN); out[1] = 0.5 + t * 0.5; out[2] = s * 0.9; out[3] = 0.85; }, { capStart: 0.5, capEnd: 0.4 });
  };
  if (g.tail === 'fan') tailPiece(0, 1.3, W * 0.75);
  else if (g.tail === 'fork') { tailPiece(W * 0.5, 0.2, W * 0.4); tailPiece(-W * 0.5, 0.2, W * 0.4); }
  else { tailPiece(0, 0.4, W * 0.5); if (hi) { tailPiece(W * 0.25, -0.2, W * 0.12); tailPiece(-W * 0.25, -0.2, W * 0.12); } }
}

function rayGeo(mb, rig, hi) {
  const g = rig.g, L = g.bodyLen, half = g.span * 0.5, th = g.thick;
  const skinZ = zSkinner(rig, L * 0.15);
  const start = mb.nv;
  // planform: half-width w(t), t: 0 rear → 1 nose
  const n = hi ? 34 : 10;
  const ctrl = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = -L * 0.5 + L * t;
    let w;
    if (t < g.tipT) w = half * Math.pow(t / g.tipT, g.tipSharp) * (1 - 0.12 * Math.sin(Math.PI * t / g.tipT));
    else w = half * (1 - Math.pow((t - g.tipT) / (1 - g.tipT), 0.85) * 0.78);
    w = Math.max(half * 0.08, w);
    const bodyW = L * 0.16 * Math.sin(Math.PI * Math.min(1, t * 1.05));
    ctrl.push({ z, y: 0, w: Math.max(w, bodyW), ht: th * (0.4 + 0.6 * Math.sin(Math.PI * t)), hb: th * 0.7 * (0.4 + 0.6 * Math.sin(Math.PI * t)) });
  }
  const sp = spline(ctrl.map((c) => ({ p: [0, c.y, c.z], w: c.w, ht: c.ht, hb: c.hb })), hi ? 40 : 12, ['w', 'ht', 'hb']);
  mb.loft({
    pts: sp.pts, w: sp.w, ht: sp.ht, hb: sp.hb, segs: hi ? 40 : 14, power: 2, up: [0, 1, 0],
    skin: (i, t, out) => skinZ(sp.pts[i][2], out),
    info: (i, t, s, out) => { out[0] = code(PART.BODY, MAT.SKIN); out[1] = t; out[2] = s; out[3] = 0.7 + 0.3 * Math.max(0, s); },
    capStart: 0.3, capEnd: 0.3,
  });
  // post-process: thin the wings (thick body core, knife-thin wingtips) and re-skin by span
  const P = mb.pos, SK = mb.skin, IN = mb.info;
  const x1 = half * 0.16, x2 = half * 0.28, xe = half * 0.55;
  const tmp = [0, 0, 1];
  for (let v = start; v < mb.nv; v++) {
    const x = P[v * 3], ax = Math.abs(x);
    const k = sstep(L * 0.1, half * 0.7, ax);
    P[v * 3 + 1] *= 1 - 0.82 * k;
    P[v * 3 + 1] -= Math.pow(ax / half, 2) * th * 0.6;     // slight droop to the tips
    const wing1 = x > 0 ? rig.extra.wL1 : rig.extra.wR1, wing2 = x > 0 ? rig.extra.wL2 : rig.extra.wR2;
    skinZ(P[v * 3 + 2], tmp);
    const body = tmp[2] > 0.5 ? tmp[0] : tmp[1];
    if (ax < x1) { SK[v * 4] = tmp[0]; SK[v * 4 + 1] = tmp[1]; SK[v * 4 + 2] = tmp[2]; }
    else if (ax < x2) { const w = sstep(x1, x2, ax); SK[v * 4] = wing1; SK[v * 4 + 1] = body; SK[v * 4 + 2] = w; }
    else { chainSkin(ax, [xe], [wing1, wing2], half * 0.12, tmp); SK[v * 4] = tmp[0]; SK[v * 4 + 1] = tmp[1]; SK[v * 4 + 2] = tmp[2]; }
    IN[v * 4 + 1] = Math.min(1, ax / half);                  // u = span fraction (glow tips / veins)
    if (ax > x2) IN[v * 4] = code(PART.FIN, MAT.SKIN);
  }
  // cephalic lobes
  if (g.lobes) {
    for (const side of [1, -1]) {
      const c = [];
      for (let i = 0; i <= 5; i++) { const t = i / 5; c.push({ x: side * (L * 0.12 + t * L * 0.02), z: L * 0.42 + t * L * 0.16, y: -th * 0.2 - t * th * 0.3, w: L * 0.035 * (1 - t * 0.6), ht: th * 0.25 * (1 - t * 0.5) }); }
      bodyLoft(mb, c, hi ? 8 : 3, hi ? 7 : 4, (z, o) => { o[0] = 1; o[1] = 1; o[2] = 1; }, (i, t, s, out) => { out[0] = code(PART.HORN, MAT.SKIN); out[1] = t; out[2] = s; out[3] = 0.8; }, { capStart: false, capEnd: 0.5 });
    }
  }
  for (const side of [1, -1]) eye(mb, [side * L * 0.13, th * 0.25, L * 0.36], th * 0.22, [side, 0.3, 0.3].map((v, i, a) => v / Math.hypot(...a)), 1, hi);
  // whip tail
  const tc = [];
  for (let i = 0; i <= 8; i++) { const t = i / 8; tc.push({ z: -L * 0.42 - g.tailLen * t, y: th * 0.1, w: th * 0.35 * (1 - t * 0.9) + 0.01, ht: th * 0.3 * (1 - t * 0.9) + 0.01 }); }
  bodyLoft(mb, tc, hi ? 20 : 6, hi ? 6 : 3, skinZ, (i, t, s, out) => { out[0] = code(PART.TENTACLE, MAT.SKIN); out[1] = t; out[2] = s; out[3] = 0.9; }, { capStart: false, capEnd: 0.5 });
}

function whaleGeo(mb, rig, hi) {
  const g = rig.g, L = g.L, R = g.R;
  const skinZ = zSkinner(rig, L * 0.06);
  // body profile (tail → nose). Rounded forehead, deep chest, long tapering peduncle.
  const prof = [
    [-0.5, 0.05, 0.07], [-0.44, 0.12, 0.16], [-0.34, 0.3, 0.36], [-0.2, 0.62, 0.66], [-0.05, 0.9, 0.92], [0.1, 1.0, 1.02],
    [0.25, 0.96, 0.98], [0.36, 0.85, 0.86], [0.44, 0.68 * g.headK, 0.66], [0.49, 0.42 * g.headK, 0.36], [0.515, 0.14, 0.1],
  ];
  const ctrl = prof.map(([t, w, h]) => ({ z: t * L, y: t > 0.3 ? (t - 0.3) * R * 0.3 : 0, w: R * w, ht: R * h * g.flatK, hb: R * h * 1.08 }));
  const grooves = g.grooves;
  bodyLoft(mb, ctrl, hi ? 60 : 16, hi ? 28 : 10, skinZ, (i, t, s, out, c, p) => {
    out[0] = code(p[2] > L * 0.3 ? PART.HEAD : PART.BODY, MAT.SKIN); out[1] = t; out[2] = s; out[3] = 0.55 + 0.45 * Math.max(0, (s + 1) * 0.5);
  }, {
    power: 2.05,
    bulge: hi ? (p, t, c, s) => {
      let m = 1;
      if (grooves && s < -0.35 && p[2] > -L * 0.05 && p[2] < L * 0.46) m -= 0.022 * Math.pow(Math.abs(Math.sin(Math.atan2(s, c) * 18)), 3);
      return m;
    } : undefined,
    capStart: 0.5, capEnd: 0.9,
  });
  // mouth line (dark) and eyes
  for (const side of [1, -1]) {
    eye(mb, [side * R * 0.62, -R * 0.12, L * 0.38], R * 0.07, [side, 0.1, 0.25].map((v, i, a) => v / Math.hypot(...a)), 1, hi);
    if (hi) {
      const mc = [];
      for (let i = 0; i <= 6; i++) { const t = i / 6; const z = L * (0.49 - t * 0.14); const rr = R * lerp(0.38, 0.84, Math.sqrt(t)); mc.push({ x: side * rr * 0.92, z, y: -R * 0.28 - t * R * 0.05, w: R * 0.018, ht: R * 0.012 }); }
      bodyLoft(mb, mc, 10, 5, (z, o) => { o[0] = 1; o[1] = 1; o[2] = 1; }, (i, t, s, out) => { out[0] = code(PART.HEAD, MAT.DARK); out[1] = 1; out[2] = 0; out[3] = 0.4; }, { capStart: 0.5, capEnd: 0.5 });
    }
  }
  // pectoral fins (long, humpback-like, knobbly leading edge)
  const fin = (side, bone, z0, len, root, droop) => {
    const pts = [], w = [], ht = [];
    const n = hi ? 16 : 5;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([side * (R * 0.7 + len * t * 0.92), -R * 0.35 - len * t * droop, z0 - len * t * 0.38]);
      w.push(Math.max(0.05, root * (1 - t * 0.75) * (t > 0.85 ? Math.sqrt(Math.max(0.05, 1 - (t - 0.85) / 0.16)) : 1)));
      ht.push(Math.max(0.03, root * 0.14 * (1 - t * 0.8)));
    }
    mb.loft({ pts, w, ht, hb: ht, segs: hi ? 10 : 5, up: [0, 1, 0],
      skin: (i, t, out) => { const k = sstep(0, 0.2, t); out[0] = bone; out[1] = 0; out[2] = k; },
      info: (i, t, s, out) => { out[0] = code(PART.FIN, MAT.SKIN); out[1] = t; out[2] = s * 0.8; out[3] = 0.8; },
      bulge: hi ? (i, t, c, s) => 1 + 0.07 * Math.max(0, side > 0 ? -c : c) * Math.max(0, Math.sin(t * 40)) : undefined,
      capStart: 0.5, capEnd: 0.5 });
  };
  for (const side of [1, -1]) {
    fin(side, side > 0 ? rig.extra.finL : rig.extra.finR, L * 0.14, g.finLen, R * 0.42, 0.25);
    if (g.fin2) fin(side, side > 0 ? rig.extra.fin2L : rig.extra.fin2R, -L * 0.12, g.finLen * 0.55, R * 0.3, 0.15);
  }
  // flukes (horizontal)
  const last = rig.tail[rig.tail.length - 1];
  for (const side of [1, -1]) {
    const pts = [], w = [], ht = [];
    const n = hi ? 14 : 5;
    const span = g.fluke;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([side * span * t, 0, -L * 0.47 - span * 0.35 * Math.pow(t, 1.4)]);
      w.push(Math.max(0.05, R * 0.3 * (1 - t * 0.55) * (t > 0.8 ? Math.sqrt(Math.max(0.05, 1 - (t - 0.8) / 0.21)) : 1)));
      ht.push(Math.max(0.03, R * 0.05 * (1 - t * 0.7)));
    }
    mb.loft({ pts, w, ht, hb: ht, segs: hi ? 10 : 5, up: [0, 1, 0],
      skin: (i, t, out) => { out[0] = last; out[1] = last; out[2] = 1; },
      info: (i, t, s, out) => { out[0] = code(PART.FIN, MAT.SKIN); out[1] = t; out[2] = s; out[3] = 0.85; }, capStart: 0.3, capEnd: 0.5 });
  }
  // dorsal ridge (plates / glowing nodules)
  if (g.ridge && hi) {
    for (let k = 0; k < g.ridge; k++) {
      const t = k / (g.ridge - 1);
      const z = L * (0.25 - t * 0.55);
      const rr = R * (1 - Math.pow(Math.abs(z / L - 0.05) * 1.8, 2)) * 0.95;
      const base = [0, Math.max(R * 0.1, rr * g.flatK), z];
      const size = R * 0.16 * (1 - t * 0.5);
      const pc = [];
      for (let i = 0; i <= 4; i++) { const u = i / 4; pc.push({ z: base[2] - u * size * 0.6, y: base[1] - size * 0.3 + u * size, w: size * 0.12 * (1 - u * 0.8), ht: size * 0.35 * (1 - u * 0.85) }); }
      bodyLoft(mb, pc, 6, 6, skinZ, (i, u, s, out) => { out[0] = code(PART.SPIKE, k % 2 ? MAT.KERATIN : MAT.GLOW); out[1] = u; out[2] = 1; out[3] = 1; }, { capStart: false, capEnd: 0.4 });
    }
  }
}

function fishGeo(mb, rig, hi) {
  const g = rig.g, L = g.L, H = g.H * L, W = g.W * L;
  const skinZ = zSkinner(rig, L * 0.06);
  const prof = [[-0.44, 0.12, 0.14], [-0.34, 0.3, 0.3], [-0.15, 0.8, 0.85], [0.05, 1, 1], [0.22, 0.9, 0.92], [0.36, 0.6, 0.62], [0.46, 0.25, 0.25]];
  bodyLoft(mb, prof.map(([t, w, h]) => ({ z: t * L, y: 0, w: W * w, ht: H * 0.5 * h, hb: H * 0.5 * h })), hi ? 24 : 8, hi ? 12 : 6, skinZ,
    (i, t, s, out, c, p) => { out[0] = code(p[2] > L * 0.25 ? PART.HEAD : PART.BODY, MAT.SKIN); out[1] = t; out[2] = s; out[3] = 0.75 + 0.25 * s; }, { capStart: 0.5, capEnd: 0.8, power: 2.2 });
  for (const side of [1, -1]) eye(mb, [side * W * 0.62, H * 0.08, L * 0.33], H * 0.09, [side, 0.1, 0.3].map((v, i, a) => v / Math.hypot(...a)), 1, hi);
  // caudal fin (vertical plane: loft along -z with tall thin sections)
  const last = rig.tail[rig.tail.length - 1];
  const tf = g.tail;
  for (const up of [1, -1]) {
    const pts = [], w = [], ht = [];
    const n = hi ? 8 : 3;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const rake = tf === 'fork' || tf === 'lunate' ? 1 : 0.4;
      pts.push([0, up * H * 0.62 * t, -L * 0.4 - L * 0.14 * t * rake - (tf === 'lunate' ? L * 0.05 * t * t : 0)]);
      w.push(W * 0.1 * (1 - t * 0.6) + 0.001);
      ht.push(Math.max(0.002, L * 0.07 * (tf === 'fan' ? 1.1 : 0.85) * (1 - t * (tf === 'fork' ? 0.75 : 0.35))));
    }
    mb.loft({ pts, w, ht, hb: ht, segs: hi ? 8 : 4, up: [0, 0, 1],
      skin: (i, t, out) => { out[0] = last; out[1] = last; out[2] = 1; },
      info: (i, t, s, out) => { out[0] = code(PART.FIN, MAT.MEMBRANE); out[1] = t; out[2] = 0.3; out[3] = 0.9; }, capStart: false, capEnd: 0.4 });
  }
  // dorsal fin
  const dp = [], dw = [], dh = [];
  for (let i = 0; i <= 6; i++) { const t = i / 6; dp.push([0, H * 0.45 + H * 0.35 * g.dorsal * Math.sin(Math.PI * t) * (1 - t * 0.3), L * (0.12 - t * 0.35)]); dw.push(W * 0.08 + 0.001); dh.push(Math.max(0.002, H * 0.12 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05)))); }
  mb.loft({ pts: dp, w: dw, ht: dh, hb: dh, segs: hi ? 6 : 3, up: [0, 0, 1], skin: (i, t, out) => skinZ(dp[i][2], out),
    info: (i, t, s, out) => { out[0] = code(PART.FIN, MAT.MEMBRANE); out[1] = t; out[2] = 0.9; out[3] = 1; }, capStart: 0.3, capEnd: 0.3 });
}

function jellyGeo(mb, rig, hi) {
  const g = rig.g, R = g.R, H = g.H;
  const bell = rig.extra.bell, rim = rig.extra.rim;
  const segs = hi ? 36 : 14;
  // outer dome → rim → inner subumbrella (single lathe, double-walled bell)
  const prof = [];
  const no = hi ? 12 : 6;
  for (let i = 0; i <= no; i++) { const a = (i / no) * Math.PI * 0.5; prof.push([Math.sin(a) * R * (1 + 0.08 * Math.sin(a * 2)), H * 0.35 + Math.cos(a) * H * 0.65, i / no]); }
  prof.push([R * 1.02, H * 0.3, 1.02]);
  const ni = hi ? 6 : 3;
  for (let i = 1; i <= ni; i++) { const a = (1 - i / ni) * Math.PI * 0.5; prof.push([Math.sin(a) * R * 0.88, H * 0.36 + Math.cos(a) * H * 0.45, 1 + i / ni]); }
  const lobes = g.lobes;
  mb.lathe([0, 0, 0], [0, 1, 0], prof.map((p) => [Math.max(1e-3, p[0]), p[1]]), segs,
    (i, k, out) => {
      const v = prof[i][2];
      out[0] = rim; out[1] = bell; out[2] = sstep(0.35, 0.95, v > 1 ? 2 - v : v);
    },
    (i, k, out) => { const v = prof[i][2]; out[0] = code(PART.BODY, MAT.JELLY); out[1] = v > 1 ? 2 - v : v; out[2] = v > 1 ? -0.5 : 1 - v; out[3] = 1; }, false);
  // scalloped rim lobes: small flaps
  if (hi) {
    for (let l = 0; l < lobes; l++) {
      const a = (l / lobes) * Math.PI * 2;
      const c = [Math.sin(a) * R * 1.0, H * 0.28, Math.cos(a) * R * 1.0];
      mb.ellipsoid(c, R * 0.12, H * 0.05, R * 0.06, 8, 4, (t, o) => { o[0] = rim; o[1] = rim; o[2] = 1; },
        (t, s, o) => { o[0] = code(PART.FIN, MAT.GLOW); o[1] = 1; o[2] = 0; o[3] = 1; },
        [[Math.cos(a), 0, -Math.sin(a)], [0, 1, 0], [Math.sin(a), 0, Math.cos(a)]]);
    }
  }
  // tentacles
  const nT = hi ? g.tent : Math.ceil(g.tent / 2);
  const Lt = g.tentLen;
  for (let k = 0; k < nT; k++) {
    const a = (k / nT) * Math.PI * 2 + 0.2;
    const chain = k % 2 ? rig.extra.tentA : rig.extra.tentB;
    const pts = [], w = [];
    const n = hi ? 16 : 5;
    const rr = R * 0.82;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([Math.sin(a) * rr * (1 - t * 0.35), H * 0.3 - Lt * t * (0.85 + 0.15 * ((k * 7) % 3) / 2), Math.cos(a) * rr * (1 - t * 0.35)]);
      w.push(R * 0.025 * (1 - t * 0.8) + 0.004);
    }
    mb.loft({ pts, w, segs: hi ? 5 : 3, up: [1, 0, 0],
      skin: (i, t, out) => chainSkin(t, [0.05, 0.36, 0.7], [rig.extra.bell, chain[0], chain[1], chain[2]], 0.08, out),
      info: (i, t, s, out) => { out[0] = code(PART.TENTACLE, MAT.GLOW); out[1] = t; out[2] = 0; out[3] = 1; }, capEnd: true });
  }
  // oral arms: frilly ribbons
  for (let k = 0; k < g.arms; k++) {
    const a = (k / g.arms) * Math.PI * 2;
    const chain = k % 2 ? rig.extra.tentB : rig.extra.tentA;
    const pts = [], w = [], ht = [];
    const n = hi ? 14 : 5;
    const La = Lt * 0.5;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([Math.sin(a) * R * 0.2 + Math.sin(t * 9 + k) * R * 0.08, H * 0.35 - La * t, Math.cos(a) * R * 0.2 + Math.cos(t * 9 + k) * R * 0.08]);
      w.push(R * 0.11 * (1 - t * 0.6)); ht.push(R * 0.035 * (1 - t * 0.5));
    }
    mb.loft({ pts, w, ht, hb: ht, segs: hi ? 8 : 4, up: [Math.cos(a), 0, -Math.sin(a)],
      skin: (i, t, out) => chainSkin(t, [0.1, 0.5], [rig.extra.bell, chain[0], chain[1]], 0.1, out),
      bulge: hi ? (i, t, c, s) => 1 + 0.35 * Math.abs(Math.sin(t * 30 + c * 3)) * Math.abs(c) : undefined,
      info: (i, t, s, out) => { out[0] = code(PART.TENTACLE, MAT.JELLY); out[1] = t; out[2] = 0; out[3] = 1; }, capEnd: true });
  }
}
