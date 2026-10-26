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
uniform vec4 pHaze;      // strength, body height (rest m), density (1/m), ground-mist bias
uniform vec3 rvHaze;     // sky ambient (≈ haze colour)
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
  if (type < 0.5 || type > 8.5) return 0.0;
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
    float band = smoothstep(0.3, 0.62, dors + (rvFbm(P * sc) - 0.5) * 0.45);
    float flank = smoothstep(0.13, 0.0, abs(dors + 0.1 + (rvFbm(P * sc * 1.6) - 0.5) * 0.22) - 0.03);
    m = max(band, flank * 0.7) * (0.8 + 0.2 * rvVN(P * sc * 3.0));
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
  } else if (type < 4.5) {                                            // veins over the whole body
    float n = abs(rvFbm(P * pPattern.y * 1.3) - 0.5);
    g = max(g, smoothstep(0.05, 0.0, n));
  } else {                                                            // photophores: rows of dots on flanks & belly + lateral line
    vec2 wv = rvWor(P * pPattern.y * 3.2 + 1.7);
    float dots = 1.0 - smoothstep(0.12, 0.24, wv.x);
    float lat = smoothstep(0.05, 0.0, abs(dors + 0.12) - 0.018);
    g = max(g, (dots * smoothstep(0.55, -0.1, dors) + lat * 0.8) * step(part, 1.5));
    g = max(g, dots * 0.8 * step(5.5, part) * step(part, 6.5));        // fins
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
  // fur / skin micro albedo — faded by pixel footprint (value noise at pixel frequency aliases
  // into a 2x2-quad checkerboard, worst on software GL); rotated domain hides the lattice
  {
    vec3 mp = mat3(0.80, 0.36, -0.48, -0.60, 0.48, -0.64, 0.0, 0.80, 0.60) * (vRest * vec3(26.0, 26.0, 9.0) * (1.0 + pSurf.w));
    float mfw = length(fwidth(mp));
    float mfade = 1.0 - smoothstep(0.2, 0.7, mfw);
    base *= 1.0 + (rvVN(mp) - 0.5) * 0.2 * mfade;
    // coarser mottling that survives at mid distance (never aliases: ~5x larger cells)
    vec3 cp = vRest * (5.0 + 4.0 * pSurf.w);
    float cfade = 1.0 - smoothstep(0.25, 0.8, length(fwidth(cp)));
    base *= 1.0 + (rvVN(cp + 17.0) - 0.5) * 0.14 * cfade;
  }
  // legs: socks / darker extremities
  if (rvPart > 1.5 && rvPart < 2.5) base = mix(base, cPattern * 0.55 + cBack * 0.15, smoothstep(0.62, 0.92, rvU) * pExtra.x);
  // head: slightly darker muzzle
  if (rvPart > 0.5 && rvPart < 1.5) base = mix(base, base * 0.55 + cPattern * 0.2, smoothstep(0.75, 1.0, rvU) * 0.6);
  rvCol = base;
  if (rvMat > 0.5 && rvMat < 1.5) {          // keratin: horns, hooves, beaks, claws
    rvCol = mix(cKeratin, cKeratin * 0.35, smoothstep(0.2, 1.0, rvU)) * (0.9 + 0.2 * rvVN(vRest * 60.0));
    rvRough = 0.42; rvSheen = 0.0; rvBumpAmt = 0.25;
  } else if (rvMat > 1.5 && rvMat < 2.5) {   // eyes: dark sclera → coloured iris → pupil (u = pole param, 1 = front)
    float iris = smoothstep(0.86, 0.885, rvU);
    float pupil = smoothstep(0.935, 0.952, rvU);
    float irisN = 0.75 + 0.5 * rvVN(vec3(atan(vRest.y, vRest.x) * 3.0, rvU * 20.0, rvSeed * 7.0));
    rvCol = mix(cBack * 0.18, cEye * irisN * mix(0.45, 0.95, smoothstep(0.935, 0.87, rvU)), iris);
    rvCol = mix(rvCol, vec3(0.01), pupil);
    rvRough = 0.16; rvSheen = 0.0; rvBumpAmt = 0.0; rvEyeM = 0.35 + 0.65 * pupil;
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
  if (pPattern.x > 7.5 && pPattern.x < 8.5) {
    rvGlowM *= smoothstep(0.15, 0.7, uNight);     // its spirit light shows only at dusk and night
    // ---- made of the world (colossus): bark and twisted root, lichen, moss cushions, blossom, old wood
    bool legP = rvPart > 1.5 && rvPart < 2.5;
    // the neck (above the back, in the rest pose) is old wood: furrows run along its axis (~53 deg up),
    // moss only in streaks, so a lowered head comes down on a neck of bark, not a green tube
    float neckK = legP ? 0.0 : smoothstep(0.7, 0.8, vRest.y / max(pHaze.y, 0.01));
    vec3 fp = legP ? vRest * vec3(1.9, 0.22, 1.9)
            : neckK > 0.5 ? vec3(vRest.x * 1.3, dot(vRest.yz, vec2(0.6, -0.8)) * 1.3, dot(vRest.yz, vec2(0.8, 0.6)) * 0.24)
            : vRest * vec3(1.3, 1.3, 0.24);
    float fib = rvFbm(fp * 1.6 + 3.0);
    float crev = smoothstep(0.32, 0.62, rvVN(fp * 3.4 + fib * 1.7));
    vec3 bark = mix(cBack * 0.42, cBack * 1.18, crev) * (0.82 + 0.36 * rvVN(vRest * 0.45 + 11.0));
    // lichen rosettes (pale grey-green) on the bark
    vec2 lw = rvWor(vRest * 1.25 + 4.0);
    float lich = (1.0 - smoothstep(0.16, 0.3, lw.x)) * smoothstep(0.35, 0.7, rvVN(vRest * 0.35));
    bark = mix(bark, cBelly * (0.85 + 0.3 * rvVN(vRest * 6.0)), lich * 0.75);
    // moss creeping over every up-facing surface and the upper legs
    float mn = rvFbm(vRest * 0.55 + 2.0) - 0.5;
    float mossM = legP ? smoothstep(0.62, 0.15, rvU + mn * 0.5) * smoothstep(-0.6, 0.2, rvDors + mn)
                       : smoothstep(0.0, 0.55, rvDors + mn * 1.5);   // patchy: bark shows through on the flanks and neck
    mossM = max(mossM, smoothstep(0.62, 0.78, rvFbm(vRest * 0.32 + 7.0)) * 0.85);     // moss patches anywhere
    mossM *= mix(1.0, 0.15 + 0.85 * smoothstep(0.5, 0.72, rvFbm(fp * vec3(1.6, 1.6, 0.5) + 4.0)), neckK);
    vec3 mossC = cPattern * (0.7 + 0.6 * rvVN(vRest * 2.6 + 5.0));
    if (rvMat < 0.5 || rvMat > 6.5) {
      rvCol = mix(bark, mossC, mossM * pPattern.w * (rvMat > 6.5 ? 0.2 : 1.0));
      if (rvMat > 6.5) rvCol *= 0.5;
      rvRough = mix(0.86, 0.95, mossM); rvSheen = 0.12 * mossM; rvBumpAmt = mix(1.7, 0.7, mossM);
      if (rvPart > 0.5 && rvPart < 1.5 && rvMat < 0.5) {
        // the face: a pale mask of old weathered wood (a forest spirit's face), grain running down the
        // muzzle, dark grooves, moss creeping in from the crown; reads at any distance as a pale face
        float maskM = smoothstep(0.18, 0.36, rvU) * smoothstep(-0.7, -0.25, rvDors) * (1.0 - smoothstep(0.55, 0.95, rvDors + mn * 0.6) * 0.65);
        float grain = rvVN(vRest * vec3(7.0, 7.0, 0.7) + 21.0);
        vec3 wood = mix(cKeratin * 0.5, cKeratin * 1.12, smoothstep(0.25, 0.75, grain)) * (0.9 + 0.2 * rvVN(vRest * 1.3));
        rvCol = mix(rvCol, wood, maskM);
        rvRough = mix(rvRough, 0.7, maskM); rvSheen *= 1.0 - maskM; rvBumpAmt = mix(rvBumpAmt, 1.2, maskM);
      }
    } else if (rvMat > 0.5 && rvMat < 1.5) {
      // antlers and the sapling: pale weathered wood, darker in the grooves, moss in the forks
      float wf = rvVN(vRest * vec3(0.8, 5.0, 0.8));
      rvCol = mix(cKeratin * 0.45, cKeratin, smoothstep(0.2, 0.8, wf));
      rvCol = mix(rvCol, mossC, smoothstep(0.55, 0.85, rvFbm(vRest * 0.9)) * 0.5);
      rvRough = 0.8; rvSheen = 0.0; rvBumpAmt = 1.1;
    }
    if (rvPart > 9.5 && rvPart < 10.5) {
      // moss cushions and hanging moss: velvety, lighter tips
      rvCol = mossC * mix(0.75, 1.25, smoothstep(-0.4, 0.9, rvDors)) * (0.85 + 0.3 * rvVN(vRest * 9.0));
      rvRough = 0.96; rvSheen = 0.45; rvBumpAmt = 0.5; rvThin = 0.25;
    } else if (rvPart > 10.5) {
      // blossom: florets packed over leafy shrubs, translucent petals glowing when backlit
      // a mass of blossom (petal colour throughout, florets in two sizes, shadowed gaps) with a few
      // leafy sprigs showing through; not dots painted on a brown ball
      vec2 wv = rvWor(vRest * 4.6 + 9.0);
      float fl = 1.0 - smoothstep(0.22, 0.55, wv.x);
      vec3 fp2 = vRest * 12.0 + 3.0;
      float f2k = 1.0 - smoothstep(0.3, 0.8, length(fwidth(fp2)));
      vec2 wv2 = rvWor(fp2);
      float fl2 = mix(0.5, 1.0 - smoothstep(0.18, 0.5, wv2.x), f2k);
      float vary = rvVN(vRest * 1.3);
      vec3 petal = cAccent * (0.86 + 0.24 * vary);
      vec3 cc = petal * (0.58 + 0.27 * fl + 0.22 * fl2);
      float leaf = smoothstep(0.64, 0.82, rvFbm(vRest * 1.6 + 2.0)) * 0.55;
      rvCol = mix(cc, cPattern * 1.1, leaf);
      rvRough = 0.72; rvSheen = 0.2; rvBumpAmt = 0.4; rvThin = 0.85;
      rvGlowM = max(rvGlowM, fl * 0.35);
    }
  }
  if (pPattern.x > 8.5 && rvMat < 0.5) {
    // ---- sky whale skin (after the humpback): slate back with an irregular splashy flank boundary,
    // pale throat with ventral pleats from chin to navel, the long mouth line, tubercles on the
    // rostrum, barnacle clusters on chin and flipper tips, a few pale scars raked over the back
    float iR = pPattern.z;                  // 1 / body radius
    vec3 q = vRest * iR;                    // body in radius units (L ~ 7 R)
    float zl = q.z * 0.14;                  // ~ z / L
    float fwq = length(fwidth(q));
    float n1 = rvFbm(vRest * iR * 1.3 + 3.0);
    float bound = rvDors + (n1 - 0.5) * 0.55 + 0.1 * sin(q.z * 2.3 + n1 * 4.0);
    vec3 c = mix(cBelly, cBack, smoothstep(-0.28, 0.12, bound));
    c = mix(c, cBack * 0.85, smoothstep(0.66, 0.78, rvFbm(vRest * iR * 2.6 + 9.0)) * smoothstep(0.0, -0.45, rvDors) * 0.35);
    float pleatZone = smoothstep(-0.3, -0.62, rvDors) * smoothstep(-0.04, 0.08, zl) * smoothstep(0.52, 0.43, zl) * step(rvPart, 1.5);
    float pl = abs(fract(q.x * 5.0 + (rvVN(vRest * iR * 3.0) - 0.5) * 0.45) - 0.5);
    float pleat = smoothstep(0.14, 0.04, pl) * (1.0 - smoothstep(0.1, 0.3, fwq * 5.0));
    c *= 1.0 - pleat * pleatZone * 0.42;
    float my = mix(-0.12, -0.36, smoothstep(0.515, 0.33, zl));
    float mouth = smoothstep(0.04, 0.015, abs(q.y - my)) * smoothstep(0.3, 0.34, zl) * step(0.22, abs(q.x)) * step(rvPart, 1.5);
    c = mix(c, cBack * 0.12, mouth * 0.85);
    vec2 tw = rvWor(vRest * iR * 9.0 + 2.0);
    float knob = (1.0 - smoothstep(0.12, 0.24, tw.x)) * smoothstep(0.37, 0.43, zl) * (1.0 - smoothstep(0.1, 0.35, fwq * 9.0));
    c = mix(c, mix(cBelly, cBack, 0.4) * 1.1, knob * 0.65);
    float barn = smoothstep(0.6, 0.8, rvFbm(vRest * iR * 4.0 + 1.0)) * (smoothstep(0.4, 0.47, zl) * smoothstep(-0.2, -0.6, rvDors) + (rvPart > 5.5 && rvPart < 6.5 ? smoothstep(0.65, 1.0, rvU) : 0.0));
    c = mix(c, vec3(0.6, 0.6, 0.56) * (0.8 + 0.4 * rvVN(vRest * iR * 20.0)), clamp(barn, 0.0, 1.0) * 0.55);
    float scar = smoothstep(0.035, 0.0, abs(fract(q.z * 0.9 + q.y * 1.7 + rvFbm(vRest * iR * 0.8) * 1.2) - 0.5) - 0.465) * smoothstep(0.0, 0.5, rvDors) * smoothstep(0.55, 0.7, rvVN(vRest * iR * 1.1 + 5.0));
    c = mix(c, mix(cBack, cBelly, 0.6), scar * 0.5);
    rvCol = c * (0.9 + 0.2 * rvSeed);
    rvRough = mix(0.48, 0.62, smoothstep(0.0, -0.5, rvDors)); rvSheen = 0.25; rvBumpAmt = 0.45;
  }
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
  vec3 bp = vRest * vec3(110.0, 110.0, 26.0) * (0.6 + pSurf.w);
  float fw = length(fwidth(bp));
  float fade = 1.0 - smoothstep(0.18, 0.55, fw);
  if (fade > 0.001) {
    float h = rvVN(bp) * 0.6 + (rvVN(bp * 2.3) - 0.5) * 0.4 * (1.0 - smoothstep(0.08, 0.24, fw)) + 0.2;
    if (rvMat > 3.5 && rvMat < 4.5) h = rvWor(vRest * 24.0).x;
    // fur: finer, gentler strands (a strong bump reads as bark / stucco); scales & carapace keep it
    float bk = mix(1.0, 0.45, clamp(pSurf.w, 0.0, 1.0) * (rvMat < 0.5 ? 1.0 : 0.0));
    normal = normalize(mix(normal, rvBump(-vViewPosition, normal, h * rvBumpAmt * 0.012 * bk), fade));
  }
}
`;
const FRAG_EMISSIVE = /* glsl */`
#include <emissivemap_fragment>
{
  float night = clamp(uNight, 0.0, 1.0);
  float pulse = 0.75 + 0.25 * sin(rvTime * pGlow.z + rvSeed * 20.0 + rvU * 6.0);
  float rvGk = 1.0;
  {
    vec3 Vj = normalize(vViewPosition);
    float frj = pow(1.0 - clamp(abs(dot(normal, Vj)), 0.0, 1.0), 2.0);
    if (rvMat > 5.5 && rvMat < 6.5) {
      rvGk = 0.18 + 1.7 * frj + 0.35 * smoothstep(0.2, 1.0, rvU);          // translucent bell: glowing rim, clear centre
      if (rvPart < 0.5) {
        // the four glowing horseshoes seen through the bell (a moon jelly's clover), and radial canals
        float ang = atan(vRest.z, vRest.x);
        float lobe = 0.5 + 0.5 * cos(ang * 4.0);
        rvGk += 1.5 * smoothstep(0.06, 0.0, abs(rvU - (0.2 + 0.15 * lobe))) * smoothstep(0.2, 0.85, lobe);
        rvGk += 0.35 * smoothstep(0.9, 1.0, cos(ang * 8.0)) * smoothstep(0.3, 0.9, rvU);
      }
    }
    else if (rvMat > 4.5 && rvMat < 5.5 && rvPart > 7.5 && rvPart < 8.5)                                   // tentacles: a trail of glowing beads
      rvGk = (0.3 + 0.9 * smoothstep(0.55, 1.0, sin(rvU * 46.0 - rvTime * 2.2 + rvSeed * 9.0))) * (1.0 - 0.6 * rvU);
  }
  // small glowing life fades to faint points with distance (no saturated halos dotting far night terrain);
  // giants and sky whales (haze-shaded) keep their light
  float rvFarK = pHaze.x > 0.0 ? 1.0 : mix(1.0, 0.3, smoothstep(90.0, 600.0, length(vViewPosition)));
  totalEmissiveRadiance += cGlow * rvGlowM * pGlow.x * (0.08 + 1.4 * night * night) * pulse * (0.7 + 0.6 * vInst.y) * rvGk * rvFarK;
  // bioluminescent species read as lit volumes at night, not rim outlines: a dim self-illumination
  // of the whole body (the glow scattered under translucent skin), brighter on the belly and toward
  // the silhouette (fresnel), mottled so it reads organic
  if (pGlow.x > 0.0 && rvMat != 2.0 && rvMat != 7.0) {
    vec3 Vw = normalize(vViewPosition);
    float fr = pow(1.0 - clamp(abs(dot(normal, Vw)), 0.0, 1.0), 2.2);
    float belly = smoothstep(0.35, -0.85, rvDors);
    float mott = 0.65 + 0.7 * rvVN(vRest * pPattern.y * 1.7 + rvSeed * 9.0);
    vec3 sub = mix(diffuseColor.rgb * 1.2 + 0.01, cGlow, 0.72);
    // strong dorsal → ventral gradient (dark back, glowing belly) so the body keeps its volume
    float k = (0.01 + 0.13 * pow(belly, 1.5) + 0.09 * fr * (0.35 + 0.65 * belly)) * mott * (0.8 + 0.4 * pulse);
    totalEmissiveRadiance += sub * k * min(pGlow.x, 2.0) * night * (0.7 + 0.6 * vInst.y);
  }
  // eyeshine: retroreflection in the dark
  totalEmissiveRadiance += cEye * rvEyeM * pGlow.w * night * 2.5;
  // the colossus' eyes keep a soft inner light by day too (a gentle spirit looking at you)
  if (pPattern.x > 7.5 && pPattern.x < 8.5 && rvMat > 1.5 && rvMat < 2.5) totalEmissiveRadiance += cGlow * (0.35 + 0.65 * smoothstep(0.86, 0.95, rvU)) * (0.6 + 2.0 * night);
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
  // fur / soft skin: light scattered in the coat wraps past the terminator (no hard plastic edge)
  // and the coat is a poor specular reflector except at grazing angles (handled by the sheen)
  {
    float furK = clamp(pSurf.w, 0.0, 1.0) * (rvMat < 0.5 ? 1.0 : 0.0);
    float nl = dot(N, Lv);
    float wrapD = clamp((nl + 0.5) / 1.5, 0.0, 1.0) - clamp(nl, 0.0, 1.0);
    reflectedLight.directDiffuse += diffuseColor.rgb * rvSunColor * wrapD * 0.42 * furK * ao;
    reflectedLight.directSpecular *= 1.0 - 0.55 * furK;
  }
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
  if (rvMat > 1.5 && rvMat < 2.5) {
    vec3 R = reflect(-V, N);
    reflectedLight.indirectSpecular += (amb * 1.4 + vec3(0.006)) * pow(clamp(R.y * 0.5 + 0.5, 0.0, 1.0), 8.0);
  }
  // backlight rim: the silhouette catches the sun when the creature stands against it (rim light
  // carries the form, as in the reference frames), plus a faint sky rim on every silhouette
  {
    float behind = clamp(dot(-V, Lv), 0.0, 1.0);
    float edge = pow(1.0 - ndv, 2.6);
    float rimK = edge * (0.12 + 0.88 * behind * behind) * (1.0 - 0.5 * rvThin);
    reflectedLight.directDiffuse += (diffuseColor.rgb * 0.6 + 0.05) * rvSunColor * rimK * 0.55 * ao;
    reflectedLight.indirectDiffuse += amb * edge * 0.35 * (diffuseColor.rgb + 0.04) * ao;
  }
}
`;
const FRAG_HAZE = /* glsl */`
{
  // giants are mostly haze and silhouette: the farther, the paler and cooler, and the mist takes the
  // head before the feet (height above the creature's own ground, rest frame)
  if (pHaze.x > 0.0) {
    float d = length(vViewPosition);
    float hk = clamp(vRest.y / max(pHaze.y, 0.01), 0.0, 1.25);
    float fog = (1.0 - exp(-d * pHaze.z)) * pHaze.x * mix(1.0, 0.25 + 0.75 * smoothstep(0.0, 1.0, hk), pHaze.w);
    vec3 Lh = normalize((viewMatrix * vec4(rvSunDir, 0.0)).xyz);
    float fs = pow(clamp(dot(normalize(-vViewPosition), Lh), 0.0, 1.0), 6.0);
    vec3 hc = rvHaze * vec3(0.95, 1.0, 1.07) + rvSunColor * fs * 0.07;
    outgoingLight = mix(outgoingLight, hc, clamp(fog, 0.0, 0.9));
  }
}
#include <opaque_fragment>
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
    pHaze: { value: new THREE.Vector4(0, 1, 0, 0) },
    rvHaze: G.uAmbientSky,
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
      .replace('#include <lights_fragment_end>', FRAG_LIGHT)
      .replace('#include <opaque_fragment>', FRAG_HAZE);
  };
  mat.customProgramCacheKey = () => (transparent ? 'rv-fauna-skin-t4' : 'rv-fauna-skin-4');

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
