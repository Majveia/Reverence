// GLSL for the ocean surface (all liquids) — see index.js for the rendering scheme.
//
// Vertex: a camera-centred polar grid laid directly on the sea sphere (rings exponentially spaced from
// the nadir to past the horizon), displaced by the Gerstner set with per-vertex wavelength filtering.
// Fragment: analytic Gerstner normals (pixel-footprint filtered, lost variance → roughness) + 3 layers of
// FFT-spectrum detail normals, GGX sun/moon glint, Fresnel sky reflection (atmosphere env cube) + screen-
// space reflections, refraction of the opaque scene with depth-based Beer–Lambert absorption, in-scatter,
// subsurface crest glow, crest / shore foam with surf lines, seabed caustics, soft shoreline edge.
// Seen from below: Snell's window + total internal reflection.
import { registerChunk } from '../../shaders/chunks.js';
import { SLOPE_RANGE } from './textures.js';

registerChunk('rv_water_common', /* glsl */ `
#ifndef RV_WATER_COMMON
#define RV_WATER_COMMON
uniform vec3 uUp, uE1, uE2, uT1, uT2, uPC;
uniform float uRs, uCamH, uCrestA, uJit;
uniform vec4 uGrid;                 // dMin, dMax, ring count, spacing factor
uniform vec4 uWA[NW];               // dir.x, dir.y, k, A (amp applied)
uniform vec4 uWB[NW];               // Q, phase at nadir, wavelength, unused
uniform float uTime;
uniform sampler2D tBathy;           // water depth (m) around the camera (worker-built, half float)
uniform vec4 uBathy;                // xy: qN − qCentre, z: 1/(2L), w: valid
uniform vec4 uShore;                // x: swell amplitude, y: k per metre of depth, z: omega, w: band depth
uniform float uBathyE;              // bathymetry texel (m)
uniform vec2 uQN;                   // nadir wave coordinate mod 4096 m (texture layers)
uniform vec2 uQF;                   // nadir wave coordinate mod 245760 m (far layers, tiles dividing it)
const mat2 ROT1 = mat2(0.8253, 0.5646, -0.5646, 0.8253);   // +0.6 rad
const mat2 ROT2 = mat2(0.4536, -0.8912, 0.8912, 0.4536);   // -1.1 rad
const mat2 ROT3 = mat2(-0.5885, 0.8085, -0.8085, -0.5885); // +2.2 rad
// texture layer coordinate: tile size S (m), drift velocity vel (m/s) in the layer frame
vec2 lay(vec2 q, float S, vec2 vel){ return (q + uQN) / S - vel * (uTime / S); }
vec2 layR(mat2 R, vec2 q, float S, vec2 vel){ return (R * (q + uQN)) / S - vel * (uTime / S); }
// depth below the surface (m, <0 on land) and a border fade
vec2 bathy(vec2 q){
  vec2 uv = (q + uBathy.xy) * uBathy.z + 0.5;
  vec2 e = min(uv, 1.0 - uv);
  float f = uBathy.w * smoothstep(0.0, 0.06, min(e.x, e.y));
  if (f <= 0.0) return vec2(1e3, 0.0);
  return vec2(textureLod(tBathy, clamp(uv, 0.0, 1.0), 0.0).r, f);
}
#endif
`);

export const OCEAN_VERT = /* glsl */ `
#include <rv_water_common>
uniform sampler2D tWaves, tCrust;
attribute vec2 grid;                // ring index, azimuth (rad)
varying vec3 vPos;                  // scene-space position (displaced)
varying vec2 vQ;                    // wave-frame coordinate relative to the nadir (undisplaced)
varying float vFold;                // Gerstner Jacobian (1 = flat, <0.4 folding crest)
varying float vH;                   // wave height (m)
varying vec3 vView;                 // view-space position
void main(){
  float i = grid.x;
  float d = i < 0.5 ? 0.0 : uGrid.x * pow(uGrid.y / uGrid.x, (i - 1.0) / max(uGrid.z - 2.0, 1.0));
  float th = d / uRs;
  vec3 dirOff = cos(grid.y) * uE1 + sin(grid.y) * uE2;
  float s = sin(th), h2 = sin(0.5 * th);
  vec3 rel = uRs * (s * dirOff - 2.0 * h2 * h2 * uUp);
  vec3 n = normalize(uUp * cos(th) + dirOff * s);
  vec2 q = vec2(dot(rel, uT1), dot(rel, uT2));
  // vertex spacing (m) around this ring: radial step of the exponential ring distribution
  float spacing = max(d, uGrid.x) * uGrid.w + 0.05;
  float hs = 0.0, fold = 1.0;
  vec2 hor = vec2(0.0);
  vec2 bd = bathy(q);
  float damp = mix(1.0, smoothstep(-0.2, 3.0, bd.x), bd.y);          // open-sea waves die in the shallows
  for (int k = 0; k < NW; k++){
    vec4 a = uWA[k]; vec4 b = uWB[k];
    float f = 1.0 - smoothstep(b.z * 0.09, b.z * 0.3, spacing);
    float A = a.w * f * damp;
    float ph = a.z * dot(a.xy, q) + b.y;
    float S = sin(ph), C = cos(ph);
    hor += a.xy * (b.x * A * C);
    hs += A * S;
    fold -= b.x * a.z * A * S;
  }
  // shore swell: crests follow the depth contours and roll toward the beach, steepening as they shoal
  float band = (1.0 - smoothstep(uShore.w * 0.45, uShore.w, bd.x)) * smoothstep(-0.4, 0.6, bd.x) * bd.y;
  if (band > 0.001 && spacing < 6.0){
    float e = uBathyE;
    vec2 g = vec2(bathy(q + vec2(e, 0.0)).x - bd.x, bathy(q + vec2(0.0, e)).x - bd.x) / e;
    vec2 sd = -g / max(length(g), 1e-4);
    float var = textureLod(tWaves, lay(q, 90.0, vec2(0.0, 0.4)), 3.0).a;
    float ph = uShore.y * bd.x + uShore.z * uTime;
    float pr = pow(0.5 + 0.5 * sin(ph), 3.0);
    float A = uShore.x * band * (0.45 + 0.9 * var) * (1.0 - smoothstep(2.0, 6.0, spacing));
    hs += A * (pr - 0.18);
    hor += sd * (A * 0.8 * pr);
    fold -= A * pr * 0.6;
  }
#ifdef LIQUID_ICE
  // frozen sea: pressure ridges along the big plate boundaries + wind-packed snow drifts
  {
    float fr = 1.0 - smoothstep(1.5, 5.0, spacing);
    if (fr > 0.0){
      vec4 cr = textureLod(tCrust, lay(q, 83.0, vec2(0.0)), 0.0);
      float nz = textureLod(tWaves, lay(q, 29.0, vec2(0.0)), 0.0).a;
      float ridge = (1.0 - smoothstep(0.0, 0.07, cr.r)) * (0.35 + 1.3 * nz * nz);
      float drift = smoothstep(0.45, 0.7, textureLod(tWaves, lay(q, 170.0, vec2(0.0)), 1.0).a) * 0.25;
      hs += (ridge * 0.9 + drift) * fr;
    }
  }
#endif
  vec3 t1 = normalize(uT1 - n * dot(uT1, n));
  vec3 t2 = cross(n, t1);
  vec3 P = (cameraPosition - uUp * uCamH) + rel + n * hs + t1 * hor.x + t2 * hor.y;
  vPos = P; vQ = q; vFold = fold; vH = hs;
  vec4 mv = viewMatrix * vec4(P, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const OCEAN_FRAG = /* glsl */ `
#include <rv_common>
#include <rv_color>
#include <rv_water_common>
#include <rv_cloudshadow>
#define SLOPE_RANGE ${SLOPE_RANGE.toFixed(3)}
uniform sampler2D tWaves, tFoam, tCrust;
uniform sampler2D tSceneColor, tSceneDepth;
uniform float uHasScene;
uniform vec2 uInvRes;
uniform vec2 uNearFar;
uniform samplerCube tEnv;
uniform float uHasEnv;
uniform vec3 uKeyDir, uKeyColor, uAmbSky, uAmbGround;
uniform vec3 uSigma, uScatter, uShallow, uSSS, uGlow;
uniform vec4 uLook;                 // x roughness base, y foam amount, z refraction strength, w detail amp
uniform vec4 uLook2;                // x ssr (0/1), y shore foam, z caustics, w wind 0..1
uniform float uNight, uWet;
uniform float uDebug;
uniform mat4 uProj;                 // camera projection (for SSR)
varying vec3 vPos;
varying vec2 vQ;
varying float vFold;
varying float vH;
varying vec3 vView;


float sceneDistAt(vec2 uv, float cosF){
  float d = texture2D(tSceneDepth, uv).r;
#ifdef USE_REVERSED_DEPTH_BUFFER
  if (d <= 0.0) return 1e9;
#else
  if (d >= 1.0) return 1e9;
#endif
  return rv_viewZFromDepth(d, uNearFar.x, uNearFar.y) / max(cosF, 1e-3);
}

vec3 envSky(vec3 R){
  if (uHasEnv > 0.5) return textureCube(tEnv, R).rgb;
  float h = clamp(R.y, 0.0, 1.0);
  return mix(uAmbSky * 0.45, uAmbSky * 0.2, h) / RV_PI;
}

float ggx(float NdH, float a){
  float a2 = a * a;
  float d = NdH * NdH * (a2 - 1.0) + 1.0;
  return a2 / (RV_PI * d * d + 1e-7);
}
float smithVis(float NdL, float NdV, float a){
  float a2 = a * a;
  float gv = NdL * sqrt(NdV * NdV * (1.0 - a2) + a2);
  float gl = NdV * sqrt(NdL * NdL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

// Screen-space reflection: geometric march in view space against the pre-water depth + binary refinement
vec4 ssr(vec3 posV, vec3 dirV, vec3 posW, vec3 dirW){
  float t = 0.5 + 0.03 * length(posV);
  float tPrev = 0.0;
  float jitter = fract(rv_ign(gl_FragCoord.xy + 5.588 * floor(uJit * 64.0)) + uJit);
  for (int s = 0; s < 22; s++){
    float tj = t * (1.0 + 0.12 * jitter);
    vec3 p = posV + dirV * tj;
    vec4 c = uProj * vec4(p, 1.0);
    if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    if (length(posW + dirW * tj - uPC) < uRs - 1.0) break;          // went under the sea
    float sd = sceneDistAt(uv, -normalize(p).z);
    float rd = length(p);
    if (sd < rd){
      // passed behind an object between two steps: still its colour (big landforms), a bit less confident
      float conf = rd - sd > (tj - tPrev) * 1.6 + 2.0 ? 0.75 : 1.0;
      // refine between tPrev and tj
      float a = tPrev, b = tj;
      for (int r = 0; r < 5; r++){
        float m = 0.5 * (a + b);
        vec3 pm = posV + dirV * m;
        vec4 cm = uProj * vec4(pm, 1.0);
        vec2 um = cm.xy / cm.w * 0.5 + 0.5;
        if (sceneDistAt(um, -normalize(pm).z) < length(pm)) { b = m; uv = um; } else a = m;
      }
      vec2 e = min(uv, 1.0 - uv);
      float fade = smoothstep(0.0, 0.06, min(e.x, e.y)) * (1.0 - smoothstep(0.75, 1.0, float(s) / 22.0));
      return vec4(texture2D(tSceneColor, uv).rgb, fade * conf);
    }
    tPrev = tj;
    t *= 1.38;
  }
  return vec4(0.0);
}

void main(){
  if (uDebug > 4.5){ gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
  vec3 camV = cameraPosition - vPos;
  float wDist = length(camV);
  vec3 V = camV / wDist;
  vec3 nS = normalize(vPos - uPC);
  bool below = dot(camV, nS) < 0.0 && uCamH < 0.5;
  vec3 t1 = normalize(uT1 - nS * dot(uT1, nS));
  vec3 t2 = cross(nS, t1);
  vec3 L = normalize(uKeyDir);
  float sunUp = dot(nS, L);

  // ------------------------------------------------ normals (analytic Gerstner + detail maps)
  vec2 fq = fwidth(vQ);
  float fp = max(max(fq.x, fq.y), 1e-4);               // meters per pixel
  // gusts: calm / rough patches drifting down-wind at 0.4–4 km scales (cat's paws up close, slicks and
  // streaks in the sun path from altitude). 0 = calm, 1 = rough.
  float gA = texture2D(tWaves, lay(vQ, 1530.0, vec2(4.0, 0.5))).a;
  float gB = texture2D(tWaves, layR(ROT1, vQ, 437.0, vec2(2.6, -0.3))).a;
  float gC = texture2D(tWaves, layR(ROT2, vQ, 4096.0, vec2(3.0, 0.4))).a;
  float gust = smoothstep(-1.15, 1.15, ((gA - 0.5) * 0.8 + (gB - 0.5) * 0.45 + (gC - 0.5) * 0.7) / 0.18);
  float gk = mix(0.28, 1.3, gust);
  float sx = 0.0, sy = 0.0, ny = 0.0, varS = 0.0;
  vec2 bd = bathy(vQ);
  float damp = mix(1.0, smoothstep(-0.2, 3.0, bd.x), bd.y);
  for (int k = 0; k < NW; k++){
    vec4 a = uWA[k]; vec4 b = uWB[k];
    float f = smoothstep(1.5, 5.0, b.z / fp);
    float wa = a.z * a.w * damp * mix(1.0, gk, b.w);
    float ph = a.z * dot(a.xy, vQ) + b.y;
    float S = sin(ph), C = cos(ph);
    sx += a.x * wa * C * f; sy += a.y * wa * C * f;
    ny += b.x * wa * S * f;
    varS += 0.5 * wa * wa * (1.0 - f);
  }
  // shore swell slopes (same function as the vertex stage, per pixel)
  float swellPr = 0.0, swellA = 0.0, swellVar = 0.5;
  float band = (1.0 - smoothstep(uShore.w * 0.45, uShore.w, bd.x)) * smoothstep(-0.4, 0.6, bd.x) * bd.y;
  if (band > 0.001){
    float e = uBathyE;
    vec2 g = vec2(bathy(vQ + vec2(e, 0.0)).x - bd.x, bathy(vQ + vec2(0.0, e)).x - bd.x) / e;
    float var = textureLod(tWaves, lay(vQ, 90.0, vec2(0.0, 0.4)), 3.0).a;
    float ph = uShore.y * bd.x + uShore.z * uTime;
    float sn = 0.5 + 0.5 * sin(ph);
    swellPr = sn * sn * sn;
    swellA = uShore.x * band * (0.45 + 0.9 * var);
    swellVar = var;
    vec2 dh = g * (swellA * 3.0 * sn * sn * 0.5 * cos(ph) * uShore.y);
    sx += dh.x; sy += dh.y;
  }
  float dAmp = uLook.w * mix(0.35, 1.0, damp) * mix(0.5, 1.2, gust);
  // four FFT-spectrum layers (157 / 41 / 13.7 / 4.3 m tiles, rotated, drifting). A layer fades out before its
  // tile shrinks to a few dozen pixels (no visible repetition lattice); its slopes then live on as roughness.
  vec2 uv3 = layR(ROT3, vQ, 157.0, vec2(2.1, 0.2));
  vec2 uv0 = lay(vQ, 41.0, vec2(1.3, 0.0));
  vec2 uv1 = layR(ROT1, vQ, 13.7, vec2(0.9, 0.1));
  vec2 uv2 = layR(ROT2, vQ, 4.3, vec2(0.55, 0.0));
  float v3 = smoothstep(10.0, 40.0, 157.0 / fp), v0 = smoothstep(10.0, 40.0, 41.0 / fp);
  float v1 = smoothstep(10.0, 40.0, 13.7 / fp), v2 = smoothstep(10.0, 40.0, 4.3 / fp);
  vec4 w0 = texture2D(tWaves, uv0);
  vec4 w1 = texture2D(tWaves, uv1);
  vec4 w3 = texture2D(tWaves, uv3);
  vec2 d3 = ((w3.rg * 2.0 - 1.0) * SLOPE_RANGE * 0.22) * ROT3 * v3;
  vec2 d0 = (w0.rg * 2.0 - 1.0) * SLOPE_RANGE * 0.32 * v0;
  vec2 d1 = ((w1.rg * 2.0 - 1.0) * SLOPE_RANGE * 0.26) * ROT1 * v1;
  vec2 d2 = vec2(0.0);
  if (v2 > 0.0){
    vec4 w2 = texture2D(tWaves, uv2);
    d2 = ((w2.rg * 2.0 - 1.0) * SLOPE_RANGE * 0.22) * ROT2 * v2;
  }
  // variance lost to mip filtering (texel = tile/256) or to the fade → roughness
  float lod0 = fp / (41.0 / 256.0), lod1 = fp / (13.7 / 256.0), lod2 = fp / (4.3 / 256.0), lod3 = fp / (157.0 / 256.0);
  varS += dAmp * dAmp * 0.048 * (
      0.30 * (1.0 - v0 * (1.0 - smoothstep(0.7, 12.0, lod0)))
    + 0.18 * (1.0 - v1 * (1.0 - smoothstep(0.7, 12.0, lod1)))
    + 0.13 * (1.0 - v2 * (1.0 - smoothstep(0.7, 12.0, lod2)))
    + 0.16 * (1.0 - v3 * (1.0 - smoothstep(0.7, 12.0, lod3))));
  vec2 det = (d0 + d1 + d2 + d3) * dAmp;
  // kilometre-scale swell trains (0.7 / 2.4 km tiles, stretched across the wind so crests run in long lines):
  // what is left of the sea's relief when seen from altitude — streaks and bands in the sun path and the sky
  // reflection. Only far from the camera (close by, the Gerstner swell carries these scales geometrically).
  float vA = smoothstep(8.0, 30.0, 700.0 / fp) * smoothstep(250.0, 1400.0, wDist);
  float vB = smoothstep(8.0, 30.0, 2400.0 / fp) * smoothstep(1500.0, 6000.0, wDist);
  if (vA + vB > 0.001){
    vec2 qa4 = vQ + uQF;
    vec2 wa4 = texture2D(tWaves, (qa4 * vec2(1.0, 0.34) - vec2(5.0, 0.0) * uTime) / 682.667).rg * 2.0 - 1.0;
    vec2 wb4 = texture2D(tWaves, (qa4 * vec2(0.4, 1.0) - vec2(0.0, 7.0) * uTime).yx / 2457.6).rg * 2.0 - 1.0;
    det += (wa4 * vec2(1.0, 0.34) * vA * 0.3 + wb4.yx * vec2(0.4, 1.0) * vB * 0.22) * SLOPE_RANGE * mix(0.55, 1.3, gust) * uLook.w;
  }
  sx += det.x; sy += det.y;
  // rain: expanding drop rings near the camera, a dimpled (rougher) surface further out
  if (uWet > 0.02){
    float rf = (1.0 - smoothstep(12.0, 45.0, wDist)) * (1.0 - smoothstep(0.02, 0.06, fp));
    if (rf > 0.0){
      vec2 rr = vec2(0.0);
      for (int l = 0; l < 2; l++){
        float S = l == 0 ? 0.85 : 0.53;
        vec2 p = (vQ + uQN) / S + float(l) * 3.7;
        vec2 c = mod(floor(p), 512.0);
        vec2 o = vec2(rv_hash12(c + 3.1), rv_hash12(c + 7.7)) - 0.5;
        vec2 dd = fract(p) - 0.5 - o * 0.5;
        float r = length(dd);
        float ph = fract(uTime * (0.7 + 0.2 * float(l)) + rv_hash12(c + float(l) * 17.0));
        float ring = r - ph * 0.55;
        float env = exp(-ring * ring * 300.0) * (1.0 - ph) * (1.0 - ph) * step(rv_hash12(c + 1.3), uWet);
        rr += dd / max(r, 1e-3) * cos(ring * 70.0) * env;
      }
      sx += rr.x * 0.35 * rf; sy += rr.y * 0.35 * rf;
    }
    varS += uWet * 0.006;
  }
  vec3 N = normalize(nS * max(1.0 - ny, 0.2) - t1 * sx - t2 * sy);
  // far away: blend to the smooth sphere (all detail is roughness by then)
  float farF = smoothstep(4000.0, 60000.0, wDist);
  N = normalize(mix(N, nS, farF));
  float alpha = clamp(sqrt(uLook.x * uLook.x + 2.0 * varS), 0.02, 0.6);
  // seen from far away the gust patches are what is left of the waves: mirror-calm vs. matte-rough
  float slF = smoothstep(150.0, 1500.0, wDist);
  alpha *= mix(1.0, mix(0.4, 1.7, gust), slF);
  // orbit: glint as broad as the sea state, mottled by the km-scale roughness patches
  // plus wind-streaked 20 / 61 km roughness bands (slicks and rough lanes stretched along the wind): the
  // glint seen from orbit is mottled and streaky, not a smooth blob
  float gO = 0.5, gO2 = 0.5;
  if (farF > 0.0){
    vec2 qf = vQ + uQF;
    gO = texture2D(tWaves, (qf * vec2(0.45, 1.0)) / 20480.0).a;
    gO2 = texture2D(tWaves, (qf * vec2(0.3, 1.0)) / 61440.0 + 0.37).a;
  }
  float oR = (0.8 + 1.6 * (gO - 0.5)) * (0.75 + 1.4 * (gO2 - 0.5));
  alpha = mix(alpha, clamp(mix(0.09, 0.24, gust) * oR, 0.045, 0.34), farF);

  // ------------------------------------------------ scene behind the surface
  vec2 suv = gl_FragCoord.xy * uInvRes;
  vec3 rayV = normalize(vView);
  float cosF = -rayV.z;
  float sDist = uHasScene > 0.5 ? sceneDistAt(suv, cosF) : 1e9;
  float thick = max(sDist - wDist, 0.0);

  // fold / crest measures
  float fold = vFold - w0.b * 0.35 * dAmp * v0 - w1.b * 0.2 * dAmp * v1 - w3.b * 0.25 * dAmp * v3;
  float crest = clamp(vH / max(uCrestA * 2.2, 0.05) * 0.5 + 0.5, 0.0, 1.0);

  vec3 col;
  float cloud = rv_cloudShadow(vPos);
  float sunVis = smoothstep(-0.02, 0.06, sunUp) * cloud;
  vec3 Esun = uKeyColor * sunVis;
  vec3 Eamb = uAmbSky;

#if defined(LIQUID_LAVA)
  {
  // ================================================= LAVA: basalt crust rafts on an incandescent, convecting melt
  // heat 0..1 → emitted radiance (dull red → orange → yellow-white, ~T^4 brightness)
  #define LAVA_RAMP(t) (mix(mix(vec3(0.4, 0.012, 0.0), vec3(1.0, 0.11, 0.006), smoothstep(0.0, 0.5, t)), vec3(1.0, 0.4, 0.07), smoothstep(0.5, 1.0, t)) * (0.03 + 3.4 * t * t * t))
  // flow: the melt drifts down-slope/down-wind (wave-frame +x) with a slowly meandering direction
  vec2 fw = texture2D(tWaves, lay(vQ, 740.0, vec2(0.0))).rg - 0.5;
  vec2 flowV = vec2(0.34, 0.08) + fw * 0.5;                    // m/s, spatially varying (melt)
  vec2 raftV = vec2(0.24, 0.06);                               // rafts drift as rigid plates
  vec2 warp = (texture2D(tWaves, lay(vQ, 90.0, vec2(0.35, 0.1))).rg - 0.5) * 0.22;
  // activity: large regions of open, churning melt vs. solid crust fields (slowly drifting)
  float act0 = texture2D(tWaves, lay(vQ, 610.0, raftV * 0.5)).a;
  float act1 = texture2D(tWaves, layR(ROT2, vQ, 230.0, raftV)).a;
  float actN = act0 * 0.65 + act1 * 0.55 - 0.1;
  float act = smoothstep(0.36, 0.6, actN);
  vec4 cM = texture2D(tCrust, layR(ROT2, vQ, 260.0, raftV * 0.6) + warp * 0.3);   // mega plates (~29 m)
  vec4 c0 = texture2D(tCrust, lay(vQ, 55.0, raftV) + warp);                     // rafts (~6 m)
  vec4 c1 = texture2D(tCrust, layR(ROT1, vQ, 16.4, raftV * 0.5) + warp * 0.5);  // fine fissures
  // pixel footprint relative to the crack widths → fade fine structure to its average (no shimmer)
  float fr0 = smoothstep(0.012, 0.05, fp / 55.0), fr1 = smoothstep(0.012, 0.05, fp / 16.4);
  // gaps between rafts widen where the melt is active: the crust breaks into drifting islands, then opens
  float gapW = mix(0.035, 0.8, act * act);
  float gap = 1.0 - smoothstep(gapW * 0.55, gapW, c0.r + (c1.a - 0.5) * 0.08);
  gap = mix(gap, min(gapW * 1.6, 1.0), fr0);
  float megaCrack = 1.0 - smoothstep(0.015, 0.06 + 0.14 * act, cM.r);
  float fis = (1.0 - smoothstep(0.01, 0.04, c1.b)) * (1.0 - fr1) + 0.06 * fr1;
  float molten = max(gap, megaCrack);
  // melt surface: convection cells + streaks stretched along the flow, advected with a two-phase flow map
  // (seamless, never a static texture)
  float fT = 7.0;
  float ph0 = fract(uTime / fT), ph1 = fract(uTime / fT + 0.5);
  float wB = abs(ph0 * 2.0 - 1.0);
  vec2 qa = vQ - flowV * (ph0 * fT), qb = vQ - flowV * (ph1 * fT) + vec2(13.1, 7.7);
  vec2 wa2 = warp * 40.0;
  float conv = mix(texture2D(tWaves, layR(ROT1, qa + wa2, 37.0, vec2(0.0))).a, texture2D(tWaves, layR(ROT1, qb + wa2, 37.0, vec2(0.0))).a, wB);
  vec2 sa = (qa + warp * 25.0) * vec2(0.3, 1.0), sb = (qb + warp * 25.0) * vec2(0.3, 1.0);
  float strk = mix(texture2D(tWaves, lay(sa, 16.0, vec2(0.0))).a, texture2D(tWaves, lay(sb, 16.0, vec2(0.0))).a, wB);
  float strk2 = mix(texture2D(tFoam, lay(sa * 1.3, 9.0, vec2(0.0))).a, texture2D(tFoam, lay(sb * 1.3, 9.0, vec2(0.0))).a, wB);
  float fstr = 1.0 - smoothstep(0.02, 0.12, fp / 9.0);         // fine streak detail only where resolved
  // breathing: the melt glows up and dims in slow, region-wide pulses (pressure from below)
  float breath = 0.5 + 0.5 * sin(uTime * 0.55 + act0 * 40.0 + act1 * 17.0);
  // far away the (tiling) convection / streak layers would line up into regular bands: fade them to their mean
  // and let the non-repeating activity fields carry the variation
  float fConv = 1.0 - smoothstep(0.012, 0.05, fp / 37.0);
  float fStrk = 1.0 - smoothstep(0.01, 0.04, fp / 16.0);
  float meltHeat = clamp(0.52 + (conv - 0.5) * 1.3 * fConv + (strk - 0.5) * 0.9 * fStrk + (strk2 - 0.35) * 0.35 * fstr
                         + (act1 - 0.5) * 0.7 * (1.0 - fConv) + act * 0.22 + breath * 0.1, 0.18, 1.0);
  // upwellings: incandescent yellow-white boils where convection brings fresh melt up
  meltHeat = max(meltHeat, smoothstep(0.64, 0.8, conv + (breath - 0.5) * 0.08) * (0.85 + 0.15 * act) * fConv);
  // crust: cooled near its centre, still glowing dull red towards its edges (cooling gradient)
  float edgeD = c0.r / max(gapW, 0.03);
  float rim = exp(-max(edgeD - 1.0, 0.0) * 3.5) * (0.35 + 0.65 * act) * (1.0 - fr0 * 0.5);
  float crustHeat = rim * 0.4 + fis * (0.28 + 0.35 * act) + (1.0 - smoothstep(0.0, 0.25, cM.r)) * 0.18;
  // shore: melt pooled against rock stays open and hot
  float shoreHot = uHasScene > 0.5 ? 1.0 - smoothstep(0.0, 2.5, thick) : 0.0;
  molten = max(molten, shoreHot * 0.85);
  float heat = mix(crustHeat, meltHeat, molten);
  vec3 emis = LAVA_RAMP(heat) * mix(0.7, 1.0, molten) * (0.8 + 0.35 * breath * molten);
  // basalt: near-black, ropy (pahoehoe) relief from the detail slopes, glassy where fresh
  float rope = 1.0 - smoothstep(25.0, 140.0, wDist);
  vec3 Nl = normalize(nS - t1 * ((w0.r - 0.5) * 0.7 * rope + (w1.r - 0.5) * 0.35) - t2 * ((w0.g - 0.5) * 0.7 * rope + (w1.g - 0.5) * 0.35));
  Nl = normalize(mix(Nl, nS, farF));
  float NdL = max(dot(Nl, L), 0.0), NdVl = max(dot(Nl, V), 1e-3);
  vec3 crustC = vec3(0.011, 0.0095, 0.009) * (0.55 + 0.9 * c0.g) * (1.0 + 0.6 * c1.a);
  float solid = 1.0 - molten;
  col = crustC * (Esun * NdL + Eamb) / RV_PI * solid;
  col += vec3(0.5, 0.05, 0.004) * (0.02 + 0.06 * act) * solid;           // glow of the surrounding melt bouncing on the crust
  vec3 H = normalize(L + V);
  float aL = mix(0.45, 0.75, c0.g);
  float Fh = 0.04 + 0.96 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  col += Esun * ggx(max(dot(Nl, H), 0.0), aL) * smithVis(NdL, NdVl, aL) * NdL * Fh * solid * 0.6;
  float Fl = 0.04 + 0.5 * pow(1.0 - NdVl, 5.0);
  vec3 Rl = reflect(-V, Nl); Rl = normalize(Rl + nS * max(0.0, -dot(Rl, nS)) * 2.0);
  col += envSky(Rl) * Fl * 0.15 * solid;
  // the melt itself: a viscous skin with a faint sky sheen
  col += emis + envSky(Rl) * 0.03 * molten;
  if (uDebug > 1.5 && uDebug < 2.5) col = emis;
  float edge = uHasScene > 0.5 ? smoothstep(0.0, 0.25, thick) : 1.0;
  if (uHasScene > 0.5) col = mix(texture2D(tSceneColor, suv).rgb, col, edge);
  gl_FragColor = vec4(col, 1.0);
  return;
  }
#endif

#if defined(LIQUID_ICE)
  {
  // ================================================= ICE: frozen sea — pressure plates, cracks, snow drifts
  vec4 c0 = texture2D(tCrust, lay(vQ, 83.0, vec2(0.0)));
  vec4 c1 = texture2D(tCrust, layR(ROT1, vQ, 21.0, vec2(0.0)));
  float crack = 1.0 - smoothstep(0.012, 0.05, c0.r);
  float crackF = 1.0 - smoothstep(0.015, 0.05, c1.b);
  float snowN = texture2D(tWaves, lay(vQ, 170.0, vec2(0.0))).a;
  float drift = texture2D(tWaves, layR(ROT1, vQ, 37.0, vec2(0.0))).a;
  float snowM = smoothstep(0.5, 0.64, snowN + (drift - 0.5) * 0.35 + (c0.g - 0.5) * 0.12);
  vec3 Ni = normalize(nS - t1 * (w0.r - 0.5) * 0.08 * (1.0 - snowM) - t2 * (w0.g - 0.5) * 0.08 * (1.0 - snowM) - t1 * (c0.g - 0.5) * 0.06 - t2 * (drift - 0.5) * 0.3 * snowM);
  // ridge relief (vertex heights) → geometric normal from screen derivatives
  vec3 gN = normalize(cross(dFdx(vPos), dFdy(vPos)));
  if (dot(gN, nS) < 0.0) gN = -gN;
  float ridgeM = smoothstep(0.08, 0.5, vH);
  Ni = normalize(Ni + (gN - nS) * 1.0);
  snowM = max(snowM, ridgeM * 0.8);
  float NdL = max(dot(Ni, L), 0.0), NdV = max(dot(Ni, V), 1e-3);
  // clear black-blue ice (Baikal) with frozen bubbles, white frost-filled cracks, wind-blown snow
  vec3 clearIce = mix(vec3(0.012, 0.04, 0.055), uShallow * 0.3, 0.25 + 0.5 * c1.g);
  float bub = smoothstep(0.55, 0.9, texture2D(tFoam, lay(vQ, 4.0, vec2(0.0))).a) * (1.0 - smoothstep(20.0, 80.0, wDist));
  vec3 alb = clearIce + vec3(0.18, 0.22, 0.25) * bub;
  float frost = clamp(crack * 0.95 + crackF * 0.45, 0.0, 1.0);
  alb = mix(alb, vec3(0.62, 0.7, 0.76), frost);
  alb = mix(alb, vec3(0.86, 0.9, 0.95), snowM);
  col = alb * (Esun * NdL + Eamb) / RV_PI;
  // light glowing up through the ice around cracks
  col += uShallow * Eamb / RV_PI * 0.25 * (crack + crackF * 0.5) * (1.0 - snowM);
  vec3 H = normalize(L + V);
  float a = mix(0.05, 0.5, max(snowM, frost * 0.6));
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, Ni); R = normalize(R + nS * max(0.0, -dot(R, nS)) * 2.0);
  col = mix(col, envSky(R), F * (1.0 - snowM) * (1.0 - frost * 0.7) * 0.9);
  col += Esun * ggx(max(dot(Ni, H), 0.0), a) * smithVis(NdL, NdV, a) * NdL * (0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0));
  float edge = uHasScene > 0.5 ? smoothstep(0.0, 0.08, thick) : 1.0;
  if (uHasScene > 0.5) col = mix(texture2D(tSceneColor, suv).rgb, col, edge);
  gl_FragColor = vec4(col, 1.0);
  return;
  }
#endif

  // ================================================= WATER / ACID
  if (below){
    // ---- seen from below: Snell's window, total internal reflection beyond ~48.6°
    // seen from below the surface ripples read much stronger (refraction magnifies the slopes)
    vec3 Nb = normalize(nS + (N - nS) * 2.2);
    vec3 n = -Nb;
    vec3 I = -V;
    vec3 Tt = refract(I, n, 1.333);
    float cosi = max(dot(V, n), 0.0);
    vec3 under = uScatter * (Esun * 0.6 + Eamb) / RV_PI * exp(-uSigma * max(-uCamH, 0.0) * 0.5);
    vec3 c;
    if (dot(Tt, Tt) < 1e-4){
      c = under;                                    // TIR: mirror of the deep
    } else {
      float cost = max(dot(Tt, nS), 0.0);
      // transmission falls off gradually towards the critical angle (soft, rippled window rim)
      float F = max(0.02 + 0.98 * pow(1.0 - cost, 5.0), pow(1.0 - cost, 2.2));
      // the sky through the window is strongly distorted by the ripples
      vec3 Tw = normalize(Tt + (t1 * ((w1.r - 0.5) * v1 + (w0.g - 0.5) * v0) + t2 * ((w1.g - 0.5) * v1 - (w0.r - 0.5) * v0)) * 0.55);
      vec3 sky = mix(envSky(Tw), envSky(normalize(Tw + nS * 2.0)), 0.45) * 0.8;
      float sunD = pow(max(dot(Tt, L), 0.0), 900.0) * 60.0 + pow(max(dot(Tt, L), 0.0), 40.0) * 0.6;
      c = mix(sky * 0.6 + uKeyColor * sunVis * sunD, under, F);
    }
    // bright caustic ripples of sunlight on the underside of the surface
    vec3 cu = texture2D(tFoam, lay(vQ, 7.0, vec2(0.45, 0.1))).rgb;
    vec3 cv = texture2D(tFoam, layR(ROT1, vQ, 9.3, vec2(0.35, -0.2))).rgb;
    float fadeU = 1.0 - smoothstep(15.0, 90.0, wDist);
    c += (min(cu, cv) * 1.6 + (cu + cv) * 0.12) * (Esun * 0.06 + Eamb * 0.04) * fadeU;
    // foam seen from underneath: lacy, dim silhouettes against the window
    float fwb = texture2D(tFoam, lay(vQ, 11.0, vec2(0.5, 0.0))).a;
    float fwb2 = texture2D(tFoam, layR(ROT2, vQ, 3.7, vec2(0.25, 0.0))).a;
    float fm = smoothstep(0.45, 0.1, fold) * smoothstep(0.3, 0.8, fwb * 0.7 + fwb2 * 0.5) * 0.5 * smoothstep(8.0, 30.0, 11.0 / fp);
    c = mix(c, (Esun * 0.2 + Eamb) * 0.3 / RV_PI * (0.5 + 0.8 * fwb2), fm * uLook.y);
    gl_FragColor = vec4(c, 1.0);
    return;
  }

  // refraction offset (screen space), stronger for thicker water, fades with distance
  vec3 dN = N - nS;
  vec2 offV = vec2(dot(dN, vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0])), dot(dN, vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1])));
  vec2 ruv = suv + offV * uLook.z * clamp(thick * 0.35, 0.0, 1.0) / (1.0 + wDist * 0.04);
  float rDist = sDist;
  if (uHasScene > 0.5){
    float rd = sceneDistAt(ruv, cosF);
    if (rd > wDist + 0.05) rDist = rd; else ruv = suv;
  }
  float rThick = max(rDist - wDist, 0.0);
  vec3 refr = uHasScene > 0.5 ? texture2D(tSceneColor, ruv).rgb : vec3(0.0);
  vec3 bed = cameraPosition + (-V) * min(rDist, 1e6);
  float hb = length(bed - uPC) - uRs;
  float depthBelow = rDist > 1e8 ? 1e4 : max(-hb, 0.0);
  // land above the sea seen through a long water path is terrain beyond the wave horizon (an island behind
  // the curvature), not a shore: treat it as deep water (no shore foam / surf lines there)
  if (hb > 0.0 && rThick > 50.0 + wDist * 0.03) depthBelow = 1e4;
  if (uHasScene < 0.5){ rThick = 1e4; depthBelow = 1e4; }

  // caustics on the seabed (projected along the refracted sun)
  if (uLook2.z > 0.0 && depthBelow < 40.0 && rDist < 1e8){
    vec3 Lt = L - nS * dot(L, nS);
    vec3 relB = bed - (cameraPosition - uUp * uCamH);
    vec2 qb = vec2(dot(relB, uT1), dot(relB, uT2)) - vec2(dot(Lt, uT1), dot(Lt, uT2)) * depthBelow * 0.75 / max(sunUp, 0.25);
    vec3 ca = texture2D(tFoam, lay(qb, 6.1, vec2(0.45, 0.1))).rgb;
    vec3 cb = texture2D(tFoam, layR(ROT1, qb, 8.9, vec2(0.35, -0.2))).rgb;
    vec3 caus = ca * cb * 6.5 + (ca + cb) * 0.22 - 0.2;
    float cf = smoothstep(0.02, 0.4, depthBelow) * (1.0 - smoothstep(4.0, 38.0, depthBelow)) * uLook2.z * sunVis * (1.0 - smoothstep(0.0, 400.0, rDist));
    refr += refr * caus * cf * 2.2;
  }

  // Beer–Lambert absorption along the view path + the light's path down to the bed
  vec3 Tr = exp(-uSigma * (rThick + depthBelow * 0.9));
  vec3 Ein = Esun * max(sunUp, 0.0) * 0.8 + Eamb;
  vec3 inscat = uScatter * Ein / RV_PI;
#ifdef LIQUID_ACID
  inscat += uGlow * (0.6 + 0.4 * sin(uTime * 0.7 + vQ.x * 0.05)) * 0.35;
#endif
  vec3 body = refr * Tr + inscat * (1.0 - Tr);

  // subsurface glow through thin crests (backlit) + a little forward scattering on sunny faces
  float back = pow(clamp(dot(-V, L), 0.0, 1.0), 3.0);
  float sss = (back * 0.9 + 0.15 * max(dot(N, L), 0.0)) * crest * crest * smoothstep(0.0, 0.35, max(sunUp, 0.0));
  body += uSSS * uKeyColor * sss * cloud * 0.08;

  // ------------------------------------------------ reflection
  float NdV = max(dot(N, V), 1e-3);
  vec3 Nr = normalize(mix(nS, N, 0.55));                       // calmer normal for coherent reflections
  vec3 R = reflect(-V, Nr);
  float rUp = dot(R, nS);
  R = normalize(R + nS * max(0.0, -rUp) * 2.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  F *= mix(1.0, 0.55, smoothstep(0.08, 0.5, alpha));          // rough water reflects less at grazing
  vec3 refl = envSky(R);
  if (uLook2.x > 0.5 && uHasScene > 0.5 && wDist < 6000.0){
    vec3 posV = vView;
    vec3 Rv = normalize((viewMatrix * vec4(R, 0.0)).xyz);
    vec4 hit = ssr(posV, Rv, vPos, R);
    refl = mix(refl, hit.rgb, hit.a * (1.0 - smoothstep(3500.0, 6000.0, wDist)));
    if (uDebug > 0.5){ gl_FragColor = vec4(hit.a, uHasScene, F, 1.0); return; }
  }
  // sun / moon glint (GGX)
  vec3 H = normalize(L + V);
  float NdL = max(dot(N, L), 0.0);
  float VdH = max(dot(V, H), 0.0);
  float Fs = 0.02 + 0.98 * pow(1.0 - VdH, 5.0);
  vec3 spec = Esun * ggx(max(dot(N, H), 0.0), alpha) * smithVis(NdL, NdV, alpha) * Fs * NdL;
  // glitter: individual wave facets flashing the sun inside a broad lobe (the granular sun path). Stochastic:
  // world-space cells (≥ 1.5 px, power-of-two sized so they never swim) light up with a probability that follows
  // the broad GGX lobe, each flash carrying the lobe's peak energy → same mean brightness as the smooth lobe.
  float aB = min(alpha * 1.6 + 0.04, 0.42);
  float NdH = max(dot(N, H), 0.0);
  float dB = NdH * NdH * (aB * aB - 1.0) + 1.0;
  float lobeN = clamp(aB * aB / max(dB, 1e-5), 0.0, 1.0); lobeN *= lobeN;        // GGX(NdH)/GGX(1)
  float lobeRest = smithVis(NdL, NdV, aB) * Fs * NdL / (RV_PI * aB * aB);
  if (lobeN > 0.002 && farF < 0.999){
    float lc = log2(fp * 1.6);
    float cs = exp2(ceil(lc));
    vec2 cq = (vQ + uQN) / cs;
    vec2 ci = mod(floor(cq), 1024.0);
    float tw = mod(floor(uTime * 7.0 + rv_hash12(ci + 17.0) * 7.0), 512.0);
    float hs = rv_hash13(vec3(ci, tw));
    float pr = 0.3 * lobeN * lobeN * (0.6 + 0.8 * gust);
    // soft round glints inside the cell (no square pixels up close)
    vec2 fc = fract(cq) - 0.5;
    float spot = 1.0 - smoothstep(0.18, 0.5, length(fc));
    float sp = smoothstep(1.0 - pr, 1.0 - pr * 0.7, hs) * spot;
    spec += Esun * sp * lobeRest * 3.0 * uLook2.w * (1.0 - farF);
  }
  spec *= 1.0 + 1.2 * farF;                                      // orbital glint survives the aerial perspective
  spec = min(spec, vec3(3.0e4));

  col = mix(body, refl, F) + spec;

  // ------------------------------------------------ foam: crests + shore + surf lines
  float web = texture2D(tFoam, lay(vQ, 11.0, vec2(0.5, 0.0))).a;
  float web2 = texture2D(tFoam, layR(ROT2, vQ, 3.7, vec2(0.25, 0.0))).a;
  float patchN = texture2D(tWaves, layR(ROT1, vQ, 150.0, vec2(1.2, 0.0))).a;
  float crestF = smoothstep(0.62 - 0.25 * uLook2.w, 0.12, fold) * uLook.y * smoothstep(0.4, 0.66, patchN * 0.55 + gust * 0.45 + web * 0.25);
  float foam = crestF * smoothstep(0.15, 0.6, web * 0.8 + web2 * 0.5);
  if (uHasScene > 0.5 && uLook2.y > 0.0){
    float n1 = texture2D(tWaves, lay(vQ, 57.0, vec2(0.3, 0.0))).a;
    float shoreD = min(depthBelow, rThick * 0.5);
    float n2 = texture2D(tWaves, layR(ROT1, vQ, 23.0, vec2(0.2, 0.0))).a;
    // the waterline: a broken, lacy fringe (patchy along the shore), never a continuous white rim
    float edgeFoam = (1.0 - smoothstep(0.0, 0.22 + 0.75 * n1, shoreD)) * smoothstep(0.28, 0.62, n2 + (n1 - 0.5) * 0.4);
    float ph = shoreD * 2.1 - uTime * 1.25 + n1 * 9.0;
    float lines = smoothstep(0.72, 0.97, sin(ph) * 0.5 + 0.5) * (1.0 - smoothstep(0.4, 3.6, shoreD))
                * smoothstep(0.35, 0.6, n2 + 0.25 * sin(floor(ph / RV_TAU) * 1.7 + n1 * 4.0));
    float surf = max(edgeFoam, lines * 0.85) * uLook2.y;
    foam = max(foam, surf * smoothstep(0.2, 0.62, web * 0.7 + web2 * 0.6 + edgeFoam * 0.1));
  }
  // breaking shore swell: white water on the crest front, trailing lace behind
  if (swellA > 0.0){
    float brk = smoothstep(0.45, 0.85, swellPr) * (1.0 - smoothstep(0.4, uShore.w * 0.38, bd.x)) * smoothstep(-0.2, 0.3, bd.x)
              * smoothstep(0.25, 0.65, swellVar + (web - 0.5) * 0.5);
    // lace: the spent white water left behind the breaker — patchy along the shore and fading as the swell
    // passes (never a uniform net over the whole shallow)
    float lp = texture2D(tWaves, layR(ROT2, vQ, 61.0, vec2(0.3, 0.0))).a;
    float lace = smoothstep(0.2, 0.45, swellPr) * (1.0 - smoothstep(0.25, 1.2, bd.x)) * 0.5 * smoothstep(0.42, 0.66, lp + (swellVar - 0.5) * 0.4);
    foam = max(foam, clamp(brk + lace, 0.0, 1.0) * smoothstep(0.22, 0.7, web * 0.75 + web2 * 0.55 + brk * 0.45) * min(swellA * 3.0, 1.0));
  }
  foam *= 1.0 - farF;
  vec3 foamC = vec3(0.9, 0.92, 0.94) * (Esun * (0.6 + 0.4 * max(dot(N, L), 0.0)) + Eamb) / RV_PI;
  col = mix(col, foamC, clamp(foam, 0.0, 1.0));

  // soft shoreline: fade in over the first centimetres of water
  if (uHasScene > 0.5){
    float edge = smoothstep(0.0, 0.18, rThick) ;
    col = mix(texture2D(tSceneColor, suv).rgb, col, edge);
  }
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// ---------------------------------------------------------------- underwater post effect (order 130)
export const UNDERWATER_FRAG = /* glsl */ `
#include <rv_common>
uniform sampler2D tColor, tDepth, tFoam;
uniform mat4 uInvProj, uCamWorld;
uniform vec2 uNearFar;
uniform vec3 uCam, uPC, uUp, uT1, uT2, uL;
uniform float uRs, uCamDepth, uTime, uUnder, uJit;
uniform vec3 uSigma, uScatter, uEsun, uEamb, uGlow;
uniform vec2 uQN;
varying vec2 vUv;
vec2 lay(vec2 q, float S, vec2 vel){ return (q + uQN) / S - vel * (uTime / S); }

float dist(vec2 uv, vec3 dirV){
  float d = texture2D(tDepth, uv).r;
#ifdef USE_REVERSED_DEPTH_BUFFER
  if (d <= 0.0) return 1e9;
#else
  if (d >= 1.0) return 1e9;
#endif
  return rv_viewZFromDepth(d, uNearFar.x, uNearFar.y) / max(-dirV.z, 1e-3);
}

void main(){
  vec3 col = texture2D(tColor, vUv).rgb;
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dirV = normalize(v.xyz / v.w);
  vec3 dir = normalize((uCamWorld * vec4(dirV, 0.0)).xyz);
  float D = min(dist(vUv, dirV), 2000.0);
  // light available at a depth z below the surface
  float up = dot(dir, uUp);
  // in-scatter: integrate along the ray (exact per-segment extinction, samples denser near the eye), with
  // depth-dependent sunlight and god-ray shafts. The shaft pattern is the SMOOTH (mip-filtered) focusing
  // pattern of the surface projected along the refracted sun: shafts are broad, only their edges are soft,
  // and the per-pixel jitter changes every rendered (sub)frame so TAA / shot supersampling resolves it.
  vec3 Tr = exp(-uSigma * D * 0.85);
  vec3 acc = vec3(0.0);
  float jit = uJit < 0.0 ? 0.5 : fract(rv_ign(gl_FragCoord.xy + 5.588 * floor(uJit * 64.0)) + uJit);
#ifndef SHAFT_STEPS
#define SHAFT_STEPS 16
#endif
  vec3 trAcc = vec3(1.0);
  float sunUp = max(dot(uUp, uL), 0.05);
  vec3 Lt = uL - uUp * dot(uL, uUp);
  vec2 Lq = vec2(dot(Lt, uT1), dot(Lt, uT2)) / sunUp;
  float cosDL = max(dot(dir, uL), 0.0);
  float phase = 0.3 + 0.7 * pow(cosDL, 5.0) + 0.25 * pow(cosDL, 60.0);
  // (1) near span (≤ 36 m, where the shafts are coherent and resolvable): uniform jittered steps with the
  //     projected focusing pattern — broad beams slanting down along the refracted sun
  // (2) far span (≤ 180 m): quadratic steps, shafts averaged out (mean focusing = 1)
  float Dn = min(D, 36.0), Dm = min(D, 180.0);
  float tPrev = 0.0;
  for (int i = 0; i < SHAFT_STEPS; i++){
    float t1 = Dn * (float(i) + 1.0) / float(SHAFT_STEPS);
    float tm = mix(tPrev, t1, jit);
    vec3 p = dir * tm;
    float z = max(uCamDepth - dot(p, uUp), 0.0);               // depth of the sample below the surface
    vec3 Ez = uEsun * exp(-uSigma * z / sunUp);
    vec2 q = vec2(dot(p, uT1), dot(p, uT2)) + Lq * z;
    // two large, independent focusing patterns (≈ 5–8 m beams): their product is sparse, bright beams with dark
    // gaps; normalised so the mean stays ≈ 1 (energy of the far span, which averages the shafts out)
    float sh = textureLod(tFoam, lay(q, 53.0, vec2(0.6, 0.1)), 3.0).r * textureLod(tFoam, lay(q.yx, 83.0, vec2(-0.4, 0.2)), 3.0).g;
    float nsh = sh * 13.7;
    float shaft = mix(1.0, clamp(nsh * nsh * 0.8, 0.0, 5.0), exp(-z * 0.03));
    vec3 Ls = uScatter * (Ez * shaft * phase * 2.2 + uEamb * exp(-uSigma * z * 0.5)) / RV_PI + uGlow * 0.2;
    vec3 stepTr = exp(-uSigma * (t1 - tPrev) * 0.85);
    acc += trAcc * (1.0 - stepTr) * Ls;
    trAcc *= stepTr;
    tPrev = t1;
  }
  if (Dm > Dn + 0.1){
    for (int i = 0; i < 6; i++){
      float u1 = (float(i) + 1.0) / 6.0;
      float t1 = Dn + (Dm - Dn) * u1 * u1;
      float tm = mix(tPrev, t1, 0.25 + 0.5 * jit);
      float z = max(uCamDepth - dot(dir * tm, uUp), 0.0);
      vec3 Ez = uEsun * exp(-uSigma * z / sunUp);
      vec3 Ls = uScatter * (Ez * phase * 2.2 + uEamb * exp(-uSigma * z * 0.5)) / RV_PI + uGlow * 0.2;
      vec3 stepTr = exp(-uSigma * (t1 - tPrev) * 0.85);
      acc += trAcc * (1.0 - stepTr) * Ls;
      trAcc *= stepTr;
      tPrev = t1;
    }
  }
  // beyond the marched span: constant fog of the deep
  vec3 far = uScatter * (uEsun * exp(-uSigma * (uCamDepth + 20.0) / sunUp) * 0.35 + uEamb * exp(-uSigma * uCamDepth * 0.5)) / RV_PI;
  acc += trAcc * (1.0 - exp(-uSigma * max(D - Dm, 0.0) * 0.85)) * far;
  // seabed caustics (scene surfaces below the surface): two dispersive caustic layers at different scales and
  // drift directions; their product is the sharp, bright interference web, their mean the soft ambient focus
  if (D < 150.0){
    vec3 P = uCam + dir * D;
    float zb = uRs - length(P - uPC);
    if (zb > 0.1){
      vec3 rel = dir * D;
      vec2 qb = vec2(dot(rel, uT1), dot(rel, uT2)) - Lq * zb * 0.75;
      vec3 ca = texture2D(tFoam, lay(qb, 6.1, vec2(0.45, 0.1))).rgb;
      vec3 cb = texture2D(tFoam, lay(qb.yx * 0.93 + 3.7, 8.9, vec2(-0.3, 0.26))).rgb;
      vec3 caus = ca * cb * 6.5 + (ca + cb) * 0.22;
      float cf = (1.0 - smoothstep(5.0, 38.0, zb)) * smoothstep(0.1, 0.8, zb) * (1.0 - smoothstep(40.0, 150.0, D));
      col += col * (caus - 0.2) * 2.4 * cf * exp(-uSigma.g * zb * 0.4);
    }
  }
  vec3 outc = col * Tr + acc;
  // slight blue lift + vignette of the mask
  gl_FragColor = vec4(mix(col, outc, uUnder), 1.0);
}
`;

// ---------------------------------------------------------------- heat shimmer over lava (order 145)
export const SHIMMER_FRAG = /* glsl */ `
#include <rv_common>
uniform sampler2D tColor, tDepth, tWaves;
uniform mat4 uInvProj, uCamWorld;
uniform vec2 uNearFar;
uniform vec3 uCam, uPC;
uniform float uRs, uTime, uStrength;
varying vec2 vUv;
void main(){
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dirV = normalize(v.xyz / v.w);
  vec3 dir = normalize((uCamWorld * vec4(dirV, 0.0)).xyz);
  float d = texture2D(tDepth, vUv).r;
#ifdef USE_REVERSED_DEPTH_BUFFER
  bool sky = d <= 0.0;
#else
  bool sky = d >= 1.0;
#endif
  float D = sky ? 3000.0 : min(rv_viewZFromDepth(d, uNearFar.x, uNearFar.y) / max(-dirV.z, 1e-3), 3000.0);
  vec3 P = uCam + dir * D;
  float h = length(P - uPC) - uRs;
  float m = (1.0 - smoothstep(2.0, 60.0, h)) * smoothstep(3.0, 30.0, D) * (1.0 - smoothstep(600.0, 2500.0, D)) * uStrength;
  vec2 o = vec2(0.0);
  if (m > 0.001){
    vec2 w = texture2D(tWaves, vUv * vec2(3.0, 1.6) + vec2(0.0, -uTime * 0.35)).rg - 0.5;
    vec2 w2 = texture2D(tWaves, vUv * vec2(7.0, 4.0) + vec2(uTime * 0.05, -uTime * 0.8)).rg - 0.5;
    o = (w + w2 * 0.6) * 0.006 * m;
  }
  gl_FragColor = vec4(texture2D(tColor, vUv + o).rgb, 1.0);
}
`;

// ---------------------------------------------------------------- marine snow (suspended particles underwater)
export const SNOW_VERT = /* glsl */ `
uniform float uTime, uBox, uPx;
attribute vec4 seed;
varying float vA;
void main(){
  vec3 drift = vec3(sin(uTime * 0.13 + seed.w * 6.0), -0.35, cos(uTime * 0.11 + seed.w * 5.0)) * 0.12 * uTime;
  vec3 p = cameraPosition + (fract((seed.xyz * uBox - cameraPosition + drift) / uBox) - 0.5) * uBox;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  vA = (1.0 - smoothstep(uBox * 0.25, uBox * 0.5, d)) * smoothstep(0.2, 0.8, d) * (0.4 + 0.6 * seed.w);
  gl_PointSize = clamp(uPx * (0.6 + seed.w) * 6.0 / max(d, 0.1), 1.5, 9.0);
  gl_Position = projectionMatrix * mv;
}
`;
export const SNOW_FRAG = /* glsl */ `
uniform vec3 uCol;
varying float vA;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.1, length(c)) * vA;
  gl_FragColor = vec4(uCol * a, a);
}
`;

// ---------------------------------------------------------------- shore effect (order 95): wet sand, swash, hot rims
// Runs before the atmosphere. Land pixels (depth identical to the pre-water grab) just above sea level get the
// swash of the shore swell: a thin glossy water sheet that runs up the beach and drains back, a lacy foam line at
// its front, and sand that stays dark and glossy up to the highest run-up. Lava seas instead heat their rocky rims.
export const SHORE_FRAG = /* glsl */ `
#include <rv_common>
uniform sampler2D tColor, tDepth, tGrabDepth, tFoam, tWaves, tPreAO;
uniform float uUnder, uShoreOn;
uniform samplerCube tEnv;
uniform float uHasEnv;
uniform mat4 uInvProj, uCamWorld;
uniform vec2 uNearFar;
uniform vec3 uCam, uPC, uUp, uT1, uT2, uKeyDir, uKeyColor, uAmbSky, uShallow;
uniform float uRs, uCamH, uTime, uLiquid;
uniform vec2 uQN;
uniform vec4 uShore;
varying vec2 vUv;
vec2 lay(vec2 q, float S, vec2 vel){ return (q + uQN) / S - vel * (uTime / S); }
float ggxS(float NdH, float a){ float a2 = a * a; float d = NdH * NdH * (a2 - 1.0) + 1.0; return a2 / (RV_PI * d * d + 1e-7); }

void main(){
  vec3 col = texture2D(tColor, vUv).rgb;
  gl_FragColor = vec4(col, 1.0);
  float d = texture2D(tDepth, vUv).r;
  float dg = texture2D(tGrabDepth, vUv).r;
#ifdef USE_REVERSED_DEPTH_BUFFER
  if (d <= 0.0) return;
#else
  if (d >= 1.0) return;
#endif
  bool isWater = abs(d - dg) > 1e-7 + abs(d) * 1e-5;                  // the water itself (or drawn after it)
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dirV = normalize(v.xyz / v.w);
  float D = rv_viewZFromDepth(d, uNearFar.x, uNearFar.y) / max(-dirV.z, 1e-3);
  // Screen-space AO (pipeline, before the effects) turns the smooth, grazing water surface into a hatched
  // noise pattern and has no meaning on a liquid: water pixels take the pre-AO scene colour. Underwater, AO
  // also fades out with distance (the grazing seabed / surface underside far away).
  if (uUnder > 0.5){
    vec3 pre = texture2D(tPreAO, vUv).rgb;
    gl_FragColor = vec4(mix(col, pre, isWater ? 1.0 : smoothstep(10.0, 30.0, D)), 1.0);
    return;
  }
  if (isWater){ gl_FragColor = vec4(texture2D(tPreAO, vUv).rgb, 1.0); return; }
  if (uShoreOn < 0.5 || D > 1200.0) return;
  vec3 dir = normalize((uCamWorld * vec4(dirV, 0.0)).xyz);
  vec3 P = uCam + dir * D;
  vec3 nS = normalize(P - uPC);
  float h = length(P - uPC) - uRs;
  if (h > 2.2 || h < -1.5) return;
  vec3 rel = P - (uCam - uUp * uCamH);
  vec2 q = vec2(dot(rel, uT1), dot(rel, uT2));
  float fadeD = 1.0 - smoothstep(500.0, 1150.0, D);
  if (fadeD <= 0.0) return;
  float n1 = texture2D(tWaves, lay(q, 23.0, vec2(0.0))).a;
  float n2 = texture2D(tWaves, lay(q, 6.1, vec2(0.0))).a;
  float n3 = texture2D(tWaves, lay(q, 71.0, vec2(0.0))).a;
  vec3 L = normalize(uKeyDir);
  vec3 V = -dir;
  float NdL = max(dot(nS, L), 0.0);
  float sunUp = smoothstep(-0.02, 0.08, dot(nS, L));
  if (uLiquid > 1.5){
    // lava: rocks at the rim glow from the heat of the melt, cooling upward
    float g = exp(-max(h, 0.0) * (2.2 + 2.0 * n1)) * (0.55 + 0.9 * n2 * n3 * 2.0);
    vec3 glow = vec3(1.0, 0.16, 0.012) * (0.25 + 2.2 * g * g) * g;
    col = mix(col, col * vec3(0.25, 0.2, 0.2), g * 0.6) + glow * fadeD;
    gl_FragColor = vec4(col, 1.0);
    return;
  }
  float amp = uShore.x;
  float runMax = max(0.12 + amp * 0.85 + (n3 - 0.5) * 0.35 + (n1 - 0.5) * 0.15, 0.05);
  float period = RV_TAU / max(uShore.z, 0.05);
  // swash cycle: fast run-up, slow backwash; phase drifts along the beach
  float cyc = fract(uShore.z * uTime / RV_TAU + n3 * 1.3 + n1 * 0.3);
  float rise = smoothstep(0.0, 0.24, cyc);
  float fall = 1.0 - smoothstep(0.24, 0.97, cyc);
  float front = runMax * rise * sqrt(max(fall, 0.0));
  float frontJ = front + (n2 - 0.5) * 0.06;
  float film = (1.0 - smoothstep(frontJ - 0.035, frontJ + 0.005, h)) * smoothstep(0.005, 0.05, front);
  // time since the backwash uncovered this height: freshly drained sand keeps a mirror sheen for ~2 s
  float r = clamp(h / runMax, 0.0, 1.0);
  float cDown = 0.24 + 0.73 * (0.5 - sin(asin(clamp(2.0 * r * r - 1.0, -1.0, 1.0)) / 3.0));
  float since = fract(cyc - cDown) * period;
  float sheen = h < runMax ? exp(-since / 2.2) * (1.0 - film) : 0.0;
  // moisture: saturated up to the highest run-up, then a long capillary gradient (damp → dry) above it
  float hr = h - runMax + (n1 - 0.5) * 0.14 + (n2 - 0.5) * 0.05;
  float moist = 1.0 - smoothstep(-0.03, 0.75 + 0.35 * n3, hr);
  moist *= moist;
  float sat = max(1.0 - smoothstep(-0.14, 0.1, hr), film);   // fully saturated band (below the run-up)
  // darker, more saturated wet sand, graded
  float lu = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 wetCol = max(mix(vec3(lu), col, 1.25), 0.0) * 0.5;
  col = mix(col, wetCol, max(sat, moist * 0.85) * fadeD);
  // thin water sheet: slight tint, sky reflection (Fresnel), sun glint. Roughness grades from the mirror film
  // and the draining sheen to matte damp sand.
  vec3 R = reflect(dir, nS);
  R = normalize(R + nS * max(0.0, -dot(R, nS)) * 2.0);
  float NdV = max(dot(nS, V), 0.02);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  float glossy = max(film, sheen * 0.85);
  float gloss = (glossy * 0.8 + sat * 0.22 + moist * 0.08) * fadeD;
  vec3 sky = uHasEnv > 0.5 ? textureCube(tEnv, R).rgb : uAmbSky * 0.3;
  col = mix(col, col * mix(vec3(1.0), uShallow * 1.6, 0.35), film * fadeD);
  col = col * (1.0 - F * gloss) + sky * F * gloss;
  vec3 H = normalize(L + V);
  float a = mix(mix(0.42, 0.22, sat), 0.045, glossy);
  float NdH = max(dot(nS, H), 0.0);
  float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  float vis = 0.25 / max(NdL * NdV + 0.05, 0.05);
  col += uKeyColor * sunUp * ggxS(NdH, a) * vis * Fh * NdL * max(gloss, sat * 0.3 * fadeD) * (0.6 + 0.8 * n2);
  // foam lace at the swash front (bright while running up, thinning to bubbles as it drains), a bubble line
  // left at the top of the run-up that dissolves, never a solid white stripe
  float web = texture2D(tFoam, lay(q, 4.3, vec2(0.12, 0.0))).a;
  float web2 = texture2D(tFoam, lay(q, 1.7, vec2(0.0))).a;
  float band = film * (1.0 - smoothstep(0.0, 0.06 + 0.08 * n1, frontJ - h));
  float trail = film * smoothstep(0.35, 0.8, web) * 0.4 * (1.0 - rise * 0.5);
  float topLine = (1.0 - smoothstep(0.0, 0.04, abs(h - runMax * 0.97))) * exp(-fract(cyc - 0.24) * period / 3.5) * 0.5;
  float lace = smoothstep(0.28, 0.72, web * 0.7 + web2 * 0.5);
  float foam = clamp((band * mix(0.9, 0.35, smoothstep(0.24, 0.6, cyc)) + trail + topLine) * lace, 0.0, 1.0);
  vec3 foamC = vec3(0.9, 0.92, 0.94) * (uKeyColor * sunUp * (0.5 + 0.5 * NdL) + uAmbSky) / RV_PI;
  col = mix(col, foamC, foam * fadeD * (uLiquid < 0.5 ? 0.9 : 0.55));
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;
