// Procedural explorer figure (suit, helmet with visor, backpack) posed for a vehicle.
// Poses: 'bike' (leaning forward, hands on bars, feet on pegs), 'seat' (upright driver/pilot).
// Returned as its own mesh (shares the vehicle uber material) so it can be hidden/leaned.
import * as THREE from 'three';
import { Builder, loft, rbox, tube, bcyl, T } from '../geom.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function limb(b, a, c, r0, r1, surf, color) {
  // tapered limb from a to c (Vector3), built as a lathe along Y then oriented
  const d = new THREE.Vector3().subVectors(c, a);
  const len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, 12, 1, false);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize());
  const m = new THREE.Matrix4().compose(a, q, V(1, 1, 1));
  b.add(g, surf, color, m);
  // joint caps
  b.add(new THREE.SphereGeometry(r0 * 1.02, 12, 8), surf, color, T([a.x, a.y, a.z]));
  b.add(new THREE.SphereGeometry(r1 * 1.02, 12, 8), surf, color, T([c.x, c.y, c.z]));
}

/**
 * @param liv livery (suit colors)  pose 'bike'|'seat'
 * anchors (object space of the vehicle): hip, handL/handR (optional), footL/footR
 */
export function buildRider(mats, liv, pose = 'bike', anchors = {}) {
  const b = new Builder();
  const suit = liv.suit ?? '#d9d4c8';
  const suit2 = liv.suit2 ?? '#3a3c40';
  const accent = liv.accent;
  const hip = anchors.hip ?? V(0, 0, 0);
  const lean = pose === 'bike' ? 0.62 : 0.12;   // torso forward lean (radians from vertical)
  const torsoLen = 0.52;
  const chest = V(0, Math.cos(lean) * torsoLen, Math.sin(lean) * torsoLen).add(hip);
  const neck = chest.clone().add(V(0, 0.1 * Math.cos(lean * 0.7), 0.1 * Math.sin(lean * 0.7)));
  const head = neck.clone().add(V(0, 0.13, 0.03));

  // torso (loft between hip and chest)
  const tl = loft([
    { z: 0.0, w: 0.15, ht: 0.11, hb: 0.11, n: 2.4 },
    { z: 0.18, w: 0.16, ht: 0.12, hb: 0.12, n: 2.4 },
    { z: 0.38, w: 0.2, ht: 0.13, hb: 0.12, n: 2.6 },
    { z: 0.52, w: 0.19, ht: 0.12, hb: 0.11, n: 2.6 },
    { z: 0.6, w: 0.08, ht: 0.07, hb: 0.07, n: 2 },
  ], { radial: 20, along: 12 });
  // loft is along Z; rotate so Z → torso direction
  const tq = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), chest.clone().sub(hip).normalize());
  // keep the loft's +Y (chest front/back) pointing forward-ish: rotate about the torso axis
  const tm = new THREE.Matrix4().compose(hip, tq, V(1, 1, 1));
  b.add(tl.geometry, 'fabric', suit, tm);
  // chest armor plate + belt
  const plate = rbox(0.3, 0.22, 0.08, 0.03, 2);
  const pq = new THREE.Quaternion().setFromEuler(new THREE.Euler(lean - Math.PI / 2 + Math.PI / 2, 0, 0));
  const pc = hip.clone().lerp(chest, 0.62).add(V(0, -Math.sin(lean) * 0.0, 0.0));
  const front = V(0, -Math.sin(lean), Math.cos(lean)); // torso-front direction (perp to torso axis, forward)
  b.add(plate, 'plastic', suit2, new THREE.Matrix4().compose(pc.clone().addScaledVector(front, 0.11), new THREE.Quaternion().setFromEuler(new THREE.Euler(-lean, 0, 0)), V(1, 1, 1)));
  void pq;
  b.add(bcyl(0.165, 0.06, 0.015, 20), 'darkMetal', '#2a2b2e', new THREE.Matrix4().compose(hip.clone().add(V(0, 0.03, 0)), new THREE.Quaternion().setFromEuler(new THREE.Euler(lean, 0, 0)), V(1, 1, 0.75)));
  // backpack (life support) with vents
  const back = V(0, Math.sin(lean), -Math.cos(lean));
  const bpC = hip.clone().lerp(chest, 0.58).addScaledVector(back, 0.17);
  const bpq = new THREE.Quaternion().setFromEuler(new THREE.Euler(lean, 0, 0));
  b.add(rbox(0.32, 0.4, 0.16, 0.04, 2), 'paint', liv.primary, new THREE.Matrix4().compose(bpC, bpq, V(1, 1, 1)));
  b.add(rbox(0.26, 0.08, 0.05, 0.015, 1), 'darkMetal', '#222326', new THREE.Matrix4().compose(bpC.clone().addScaledVector(back, 0.08).add(V(0, 0.08 * Math.cos(lean), 0.08 * Math.sin(lean))), bpq, V(1, 1, 1)));
  b.add(bcyl(0.045, 0.3, 0.01, 12), 'metal', '#8c8f94', new THREE.Matrix4().compose(bpC.clone().addScaledVector(back, 0.06).add(V(0.12, 0, 0)), bpq, V(1, 1, 1)));
  b.glow(rbox(0.03, 0.12, 0.012, 0.005, 1), liv.glow.map((x) => x * 2.2), 4, new THREE.Matrix4().compose(bpC.clone().addScaledVector(back, 0.085).add(V(-0.08, 0, 0)), bpq, V(1, 1, 1)));

  // helmet: rounded shell + visor
  const helm = loft([
    { z: -0.15, w: 0.02, ht: 0.02, hb: 0.02, n: 2 },
    { z: -0.12, w: 0.11, ht: 0.12, hb: 0.1, n: 2.1 },
    { z: -0.02, w: 0.145, ht: 0.155, hb: 0.13, n: 2.2 },
    { z: 0.08, w: 0.14, ht: 0.15, hb: 0.12, n: 2.2 },
    { z: 0.14, w: 0.1, ht: 0.11, hb: 0.08, n: 2.1 },
    { z: 0.16, w: 0.02, ht: 0.02, hb: 0.02, n: 2 },
  ], { radial: 24, along: 16 });
  const hq = new THREE.Quaternion().setFromEuler(new THREE.Euler(pose === 'bike' ? -0.25 : 0, 0, 0));
  b.add(helm.geometry, 'paint', suit, new THREE.Matrix4().compose(head, hq, V(1, 1, 1)));
  // visor (dark reflective, slightly larger on the front)
  const vis = loft([
    { z: 0.0, w: 0.12, ht: 0.07, hb: 0.05, n: 2.4 },
    { z: 0.07, w: 0.128, ht: 0.075, hb: 0.055, n: 2.4 },
    { z: 0.125, w: 0.095, ht: 0.06, hb: 0.045, n: 2.3 },
    { z: 0.158, w: 0.02, ht: 0.02, hb: 0.02, n: 2 },
  ], { radial: 20, along: 10, capStart: false });
  b.add(vis.geometry, 'visor', liv.visor ?? '#1a1208', new THREE.Matrix4().compose(head.clone().add(V(0, 0.02, 0.012)), hq, V(1, 1, 1)));
  b.add(rbox(0.3, 0.018, 0.2, 0.008, 1), 'paint', accent, new THREE.Matrix4().compose(head.clone().add(V(0, 0.155, -0.02)), hq, V(0.12, 1, 1)));
  // neck ring
  b.add(new THREE.TorusGeometry(0.085, 0.022, 8, 20), 'darkMetal', '#303236', new THREE.Matrix4().compose(neck, new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 + lean * 0.7, 0, 0)), V(1, 1, 1)));

  // arms: shoulder → elbow → hand
  const shoulderY = 0.44;
  for (const s of [-1, 1]) {
    const sh = hip.clone().add(V(0.2 * s, Math.cos(lean) * shoulderY, Math.sin(lean) * shoulderY));
    const hand = (s < 0 ? anchors.handL : anchors.handR) ?? sh.clone().add(V(0.05 * s, -0.35, 0.25));
    const mid = sh.clone().lerp(hand, 0.5).add(V(0.08 * s, -0.06, -0.03));
    limb(b, sh, mid, 0.058, 0.05, 'fabric', suit);
    limb(b, mid, hand, 0.05, 0.042, 'fabric', suit);
    // shoulder pad, glove, elbow pad
    b.add(new THREE.SphereGeometry(0.075, 14, 10), 'plastic', suit2, T([sh.x, sh.y + 0.01, sh.z], [0, 0, 0], [1.1, 0.9, 1.1]));
    b.add(rbox(0.07, 0.06, 0.1, 0.02, 2), 'leather', '#2b2622', T([hand.x, hand.y, hand.z]));
    b.add(new THREE.SphereGeometry(0.048, 10, 8), 'plastic', suit2, T([mid.x, mid.y, mid.z]));
  }
  // legs: hip → knee → foot
  for (const s of [-1, 1]) {
    const hp = hip.clone().add(V(0.1 * s, -0.02, 0));
    const foot = (s < 0 ? anchors.footL : anchors.footR) ?? hp.clone().add(V(0.05 * s, -0.8, 0.25));
    const kneeDef = pose === 'bike' ? hp.clone().lerp(foot, 0.5).add(V(0.1 * s, 0.14, 0.26)) : hp.clone().add(V(0.02 * s, 0.02, 0.42));
    const knee = anchors.knee ? anchors.knee(s, hp, foot) : kneeDef;
    limb(b, hp, knee, 0.085, 0.066, 'fabric', suit);
    limb(b, knee, foot.clone().add(V(0, 0.08, -0.02)), 0.066, 0.055, 'fabric', suit);
    b.add(new THREE.SphereGeometry(0.07, 12, 8), 'plastic', suit2, T([knee.x, knee.y, knee.z + 0.03], [0, 0, 0], [1, 1, 1.1]));
    // boot
    b.add(rbox(0.12, 0.13, 0.26, 0.035, 2), 'leather', '#2a2622', T([foot.x, foot.y + 0.04, foot.z + 0.04]));
    b.add(rbox(0.13, 0.03, 0.28, 0.01, 1), 'rubber', '#151515', T([foot.x, foot.y - 0.02, foot.z + 0.04]));
  }
  // suit accent stripes along the thighs (thin boxes)
  const out = b.build({ body: mats.body, glow: mats.glow }, { name: 'rider' });
  const g = new THREE.Group();
  g.name = 'rider';
  if (out.body) g.add(out.body);
  if (out.glow) g.add(out.glow);
  void tube;
  return g;
}
