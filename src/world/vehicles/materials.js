// Vehicle materials — one PBR "uber" shader per vehicle covering every opaque part:
//   • per-part surface attributes (aSurf = roughness, metalness, panel amount, clearcoat;
//     aSurf2 = wear, dirt acceptance, emissive LED strength, rust acceptance)
//   • procedural triplanar panel seams (object space) with derivative bump → reads as real panels
//   • curvature-from-derivatives edge wear (bevels catch light and show bare metal)
//   • world-integrated grime: dirt in the planet's soil color creeping up from below, rust, wetness
//   • reentry heat (blackbody glow on surfaces facing the airflow) and a dissolve/materialize effect
// Plus: animated multi-channel glow material, tinted glass, decal atlas material, a sky-probe
// environment map (used only when the atmosphere track has not set scene.environment) and liveries.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';

// ------------------------------------------------------------------ surface presets
// r: roughness, m: metalness, p: panel seams, cc: clearcoat, w: edge wear, d: dirt, e: emissive, ru: rust
export const SURF = {
  paint: { r: 0.3, m: 0.05, p: 1.0, cc: 1.0, w: 1.0, d: 1.0, e: 0, ru: 1.0 },
  paintMatte: { r: 0.62, m: 0.02, p: 1.0, cc: 0.0, w: 1.0, d: 1.0, e: 0, ru: 1.0 },
  paintMetal: { r: 0.28, m: 0.6, p: 1.0, cc: 0.8, w: 1.0, d: 1.0, e: 0, ru: 0.8 },
  pearl: { r: 0.22, m: 0.38, p: 1.0, cc: 1.0, w: 1.0, d: 1.0, e: 0, ru: 0.8 },   // metallic-flake hull paint (strong sky reflections)
  metal: { r: 0.32, m: 1.0, p: 0.5, cc: 0, w: 0.4, d: 0.7, e: 0, ru: 0.5 },
  brushed: { r: 0.26, m: 1.0, p: 0.0, cc: 0, w: 0.2, d: 0.5, e: 0, ru: 0.2 },
  darkMetal: { r: 0.46, m: 0.85, p: 0.7, cc: 0, w: 0.7, d: 0.9, e: 0, ru: 0.7 },
  gunmetal: { r: 0.38, m: 0.9, p: 0.9, cc: 0.3, w: 0.8, d: 0.8, e: 0, ru: 0.5 },
  chrome: { r: 0.07, m: 1.0, p: 0.0, cc: 0, w: 0.0, d: 0.35, e: 0, ru: 0.0 },
  rubber: { r: 0.9, m: 0.0, p: 0.0, cc: 0, w: 0.0, d: 0.45, e: 0, ru: 0.0 },
  plastic: { r: 0.55, m: 0.0, p: 0.35, cc: 0, w: 0.25, d: 0.8, e: 0, ru: 0.0 },
  gloss: { r: 0.18, m: 0.0, p: 0.0, cc: 1.0, w: 0.2, d: 0.6, e: 0, ru: 0.0 },
  fabric: { r: 0.88, m: 0.0, p: 0.0, cc: 0, w: 0.0, d: 0.6, e: 0, ru: 0.0 },
  leather: { r: 0.58, m: 0.0, p: 0.25, cc: 0, w: 0.3, d: 0.4, e: 0, ru: 0.0 },
  ceramic: { r: 0.5, m: 0.0, p: 1.0, cc: 0, w: 0.3, d: 0.5, e: 0, ru: 0.0 },
  led: { r: 0.25, m: 0.0, p: 0.0, cc: 0.5, w: 0.0, d: 0.0, e: 5.0, ru: 0.0 },
  screen: { r: 0.12, m: 0.0, p: 0.0, cc: 1.0, w: 0.0, d: 0.0, e: 1.6, ru: 0.0 },
  visor: { r: 0.06, m: 0.9, p: 0.0, cc: 1.0, w: 0.0, d: 0.1, e: 0, ru: 0.0 },
};

// ------------------------------------------------------------------ shader chunks
const NOISE_GLSL = /* glsl */`
float rvv_h13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float rvv_h11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float rvv_vn(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rvv_h13(i), rvv_h13(i + vec3(1,0,0)), f.x), mix(rvv_h13(i + vec3(0,1,0)), rvv_h13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(rvv_h13(i + vec3(0,0,1)), rvv_h13(i + vec3(1,0,1)), f.x), mix(rvv_h13(i + vec3(0,1,1)), rvv_h13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float rvv_fbm(vec3 p){ return rvv_vn(p) * 0.55 + rvv_vn(p * 2.07 + 13.1) * 0.3 + rvv_vn(p * 4.13 + 7.7) * 0.15; }
`;

const UBER_VERT_PARS = /* glsl */`
attribute vec4 aSurf;
attribute vec4 aSurf2;
varying vec3 vObjPos;
varying vec3 vObjNrm;
varying vec4 vSurf;
varying vec4 vSurf2;
varying vec3 vWNrm;
`;
const UBER_VERT_MAIN = /* glsl */`
vObjPos = position;
vObjNrm = normal;
vSurf = aSurf;
vSurf2 = aSurf2;
#ifdef USE_INSTANCING
  vWNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
#else
  vWNrm = normalize(mat3(modelMatrix) * normal);
#endif
`;

const UBER_FRAG_PARS = /* glsl */`
varying vec3 vObjPos;
varying vec3 vObjNrm;
varying vec4 vSurf;
varying vec4 vSurf2;
varying vec3 vWNrm;
uniform float uPanelScale;
uniform float uSeam;
uniform float uDirt;
uniform vec3 uDirtColor;
uniform vec2 uDirtRange;
uniform float uWear;
uniform float uRust;
uniform vec3 uRustColor;
uniform float uWet;
uniform float uHeat;
uniform vec3 uHeatDir;
uniform float uDissolve;
uniform vec3 uDissolveColor;
uniform float uSeed;
uniform vec3 uEdgeColor;
uniform float uEmissiveBoost;
uniform float uSeamDark;
uniform vec3 uFill;
${NOISE_GLSL}
// Panel seams in a 2D projection (meters). Staggered rows with varying panel widths; some
// vertical seams are skipped so panels have different lengths. Returns seam coverage 0..1.
float rvv_seam(vec2 uv, float scale, float width, out float rowId){
  vec2 p = uv / scale;
  float row = floor(p.y);
  rowId = row;
  float rw = 0.55 + 0.9 * rvv_h11(row * 1.37 + uSeed);
  p.x = p.x / rw + rvv_h11(row + 3.1 + uSeed) * 7.0;
  vec2 c = floor(p), f = fract(p);
  vec2 fw = max(fwidth(p), vec2(1e-5));
  float wx = width / (scale * rw), wy = width / scale;
  float kx = f.x < 0.5 ? c.x : c.x + 1.0;
  float keep = step(rvv_h11(kx * 3.1 + row * 7.7 + uSeed), 0.72);
  float dx = min(f.x, 1.0 - f.x), dy = min(f.y, 1.0 - f.y);
  float sx = (1.0 - smoothstep(wx, wx + fw.x * 1.5, dx)) * keep;
  float sy = 1.0 - smoothstep(wy, wy + fw.y * 1.5, dy);
  // fade seams out when they would alias (sub-pixel at distance)
  float fade = 1.0 - smoothstep(0.08, 0.35, max(fw.x, fw.y));
  return max(sx, sy) * fade;
}
vec3 rvv_perturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir){
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
vec3 rvv_blackbody(float T){
  T = clamp(T, 800.0, 12000.0) / 100.0;
  vec3 c;
  c.r = T <= 66.0 ? 1.0 : clamp(1.2929 * pow(T - 60.0, -0.1332), 0.0, 1.0);
  c.g = T <= 66.0 ? clamp(0.3901 * log(T) - 0.6318, 0.0, 1.0) : clamp(1.1299 * pow(T - 60.0, -0.0755), 0.0, 1.0);
  c.b = T >= 66.0 ? 1.0 : (T <= 19.0 ? 0.0 : clamp(0.5432 * log(T - 10.0) - 1.1963, 0.0, 1.0));
  return c * c;
}
`;

// Computes masks right after color_fragment (diffuseColor holds the per-part albedo).
const UBER_FRAG_COLOR = /* glsl */`
vec3 rvN = normalize(vObjNrm);
vec3 rvAn = abs(rvN);
vec3 rvW = pow(rvAn, vec3(8.0)); rvW /= (rvW.x + rvW.y + rvW.z + 1e-5);
float rvRow = 0.0, rvR1 = 0.0, rvR2 = 0.0, rvR3 = 0.0;
float rvSeamW = 0.0045 * uSeam;
float rvSeam = 0.0;
if (vSurf.z > 0.01) {
  float s1 = rvW.x > 0.02 ? rvv_seam(vObjPos.zy, uPanelScale, rvSeamW, rvR1) : 0.0;
  float s2 = rvW.y > 0.02 ? rvv_seam(vObjPos.xz + 11.3, uPanelScale * 1.15, rvSeamW, rvR2) : 0.0;
  float s3 = rvW.z > 0.02 ? rvv_seam(vObjPos.xy + 5.7, uPanelScale, rvSeamW, rvR3) : 0.0;
  rvSeam = (s1 * rvW.x + s2 * rvW.y + s3 * rvW.z) * vSurf.z;
  rvRow = rvR1 * rvW.x + rvR2 * rvW.y + rvR3 * rvW.z;
}
// curvature from screen-space derivatives (bevels / hard edges)
float rvCurv = length(fwidth(vObjNrm)) / max(length(fwidth(vObjPos)), 1e-4);
float rvEdge = smoothstep(9.0, 40.0, rvCurv);
float rvN1 = rvv_fbm(vObjPos * 5.3 + uSeed);
float rvN2 = rvv_vn(vObjPos * 23.0 + uSeed * 1.7);
// per-panel subtle tint variation + large-scale albedo breakup
float rvPanelTint = (rvv_h11(floor(rvRow) * 5.13 + uSeed) - 0.5) * 0.06 * vSurf.z;
vec3 rvBase = diffuseColor.rgb;
vec3 rvAlb = rvBase * (1.0 + rvPanelTint + (rvN1 - 0.5) * 0.08);
// edge wear → bare metal
float rvWearMask = smoothstep(0.35, 0.65, rvEdge * (0.55 + rvN2 * 0.9)) * uWear * vSurf2.x;
// dirt: creeping up from the bottom in the planet's soil color, collects in seams
float rvH01 = clamp((vObjPos.y - uDirtRange.x) / max(uDirtRange.y - uDirtRange.x, 1e-3), 0.0, 1.0);
float rvDirt = smoothstep(0.25, 0.75, (1.0 - rvH01) * 0.85 + (rvN1 - 0.5) * 0.9 + rvSeam * 0.35 + (uDirt - 0.5) * 0.9);
rvDirt *= clamp(uDirt * 1.6, 0.0, 1.0) * vSurf2.y;
// streaks: vertical grime runs under panels
float rvStreak = smoothstep(0.62, 0.9, rvv_vn(vec3(vObjPos.x * 18.0, vObjPos.y * 1.2, vObjPos.z * 18.0) + uSeed)) * (1.0 - rvH01 * 0.5) * vSurf2.y * uDirt;
// rust patches (grows from edges and seams)
float rvRust = smoothstep(0.62, 0.82, rvv_fbm(vObjPos * 2.1 + 31.0 + uSeed) + rvEdge * 0.25 + rvSeam * 0.3) * uRust * vSurf2.w;
vec3 rvRustCol = uRustColor * (0.6 + 0.7 * rvN2);
rvAlb = mix(rvAlb, rvAlb * uSeamDark, rvSeam);
rvAlb = mix(rvAlb, uEdgeColor * (0.75 + 0.35 * rvN2), rvWearMask);
rvAlb = mix(rvAlb, rvRustCol, rvRust);
rvAlb = mix(rvAlb, rvAlb * 0.55 + uDirtColor * 0.2, rvStreak * 0.6);
rvAlb = mix(rvAlb, uDirtColor * (0.8 + 0.4 * rvN2), rvDirt);
rvAlb *= mix(1.0, 0.72, uWet * (0.35 + rvDirt * 0.65));
vec3 rvEmissive = rvBase * vSurf2.z * uEmissiveBoost;
diffuseColor.rgb = rvAlb;
`;

const UBER_FRAG_ROUGH = /* glsl */`
roughnessFactor = vSurf.x;
metalnessFactor = vSurf.y;
// micro variation + fine directional scratches
float rvScr = smoothstep(0.78, 0.95, rvv_vn(vec3(vObjPos.x * 90.0, vObjPos.y * 6.0, vObjPos.z * 90.0) + uSeed));
roughnessFactor *= 0.85 + rvN1 * 0.3;
roughnessFactor = mix(roughnessFactor, min(1.0, roughnessFactor + 0.25), rvScr * vSurf2.x * uWear);
roughnessFactor = mix(roughnessFactor, 0.85, rvSeam * 0.8);
roughnessFactor = mix(roughnessFactor, 0.34, rvWearMask);
metalnessFactor = mix(metalnessFactor, 1.0, rvWearMask);
roughnessFactor = mix(roughnessFactor, 0.9, rvRust);
metalnessFactor = mix(metalnessFactor, 0.0, rvRust);
roughnessFactor = mix(roughnessFactor, 0.96, rvDirt);
metalnessFactor = mix(metalnessFactor, 0.0, rvDirt);
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.35 + 0.02, uWet * (1.0 - rvDirt * 0.5));
roughnessFactor = clamp(roughnessFactor, 0.04, 1.0);
`;

const UBER_FRAG_NORMAL = /* glsl */`
{
  // grooves at seams + fine grain, via derivative bump mapping
  float rvHgt = -rvSeam * 0.0025 + (rvN2 - 0.5) * 0.00025 * (1.0 - vSurf.y * 0.6) + rvRust * rvN2 * 0.0006 + rvDirt * rvN2 * 0.0008;
  vec2 rvdH = vec2(dFdx(rvHgt), dFdy(rvHgt));
  normal = rvv_perturb(-vViewPosition, normal, rvdH * 1.0, faceDirection);
}
`;

const UBER_FRAG_EMISSIVE = /* glsl */`
totalEmissiveRadiance += rvEmissive * (1.0 - rvDirt * 0.7);
// night fill: bounce from city glow / sky + a soft silhouette rim so vehicles read in the dark
if (uFill.r + uFill.g + uFill.b > 0.0001) {
  float rvNV = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  float rvRim = pow(1.0 - rvNV, 3.0);
  totalEmissiveRadiance += uFill * (rvAlb * (0.55 + 0.45 * (1.0 - abs(rvN.y))) + rvRim * 0.6 * (1.0 - rvDirt * 0.5));
}
if (uHeat > 0.001) {
  float facing = clamp(dot(normalize(vWNrm), uHeatDir), 0.0, 1.0);
  float fl = 0.75 + 0.25 * rvv_vn(vObjPos * 3.0 + vec3(0.0, 0.0, uSeed + uHeat * 40.0));
  float h = uHeat * pow(facing, 1.5) * fl;
  totalEmissiveRadiance += rvv_blackbody(900.0 + 2600.0 * h) * h * h * 14.0;
}
if (uDissolve > 0.0) {
  float dn = rvv_vn(vObjPos * 3.1) * 0.65 + rvv_vn(vObjPos * 11.0) * 0.35;
  if (dn < uDissolve) discard;
  float rim = 1.0 - smoothstep(0.0, 0.05, dn - uDissolve);
  totalEmissiveRadiance += uDissolveColor * rim * 10.0;
}
`;

const UBER_FRAG_CLEARCOAT = /* glsl */`
#ifdef USE_CLEARCOAT
  material.clearcoat = saturate(vSurf.w * (1.0 - rvDirt) * (1.0 - rvRust) * (1.0 - rvWearMask) * clearcoat);
#endif
`;

/** Create the per-vehicle uber material + its uniforms. */
export function makeUberMaterial(opts = {}) {
  const physical = opts.clearcoat !== false;
  const Ctor = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const mat = new Ctor({ color: 0xffffff, roughness: 0.5, metalness: 0.0, vertexColors: true });
  if (physical) { mat.clearcoat = 1.0; mat.clearcoatRoughness = 0.1; }
  mat.envMapIntensity = opts.envMapIntensity ?? 1.25;
  const u = {
    uPanelScale: { value: opts.panelScale ?? 0.45 },
    uSeam: { value: opts.seam ?? 1.0 },
    uDirt: { value: opts.dirt ?? 0.25 },
    uDirtColor: { value: new THREE.Color(opts.dirtColor ?? 0x7a6a55) },
    uDirtRange: { value: new THREE.Vector2(opts.dirtLow ?? 0, opts.dirtHigh ?? 1.5) },
    uWear: { value: opts.wear ?? 0.6 },
    uRust: { value: opts.rust ?? 0.0 },
    uRustColor: { value: new THREE.Color(opts.rustColor ?? 0x6e3a1e) },
    uWet: { value: 0 },
    uHeat: { value: 0 },
    uHeatDir: { value: new THREE.Vector3(0, 0, 1) },
    uDissolve: { value: 0 },
    uDissolveColor: { value: new THREE.Color(0.3, 0.8, 1.6) },
    uSeed: { value: opts.seed ?? 1.7 },
    uEdgeColor: { value: new THREE.Color(opts.edgeColor ?? 0x9a9ea3) },
    uEmissiveBoost: { value: 1 },
    uSeamDark: { value: opts.seamDark ?? 0.3 },
    uFill: { value: new THREE.Color(0, 0, 0) },
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + UBER_VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + UBER_VERT_MAIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + UBER_FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + UBER_FRAG_COLOR)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + UBER_FRAG_ROUGH)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + UBER_FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + UBER_FRAG_EMISSIVE)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + UBER_FRAG_CLEARCOAT);
  };
  mat.customProgramCacheKey = () => 'rv-vehicle-uber-v4' + (physical ? 'p' : 's');
  return mat;
}

// ------------------------------------------------------------------ glow (animated emissive)
/**
 * Emissive material for lights/thrusters. Per-vertex HDR color × channel intensity:
 * vertex attribute aCh selects uCh[i] (engine, nav blink, brake, headlight, repulsor, ...).
 */
export function makeGlowMaterial(opts = {}) {
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, toneMapped: false, side: opts.side ?? THREE.FrontSide });
  const ch = { value: new Float32Array(8).fill(1) };
  mat.userData.ch = ch.value;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCh = ch;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aCh;\nvarying float vCh;\nvarying vec3 vGN;\nvarying vec3 vGV;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCh = aCh;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGN = normalize(normalMatrix * normal);\nvGV = normalize(-mvPosition.xyz);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uCh[8];\nvarying float vCh;\nvarying vec3 vGN;\nvarying vec3 vGV;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        int ci = int(vCh + 0.5);
        float k = ci == 0 ? uCh[0] : ci == 1 ? uCh[1] : ci == 2 ? uCh[2] : ci == 3 ? uCh[3] : ci == 4 ? uCh[4] : ci == 5 ? uCh[5] : ci == 6 ? uCh[6] : uCh[7];
        float fres = 0.55 + 0.45 * abs(dot(normalize(vGN), normalize(vGV)));
        diffuseColor.rgb *= k * fres;`);
  };
  mat.customProgramCacheKey = () => 'rv-vehicle-glow-v2';
  return mat;
}

// ------------------------------------------------------------------ glass
export function makeGlassMaterial(tint = 0x10161c, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: tint, roughness: opts.roughness ?? 0.03, metalness: 0.1, transparent: true, opacity: opts.opacity ?? 0.42,
    depthWrite: false, envMapIntensity: 1.6,
  });
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
      float gf = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
      diffuseColor.a = clamp(diffuseColor.a + pow(gf, 2.5) * 0.55, 0.0, 0.96);
      #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'rv-vehicle-glass-v1';
  return mat;
}

// ------------------------------------------------------------------ decal atlas
// 4×4 grid of 256px cells. Cells (index = row*4+col):
//  0 hazard yellow/black  1 hazard white/orange  2 chevrons  3 accent stripe band
//  4 big numerals (set)   5 emblem ring          6 CAUTION label  7 barcode/serial
//  8 NO STEP arrow        9 text line block      10 triangle warn 11 grid ticks
//  12 wordmark REVERENCE  13 small numerals      14 flag/bars     15 dots
let _atlas = null;
export function decalAtlas() {
  if (_atlas) return _atlas;
  const S = 1024, C = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  const cell = (i, fn) => { const x = (i % 4) * C, y = Math.floor(i / 4) * C; g.save(); g.translate(x, y); g.beginPath(); g.rect(0, 0, C, C); g.clip(); fn(g); g.restore(); };
  const stripes = (a, b, w = 36) => (ctx) => {
    ctx.fillStyle = a; ctx.fillRect(0, 0, C, C);
    ctx.fillStyle = b;
    for (let k = -C; k < C * 2; k += w * 2) { ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k + w, 0); ctx.lineTo(k + w - C, C); ctx.lineTo(k - C, C); ctx.closePath(); ctx.fill(); }
  };
  cell(0, stripes('#f2c21a', '#15130f'));
  cell(1, stripes('#f4f1ea', '#ff6a1a'));
  cell(2, (ctx) => { ctx.fillStyle = '#ffffff'; for (let k = 0; k < 3; k++) { const x = 30 + k * 70; ctx.beginPath(); ctx.moveTo(x, 40); ctx.lineTo(x + 40, 128); ctx.lineTo(x, 216); ctx.lineTo(x + 26, 216); ctx.lineTo(x + 66, 128); ctx.lineTo(x + 26, 40); ctx.closePath(); ctx.fill(); } });
  cell(3, (ctx) => { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 70, C, 60); ctx.fillRect(0, 150, C, 16); ctx.fillRect(0, 180, C, 6); });
  cell(4, (ctx) => { ctx.fillStyle = '#ffffff'; ctx.font = 'bold 190px "DejaVu Sans Condensed", "Arial Narrow", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('07', C / 2, C / 2 + 10); });
  cell(5, (ctx) => {
    ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff'; ctx.lineWidth = 14;
    ctx.beginPath(); ctx.arc(128, 128, 96, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(128, 128, 70, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, r = k % 2 ? 22 : 56; ctx.lineTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r); } ctx.closePath(); ctx.fill();
  });
  cell(6, (ctx) => {
    ctx.fillStyle = '#f2c21a'; ctx.fillRect(10, 60, 236, 136);
    ctx.fillStyle = '#111'; ctx.fillRect(18, 68, 220, 40);
    ctx.fillStyle = '#f2c21a'; ctx.font = 'bold 34px "DejaVu Sans", sans-serif'; ctx.textAlign = 'center'; ctx.fillText('CAUTION', 128, 100);
    ctx.fillStyle = '#111'; ctx.font = 'bold 17px "DejaVu Sans", sans-serif'; ctx.fillText('HIGH VOLTAGE', 128, 138); ctx.fillText('KEEP CLEAR 2M', 128, 164); ctx.font = '12px monospace'; ctx.fillText('RV-EXP 0419-B', 128, 186);
  });
  cell(7, (ctx) => {
    ctx.fillStyle = '#ffffff';
    let x = 20; let s = 7;
    while (x < 236) { s = (s * 1103515245 + 12345) & 0x7fffffff; const w = 2 + (s % 7); ctx.fillRect(x, 60, w, 100); x += w + 2 + ((s >> 8) % 5); }
    ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center'; ctx.fillText('RVX-2217-0419', 128, 196);
  });
  cell(8, (ctx) => {
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 44px "DejaVu Sans", sans-serif'; ctx.textAlign = 'center'; ctx.fillText('NO STEP', 128, 110);
    ctx.fillRect(40, 130, 176, 8); ctx.beginPath(); ctx.moveTo(128, 150); ctx.lineTo(160, 200); ctx.lineTo(96, 200); ctx.closePath(); ctx.fill();
  });
  cell(9, (ctx) => {
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 20px monospace'; ctx.textAlign = 'left';
    const lines = ['DEEP RANGE SURVEY', 'MFG 2291 · ORBITAL', 'CL-4 ATMO RATED', 'SERVICE 0x3F2A', 'FUEL: DEUTERIUM'];
    lines.forEach((l, k) => ctx.fillText(l, 16, 50 + k * 38));
  });
  cell(10, (ctx) => {
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(128, 24); ctx.lineTo(236, 220); ctx.lineTo(20, 220); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.moveTo(128, 60); ctx.lineTo(206, 204); ctx.lineTo(50, 204); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(120, 100, 16, 60); ctx.fillRect(120, 172, 16, 16);
  });
  cell(11, (ctx) => { ctx.fillStyle = '#ffffff'; for (let k = 0; k < 16; k++) { const h = k % 4 === 0 ? 60 : 30; ctx.fillRect(8 + k * 15, 40, 4, h); } ctx.fillRect(8, 110, 240, 4); ctx.font = 'bold 18px monospace'; ctx.fillText('0   25   50   75', 8, 150); });
  cell(12, (ctx) => { ctx.fillStyle = '#ffffff'; ctx.font = 'bold 40px "DejaVu Sans", sans-serif'; ctx.textAlign = 'center'; ctx.save(); ctx.scale(1, 1.4); ctx.fillText('REVERENCE', 128, 70); ctx.restore(); ctx.font = '16px "DejaVu Sans", sans-serif'; ctx.fillText('DEEP FIELD EXPEDITIONARY', 128, 150); ctx.fillRect(20, 170, 216, 5); });
  cell(13, (ctx) => { ctx.fillStyle = '#ffffff'; ctx.font = 'bold 120px "DejaVu Sans Condensed", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('K-9', C / 2, C / 2); });
  cell(14, (ctx) => { const cols = ['#ffffff', '#ff5a2a', '#ffffff', '#2a9aff']; cols.forEach((c, k) => { ctx.fillStyle = c; ctx.fillRect(20 + k * 56, 50, 44, 156); }); });
  cell(15, (ctx) => { ctx.fillStyle = '#ffffff'; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { ctx.beginPath(); ctx.arc(20 + x * 31, 20 + y * 31, 7, 0, Math.PI * 2); ctx.fill(); } });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  _atlas = tex;
  return tex;
}

export function makeDecalMaterial(opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: decalAtlas(), transparent: true, alphaTest: 0.3, depthWrite: false, vertexColors: true,
    roughness: 0.5, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: 0,
  });
  const u = { uDecalWear: { value: opts.wear ?? 0.45 }, uDecalSeed: { value: opts.seed ?? 3.1 } };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDP;\nuniform float uDecalWear;\nuniform float uDecalSeed;\n' + NOISE_GLSL)
      .replace('#include <alphatest_fragment>', `
        float dw = rvv_fbm(vDP * 9.0 + uDecalSeed) * 0.8 + rvv_vn(vDP * 60.0) * 0.35;
        diffuseColor.a *= smoothstep(uDecalWear * 0.75, uDecalWear * 0.75 + 0.08, dw);
        #include <alphatest_fragment>`);
  };
  mat.customProgramCacheKey = () => 'rv-vehicle-decal-v1';
  return mat;
}

// ------------------------------------------------------------------ environment probe
// Low-res PMREM of a procedural sky driven by the shared lighting uniforms. Used only while the
// scene has no environment map of its own, so metal/glass reflect the planet's actual sky.
const PROBE_FRAG = /* glsl */`
uniform vec3 uSky; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uUp;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float h = dot(d, uUp);
  vec3 c = mix(uHorizon, uSky, pow(clamp(h, 0.0, 1.0), 0.5));
  c = mix(c, uGround, smoothstep(0.02, -0.12, h));
  float s = max(dot(d, uSunDir), 0.0);
  c += uSunCol * (pow(s, 6.0) * 0.35 + pow(s, 64.0) * 1.2 + smoothstep(0.9985, 0.9995, s) * 30.0);
  // soft "cloud band" & ground bounce breakup so chrome doesn't look like a plain gradient
  c *= 0.92 + 0.08 * sin(d.x * 9.0 + d.z * 7.0) * sin(d.y * 11.0 + d.z * 3.0);
  gl_FragColor = vec4(c, 1.0);
}`;
const PROBE_VERT = /* glsl */`varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export class EnvProbe {
  constructor(renderer, world) {
    this.renderer = renderer;
    this.world = world;
    this.rt = null;
    this.timer = 0;
    this.enabled = true;
    this.scene = new THREE.Scene();
    this.mat = new THREE.ShaderMaterial({
      vertexShader: PROBE_VERT, fragmentShader: PROBE_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false,
      uniforms: {
        uSky: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() }, uUp: { value: new THREE.Vector3(0, 1, 0) },
      },
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.mat));
    try { this.pmrem = new THREE.PMREMGenerator(renderer); } catch (_) { this.pmrem = null; this.enabled = false; }
    const pal = world.body.art?.palette || {};
    this.skyC = new THREE.Color(pal.sky || '#8fb4d8');
    this.fogC = new THREE.Color(pal.fog || '#c8d4dc');
    this.groundC = new THREE.Color(pal.rock || '#6a6258');
  }

  get texture() { return this.rt ? this.rt.texture : null; }

  /** Refresh every few seconds (and immediately the first time). Returns true when a new map was made. */
  update(dt, upDir) {
    if (!this.enabled || !this.pmrem) return false;
    this.timer -= dt;
    if (this.rt && this.timer > 0) return false;
    this.timer = 6;
    const u = this.mat.uniforms;
    const amb = G.uAmbientSky.value, ambG = G.uAmbientGround.value;
    const night = G.uNight.value;
    const day = 1 - night;
    const ambL = Math.max(amb.r, amb.g, amb.b);
    // sky: blend art palette with live ambient so sunsets/nights reflect correctly
    u.uSky.value.copy(this.skyC).multiplyScalar(0.25 + 0.9 * day).lerp(amb, ambL > 0.02 ? 0.45 : 0);
    u.uHorizon.value.copy(this.fogC).multiplyScalar(0.18 + 0.9 * day);
    u.uGround.value.copy(this.groundC).multiplyScalar(0.12 + 0.4 * day).lerp(ambG, 0.3);
    u.uSunDir.value.copy(G.uSunDir.value);
    u.uSunCol.value.copy(G.uSunColor.value).multiplyScalar(0.5);
    if (upDir) u.uUp.value.copy(upDir);
    try {
      const old = this.rt;
      this.rt = this.pmrem.fromScene(this.scene, 0.02, 0.1, 100, { size: 64 });
      old?.dispose();
      return true;
    } catch (e) {
      console.warn('[vehicles] env probe failed', e);
      this.enabled = false;
      return false;
    }
  }

  dispose() {
    this.rt?.dispose(); this.pmrem?.dispose(); this.mat.dispose();
    this.scene.traverse((o) => o.geometry?.dispose?.());
  }
}

// ------------------------------------------------------------------ liveries
// Curated paint schemes; chosen per world (deterministic) with a bias from the art preset so a
// vehicle feels at home in each art-directed world.
export const LIVERIES = {
  nasapunk: { primary: '#e9e6df', secondary: '#3a3d42', accent: '#ff6a1a', trim: '#1c1d20', glow: [0.35, 0.85, 1.6], glass: '#1a2a36', decal: '#1c1d20', edge: '#b8bcc2' },
  expedition: { primary: '#c9b48a', secondary: '#4b4a3e', accent: '#e5572b', trim: '#232320', glow: [1.6, 0.95, 0.35], glass: '#2a2416', decal: '#1f1f1b', edge: '#a6a298' },
  racer: { primary: '#b8261f', secondary: '#eae6de', accent: '#f0c419', trim: '#151516', glow: [0.4, 1.0, 1.6], glass: '#12181e', decal: '#f4f1ea', edge: '#c9c9c9' },
  hauler: { primary: '#e8b31c', secondary: '#2b2b2c', accent: '#111111', trim: '#1a1a1a', glow: [1.7, 0.7, 0.25], glass: '#241a0e', decal: '#111111', edge: '#b0ada6' },
  retro: { primary: '#5fa8a0', secondary: '#efe6d2', accent: '#e0553a', trim: '#2a2a28', glow: [1.5, 0.6, 0.4], glass: '#16262a', decal: '#2a2a28', edge: '#c4c0b6' },
  stealth: { primary: '#26282d', secondary: '#4a4e57', accent: '#ff2e88', trim: '#101114', glow: [1.8, 0.25, 0.9], glass: '#200a18', decal: '#ff2e88', edge: '#7a7e88' },
  pulp: { primary: '#e8742a', secondary: '#f1e7d0', accent: '#2c6fd6', trim: '#262422', glow: [0.35, 0.8, 1.7], glass: '#2a1a10', decal: '#262422', edge: '#c8bfae' },
  frontier: { primary: '#8a4e36', secondary: '#d9c6a4', accent: '#ffb04a', trim: '#241c18', glow: [1.7, 0.8, 0.3], glass: '#2a1c12', decal: '#f0e0c8', edge: '#a8988a' },
  arctic: { primary: '#f1f3f5', secondary: '#c33a2c', accent: '#2a2d33', trim: '#1c1e22', glow: [0.5, 0.9, 1.7], glass: '#18222c', decal: '#c33a2c', edge: '#c0c4ca' },
  jade: { primary: '#2f6b5a', secondary: '#d8d2c0', accent: '#f2b43a', trim: '#1a1e1c', glow: [0.4, 1.5, 1.1], glass: '#10201c', decal: '#f2e8d0', edge: '#a0aaa4' },
};

// Pilot suits per livery: shell = glossy armour/helmet, under = pressure-suit fabric, under2 = quilted
// panels/pockets, accent = bands/canisters, boot = gloves/boots, visor = mirror tint (metallic).
export const SUITS = {
  nasapunk: { shell: '#f2f0ea', under: '#34373d', under2: '#4a4e55', accent: '#ff6a1a', boot: '#2a2622', visor: '#d09a36' },
  expedition: { shell: '#e4d6b4', under: '#454334', under2: '#5c5946', accent: '#e5572b', boot: '#3a2b20', visor: '#c88a32' },
  racer: { shell: '#f4f1ea', under: '#23262c', under2: '#3a3e46', accent: '#d12a1e', boot: '#1d1b1a', visor: '#b8862a' },
  hauler: { shell: '#f0b81c', under: '#2a2b2d', under2: '#3e4043', accent: '#f4f1ea', boot: '#231f1b', visor: '#c07a24' },
  retro: { shell: '#f3ead6', under: '#2d4e4a', under2: '#3f6660', accent: '#e0553a', boot: '#3a2a20', visor: '#c89a3c' },
  stealth: { shell: '#494d56', under: '#17181b', under2: '#26282d', accent: '#ff2e88', boot: '#141416', visor: '#5a2848' },
  pulp: { shell: '#f4ead2', under: '#2a3a5c', under2: '#3a4e78', accent: '#e8742a', boot: '#2c2320', visor: '#d0a040' },
  frontier: { shell: '#e2cfab', under: '#3e2c24', under2: '#57402f', accent: '#ffb04a', boot: '#2a1e17', visor: '#c8903a' },
  arctic: { shell: '#f6f7f8', under: '#2a2d33', under2: '#40444c', accent: '#c33a2c', boot: '#1f1d1c', visor: '#d6a040' },
  jade: { shell: '#e2dccb', under: '#1f3d35', under2: '#2f574b', accent: '#f2b43a', boot: '#2a241e', visor: '#c89a3c' },
};

const ART_LIVERY = {
  ghibli: ['retro', 'arctic', 'racer'], moebius: ['retro', 'arctic', 'pulp'], villeneuve: ['expedition', 'frontier', 'nasapunk'],
  bladerunner: ['hauler', 'stealth', 'hauler'], stalenhag: ['expedition', 'hauler', 'arctic'], rogerdean: ['jade', 'pulp', 'retro'],
  tarkovsky: ['arctic', 'expedition', 'nasapunk'], friedrich: ['arctic', 'nasapunk', 'expedition'], bierstadt: ['racer', 'nasapunk', 'retro'],
  beksinski: ['frontier', 'stealth', 'expedition'], nausicaa: ['jade', 'expedition', 'retro'], bebop: ['frontier', 'racer', 'hauler'],
  rickmorty: ['pulp', 'jade', 'racer'], kubrick: ['nasapunk', 'arctic', 'nasapunk'], turner: ['racer', 'retro', 'expedition'],
  crystal: ['arctic', 'jade', 'stealth'], botw: ['retro', 'racer', 'jade'], outerwilds: ['pulp', 'frontier', 'retro'],
  nms: ['pulp', 'hauler', 'racer'], starfield: ['nasapunk', 'arctic', 'hauler'],
};

/** Pick a livery for vehicle `kind` ('bike'|'rover'|'ship') on this body. */
export function pickLivery(body, kind) {
  const key = body.art?.key || 'nms';
  const opts = ART_LIVERY[key] || ['nasapunk', 'pulp', 'racer'];
  const idx = { bike: 0, rover: 1, ship: 2 }[kind] ?? 0;
  const name = opts[(idx + ((body.seed >>> 3) % 2)) % opts.length];
  const L = LIVERIES[name] || LIVERIES.nasapunk;
  const accentArt = body.art?.palette?.accent;
  return { name, ...L, artAccent: accentArt || L.accent };
}

/** Weathering profile per art preset: dirt, wear, rust. */
export function weathering(body) {
  const key = body.art?.key || '';
  const w = { dirt: 0.3, wear: 0.55, rust: 0.0 };
  if (key === 'stalenhag') Object.assign(w, { dirt: 0.55, wear: 0.8, rust: 0.55 });
  else if (key === 'beksinski' || key === 'bebop' || key === 'villeneuve') Object.assign(w, { dirt: 0.5, wear: 0.75, rust: 0.35 });
  else if (key === 'bladerunner') Object.assign(w, { dirt: 0.4, wear: 0.6, rust: 0.2 });
  else if (key === 'moebius' || key === 'nausicaa') Object.assign(w, { dirt: 0.45, wear: 0.5, rust: 0.05 });
  else if (key === 'kubrick' || key === 'starfield') Object.assign(w, { dirt: 0.12, wear: 0.35, rust: 0.0 });
  return w;
}
