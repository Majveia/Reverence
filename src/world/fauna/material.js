// Creature material: MeshStandardMaterial + GPU skinning from a bone texture.
//
// Bone texture layout (RGBA32F), one ROW per rendered instance (row = gl_InstanceID + uRowOffset):
//   texel 0            : instance params (seed 0..1, glow 0..1, fade 0..1, alert 0..1)
//   texel 1 + 2*b      : bone b rotation quaternion (x, y, z, w)
//   texel 2 + 2*b      : bone b translation (x, y, z) + uniform scale (w)
// Skinned position = sum_i w_i * (t_i + s_i * rotate(q_i, restPosition))   (linear blend, 2 bones)
//
// All species share ONE compiled program (uniform-driven look) → cheap shader compiles.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';

const VERT_PARS = /* glsl */`
uniform highp sampler2D uBones;
uniform int uRowOffset;
attribute vec4 aSkin;
attribute vec4 aInfo;
varying vec4 vInfo;
varying vec3 vRest;
varying vec4 vInst;
vec4 rvQ0; vec4 rvT0; vec4 rvQ1; vec4 rvT1; float rvW0;
bool rvDone = false;
vec3 rvQrot(vec4 q, vec3 v){ vec3 t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
void rvFetch(){
  if (rvDone) return;
  rvDone = true;
  int row = gl_InstanceID + uRowOffset;
  int b0 = int(aSkin.x + 0.5), b1 = int(aSkin.y + 0.5);
  rvQ0 = texelFetch(uBones, ivec2(1 + b0 * 2, row), 0);
  rvT0 = texelFetch(uBones, ivec2(2 + b0 * 2, row), 0);
  rvQ1 = texelFetch(uBones, ivec2(1 + b1 * 2, row), 0);
  rvT1 = texelFetch(uBones, ivec2(2 + b1 * 2, row), 0);
  rvW0 = aSkin.z;
  vInst = texelFetch(uBones, ivec2(0, row), 0);
  vInfo = aInfo;
  vRest = position;
}
`;

const BEGINNORMAL = /* glsl */`
rvFetch();
vec3 objectNormal = normalize(rvQrot(rvQ0, normal) * rvW0 + rvQrot(rvQ1, normal) * (1.0 - rvW0));
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif
`;

const BEGIN = /* glsl */`
rvFetch();
vec3 transformed = (rvT0.xyz + rvT0.w * rvQrot(rvQ0, position)) * rvW0 + (rvT1.xyz + rvT1.w * rvQrot(rvQ1, position)) * (1.0 - rvW0);
`;

const FRAG_PARS = /* glsl */`
uniform vec3 cBack; uniform vec3 cBelly; uniform vec3 cPattern; uniform vec3 cAccent; uniform vec3 cKeratin; uniform vec3 cEye; uniform vec3 cGlow;
uniform vec4 pPattern;   // type, scale, threshold, amount
uniform vec4 pGlow;      // strength, type, pulse speed, eyeshine
uniform vec4 pSurf;      // roughness, sheen, bump, furness
uniform vec4 pExtra;     // socks, iridescence, translucency, belly contrast
uniform float uNight;
uniform float rvTime;
uniform vec3 rvSunDir;
uniform vec3 rvSunColor;
varying vec4 vInfo;
varying vec3 vRest;
varying vec4 vInst;

float rvH3(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
vec3 rvH33(vec3 p){ p = fract(p * vec3(.1031, .1030, .0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float rvVN(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rvH3(i), rvH3(i + vec3(1,0,0)), f.x), mix(rvH3(i + vec3(0,1,0)), rvH3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(rvH3(i + vec3(0,0,1)), rvH3(i + vec3(1,0,1)), f.x), mix(rvH3(i + vec3(0,1,1)), rvH3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float rvFbm(vec3 p){ return rvVN(p) * 0.55 + rvVN(p * 2.07 + 13.1) * 0.3 + rvVN(p * 4.13 + 5.7) * 0.15; }
vec2 rvWor(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); float f1 = 8.0, f2 = 8.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec3 b = vec3(float(x), float(y), float(z));
    vec3 r = b + rvH33(i + b) * 0.85 - f; float d = dot(r, r);
    if (d < f1){ f2 = f1; f1 = d; } else if (d < f2){ f2 = d; }
  }
  return sqrt(vec2(f1, f2));
}
// pattern mask 0..1 (1 = pattern color)
float rvPattern(vec3 P, float u, float dors, float part){
  float type = pPattern.x; float sc = pPattern.y; float th = pPattern.z;
  if (type < 0.5) return 0.0;
  float m = 0.0;
  if (type < 1.5) {           // stripes (zebra / tiger) wrapping the body
    float w = rvFbm(P * sc * 0.7) * 1.6;
    float s = sin((P.z * sc * 3.0 + w * 2.2 + abs(P.x) * sc * 0.6) * 3.14159);
    m = smoothstep(th - 0.08, th + 0.08, s) * smoothstep(-0.95, -0.2, dors);
  } else if (type < 2.5) {    // spots
    vec2 wv = rvWor(P * sc + rvFbm(P * sc * 0.5) * 0.6);
    m = 1.0 - smoothstep(th * 0.55, th * 0.55 + 0.08, wv.x);
    m *= smoothstep(-0.9, -0.3, dors);
  } else if (type < 3.5) {    // reticulated network (giraffe)
    vec2 wv = rvWor(P * sc + rvFbm(P * sc * 0.4) * 0.4);
    m = smoothstep(th * 0.25, th * 0.25 + 0.06, wv.y - wv.x);
    m *= smoothstep(-0.95, -0.4, dors);
  } else if (type < 4.5) {    // dorsal saddle + flank band
    float band = smoothstep(0.35, 0.55, dors + (rvFbm(P * sc) - 0.5) * 0.4);
    float flank = smoothstep(0.05, 0.0, abs(dors + 0.1 + (rvVN(P * sc * 2.0) - 0.5) * 0.15) - 0.07);
    m = max(band, flank * 0.9);
  } else if (type < 5.5) {    // dapples (fawn spots)
    vec2 wv = rvWor(P * sc * 1.6);
    m = (1.0 - smoothstep(0.16, 0.24, wv.x)) * smoothstep(0.0, 0.5, dors) ;
  } else if (type < 6.5) {    // rings / bands along the length
    float s = sin((u * sc * 6.0 + rvVN(P * 3.0) * 0.6) * 6.2831);
    m = smoothstep(th - 0.1, th + 0.1, s);
  } else {                    // blotches (cow / piebald)
    float n = rvFbm(P * sc * 0.6 + 7.0);
    m = smoothstep(th - 0.04, th + 0.04, n);
  }
  return m;
}
float rvGlowMask(vec3 P, float u, float dors, float part, float mat){
  float type = pGlow.y;
  if (pGlow.x <= 0.0) return 0.0;
  float g = 0.0;
  if (mat > 4.5 && mat < 6.5) g = 1.0;                              // glow organs, jelly
  if (type < 1.5) {                                                   // flank spots
    vec2 wv = rvWor(P * pPattern.y * 2.2 + 3.1);
    g = max(g, (1.0 - smoothstep(0.1, 0.2, wv.x)) * smoothstep(0.25, 0.0, abs(dors + 0.05)) * step(part, 1.5));
  } else if (type < 2.5) {                                            // spine + lateral lines
    float line = smoothstep(0.035, 0.0, abs(dors - 0.97) * 0.3) + smoothstep(0.05, 0.0, abs(dors + 0.15) - 0.02);
    g = max(g, line * step(part, 1.5) * (0.6 + 0.4 * sin(u * 40.0 - rvTime * pGlow.z * 3.0)));
  } else if (type < 3.5) {                                            // tips (tail, ears, antennae)
    g = max(g, smoothstep(0.75, 0.98, u) * step(2.5, part) + smoothstep(0.1, 0.0, u) * step(part, 0.5));
  } else {                                                            // veins over the whole body
    float n = abs(rvFbm(P * pPattern.y * 1.3) - 0.5);
    g = max(g, smoothstep(0.05, 0.0, n));
  }
  return g;
}
vec3 rvBump(vec3 surf_pos, vec3 surf_norm, float h){
  vec3 sx = dFdx(surf_pos), sy = dFdy(surf_pos);
  vec3 r1 = cross(sy, surf_norm), r2 = cross(surf_norm, sx);
  float det = dot(sx, r1);
  float bx = dFdx(h), by = dFdy(h);
  vec3 grad = sign(det) * (bx * r1 + by * r2);
  return normalize(abs(det) * surf_norm - grad);
}
`;

const FRAG_COLOR = /* glsl */`
float rvPart = floor(vInfo.x / 8.0 + 0.01);
float rvMat = floor(vInfo.x - rvPart * 8.0 + 0.5);
float rvU = vInfo.y, rvDors = vInfo.z, rvAO = vInfo.w;
if (vInst.z < 0.999) { float dz = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); if (dz > vInst.z) discard; }
float rvSeed = vInst.x;
vec3 rvCol;
float rvRough = pSurf.x;
float rvMetal = 0.0;
float rvThin = 0.0;
float rvSheen = pSurf.y;
float rvBumpAmt = pSurf.z;
float rvGlowM = 0.0;
float rvEyeM = 0.0;
{
  // countershading: dark back → pale belly, noisy boundary
  float cn = rvVN(vRest * 3.1) - 0.5;
  vec3 base = mix(cBelly, cBack, smoothstep(-0.55, 0.45, rvDors + cn * 0.35 * pExtra.w));
  float pm = rvPattern(vRest, rvU, rvDors, rvPart);
  base = mix(base, cPattern, pm * pPattern.w);
  // per-individual variation (value + slight hue)
  base *= 0.86 + 0.28 * rvSeed;
  base = mix(base, base.gbr, (rvSeed - 0.5) * 0.06);
  // fur / skin micro albedo
  base *= 0.9 + 0.2 * rvVN(vRest * vec3(34.0, 34.0, 11.0) * (1.0 + pSurf.w));
  // legs: socks / darker extremities
  if (rvPart > 1.5 && rvPart < 2.5) base = mix(base, cPattern * 0.55 + cBack * 0.15, smoothstep(0.62, 0.92, rvU) * pExtra.x);
  // head: slightly darker muzzle
  if (rvPart > 0.5 && rvPart < 1.5) base = mix(base, base * 0.55 + cPattern * 0.2, smoothstep(0.75, 1.0, rvU) * 0.6);
  rvCol = base;
  if (rvMat > 0.5 && rvMat < 1.5) {          // keratin: horns, hooves, beaks, claws
    rvCol = mix(cKeratin, cKeratin * 0.35, smoothstep(0.2, 1.0, rvU)) * (0.9 + 0.2 * rvVN(vRest * 60.0));
    rvRough = 0.42; rvSheen = 0.0; rvBumpAmt = 0.25;
  } else if (rvMat > 1.5 && rvMat < 2.5) {   // eyes
    rvCol = cEye * 0.25; rvRough = 0.06; rvSheen = 0.0; rvBumpAmt = 0.0; rvEyeM = 1.0;
  } else if (rvMat > 2.5 && rvMat < 3.5) {   // membranes (wings, fins, frills, inner ears)
    float veins = smoothstep(0.08, 0.0, abs(fract(rvU * 9.0 + rvVN(vRest * 4.0) * 0.8) - 0.5) - 0.42);
    rvCol = mix(mix(cBelly, cAccent, 0.35 + 0.35 * rvU), cPattern * 0.6, veins * 0.5);
    rvThin = 1.0; rvRough = 0.55; rvSheen *= 0.3; rvBumpAmt *= 0.3;
  } else if (rvMat > 3.5 && rvMat < 4.5) {   // carapace
    rvCol = mix(cBack, cPattern, pm * pPattern.w) * (0.75 + 0.25 * rvSeed);
    rvRough = 0.22; rvSheen = 0.0; rvBumpAmt *= 0.4;
  } else if (rvMat > 4.5 && rvMat < 5.5) {   // glow organs
    rvCol = mix(cGlow, vec3(1.0), 0.2) * 0.5; rvRough = 0.3;
  } else if (rvMat > 5.5 && rvMat < 6.5) {   // jelly
    rvCol = mix(cBelly, cGlow, 0.4); rvRough = 0.15; rvThin = 1.0; rvSheen = 0.0;
  } else if (rvMat > 6.5) {                  // dark (mouth, nostrils, pads)
    rvCol = cBack * 0.12; rvRough = 0.7;
  }
  if (rvPart > 2.5 && rvPart < 3.5 && rvMat < 0.5) rvThin = 0.6;   // ears are thin skin
  rvGlowM = rvGlowMask(vRest, rvU, rvDors, rvPart, rvMat);
}
vec4 diffuseColor = vec4(rvCol, opacity);
`;

const FRAG_ROUGH = /* glsl */`
#include <roughnessmap_fragment>
roughnessFactor = rvRough;
`;
const FRAG_METAL = /* glsl */`
#include <metalnessmap_fragment>
metalnessFactor = rvMetal;
`;
const FRAG_NORMAL = /* glsl */`
#include <normal_fragment_maps>
if (rvBumpAmt > 0.001) {
  // fur strands / skin pores / scales, faded by pixel footprint to avoid shimmer
  vec3 bp = vRest * vec3(90.0, 90.0, 30.0) * (0.6 + pSurf.w);
  float fw = length(fwidth(bp));
  float fade = 1.0 - smoothstep(0.6, 2.4, fw);
  if (fade > 0.001) {
    float h = rvVN(bp) * 0.6 + rvVN(bp * 2.3) * 0.4;
    if (rvMat > 3.5 && rvMat < 4.5) h = rvWor(vRest * 24.0).x;
    normal = normalize(mix(normal, rvBump(-vViewPosition, normal, h * rvBumpAmt * 0.012), fade));
  }
}
`;
const FRAG_EMISSIVE = /* glsl */`
#include <emissivemap_fragment>
{
  float night = clamp(uNight, 0.0, 1.0);
  float pulse = 0.75 + 0.25 * sin(rvTime * pGlow.z + rvSeed * 20.0 + rvU * 6.0);
  totalEmissiveRadiance += cGlow * rvGlowM * pGlow.x * (0.08 + 1.4 * night * night) * pulse * (0.7 + 0.6 * vInst.y);
  // eyeshine: retroreflection in the dark
  totalEmissiveRadiance += cEye * rvEyeM * pGlow.w * night * 2.5;
}
`;
const FRAG_LIGHT = /* glsl */`
#include <lights_fragment_end>
{
  float ao = mix(1.0, rvAO, 0.85);
  reflectedLight.indirectDiffuse *= ao;
  reflectedLight.indirectSpecular *= ao;
  vec3 V = geometryViewDir;
  vec3 N = normal;
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  vec3 Lv = normalize((viewMatrix * vec4(rvSunDir, 0.0)).xyz);
  vec3 amb = (irradiance + iblIrradiance) * RECIPROCAL_PI;
  // fur sheen / rim (soft velvet outline that separates the silhouette from the ground)
  float rim = pow(1.0 - ndv, 3.0);
  reflectedLight.indirectDiffuse += diffuseColor.rgb * amb * rim * rvSheen * 1.6 * ao;
  reflectedLight.directDiffuse += diffuseColor.rgb * rvSunColor * rim * rvSheen * 0.35 * clamp(dot(N, Lv) + 0.5, 0.0, 1.0);
  // translucency: sun shining through thin parts (ears, membranes, fins, jelly)
  float back = pow(clamp(dot(-V, Lv), 0.0, 1.0), 3.0);
  float wrap = clamp(-dot(N, Lv) * 0.6 + 0.4, 0.0, 1.0);
  reflectedLight.directDiffuse += (diffuseColor.rgb * 0.7 + cAccent * 0.3) * rvSunColor * rvThin * pExtra.z * (back * 0.9 + wrap * 0.18);
  // carapace iridescence
  if (rvMat > 3.5 && rvMat < 4.5 && pExtra.y > 0.0) {
    vec3 ir = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + ndv * 1.6 + rvSeed * 0.3));
    reflectedLight.indirectSpecular += ir * pExtra.y * (amb * 2.0 + rvSunColor * 0.15) * (1.0 - ndv * 0.6);
  }
  // eye catch-light (sky reflection)
  if (rvEyeM > 0.5) {
    vec3 R = reflect(-V, N);
    reflectedLight.indirectSpecular += (amb * 3.0 + vec3(0.02)) * pow(clamp(R.y * 0.5 + 0.5, 0.0, 1.0), 6.0);
  }
}
`;

/** Shared per-species look uniforms (colors & params). */
export function createLookUniforms(boneTexture, look) {
  return {
    uBones: { value: boneTexture },
    cBack: { value: look.back }, cBelly: { value: look.belly }, cPattern: { value: look.pattern },
    cAccent: { value: look.accent }, cKeratin: { value: look.keratin }, cEye: { value: look.eye }, cGlow: { value: look.glow },
    pPattern: { value: new THREE.Vector4(...look.patternParams) },
    pGlow: { value: new THREE.Vector4(...look.glowParams) },
    pSurf: { value: new THREE.Vector4(...look.surf) },
    pExtra: { value: new THREE.Vector4(...look.extra) },
    uNight: G.uNight,
    rvTime: G.uTime,
    rvSunDir: G.uSunDir,
    rvSunColor: G.uSunColor,
  };
}

/**
 * Create a creature material pair (color + shadow depth) for one LOD mesh.
 * lookUniforms: from createLookUniforms (shared between LODs); rowOffset: { value } own per LOD.
 */
export function createCreatureMaterials(lookUniforms, rowOffset, { transparent = false, opacity = 0.8 } = {}) {
  const uniforms = { ...lookUniforms, uRowOffset: rowOffset };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.0, transparent, depthWrite: !transparent });
  if (transparent) mat.opacity = opacity;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <beginnormal_vertex>', BEGINNORMAL)
      .replace('#include <begin_vertex>', BEGIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <metalnessmap_fragment>', FRAG_METAL)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
      .replace('#include <lights_fragment_end>', FRAG_LIGHT);
  };
  mat.customProgramCacheKey = () => (transparent ? 'rv-fauna-skin-t3' : 'rv-fauna-skin-3');

  const depth = new THREE.MeshDepthMaterial();
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.uBones = uniforms.uBones;
    shader.uniforms.uRowOffset = uniforms.uRowOffset;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <beginnormal_vertex>', BEGINNORMAL)
      .replace('#include <begin_vertex>', BEGIN);
  };
  depth.customProgramCacheKey = () => 'rv-fauna-depth-3';
  return { material: mat, depth };
}
