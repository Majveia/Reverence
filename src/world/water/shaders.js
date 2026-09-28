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
uniform float uRs, uCamH;
uniform vec4 uGrid;                 // dMin, dMax, ring count, spacing factor
uniform vec4 uWA[NW];               // dir.x, dir.y, k, A (amp applied)
uniform vec4 uWB[NW];               // Q, phase at nadir, wavelength, unused
uniform float uTime;
uniform sampler2D tBathy;           // water depth (m) around the camera (worker-built, half float)
uniform vec4 uBathy;                // xy: qN − qCentre, z: 1/(2L), w: valid
uniform vec4 uShore;                // x: swell amplitude, y: k per metre of depth, z: omega, w: band depth
uniform float uBathyE;              // bathymetry texel (m)
uniform vec2 uQN;                   // nadir wave coordinate mod 4096 m (texture layers)
const mat2 ROT1 = mat2(0.8253, 0.5646, -0.5646, 0.8253);   // +0.6 rad
const mat2 ROT2 = mat2(0.4536, -0.8912, 0.8912, 0.4536);   // -1.1 rad
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
uniform float uNight;
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
  float jitter = rv_ign(gl_FragCoord.xy);
  for (int s = 0; s < 22; s++){
    float tj = t * (1.0 + 0.2 * jitter);
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
  float sx = 0.0, sy = 0.0, ny = 0.0, varS = 0.0;
  vec2 bd = bathy(vQ);
  float damp = mix(1.0, smoothstep(-0.2, 3.0, bd.x), bd.y);
  for (int k = 0; k < NW; k++){
    vec4 a = uWA[k]; vec4 b = uWB[k];
    float f = smoothstep(1.5, 5.0, b.z / fp);
    float wa = a.z * a.w * damp;
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
  float dAmp = uLook.w * mix(0.35, 1.0, damp);
  vec2 uv0 = lay(vQ, 41.0, vec2(1.3, 0.0));
  vec2 uv1 = layR(ROT1, vQ, 13.7, vec2(0.9, 0.1));
  vec2 uv2 = layR(ROT2, vQ, 4.3, vec2(0.55, 0.0));
  vec4 w0 = texture2D(tWaves, uv0);
  vec4 w1 = texture2D(tWaves, uv1);
  vec2 d0 = (w0.rg * 2.0 - 1.0) * SLOPE_RANGE * 0.32;
  vec2 d1 = ((w1.rg * 2.0 - 1.0) * SLOPE_RANGE * 0.26) * ROT1;
  vec2 d2 = vec2(0.0);
  float nearF = 1.0 - smoothstep(60.0, 260.0, wDist);
  if (nearF > 0.0){
    vec4 w2 = texture2D(tWaves, uv2);
    d2 = ((w2.rg * 2.0 - 1.0) * SLOPE_RANGE * 0.22) * ROT2 * nearF;
  }
  // variance lost to mip filtering (texel = tile/256) → roughness
  float lod0 = fp / (41.0 / 256.0), lod1 = fp / (13.7 / 256.0), lod2 = fp / (4.3 / 256.0);
  varS += dAmp * dAmp * 0.048 * (0.30 * smoothstep(0.7, 12.0, lod0) + 0.18 * smoothstep(0.7, 12.0, lod1) + 0.13 * smoothstep(0.7, 12.0, lod2));
  vec2 det = (d0 + d1 + d2) * dAmp;
  sx += det.x; sy += det.y;
  vec3 N = normalize(nS * max(1.0 - ny, 0.2) - t1 * sx - t2 * sy);
  // far away: blend to the smooth sphere (all detail is roughness by then)
  float farF = smoothstep(4000.0, 60000.0, wDist);
  N = normalize(mix(N, nS, farF));
  float alpha = clamp(sqrt(uLook.x * uLook.x + 2.0 * varS), 0.02, 0.6);
  alpha = mix(alpha, 0.14, farF);                                // orbit: broad but bright sun glint

  // ------------------------------------------------ scene behind the surface
  vec2 suv = gl_FragCoord.xy * uInvRes;
  vec3 rayV = normalize(vView);
  float cosF = -rayV.z;
  float sDist = uHasScene > 0.5 ? sceneDistAt(suv, cosF) : 1e9;
  float thick = max(sDist - wDist, 0.0);

  // fold / crest measures
  float fold = vFold - w0.b * 0.35 * dAmp - w1.b * 0.2 * dAmp;
  float crest = clamp(vH / max(uWA[0].w * 2.2, 0.05) * 0.5 + 0.5, 0.0, 1.0);

  vec3 col;
  float cloud = rv_cloudShadow(vPos);
  float sunVis = smoothstep(-0.02, 0.06, sunUp) * cloud;
  vec3 Esun = uKeyColor * sunVis;
  vec3 Eamb = uAmbSky;

#if defined(LIQUID_LAVA)
  {
  // ================================================= LAVA: crusted flowing rock with incandescent cracks
  vec2 warp = (texture2D(tWaves, lay(vQ, 90.0, vec2(0.35, 0.1))).rg - 0.5) * 0.25;
  vec4 c0 = texture2D(tCrust, lay(vQ, 55.0, vec2(0.22, 0.07)) + warp);
  vec4 c1 = texture2D(tCrust, layR(ROT1, vQ, 16.4, vec2(0.1, 0.0)) + warp * 0.5);
  float crack = 1.0 - smoothstep(0.02, 0.11, c0.r);                  // big plate borders
  float crackF = (1.0 - smoothstep(0.01, 0.035, c1.b)) * 0.35;       // fine fissures
  float heatN = texture2D(tWaves, lay(vQ, 130.0, vec2(0.3, 0.2))).a;
  float pool = smoothstep(0.86, 0.95, heatN);                             // rare open pools
  float frag = 1.0 - smoothstep(0.35, 0.6, c0.g);                        // crust plates drifting in them
  float hn2 = texture2D(tWaves, lay(vQ + warp * 30.0, 70.0, vec2(0.18, 0.05))).a;
  float channel = 1.0 - smoothstep(0.0, 0.03, abs(hn2 - 0.5));           // sinuous glowing flow veins
  float molten = max(pool * (1.0 - 0.9 * frag), channel * 0.75);
  float hot = clamp(max(crack, crackF * (0.3 + heatN)) + molten * 0.7 + max(0.6 - fold, 0.0) * 0.3, 0.0, 1.0);
  // shore: lava pooled against rock is hotter and bright
  float shoreHot = uHasScene > 0.5 ? 1.0 - smoothstep(0.0, 1.2, thick) : 0.0;
  hot = max(hot, shoreHot * 0.55);
  float T = mix(1000.0, 1350.0, hot * hot);
  vec3 emis = rv_blackbody(T) * pow(hot, 2.0) * 4.5 * vec3(1.0, 0.62, 0.38) + rv_blackbody(1000.0) * 0.03 * (0.5 + c0.g) * (1.0 - pool);
  vec3 crustC = vec3(0.045, 0.036, 0.034) * (0.6 + 0.8 * c0.g);
  vec3 Nl = normalize(nS - t1 * (w0.r - 0.5) * 0.6 - t2 * (w0.g - 0.5) * 0.6);
  float NdL = max(dot(Nl, L), 0.0);
  col = crustC * (Esun * NdL + Eamb) / RV_PI * (1.0 - hot) + emis;
  // glassy sheen on the crust
  vec3 H = normalize(L + V);
  col += uKeyColor * sunVis * ggx(max(dot(Nl, H), 0.0), 0.35) * smithVis(NdL, max(dot(Nl, V), 1e-3), 0.35) * NdL * 0.04 * (1.0 - hot);
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
    vec3 n = -N;
    vec3 I = -V;
    vec3 Tt = refract(I, n, 1.333);
    float cosi = max(dot(V, n), 0.0);
    vec3 under = uScatter * (Esun * 0.6 + Eamb) / RV_PI * exp(-uSigma * max(-uCamH, 0.0) * 0.5);
    vec3 c;
    if (dot(Tt, Tt) < 1e-4){
      c = under * 1.2;                                    // TIR: mirror of the deep
    } else {
      float cost = max(dot(Tt, nS), 0.0);
      float F = 0.02 + 0.98 * pow(1.0 - cost, 5.0);
      vec3 sky = envSky(Tt) * 0.85;
      float sunD = pow(max(dot(Tt, L), 0.0), 900.0) * 60.0 + pow(max(dot(Tt, L), 0.0), 40.0) * 0.6;
      c = mix(sky * 0.6 + uKeyColor * sunVis * sunD, under, F);
    }
    // foam seen from underneath: lacy, dim silhouettes against the window
    float fwb = texture2D(tFoam, lay(vQ, 11.0, vec2(0.5, 0.0))).a;
    float fm = smoothstep(0.5, 0.15, fold) * smoothstep(0.25, 0.75, fwb) * 0.7;
    c = mix(c, (Esun * 0.15 + Eamb) * 0.35 / RV_PI, fm * uLook.y);
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
  float depthBelow = rDist > 1e8 ? 1e4 : max(uRs - length(bed - uPC), 0.0);
  if (uHasScene < 0.5){ rThick = 1e4; depthBelow = 1e4; }

  // caustics on the seabed (projected along the refracted sun)
  if (uLook2.z > 0.0 && depthBelow < 40.0 && rDist < 1e8){
    vec3 Lt = L - nS * dot(L, nS);
    vec3 relB = bed - (cameraPosition - uUp * uCamH);
    vec2 qb = vec2(dot(relB, uT1), dot(relB, uT2)) - vec2(dot(Lt, uT1), dot(Lt, uT2)) * depthBelow * 0.75 / max(sunUp, 0.25);
    vec3 ca = texture2D(tFoam, lay(qb, 7.0, vec2(0.45, 0.1))).rgb;
    vec3 cb = texture2D(tFoam, layR(ROT1, qb, 9.3, vec2(0.35, -0.2))).rgb;
    vec3 caus = min(ca, cb) * 2.4 + (ca + cb) * 0.35;
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
  // glitter: sparse, sharp facets inside a broad lobe (sun path sparkle)
  float aB = min(alpha * 2.2 + 0.08, 0.7);
  float lobe = ggx(max(dot(N, H), 0.0), aB) * smithVis(NdL, NdV, aB) * Fs * NdL;
  float gl1 = texture2D(tFoam, layR(ROT2, vQ, 1.9 + wDist * 0.004, vec2(1.6, 0.3))).r;
  float gl2 = texture2D(tFoam, lay(vQ, 2.7 + wDist * 0.006, vec2(-0.9, 1.1))).g;
  float glit = pow(clamp(gl1 * gl2 * 3.0, 0.0, 1.0), 2.0) * (1.0 - farF);
  spec += Esun * lobe * glit * 6.0 * uLook2.w;
  spec = min(spec, vec3(3.0e4));

  col = mix(body, refl, F) + spec;

  // ------------------------------------------------ foam: crests + shore + surf lines
  float web = texture2D(tFoam, lay(vQ, 11.0, vec2(0.5, 0.0))).a;
  float web2 = texture2D(tFoam, layR(ROT2, vQ, 3.7, vec2(0.25, 0.0))).a;
  float patchN = texture2D(tWaves, layR(ROT1, vQ, 150.0, vec2(1.2, 0.0))).a;
  float crestF = smoothstep(0.62 - 0.25 * uLook2.w, 0.12, fold) * uLook.y * smoothstep(0.38, 0.62, patchN + web * 0.25);
  float foam = crestF * smoothstep(0.15, 0.6, web * 0.8 + web2 * 0.5);
  if (uHasScene > 0.5 && uLook2.y > 0.0){
    float n1 = texture2D(tWaves, lay(vQ, 57.0, vec2(0.3, 0.0))).a;
    float shoreD = min(depthBelow, rThick * 0.5);
    float edgeFoam = 1.0 - smoothstep(0.0, 0.35 + 0.9 * n1, shoreD);
    float n2 = texture2D(tWaves, layR(ROT1, vQ, 23.0, vec2(0.2, 0.0))).a;
    float ph = shoreD * 2.1 - uTime * 1.25 + n1 * 9.0;
    float lines = smoothstep(0.72, 0.97, sin(ph) * 0.5 + 0.5) * (1.0 - smoothstep(0.4, 3.6, shoreD))
                * smoothstep(0.35, 0.6, n2 + 0.25 * sin(floor(ph / RV_TAU) * 1.7 + n1 * 4.0));
    float surf = max(edgeFoam, lines * 0.85) * uLook2.y;
    foam = max(foam, surf * smoothstep(0.1, 0.55, web * 0.7 + web2 * 0.6 + edgeFoam * 0.3));
  }
  // breaking shore swell: white water on the crest front, trailing lace behind
  if (swellA > 0.0){
    float brk = smoothstep(0.45, 0.85, swellPr) * (1.0 - smoothstep(0.4, uShore.w * 0.38, bd.x)) * smoothstep(-0.2, 0.3, bd.x)
              * smoothstep(0.25, 0.65, swellVar + (web - 0.5) * 0.5);
    float lace = smoothstep(0.15, 0.4, swellPr) * (1.0 - smoothstep(0.3, 1.6, bd.x)) * 0.6;
    foam = max(foam, clamp(brk + lace, 0.0, 1.0) * smoothstep(0.12, 0.6, web * 0.75 + web2 * 0.55 + brk * 0.35) * min(swellA * 3.0, 1.0));
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
uniform float uRs, uCamDepth, uTime, uUnder;
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
  // in-scatter: integrate fog colour along the ray with depth-dependent light (analytic in 8 steps)
  vec3 Tr = exp(-uSigma * D * 0.85);
  vec3 acc = vec3(0.0);
  float jit = rv_ign(gl_FragCoord.xy + uTime * 60.0);
  const int STEPS = 10;
  float seg = min(D, 160.0) / float(STEPS);
  vec3 trAcc = vec3(1.0);
  float sunUp = max(dot(uUp, uL), 0.05);
  vec3 Lt = uL - uUp * dot(uL, uUp);
  for (int i = 0; i < STEPS; i++){
    float t = (float(i) + jit) * seg;
    vec3 p = dir * t;
    float z = max(uCamDepth - dot(p, uUp), 0.0);               // depth of the sample below the surface
    vec3 Ez = uEsun * exp(-uSigma * z / sunUp) ;
    // god rays: light through the wavy surface projected along the sun (shaft pattern)
    vec2 q = vec2(dot(p, uT1), dot(p, uT2)) + vec2(dot(Lt, uT1), dot(Lt, uT2)) * z / sunUp;
    float sh = texture2D(tFoam, lay(q, 23.0, vec2(0.6, 0.1))).r + texture2D(tFoam, lay(q.yx, 37.0, vec2(-0.4, 0.2))).g;
    float shaft = mix(1.0, 0.12 + 3.0 * sh * sh, exp(-z * 0.03));
    float phase = 0.25 + 0.75 * pow(max(dot(dir, uL), 0.0), 6.0);
    vec3 Ls = uScatter * (Ez * shaft * phase * 2.2 + uEamb * exp(-uSigma * z * 0.5)) / RV_PI + uGlow * 0.2;
    vec3 stepTr = exp(-uSigma * seg * 0.85);
    acc += trAcc * (1.0 - stepTr) * Ls;
    trAcc *= stepTr;
  }
  // beyond the marched span: constant fog of the deep
  vec3 far = uScatter * (uEsun * exp(-uSigma * (uCamDepth + 20.0) / sunUp) * 0.35 + uEamb * exp(-uSigma * uCamDepth * 0.5)) / RV_PI;
  acc += trAcc * (1.0 - exp(-uSigma * max(D - 160.0, 0.0) * 0.85)) * far;
  // seabed caustics (scene surfaces below the surface)
  if (D < 150.0){
    vec3 P = uCam + dir * D;
    float zb = uRs - length(P - uPC);
    if (zb > 0.1){
      vec3 rel = dir * D;
      vec2 qb = vec2(dot(rel, uT1), dot(rel, uT2)) - vec2(dot(Lt, uT1), dot(Lt, uT2)) * zb * 0.75 / sunUp;
      vec3 ca = texture2D(tFoam, lay(qb, 7.0, vec2(0.45, 0.1))).rgb;
      vec3 cb = texture2D(tFoam, lay(qb.yx, 9.3, vec2(0.35, -0.2))).rgb;
      float cf = (1.0 - smoothstep(4.0, 38.0, zb)) * smoothstep(0.1, 0.8, zb);
      col += col * (min(ca, cb) * 2.4 + (ca + cb) * 0.35) * 2.2 * cf * exp(-uSigma.g * zb * 0.4);
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
