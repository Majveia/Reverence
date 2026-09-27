// Shared GLSL for the galaxy track: bit-exact mirrors of GalaxyModel's hash / value noise / arm
// geometry / cluster sites (so GPU maps line up with CPU-placed stars), plus the uniform block
// builder. Shader units: kly (1 unit = 1000 light-years), pattern frame, disk in XZ.
import * as THREE from 'three';
import { registerChunk } from '../../../shaders/chunks.js';

export const TYPE_ID = { spiral: 0, barred: 1, ring: 2, lenticular: 3, elliptical: 4, irregular: 5 };

registerChunk('gx_common', /* glsl */ `
#ifndef GX_COMMON
#define GX_COMMON
#ifndef TAU
#define TAU 6.28318530718
#endif
uniform float gR, gM, gTanP, gSinP, gPhi0, gR0, gWarpAmp, gWarpF, gArmW, gFragAmp, gFragF;
uniform uint gSeedWarp, gSeedFrag, gSeedSite;
uniform float gArmAmp[8];
uniform float gArmEnd[8];
uniform float gSiteCell, gSiteDensity, gHiiFrac, gRingIn, gRingOut;
uniform int gType;
uniform vec4 gClumps[12];
uniform int gNClumps;

uint gx_hash(uint x){ x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
uint gx_ih2(int x, int y, uint seed){ return gx_hash((uint(x) * 0x27d4eb2du) ^ (uint(y) * 0x165667b1u) ^ seed); }
float gx_u(uint h){ return float(h) * (1.0 / 4294967296.0); }
float gx_vnoise2(vec2 p, uint seed){
  vec2 i = floor(p); vec2 f = p - i; vec2 u = f * f * (3.0 - 2.0 * f);
  int ix = int(i.x), iy = int(i.y);
  float a = gx_u(gx_ih2(ix, iy, seed)), b = gx_u(gx_ih2(ix + 1, iy, seed));
  float c = gx_u(gx_ih2(ix, iy + 1, seed)), d = gx_u(gx_ih2(ix + 1, iy + 1, seed));
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}
float gx_fbm2(vec2 p, uint seed, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int o = 0; o < 4; o++){
    if (o >= oct) break;
    s += a * gx_vnoise2(p, seed + uint(o) * 101u); n += a;
    p = p * 2.03 + vec2(17.1, 5.3); a *= 0.5;
  }
  return s / n;
}

struct GxArm { float r; int k; float dperp; float u; float psi; };
GxArm gx_arm(vec2 p){
  GxArm a;
  float r = length(p);
  float rr = max(r, gR * 0.02);
  a.r = r; a.k = 0; a.dperp = 1e9; a.u = 0.0; a.psi = 0.0;
  if (gM < 0.5) return a;
  float th = atan(p.y, p.x + 1e-9);
  float lr = log(rr / gR0) / gTanP;
  float w = gWarpAmp * (gx_fbm2(p * gWarpF, gSeedWarp, 3) * 2.0 - 1.0);
  float psi = th - lr - gPhi0 + w;
  float s = psi * gM / TAU;
  float n = floor(s + 0.5);
  a.k = int(mod(n, gM));
  a.dperp = (s - n) * TAU / gM * rr * gSinP;
  a.u = log(rr / gR0);
  a.psi = psi;
  return a;
}
float gx_armWindow(int k, float r){
  return smoothstep(gR0 * 0.7, gR0 * 1.12, r) * (1.0 - smoothstep(gArmEnd[k] * 0.75, gArmEnd[k] * 1.05, r)) * gArmAmp[k];
}
float gx_armFrag(int k, float u){
  return 1.0 - gFragAmp * (1.0 - smoothstep(0.3, 0.62, gx_vnoise2(vec2(u * gFragF, float(k) * 7.31 + 3.7), gSeedFrag)));
}
// Young-population surface density (mirror of GalaxyModel.youngDensity)
float gx_young(vec2 p){
  if (gType <= 2) {
    GxArm a = gx_arm(p);
    float r = a.r;
    float sig = gArmW * (0.7 + 0.6 * r / gR);
    float d = (a.dperp + 0.35 * sig) / sig;
    float v = gx_armWindow(a.k, r) * gx_armFrag(a.k, a.u) * exp(-0.5 * d * d);
    if (gType == 2) {
      float di = (r - gRingIn) / (gR * 0.035), dout = (r - gRingOut) / (gR * 0.03);
      v = max(max(v * smoothstep(gRingIn * 0.95, gRingIn * 1.15, r), exp(-0.5 * di * di)), 0.7 * exp(-0.5 * dout * dout));
    }
    return v;
  }
  if (gType == 5) {
    float v = 0.0;
    for (int i = 0; i < 12; i++){
      if (i >= gNClumps) break;
      vec4 c = gClumps[i];
      vec2 d = p - c.xy;
      v += c.w * exp(-0.5 * dot(d, d) / (c.z * c.z));
    }
    return min(1.0, v);
  }
  return 0.0;
}
// Cluster / HII site of jittered-grid cell (mirror of GalaxyModel.clusterSite)
// returns vec4(x, z, size, bright) and flags (active, hii)
vec4 gx_site(int cx, int cz, out float isAct, out float isHii){
  uint h = gx_ih2(cx, cz, gSeedSite);
  float hx = gx_u(gx_hash(h + 1u)), hz = gx_u(gx_hash(h + 2u)), ha = gx_u(gx_hash(h + 3u));
  float hs = gx_u(gx_hash(h + 4u)), hh = gx_u(gx_hash(h + 5u));
  vec2 pos = (vec2(float(cx), float(cz)) + 0.5 + 0.8 * (vec2(hx, hz) - 0.5)) * gSiteCell;
  float act = gx_young(pos);
  isAct = ha < act * gSiteDensity ? 1.0 : 0.0;
  isHii = hh < gHiiFrac ? 1.0 : 0.0;
  return vec4(pos, gSiteCell * (0.05 + 0.14 * hs * hs), 0.35 + 0.65 * hs);
}
#endif
`);

/** Uniform values for the gx_common block from a GalaxyModel structure (lengths → kly). */
export function galaxyUniforms(S) {
  const k = 1 / 1000;
  const amp = new Float32Array(8), end = new Float32Array(8);
  for (let i = 0; i < 8; i++) { amp[i] = S.armAmp[i] ?? 0; end[i] = (S.armEnd[i] ?? S.R) * k; }
  const clumps = [];
  for (let i = 0; i < 12; i++) {
    const c = S.clumps[i];
    clumps.push(c ? new THREE.Vector4(c.x * k, c.z * k, c.s * k, c.w) : new THREE.Vector4(0, 0, 1, 0));
  }
  return {
    gR: { value: S.R * k }, gM: { value: S.m }, gTanP: { value: S.tanP }, gSinP: { value: S.sinP },
    gPhi0: { value: S.phi0 }, gR0: { value: S.r0 * k }, gWarpAmp: { value: S.warpAmp }, gWarpF: { value: S.warpF / k },
    gArmW: { value: S.armW * k }, gFragAmp: { value: S.fragAmp }, gFragF: { value: S.fragF },
    gSeedWarp: { value: S.seedWarp >>> 0 }, gSeedFrag: { value: S.seedFrag >>> 0 }, gSeedSite: { value: S.seedSite >>> 0 },
    gArmAmp: { value: amp }, gArmEnd: { value: end },
    gSiteCell: { value: S.siteCell * k }, gSiteDensity: { value: S.siteDensity }, gHiiFrac: { value: S.hiiFrac },
    gRingIn: { value: S.ringIn * k }, gRingOut: { value: S.ringOut * k },
    gType: { value: TYPE_ID[S.type] ?? 0 },
    gClumps: { value: clumps }, gNClumps: { value: S.clumps.length },
  };
}
