// Player track — the companion: a white wolf (season 2, the swordswoman's companion; it fits the creator's
// Characters frames — "a child before a great animal", tender contact). Pale silver-white fur, a faint ring of
// light on its brow (the sign of the source) and a wisp of light at the tail tip. It lopes after her with a
// spring-damped offset, sits down beside her when she rests (at her left hip, looking out at the same view), leans
// into the arm put around it and now and then turns its head to her.
//
// Fallback for the fauna track's planned `world.get('fauna').companion` — the Player only builds this one when
// fauna does not provide a companion. One skinned mesh pair (fur + glow), 11 bones, ~3k triangles,
// allocation-free per frame.
import * as THREE from 'three';
import { Assembler, ellipsoid, cylinder, torus, loft, xf, rigid, blendY } from './geo.js';
import { patchLighting } from './Explorer.js';
import { clamp, lerp, damp, dampF, smoothstep, projectOnPlane, quatFromUpForward, noise1 } from './util.js';

const C = { root: 0, body: 1, head: 2, tail0: 3, tail1: 4, tail2: 5, legFL: 6, legFR: 7, legBL: 8, legBR: 9, chest: 10 };
const REST = {
  root: [null, 0, 0, 0],
  body: ['root', 0, 0.275, -0.02],
  chest: ['body', 0, 0.295, 0.12],
  head: ['chest', 0, 0.385, 0.19],
  tail0: ['body', 0, 0.305, -0.19],
  tail1: ['tail0', 0, 0.300, -0.3],
  tail2: ['tail1', 0, 0.290, -0.41],
  legFL: ['chest', 0.045, 0.265, 0.13], legFR: ['chest', -0.045, 0.265, 0.13],
  legBL: ['body', 0.05, 0.275, -0.12], legBR: ['body', -0.05, 0.275, -0.12],
};
const NAMES = Object.keys(C).sort((a, b) => C[a] - C[b]);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');

export class Companion {
  constructor(world, player, quality) {
    this.world = world;
    this.player = player;
    const lo = quality?.tier === 'low';
    const R = (n) => Math.max(6, Math.round(n * (lo ? 0.6 : 1)));
    const fur = new THREE.Color('#dfe2e6'), fur2 = new THREE.Color('#cdd2d9'), back = new THREE.Color('#b7bec9');
    const dark = new THREE.Color('#1c1d22'), inner = new THREE.Color('#a8959b'), sock = new THREE.Color('#c3c8cf');
    const glowC = new THREE.Color('#cfe6ff');
    const A = new Assembler();
    const RAD = lo ? 12 : 18;
    // a loft along +Z (character forward): sections [z, halfWidth, halfHeight, centreY]
    const loftZ = (secs, radial = RAD, opts = {}) => {
      const g = loft(secs.map(([z, rx, ry, cy]) => ({ y: z, rx, rz: ry, oz: -cy })), { radial, sub: 3, closeBottom: true, closeTop: true, ...opts });
      return g.rotateX(Math.PI / 2); // (x, y, z) → (x, -z, y): loft y → +Z, -oz → height
    };
    // a leg loft along +Y from the paw up: sections [y, halfWidth, halfDepth, dz] (dz = forward offset)
    const legLoft = (secs) => loft(secs.map(([y, rx, rz, dz]) => ({ y, rx, rz, oz: dz })), { radial: lo ? 8 : 12, sub: 2, closeBottom: true, closeTop: true });
    // a fur tuft: a flattened cone from (x, y, z) along dir — breaks the smooth silhouette into locks of fur
    const _qt = new THREE.Quaternion(), _m4 = new THREE.Matrix4(), _Y = new THREE.Vector3(0, 1, 0), _dv = new THREE.Vector3();
    const tuft = (x, y, z, dx, dy, dz, len, r, col, skin, flat = 0.6) => {
      // a soft lock (a flattened ellipsoid lying along dir), never a spike
      const g = ellipsoid(r, len * 0.5, r * flat, lo ? 6 : 8, lo ? 4 : 6);
      g.translate(0, len * 0.3, 0);
      _qt.setFromUnitVectors(_Y, _dv.set(dx, dy, dz).normalize());
      g.applyMatrix4(_m4.compose(_a.set(x, y, z), _qt, _b.set(1, 1, 1)));
      A.add('fur', g, col, skin);
    };
    const bodySkin = (x, y, z, o) => { const t = smoothstep(-0.03, 0.09, z); o[0] = C.body; o[1] = 1 - t; o[2] = C.chest; o[3] = t; return o; };
    // torso: high rump, tucked waist, deep keel of a chest, shoulders rising into a thick neck
    A.add('fur', loftZ([
      [-0.24, 0.026, 0.026, 0.302], [-0.205, 0.05, 0.056, 0.3], [-0.14, 0.057, 0.064, 0.292], [-0.06, 0.049, 0.053, 0.3],
      [0.02, 0.054, 0.072, 0.29], [0.09, 0.06, 0.088, 0.284], [0.15, 0.059, 0.085, 0.296], [0.195, 0.048, 0.064, 0.33],
    ]), fur, bodySkin);
    // the darker silver saddle along the spine
    A.add('fur', loftZ([[-0.21, 0.03, 0.02, 0.338], [-0.1, 0.044, 0.026, 0.338], [0.02, 0.046, 0.03, 0.345], [0.13, 0.05, 0.03, 0.362], [0.18, 0.04, 0.024, 0.37]], RAD), back, bodySkin);
    // neck + the great ruff (mane) around it
    const neckSkin = blendY(C.chest, C.head, 0.34, 0.4);
    A.add('fur', ellipsoid(0.052, 0.07, 0.06, R(14), R(10)).rotateX(-0.55).translate(0, 0.37, 0.185), fur, neckSkin);
    A.add('fur', ellipsoid(0.07, 0.078, 0.062, R(16), R(10)).rotateX(-0.35).translate(0, 0.345, 0.165), fur, neckSkin);
    tuft(0, 0.26, 0.15, 0, -0.85, -0.2, 0.06, 0.03, fur, rigid(C.chest)); // chest bib
    tuft(0.03, 0.25, 0.1, 0.25, -0.9, -0.25, 0.05, 0.022, fur, rigid(C.chest));
    tuft(-0.03, 0.25, 0.1, -0.25, -0.9, -0.25, 0.05, 0.022, fur, rigid(C.chest));
    tuft(0, 0.24, -0.02, 0, -0.95, -0.3, 0.035, 0.03, fur2, bodySkin); // belly fringe
    // head: a long wolf's skull, cheek ruff, a tapering muzzle with a dark nose, tall pointed ears
    const H = rigid(C.head);
    A.add('fur', ellipsoid(0.055, 0.045, 0.062, R(16), R(12)).translate(0, 0.43, 0.215), fur, H);
    A.add('fur', ellipsoid(0.04, 0.02, 0.04, R(10), R(8)).translate(0, 0.462, 0.222), back, H); // brow / forehead
    A.add('fur', loftZ([[0.24, 0.036, 0.036, 0.418], [0.285, 0.027, 0.026, 0.413], [0.318, 0.02, 0.019, 0.409], [0.334, 0.014, 0.014, 0.408]], lo ? 10 : 14), fur, H);
    A.add('fur', ellipsoid(0.02, 0.009, 0.045, R(10), R(6)).translate(0, 0.393, 0.285), fur2, H); // lower jaw
    A.add('fur', ellipsoid(0.013, 0.011, 0.01, 8, 6).translate(0, 0.416, 0.334), dark, H); // nose
    A.add('fur', ellipsoid(0.017, 0.0025, 0.03, 8, 4).translate(0, 0.399, 0.305), dark, H); // mouth line
    for (const s of [1, -1]) {
      for (let i = 0; i < 2; i++) tuft(s * 0.044, 0.41 - i * 0.014, 0.215 - i * 0.012, s * 0.85, -0.25 - i * 0.2, -0.45, 0.05, 0.019, i ? fur2 : fur, H);
      const ear = cylinder(0.003, 0.028, 0.062, R(8)); ear.scale(1, 1, 0.5); xf(ear, s * 0.03, 0.488, 0.198, -0.16, 0, -s * 0.2); A.add('fur', ear, fur2, H);
      const ein = cylinder(0.002, 0.018, 0.045, R(6)); ein.scale(1, 1, 0.3); xf(ein, s * 0.03, 0.482, 0.208, -0.16, 0, -s * 0.2); A.add('fur', ein, inner, H);
      const eye = ellipsoid(0.012, 0.0065, 0.006, 8, 6); xf(eye, s * 0.027, 0.444, 0.27, 0, s * 0.5, s * 0.22); A.add('fur', eye, dark, H);
    }
    A.add('glow', torus(0.012, 0.0026, 4, 18).rotateX(-0.25).translate(0, 0.468, 0.262), glowC.clone().multiplyScalar(0.8), H);
    // a full brush of a tail: three segments, thick then tapering to a wisp of light
    A.add('fur', ellipsoid(0.03, 0.033, 0.075, R(12), R(8)).translate(0, 0.303, -0.245), back, rigid(C.tail0));
    A.add('fur', ellipsoid(0.042, 0.044, 0.088, R(12), R(8)).translate(0, 0.296, -0.355), fur2, rigid(C.tail1));
    A.add('fur', ellipsoid(0.034, 0.034, 0.075, R(12), R(8)).translate(0, 0.288, -0.46), fur, rigid(C.tail2));
    for (const [bn, z0, n] of [['tail1', -0.36, 3]]) for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (bn === 'tail2' ? 0.5 : 0);
      tuft(Math.sin(a) * 0.026, 0.296 + Math.cos(a) * 0.026, z0, Math.sin(a) * 0.3, Math.cos(a) * 0.3, -1, 0.08, 0.026, fur, rigid(C[bn]));
    }
    A.add('glow', ellipsoid(0.014, 0.014, 0.034, R(10), R(8)).translate(0, 0.286, -0.53), glowC.clone().multiplyScalar(0.7), rigid(C.tail2));
    // legs: long and lean — the fore leg straight with a soft wrist, the hind leg with the wolf's hock angle
    const FORE = [[0.006, 0.017, 0.024, 0.016], [0.026, 0.013, 0.017, 0.008], [0.06, 0.0105, 0.012, 0.002], [0.1, 0.0115, 0.013, 0.0], [0.17, 0.013, 0.017, -0.004], [0.215, 0.019, 0.028, -0.012], [0.265, 0.03, 0.048, -0.004], [0.305, 0.028, 0.05, 0.0]];
    const HIND = [[0.006, 0.017, 0.024, 0.014], [0.026, 0.012, 0.016, 0.006], [0.07, 0.0105, 0.013, -0.006], [0.112, 0.012, 0.018, -0.024], [0.155, 0.018, 0.03, -0.014], [0.205, 0.029, 0.05, 0.0], [0.255, 0.037, 0.06, 0.006], [0.3, 0.033, 0.055, 0.0]];
    for (const [bn, x, y, z] of [['legFL', 0.045, 0.265, 0.13], ['legFR', -0.045, 0.265, 0.13], ['legBL', 0.05, 0.275, -0.12], ['legBR', -0.05, 0.275, -0.12]]) {
      const hind = bn[3] === 'B';
      const g = legLoft(hind ? HIND : FORE); g.translate(x, 0, z);
      A.add('fur', g, fur, rigid(C[bn]));
      A.add('fur', ellipsoid(0.019, 0.011, 0.027, R(8), R(6)).translate(x, 0.01, z + (hind ? 0.016 : 0.018)), sock, rigid(C[bn]));
      tuft(x + Math.sign(x) * 0.01, hind ? 0.15 : 0.19, z - (hind ? 0.03 : 0.018), Math.sign(x) * 0.2, -0.5, -0.85, 0.04, 0.016, fur2, rigid(C[bn])); // feathering
    }
    const geos = A.build();
    this.tris = A.tris;
    // fur mottling: a soft value noise over the coat, a paler belly, a cooler shade along the back
    const fg = geos.get('fur');
    if (fg) {
      const P = fg.attributes.position, Cc = fg.attributes.color;
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        const n = Math.sin(x * 61 + z * 23) * Math.sin(y * 47 - z * 31) * 0.5 + Math.sin(x * 143 - y * 97 + z * 71) * 0.25;
        const k = (0.95 + 0.06 * n) * (1 + 0.05 * smoothstep(0.32, 0.22, y) * smoothstep(0.05, 0.2, y));
        Cc.setXYZ(i, Cc.getX(i) * k, Cc.getY(i) * k, Cc.getZ(i) * k * 1.01);
      }
    }
    // skeleton
    this.bones = NAMES.map((n) => { const b = new THREE.Bone(); b.name = 'wolf-' + n; return b; });
    for (const n of NAMES) {
      const [par, x, y, z] = REST[n];
      const b = this.bones[C[n]];
      if (par) { this.bones[C[par]].add(b); b.position.set(x - REST[par][1], y - REST[par][2], z - REST[par][3]); } else b.position.set(x, y, z);
    }
    this.rest = this.bones.map((b) => b.position.clone());
    this.bones[C.root].updateMatrixWorld(true); // bind pose = rest (bone inverses from the rest transforms)
    this.skeleton = new THREE.Skeleton(this.bones);
    const furMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    patchLighting(furMat, { rim: 0.6, sky: 0.25, key: 'wolf', sunRim: 1.5, wear: 0 });
    const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1, 1, 1).multiplyScalar(3.2) });
    this.materials = [furMat, glowMat];
    this.group = new THREE.Group();
    this.group.name = 'companion';
    this.scale = 1.85; // a big white wolf (shoulder ≈ 0.62 m)
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
    if (sit) out.copy(p.pos).addScaledVector(_b, 0.66).addScaledVector(p.forward, 0.04);
    else out.copy(p.pos).addScaledVector(_b, 1.5).addScaledVector(p.forward, -1.7);
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
    const want = resting ? clamp(d * 2.5, 0, 3.5) : d < 0.8 ? 0 : clamp((d - 0.8) * 2.4, 0, Math.max(11, p.speed * 1.15));
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
    this.seated = resting && d < 0.3;
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
    B[C.body].position.y += Math.abs(Math.sin(ph)) * 0.02 * run - 0.105 * sit;
    _e.set(-0.6 * sit + Math.sin(ph * 2) * 0.03 * run, 0, -0.16 * hug); B[C.body].quaternion.setFromEuler(_e);
    _e.set(0.32 * sit, 0, 0); B[C.chest].quaternion.setFromEuler(_e);
    // legs: diagonal trot; seated hind legs fold forward under the body
    const sw = 0.55 * run;
    _e.set(Math.sin(ph) * sw + 0.3 * sit, 0, 0); B[C.legFL].quaternion.setFromEuler(_e);
    _e.set(-Math.sin(ph) * sw + 0.3 * sit, 0, 0); B[C.legFR].quaternion.setFromEuler(_e);
    _e.set(-Math.sin(ph) * sw - 0.6 * sit, 0, 0.1 * sit); B[C.legBL].quaternion.setFromEuler(_e);
    _e.set(Math.sin(ph) * sw - 0.6 * sit, 0, -0.1 * sit); B[C.legBR].quaternion.setFromEuler(_e);
    // head: look ahead / at the explorer; when hugged, tilt toward the explorer's face, a little nuzzle
    this.lookUp = damp(this.lookUp, resting ? 0.5 + 0.5 * Math.sin(this.t * 0.17) : 0, 0.8, dt);
    const nuzzle = hug * (0.5 + 0.5 * Math.sin(this.t * 1.3)) * smoothstep(0.6, 0.9, Math.sin(this.t * 0.31) * 0.5 + 0.5);
    _e.set(0.25 * sit - 0.35 * this.lookUp * (1 - hug) - 0.25 * hug + Math.sin(ph * 2) * 0.05 * run, -0.5 * hug - 0.2 * nuzzle, -0.3 * hug - 0.15 * nuzzle);
    B[C.head].quaternion.setFromEuler(_e);
    // tail: lags behind turns, wags slowly, curls round the paws when seated
    const wag = Math.sin(this.t * (resting ? 1.1 : 2.6)) * (resting ? 0.12 : 0.28) + noise1(this.t * 0.7, 5) * 0.1;
    _e.set(-0.5 + 0.8 * sit + 0.3 * run, wag - 0.7 * sit, 0); B[C.tail0].quaternion.setFromEuler(_e);
    _e.set(-0.2 + 0.35 * sit + 0.1 * run, wag * 0.8 - 0.8 * sit, 0); B[C.tail1].quaternion.setFromEuler(_e);
    _e.set(0.1 * sit, wag * 0.6 - 0.9 * sit, 0); B[C.tail2].quaternion.setFromEuler(_e);
    // place
    quatFromUpForward(this.up, this.fwd, this._gq);
    this.group.position.copy(this.pos);
    this.group.quaternion.copy(this._gq);
    this.group.scale.setScalar(this.scale);
    this.group.updateMatrixWorld(true);
    this.headPos.set(0, 0.43 * this.scale, 0.24 * this.scale).applyQuaternion(this._gq).add(this.pos);
  }

  dispose() {
    for (const c of this.group.children) if (c.isSkinnedMesh) c.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.skeleton.dispose?.();
  }
}
