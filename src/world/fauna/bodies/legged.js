// Legged creatures: quadruped grazers, long-necked giants, hexapods, bipedal hoppers, critters.
// genome (deterministic from RNG) → rig (bones, pivots, legs, chains) + geometry (LOD0, LOD1).
//
// Body frame: +Z forward, +Y up, +X = creature's left, origin on the ground under the body.
// Bones: 0 root · 1 pelvis · 2 spine · 3 chest · 4 neck1 · 5 neck2 · 6 head · 7 earL · 8 earR ·
//        9 tail1 · 10 tail2 · 11 tail3 · then 3 bones per leg (upper, lower, foot) · jaw/antennae extras.
import { MeshBuilder, spline, chainSkin, PART, MAT } from '../MeshBuilder.js';

const B = { ROOT: 0, PELVIS: 1, SPINE: 2, CHEST: 3, NECK1: 4, NECK2: 5, HEAD: 6, EARL: 7, EARR: 8, TAIL1: 9, TAIL2: 10, TAIL3: 11 };
export const LEGGED_BONES = B;

const r2 = (rng, a, b) => rng.range(a, b);

/** Genome for a legged archetype. kind: grazer | giant | hexapod | hopper | critter */
export function leggedGenome(rng, kind, style = {}) {
  const g = { kind };
  const exotic = style.exotic ?? 0;       // 0 naturalistic … 1 wild (NMS/Rick&Morty)
  if (kind === 'grazer') {
    g.S = r2(rng, 1.0, 2.1);
    g.legFrac = r2(rng, 0.5, 0.62);
    g.bodyLen = r2(rng, 0.78, 1.12);
    g.depthK = r2(rng, 0.9, 1.05);
    g.widthK = r2(rng, 0.36, 0.5);
    g.neckLen = r2(rng, 0.38, 0.72);
    g.neckAng = r2(rng, 32, 58);
    g.neckW = r2(rng, 0.2, 0.3);
    g.headLen = r2(rng, 0.3, 0.42);
    g.headW = r2(rng, 0.17, 0.24);
    g.headH = r2(rng, 0.2, 0.27);
    g.headPitch = r2(rng, 30, 48);
    g.snout = r2(rng, 0.45, 0.75);
    g.tailLen = rng.pick([r2(rng, 0.12, 0.25), r2(rng, 0.3, 0.6), r2(rng, 0.55, 0.9)]);
    g.tailW = r2(rng, 0.06, 0.1);
    g.tailDroop = r2(rng, 40, 75);
    g.tuft = rng.chance(0.45);
    g.hump = rng.chance(0.25) ? r2(rng, 0.15, 0.4) : r2(rng, 0, 0.08);
    g.belly = r2(rng, 0.0, 0.15);
    g.legThick = r2(rng, 0.85, 1.25);
    g.foot = 'hoof';
    g.ears = { type: rng.weighted([['leaf', 5], ['long', 1.5 + exotic * 2], ['round', 1], ['none', 0.3]]), len: r2(rng, 0.35, 0.8) };
    g.horns = { type: rng.weighted([['none', 2.2], ['spike', 1], ['curve', 2], ['lyre', 1.2], ['antler', 1.6], ['spiral', 1], ['nasal', 0.4 + exotic], ['crest', 0.3 + exotic * 1.2]]), len: r2(rng, 0.35, 0.85), spread: r2(rng, 0.3, 0.9) };
    g.spikes = rng.chance(0.12 + exotic * 0.3) ? { n: rng.int(5, 11), size: r2(rng, 0.08, 0.2), plates: rng.chance(0.4) } : null;
    g.eyeK = r2(rng, 0.2, 0.28);
    g.pairs = 2;
    g.walkSpeed = r2(rng, 1.1, 1.6); g.runSpeed = r2(rng, 7, 11);
  } else if (kind === 'giant') {
    g.S = r2(rng, 4.2, 8.5);
    g.legFrac = r2(rng, 0.5, 0.6);
    g.bodyLen = r2(rng, 0.95, 1.25);
    g.depthK = r2(rng, 0.95, 1.1);
    g.widthK = r2(rng, 0.5, 0.62);
    g.neckLen = r2(rng, 1.2, 2.1);
    g.neckAng = r2(rng, 42, 62);
    g.neckW = r2(rng, 0.16, 0.22);
    g.headLen = r2(rng, 0.17, 0.25);
    g.headW = r2(rng, 0.2, 0.26);
    g.headH = r2(rng, 0.22, 0.28);
    g.headPitch = r2(rng, 15, 35);
    g.snout = r2(rng, 0.5, 0.8);
    g.tailLen = r2(rng, 1.2, 2.0);
    g.tailW = r2(rng, 0.12, 0.17);
    g.tailDroop = r2(rng, 8, 22);
    g.tuft = false;
    g.hump = r2(rng, 0.05, 0.25);
    g.belly = r2(rng, 0.05, 0.2);
    g.legThick = r2(rng, 1.5, 1.9);
    g.foot = 'pad';
    g.ears = { type: rng.weighted([['none', 3], ['fan', 1 + exotic], ['round', 0.6]]), len: r2(rng, 0.4, 0.8) };
    g.horns = { type: rng.weighted([['none', 3], ['crest', 1 + exotic * 2], ['spike', 0.6]]), len: r2(rng, 0.3, 0.6), spread: 0.4 };
    g.spikes = rng.chance(0.35 + exotic * 0.3) ? { n: rng.int(9, 16), size: r2(rng, 0.05, 0.1), plates: rng.chance(0.6) } : null;
    g.eyeK = r2(rng, 0.13, 0.18);
    g.pairs = 2;
    g.walkSpeed = r2(rng, 1.3, 2.0); g.runSpeed = r2(rng, 3.0, 4.5);
  } else if (kind === 'hexapod') {
    g.S = r2(rng, 0.8, 1.7);
    g.legFrac = r2(rng, 0.32, 0.42);
    g.bodyLen = r2(rng, 1.1, 1.6);
    g.depthK = r2(rng, 0.85, 1.0);
    g.widthK = r2(rng, 0.55, 0.75);
    g.neckLen = r2(rng, 0.08, 0.18);
    g.neckAng = r2(rng, 5, 20);
    g.neckW = r2(rng, 0.28, 0.4);
    g.headLen = r2(rng, 0.3, 0.45);
    g.headW = r2(rng, 0.24, 0.32);
    g.headH = r2(rng, 0.2, 0.26);
    g.headPitch = r2(rng, 5, 25);
    g.snout = r2(rng, 0.55, 0.9);
    g.tailLen = r2(rng, 0.05, 0.35);
    g.tailW = r2(rng, 0.1, 0.18);
    g.tailDroop = r2(rng, 10, 35);
    g.tuft = false;
    g.hump = r2(rng, 0.1, 0.35);
    g.belly = r2(rng, 0, 0.1);
    g.legThick = r2(rng, 0.75, 1.0);
    g.foot = 'claw';
    g.ears = { type: 'antenna', len: r2(rng, 0.5, 1.2) };
    g.horns = { type: rng.weighted([['mandible', 3], ['nasal', 1], ['none', 1]]), len: r2(rng, 0.25, 0.5), spread: 0.5 };
    g.spikes = rng.chance(0.3) ? { n: rng.int(4, 8), size: r2(rng, 0.08, 0.16), plates: true } : null;
    g.eyeK = r2(rng, 0.3, 0.42);
    g.segments = rng.int(4, 7);
    g.pairs = 3;
    g.walkSpeed = r2(rng, 1.2, 2.2); g.runSpeed = r2(rng, 4.5, 7);
  } else if (kind === 'hopper') {
    g.S = r2(rng, 0.55, 1.2);
    g.legFrac = r2(rng, 0.4, 0.5);
    g.bodyLen = r2(rng, 0.55, 0.75);
    g.depthK = r2(rng, 1.0, 1.2);
    g.widthK = r2(rng, 0.45, 0.6);
    g.neckLen = r2(rng, 0.12, 0.22);
    g.neckAng = r2(rng, 55, 75);
    g.neckW = r2(rng, 0.3, 0.38);
    g.headLen = r2(rng, 0.34, 0.44);
    g.headW = r2(rng, 0.25, 0.32);
    g.headH = r2(rng, 0.26, 0.32);
    g.headPitch = r2(rng, 5, 25);
    g.snout = r2(rng, 0.3, 0.6);
    g.tailLen = r2(rng, 0.6, 1.1);
    g.tailW = r2(rng, 0.1, 0.16);
    g.tailDroop = r2(rng, 15, 35);
    g.tuft = rng.chance(0.5);
    g.hump = 0; g.belly = r2(rng, 0.1, 0.25);
    g.legThick = r2(rng, 1.1, 1.4);
    g.foot = 'longfoot';
    g.ears = { type: rng.weighted([['long', 3], ['fan', 1 + exotic], ['leaf', 1]]), len: r2(rng, 0.7, 1.3) };
    g.horns = { type: rng.weighted([['none', 4], ['spike', 0.5 + exotic], ['antler', 0.5]]), len: r2(rng, 0.2, 0.45), spread: 0.4 };
    g.spikes = null;
    g.eyeK = r2(rng, 0.26, 0.34);
    g.pairs = 1; g.arms = true; g.incline = r2(rng, 30, 48);
    g.walkSpeed = r2(rng, 1.8, 2.6); g.runSpeed = r2(rng, 6, 9);
  } else { // critter
    g.S = r2(rng, 0.2, 0.42);
    g.legFrac = r2(rng, 0.3, 0.42);
    g.bodyLen = r2(rng, 1.2, 1.7);
    g.depthK = r2(rng, 0.95, 1.1);
    g.widthK = r2(rng, 0.45, 0.6);
    g.neckLen = r2(rng, 0.12, 0.25);
    g.neckAng = r2(rng, 15, 35);
    g.neckW = r2(rng, 0.32, 0.4);
    g.headLen = r2(rng, 0.45, 0.6);
    g.headW = r2(rng, 0.24, 0.3);
    g.headH = r2(rng, 0.24, 0.3);
    g.headPitch = r2(rng, 5, 20);
    g.snout = r2(rng, 0.35, 0.7);
    g.tailLen = r2(rng, 0.8, 1.6);
    g.tailW = r2(rng, 0.1, 0.2);
    g.tailDroop = r2(rng, -10, 25);
    g.tuft = rng.chance(0.4);
    g.hump = 0; g.belly = r2(rng, 0.05, 0.2);
    g.legThick = r2(rng, 1.0, 1.3);
    g.foot = 'paw';
    g.ears = { type: rng.weighted([['round', 2], ['long', 1.5], ['leaf', 1], ['fan', exotic]]), len: r2(rng, 0.5, 1.1) };
    g.horns = { type: 'none', len: 0, spread: 0 };
    g.spikes = rng.chance(0.15 + exotic * 0.2) ? { n: rng.int(6, 12), size: r2(rng, 0.1, 0.2), plates: false } : null;
    g.eyeK = r2(rng, 0.26, 0.34);
    g.pairs = 2;
    g.walkSpeed = r2(rng, 0.8, 1.2); g.runSpeed = r2(rng, 4, 6);
  }
  return g;
}

// --------------------------------------------------------------------------------------------
// Rig + geometry
// --------------------------------------------------------------------------------------------

const V = (x, y, z) => [x, y, z];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const DEG = Math.PI / 180;

/** Build rig description (bones + legs + chains) from a genome. Deterministic. */
export function leggedRig(g) {
  const S = g.S;
  const hop = g.kind === 'hopper', hexa = g.kind === 'hexapod', giant = g.kind === 'giant';
  const yB = S * g.legFrac;                       // belly line at chest
  const D = (S - yB) * g.depthK;                  // torso depth
  const W = D * g.widthK;                         // torso half width
  const BL = S * g.bodyLen;
  let hipP, shP;                                  // hip & shoulder joint centers (x=0)
  if (hop) {
    const inc = g.incline * DEG;
    hipP = V(0, yB + D * 0.45, -BL * 0.25);
    shP = add(hipP, V(0, Math.sin(inc), Math.cos(inc)), BL);
  } else {
    hipP = V(0, yB + D * 0.55, -BL / 2);
    shP = V(0, yB + D * 0.52, BL / 2);
  }
  const bodyAxis = norm(sub(shP, hipP));
  const midP = lerp3(hipP, shP, 0.5);
  // neck
  const na = g.neckAng * DEG;
  const neckDir = hop ? norm([0, Math.sin(na), Math.cos(na)]) : norm([0, Math.sin(na), Math.cos(na)]);
  const neckBase = add(add(shP, bodyAxis, D * (hexa ? 0.25 : 0.32)), V(0, 1, 0), D * (hexa ? 0.05 : 0.18));
  const Ln = S * g.neckLen;
  const neckMid = add(neckBase, neckDir, Ln * 0.5);
  const headP = add(neckBase, neckDir, Ln);
  const hp = g.headPitch * DEG;
  const headDir = norm([0, -Math.sin(hp), Math.cos(hp)]);
  const Lh = S * g.headLen;
  // tail
  const td = g.tailDroop * DEG;
  const tailBase = add(add(hipP, bodyAxis, hexa ? -D * 0.75 : -D * 0.56), V(0, 1, 0), hexa ? D * 0.02 : D * 0.2);
  const Lt = S * g.tailLen;
  const tailDir0 = norm(add(V(0, -Math.sin(td), -Math.cos(td)), bodyAxis, 0));
  const tailPts = [];
  for (let i = 0; i <= 3; i++) {
    const t = i / 3;
    const droop = td + (hop ? -0.25 : 0.35) * t * (g.tailDroop > 0 ? 1 : -1);
    const dir = norm([0, -Math.sin(droop), -Math.cos(droop)]);
    tailPts.push(i === 0 ? tailBase : add(tailPts[i - 1], dir, Lt / 3));
  }
  void tailDir0;

  const bones = [];
  const bone = (name, parent, pivot) => { bones.push({ name, parent, pivot }); return bones.length - 1; };
  bone('root', -1, V(0, 0, 0));
  bone('pelvis', 0, hipP);
  bone('spine', 1, midP);
  bone('chest', 2, shP);
  bone('neck1', 3, neckBase);
  bone('neck2', 4, neckMid);
  bone('head', 5, headP);
  // ears / antennae attach at the top-back of the head (head frame: headDir forward, headUp up)
  const headUp = norm([0, Math.cos(hp), Math.sin(hp)]);
  const hwAbs = S * g.headW * (giant ? 0.45 : 1), hhAbs = S * g.headH * (giant ? 0.45 : 1);
  const earBase = (side) => add(add(add(headP, headDir, Lh * (hexa ? 0.55 : 0.1)), headUp, hhAbs * (hexa ? 0.55 : 0.78)), V(side, 0, 0), hwAbs * (hexa ? 0.35 : 0.6));
  bone('earL', 6, earBase(1));
  bone('earR', 6, earBase(-1));
  bone('tail1', 1, tailPts[0]);
  bone('tail2', 9, tailPts[1]);
  bone('tail3', 10, tailPts[2]);

  // legs
  const legs = [];
  const pairs = g.pairs;
  const lt = g.legThick;
  for (let p = 0; p < pairs; p++) {
    for (const side of [1, -1]) {
      const front = p === pairs - 1 && !hop;
      const hind = !front;
      let root, knee, ankle, contact, pole, parent;
      const k = hexa ? p / (pairs - 1) : (front ? 1 : 0);   // 0 = rear … 1 = front
      if (hexa) {
        const z = hipP[2] + (shP[2] - hipP[2]) * (0.25 + 0.6 * k);
        const y = yB + D * 0.3;
        root = V(side * W * 0.6, y, z);
        const span = S * 0.95 + D * 0.3;
        const zSplay = (k - 0.5) * S * 0.9;
        knee = V(side * (W + span * 0.42), y + S * 0.28, z + zSplay * 0.4);
        ankle = V(side * (W + span * 0.85), S * 0.12, z + zSplay * 0.85);
        contact = V(side * (W + span * 0.95), 0, z + zSplay);
        pole = V(side * 0.3, 1, 0);
        parent = k > 0.6 ? B.CHEST : k > 0.3 ? B.SPINE : B.PELVIS;
      } else if (hop) {
        // big digitigrade hind legs, long feet
        root = V(side * W * 0.6, hipP[1] - D * 0.05, hipP[2] + D * 0.1);
        knee = V(side * W * 0.75, yB * 0.62, hipP[2] + D * 0.55);
        ankle = V(side * W * 0.7, S * 0.16, hipP[2] - D * 0.35);
        contact = V(side * W * 0.7, 0, hipP[2] + D * 0.75);
        pole = V(0, 0, 1);
        parent = B.PELVIS;
      } else if (giant) {
        const z = front ? shP[2] - D * 0.05 : hipP[2] + D * 0.05;
        const x = side * W * 0.62;
        root = V(x, (front ? shP[1] : hipP[1]) - D * 0.05, z);
        knee = V(x, yB * 0.52, z + (front ? -D * 0.04 : D * 0.08));
        ankle = V(x, S * 0.07, z + (front ? D * 0.02 : -D * 0.02));
        contact = V(x, 0, z + D * 0.05);
        pole = front ? V(0, 0, -1) : V(0, 0, 1);
        parent = front ? B.CHEST : B.PELVIS;
      } else if (front) {
        const z = shP[2] + D * 0.02;
        const x = side * W * 0.58;
        root = V(x, shP[1] - D * 0.1, z - D * 0.05);
        knee = V(x, yB + D * 0.02, z - D * 0.2);                  // elbow (points back)
        ankle = V(x, yB * 0.42, z - D * 0.12);                    // carpus
        contact = V(x, 0, z - D * 0.05);
        pole = V(0, 0, -1);
        parent = B.CHEST;
      } else {
        const z = hipP[2] + D * 0.05;
        const x = side * W * 0.55;
        root = V(x, hipP[1] - D * 0.05, z);
        knee = V(x, yB + D * 0.02, z + D * 0.38);                 // stifle (points forward)
        ankle = V(x, yB * (g.kind === 'critter' ? 0.3 : 0.4), z - D * 0.32);   // hock
        contact = V(x, 0, z - D * 0.2);
        pole = V(0, 0, 1);
        parent = B.PELVIS;
      }
      const upper = bone(`leg${legs.length}u`, parent, root);
      const lower = bone(`leg${legs.length}l`, upper, knee);
      const foot = bone(`leg${legs.length}f`, lower, ankle);
      const L1 = len(sub(knee, root)), L2 = len(sub(ankle, knee));
      legs.push({ side, front, hind, pair: p, k, root, knee, ankle, contact, pole, parent, upper, lower, foot, L1, L2, thick: lt });
    }
  }
  // arms (hoppers): small FK limbs
  const arms = [];
  if (g.arms) {
    for (const side of [1, -1]) {
      const root = add(add(shP, bodyAxis, -D * 0.2), V(side * W * 0.7, -D * 0.2, 0), 1);
      const elbow = add(root, norm([side * 0.15, -0.8, 0.45]), S * 0.14);
      const hand = add(elbow, norm([0, -0.35, 0.95]), S * 0.12);
      const up = bone(`arm${arms.length}u`, B.CHEST, root);
      const lo = bone(`arm${arms.length}l`, up, elbow);
      arms.push({ side, root, elbow, hand, upper: up, lower: lo });
    }
  }
  const pivots = new Float32Array(bones.length * 3);
  bones.forEach((b, i) => { pivots[i * 3] = b.pivot[0]; pivots[i * 3 + 1] = b.pivot[1]; pivots[i * 3 + 2] = b.pivot[2]; });
  return {
    g, S, D, W, BL, yB, hipP, shP, midP, bodyAxis, neckBase, neckMid, neckDir, headP, headDir, headUp, hwAbs, hhAbs, Lh, Ln, tailPts, Lt,
    bones, pivots, legs, arms, nb: bones.length,
    height: Math.max(S, headP[1] + S * g.headH * 0.5),
    length: len(sub(headP, tailPts[3])) + Lh,
  };
}

/** Geometry for a legged rig. lod 0 = hero detail, 1 = far. */
export function leggedGeometry(rig, lod = 0) {
  const g = rig.g, S = rig.S, D = rig.D, W = rig.W;
  const hexa = g.kind === 'hexapod', giant = g.kind === 'giant', hop = g.kind === 'hopper';
  const mb = new MeshBuilder();
  const hi = lod === 0;
  const skin3 = [0, 0, 1];
  const P = PART, M = MAT;
  const code = (part, mat) => part * 8 + mat;

  // ------------------------------------------------------------------ main body loft (tail tip → neck top)
  const tp = rig.tailPts;
  const hipP = rig.hipP, shP = rig.shP, ax = rig.bodyAxis;
  const up = V(0, 1, 0);
  const tw = D * g.tailW * (giant ? 1.9 : 1.0) * (hop ? 1.6 : 1.0);
  const nW = D * g.neckW * (giant ? 1.5 : 1);
  const hump = g.hump, belly = g.belly;
  const ctrl = [];
  const C = (p, w, ht, hb) => ctrl.push({ p, w, ht, hb });
  // torso (rounded rear → chest)
  if (hexa) {
    // abdomen segments (bulbous) → thorax
    C(add(hipP, ax, -D * 0.95), W * 0.2, D * 0.14, D * 0.12);
    C(add(hipP, ax, -D * 0.7), W * 0.58, D * 0.36, D * 0.3);
    C(add(hipP, ax, -D * 0.2), W * 0.9, D * 0.5, D * 0.4);
    C(add(hipP, ax, D * 0.25), W * 1.0, D * 0.55, D * 0.42);
    C(lerp3(hipP, shP, 0.55), W * 0.78, D * 0.45, D * 0.36);
    C(add(shP, ax, -D * 0.1), W * 0.85, D * 0.5 + hump * D * 0.3, D * 0.4);
    C(add(shP, ax, D * 0.2), W * 0.7, D * 0.42, D * 0.36);
  } else {
    C(add(add(hipP, ax, -D * 0.6), up, D * 0.02), W * 0.3, D * 0.2, D * 0.2);
    C(add(add(hipP, ax, -D * 0.5), up, D * 0.04), W * 0.62, D * 0.36, D * 0.34);
    C(add(add(hipP, ax, -D * 0.28), up, D * 0.02), W * 0.84, D * 0.46, D * 0.42);
    C(add(hipP, ax, -D * 0.02), W * 0.92, D * 0.5, D * 0.46);
    C(add(lerp3(hipP, shP, 0.5), up, -D * 0.05), W * 0.98, D * 0.47, D * 0.52 * (1 + belly));
    C(add(add(shP, ax, -D * 0.2), up, hump * D * 0.12), W * 1.0, D * (0.52 + hump * 0.3), D * 0.5);
    C(add(add(shP, ax, D * 0.18), up, D * 0.08 + hump * D * 0.08), W * 0.78, D * (0.46 + hump * 0.15), D * 0.44);
  }
  // neck
  const nb = rig.neckBase, nd = rig.neckDir, Ln = rig.Ln;
  C(add(nb, nd, -D * 0.02), nW * 1.45, nW * 1.7, nW * 1.6);
  C(add(nb, nd, Ln * 0.3), nW * 1.12, nW * 1.35, nW * 1.25);
  C(add(nb, nd, Ln * 0.65), nW * 0.98, nW * 1.18, nW * 1.1);
  C(add(nb, nd, Ln * 0.98), nW * 0.9, nW * 1.08, nW * 1.02);
  C(add(add(nb, nd, Ln), rig.headDir, rig.Lh * 0.1), nW * 0.72, nW * 0.85, nW * 0.8);

  const nMain = hi ? (giant ? 110 : 84) : 22;
  const sp = spline(ctrl, nMain, ['w', 'ht', 'hb']);
  // joints (arc length) at bone pivots, found by nearest sample
  const nearestS = (pt) => { let best = 0, bd = Infinity; sp.pts.forEach((q, i) => { const d = len(sub(q, pt)); if (d < bd) { bd = d; best = i; } }); return sp.s[best]; };
  const jSpine = nearestS(rig.midP), jChest = nearestS(shP), jNeck1 = nearestS(nb), jNeck2 = nearestS(rig.neckMid), jHead = nearestS(rig.headP);
  const jTail1 = 0;
  const joints = [jSpine, jChest, jNeck1, jNeck2, jHead];
  const owners = [B.PELVIS, B.SPINE, B.CHEST, B.NECK1, B.NECK2, B.HEAD];
  const blends = [D * 0.4, D * 0.4, nW * 1.6, nW * 1.4, nW * 0.7];
  const segMain = hi ? 22 : 9;
  const carapace = hexa;
  mb.loft({
    pts: sp.pts, w: sp.w, ht: sp.ht, hb: sp.hb, segs: segMain, power: hexa ? 2.3 : 2.15, up: [0, 1, 0],
    skin: (i, t, out) => chainSkin(sp.s[i], joints, owners, blends, out),
    info: (i, t, s, out) => {
      const ao = 0.5 + 0.5 * Math.min(1, Math.max(0, (s + 1) / 1.3));
      out[0] = code(P.BODY, carapace && s > -0.25 ? M.CARAPACE : M.SKIN);
      out[1] = t * 0.85 + 0.1; out[2] = s; out[3] = ao;
    },
    bulge: hexa && hi ? (i, t, c, s) => {
      // segmented abdomen ridges
      const sArc = sp.s[i];
      if (sArc < jTail1 || sArc > jChest) return 1;
      const seg = Math.cos((sArc - jTail1) / (jChest - jTail1) * Math.PI * 2 * (g.segments || 5));
      return 1 + 0.035 * seg * (s > -0.3 ? 1 : 0.4);
    } : (g.spikes?.plates && hi ? null : null),
    capStart: 0.55, capEnd: 0.5,
  });

  // ------------------------------------------------------------------ tail (separate loft emerging from the rump)
  if (rig.Lt > 0.02) {
    const inside = add(add(tp[0], ax, D * 0.22), up, -D * 0.06);
    const tc = [
      { p: inside, w: tw * 1.25, ht: tw * 1.3 },
      { p: tp[0], w: tw * 1.1, ht: tw * 1.15 },
      { p: tp[1], w: tw * 0.8, ht: tw * 0.82 },
      { p: tp[2], w: tw * 0.56, ht: tw * 0.56 },
      { p: lerp3(tp[2], tp[3], 0.55), w: tw * 0.4, ht: tw * 0.4 },
      { p: tp[3], w: tw * 0.2, ht: tw * 0.2 },
    ];
    if (g.tuft) { tc[4].w *= 1.6; tc[4].ht *= 1.6; tc[5].w = tw * 0.9; tc[5].ht = tw * 0.9; tc.push({ p: add(tp[3], norm(sub(tp[3], tp[2])), tw * 1.2), w: tw * 0.3, ht: tw * 0.3 }); }
    const tsp = spline(tc, hi ? 26 : 7, ['w', 'ht']);
    const nearT = (pt) => { let best = 0, bd = Infinity; tsp.pts.forEach((q, i) => { const d = len(sub(q, pt)); if (d < bd) { bd = d; best = i; } }); return tsp.s[best]; };
    const tj = [nearT(tp[0]), nearT(tp[1]), nearT(tp[2])];
    mb.loft({
      pts: tsp.pts, w: tsp.w, ht: tsp.ht, hb: tsp.ht, segs: hi ? 10 : 5, up: [0, 1, 0],
      skin: (i, t, out) => chainSkin(tsp.s[i], tj, [B.PELVIS, B.TAIL1, B.TAIL2, B.TAIL3], [tw * 1.5, tw * 1.6, tw * 1.4], out),
      info: (i, t, s, out) => { out[0] = code(P.TENTACLE, M.SKIN); out[1] = t; out[2] = s * 0.8 + 0.1; out[3] = 0.85 + 0.15 * s; },
      capStart: false, capEnd: true,
    });
  }

  // ------------------------------------------------------------------ head
  const hd = rig.headDir, Lh = rig.Lh, hP = rig.headP;
  const hw = rig.hwAbs, hh = rig.hhAbs;
  const hUp = rig.headUp;
  const sn = g.snout;
  const hc = [];
  const H = (s, dy, w, ht, hb) => hc.push({ p: add(add(hP, hd, s * Lh), hUp, dy * hh), w: w * hw, ht: ht * hh, hb: hb * hh });
  if (hexa) {
    H(-0.2, 0.0, 0.5, 0.5, 0.5);
    H(0.1, 0.05, 0.95, 0.85, 0.8);
    H(0.45, 0.02, 1.0, 0.9, 0.85);
    H(0.8, -0.05, 0.75, 0.62, 0.7);
    H(1.0, -0.12, 0.35, 0.3, 0.35);
  } else {
    H(-0.18, 0.05, 0.55, 0.55, 0.55);
    H(0.05, 0.12, 0.92, 0.9, 0.85);
    H(0.28, 0.06, 0.98, 0.82, 1.0);
    H(0.52, -0.04, 0.55 + 0.25 * (1 - sn), 0.55, 0.72);
    H(0.8, -0.1, 0.42 + 0.2 * (1 - sn), 0.42, 0.52);
    H(0.97, -0.13, 0.36 + 0.12 * (1 - sn), 0.34, 0.4);
    H(1.04, -0.16, 0.18, 0.16, 0.2);
  }
  const hsp = spline(hc, hi ? 30 : 9, ['w', 'ht', 'hb']);
  mb.loft({
    pts: hsp.pts, w: hsp.w, ht: hsp.ht, hb: hsp.hb, segs: hi ? 20 : 8, power: 2.1, up: hUp,
    skin: (i, t, out) => { out[0] = B.HEAD; out[1] = B.HEAD; out[2] = 1; },
    info: (i, t, s, out) => { out[0] = code(P.HEAD, hexa && s > 0 ? M.CARAPACE : M.SKIN); out[1] = t; out[2] = s * 0.8 + 0.1; out[3] = 0.7 + 0.3 * Math.max(0, s); },
    capStart: true, capEnd: 0.9,
  });
  // head surface point helper: position on head section at arc param t, angle (cos, sin)
  const headSurf = (t, c, s) => {
    const i = Math.round(t * (hsp.pts.length - 1));
    const p = hsp.pts[i];
    const hx = hsp.w[i], hyT = hsp.ht[i], hyB = hsp.hb[i];
    const X = norm([1, 0, 0]);
    return add(add(p, X, c * hx), hUp, s * (s > 0 ? hyT : hyB));
  };

  // eyes
  const eyeR = hh * g.eyeK * (hexa ? 1.4 : 1);
  const eyeT = hexa ? 0.42 : 0.3;
  for (const side of [1, -1]) {
    const surf = headSurf(eyeT, side * 0.72, 0.62);
    const out = norm(add(V(side, 0, 0), hUp, 0.55));
    const c = add(surf, out, -eyeR * 0.35);
    mb.ellipsoid(c, eyeR, eyeR * 0.92, eyeR, hi ? 12 : 5, hi ? 8 : 3,
      (t, o) => { o[0] = B.HEAD; o[1] = B.HEAD; o[2] = 1; },
      (t, s, o) => { o[0] = code(P.EYE, M.EYE); o[1] = t; o[2] = 0; o[3] = 1; },
      eyeBasis(norm(add(out, hd, 0.25))));
  }
  // nostrils / mouth line (dark) — small flattened ellipsoids at the muzzle
  if (hi && !hexa) {
    for (const side of [1, -1]) {
      const p = headSurf(0.97, side * 0.45, 0.25);
      mb.ellipsoid(p, hw * 0.07, hh * 0.05, hw * 0.08, 6, 3, (t, o) => { o[0] = B.HEAD; o[1] = B.HEAD; o[2] = 1; }, (t, s, o) => { o[0] = code(P.HEAD, M.DARK); o[1] = 1; o[2] = 0; o[3] = 0.5; });
    }
  }

  // ears / antennae
  const ears = g.ears;
  if (ears && ears.type !== 'none') {
    for (const side of [1, -1]) {
      const bIdx = side > 0 ? B.EARL : B.EARR;
      const base = rig.bones[bIdx].pivot;
      if (ears.type === 'antenna') {
        const L = S * 0.4 * ears.len;
        const pts = [];
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          pts.push(add(base, norm([side * (0.35 + t * 0.4), 0.55 + 0.3 * t - t * t * 0.9, 0.8]), L * t));
        }
        const w = pts.map((_, i) => S * 0.012 * (1 - i / 10));
        mb.loft({ pts, w, segs: hi ? 6 : 3, skin: (i, t, o) => { o[0] = bIdx; o[1] = bIdx; o[2] = 1; }, info: (i, t, s, o) => { o[0] = code(P.EAR, M.CARAPACE); o[1] = t; o[2] = s; o[3] = 1; }, capEnd: true });
        continue;
      }
      const L = hh * 2.2 * ears.len * (ears.type === 'long' ? 1.8 : ears.type === 'round' ? 0.7 : ears.type === 'fan' ? 1.3 : 1);
      const wid = L * (ears.type === 'round' ? 0.6 : ears.type === 'fan' ? 0.75 : ears.type === 'long' ? 0.28 : 0.38);
      const dir = norm(ears.type === 'fan' ? [side * 1.0, 0.25, -0.3] : [side * 0.55, 0.85, -0.35]);
      const n = hi ? 10 : 4;
      const pts = [], w = [], ht = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts.push(add(base, dir, L * t));
        const prof = Math.sin(Math.PI * Math.pow(t, 0.75)) * (1 - 0.15 * t) + (t < 0.1 ? 0.25 : 0);
        w.push(Math.max(wid * 0.03, wid * 0.5 * prof));
        ht.push(Math.max(wid * 0.02, wid * 0.08 * (1 - t * 0.7)));
      }
      // ears are flattened along their facing direction (face forward-out)
      const earUp = norm([side * 0.3, -0.35, 0.9]);
      mb.loft({ pts, w, ht, hb: ht, segs: hi ? 10 : 5, up: earUp, skin: (i, t, o) => { o[0] = bIdx; o[1] = bIdx; o[2] = 1; }, info: (i, t, s, o) => { o[0] = code(P.EAR, s > 0.2 ? M.MEMBRANE : M.SKIN); o[1] = t; o[2] = 0.5; o[3] = 0.85; }, capEnd: true, capStart: true });
    }
  }

  // horns
  hornsGeometry(mb, rig, g, hi, headSurf, hUp, hw, hh, code);

  // dorsal spikes / plates
  if (g.spikes && hi) {
    const n = g.spikes.n;
    for (let i = 0; i < n; i++) {
      const t = 0.1 + (i / Math.max(1, n - 1)) * 0.62;    // along main loft (rump → neck)
      const k = Math.round(t * (sp.pts.length - 1));
      const p = sp.pts[k];
      const a = sp.pts[Math.max(0, k - 1)], b = sp.pts[Math.min(sp.pts.length - 1, k + 1)];
      const T = norm(sub(b, a));
      const upv = norm(sub(V(0, 1, 0), [T[0] * T[1], T[1] * T[1], T[2] * T[1]]));
      const base = add(p, upv, sp.ht[k] * 0.9);
      const size = S * g.spikes.size * (0.6 + 0.4 * Math.sin(Math.PI * (i + 0.5) / n)) * (giant ? 0.6 : 1);
      chainSkin(sp.s[k], joints, owners, blends, skin3);
      const b0 = skin3[0], b1 = skin3[1], w0 = skin3[2];
      const tip = add(add(base, upv, size), T, -size * 0.35);
      const pts = [], w = [], ht = [];
      for (let j = 0; j <= 4; j++) { const t2 = j / 4; pts.push(lerp3(add(base, upv, -size * 0.2), tip, t2)); const r = size * 0.28 * (1 - t2) + 0.002; w.push(g.spikes.plates ? r * 0.25 : r); ht.push(g.spikes.plates ? r * 1.6 : r); }
      mb.loft({ pts, w, ht, hb: ht, segs: 6, up: T, skin: (ii, tt, o) => { o[0] = b0; o[1] = b1; o[2] = w0; }, info: (ii, tt, s, o) => { o[0] = code(P.SPIKE, M.KERATIN); o[1] = tt; o[2] = 1; o[3] = 1; }, capEnd: true });
    }
  }

  // ------------------------------------------------------------------ legs
  for (const L of rig.legs) legGeometry(mb, rig, L, hi, code);
  for (const A of rig.arms) {
    const pts = [A.root, lerp3(A.root, A.elbow, 0.5), A.elbow, lerp3(A.elbow, A.hand, 0.5), A.hand];
    const r = D * 0.12 * g.legThick;
    const sp2 = spline(pts.map((p, i) => ({ p, w: r * [1.3, 1.0, 0.8, 0.7, 0.6][i] })), hi ? 12 : 5, ['w']);
    const jE = sp2.s[Math.round((sp2.pts.length - 1) * 0.5)];
    mb.loft({ pts: sp2.pts, w: sp2.w, segs: hi ? 8 : 4, up: [0, 0, 1],
      skin: (i, t, o) => chainSkin(sp2.s[i], [sp2.s[1] * 0.5, jE], [B.CHEST, A.upper, A.lower], [r, r * 1.2], o),
      info: (i, t, s, o) => { o[0] = code(P.LEG, M.SKIN); o[1] = t * 0.8; o[2] = -0.2; o[3] = 0.75; }, capEnd: true });
  }
  return mb.build();
}

function eyeBasis(out) {
  // basis whose Z axis = outward direction
  const z = out;
  const ref = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = norm([ref[1] * z[2] - ref[2] * z[1], ref[2] * z[0] - ref[0] * z[2], ref[0] * z[1] - ref[1] * z[0]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x, y, z];
}

function legGeometry(mb, rig, L, hi, code) {
  const g = rig.g, D = rig.D, S = rig.S;
  const kind = g.kind;
  const hexa = kind === 'hexapod', giant = kind === 'giant', hop = kind === 'hopper';
  const th = g.legThick;
  const P = PART, M = MAT;
  // radii
  let rTop, rKnee, rShin, rAnkle, rFoot;
  if (hexa) { rTop = D * 0.13 * th; rKnee = D * 0.09 * th; rShin = D * 0.07 * th; rAnkle = D * 0.045 * th; rFoot = D * 0.03 * th; }
  else if (giant) { rTop = D * 0.24 * th; rKnee = D * 0.17 * th; rShin = D * 0.15 * th; rAnkle = D * 0.15 * th; rFoot = D * 0.19 * th; }
  else if (hop) { rTop = D * 0.34 * th; rKnee = D * 0.16 * th; rShin = D * 0.1 * th; rAnkle = D * 0.07 * th; rFoot = D * 0.06 * th; }
  else if (kind === 'critter') { rTop = D * (L.hind ? 0.3 : 0.24) * th; rKnee = D * 0.13 * th; rShin = D * 0.1 * th; rAnkle = D * 0.075 * th; rFoot = D * 0.1 * th; }
  else { rTop = D * (L.hind ? 0.34 : 0.26) * th; rKnee = D * (L.hind ? 0.13 : 0.12) * th; rShin = D * 0.075 * th; rAnkle = D * 0.06 * th; rFoot = D * 0.065 * th; }
  const top = add(L.root, norm(sub(L.root, L.knee)), rTop * 0.9);
  const ctrl = [
    { p: top, w: rTop * 0.85, ht: rTop * 0.9 },
    { p: L.root, w: rTop * 0.95, ht: rTop * 1.1 },
    { p: lerp3(L.root, L.knee, 0.5), w: rTop * 0.75, ht: rTop * 0.95 },
    { p: L.knee, w: rKnee, ht: rKnee * 1.1 },
    { p: lerp3(L.knee, L.ankle, 0.35), w: rShin * 1.15, ht: rShin * 1.35 },
    { p: lerp3(L.knee, L.ankle, 0.8), w: rShin * 0.9, ht: rShin },
    { p: L.ankle, w: rAnkle * 1.15, ht: rAnkle * 1.3 },
  ];
  const foot = [];
  const cont = L.contact;
  if (g.foot === 'hoof') {
    const f1 = lerp3(L.ankle, cont, 0.55), f2 = lerp3(L.ankle, cont, 0.84);
    ctrl.push({ p: lerp3(L.ankle, cont, 0.3), w: rAnkle * 0.85, ht: rAnkle * 0.9 });
    ctrl.push({ p: f1, w: rAnkle * 0.85, ht: rAnkle * 0.95 });
    ctrl.push({ p: add(f2, [0, 0, 1], rAnkle * 0.05), w: rAnkle * 1.2, ht: rAnkle * 1.25 });   // fetlock
    ctrl.push({ p: add(cont, [0, 1, 0], rFoot * 0.9), w: rFoot * 1.2, ht: rFoot * 1.35 });   // hoof top
    ctrl.push({ p: add(cont, [0, 1, 0], rFoot * 0.1), w: rFoot * 1.35, ht: rFoot * 1.55 });   // hoof base
    foot.push(0.86);
  } else if (g.foot === 'pad') {
    ctrl.push({ p: lerp3(L.ankle, cont, 0.4), w: rFoot * 0.95, ht: rFoot * 1.0 });
    ctrl.push({ p: add(cont, [0, 1, 0], rFoot * 0.3), w: rFoot * 1.12, ht: rFoot * 1.15 });
    ctrl.push({ p: add(cont, [0, 1, 0], rFoot * 0.05), w: rFoot * 1.1, ht: rFoot * 1.12 });
    foot.push(0.93);
  } else if (g.foot === 'paw') {
    ctrl.push({ p: lerp3(L.ankle, cont, 0.6), w: rAnkle * 0.9, ht: rAnkle * 0.95 });
    ctrl.push({ p: add(add(cont, [0, 1, 0], rFoot * 0.6), [0, 0, 1], rFoot * 0.4), w: rFoot * 1.05, ht: rFoot * 0.8 });
    ctrl.push({ p: add(add(cont, [0, 1, 0], rFoot * 0.35), [0, 0, 1], rFoot * 1.1), w: rFoot * 0.8, ht: rFoot * 0.5 });
    foot.push(0.97);
  } else if (g.foot === 'longfoot') {
    ctrl.push({ p: lerp3(L.ankle, cont, 0.5), w: rAnkle * 0.95, ht: rAnkle * 0.7 });
    ctrl.push({ p: add(cont, [0, 1, 0], rFoot * 0.6), w: rFoot * 1.1, ht: rFoot * 0.6 });
    foot.push(0.97);
  } else { // claw
    ctrl.push({ p: lerp3(L.ankle, cont, 0.6), w: rFoot * 1.1, ht: rFoot * 1.1 });
    ctrl.push({ p: add(cont, [0, 1, 0], rFoot * 0.2), w: rFoot * 0.4, ht: rFoot * 0.4 });
    foot.push(0.8);
  }
  const sp = spline(ctrl, hi ? (giant ? 26 : 22) : 7, ['w', 'ht']);
  const nearS = (pt) => { let best = 0, bd = Infinity; sp.pts.forEach((q, i) => { const d = len(sub(q, pt)); if (d < bd) { bd = d; best = i; } }); return sp.s[best]; };
  const jRoot = nearS(L.root), jKnee = nearS(L.knee), jAnkle = nearS(L.ankle);
  const joints = [jRoot, jKnee, jAnkle];
  const owners = [L.parent, L.upper, L.lower, L.foot];
  const blends = [rTop * 1.1, rKnee * 1.6, rAnkle * 2.0];
  const hoofStart = foot[0];
  mb.loft({
    pts: sp.pts, w: sp.w, ht: sp.ht, hb: sp.ht, segs: hi ? (giant ? 14 : 11) : 5, power: 2.0,
    up: hexa ? [0, 1, 0] : [0, 0, 1],
    skin: (i, t, out) => chainSkin(sp.s[i], joints, owners, blends, out),
    info: (i, t, s, out) => {
      const isHoof = (g.foot === 'hoof' || g.foot === 'claw' || g.foot === 'pad') && t > hoofStart;
      out[0] = code(P.LEG, isHoof ? (g.foot === 'pad' ? M.DARK : M.KERATIN) : (hexa ? M.CARAPACE : M.SKIN));
      out[1] = t; out[2] = -0.25 + 0.3 * s; out[3] = 0.55 + 0.45 * Math.min(1, t * 2.2);
    },
    capStart: false, capEnd: true,
  });
  // giant toenails
  if (g.foot === 'pad' && hi) {
    for (let k = -1; k <= 1; k++) {
      const p = add(add(cont, [0, 1, 0], rFoot * 0.25), [Math.sin(k * 0.5), 0, Math.cos(k * 0.5)], rFoot * 1.08);
      mb.ellipsoid(p, rFoot * 0.2, rFoot * 0.18, rFoot * 0.12, 6, 4, (t, o) => { o[0] = L.foot; o[1] = L.foot; o[2] = 1; }, (t, s, o) => { o[0] = code(P.LEG, M.KERATIN); o[1] = 0.3; o[2] = 0; o[3] = 0.9; });
    }
  }
}

function hornsGeometry(mb, rig, g, hi, headSurf, hUp, hw, hh, code) {
  const horns = g.horns;
  if (!horns || horns.type === 'none') return;
  const P = PART, M = MAT;
  const S = rig.S, hd = rig.headDir;
  const segs = hi ? 8 : 4, n = hi ? 14 : 5;
  const skinHead = (i, t, o) => { o[0] = B.HEAD; o[1] = B.HEAD; o[2] = 1; };
  const info = (i, t, s, o) => { o[0] = code(P.HORN, M.KERATIN); o[1] = t; o[2] = s; o[3] = 1; };
  const L = hh * 3.2 * horns.len;
  const back = [-hd[0], -hd[1], -hd[2]];
  const tube = (pts, r0, r1, keratinInfo = info) => {
    const w = pts.map((_, i) => r0 + (r1 - r0) * Math.pow(i / (pts.length - 1), 0.8));
    mb.loft({ pts, w, segs, skin: skinHead, info: keratinInfo, capEnd: true, up: hUp });
  };
  for (const side of [1, -1]) {
    const base = headSurf(0.12, side * 0.45, 0.8);
    const pts = [];
    if (horns.type === 'spike') {
      for (let i = 0; i <= n; i++) pts.push(add(base, norm(add(add(hUp, back, 0.6), [side * horns.spread * 0.4, 0, 0])), L * (i / n)));
      tube(pts, hw * 0.16, 0.003);
    } else if (horns.type === 'curve') {
      for (let i = 0; i <= n; i++) {
        const t = i / n, a = t * 1.3;
        const d = add(add(hUp, back, 0.4 + a), [side * horns.spread * 0.35, 0, 0]);
        pts.push(i === 0 ? base : add(pts[i - 1], norm(add(d, hUp, -a * 0.35)), L / n));
      }
      tube(pts, hw * 0.17, 0.004);
    } else if (horns.type === 'lyre') {
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const d = add(add(hUp, back, 0.5 - Math.sin(t * Math.PI) * 0.4), [side * (Math.sin(t * Math.PI * 1.2) * 0.55 - t * 0.2), 0, 0]);
        pts.push(i === 0 ? base : add(pts[i - 1], norm(d), L * 1.1 / n));
      }
      tube(pts, hw * 0.14, 0.003);
    } else if (horns.type === 'spiral') {
      const c0 = add(base, [side * hw * 0.2, 0, 0]);
      for (let i = 0; i <= n; i++) {
        const t = i / n, a = t * Math.PI * 1.55;
        const r = L * 0.34 * (1 - t * 0.3);
        pts.push(add(add(add(c0, back, Math.sin(a) * r), hUp, (Math.cos(a) - 1) * -r * 0.5 + (t < 0.2 ? t * r : 0)), [side * (t * L * 0.28 + Math.sin(a * 0.5) * r * 0.3), 0, 0]));
      }
      tube(pts, hw * 0.24, hw * 0.03);
    } else if (horns.type === 'antler') {
      const beam = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const d = add(add(hUp, back, 0.35 + t * 0.4), [side * (0.35 + t * 0.35) * horns.spread + side * 0.2, 0, 0]);
        beam.push(i === 0 ? base : add(beam[i - 1], norm(add(d, hd, t * 0.5)), L * 1.25 / n));
      }
      tube(beam, hw * 0.12, hw * 0.025);
      const tines = hi ? 3 : 2;
      for (let k = 0; k < tines; k++) {
        const at = beam[Math.round(n * (0.3 + 0.22 * k))];
        const tp = [];
        for (let i = 0; i <= 5; i++) tp.push(add(at, norm(add(add(hUp, hd, 0.7 - k * 0.2), [side * 0.2, 0, 0])), L * 0.38 * (1 - k * 0.15) * i / 5));
        tube(tp, hw * 0.07, 0.003);
      }
    } else if (horns.type === 'mandible') {
      const mb0 = headSurf(0.92, side * 0.55, -0.35);
      for (let i = 0; i <= n; i++) {
        const t = i / n, a = t * 1.4;
        pts.push(add(mb0, norm(add(add(hd, [-side * Math.sin(a) * 0.9, 0, 0]), hUp, -0.2)), L * 0.45 * t));
      }
      tube(pts, hw * 0.12, 0.004);
    } else if (horns.type === 'nasal') {
      if (side < 0) continue;
      const nb = headSurf(0.78, 0, 1);
      for (let i = 0; i <= n; i++) pts.push(add(nb, norm(add(hUp, hd, 0.5 + i / n * 0.8)), L * 0.55 * i / n));
      tube(pts, hw * 0.22, 0.004);
    } else if (horns.type === 'crest') {
      if (side < 0) continue;
      // fan-shaped bony crest (membrane between two ribs) sweeping back from the skull
      const grid = [];
      const ni = hi ? 8 : 3, nj = hi ? 6 : 3;
      for (let i = 0; i <= ni; i++) {
        const row = [];
        const t = i / ni;
        const a0 = headSurf(0.1 + t * 0.3, 0, 0.95);
        for (let j = 0; j <= nj; j++) {
          const u = j / nj;
          const height = L * (0.25 + 0.75 * Math.sin(t * Math.PI * 0.9 + 0.15)) * u;
          row.push(add(add(a0, hUp, height), back, height * (0.5 + t * 0.6)));
        }
        grid.push(row);
      }
      mb.membrane(grid, (i, j, o) => { o[0] = B.HEAD; o[1] = B.HEAD; o[2] = 1; }, (i, j, s, o) => { o[0] = code(P.FIN, M.MEMBRANE); o[1] = j / nj; o[2] = 1; o[3] = 1; }, hw * 0.05);
    }
  }
}
