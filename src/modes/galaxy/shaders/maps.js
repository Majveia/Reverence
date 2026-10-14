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
    // power-law sizes and luminosities (few giant complexes, many small knots)
    float u = fract(h.x * 7.13);
    float rr = rad * (0.45 + 1.1 * u * u * u);
    s += exp(-dot(d, d) / (rr * rr)) * (0.25 + 1.4 * pow(fract(h.z * 13.7), 3.0));
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

  // old stars are a smooth population (relaxed orbits): almost no noise of their own
  float old = exp(-r / uRd) * cut * (gType <= 2 ? 0.96 + 0.06 * n1 : 0.88 + 0.24 * n1 + 0.08 * n2);
  float young = 0.0, dust = 0.0, hii = 0.0;
  float armRidge = 0.0;          // where young stars / HII concentrate (for knots)
  float hiiStr = 0.0;            // HII strings along the lanes (spirals)

  if (gType <= 2 && gM > 0.5) {
    GxArm a = gx_arm(p);
    float rN = r / R;
    float rrS = max(r, R * 0.02);
    float lrF = log(rrS / gR0);
    float thF = atan(p.y, p.x + 1e-9);
    // visual arm width tapers: narrow and tight inside, broad and frayed outside
    float sig = gArmW * (0.6 + 1.15 * rN);
    float win = gx_armWindow(a.k, r);
    float frag = gx_armFrag(a.k, a.u);
    float kSeed = float(a.k) * 13.7 + uSeedF;
    // local arm frame in galaxy radii: al = arc length along the arm, ac = signed distance across it
    float dN = a.dperp + sig * ((0.7 + 0.9 * rN) * n1 + 0.45 * n2);
    float x = dN / sig;                                   // across, in arm widths (+ = upstream / dust side)
    // conformal log-polar arm frame (a log spiral is a straight line in (θ, ln r)): al is constant along
    // the arm's orthogonal trajectories, ac across it; both scale with r (sheared structure grows outward).
    // Normalised to galaxy radii at r = 0.4 R.
    float cosP = sqrt(max(0.0, 1.0 - gSinP * gSinP));
    float al = (a.u + a.dperp * cosP / rrS) / gSinP * 0.4;
    float ac = dN / rrS * 0.4;
    // along-arm variations of brightness, lane position and thickness
    float nAl = rv_fbm(vec3(al * 9.0, kSeed, 11.0), 3);
    float nAl2 = rv_fbm(vec3(al * 26.0, kSeed + 3.1, 13.0), 2);
    float bAl = 0.3 + 0.85 * smoothstep(-0.5, 0.4, nAl);
    // braided arm: 3 strands wandering around the ridge, appearing / vanishing along the arm
    float armY = 0.0;
    for (int j = 0; j < 3; j++) {
      float fj = float(j);
      float ns = rv_fbm(vec3(a.u * 2.4 + fj * 5.1, float(a.k) * 3.3 + fj * 1.7, 21.0 + uSeedF), 3);
      float nw = rv_fbm(vec3(a.u * 3.1 + fj * 2.3, float(a.k) * 1.9 - fj, 31.0 + uSeedF), 2);
      float off = (fj - 1.0) * 1.1 + 2.0 * ns;
      float w = (0.75 + 0.55 * nw) * (j == 1 ? 1.35 : 0.9);
      float g = j == 1 ? 1.0 : smoothstep(-0.15, 0.35, nw + 0.25 * ns);
      float d = (x + 0.35 - off) / w;
      armY += g * exp(-0.5 * d * d) * (j == 1 ? 1.0 : 0.75);
    }
    armY = min(armY, 1.4) * bAl;
    float dB = x / 3.2;
    float armBroad = exp(-0.5 * dB * dB);
    // OB associations: clumpy star clouds strung along the arm (hierarchical: clouds of clumps)
    float clump = smoothstep(-0.3, 0.55, rv_fbm(vec3(al * 70.0, ac * 110.0, kSeed + 5.0), 3) * 0.9 + n3 * 0.35);
    float patchA = smoothstep(-0.2, 0.6, n2 + 0.6 * n3);
    // outer arms fragment into strings of separate star clouds
    float outerFrag = mix(1.0, smoothstep(-0.1, 0.45, rv_fbm(vec3(al * 24.0, ac * 36.0, kSeed + 9.0), 3)), smoothstep(0.45, 0.9, rN));
    young = win * frag * frag * outerFrag * (armY * (0.25 + 1.1 * clump) + 0.6 * armBroad * (0.35 + 0.8 * patchA) * (0.6 + 0.4 * n1));
    armRidge = win * frag * armY;
    // the density wave compresses the old disk too (broad, smooth): the arms read white, not only blue
    old *= 1.0 + 0.75 * win * armBroad;

    // ---- dust: a BUNDLE of woven filaments on the concave (upstream) edge of the arm
    float xl = 1.25 + 0.35 * nAl2 + 0.3 * rv_fbm(vec3(al * 4.0, kSeed + 7.7, 17.0), 2);     // lane centre wanders
    float wl = 0.75 + 0.55 * smoothstep(-0.4, 0.5, nAl) + 0.25 * rN;                         // and breathes
    float dl = (x - xl) / wl;
    float bundle = exp(-0.5 * dl * dl);
    // parallel strands (≈ 7:1 anisotropic ridged noise in the arm frame) that braid and branch
    float wv = rv_fbm(vec3(al * 14.0, ac * 30.0, kSeed + 21.0), 2);
    float st1 = rv_ridged(vec3(al * 20.0 + 0.6 * wv, ac * 140.0 + 1.2 * wv, kSeed + 31.0), 4);
    float st2 = rv_ridged(vec3(al * 46.0 + 0.4 * wv, ac * 320.0 + 2.0 * wv, kSeed + 41.0), 3);
    float strand = smoothstep(0.32, 0.8, st1) * 0.9 + smoothstep(0.42, 0.85, st2) * 0.55;
    float laneWin = (gType == 1 ? smoothstep(0.85 * gR0, 1.05 * gR0, r) : smoothstep(gR0 * 0.04, gR0 * 0.4, r)) * (1.0 - smoothstep(gArmEnd[a.k] * 0.8, gArmEnd[a.k] * 1.1, r)) * mix(1.0, gArmAmp[a.k], 0.6);
    // the lane breaks into segments and re-forms; thick and dark inside, thinner and wispier outside
    float seg = smoothstep(-0.35, 0.25, nAl2 + 0.5 * nAl + 0.2);
    float lane = bundle * (0.2 + 1.1 * strand) * (0.35 + 0.65 * seg) * laneWin * (1.25 - 0.6 * rN);
    // secondary thin lane further upstream (M51 has 2–3 parallel lanes per arm)
    float dl2 = (x - xl - wl * (2.2 + 0.8 * nAl)) / (wl * 0.35);
    lane += 0.45 * exp(-0.5 * dl2 * dl2) * smoothstep(0.4, 0.8, st1) * laneWin * smoothstep(-0.1, 0.4, nAl2);
    // feathers / spurs: steeper-pitched dust filaments leaving the lane downstream, crossing the arm
    float pitchS = atan(gTanP) + 0.75;
    float psiS = thF - lrF / tan(pitchS) - gPhi0 + n1 * 0.6;
    float spF = rv_ridged(vec3(cos(psiS) * 34.0, sin(psiS) * 34.0, lrF * 3.0 + 51.0 + uSeedF), 3);
    float spGate = smoothstep(0.05, 0.55, rv_fbm(vec3(cos(psiS) * 5.0, sin(psiS) * 5.0, lrF * 1.5 + 57.0 + uSeedF), 2) + 0.15);
    float spurEnv = smoothstep(-3.6, -1.2, x) * (1.0 - smoothstep(xl, xl + 0.8, x)) * win;
    float feath = smoothstep(0.55, 0.88, spF) * spGate * spurEnv;
    young *= 1.0 - 0.35 * feath;                          // the spurs cut the arm into segments
    // patchy dust inside the young arm
    float inArm = armY * win * smoothstep(0.4, 0.85, st2 * 0.8 + n3 * 0.4);
    // inner-disk "fingerprint": many fine, tightly wound dust filaments (sheared by differential rotation)
    float psiF = thF - lrF / (gTanP * 0.8) + 0.6 * n1 + 0.25 * n2;
    float fp = rv_ridged(vec3(cos(psiF) * 45.0, sin(psiF) * 45.0, lrF * 7.0 + 61.0 + uSeedF), 4);
    float fpEnv = (gType == 1 ? smoothstep(0.9 * gR0, 1.2 * gR0, r) : smoothstep(gR0 * 0.05, gR0 * 0.45, r)) * (1.0 - smoothstep(0.22 * R, 0.55 * R, r));
    float fpDust = smoothstep(0.45, 0.85, fp) * fpEnv * smoothstep(-0.2, 0.5, n2 + 0.5 * n3 + 0.15);
    // moderate optical depth (τ_B ≈ 1.5 in the lane body, 4–6 in its strands): brown, filamentary lanes
    // where reddened starlight leaks through, not opaque black ribbons
    dust += lane * 1.0 + feath * 0.6 * uSpur + inArm * 0.3 + fpDust * 0.55;
    // feathers of young stars between the spurs (blue spur fragments downstream of the arm)
    float spY = smoothstep(0.5, 0.9, rv_ridged(vec3(cos(psiS) * 20.0, sin(psiS) * 20.0, lrF * 2.0 + 71.0 + uSeedF), 3));
    young += uSpur * 0.35 * spY * smoothstep(-4.0, -1.5, x) * (1.0 - smoothstep(-1.2, 0.0, x)) * win * smoothstep(-0.1, 0.5, n2 + 0.3 * n3);
    // flocculent interarm patches (isotropic, not stripes)
    float fl = smoothstep(0.25, 0.75, n3 + 0.4 * n2) * smoothstep(gR0 * 0.8, gR0 * 1.6, r) * (1.0 - smoothstep(0.75 * R, 1.05 * R, r));
    young += (0.08 + uFloc * 0.25) * fl * exp(-r / uRdY) * 2.2 * (1.0 - min(armY, 1.0));
    // HII complexes strung along the young edge of the lane, ringed by their blue clusters
    float xs = (x - (xl - wl * 1.1)) / 0.55;
    float strip = exp(-0.5 * xs * xs) * win * frag;
    float cplx = smoothstep(-0.05, 0.45, rv_fbm(vec3(al * 16.0, kSeed + 71.0, 3.0), 3) + 0.1);
    vec3 qk = vec3(al * 90.0, ac * 90.0, kSeed + 81.0);
    vec3 qk2 = vec3(al * 42.0, ac * 42.0, kSeed + 91.0);
    float kn = knots(qk, 0.5, 0.22), kn2 = knots(qk2, 0.7, 0.2);
    hiiStr = strip * cplx * cplx * (kn * 1.4 * cplx + kn2 * 2.6);
    young += strip * (0.3 + cplx) * (knots(qk, 0.55, 0.42) * 0.3 + knots(qk2, 0.68, 0.5) * 0.45);
    // diffuse HII glow along the young ridge
    hii += 0.02 * young * smoothstep(0.1, 0.6, n3 + 0.3);
  }
  float gap = 0.0;
  if (gType == 2) {
    float ro = length(p - gRingOff);
    float th = atan(p.y - gRingOff.y, p.x - gRingOff.x + 1e-9);
    float rn = rv_fbm(vec3(cos(th) * 4.0, sin(th) * 4.0, ro / R * 8.0) + so, 5);
    float rn2 = rv_fbm(vec3(cos(th) * 11.0, sin(th) * 11.0, ro / R * 20.0) + so + 5.0, 4);
    float dout = (ro - gRingOut) / gRingW;
    float outer = exp(-0.5 * dout * dout);
    float di = (r - gRingIn) / (R * 0.035);
    float inner = gRingStyle == 2 ? 0.0 : exp(-0.5 * di * di);
    float ringY = inner * (gRingStyle == 1 ? 0.6 : 1.0) + (gRingStyle == 0 ? 0.7 : 1.0) * outer;
    young = max(young, ringY * (0.15 + 1.4 * smoothstep(-0.3, 0.5, rn + n2 * 0.5)) * (0.7 + 0.6 * smoothstep(0.3, 0.7, rn2)));
    armRidge = max(armRidge, ringY);
    if (gRingStyle == 0) {
      float dri = (r - gRingIn * 0.965) / (R * 0.012);
      dust += 1.1 * exp(-0.5 * dri * dri) * smoothstep(-0.3, 0.5, rn + rid * 0.4);
    } else {
      // compressed dust on the inner (shocked) edge of the expanding ring + patchy dust inside it
      float dro = (ro - gRingOut + gRingW * 1.05) / (gRingW * 0.4);
      dust += 1.3 * exp(-0.5 * dro * dro) * smoothstep(-0.35, 0.45, rn2 + rid * 0.5);
      dust += 0.6 * outer * smoothstep(0.35, 0.8, ridF + 0.3 * n3);
      if (gRingStyle == 1) {
        float dri = (r - gRingIn * 1.15) / (R * 0.012);
        dust += 0.9 * exp(-0.5 * dri * dri) * smoothstep(-0.3, 0.5, rn + rid * 0.4);
      }
      gap = smoothstep(max(gRingIn * 1.25, R * 0.08), max(gRingIn * 1.8, R * 0.2), r) * (1.0 - smoothstep(gRingOut - 2.6 * gRingW, gRingOut - 1.2 * gRingW, ro));
      // stars and gas beyond the ring are sparse too (the ring is the density wave's crest)
      gap = max(gap, 0.6 * smoothstep(gRingOut + 1.5 * gRingW, gRingOut + 4.0 * gRingW, ro));
      old *= 1.0 + 1.2 * outer;
    }
    old *= 1.0 + 0.35 * ringY;
  }
  if (gType == 1) {
    // bar dust lanes on the leading edges (bar major axis at angle phi0), curving into the arms
    float ca = cos(-gPhi0), sa = sin(-gPhi0);
    vec2 b = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
    float ax = abs(b.x) / uBar.x;
    // two lanes offset to opposite (leading) sides, converging on the nuclear ring, fading at the bar ends
    float off = -sign(b.x) * uBar.y * (0.38 + 0.4 * ax * ax);
    float dl = (b.y - off + uBar.y * 0.18 * n2) / (uBar.x * 0.026 * (0.7 + 0.9 * ax));
    float barStr = rv_ridged(vec3(b.x / uBar.x * 9.0, (b.y - off) / uBar.x * 70.0, 19.0 + uSeedF), 3);
    float barLane = exp(-0.5 * dl * dl) * smoothstep(0.07, 0.2, ax) * (1.0 - smoothstep(0.8, 1.08, ax));
    dust += 1.4 * barLane * (0.35 + 0.9 * smoothstep(0.3, 0.8, barStr));
    // star-formation desert swept by the bar: the disk inside the bar radius is dimmer
    float me = (b.x * b.x) / (uBar.x * uBar.x) + (b.y * b.y) / (uBar.y * uBar.y * 2.5);
    old *= 1.0 - 0.8 * (1.0 - smoothstep(0.85, 1.2, r / uBar.x)) * smoothstep(0.5, 1.3, me);
    young *= 1.0 - 0.9 * (1.0 - smoothstep(0.85, 1.2, r / uBar.x)) * smoothstep(0.5, 1.3, me);
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
  if (gType != 4 && gType != 3) young += (gType <= 2 ? 0.05 : 0.1) * exp(-r / uRdY) * cut * smoothstep(gR0 * 0.3, gR0 * 1.2, r) * (0.7 + 0.5 * n1);
  // diffuse dust across star-forming disks (spirals: a smooth thin veil, the structure is in the lanes)
  if (gType <= 2 && gM > 0.5) {
    dust += 0.06 * exp(-r / uRdY) * cut * smoothstep(gR0 * 0.2, gR0, r);
  } else if (gType != 4 && gType != 3) {
    float web = smoothstep(0.15, 0.65, n2 * 0.8 + n3 * 0.5 + n1 * 0.3) * exp(-r / (0.55 * R)) * smoothstep(gR0 * 0.25, gR0 * 1.1, r);
    dust += web * (gType <= 2 ? 0.12 : 0.35) + 0.1 * exp(-r / uRdY) * cut * smoothstep(gR0 * 0.2, gR0, r);
    vec2 wq = P * 40.0 + vec2(n2, n3) * 2.2;
    float fd = rv_ridged(vec3(wq, 13.3) + so, 4);
    float fd2 = rv_ridged(vec3(P * 85.0 + vec2(n3, n1) * 3.0, 17.9) + so, 3);
    float fd3 = rv_ridged(vec3(P * 170.0 + vec2(fd, n3) * 2.0, 23.1) + so, 2);
    float envD = exp(-r / (0.7 * R)) * smoothstep(gR0 * 0.05, gR0 * 0.5, r) * cut;
    dust += (1.1 * smoothstep(0.5, 0.88, fd) + 0.6 * smoothstep(0.58, 0.9, fd2) + 0.35 * smoothstep(0.62, 0.92, fd3)) * envD * smoothstep(0.3, 0.75, n1 * 0.6 + n2 * 0.6 + 0.5);
  }
  if (gap > 0.0) { old *= 1.0 - 0.85 * gap; young *= 1.0 - 0.55 * gap; dust *= 1.0 - 0.6 * gap; }
  // Sombrero-like dust ring: a crisp, optically thick lane with fibrous edges, a bright rim of
  // starlight just outside it and a bright smooth inner lens
  if (uDustRing.z > 0.0) {
    float dr = (r - uDustRing.x) / uDustRing.y;
    float th = atan(p.y, p.x + 1e-9);
    float rn = rv_fbm(vec3(cos(th) * 6.0, sin(th) * 6.0, r / R * 10.0) + so + 3.0, 5);
    float rf = rv_ridged(vec3(cos(th) * 30.0, sin(th) * 30.0, r / R * 60.0) + so + 7.0, 4);
    float core = exp(-0.5 * pow(abs(dr) / 0.75, 3.0));                 // flat-topped lane, sharp edges
    // granular lane: dense clumps and thinner gaps (reddened light leaks through → brown, not black)
    float gr = rv_fbm(vec3(cos(th) * 55.0, sin(th) * 55.0, r / R * 140.0) + so + 11.0, 3);
    dust += 2.0 * uDustRing.z * core * (0.5 + 0.6 * smoothstep(-0.4, 0.5, rn)) * (0.45 + 0.75 * rf) * (0.4 + 1.2 * smoothstep(-0.25, 0.45, gr));
    float dr2 = (r - uDustRing.x * 0.86) / (uDustRing.y * 0.3);
    dust += 0.9 * uDustRing.z * exp(-0.5 * dr2 * dr2) * smoothstep(0.0, 0.6, rn);
    // fibrous wisps just inside / outside the lane
    dust += 0.7 * uDustRing.z * exp(-0.5 * dr * dr / 4.0) * smoothstep(0.55, 0.9, rf);
    float rim = exp(-0.5 * pow((r - uDustRing.x - 1.3 * uDustRing.y) / (uDustRing.y * 0.7), 2.0));
    // bright flat lens inside the ring (Sombrero's white inner disk), almost nothing beyond the ring
    float lens = 1.0 - smoothstep(uDustRing.x * 0.7, uDustRing.x * 1.02, r);
    old = old * (0.85 + 0.6 * exp(-r / (0.3 * uDustRing.x))) + 0.16 * lens * (0.85 + 0.3 * n2);
    old *= 1.0 - 0.93 * smoothstep(uDustRing.x + 1.2 * uDustRing.y, uDustRing.x + 3.5 * uDustRing.y, r);
    old += 0.035 * rim;
    young += 0.06 * exp(-0.5 * dr * dr) * smoothstep(0.3, 0.8, rn + n3 * 0.4) + 0.02 * rim * knots(vec3(P * 90.0, 5.0 + uSeedF), 0.5, 0.3);
    hii += 0.05 * exp(-0.5 * dr * dr) * smoothstep(0.5, 0.9, rn + n3 * 0.4) * knots(vec3(P * 70.0, 3.0 + uSeedF), 0.6, 0.25);
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
    float cplx = smoothstep(0.05, 0.55, n2 + 0.5 * n3);            // star-formation complexes
    float kD = knots(vec3(P * 60.0, 9.0 + uSeedF), 0.55, 0.28);
    bool armed = gType <= 1 && gM > 0.5;
    if (armed) {
      // spirals: HII complexes are strung along the lanes (hiiStr); the shared sites stay as the giant ones
      hk *= 0.6;
      hk += hiiStr + ridgeK * 0.6 * kB * (0.35 + 0.9 * cplx);
      hk += smoothstep(0.02, 0.3, young) * (1.0 - ridgeK) * 0.35 * kD * smoothstep(0.35, 0.8, n3 + 0.3 * n2);
    } else {
      hk += ridgeK * (2.4 * kA + 3.0 * kB) * (0.35 + 0.9 * cplx);
      hk += smoothstep(0.02, 0.3, young) * (1.0 - ridgeK) * 1.2 * kD * smoothstep(0.25, 0.7, n3 + 0.3 * n2);  // interarm HII
    }
    yk += ridgeK * (0.15 * kC + 0.25 * kA) * (0.5 + cplx);
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
