// GLSL for one-off GPU generation passes: the galaxy disk map (pattern frame) and a tileable
// 3-D noise volume used for dust / gas detail.

// Disk map: RGBA = (old stellar surface density, young stars, dust, HII emission).
export const DISK_MAP_FRAG = /* glsl */ `
precision highp float;
precision highp int;
#include <gx_common>
#include <rv_noise>
uniform float uMapR, uRd, uRdY, uDust, uSpur, uFloc, uHii, uSeedF;
uniform vec3 uDustRing;      // r, w, amp (kly)
uniform vec3 uBar;           // a, b, c (kly)
varying vec2 vUv;

float ridge(vec3 p, int oct){ return rv_ridged(p, oct); }

void main(){
  vec2 p = (vUv * 2.0 - 1.0) * uMapR;
  float r = length(p);
  float R = gR;
  vec3 so = vec3(uSeedF * 1.37, uSeedF * 0.71, uSeedF * 2.13);
  float cut = 1.0 - smoothstep(0.98 * R, 1.3 * R, r);
  float old = exp(-r / uRd) * cut;
  float young = 0.0, dust = 0.0, hii = 0.0;

  // large-scale physical-space noises (kly^-1 frequencies)
  float nA = rv_fbm(vec3(p * 0.11, 0.7) + so, 5);
  float nB = rv_fbm(vec3(p * 0.45, 3.1) + so, 5);
  float nC = rv_fbm(vec3(p * 1.6, 5.3) + so, 4);

  if (gType <= 2 && gM > 0.5) {
    GxArm a = gx_arm(p);
    float sig = gArmW * (0.7 + 0.6 * r / R);
    float win = gx_armWindow(a.k, r);
    float frag = gx_armFrag(a.k, a.u);
    // noise stretched along the arms (log-polar, periodic in phase)
    vec3 q = vec3(a.u * 2.2, cos(a.psi) * 2.6, sin(a.psi) * 2.6) + so;
    float nArm = rv_fbm(q, 5);
    float nArm2 = rv_fbm(q * vec3(2.5, 3.0, 3.0) + 7.0, 4);
    // young stellar arms (downstream of the shock)
    float dY = (a.dperp + 0.35 * sig) / sig;
    float profY = exp(-0.5 * dY * dY);
    float clump = smoothstep(-0.3, 0.5, nArm * 0.7 + nB * 0.5 + nArm2 * 0.35);
    young = win * frag * profY * (0.18 + 1.25 * clump);
    // broad old-star arm enhancement
    float dO = a.dperp / (sig * 4.0);
    old *= 1.0 + 0.55 * win * exp(-0.5 * dO * dO);
    // flocculent fragments: higher-multiplicity spiral gated by noise
    float mf = gM * 3.0;
    float fl = 0.5 + 0.5 * cos(a.psi * mf + nA * 3.0);
    float flo = smoothstep(0.7, 0.95, fl) * smoothstep(0.0, 0.5, nB + 0.2) * smoothstep(gR0 * 0.8, gR0 * 1.5, r) * (1.0 - smoothstep(0.8 * R, 1.05 * R, r));
    young += uFloc * 0.45 * flo * exp(-r / uRdY) * 2.5;
    // spurs: large-pitch feathers downstream of the arms
    float pitchS = atan(gTanP) + 0.75;
    float rr = max(r, R * 0.02);
    float psiS = atan(p.y, p.x + 1e-9) - log(rr / gR0) / tan(pitchS) - gPhi0 + nA * 1.5;
    float spurPat = smoothstep(0.55, 0.95, 0.5 + 0.5 * cos(psiS * gM * 5.0));
    float dS = (a.dperp + 2.2 * sig) / (1.8 * sig);
    float spur = spurPat * exp(-0.5 * dS * dS) * win * smoothstep(-0.2, 0.4, nB);
    young += uSpur * 0.35 * spur;
    // dust lane on the concave (upstream) side, continuing into the core as nuclear spirals
    float sD = sig * mix(0.3, 0.5, smoothstep(gR0 * 0.3, gR0 * 1.5, r));
    float dD = (a.dperp - 0.8 * sig) / sD;
    float lane = exp(-0.5 * dD * dD);
    float winD = smoothstep(gR0 * 0.06, gR0 * 0.45, r) * (1.0 - smoothstep(gArmEnd[a.k] * 0.8, gArmEnd[a.k] * 1.1, r)) * mix(1.0, gArmAmp[a.k], 0.6);
    float laneTex = smoothstep(-0.45, 0.35, nArm2 * 0.8 + nC * 0.6);
    lane *= winD * (0.25 + 0.95 * laneTex);
    // secondary thin lanes inside the arm
    float dD2 = (a.dperp - 0.1 * sig) / (sig * 0.22);
    float lane2 = exp(-0.5 * dD2 * dD2) * win * smoothstep(0.1, 0.6, nArm2 + nC * 0.5) * 0.55;
    // dust spurs (feathers)
    float dustSpur = spurPat * exp(-0.5 * dS * dS * 0.6) * win * smoothstep(-0.1, 0.5, nC + nArm * 0.5);
    dust += lane * 1.15 + lane2 + uSpur * 0.7 * dustSpur;
    // HII: diffuse glow along the young arms
    hii += 0.1 * young * smoothstep(0.1, 0.6, nArm2 + 0.3);
  }
  if (gType == 2) {
    // rings (inner starburst ring + outer ring) with clumpy texture
    float di = (r - gRingIn) / (R * 0.035), dout = (r - gRingOut) / (R * 0.03);
    float ringY = exp(-0.5 * di * di) + 0.7 * exp(-0.5 * dout * dout);
    float th = atan(p.y, p.x + 1e-9);
    float rn = rv_fbm(vec3(cos(th) * 4.0, sin(th) * 4.0, r * 0.3) + so, 5);
    young = max(young, ringY * (0.25 + 1.2 * smoothstep(-0.3, 0.5, rn + nC * 0.4)));
    float dri = (r - gRingIn * 0.965) / (R * 0.012);
    dust += 0.9 * exp(-0.5 * dri * dri) * smoothstep(-0.4, 0.4, rn);
    old *= 1.0 + 0.35 * ringY;
  }
  if (gType == 1) {
    // bar dust lanes on the leading edges (bar major axis at angle phi0)
    float ca = cos(-gPhi0), sa = sin(-gPhi0);
    vec2 b = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
    float ax = abs(b.x) / uBar.x;
    float off = -sign(b.x) * uBar.y * (0.18 + 0.55 * ax * ax);
    float dl = (b.y - off) / (uBar.x * 0.035 * (0.7 + 0.8 * ax));
    float barLane = exp(-0.5 * dl * dl) * smoothstep(0.08, 0.3, ax) * (1.0 - smoothstep(0.85, 1.1, ax));
    dust += 1.1 * barLane * (0.5 + 0.7 * smoothstep(-0.3, 0.4, nC));
    // nuclear ring of star formation (like NGC 1300's core)
    float nr = (r - uBar.x * 0.1) / (uBar.x * 0.025);
    young += 0.6 * exp(-0.5 * nr * nr) * (0.4 + 0.8 * smoothstep(-0.2, 0.5, nC));
    hii += 0.4 * exp(-0.5 * nr * nr) * smoothstep(0.0, 0.6, nC);
  }
  if (gType == 5) {
    // irregular: clumpy star formation + patchy dust
    float yv = gx_young(p);
    young = yv * (0.3 + 1.3 * smoothstep(-0.25, 0.55, nB + nC * 0.6));
    hii += 0.5 * yv * smoothstep(0.2, 0.7, nC + nB * 0.4);
    dust += 0.7 * yv * smoothstep(-0.1, 0.6, -nB + nC * 0.5) + 0.25 * smoothstep(0.1, 0.6, nA) * exp(-r / (0.5 * R));
    old = exp(-r / uRd) * cut * (0.7 + 0.6 * smoothstep(-0.4, 0.6, nA));
  }
  if (gType == 3) {
    // lenticular: smooth disk with a lens plateau
    old = exp(-r / uRd) * cut + 0.25 * (1.0 - smoothstep(0.18 * R, 0.4 * R, r));
  }
  if (gType == 4) old = 0.0;

  // diffuse dust web across star-forming disks
  if (gType != 4 && gType != 3) {
    float fil = rv_ridged(vec3(p * 0.9, 2.0) + so, 5);
    float web = smoothstep(0.55, 0.92, fil) * exp(-r / (0.5 * R)) * smoothstep(gR0 * 0.3, gR0 * 1.2, r);
    dust += web * 0.4 + 0.12 * exp(-r / uRdY) * cut * smoothstep(gR0 * 0.2, gR0, r);
  }
  // Sombrero-like dust ring
  if (uDustRing.z > 0.0) {
    float dr = (r - uDustRing.x) / uDustRing.y;
    float th = atan(p.y, p.x + 1e-9);
    float rn = rv_fbm(vec3(cos(th) * 6.0, sin(th) * 6.0, r * 0.5) + so + 3.0, 5);
    dust += uDustRing.z * exp(-0.5 * dr * dr) * (0.45 + 0.8 * smoothstep(-0.4, 0.5, rn));
    float dr2 = (r - uDustRing.x * 0.8) / (uDustRing.y * 0.5);
    dust += 0.35 * uDustRing.z * exp(-0.5 * dr2 * dr2) * smoothstep(0.0, 0.6, rn);
    young += 0.25 * exp(-0.5 * dr * dr) * smoothstep(0.1, 0.7, rn + nC * 0.4);
  }

  // clusters and HII regions at the shared sites
  if (gType == 0 || gType == 1 || gType == 2 || gType == 5) {
    int cx = int(floor(p.x / gSiteCell)), cz = int(floor(p.y / gSiteCell));
    float yk = 0.0, hk = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      float act, isH;
      vec4 s = gx_site(cx + i, cz + j, act, isH);
      if (act < 0.5) continue;
      vec2 d = p - s.xy;
      float q2 = dot(d, d);
      float sz = s.z;
      // irregular HII shapes: noise in the site's own scale
      float sn = rv_fbm(vec3(d / sz * 0.9, float(i + 3 * j) * 1.7 + uSeedF), 3);
      yk += s.w * exp(-0.5 * q2 / (sz * sz * 0.45)) * (0.7 + 0.5 * sn);
      float gh = exp(-0.5 * q2 / (sz * sz * 1.4));
      hk += isH * s.w * gh * clamp(0.55 + 0.9 * sn, 0.0, 1.6);
    }
    young += yk * 0.75;
    hii += hk * uHii;
    dust += 0.35 * hk * smoothstep(0.0, 0.4, nC + 0.2);
  }
  dust *= uDust;
  gl_FragColor = vec4(old, young, dust, hii);
}
`;

// Tileable 3-D noise volume: R = fbm, G = ridged (filaments), B = cellular (clumps), A = fbm (detail)
export const NOISE3D_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform float uZ;
uniform float uSize;
varying vec2 vUv;
uint nh(uint x){ x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
ivec3 wrapc(ivec3 c, int P){ return (c + ivec3(P * 8)) % P; }
vec3 grad(ivec3 c, int P, uint seed){
  c = wrapc(c, P);
  uint h = nh(uint(c.x) * 73856093u ^ uint(c.y) * 19349663u ^ uint(c.z) * 83492791u ^ seed);
  float u = float(h & 1023u) / 1023.0 * 6.2831853, v = float((h >> 10u) & 1023u) / 1023.0 * 2.0 - 1.0;
  float s = sqrt(1.0 - v * v);
  return vec3(s * cos(u), s * sin(u), v);
}
float pnoise(vec3 p, int P, uint seed){
  vec3 i = floor(p); vec3 f = p - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec3 c = ivec3(i);
  float n000 = dot(grad(c, P, seed), f);
  float n100 = dot(grad(c + ivec3(1,0,0), P, seed), f - vec3(1,0,0));
  float n010 = dot(grad(c + ivec3(0,1,0), P, seed), f - vec3(0,1,0));
  float n110 = dot(grad(c + ivec3(1,1,0), P, seed), f - vec3(1,1,0));
  float n001 = dot(grad(c + ivec3(0,0,1), P, seed), f - vec3(0,0,1));
  float n101 = dot(grad(c + ivec3(1,0,1), P, seed), f - vec3(1,0,1));
  float n011 = dot(grad(c + ivec3(0,1,1), P, seed), f - vec3(0,1,1));
  float n111 = dot(grad(c + ivec3(1,1,1), P, seed), f - vec3(1,1,1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm(vec3 p, int P, uint seed, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int o = 0; o < 6; o++){ if (o >= oct) break; s += a * pnoise(p, P, seed + uint(o) * 1013u); n += a; p *= 2.0; P *= 2; a *= 0.5; }
  return s / n;
}
float ridged(vec3 p, int P, uint seed, int oct){
  float s = 0.0, a = 0.5, n = 0.0, w = 1.0;
  for (int o = 0; o < 6; o++){ if (o >= oct) break; float r = 1.0 - abs(pnoise(p, P, seed + uint(o) * 733u) * 1.6); r *= r * w; w = clamp(r * 1.8, 0.0, 1.0); s += a * r; n += a; p *= 2.0; P *= 2; a *= 0.5; }
  return s / n;
}
float cellular(vec3 p, int P, uint seed){
  vec3 i = floor(p); vec3 f = p - i; float d1 = 8.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    ivec3 c = ivec3(i) + ivec3(x, y, z);
    ivec3 cw = wrapc(c, P);
    uint h = nh(uint(cw.x) * 73856093u ^ uint(cw.y) * 19349663u ^ uint(cw.z) * 83492791u ^ seed);
    vec3 o = vec3(float(h & 255u), float((h >> 8u) & 255u), float((h >> 16u) & 255u)) / 255.0;
    vec3 d = vec3(float(x), float(y), float(z)) + o - f;
    d1 = min(d1, dot(d, d));
  }
  return sqrt(d1);
}
void main(){
  vec3 p = vec3(vUv, uZ);
  float a = fbm(p * 4.0, 4, 11u, 5) * 0.5 + 0.5;
  float b = ridged(p * 4.0, 4, 23u, 5);
  float c = 1.0 - clamp(cellular(p * 8.0, 8, 37u) * 1.1, 0.0, 1.0);
  float d = fbm(p * 8.0, 8, 41u, 4) * 0.5 + 0.5;
  gl_FragColor = vec4(clamp(a * 1.25 - 0.12, 0.0, 1.0), clamp(b, 0.0, 1.0), c, clamp(d * 1.25 - 0.12, 0.0, 1.0));
}
`;
