// Player track — the katana's motion: key poses for the draw, the ready stance, a three-cut combo, the iaido
// stance and its single flash cut, and the sheathe (chiburi flick → over the shoulder → click).
//
// Everything is in CHEST space (the chest bone's frame: +X her left, +Y up, +Z forward), so the cuts ride the
// torso's twist. A key gives the right hand's target, the blade direction (tsuba → tip), whether the sword is in
// the hand (else in the scabbard on her back), a torso yaw, a stance depth (crouch), a forward lean and an optional
// left-hand target. Segments ease in / out per key; the blade direction is slerped, so a cut sweeps an arc.
import * as THREE from 'three';

// The scabbard on her back (chest space): the mouth behind the right shoulder blade, the tip toward the left hip.
export const SHEATH = {
  mouth: new THREE.Vector3(-0.12, 0.2, -0.165),
  axis: new THREE.Vector3(0.42, -0.9, -0.06).normalize(),   // mouth → tip
  edge: new THREE.Vector3(0, 0, -1),                         // the edge faces away from her back
  len: 0.8,
};
// where the right hand closes on the hilt while it is sheathed (a little above the mouth along the handle)
export const HILT = SHEATH.mouth.clone().addScaledVector(SHEATH.axis, -0.075);

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const N = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
const AX = SHEATH.axis;
const REST_HAND = V(-0.2, -0.36, 0.02);
const HILT_HAND = V(-0.15, 0.25, -0.12);

// k(u, hand, dir, opts) — opts: inHand (0/1), yaw, crouch, lean, handL, ease (0 smooth, 1 fast-out, 2 fast-in), w
const k = (u, hand, dir, o = {}) => ({ u, hand, dir, inHand: o.inHand ?? 1, yaw: o.yaw ?? 0, crouch: o.crouch ?? 0, lean: o.lean ?? 0, handL: o.handL || null, ease: o.ease ?? 0, w: o.w ?? 1 });

const READY = k(0, V(-0.235, -0.3, 0.13), N(-0.34, -0.5, 0.8), { yaw: 0.06 });
const READY_RUN = k(0, V(-0.24, -0.3, -0.03), N(-0.22, -0.38, -0.9), { lean: 0.05 });

export const ACTS = {
  // over the shoulder: reach the hilt, pull it out along the scabbard, swing it over the top, settle into ready
  draw: { dur: 0.6, keys: [
    k(0, REST_HAND, AX, { inHand: 0, w: 0 }),
    k(0.3, HILT_HAND, AX, { inHand: 0, ease: 0 }),
    k(0.34, HILT_HAND, AX, { inHand: 1 }),
    k(0.52, V(-0.3, 0.5, 0.1), AX, { ease: 2, yaw: -0.12 }),
    k(0.64, V(-0.33, 0.5, 0.2), N(-0.15, 0.55, -0.82), { ease: 1, yaw: -0.1 }),
    k(0.76, V(-0.28, 0.34, 0.38), N(-0.1, 0.5, 0.86), { ease: 1 }),
    { ...READY, u: 1, ease: 0 },
  ] },
  // flick the blade clean, lift it over the shoulder, find the mouth, slide it home (click), hand back down
  sheathe: { dur: 0.95, keys: [
    { ...READY, u: 0 },
    k(0.16, V(-0.44, -0.06, 0.3), N(-0.78, -0.42, 0.46), { ease: 1, yaw: -0.18 }),
    k(0.36, V(-0.3, 0.46, 0.16), N(-0.12, 0.62, -0.78), { ease: 0 }),
    k(0.5, V(-0.3, 0.5, 0.1), AX, { ease: 0 }),
    k(0.78, HILT_HAND, AX, { ease: 2 }),
    k(0.8, HILT_HAND, AX, { inHand: 0 }),
    k(1, REST_HAND, AX, { inHand: 0, w: 0 }),
  ] },
  // kesa-giri: from over the right shoulder down across the body to the low left
  slash1: { dur: 0.5, hit: 0.4, keys: [
    { ...READY, u: 0 },
    k(0.24, V(-0.13, 0.42, 0.04), N(0.12, 0.55, -0.83), { yaw: -0.38, ease: 0 }),
    k(0.34, V(-0.04, 0.38, 0.3), N(0.22, 0.78, 0.58), { yaw: -0.05, ease: 2, lean: 0.06 }),
    k(0.46, V(0.17, -0.18, 0.36), N(0.62, -0.44, 0.65), { yaw: 0.34, ease: 1, crouch: 0.06, lean: 0.12 }),
    { ...READY, u: 1, ease: 0 },
  ] },
  // a flat backhand cut from her left to her right, the body unwinding behind it
  slash2: { dur: 0.5, hit: 0.36, keys: [
    k(0, V(0.17, -0.18, 0.36), N(0.62, -0.44, 0.65), { yaw: 0.34 }),
    k(0.2, V(0.24, 0.04, 0.28), N(0.9, 0.08, 0.42), { yaw: 0.48, ease: 0 }),
    k(0.32, V(0.0, 0.07, 0.44), N(0.0, 0.1, 1.0), { yaw: 0.0, ease: 2, lean: 0.08 }),
    k(0.45, V(-0.43, 0.05, 0.24), N(-0.9, 0.1, 0.42), { yaw: -0.52, ease: 1, crouch: 0.05, lean: 0.1 }),
    { ...READY, u: 1, ease: 0 },
  ] },
  // the finisher: low right, rising through the centre and up over her head
  slash3: { dur: 0.66, hit: 0.4, keys: [
    k(0, V(-0.43, 0.05, 0.24), N(-0.9, 0.1, 0.42), { yaw: -0.52 }),
    k(0.2, V(-0.3, -0.3, 0.16), N(-0.45, -0.58, 0.68), { yaw: -0.42, crouch: 0.12, ease: 0 }),
    k(0.36, V(-0.02, 0.24, 0.44), N(0.06, 0.74, 0.67), { yaw: 0.05, crouch: 0.02, ease: 2, lean: 0.06 }),
    k(0.48, V(0.1, 0.5, 0.24), N(0.22, 0.95, -0.2), { yaw: 0.4, ease: 1, lean: -0.06 }),
    k(0.7, V(0.02, 0.36, 0.3), N(0.0, 0.85, 0.52), { yaw: 0.2, ease: 0 }),
    { ...READY, u: 1, ease: 0 },
  ] },
  // iaido: the sheathed stance — low, right shoulder back, the hand on the hilt, the left hand forward
  charge: { dur: 0.45, keys: [
    k(0, REST_HAND, AX, { inHand: 0, w: 0 }),
    k(0.6, HILT_HAND, AX, { inHand: 0, yaw: -0.55, crouch: 0.15, lean: 0.12, handL: V(0.2, -0.04, 0.3) }),
    k(1, HILT_HAND, AX, { inHand: 0, yaw: -0.6, crouch: 0.17, lean: 0.14, handL: V(0.2, -0.02, 0.32) }),
  ] },
  // the same stance with the blade already drawn: held low and back
  chargeDrawn: { dur: 0.4, keys: [
    { ...READY, u: 0 },
    k(0.6, V(-0.22, -0.22, -0.1), N(-0.16, -0.3, -0.94), { yaw: -0.5, crouch: 0.15, lean: 0.12, handL: V(0.2, -0.04, 0.3) }),
    k(1, V(-0.22, -0.2, -0.12), N(-0.15, -0.28, -0.95), { yaw: -0.55, crouch: 0.17, lean: 0.14, handL: V(0.2, -0.02, 0.32) }),
  ] },
  // the flash cut: out of the scabbard and through in a tenth of a second, then held — the beat — then a flick
  iai: { dur: 1.25, hit: 0.1, keys: [
    k(0, HILT_HAND, AX, { inHand: 0, yaw: -0.6, crouch: 0.17, lean: 0.14, handL: V(0.2, -0.02, 0.32) }),
    k(0.035, HILT_HAND, AX, { inHand: 1, yaw: -0.6, crouch: 0.17, lean: 0.14, handL: V(0.2, -0.02, 0.32) }),
    k(0.07, V(-0.33, 0.42, 0.16), N(-0.5, 0.2, 0.84), { yaw: -0.3, crouch: 0.16, lean: 0.16, ease: 2, handL: V(0.1, -0.1, 0.1) }),
    k(0.13, V(0.44, 0.07, 0.28), N(0.93, 0.04, 0.36), { yaw: 0.6, crouch: 0.2, lean: 0.18, ease: 1, handL: V(0.26, -0.3, -0.2) }),
    k(0.6, V(0.45, 0.06, 0.27), N(0.94, 0.02, 0.34), { yaw: 0.62, crouch: 0.22, lean: 0.17, ease: 0, handL: V(0.27, -0.31, -0.21) }),
    k(0.8, V(-0.42, -0.05, 0.3), N(-0.78, -0.42, 0.46), { yaw: -0.15, crouch: 0.06, ease: 1 }),
    { ...READY, u: 1, ease: 0 },
  ] },
};
for (const a of Object.values(ACTS)) {
  for (const key of a.keys) key.dir = key.dir.clone().normalize();
}
export const READY_POSE = READY;
export const READY_RUN_POSE = READY_RUN;

const easeF = (e, t) => (e === 1 ? 1 - Math.pow(1 - t, 3) : e === 2 ? t * t * t : t * t * (3 - 2 * t));
const _a = new THREE.Vector3();

function slerpDir(a, b, t, out) {
  const d = Math.min(1, Math.max(-1, a.dot(b)));
  const ang = Math.acos(d);
  if (ang < 1e-3) return out.copy(a).lerp(b, t).normalize();
  const s = Math.sin(ang);
  if (s < 1e-3) return out.copy(a).lerp(b, t).normalize(); // (anti-parallel: keys avoid this)
  const wa = Math.sin((1 - t) * ang) / s, wb = Math.sin(t * ang) / s;
  return out.set(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb).normalize();
}

/** Evaluate an action at u (0..1) → out {hand, dir, inHand, yaw, crouch, lean, handL, handLw, w}. */
export function evalAct(keys, u, out) {
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1].u) i++;
  const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  const span = Math.max(1e-4, b.u - a.u);
  const t0 = Math.min(1, Math.max(0, (u - a.u) / span));
  const t = easeF(b.ease, t0);
  out.hand.lerpVectors(a.hand, b.hand, t);
  slerpDir(a.dir, b.dir, t, out.dir);
  out.inHand = t < 0.5 ? a.inHand : b.inHand;
  if (a.inHand !== b.inHand) out.inHand = t0 >= 1 ? b.inHand : a.inHand;
  out.yaw = a.yaw + (b.yaw - a.yaw) * t;
  out.crouch = a.crouch + (b.crouch - a.crouch) * t;
  out.lean = a.lean + (b.lean - a.lean) * t;
  out.w = a.w + (b.w - a.w) * t;
  const la = a.handL ? 1 : 0, lb = b.handL ? 1 : 0;
  out.handLw = la + (lb - la) * t;
  if (a.handL && b.handL) out.handL.lerpVectors(a.handL, b.handL, t);
  else if (a.handL || b.handL) out.handL.copy(a.handL || b.handL);
  return out;
}

/** Copy a single key into out (static poses: ready, ready-run). */
export function evalKey(key, out) {
  out.hand.copy(key.hand); out.dir.copy(key.dir); out.inHand = key.inHand; out.yaw = key.yaw; out.crouch = key.crouch;
  out.lean = key.lean; out.w = key.w; out.handLw = key.handL ? 1 : 0; if (key.handL) out.handL.copy(key.handL);
  return out;
}

export function makeSwordPose() {
  return { hand: new THREE.Vector3(), dir: new THREE.Vector3(0, -1, 0), inHand: 0, yaw: 0, crouch: 0, lean: 0, handL: new THREE.Vector3(), handLw: 0, w: 0 };
}
export const _tmpA = _a;
