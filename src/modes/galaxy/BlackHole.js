// BlackHole — the supermassive black hole at the galactic center, rendered as a full-screen
// post effect when the camera is close (within ~20 000 Schwarzschild radii):
//   * null geodesics of the Schwarzschild metric integrated per pixel (Binet form:
//     x'' = -3/2 h² x / r⁵ in units of r_s), weak-field deflection (α = 2 r_s / b) far from the hole
//   * thin accretion disk (Novikov–Thorne-like temperature profile, ISCO shrinking with spin),
//     relativistic Doppler beaming (g³) + gravitational redshift, blackbody colors shifted by g,
//     Keplerian differential rotation of turbulent streaks, multiple crossings → photon ring and
//     the lensed far side of the disk arching over the shadow (Interstellar / EHT look)
//   * everything behind the hole (the galactic nucleus, stars) is re-sampled from the HDR frame
//     along the bent rays; rays leaving the screen fall back to a procedural star field.
// Units: galaxy mode uses kly; r_s(kly) = M☉ × 3.118e-16.
import * as THREE from 'three';
import { makeFullscreenMaterial, FullscreenQuad } from '../../post/Pipeline.js';

const RS_PER_MSUN_KLY = 2953.25 / 9.4607e18;   // 2GM☉/c² (m) → kly

const FRAG = /* glsl */ `
precision highp float;
#include <rv_common>
#include <rv_noise>
#include <rv_color>
uniform sampler2D tInput;
uniform vec3 uCam;          // camera position, BH frame, units of r_s
uniform mat3 uCamRot;       // view dir → BH frame
uniform mat3 uBhToView;     // BH frame dir → view
uniform mat4 uProj, uInvProj;
uniform float uTime, uDiskIn, uDiskOut, uDiskT, uDiskGain, uSeed, uBgGain, uStarF;
uniform float uPixAng;      // radians per pixel
uniform float uRing, uJet, uTorn, uDiskK;
uniform int uSteps;
varying vec2 vUv;

const float B_CRIT = 2.598076;   // 3√3/2 r_s: critical impact parameter (photon sphere at 1.5 r_s)

vec3 starfield(vec3 d){
  vec3 c = vec3(0.0);
  for (int k = 0; k < 2; k++){
    float sc = k == 0 ? 90.0 : 260.0;
    vec3 q = d * sc;
    vec3 id = floor(q);
    vec3 h = rv_hash33(id + uSeed + float(k) * 17.0);
    vec3 sp = id + 0.2 + 0.6 * h;
    float dd = length(q - sp);
    float m = pow(h.x, 18.0) * (k == 0 ? 6.0 : 2.0);
    vec3 tint = mix(vec3(1.0, 0.75, 0.5), vec3(0.7, 0.8, 1.0), h.y);
    c += tint * m * exp(-dd * dd * 90.0);
  }
  return c;
}

// "torn space": the ionised gas of the nucleus behind the hole — Hα red and [OIII] teal veils with dark
// filaments. A function of direction only, so the geodesics tear it into arcs around the shadow.
vec3 tornSky(vec3 d){
  vec3 q = d * 2.4 + uSeed * 0.13;
  vec3 w = vec3(rv_snoise(q * 0.9), rv_snoise(q * 0.9 + 5.2), rv_snoise(q * 0.9 + 9.7));
  q += 0.55 * w;
  float a = rv_fbm(q, 4);
  float b = rv_fbm(q * 1.7 + 3.3, 4);
  float fil = rv_ridged(q * 2.6 + 1.1, 3);
  vec3 red = vec3(0.55, 0.06, 0.035) * smoothstep(-0.05, 0.55, a);
  vec3 teal = vec3(0.03, 0.26, 0.30) * smoothstep(0.0, 0.6, b) * (1.0 - 0.6 * smoothstep(0.0, 0.5, a));
  vec3 c = red + teal + vec3(0.6, 0.18, 0.08) * pow(fil, 4.0) * smoothstep(-0.2, 0.4, a) * 0.6;
  // dark dust lanes in front of the glow
  c *= 0.25 + 0.75 * smoothstep(-0.35, 0.15, rv_fbm(q * 3.1 + 7.0, 3));
  return c;
}

vec3 background(vec3 dirBH){
  vec3 dv = uBhToView * dirBH;
  vec3 extra = uTorn > 0.0 ? tornSky(dirBH) * uTorn : vec3(0.0);
  if (dv.z < -1e-4) {
    vec4 c = uProj * vec4(dv, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) return textureLod(tInput, uv, 0.0).rgb + extra;
    vec2 e = clamp(uv, 0.002, 0.998);
    float f = exp(-length(uv - e) * 2.5);
    return textureLod(tInput, e, 0.0).rgb * f + starfield(dirBH) + extra;
  }
  return textureLod(tInput, vec2(0.5), 3.0).rgb * 0.15 + starfield(dirBH) + extra;
}

// emitted colour of the disk gas: a gold "ring of fire" ramp (deep red outer gas → orange → gold → warm
// white at the ISCO; strongly beamed gas goes white-hot). t ≈ local temperature / peak temperature.
vec3 fireRamp(float t){
  vec3 c = mix(vec3(0.30, 0.035, 0.008), vec3(1.0, 0.26, 0.035), smoothstep(0.05, 0.38, t));
  c = mix(c, vec3(1.0, 0.55, 0.12), smoothstep(0.32, 0.62, t));
  c = mix(c, vec3(1.0, 0.80, 0.42), smoothstep(0.58, 0.9, t));
  c = mix(c, vec3(1.0, 0.95, 0.86), smoothstep(0.9, 1.35, t));
  return c;
}

// thin disk sample at crossing point p (BH frame, y≈0) seen along photon direction ph (toward camera);
// foot = pixel footprint on the disk (r_s) for anti-aliasing the fine filaments
vec4 disk(vec3 p, vec3 ph, float foot){
  float r = length(p.xz);
  if (r < uDiskIn * 0.98 || r > uDiskOut) return vec4(0.0);
  float x = uDiskIn / r;
  float prof = pow(x, 0.75) * pow(max(1.0 - sqrt(x), 0.0), 0.25) / 0.488;
  vec3 uPhi = normalize(vec3(-p.z, 0.0, p.x));
  float beta = min(sqrt(0.5 / max(r - 1.0, 0.05)), 0.96);
  float gam = inversesqrt(1.0 - beta * beta);
  float dop = 1.0 / (gam * (1.0 - beta * dot(uPhi, ph)));
  float g = dop * sqrt(max(1.0 - 1.0 / r, 0.02));
  // Keplerian flow: everything is advected at Ω ∝ r^-3/2 and sheared into trailing filaments
  float om = sqrt(0.5 / (r * r * r));
  float phi = atan(p.z, p.x) - om * uTime * 6.0;
  float lr = log(r);
  float fpl = foot / r;                         // footprint in ln r
  // coarse clumps (±) — slow, broad
  float cl = rv_snoise(vec3(cos(phi) * 1.3, sin(phi) * 1.3, lr * 5.0 + uSeed));
  // fine anisotropic filaments: long along the flow (azimuth), thin across it (ln r), trailing shear
  float phS = phi + 1.8 * lr;
  // u_14-like: short bright dashes riding circular orbits (long in azimuth, very thin in radius)
  float st = 0.0, ws = 0.0, F = 38.0, A = 3.6, amp = 1.0;
  for (int k = 0; k < 3; k++){
    float aa = 1.0 - smoothstep(0.18, 0.5, F * fpl);    // fade a layer once its period nears 2-3 px
    float nk = rv_snoise(vec3(cos(phS) * A, sin(phS) * A, lr * F + uSeed * 1.7 + float(k) * 7.31));
    st += amp * aa * nk; ws += amp * aa;
    F *= 2.1; A *= 1.85; amp *= 0.7; phS += 0.35 * lr;
  }
  float con = smoothstep(0.08, 0.45, ws / 2.19);       // how much filament contrast survives the footprint
  st /= max(ws, 1e-3);
  float fil = smoothstep(-0.1, 0.45, st + 0.25 * cl);
  // brightness: crisp dashes with truly dark gaps; where the footprint is too coarse to resolve them,
  // the same mean energy as a smooth glow (no dark band near the shadow, no aliasing)
  float filB = mix(0.42 + 0.12 * cl, 0.03 + 1.4 * fil * fil, con);
  // a few compact hot spots (flares) riding the flow at their own Keplerian rate
  float hot = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float rk = uDiskIn * (1.6 + 1.3 * fk) + 0.7 * sin(uSeed + fk * 2.1);
    float ak = uSeed * (1.3 + fk) + fk * 2.4 - sqrt(0.5 / (rk * rk * rk)) * uTime * 6.0;
    vec2 hp = vec2(cos(ak), sin(ak)) * rk;
    vec2 dd = p.xz - hp;
    hot += exp(-dot(dd, dd) / (0.3 + 0.2 * fk)) * (1.2 - 0.3 * fk);
  }
  float edgeIn = smoothstep(uDiskIn * 0.98, uDiskIn * 1.08, r);
  float edgeOut = 1.0 - smoothstep(uDiskOut * 0.3, uDiskOut, r);
  // gaps between filaments are thin and nearly transparent: the far side and the black sky show through
  float a = clamp((0.16 + 0.74 * mix(0.5, fil, con)) * edgeIn * edgeOut + 0.25 * hot, 0.0, 0.95);
  // colour temperature: Novikov–Thorne profile × redshift; art-directed ramp: a white-hot heart near
  // the ISCO, gold through the middle, deep orange-red embers fading to black at the rim (u_14)
  float t = pow(prof, 1.15) * pow(g, 1.15) * (uDiskT / 6000.0) * 1.32 * (0.82 + 0.3 * mix(0.5, fil, con) + 0.3 * hot);
  vec3 col = fireRamp(t);
  // relativistic beaming I ∝ g³ (+ gravitational redshift) with a soft knee on the approaching side
  float gb = pow(g, 3.0);
  gb = gb <= 1.0 ? gb : 1.0 + (gb - 1.0) / (1.0 + 0.45 * (gb - 1.0));
  float I = uDiskGain * pow(prof, 3.0) * gb * filB * (1.0 + 0.25 * cl) * (1.0 + 1.5 * hot) * uDiskK;
  return vec4(col * I / max(a, 0.05), a);
}

void main(){
  vec3 base = textureLod(tInput, vUv, 0.0).rgb;
  vec4 vv = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(uCamRot * normalize(vv.xyz / vv.w));
  vec3 ro = uCam;
  float R0 = length(ro);
  float tca = -dot(ro, rd);
  vec3 cp = ro + rd * tca;
  float b = length(cp);
  float bw = max(fwidth(b), 1e-4);              // impact-parameter change per pixel (before any branch)
  const float B_FULL = 320.0;
  if (b > B_FULL || (tca < 0.0 && R0 > 60.0)) {
    // weak field: deflect toward the hole (partial if the hole is behind)
    float part = 0.5 * (1.0 + tca / sqrt(tca * tca + b * b));
    float alpha = 2.0 / max(b, 1.0) * part;
    if (alpha < 2e-5) { gl_FragColor = vec4(base * uBgGain, 1.0); return; }
    vec3 d = normalize(rd - (cp / b) * alpha);
    gl_FragColor = vec4(background(d) * uBgGain, 1.0);
    return;
  }
  // strong field: start on a sphere around the hole
  float rStart = max(90.0, 1.3 * b);
  vec3 x = ro;
  float s = 0.0;                                 // path length from the camera (pixel footprint)
  if (R0 > rStart) {
    float disc = tca * tca - (R0 * R0 - rStart * rStart);
    s = tca - sqrt(max(disc, 0.0));
    x = ro + rd * s;
  }
  vec3 v = rd;
  float h2 = dot(cross(x, v), cross(x, v));
  vec3 L = vec3(0.0);
  float Tr = 1.0, TrRing = -1.0;
  float nCross = 0.0;
  bool captured = false;
  // polar jet ("pillar of light"): collimated along the spin axis, emerging just outside the shadow
  vec3 jetCore = vec3(1.0, 0.82, 0.5), jetSheath = vec3(1.0, 0.36, 0.08);
  for (int i = 0; i < 400; i++) {
    if (i >= uSteps) break;
    float r = length(x);
    if (r < 1.0) { captured = true; break; }
    if (TrRing < 0.0 && r < 1.8) TrRing = Tr;
    if (r > rStart * 1.02 && dot(x, v) > 0.0) break;
    float dt = clamp(0.07 * r, 0.015, 6.0) * (r < 2.5 ? 0.7 : 1.0);
    // velocity Verlet on x'' = -1.5 h² x / r⁵
    vec3 acc = -1.5 * h2 * x / pow(r, 5.0);
    vec3 xn = x + v * dt + 0.5 * acc * dt * dt;
    float rn = length(xn);
    vec3 accn = -1.5 * h2 * xn / pow(max(rn, 0.5), 5.0);
    vec3 vn = v + 0.5 * (acc + accn) * dt;
    if (uJet > 0.0) {
      // the pillar of light: a collimated jet along the spin axis, a blazing gold-white core inside a
      // flickering fiery sheath, emerging from the shadow's edge (u_157)
      vec3 xm = 0.5 * (x + xn);
      float ay = abs(xm.y), rho = length(xm.xz);
      float wj = 0.2 + 0.06 * ay;
      float q = rho / wj;
      if (q < 4.0) {
        float jb = smoothstep(2.5, 4.0, ay) * exp(-ay / 90.0);
        float fl = rv_snoise(vec3(xm.x / wj * 0.7, ay * 0.22 - uTime * 3.0 * sign(xm.y), xm.z / wj * 0.7 + (xm.y > 0.0 ? 0.0 : 9.1)));
        float qq = q * (1.0 - 0.28 * fl);
        float knots = 0.75 + 0.25 * sin(ay * 0.45 - uTime * 2.2 + (xm.y > 0.0 ? 0.0 : 1.7));
        vec3 je = jetCore * exp(-qq * qq * 5.0) * 3.0 + jetSheath * exp(-qq * qq * 0.9) * (0.4 + 0.35 * fl);
        L += Tr * je * (jb * knots * uJet / wj) * dt;
      }
    }
    if (x.y * xn.y < 0.0) {
      float f = x.y / (x.y - xn.y);
      vec3 p = mix(x, xn, f);
      vec3 ph = -normalize(mix(v, vn, f));
      float foot = (s + f * dt) * uPixAng / max(abs(ph.y), 0.25) * (1.0 + 3.0 * nCross);
      vec4 d = disk(p, ph, foot);
      L += Tr * d.rgb * d.a;
      Tr *= 1.0 - d.a;
      nCross += 1.0;
      if (Tr < 0.01) break;
    }
    s += dt;
    x = xn; v = vn;
  }
  if (TrRing < 0.0) TrRing = Tr;
  // near the hole the nucleus glow is exposed down; a procedural sky of sharp stars stays (lensed by direction)
  vec3 bg = captured ? vec3(0.0) : background(normalize(v)) * uBgGain + starfield(normalize(v)) * uStarF;
  // photon ring: light that orbited the photon sphere (n ≥ 2 images of the disk) piles up at b → b_c.
  // Drawn analytically at pixel scale (the n ≥ 2 crossings are thinner than a pixel): a thin blazing
  // gold-white line with a soft outer glow, Doppler-brighter on the approaching side, black inside.
  float db = b - B_CRIT;
  float wr = max(bw * 0.9, 0.002);
  float ringCore = exp(-db * db / (wr * wr));
  float ringGlow = db > 0.0 ? exp(-db / (wr * 5.0)) * 0.45 + exp(-db / 0.35) * 0.12 : exp(db / (wr * 0.8)) * 0.4;
  vec3 tang = normalize(vec3(-cp.z, 0.0, cp.x) + 1e-6);
  float beam = clamp(1.0 + 0.7 * dot(tang, -rd), 0.35, 1.8);
  vec3 ringCol = mix(vec3(1.0, 0.55, 0.16), vec3(1.0, 0.9, 0.7), clamp(ringCore * beam * 0.8, 0.0, 1.0));
  vec3 ring = ringCol * (ringCore * 1.6 + ringGlow) * beam * uRing * uDiskGain * 0.55;
  vec3 col = L + Tr * bg + TrRing * ring;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class BlackHole {
  constructor(engine, S) {
    this.engine = engine;
    const bh = S.blackHole || { mass: 4e6, spin: 0.6 };
    this.mass = bh.mass;
    this.spin = bh.spin;
    this.rs = bh.mass * RS_PER_MSUN_KLY;              // kly
    const q = engine.quality;
    const steps = q.tier === 'ultra' ? 320 : q.tier === 'high' ? 240 : q.tier === 'med' ? 160 : 110;
    // ISCO (Schwarzschild 3 r_s → ~0.6 r_s for a maximally spinning prograde Kerr hole), kept ≥ 1.25 r_s
    const isco = Math.max(1.25, 3 - 1.9 * Math.pow(bh.spin, 2.2));
    this.tilt = 0.12;
    this.bhRot = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationX(this.tilt)); // world → BH
    this.bhRotT = this.bhRot.clone().transpose();
    this.material = makeFullscreenMaterial(FRAG, {
      tInput: { value: null },
      uCam: { value: new THREE.Vector3() },
      uCamRot: { value: new THREE.Matrix3() },
      uBhToView: { value: new THREE.Matrix3() },
      uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() },
      uTime: { value: 0 }, uDiskIn: { value: isco }, uDiskOut: { value: 20 },
      uDiskT: { value: 5000 + 1800 * bh.spin }, uDiskGain: { value: 5.0 }, uSeed: { value: (S.seed % 997) * 0.37 },
      uSteps: { value: steps }, uBgGain: { value: 1 }, uStarF: { value: 0 },
      uPixAng: { value: 0.001 }, uRing: { value: 1 }, uJet: { value: 0.0 }, uTorn: { value: 0 },
    });
    this.jet = 0.06;      // jet brightness (×uDiskGain units); &gx=Jet:… overrides
    this.torn = 0.06;     // torn-space nebula brightness
    this.quad = new FullscreenQuad(this.material);
    this._m3 = new THREE.Matrix3();
    this._v = new THREE.Vector3();
    this.effect = { name: 'galaxy-blackhole', order: 150, render: (r, io) => this._render(r, io) };
  }

  /** Camera distance in Schwarzschild radii. */
  distanceRs(camera) { return camera.position.length() / this.rs; }
  active(camera) { return this.distanceRs(camera) < 20000; }

  _render(renderer, io) {
    const cam = io.camera, u = this.material.uniforms;
    u.tInput.value = io.input.texture;
    this._v.copy(cam.position).multiplyScalar(1 / this.rs).applyMatrix3(this.bhRot);
    u.uCam.value.copy(this._v);
    const camRot = this._m3.setFromMatrix4(cam.matrixWorld);           // view → world
    u.uCamRot.value.multiplyMatrices(this.bhRot, camRot);                // view → BH
    u.uBhToView.value.copy(u.uCamRot.value).transpose();                 // BH → view (orthonormal)
    u.uProj.value.copy(cam.projectionMatrix);
    u.uInvProj.value.copy(cam.projectionMatrixInverse);
    u.uTime.value = this.engine.time.t;
    // exposure adapts to the accretion disk: the nucleus' starlight is dimmed close to the hole
    const lr = Math.log10(Math.max(1, this.distanceRs(cam)));
    const k = Math.min(1, Math.max(0, (lr - 2.2) / (4.3 - 2.2)));
        u.uBgGain.value = 0.02 + 0.98 * k * k * (3 - 2 * k);
    u.uStarF.value = 1 - k;
    // pixel footprint (rad / px) for the disk filaments' anti-aliasing
    const H = Math.max(1, this.engine.pipeline?.height || this.engine.height || 720);
    u.uPixAng.value = 2 * Math.tan((cam.fov || 45) * Math.PI / 360) / (cam.zoom || 1) / H;
    // close to the hole: the polar jet (pillar of light) and the torn red/teal gas of the nucleus behind it
    const near = 1 - k;
    u.uJet.value = this.jet * near;
    u.uTorn.value = this.torn * near;
    this.quad.render(renderer, io.output);
  }

  dispose() { this.material.dispose(); this.quad.dispose(); }
}
