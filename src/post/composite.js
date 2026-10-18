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
#include <rv_post>
uniform sampler2D tColor, tBloom, tBloomWide, tAdapt, tSunVis, tDirt, tDepth, tSky;
uniform float uHasDepth, uNear, uFar, uHaze, uHazeDist, uTwilight, uNightLift, uEclipse, uDuskDesat;
uniform float uLookId, uLookLand, uLookAccent, uLookInk, uLookBands, uPLSat, uInkWidth;
uniform vec3 uToneA, uToneB, uToneC, uToneD;
uniform sampler3D tLUT;
uniform float uHasBloom, uBloomMode, uBloomStrength, uBloomScatter, uClarity;
uniform float uExposure, uAuto, uAEKey, uAEMin, uAEMax, uAEStrength;
uniform float uTemperature, uTint, uLookPower, uLookSat;
uniform float uVignette, uChromatic, uBlackPoint, uLutSize, uUseLUT; uniform int uTonemap;
uniform vec2 uRes;
uniform vec2 uSunUv; uniform vec3 uSunCol; uniform float uFlare, uGhosts, uStarburst, uStreak, uHalo, uDirt, uSSGhost, uHasDirt, uFlareRot;
uniform float uPurkinje, uTonemapHue;
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
// 'agx-punchy': blend AgX with a hue/saturation-preserving curve (the max channel goes through the
// same AgX tone curve, the colour keeps its scene-referred ratios) so bright saturated emitters
// (HII knots, neon, lava) keep their colour instead of sliding to white.
vec3 agxHue(vec3 c){
  vec3 a = agx(c);
  float m = max(c.r, max(c.g, c.b));
  if (m <= 1e-6) return a;
  float tm = agx(vec3(m)).g;
  vec3 h = c * (tm / m);
  return mix(a, h, uTonemapHue);
}
vec3 aces(vec3 x){ const float a=2.51,b=0.03,c2=2.43,d=0.59,e=0.14; return clamp((x*(a*x+b))/(x*(c2*x+d)+e),0.0,1.0); }
vec3 linearToSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }

float hexDist(vec2 p){ p = abs(p); return max(p.x * 0.866025 + p.y * 0.5, p.y); }

vec3 sunFlare(vec2 uv, float vis){
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  vec2 d = (uv - uSunUv) * asp;
  float r = length(d);
  vec3 f = vec3(0.0);
  // core + halo / veiling glare around the sun (a bright core also stands in for a sun disc that
  // is too small to resolve; over a rendered disc it just saturates)
  f += uSunCol * uHalo * (1.6 / (1.0 + r * r * 90000.0) + 0.05 / (1.0 + r * r * 1400.0) + 0.012 * exp(-r * 6.0));
  // starburst: 6-blade aperture diffraction spikes (thin, tapering) + fine ragged rays
  float ang = atan(d.y, d.x) + uFlareRot;
  float spikes = pow(abs(cos(ang * 3.0)), 400.0);
  float ragged = rv_hash11(floor((ang + 3.1416) * 57.0)) * rv_hash11(floor((ang + 3.1416) * 13.0) + 7.0);
  ragged = pow(ragged, 3.0) * pow(abs(sin(ang * 37.0 + 1.3)), 2.0);
  float fall = 0.03 / (0.015 + r * 4.0);
  f += uSunCol * uStarburst * (spikes * 0.35 * exp(-r * 5.0) + ragged * 0.35 * exp(-r * 9.0)) * fall;
  // anamorphic streak
  f += uSunCol * vec3(0.55, 0.75, 1.0) * uStreak * exp(-abs(d.y) * 260.0) * exp(-abs(d.x) * 2.6) * 0.14;
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
    g += tint * sh * (i == 6 ? 0.18 : 0.45) / (1.0 + fi * 0.25);
  }
  // ghosts fade when the sun is near the centre (they collapse) and brighten off-axis
  float off = clamp(length(axis * asp) * 2.2, 0.0, 1.0);
  f += g * uGhosts * 0.05 * (0.35 + 0.65 * off) * (uSunCol / max(rv_luma(uSunCol), 1e-3)) * min(rv_luma(uSunCol), 2.0);
  // lens dirt catches the sun
  if (uHasDirt > 0.5) f += uSunCol * uDirt * texture2D(tDirt, uv).r * 0.12 * exp(-r * 3.0);
  return f * vis;
}

// ---- photo looks (season 2) ---------------------------------------------------------------
float invDepth(vec2 uv){
  float d = texture2D(tDepth, uv).r;
  return rvp_isSky(d) ? 0.0 : 1.0 / max(rvp_linDepth(d, uNear, uFar), 1e-3);
}
// silhouette / crease ink from the Laplacian of inverse depth (planes are linear in 1/z → no false edges
// on grazing ground), normalised by the nearest depth so it is scale-free
float inkEdge(vec2 uv){
  vec2 px = uInkWidth / uRes;
  float c = invDepth(uv);
  float n = invDepth(uv + vec2(0.0, px.y)), s = invDepth(uv - vec2(0.0, px.y));
  float e = invDepth(uv + vec2(px.x, 0.0)), w = invDepth(uv - vec2(px.x, 0.0));
  float mx = max(max(max(n, s), max(e, w)), c);
  if (mx <= 0.0) return 0.0;
  float lap = abs(n + s + e + w - 4.0 * c) / mx;
  return smoothstep(0.12, 0.32, lap);
}
float accentMask(vec3 e){
  float I = 0.596 * e.r - 0.274 * e.g - 0.322 * e.b, Q = 0.211 * e.r - 0.523 * e.g + 0.312 * e.b;
  float C = length(vec2(I, Q));
  float d = abs(atan(Q, I) - 0.33);
  d = min(d, 6.2831853 - d);
  return (1.0 - smoothstep(0.2, 0.46, d)) * smoothstep(0.06, 0.16, C);
}
vec3 gradMap3(float g, vec3 a, vec3 b, vec3 c){
  return g < 0.62 ? mix(a, b, smoothstep(0.0, 1.0, g / 0.62)) : mix(b, c, smoothstep(0.0, 1.0, (g - 0.62) / 0.38));
}
// soft (anti-aliased) quantisation of x into n bands, 0..1
float bands(float x, float n){
  float f = x * n;
  float w = max(fwidth(f), 1e-3) * 0.75;
  float q = floor(f) + smoothstep(1.0 - w, 1.0, fract(f));
  return clamp(q / max(n - 1.0, 1.0), 0.0, 1.0);
}
vec3 palette4(float q, vec3 a, vec3 b, vec3 c, vec3 d){
  return q < 0.3334 ? mix(a, b, q * 3.0) : q < 0.6667 ? mix(b, c, q * 3.0 - 1.0) : mix(c, d, q * 3.0 - 2.0);
}
vec3 photoLook(vec3 e, vec2 uv, bool sky, vec3 bloomW){
  float L = dot(e, vec3(0.2126, 0.7152, 0.0722));
  float acc = uLookAccent > 0.0 ? accentMask(e) * uLookAccent : 0.0;
  vec3 eSat = clamp(vec3(L) + (e - vec3(L)) * 1.35, 0.0, 1.0);
  float id = uLookId;
  vec3 o = e;
  if (id < 1.5) {                       // two-tone: black → hue → pale, the land in silhouette
    float g = smoothstep(0.03, 0.92, L * (sky ? 1.0 : uLookLand));
    o = gradMap3(g, uToneA, uToneB, uToneC);
  } else if (id < 2.5) {                // high-key black and white with halation
    float h = 1.0 - exp(-rv_luma(bloomW) * 0.6);
    float g = clamp((L - 0.025) * 1.32 + h * 0.18, 0.0, 1.0);
    g = pow(g, 0.72);
    g = mix(g, g * g * (3.0 - 2.0 * g), 0.55);
    o = vec3(g);
  } else if (id < 3.5) {                // flat poster: n value bands → 4-colour palette + ink
    float q = bands(pow(L, 0.8), uLookBands);
    o = palette4(q, uToneA, uToneB, uToneC, uToneD);
  } else if (id < 4.5) {                // candy sky over a near-black land
    if (sky) { o = clamp(vec3(L) + (e - vec3(L)) * uPLSat, 0.0, 1.0); o = pow(o, vec3(0.9)); }
    else o = mix(uToneA, e, uLookLand);
  } else {                              // woodcut: stepped two-colour sky, engraved land
    if (sky) {
      float q = bands(L, uLookBands);
      o = mix(uToneB, uToneC, q);
    } else {
      float dk = 1.0 - smoothstep(0.03, 0.55, L);
      float sp = max(3.0, uRes.y / 180.0);
      vec2 fc = gl_FragCoord.xy;
      float s1 = abs(fract((fc.x - fc.y) / sp) - 0.5) * 2.0;
      float s2 = abs(fract((fc.x + fc.y) / sp) - 0.5) * 2.0;
      float t = smoothstep(dk - 0.18, dk + 0.18, s1);
      if (dk > 0.62) t *= smoothstep(dk - 0.62 - 0.12, dk - 0.62 + 0.12, s2 * 0.6);
      o = mix(uToneA, uToneD, t);
    }
  }
  if (uLookInk > 0.0 && uHasDepth > 0.5) o = mix(o, uToneA, inkEdge(uv) * uLookInk);
  return mix(o, eSat, acc);
}

void main(){
  vec2 uv = vUv;
  vec2 dc = uv - 0.5;
  float dRaw = uHasDepth > 0.5 ? texture2D(tDepth, uv).r : 0.0;
  bool sky = uHasDepth > 0.5 ? rvp_isSky(dRaw) : true;
  float dist = sky ? 1e12 : rvp_linDepth(dRaw, uNear, uFar);
  vec3 col;
  if (uChromatic > 0.0) {
    // lateral CA grows with field height: nearly none in the centre, ramping in over the outer ~25 %
    float fh = dot(dc, dc) * 2.0;                                  // 0 centre .. 1 corner
    vec2 caOff = dc * uChromatic * (0.15 + 1.85 * fh * fh);
    col.r = texture2D(tColor, uv - caOff).r;
    col.g = texture2D(tColor, uv).g;
    col.b = texture2D(tColor, uv + caOff).b;
  } else col = texture2D(tColor, uv).rgb;
  col = max(col, 0.0);

  vec3 bloomW = vec3(0.0);
  if (uHasBloom > 0.5) {
    vec3 b = texture2D(tBloom, uv).rgb;
    // clarity: ratio-based local contrast against the low-pass pyramid (cuts through flat haze;
    // multiplicative so black stays black)
    if (uClarity > 0.0 && uBloomMode > 0.5) {
      float L = rv_luma(col), Lb = rv_luma(b);
      float k = pow(clamp((L + 1e-4) / (Lb + 1e-4), 0.3, 3.0), uClarity);
      col *= mix(1.0, k, smoothstep(0.0, 0.02, Lb));
    }
    if (uBloomMode < 0.5) col += b * uBloomStrength;
    else col = mix(col, b, uBloomScatter);                     // energy-conserving scatter
    bloomW = texture2D(tBloomWide, uv).rgb;
  }

  // depth-layered aerial perspective (rule 4): each layer back drifts toward the colour of the sky near
  // the horizon (metered from the frame), paler and a touch cooler; the sky itself is untouched
  vec3 hz = vec3(0.0); float hzOk = 0.0;
  if (uHaze > 0.0 || uDuskDesat > 0.0) {
    vec4 sm = texture2D(tSky, vec2(0.5));
    hzOk = smoothstep(0.002, 0.03, sm.a);
    hz = sm.rgb / max(sm.a, 1e-5);
    float hl = rv_luma(hz);
    hz = mix(hz, vec3(hl) * vec3(0.93, 0.98, 1.08), 0.22);
  }
  if (uHaze > 0.0 && !sky && hzOk > 0.0) {
    float h = uHaze * hzOk * (1.0 - exp(-dist / uHazeDist));
    col = mix(col, hz, h);
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

  // Purkinje shift: in scotopic adaptation dim tones drift toward indigo (never grey or green) and lose
  // saturation; the land's dim tones are lifted multiplicatively (black stays 0) so nights stay readable
  if (uPurkinje > 0.0 && uAuto > 0.5) {
    float night = max(1.0 - smoothstep(0.004, 0.05, adaptL), uNightLift);
    float l = rv_luma(col);
    float dim = 1.0 - smoothstep(0.02, 0.6, l);
    col = mix(col, vec3(l) * vec3(0.6, 0.76, 1.62), night * dim * uPurkinje);
  }
  if (uNightLift > 0.0 && !sky) {
    float l = rv_luma(col);
    col *= 1.0 + uNightLift * (1.0 - smoothstep(0.0, 0.1, l));
  }
  // blue hour / dusk: the sky keeps its colour, the land loses it (desaturated toward the sky's hue)
  if (uDuskDesat > 0.0 && !sky) {
    float l = rv_luma(col);
    vec3 skyHue = hzOk > 0.0 ? hz / max(rv_luma(hz), 1e-5) : vec3(0.8, 0.9, 1.2);
    skyHue = clamp(skyHue, 0.0, 2.5);
    col = mix(col, l * skyHue, uDuskDesat);
  }
  // eclipse: darker, cooler, harder
  if (uEclipse > 0.0) {
    float l = rv_luma(col);
    col = mix(col, l * vec3(0.78, 0.9, 1.28), 0.35 * uEclipse);
    col *= pow(max(l, 1e-6) / 0.18, 0.22 * uEclipse);
  }

  if (uTonemap == 0) col = agx(col);
  else if (uTonemap == 4) col = agxHue(col);
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
  if (uLookId > 0.5) enc = photoLook(enc, uv, sky, bloomW);
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
