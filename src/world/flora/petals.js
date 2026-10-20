// Drifting petals, leaves, seed fluff and spores (season 2: "petals and leaves blowing across the
// frame; the wind as a living force"). A camera-centred GPU particle volume: two instanced draws (a
// near cube of ~22 m with small petals that fill the frame, a far cube of ~70 m whose specks read as a
// drift across the view). Each particle wraps inside its cube (planet-local, so the volume follows the
// camera without popping), rides the shared wind (G.uWindDir / uWindStrength, integrated on the CPU in
// float64), loops on its own small swirl, surges in the same travelling gust bands as the grass and
// tumbles as it falls. What blows depends on where you stand: the season region at the camera (pink and
// white cherry petals, crimson and orange maple leaves, golden ginkgo fans and pampas fluff, white seed
// fluff in green meadows), glowing spores on alien worlds, motes of light near the World Tree.
// player:slash bursts a flurry of petals / leaves from the cut. Lit by the scene (MeshStandardMaterial +
// onBeforeCompile), alpha-cut (writes depth, so the atmosphere/fog post applies), no per-frame allocation.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { mulberry } from './util.js';
import { seaRamp } from './placement.js';

const _c = new THREE.Vector3(), _w = new THREE.Vector3();

const VERT_PARS = /* glsl */`
attribute vec4 aSeed;
uniform float uTime; uniform vec3 uBox; uniform vec3 uShift; uniform float uSize; uniform float uAmount;
uniform vec3 uUpL; uniform vec3 uWindL; uniform vec3 uShapeW; uniform vec4 uBurst; uniform vec3 uBurstL; uniform float uGustT;
varying vec2 vUvP; varying float vShape; varying float vHash; varying float vFadeP;
vec3 rvRotA(vec3 v, vec3 k, float a){ float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
vec3 rvPetP; vec3 rvPetN;
`;
const VERT_CORE = /* glsl */`
{
  vec4 sd = aSeed;
  float hA = fract(sd.w * 7.31 + sd.x * 3.1), hB = fract(sd.y * 11.7 + sd.w * 1.9);
  vHash = hB;
  // shape by weight: petal | leaf | fluff
  float shp = hA < uShapeW.x ? 0.0 : (hA < uShapeW.x + uShapeW.y ? 1.0 : 2.0);
  vShape = shp;
  float t = uTime;
  // own swirl (a slow loop) + gust surge along the wind (the grass's travelling gust field)
  vec3 sw = vec3(sin(t * (0.45 + 0.5 * sd.w) + sd.x * 40.0), sin(t * (0.7 + 0.4 * sd.y) + sd.z * 31.0) * 0.6, cos(t * (0.4 + 0.5 * sd.z) + sd.y * 27.0)) * (1.0 + 0.6 * sd.w);
  vec3 q0 = sd.xyz * uBox;
  vec3 q = mod(q0 + uShift + sw, uBox) - uBox * 0.5;
  // gust: a forward lurch where the travelling band passes
  float along = dot(q, normalize(uWindL + vec3(1e-4)));
  float gst = 0.5 + 0.5 * sin(along * 0.18 - uGustT * 2.3 + sd.w * 2.0);
  q += uWindL * gst * 0.35;
  // soft edges (wrap seams) and the lens
  vec3 e = 0.5 - abs(q / uBox);
  float edge = smoothstep(0.0, 0.1, min(e.x, min(e.y, e.z)));
  float dc = length(q);
  float nearF = smoothstep(0.35, 1.1, dc);
  float on = step(sd.w, uAmount);
  // a flurry from a katana cut: ~12 % of the near particles fly out of the cut for ~3 s
  float age = t - uBurst.w;
  if (uBurst.w > -1.0 && age >= 0.0 && age < 3.2 && fract(sd.w * 13.7) < 0.12) {
    vec3 dir = normalize(sd.xyz - 0.5 + vec3(0.0, 0.25, 0.0));
    float k = 1.0 - exp(-age * 2.2);
    q = uBurstL + dir * k * 3.2 + uUpL * (1.4 * k - 0.32 * age * age * 0.6) + uWindL * age * 0.6 + sw * 0.15 * age;
    edge = 1.0 - smoothstep(2.4, 3.2, age);
    nearF = smoothstep(0.35, 1.1, length(q));
    on = 1.0;
  }
  float s = uSize * (0.65 + 0.7 * hB) * mix(1.0, 1.7, step(0.5, shp) * step(shp, 1.5)) * mix(1.0, 0.6, step(1.5, shp)) * edge * nearF * on;
  vFadeP = edge;
  // tumble about a per-particle axis
  vec3 ax = normalize(vec3(sd.z - 0.5, sd.x - 0.5, sd.y - 0.45) + 1e-3);
  float a = t * (1.2 + 3.4 * sd.w) + sd.x * 20.0;
  vec3 U = rvRotA(vec3(1.0, 0.0, 0.0), ax, a), V = rvRotA(vec3(0.0, 0.0, 1.0), ax, a);
  float asp = shp < 0.5 ? 0.62 : 1.0;
  rvPetP = q + (U * position.x * asp + V * position.y) * s;
  rvPetN = normalize(cross(U, V));
  vUvP = position.xy;
  if (s < 1e-4) rvPetP = vec3(0.0, -1e5, 0.0);
}
`;
const FRAG_PARS = /* glsl */`
uniform vec3 uPetA; uniform vec3 uPetB; uniform vec3 uLeafA; uniform vec3 uLeafB; uniform vec3 uFluff; uniform float uGlowP; uniform float uNight;
varying vec2 vUvP; varying float vShape; varying float vHash; varying float vFadeP;
vec3 rvPetE = vec3(0.0);
`;
const FRAG_MAP = /* glsl */`
{
  vec2 p = vUvP;
  float inside;
  vec3 col;
  if (vShape < 0.5) {
    // petal: rounded teardrop with a notch at the tip, pale at the base
    vec2 q = vec2(p.x * 1.15, p.y * 0.95 + 0.1);
    float d = length(q) - (0.62 + 0.28 * q.y);
    float notch = length(vec2(p.x * 2.2, p.y - 0.98)) - 0.24;
    inside = step(d, 0.0) * step(0.0, notch);
    col = mix(uPetA, uPetB, step(0.55, vHash)) * mix(1.15, 0.9, smoothstep(-0.8, 0.6, p.y));
  } else if (vShape < 1.5) {
    // leaf: palmate star (maple) or fan, depending on the hash
    float th = atan(p.y, p.x), r = length(p);
    float star = 0.5 + 0.42 * pow(abs(cos(2.5 * (th - 1.5708))), 0.6);
    float fan = step(-0.15, p.y) * (0.95 - 0.1 * abs(sin(th * 9.0)));
    float lim = vHash < 0.5 ? star : fan;
    inside = step(r, lim) * (vHash < 0.5 ? 1.0 : step(0.06, r));
    col = mix(uLeafA, uLeafB, fract(vHash * 5.3)) * (0.85 + 0.3 * (1.0 - r));
  } else {
    // fluff / spore: soft round mote
    float r = length(p);
    inside = step(r, 0.85);
    col = uFluff * (1.1 - 0.5 * r);
  }
  if (inside < 0.5) discard;
  diffuseColor.rgb *= col;
  rvPetE = col * uGlowP * (0.15 + 0.85 * uNight) * (vShape > 1.5 ? 1.0 : 0.25);
}
`;

export class Petals {
  constructor(flora) {
    this.flora = flora;
    this.world = flora.world;
    this.meshes = [];
    this.drift = new Float64Array(3);
    this.t = 0;
    this.sampleT = 1e9;
    this.target = null;
    this.burstAt = -10;
  }

  init() {
    const F = this.flora, q = F.q || {};
    const ps = Math.max(0.2, Math.min(2, q.particleScale ?? 1)) * (q.tier === 'low' ? 0.35 : q.tier === 'med' ? 0.65 : 1);
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
    quad.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    quad.setIndex([0, 1, 3, 0, 3, 2]);
    this.quad = quad;
    const U = {
      uBox: { value: new THREE.Vector3() }, uShift: { value: new THREE.Vector3() }, uSize: { value: 0.03 }, uAmount: { value: 0 },
      uUpL: { value: new THREE.Vector3(0, 1, 0) }, uWindL: { value: new THREE.Vector3() }, uShapeW: { value: new THREE.Vector3(1, 0, 0) },
      uBurst: { value: new THREE.Vector4(0, 0, 0, -10) }, uBurstL: { value: new THREE.Vector3() }, uGustT: G.uTime,
      uPetA: { value: new THREE.Color(0.85, 0.42, 0.52) }, uPetB: { value: new THREE.Color(0.92, 0.82, 0.82) },
      uLeafA: { value: new THREE.Color(0.5, 0.05, 0.02) }, uLeafB: { value: new THREE.Color(0.62, 0.22, 0.03) },
      uFluff: { value: new THREE.Color(0.9, 0.88, 0.8) }, uGlowP: { value: 0 },
    };
    this.U = U;
    const mk = (n, box, size, seed, near) => {
      const g = new THREE.InstancedBufferGeometry();
      g.index = quad.index;
      g.setAttribute('position', quad.attributes.position);
      g.setAttribute('normal', quad.attributes.normal);
      const rnd = mulberry(seed);
      const a = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { a[i * 4] = rnd(); a[i * 4 + 1] = rnd(); a[i * 4 + 2] = rnd(); a[i * 4 + 3] = (i + rnd()) / n; }
      g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(a, 4));
      g.instanceCount = n;
      const u = { ...U, uBox: { value: new THREE.Vector3(box, box * 0.8, box) }, uShift: { value: new THREE.Vector3() }, uSize: { value: size } };
      if (!near) u.uBurst = { value: new THREE.Vector4(0, 0, 0, -10) };
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0, side: THREE.DoubleSide });
      mat.name = 'flora-petals';
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = G.uTime; sh.uniforms.uNight = G.uNight;
        for (const k in u) sh.uniforms[k] = u[k];
        let vs = sh.vertexShader;
        vs = vs.replace('#include <common>', '#include <common>\n' + VERT_PARS);
        vs = vs.replace('#include <beginnormal_vertex>', VERT_CORE + '\nvec3 objectNormal = rvPetN;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(1.0,0.0,0.0);\n#endif');
        vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = rvPetP;');
        sh.vertexShader = vs;
        let fs = sh.fragmentShader;
        fs = fs.replace('#include <common>', '#include <common>\n' + FRAG_PARS);
        fs = fs.replace('#include <map_fragment>', FRAG_MAP);
        fs = fs.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal *= faceDirection;');
        // thin petals: light passes through (back-lit petals glow in the low sun)
        fs = fs.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n#if NUM_SUN_LIGHTS > 0\n{ float bl = pow(clamp(-dot(normalize(vViewPosition), (viewMatrix * vec4(G_SUNDIR, 0.0)).xyz), 0.0, 1.0), 3.0); reflectedLight.directDiffuse += diffuseColor.rgb * sunLights[0].color * (0.25 + 1.2 * bl) * 0.35; }\n#endif');
        fs = fs.replace('G_SUNDIR', 'uSunDirP');
        fs = fs.replace('#include <common>', '#include <common>\nuniform vec3 uSunDirP;');
        sh.uniforms.uSunDirP = G.uSunDir;
        fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rvPetE;');
        sh.fragmentShader = fs;
      };
      mat.customProgramCacheKey = () => 'rv-flora-petals-v1';
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = near ? 'flora-petals-near' : 'flora-petals-far';
      mesh.frustumCulled = false;
      mesh.castShadow = false; mesh.receiveShadow = true;
      mesh.visible = false;
      F.group.add(mesh);
      this.meshes.push({ mesh, u, box, near });
    };
    mk(Math.round(2600 * ps), 22, 0.034, 0x51a7 ^ F.seed, true);
    mk(Math.round(2200 * ps), 70, 0.075, 0x2b9d ^ F.seed, false);
    try { this._off = this.world.events?.on?.('player:slash', (e) => this.burst(e)); } catch (_) { /* optional */ }
    return true;
  }

  /** a flurry of petals / leaves from a katana cut (planet-local pos) */
  burst(e) {
    if (!e?.pos) return;
    this.burstPos = (this.burstPos || new THREE.Vector3()).copy(e.pos);
    this.burstAt = G.uTime.value;
  }

  /** what blows here: season region at the camera, alien spores, motes near the World Tree */
  _scheme(cam) {
    const F = this.flora, S = this.world.surface;
    const key = F.styleKey;
    const T = { amount: 0.2, shape: [0, 0.2, 0.8], petA: [0.85, 0.42, 0.52], petB: [0.92, 0.84, 0.84], leafA: [0.18, 0.3, 0.06], leafB: [0.3, 0.38, 0.08], fluff: [0.9, 0.88, 0.82], glow: 0 };
    const glowStyle = { bioluminescent: 1, fungal: 0.7, crystal: 0.8, giant: 0.5, alien: 0.4 }[key];
    if (glowStyle) {
      const gc = F.S?.grass?.glowTip || [0.4, 1, 0.9];
      Object.assign(T, { amount: 0.45, shape: [0, 0, 1], fluff: [Math.min(1, gc[0] * 1.4 + 0.1), Math.min(1, gc[1] * 1.4 + 0.1), Math.min(1, gc[2] * 1.4 + 0.1)], glow: 1.8 * glowStyle });
    } else if (key === 'wacky') {
      Object.assign(T, { amount: 0.5, shape: [0.7, 0, 0.3], petA: [0.95, 0.4, 0.7], petB: [0.4, 0.85, 0.95], fluff: [1, 0.9, 0.5] });
    } else if (F.seasonAmt > 0.05) {
      let sv = 0;
      try { const l = cam.length() || 1; sv = S.season(cam.x / l, cam.y / l, cam.z / l); } catch (_) { sv = 0; }
      const a = F.seasonAmt;
      const wB = seaRamp(sv, 1) * a, wY = seaRamp(sv, 2) * a, wR = seaRamp(sv, 3) * a;
      if (wB >= 0.45 && wB >= wY) Object.assign(T, { amount: 0.25 + 0.75 * wB, shape: [0.92, 0, 0.08] });
      else if (wR >= 0.45) Object.assign(T, { amount: 0.2 + 0.45 * wR, shape: [0.12, 0.8, 0.08], leafA: [0.5, 0.035, 0.02], leafB: [0.62, 0.2, 0.03] });
      else if (wY >= 0.45) Object.assign(T, { amount: 0.2 + 0.4 * wY, shape: [0, 0.55, 0.45], leafA: [0.62, 0.42, 0.04], leafB: [0.72, 0.55, 0.1], fluff: [0.92, 0.84, 0.62] });
      else Object.assign(T, { amount: 0.18, shape: [0.1, 0.25, 0.65] });
    } else if (key === 'dead' || key === 'barren' || key === 'none') {
      Object.assign(T, { amount: key === 'dead' ? 0.12 : 0, shape: [0, 0.6, 0.4], leafA: [0.3, 0.25, 0.18], leafB: [0.4, 0.33, 0.24] });
    }
    // near the World Tree of light: warm motes drift around its roots and crown
    const wt = F.sacred?.pos;
    if (wt) {
      const d = cam.distanceTo(wt);
      const k = 1 - Math.min(1, Math.max(0, (d - 250) / 500));
      if (k > 0) {
        T.amount = T.amount + (0.8 - T.amount) * k;
        T.shape = T.shape.map((v, i) => v + ((i === 2 ? 0.7 : i === 0 ? 0.3 : 0) - v) * k);
        T.fluff = T.fluff.map((v, i) => v + ([1, 0.85, 0.55][i] - v) * k);
        T.glow = T.glow + (2.2 - T.glow) * k;
      }
    }
    return T;
  }

  update(dt) {
    if (!this.meshes.length) return;
    const W = this.world, cam = W.camera;
    if (!cam) return;
    const F = this.flora;
    _c.copy(cam.position);
    const R = F.R, l = _c.length() || 1;
    const alt = l - R - Math.max(F._gH || 0, F.table?.hasSea ? F.table.sea : -1e9);
    const vis = F.visible && alt < 400;
    for (const m of this.meshes) m.mesh.visible = vis;
    if (!vis) return;
    const shot = !!F.shot;
    this.sampleT += dt;
    if (!this.target || this.sampleT > 1.5) { this.sampleT = 0; this.target = this._scheme(_c); }
    const T = this.target, U = this.U;
    // high above the ground (flying) the drift thins out: it is a ground-level weather
    const altK = 1 - Math.min(1, Math.max(0, (alt - 25) / 90));
    const k = this.cur ? Math.min(1, dt * 0.8) : 1;
    this.cur = true;
    if (shot) {
      // deterministic stills: no lerp history
      U.uAmount.value = T.amount * altK;
    } else U.uAmount.value += (T.amount * altK - U.uAmount.value) * k;
    const kk = shot ? 1 : k;
    U.uShapeW.value.set(U.uShapeW.value.x + (T.shape[0] - U.uShapeW.value.x) * kk, U.uShapeW.value.y + (T.shape[1] - U.uShapeW.value.y) * kk, 0);
    U.uPetA.value.setRGB(...T.petA); U.uPetB.value.setRGB(...T.petB);
    U.uLeafA.value.setRGB(...T.leafA); U.uLeafB.value.setRGB(...T.leafB);
    U.uFluff.value.setRGB(...T.fluff);
    U.uGlowP.value += (T.glow - U.uGlowP.value) * kk;
    // wind drift (float64): wind along the shared prevailing wind, plus a slow fall
    const ws = G.uWindStrength.value ?? 0.3;
    const wd = G.uWindDir.value;
    const ux = _c.x / l, uy = _c.y / l, uz = _c.z / l;
    const sp = 1.2 + 6.5 * ws;
    const wx = wd.x - ux * (wd.x * ux + wd.y * uy + wd.z * uz), wy = wd.y - uy * (wd.x * ux + wd.y * uy + wd.z * uz), wz = wd.z - uz * (wd.x * ux + wd.y * uy + wd.z * uz);
    const step = Math.min(dt, 0.25);
    this.drift[0] += (wx * sp - ux * 0.45) * step;
    this.drift[1] += (wy * sp - uy * 0.45) * step;
    this.drift[2] += (wz * sp - uz * 0.45) * step;
    U.uUpL.value.set(ux, uy, uz);
    U.uWindL.value.set(wx * sp, wy * sp, wz * sp);
    for (const m of this.meshes) {
      const B = m.u.uBox.value;
      const md = (v, b) => ((v % b) + b) % b;
      m.u.uShift.value.set(md(this.drift[0] - _c.x, B.x), md(this.drift[1] - _c.y, B.y), md(this.drift[2] - _c.z, B.z));
      m.mesh.position.copy(_c);
      m.mesh.updateMatrix();
    }
    // katana burst (near volume only): position relative to the camera
    if (this.burstPos && G.uTime.value - this.burstAt < 3.5) {
      U.uBurst.value.set(0, 0, 0, this.burstAt);
      _w.copy(this.burstPos).sub(_c);
      U.uBurstL.value.copy(_w);
    } else U.uBurst.value.w = -10;
  }

  getState() {
    return { amount: +this.U?.uAmount.value.toFixed(2), shape: this.U ? this.U.uShapeW.value.toArray().map((v) => +v.toFixed(2)) : null };
  }

  dispose() {
    try { if (typeof this._off === 'function') this._off(); } catch (_) { /* ignore */ }
    for (const m of this.meshes) { m.mesh.removeFromParent(); m.mesh.geometry.dispose(); m.mesh.material.dispose(); }
    this.quad?.dispose();
    this.meshes.length = 0;
  }
}
