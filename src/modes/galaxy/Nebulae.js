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
vec3 Ha(float hub){ return mix(vec3(1.0, 0.13, 0.24), vec3(1.0, 0.66, 0.22), hub); }
vec3 O3(float hub){ return mix(vec3(0.25, 0.72, 0.85), vec3(0.2, 0.55, 1.0), hub); }
vec3 S2(float hub){ return mix(vec3(0.9, 0.25, 0.25), vec3(1.0, 0.32, 0.18), hub); }

// returns emission (rgb) and extinction (a) per unit length (in radii) at local coords q
vec4 emissionCloud(vec3 q, vec3 s, float hub){
  vec3 w = q + 0.45 * (N(q * 0.21 + s).rgb - 0.5);
  float big = N(w * 0.38 + s * 1.3).r;
  float det = N(w * 1.1 + s * 2.1).a;
  float fine = N(w * 2.6 + s * 0.7).a;
  float fil = N(w * 0.7 + s * 3.7).g;
  float r = length(q);
  vec3 qc = vec3(0.12, 0.05, -0.08);
  vec3 tc = qc - q;
  float dc = length(tc);
  float ion = 1.0 / (1.0 + dc * dc * 10.0);
  // wind-blown cavity around the cluster, surrounded by a thick irregular wall of ionized gas
  float cav = smoothstep(0.12, 0.42, dc + 0.35 * (big - 0.5) + 0.12 * (det - 0.5));
  float lobe = N(q * 1.05 + s * 0.4).r;
  // (moderate noise on the envelope: strong low-frequency lattice noise reads as a box silhouette)
  float outer = 1.0 - smoothstep(0.3, 0.95, r + 0.4 * (big - 0.5) + 0.55 * (lobe - 0.5) + 0.25 * (det - 0.5));
  float gas = cav * outer * pow(clamp(det * 1.2 + fine * 0.5 + big * 0.4 - 0.55, 0.0, 1.0), 1.6);
  // cold dust lanes and globules in the outer wall, lit on their cluster-facing side
  float dustF = smoothstep(0.72, 0.86, fil * 0.85 + big * 0.3 + (fine - 0.5) * 0.3) * smoothstep(0.25, 0.5, dc) * outer;
  float dustNear = smoothstep(0.72, 0.86, N((w + tc / max(dc, 1e-3) * 0.05) * 0.7 + s * 3.7).g * 0.85 + big * 0.3 + (fine - 0.5) * 0.3) * smoothstep(0.25, 0.5, dc) * outer;
  float rim = max(dustF - dustNear, 0.0) * ion;
  vec3 col = mix(Ha(hub), O3(hub), smoothstep(0.55, 0.12, dc) * 0.9);
  col = mix(col, S2(hub), smoothstep(0.45, 0.9, r) * 0.6);
  vec3 em = col * gas * (0.5 + 5.0 * ion) + mix(vec3(1.0, 0.5, 0.4), vec3(1.0, 0.82, 0.5), hub) * rim * 30.0;
  em += vec3(0.45, 0.6, 1.0) * exp(-dc * dc * 40.0) * (0.3 + det) * 0.6;   // reflection haze
  return vec4(em, dustF * 16.0 + gas * 0.2);
}

float pillarSDF(vec3 q, vec3 s){
  float best = -2.0;
  for (int j = 0; j < 3; j++) {
    vec2 base = j == 0 ? vec2(-0.52, 0.05) : j == 1 ? vec2(0.02, -0.06) : vec2(0.46, 0.1);
    float h = j == 0 ? 1.62 : j == 1 ? 1.24 : 0.95;
    float r0 = j == 0 ? 0.21 : j == 1 ? 0.165 : 0.13;
    vec2 lean = j == 0 ? vec2(0.14, 0.03) : j == 1 ? vec2(0.12, -0.05) : vec2(-0.1, 0.06);
    float fj = float(j);
    float t = (q.y + 1.0) / h;
    // columns bend (wind-sculpted), bulge and pinch along their height, knobby heads
    vec2 wig = 0.07 * vec2(sin(q.y * 2.3 + fj * 2.0 + s.x), cos(q.y * 1.7 + fj * 1.3 + s.y)) + vec2(0.1 * t * t * (fj - 1.0), 0.0);
    vec2 axis = base + lean * (q.y + 1.0) + wig;
    float d = length(q.xz - axis);
    float pinch = 1.0 + 0.55 * (N(vec3(fj * 3.1 + s.x, q.y * 0.9, s.z)).r - 0.5);
    float rad = r0 * (1.65 - 0.95 * clamp(t, 0.0, 1.0)) * pinch;
    float yTop = -1.0 + h;
    float head = 1.0 + 0.35 * smoothstep(0.75, 0.95, t);          // swollen head below the tip
    float body = (rad * head - length(vec2(d, max(q.y - yTop, 0.0) * 0.75))) / rad;
    best = max(best, body);
  }
  // common base: broad dark mound the columns grow out of
  float mound = (0.72 - length(vec3(q.x * 0.62, (q.y + 1.2) * 1.35, q.z * 1.2))) / 0.45;
  return max(best, mound);
}

// displaced pillar field: > 0 inside the columns. Striations run along the columns (erosion by the
// photo-evaporative flow), coarse lumps + fine grit break up the silhouette.
float pillarField(vec3 q, vec3 s, out float smoothF){
  float n1 = N(q * 1.1 + s).r - 0.5, n2 = N(q * 3.0 + s * 2.0).a - 0.5, n3 = N(q * 6.5 + s * 1.3).r - 0.5;
  float st = N(vec3(q.x * 5.5, q.y * 1.1, q.z * 5.5) + s * 0.7).g - 0.5;
  smoothF = pillarSDF(q, s) + 0.9 * n1 + 0.42 * n2;          // large-scale shape (fronts, lighting)
  return smoothF + 0.08 * n3 + 0.26 * st;
}

// Pillars of Creation: cold molecular columns lit from above-front by an O-star cluster.
// Lighting is volumetric: light transmission toward the cluster is estimated from the displaced SDF
// sampled along the light direction (self-shadowing); the ionisation front is a bright skin on lit
// faces, photo-evaporation flows stream off them, the column bodies are dusty and partly translucent
// (rust / umber, lit tops glow gold) and backlit edges pick up the cavity light.
vec4 pillars(vec3 q, vec3 s, float hub){
  vec3 Ld = normalize(vec3(0.45, 1.0, -0.12));         // cluster above, to the right, slightly behind
  float r = length(q);
  float sm, sm1, sm2, sm3;
  float sdf = pillarField(q, s, sm);
  float body = smoothstep(-0.02, 0.2, sdf);
  float fl = 0.0, sh = 1.0;
  if (sdf > -0.35) {
    pillarField(q + Ld * 0.05, s, sm1);
    float l2 = pillarField(q + Ld * 0.16, s, sm2);
    float l3 = pillarField(q + Ld * 0.38, s, sm3);
    fl = clamp((sm - sm1) / 0.05, 0.0, 1.0);                                       // faces the cluster
    sh = exp(-6.0 * max(l2, 0.0) - 3.5 * max(l3, 0.0));                           // light reaching q
  }
  float n2 = N(q * 3.0 + s * 2.0).a, n4 = N(q * 9.0 + s * 0.4).a, n5 = N(q * 14.0 + s * 1.9).r;
  float nStr = N(vec3(q.x * 7.0, q.y * 1.4, q.z * 7.0) + s * 1.1).g;               // striations
  // ionisation-front skin (thin, bright, gold-white)
  float skin = exp(-sm * sm / 0.005) * fl * sh * smoothstep(-0.75, 0.05, q.y) * (0.55 + 0.9 * smoothstep(-0.12, 0.1, sdf - sm));
  // photo-evaporation flow: glow just outside the lit surfaces, streaming toward the cluster
  float ev = smoothstep(-0.2, -0.01, sdf) * (1.0 - body) * fl * sh * (0.5 + n4);
  // body: dense dust, lit where light gets in; dark umber lanes along the striations
  float tex = (0.5 + 0.75 * n2 * (0.6 + 0.8 * n5)) * (0.55 + 0.7 * smoothstep(0.2, 0.75, nStr));
  vec3 umber = mix(vec3(0.3, 0.075, 0.03), vec3(0.58, 0.22, 0.09), smoothstep(0.3, 0.8, n2));
  vec3 lit = mix(vec3(0.95, 0.42, 0.14), vec3(1.0, 0.66, 0.3), n4);
  float light = sh * (0.3 + 0.7 * fl);
  vec3 bodyC = mix(umber, lit, clamp(light * 0.8, 0.0, 1.0)) * tex;
  // (optically thick: visible radiance ≈ emission / extinction ≈ bodyC × (ambient + direct))
  vec3 bodyE = bodyC * body * (1.2 + 8.5 * light * light);
  // cavity haze: teal [OIII] away from the fronts, gold-green close to them, brighter toward the stars
  float hz = N(q * 0.35 + s * 0.7).r, hz2 = N(q * 1.2 + s).a, hz3 = N(q * 2.8 + s * 1.7).g;
  float env = 1.0 - smoothstep(0.25, 1.0, r + 0.3 * (hz - 0.5));
  // the cavity wall lies behind the columns (camera on +z): only a thin veil in front of them
  float behind = mix(0.05, 1.0, smoothstep(0.3, -0.25, q.z + 0.35 * (hz2 - 0.5)));
  float haze = clamp(0.3 + hz * 0.8 + hz2 * 0.5 - 0.5 + 0.35 * (hz3 - 0.5), 0.0, 1.3) * env * (1.0 - body) * behind * (0.6 + 0.6 * smoothstep(-0.6, 0.9, q.y));
  float near = smoothstep(-0.5, -0.02, sdf) * (0.35 + 0.65 * fl);
  vec3 cavC = mix(vec3(0.13, 0.36, 0.55), vec3(0.2, 0.55, 0.62), hz2);
  vec3 frontC = mix(vec3(0.62, 0.72, 0.36), vec3(1.0, 0.74, 0.38), fl);
  vec3 hazeCol = mix(cavC, frontC, near * 0.75);
  vec3 skinC = mix(vec3(1.0, 0.5, 0.2), vec3(1.0, 0.78, 0.45), n4);
  // backlit translucent edges: the thin outer layer of each column glows with the light behind it
  float edge = smoothstep(-0.06, 0.04, sdf) * (1.0 - smoothstep(0.04, 0.16, sdf));
  vec3 em = hazeCol * haze * 2.4
          + skinC * skin * 26.0
          + mix(vec3(1.0, 0.72, 0.4), vec3(0.55, 0.85, 0.75), 0.3) * ev * 5.5
          + mix(vec3(0.7, 0.42, 0.2), frontC, fl) * edge * (0.5 + 0.9 * n4) * 3.2 * (0.15 + 0.85 * sh * (0.3 + 0.7 * fl))
          + bodyE;
  return vec4(em * 1.3, body * 24.0 + haze * 0.16 + ev * 0.3 + edge * 1.5);
}

// Outer cavity wall of an HII region (Eagle-Nebula-like), seen behind (and faintly in front of) the
// columns: two samples on a shell of radius RS with multi-octave textured emission and dark globules.
vec3 cavityWall(vec3 q, vec3 s, float front){
  vec3 d = normalize(q);
  vec3 w = q + 0.9 * (N(q * 0.07 + s).rgb - 0.5);
  float a = N(w * 0.1 + s * 0.4).r, b = N(w * 0.28 + s * 1.3).a, c = N(w * 0.7 + s * 2.2).a, e = N(w * 1.7 + s * 0.9).r;
  float glob = N(w * 0.16 + s * 2.7).r;
  float dens = clamp(0.25 + 0.9 * a + 0.55 * (b - 0.5) + 0.35 * (c - 0.5) + 0.2 * (e - 0.5), 0.0, 1.6);
  float fil = smoothstep(0.55, 0.9, c * 0.6 + e * 0.5) * 0.5;   // brighter ionised wisps
  float up = smoothstep(-0.6, 0.9, d.y);                  // brighter toward the cluster above
  vec3 teal = mix(vec3(0.07, 0.2, 0.34), vec3(0.2, 0.5, 0.62), a);
  vec3 gold = vec3(0.75, 0.62, 0.3);
  vec3 rust = vec3(0.55, 0.2, 0.12);
  vec3 col = mix(teal, gold, smoothstep(0.55, 0.95, b) * 0.5 * up) + rust * smoothstep(0.6, 0.9, glob) * 0.25;
  float dark = 1.0 - 0.7 * smoothstep(0.62, 0.9, glob + 0.25 * (e - 0.5) + 0.2 * (b - 0.5));   // cold dark clouds
  return col * (dens * (0.35 + 0.8 * up) + fil * up) * dark * (front > 0.5 ? 0.25 : 1.0);
}

vec4 planetary(vec3 q, vec3 s, float hub){
  vec3 p = q * vec3(1.0, 1.35, 1.0);
  float r = length(p);
  vec3 dir = p / max(r, 1e-4);
  float ang = N(q * 1.3 + s).g;
  float ang2 = N(q * 2.6 + dir * 0.6 + s * 1.3).b;
  float rs = 0.5 + 0.12 * (N(dir * 1.1 + s).r - 0.5);
  float shell = exp(-pow((r - rs) / 0.1, 2.0)) * (0.3 + 1.3 * ang);
  float inner = exp(-pow(r / 0.42, 2.0)) * (0.5 + 0.6 * N(q * 2.0 + s).a);
  float outer = exp(-pow((r - 0.8) / 0.12, 2.0)) * smoothstep(0.35, 0.8, ang2);
  float knots = smoothstep(0.6, 0.9, ang2) * exp(-pow((r - rs + 0.07) / 0.045, 2.0));
  vec3 em = O3(hub) * inner * 0.18 + mix(O3(hub), Ha(hub), smoothstep(rs - 0.12, rs + 0.04, r)) * shell * 1.0
          + Ha(hub) * outer * 0.45 + vec3(1.0, 0.5, 0.35) * knots * 1.6;
  em += vec3(0.8, 0.9, 1.0) * exp(-r * r * 1600.0) * 40.0;         // white dwarf
  return vec4(em, knots * 22.0 + shell * 0.25);
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
  float jit = rv_hash12(gl_FragCoord.xy + vec2(mod(uFrame, 64.0) * 17.31, 3.7));
  vec3 L = vec3(0.0);
  float T = 1.0;
  for (int k = 0; k < ${MAXN}; k++) {
    if (k >= uCount) break;
    vec3 c = uNeb[k].xyz; float R = uNeb[k].w;
    vec3 oc = ro - c;
    float b = dot(oc, rd), cc = dot(oc, oc) - R * R;
    int kind = int(uNebP[k].x + 0.5);
    vec3 s = vec3(uNebP[k].y, uNebP[k].y * 1.7, uNebP[k].y * 0.3);
    float hub = uNebP[k].z, fade = uNebP[k].w;
    mat3 M = uNebRot[k];
    // pillars: the cavity wall of the surrounding HII region (shell of radius RS) — textured
    // backdrop that fills the frame from inside, fades out once the camera leaves the region
    float RS = 2.6 * R;
    float shellK = kind == 1 ? 1.0 - smoothstep(0.85 * RS, 1.15 * RS, length(oc)) : 0.0;
    float tS0 = 0.0, tS1 = -1.0;
    if (shellK > 0.0) {
      float ccS = dot(oc, oc) - RS * RS, discS = b * b - ccS;
      if (discS > 0.0) { float sqS = sqrt(discS); tS0 = -b - sqS; tS1 = -b + sqS; }
      if (tS0 > 0.0) {            // front wall (camera outside the shell: faint veil)
        vec3 qf = M * ((ro + rd * tS0 - c) / R);
        L += T * cavityWall(qf, s, 1.0) * fade * shellK * 0.6;
        T *= mix(1.0, 0.85, shellK);
      }
    }
    float disc = b * b - cc;
    if (disc > 0.0) {
      float sq = sqrt(disc);
      float t0 = max(-b - sq, 0.0), t1 = -b + sq;
      if (t1 > 0.0) {
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
      }
    }
    if (shellK > 0.0 && tS1 > 0.0 && T > 0.004) {
      vec3 qb = M * ((ro + rd * tS1 - c) / R);
      L += T * cavityWall(qb, s, 0.0) * fade * shellK * 0.6;
      T *= mix(1.0, 0.45, shellK * fade);          // the wall hides much of the galaxy behind it
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
      uniforms: { tVol: { value: this.rt.texture }, uVolSize: { value: new THREE.Vector2(4, 4) }, uGain: { value: 1 }, uDetail: { value: 0 } },
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
      const m4 = new THREE.Matrix4().makeRotationFromEuler(nb.kind === 'pillars' ? new THREE.Euler(0.06, nb.tilt[0], 0.12, 'YXZ') : new THREE.Euler(nb.tilt[1], nb.tilt[0], nb.tilt[1] * 0.5, 'YXZ'));
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
