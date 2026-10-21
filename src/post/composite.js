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
uniform vec3 uToneA, uToneB, uToneC, uToneD, uHazeFallback;
uniform sampler3D tLUT;
uniform float uHasBloom, uBloomMode, uBloomStrength, uBloomScatter, uClarity;
uniform float uExposure, uAuto, uAEKey, uAEMin, uAEMax, uAEStrength;
uniform float uTemperature, uTint, uLookPower, uLookSat;
uniform float uVignette, uChromatic, uBlackPoint, uLutSize, uUseLUT; uniform int uTonemap;
uniform vec2 uRes;
uniform vec2 uSunUv; uniform vec3 uSunCol; uniform float uFlare, uGhosts, uStarburst, uStreak, uHalo, uDirt, uSSGhost, uHasDirt, uFlareRot;
uniform float uPurkinje, uTonemapHue, uSpaceGlow;
uniform vec2 uPlayerA, uPlayerB, uLookD, uWindUv; uniform float uPlayerR, uPlayerDist, uPlayerOn;
uniform float uGolden, uNightSky, uMist, uLandDrop; uniform vec2 uProjXY, uProjZW; uniform vec3 uSunView; uniform vec3 uGoldTint;
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
  // above the air: the star tints a wide patch of space around it (rule 6) — soft, ~a quarter of the frame
  // (tinted by the star's own colour, a little more saturated than the core so the halo reads as colour)
  vec3 gcol = max(mix(vec3(1.0), uSunCol, 1.6), vec3(0.0));
  f += gcol * uSpaceGlow * (0.055 / (1.0 + r * r * 36.0) + 0.022 * exp(-r * 2.8));
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
// rim: this pixel is land and a neighbour ~1.5 px away is much farther (or sky) → the silhouette's edge
// against what lies behind it (the backlit fringe that keeps a black figure readable on a dark ground)
float rimEdge(vec2 uv, float c){
  if (c <= 0.0) return 0.0;
  vec2 px = uInkWidth * 1.1 / uRes;
  float r = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982 + 0.39;
    float n = invDepth(uv + vec2(cos(a), sin(a)) * px);
    r = max(r, smoothstep(0.45, 0.8, 1.0 - n / c));
  }
  return r;
}
// the explorer: a capsule between her projected feet and head, depth-matched (so grass in front of or
// ground behind her is not part of it)
float playerMask(vec2 uv, float dist, bool sky){
  if (uPlayerOn <= 0.0 || sky) return 0.0;
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  vec2 pa = uPlayerA * asp, pb = uPlayerB * asp, p = uv * asp;
  vec2 ab = pb - pa;
  float t0 = dot(p - pa, ab) / max(dot(ab, ab), 1e-8);
  float t = clamp(t0, 0.0, 1.0);
  float d = length(p - (pa + ab * t));
  // the legs are narrower than the coat and shoulders; nothing below the ankles (the ground there is hers too)
  float R = uPlayerR * mix(0.55, 1.0, smoothstep(0.05, 0.45, t0));
  float inCap = (1.0 - smoothstep(R * 0.75, R, d)) * smoothstep(0.03, 0.09, t0);
  float dz = abs(dist - uPlayerDist);
  return inCap * (1.0 - smoothstep(0.45, 0.9, dz)) * uPlayerOn;
}
// log-depth layer 0 (at the lens) .. 1 (far ridges): the looks build value structure from depth (rule 4:
// each layer back paler), not from noisy lit/shadowed texture
float layerT(float dist){
  return clamp((log2(max(dist, 0.05)) - log2(uLookD.x)) / max(log2(uLookD.y) - log2(uLookD.x), 1e-3), 0.0, 1.0);
}
float accentMask(vec3 e){
  float I = 0.596 * e.r - 0.274 * e.g - 0.322 * e.b, Q = 0.211 * e.r - 0.523 * e.g + 0.312 * e.b;
  float C = length(vec2(I, Q));
  float d = abs(atan(Q, I) - 0.33);
  d = min(d, 6.2831853 - d);
  return (1.0 - smoothstep(0.2, 0.46, d)) * smoothstep(0.15, 0.26, C);   // saturated reds only (scarf, lanterns), not pink sand
}
// four-stop ramp a (0) → b (s1) → c (s2) → d (1)
vec3 ramp4(float g, vec3 a, vec3 b, vec3 c, vec3 d, float s1, float s2){
  return g < s1 ? mix(a, b, smoothstep(0.0, 1.0, g / s1))
       : g < s2 ? mix(b, c, smoothstep(0.0, 1.0, (g - s1) / (s2 - s1)))
                : mix(c, d, smoothstep(0.0, 1.0, (g - s2) / (1.0 - s2)));
}
// soft (anti-aliased) quantisation of x into n bands, 0..1
float bands(float x, float n){
  float f = x * n;
  float w = max(fwidth(f), 1e-3) * 0.75;
  float q = floor(f) + smoothstep(1.0 - w, 1.0, fract(f));
  return clamp(q / max(n - 1.0, 1.0), 0.0, 1.0);
}
// hard 2-level step with an anti-aliased edge
float step2(float x, float t){ float w = max(fwidth(x), 1e-3) * 0.75; return smoothstep(t - w, t + w, x); }
vec3 palette4(float q, vec3 a, vec3 b, vec3 c, vec3 d){
  return q < 0.3334 ? mix(a, b, q * 3.0) : q < 0.6667 ? mix(b, c, q * 3.0 - 1.0) : mix(c, d, q * 3.0 - 2.0);
}
// display luminance of a disc around uv (linear HDR average → exposure → tone curve → sRGB): the poster,
// woodcut and ink looks band THIS, so grass blades, leaf speckle and shadow dapples merge into flat shapes;
// depth-aware (taps across a silhouette are dropped) so shapes keep crisp edges
float smoothL(vec2 uv, float expo, float radiusPx){
  vec3 a = vec3(0.0); float wsum = 0.0;
  vec2 px = radiusPx * max(1.0, uRes.y / 540.0) / uRes;
  float c = invDepth(uv);
  for (int i = 0; i < 16; i++) {
    float r = sqrt((float(i) + 0.5) / 16.0);
    float th = float(i) * 2.39996323;
    vec2 o = uv + vec2(cos(th), sin(th)) * r * px;
    float n = invDepth(o);
    float w = (c <= 0.0) == (n <= 0.0) ? 1.0 - smoothstep(0.25, 0.5, abs(n - c) / max(max(n, c), 1e-6)) : 0.0;
    w = i == 0 ? 1.0 : w;
    a += min(texture2D(tColor, o).rgb, vec3(64.0)) * w; wsum += w;
  }
  vec3 cc = clamp(agx(a / max(wsum, 1e-3) * expo), 0.0, 1.0);
  return rv_luma(linearToSRGB(cc));
}
// a touch of wind blur (Kurosawa): luminance averaged along the screen-space wind direction
float windL(vec2 uv, float expo){
  vec2 dir = uWindUv * max(1.0, uRes.y / 540.0) / uRes;
  vec3 a = vec3(0.0);
  for (int i = 0; i < 7; i++) a += min(texture2D(tColor, uv + dir * (float(i) - 3.0)).rgb, vec3(64.0));
  vec3 cc = clamp(agx(a / 7.0 * expo), 0.0, 1.0);
  return rv_luma(linearToSRGB(cc));
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rv_hash12(i), rv_hash12(i + vec2(1, 0)), f.x), mix(rv_hash12(i + vec2(0, 1)), rv_hash12(i + vec2(1, 1)), f.x), f.y);
}
vec3 photoLook(vec3 e, vec2 uv, bool sky, vec3 bloomW, float expo, float dist, float skyRel){
  float L = dot(e, vec3(0.2126, 0.7152, 0.0722));
  float acc = uLookAccent > 0.0 ? accentMask(e) * uLookAccent : 0.0;
  vec3 eSat = clamp(vec3(L) + (e - vec3(L)) * 1.35, 0.0, 1.0);
  float id = uLookId;
  float c0 = sky ? 0.0 : 1.0 / max(dist, 1e-3);
  float pm = playerMask(uv, dist, sky);
  float lay = sky ? 1.0 : layerT(dist);
  float rim = (id < 1.5 || (id > 3.5 && id < 4.5) || id > 6.5) && uHasDepth > 0.5 ? rimEdge(uv, c0) : 0.0;
  // the poured sky: value from the sky's own luminance relative to the metered sky, plus a slow vertical pour
  float pour = clamp(0.62 * pow(clamp(skyRel, 0.0, 6.0), 0.85) - 0.14 * (uv.y - 0.45), 0.0, 1.0);
  vec3 o = e;
  bool ink = uLookInk > 0.0;
  if (id < 1.5) {                       // two-tone: black → crimson → magenta → pale, land in layered silhouette
    float g;
    if (sky) g = max(pour, 0.42);
    else {
      // near land is a lifted floor in the dark hue, each layer back a step toward the sky; her figure is pure black
      g = 0.075 + 0.36 * pow(lay, 1.7) + 0.06 * L * lay;
      g *= 1.0 - pm;
      g = max(g, rim * 0.7);
    }
    o = ramp4(g, uToneA, uToneB, uToneC, uToneD, 0.4, 0.8);
  } else if (id < 2.5) {                // high-key black and white with halation
    float h = 1.0 - exp(-rv_luma(bloomW) * 0.6);
    float g = clamp((L - 0.025) * 1.32 + h * 0.18, 0.0, 1.0);
    g = pow(g, 0.72);
    g = mix(g, g * g * (3.0 - 2.0 * g), 0.55);
    o = vec3(g);
  } else if (id < 3.5) {                // flat poster: three colours (dark ground, sky hue, cream light) + red accent
    float Ls = smoothL(uv, expo, 7.0);
    if (sky) o = mix(uToneB, uToneC, step2(pour, 0.74));          // clouds and the bright sun side in cream
    else {
      // flat shapes from depth layers; light only lifts big sunlit planes (smoothed, dapples ignored)
      // (the ground at her feet is the light band so her dark figure reads; the middle distance is the dark mass)
      float v = max(0.78 * pow(lay, 1.3), 0.62 * (1.0 - smoothstep(0.06, 0.2, lay))) + 0.3 * smoothstep(0.3, 0.75, Ls);
      o = mix(uToneA, mix(uToneA, uToneB, 0.62), step2(v, 0.55));
      o = mix(o, uToneC, step2(Ls * lay, 0.72));           // far sunlit snow / cliffs: the light colour
      o = mix(o, uToneA, pm);
      o = mix(o, uToneC, rimEdge(uv, c0) * step(0.3, playerMask(uv, dist, false)) * 0.85);   // her outline in cream
    }
  } else if (id < 4.5) {                // candy sky over a near-black land, layered in plum
    if (sky) {
      vec3 rmp = ramp4(pour, uToneB * 0.55, uToneB, uToneC, uToneD, 0.3, 0.68);
      vec3 sat = clamp(vec3(L) + (e - vec3(L)) * uPLSat, 0.0, 1.0);
      o = mix(rmp, rmp * (0.6 + 0.8 * sat), 0.25);
    } else {
      vec3 plum = mix(uToneA, uToneB * 0.5, pow(lay, 1.6) * 0.85);
      o = mix(plum, e * 0.35, uLookLand) * (1.0 - pm);
      o = mix(o, uToneC * 0.9, rim * 0.75);
    }
  } else if (id < 5.5) {                // woodcut: stepped two-colour sky, engraved land
    float Ls = smoothL(uv, expo, 4.0);
    if (sky) {
      float q = bands(mix(L, Ls, 0.6), uLookBands);
      o = mix(uToneB, uToneC, q);
    } else {
      float dk = 1.0 - smoothstep(0.03, 0.55, mix(L, Ls, 0.5));
      float sp = max(3.0, uRes.y / 180.0);
      vec2 fc = gl_FragCoord.xy;
      float s1 = abs(fract((fc.x - fc.y) / sp) - 0.5) * 2.0;
      float s2 = abs(fract((fc.x + fc.y) / sp) - 0.5) * 2.0;
      float t = smoothstep(dk - 0.18, dk + 0.18, s1);
      if (dk > 0.62) t *= smoothstep(dk - 0.62 - 0.12, dk - 0.62 + 0.12, s2 * 0.6);
      o = mix(uToneA, uToneD, t);
    }
  } else if (id < 6.5) {                // Kurosawa: red-filter black and white film, deep contrast, wind blur, halation
    float Lw = windL(uv, expo);
    float Lr = dot(e, vec3(0.5, 0.42, 0.08));          // red filter: blue sky darkens, clouds stand out
    float g = mix(Lr, Lw * (Lr / max(L, 1e-3)), 0.4);
    g = clamp((g - 0.03) * 1.18, 0.0, 1.0);
    g = g * g * (3.0 - 2.0 * g);
    g = mix(g, smoothstep(0.0, 1.0, g), 0.5);
    g += (1.0 - exp(-rv_luma(bloomW) * 0.5)) * 0.12;   // halation off the highlights
    float vr = length((uv - 0.5) * vec2(uRes.x / uRes.y, 1.0));
    g *= 1.0 - 0.32 * smoothstep(0.35, 1.05, vr);
    o = vec3(clamp(g, 0.0, 1.0)) * vec3(1.0, 0.985, 0.96);
  } else {                              // ink wash (sumi-e): paper, layered washes, wet edges, a vermilion sun
    vec2 fc = gl_FragCoord.xy / max(1.0, uRes.y / 720.0);
    float paperN = vnoise(fc * 0.9) * 0.5 + vnoise(fc * 0.13 + 7.1) * 0.5;
    vec3 paper = uToneD * (0.955 + 0.06 * paperN);
    float dens;
    if (sky) {
      // the sky is the paper; clouds and the darker zenith are the faintest grey washes
      dens = clamp(0.16 * (1.0 - pour * 1.3) + 0.1 * (uv.y - 0.5), 0.0, 0.2) * smoothstep(0.1, 0.9, vnoise(fc * 0.02 + uv * 3.0) + 0.4);
    } else {
      float Ls = smoothL(uv, expo, 5.0);
      // ink density falls with distance (each ridge a paler wash); sunlit planes are left lighter
      // ink density: the ground at her feet is left almost as paper (so her figure reads), the middle distance
      // is the darkest wash, each ridge beyond a paler one; sunlit planes are left lighter
      dens = 0.34 + 0.6 * pow(1.0 - lay, 1.3) * smoothstep(0.02, 0.26, lay);
      // the value of the scene still speaks inside each wash: snow and sunlit planes are left as paper,
      // shaded forest is the deeper wash
      dens *= clamp(0.15 + 1.5 * (1.0 - Ls), 0.2, 1.4);
      dens = mix(dens, 0.95, pm);
      dens += rim * (0.45 * (1.0 - dens) + 0.12);          // ink pools at each ridge's upper edge (wet edge)
      dens *= 0.93 + 0.14 * vnoise(fc * 0.06 + vec2(dist * 0.002, 0.0));   // soft brush texture
    }
    o = mix(paper, uToneA, clamp(dens, 0.0, 1.0));
    // the sun as a vermilion seal disc
    float sv = uFlare > 0.0 ? texture2D(tSunVis, vec2(0.5)).r : 0.0;
    vec2 sd = (uv - uSunUv) * vec2(uRes.x / uRes.y, 1.0);
    float sunDisc = 1.0 - smoothstep(0.034, 0.037, length(sd));
    o = mix(o, uToneC, sunDisc * smoothstep(0.05, 0.4, sv) * (sky ? 1.0 : 0.0) * 0.92);
    acc *= 1.0;
    o = mix(o, uToneC, acc);
    acc = 0.0;
  }
  // (ink lines thin out on the clutter right at the lens: grass blades are drawn by the wash, not outlined)
  if (ink && uHasDepth > 0.5) o = mix(o, uToneA, inkEdge(uv) * uLookInk * (sky ? 1.0 : mix(0.35, 1.0, smoothstep(0.08, 0.3, lay))));
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
  vec3 hz = vec3(0.0); float hzOk = 0.0, skyRel = 1.0;
  if (uHaze > 0.0 || uDuskDesat > 0.0 || uLookId > 0.5) {
    vec4 sm = texture2D(tSky, vec2(0.5));
    float metered = smoothstep(0.002, 0.03, sm.a);
    // no sky in frame (looking down at the land): the sky's radiance from its irradiance (E ≈ π·L,
    // horizon a little brighter than the mean)
    hz = mix(uHazeFallback, sm.rgb / max(sm.a, 1e-5), metered);
    hzOk = max(metered, step(1e-6, rv_luma(uHazeFallback)));
    skyRel = rv_luma(col) / max(rv_luma(hz), 1e-6);
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

  // golden hour (sun low over the horizon): expose for the sky and split the tones — shadows lean to
  // indigo, highlights to the sun's colour (multiplicative: black stays 0)
  if (uGolden > 0.0) {
    float l = rv_luma(col);
    // warmth: on the land the lit planes; in the sky the half toward the sun (the aureole side), the far side
    // stays cool — the same sun-elevation curve drives both
    vec3 vd = normalize(vec3((uv * 2.0 - 1.0 + uProjZW) / uProjXY, -1.0));
    float toward = clamp(dot(vd, uSunView) * 0.5 + 0.5, 0.0, 1.0);
    float hiW = sky ? smoothstep(0.25, 0.95, toward) * (0.6 + 0.4 * smoothstep(0.0, 0.6, l))
                    : smoothstep(0.04, 0.8, l) * (0.55 + 0.45 * toward);
    // mid-tones and highlights go warm (the whole frame shifts toward the low sun), only the deep shadows stay cool
    hiW = mix(0.0, max(hiW, 0.72), smoothstep(0.0, 0.1, l));
    vec3 cool = vec3(0.78, 0.88, 1.36);
    vec3 tint = mix(cool, mix(uGoldTint, vec3(1.32, 0.98, 0.66), 0.5), hiW);
    tint /= max(rv_luma(tint), 1e-3);
    col *= max(mix(vec3(1.0), tint, uGolden), vec3(0.0));
  }
  // low sun / blue hour: expose for the sky — the land goes deep (a graduated filter; far, hazy layers keep
  // more of their light so the ridges still step back)
  if (uLandDrop > 0.0 && !sky) col *= 1.0 - uLandDrop * (1.0 - 0.65 * (1.0 - exp(-dist / uHazeDist)));
  // night: wide soft glow around the brightest emitters (lanterns, the World Tree's light): luminous mist
  // (soft-capped so one very hot lamp does not become a hard orb)
  if (uMist > 0.0) { vec3 m = max(bloomW - vec3(1.0), 0.0); col += m / (1.0 + 0.6 * m) * uMist; }

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
  // night sky: deep indigo, never grey or muddy mauve (bright stars keep their colour)
  if (uNightSky > 0.0 && sky) {
    float l = rv_luma(col);
    col = mix(col, l * vec3(0.5, 0.68, 1.85), uNightSky * (1.0 - smoothstep(0.08, 1.2, l)));
  }
  // blue hour / dusk: the sky keeps its colour, the land loses it (desaturated toward the sky's hue)
  if (uDuskDesat > 0.0 && !sky) {
    float l = rv_luma(col);
    vec3 skyHue = hzOk > 0.0 ? hz / max(rv_luma(hz), 1e-5) : vec3(0.8, 0.9, 1.2);
    // the land takes the sky's hue, a little stronger than the sky itself (blue hour reads blue, not grey)
    skyHue = clamp(mix(vec3(1.0), skyHue, 1.7), 0.0, 2.5);
    skyHue /= max(rv_luma(skyHue), 1e-3);
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
  if (uLookId > 0.5) enc = photoLook(enc, uv, sky, bloomW, expo, dist, skyRel);
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
