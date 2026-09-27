// Atmosphere LUTs (Hillaire 2020) rendered on the GPU (OWNED BY THE ATMOSPHERE TRACK).
//   transmittance LUT  256×64   (r, μ)          — once per planet
//   multi-scattering   32×32    (r, μs)         — once per planet
//   sky-view LUT       192×108  (view zenith, azimuth to sun) — every rendered frame, for the camera
//                      MRT: [0] Rayleigh single scattering (no phase), [1] Mie single scattering
//                      (no phase), [2] multiple scattering + ground bounce. Phases are applied
//                      analytically per pixel → razor-sharp sun aureole at any LUT resolution.
import * as THREE from 'three';
import { TRANS_W, TRANS_H, MS_SIZE, SKY_W, SKY_H } from './glsl.js';
import { fsMaterial, FSQuad, hdrTarget } from './fs.js';

const TRANS_FRAG = /* glsl */ `
#include <rv_atmo>
varying vec2 vUv;
void main(){
  float r, mu;
  atmo_transUVInv(vUv, r, mu);
  float disc = r * r * (mu * mu - 1.0) + uAtmoRt * uAtmoRt;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  vec3 od = vec3(0.0);
  const float N = 48.0;
  float dt = d / N;
  vec3 ro = vec3(0.0, r, 0.0), rd = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  for (float i = 0.0; i < N; i += 1.0){
    vec3 p = ro + rd * ((i + 0.5) * dt);
    vec3 sR, sM, ext;
    atmo_medium(length(p) - uAtmoRb, sR, sM, ext);
    od += ext * dt;
  }
  gl_FragColor = vec4(exp(-od), 1.0);
}`;

const MS_FRAG = /* glsl */ `
#include <rv_atmo>
varying vec2 vUv;
// Integrate single scattering with an isotropic phase + ground bounce, and the f_ms transfer term.
void integ(vec3 ro, vec3 rd, vec3 sunDir, out vec3 L, out vec3 fms){
  L = vec3(0.0); fms = vec3(0.0);
  vec2 top = atmo_raySphere(ro, rd, uAtmoRt);
  vec2 bot = atmo_raySphere(ro, rd, uAtmoRb);
  float tMax = top.y;
  bool hitGround = bot.x > 0.0;
  if (hitGround) tMax = min(tMax, bot.x);
  if (tMax <= 0.0) return;
  const float N = 20.0;
  float dt = tMax / N;
  vec3 T = vec3(1.0);
  const float iso = 1.0 / (4.0 * RV_PI);
  for (float i = 0.0; i < N; i += 1.0){
    vec3 p = ro + rd * ((i + 0.3) * dt);
    float r = length(p);
    vec3 sR, sM, ext;
    atmo_medium(r - uAtmoRb, sR, sM, ext);
    vec3 scat = sR + sM;
    vec3 Ts = atmo_sunTransmittance(r, dot(p / r, sunDir));
    vec3 Tseg = exp(-ext * dt);
    vec3 k = T * (1.0 - Tseg) / max(ext, vec3(1e-12));
    L += k * scat * iso * Ts;
    fms += k * scat;
    T *= Tseg;
  }
  if (hitGround){
    vec3 p = ro + rd * tMax;
    float r = length(p);
    vec3 up = p / r;
    vec3 Ts = atmo_sunTransmittance(r, dot(up, sunDir));
    L += T * Ts * max(dot(up, sunDir), 0.0) * uGroundAlbedo / RV_PI;
  }
}
void main(){
  float muS = atmo_subToUnit(vUv.x, ATMO_MS_SIZE) * 2.0 - 1.0;
  float r = uAtmoRb + clamp(atmo_subToUnit(vUv.y, ATMO_MS_SIZE), 0.0, 1.0) * (uAtmoRt - uAtmoRb);
  r = clamp(r, uAtmoRb + 1.0, uAtmoRt - 1.0);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 sunDir = normalize(vec3(0.0, muS, -sqrt(max(0.0, 1.0 - muS * muS))));
  vec3 Lsum = vec3(0.0), Fsum = vec3(0.0);
  const float S = 8.0;
  for (float i = 0.0; i < S; i += 1.0){
    for (float j = 0.0; j < S; j += 1.0){
      float th = 2.0 * RV_PI * (i + 0.5) / S;
      float ph = acos(1.0 - 2.0 * (j + 0.5) / S);
      vec3 rd = vec3(cos(th) * sin(ph), cos(ph), sin(th) * sin(ph));
      vec3 L, f;
      integ(ro, rd, sunDir, L, f);
      Lsum += L; Fsum += f;
    }
  }
  float w = 4.0 * RV_PI / (S * S);
  vec3 L2 = Lsum * w / (4.0 * RV_PI);     // second-order luminance (isotropic phase)
  vec3 fms = Fsum * w / (4.0 * RV_PI);    // transfer factor
  vec3 psi = L2 / max(1.0 - fms, vec3(1e-3));
  gl_FragColor = vec4(psi, 1.0);
}`;

const SKY_FRAG = /* glsl */ `
#include <rv_atmo>
uniform float uViewR;         // camera radius (planet-centered)
uniform float uSunCosZ;       // sun zenith cosine at the camera
uniform float uSteps;
uniform vec3 uGroundIrr;      // sky irradiance at the ground (for the ground bounce, sun = 1)
varying vec2 vUv;
layout(location = 0) out vec4 outR;
layout(location = 1) out vec4 outM;
layout(location = 2) out vec4 outMS;
void main(){
  float viewR = max(uViewR, uAtmoRb + 1.0);
  vec2 uv = vec2(atmo_subToUnit(vUv.x, ATMO_SKY_W), atmo_subToUnit(vUv.y, ATMO_SKY_H));
  uv = clamp(uv, 0.0, 1.0);
  float vHorizon = sqrt(max(viewR * viewR - uAtmoRb * uAtmoRb, 0.0));
  float cosBeta = vHorizon / viewR;
  float beta = acos(clamp(cosBeta, -1.0, 1.0));
  float zenithHorizonAngle = RV_PI - beta;
  float viewZenith;
  if (uv.y < 0.5){
    float c = 2.0 * uv.y; c = 1.0 - c; c *= c; c = 1.0 - c;
    viewZenith = zenithHorizonAngle * c;
  } else {
    float c = uv.y * 2.0 - 1.0; c *= c;
    viewZenith = zenithHorizonAngle + beta * c;
  }
  float cz = cos(viewZenith), sz = sin(viewZenith);
  float coordX = uv.x * uv.x;
  float cosAz = -(coordX * 2.0 - 1.0);
  float sinAz = sqrt(max(0.0, 1.0 - cosAz * cosAz));
  vec3 rd = vec3(sz * cosAz, cz, sz * sinAz);
  float sz_s = sqrt(max(0.0, 1.0 - uSunCosZ * uSunCosZ));
  vec3 sunDir = vec3(sz_s, uSunCosZ, 0.0);
  vec3 ro = vec3(0.0, viewR, 0.0);

  vec2 top = atmo_raySphere(ro, rd, uAtmoRt);
  vec2 bot = atmo_raySphere(ro, rd, uAtmoRb);
  float tMax = top.y;
  bool ground = bot.x > 0.0;
  if (ground) tMax = min(tMax, bot.x);
  AtmoInscatter a = atmo_march(ro, rd, max(top.x, 0.0), tMax, sunDir, uSteps, 0.3);
  vec3 ms = a.Lms;
  if (ground){
    vec3 p = ro + rd * tMax;
    float r = length(p);
    vec3 up = p / r;
    float muS = dot(up, sunDir);
    vec3 Ts = atmo_sunTransmittance(r, muS);
    ms += a.T * uGroundAlbedo / RV_PI * (Ts * max(muS, 0.0) + uGroundIrr);
  }
  outR = vec4(a.Lr, 1.0);
  outM = vec4(a.Lm, 1.0);
  outMS = vec4(ms, 1.0);
}`;

export class AtmosphereLUTs {
  constructor(uniforms, quality) {
    this.u = uniforms;
    this.quad = new FSQuad();
    this.transRT = hdrTarget(TRANS_W, TRANS_H);
    this.msRT = hdrTarget(MS_SIZE, MS_SIZE);
    this.skyRT = hdrTarget(SKY_W, SKY_H, { count: 3 });
    this.transMat = fsMaterial(TRANS_FRAG, { ...uniforms });
    this.msMat = fsMaterial(MS_FRAG, { ...uniforms });
    this.skyUniforms = {
      uViewR: { value: 1 }, uSunCosZ: { value: 1 },
      uSteps: { value: quality.tier === 'low' ? 18 : quality.tier === 'med' ? 24 : 32 },
      uGroundIrr: { value: new THREE.Vector3(0.1, 0.1, 0.12) },
    };
    this.skyMat = fsMaterial(SKY_FRAG, { ...uniforms, ...this.skyUniforms }, { glslVersion: THREE.GLSL3 });
    this.staticDone = false;
    // expose textures through the shared uniforms
    uniforms.uTransLUT.value = this.transRT.texture;
    uniforms.uMsLUT.value = this.msRT.texture;
  }

  get skyTextures() { return this.skyRT.textures; }

  buildStatic(renderer) {
    // transmittance first (MS depends on it)
    this.u.uTransLUT.value = null;
    this.quad.render(renderer, this.transMat, this.transRT);
    this.u.uTransLUT.value = this.transRT.texture;
    this.u.uMsLUT.value = null;
    this.quad.render(renderer, this.msMat, this.msRT);
    this.u.uMsLUT.value = this.msRT.texture;
    this.staticDone = true;
  }

  updateSky(renderer, viewR, sunCosZ, groundIrr) {
    const s = this.skyUniforms;
    s.uViewR.value = viewR;
    s.uSunCosZ.value = sunCosZ;
    if (groundIrr) s.uGroundIrr.value.copy(groundIrr);
    this.quad.render(renderer, this.skyMat, this.skyRT);
  }

  dispose() {
    this.transRT.dispose(); this.msRT.dispose(); this.skyRT.dispose();
    this.transMat.dispose(); this.msMat.dispose(); this.skyMat.dispose();
    this.quad.dispose();
  }
}
