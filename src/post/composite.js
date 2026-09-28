// Composite (HDR → display) and final (AA / sharpen / grain / dither / fade) shaders.
//
// composite: CA → bloom (additive or energy-conserving scatter) → exposure (manual × adapted)
//            → white balance → lens flare (sun ghosts, halo, starburst, streak) + screen-space
//            ghosts + lens dirt → Purkinje night shift → AgX (+ film look) / ACES / Reinhard
//            → vignette → black point → sRGB encode → 3D grading LUT
// final:     FXAA 3.11 (quality) or CAS sharpening (after TAA) → film grain (luma-gated, zero in
//            black) → triangular dither (zero in black) → fade overlay.

export const COMPOSITE_FRAG = /* glsl */ `
precision highp sampler3D;
#include <rv_common>
uniform sampler2D tColor, tBloom, tBloomWide, tAdapt, tSunVis, tDirt;
uniform sampler3D tLUT;
uniform float uHasBloom, uBloomMode, uBloomStrength, uBloomScatter;
uniform float uExposure, uAuto, uAEKey, uAEMin, uAEMax, uAEStrength;
uniform float uTemperature, uTint, uLookPower, uLookSat;
uniform float uVignette, uChromatic, uBlackPoint, uLutSize, uUseLUT; uniform int uTonemap;
uniform vec2 uRes;
uniform vec2 uSunUv; uniform vec3 uSunCol; uniform float uFlare, uGhosts, uStarburst, uStreak, uHalo, uDirt, uSSGhost, uHasDirt, uFlareRot;
uniform float uPurkinje;
varying vec2 vUv;

vec3 agxContrast(vec3 x){
  vec3 x2 = x*x; vec3 x4 = x2*x2;
  return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232;
}
vec3 agx(vec3 c){
  const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  c = m * max(c, 0.0);
  c = clamp(log2(max(c, 1e-10)), -12.47393, 4.026069);
  c = (c + 12.47393) / (4.026069 + 12.47393);
  c = agxContrast(c);
  // AgX look (ASC-CDL power + saturation in AgX space, like Blender's "Punchy")
  c = pow(max(c, 0.0), vec3(uLookPower));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = l + uLookSat * (c - l);
  c = mi * c;
  return pow(max(c, 0.0), vec3(2.2));
}
vec3 aces(vec3 x){ const float a=2.51,b=0.03,c2=2.43,d=0.59,e=0.14; return clamp((x*(a*x+b))/(x*(c2*x+d)+e),0.0,1.0); }
vec3 linearToSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }

float hexDist(vec2 p){ p = abs(p); return max(p.x * 0.866025 + p.y * 0.5, p.y); }

vec3 sunFlare(vec2 uv, float vis){
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  vec2 d = (uv - uSunUv) * asp;
  float r = length(d);
  vec3 f = vec3(0.0);
  // halo / veiling glare around the sun
  f += uSunCol * uHalo * (0.035 / (1.0 + r * r * 900.0) + 0.012 * exp(-r * 7.0));
  // starburst: 6-blade aperture diffraction spikes + fine ragged rays
  float ang = atan(d.y, d.x) + uFlareRot;
  float spikes = pow(abs(cos(ang * 3.0)), 180.0) + 0.5 * pow(abs(cos(ang * 3.0 + 1.5708)), 400.0);
  float ragged = rv_hash11(floor((ang + 3.1416) * 40.0)) * 0.6 + 0.4;
  ragged *= pow(abs(sin(ang * 23.0 + 1.3)), 6.0);
  f += uSunCol * uStarburst * (spikes * 0.5 + ragged * 0.12) * (0.04 / (0.02 + r * 3.0)) * exp(-r * 3.5);
  // anamorphic streak
  f += uSunCol * vec3(0.55, 0.75, 1.0) * uStreak * exp(-abs(d.y) * 220.0) * exp(-abs(d.x) * 1.8) * 0.18;
  // ghosts along the optical axis (sun → centre → beyond), hexagonal aperture, tinted coatings
  vec2 axis = vec2(0.5) - uSunUv;
  vec3 g = vec3(0.0);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float t = (i == 0 ? 0.32 : i == 1 ? 0.62 : i == 2 ? 0.85 : i == 3 ? 1.22 : i == 4 ? 1.5 : i == 5 ? 1.78 : 2.25);
    float sz = (i == 0 ? 0.035 : i == 1 ? 0.018 : i == 2 ? 0.07 : i == 3 ? 0.028 : i == 4 ? 0.11 : i == 5 ? 0.045 : 0.16);
    vec3 tint = (i == 0 ? vec3(1.0, 0.55, 0.2) : i == 1 ? vec3(0.3, 0.9, 0.7) : i == 2 ? vec3(0.45, 0.4, 1.0) :
                 i == 3 ? vec3(1.0, 0.8, 0.35) : i == 4 ? vec3(0.25, 0.6, 1.0) : i == 5 ? vec3(0.9, 0.35, 0.7) : vec3(0.4, 0.8, 0.5));
    vec2 p = (uv - (uSunUv + axis * t)) * asp;
    // slight chromatic separation per ghost
    float hr = hexDist(p * 1.0 / sz), hb = hexDist(p * 0.97 / sz);
    float shapeR = smoothstep(1.0, 0.82, hr), shapeB = smoothstep(1.0, 0.82, hb);
    float rim = smoothstep(0.7, 0.98, hr) * shapeR;           // brighter rim like a real ghost
    vec3 sh = vec3(shapeR, mix(shapeR, shapeB, 0.5), shapeB) * (0.55 + 0.9 * rim);
    g += tint * sh * (i == 6 ? 0.25 : 0.55) / (1.0 + fi * 0.25);
  }
  // ghosts fade when the sun is near the centre (they collapse) and brighten off-axis
  float off = clamp(length(axis * asp) * 2.2, 0.0, 1.0);
  f += g * uGhosts * 0.05 * (0.35 + 0.65 * off) * (uSunCol / max(rv_luma(uSunCol), 1e-3)) * min(rv_luma(uSunCol), 2.0);
  // lens dirt catches the sun
  if (uHasDirt > 0.5) f += uSunCol * uDirt * texture2D(tDirt, uv).r * 0.35 * exp(-r * 1.6);
  return f * vis;
}

void main(){
  vec2 uv = vUv;
  vec2 dc = uv - 0.5;
  vec3 col;
  if (uChromatic > 0.0) {
    vec2 caOff = dc * uChromatic * (0.5 + dot(dc, dc) * 2.0);
    col.r = texture2D(tColor, uv - caOff).r;
    col.g = texture2D(tColor, uv).g;
    col.b = texture2D(tColor, uv + caOff).b;
  } else col = texture2D(tColor, uv).rgb;
  col = max(col, 0.0);

  vec3 bloomW = vec3(0.0);
  if (uHasBloom > 0.5) {
    vec3 b = texture2D(tBloom, uv).rgb;
    if (uBloomMode < 0.5) col += b * uBloomStrength;
    else col = mix(col, b, uBloomScatter);                     // energy-conserving scatter
    bloomW = texture2D(tBloomWide, uv).rgb;
  }

  // exposure: manual × eye adaptation
  float expo = uExposure;
  float adaptL = 1.0;
  if (uAuto > 0.5) {
    float la = texture2D(tAdapt, vec2(0.5)).r;
    adaptL = exp2(la);
    expo *= clamp(pow(uAEKey / max(adaptL, 1e-6), uAEStrength), uAEMin, uAEMax);
  }
  col *= expo;
  bloomW *= expo;
  // white balance (scene-referred, simple temperature/tint)
  col *= vec3(1.0 + uTemperature * 0.10, 1.0 - uTint * 0.06, 1.0 - uTemperature * 0.10);

  // lens: sun flare + screen-space ghosts of every bright light + dirt
  float sunVis = uFlare > 0.0 ? texture2D(tSunVis, vec2(0.5)).r * uFlare : 0.0;
  if (sunVis > 1e-3) col += sunFlare(uv, sunVis);
  if (uHasBloom > 0.5 && (uSSGhost > 0.0 || uDirt > 0.0)) {
    vec2 tc = 1.0 - uv;
    vec2 gv = (0.5 - tc) * 0.55;
    vec3 ss = vec3(0.0);
    for (int i = 1; i < 4; i++) {
      vec2 o = tc + gv * float(i);
      float w = pow(max(1.0 - length(0.5 - o) / 0.7071, 0.0), 6.0);
      ss += max(texture2D(tBloomWide, o).rgb * expo - 1.0, 0.0) * w * (i == 2 ? vec3(0.6, 0.8, 1.0) : vec3(1.0, 0.85, 0.7));
    }
    col += ss * uSSGhost;
    // dirt only lights up where strong light hits the lens (highlights, not the whole image)
    if (uHasDirt > 0.5) col += max(bloomW - 0.8, 0.0) * texture2D(tDirt, uv).r * uDirt;
  }

  // Purkinje shift: in scotopic adaptation dim tones drift toward blue and lose saturation
  if (uPurkinje > 0.0 && uAuto > 0.5) {
    float night = 1.0 - smoothstep(0.004, 0.05, adaptL);
    float l = rv_luma(col);
    float dim = 1.0 - smoothstep(0.02, 0.6, l);
    col = mix(col, vec3(l) * vec3(0.72, 0.92, 1.3), night * dim * uPurkinje);
  }

  if (uTonemap == 0) col = agx(col);
  else if (uTonemap == 1) col = aces(col * 0.8);
  else if (uTonemap == 2) col = col / (1.0 + col);
  col = clamp(col, 0.0, 1.0);

  // vignette (optical cos^4-like falloff, aspect-correct)
  float vr = length(dc * vec2(uRes.x / uRes.y, 1.0)) * 1.25;
  col *= 1.0 - uVignette * smoothstep(0.25, 1.1, vr);
  col = max(col - uBlackPoint, 0.0) / (1.0 - uBlackPoint);
  vec3 enc = linearToSRGB(clamp(col, 0.0, 1.0));
  if (uUseLUT > 0.5) {
    vec3 lc = enc * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    enc = texture(tLUT, lc).rgb;
  }
  gl_FragColor = vec4(enc, 1.0);
}`;

export const FINAL_FRAG = /* glsl */ `
#include <rv_common>
uniform sampler2D tSrc; uniform vec2 uInvRes; uniform float uMode, uSharpen, uGrain, uTime, uFade;
uniform vec3 uFadeColor;
varying vec2 vUv;
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 S(vec2 p){ return texture2D(tSrc, p).rgb; }

vec3 fxaa(vec2 uv){
  vec3 rgbM = S(uv);
  float lM = luma(rgbM);
  float lN = luma(S(uv + vec2(0, uInvRes.y))), lS = luma(S(uv - vec2(0, uInvRes.y)));
  float lE = luma(S(uv + vec2(uInvRes.x, 0))), lW = luma(S(uv - vec2(uInvRes.x, 0)));
  float lMin = min(lM, min(min(lN, lS), min(lE, lW)));
  float lMax = max(lM, max(max(lN, lS), max(lE, lW)));
  float range = lMax - lMin;
  if (range < max(0.0312, lMax * 0.125)) return rgbM;
  float lNW = luma(S(uv + vec2(-uInvRes.x, uInvRes.y))), lNE = luma(S(uv + uInvRes));
  float lSW = luma(S(uv - uInvRes)), lSE = luma(S(uv + vec2(uInvRes.x, -uInvRes.y)));
  // edge orientation
  float edgeH = abs(-2.0 * lW + lNW + lSW) + 2.0 * abs(-2.0 * lM + lN + lS) + abs(-2.0 * lE + lNE + lSE);
  float edgeV = abs(-2.0 * lS + lSW + lSE) + 2.0 * abs(-2.0 * lM + lW + lE) + abs(-2.0 * lN + lNW + lNE);
  bool horz = edgeH >= edgeV;
  float l1 = horz ? lS : lW, l2 = horz ? lN : lE;
  float g1 = l1 - lM, g2 = l2 - lM;
  bool steep1 = abs(g1) >= abs(g2);
  float gScaled = 0.25 * max(abs(g1), abs(g2));
  float stepLen = horz ? uInvRes.y : uInvRes.x;
  float lLocal;
  if (steep1) { stepLen = -stepLen; lLocal = 0.5 * (l1 + lM); } else lLocal = 0.5 * (l2 + lM);
  vec2 cuv = uv;
  if (horz) cuv.y += stepLen * 0.5; else cuv.x += stepLen * 0.5;
  vec2 off = horz ? vec2(uInvRes.x, 0.0) : vec2(0.0, uInvRes.y);
  vec2 uv1 = cuv - off, uv2 = cuv + off;
  float e1 = luma(S(uv1)) - lLocal, e2 = luma(S(uv2)) - lLocal;
  bool r1 = abs(e1) >= gScaled, r2 = abs(e2) >= gScaled;
  for (int i = 0; i < 10; i++) {
    if (r1 && r2) break;
    float q = i < 3 ? 1.0 : i < 6 ? 1.5 : i < 8 ? 2.0 : 4.0;
    if (!r1) { uv1 -= off * q; e1 = luma(S(uv1)) - lLocal; r1 = abs(e1) >= gScaled; }
    if (!r2) { uv2 += off * q; e2 = luma(S(uv2)) - lLocal; r2 = abs(e2) >= gScaled; }
  }
  float d1 = horz ? uv.x - uv1.x : uv.y - uv1.y;
  float d2 = horz ? uv2.x - uv.x : uv2.y - uv.y;
  bool dir1 = d1 < d2;
  float dMin = min(d1, d2);
  float edgeLen = d1 + d2;
  float pixOff = -dMin / edgeLen + 0.5;
  bool lMlow = lM < lLocal;
  bool correct = ((dir1 ? e1 : e2) < 0.0) != lMlow;
  float fo = correct ? pixOff : 0.0;
  // sub-pixel aliasing
  float lAvg = (1.0 / 12.0) * (2.0 * (lN + lS + lE + lW) + lNW + lNE + lSW + lSE);
  float sub = clamp(abs(lAvg - lM) / range, 0.0, 1.0);
  sub = (-2.0 * sub + 3.0) * sub * sub;
  float subOff = sub * sub * 0.75;
  fo = max(fo, subOff);
  vec2 fuv = uv;
  if (horz) fuv.y += fo * stepLen; else fuv.x += fo * stepLen;
  return S(fuv);
}

vec3 cas(vec2 uv){
  vec3 b = S(uv + vec2(0, -uInvRes.y)), d = S(uv + vec2(-uInvRes.x, 0)), e = S(uv);
  vec3 f = S(uv + vec2(uInvRes.x, 0)), h = S(uv + vec2(0, uInvRes.y));
  vec3 mn = min(e, min(min(b, d), min(f, h))), mx = max(e, max(max(b, d), max(f, h)));
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
  vec3 w = -amp * mix(0.125, 0.2, uSharpen);
  return clamp((e + w * (b + d + f + h)) / (1.0 + 4.0 * w), 0.0, 1.0);
}

void main(){
  vec3 c = uMode > 1.5 ? cas(vUv) : uMode > 0.5 ? fxaa(vUv) : S(vUv);
  float l = luma(c);
  // film grain: gaussian-ish (sum of 2 hashes), strongest in mid-tones, zero in true black
  vec2 fc = gl_FragCoord.xy;
  float t = fract(uTime * 7.31) * 517.0;
  float n = rv_hash12(fc + t) + rv_hash12(fc * 1.37 + t * 1.7) - 1.0;
  float gw = smoothstep(0.0, 0.12, l) * (1.0 - 0.55 * smoothstep(0.5, 1.0, l));
  c += n * uGrain * gw * vec3(1.0, 0.97, 1.03);
  // triangular dither against 8-bit banding (never lifts pure black)
  float dn = rv_ign(fc + t) + rv_hash12(fc + 91.7 + t) - 1.0;
  c += dn / 255.0 * step(0.5 / 255.0, max(c.r, max(c.g, c.b)));
  c = mix(c, uFadeColor, uFade);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
