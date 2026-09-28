// GLSL library for the atmosphere track (OWNED BY THE ATMOSPHERE TRACK).
//
// Registers shader chunks:
//   rv_atmo        physically based atmosphere (Hillaire 2020 "A Scalable and Production Ready Sky and
//                  Atmosphere Rendering Technique"): Rayleigh + Mie + ozone, transmittance / multiple
//                  scattering LUT lookups, ray/sphere helpers, phase functions, ray-marched in-scattering.
//                  All distances are METERS in a PLANET-CENTERED frame (p = scenePos - uPlanetCenter).
//   rv_atmo_view   screen → view-ray reconstruction helpers for full-screen passes.
//   rv_cloudshadow cloud shadow lookup for any shader: rv_cloudShadow(worldScenePos) → 0..1
//                  (declare the uniforms by including this chunk; values are provided by world.lighting)
import { registerChunk } from '../../shaders/chunks.js';

// Sizes of the LUTs (must match luts.js)
export const TRANS_W = 256, TRANS_H = 64;
export const MS_SIZE = 32;
export const SKY_W = 192, SKY_H = 108;

registerChunk('rv_atmo', /* glsl */ `
#ifndef RV_ATMO
#define RV_ATMO
#ifndef RV_PI
#define RV_PI 3.14159265359
#endif
#define ATMO_TRANS_W ${TRANS_W}.0
#define ATMO_TRANS_H ${TRANS_H}.0
#define ATMO_MS_SIZE ${MS_SIZE}.0
#define ATMO_SKY_W ${SKY_W}.0
#define ATMO_SKY_H ${SKY_H}.0

uniform float uAtmoRb;          // bottom radius (sea level), m
uniform float uAtmoRt;          // top radius, m
uniform vec3  uRayScat;         // Rayleigh scattering at sea level (1/m)
uniform float uRayInvH;         // 1 / Rayleigh scale height
uniform vec3  uMieScat;         // Mie scattering at sea level (1/m)
uniform vec3  uMieExt;          // Mie extinction at sea level (1/m)
uniform float uMieInvH;         // 1 / Mie scale height
uniform float uMieG;            // Mie asymmetry
uniform vec3  uOzoneAbs;        // ozone absorption at peak (1/m)
uniform float uOzoneCenter;     // ozone layer center altitude (m)
uniform float uOzoneInvHalfW;   // 1 / ozone half width
uniform float uSkyGain;         // art gain on in-scattered light (sky brighter than sunlit ground, as in games)
uniform float uSkyViewGain;     // extra gain for the sky dome seen from inside the atmosphere (sky-view LUT)
uniform vec2  uTopFade;
uniform float uSunsetK;         // sun-path reddening power for low suns (see atmo_sunTransmittance)         // density fades to 0 between x and y (altitude, m)
uniform vec3  uGroundAlbedo;
uniform float uSunAngR;         // angular radius of the star (rad)
uniform sampler2D uTransLUT;
uniform sampler2D uMsLUT;

float atmo_unitToSub(float u, float res){ return (u + 0.5 / res) * (res / (res + 1.0)); }
float atmo_subToUnit(float u, float res){ return (u - 0.5 / res) * (res / (res - 1.0)); }

// Ray / sphere (sphere at origin). Numerically stable for far-away origins. Returns (t0, t1) or (-1,-1).
vec2 atmo_raySphere(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd);
  vec3 q = ro - b * rd;
  float h2 = r * r - dot(q, q);
  if (h2 < 0.0) return vec2(-1.0);
  float h = sqrt(h2);
  return vec2(-b - h, -b + h);
}

// ---------------------------------------------------------------- medium
void atmo_medium(float h, out vec3 scatR, out vec3 scatM, out vec3 ext){
  h = max(h, 0.0);
  float f = 1.0 - smoothstep(uTopFade.x, uTopFade.y, h);
  float dR = exp(-h * uRayInvH) * f;
  float dM = exp(-h * uMieInvH) * f;
  float dO = max(0.0, 1.0 - abs(h - uOzoneCenter) * uOzoneInvHalfW);
  scatR = uRayScat * dR;
  scatM = uMieScat * dM;
  ext = scatR + uMieExt * dM + uOzoneAbs * dO;
}

// ---------------------------------------------------------------- phase functions
float atmo_phaseRayleigh(float c){ return 3.0 / (16.0 * RV_PI) * (1.0 + c * c); }
// Cornette-Shanks (better than plain HG for aerosols)
float atmo_phaseMie(float c, float g){
  float g2 = g * g;
  float k = 3.0 / (8.0 * RV_PI) * (1.0 - g2) / (2.0 + g2);
  return k * (1.0 + c * c) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}
float atmo_phaseHG(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * RV_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// ---------------------------------------------------------------- transmittance LUT (Bruneton parameterization)
vec2 atmo_transUV(float r, float mu){
  float Rb = uAtmoRb, Rt = uAtmoRt;
  float H = sqrt(max(0.0, Rt * Rt - Rb * Rb));
  float rho = sqrt(max(0.0, r * r - Rb * Rb));
  float disc = r * r * (mu * mu - 1.0) + Rt * Rt;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dMin = Rt - r;
  float dMax = rho + H;
  float xMu = (d - dMin) / max(dMax - dMin, 1e-3);
  float xR = rho / H;
  return vec2(atmo_unitToSub(clamp(xMu, 0.0, 1.0), ATMO_TRANS_W), atmo_unitToSub(clamp(xR, 0.0, 1.0), ATMO_TRANS_H));
}
void atmo_transUVInv(vec2 uv, out float r, out float mu){
  float Rb = uAtmoRb, Rt = uAtmoRt;
  float xMu = atmo_subToUnit(uv.x, ATMO_TRANS_W);
  float xR = atmo_subToUnit(uv.y, ATMO_TRANS_H);
  float H = sqrt(max(0.0, Rt * Rt - Rb * Rb));
  float rho = H * clamp(xR, 0.0, 1.0);
  r = sqrt(rho * rho + Rb * Rb);
  float dMin = Rt - r;
  float dMax = rho + H;
  float d = dMin + clamp(xMu, 0.0, 1.0) * (dMax - dMin);
  mu = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
}
vec3 atmo_transmittance(float r, float mu){
  r = clamp(r, uAtmoRb + 0.5, uAtmoRt);
  return texture(uTransLUT, atmo_transUV(r, mu)).rgb;
}
// Transmittance of the straight segment p0 → p1 (planet-centered), from the LUT (Bruneton): descending
// segments use the reversed (upward) form.
vec3 atmo_transSegment(vec3 p0, vec3 p1){
  vec3 d = p1 - p0;
  float l = length(d);
  if (l < 1.0) return vec3(1.0);
  d /= l;
  float r0 = length(p0), r1 = length(p1);
  float mu0 = dot(p0, d) / r0, mu1 = dot(p1, d) / r1;
  vec3 T;
  if (mu1 < 0.0) T = atmo_transmittance(r1, -mu1) / max(atmo_transmittance(r0, -mu0), vec3(1e-5));
  else T = atmo_transmittance(r0, mu0) / max(atmo_transmittance(r1, mu1), vec3(1e-5));
  return clamp(T, 0.0, 1.0);
}
// Transmittance toward the star from radius r, star zenith cosine muS, with a soft planet shadow
// (the star is a disk: fraction of the disk above the geometric horizon).
vec3 atmo_sunTransmittance(float r, float muS){
  r = max(r, uAtmoRb + 0.5);
  float sinH = uAtmoRb / r;
  float cosH = -sqrt(max(0.0, 1.0 - sinH * sinH));
  float a = max(uSunAngR, 0.004);
  float vis = smoothstep(-a, a, (muS - cosH) / max(sinH, 1e-3));
  if (vis <= 0.0) return vec3(0.0);
  // art-directed sunset reddening: low suns get a deeper (Earth-like) air-mass color
  float k = mix(uSunsetK, 1.0, smoothstep(0.0, 0.2, muS));
  return pow(atmo_transmittance(r, muS), vec3(k)) * vis;
}

// ---------------------------------------------------------------- multiple scattering LUT
vec2 atmo_msUV(float r, float muS){
  float x = clamp(muS * 0.5 + 0.5, 0.0, 1.0);
  float y = clamp((r - uAtmoRb) / (uAtmoRt - uAtmoRb), 0.0, 1.0);
  return vec2(atmo_unitToSub(x, ATMO_MS_SIZE), atmo_unitToSub(y, ATMO_MS_SIZE));
}
vec3 atmo_multiScat(float r, float muS){ return texture(uMsLUT, atmo_msUV(r, muS)).rgb; }

// ---------------------------------------------------------------- ray-marched in-scattering
// Integrates single (phase-free, split Rayleigh/Mie) + multiple scattering along [t0, t1].
// Energy-conserving per-segment analytic integration (Hillaire). Sun illuminance = 1.
// Lr/Lm must be multiplied by the Rayleigh/Mie phase for the view/sun angle (constant along a ray).
struct AtmoInscatter { vec3 Lr; vec3 Lm; vec3 Lms; vec3 T; };

AtmoInscatter atmo_marchS(vec3 ro, vec3 rd, float t0, float t1, vec3 sunDir, float steps, float jitter, float dens){
  AtmoInscatter o;
  o.Lr = vec3(0.0); o.Lm = vec3(0.0); o.Lms = vec3(0.0); o.T = vec3(1.0);
  float len = max(t1 - t0, 0.0);
  if (len <= 0.0) return o;
  float dt = len / steps;
  for (int i = 0; i < 64; i++){
    if (float(i) >= steps) break;
    float t = t0 + (float(i) + jitter) * dt;
    vec3 p = ro + rd * t;
    float r = length(p);
    vec3 up = p / r;
    vec3 sR, sM, ext;
    atmo_medium(r - uAtmoRb, sR, sM, ext);
    sR *= dens; sM *= dens; ext *= dens;
    float muS = dot(up, sunDir);
    vec3 Ts = atmo_sunTransmittance(r, muS);
    vec3 ms = atmo_multiScat(r, muS);
    vec3 Tseg = exp(-ext * dt);
    vec3 integ = o.T * (1.0 - Tseg) / max(ext, vec3(1e-12));
    o.Lr += integ * sR * Ts;
    o.Lm += integ * sM * Ts;
    o.Lms += integ * (sR + sM) * ms;
    o.T *= Tseg;
  }
  return o;
}

AtmoInscatter atmo_march(vec3 ro, vec3 rd, float t0, float t1, vec3 sunDir, float steps, float jitter){
  return atmo_marchS(ro, rd, t0, t1, sunDir, steps, jitter, 1.0);
}

vec3 atmo_combine(AtmoInscatter a, float cosTheta){
  return (a.Lr * atmo_phaseRayleigh(cosTheta) + a.Lm * atmo_phaseMie(cosTheta, uMieG) + a.Lms) * uSkyGain;
}

// Segment of a ray (planet-centered origin) inside the atmosphere, clipped to [0, tMax].
// Returns (tStart, tEnd); tEnd <= tStart means no atmosphere along the segment.
vec2 atmo_segment(vec3 ro, vec3 rd, float tMax){
  vec2 top = atmo_raySphere(ro, rd, uAtmoRt);
  if (top.y <= 0.0) return vec2(0.0, -1.0);
  float ts = max(top.x, 0.0);
  float te = min(top.y, tMax);
  return vec2(ts, te);
}
#endif
`);

// Sky-view LUT sampling (requires rv_atmo). Returns sky radiance for sun illuminance = 1.
registerChunk('rv_atmo_sky', /* glsl */ `
#ifndef RV_ATMO_SKY
#define RV_ATMO_SKY
uniform sampler2D uSkyR;
uniform sampler2D uSkyM;
uniform sampler2D uSkyMS;
vec2 atmo_skyViewUV(bool ground, float cosZ, float cosAz, float viewR){
  float vHorizon = sqrt(max(viewR * viewR - uAtmoRb * uAtmoRb, 0.0));
  float beta = acos(clamp(vHorizon / viewR, -1.0, 1.0));
  float zha = RV_PI - beta;
  float va = acos(clamp(cosZ, -1.0, 1.0));
  vec2 uv;
  if (!ground){
    float c = clamp(va / zha, 0.0, 1.0);
    c = 1.0 - sqrt(max(1.0 - c, 0.0));
    uv.y = c * 0.5;
  } else {
    float c = clamp((va - zha) / max(beta, 1e-4), 0.0, 1.0);
    uv.y = sqrt(c) * 0.5 + 0.5;
  }
  uv.x = sqrt(clamp(-cosAz * 0.5 + 0.5, 0.0, 1.0));
  return vec2(atmo_unitToSub(uv.x, ATMO_SKY_W), atmo_unitToSub(uv.y, ATMO_SKY_H));
}
// dir: view direction, up: local up at the camera, viewR: camera radius, sunDir, nu = dot(dir, sunDir)
vec3 atmo_skyLUT(vec3 dir, vec3 up, float viewR, vec3 sunDir, float nu){
  float cosZ = dot(dir, up);
  vec3 sH = sunDir - up * dot(sunDir, up);
  vec3 vH = dir - up * cosZ;
  float ls = length(sH), lv = length(vH);
  float cosAz = (ls > 1e-5 && lv > 1e-5) ? dot(sH, vH) / (ls * lv) : 1.0;
  vec2 bot = atmo_raySphere(up * viewR, dir, uAtmoRb);
  bool ground = bot.x > 0.0;
  vec2 uv = atmo_skyViewUV(ground, cosZ, cosAz, viewR);
  vec3 Lr = texture(uSkyR, uv).rgb;
  vec3 Lm = texture(uSkyM, uv).rgb;
  vec3 Lms = texture(uSkyMS, uv).rgb;
  return (Lr * atmo_phaseRayleigh(nu) + Lm * atmo_phaseMie(nu, uMieG) + Lms) * uSkyGain * uSkyViewGain;
}
#endif
`);

registerChunk('rv_atmo_view', /* glsl */ `
#ifndef RV_ATMO_VIEW
#define RV_ATMO_VIEW
uniform mat4 uCamWorld;     // camera.matrixWorld (scene space)
uniform vec4 uProjParams;   // (P00, P11, P20, P21) of the projection matrix
uniform float uNear;
uniform float uFar;
// View-space direction (not normalized, z = -1) for a screen uv.
vec3 atmo_viewDir(vec2 uv){
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3((ndc.x + uProjParams.z) / uProjParams.x, (ndc.y + uProjParams.w) / uProjParams.y, -1.0);
}
// Distance along the (normalized) world ray to the depth-buffer surface.
float atmo_depthToDist(float depth, vec3 viewDir){
  float vz = rv_viewZFromDepth(depth, uNear, uFar);
  return vz * length(viewDir);
}
bool atmo_isFar(float depth){
#ifdef USE_REVERSED_DEPTH_BUFFER
  return depth <= 1e-9;
#else
  return depth >= 0.9999999;
#endif
}
#endif
`);

// Cloud shadow lookup usable by any material (flora, water, custom shaders).
// Uniform values live in world.lighting.uniforms (rvCloudShadowMap, rvCloudShadowMatrix, rvCloudShadowParams).
registerChunk('rv_cloudshadow', /* glsl */ `
#ifndef RV_CLOUDSHADOW
#define RV_CLOUDSHADOW
uniform sampler2D rvCloudShadowMap;
uniform mat4 rvCloudShadowMatrix;   // scene-space position → (u, v) in the map (xy), w unused
uniform vec4 rvCloudShadowParams;   // x: enabled (0/1), y: strength, z: fade radius (m), w: unused
float rv_cloudShadow(vec3 scenePos){
  if (rvCloudShadowParams.x < 0.5) return 1.0;
  vec4 c = rvCloudShadowMatrix * vec4(scenePos, 1.0);
  vec2 uv = c.xy;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 1.0;
  float s = texture(rvCloudShadowMap, uv).r;
  // fade out at the map border
  vec2 e = min(uv, 1.0 - uv);
  float edge = smoothstep(0.0, 0.08, min(e.x, e.y));
  return mix(1.0, mix(1.0, s, rvCloudShadowParams.y), edge);
}
#endif
`);
