// Nebulae — volumetric emission / absorption nebulae placed in the arms (GalaxyModel.galaxyNebulae):
//   emission clouds (Carina/Orion: Hα + [OIII] gas lit by an embedded cluster, absorbing dust with
//   ionization-front rims), pillars (Pillars of Creation: dense eroded columns, bright rims, teal haze),
//   planetary nebulae (Helix/Ring: prolate shell, [OIII] core, Hα rim, cometary knots, white dwarf)
//   and supernova remnants (Veil: filamentary shell).
// Raymarched at reduced resolution (shared tileable 3-D noise from GalaxyVolume) when the camera is
// within ~60 radii, composited like the galaxy volume: out = emission + dst × transmittance.
import * as THREE from 'three';
import { galaxyNebulae } from '../../universe/GalaxyModel.js';
import { COMPOSITE_FRAG, FS_VERT } from './shaders/volume.js';
import { rotTheta } from './GalaxyCamera.js';
import { NebulaStars } from './NebulaStars.js';

const KIND_ID = { emission: 0, pillars: 1, planetary: 2, remnant: 3, dark: 0 };
const MAXN = 3;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
#include <rv_common>
uniform sampler3D tNoise;
uniform vec3 uCamPos;
uniform mat4 uInvProj;
uniform mat3 uCamRot;
uniform int uCount;
uniform vec4 uNeb[${MAXN}];     // world center (kly), radius (kly)
uniform vec4 uNebP[${MAXN}];    // kind, seed, palette (1 = hubble), fade
uniform mat3 uNebRot[${MAXN}];  // world → local
uniform int uSteps;
uniform float uFrame, uTime, uHalo;
varying vec2 vUv;

vec4 N(vec3 p){ return texture(tNoise, p); }

// palette: x = Hα, y = [OIII], z = [SII]
vec3 Ha(float hub){ return mix(vec3(1.0, 0.13, 0.24), vec3(1.0, 0.66, 0.22), hub); }
vec3 O3(float hub){ return mix(vec3(0.25, 0.72, 0.85), vec3(0.2, 0.55, 1.0), hub); }
vec3 S2(float hub){ return mix(vec3(0.9, 0.25, 0.25), vec3(1.0, 0.32, 0.18), hub); }

// returns emission (rgb) and extinction (a) per unit length (in radii) at local coords q
vec4 emissionCloud(vec3 q, vec3 s, float hub){
  vec3 w = q + 0.45 * (N(q * 0.21 + s).rgb - 0.5);
  float big = N(w * 0.38 + s * 1.3).r;
  float det = N(w * 1.1 + s * 2.1).a;
  float fine = N(w * 2.6 + s * 0.7).a;
  float fil = N(w * 0.7 + s * 3.7).g;
  float r = length(q);
  vec3 qc = vec3(0.12, 0.05, -0.08);
  vec3 tc = qc - q;
  float dc = length(tc);
  float ion = 1.0 / (1.0 + dc * dc * 10.0);
  // wind-blown cavity around the cluster, surrounded by a thick irregular wall of ionized gas
  float cav = smoothstep(0.12, 0.42, dc + 0.35 * (big - 0.5) + 0.12 * (det - 0.5));
  // irregular envelope: 4 warped ellipsoidal lobes with soft, noise-faded edges (never a sphere / box)
  vec3 we = q + 0.35 * (N(q * 0.33 + s * 0.6).rgb - 0.5) * 2.0;
  float env = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec3 h = fract(sin(vec3(fi * 12.9898 + s.x * 3.1, fi * 78.233 + s.y * 1.7, fi * 37.719 + s.z * 5.3)) * 43758.5453);
    vec3 c = (h - 0.5) * vec3(0.9, 0.5, 0.8);
    vec3 ax = vec3(0.3 + 0.22 * h.y, 0.2 + 0.14 * h.z, 0.28 + 0.2 * h.x);
    vec3 dq = (we - c) / ax;
    env += exp(-dot(dq, dq) * 0.9) * (0.6 + 0.4 * h.x);
  }
  float outer = smoothstep(0.1, 0.75, env + 0.45 * (big - 0.5) + 0.3 * (det - 0.5)) * (1.0 - smoothstep(0.75, 0.99, r));
  float gas = cav * outer * pow(clamp(det * 1.2 + fine * 0.5 + big * 0.4 - 0.55, 0.0, 1.0), 1.6);
  // cold dust lanes and globules in the outer wall, lit on their cluster-facing side
  float dustF = smoothstep(0.72, 0.86, fil * 0.85 + big * 0.3 + (fine - 0.5) * 0.3) * smoothstep(0.25, 0.5, dc) * outer;
  float dustNear = smoothstep(0.72, 0.86, N((w + tc / max(dc, 1e-3) * 0.05) * 0.7 + s * 3.7).g * 0.85 + big * 0.3 + (fine - 0.5) * 0.3) * smoothstep(0.25, 0.5, dc) * outer;
  // Bok globules: small, dense, dark knots inside the glowing gas
  float glob = smoothstep(0.84, 0.94, N(w * 1.5 + s * 5.1).b) * outer;
  dustF = max(dustF, glob);
  float rim = max(dustF - dustNear, 0.0) * ion;
  vec3 col = mix(Ha(hub), O3(hub), smoothstep(0.62, 0.08, dc + 0.25 * (det - 0.5)) * 0.95);
  col = mix(col, S2(hub), smoothstep(0.45, 0.9, r) * 0.6);
  vec3 em = col * gas * (0.5 + 5.0 * ion) + mix(vec3(1.0, 0.5, 0.4), vec3(1.0, 0.82, 0.5), hub) * rim * 30.0;
  em += vec3(0.45, 0.6, 1.0) * exp(-dc * dc * 40.0) * (0.3 + det) * 0.6;   // reflection haze
  return vec4(em, dustF * 26.0 + gas * 0.2);
}

// ---- Pillars of Creation (JWST-like): sculpted molecular columns leaning toward the ionising cluster
// (upper right). Shape = smooth union of tapered capsules (swollen heads, broad bases) warped by a
// 3-iteration domain warp, eroded by ridged noise stretched along the light direction (photo-evaporation
// grooves), so the surface reads as layered, wind-sculpted gas rather than cotton wool.
const vec3 P_LD = vec3(0.56, 0.81, 0.16);                 // direction to the cluster (normalised below)
float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float capsule(vec3 q, vec3 a, vec3 b, float r0, float r1, float head){
  vec3 ab = b - a;
  float t = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
  float rad = mix(r0, r1, t * t * (3.0 - 2.0 * t)) * (1.0 + head * smoothstep(0.7, 0.93, t) * (1.0 - smoothstep(0.96, 1.0, t)));
  return length(q - (a + ab * t)) - rad;
}
float pillarSDF(vec3 q){
  float d = capsule(q, vec3(-1.05, -1.25, 0.05), vec3(-0.2, 0.86, -0.08), 0.42, 0.13, 0.55);      // tall left column
  d = smin(d, capsule(q, vec3(0.02, -1.25, 0.2), vec3(0.74, 0.22, 0.05), 0.3, 0.1, 0.6), 0.12);    // middle column
  d = smin(d, capsule(q, vec3(0.42, -0.25, 0.05), vec3(1.2, 0.5, -0.06), 0.11, 0.065, 0.7), 0.08); // thin finger off the middle one
  d = smin(d, capsule(q, vec3(-1.75, -1.3, 0.3), vec3(-1.15, -0.5, 0.28), 0.36, 0.12, 0.5), 0.12); // small column, bottom left
  d = smin(d, length(vec3(q.x * 0.42, (q.y + 1.55) * 1.4, q.z * 0.9)) - 0.42, 0.25);              // common base cloud
  return d;
}
// signed density (> 0 inside), large-scale (s0) for lighting and full detail for the surface
float pillarField(vec3 q, vec3 s, out float coarse){
  vec3 L = normalize(P_LD);
  // domain warp (3 iterations, decreasing scale): flowing, sheared shapes
  vec3 w = q;
  w += 0.16 * (N(w * 0.45 + s).rgb - 0.5) * 2.0;
  w += 0.07 * (N(w * 1.2 + s * 1.7).rgb - 0.5) * 2.0;
  w += 0.03 * (N(w * 2.2 + s * 0.6).rgb - 0.5) * 2.0;
  float d = -pillarSDF(w);
  // grooves and ridges stretched along the light direction (evaporation flow)
  vec3 qs = w - L * dot(w, L) * 0.6;
  float gro = N(qs * 2.6 + s * 0.4).g;                 // ridged
  float gro2 = N(qs * 3.7 + s * 1.3).g;
  float lump = N(w * 1.8 + s * 2.1).r - 0.5;
  coarse = d + 0.1 * lump;
  return d + 0.1 * lump + 0.06 * (gro - 0.5) + 0.015 * (gro2 - 0.5);
}

float gPillarD = 0.0;      // signed field at the last pillar sample (adaptive stepping)
vec4 pillars(vec3 q, vec3 s, float hub){
  vec3 L = normalize(P_LD);
  float co;
  float d = pillarField(q, s, co);
  gPillarD = d;
  // dust density: a soft but well-defined surface (sculpted edges), denser toward the column cores
  float rho = smoothstep(-0.06, 0.05, d) * (0.6 + 0.8 * smoothstep(0.0, 0.25, co));
  // tenuous evaporating gas just outside the surface, streaming toward the cluster
  vec3 qs = q - L * dot(q, L) * 0.9;
  float flow = N(qs * 4.0 + s * 3.3).g;
  float halo = (1.0 - smoothstep(0.0, 0.11, -d)) * (1.0 - smoothstep(-0.03, 0.02, d));
  float wisp = halo * smoothstep(0.55, 0.9, flow);
  if (rho < 0.002 && wisp < 0.002) {
    return vec4(0.0);
  }
  // self-shadowing: optical depth toward the cluster (coarse field, 5 samples, growing steps)
  float od = 0.0;
  float sc;
  od += max(pillarField(q + L * 0.03, s, sc), -0.05) + 0.05;
  od += max(pillarField(q + L * 0.08, s, sc), -0.05) + 0.05;
  od += (max(pillarField(q + L * 0.16, s, sc), -0.05) + 0.05) * 1.4;
  od += (max(pillarField(q + L * 0.32, s, sc), -0.05) + 0.05) * 2.0;
  od += (max(pillarField(q + L * 0.6, s, sc), -0.05) + 0.05) * 2.6;
  float TL = exp(-od * 14.0);
  // ionisation front: the thin skin of the surface that sees the cluster
  float skin = smoothstep(-0.06, 0.0, d) * (1.0 - smoothstep(0.0, 0.07, d)) * TL;
  float n4 = N(q * 3.0 + s * 0.4).a, n5 = N(q * 1.4 + s * 1.9).r;
  // JWST-like palette: gold / amber lit dust, rust-brown bodies, near-black dense cores
  vec3 deep = mix(vec3(0.09, 0.022, 0.008), vec3(0.3, 0.075, 0.02), n5);
  vec3 lit = mix(vec3(1.0, 0.38, 0.06), vec3(1.0, 0.62, 0.16), n4);
  vec3 rimC = mix(vec3(1.0, 0.5, 0.14), vec3(1.0, 0.72, 0.36), n4);
  float amb = 0.07 + 0.14 * smoothstep(-1.2, 0.8, q.y);        // cavity light from all around
  vec3 bodyC = deep * amb + lit * TL * 1.1;
  // optically thick: radiance ≈ (scattered + emitted) ≈ colour × (ambient + direct) — scale by σ
  float sigma = rho * 26.0;
  // translucent fringes (low column) glow gold where the cluster light leaks through: backlit veils
  float fringe = 1.0 - smoothstep(0.15, 0.85, rho);
  vec3 em = (bodyC + lit * fringe * (0.15 + 1.1 * TL)) * sigma * 1.1;
  em += rimC * skin * TL * TL * 6.0;
  em += mix(vec3(1.0, 0.55, 0.2), vec3(1.0, 0.75, 0.4), flow) * wisp * (0.1 + 2.0 * TL) * 0.7;
  // embedded protostar: a red-glowing knot at the tip of the middle column (JWST's red "lava")
  vec3 tip = vec3(0.7, 0.2, 0.05);
  float dt = length(q - tip);
  em += vec3(1.0, 0.08, 0.05) * exp(-dt * dt / 0.0015) * 40.0;
  return vec4(em, sigma + wisp * 0.6);
}

// Outer cavity wall of an HII region (Eagle-Nebula-like), seen behind (and faintly in front of) the
// columns: two samples on a shell of radius RS with multi-octave textured emission and dark globules.
vec3 cavityWall(vec3 q, vec3 s, float front){
  vec3 d = normalize(q);
  vec3 w = q + 0.9 * (N(q * 0.07 + s).rgb - 0.5);
  float a = N(w * 0.1 + s * 0.4).r, b = N(w * 0.28 + s * 1.3).a, c = N(w * 0.7 + s * 2.2).a, e = N(w * 1.7 + s * 0.9).r;
  float glob = N(w * 0.16 + s * 2.7).r;
  float dens = clamp(0.25 + 0.9 * a + 0.55 * (b - 0.5) + 0.35 * (c - 0.5) + 0.2 * (e - 0.5), 0.0, 1.6);
  float fil = smoothstep(0.55, 0.9, c * 0.6 + e * 0.5) * 0.5;   // brighter ionised wisps
  float up = smoothstep(-0.6, 0.9, dot(d, normalize(P_LD)));   // brighter toward the cluster (upper right)
  // JWST-like: deep blue ionised gas ([OIII]/Paschen rendered blue), cyan-white near the cluster
  vec3 blue = mix(vec3(0.03, 0.08, 0.3), vec3(0.12, 0.3, 0.75), a);
  vec3 hot = vec3(0.45, 0.65, 1.0);
  vec3 rust = vec3(0.5, 0.22, 0.1);
  vec3 col = mix(blue, hot, smoothstep(0.55, 0.95, b) * 0.6 * up) + rust * smoothstep(0.66, 0.92, glob) * 0.3;
  float dark = 1.0 - 0.6 * smoothstep(0.64, 0.92, glob + 0.25 * (e - 0.5) + 0.2 * (b - 0.5));   // cold dark clouds
  return col * (dens * (0.3 + 0.9 * up) + fil * up) * dark * (front > 0.5 ? 0.25 : 1.0);
}

// Planetary nebula (Helix / Ring-like): a thick, slightly irregular shell. Volume integration of an
// optically thin shell gives the limb-brightened ring by itself (path length ∝ 1/√(1−r²)) from any angle.
//  · [OIII] fills the inner cavity (teal-blue), brightening toward the shell, with faint radial spokes
//  · the Hα/[NII] shell (orange-red), clumpy, with an inner rim of cometary knots: dense heads with
//    photo-ionised (bright) tips facing the white dwarf and dark tails streaming radially outward
//  · a faint, broken outer halo, and the hot white dwarf at the centre
vec3 gViewL = vec3(0.0, 0.0, 1.0);   // ray direction in the nebula's local frame (set per nebula)
vec4 planetary(vec3 q, vec3 s, float hub){
  vec3 p = q * vec3(1.0, 1.28, 1.0);
  float r = length(p);
  vec3 dir = p / max(r, 1e-4);
  // the shell is a thick torus seen pole-on (Helix): its caps along the line of sight are missing, so
  // the [OIII] interior is seen clean through the ring instead of behind two layers of Hα
  float vz = dot(dir, gViewL);
  float torus = 1.0 - 0.92 * smoothstep(0.35, 0.8, abs(vz));
  // irregular shell radius (lumpy, slightly lopsided like the Helix)
  float rs = 0.46 + 0.07 * (N(dir * 0.9 + s).r - 0.5) * 2.0 + 0.03 * dir.x;
  // radially stretched coordinates: features become radial streaks (knot tails, spokes)
  vec3 rq = dir * 3.2 + vec3(r * 0.35);
  float cel = N(dir * 2.6 + vec3(r * 0.18) + s * 1.3).b;          // cellular: knot heads
  float spk = N(rq + s * 0.7).g;
  float clump = N(q * 1.1 + s * 2.1).r, clump2 = N(q * 2.4 + s * 0.4).a;
  // [OIII] interior: filled, limb-brightening toward the shell, faint radial spokes
  float o3 = smoothstep(rs + 0.02, rs - 0.1, r) * (0.18 + 0.82 * pow(smoothstep(0.0, rs, r), 1.6)) * (0.7 + 0.6 * spk);
  // Hα / [NII] shell: thick, clumpy, peak just outside rs
  float hr = (r - rs - 0.09) / 0.11;
  float ha = exp(-hr * hr) * (0.12 + 1.6 * smoothstep(0.32, 0.72, clump)) * (0.45 + 1.0 * smoothstep(0.3, 0.75, clump2)) * (0.25 + 1.5 * spk * spk) * torus;
  // inner bright rim of the shell (where [OIII] and Hα overlap: white-blue in the photos)
  float rimR = (r - rs + 0.01) / 0.04;
  float rim = exp(-rimR * rimR) * (0.5 + 0.8 * clump2) * torus;
  // cometary knots: heads on the inner shell edge, tails radially outward
  float kr = r - rs + 0.03;
  float head = smoothstep(0.84, 0.95, cel) * (0.3 + 1.2 * clump) * exp(-pow(kr / 0.035, 2.0)) * torus;
  float tail = smoothstep(0.7, 0.9, cel) * smoothstep(-0.02, 0.03, kr) * (1.0 - smoothstep(0.03, 0.16, kr)) * torus;
  // outer halo, broken into arcs
  float halo = exp(-pow((r - 0.8) / 0.09, 2.0)) * smoothstep(0.4, 0.75, N(q * 1.2 + s * 3.0).r);
  vec3 cO3 = mix(vec3(0.08, 0.62, 0.9), vec3(0.1, 0.55, 1.0), hub);
  vec3 cHa = mix(vec3(1.0, 0.2, 0.08), vec3(1.0, 0.36, 0.12), hub);
  vec3 em = cO3 * o3 * 0.75
          + cHa * ha * 1.1
          + mix(vec3(0.6, 0.92, 1.0), cHa, 0.12) * rim * 1.4
          + vec3(1.0, 0.75, 0.6) * head * 2.2
          + cHa * halo * 0.22;
  em += vec3(0.8, 0.9, 1.0) * exp(-r * r * 2500.0) * 60.0;          // white dwarf
  return vec4(em, head * 26.0 + tail * 5.0 + ha * 0.15);
}

vec4 remnant(vec3 q, vec3 s, float hub){
  float r = length(q);
  vec3 w = q + 0.25 * (N(q * 0.4 + s).rgb - 0.5);
  float rw = length(w);
  float sh = exp(-pow((rw - 0.78) / 0.16, 2.0));
  float f1 = pow(N(w * 1.1 + s * 1.3).g, 3.0), f2 = pow(N(w * 2.3 + s * 2.1).g, 4.0);
  float fil = (f1 * 1.6 + f2) * sh;
  float t = N(w * 0.6 + s * 3.0).r;
  vec3 em = mix(Ha(hub), O3(hub), smoothstep(0.35, 0.65, t)) * fil * 5.0 + O3(hub) * exp(-r * r * 4.0) * 0.08;
  em += vec3(0.7, 0.8, 1.0) * exp(-r * r * 2500.0) * 30.0;          // pulsar
  return vec4(em, fil * 2.0);
}

vec4 sampleNeb(int kind, vec3 q, vec3 s, float hub){
  if (kind == 0) return emissionCloud(q, s, hub);
  if (kind == 1) return pillars(q, s, hub);
  if (kind == 2) return planetary(q, s, hub);
  return remnant(q, s, hub);
}

void main(){
  vec4 vv = uInvProj * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
  vec3 rd = normalize(uCamRot * normalize(vv.xyz / vv.w));
  vec3 ro = uCamPos;
  float jit = rv_hash12(gl_FragCoord.xy + vec2(mod(uFrame, 64.0) * 17.31, 3.7));
  vec3 L = vec3(0.0);
  float T = 1.0;
  for (int k = 0; k < ${MAXN}; k++) {
    if (k >= uCount) break;
    vec3 c = uNeb[k].xyz; float R = uNeb[k].w;
    vec3 oc = ro - c;
    int kind = int(uNebP[k].x + 0.5);
    // pillars extend past one radius (broad base, leaning columns): larger bounding sphere, more steps
    float Rb = kind == 1 ? 2.0 * R : R;
    int nSteps = kind == 1 ? int(float(uSteps) * 2.6) : uSteps;
    float b = dot(oc, rd), cc = dot(oc, oc) - Rb * Rb;
    vec3 s = vec3(uNebP[k].y, uNebP[k].y * 1.7, uNebP[k].y * 0.3);
    float hub = uNebP[k].z, fade = uNebP[k].w;
    mat3 M = uNebRot[k];
    gViewL = normalize(M * rd);
    // the nebula tints the space around it (rule 6): scattered and faint ionised light far beyond the
    // bright body, integrated analytically along the ray (Gaussian column through the impact point),
    // broken into wisps by noise at the point of closest approach. Hue shifts toward the complementary
    // colour at the edge (red / teal), so the field around the object is never flat black.
    {
      float tc = max(-b, 0.0);
      vec3 pc = oc + rd * tc;
      float x = length(pc) / R;
      float side = 0.5 + 0.5 * clamp(-b / (2.5 * R), -1.0, 1.0);
      vec3 ql = M * (pc / R);
      vec3 wq = ql + 1.2 * (N(ql * 0.05 + s * 0.3).rgb - 0.5);
      float n1 = N(wq * 0.11 + s).r, n2 = N(wq * 0.31 + s * 1.7).a, n3 = N(wq * 0.8 + s * 0.6).g;
      float wisp = 0.08 + 1.7 * smoothstep(0.35, 0.85, n1) * (0.4 + 1.0 * n2) + 0.6 * smoothstep(0.6, 0.95, n3) * n1;
      vec3 inner, outer;
      if (kind == 2) { inner = vec3(0.10, 0.55, 0.85); outer = vec3(0.9, 0.18, 0.08); }
      else if (kind == 1) { inner = vec3(0.12, 0.32, 0.9); outer = vec3(0.6, 0.35, 0.15); }
      else if (kind == 3) { inner = vec3(0.2, 0.6, 0.9); outer = vec3(0.85, 0.2, 0.3); }
      else { inner = mix(vec3(1.0, 0.18, 0.3), vec3(1.0, 0.45, 0.25), hub); outer = vec3(0.1, 0.5, 0.65); }
      vec3 hc = mix(inner, outer, smoothstep(1.2, 4.5, x));
      float prof = 0.05 * exp(-x * x / 2.0) + 0.016 * exp(-x * x / 10.0) + 0.003 * exp(-x / 5.0);
      L += T * hc * prof * wisp * side * fade * uHalo * (kind == 1 ? 0.35 : 1.0);
    }
    // pillars: the cavity wall of the surrounding HII region (shell of radius RS) — textured
    // backdrop that fills the frame from inside, fades out once the camera leaves the region
    float RS = 2.6 * R;
    float shellK = kind == 1 ? 1.0 - smoothstep(0.85 * RS, 1.15 * RS, length(oc)) : 0.0;
    float tS0 = 0.0, tS1 = -1.0;
    if (shellK > 0.0) {
      float ccS = dot(oc, oc) - RS * RS, discS = b * b - ccS;
      if (discS > 0.0) { float sqS = sqrt(discS); tS0 = -b - sqS; tS1 = -b + sqS; }
      if (tS0 > 0.0) {            // front wall (camera outside the shell: faint veil)
        vec3 qf = M * ((ro + rd * tS0 - c) / R);
        L += T * cavityWall(qf, s, 1.0) * fade * shellK * 0.6;
        T *= mix(1.0, 0.85, shellK);
      }
    }
    float disc = b * b - cc;
    if (disc > 0.0) {
      float sq = sqrt(disc);
      float t0 = max(-b - sq, 0.0), t1 = -b + sq;
      if (t1 > 0.0) {
        float dt = (t1 - t0) / float(nSteps);
        float t = t0 + (kind == 1 ? 0.012 * R : dt) * jit;
        for (int i = 0; i < 240; i++) {
          if (i >= nSteps || t >= t1) break;
          vec3 q = M * ((ro + rd * t - c) / R);
          vec4 d = sampleNeb(kind, q, s, hub);
          // pillars: sphere-trace the empty space, fine steps through the surfaces (no sampling grain)
          float stepT = kind == 1 ? R * clamp(-gPillarD * 0.6, 0.012, 0.14) : dt;
          stepT = min(stepT, t1 - t);
          float dl = (kind == 1 ? stepT : dt) / R;
          float a = exp(-d.a * dl * fade);
          // emission integrated over the step with self-absorption
          L += T * d.rgb * fade * dl * (d.a > 1e-3 ? (1.0 - a) / (d.a * dl * fade + 1e-6) : 1.0);
          T *= a;
          if (T < 0.004) break;
          t += kind == 1 ? max(stepT, 1e-6 * R) : dt;
        }
      }
    }
    if (shellK > 0.0 && tS1 > 0.0 && T > 0.004) {
      vec3 qb = M * ((ro + rd * tS1 - c) / R);
      L += T * cavityWall(qb, s, 0.0) * fade * shellK * 0.6;
      T *= mix(1.0, 0.45, shellK * fade);          // the wall hides much of the galaxy behind it
    }
    if (T < 0.004) break;
  }
  gl_FragColor = vec4(L, T);
}
`;

export class Nebulae {
  constructor(engine, galaxy, S, volUniforms) {
    this.engine = engine;
    this.list = galaxyNebulae(galaxy);
    const q = engine.quality;
    this.steps = q.tier === 'ultra' ? 110 : q.tier === 'high' ? 84 : q.tier === 'med' ? 56 : 36;
    this.resScale = q.tier === 'ultra' ? 0.6 : q.tier === 'high' ? 0.5 : q.tier === 'med' ? 0.42 : 0.34;
    this.maxPixels = q.tier === 'ultra' ? 1.4e6 : q.tier === 'high' ? 7e5 : q.tier === 'med' ? 3.6e5 : 1.8e5;
    const nebU = [], nebP = [], nebR = [];
    for (let i = 0; i < MAXN; i++) { nebU.push(new THREE.Vector4()); nebP.push(new THREE.Vector4()); nebR.push(new THREE.Matrix3()); }
    this.uniforms = {
      tNoise: volUniforms.tNoise,
      uCamPos: { value: new THREE.Vector3() }, uInvProj: { value: new THREE.Matrix4() }, uCamRot: { value: new THREE.Matrix3() },
      uCount: { value: 0 }, uNeb: { value: nebU }, uNebP: { value: nebP }, uNebRot: { value: nebR },
      uSteps: { value: this.steps }, uFrame: { value: 0 }, uTime: { value: 0 }, uHalo: { value: 1 },
    };
    this.mat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: FRAG, uniforms: this.uniforms, depthTest: false, depthWrite: false });
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.rt = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG,
      uniforms: { tVol: { value: this.rt.texture }, uVolSize: { value: new THREE.Vector2(4, 4) }, uGain: { value: 1 }, uDetail: { value: 0 } },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.group = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMat);
    this.group.frustumCulled = false;
    this.group.renderOrder = 5;
    this.group.visible = false;
    // dense field of the star-forming region (behind + a few in front of the nebula)
    try { this.stars = new NebulaStars(engine, galaxy); this.group.add(this.stars.back, this.stars.front); } catch (err) { console.warn('[galaxy] nebula stars failed', err); this.stars = null; }
    // per-nebula orientation (world → local), pattern-frame centers in kly
    this.items = this.list.map((nb) => {
      const m4 = new THREE.Matrix4().makeRotationFromEuler(nb.kind === 'pillars' ? new THREE.Euler(0.06, nb.tilt[0], 0.12, 'YXZ') : new THREE.Euler(nb.tilt[1], nb.tilt[0], nb.tilt[1] * 0.5, 'YXZ'));
      return {
        nb, center: new THREE.Vector3(nb.x, nb.y, nb.z).multiplyScalar(1 / 1000), radius: nb.radius / 1000,
        rot: new THREE.Matrix3().setFromMatrix4(m4).transpose(), kind: KIND_ID[nb.kind] ?? 0,
        seed: (nb.seed % 1000) / 1000 * 7.3, hub: nb.palette === 'hubble' ? 1 : 0, world: new THREE.Vector3(), d: 0, fade: 0, seen: false,
      };
    });
    this.active = [];
    this._m3 = new THREE.Matrix3();
    this.frame = 0;
    this.setSize(engine.pipeline.width, engine.pipeline.height);
  }

  setSize(w, h) {
    let s = this.resScale;
    if (w * h * s * s > this.maxPixels) s = Math.sqrt(this.maxPixels / (w * h));
    const vw = Math.max(16, Math.round(w * s)), vh = Math.max(16, Math.round(h * s));
    this.rt.setSize(vw, vh);
    this.compositeMat.uniforms.uVolSize.value.set(vw, vh);
  }

  update(camera, pat, camPat, dt, t) {
    const e = this.engine;
    if (this.rt.width !== Math.round(e.pipeline.width * this.resScale) && this._lastW !== e.pipeline.width) { this._lastW = e.pipeline.width; this.setSize(e.pipeline.width, e.pipeline.height); }
    this.active.length = 0;
    for (const it of this.items) {
      rotTheta(it.center, pat, it.world);
      it.d = it.world.distanceTo(camera.position);
      it.fade = 1 - THREE.MathUtils.smoothstep(it.d / it.radius, 28, 70);
      if (it.fade > 0.001) this.active.push(it);
      if (!it.seen && it.d < it.radius * 6) {
        it.seen = true;
        try { e.ui.toast(it.nb.name, { kind: 'discovery', eyebrow: it.nb.kind === 'planetary' ? 'Planetary nebula' : it.nb.kind === 'remnant' ? 'Supernova remnant' : 'Nebula' }); } catch (_) { /* ui optional */ }
      }
    }
    this.active.sort((a, b) => a.d - b.d);
    if (this.active.length > MAXN) this.active.length = MAXN;
    const u = this.uniforms;
    u.uCount.value = this.active.length;
    this.active.forEach((it, i) => {
      u.uNeb.value[i].set(it.world.x, it.world.y, it.world.z, it.radius);
      u.uNebP.value[i].set(it.kind, it.seed, it.hub, it.fade);
      // local frame co-rotates with the pattern: world → pattern (−pat) → local
      const c = Math.cos(-pat), s = Math.sin(-pat);
      const rp = this._m3.set(c, 0, -s, 0, 1, 0, s, 0, c);
      u.uNebRot.value[i].multiplyMatrices(it.rot, rp);
    });
    u.uCamPos.value.copy(camera.position);
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
    u.uFrame.value = e.shot ? 0 : (this.frame++ % 64);
    u.uTime.value = t;
    this.group.visible = this.active.length > 0;
    // the dense star-forming-region field only around the nebula itself (within ~10 radii)
    let nf = 0;
    for (const it of this.active) nf = Math.max(nf, 1 - THREE.MathUtils.smoothstep(it.d / it.radius, 6, 14));
    this.stars?.update(nf);
    void camPat; void dt;
  }

  /** Marker entries for nebulae in view (merged into the mode's marker list). */
  markers(camera, e, out) {
    const v = new THREE.Vector3();
    for (const it of this.items) {
      if (it.d > it.radius * 90 || it.d < it.radius * 1.4) continue;
      v.copy(it.world).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      const pr = it.radius / Math.max(it.d, 1e-9) * (e.height / 2) / Math.tan(camera.fov * Math.PI / 360);
      out.push({ id: 'gx-neb-' + it.nb.id, x: (v.x * 0.5 + 0.5) * e.width, y: (0.5 - v.y * 0.5) * e.height - Math.min(pr, e.height * 0.3) - 12, visible: true, label: it.nb.name, sub: it.nb.kind === 'planetary' ? 'planetary nebula' : it.nb.kind === 'remnant' ? 'supernova remnant' : it.nb.kind === 'pillars' ? 'star-forming pillars' : 'emission nebula' });
    }
    return out;
  }

  render(renderer) {
    if (!this.active.length) return;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    renderer.render(this.quadScene, this.quadCam);
    renderer.setRenderTarget(prev);
  }

  isReady() { return true; }

  dispose() {
    this.stars?.dispose();
    this.rt.dispose(); this.mat.dispose(); this.compositeMat.dispose();
    this.quad.geometry.dispose(); this.group.geometry.dispose();
  }
}
