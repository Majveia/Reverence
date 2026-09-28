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
uniform float uTime, uDiskIn, uDiskOut, uDiskT, uDiskGain, uSeed, uBgGain;
uniform int uSteps;
varying vec2 vUv;

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

vec3 background(vec3 dirBH){
  vec3 dv = uBhToView * dirBH;
  if (dv.z < -1e-4) {
    vec4 c = uProj * vec4(dv, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) return textureLod(tInput, uv, 0.0).rgb;
    vec2 e = clamp(uv, 0.002, 0.998);
    float f = exp(-length(uv - e) * 2.5);
    return textureLod(tInput, e, 0.0).rgb * f + starfield(dirBH);
  }
  return textureLod(tInput, vec2(0.5), 3.0).rgb * 0.15 + starfield(dirBH);
}

// thin disk sample at crossing point p (BH frame, y≈0) seen along photon direction ph (toward camera)
vec4 disk(vec3 p, vec3 ph){
  float r = length(p.xz);
  if (r < uDiskIn * 0.98 || r > uDiskOut) return vec4(0.0);
  float x = uDiskIn / r;
  float prof = pow(x, 0.75) * pow(max(1.0 - sqrt(x), 0.0), 0.25) / 0.488;
  vec3 uPhi = normalize(vec3(-p.z, 0.0, p.x));
  float beta = min(sqrt(0.5 / max(r - 1.0, 0.05)), 0.96);
  float gam = inversesqrt(1.0 - beta * beta);
  float dop = 1.0 / (gam * (1.0 - beta * dot(uPhi, ph)));
  float g = dop * sqrt(max(1.0 - 1.0 / r, 0.02));
  // turbulent streaks sheared by Keplerian rotation
  float om = sqrt(0.5 / (r * r * r));
  float phi = atan(p.z, p.x) - om * uTime * 6.0;
  float lr = log(r);
  float n = rv_fbm(vec3(cos(phi) * 2.2, sin(phi) * 2.2, lr * 9.0 + uSeed), 5);
  float n2 = rv_fbm(vec3(cos(phi) * 7.0, sin(phi) * 7.0, lr * 26.0 + 3.1 + uSeed), 3);
  float dens = smoothstep(-0.55, 0.55, n + 0.35 * n2);
  float edgeIn = smoothstep(uDiskIn * 0.98, uDiskIn * 1.12, r);
  float edgeOut = 1.0 - smoothstep(uDiskOut * 0.45, uDiskOut, r);
  float a = clamp((0.35 + 0.75 * dens) * edgeIn * edgeOut, 0.0, 0.97);
  float T = uDiskT * prof * g;
  vec3 col = rv_blackbody(T);
  col /= max(max(col.r, col.g), max(col.b, 1e-3));
  float I = uDiskGain * prof * prof * pow(g, 3.0) * (0.45 + 0.9 * dens);
  return vec4(col * I, a);
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
  const float B_FULL = 320.0;
  if (b > B_FULL || (tca < 0.0 && R0 > 60.0)) {
    // weak field: deflect toward the hole (partial if the hole is behind)
    float part = tca > 0.0 ? 0.5 * (1.0 + tca / sqrt(tca * tca + b * b)) : 0.5 * (1.0 + tca / sqrt(tca * tca + b * b));
    float alpha = 2.0 / max(b, 1.0) * part;
    if (alpha < 2e-5) { gl_FragColor = vec4(base * uBgGain, 1.0); return; }
    vec3 d = normalize(rd - (cp / b) * alpha);
    gl_FragColor = vec4(background(d) * uBgGain, 1.0);
    return;
  }
  // strong field: start on a sphere around the hole
  float rStart = max(90.0, 1.3 * b);
  vec3 x = ro;
  if (R0 > rStart) {
    float disc = tca * tca - (R0 * R0 - rStart * rStart);
    x = ro + rd * (tca - sqrt(max(disc, 0.0)));
  }
  vec3 v = rd;
  float h2 = dot(cross(x, v), cross(x, v));
  vec3 L = vec3(0.0);
  float Tr = 1.0;
  bool captured = false;
  for (int i = 0; i < 400; i++) {
    if (i >= uSteps) break;
    float r = length(x);
    if (r < 1.0) { captured = true; break; }
    if (r > rStart * 1.02 && dot(x, v) > 0.0) break;
    float dt = clamp(0.07 * r, 0.015, 6.0) * (r < 2.5 ? 0.7 : 1.0);
    // velocity Verlet on x'' = -1.5 h² x / r⁵
    vec3 acc = -1.5 * h2 * x / pow(r, 5.0);
    vec3 xn = x + v * dt + 0.5 * acc * dt * dt;
    float rn = length(xn);
    vec3 accn = -1.5 * h2 * xn / pow(max(rn, 0.5), 5.0);
    vec3 vn = v + 0.5 * (acc + accn) * dt;
    if (x.y * xn.y < 0.0) {
      float f = x.y / (x.y - xn.y);
      vec3 p = mix(x, xn, f);
      vec4 d = disk(p, -normalize(mix(v, vn, f)));
      L += Tr * d.rgb * d.a;
      Tr *= 1.0 - d.a;
      if (Tr < 0.01) break;
    }
    x = xn; v = vn;
  }
  vec3 bg = captured ? vec3(0.0) : background(normalize(v)) * uBgGain;
  // smooth hand-over to the unlensed frame at the edge of the strong-field region
  vec3 col = L + Tr * bg;
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
      uTime: { value: 0 }, uDiskIn: { value: isco }, uDiskOut: { value: 16 },
      uDiskT: { value: 5000 + 1800 * bh.spin }, uDiskGain: { value: 5.0 }, uSeed: { value: (S.seed % 997) * 0.37 },
      uSteps: { value: steps }, uBgGain: { value: 1 },
    });
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
    u.uBgGain.value = 0.018 + 0.982 * k * k * (3 - 2 * k);
    this.quad.render(renderer, io.output);
  }

  dispose() { this.material.dispose(); this.quad.dispose(); }
}
