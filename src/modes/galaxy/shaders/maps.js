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

// small bright knots: jittered-grid Gaussian blobs, gated per cell (fraction 1-thr survives)
float knots(vec3 q, float thr, float rad){
  vec2 i = floor(q.xy), f = q.xy - i;
  float s = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 b = vec2(float(x), float(y));
    vec3 h = rv_hash33(vec3(i + b, q.z));
    if (h.z < thr) continue;
    vec2 d = b + 0.15 + 0.7 * h.xy - f;
    float rr = rad * (0.6 + 0.8 * fract(h.x * 7.13));
    s += exp(-dot(d, d) / (rr * rr)) * (0.3 + 1.0 * fract(h.z * 13.7));
  }
  return s;
}

void main(){
  vec2 p = (vUv * 2.0 - 1.0) * uMapR;
  float r = length(p);
  float R = gR;
  vec2 P = p / R;                                   // galaxy-normalized coordinates
  vec3 so = vec3(uSeedF * 1.37, uSeedF * 0.71, uSeedF * 2.13);
  float cut = 1.0 - smoothstep(0.72 * R, 1.25 * R, r);

  // multi-scale noises (normalized space)
  float n1 = rv_fbm(vec3(P * 5.0, 0.7) + so, 4);
  float n2 = rv_fbm(vec3(P * 16.0, 3.1) + so, 4);
  float n3 = rv_fbm(vec3(P * 48.0, 5.3) + so, 3);
  float rid = rv_ridged(vec3(P * 13.0, 7.7) + so, 5);
  float ridF = rv_ridged(vec3(P * 34.0, 9.1) + so, 4);

  float old = exp(-r / uRd) * cut * (0.88 + 0.24 * n1 + 0.08 * n2);
  float young = 0.0, dust = 0.0, hii = 0.0;
  float armRidge = 0.0;          // where young stars / HII concentrate (for knots)

  if (gType <= 2 && gM > 0.5) {
    GxArm a = gx_arm(p);
    float sig = gArmW * (0.7 + 0.6 * r / R);
    float win = gx_armWindow(a.k, r);
    float frag = gx_armFrag(a.k, a.u);
    // ragged arm: perpendicular coordinate wobbled by noise
    float dN = a.dperp + sig * (1.3 * n1 + 0.55 * n2);
    // along-arm variation of width and brightness (log-radius coordinate per arm)
    float nAl = rv_fbm(vec3(a.u * 3.2 + float(a.k) * 7.3, dN / sig * 0.12, 11.0 + uSeedF), 3);
    float wAl = 1.0 + 0.45 * nAl;
    float bAl = smoothstep(-0.55, 0.35, nAl) * 0.85 + 0.25;
    // braided arm: 3 strands wandering around the ridge, appearing / vanishing along the arm
    float armY = 0.0;
    for (int j = 0; j < 3; j++) {
      float fj = float(j);
      float ns = rv_fbm(vec3(a.u * 2.4 + fj * 5.1, float(a.k) * 3.3 + fj * 1.7, 21.0 + uSeedF), 3);
      float nw = rv_fbm(vec3(a.u * 3.1 + fj * 2.3, float(a.k) * 1.9 - fj, 31.0 + uSeedF), 2);
      float off = (fj - 1.0) * 1.1 * sig + 2.0 * sig * ns;
      float w = sig * (0.75 + 0.55 * nw) * (j == 1 ? 1.35 : 0.9);
      float g = j == 1 ? 1.0 : smoothstep(-0.15, 0.35, nw + 0.25 * ns);
      float d = (dN + 0.35 * sig - off) / w;
      armY += g * exp(-0.5 * d * d) * (j == 1 ? 1.0 : 0.75);
    }
    armY = min(armY, 1.4) * bAl;
    float dB = a.dperp / (sig * 4.0);
    float armBroad = exp(-0.5 * dB * dB);
    float clump = smoothstep(-0.3, 0.55, n2 * 0.85 + n3 * 0.45 + n1 * 0.3);
    young = win * frag * frag * (armY * (0.1 + 1.5 * clump) + 0.22 * armBroad * (0.55 + 0.45 * n1));
    armRidge = win * frag * armY;
    old *= 1.0 + 0.6 * win * armBroad;
    // spurs / feathers: high-pitch structures leaving the arms downstream
    float pitchS = atan(gTanP) + 0.8;
    float rr = max(r, R * 0.02);
    float psiS = atan(p.y, p.x + 1e-9) - log(rr / gR0) / tan(pitchS) - gPhi0 + n1 * 1.2;
    float spurPat = smoothstep(0.45, 0.95, 0.5 + 0.5 * cos(psiS * gM * 5.0 + n2 * 2.0));
    float dS = (a.dperp + 2.4 * sig) / (2.0 * sig);
    float spurEnv = exp(-0.5 * dS * dS) * win;
    young += uSpur * 0.6 * spurPat * spurEnv * smoothstep(-0.1, 0.5, n2 + 0.3 * n3);
    // flocculent interarm patches (isotropic, not stripes)
    float fl = smoothstep(0.25, 0.75, n3 + 0.4 * n2) * smoothstep(gR0 * 0.8, gR0 * 1.6, r) * (1.0 - smoothstep(0.75 * R, 1.05 * R, r));
    young += uFloc * 0.2 * fl * exp(-r / uRdY) * 2.2 * (1.0 - armY);
    // --- dust: main lane on the concave (upstream) edge, braided filaments
    float sD = sig * mix(0.4, 0.62, smoothstep(gR0 * 0.3, gR0 * 1.5, r));
    float dD = (dN - 1.35 * sig) / sD;
    float lane = exp(-0.5 * dD * dD);
    float winD = smoothstep(gR0 * 0.04, gR0 * 0.4, r) * (1.0 - smoothstep(gArmEnd[a.k] * 0.8, gArmEnd[a.k] * 1.1, r)) * mix(1.0, gArmAmp[a.k], 0.6);
    lane *= winD * (0.3 + 1.2 * smoothstep(0.15, 0.75, rid)) * (0.7 + 0.5 * frag);
    // dust inside the arm (patchy) and feathers crossing it
    float inArm = armY * win * smoothstep(0.25, 0.75, ridF * 0.9 + n3 * 0.3);
    float feath = spurPat * exp(-0.5 * dS * dS * 0.5) * win * smoothstep(0.2, 0.7, ridF + 0.3 * n2);
    dust += lane * 1.5 + inArm * 0.75 + uSpur * 0.9 * feath;
    // diffuse HII glow along the young ridge
    hii += 0.06 * young * smoothstep(0.0, 0.5, n3 + 0.3);
  }
  if (gType == 2) {
    float di = (r - gRingIn) / (R * 0.035), dout = (r - gRingOut) / (R * 0.03);
    float ringY = exp(-0.5 * di * di) + 0.7 * exp(-0.5 * dout * dout);
    float th = atan(p.y, p.x + 1e-9);
    float rn = rv_fbm(vec3(cos(th) * 4.0, sin(th) * 4.0, r / R * 8.0) + so, 5);
    young = max(young, ringY * (0.2 + 1.3 * smoothstep(-0.3, 0.5, rn + n2 * 0.5)));
    armRidge = max(armRidge, ringY);
    float dri = (r - gRingIn * 0.965) / (R * 0.012);
    dust += 1.1 * exp(-0.5 * dri * dri) * smoothstep(-0.3, 0.5, rn + rid * 0.4);
    old *= 1.0 + 0.35 * ringY;
  }
  if (gType == 1) {
    // bar dust lanes on the leading edges (bar major axis at angle phi0), curving into the arms
    float ca = cos(-gPhi0), sa = sin(-gPhi0);
    vec2 b = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
    float ax = abs(b.x) / uBar.x;
    float off = -sign(b.x) * uBar.y * (0.15 + 0.6 * ax * ax);
    float dl = (b.y - off + uBar.y * 0.25 * (n2 - 0.0)) / (uBar.x * 0.03 * (0.7 + 0.9 * ax));
    float barLane = exp(-0.5 * dl * dl) * smoothstep(0.06, 0.25, ax) * (1.0 - smoothstep(0.85, 1.15, ax));
    dust += 1.5 * barLane * (0.45 + 0.8 * smoothstep(0.1, 0.7, rid));
    // star-formation desert swept by the bar: the disk inside the bar radius is dimmer
    float me = (b.x * b.x) / (uBar.x * uBar.x) + (b.y * b.y) / (uBar.y * uBar.y * 2.5);
    old *= 1.0 - 0.55 * (1.0 - smoothstep(0.75, 1.15, r / uBar.x)) * smoothstep(0.6, 1.4, me);
    young *= 1.0 - 0.8 * (1.0 - smoothstep(0.8, 1.2, r / uBar.x)) * smoothstep(0.6, 1.4, me);
    // nuclear ring of star formation (NGC 1300 core)
    float nr = (r - uBar.x * 0.1) / (uBar.x * 0.022);
    float nring = exp(-0.5 * nr * nr);
    young += 0.8 * nring * (0.4 + 0.8 * smoothstep(-0.2, 0.5, n3));
    hii += 0.7 * nring * smoothstep(0.0, 0.6, n3 + 0.2);
    float nd = (r - uBar.x * 0.075) / (uBar.x * 0.02);
    dust += 0.9 * exp(-0.5 * nd * nd) * smoothstep(0.1, 0.7, ridF);
  }
  if (gType == 5) {
    float yv = gx_young(p);
    young = yv * (0.25 + 1.4 * smoothstep(-0.25, 0.55, n2 + n3 * 0.6));
    armRidge = yv;
    hii += 0.45 * yv * smoothstep(0.2, 0.7, n3 + n2 * 0.4);
    dust += 0.8 * yv * smoothstep(0.25, 0.75, rid) + 0.3 * smoothstep(0.4, 0.8, ridF) * exp(-r / (0.5 * R));
    old = exp(-r / uRd) * cut * (0.6 + 0.8 * smoothstep(-0.4, 0.6, n1));
  }
  if (gType == 3) {
    old = exp(-r / uRd) * cut + 0.25 * (1.0 - smoothstep(0.18 * R, 0.4 * R, r));
  }
  if (gType == 4) old = 0.0;

  // faint blue diffuse light of the young disk (outer disks look blue-grey, not beige)
  if (gType != 4 && gType != 3) young += 0.1 * exp(-r / uRdY) * cut * smoothstep(gR0 * 0.3, gR0 * 1.2, r) * (0.7 + 0.5 * n1);
  // diffuse dust web across star-forming disks
  if (gType != 4 && gType != 3) {
    float web = smoothstep(0.15, 0.65, n2 * 0.8 + n3 * 0.5 + n1 * 0.3) * exp(-r / (0.55 * R)) * smoothstep(gR0 * 0.25, gR0 * 1.1, r);
    dust += web * 0.35 + 0.1 * exp(-r / uRdY) * cut * smoothstep(gR0 * 0.2, gR0, r);
  }
  // fine dust filaments across the whole star-forming disk (Hubble-like texture)
  if (gType != 4 && gType != 3) {
    float fd = rv_ridged(vec3(P * 40.0, 13.3) + so, 4);
    float fd2 = rv_ridged(vec3(P * 85.0, 17.9) + so, 2);
    float envD = exp(-r / (0.7 * R)) * smoothstep(gR0 * 0.05, gR0 * 0.5, r) * cut;
    dust += (0.9 * smoothstep(0.55, 0.9, fd) + 0.4 * smoothstep(0.6, 0.92, fd2)) * envD * smoothstep(0.35, 0.75, n1 * 0.6 + n2 * 0.6 + 0.5);
  }
  // Sombrero-like dust ring
  if (uDustRing.z > 0.0) {
    float dr = (r - uDustRing.x) / uDustRing.y;
    float th = atan(p.y, p.x + 1e-9);
    float rn = rv_fbm(vec3(cos(th) * 6.0, sin(th) * 6.0, r / R * 10.0) + so + 3.0, 5);
    dust += 1.3 * uDustRing.z * exp(-0.5 * dr * dr) * (0.45 + 0.8 * smoothstep(-0.4, 0.5, rn));
    float dr2 = (r - uDustRing.x * 0.86) / (uDustRing.y * 0.35);
    dust += 0.8 * uDustRing.z * exp(-0.5 * dr2 * dr2) * smoothstep(0.0, 0.6, rn);
    old *= 0.35 + 1.6 * exp(-0.5 * pow((r - uDustRing.x * 1.02) / (uDustRing.y * 1.6), 2.0));
    young += 0.25 * exp(-0.5 * dr * dr) * smoothstep(0.1, 0.7, rn + n3 * 0.4);
  }

  // clusters and HII regions at the shared sites (match CPU-placed cluster stars)
  if (gType == 0 || gType == 1 || gType == 2 || gType == 5) {
    int cx = int(floor(p.x / gSiteCell)), cz = int(floor(p.y / gSiteCell));
    float yk = 0.0, hk = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      float act, isH;
      vec4 s = gx_site(cx + i, cz + j, act, isH);
      if (act < 0.5) continue;
      vec2 d = p - s.xy;
      float q2 = dot(d, d);
      float sz = s.z * 2.2;
      float sn = rv_fbm(vec3(d / sz * 1.3, float(i + 3 * j) * 1.7 + uSeedF), 3);
      yk += s.w * exp(-0.5 * q2 / (sz * sz * 0.3)) * (0.7 + 0.5 * sn);
      float gh = exp(-0.5 * q2 / (sz * sz));
      hk += isH * s.w * gh * clamp(0.4 + 1.1 * sn, 0.0, 1.6);
    }
    // many small knots along the young ridge (HII complexes + OB associations)
    float kA = knots(vec3(P * 95.0, 1.0 + uSeedF), 0.62, 0.2);
    float kB = knots(vec3(P * 45.0, 4.0 + uSeedF), 0.75, 0.2);
    float kC = knots(vec3(P * 120.0, 7.0 + uSeedF), 0.25, 0.3);
    float ridgeK = smoothstep(0.08, 0.6, armRidge);
    hk += ridgeK * (2.4 * kA + 3.0 * kB) * smoothstep(-0.2, 0.3, n2);
    yk += ridgeK * (0.8 * kC + 0.5 * kA);
    young += yk * 0.8;
    hii += hk * uHii;
    dust += 0.3 * hk * smoothstep(0.0, 0.4, n3 + 0.2);
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
