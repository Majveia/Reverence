// Flora materials: MeshStandardMaterial + onBeforeCompile so the engine's lights, (cascaded) sun
// shadows, hemisphere/env ambient and fog all apply. Every material has a matching depth material
// (same instancing + wind) so shadows move with the foliage.
//
// Per-instance attributes (InstancedBufferGeometry, mesh positioned at a layer anchor):
//   iPos  = (offset from anchor xyz, uniform scale)   iRot = quaternion (model → world)
//   iData = (seed, rank, tint shift, spare)
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { registerChunk } from '../../shaders/chunks.js';

// ------------------------------------------------------------------ shared GLSL
registerChunk('rv_flora', /* glsl */`
#ifndef RV_FLORA
#define RV_FLORA
vec3 rvQrot(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
float rvIGN(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// temporal dither: the pattern shifts every TAA sub-frame / frame so crossfades and alpha edges
// resolve to smooth gradients instead of a fixed screen-door pattern
uniform float uDitherF; uniform float uDitherA;
float rvDither(vec2 p){ return rvIGN(p + 5.588238 * mod(uDitherF, 64.0)); }
// LOD band: x..y fade in, z..w fade out (linear so neighbouring LODs are exactly complementary)
vec2 rvLodFade(float d, vec4 f){
  float fin = f.y > f.x ? clamp((d - f.x) / (f.y - f.x), 0.0, 1.0) : 1.0;
  float fout = f.w > f.z ? clamp((f.w - d) / (f.w - f.z), 0.0, 1.0) : 1.0;
  return vec2(fin, fout);
}
// distance thinning for far layers: keep instances whose rank < f(d)
float rvThin(float d, float rank, vec4 t){
  if (t.w < 0.5) return 1.0;
  float f = clamp(pow(t.x / max(d, 1.0), t.y), t.z, 1.0);
  return smoothstep(0.0, 0.06, f - rank);
}
#endif
`);

// Wind needs uTime/uWindDir/uWindStrength declared before inclusion (vertex shaders only).
registerChunk('rv_flora_wind', /* glsl */`
#ifndef RV_FLORA_WIND
#define RV_FLORA_WIND
vec3 rvTangentWind(vec3 up, vec3 wind){
  vec3 wd = wind - up * dot(wind, up);
  float wl = length(wd);
  return wl > 1e-3 ? wd / wl : normalize(cross(up, vec3(0.0, 0.0, 1.0)) + vec3(1e-4));
}
// Coherent wind: traveling gusts across the landscape + per-plant sway + leaf flutter.
vec3 rvWind(vec3 wp, vec3 pl, vec3 up, float flex, float phase, float flutter, float sc, float amp, float seed){
  vec3 wd = rvTangentWind(up, uWindDir);
  vec3 side = cross(up, wd);
  float s = uWindStrength;
  float along = dot(pl, wd);
  float gust = 0.5 + 0.5 * sin(along * 0.05 - uTime * 1.7 + sin(dot(pl, side) * 0.021) * 2.5);
  gust = gust * gust * (0.7 + 0.3 * sin(along * 0.013 - uTime * 0.6));
  float t = uTime * (0.9 + seed * 0.25) + phase * 6.2832 + seed * 17.0;
  float sway = sin(t * 1.25) * 0.55 + sin(t * 2.9 + 1.3) * 0.2;
  float bend = s * (0.25 + 1.1 * gust) + s * s * 0.4;
  vec3 disp = wd * (bend * (0.75 + 0.35 * sway)) * flex * amp * sc;
  disp += side * (sin(t * 1.7 + 0.5) * 0.22 * s) * flex * amp * sc;
  if (flutter > 0.0) {
    float f = sin(t * 8.5 + dot(wp, vec3(3.1, 2.3, 1.7))) * cos(t * 5.3 + wp.y * 3.0);
    disp += (up * 0.6 + wd * 0.5 + side * 0.4) * f * 0.07 * (0.3 + s) * flutter * (0.4 + gust) * sc;
  }
  float dl = length(disp);
  disp -= up * dl * dl / max(0.8, 2.0 * length(wp));
  return disp;
}
#endif
`);

const PLANT_VERT_PARS = /* glsl */`
#include <rv_flora>
attribute vec4 iPos; attribute vec4 iRot; attribute vec4 iData;
attribute vec4 aInfo; attribute vec3 aShade; attribute vec3 aColor; attribute vec3 aCorner; attribute vec3 aGlowL;
varying vec3 vGlowL;
uniform vec4 uFade; uniform vec4 uDFade; uniform vec4 uThin; uniform float uWindAmp; uniform float uBillboard;
uniform vec3 uCamPos; uniform vec3 uPlanetCenter; uniform float uTime; uniform vec3 uWindDir; uniform float uWindStrength;
uniform float uTintVar; uniform float uShadowPush;
#include <rv_flora_wind>
varying vec2 vAtlasUv; varying vec4 vInfo; varying vec3 vCol; varying vec3 vShadeN; varying vec2 vFade; varying vec3 vObjPos; varying float vSeed;
vec3 rvCardC = vec3(0.0); float rvIsCard = 0.0;
`;

// Builds `transformed` from instance data. DEPTH_PASS is defined for shadow materials.
const PLANT_BEGIN = /* glsl */`
vec3 transformed;
{
  vec3 base = iPos.xyz;
  vec3 wb = (modelMatrix * vec4(base, 1.0)).xyz;
  vec3 pl = wb - uPlanetCenter;
  vec3 up = normalize(pl);
  float d = length(wb - uCamPos);
  #ifdef DEPTH_PASS
    vFade = rvLodFade(d, uDFade);
  #else
    vFade = rvLodFade(d, uFade);
  #endif
  float thin = rvThin(d, iData.y, uThin);
  float sc = iPos.w * thin;
  vec3 wp = rvQrot(iRot, position * sc);
  vec3 wp0 = wp;
  if (aCorner.z > 0.5) {
    vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 bb = (camR * aCorner.x + camU * aCorner.y) * sc;
    // partial billboarding keeps a hint of parallax; full in shadow passes
    #ifdef DEPTH_PASS
      wp += bb;
      vec3 camF = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
      wp += camF * uShadowPush * sc;
    #else
      vec3 st = rvQrot(iRot, vec3(aCorner.x, aCorner.y, 0.0)) * sc;
      wp += mix(st, bb, uBillboard);
    #endif
  }
  float kind = floor(aInfo.x / 16.0 + 0.001);
  vec3 wnd = rvWind(wp, pl, up, aInfo.y, aInfo.w, (kind > 0.5 && kind < 2.5) ? 1.0 : 0.0, sc, uWindAmp, iData.x);
  wp += wnd;
  transformed = base + wp;
  // card centre (with the same wind) for filtered shadow lookups, see PLANT_SHADOW_VERT
  rvCardC = base + wp0 + wnd;
  rvIsCard = aCorner.z;
  if (vFade.x * vFade.y <= 0.001 || sc <= 1e-4) transformed = base;
  vAtlasUv = uv;
  vInfo = aInfo;
  #ifndef DEPTH_PASS
  vGlowL = aGlowL;
  #endif
  float tv = (iData.z - 0.5) * uTintVar;
  vCol = aColor * vec3(1.0 + tv * 0.6, 1.0 + tv * 0.25, 1.0 - tv * 0.35) * (1.0 + (iData.x - 0.5) * uTintVar * 0.35);
  vObjPos = position;
  vSeed = iData.x;
}
`;

// Leaf-card shadow lookups: sample the sun shadow around the card centre (footprint shrunk to 10%)
// instead of per pixel. Cascade texels are several cm while cards are ~1.5 m clusters of leaves:
// per-pixel lookups stair-step into blocky "voxel" self-shadowing; the shrunk footprint gives each
// leaf cluster a smooth light→shade gradient (dappled, painterly canopy light).
const PLANT_SHADOW_VERT = /* glsl */`
#include <shadowmap_vertex>
#if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
  if (rvIsCard > 0.5) {
    vec3 rvCW = (modelMatrix * vec4(rvCardC, 1.0)).xyz;
    vSunShadowWorldPosition.xyz = mix(rvCW, vSunShadowWorldPosition.xyz, 0.1);
  }
#endif
`;

const PLANT_FRAG_PARS = /* glsl */`
#include <rv_flora>
uniform sampler2D uAtlas; uniform highp sampler2DArray uBark; uniform float uBarkLayer; uniform float uBarkScale;
uniform vec3 uTint2; uniform float uTransl; uniform float uGlowStr; uniform float uCardGlow; uniform float uNight; uniform float uTime;
uniform vec3 uMoss; uniform float uMossAmt; uniform float uAtlasSize; uniform float uSpec;
varying vec3 vGlowL;
varying vec2 vAtlasUv; varying vec4 vInfo; varying vec3 vCol; varying vec3 vShadeN; varying vec2 vFade; varying vec3 vObjPos; varying float vSeed;
float rvTransl = 0.0;
float rvWrap = 0.0;
float rvKind = 0.0;
float rvBarkH = 0.5;
vec2 rvGrad = vec2(0.0);   // height gradient in texture space (per filtered texel step)
vec3 rvGlow = vec3(0.0);
// Perturb a view-space normal by a texture-space height gradient using the screen-space cotangent
// frame (Mikkelsen). Only derivatives of interpolated position/uv are used (smooth per triangle), so
// there are no 2×2-quad blocks like dFdx(texture) bump mapping produces.
vec3 rvPerturb(vec3 N, vec3 vpos, vec2 uv, vec2 g, float k){
  vec3 dp1 = dFdx(vpos), dp2 = dFdy(vpos);
  vec2 du1 = dFdx(uv), du2 = dFdy(uv);
  vec3 p2 = cross(dp2, N), p1 = cross(N, dp1);
  vec3 T = p2 * du1.x + p1 * du2.x;
  vec3 B = p2 * du1.y + p1 * du2.y;
  float im = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
  return normalize(N - k * (g.x * T + g.y * B) * im);
}
float rvPatternHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rvH3(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float rvVN3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rvH3(i), rvH3(i + vec3(1,0,0)), f.x), mix(rvH3(i + vec3(0,1,0)), rvH3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(rvH3(i + vec3(0,0,1)), rvH3(i + vec3(1,0,1)), f.x), mix(rvH3(i + vec3(0,1,1)), rvH3(i + vec3(1,1,1)), f.x), f.y), f.z); }
float rvSolidN = 0.5;
vec3 rvPattern(float pat, vec2 uv, vec3 col){
  if (pat < 0.5) return col;
  if (pat < 1.5) { // spots (mushroom caps): jittered dots
    vec2 g = uv * vec2(14.0, 7.0); vec2 id = floor(g); vec2 f = fract(g) - 0.5;
    vec2 o = vec2(rvPatternHash(id), rvPatternHash(id + 7.3)) - 0.5;
    float d = length(f - o * 0.5);
    float sz = 0.12 + 0.2 * rvPatternHash(id + 3.1);
    return mix(col, vec3(0.95, 0.92, 0.85), (1.0 - smoothstep(sz, sz + 0.05, d)) * step(0.35, rvPatternHash(id + 1.7)) * step(uv.y, 0.85));
  }
  if (pat < 2.5) { // candy stripes
    float s = smoothstep(-0.15, 0.15, sin((uv.y * 7.0 + uv.x) * 6.2832));
    return mix(col, vec3(0.95, 0.93, 0.9), s * 0.85);
  }
  if (pat < 3.5) { // polka dots
    vec2 g = uv * vec2(10.0, 6.0); vec2 f = fract(g) - 0.5;
    float d = length(f);
    return mix(col, col.gbr * 1.25 + 0.15, 1.0 - smoothstep(0.18, 0.23, d));
  }
  if (pat < 4.5) { // eyeball: iris around the pole (v≈0)
    float r = uv.y;
    vec3 white = vec3(0.92, 0.9, 0.86);
    vec3 c = mix(white, col, 1.0 - smoothstep(0.17, 0.19, r));
    c = mix(c, vec3(0.02), 1.0 - smoothstep(0.075, 0.085, r));
    c = mix(c, vec3(1.0), (1.0 - smoothstep(0.02, 0.03, distance(uv, vec2(0.2, 0.04)))) );
    c *= 1.0 - 0.35 * smoothstep(0.55, 0.75, sin(uv.x * 40.0) * 0.5 + 0.5) * step(0.25, r) * step(r, 0.6) * 0.3;
    return c;
  }
  if (pat < 5.5) { // radial gills
    float g = 0.5 + 0.5 * sin(uv.x * 6.2832 * 48.0);
    return col * (0.55 + 0.45 * g);
  }
  if (pat < 6.5) { // bands
    float b = 0.5 + 0.5 * sin(uv.y * 30.0 + sin(uv.x * 6.2832 * 3.0) * 0.8);
    return col * (0.75 + 0.35 * b);
  }
  // vertical ribs (cactus, stalks)
  float rb = 0.5 + 0.5 * cos(uv.x * 6.2832 * 12.0);
  return col * (0.7 + 0.35 * rb);
}
`;

const PLANT_MAP = /* glsl */`
float kind = floor(vInfo.x / 16.0 + 0.001);
float pat = vInfo.x - kind * 16.0;
rvKind = kind;
vec3 albedo = vCol;
float alpha = 1.0;
if (kind < 0.5) {
  vec2 buv = vAtlasUv * vec2(1.0, uBarkScale);
  vec4 bk = texture(uBark, vec3(buv, uBarkLayer));
  rvBarkH = bk.g;
  {
    vec2 fw = fwidth(buv);
    vec2 e = max(fw, vec2(1.0 / 256.0, 1.0 / 512.0));
    float hx = texture(uBark, vec3(buv + vec2(e.x, 0.0), uBarkLayer)).g;
    float hy = texture(uBark, vec3(buv + vec2(0.0, e.y), uBarkLayer)).g;
    // fade relief with distance (texel footprint) → no sparkle far away
    float nearK = 1.0 - smoothstep(0.02, 0.12, max(fw.x, fw.y));
    rvGrad = vec2(hx - bk.g, hy - bk.g) * (0.35 + 0.65 * nearK);
  }
  albedo = vCol * (0.5 + 0.8 * bk.r);
  albedo = mix(albedo, uMoss * (0.6 + 0.6 * bk.r), clamp(bk.b * uMossAmt * 1.5, 0.0, 1.0));
} else if (kind < 2.5) {
  vec4 tx = texture2D(uAtlas, vAtlasUv);
  vec2 px = vAtlasUv * uAtlasSize;
  vec2 dx = dFdx(px), dy = dFdy(px);
  float mip = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
  alpha = tx.a * (1.0 + mip * 0.14);
  albedo = mix(vCol, uTint2, tx.g) * (0.38 + tx.r * 0.95);
  rvBarkH = tx.r;
  {
    vec2 e = max(fwidth(vAtlasUv), vec2(1.0 / uAtlasSize)) * 1.5;
    float hx = texture2D(uAtlas, vAtlasUv + vec2(e.x, 0.0)).r;
    float hy = texture2D(uAtlas, vAtlasUv + vec2(0.0, e.y)).r;
    rvGrad = vec2(hx - tx.r, hy - tx.r) * (1.0 - smoothstep(1.5, 4.0, mip) * 0.7);
  }
  rvTransl = tx.b * uTransl * (kind > 1.5 ? 1.3 : 1.0);
  rvWrap = 0.5;
  if (uCardGlow > 0.0 && kind > 1.5) rvGlow = albedo * uCardGlow * (0.05 + uNight) * (0.8 + 0.2 * sin(uTime * 1.3 + vSeed * 20.0));
} else {
  albedo = rvPattern(pat, vAtlasUv, vCol);
  // material breakup on solids (caps, stalks, bulbs): mottling + fine grain, drives roughness too
  rvSolidN = rvVN3(vObjPos * 2.3 + vSeed * 17.0) * 0.6 + rvVN3(vObjPos * 9.0 + 3.1) * 0.4;
  albedo *= 0.8 + 0.38 * rvSolidN;
  if (kind > 3.5 && kind < 4.5) {
    float pulse = 0.85 + 0.15 * sin(uTime * (0.8 + vSeed) + vSeed * 30.0 + vObjPos.y * 0.5);
    rvGlow = albedo * uGlowStr * (0.08 + 0.92 * uNight) * pulse;
    rvTransl = uTransl * 0.6;
  }
  if (kind > 4.5) {
    float band = 0.5 + 0.5 * sin(vObjPos.y * 3.0 + vSeed * 10.0);
    rvGlow = albedo * uGlowStr * (0.12 + 0.88 * uNight) * (0.6 + 0.4 * band);
    rvTransl = 0.5;
  }
  rvWrap = 0.2;
}
// bounce light from the plant's own glowing parts (baked per vertex, see PlantBuilder._bakeGlow)
if (uGlowStr > 0.0 && kind < 3.5) rvGlow += (albedo + 0.05) * vGlowL * uGlowStr * 0.6 * (0.03 + 0.97 * uNight);
// LOD crossfade (complementary dither, temporally shifted so TAA resolves it)
float dth = rvDither(gl_FragCoord.xy);
// soft alpha-tested leaf edges: jitter the coverage threshold (TAA averages it into a soft edge)
if (uDitherA > 0.0 && kind > 0.5 && kind < 2.5) alpha += (dth - 0.5) * uDitherA;
// dissolve foliage/branches right in front of the camera so they never smother the view
{ float cd = length(vViewPosition); if (cd < 3.2 && dth > smoothstep(1.0, 3.2, cd)) discard; }
if (vFade.y < 0.999 && dth >= vFade.y) discard;
if (vFade.x < 0.999 && (1.0 - dth) >= vFade.x) discard;
diffuseColor.rgb *= albedo;
diffuseColor.a = alpha;
`;

const PLANT_NORMAL = /* glsl */`
#include <normal_fragment_begin>
if (rvKind > 0.5 && rvKind < 2.5) {
  // crown-level (spherified) normal + per-leaf relief from the atlas luminance: sunlit vs shaded leaves
  normal = normalize(vShadeN);
  normal = rvPerturb(normal, -vViewPosition, vAtlasUv, rvGrad, 2.2);
} else if (rvKind < 0.5) {
  normal = rvPerturb(normal, -vViewPosition, vAtlasUv * vec2(1.0, uBarkScale), rvGrad, 5.0);
} else {
  normal = normalize(mix(normal, normalize(vShadeN), 0.5));
}
`;

// Foliage lighting: wrap diffuse + thin-leaf translucency (shadowed, since directLight.color
// already includes the shadow term).
export const PLANT_LIGHT_PARS = /* glsl */`
#include <lights_physical_pars_fragment>
void RE_Direct_Flora(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  RE_Direct_Physical(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  float nl = dot(geometryNormal, directLight.direction);
  if (rvWrap > 0.0) {
    float w = clamp((nl + rvWrap) / (1.0 + rvWrap), 0.0, 1.0) - clamp(nl, 0.0, 1.0);
    reflectedLight.directDiffuse += directLight.color * BRDF_Lambert(material.diffuseContribution) * w * 0.8;
  }
  if (rvTransl > 0.0) {
    float back = clamp(-nl, 0.0, 1.0);
    float scat = pow(clamp(dot(geometryViewDir, -directLight.direction), 0.0, 1.0), 4.0);
    vec3 tcol = material.diffuseContribution * vec3(1.05, 1.15, 0.6);
    reflectedLight.directDiffuse += directLight.color * tcol * rvTransl * (0.25 * back + 1.6 * scat) * RECIPROCAL_PI * 2.0;
  }
}
#undef RE_Direct
#define RE_Direct RE_Direct_Flora
`;

const PLANT_AO = /* glsl */`
{
  float ao = vInfo.z;
  reflectedLight.indirectDiffuse *= ao;
  reflectedLight.indirectSpecular *= ao;
  reflectedLight.directDiffuse *= mix(1.0, ao, 0.45);
  reflectedLight.directSpecular *= ao * uSpec;
}
#include <aomap_fragment>
`;

const PLANT_ROUGH = /* glsl */`
#include <roughnessmap_fragment>
if (rvKind < 0.5) roughnessFactor = 0.92;
else if (rvKind < 2.5) roughnessFactor = clamp(0.44 + 0.34 * rvBarkH + 0.16 * fract(vSeed * 7.13 + vAtlasUv.x * 3.0), 0.42, 0.92); // leaf-to-leaf sheen breakup
else if (rvKind < 4.5) roughnessFactor = 0.38 + 0.4 * rvSolidN;
else roughnessFactor = 0.1;
`;

/** shared foliage textures + static uniforms */
export class FloraShared {
  constructor({ atlas, atlasSize, bark }) {
    this.atlas = atlas;
    this.atlasSize = atlasSize;
    this.bark = bark;
  }
}

export function linkCommon(shader, u) {
  shader.uniforms.uTime = G.uTime;
  shader.uniforms.uWindDir = G.uWindDir;
  shader.uniforms.uWindStrength = G.uWindStrength;
  shader.uniforms.uCamPos = G.uCameraPos;
  shader.uniforms.uPlanetCenter = G.uPlanetCenter;
  shader.uniforms.uNight = G.uNight;
  shader.uniforms.uDitherF = FLORA_DITHER.frame;
  shader.uniforms.uDitherA = FLORA_DITHER.amt;
  for (const k in u) shader.uniforms[k] = u[k];
}

/** shared temporal-dither state (updated per draw from the TAA sub-frame index, see index.js) */
export const FLORA_DITHER = { frame: { value: 0 }, amt: { value: 0 } };

/**
 * Plant material pair for one (model, LOD) layer.
 * params: { shared, barkLayer, tint2, transl, glow, cardGlow, moss, mossAmt, windAmp, billboard,
 *           fade:[4], thin:[4], tintVar, shadowPush, alphaToCoverage }
 */
export function makePlantMaterials(p) {
  const u = {
    uAtlas: { value: p.shared.atlas }, uBark: { value: p.shared.bark }, uAtlasSize: { value: p.shared.atlasSize },
    uBarkLayer: { value: p.barkLayer ?? 0 }, uBarkScale: { value: p.barkScale ?? 1 },
    uTint2: { value: new THREE.Color().fromArray(p.tint2 ?? [0.12, 0.08, 0.05]) },
    uTransl: { value: p.transl ?? 0.8 }, uGlowStr: { value: p.glow ?? 0 }, uCardGlow: { value: p.cardGlow ?? 0 },
    uMoss: { value: new THREE.Color().fromArray(p.moss ?? [0.1, 0.16, 0.05]) }, uMossAmt: { value: p.mossAmt ?? 0.3 },
    uFade: { value: new THREE.Vector4(...(p.fade ?? [0, 0, 1e9, 1e9])) }, uDFade: { value: new THREE.Vector4(...(p.dfade ?? p.fade ?? [0, 0, 1e9, 1e9])) },
    uThin: { value: new THREE.Vector4(...(p.thin ?? [0, 1, 0, 0])) },
    uWindAmp: { value: p.windAmp ?? 1 }, uBillboard: { value: p.billboard ?? 0.85 },
    uTintVar: { value: p.tintVar ?? 0.35 }, uShadowPush: { value: p.shadowPush ?? 0.35 }, uSpec: { value: p.spec ?? 1 },
  };
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.65, metalness: 0, side: THREE.DoubleSide,
    alphaTest: 0.5, alphaToCoverage: !!p.alphaToCoverage,
  });
  mat.name = 'flora-plant';
  mat.onBeforeCompile = (shader) => {
    linkCommon(shader, u);
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + PLANT_VERT_PARS);
    vs = vs.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = rvQrot(iRot, normal);\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(tangent.xyz);\n#endif');
    vs = vs.replace('#include <begin_vertex>', PLANT_BEGIN + '\nvShadeN = normalize(normalMatrix * rvQrot(iRot, aShade));');
    vs = vs.replace('#include <shadowmap_vertex>', PLANT_SHADOW_VERT);
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\n' + PLANT_FRAG_PARS);
    fs = fs.replace('#include <map_fragment>', PLANT_MAP);
    fs = fs.replace('#include <normal_fragment_begin>', PLANT_NORMAL);
    fs = fs.replace('#include <lights_physical_pars_fragment>', PLANT_LIGHT_PARS);
    fs = fs.replace('#include <roughnessmap_fragment>', PLANT_ROUGH);
    fs = fs.replace('#include <aomap_fragment>', PLANT_AO);
    // glowing solids: brightest facing the viewer, dimmer toward the rim → lanterns read as round,
    // translucent bodies with form instead of flat bloom discs
    fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n{ float fr = (rvKind > 3.5 && rvKind < 4.5) ? mix(0.3, 1.0, pow(clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 1.3)) : 1.0; totalEmissiveRadiance += rvGlow * fr; }');
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'rv-flora-plant-v4';

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  depth.name = 'flora-plant-depth';
  depth.onBeforeCompile = (shader) => {
    linkCommon(shader, u);
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', '#define DEPTH_PASS\n#include <common>\n' + PLANT_VERT_PARS);
    vs = vs.replace('#include <begin_vertex>', PLANT_BEGIN);
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\n' + /* glsl */`
uniform sampler2D uAtlas; uniform float uAtlasSize;
varying vec2 vAtlasUv; varying vec4 vInfo; varying vec2 vFade;
float rvIGNd(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`);
    fs = fs.replace('#include <alphatest_fragment>', /* glsl */`
{
  if (vFade.y < 0.999 && rvIGNd(gl_FragCoord.xy) >= vFade.y) discard;
  float kind = floor(vInfo.x / 16.0 + 0.001);
  if (kind > 0.5 && kind < 2.5) {
    // Shadow casters use a coarse mip of the leaf coverage (clump-level blobs, not individual
    // leaves): per-leaf holes are far below the cascade texel size and alias into blocky
    // "voxel" self-shadowing on canopies; blobby clump shadows read like real soft canopy shade.
    float a = texture(uAtlas, vAtlasUv, 3.5).a;
    if (a < 0.42) discard;
  }
}`);
    shader.fragmentShader = fs;
  };
  depth.customProgramCacheKey = () => 'rv-flora-plant-depth-v2';
  return { material: mat, depth, uniforms: u };
}

// ------------------------------------------------------------------ rocks
const ROCK_VERT_PARS = /* glsl */`
#include <rv_flora>
attribute vec4 iPos; attribute vec4 iRot; attribute vec4 iData; attribute vec4 aRock;
uniform vec4 uFade; uniform vec4 uThin; uniform vec3 uCamPos; uniform vec3 uPlanetCenter;
varying vec3 vObjP; varying vec3 vObjN; varying vec4 vRock; varying vec3 vUpW; varying vec3 vWN; varying vec2 vFade; varying float vSeed; varying float vTint;
`;
const ROCK_BEGIN = /* glsl */`
vec3 transformed;
{
  vec3 base = iPos.xyz;
  vec3 wb = (modelMatrix * vec4(base, 1.0)).xyz;
  float d = length(wb - uCamPos);
  vFade = rvLodFade(d, uFade);
  float sc = iPos.w * rvThin(d, iData.y, uThin);
  transformed = base + rvQrot(iRot, position * sc);
  if (vFade.x * vFade.y <= 0.001 || sc <= 1e-4) transformed = base;
  vObjP = position * iPos.w;
  vRock = aRock;
  vUpW = normalize(wb - uPlanetCenter);
  vSeed = iData.x; vTint = iData.z;
}
`;
const ROCK_FRAG_PARS = /* glsl */`
#include <rv_flora>
#include <rv_noise>
uniform sampler2D uRockTex; uniform vec3 uRockA; uniform vec3 uRockB; uniform vec3 uMossC; uniform float uMossAmt; uniform float uStrata;
uniform float uTexScale; uniform float uWet; uniform vec3 uSnowC; uniform float uSnow;
varying vec3 vObjP; varying vec3 vObjN; varying vec4 vRock; varying vec3 vUpW; varying vec3 vWN; varying vec2 vFade; varying float vSeed; varying float vTint;
float rkH = 0.5; float rkMoss = 0.0;
vec4 rvTri(vec3 p, vec3 w){ return texture2D(uRockTex, p.yz) * w.x + texture2D(uRockTex, p.xz) * w.y + texture2D(uRockTex, p.xy) * w.z; }
`;
const ROCK_MAP = /* glsl */`
{
  float dth = rvDither(gl_FragCoord.xy);
  if (vFade.y < 0.999 && dth >= vFade.y) discard;
  if (vFade.x < 0.999 && (1.0 - dth) >= vFade.x) discard;
  vec3 bw = pow(abs(normalize(vObjN)), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
  vec3 op = vObjP * uTexScale + vSeed * 7.0;
  vec4 t1 = rvTri(op, bw);
  vec4 t2 = rvTri(op * 3.7 + 1.3, bw);
  float det = t1.r * 0.65 + t2.r * 0.35;
  rkH = t1.g * 0.6 + t2.g * 0.4;
  vec3 base = mix(uRockA, uRockB, clamp(vTint * 1.2 - 0.1 + (t1.b - 0.5) * 0.4, 0.0, 1.0));
  float strata = 0.5 + 0.5 * sin(vRock.y * 9.0 + t1.r * 2.0);
  base *= mix(1.0, 0.75 + 0.45 * strata, uStrata);
  vec3 alb = base * (0.45 + 0.95 * det) * (0.35 + 0.65 * vRock.x);
  alb *= 1.0 - t1.b * 0.35;
  // moss / lichen on top faces (world up), broken by noise
  float upf = dot(normalize(vWN), vUpW);
  float mn = rv_snoise(vObjP * 1.3 + vSeed * 13.0) * 0.5 + 0.5;
  rkMoss = smoothstep(0.25, 0.75, upf + (mn - 0.5) * 0.8 + vRock.z * 0.2) * uMossAmt;
  alb = mix(alb, uMossC * (0.55 + 0.7 * det), rkMoss);
  float sn = smoothstep(0.45, 0.8, upf + (mn - 0.5) * 0.4) * uSnow;
  alb = mix(alb, uSnowC, sn);
  diffuseColor.rgb *= alb;
}
`;
const ROCK_NORMAL = /* glsl */`
#include <normal_fragment_begin>
{
  vec3 vpos = -vViewPosition;
  vec3 dpdx = dFdx(vpos), dpdy = dFdy(vpos);
  float hx = dFdx(rkH), hy = dFdy(rkH);
  vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (hx * r1 + hy * r2);
  normal = normalize(abs(det) * normal - 1.2 * (1.0 - rkMoss * 0.7) * grad);
}
`;

export function makeRockMaterials(p) {
  const u = {
    uRockTex: { value: p.tex }, uRockA: { value: new THREE.Color().fromArray(p.colA) }, uRockB: { value: new THREE.Color().fromArray(p.colB) },
    uMossC: { value: new THREE.Color().fromArray(p.moss ?? [0.1, 0.15, 0.05]) }, uMossAmt: { value: p.mossAmt ?? 0.5 },
    uStrata: { value: p.strata ?? 0.3 }, uTexScale: { value: p.texScale ?? 0.35 }, uWet: { value: 0 },
    uSnowC: { value: new THREE.Color(0.9, 0.93, 0.97) }, uSnow: { value: p.snow ?? 0 },
    uFade: { value: new THREE.Vector4(...(p.fade ?? [0, 0, 1e9, 1e9])) }, uThin: { value: new THREE.Vector4(...(p.thin ?? [0, 1, 0, 0])) },
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0 });
  mat.name = 'flora-rock';
  mat.onBeforeCompile = (shader) => {
    linkCommon(shader, u);
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + ROCK_VERT_PARS);
    vs = vs.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = rvQrot(iRot, normal);\nvObjN = normal;\nvWN = objectNormal;');
    vs = vs.replace('#include <begin_vertex>', ROCK_BEGIN);
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\n' + ROCK_FRAG_PARS);
    fs = fs.replace('#include <map_fragment>', ROCK_MAP);
    fs = fs.replace('#include <normal_fragment_begin>', ROCK_NORMAL);
    fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.86, 1.0, rkMoss) - rkH * 0.08;');
    fs = fs.replace('#include <aomap_fragment>', '{ reflectedLight.indirectDiffuse *= 0.45 + 0.55 * vRock.x; reflectedLight.indirectSpecular *= vRock.x; }\n#include <aomap_fragment>');
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'rv-flora-rock-v1';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    linkCommon(shader, u);
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + ROCK_VERT_PARS);
    vs = vs.replace('#include <begin_vertex>', 'vec3 objectNormal = rvQrot(iRot, normal); vObjN = normal; vWN = objectNormal;\n' + ROCK_BEGIN);
    shader.vertexShader = vs;
  };
  depth.customProgramCacheKey = () => 'rv-flora-rock-depth-v1';
  return { material: mat, depth, uniforms: u };
}
