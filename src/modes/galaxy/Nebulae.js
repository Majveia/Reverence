// Nebulae — volumetric emission / absorption nebulae placed in the arms (GalaxyModel.galaxyNebulae):
//   emission clouds (Carina/Orion: Hα + [OIII] gas lit by an embedded cluster, absorbing dust with
//   ionization-front rims), pillars (Pillars of Creation: dense eroded columns, bright rims, teal haze),
//   planetary nebulae (Helix/Ring: prolate shell, [OIII] core, Hα rim, cometary knots, white dwarf)
//   and supernova remnants (Veil: filamentary shell).
// Raymarched at reduced resolution (shared tileable 3-D noise from GalaxyVolume) when the camera is
// within ~60 radii, composited like the galaxy volume: out = emission + dst × transmittance.
import * as THREE from 'three';
import { galaxyNebulae } from '../../universe/GalaxyModel.js';
import { COMPOSITE_FRAG, FS_VERT } from './shaders/volume.js';
import { rotTheta } from './GalaxyCamera.js';

const KIND_ID = { emission: 0, pillars: 1, planetary: 2, remnant: 3, dark: 0 };
const MAXN = 3;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
#include <rv_common>
uniform sampler3D tNoise;
uniform vec3 uCamPos;
uniform mat4 uInvProj;
uniform mat3 uCamRot;
uniform int uCount;
uniform vec4 uNeb[${MAXN}];     // world center (kly), radius (kly)
uniform vec4 uNebP[${MAXN}];    // kind, seed, palette (1 = hubble), fade
uniform mat3 uNebRot[${MAXN}];  // world → local
uniform int uSteps;
uniform float uFrame, uTime;
varying vec2 vUv;

vec4 N(vec3 p){ return texture(tNoise, p); }

// palette: x = Hα, y = [OIII], z = [SII]
vec3 Ha(float hub){ return mix(vec3(1.0, 0.2, 0.3), vec3(1.0, 0.72, 0.28), hub); }
vec3 O3(float hub){ return mix(vec3(0.25, 0.72, 0.85), vec3(0.2, 0.55, 1.0), hub); }
vec3 S2(float hub){ return mix(vec3(0.9, 0.25, 0.25), vec3(1.0, 0.32, 0.18), hub); }

// returns emission (rgb) and extinction (a) per unit length (in radii) at local coords q
vec4 emissionCloud(vec3 q, vec3 s, float hub){
  vec3 w = q + 0.5 * (N(q * 0.21 + s).rgb - 0.5);
  float big = N(w * 0.38 + s * 1.3).r;
  float det = N(w * 1.1 + s * 2.1).a;
  float fine = N(w * 2.6 + s * 0.7).a;
  float fil = N(w * 0.62 + s * 3.7).g;
  float r = length(q);
  float env = 1.0 - smoothstep(0.2, 0.95, r + 0.55 * (big - 0.5) + 0.25 * (det - 0.5));
  float gas = pow(clamp(big * 1.6 + det * 0.7 + fine * 0.3 - 1.15, 0.0, 1.0), 1.4) * env;
  float dustF = smoothstep(0.55, 0.85, fil * 0.8 + big * 0.35 + (fine - 0.5) * 0.2) * env;
  vec3 qc = vec3(0.1, 0.04, -0.06);
  vec3 tc = qc - q;
  float dc = length(tc);
  float ion = 1.0 / (1.0 + dc * dc * 7.0);
  float dustNear = smoothstep(0.55, 0.85, N((w + tc / max(dc, 1e-3) * 0.06) * 0.62 + s * 3.7).g * 0.8 + big * 0.35 + (fine - 0.5) * 0.2) * env;
  float rim = max(dustF - dustNear, 0.0) * ion;
  vec3 col = mix(Ha(hub), O3(hub), smoothstep(0.5, 0.05, dc) * 0.8);
  col = mix(col, S2(hub), smoothstep(0.5, 0.95, r) * 0.6);
  vec3 em = col * gas * (1.2 + 4.0 * ion) + mix(vec3(1.0, 0.5, 0.4), vec3(1.0, 0.8, 0.45), hub) * rim * 30.0;
  em += vec3(0.4, 0.55, 1.0) * exp(-dc * dc * 25.0) * (0.4 + det) * 1.5;   // reflection haze around the cluster
  em += vec3(1.0, 0.95, 0.9) * exp(-dc * dc * 900.0) * 30.0;               // the cluster core
  return vec4(em * 1.1, dustF * 9.0 + gas * 0.6);
}

float pillarSDF(vec3 q, vec3 s){
  float best = -2.0;
  for (int j = 0; j < 3; j++) {
    float fj = float(j);
    vec2 base = vec2(-0.45 + 0.42 * fj, -0.08 + 0.18 * sin(fj * 2.3 + s.x));
    float h = 1.0 + 0.45 * fract(sin(fj * 12.9 + s.y) * 43758.5) - 0.25 * abs(fj - 1.0);
    float t = (q.y + 0.95) / h;
    vec2 wig = 0.05 * vec2(sin(q.y * 3.1 + fj * 2.0 + s.x), cos(q.y * 2.3 + fj * 1.3 + s.y));
    vec2 axis = base + vec2(0.1, 0.04) * (q.y + 0.95) * (fj - 1.0) + wig;
    float d = length(q.xz - axis);
    float r0 = 0.16 - 0.035 * abs(fj - 1.0);
    float rad = r0 * (1.35 - 0.6 * clamp(t, 0.0, 1.0));
    float body = min((rad - d) / rad, (1.0 - t) * 5.0);
    vec3 hp = vec3(axis.x, -0.95 + h * 0.97, axis.y);
    float hr = rad * 1.35;
    float head = (hr - length((q - hp) * vec3(1.0, 1.3, 1.0))) / hr;
    best = max(best, max(body, head));
  }
  return best;
}

vec4 pillars(vec3 q, vec3 s, float hub){
  float n1 = N(q * 1.6 + s).r - 0.5, n2 = N(q * 4.2 + s * 2.0).a - 0.5, n3 = N(q * 10.0 + s * 3.0).b - 0.5;
  float sdf = pillarSDF(q, s) + 0.7 * n1 + 0.4 * n2 + 0.22 * n3;
  vec3 qu = q + vec3(0.0, 0.035, 0.012);
  float sdfU = pillarSDF(qu, s) + 0.7 * (N(qu * 1.6 + s).r - 0.5) + 0.4 * (N(qu * 4.2 + s * 2.0).a - 0.5) + 0.22 * (N(qu * 10.0 + s * 3.0).b - 0.5);
  float pil = smoothstep(0.0, 0.16, sdf);
  float skin = smoothstep(-0.28, 0.02, sdf) * (1.0 - pil);
  float rim = clamp((sdf - sdfU) * 10.0, 0.0, 1.0) * smoothstep(-0.22, 0.05, sdf);
  float r = length(q);
  float env = 1.0 - smoothstep(0.5, 1.05, r);
  float hz = N(q * 0.45 + s * 0.7).r;
  float haze = clamp(hz * 1.4 + N(q * 1.3 + s).a * 0.4 - 0.55, 0.0, 1.0) * env;
  float upk = smoothstep(-0.6, 0.9, q.y);
  vec3 hazeCol = mix(mix(Ha(hub), vec3(1.0, 0.7, 0.4), 0.3), O3(hub), upk * 0.85);
  vec3 skinCol = mix(vec3(1.0, 0.45, 0.35), vec3(1.0, 0.72, 0.4), hub);
  vec3 em = hazeCol * haze * (0.5 + 1.2 * upk)
          + skinCol * (skin * 1.2 + rim * 22.0) * (0.45 + 0.55 * upk)
          + vec3(0.5, 0.26, 0.12) * pil * (0.6 + 1.5 * rim);
  return vec4(em * 1.5, pil * 30.0 + skin * 2.0 + haze * 0.35);
}

vec4 planetary(vec3 q, vec3 s, float hub){
  vec3 p = q * vec3(1.0, 1.4, 1.0);
  float r = length(p);
  float n = N(q * 1.1 + s).r, n2 = N(q * 3.0 + s * 1.7).b;
  float shell = exp(-pow((r - 0.52) / 0.13, 2.0)) * (0.55 + 0.9 * n);
  float inner = exp(-pow(r / 0.46, 2.0));
  float outer = exp(-pow((r - 0.82) / 0.14, 2.0)) * n;
  float knots = smoothstep(0.55, 0.85, n2) * exp(-pow((r - 0.42) / 0.07, 2.0));
  vec3 em = O3(hub) * inner * 1.3 + mix(O3(hub), Ha(hub), smoothstep(0.4, 0.62, r)) * shell * 2.8 + Ha(hub) * outer * 0.9
          + vec3(1.0, 0.55, 0.4) * knots * 3.0;
  em += vec3(0.8, 0.9, 1.0) * exp(-r * r * 900.0) * 60.0;         // white dwarf
  return vec4(em, knots * 18.0 + shell * 0.6);
}

vec4 remnant(vec3 q, vec3 s, float hub){
  float r = length(q);
  vec3 w = q + 0.25 * (N(q * 0.4 + s).rgb - 0.5);
  float rw = length(w);
  float sh = exp(-pow((rw - 0.78) / 0.16, 2.0));
  float f1 = pow(N(w * 1.1 + s * 1.3).g, 3.0), f2 = pow(N(w * 2.3 + s * 2.1).g, 4.0);
  float fil = (f1 * 1.6 + f2) * sh;
  float t = N(w * 0.6 + s * 3.0).r;
  vec3 em = mix(Ha(hub), O3(hub), smoothstep(0.35, 0.65, t)) * fil * 5.0 + O3(hub) * exp(-r * r * 4.0) * 0.08;
  em += vec3(0.7, 0.8, 1.0) * exp(-r * r * 2500.0) * 30.0;          // pulsar
  return vec4(em, fil * 2.0);
}

vec4 sampleNeb(int kind, vec3 q, vec3 s, float hub){
  if (kind == 0) return emissionCloud(q, s, hub);
  if (kind == 1) return pillars(q, s, hub);
  if (kind == 2) return planetary(q, s, hub);
  return remnant(q, s, hub);
}

void main(){
  vec4 vv = uInvProj * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
  vec3 rd = normalize(uCamRot * normalize(vv.xyz / vv.w));
  vec3 ro = uCamPos;
  float jit = rv_ign(gl_FragCoord.xy + vec2(mod(uFrame, 64.0) * 5.3));
  vec3 L = vec3(0.0);
  float T = 1.0;
  for (int k = 0; k < ${MAXN}; k++) {
    if (k >= uCount) break;
    vec3 c = uNeb[k].xyz; float R = uNeb[k].w;
    vec3 oc = ro - c;
    float b = dot(oc, rd), cc = dot(oc, oc) - R * R;
    float disc = b * b - cc;
    if (disc <= 0.0) continue;
    float sq = sqrt(disc);
    float t0 = max(-b - sq, 0.0), t1 = -b + sq;
    if (t1 <= 0.0) continue;
    int kind = int(uNebP[k].x + 0.5);
    vec3 s = vec3(uNebP[k].y, uNebP[k].y * 1.7, uNebP[k].y * 0.3);
    float hub = uNebP[k].z, fade = uNebP[k].w;
    mat3 M = uNebRot[k];
    float dt = (t1 - t0) / float(uSteps);
    float t = t0 + dt * jit;
    for (int i = 0; i < 160; i++) {
      if (i >= uSteps || t >= t1) break;
      vec3 q = M * ((ro + rd * t - c) / R);
      vec4 d = sampleNeb(kind, q, s, hub);
      float dl = dt / R;
      float a = exp(-d.a * dl * fade);
      // emission integrated over the step with self-absorption
      L += T * d.rgb * fade * dl * (d.a > 1e-3 ? (1.0 - a) / (d.a * dl * fade + 1e-6) : 1.0);
      T *= a;
      if (T < 0.004) break;
      t += dt;
    }
    if (T < 0.004) break;
  }
  gl_FragColor = vec4(L, T);
}
`;

export class Nebulae {
  constructor(engine, galaxy, S, volUniforms) {
    this.engine = engine;
    this.list = galaxyNebulae(galaxy);
    const q = engine.quality;
    this.steps = q.tier === 'ultra' ? 110 : q.tier === 'high' ? 84 : q.tier === 'med' ? 56 : 36;
    this.resScale = q.tier === 'ultra' ? 0.6 : q.tier === 'high' ? 0.5 : q.tier === 'med' ? 0.42 : 0.34;
    this.maxPixels = q.tier === 'ultra' ? 1.4e6 : q.tier === 'high' ? 7e5 : q.tier === 'med' ? 3.6e5 : 1.8e5;
    const nebU = [], nebP = [], nebR = [];
    for (let i = 0; i < MAXN; i++) { nebU.push(new THREE.Vector4()); nebP.push(new THREE.Vector4()); nebR.push(new THREE.Matrix3()); }
    this.uniforms = {
      tNoise: volUniforms.tNoise,
      uCamPos: { value: new THREE.Vector3() }, uInvProj: { value: new THREE.Matrix4() }, uCamRot: { value: new THREE.Matrix3() },
      uCount: { value: 0 }, uNeb: { value: nebU }, uNebP: { value: nebP }, uNebRot: { value: nebR },
      uSteps: { value: this.steps }, uFrame: { value: 0 }, uTime: { value: 0 },
    };
    this.mat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: FRAG, uniforms: this.uniforms, depthTest: false, depthWrite: false });
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.rt = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG,
      uniforms: { tVol: { value: this.rt.texture }, uVolSize: { value: new THREE.Vector2(4, 4) }, uGain: { value: 1 } },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.group = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMat);
    this.group.frustumCulled = false;
    this.group.renderOrder = 5;
    this.group.visible = false;
    // per-nebula orientation (world → local), pattern-frame centers in kly
    this.items = this.list.map((nb) => {
      const m4 = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(nb.tilt[1], nb.tilt[0], nb.kind === 'pillars' ? 0.25 : nb.tilt[1] * 0.5, 'YXZ'));
      return {
        nb, center: new THREE.Vector3(nb.x, nb.y, nb.z).multiplyScalar(1 / 1000), radius: nb.radius / 1000,
        rot: new THREE.Matrix3().setFromMatrix4(m4).transpose(), kind: KIND_ID[nb.kind] ?? 0,
        seed: (nb.seed % 1000) / 1000 * 7.3, hub: nb.palette === 'hubble' ? 1 : 0, world: new THREE.Vector3(), d: 0, fade: 0, seen: false,
      };
    });
    this.active = [];
    this._m3 = new THREE.Matrix3();
    this.frame = 0;
    this.setSize(engine.pipeline.width, engine.pipeline.height);
  }

  setSize(w, h) {
    let s = this.resScale;
    if (w * h * s * s > this.maxPixels) s = Math.sqrt(this.maxPixels / (w * h));
    const vw = Math.max(16, Math.round(w * s)), vh = Math.max(16, Math.round(h * s));
    this.rt.setSize(vw, vh);
    this.compositeMat.uniforms.uVolSize.value.set(vw, vh);
  }

  update(camera, pat, camPat, dt, t) {
    const e = this.engine;
    if (this.rt.width !== Math.round(e.pipeline.width * this.resScale) && this._lastW !== e.pipeline.width) { this._lastW = e.pipeline.width; this.setSize(e.pipeline.width, e.pipeline.height); }
    this.active.length = 0;
    for (const it of this.items) {
      rotTheta(it.center, pat, it.world);
      it.d = it.world.distanceTo(camera.position);
      it.fade = 1 - THREE.MathUtils.smoothstep(it.d / it.radius, 28, 70);
      if (it.fade > 0.001) this.active.push(it);
      if (!it.seen && it.d < it.radius * 6) {
        it.seen = true;
        try { e.ui.toast(it.nb.name, { kind: 'discovery', eyebrow: it.nb.kind === 'planetary' ? 'Planetary nebula' : it.nb.kind === 'remnant' ? 'Supernova remnant' : 'Nebula' }); } catch (_) { /* ui optional */ }
      }
    }
    this.active.sort((a, b) => a.d - b.d);
    if (this.active.length > MAXN) this.active.length = MAXN;
    const u = this.uniforms;
    u.uCount.value = this.active.length;
    this.active.forEach((it, i) => {
      u.uNeb.value[i].set(it.world.x, it.world.y, it.world.z, it.radius);
      u.uNebP.value[i].set(it.kind, it.seed, it.hub, it.fade);
      // local frame co-rotates with the pattern: world → pattern (−pat) → local
      const c = Math.cos(-pat), s = Math.sin(-pat);
      const rp = this._m3.set(c, 0, -s, 0, 1, 0, s, 0, c);
      u.uNebRot.value[i].multiplyMatrices(it.rot, rp);
    });
    u.uCamPos.value.copy(camera.position);
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
    u.uFrame.value = e.shot ? 0 : (this.frame++ % 64);
    u.uTime.value = t;
    this.group.visible = this.active.length > 0;
    void camPat; void dt;
  }

  /** Marker entries for nebulae in view (merged into the mode's marker list). */
  markers(camera, e, out) {
    const v = new THREE.Vector3();
    for (const it of this.items) {
      if (it.d > it.radius * 90 || it.d < it.radius * 1.4) continue;
      v.copy(it.world).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      const pr = it.radius / Math.max(it.d, 1e-9) * (e.height / 2) / Math.tan(camera.fov * Math.PI / 360);
      out.push({ id: 'gx-neb-' + it.nb.id, x: (v.x * 0.5 + 0.5) * e.width, y: (0.5 - v.y * 0.5) * e.height - Math.min(pr, e.height * 0.3) - 12, visible: true, label: it.nb.name, sub: it.nb.kind === 'planetary' ? 'planetary nebula' : it.nb.kind === 'remnant' ? 'supernova remnant' : it.nb.kind === 'pillars' ? 'star-forming pillars' : 'emission nebula' });
    }
    return out;
  }

  render(renderer) {
    if (!this.active.length) return;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    renderer.render(this.quadScene, this.quadCam);
    renderer.setRenderTarget(prev);
  }

  isReady() { return true; }

  dispose() {
    this.rt.dispose(); this.mat.dispose(); this.compositeMat.dispose();
    this.quad.geometry.dispose(); this.group.geometry.dispose();
  }
}
