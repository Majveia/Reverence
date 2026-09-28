// Civ uber-material: one MeshStandardMaterial (PBR, CSM shadows, env reflections, cloud shadows via
// world.lighting.setupMaterial) whose fragment stage synthesises the surface from per-vertex data:
// albedo, roughness, metalness, emission and a PATTERN id (see geo.js PAT): windows with night
// lights, planks, stone blocks, roof tiles, curtain glass, neon, glyphs, cobbles, asphalt…
// No textures → no tiling, no seams, crisp at every distance (patterns are analytically AA'd).
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';

const VERT_PARS = /* glsl */`
attribute vec3 aCol;
attribute vec4 aMat;
attribute vec2 aAux;
attribute vec2 aUv;
varying vec3 vColL;
varying vec4 vMatA;
varying vec2 vAux;
varying vec2 vUvM;
varying vec3 vLPos;
varying vec3 vUpW;
varying vec3 vNW;
uniform vec3 uPlanetC;
`;
// ---- vertex animation variants (instanced): NPC walkers, flying traffic, boats
const ANIM_PARS = {
  npc: /* glsl */`
attribute vec3 aA; attribute vec3 aB; attribute vec4 aP; attribute vec3 aTint;
uniform vec3 uUpL; uniform float uTimeA;
mat3 rvRot; vec3 rvOff; float rvWalk; float rvScale;
`,
  traffic: /* glsl */`
attribute vec4 aL; attribute vec4 aL2;
uniform vec3 uUpL; uniform vec3 uEastL; uniform vec3 uNorthL; uniform vec3 uSiteC; uniform float uRBase; uniform float uTimeA;
mat3 rvRot; vec3 rvOff; float rvWalk; float rvScale;
`,
  boat: /* glsl */`
attribute vec4 aL; attribute vec4 aL2;
uniform vec3 uUpL; uniform vec3 uEastL; uniform vec3 uNorthL; uniform vec3 uSiteC; uniform float uRBase; uniform float uTimeA;
mat3 rvRot; vec3 rvOff; float rvWalk; float rvScale;
`,
};
const ANIM_NORMAL = {
  npc: /* glsl */`
{
  vec3 ab = aB - aA; float L = max(length(ab), 0.01);
  float s = uTimeA * aP.x / L + aP.y;
  float ph = fract(s * 0.5);
  float tri = abs(ph * 2.0 - 1.0);
  rvOff = mix(aA, aB, 1.0 - tri);
  vec3 fwd = (ph < 0.5 ? 1.0 : -1.0) * ab / L;
  if (aP.x < 0.01) fwd = normalize(vec3(sin(aP.y * 6.28), 0.0, cos(aP.y * 6.28)));
  vec3 up = uUpL;
  vec3 fw = normalize(fwd - up * dot(fwd, up) + 1e-5);
  rvRot = mat3(cross(up, fw), up, fw);
  rvWalk = aP.x > 0.01 ? s * L / 0.75 * 3.14159 : 0.0;
  rvScale = aP.z;
}
objectNormal = rvRot * objectNormal;
`,
  traffic: /* glsl */`
{
  float ang = aL2.z + uTimeA * aL2.y / max(0.5 * (aL.z + aL.w), 1.0);
  float c = cos(aL2.w), sn = sin(aL2.w);
  vec2 e = vec2(cos(ang) * aL.z, sin(ang) * aL.w);
  vec2 de = vec2(-sin(ang) * aL.z, cos(ang) * aL.w) * sign(aL2.y);
  vec2 p2 = aL.xy + vec2(e.x * c - e.y * sn, e.x * sn + e.y * c);
  vec2 d2 = normalize(vec2(de.x * c - de.y * sn, de.x * sn + de.y * c));
  vec3 tp = uEastL * p2.x + uNorthL * p2.y;
  vec3 dirW = normalize(uSiteC + tp);
  float bob = sin(uTimeA * 0.7 + aL2.z * 5.0) * 0.6;
  rvOff = dirW * (uRBase + aL2.x + bob) - uSiteC;
  vec3 up = dirW;
  vec3 fwd = uEastL * d2.x + uNorthL * d2.y;
  vec3 fw = normalize(fwd - up * dot(fwd, up));
  vec3 rt = cross(up, fw);
  float bank = 0.25 * sign(aL2.y);
  up = normalize(up * cos(bank) + rt * sin(bank)); rt = cross(up, fw);
  rvRot = mat3(rt, up, fw);
  rvWalk = 0.0; rvScale = 1.0;
}
objectNormal = rvRot * objectNormal;
`,
  boat: /* glsl */`
{
  vec2 p2 = aL.xy;
  vec3 tp = uEastL * p2.x + uNorthL * p2.y;
  vec3 dirW = normalize(uSiteC + tp);
  float bob = sin(uTimeA * 1.1 + aL2.x * 6.0) * 0.18;
  rvOff = dirW * (uRBase + aL.z + bob) - uSiteC;
  vec3 up = dirW;
  float hd = aL.w + sin(uTimeA * 0.13 + aL2.x * 9.0) * 0.12;
  vec3 fwd = uEastL * sin(hd) + uNorthL * cos(hd);
  vec3 fw = normalize(fwd - up * dot(fwd, up));
  vec3 rt = cross(up, fw);
  float roll = sin(uTimeA * 0.9 + aL2.x * 4.0) * 0.06, pitch = sin(uTimeA * 0.7 + aL2.x * 3.0) * 0.04;
  up = normalize(up + rt * roll + fw * pitch); fw = normalize(cross(rt, up)); rt = cross(up, fw);
  rvRot = mat3(rt, up, fw);
  rvWalk = 0.0; rvScale = aL2.y;
}
objectNormal = rvRot * objectNormal;
`,
};
const ANIM_POS = /* glsl */`
{
  vec3 p = transformed * rvScale;
  if (rvWalk != 0.0) {
    float sw = sin(rvWalk);
    if (p.y < 0.86 * rvScale) { float side = sign(p.x); p.z += (0.86 * rvScale - p.y) * sw * 0.55 * side; p.y += abs(sw) * 0.03 * step(0.0, side * sw); }
    else if (p.y < 1.45 * rvScale && abs(p.x) > 0.19 * rvScale) { p.z -= (1.45 * rvScale - p.y) * sw * 0.6 * sign(p.x); }
    p.y += abs(cos(rvWalk)) * 0.035;
  }
  transformed = rvOff + rvRot * p;
}
`;

const VERT_MAIN = /* glsl */`
vColL = pow(aCol, vec3(2.2));
vMatA = vec4(aMat.x / 255.0, aMat.y / 255.0, aMat.z / 16.0, aMat.w);
vAux = aAux; vUvM = aUv; vLPos = position;
{
  vec4 rvWp = modelMatrix * vec4(position, 1.0);
  vUpW = normalize(rvWp.xyz - uPlanetC);
  vNW = normalize(mat3(modelMatrix) * objectNormal);
}
`;

const FRAG_PARS = /* glsl */`
#include <rv_noise>
varying vec3 vColL;
varying vec4 vMatA;
varying vec2 vAux;
varying vec2 vUvM;
varying vec3 vLPos;
varying vec3 vUpW;
varying vec3 vNW;
uniform float uNightF;
uniform float uTimeC;
uniform vec3 uSunDirC;
uniform float uWet;
uniform float uSnowC;
uniform vec3 uWinCol;
uniform vec3 uWinCol2;
uniform float uLitFrac;
uniform float uEmitK;
uniform float uAge;
uniform vec4 uWinRect;

float rvBox(vec2 f, vec4 r, vec2 fw){
  vec2 a = smoothstep(r.xy - fw, r.xy + fw, f);
  vec2 b = 1.0 - smoothstep(r.zw - fw, r.zw + fw, f);
  return a.x * a.y * b.x * b.y;
}
vec3 rvBumpN(vec3 surfPos, vec3 n, float h, float k){
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1);
  float dbx = dFdx(h) * k, dby = dFdy(h) * k;
  vec3 grad = sign(det) * (dbx * r1 + dby * r2);
  return normalize(abs(det) * n - grad);
}
// glyph: 3x3 stroke alphabet from a hash
float rvGlyph(vec2 f, float h){
  vec2 p = (f - 0.5) * 1.35 + 0.5;
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) return 0.0;
  vec2 g = p * 3.0; vec2 c = floor(g); vec2 q = fract(g) - 0.5;
  float r = rv_hash12(c + h * 91.7);
  float hs = step(0.45, r) * (1.0 - smoothstep(0.06, 0.13, abs(q.y)));
  float vs = step(r, 0.62) * (1.0 - smoothstep(0.06, 0.13, abs(q.x)));
  float dt = step(0.85, rv_hash12(c * 1.7 + h)) * (1.0 - smoothstep(0.1, 0.18, length(q)));
  return max(max(hs, vs), dt);
}
`;

// computes rvAlb / rvRough / rvMetal / rvEmi / rvH / rvBumpK
const FRAG_SURF = /* glsl */`
vec3 rvAlb = vColL; float rvRough = vMatA.x; float rvMetal = vMatA.y; vec3 rvEmi = vec3(0.0);
float rvH = 0.0; float rvBumpK = 0.0; float rvAO = 1.0; float rvGlass = 0.0;
int rvPat = int(vMatA.w + 0.5);
vec2 uv = vUvM;
vec3 lp = vLPos;
float seed = vAux.y;
float upness = dot(normalize(vNW), vUpW);
float nA = rv_vnoise(lp * 0.21 + seed * 3.1);
float nB = rv_vnoise(lp * 1.7 + 11.0);
float nC = rv_vnoise(lp * 7.3 + 5.0);
float macro = nA * 0.55 + nB * 0.3 + nC * 0.15;
vec2 fw = fwidth(uv);
float fwl = max(fw.x, fw.y);
float night = max(uNightF * 0.0, 1.0 - smoothstep(-0.14, 0.06, dot(vUpW, normalize(uSunDirC))));

if (rvPat == 1 || rvPat == 6 || rvPat == 15 || rvPat == 22) {
  // ------------------------------------------------ windows (cell units)
  vec2 id = floor(uv); vec2 f = fract(uv);
  float hsh = rv_hash12(id + seed * 7.13);
  float hsh2 = rv_hash12(id * 1.37 + seed * 3.7 + 5.1);
  float win = 0.0, frame = 0.0;
  float fade = 1.0 - smoothstep(0.35, 0.6, fwl); // far → average
  if (rvPat == 1) {
    vec4 r = uWinRect;
    win = rvBox(f, r, fw);
    frame = rvBox(f, r + vec4(-0.07, -0.1, 0.07, 0.05), fw) - win;
    // mullion cross
    float mull = (1.0 - smoothstep(0.012, 0.012 + fw.x, abs(f.x - (r.x + r.z) * 0.5))) * win;
    frame += mull * 0.8; win *= 1.0 - mull;
    if (hsh2 < uAge * 0.25) { win *= 0.0; }
  } else if (rvPat == 15) {
    vec2 c = vec2(0.5, 0.66);
    float rect = rvBox(f, vec4(0.34, 0.14, 0.66, 0.66), fw);
    float arc = 1.0 - smoothstep(0.16 - fw.x, 0.16 + fw.x, length((f - c) * vec2(1.0, 0.55)));
    arc *= step(c.y, f.y);
    win = max(rect, arc);
    float rect2 = rvBox(f, vec4(0.29, 0.1, 0.71, 0.66), fw);
    float arc2 = (1.0 - smoothstep(0.21 - fw.x, 0.21 + fw.x, length((f - c) * vec2(1.0, 0.55)))) * step(c.y, f.y);
    frame = max(rect2, arc2) - win;
  } else if (rvPat == 22) {
    win = rvBox(f, vec4(0.46, 0.12, 0.54, 0.88), fw);
    frame = rvBox(f, vec4(0.43, 0.08, 0.57, 0.9), fw) - win;
  } else {
    // curtain wall: mullions + spandrel band
    float mx = 1.0 - smoothstep(0.035, 0.035 + fw.x * 1.5, min(f.x, 1.0 - f.x));
    float my = 1.0 - smoothstep(0.035, 0.035 + fw.y * 1.5, min(f.y, 1.0 - f.y));
    float band = 1.0 - smoothstep(0.16, 0.16 + fw.y, f.y);
    frame = max(max(mx, my), band);
    win = 1.0 - frame;
  }
  win *= step(0.0, id.y) * fade + (1.0 - fade) * 0.55 * step(0.0, id.y);
  frame *= fade;
  vec3 glass = mix(vec3(0.018, 0.024, 0.03), rvAlb * 0.25, rvPat == 6 ? 0.55 : 0.1);
  // interior: curtains / rooms
  vec3 interior = mix(vec3(0.05, 0.045, 0.04), vec3(0.12, 0.09, 0.07), hsh2) * (0.6 + 0.4 * f.y);
  vec3 trim = mix(rvAlb * 1.35 + 0.05, vec3(0.9, 0.88, 0.82), 0.35);
  if (rvPat == 6) trim = rvAlb * 0.6;
  rvAlb = mix(rvAlb, trim, clamp(frame, 0.0, 1.0));
  rvAlb = mix(rvAlb, mix(glass, interior, (rvPat == 6 ? 0.06 : 0.22) * (0.4 + 0.6 * night)), win);
  rvRough = mix(rvRough, 0.12 + 0.06 * hsh2, win);
  rvMetal = mix(rvMetal, rvPat == 6 ? 0.65 : 0.25, win);
  rvGlass = win;
  // plaster / cladding micro relief outside the panes
  rvH = frame * 0.6 - win * 0.8 + (1.0 - win - frame) * (nC * 0.25 + nB * 0.1);
  rvBumpK = 0.03;
  // night lights (and dim interior by day)
  float lit = step(hsh, uLitFrac);
  float hsh3 = rv_hash12(id * 2.71 + seed * 1.9 + 17.0);
  vec3 wc = hsh2 > 0.82 ? uWinCol2 : (hsh2 > 0.72 ? vec3(0.75, 1.0, 0.8) : uWinCol);
  wc *= mix(0.2, 1.25, hsh3 * hsh3);
  // blinds / curtains on some windows
  float bl = f.y * 9.0; float fwb = fwidth(bl) * 1.2;
  float blinds = hsh2 > 0.45 && hsh2 < 0.7 ? mix(0.72, 0.4 + 0.6 * smoothstep(0.4 - fwb, 0.4 + fwb, abs(fract(bl) - 0.5) * 2.0), 1.0 - smoothstep(0.25, 0.5, fwb)) : 1.0;
  // light gradient: lampshade glow in the upper part of the pane, plus a dim floor-lamp pool low
  float grad = (0.55 + 0.6 * smoothstep(0.2, 0.95, f.y)) * blinds;
  float onK = mix(0.03, 1.0, night);
  rvEmi += wc * lit * win * grad * onK * uEmitK * (rvPat == 6 ? 0.9 : 1.6);
  rvAlb *= mix(1.0, blinds, win * 0.5);
} else if (rvPat == 0) {
  // plain surfaces: subtle trowel / cast relief so close-ups are never flat
  rvH = nC * 0.35 + nB * 0.2;
  rvBumpK = 0.008;
} else if (rvPat == 2) {
  // ------------------------------------------------ planks (horizontal boards)
  float bw = 0.24;
  float row = floor(uv.y / bw); float fy = fract(uv.y / bw);
  float bh = rv_hash11(row * 7.1 + seed);
  float seg = floor((uv.x + bh * 7.0) / 3.1);
  float bh2 = rv_hash12(vec2(row, seg) + seed);
  float groove = smoothstep(0.0, 0.1, fy) * smoothstep(1.0, 0.86, fy);
  float grain = rv_vnoise(vec3(uv.x * 1.3, uv.y * 42.0, bh * 10.0));
  rvAlb *= (0.72 + 0.4 * bh2) * (0.85 + 0.25 * grain) * mix(0.55, 1.0, groove);
  rvH = groove * 0.8 + grain * 0.15;
  rvBumpK = 0.02;
  rvRough = min(1.0, rvRough + 0.1 * grain);
} else if (rvPat == 3 || rvPat == 23) {
  // ------------------------------------------------ stone blocks (ashlar), optional moss
  float bh = 0.52, bwid = 1.05;
  float row = floor(uv.y / bh);
  float off = rv_hash11(row * 3.3 + seed) * bwid;
  float col = floor((uv.x + off) / bwid);
  vec2 f = vec2(fract((uv.x + off) / bwid), fract(uv.y / bh));
  vec2 id = vec2(col, row);
  float h = rv_hash12(id + seed * 1.3);
  vec2 e = min(f, 1.0 - f) * vec2(bwid, bh);
  float m = min(e.x, e.y);
  float mortar = 1.0 - smoothstep(0.015, 0.035 + fwl * 0.3, m);
  float fadeM = 1.0 - smoothstep(0.08, 0.4, fwl);
  mortar *= fadeM;
  float chip = rv_vnoise(vec3(uv * 6.0, h * 9.0));
  rvAlb *= mix(0.78 + 0.34 * h, 1.0, 1.0 - fadeM) * (0.88 + 0.2 * chip);
  rvAlb = mix(rvAlb, rvAlb * 0.45, mortar);
  rvH = smoothstep(0.0, 0.08, m) * (0.8 + 0.2 * chip) * fadeM;
  rvBumpK = 0.045;
  rvRough = clamp(rvRough + 0.1 * chip, 0.0, 1.0);
  if (rvPat == 23) {
    float mo = smoothstep(0.45, 0.75, rv_vnoise(lp * 0.6 + 3.0) * 0.7 + upness * 0.45 + nC * 0.2 - vAux.x * 0.012);
    rvAlb = mix(rvAlb, vec3(0.13, 0.2, 0.06) * (0.7 + 0.6 * nC), mo);
    rvRough = mix(rvRough, 1.0, mo);
    rvH += mo * nC * 0.6;
  }
} else if (rvPat == 4 || rvPat == 19) {
  // ------------------------------------------------ metal panels (+ rust)
  vec2 ps = vec2(1.6, 1.2);
  vec2 id = floor(uv / ps); vec2 f = fract(uv / ps);
  float h = rv_hash12(id + seed);
  vec2 e = min(f, 1.0 - f) * ps;
  float m = min(e.x, e.y);
  float seam = 1.0 - smoothstep(0.012, 0.03 + fwl * 0.2, m);
  vec2 rv = abs(f - 0.5) * ps - (ps * 0.5 - 0.09);
  float rivet = (1.0 - smoothstep(0.018, 0.03, length(max(rv, 0.0)))) * step(0.0, rv.x) * step(0.0, rv.y);
  rvAlb *= 0.88 + 0.22 * h;
  rvAlb *= 1.0 - seam * 0.55;
  rvH = -seam + rivet * 0.6 + h * 0.05;
  rvBumpK = 0.02;
  rvRough = clamp(rvRough + (h - 0.5) * 0.15, 0.05, 1.0);
  if (rvPat == 19 || uAge > 0.58) {
    float streak = rv_vnoise(vec3(uv.x * 3.0, uv.y * 0.25, seed));
    float rust = smoothstep(0.5, 0.8, macro * 0.7 + streak * 0.5 + (rvPat == 19 ? 0.15 : uAge * 0.1) - 0.1);
    vec3 rc = mix(vec3(0.32, 0.12, 0.04), vec3(0.55, 0.26, 0.08), nC);
    rvAlb = mix(rvAlb, rc, rust);
    rvRough = mix(rvRough, 0.92, rust); rvMetal = mix(rvMetal, 0.1, rust);
    rvH += rust * nC * 0.4;
  }
} else if (rvPat == 5) {
  // ------------------------------------------------ roof tiles (rows along slope v)
  float rh = 0.3, tw = 0.24;
  float row = floor(uv.y / rh);
  float fx = fract(uv.x / tw + row * 0.5);
  float fy = fract(uv.y / rh);
  float id = rv_hash12(vec2(floor(uv.x / tw + row * 0.5), row) + seed);
  float prof = sin(fx * 3.14159);
  float lip = smoothstep(0.0, 0.18, fy);
  float fade = 1.0 - smoothstep(0.03, 0.12, fwl);
  float tpatch = rv_vnoise(vec3(uv * 0.35, seed));
  rvAlb *= mix(0.86, 1.1, tpatch);
  rvAlb *= mix(1.0, (0.88 + 0.18 * id) * mix(0.62, 1.0, lip) * (0.88 + 0.14 * prof), fade);
  rvAlb *= mix(1.0, 0.9, (1.0 - fade) * 0.5);
  rvH = (prof * 0.5 + fy * 0.8) * fade;
  rvBumpK = 0.05;
  float moss = smoothstep(0.55, 0.85, macro + nC * 0.2);
  rvAlb = mix(rvAlb, vec3(0.16, 0.2, 0.08), moss * 0.55 * (0.4 + uAge));
} else if (rvPat == 7 || rvPat == 17) {
  // ------------------------------------------------ neon tubes / holograms (always lit)
  float fl = 0.92 + 0.08 * sin(uTimeC * 37.0 + seed * 13.0) * step(0.93, rv_hash11(floor(uTimeC * 6.0) + seed));
  float k = vMatA.z * uEmitK * mix(0.55, 1.4, night) * fl;
  if (rvPat == 17) {
    float scan = 0.65 + 0.35 * sin(uv.y * 60.0 - uTimeC * 4.0);
    float bars = step(0.5, fract(uv.y * 1.3 - uTimeC * 0.15 + rv_hash11(floor(uv.x * 3.0) + seed)));
    float glitch = step(0.97, rv_hash11(floor(uTimeC * 9.0) + seed * 3.0));
    k *= scan * mix(0.55, 1.0, bars) * (1.0 - 0.5 * glitch);
    rvAlb *= 0.2;
  }
  rvEmi += vColL * k;
  rvRough = 0.3;
} else if (rvPat == 8) {
  // ------------------------------------------------ lamps / lanterns (night emissive)
  rvEmi += vColL * vMatA.z * uEmitK * mix(0.04, 1.0, night);
} else if (rvPat == 9) {
  // ------------------------------------------------ thatch / straw
  float fib = rv_vnoise(vec3(uv.x * 26.0, uv.y * 1.8, seed));
  float fib2 = rv_vnoise(vec3(uv.x * 61.0, uv.y * 3.1, seed + 3.0));
  float layer = fract(uv.y / 0.35);
  rvAlb *= (0.6 + 0.55 * fib) * (0.8 + 0.25 * fib2) * mix(0.6, 1.0, smoothstep(0.0, 0.3, layer));
  rvH = fib * 0.6 + layer * 0.6;
  rvBumpK = 0.06;
  rvRough = 1.0;
} else if (rvPat == 10) {
  // ------------------------------------------------ corrugated metal
  float c = sin(uv.x * 6.2831 / 0.13);
  float fade = 1.0 - smoothstep(0.05, 0.13, fwl);
  rvH = c * 0.5 * fade;
  rvBumpK = 0.012;
  float streak = rv_vnoise(vec3(uv.x * 2.0, uv.y * 0.3, seed * 2.0));
  float rust = smoothstep(0.55, 0.85, streak * 0.6 + macro * 0.5 + uAge * 0.2);
  rvAlb = mix(rvAlb * (0.9 + 0.15 * c * fade), vec3(0.36, 0.16, 0.06) * (0.7 + 0.5 * nC), rust * 0.85);
  rvRough = mix(rvRough, 0.9, rust); rvMetal = mix(rvMetal, 0.15, rust);
} else if (rvPat == 11 || rvPat == 21) {
  // ------------------------------------------------ cobbles / flagstone paving
  vec2 p = rvPat == 11 ? uv * 2.6 : uv * vec2(0.75, 0.75);
  vec2 w = rv_worley(vec3(p, seed));
  float edge = w.y - w.x;
  float cell = rv_hash12(floor(p) + seed);
  if (rvPat == 21) {
    vec2 f = fract(p); vec2 e = min(f, 1.0 - f);
    edge = min(e.x, e.y) * 2.0;
    cell = rv_hash12(floor(p) + 3.0);
  }
  float fade = 1.0 - smoothstep(0.25, 0.9, fwl * 2.6);
  float joint = (1.0 - smoothstep(0.03, 0.12, edge)) * fade;
  rvAlb *= (0.8 + 0.35 * cell * fade) * (1.0 - joint * 0.55);
  rvH = smoothstep(0.0, 0.3, edge) * fade;
  rvBumpK = rvPat == 11 ? 0.035 : 0.02;
  rvRough = mix(rvRough, 0.95, joint);
} else if (rvPat == 12) {
  // ------------------------------------------------ asphalt road (uv.x: -1..1 across, uv.y: meters along)
  float g = rv_vnoise(vec3(uv * vec2(14.0, 3.0), seed)) * 0.5 + nC * 0.5;
  rvAlb *= 0.8 + 0.35 * g;
  float ax = abs(uv.x);
  float fx = fwidth(uv.x);
  float centre = (1.0 - smoothstep(0.018, 0.018 + fx, ax)) * step(0.5, fract(uv.y / 7.0));
  float edgeL = (1.0 - smoothstep(0.02, 0.02 + fx, abs(ax - 0.86)));
  float paint = max(centre, edgeL) * (0.75 + 0.25 * nB);
  rvAlb = mix(rvAlb, vec3(0.75, 0.68, 0.45), paint);
  float crack = smoothstep(0.02, 0.0, abs(rv_vnoise(vec3(uv * vec2(3.0, 0.8), 1.0)) - 0.5)) * 0.4;
  rvAlb *= 1.0 - crack;
  rvRough = mix(0.88, 0.7, paint);
} else if (rvPat == 13) {
  // ------------------------------------------------ dirt path (ruts at the wheel tracks)
  float ax = abs(uv.x);
  float rut = exp(-pow((ax - 0.45) * 7.0, 2.0));
  float peb = step(0.8, rv_vnoise(vec3(uv * 9.0, seed)));
  rvAlb *= (0.8 + 0.3 * nB) * (1.0 - 0.18 * rut) * (1.0 + peb * 0.25);
  rvH = -rut * 0.6 + peb * 0.3 + nC * 0.2;
  rvBumpK = 0.05;
} else if (rvPat == 14) {
  // ------------------------------------------------ glyph wall (carved + glowing)
  vec2 gs = vec2(0.9, 1.1);
  vec2 id = floor(uv / gs); vec2 f = fract(uv / gs);
  float h = rv_hash12(id + seed);
  float gl = rvGlyph(f, h) * step(0.2, h);
  float fade = 1.0 - smoothstep(0.2, 0.5, fwl);
  gl *= fade;
  rvAlb = mix(rvAlb * (0.85 + 0.2 * nB), rvAlb * 0.35, gl);
  rvH = -gl;
  rvBumpK = 0.03;
  float pulse = 0.55 + 0.45 * sin(uTimeC * 1.3 - id.y * 0.7 + id.x * 0.21 + seed);
  rvEmi += uWinCol2 * gl * pulse * vMatA.z * uEmitK * mix(0.5, 1.4, night);
  rvEmi += uWinCol2 * vMatA.z * 0.06 * (1.0 - fade) * uEmitK * night;
} else if (rvPat == 16) {
  // ------------------------------------------------ board-formed concrete
  float board = fract(uv.y / 0.3);
  float bl = 1.0 - smoothstep(0.0, 0.06 + fwl, min(board, 1.0 - board));
  vec2 pp = uv / vec2(2.4, 1.2); vec2 f = fract(pp); vec2 e = min(f, 1.0 - f) * vec2(2.4, 1.2);
  float joint = 1.0 - smoothstep(0.01, 0.02 + fwl * 0.3, min(e.x, e.y));
  vec2 tq = abs(f - 0.5) * vec2(2.4, 1.2) - vec2(0.9, 0.35);
  float tie = 1.0 - smoothstep(0.02, 0.035, length(tq));
  float stain = rv_vnoise(vec3(uv.x * 1.5, uv.y * 0.12, seed));
  rvAlb *= (0.9 + 0.15 * nB) * (1.0 - 0.1 * bl) * (1.0 - 0.4 * joint) * (1.0 - 0.45 * tie) * mix(0.75, 1.0, smoothstep(0.2, 0.7, stain));
  rvH = -bl * 0.25 - joint - tie * 0.8 + nC * 0.2;
  rvBumpK = 0.02;
} else if (rvPat == 18) {
  // ------------------------------------------------ canvas / fabric
  float weave = sin(uv.x * 220.0) * sin(uv.y * 220.0);
  float fold = sin(uv.x * 2.2 + nA * 3.0) * 0.5 + 0.5;
  rvAlb *= (0.82 + 0.25 * fold) * (0.95 + 0.05 * weave) * (0.85 + 0.25 * nB);
  rvH = fold * 0.8;
  rvBumpK = 0.04;
  rvRough = 0.95;
  // backlit translucency glow at night (lamps inside tents)
  rvEmi += vColL * uWinCol * vMatA.z * uEmitK * night * 0.35 * (0.7 + 0.3 * fold);
} else if (rvPat == 20) {
  // ------------------------------------------------ crystal
  vec3 V = normalize(vViewPosition);
  float fres = pow(1.0 - abs(dot(normalize(vNormal), V)), 3.0);
  float inner = rv_vnoise(lp * 0.8 + uTimeC * 0.05);
  rvEmi += vColL * vMatA.z * uEmitK * (0.25 + 0.75 * inner) * (0.4 + fres * 1.5) * mix(0.35, 1.2, night);
  rvRough = 0.08; rvMetal = 0.3;
  rvAlb *= 0.5;
}

// ---------------------------------------------------- weathering & context
if (rvPat != 7 && rvPat != 8 && rvPat != 17) {
  float ageK = (0.1 + uAge * 0.5) * (1.0 - rvGlass * 0.85);
  // macro colour variation + grime
  rvAlb *= mix(1.0 - 0.25 * ageK, 1.0 + 0.08 * ageK, macro);
  // rain streaks on facades
  float vert = 1.0 - abs(upness);
  float streak = rv_vnoise(vec3(lp.x * 2.5 + lp.z * 2.5, lp.y * 0.18, seed));
  rvAlb *= 1.0 - vert * ageK * 0.35 * smoothstep(0.55, 0.9, streak);
  // contact AO / splash grime at the base
  if (vAux.x < 50.0) {
    float base = smoothstep(0.0, 1.8, vAux.x + nC * 0.4);
    rvAO = mix(0.45, 1.0, base);
    rvAlb *= mix(0.6 + 0.2 * nB, 1.0, base);
  }
  // snow on up-facing surfaces
  float sn = uSnowC * smoothstep(0.35, 0.75, upness + nB * 0.25);
  rvAlb = mix(rvAlb, vec3(0.85, 0.88, 0.92), sn);
  rvRough = mix(rvRough, 0.7, sn);
  // wetness: darker, glossier
  float wet = uWet * (0.6 + 0.4 * smoothstep(0.2, 0.8, upness));
  rvAlb *= 1.0 - 0.35 * wet;
  rvRough = mix(rvRough, rvRough * 0.25, wet);
  // glass never goes mirror-perfect (the night env map holds stars → sparkle noise)
  rvRough = max(rvRough, 0.12 * rvGlass);
  // street-level warm bounce at night (lamps, shopfronts)
  rvEmi += rvAlb * uWinCol * night * 0.06 * uEmitK * exp(-max(vAux.x, 0.0) * 0.28);
}
`;

let _id = 0;
/**
 * Create the civ uber material. style: { winCol, winCol2, litFrac, age, winRect, emit }.
 * Uniform objects are exposed on mat.userData.u for per-frame tweaks.
 */
export function makeCivMaterial(style = {}, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 1.0 });
  const U = {
    uNightF: G.uNight, uTimeC: G.uTime, uWet: G.uWetness, uSnowC: G.uSnow,
    uPlanetC: G.uPlanetCenter, uSunDirC: G.uSunDir,
    uWinCol: { value: new THREE.Color(style.winCol ?? '#ffb467') },
    uWinCol2: { value: new THREE.Color(style.winCol2 ?? '#9fd8ff') },
    uLitFrac: { value: style.litFrac ?? 0.55 },
    uEmitK: { value: style.emit ?? 1.0 },
    uAge: { value: style.age ?? 0.2 },
    uWinRect: { value: new THREE.Vector4(...(style.winRect ?? [0.26, 0.3, 0.74, 0.82])) },
  };
  m.userData.u = U;
  const anim = opts.anim || null;
  if (anim) {
    U.uUpL = { value: new THREE.Vector3(0, 1, 0) }; U.uEastL = { value: new THREE.Vector3(1, 0, 0) }; U.uNorthL = { value: new THREE.Vector3(0, 0, 1) };
    U.uSiteC = { value: new THREE.Vector3() }; U.uRBase = { value: 0 }; U.uTimeA = G.uTime;
  }
  const key = 'rvciv' + (opts.key || '') + (anim || '');
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    let vs = sh.vertexShader.replace('#include <common>', '#include <common>\n' + VERT_PARS + (anim ? ANIM_PARS[anim] : ''));
    if (anim) {
      vs = vs.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + ANIM_NORMAL[anim])
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + ANIM_POS);
      if (anim === 'npc') vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>');
    }
    vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_MAIN + (anim === 'npc' ? '\n if (aMat.w > 17.5 && aMat.w < 18.5) vColL = aTint;\n' : ''));
    sh.vertexShader = vs;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_SURF + '\n diffuseColor.rgb = rvAlb;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = clamp(rvRough, 0.04, 1.0);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = rvMetal;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n if (rvBumpK > 0.0) normal = rvBumpN(-vViewPosition, normal, rvH, rvBumpK);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += rvEmi;')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n reflectedLight.indirectDiffuse *= rvAO; reflectedLight.indirectSpecular *= mix(1.0, rvAO, 0.5);');
  };
  m.customProgramCacheKey = () => key;
  m.name = 'civ-uber' + (opts.key ? '-' + opts.key : '');
  if (opts.polygonOffset) { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -4; }
  m.userData.civ = ++_id;
  return m;
}

// --------------------------------------------------------------------------- glow sprites
// Points drawn additively: street lamps, lanterns, beacons, window clusters seen from orbit.
// attributes: position, aColor (linear rgb * intensity), aSize (m), aKind (0 lamp · 1 blink beacon
// · 2 lantern sway · 3 far cluster light), aPhase.
export function makeGlowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uNightF: G.uNight, uTimeC: G.uTime, uPixH: { value: 540 }, uFov: { value: 1 }, uSunDirC: G.uSunDir, uPlanetC: G.uPlanetCenter,
      uFarFade: { value: new THREE.Vector2(0, 1e9) }, uDayK: { value: 0.0 }, uScale: { value: 1 },
    },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aSize; attribute float aKind; attribute float aPhase;
      uniform float uNightF, uTimeC, uPixH, uFov, uDayK, uScale; uniform vec2 uFarFade; uniform vec3 uSunDirC, uPlanetC;
      varying vec3 vC; varying float vA; varying float vBlob;
      void main(){
        vec3 p = position;
        vBlob = step(3.5, aKind);
        float k = aKind;
        vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
        vec3 prel = wp - uPlanetC;
        float nightL = 1.0 - smoothstep(-0.14, 0.06, dot(normalize(prel), normalize(uSunDirC)));
        float horizon = step(0.0, dot(prel, cameraPosition - wp));
        float on = mix(uDayK, 1.0, nightL);
        float fl = 1.0;
        if (k > 0.5 && k < 1.5) { fl = step(0.55, fract(uTimeC * 0.5 + aPhase)); on = max(on, 0.6); }
        else if (k > 1.5 && k < 2.5) { p.x += sin(uTimeC * 1.3 + aPhase * 6.28) * 0.06; p.z += cos(uTimeC * 1.1 + aPhase * 6.28) * 0.06; fl = 0.9 + 0.1 * sin(uTimeC * 11.0 + aPhase * 40.0); }
        else if (k > 3.5) { fl = 1.0; }
        else if (k > 2.5) { fl = 0.85 + 0.15 * sin(uTimeC * 0.7 + aPhase * 30.0); }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float d = -mv.z;
        gl_Position = projectionMatrix * mv;
        float px = aSize * uScale * uPixH / (2.0 * tan(uFov * 0.5) * max(d, 0.1));
        float fade = smoothstep(uFarFade.x * 0.7, uFarFade.x, d) * (1.0 - smoothstep(uFarFade.y * 0.8, uFarFade.y, d));
        vA = on * fl * fade * horizon;
        // keep tiny distant lights visible as 1.5px points, energy-conserving
        float cl = max(px, 1.6);
        if (k > 3.5) {
          // city glow blob: only from afar (fades in beyond ~2.5 km), keeps a visible core from orbit
          vA *= smoothstep(2500.0, 6000.0, d) * clamp(px / cl, 0.5, 1.0) * mix(0.35, 1.0, smoothstep(2.0, 12.0, px)) * 0.8;
          cl = max(px, 2.2);
        } else vA *= min(1.0, (px * px) / (cl * cl) * 6.0 + 0.15);
        gl_PointSize = min(cl, 96.0);
        vC = aColor;
        if (vA < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vC; varying float vA; varying float vBlob;
      void main(){
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(q, q);
        if (r2 > 1.0) discard;
        float core = exp(-r2 * 14.0);
        float halo = exp(-r2 * 3.5) * 0.35;
        gl_FragColor = vec4(vC * (vBlob > 0.5 ? exp(-r2 * 4.0) * 0.9 : core * 1.6 + halo) * vA, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
