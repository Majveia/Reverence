// Volumetric light (pipeline effect "volumetric-light", order 120). OWNED BY THE ATMOSPHERE TRACK.
//
// Two complementary terms, composited in one pass:
//
//  1. Ray-marched volumetric shafts (quarter res, depth-aware upsample): each view ray is marched through
//     the air BELOW the cloud deck; at every sample the cloud shadow map (projected along the key light,
//     see clouds.js) says whether that parcel of air is sunlit. The single-scattered sunlight the
//     atmosphere pass already added for shadowed parcels is removed (dark beams), and an art-directed
//     haze (weather: fog / dust / rain) scatters sunlight only where it is lit (bright beams). This gives
//     real 3D crepuscular rays: converging on the sun through cloud gaps, and on the anti-solar point
//     behind the camera. The same march adds RAIN CURTAINS: grey precipitation shafts hanging under
//     dense / stormy cells of the weather map (extinction + ambient in-scatter).
//  2. Screen-space radial streaks around the key light (quarter res): a mask of unoccluded sky (scene
//     depth = far) × cloud transmittance, blurred toward the light in two passes — the fine streaks
//     between cloud edges and ridges right next to the sun disk.
import * as THREE from 'three';
import { fsMaterial, FSQuad, hdrTarget } from './fs.js';
import { Params } from '../../core/Params.js';

const VOL_FRAG = /* glsl */`
#include <rv_common>
#include <rv_atmo>
#include <rv_atmo_view>
#ifdef HAS_CLOUDS
#include <rv_cloud>
#endif
uniform sampler2D tDepth;
uniform sampler2D tShadow;
uniform vec4 uShadowP;     // enabled, size (m), -, -
uniform vec3 uShE1;
uniform vec3 uShE2;
#ifdef HAS_CSM
uniform sampler2DShadow tSunShadow;
uniform mat4 uCsmMat[CSM_N];
uniform float uCsmEnd[CSM_N];
uniform vec4 uCsmP;        // enabled, range (m), bias, -
uniform vec3 uOrigin;      // floating origin (planet-local position of the scene origin)
#endif
uniform vec3 uCamPlanet;
uniform vec3 uKeyDir;
uniform vec3 uKeyIll;      // key light illuminance at the top of the atmosphere
uniform float uAPScale;
uniform vec4 uHaze;        // extra haze: extinction at the base (1/m), 1/scale height, base altitude (m), anisotropy
uniform vec4 uMarch;       // steps, max distance (m), cloud base radius (m), shaft gain
uniform vec4 uRain;        // amount 0..1, extinction (1/m), storm weight, -
uniform vec3 uRainCol;     // in-scattered radiance of the rain curtains
uniform sampler2D tCloudRT;  // clouds pass (rgb: light, a: transmittance), half res
uniform float uHasCloudRT;
uniform vec4 uFogV;        // effect height fog: density at base (1/m), scale height, base altitude, -
uniform vec3 uFogSunV;     // sun illuminance used by the fog (already dimmed by weather)
uniform float uFrameJ;     // frame counter (jitter pattern; TAA accumulates it)
varying vec2 vUv;
layout(location = 0) out vec4 outAdd;   // rgb: added light (lit haze, rain), a: transmittance
layout(location = 1) out vec4 outSub;   // r: removed light (shadowed air), luminance (>= 0)

float cloudVis(vec3 p){
  if (uShadowP.x < 0.5) return 1.0;
  vec3 d = p - uCamPlanet;
  vec2 uv = vec2(dot(d, uShE1), dot(d, uShE2)) / uShadowP.y + 0.5;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 1.0;
  float s = texture(tShadow, uv).r;
  vec2 e = min(uv, 1.0 - uv);
  return mix(1.0, s, smoothstep(0.0, 0.1, min(e.x, e.y)));
}

#ifdef HAS_CSM
// sun cascaded shadow map (terrain, trees, buildings): the cascade covering this view depth
float csmVis(vec3 pPlanet, float viewDepth){
  if (uCsmP.x < 0.5 || viewDepth > uCsmP.y) return 1.0;
  vec4 wp = vec4(pPlanet - uOrigin, 1.0);
  for (int i = 0; i < CSM_N; i++){
    if (viewDepth < uCsmEnd[i]){
      vec4 sc = uCsmMat[i] * wp;
      sc.xyz /= sc.w;
      sc.z += uCsmP.z;
      if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
      return texture(tSunShadow, sc.xyz);
    }
  }
  return 1.0;
}
#endif

void main(){
  float depth = texture(tDepth, vUv).r;
  vec3 vd = atmo_viewDir(vUv);
  vec3 dir = normalize(mat3(uCamWorld) * vd);
  bool far = atmo_isFar(depth);
  float tHit = far ? 1e30 : atmo_depthToDist(depth, vd);
  vec3 ro = uCamPlanet;
  float camR = length(ro);
  float tEnd = min(tHit, uMarch.y);
  // only the air below the cloud deck (above it, the clouds pass owns the light)
  outSub = vec4(0.0, 0.0, 0.0, 1.0);
  if (camR > uMarch.z){ outAdd = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 cb = atmo_raySphere(ro, dir, uMarch.z);
  tEnd = min(tEnd, max(cb.y, 0.0));
  vec2 g = atmo_raySphere(ro, dir, uAtmoRb);
  if (g.x > 0.0) tEnd = min(tEnd, g.x);
  if (tEnd <= 1.0){ outAdd = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float jit = rv_ign(gl_FragCoord.xy + 5.588238 * uFrameJ);
  float nu = dot(dir, uKeyDir);
  float phR = atmo_phaseRayleigh(nu), phM = atmo_phaseMie(nu, uMieG);
  float phH = mix(atmo_phaseHG(nu, uHaze.w), 1.0 / (4.0 * RV_PI), 0.25);
  float phF = atmo_phaseHG(nu, 0.55) * 0.9 + 0.05;
  // sky pixels: the sky LUT used the full-density air; geometry: the art-thinned veil
  float apS = far ? 1.0 : uAPScale;
  float viewK = 1.0 / length(vd);          // view depth per unit ray distance
  // two segments: near (sun shadow map range: trees, buildings, ridges) + far (cloud shadows)
  float tNear = 0.0, nNear = 0.0;
#ifdef HAS_CSM
  if (uCsmP.x > 0.5){ tNear = min(tEnd, uCsmP.y / viewK); nNear = floor(uMarch.x * 0.4); }
#endif
  float nFar = uMarch.x - nNear;
  vec3 add = vec3(0.0), addL = vec3(0.0);
  float sub = 0.0, subL = 0.0;
  vec3 Tv = vec3(1.0);
  float Tr = 1.0, Th = 1.0;
#ifdef HAS_CLOUDS
  float rc0 = uLayer.x;
#else
  float rc0 = 1e30;
#endif
  for (int i = 0; i < 64; i++){
    float fi = float(i);
    if (fi >= uMarch.x) break;
    float ta, tb;
    if (fi < nNear){
      float x0 = fi / nNear, x1 = (fi + 1.0) / nNear;
      ta = tNear * x0 * x0; tb = tNear * x1 * x1;
    } else {
      float x0 = (fi - nNear) / nFar, x1 = (fi - nNear + 1.0) / nFar;
      ta = mix(tNear, tEnd, x0 * x0); tb = mix(tNear, tEnd, x1 * x1);
    }
    float dt = tb - ta;
    if (dt <= 0.0) continue;
    float t = mix(ta, tb, jit);
    vec3 p = ro + dir * t;
    float r = length(p);
    float h = r - uAtmoRb;
    vec3 sR, sM, ext;
    atmo_medium(h, sR, sM, ext);
    sR *= apS; sM *= apS; ext *= apS;
    float muS = dot(p / r, uKeyDir);
    vec3 Ts = atmo_sunTransmittance(r, muS) * uKeyIll;
    float vis = cloudVis(p);
#ifdef HAS_CLOUDS
    // inside the layer only the sun-ward part of the column shadows this parcel
    if (r > rc0) vis = pow(max(vis, 1e-4), 1.0 - clamp((r - rc0) / (uLayer.y - rc0), 0.0, 1.0));
#endif
#ifdef HAS_CSM
    if (fi < nNear) vis *= csmVis(p, t * viewK);
#endif
    float hz = uHaze.x * exp(-max(h - uHaze.z, 0.0) * uHaze.y);
    float fogD = uFogV.x * exp(-clamp(h - uFogV.z, -2.0 * uFogV.y, 1e5) / uFogV.y);
    // shadowed air & fog lose the single scattering the atmosphere pass gave them; lit haze glows
    vec3 dL = vis * hz * phH * Ts * uMarch.w;
    vec3 dS = (1.0 - vis) * ((sR * phR * uSkyGain + sM * phM * uMieGain) * Ts * uMarch.w + fogD * phF * uFogSunV);
    float dSl = dot(dS, vec3(0.2126, 0.7152, 0.0722));
    float sr = 0.0;
#ifdef HAS_CLOUDS
    if (uRain.x > 0.0){
      vec4 wx = cl_weather(p);
      float cover = clamp(wx.r * uShape3.x + uShape3.y + uCoverBoost, 0.0, 1.0);
      // curtains hang under dense / stormy cells and thin out toward the ground (evaporation)
      float cell = smoothstep(0.62, 0.92, cover) * 0.6 + wx.b * uRain.z;
      float fall = 0.55 + 0.45 * smoothstep(0.0, uMarch.z - uAtmoRb, h);
      sr = uRain.x * uRain.y * cell * fall;
      dL += sr * uRainCol;
    }
#endif
    // air between the clouds (inside the layer): hidden behind the clouds in front of it
    float w = dot(Tv, vec3(0.2126, 0.7152, 0.0722)) * Tr * dt;
    if (r > rc0){ addL += Tv * Tr * dL * dt; subL += w * dSl; } else { add += Tv * Tr * dL * dt; sub += w * dSl; }
    Tr *= exp(-sr * dt);
    Th *= exp(-hz * dt);
    Tv *= exp(-(ext + hz + fogD) * dt);
  }
  // clouds in front hide the air behind them; the clouds pass also replaced the sky's in-scatter
  // behind a cloud by its own aerial perspective, so the darkening only applies to what is left
  float Tc = uHasCloudRT > 0.5 ? texture(tCloudRT, vUv).a : 1.0;
  addL *= Tc;
  // rain curtains and the extra haze also dim what lies behind them
  outAdd = vec4(add + addL, Tr * Th);
  outSub = vec4((sub + subL) * Tc, 0.0, 0.0, 1.0);
}`;

const MASK_FRAG = /* glsl */`
#include <rv_common>
#include <rv_atmo_view>
uniform sampler2D tDepth;
uniform sampler2D tClouds;
uniform float uHasClouds;
uniform vec3 uLightDir;
uniform float uKeyLum;     // luminance of the key light illuminance (cloud radiance reference)
varying vec2 vUv;
// Occlusion-based light-scattering source (GPU Gems 3, ch. 13): open sky near the key light AND the
// bright silver-lined cloud edges emit; terrain and dense cloud bodies block. The radial blur toward
// the light turns every gap / ridge / cloud edge into a streak.
void main(){
  float d = texture(tDepth, vUv).r;
  float src = 0.0;
  if (atmo_isFar(d)){
    src = 1.0;
    if (uHasClouds > 0.5){
      vec4 cl = texture(tClouds, vUv);
      // silver lining: cloud radiance relative to the key light (a lit white cloud ≈ 0.3, forward-scattering rims > 1)
      float rim = smoothstep(0.35, 1.6, rv_luma(cl.rgb) / max(uKeyLum, 1e-6)) * (1.0 - cl.a);
      src = cl.a * cl.a + rim * 1.6;
    }
  }
  vec3 dir = normalize(mat3(uCamWorld) * atmo_viewDir(vUv));
  float c = max(dot(dir, uLightDir), 0.0);
  float glow = pow(c, 64.0) + pow(c, 16.0) * 0.25;
  gl_FragColor = vec4(src * glow, 0.0, 0.0, 1.0);
}`;

const BLUR_FRAG = /* glsl */`
#include <rv_common>
uniform sampler2D tSrc;
uniform vec2 uCenter;      // light position in uv
uniform float uLen;        // fraction of the vector to the light covered
varying vec2 vUv;
void main(){
  vec2 dv = (uCenter - vUv) * uLen / 24.0;
  float j = rv_ign(gl_FragCoord.xy);
  vec2 uv = vUv + dv * j;
  float acc = 0.0, w = 1.0, wsum = 0.0;
  for (int i = 0; i < 24; i++){
    acc += texture(tSrc, uv).r * w;
    wsum += w;
    w *= 0.955;
    uv += dv;
  }
  gl_FragColor = vec4(acc / wsum, 0.0, 0.0, 1.0);
}`;

const COMP_FRAG = /* glsl */`
#include <rv_common>
#include <rv_atmo_view>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tRays;
uniform sampler2D tVol;
uniform sampler2D tVolSub;
uniform vec2 uLowRes;
uniform vec3 uColor;
uniform float uHasRays;
uniform vec3 uRayDir;
uniform float uHasVol;
uniform float uDebug;
varying vec2 vUv;
float linDist(vec2 uv){
  float d = texture(tDepth, uv).r;
  if (atmo_isFar(d)) return 1e9;
  return atmo_depthToDist(d, atmo_viewDir(uv));
}
void main(){
  vec3 c = texture(tColor, vUv).rgb;
  if (uHasVol > 0.5){
    // depth-aware 3×3 upsample of the quarter-res volumetric term
    float dz = linDist(vUv);
    vec2 st = vUv * uLowRes - 0.5;
    vec2 i0 = floor(st), f = st - i0;
    vec4 acc = vec4(0.0);
    float sacc = 0.0, wsum = 0.0;
    for (int k = 0; k < 9; k++){
      vec2 o = vec2(float(k % 3) - 0.5, float(k / 3) - 0.5);
      vec2 uv = (i0 + o + 0.5) / uLowRes;
      vec2 dd = abs(o - f);
      float wb = max(0.0, 1.5 - dd.x) * max(0.0, 1.5 - dd.y);
      float z = linDist(uv);
      float w = wb / (1e-3 + abs(log(max(z, 1e-3)) - log(max(dz, 1e-3))) * 10.0);
      acc += texture(tVol, uv) * w;
      sacc += texture(tVolSub, uv).r * w;
      wsum += w;
    }
    vec4 v = wsum > 0.0 ? acc / wsum : vec4(0.0, 0.0, 0.0, 1.0);
    float sub = wsum > 0.0 ? sacc / wsum : 0.0;
    // shadow beams: remove the shadowed in-scatter, hue-preserving (never below 25 %)
    float lc = max(rv_luma(c), 1e-5);
    c *= clamp(1.0 - sub / lc, 0.25, 1.0);
    c = c * v.a + v.rgb;
    if (uDebug > 4.5) c = vec3(rv_luma(v.rgb), sub, 1.0 - v.a) * 4.0;
  }
  if (uHasRays > 0.5){
    // streaks fade with the angle from the light (no full-screen veil from the radial average)
    vec3 dir = normalize(mat3(uCamWorld) * atmo_viewDir(vUv));
    float fa = pow(max(dot(dir, uRayDir), 0.0), 3.0);
    c += uColor * texture(tRays, vUv).r * fa;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

export class LightShafts {
  constructor(atmo) {
    this.atmo = atmo;
    this.name = 'volumetric-light';
    this.order = 120;
    const q = atmo.world.quality;
    this.tier = q.tier;
    this.enabled = !!atmo.model.present && this.tier !== 'low' && Params.num?.('shafts') !== 0;   // &shafts=0: A/B debug
    this.volOn = true;
    this.quad = new FSQuad();
    this.a = hdrTarget(4, 4); this.b = hdrTarget(4, 4);
    this.vol = hdrTarget(4, 4, { count: 2 });
    const m = atmo.model;
    const cl = atmo.clouds?.present ? atmo.clouds : null;
    this.u = {
      tDepth: { value: null }, tClouds: { value: null }, uHasClouds: { value: 0 },
      uLightDir: { value: new THREE.Vector3() }, uKeyLum: { value: 1 },
      uCamWorld: { value: new THREE.Matrix4() }, uProjParams: { value: new THREE.Vector4(1, 1, 0, 0) },
      uNear: { value: 0.05 }, uFar: { value: 2e10 },
    };
    this.vu = {
      ...(cl ? cl.u : {}),
      ...atmo.atmoUniforms,
      tDepth: this.u.tDepth, uCamWorld: this.u.uCamWorld, uProjParams: this.u.uProjParams, uNear: this.u.uNear, uFar: this.u.uFar,
      tShadow: { value: null }, uShadowP: { value: new THREE.Vector4() },
      uShE1: { value: new THREE.Vector3() }, uShE2: { value: new THREE.Vector3() },
      uCamPlanet: { value: new THREE.Vector3() },
      uKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uKeyIll: { value: new THREE.Vector3() },
      uAPScale: atmo.effect?.u?.uAPScale ?? { value: 1 },
      uHaze: { value: new THREE.Vector4(0, 1 / 1500, 0, 0.6) },
      uMarch: { value: new THREE.Vector4(this.tier === 'ultra' ? 48 : this.tier === 'high' ? 36 : 22, 30000, m.Rt, 1) },
      uRain: { value: new THREE.Vector4() },
      uRainCol: { value: new THREE.Vector3() },
    };
    // sun cascaded shadow map (lighting.js RVSunShadow) for near-field shafts
    const sh = atmo.lighting?.key?.castShadow ? atmo.lighting.key.shadow : null;
    this.csm = sh && sh.cascades ? sh : null;
    const defines = {};
    if (cl) defines.HAS_CLOUDS = 1;
    if (this.csm) {
      defines.HAS_CSM = 1; defines.CSM_N = this.csm.cascades;
      Object.assign(this.vu, {
        tSunShadow: { value: null },
        uCsmMat: { value: this.csm._matrices },
        uCsmEnd: { value: new Array(this.csm.cascades).fill(0) },
        uCsmP: { value: new THREE.Vector4(0, 0, 0, 0) },
        uOrigin: { value: atmo.world.origin },
      });
    }
    this.vu.uFogV = { value: new THREE.Vector4(0, 1, 0, 0) };
    this.vu.tCloudRT = { value: null }; this.vu.uHasCloudRT = { value: 0 };
    this.vu.uFogSunV = { value: new THREE.Vector3() };
    this.vu.uFrameJ = { value: 0 };
    this.volMat = fsMaterial(VOL_FRAG, this.vu, { defines, glslVersion: THREE.GLSL3 });
    this.maskMat = fsMaterial(MASK_FRAG, this.u);
    this.blurMat = fsMaterial(BLUR_FRAG, { tSrc: { value: null }, uCenter: { value: new THREE.Vector2() }, uLen: { value: 1 } });
    this.cu = {
      tColor: { value: null }, tDepth: this.u.tDepth, tRays: { value: null }, tVol: { value: null }, tVolSub: { value: null },
      uLowRes: { value: new THREE.Vector2(1, 1) }, uColor: { value: new THREE.Vector3() }, uRayDir: { value: new THREE.Vector3(0, 1, 0) },
      uHasRays: { value: 0 }, uHasVol: { value: 0 }, uDebug: { value: +(Params.num?.('atmoDebug') ?? 0) },
      uCamWorld: this.u.uCamWorld, uProjParams: this.u.uProjParams, uNear: this.u.uNear, uFar: this.u.uFar,
    };
    this.compMat = fsMaterial(COMP_FRAG, this.cu);
    this._v = new THREE.Vector4();
    // world haze → screen-space ray strength
    this.haze = THREE.MathUtils.clamp(0.35 + (m.mieExt.x * m.HM) * 12 + (m.fog || 0) * 0.8 + (m.dust || 0) * 0.8, 0.3, 1.6);
    this.sizeK = THREE.MathUtils.clamp(atmo.world.body.radius / 70000, 0.6, 1.4);
  }

  setSize(w, h) {
    const q = 4;
    const lw = Math.max(1, Math.round(w / q)), lh = Math.max(1, Math.round(h / q));
    this.a.setSize(lw, lh); this.b.setSize(lw, lh); this.vol.setSize(lw, lh);
    this.cu.uLowRes.value.set(lw, lh);
  }

  // ---------------------------------------------------------------- per-frame parameters of the volumetric march
  _updateVol(cam) {
    const atmo = this.atmo, vu = this.vu, W = atmo.weather, m = atmo.model;
    const L = atmo.lighting;
    const cl = atmo.clouds?.present ? atmo.clouds : null;
    vu.uCamPlanet.value.setFromMatrixPosition(cam.matrixWorld).add(atmo.world.origin);
    const camR = vu.uCamPlanet.value.length();
    // key light (sun by day, moon at night) at the top of the atmosphere
    const E = m.sunIlluminance, sc = atmo.starColor;
    const kd = L.uniforms.uKeyDir.value;
    vu.uKeyDir.value.copy(kd);
    if (L.keyIsMoon) { const mi = (L.moon.ill || 0) * E; vu.uKeyIll.value.set(0.62 * mi, 0.72 * mi, mi); }
    else vu.uKeyIll.value.set(sc.r * E, sc.g * E, sc.b * E).multiplyScalar(Math.max(0.15, W.sunDim ?? 1));
    // cloud shadow map (clouds.js)
    const LU = L.uniforms;
    const shOn = cl && LU.rvCloudShadowParams.value.x > 0.5 && cl.shadowRT;
    vu.uShadowP.value.set(shOn ? 1 : 0, cl ? cl.shadowU.uSize.value : 1, 0, 0);
    vu.tShadow.value = shOn ? cl.shadowRT.texture : null;
    if (cl) { vu.uShE1.value.copy(cl.shadowU.uE1.value); vu.uShE2.value.copy(cl.shadowU.uE2.value); }
    // extra haze (weather / art): fog, dust, rain; a whisper on clear days
    const fog = W.fog || 0, dust = W.dust || 0, rain = Math.max(W.rain || 0, W.snow || 0);
    const upv = _up.copy(vu.uCamPlanet.value).normalize();
    const lowSun = 1 + 0.8 * (1 - THREE.MathUtils.smoothstep(upv.dot(kd), 0.08, 0.45));
    // shafts need something lit to contrast with: more haze when the deck is broken (many shadows)
    const broken = cl ? THREE.MathUtils.clamp(cl.meanCover + (W.coverBoost || 0), 0, 1) : 0;
    // (kept thin: a thick glowing veil washes out the image; the beams come from the shadowed in-scatter)
    const hz = (0.03 + Math.max(fog - 0.3, 0) * 1.2 + dust * 3.0 + rain * 1.0 + (m.moody || 0) * 0.6 + broken * 0.08) * lowSun * 1e-5 / this.sizeK;
    const sea = Math.max(0, atmo.world.surface?.seaLevel ?? 0);
    const Hh = THREE.MathUtils.lerp(900, 2200, THREE.MathUtils.clamp(dust + rain * 0.5, 0, 1)) * this.sizeK;
    vu.uHaze.value.set(hz, 1 / Hh, sea, 0.45 + 0.15 * (1 - dust));
    // height fog of the atmosphere pass (weather) — its sunlit part is gated by the shadows too
    const ef = atmo.effect?.u;
    if (ef) { vu.uFogV.value.copy(ef.uFog.value); vu.uFogSunV.value.copy(ef.uFogSun.value).multiplyScalar(ef.uFogAlbedo.value.y); }
    // sun cascades
    let csmOn = false;
    // the sampler2DShadow must always be bound to a depth texture (even when unused, e.g. moon as key light):
    // any other texture is a GL_INVALID_OPERATION that silently drops the draw
    const dtex0 = this.csm?.map?.depthTexture;
    if (this.csm) { if (dtex0) vu.tSunShadow.value = dtex0; else if (!vu.tSunShadow.value) return false; }
    if (this.csm && !L.keyIsMoon) {
      const dtex = dtex0;
      if (dtex) {
        csmOn = true;
        vu.tSunShadow.value = dtex;
        const cd = this.csm._cascadeData, ends = vu.uCsmEnd.value;
        for (let i = 0; i < ends.length; i++) ends[i] = cd[i].y;
        vu.uCsmP.value.set(1, ends[ends.length - 1], this.csm.bias || 0, 0);
      }
    }
    if (this.csm) { vu.uCsmP.value.x = csmOn ? 1 : 0; vu.uOrigin.value = atmo.world.origin; }
    // march up to the cloud tops (shafts between the puffs), clouds in front hide what is behind
    const base = cl ? cl.Rc1 : m.Rb + m.height * 0.6;
    vu.uHasCloudRT.value = cl && cl.lowRT ? 1 : 0;
    vu.tCloudRT.value = cl ? cl.lowRT.texture : null;
    vu.uMarch.value.y = (cl ? 26000 : 18000) * this.sizeK;
    vu.uMarch.value.z = base;
    vu.uMarch.value.w = 1.0;
    // rain curtains: under dense / stormy cells
    const rainAmt = cl ? Math.max(W.rain || 0, (W.snow || 0) * 0.6) : 0;
    vu.uRain.value.set(rainAmt, 1.6e-4 / this.sizeK, 0.8 + (W.storm || 0), 0);
    const amb = atmo.lighting.skyIrr, sd = Math.max(0.1, W.sunDim ?? 1);
    const na = atmo.nightAmbient;
    // grey curtain radiance: diffuse light under the deck (sky irradiance / π, dimmed by the overcast)
    vu.uRainCol.value.set((amb[0] + na.r * 0.1) / Math.PI, (amb[1] + na.g * 0.1) / Math.PI, (amb[2] + na.b * 0.1) / Math.PI).multiplyScalar(0.55 * sd + 0.15);
    const lum = vu.uRainCol.value.x * 0.2126 + vu.uRainCol.value.y * 0.7152 + vu.uRainCol.value.z * 0.0722;
    vu.uRainCol.value.lerp(_v3.set(lum, lum * 1.02, lum * 1.06), 0.6);
    return camR < base && (shOn || csmOn || hz > 0 || rainAmt > 0.02);
  }

  render(renderer, io) {
    const atmo = this.atmo;
    const cam = io.camera;
    const L = atmo.lighting;
    const keyDir = L.uniforms.uKeyDir.value;
    const u = this.u, p = cam.projectionMatrix.elements;
    u.uCamWorld.value.copy(cam.matrixWorld);
    u.uProjParams.value.set(p[0], p[5], p[8], p[9]);
    u.uNear.value = cam.near; u.uFar.value = cam.far;
    u.tDepth.value = io.depth;
    if (this.a.width < 2 && io.input) this.setSize(io.input.width, io.input.height);

    // ---- 1. volumetric march
    let hasVol = false;
    if (this.volOn) {
      try { hasVol = this._updateVol(cam); } catch (e) { hasVol = false; }
      if (hasVol) { this.vu.uFrameJ.value = this._rf = ((this._rf || 0) + 1) % 64; this.quad.render(renderer, this.volMat, this.vol); }
    }

    // ---- 2. screen-space streaks around the key light
    let hasRays = false;
    const v = this._v.set(keyDir.x, keyDir.y, keyDir.z, 0);
    v.applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    let sx = 0.5, sy = 0.5, strength = 0;
    const kc = L.uniforms.uKeyColor.value;
    if (v.w > 1e-4) {
      sx = v.x / v.w * 0.5 + 0.5; sy = v.y / v.w * 0.5 + 0.5;
      const off = Math.max(0, Math.max(Math.abs(sx - 0.5), Math.abs(sy - 0.5)) - 0.5);
      const onScreen = 1 - THREE.MathUtils.smoothstep(off, 0.0, 0.45);
      const W = atmo.weather;
      const up = _up.setFromMatrixPosition(cam.matrixWorld).add(atmo.world.origin).normalize();
      const elev = up.dot(keyDir);
      this._elev = elev;
      const lowSun = 0.55 + 0.9 * (1 - THREE.MathUtils.smoothstep(elev, 0.05, 0.6));
      strength = onScreen * this.haze * lowSun * (1 + (W.fog || 0) * 0.8 + (W.dust || 0)) * THREE.MathUtils.smoothstep(elev, -0.06, 0.03) * (L.keyIsMoon ? 0.35 : 1);
      hasRays = strength >= 0.01 && kc.r + kc.g + kc.b > 1e-4;
    }
    if (hasRays) {
      u.uLightDir.value.copy(keyDir);
      u.uKeyLum.value = Math.max(1e-6, kc.r * 0.2126 + kc.g * 0.7152 + kc.b * 0.0722);
      const cl = atmo.clouds;
      const hasCl = cl?.present && cl.lowRT;
      u.uHasClouds.value = hasCl ? 1 : 0;
      u.tClouds.value = hasCl ? cl.lowRT.texture : null;
      this.quad.render(renderer, this.maskMat, this.a);
      const bm = this.blurMat.uniforms;
      bm.uCenter.value.set(sx, sy);
      // three radial passes (24 taps each → ~13k effective samples): long streaks without banding
      bm.tSrc.value = this.a.texture; bm.uLen.value = 1.0;
      this.quad.render(renderer, this.blurMat, this.b);
      bm.tSrc.value = this.b.texture; bm.uLen.value = 0.4;
      this.quad.render(renderer, this.blurMat, this.a);
      bm.tSrc.value = this.a.texture; bm.uLen.value = 0.14;
      this.quad.render(renderer, this.blurMat, this.b);
    }
    if (!hasVol && !hasRays) { io.skip = true; return; }
    const cu = this.cu;
    cu.tColor.value = io.input.texture;
    cu.tRays.value = this.b.texture;
    cu.tVol.value = this.vol.textures[0];
    cu.tVolSub.value = this.vol.textures[1];
    cu.uHasRays.value = hasRays ? 1 : 0;
    cu.uHasVol.value = hasVol ? 1 : 0;
    // golden hour: a warm, generous glow of streaks (the reddened sun is dim, the scene is backlit);
    // high sun: subtle streaks only (a bright veil would wash out the contrast)
    const gold = 1 - THREE.MathUtils.smoothstep(this._elev ?? 1, 0.02, 0.3);
    cu.uColor.value.set(kc.r, kc.g, kc.b).multiplyScalar(strength * (0.12 + 0.22 * gold));
    cu.uRayDir.value.copy(keyDir);
    this.quad.render(renderer, this.compMat, io.output);
  }

  dispose() {
    this.a.dispose(); this.b.dispose(); this.vol.dispose();
    this.volMat.dispose(); this.maskMat.dispose(); this.blurMat.dispose(); this.compMat.dispose();
    this.quad.dispose();
  }
}

const _up = new THREE.Vector3(), _v3 = new THREE.Vector3();
