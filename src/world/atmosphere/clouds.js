// Volumetric clouds (pipeline effect "clouds", order 110). OWNED BY THE ATMOSPHERE TRACK.
//
//  • One spherical cloud shell per planet [Rc0, Rc1] — the SAME march is used from the ground, from
//    altitude and from orbit (seamless). Shape = weather cube map (planet-wide coverage / tallness /
//    storm cells, drifting with the wind) × height profile per cloud type × tileable Perlin-Worley 3D
//    noise, eroded by Worley detail (Schneider / Nubis style).
//  • Lighting: sun (or moon at night) illuminance × atmospheric transmittance AT EACH SAMPLE (golden
//    and pink clouds at sunset, planet-shadowed clouds after dusk), Beer-powder, dual-lobe HG phase with
//    silver lining, 3-octave multiple-scattering approximation, sky ambient (top) + ground bounce
//    (bottom), energy-conserving integration (Hillaire 2016).
//  • Aerial perspective: distant clouds melt into the sky-view LUT color of their direction.
//  • Rendered at reduced resolution (tier), jittered, then depth-aware upsampled over the scene.
//  • Cloud shadow map: 2D transmittance map projected along the sun around the camera; consumed by
//    every patched material through the rv_cloudshadow chunk (world.lighting.uniforms).
//  • Low tier: 2-sample "slab" clouds (same shapes, much cheaper).
//
// Types (body.clouds.type / art.clouds): cumulus · stratus · wisp · storm · haze · fogsea · none.
import * as THREE from 'three';
import { fsMaterial, FSQuad, hdrTarget } from './fs.js';
import { registerChunk } from '../../shaders/chunks.js';
import { Params } from '../../core/Params.js';

const clamp = THREE.MathUtils.clamp;
// sky ambient on clouds: sky irradiance / π × this (thick-cloud albedo ≈ 0.8 plus a little art lift)
const AMBK = 1.1;

// ------------------------------------------------------------------ cloud type presets
// alt: base altitude × body.clouds.altitude · thick: m (× size) · dens: extinction (1/m) at density 1
// scale: base noise tile (m) · detail: detail tile (m) · erode: detail erosion · topMin: tallness range
// soft: base softness · anvil · stretch (cirrus streaks) · cover: coverage multiplier / add
export const CLOUD_TYPES = {
  cumulus: { alt: 1.0, thick: 1500, dens: 0.065, scale: 3600, detail: 1700, erode: 0.5, billow: 0.6, dome: 0.6, edge: 0.22, topMin: 0.45, soft: 0.08, topSoft: 0.55, anvil: 0.0, stretch: 0.0, coverMul: 1.0, coverAdd: 0.0, weatherFreq: 9, ambient: 1.0, lump: 0.10, grad: 0.62, baseMax: 2600, sunGain: 5.8, tupK: 0.07 },
  storm: { billow: 0.35, alt: 0.8, thick: 3800, dens: 0.07, dome: 0.2, edge: 0.18, scale: 6400, detail: 1000, erode: 0.4, topMin: 0.35, soft: 0.05, topSoft: 0.6, anvil: 0.9, stretch: 0.0, coverMul: 1.1, coverAdd: 0.1, weatherFreq: 6, ambient: 0.8, lump: 0.22, grad: 0.75, baseMax: 1500, sunGain: 4.2, tupK: 0.05 },
  stratus: { billow: 0.12, alt: 0.75, thick: 800, dens: 0.035, scale: 7000, detail: 1100, erode: 0.4, topMin: 0.7, soft: 0.18, topSoft: 0.72, anvil: 0.0, stretch: 0.4, coverMul: 1.05, coverAdd: 0.18, weatherFreq: 4, ambient: 1.1, lump: 0.42, grad: 0.7, baseMax: 2400, sunGain: 4.2, tupK: 0.05 },
  wisp: { alt: 2.3, thick: 450, dens: 0.012, scale: 7000, detail: 1200, erode: 0.5, topMin: 0.8, soft: 0.3, topSoft: 0.3, anvil: 0.0, stretch: 0.85, coverMul: 0.9, coverAdd: 0.05, weatherFreq: 7, ambient: 1.2, lump: 0.1, grad: 1.0, baseMax: 1e9, sunGain: 3.4, tupK: 0.04 },
  haze: { alt: 1.6, thick: 1100, dens: 0.008, scale: 11000, detail: 2000, erode: 0.2, topMin: 0.8, soft: 0.4, topSoft: 0.4, anvil: 0.0, stretch: 0.6, coverMul: 0.8, coverAdd: 0.25, weatherFreq: 3, ambient: 1.3, lump: 0.05, grad: 1.0, baseMax: 1e9, sunGain: 3.0, tupK: 0.03 },
  fogsea: { billow: 0.3, alt: 0.0, thick: 760, dens: 0.04, scale: 2800, detail: 520, erode: 0.34, topMin: 0.6, soft: 0.02, topSoft: 0.86, dome: 0.25, anvil: 0.0, stretch: 0.15, coverMul: 1.2, coverAdd: 0.35, weatherFreq: 5, ambient: 1.0, lump: 0.62, grad: 0.75, baseMax: 1e9, sunGain: 5.0, tupK: 0.05, edge: 0.18 },
};

// ------------------------------------------------------------------ GLSL
registerChunk('rv_cloud_noise', /* glsl */`
#ifndef RV_CLOUD_NOISE
#define RV_CLOUD_NOISE
// tileable gradient noise & Worley on the unit cube (period = freq)
vec3 cn_hash(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float cn_perlin(vec3 p, float freq){
  vec3 q = p * freq; vec3 i = floor(q); vec3 f = fract(q);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n[8];
  for (int k = 0; k < 8; k++){
    vec3 o = vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    vec3 g = cn_hash(mod(i + o, freq) + 0.37) * 2.0 - 1.0;
    n[k] = dot(normalize(g + 1e-5), f - o);
  }
  float x00 = mix(n[0], n[1], u.x), x10 = mix(n[2], n[3], u.x), x01 = mix(n[4], n[5], u.x), x11 = mix(n[6], n[7], u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}
float cn_worley(vec3 p, float freq){
  vec3 q = p * freq; vec3 i = floor(q); vec3 f = fract(q);
  float md = 1.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 h = cn_hash(mod(i + o, freq));
    vec3 d = o + h - f;
    md = min(md, dot(d, d));
  }
  return 1.0 - sqrt(md);
}
float cn_worleyFbm(vec3 p, float freq){
  return cn_worley(p, freq) * 0.625 + cn_worley(p, freq * 2.0) * 0.25 + cn_worley(p, freq * 4.0) * 0.125;
}
float cn_perlinFbm(vec3 p, float freq){
  float s = 0.0, a = 1.0, w = 0.0;
  for (int o = 0; o < 4; o++){ s += cn_perlin(p, freq) * a; w += a; a *= 0.5; freq *= 2.0; }
  return s / w;
}
#endif
`);

const NOISE_FRAG = /* glsl */`
#include <rv_cloud_noise>
uniform float uLayer;
uniform float uSize;
varying vec2 vUv;
float remap(float x, float a, float b, float c, float d){ return c + (x - a) * (d - c) / (b - a); }
void main(){
  vec3 p = vec3(vUv, (uLayer + 0.5) / uSize);
  float pf = cn_perlinFbm(p, 4.0) * 0.5 + 0.5;
  float wf = cn_worleyFbm(p, 4.0);
  // Perlin-Worley: billowy, connected
  float pw = clamp(remap(pf, 0.0, 1.0, wf, 1.0), 0.0, 1.0);
  gl_FragColor = vec4(pw, cn_worleyFbm(p, 8.0), cn_worleyFbm(p, 16.0), cn_worleyFbm(p, 24.0));
}`;

const WEATHER_VERT = /* glsl */`
varying vec3 vDir;
void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const WEATHER_FRAG = /* glsl */`
#include <rv_common>
#include <rv_noise>
uniform vec3 uSeed;
uniform float uCoverage;   // global mean coverage 0..1
uniform float uFreq;
uniform float uStorms;     // storm cell amount 0..1
uniform float uStretch;
uniform vec4 uCyc[5];      // cyclones / weather systems: centre (unit dir), swirl (rad, signed by hemisphere)
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  // weather systems: the lookup is twisted around each centre (twist decays with distance) → spiral bands
  float cyc = 0.0, eye = 0.0;
  for (int k = 0; k < 5; k++){
    vec3 c = uCyc[k].xyz;
    float a2 = max(0.0, 2.0 - 2.0 * dot(d, c));          // ≈ angular distance²
    float fall = exp(-a2 / 0.07);
    float ang = uCyc[k].w * fall;
    d = normalize(d * cos(ang) + cross(c, d) * sin(ang) + c * dot(c, d) * (1.0 - cos(ang)));
    cyc = max(cyc, fall * smoothstep(1.5, 5.0, abs(uCyc[k].w)));
    eye = max(eye, exp(-a2 / 0.0008) * smoothstep(4.0, 6.0, abs(uCyc[k].w)));
  }
  // streaky fields (stratus / cirrus bands) stretched along latitude
  vec3 q = d * uFreq;
  q.y *= mix(1.0, 2.6, uStretch);
  vec3 w = vec3(rv_snoise(q * 0.5 + uSeed), rv_snoise(q * 0.5 + uSeed.yzx + 7.1), rv_snoise(q * 0.5 + uSeed.zxy - 3.3));
  q += w * 0.9;
  float n = rv_fbm(q + uSeed, 5) * 0.5 + 0.5;
  // clear gaps between cloud fields; body coverage 0.15–0.7 → mostly broken skies
  // large weather systems (fronts / cyclones, visible from orbit) × regional cloud fields
  vec3 db = d * 2.2 + uSeed.zxy * 0.3;
  db += 0.35 * vec3(rv_snoise(db * 1.3 + 4.0), rv_snoise(db * 1.3 + 9.0), rv_snoise(db * 1.3 + 13.0));
  float big = rv_fbm(db, 3) * 0.5 + 0.5;
  float cov = clamp(uCoverage * 0.55 + (big - 0.5) * 1.2 + (n - 0.5) * 1.7 + cyc * 0.35 - eye, 0.0, 1.0);
  float tall = clamp(rv_fbm(q * 1.7 + uSeed.zyx + 11.0, 3) * 0.7 + 0.5, 0.0, 1.0);
  float storm = uStorms * smoothstep(0.62, 0.8, rv_fbm(d * uFreq * 0.6 + uSeed.yxz + 21.0, 3) * 0.5 + 0.5);
  cov = max(cov, storm);
  tall = max(tall, storm);
  // orbit detail: convective cells (Worley puffs) + streaks, used where the 3D noise tile is too small
  vec3 dq = d * uFreq * 2.6 + uSeed * 1.3;
  dq.y *= mix(1.0, 1.8, uStretch);
  dq += 0.6 * vec3(rv_snoise(dq * 0.4), rv_snoise(dq * 0.4 + 5.0), rv_snoise(dq * 0.4 + 9.0));
  vec2 wo = rv_worley(dq), wo2 = rv_worley(dq * 2.7 + 3.0);
  // round convective cells (inverted F1, squared → discs, no Voronoi polygons) over warped fbm
  float c1 = 1.0 - wo.x, c2 = 1.0 - wo2.x;
  // cell strength varies regionally (popcorn fields here, smooth stratiform sheets there): no regular scales
  float cellAmt = smoothstep(0.35, 0.75, rv_fbm(dq * 0.23 + 17.0, 2) * 0.5 + 0.5);
  float fb = rv_fbm(dq * 1.7, 4) * 0.5 + 0.5;
  float det = clamp(mix(fb * 0.85 + 0.05, c1 * c1 * 0.45 + c2 * c2 * 0.25 + fb * 0.4, cellAmt), 0.0, 1.0);
  gl_FragColor = vec4(cov, tall, storm, det);
}`;

// Shared cloud density / lighting code
registerChunk('rv_cloud', /* glsl */`
#ifndef RV_CLOUD
#define RV_CLOUD
uniform sampler3D uNoise;
uniform samplerCube uWeather;
uniform mat3 uWeatherRot;
uniform vec4 uLayer;       // Rc0, Rc1, 1/thickness, max march distance
uniform vec4 uShape;       // 1/baseTile, 1/detailTile, erosion, extinction (1/m)
uniform vec4 uShape2;      // topMin, baseSoft, topSoft, anvil
uniform vec4 uShape3;      // coverMul, coverAdd, stretch, ambient scale
uniform vec3 uWindA;       // base noise offset (texture units)
uniform vec3 uWindB;       // detail noise offset (texture units)
uniform vec3 uWindDirC;    // wind direction (for cirrus streaks)
uniform float uCoverBoost; // weather state (rain/storm) coverage boost

uniform vec4 uShape4;      // lumpiness (base/top height noise), bottom density factor, orbit LOD start, LOD end (m)
uniform vec4 uShape5;      // key-light gain, column-shadow strength, far-field noise scale (1/m), dome (rounded tops)
uniform vec4 uShape6;      // far-field extinction factor, detail fade start (m), end (m), edge sharpness
uniform vec4 uShape7;      // billow (cauliflower lumps: coverage threshold follows the Worley cells), -, -, -

// distance LOD: far away (orbit) the tileable noise averages out and the weather map carries the shape
float cl_lod = 0.0;
// detail LOD: the erosion noise is band-limited with distance (no salt-and-pepper aliasing far away)
float cl_dlod = 0.0;

float cl_remap(float x, float a, float b, float c, float d){ return c + (x - a) * (d - c) / max(b - a, 1e-4); }

vec4 cl_weather(vec3 p){ return texture(uWeather, uWeatherRot * p); }

// base density (no detail) at planet-local position p with normalized layer height h
float cl_base(vec3 p, float h, vec4 wx, out float prof){
  float cover = clamp(wx.r * uShape3.x + uShape3.y + uCoverBoost, 0.0, 1.0);
  float top = mix(uShape2.x, 1.0, wx.g);
  // conservative early-out before the noise fetch (the lumpy profile moves by at most lump/2)
  float hl = uShape4.x * 0.5 * (1.0 - cl_lod);
  if (cover < 0.01 || h < -hl || h > top + hl){ prof = 0.0; return 0.0; }
  vec3 q = p * uShape.x;
  if (uShape3.z > 0.0) q -= uWindDirC * dot(q, uWindDirC) * uShape3.z;
  // domain warp (curl-like): billows roll into each other instead of sitting on a lattice of blobs
  vec4 wq = texture(uNoise, q * 0.37 + uWindA * 0.5 + 0.21);
  q += (wq.gba - 0.5) * 0.16;
  vec4 n = texture(uNoise, q + uWindA);
  float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  // lumpy bases and tops: the layer boundaries follow the low-frequency Worley field
  float hp = h + (fbm - 0.5) * uShape4.x * (1.0 - cl_lod);
  // far away (orbit) the profile is rounder: no vertical cloud walls at grazing angles near the limb
  prof = smoothstep(0.0, uShape2.y + 0.25 * cl_lod, hp) * (1.0 - smoothstep(top * mix(uShape2.z, 0.15, cl_lod), top, hp));
  // dome: density tapers toward the cloud's own top → rounded domes over flat bases (cumulus)
  prof *= 1.0 - uShape5.w * smoothstep(0.25, 1.0, hp / max(top, 0.05)) * (1.0 - cl_lod);
  // anvil: storms spread out near the top
  cover = pow(cover, cl_remap(clamp(h, 0.65, 0.9), 0.65, 0.9, 1.0, mix(1.0, 0.35, uShape2.w * wx.b)));
  if (prof * cover < 0.01) return 0.0;
  float base = cl_remap(n.r, -(1.0 - fbm), 1.0, 0.0, 1.0);
  if (cl_lod > 0.0){
    // far field (altitude / orbit): the weather map's cells + the 3D noise at two incommensurate, rotated
    // planet scales (no visible tiling), curl-warped → fractal cloud fields, popcorn cumulus, fibrous
    // frontal edges and swirls
    vec3 pf = p * uShape5.z;
    vec3 wf = texture(uNoise, pf * 0.29 + 0.53).gba - 0.5;
    pf += wf * 0.55;
    float f1 = texture(uNoise, pf + uWindA * 0.25).r;
    float f2 = texture(uNoise, mat3(0.8, -0.36, 0.48, 0.6, 0.48, -0.64, 0.0, 0.8, 0.6) * pf * 3.71 + 0.37).g;
    float far = clamp(wx.a * 0.55 + (f1 - 0.5) * 0.6 + (f2 - 0.45) * 0.3 + 0.16, 0.0, 1.0);
    // dense cores tower, thin fields stay low: relief that self-shadows under a grazing sun (terminator)
    float topF = top * mix(0.6, 1.0, smoothstep(0.25, 0.75, far));
    float profF = smoothstep(0.0, uShape2.y + 0.25, hp) * (1.0 - smoothstep(topF * 0.2, topF, hp));
    base = mix(base, far, cl_lod);
    prof = mix(prof, profF, cl_lod);
  }
  // soft coverage remap (no binary threshold): far away the edge widens further → translucent fringes
  // cauliflower lumps (~1/5 of a cloud): the coverage threshold rises toward the borders of the base
  // Worley cells and drops in their cores → clusters of rounded towers instead of one smooth blob that
  // follows the weather-map contour
  float thr = 1.0 - cover + uShape7.x * (1.0 - cl_lod) * (0.62 - n.g), xb = base * prof;
  float lin = max(cl_remap(xb, thr, 1.0, 0.0, 1.0), 0.0);
  float soft = cl_lod > 0.0 ? smoothstep(thr - 0.25, thr + 0.2, xb) * max(cl_remap(xb, thr - 0.25, 1.0, 0.0, 1.0), 0.0) : 0.0;
  base = mix(lin, soft, cl_lod) * cover;
  // denser toward the top (wispy, translucent bases; bright, solid tops)
  base *= mix(uShape4.y, 1.0, smoothstep(0.0, 0.65, h));
  return max(base, 0.0);
}
float cl_densityW(vec3 p, float h, bool detail, out vec4 wx){
  wx = cl_weather(p);
  float prof;
  float b = cl_base(p, h, wx, prof);
  if (b <= 0.0) return 0.0;
  float b0 = b;
  if (detail && cl_lod < 0.99 && cl_dlod < 0.99){
    vec3 q = p * uShape.y;
    if (uShape3.z > 0.0) q -= uWindDirC * dot(q, uWindDirC) * uShape3.z;
    vec4 d = texture(uNoise, q + uWindB);
    // octaves fade out with distance before they alias (pixel footprint > noise feature): the finest go first
    float k2 = clamp(1.0 - cl_dlod * 2.5, 0.0, 1.0), k1 = clamp(1.0 - cl_dlod * 1.4, 0.0, 1.0);
    // second, finer octave (curl-like offset by the first) → cauliflower edges instead of smooth blobs
#ifdef CL_HQ
    // billow octaves (Worley 8/16/24 per tile) + a finer, curl-offset octave at reduced weight (crisp
    // cauliflower rims, not fur)
    float dn = d.g * 0.7 + mix(0.5, d.b, k1) * 0.22 + mix(0.5, d.a, k2) * 0.08;
#else
    float dn = d.g * 0.625 + mix(0.5, d.b, k1) * 0.25 + mix(0.5, d.a, k2) * 0.125;
#endif
    dn = mix(dn, 0.5, cl_dlod);
    float m = mix(dn, 1.0 - dn, clamp(h * 4.0, 0.0, 1.0));   // wispy bases, billowy tops
    b = cl_remap(b, m * uShape.z * (1.0 - cl_lod), 1.0, 0.0, 1.0);
  }
  // sharper density-to-edge transition: a cloud surface instead of a gaussian puff (thin fringe kept)
  b = max(b, 0.0);
  b *= mix(1.0, smoothstep(0.0, uShape6.w, b), 1.0 - cl_lod);
  // no detached specks: where the base shape is nearly empty the erosion may not leave isolated bits
  b *= mix(1.0, smoothstep(0.03, 0.12, b0), 1.0 - cl_lod);
  // storms are denser & darker
  return max(b, 0.0) * (1.0 + wx.b * 1.5);
}
float cl_density(vec3 p, float h, bool detail){ vec4 wx; return cl_densityW(p, h, detail, wx); }
float cl_hg(float c, float g){ float g2 = g * g; return (1.0 - g2) / (12.5663706 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
#endif
`);

const MARCH_FRAG = /* glsl */`
#include <rv_common>
#include <rv_atmo>
#include <rv_atmo_sky>
#include <rv_atmo_view>
#include <rv_cloud>
uniform sampler2D tDepth;
uniform vec3 uCamPlanet;
uniform vec3 uSunDir;
uniform vec3 uSunIllSky;
uniform vec3 uLightDir;      // key light for clouds (sun, or moon at night)
uniform vec3 uLightIll;      // its top-of-atmosphere illuminance
uniform vec3 uAmbTop;        // sky irradiance / 4π-ish radiance on cloud tops
uniform vec3 uAmbBot;        // ground bounce
uniform vec3 uAmbRef;        // top ambient for a reference sun (per-sample daylight scaling, orbit)
uniform float uAmbLocal;     // 1: use the camera-local ambient (inside the atmosphere)
uniform vec4 uFlash;         // lightning: planet-local position (xyz), intensity (w)
uniform float uAPScale;      // aerial perspective density scale (shared with the atmosphere pass)
uniform float uSteps;
uniform float uLightSteps;
uniform float uFrameJitter;
uniform float uInside;       // camera inside the atmosphere (sky LUT valid)
uniform vec2 uLowRes;
uniform vec3 uAmbNight;      // moon / starlight fill on the night side (seen from altitude / orbit)
uniform vec4 uCirrus;        // high ice layer: radius (m), opacity, 1/tile (1/m), stretch along the wind
varying vec2 vUv;

// High cirrus / cirrostratus sheet (thin ice, 2D): fibrous streaks stretched along the wind, forward-
// scattering halo around the sun. Returns radiance (rgb) and opacity (a).
vec4 cirrusLayer(vec3 ro, vec3 dir, float tHit, float camR){
  if (uCirrus.y <= 0.0) return vec4(0.0);
  vec2 sc = atmo_raySphere(ro, dir, uCirrus.x);
  float t = camR < uCirrus.x ? sc.y : sc.x;
  if (t <= 0.0 || t > tHit) return vec4(0.0);
  if (camR < uCirrus.x){ vec2 g = atmo_raySphere(ro, dir, uAtmoRb); if (g.x > 0.0) return vec4(0.0); }
  vec3 p = ro + dir * t;
  vec3 n = normalize(p);
  vec3 q = p * uCirrus.z;
  q -= uWindDirC * dot(q, uWindDirC) * uCirrus.w;            // streaks along the wind
  vec4 a = texture(uNoise, q * 0.31 + uWindA * 0.3);
  q += (a.gba - 0.5) * 0.2;                                  // gentle swirls
  vec4 b = texture(uNoise, q + uWindB * 0.4);
  // patches: the planet weather field at a decorrelated (swizzled) direction → ~25 % of the sky, broad rafts
  float big = smoothstep(0.5, 0.78, texture(uWeather, uWeatherRot * n.zxy).r * 0.6 + a.r * 0.4);
  // altocumulus cells (inverted Worley ~400 m) bound into rafts by the perlin-worley base
  float cells = 1.0 - b.a;
  float d = big * smoothstep(0.42, 0.72, cells * 0.55 + b.r * 0.45 + (big - 0.5) * 0.2);
  // grazing views from far away: thinner (aerial perspective takes them), and no layer edge artifacts
  d *= exp(-t / (uLayer.w * 2.2));
  float alpha = d * uCirrus.y * (1.0 - 0.85 * smoothstep(uAtmoRt - uAtmoRb, (uAtmoRt - uAtmoRb) * 3.0, camR - uAtmoRb));
  if (alpha < 0.002) return vec4(0.0);
  float muS = dot(n, uLightDir);
  vec3 sunT = atmo_sunTransmittance(length(p), muS) * uLightIll;
  float nu = dot(dir, uLightDir);
  float ph = min(cl_hg(nu, 0.6), 0.6) * 0.3 + cl_hg(nu, -0.2) * 0.25 + 0.06;
  vec3 Lc = sunT * ph * 1.4 + uAmbTop * mix(1.0, 0.0, 1.0 - uAmbLocal) + uAmbRef * smoothstep(-0.1, 0.3, muS) * (1.0 - uAmbLocal) + uAmbNight;
  return vec4(Lc * alpha, alpha);
}

void main(){
  float depth = texture(tDepth, vUv).r;
  vec3 vd = atmo_viewDir(vUv);
  vec3 dir = normalize(mat3(uCamWorld) * vd);
  float tHit = atmo_isFar(depth) ? 1e30 : atmo_depthToDist(depth, vd);
  vec3 ro = uCamPlanet;
  float camR = length(ro);
  float Rc0 = uLayer.x, Rc1 = uLayer.y;
  vec2 inner = atmo_raySphere(ro, dir, Rc0);
  vec2 outer = atmo_raySphere(ro, dir, Rc1);
  vec2 gnd = atmo_raySphere(ro, dir, uAtmoRb);
  float t0, t1;
  bool skip = false;
  if (outer.y <= 0.0) skip = true;
  else if (camR < Rc0){
    if (gnd.x > 0.0) skip = true;
    t0 = inner.y; t1 = outer.y;
  } else if (camR < Rc1){
    t0 = 0.0; t1 = inner.x > 0.0 ? inner.x : outer.y;
  } else {
    t0 = outer.x; t1 = inner.x > 0.0 ? inner.x : outer.y;
  }
  if (!skip){
    t1 = min(t1, tHit);
    t1 = min(t1, t0 + uLayer.w);
    if (t1 <= t0) skip = true;
  }
  if (skip){
    vec4 ci = cirrusLayer(ro, dir, tHit, camR);
    gl_FragColor = vec4(ci.rgb, 1.0 - ci.a);
    return;
  }

  float len = t1 - t0;
  float thick = Rc1 - Rc0;
  float steps = clamp(uSteps * (0.35 + 0.65 * clamp(len / (thick * 3.0), 0.0, 1.0)), 8.0, uSteps);
  float dt = len / steps;
  float jit = rv_ign(gl_FragCoord.xy + 5.588238 * uFrameJitter);
  float nu = dot(dir, uLightDir);
  // dual-lobe HG + silver lining (strong forward peak), mixed per octave below
  float phS = cl_hg(nu, 0.9);
  float sigma = uShape.w;
  vec3 L = vec3(0.0);
  float T = 1.0;
  float tSum = 0.0, wSum = 0.0;
  float lightStep = thick * 0.06;
  float sharpEnd = t0 + uLayer.w;
  // view-dependent powder (Schneider): dark sun-facing edges seen from the anti-sun side, none toward the sun
  float powderAmt = 0.75 * clamp(0.6 - 0.6 * nu, 0.0, 1.0);
  for (int i = 0; i < 128; i++){
    if (float(i) >= steps || T < 0.01) break;
    float t = t0 + (float(i) + jit) * dt;
    vec3 p = ro + dir * t;
    float r = length(p);
    float h = (r - Rc0) / thick;
    if (h < 0.0 || h > 1.0) continue;
    // distance LOD (orbit): noise tile averages out, the weather map carries the shapes
    cl_lod = smoothstep(uShape4.z, uShape4.w, t);
    cl_dlod = smoothstep(uShape6.y, uShape6.z, t);
    vec4 wxs;
    float dens = cl_densityW(p, h, true, wxs);
    if (dens <= 0.001) continue;
    // soft contact with terrain (no cut-out where a cloud meets a ridge) and with the march range end
    if (tHit < 1e29) dens *= clamp((tHit - t) / min(260.0, 0.2 * tHit + 1.0), 0.0, 1.0);
    dens *= 1.0 - smoothstep(sharpEnd - uLayer.w * 0.25, sharpEnd, t);
    vec3 n = p / r;
    // far field: lower extinction → thin cloud fields are translucent (soft fringes from orbit, no
    // cut-out patches), dense cores stay opaque
    float sg = sigma * mix(1.0, uShape6.x, cl_lod);
    float s = dens * sg;
    // --- light march toward the key light (cone of growing steps; the last one reaches far towers)
    float od = 0.0;
    float ls = lightStep * (1.0 + 1.5 * cl_lod);
    vec3 lp = p;
    for (int j = 0; j < 6; j++){
      if (float(j) >= uLightSteps) break;
      lp += uLightDir * ls;
      float lr = length(lp);
      float lh = (lr - Rc0) / thick;
      if (lh > 1.0 || lh < 0.0) break;
      od += cl_density(lp, lh, j < 2) * ls;
      ls *= 1.9;
    }
    od *= sg;
    // --- optical depth of the column above (ambient occlusion from the sky, diffuse transmission)
    float odUp = 0.0;
    if (h < 0.9){
      float span = (1.0 - h) * thick;
      float hu1 = h + (1.0 - h) * 0.3, hu2 = h + (1.0 - h) * 0.7;
#ifdef CL_HQ
      odUp = (cl_density(p + n * span * 0.3, hu1, false) * 0.5 + cl_density(p + n * span * 0.7, hu2, false) * 0.5) * span * sigma * 0.6;
#else
      odUp = cl_density(p + n * span * 0.45, h + (1.0 - h) * 0.45, false) * span * sigma * 0.6;
#endif
    }
    float muS = dot(n, uLightDir);
    vec3 sunT = atmo_sunTransmittance(r, muS) * uLightIll;
    // multiply-scattered light has travelled through cloud (white droplets): less of the low-sun tint
    vec3 sunTd = mix(sunT, vec3(dot(sunT, vec3(0.2126, 0.7152, 0.0722))), 0.45);
    // multiple-scattering octaves (Wrenninge): energy a, extinction b, anisotropy c
    float lum = 0.0, lumMS = 0.0, a = 1.0, b = 1.0, c = 1.0;
    for (int o = 0; o < 4; o++){
      float ph = mix(mix(cl_hg(nu, 0.8 * c), cl_hg(nu, -0.3 * c), 0.25), phS, 0.1 * c);
      float v = a * ph * exp(-od * b);
      if (o == 0) lum += v; else lumMS += v;
      a *= 0.5; b *= 0.35; c *= 0.5;
    }
    float powder = mix(1.0, 1.0 - exp(-2.0 * od - s * 90.0), powderAmt);
    // soft-limit the forward (silver-lining) peak: the art gain lifts the sunlit sides; without the limit
    // thin edges next to the sun reach ~100× sky radiance and bloom into a white veil over the frame
    lum = lum / (1.0 + lum * 2.2);
    lumMS = lumMS / (1.0 + lumMS * 2.2);
    // diffuse transmission through the column above (thick decks: mottled, darker where thicker)
    float Tup = 1.0 / (1.0 + uShape5.y * odUp);
    float day = smoothstep(-0.12, 0.3, muS) * (0.35 + 0.65 * clamp(muS, 0.0, 1.0)) / 0.805;
    vec3 aTop = mix(uAmbRef * day + uAmbNight, uAmbTop, uAmbLocal);
    vec3 aBot = mix(uAmbRef * day * 0.5, uAmbBot, uAmbLocal);
    float hk = clamp(h * 1.25, 0.0, 1.0);
    vec3 amb = (aTop * hk * mix(0.12, 1.0, Tup) + aBot * (1.0 - hk) * mix(0.2, 1.0, Tup)) * uShape3.w;
    // overcast / storm: light reaching the base is diffused through the deck → neutral grey, darker
    float oc = clamp(max((wxs.r * uShape3.x + uShape3.y + uCoverBoost) * 1.4 - 0.5, uCoverBoost * 2.2), 0.0, 1.0);
    float ocb = oc * (1.0 - 0.6 * h);
    amb = mix(amb, vec3(dot(amb, vec3(0.2126, 0.7152, 0.0722))) * 0.85, ocb * 0.9) * (1.0 - 0.3 * ocb) * (1.0 - 0.5 * wxs.b * (1.0 - h));
    // key light: truncated octave series (thick clouds reflect ~75%: art gain) + diffuse transmission
    vec3 S = ((sunT * lum + sunTd * lumMS) * powder * uShape5.x + sunTd * (max(muS, 0.0) * Tup * 0.05 * (1.0 - exp(-od * 0.5))) + amb) * s;
    if (uFlash.w > 0.001){ vec3 fd = p - uFlash.xyz; float fr = min(thick, 2200.0); S += vec3(0.75, 0.82, 1.0) * uFlash.w * 30.0 * exp(-dot(fd, fd) / (fr * fr * 1.5)) * s; }
    float Ts = exp(-s * dt);
    L += T * (S - S * Ts) / max(s, 1e-7);
    tSum += t * T * (1.0 - Ts); wSum += T * (1.0 - Ts);
    T *= Ts;
  }
  // (cirrus is composited after the aerial perspective of the cumulus layer, see below)
  float alpha = 1.0 - T;
  if (alpha > 0.002){
    // aerial perspective: fade toward the sky radiance of this direction with distance
    float dist = tSum / max(wSum, 1e-6);
    vec3 p1 = ro + dir * dist;
    float r1 = length(p1);
    // transmittance camera → cloud from the (sun-path) LUT ratio, undoing the sunset reddening power
    vec2 ta = atmo_raySphere(ro, dir, uAtmoRt);
    vec3 pa = ro + dir * max(ta.x, 0.0);
    vec3 Tair = mix(vec3(1.0), pow(atmo_transSegment(pa, p1), vec3(uAPScale)), 0.85);
    vec3 skyL = vec3(0.0);
    if (uInside > 0.5) skyL = atmo_skyLUT(dir, ro / camR, camR, uSunDir, dot(dir, uSunDir)) * uSunIllSky;
    L = L * Tair + skyL * (1.0 - Tair) * alpha;
  }
  // high cirrus: above the cumulus deck (behind it from below, in front of it from above)
  vec4 ci = cirrusLayer(ro, dir, tHit, camR);
  if (ci.a > 0.0){
    if (camR < uCirrus.x){ L += T * ci.rgb; T *= 1.0 - ci.a; }
    else { L = ci.rgb + (1.0 - ci.a) * L; T *= 1.0 - ci.a; }
  }
  gl_FragColor = vec4(L, T);
}`;

const LOW_FRAG = /* glsl */`
#include <rv_common>
#include <rv_atmo>
#include <rv_atmo_sky>
#include <rv_atmo_view>
#include <rv_cloud>
uniform sampler2D tDepth;
uniform vec3 uCamPlanet;
uniform vec3 uSunDir;
uniform vec3 uSunIllSky;
uniform vec3 uLightDir;
uniform vec3 uLightIll;
uniform vec3 uAmbTop;
uniform vec3 uAmbBot;
uniform float uInside;
uniform float uAPScale;
varying vec2 vUv;
void main(){
  float depth = texture(tDepth, vUv).r;
  vec3 vd = atmo_viewDir(vUv);
  vec3 dir = normalize(mat3(uCamWorld) * vd);
  float tHit = atmo_isFar(depth) ? 1e30 : atmo_depthToDist(depth, vd);
  vec3 ro = uCamPlanet;
  float camR = length(ro);
  float thick = uLayer.y - uLayer.x;
  float Rm = uLayer.x + thick * 0.45;
  vec2 s = atmo_raySphere(ro, dir, Rm);
  float t = camR < Rm ? s.y : s.x;
  vec2 gnd = atmo_raySphere(ro, dir, uAtmoRb);
  if (t <= 0.0 || t > tHit || (camR < Rm && gnd.x > 0.0) || t > uLayer.w * 2.0){ gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 p = ro + dir * t;
  float r = length(p);
  vec3 n = p / r;
  cl_lod = smoothstep(uShape4.z, uShape4.w, t);
  float er = uShape.z * 0.35 * (1.0 - cl_lod);
  float d0 = max(cl_density(p, 0.3, false) - er, 0.0) + max(cl_density(p + dir * thick * 0.3, 0.55, false) - er, 0.0);
  float d1 = max(cl_density(p + uLightDir * thick * 0.25, 0.6, false) - er, 0.0);
  float path = thick * 0.5 / max(abs(dot(dir, n)), 0.15);
  float sigma = uShape.w;
  float T = exp(-d0 * sigma * path * 0.12);
  float od = d1 * sigma * thick * 0.5;
  float nu = dot(dir, uLightDir);
  float ph = mix(cl_hg(nu, 0.7), cl_hg(nu, -0.2), 0.3);
  vec3 sunT = atmo_sunTransmittance(r, dot(n, uLightDir)) * uLightIll;
  vec3 sunTd = mix(sunT, vec3(dot(sunT, vec3(0.2126, 0.7152, 0.0722))), 0.45);
  vec3 Lc = sunT * exp(-od) * (ph / (1.0 + ph * 2.2)) * 3.2 + sunTd * (exp(-od * 0.25) * 0.12 + exp(-od * 0.08) * 0.16) + mix(uAmbBot, uAmbTop, 0.6) * uShape3.w;
  vec3 L = Lc * (1.0 - T);
  vec2 ta = atmo_raySphere(ro, dir, uAtmoRt);
  vec3 Tair = mix(vec3(1.0), pow(atmo_transSegment(ro + dir * max(ta.x, 0.0), p), vec3(uAPScale)), 0.85);
  vec3 skyL = uInside > 0.5 ? atmo_skyLUT(dir, ro / camR, camR, uSunDir, dot(dir, uSunDir)) * uSunIllSky : vec3(0.0);
  L = L * Tair + skyL * (1.0 - Tair) * (1.0 - T);
  gl_FragColor = vec4(L, T);
}`;

const COMPOSITE_FRAG = /* glsl */`
#include <rv_common>
#include <rv_atmo_view>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tClouds;
uniform vec2 uLowRes;
varying vec2 vUv;
float linDist(vec2 uv){
  float d = texture(tDepth, uv).r;
  if (atmo_isFar(d)) return 1e9;
  return atmo_depthToDist(d, atmo_viewDir(uv));
}
void main(){
  vec3 col = texture(tColor, vUv).rgb;
  float dz = linDist(vUv);
  // depth-aware 4-tap upsample (plus a small tent to hide jitter noise)
  vec2 st = vUv * uLowRes - 0.5;
  vec2 i0 = floor(st);
  vec2 f = st - i0;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int k = 0; k < 9; k++){
    vec2 o = vec2(float(k % 3) - 0.5, float(k / 3) - 0.5);
    vec2 uv = (i0 + o + 0.5) / uLowRes;
    vec2 dd = abs(o - f);
    float wb = max(0.0, 1.05 - dd.x) * max(0.0, 1.05 - dd.y);
    float z = linDist(uv);
    float wz = 1.0 / (1e-3 + abs(log(max(z, 1e-3)) - log(max(dz, 1e-3))) * 12.0);
    float w = wb * wz;
    acc += texture(tClouds, uv) * w;
    wsum += w;
  }
  vec4 c = wsum > 0.0 ? acc / wsum : vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragColor = vec4(col * c.a + c.rgb, 1.0);
}`;

const SHADOW_FRAG = /* glsl */`
#include <rv_atmo>
#include <rv_cloud>
uniform vec3 uCamPlanet;
uniform vec3 uE1;
uniform vec3 uE2;
uniform vec3 uLightDir;
uniform float uSize;
varying vec2 vUv;
void main(){
  vec3 P = uCamPlanet + (uE1 * (vUv.x - 0.5) + uE2 * (vUv.y - 0.5)) * uSize;
  vec3 ro = P - uLightDir * 30000.0;
  vec2 g = atmo_raySphere(ro, uLightDir, uAtmoRb);
  float ts = g.y > 0.0 ? g.y : 0.0;
  vec2 inner = atmo_raySphere(ro, uLightDir, uLayer.x);
  vec2 outer = atmo_raySphere(ro, uLightDir, uLayer.y);
  float a = max(ts, max(inner.y, 0.0));
  float b = outer.y;
  float od = 0.0;
  if (b > a){
    float thick = uLayer.y - uLayer.x;
    b = min(b, a + thick * 6.0);
    const float N = 10.0;
    float dt = (b - a) / N;
    for (float i = 0.0; i < N; i += 1.0){
      vec3 p = ro + uLightDir * (a + (i + 0.5) * dt);
      float r = length(p);
      float h = (r - uLayer.x) / thick;
      if (h < 0.0 || h > 1.0) continue;
      // base shape minus the average detail erosion (the shadow pass skips the detail fetch)
      od += max(cl_density(p, h, false) - uShape.z * 0.35, 0.0) * dt;
    }
  }
  float T = exp(-od * uShape.w * 0.3);
  gl_FragColor = vec4(T, T, T, 1.0);
}`;

export class Clouds {
  constructor(atmo) {
    this.atmo = atmo;
    const w = atmo.world, body = w.body, q = w.quality;
    this.world = w;
    this.name = 'clouds';
    this.order = 110;
    this.enabled = true;
    const C = { ...(body.clouds || {}) };
    // art / capture overrides: &clouds=cumulus|storm|stratus|wisp|haze|fogsea|none  &cover=0..1
    const oType = (Params.str?.('clouds') || '').toLowerCase();
    if (oType && (CLOUD_TYPES[oType] || oType === 'none')) C.type = oType;
    const oCover = Params.num?.('cover');
    if (Number.isFinite(oCover)) C.coverage = clamp(oCover, 0, 1);
    const type = (C.type && CLOUD_TYPES[C.type]) ? C.type : (C.type === 'none' ? 'none' : 'cumulus');
    this.type = type;
    // gas giants: the space track draws the banded deck (no rocky-planet cumulus shell)
    this.present = atmo.model.present && !body.isGas && body.type !== 'gas' && type !== 'none' && (C.coverage ?? 0) > 0.02;
    this.tier = q.tier || 'high';
    this.mode2D = this.tier === 'low';
    // march resolution (fraction of the screen); &clscale= overrides (e.g. 1 for full-res hero stills)
    const cs = Params.num?.('clscale');
    // Real time: half res, a new jitter pattern every frame, converged by the TAA resolve (~10 frames).
    // Stills (shot mode) only get 4 TAA sub-frames, so they march at full res = the converged image.
    const shotHQ = !!w.engine?.shot && (this.tier === 'high' || this.tier === 'ultra');
    this.scale = Number.isFinite(cs) ? clamp(cs, 0.25, 1) : shotHQ ? 1 : 0.5;
    const P = CLOUD_TYPES[type] || CLOUD_TYPES.cumulus;
    this.P = P;
    const m = atmo.model;
    // --- layer geometry (planet-scaled; stays inside the atmosphere)
    const baseAlt = type === 'fogsea'
      ? Math.max(0, (w.surface?.seaLevel ?? 0)) + 40
      : clamp(Math.min((C.altitude || body.radius * 0.03) * P.alt, P.baseMax * clamp(body.radius / 70000, 0.6, 1.4)), 600, m.height * 0.55);
    const sizeK = clamp(body.radius / 70000, 0.6, 1.4);
    const thick = Math.min(P.thick * sizeK, m.height * 0.8 - baseAlt);
    this.Rc0 = m.Rb + baseAlt;
    this.Rc1 = this.Rc0 + Math.max(thick, 150);
    this.coverage = clamp(C.coverage ?? 0.4, 0, 1);
    // high cirrus sheet (2D, fibrous): the layered BotW / NMS sky above the cumulus or the sea of fog
    const cirrusAmt = { cumulus: 0.42, storm: 0.3, stratus: 0.25, wisp: 0.0, haze: 0.0, fogsea: 0.3 }[type] ?? 0;
    const ciR = Math.min(this.Rc1 + Math.max(2600 * sizeK, m.height * 0.12), m.Rb + m.height * 0.5);
    this.cirrus = { R: ciR, amount: (Params.num?.('cirrus') ?? cirrusAmt) * (ciR > this.Rc1 + 300 ? 1 : 0) };
    this.cirrusStretch = type === 'storm' ? 0.6 : 0.35;

    const tierSteps = { low: 16, med: 36, high: 56, ultra: 80 }[this.tier] ?? 56;
    this.baseSteps = tierSteps;
    const lightSteps = { low: 2, med: 3, high: 5, ultra: 6 }[this.tier] ?? 5;
    const seed = body.seed ?? 1;
    const hs = (k) => ((Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
    this.windA = new THREE.Vector3(hs(1), hs(2), hs(3));
    this.windB = new THREE.Vector3(hs(4), hs(5), hs(6));
    this._windM = new THREE.Vector3();
    this.weatherAngle = 0;

    this.u = {
      uNoise: { value: null }, uWeather: { value: null },
      uWeatherRot: { value: new THREE.Matrix3() },
      uLayer: { value: new THREE.Vector4(this.Rc0, this.Rc1, 1 / (this.Rc1 - this.Rc0), 60000 * sizeK) },
      uShape: { value: new THREE.Vector4(1 / (P.scale * sizeK), 1 / (P.detail * sizeK), P.erode, P.dens) },
      uShape2: { value: new THREE.Vector4(P.topMin, P.soft, P.topSoft, P.anvil) },
      uShape3: { value: new THREE.Vector4(P.coverMul, P.coverAdd, P.stretch, P.ambient) },
      uShape4: { value: new THREE.Vector4(P.lump, P.grad, 22000 * sizeK, 70000 * sizeK) },
      uShape5: { value: new THREE.Vector4(P.sunGain ?? 4.5, P.tupK ?? 0.06, 1 / (14000 * sizeK), P.dome ?? 0) },
      // far extinction factor · detail band-limit start/end (m) · edge sharpness (density ramp width)
      uShape6: { value: new THREE.Vector4(P.farSig ?? 0.24, 5000 * sizeK, 24000 * sizeK, P.edge ?? 0.12) },
      uShape7: { value: new THREE.Vector4(P.billow ?? 0, 0, 0, 0) },
      uAmbNight: { value: new THREE.Vector3() },
      uCirrus: { value: new THREE.Vector4(0, 0, 1 / (10000 * sizeK), 0.4) },
      uWindA: { value: this.windA.clone() }, uWindB: { value: this.windB.clone() },
      uWindDirC: { value: new THREE.Vector3(1, 0, 0) },
      uCoverBoost: { value: 0 },
      tDepth: { value: null }, tColor: { value: null }, tClouds: { value: null },
      uCamPlanet: { value: new THREE.Vector3() },
      uCamWorld: { value: new THREE.Matrix4() },
      uProjParams: { value: new THREE.Vector4(1, 1, 0, 0) },
      uNear: { value: 0.05 }, uFar: { value: 2e10 },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uLightIll: { value: new THREE.Vector3(1, 1, 1) },
      uSunDir: atmo.shared.uSunDir,
      uSunIllSky: atmo.shared.uSunIll,
      uAmbTop: { value: new THREE.Vector3(0.3, 0.35, 0.45) },
      uAmbBot: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
      uAmbRef: { value: new THREE.Vector3(0.3, 0.35, 0.45) },
      uAmbLocal: { value: 1 },
      uFlash: { value: new THREE.Vector4(0, 0, 0, 0) },
      uAPScale: atmo.effect?.u?.uAPScale ?? { value: 1 },
      uSteps: { value: tierSteps },
      uLightSteps: { value: lightSteps },
      uFrameJitter: { value: 0 },
      uInside: { value: 1 },
      uLowRes: { value: new THREE.Vector2(1, 1) },
      uSkyR: { value: null }, uSkyM: { value: null }, uSkyMS: { value: null },
      ...atmo.atmoUniforms,
    };
    this.u.uCirrus.value.x = this.cirrus.R;
    this.u.uCirrus.value.y = this.mode2D ? 0 : this.cirrus.amount;
    this.u.uCirrus.value.w = this.cirrusStretch;
    this.quad = new FSQuad();
    this.lowRT = hdrTarget(4, 4);
    const hq = this.tier === 'high' || this.tier === 'ultra';
    this.marchMat = fsMaterial(this.mode2D ? LOW_FRAG : MARCH_FRAG, this.u, hq ? { defines: { CL_HQ: 1 } } : {});
    this.compMat = fsMaterial(COMPOSITE_FRAG, this.u);
    this.shadowSize = { low: 128, med: 256, high: 384, ultra: 512 }[this.tier] ?? 384;
    this.shadowRT = new THREE.WebGLRenderTarget(this.shadowSize, this.shadowSize, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.shadowU = {
      uE1: { value: new THREE.Vector3() }, uE2: { value: new THREE.Vector3() },
      uSize: { value: 26000 * sizeK },
    };
    this.shadowMat = fsMaterial(SHADOW_FRAG, { ...this.u, ...this.shadowU });
    this._shadowFrame = -100;
    this._built = false;
    this._sm = new THREE.Matrix4();
    this.meanCover = this.present ? clamp(this.coverage * P.coverMul + P.coverAdd, 0, 1) : 0;
  }

  // ---------------------------------------------------------------- one-time GPU resources
  _build(renderer) {
    this._built = true;
    // tileable 3D noise
    const N = this.tier === 'ultra' ? 96 : 64;
    const rt = new THREE.WebGL3DRenderTarget(N, N, N, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false });
    rt.texture.wrapS = rt.texture.wrapT = rt.texture.wrapR = THREE.RepeatWrapping;
    rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
    rt.texture.generateMipmaps = false;
    const nm = fsMaterial(NOISE_FRAG, { uLayer: { value: 0 }, uSize: { value: N } });
    for (let z = 0; z < N; z++) { nm.uniforms.uLayer.value = z; this.quad.render(renderer, nm, rt, z); }
    nm.dispose();
    this.noiseRT = rt;
    this.u.uNoise.value = rt.texture;
    // weather cube
    const body = this.world.body;
    const size = this.tier === 'low' ? 128 : this.tier === 'med' ? 256 : 384;
    const cube = new THREE.WebGLCubeRenderTarget(size, { type: THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    const cam = new THREE.CubeCamera(0.1, 10, cube);
    const scene = new THREE.Scene();
    const seed = body.seed ?? 1;
    const hs = (k) => ((Math.sin(seed * 3.1 + k * 17.7) * 9631.3) % 1) * 40;
    const storms = clamp((body.weather?.storms ?? 0) + (this.type === 'storm' ? 0.6 : 0), 0, 1);
    const mat = new THREE.ShaderMaterial({
      vertexShader: WEATHER_VERT, fragmentShader: WEATHER_FRAG, side: THREE.BackSide, depthTest: false, depthWrite: false,
      uniforms: {
        uSeed: { value: new THREE.Vector3(hs(1), hs(2), hs(3)) },
        uCoverage: { value: this.coverage },
        uFreq: { value: this.P.weatherFreq * clamp(body.radius / 70000, 0.6, 1.6) },
        uStorms: { value: storms * 0.9 },
        uStretch: { value: this.P.stretch },
        uCyc: { value: this._cyclones(seed, storms) },
      },
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
    scene.add(box); scene.add(cam);
    cam.update(renderer, scene);
    box.geometry.dispose(); mat.dispose();
    this.weatherRT = cube;
    this.u.uWeather.value = cube.texture;
  }

  // deterministic weather systems: 2–5 cyclones in the mid latitudes, spinning by hemisphere
  _cyclones(seed, storms) {
    let st = (Math.floor(seed * 7919) >>> 0) || 7;
    const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
    const n = 2 + Math.floor(rnd() * 3.99);
    const out = [];
    for (let k = 0; k < 5; k++) {
      if (k >= n || this.type === 'fogsea') { out.push(new THREE.Vector4(0, 1, 0, 0)); continue; }
      const lat = (18 + rnd() * 42) * (rnd() < 0.5 ? -1 : 1) * Math.PI / 180, lon = rnd() * Math.PI * 2;
      const c = new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
      const strength = (2.5 + rnd() * 3.5 + storms * 2) * Math.sign(lat);
      out.push(new THREE.Vector4(c.x, c.y, c.z, strength));
    }
    return out;
  }

  // ---------------------------------------------------------------- per frame (CPU)
  update(dt, t, ctx) {
    if (!this.present) return;
    const u = this.u;
    const G = ctx.G;
    // wind drift (noise space, wrapped to keep precision)
    const speed = 14 + 26 * (G.uWindStrength.value || 0.3);
    this._windM.addScaledVector(G.uWindDir.value, speed * dt);
    const inv1 = u.uShape.value.x, inv2 = u.uShape.value.y;
    const wm = this._windM;
    u.uWindA.value.set(this.windA.x - wm.x * inv1, this.windA.y - wm.y * inv1, this.windA.z - wm.z * inv1);
    u.uWindB.value.set(this.windB.x - wm.x * inv2 * 1.3, this.windB.y - wm.y * inv2 * 1.3, this.windB.z - wm.z * inv2 * 1.3);
    for (const v of [u.uWindA.value, u.uWindB.value]) { v.x -= Math.floor(v.x); v.y -= Math.floor(v.y); v.z -= Math.floor(v.z); }
    u.uWindDirC.value.copy(G.uWindDir.value);
    // weather systems slowly rotate around the planet axis
    this.weatherAngle += dt * speed / (this.atmo.model.Rb * 1.0);
    const c = Math.cos(this.weatherAngle), s = Math.sin(this.weatherAngle);
    u.uWeatherRot.value.set(c, 0, s, 0, 1, 0, -s, 0, c);
    const shot = this.world.engine.shot;
    // stills get no temporal accumulation: spend more samples instead
    u.uSteps.value = this.baseSteps * (shot ? 1.5 : 1);
    u.uCoverBoost.value = ctx.coverBoost || 0;
    // lightning lights the deck from inside: dramatic at night, subtle in a daylit storm
    u.uFlash.value.w = (ctx.flash || 0) * (1 - 0.85 * (ctx.lighting?.dayness ?? 0));
    // key light: sun, or the moon deep at night
    const L = ctx.lighting;
    const sunElev = ctx.sunMu;
    const E = this.atmo.model.sunIlluminance;
    const sc = this.atmo.starColor;
    const high = ctx.camR - this.atmo.model.Rb > this.atmo.model.height * 0.8;
    // moon / starlight fill on the night side (orbit & altitude views: the key light stays the star)
    const mI = (L.moon?.ill || 0) * E;
    u.uAmbNight.value.set(0.05 * mI + 0.0035 * E, 0.06 * mI + 0.0042 * E, 0.085 * mI + 0.0062 * E).multiplyScalar(high ? 1 : 0);
    if (high || sunElev > -0.2 || !(L.moon.ill > 0)) {
      u.uLightDir.value.copy(ctx.sunDir);
      u.uLightIll.value.set(sc.r * E, sc.g * E, sc.b * E);
    } else {
      u.uLightDir.value.copy(L.moon.dir);
      const mi = L.moon.ill * E * 0.9;
      u.uLightIll.value.set(0.62 * mi, 0.72 * mi, 1.0 * mi);
    }
    // ambient at cloud altitude: camera-local (sun elevation here) and a reference (orbit: per-sample)
    const m = this.atmo.model, rc = (this.Rc0 + this.Rc1) * 0.5;
    const sk = this._sk || (this._sk = [0, 0, 0]), gr = this._gr || (this._gr = [0, 0, 0]);
    const scE = [sc.r * E, sc.g * E, sc.b * E];
    // night: the art-boosted terrain night ambient would make clouds glow; keep them dark silhouettes
    const na = _na.copy(this.atmo.nightAmbient).multiplyScalar(0.3), k = 1 / Math.PI;
    m.skyIrradiance(rc, clamp(sunElev, -1, 1), sk, gr);
    const at = u.uAmbTop.value.set((sk[0] * scE[0] + na.r) * k * AMBK, (sk[1] * scE[1] + na.g) * k * AMBK, (sk[2] * scE[2] + na.b) * k * AMBK);
    // cloud bases see the horizon sky as much as the ground: cool, not brown
    u.uAmbBot.value.set(at.x * 0.5 + gr[0] * scE[0] * 0.35, at.y * 0.5 + gr[1] * scE[1] * 0.35, at.z * 0.5 + gr[2] * scE[2] * 0.35);
    if (!this._refDone) {
      this._refDone = true;
      m.skyIrradiance(rc, 0.7, sk, gr);
      u.uAmbRef.value.set(sk[0] * scE[0] * k * AMBK, sk[1] * scE[1] * k * AMBK, sk[2] * scE[2] * k * AMBK);
    }
    const camAlt = ctx.camR - m.Rb;
    u.uAmbLocal.value = 1 - THREE.MathUtils.smoothstep(camAlt, m.height * 0.8, m.height * 2.5);
  }

  preRender(renderer, camera) {
    if (!this.present || !this.enabled) return;
    if (!this._built) this._build(renderer);
    const u = this.u;
    u.uCamPlanet.value.setFromMatrixPosition(camera.matrixWorld).add(this.world.origin);
    u.uInside.value = u.uCamPlanet.value.length() < this.atmo.model.Rt * 0.999 ? 1 : 0;
    // cloud shadow map (projected along the key light, centered on the camera)
    const f = this.world.engine.time.frame;
    const shot = this.world.engine.shot;
    if (shot || f - this._shadowFrame >= 3) {
      this._shadowFrame = f;
      this._renderShadow(renderer);
    }
  }

  _renderShadow(renderer) {
    const u = this.u, su = this.shadowU;
    const L = u.uLightDir.value;
    const e1 = su.uE1.value, e2 = su.uE2.value;
    const ref = Math.abs(L.y) < 0.9 ? _Y : _X;
    e1.crossVectors(ref, L).normalize();
    e2.crossVectors(L, e1).normalize();
    this.quad.render(renderer, this.shadowMat, this.shadowRT);
    // scene position → uv:  uv = ((p_local - cam_local) · e) / size + 0.5, p_local = p_scene + origin
    const S = su.uSize.value;
    const c = _c.copy(u.uCamPlanet.value).sub(this.world.origin); // camera in scene space
    const m = this._sm;
    m.set(
      e1.x / S, e1.y / S, e1.z / S, -c.dot(e1) / S + 0.5,
      e2.x / S, e2.y / S, e2.z / S, -c.dot(e2) / S + 0.5,
      0, 0, 0, 0,
      0, 0, 0, 1,
    );
    const LU = this.atmo.lighting.uniforms;
    LU.rvCloudShadowMap.value = this.shadowRT.texture;
    LU.rvCloudShadowMatrix.value.copy(m);
    const camAlt = u.uCamPlanet.value.length() - this.atmo.model.Rb;
    // fade out from high altitude (the map covers ~26 km)
    const fade = 1 - THREE.MathUtils.smoothstep(camAlt, 12000, 30000);
    LU.rvCloudShadowParams.value.set(fade > 0.01 ? 1 : 0, 0.72 * fade, S, 0);
  }

  /** Transmittance of the cloud shadow at the camera (for sun dimming / audio / weather). */
  get shadowAtCamera() { return 1; }

  setSize(w, h) {
    this.W = w; this.H = h;
    const lw = Math.max(1, Math.round(w * this.scale)), lh = Math.max(1, Math.round(h * this.scale));
    this.lowRT.setSize(lw, lh);
    this.u.uLowRes.value.set(lw, lh);
  }

  // ---------------------------------------------------------------- pipeline effect
  render(renderer, io) {
    if (!this.present) { io.skip = true; return; }
    if (!this._built) this._build(renderer);
    const u = this.u, cam = io.camera;
    const p = cam.projectionMatrix.elements;
    u.uCamWorld.value.copy(cam.matrixWorld);
    u.uProjParams.value.set(p[0], p[5], p[8], p[9]);
    u.uNear.value = cam.near; u.uFar.value = cam.far;
    u.uCamPlanet.value.setFromMatrixPosition(cam.matrixWorld).add(this.world.origin);
    u.tDepth.value = io.depth;
    const sky = this.atmo.luts?.skyTextures;
    if (sky) { u.uSkyR.value = sky[0]; u.uSkyM.value = sky[1]; u.uSkyMS.value = sky[2]; }
    if (this.lowRT.width < 2 && io.input) this.setSize(io.input.width, io.input.height);
    // new sample pattern every render (incl. the TAA sub-frames of a still) → the TAA resolve accumulates it
    u.uFrameJitter.value = this._rf = ((this._rf || 0) + 1) % 64;
    this.quad.render(renderer, this.marchMat, this.lowRT);
    u.tColor.value = io.input.texture;
    u.tClouds.value = this.lowRT.texture;
    this.quad.render(renderer, this.compMat, io.output);
  }

  dispose() {
    this.lowRT.dispose(); this.shadowRT.dispose();
    this.noiseRT?.dispose(); this.weatherRT?.dispose();
    this.marchMat.dispose(); this.compMat.dispose(); this.shadowMat.dispose();
    this.quad.dispose();
    const LU = this.atmo.lighting?.uniforms;
    if (LU) LU.rvCloudShadowParams.value.set(0, 0, 0, 0);
  }
}

const _X = new THREE.Vector3(1, 0, 0), _Y = new THREE.Vector3(0, 1, 0), _c = new THREE.Vector3(), _na = new THREE.Color();
