// Player track — the small companion: a "lantern fox", a cream-furred little creature whose tail tip glows like a
// lantern and who wears a tiny ring of light on its brow (the sign of the source, small). It trots after the
// explorer with a spring-damped offset, sits down beside them when they rest (at the left hip, looking out at
// the same view), leans into the arm put around it and now and then turns its head up to the explorer.
//
// Fallback for the fauna track's planned `world.get('fauna').companion` — the Player only builds this one when
// fauna does not provide a companion. One skinned mesh pair (fur + glow), 11 bones, ~3k triangles,
// allocation-free per frame.
import * as THREE from 'three';
import { Assembler, ellipsoid, cylinder, torus, xf, rigid, blendY } from './geo.js';
import { patchLighting } from './Explorer.js';
import { clamp, lerp, damp, dampF, smoothstep, projectOnPlane, quatFromUpForward, noise1 } from './util.js';

const C = { root: 0, body: 1, head: 2, tail0: 3, tail1: 4, tail2: 5, legFL: 6, legFR: 7, legBL: 8, legBR: 9, chest: 10 };
const REST = {
  root: [null, 0, 0, 0],
  body: ['root', 0, 0.2, -0.02],
  chest: ['body', 0, 0.22, 0.12],
  head: ['chest', 0, 0.31, 0.19],
  tail0: ['body', 0, 0.23, -0.19],
  tail1: ['tail0', 0, 0.225, -0.3],
  tail2: ['tail1', 0, 0.215, -0.41],
  legFL: ['chest', 0.045, 0.19, 0.13], legFR: ['chest', -0.045, 0.19, 0.13],
  legBL: ['body', 0.05, 0.2, -0.12], legBR: ['body', -0.05, 0.2, -0.12],
};
const NAMES = Object.keys(C).sort((a, b) => C[a] - C[b]);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');

export class Companion {
  constructor(world, player, quality) {
    this.world = world;
    this.player = player;
    const lo = quality?.tier === 'low';
    const R = (n) => Math.max(6, Math.round(n * (lo ? 0.6 : 1)));
    const fur = new THREE.Color('#efe4d0'), fur2 = new THREE.Color('#d9a66a'), dark = new THREE.Color('#2a211b'), inner = new THREE.Color('#c88f78');
    const glowC = new THREE.Color('#ffd79a');
    const A = new Assembler();
    // body + chest ruff + neck
    const back = new THREE.Color('#e2b98c');
    A.add('fur', ellipsoid(0.082, 0.08, 0.19, R(18), R(12)).translate(0, 0.2, -0.03), back, (x, y, z, o) => { const t = smoothstep(-0.02, 0.1, z); o[0] = C.body; o[1] = 1 - t; o[2] = C.chest; o[3] = t; return o; });
    A.add('fur', ellipsoid(0.07, 0.08, 0.075, R(14), R(10)).translate(0, 0.23, 0.12), fur, rigid(C.chest));
    A.add('fur', ellipsoid(0.05, 0.075, 0.055, R(12), R(8)).translate(0, 0.29, 0.17), fur, blendY(C.chest, C.head, 0.27, 0.32));
    // head: skull, cheeks, snout + nose, ears (outer warm, inner pink), eyes, brow ring of light
    A.add('fur', ellipsoid(0.062, 0.056, 0.064, R(16), R(12)).translate(0, 0.355, 0.22), fur, rigid(C.head));
    for (const s of [1, -1]) A.add('fur', ellipsoid(0.03, 0.028, 0.035, R(8), R(6)).translate(s * 0.045, 0.335, 0.235), fur, rigid(C.head));
    A.add('fur', ellipsoid(0.028, 0.025, 0.055, R(10), R(8)).translate(0, 0.336, 0.29), fur, rigid(C.head));
    A.add('fur', ellipsoid(0.011, 0.009, 0.009, 8, 6).translate(0, 0.345, 0.343), dark, rigid(C.head));
    for (const s of [1, -1]) {
      const ear = cylinder(0.0, 0.032, 0.085, R(10)); xf(ear, s * 0.038, 0.418, 0.205, -0.15, 0, -s * 0.32); A.add('fur', ear, fur2, rigid(C.head));
      const ein = cylinder(0.0, 0.02, 0.06, R(8)); xf(ein, s * 0.037, 0.412, 0.214, -0.15, 0, -s * 0.32); A.add('fur', ein, inner, rigid(C.head));
      const eye = ellipsoid(0.011, 0.012, 0.007, 8, 6); xf(eye, s * 0.03, 0.365, 0.275, 0, s * 0.45, 0); A.add('fur', eye, dark, rigid(C.head));
    }
    A.add('glow', torus(0.013, 0.003, 4, 16).translate(0, 0.392, 0.262), glowC.clone().multiplyScalar(0.8), rigid(C.head));
    // fluffy tail (three segments, thickening then tapering), warm tip that glows like a lantern
    A.add('fur', ellipsoid(0.042, 0.042, 0.075, R(12), R(8)).translate(0, 0.228, -0.24), fur, rigid(C.tail0));
    A.add('fur', ellipsoid(0.058, 0.056, 0.075, R(12), R(8)).translate(0, 0.22, -0.35), fur, rigid(C.tail1));
    A.add('fur', ellipsoid(0.05, 0.048, 0.06, R(12), R(8)).translate(0, 0.212, -0.45), fur2, rigid(C.tail2));
    A.add('glow', ellipsoid(0.036, 0.035, 0.04, R(10), R(8)).translate(0, 0.21, -0.505), glowC, rigid(C.tail2));
    // legs + paws (darker socks)
    for (const [bn, x, y, z] of [['legFL', 0.045, 0.19, 0.13], ['legFR', -0.045, 0.19, 0.13], ['legBL', 0.05, 0.2, -0.12], ['legBR', -0.05, 0.2, -0.12]]) {
      const back = bn[3] === 'B';
      A.add('fur', ellipsoid(back ? 0.036 : 0.028, 0.06, back ? 0.05 : 0.032, R(10), R(8)).translate(x, y - 0.03, z), fur, rigid(C[bn]));
      const leg = cylinder(0.014, 0.016, y - 0.02, R(8)); xf(leg, x, (y - 0.02) / 2 + 0.01, z); A.add('fur', leg, fur2.clone().multiplyScalar(0.7), rigid(C[bn]));
      A.add('fur', ellipsoid(0.02, 0.013, 0.028, R(8), R(6)).translate(x, 0.012, z + 0.012), dark, rigid(C[bn]));
    }
    const geos = A.build();
    this.tris = A.tris;
    // skeleton
    this.bones = NAMES.map((n) => { const b = new THREE.Bone(); b.name = 'fox-' + n; return b; });
    for (const n of NAMES) {
      const [par, x, y, z] = REST[n];
      const b = this.bones[C[n]];
      if (par) { this.bones[C[par]].add(b); b.position.set(x - REST[par][1], y - REST[par][2], z - REST[par][3]); } else b.position.set(x, y, z);
    }
    this.rest = this.bones.map((b) => b.position.clone());
    this.bones[C.root].updateMatrixWorld(true); // bind pose = rest (bone inverses from the rest transforms)
    this.skeleton = new THREE.Skeleton(this.bones);
    const furMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    patchLighting(furMat, { rim: 0.6, sky: 0.25, key: 'fox', sunRim: 1.4, wear: 0 });
    const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1, 1, 1).multiplyScalar(3.2) });
    this.materials = [furMat, glowMat];
    this.group = new THREE.Group();
    this.group.name = 'companion';
    this.scale = 1.2;
    this.group.add(this.bones[C.root]);
    for (const [slot, g] of geos) {
      if (!g.getAttribute('aWear')) g.setAttribute('aWear', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      const m = new THREE.SkinnedMesh(g, slot === 'glow' ? glowMat : furMat);
      m.frustumCulled = false; m.castShadow = slot !== 'glow'; m.receiveShadow = slot !== 'glow';
      this.group.add(m);
      m.bind(this.skeleton, new THREE.Matrix4());
    }
    // state (planet-local)
    this.pos = new THREE.Vector3(); this.up = new THREE.Vector3(0, 1, 0); this.fwd = new THREE.Vector3(0, 0, 1);
    this.vel = 0; this.phase = 0; this.t = 0; this.sitW = 0; this.hugW = 0; this.lookUp = 0;
    this.seated = false;
    this.headPos = new THREE.Vector3();
    this.init = false;
    this._gq = new THREE.Quaternion();
  }

  /** Place beside the explorer at once (spawns / teleports / act=rest captures). */
  snap(sit = false) {
    const p = this.player;
    this._target(_a, sit);
    this.pos.copy(_a);
    this.fwd.copy(p.forward);
    this.sitW = sit ? 1 : 0; this.hugW = sit && p.restS?.hug ? 1 : 0;
    this.init = true;
  }

  _target(out, sit) {
    const p = this.player, up = p.up;
    _b.crossVectors(up, p.forward).normalize(); // left of the explorer
    if (sit) out.copy(p.pos).addScaledVector(_b, 0.5).addScaledVector(p.forward, 0.02);
    else out.copy(p.pos).addScaledVector(_b, 1.0).addScaledVector(p.forward, -1.1);
    const H = p.heights;
    if (H) out.setLength(H.groundR(out));
    return out;
  }

  update(dt) {
    const p = this.player;
    if (!p || dt <= 0) return;
    this.t += dt;
    const resting = !!p.restS?.on && p.state === 'ground';
    if (!this.init || this.pos.distanceToSquared(p.pos) > 30 * 30) this.snap(resting && p.restS.w > 0.9);
    const H = p.heights;
    this.up.copy(this.pos).normalize();
    // ---- steering toward the slot beside / behind the explorer
    const tgt = this._target(_a, resting);
    _c.copy(tgt).sub(this.pos); projectOnPlane(_c, this.up);
    const d = _c.length();
    const want = resting ? clamp(d * 2.5, 0, 3.5) : d < 0.6 ? 0 : clamp((d - 0.6) * 2.4, 0, Math.max(11, p.speed * 1.15));
    this.vel = damp(this.vel, want, want > this.vel ? 5 : 8, dt);
    if (d > 1e-4 && this.vel > 0.05) {
      _c.divideScalar(d);
      // turn toward travel
      const ang = Math.atan2(_b.crossVectors(this.fwd, _c).dot(this.up), clamp(this.fwd.dot(_c), -1, 1));
      this.fwd.applyAxisAngle(this.up, ang * dampF(8, dt));
      this.pos.addScaledVector(_c, Math.min(this.vel * dt, d));
    } else if (resting || d < 0.8) {
      // settled: face the same way as the explorer (looking out at the same view)
      const ang = Math.atan2(_b.crossVectors(this.fwd, p.forward).dot(this.up), clamp(this.fwd.dot(p.forward), -1, 1));
      this.fwd.applyAxisAngle(this.up, ang * dampF(2.5, dt));
    }
    projectOnPlane(this.fwd, this.up); if (this.fwd.lengthSq() < 1e-8) this.fwd.copy(p.forward); this.fwd.normalize();
    if (H) this.pos.setLength(H.groundR(this.pos) + (H.water(this.pos) > -1e8 ? Math.max(0, H.R + H.water(this.pos) - H.groundR(this.pos)) : 0));
    this.seated = resting && d < 0.25;
    this.sitW = damp(this.sitW, this.seated || (this.vel < 0.1 && !resting && this.t > 2 && d < 1.0) ? 1 : 0, 3, dt);
    this.hugW = damp(this.hugW, this.seated && p.restS?.hug ? 1 : 0, 1.6, dt);
    // ---- pose
    const B = this.bones;
    const run = smoothstep(0.2, 3, this.vel);
    this.phase += dt * lerp(1.2, 3.4, smoothstep(1, 8, this.vel)) * run;
    const ph = this.phase * Math.PI * 2;
    const sit = this.sitW, hug = this.hugW;
    for (let i = 0; i < B.length; i++) { B[i].position.copy(this.rest[i]); B[i].quaternion.identity(); }
    // body: bob while trotting, sit up (hindquarters down) when seated, lean into the explorer when hugged
    B[C.body].position.y += Math.abs(Math.sin(ph)) * 0.02 * run - 0.05 * sit;
    _e.set(-0.55 * sit + Math.sin(ph * 2) * 0.03 * run, 0, -0.16 * hug); B[C.body].quaternion.setFromEuler(_e);
    _e.set(0.32 * sit, 0, 0); B[C.chest].quaternion.setFromEuler(_e);
    // legs: diagonal trot; seated hind legs fold forward under the body
    const sw = 0.55 * run;
    _e.set(Math.sin(ph) * sw + 0.22 * sit, 0, 0); B[C.legFL].quaternion.setFromEuler(_e);
    _e.set(-Math.sin(ph) * sw + 0.22 * sit, 0, 0); B[C.legFR].quaternion.setFromEuler(_e);
    _e.set(-Math.sin(ph) * sw - 1.25 * sit, 0, 0.12 * sit); B[C.legBL].quaternion.setFromEuler(_e);
    _e.set(Math.sin(ph) * sw - 1.25 * sit, 0, -0.12 * sit); B[C.legBR].quaternion.setFromEuler(_e);
    // head: look ahead / at the explorer; when hugged, tilt toward the explorer's face, a little nuzzle
    this.lookUp = damp(this.lookUp, resting ? 0.5 + 0.5 * Math.sin(this.t * 0.17) : 0, 0.8, dt);
    const nuzzle = hug * (0.5 + 0.5 * Math.sin(this.t * 1.3)) * smoothstep(0.6, 0.9, Math.sin(this.t * 0.31) * 0.5 + 0.5);
    _e.set(0.25 * sit - 0.35 * this.lookUp * (1 - hug) - 0.25 * hug + Math.sin(ph * 2) * 0.05 * run, -0.5 * hug - 0.2 * nuzzle, -0.3 * hug - 0.15 * nuzzle);
    B[C.head].quaternion.setFromEuler(_e);
    // tail: lags behind turns, wags slowly, curls round the paws when seated
    const wag = Math.sin(this.t * (resting ? 1.1 : 2.6)) * (resting ? 0.12 : 0.28) + noise1(this.t * 0.7, 5) * 0.1;
    _e.set(0.35 * sit - 0.1 * run, wag + 0.7 * sit, 0); B[C.tail0].quaternion.setFromEuler(_e);
    _e.set(0.2 * sit, wag * 0.8 + 0.8 * sit, 0); B[C.tail1].quaternion.setFromEuler(_e);
    _e.set(0.1 * sit, wag * 0.6 + 0.9 * sit, 0); B[C.tail2].quaternion.setFromEuler(_e);
    // place
    quatFromUpForward(this.up, this.fwd, this._gq);
    this.group.position.copy(this.pos);
    this.group.quaternion.copy(this._gq);
    this.group.scale.setScalar(this.scale);
    this.group.updateMatrixWorld(true);
    this.headPos.set(0, 0.36 * this.scale, 0.22 * this.scale).applyQuaternion(this._gq).add(this.pos);
  }

  dispose() {
    for (const c of this.group.children) if (c.isSkinnedMesh) c.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.skeleton.dispose?.();
  }
}
