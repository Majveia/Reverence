// Player track — first-person body: the explorer's own hands at the edges of the frame.
//
//   right hand : the katana when drawn, low right, the blade rising away into the view (the held tool sits low
//                right); it sweeps across the frame on a cut. Sheathed: a relaxed hand at the lower-right edge.
//   left hand  : open and cupped, palm up, low left — the Lumen floats a hand's breadth above it (the light in
//                hand; its point light rides with it in first person)
//   reach      : R (the resonance pulse) — the left arm reaches out from the lower-left corner toward the view
//
// Built for the frame edges, like the reference frames: a long forearm in a folded wool sleeve with a turned-back
// cuff and a wrapped wrist, a fingerless leather glove, articulated fingers (3 joints each + thumb) blended between
// a grip and an open pose. Hands are posed in camera space (-Z forward, +X right, +Y up) from a forearm direction +
// a palm axis, so every pose is a body (wrist → elbow leaves the frame), lit by the scene's sun / sky and by the
// lantern's own warm point light. The layout keeps its screen positions at any `fov=` (depth scaled).
// ~30 draw calls, first person only; no per-frame allocations.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp, damp, smoothstep, Spring } from './util.js';
import { getTextures } from './textures.js';
import { box } from './geo.js';
import { buildSwordGroup } from './Katana.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qr = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const ZA = new THREE.Vector3(0, 0, 1);
const TAU = Math.PI * 2;

/** Quaternion whose local -Z is `f` (the forearm, elbow → wrist) and local +X lies along `xHint`, then rolled. */
function basisQuat(f, xHint, roll, out, xExact = false) {
  if (xExact) { // keep the palm axis exact (a held staff), bend the forearm to it
    _x.copy(xHint).normalize();
    _z.copy(f).negate().addScaledVector(_x, f.dot(_x)).normalize();
  } else {
    _z.copy(f).negate().normalize();
    _x.copy(xHint).addScaledVector(_z, -xHint.dot(_z)).normalize();
  }
  _y.crossVectors(_z, _x);
  _m.makeBasis(_x, _y, _z);
  out.setFromRotationMatrix(_m);
  if (roll) out.multiply(_qr.setFromAxisAngle(ZA, roll));
  return out;
}

/** The fist's local X (the grip axis) in camera space. */
function _swDirFrom(out, q) { return out.set(1, 0, 0).applyQuaternion(q).normalize(); }

/** Strip to position / normal / uv, non-indexed (so parts can be merged). */
function clean(g) {
  const n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k);
  if (!n.attributes.uv) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
  return n;
}
const merge = (list) => mergeGeometries(list.map(clean), false);

/**
 * A wool sleeve from the wrist (z = 0) back toward the elbow (z = +len), with compression folds near the wrist,
 * long drape folds, a slightly oval section and a bell at the cuff. uv = (around, meters along) for the wool normal.
 */
function sleeveGeo(len, rWrist, rElbow, seed, cuffCol) {
  const RS = 24, ZS = 26;
  const pos = [], uv = [], idx = [], col = [];
  for (let j = 0; j <= ZS; j++) {
    const t = j / ZS, z = -0.012 + t * len;
    const base = lerp(rWrist, rElbow, Math.pow(t, 0.8));
    for (let i = 0; i <= RS; i++) {
      const a = (i / RS) * TAU;
      let k = 1, fold = 0;
      // turned-back cuff: a bell + a rolled lip
      const cuff = 1 - smoothstep(0.075, 0.095, t);
      k += 0.14 * cuff + 0.06 * Math.exp(-Math.pow((t - 0.085) / 0.018, 2));
      // compression folds bunching above the wrist (each ring wavy around the arm)
      for (let b = 0; b < 4; b++) {
        const c = 0.16 + b * 0.13 + 0.03 * Math.sin(a * 1.3 + seed + b * 2.1);
        const f = Math.exp(-Math.pow((t - c) / 0.035, 2)) * (0.5 + 0.5 * Math.cos(a * 2 + b * 1.7 + seed));
        k += (0.13 - b * 0.02) * f; fold += f * (1 - b * 0.15);
      }
      // long drape folds, mostly on the underside
      const dr = Math.sin(a * 3 + t * 5 + seed) * smoothstep(0.1, 0.5, t) * (0.6 - 0.4 * Math.sin(a));
      k += 0.05 * dr;
      const r = base * k;
      pos.push(Math.cos(a) * r * 1.08, Math.sin(a) * r * 0.93, z);
      // fold shading (valleys darker, crests catch light) + the lighter turned-back lining at the cuff
      const sh = clamp(0.8 + 0.28 * fold + 0.12 * dr, 0.6, 1.15);
      if (cuff > 0.5) col.push(cuffCol.r, cuffCol.g, cuffCol.b); else col.push(sh, sh, sh);
      uv.push(i / RS * (TAU * base) * 6, z * 6);
    }
  }
  for (let j = 0; j < ZS; j++) for (let i = 0; i < RS; i++) {
    const a = j * (RS + 1) + i, b = a + RS + 1;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Capsule segment along -Z from the joint (length len, radius r). */
function seg(len, r, r2 = r) {
  const g = new THREE.CapsuleGeometry(1, 1, 3, 10);
  // reshape the unit capsule: radius taper r → r2 along its length
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i); // -1.5 .. 1.5 (half-length 0.5 + radius 1)
    const t = clamp((y + 1.5) / 3, 0, 1);
    const rr = lerp(r, r2, t);
    p.setXYZ(i, p.getX(i) * rr, (y < -0.5 ? -0.5 * len + (y + 0.5) * r : y > 0.5 ? 0.5 * len + (y - 0.5) * r2 : y * len), p.getZ(i) * rr * 0.9);
  }
  g.computeVertexNormals();
  g.rotateX(-Math.PI / 2); // +Y → -Z
  g.translate(0, 0, -len / 2);
  return g;
}

/**
 * An articulated hand at the wrist (origin): fingers toward -Z, back of the hand +Y, palm -Y.
 * side = +1 right hand (thumb / index on -X), -1 left. Returns { root, fingers: [[j1,j2,j3]×4], thumb: [t1,t2,t3] }.
 */
function buildHand(side, M, add) {
  const root = new THREE.Group();
  // palm (fingerless glove): rounded box, tapered at the wrist, back gently domed
  const palm = box(0.082, 0.03, 0.09, 0.013, 3);
  const pp = palm.attributes.position;
  for (let i = 0; i < pp.count; i++) {
    const x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
    const t = clamp((z + 0.045) / 0.09, 0, 1); // 0 knuckles → 1 wrist
    pp.setXYZ(i, x * (1 - 0.18 * t) + side * 0.004 * t, y + (y > 0 ? 0.005 * Math.cos(x / 0.041 * Math.PI / 2) : 0) - 0.004 * t, z);
  }
  palm.computeVertexNormals();
  palm.translate(0, 0, -0.044);
  add(root, palm, M.leather);
  // the glove's knuckle strap and the wrist (skin under a cloth wrap)
  const strap = box(0.086, 0.034, 0.014, 0.006, 2); strap.translate(0, 0.001, -0.064); add(root, strap, M.strap);
  const wrist = new THREE.CylinderGeometry(0.029, 0.031, 0.07, 14, 1, true); wrist.rotateX(Math.PI / 2); wrist.scale(1.15, 0.85, 1); wrist.translate(0, -0.002, 0.03); add(root, wrist, M.wrap);
  for (let b = 0; b < 3; b++) { const t = new THREE.TorusGeometry(0.031, 0.0045, 5, 18); t.scale(1.15, 0.85, 1); t.rotateY(0.18 * (b - 1)); t.translate(0, -0.002, 0.008 + b * 0.019); add(root, t, M.wrap); }
  const fingers = [];
  const KX = [-0.029, -0.0095, 0.0095, 0.0275], KZ = [-0.087, -0.09, -0.088, -0.081];
  const L1 = [0.04, 0.044, 0.042, 0.033], L2 = [0.025, 0.028, 0.026, 0.02], L3 = [0.021, 0.023, 0.022, 0.019];
  const RR = [0.0094, 0.0097, 0.0091, 0.0081];
  for (let f = 0; f < 4; f++) {
    const j1 = new THREE.Group(); j1.position.set(side * KX[f], -0.002, KZ[f]); j1.rotation.order = 'YXZ'; root.add(j1);
    add(j1, seg(L1[f], RR[f], RR[f] * 0.93), M.leather); // glove covers the first phalanx
    const j2 = new THREE.Group(); j2.position.z = -L1[f]; j1.add(j2);
    add(j2, seg(L2[f], RR[f] * 0.9, RR[f] * 0.84), M.skin);
    const j3 = new THREE.Group(); j3.position.z = -L2[f]; j2.add(j3);
    add(j3, seg(L3[f], RR[f] * 0.82, RR[f] * 0.74), M.skin);
    fingers.push([j1, j2, j3]);
  }
  const t1 = new THREE.Group(); t1.position.set(-side * 0.036, -0.013, -0.024); t1.rotation.order = 'YXZ'; root.add(t1);
  add(t1, seg(0.036, 0.0125, 0.0115), M.leather);
  const t2 = new THREE.Group(); t2.position.z = -0.036; t2.rotation.order = 'YXZ'; t1.add(t2);
  add(t2, seg(0.028, 0.0108, 0.0098), M.skin);
  const t3 = new THREE.Group(); t3.position.z = -0.028; t2.add(t3);
  add(t3, seg(0.023, 0.0094, 0.0082), M.skin);
  return { root, fingers, thumb: [t1, t2, t3] };
}

// finger poses: [proximal, middle, distal] curl (negative = toward the palm), spread (per finger, × side)
const GRIP = { curl: [[-1.32, -1.5, -0.9], [-1.38, -1.52, -0.9], [-1.4, -1.5, -0.85], [-1.42, -1.45, -0.8]], spread: [0.04, 0, -0.03, -0.06], thumb: [-0.36, -0.45, -0.35, -0.3] };
const OPEN = { curl: [[-0.08, -0.14, -0.1], [-0.18, -0.22, -0.14], [-0.3, -0.34, -0.2], [-0.46, -0.44, -0.3]], spread: [0.16, 0.05, -0.05, -0.17], thumb: [0.5, -0.32, -0.15, -0.12] };

function poseHand(H, side, w) { // w: 0 grip → 1 open
  for (let f = 0; f < 4; f++) {
    const J = H.fingers[f];
    for (let k = 0; k < 3; k++) J[k].rotation.x = lerp(GRIP.curl[f][k], OPEN.curl[f][k], w);
    J[0].rotation.y = side * lerp(GRIP.spread[f], OPEN.spread[f], w);
  }
  const T = H.thumb;
  T[0].rotation.y = side * lerp(GRIP.thumb[0], OPEN.thumb[0], w);
  T[0].rotation.x = lerp(GRIP.thumb[1], OPEN.thumb[1], w);
  T[1].rotation.x = lerp(GRIP.thumb[2], OPEN.thumb[2], w);
  T[2].rotation.x = lerp(GRIP.thumb[3], OPEN.thumb[3], w);
}

export class Viewmodel {
  constructor(palette, quality) {
    const P = palette;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'viewmodel';
    this.group.visible = false;
    const tex = getTextures(null);
    const wool = new THREE.MeshStandardMaterial({ color: new THREE.Color(P.coat).multiplyScalar(1.05), roughness: 0.96, vertexColors: true });
    // the turned-back cuff shows the lighter lining (relative to the coat colour, vertex colours multiply it)
    const cw = new THREE.Color(P.coat), cl = new THREE.Color(P.wrap);
    const cuffCol = new THREE.Color(cl.r / Math.max(cw.r, 0.05), cl.g / Math.max(cw.g, 0.05), cl.b / Math.max(cw.b, 0.05)).multiplyScalar(0.55);
    if (tex.woolNormal) { wool.normalMap = tex.woolNormal; wool.normalScale = new THREE.Vector2(0.75, 0.75); wool.normalMap.channel = 0; }
    const M = {
      wool,
      leather: new THREE.MeshStandardMaterial({ color: P.leather, roughness: 0.62 }),
      strap: new THREE.MeshStandardMaterial({ color: P.strap, roughness: 0.7 }),
      brass: new THREE.MeshStandardMaterial({ color: P.brass, roughness: 0.38, metalness: 0.85 }),
      wood: new THREE.MeshStandardMaterial({ color: P.wood, roughness: 0.72 }),
      skin: new THREE.MeshStandardMaterial({ color: P.skin, roughness: 0.58 }),
      wrap: new THREE.MeshStandardMaterial({ color: P.wrap, roughness: 0.92 }),
      glass: new THREE.MeshBasicMaterial({ color: new THREE.Color(P.lamp).multiplyScalar(2.4), transparent: true, opacity: 0.92 }),
      core: new THREE.MeshBasicMaterial({ color: new THREE.Color(P.glow).multiplyScalar(10) }),
    };
    this.materials = Object.values(M);
    const add = (parent, g, m) => { const mesh = new THREE.Mesh(g, m); mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = false; parent.add(mesh); return mesh; };

    // ---------------------------------------------------------------- arms (wrist at the group origin)
    this.armR = new THREE.Group(); this.group.add(this.armR);
    add(this.armR, sleeveGeo(0.5, 0.04, 0.056, 1.3, cuffCol), wool);
    this.handR = buildHand(1, M, add); this.armR.add(this.handR.root); this.handR.root.scale.setScalar(1.15);
    this.armL = new THREE.Group(); this.group.add(this.armL);
    add(this.armL, sleeveGeo(0.55, 0.04, 0.058, 4.1, cuffCol), wool);
    this.handL = buildHand(-1, M, add); this.armL.add(this.handL.root); this.handL.root.scale.setScalar(1.15);
    poseHand(this.handR, 1, 0);
    poseHand(this.handL, -1, 0);
    this.grip = new THREE.Vector3(0, -0.032, -0.085); // rod centre inside a closed fist (hand space)

    // ---------------------------------------------------------------- the katana (right fist) — when drawn
    this.uGlow = { value: 0 }; this.uGlowCol = { value: new THREE.Color(1.0, 0.85, 0.6) };
    this.sword = buildSwordGroup(P, quality, this.uGlow, this.uGlowCol);
    this.group.add(this.sword);
    for (const m of this.sword.userData.mats) this.materials.push(m);

    // ---------------------------------------------------------------- the Lumen held above the open left palm
    this.orb = new THREE.Group(); this.group.add(this.orb);
    {
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.016, 14, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(P.glow).multiplyScalar(5) }));
      core.frustumCulled = false; this.orb.add(core); this.materials.push(core.material);
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const c2 = cv.getContext('2d'); const gr = c2.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,248,230,1)'); gr.addColorStop(0.15, 'rgba(255,228,180,0.7)'); gr.addColorStop(0.45, 'rgba(255,200,150,0.15)'); gr.addColorStop(1, 'rgba(255,190,140,0)');
      c2.fillStyle = gr; c2.fillRect(0, 0, 64, 64);
      const tx = new THREE.CanvasTexture(cv); tx.colorSpace = THREE.SRGBColorSpace;
      this.orbHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tx, color: new THREE.Color(1.5, 1.3, 1.0), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      this.orbHalo.scale.setScalar(0.16); this.orb.add(this.orbHalo); this.materials.push(this.orbHalo.material);
      this.lightAnchor = new THREE.Object3D(); this.orb.add(this.lightAnchor);
    }

    // ---- poses (camera space): wrist position, forearm direction, palm axis hint, roll
    this.P = {
      // sword hand: low right, forearm rising in from the lower-right corner, the blade up and away into the view
      swordWrist: new THREE.Vector3(0.29, -0.25, -0.5), swordFore: new THREE.Vector3(-0.5, 0.2, -0.84).normalize(), swordDir: new THREE.Vector3(-0.3, 0.7, -0.64).normalize(),
      // relaxed right hand (sheathed): lower, loosely closed
      restWrist: new THREE.Vector3(0.36, -0.3, -0.5), restFore: new THREE.Vector3(-0.3, 0.38, -0.87).normalize(), restX: new THREE.Vector3(1, 0.2, 0.2),
      // light hand: low left, palm up and cupped, the Lumen hovering above it
      lightWrist: new THREE.Vector3(-0.29, -0.235, -0.5), lightFore: new THREE.Vector3(0.42, 0.3, -0.86).normalize(), lightX: new THREE.Vector3(-1, 0.1, -0.45),
      // reach: the whole left arm out from the lower-left corner toward the view, palm forward (the pulse goes out)
      reachWrist: new THREE.Vector3(-0.255, -0.15, -0.62), reachFore: new THREE.Vector3(0.6, 0.36, -0.72).normalize(), reachX: new THREE.Vector3(1, -0.15, 0.15),
    };
    this._qSword = new THREE.Quaternion(); this._qRest = new THREE.Quaternion(); this._qLight = new THREE.Quaternion(); this._qReach = new THREE.Quaternion();
    basisQuat(this.P.swordFore, this.P.swordDir, 0, this._qSword, true);
    basisQuat(this.P.restFore, this.P.restX, 0.2, this._qRest);
    basisQuat(this.P.lightFore, this.P.lightX, 0, this._qLight);
    basisQuat(this.P.reachFore, this.P.reachX, -0.42, this._qReach);
    this._swDir = new THREE.Vector3(); this._swEdge = new THREE.Vector3();

    // ---- motion state
    this.t = 0; this.reach = 0; this.drawnW = 0;
    this.lagX = new Spring(0, 9, 0.7); this.lagY = new Spring(0, 9, 0.7);
    this.depthK = 1;
  }

  /**
   * @param ctx { visible, speed, phase (gait 0..1), lookX, lookY (rad this frame), reach (bool), state, aspect, pitch, fov,
   *              drawn (bool), act (katana action or null), u (0..1), glow, light (0..1) }
   */
  update(dt, ctx) {
    const show = !!ctx.visible;
    this.group.visible = show;
    if (!show || dt <= 0) return;
    this.t += dt;
    const sp = ctx.speed || 0;
    const walk = smoothstep(0.2, 2, sp), run = smoothstep(4, 9, sp);
    const ph = (ctx.phase || 0) * TAU;
    const swim = ctx.state === 'swim' ? 1 : 0, air = ctx.state === 'glide' || ctx.state === 'air' ? 1 : 0;
    const fov = ctx.fov || 72;
    const k = Math.tan(36 * Math.PI / 180) / Math.tan(clamp(fov, 20, 110) * Math.PI / 360);
    this.group.scale.set(1, 1, k);
    const wide = clamp((ctx.aspect || 1.78) / 1.78, 0.6, 1.3);
    this.lagX.update(clamp(-(ctx.lookX || 0) * 2.2, -0.06, 0.06), dt);
    this.lagY.update(clamp(-(ctx.lookY || 0) * 2.2, -0.05, 0.05), dt);
    const breath = Math.sin(this.t * 1.6) * 0.004;
    const bobY = -Math.abs(Math.sin(ph)) * 0.016 * walk * (1 + run) + breath;
    const bobX = Math.sin(ph) * 0.011 * walk;
    this.reach = damp(this.reach, ctx.reach ? 1 : 0, ctx.reach ? 3.5 : 2.4, dt);
    const rc = smoothstep(0, 1, this.reach);
    const P = this.P;
    this.uGlow.value = ctx.glow || 0;

    // ---- right arm: the katana (drawn) or a relaxed hand
    const act = ctx.act || null, u = ctx.u || 0;
    let drawnT = ctx.drawn ? 1 : 0;
    if (act === 'draw') drawnT = smoothstep(0.3, 0.7, u);
    else if (act === 'sheathe') drawnT = 1 - smoothstep(0.35, 0.8, u);
    else if (act === 'charge') drawnT = 0;
    this.drawnW = damp(this.drawnW, drawnT, 14, dt);
    const dw = this.drawnW;
    const R = this.armR;
    _v.copy(P.restWrist).lerp(P.swordWrist, dw); _v.x *= wide;
    R.position.copy(_v);
    R.position.x += bobX + this.lagX.x; R.position.y += bobY + this.lagY.x - 0.08 * swim - 0.03 * air - 0.02 * run;
    R.position.y -= (1 - dw) * 0.02 + (act === 'draw' ? (1 - smoothstep(0.3, 0.7, u)) * 0.25 : 0);
    R.quaternion.slerpQuaternions(this._qRest, this._qSword, dw);
    // a cut in first person: the fist sweeps across the frame and the blade follows (diagonal / flat / rising)
    let swing = 0, sx = 0, sy = 0, roll = 0;
    if (act && act.startsWith('slash')) {
      const t = smoothstep(0.18, 0.5, u) - smoothstep(0.62, 1, u) * 0;
      swing = Math.sin(Math.min(1, u * 1.6) * Math.PI) ;
      const dir = act === 'slash2' ? -1 : 1;
      sx = lerp(0.12, -0.42, t) * dir; sy = act === 'slash3' ? lerp(-0.12, 0.14, t) : lerp(0.16, -0.12, t);
      roll = lerp(0.6, -0.9, t) * dir;
      const back = smoothstep(0.55, 1, u);
      sx *= 1 - back; sy *= 1 - back; roll *= 1 - back;
    } else if (act === 'iai') {
      const t = smoothstep(0.04, 0.13, u), back = smoothstep(0.62, 1, u);
      sx = lerp(0.05, -0.5, t) * (1 - back); sy = lerp(0.1, -0.02, t) * (1 - back); roll = lerp(0.4, -1.2, t) * (1 - back); swing = 1 - back;
    }
    R.position.x += sx * dw; R.position.y += sy * dw;
    poseHand(this.handR, 1, lerp(0.35, 0, dw));
    // sword: along the fist's X axis, edge rolled down/forward; the cut rolls it across
    _swDirFrom(this._swDir, R.quaternion);
    _q.setFromAxisAngle(_w.set(0, 0, -1), roll * dw);
    this._swDir.applyQuaternion(_q);
    this._swEdge.set(0.25, -1, 0.2).addScaledVector(this._swDir, -this._swDir.dot(_w.set(0.25, -1, 0.2))).normalize();
    _x.crossVectors(this._swDir, this._swEdge);
    _m.makeBasis(_x, this._swDir, this._swEdge);
    this.sword.quaternion.setFromRotationMatrix(_m);
    _v.copy(this.grip).multiplyScalar(1.15).applyQuaternion(R.quaternion).add(R.position).addScaledVector(this._swDir, 0.045);
    this.sword.position.copy(_v);
    this.sword.visible = dw > 0.05 && swim < 0.5;
    this.swing = swing;

    // ---- left arm: the light in the open palm ↔ reach toward the view (the pulse)
    const L = this.armL;
    _v.copy(P.lightWrist); _v.x *= wide;
    _w.copy(P.reachWrist); _w.x *= lerp(1, wide, 0.5);
    L.position.lerpVectors(_v, _w, rc);
    L.position.x += -bobX * 0.8 + this.lagX.x; L.position.y += bobY * 0.9 + this.lagY.x - 0.08 * swim + Math.sin(this.t * 0.9) * 0.004;
    _qa.copy(this._qLight); _qb.copy(this._qReach);
    if (rc > 0) _qb.multiply(_q.setFromAxisAngle(ZA, Math.sin(this.t * 0.7) * 0.05));
    L.quaternion.slerpQuaternions(_qa, _qb, rc);
    poseHand(this.handL, -1, lerp(0.62, 0.95, rc));
    // the Lumen floats a hand's breadth above the palm (it rides forward with the reach and comes back)
    _v.set(0, -0.095 + 0.008 * Math.sin(this.t * 1.7), -0.07).multiplyScalar(1.15).applyQuaternion(_qa).add(L.position);
    _w.set(0, 0.05, -0.32).add(_v);
    this.orb.position.lerpVectors(_v, _w, rc * 0.6);
    const li = clamp(ctx.light ?? 1, 0, 1);
    this.orb.visible = li > 0.02 && swim < 0.5;
    this.orbHalo.material.opacity = li;
    this.orbHalo.scale.setScalar(0.13 + 0.05 * li + 0.01 * Math.sin(this.t * 5.1));
    L.visible = true;
  }

  dispose() {
    this.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
  }
}
