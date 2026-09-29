// Procedural explorer figure (pressure suit, armour shell, helmet with gold visor, life-support pack)
// posed for a vehicle. Poses: 'bike' (leaning forward, hands on bars, feet on pegs), 'seat' (upright
// driver/pilot). Built with its OWN uber material (mats.rider) so it keeps a clean, readable colour
// separation — soft charcoal undersuit, glossy shell plates, accent bands, dark leather boots/gloves,
// reflective visor — instead of inheriting the vehicle's dirt gradient.
import * as THREE from 'three';
import { Builder, loft, rbox, tube, bcyl, T } from '../geom.js';
import { SUITS } from '../materials.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const _up = V(0, 1, 0);

/** Tapered limb from a to c: a lathe along the segment with joint caps. */
function limb(b, a, c, r0, r1, surf, color) {
  const d = new THREE.Vector3().subVectors(c, a);
  const len = d.length();
  // slight muscle bulge in the upper third (reads less like a pipe)
  const bulge = Math.max(r0, r1) * 1.08;
  const prof = [[r0 * 0.98, 0], [bulge, len * 0.3], [(r0 + r1) * 0.5, len * 0.65], [r1, len]];
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 14);
  const q = new THREE.Quaternion().setFromUnitVectors(_up, d.normalize());
  b.add(g, surf, color, new THREE.Matrix4().compose(a, q, V(1, 1, 1)));
  b.add(new THREE.SphereGeometry(r0 * 1.0, 12, 8), surf, color, T([a.x, a.y, a.z]));
  b.add(new THREE.SphereGeometry(r1 * 1.0, 12, 8), surf, color, T([c.x, c.y, c.z]));
}

/** Place `geo` (authored along +Y, centred) on the segment a→c at fraction f, rolled so +Z faces `face`. */
function onSeg(b, geo, surf, color, a, c, f = 0.5, face = null, offset = 0) {
  const d = new THREE.Vector3().subVectors(c, a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(_up, d);
  if (face) {
    // roll around the segment so the part's +Z points toward `face` (projected)
    const z = V(0, 0, 1).applyQuaternion(q);
    const fp = face.clone().addScaledVector(d, -face.dot(d));
    if (fp.lengthSq() > 1e-6) {
      fp.normalize();
      let ang = Math.acos(Math.max(-1, Math.min(1, z.dot(fp))));
      if (new THREE.Vector3().crossVectors(z, fp).dot(d) < 0) ang = -ang;
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(d, ang));
    }
  }
  const p = a.clone().lerp(c, f);
  if (offset && face) p.addScaledVector(V(0, 0, 1).applyQuaternion(q), offset);
  b.add(geo, surf, color, new THREE.Matrix4().compose(p, q, V(1, 1, 1)));
}

/**
 * @param mats vehicle materials ({ rider?, body, glow })   liv livery (name → SUITS entry)
 * pose 'bike'|'seat'; anchors (object space of the vehicle): hip, handL/handR, footL/footR, knee(s, hip, foot)
 */
export function buildRider(mats, liv, pose = 'bike', anchors = {}) {
  const b = new Builder();
  const S = SUITS[liv.name] || SUITS.nasapunk;
  const shell = S.shell, under = S.under, under2 = S.under2 ?? under, accent = S.accent, boot = S.boot ?? '#2b2420';
  const visorCol = S.visor ?? '#c8973a';
  const hip = anchors.hip ?? V(0, 0, 0);
  const lean = pose === 'bike' ? 0.62 : 0.12;   // torso forward lean (radians from vertical)
  const torsoLen = 0.52;
  const axis = V(0, Math.cos(lean), Math.sin(lean));
  const chest = hip.clone().addScaledVector(axis, torsoLen);
  const front = V(0, -Math.sin(lean), Math.cos(lean));   // torso-front direction
  const back = front.clone().negate();
  const neck = chest.clone().addScaledVector(axis, 0.09).addScaledVector(front, 0.01);
  const head = neck.clone().add(V(0, 0.14, 0.035));
  const torsoQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(lean, 0, 0));   // +Y → torso axis, +Z → front

  // ---------------------------------------------------------------- torso (undersuit)
  const tl = loft([
    { z: -0.02, w: 0.15, ht: 0.1, hb: 0.1, n: 2.4 },
    { z: 0.14, w: 0.155, ht: 0.105, hb: 0.11, n: 2.4 },
    { z: 0.34, w: 0.195, ht: 0.12, hb: 0.12, n: 2.6 },
    { z: 0.48, w: 0.2, ht: 0.115, hb: 0.11, n: 2.8 },
    { z: 0.58, w: 0.1, ht: 0.07, hb: 0.07, n: 2 },
  ], { radial: 22, along: 12 });
  // loft runs along Z with +Y = back; map Z → torso axis, Y → back
  const tm = new THREE.Matrix4().makeBasis(V(1, 0, 0), back, axis).setPosition(hip);
  b.add(tl.geometry, 'fabric', under, tm);
  // quilted side panels (slightly lighter under-colour) along the ribs
  for (const s of [-1, 1]) {
    const c = hip.clone().addScaledVector(axis, 0.3).add(V(0.17 * s, 0, 0));
    b.add(rbox(0.05, 0.26, 0.17, 0.02, 2), 'fabric', under2, new THREE.Matrix4().compose(c, torsoQ, V(1, 1, 1)));
  }
  // chest armour: two-piece shell plate + sternum accent
  const plateC = hip.clone().addScaledVector(axis, 0.36).addScaledVector(front, 0.1);
  b.add(rbox(0.34, 0.2, 0.07, 0.03, 3), 'gloss', shell, new THREE.Matrix4().compose(plateC, torsoQ, V(1, 1, 1)));
  b.add(rbox(0.26, 0.1, 0.06, 0.025, 2), 'gloss', shell, new THREE.Matrix4().compose(plateC.clone().addScaledVector(axis, -0.15).addScaledVector(front, -0.01), torsoQ, V(1, 1, 1)));
  b.add(rbox(0.05, 0.14, 0.02, 0.008, 1), 'paint', accent, new THREE.Matrix4().compose(plateC.clone().addScaledVector(front, 0.037).addScaledVector(axis, 0.01), torsoQ, V(1, 1, 1)));
  b.glow(rbox(0.035, 0.012, 0.01, 0.004, 1), liv.glow.map((x) => x * 2.6), 4, new THREE.Matrix4().compose(plateC.clone().addScaledVector(front, 0.04).addScaledVector(axis, 0.07).add(V(0.1, 0, 0)), torsoQ, V(1, 1, 1)));
  // belt + pouches + buckle
  const beltC = hip.clone().addScaledVector(axis, 0.04);
  b.add(bcyl(0.16, 0.055, 0.012, 22), 'leather', boot, new THREE.Matrix4().compose(beltC, torsoQ, V(1, 1, 0.74)));
  b.add(rbox(0.07, 0.05, 0.02, 0.008, 1), 'metal', '#a9acb0', new THREE.Matrix4().compose(beltC.clone().addScaledVector(front, 0.12), torsoQ, V(1, 1, 1)));
  for (const s of [-1, 1]) {
    b.add(rbox(0.07, 0.08, 0.05, 0.015, 2), 'fabric', under2, new THREE.Matrix4().compose(beltC.clone().add(V(0.15 * s, 0, 0)).addScaledVector(front, 0.03).addScaledVector(axis, -0.01), torsoQ, V(1, 1, 1)));
  }
  // collar ring (hard neck seal) — shell with dark gasket
  const collarQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(lean * 0.85, 0, 0));
  b.add(bcyl(0.12, 0.05, 0.015, 24, 0.105), 'gloss', shell, new THREE.Matrix4().compose(neck.clone().addScaledVector(axis, -0.03), collarQ, V(1, 1, 0.9)));
  b.add(bcyl(0.095, 0.04, 0.01, 20), 'rubber', '#18191b', new THREE.Matrix4().compose(neck.clone().addScaledVector(axis, 0.01), collarQ, V(1, 1, 0.9)));

  // ---------------------------------------------------------------- life-support pack
  const bpC = hip.clone().addScaledVector(axis, 0.33).addScaledVector(back, 0.17);
  b.add(rbox(0.34, 0.42, 0.14, 0.045, 3), 'gloss', shell, new THREE.Matrix4().compose(bpC, torsoQ, V(1, 1, 1)));
  // dark frame / side rails
  for (const s of [-1, 1]) b.add(rbox(0.03, 0.44, 0.12, 0.012, 1), 'darkMetal', '#232428', new THREE.Matrix4().compose(bpC.clone().add(V(0.178 * s, 0, 0)), torsoQ, V(1, 1, 1)));
  // twin O2 canisters in accent colour
  for (const s of [-1, 1]) {
    const cc = bpC.clone().addScaledVector(back, 0.085).add(V(0.085 * s, 0, 0));
    b.add(bcyl(0.05, 0.34, 0.018, 16), 'paint', accent, new THREE.Matrix4().compose(cc, torsoQ, V(1, 1, 1)));
    b.add(bcyl(0.035, 0.04, 0.008, 12), 'metal', '#b5b8bc', new THREE.Matrix4().compose(cc.clone().addScaledVector(axis, 0.19), torsoQ, V(1, 1, 1)));
  }
  // vent grille + status strip
  b.add(rbox(0.12, 0.1, 0.03, 0.01, 1), 'darkMetal', '#1c1d20', new THREE.Matrix4().compose(bpC.clone().addScaledVector(back, 0.075).addScaledVector(axis, -0.13), torsoQ, V(1, 1, 1)));
  b.glow(rbox(0.1, 0.014, 0.01, 0.004, 1), liv.glow.map((x) => x * 2.4), 4, new THREE.Matrix4().compose(bpC.clone().addScaledVector(back, 0.093).addScaledVector(axis, -0.1), torsoQ, V(1, 1, 1)));
  b.glow(rbox(0.1, 0.014, 0.01, 0.004, 1), liv.glow.map((x) => x * 2.4), 4, new THREE.Matrix4().compose(bpC.clone().addScaledVector(back, 0.093).addScaledVector(axis, -0.14), torsoQ, V(1, 1, 1)));
  // hoses from the pack to the collar (both sides)
  for (const s of [-1, 1]) {
    const p0 = bpC.clone().addScaledVector(axis, 0.16).add(V(0.13 * s, 0, 0)).addScaledVector(back, 0.02);
    const p3 = neck.clone().add(V(0.1 * s, 0, 0)).addScaledVector(front, 0.02);
    const p1 = p0.clone().add(V(0.05 * s, 0, 0)).addScaledVector(axis, 0.07);
    const p2 = p3.clone().add(V(0.07 * s, 0, 0)).addScaledVector(back, 0.03);
    b.add(tube([[p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z], [p3.x, p3.y, p3.z]], 0.016, 14, 8), 'rubber', '#1c1d1f');
  }

  // ---------------------------------------------------------------- helmet
  const hq = new THREE.Quaternion().setFromEuler(new THREE.Euler(pose === 'bike' ? -0.28 : -0.02, 0, 0));
  const helm = loft([
    { z: -0.16, w: 0.02, ht: 0.02, hb: 0.02, n: 2 },
    { z: -0.135, w: 0.115, ht: 0.12, hb: 0.1, n: 2.1 },
    { z: -0.04, w: 0.155, ht: 0.165, hb: 0.14, n: 2.25 },
    { z: 0.07, w: 0.152, ht: 0.16, hb: 0.135, n: 2.3 },
    { z: 0.14, w: 0.12, ht: 0.12, hb: 0.1, n: 2.2 },
    { z: 0.165, w: 0.03, ht: 0.03, hb: 0.03, n: 2 },
  ], { radial: 28, along: 18 });
  b.add(helm.geometry, 'gloss', shell, new THREE.Matrix4().compose(head, hq, V(1, 1, 1)));
  // visor: a big wrap-around gold-mirror shield proud of the shell
  const vis = loft([
    { z: -0.005, w: 0.135, ht: 0.085, hb: 0.06, y: 0.01, n: 2.5 },
    { z: 0.07, w: 0.142, ht: 0.09, hb: 0.066, y: 0.01, n: 2.5 },
    { z: 0.13, w: 0.11, ht: 0.07, hb: 0.052, y: 0.008, n: 2.4 },
    { z: 0.172, w: 0.02, ht: 0.02, hb: 0.02, y: 0.005, n: 2 },
  ], { radial: 24, along: 12, capStart: false });
  b.add(vis.geometry, 'visor', visorCol, new THREE.Matrix4().compose(head.clone().add(V(0, 0.012, 0.01)), hq, V(1, 1, 1)));
  // visor frame / brow ridge
  b.add(rbox(0.28, 0.03, 0.08, 0.012, 2), 'gloss', shell, new THREE.Matrix4().compose(head.clone().add(new THREE.Vector3(0, 0.1, 0.1).applyQuaternion(hq)), hq, V(1, 1, 1)));
  // centre crest stripe in accent (front to back)
  b.add(rbox(0.035, 0.02, 0.26, 0.009, 2), 'paint', accent, new THREE.Matrix4().compose(head.clone().add(new THREE.Vector3(0, 0.163, -0.01).applyQuaternion(hq)), hq, V(1, 1, 1)));
  // side comm pods with a lamp
  for (const s of [-1, 1]) {
    const pc = head.clone().add(new THREE.Vector3(0.155 * s, 0.0, -0.01).applyQuaternion(hq));
    const pq = hq.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)));
    b.add(bcyl(0.05, 0.035, 0.01, 18), 'darkMetal', under, new THREE.Matrix4().compose(pc, pq, V(1, 1, 1)));
    b.add(bcyl(0.028, 0.02, 0.006, 14), 'paint', accent, new THREE.Matrix4().compose(pc.clone().add(new THREE.Vector3(0.018 * s, 0, 0).applyQuaternion(hq)), pq, V(1, 1, 1)));
  }
  b.glow(rbox(0.018, 0.018, 0.03, 0.006, 1), [2.4, 2.3, 2.1], 3, new THREE.Matrix4().compose(head.clone().add(new THREE.Vector3(0.16, 0.06, 0.07).applyQuaternion(hq)), hq, V(1, 1, 1)));
  // antenna stub on the left pod
  b.add(bcyl(0.004, 0.16, 0.001, 6), 'darkMetal', '#222', new THREE.Matrix4().compose(head.clone().add(new THREE.Vector3(-0.16, 0.12, -0.06).applyQuaternion(hq)), hq.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0, 0))), V(1, 1, 1)));

  // ---------------------------------------------------------------- arms
  const shoulderY = 0.45;
  for (const s of [-1, 1]) {
    const sh = hip.clone().addScaledVector(axis, shoulderY).add(V(0.215 * s, 0, 0));
    const hand = (s < 0 ? anchors.handL : anchors.handR) ?? sh.clone().add(V(0.05 * s, -0.35, 0.25));
    const mid = sh.clone().lerp(hand, 0.5).add(V(0.08 * s, -0.06, -0.04));
    limb(b, sh, mid, 0.06, 0.05, 'fabric', under);
    limb(b, mid, hand, 0.05, 0.04, 'fabric', under);
    // shoulder pauldron (shell), elbow cup, forearm gauntlet (shell) with accent band
    b.add(new THREE.SphereGeometry(0.085, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), 'gloss', shell,
      new THREE.Matrix4().compose(sh.clone().add(V(0.01 * s, 0.015, 0)), new THREE.Quaternion().setFromEuler(new THREE.Euler(lean * 0.6, 0, -0.35 * s)), V(1.05, 0.9, 1.15)));
    b.add(new THREE.SphereGeometry(0.052, 12, 8), 'plastic', under2, T([mid.x, mid.y, mid.z]));
    onSeg(b, rbox(0.1, 0.17, 0.1, 0.035, 2), 'gloss', shell, mid, hand, 0.52);
    onSeg(b, bcyl(0.061, 0.03, 0.006, 16), 'paint', accent, sh, mid, 0.55);
    // glove: palm block + cuff + knuckle plate
    const toH = hand.clone().sub(mid).normalize();
    onSeg(b, bcyl(0.05, 0.05, 0.01, 14, 0.046), 'leather', boot, mid, hand, 0.9);
    b.add(rbox(0.08, 0.065, 0.11, 0.025, 2), 'leather', boot, new THREE.Matrix4().compose(hand.clone().addScaledVector(toH, 0.04), new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), toH), V(1, 1, 1)));
    b.add(rbox(0.07, 0.02, 0.05, 0.008, 1), 'darkMetal', '#3a3c40', new THREE.Matrix4().compose(hand.clone().addScaledVector(toH, 0.05).add(V(0, 0.035, 0)), new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), toH), V(1, 1, 1)));
  }

  // ---------------------------------------------------------------- legs
  for (const s of [-1, 1]) {
    const hp = hip.clone().add(V(0.1 * s, -0.03, 0));
    const foot = (s < 0 ? anchors.footL : anchors.footR) ?? hp.clone().add(V(0.05 * s, -0.8, 0.25));
    const kneeDef = pose === 'bike' ? hp.clone().lerp(foot, 0.5).add(V(0.1 * s, 0.14, 0.26)) : hp.clone().add(V(0.02 * s, 0.02, 0.42));
    const knee = anchors.knee ? anchors.knee(s, hp, foot) : kneeDef;
    const ankle = foot.clone().add(V(0, 0.1, -0.03));
    limb(b, hp, knee, 0.088, 0.066, 'fabric', under);
    limb(b, knee, ankle, 0.066, 0.052, 'fabric', under);
    // thigh cargo pocket (outer side) + accent band
    onSeg(b, rbox(0.04, 0.14, 0.1, 0.015, 2), 'fabric', under2, hp, knee, 0.5, V(s, 0, 0), 0.075);
    onSeg(b, bcyl(0.08, 0.025, 0.006, 16), 'paint', accent, hp, knee, 0.22);
    // knee cap + shin guard (shell)
    const kFace = knee.clone().sub(hp).normalize().add(ankle.clone().sub(knee).normalize().negate()).normalize().negate();
    b.add(new THREE.SphereGeometry(0.075, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), 'gloss', shell,
      new THREE.Matrix4().compose(knee, new THREE.Quaternion().setFromUnitVectors(_up, kFace.lengthSq() > 0.1 ? kFace : V(0, 0, 1)), V(1, 0.8, 1)));
    onSeg(b, rbox(0.1, 0.24, 0.05, 0.022, 2), 'gloss', shell, knee, ankle, 0.45, V(0, 0, 1).add(V(0, 0.4, 0)).normalize(), 0.045);
    // boot: upper, toe cap, sole, strap
    b.add(rbox(0.125, 0.16, 0.16, 0.04, 2), 'leather', boot, T([foot.x, foot.y + 0.06, foot.z - 0.01]));
    b.add(rbox(0.12, 0.085, 0.16, 0.035, 2), 'leather', boot, T([foot.x, foot.y + 0.02, foot.z + 0.1]));
    b.add(rbox(0.135, 0.032, 0.3, 0.012, 1), 'rubber', '#121212', T([foot.x, foot.y - 0.025, foot.z + 0.04]));
    b.add(rbox(0.132, 0.022, 0.04, 0.006, 1), 'paint', accent, T([foot.x, foot.y + 0.1, foot.z - 0.005]));
  }

  const mat = mats.rider || mats.body;
  // keep grime to the boots / shins only (object-space Y relative to the hip)
  const u = mat.userData?.u;
  if (u && mats.rider) u.uDirtRange.value.set(hip.y - 0.95, hip.y - 0.35);
  const out = b.build({ body: mat, glow: mats.glow }, { name: 'rider' });
  const g = new THREE.Group();
  g.name = 'rider';
  if (out.body) { out.body.castShadow = true; g.add(out.body); }
  if (out.glow) g.add(out.glow);
  return g;
}
