// Galaxy volume raymarch (emission + wavelength-dependent dust absorption) in the pattern frame.
//  - disk components (old stars, young stars, HII, dust) come from the GPU disk map × analytic
//    sech² vertical profiles integrated EXACTLY per step (tanh antiderivative) → no banding from
//    the thin dust layer, few steps for face-on views;
//  - bulge (sum of Plummer spheres ≈ Sérsic), bar (Ferrers n=2) and halo are integrated
//    ANALYTICALLY per segment (closed forms) → noise-free cores, correctly cut by dust lanes;
//  - 3-D tileable noise adds filamentary structure to dust and gas at several scales.
// Output: rgb = in-scattered emission, a = mean transmittance (for compositing the background).

export const VOLUME_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
#include <rv_common>
uniform sampler2D tMap;
uniform sampler3D tNoise;
uniform float uMapR, uMapTexel;
uniform vec3 uCamPos;          // pattern frame, kly
uniform mat4 uInvProj;
uniform mat3 uRayMat;          // view → pattern-frame rotation
uniform float uR, uRmax, uYmax;
uniform float uHOld, uHYoung, uHDust, uFlare;
uniform vec3 uColOld, uColYoung, uColHII, uColBulge, uColBar, uColHalo, uExt;
uniform float uOldL, uYoungL, uHiiL, uDustL, uScreen;
uniform vec4 uBulgeA, uBulgeW;
uniform vec3 uBulgeS;
uniform float uBulgeL;
uniform vec2 uBulgeH;          // extended bulge envelope ρ ∝ (1 + r²/a²)^-2: a, total L
uniform vec4 uBar;             // a, b, c, L
uniform float uBarAng;
uniform vec2 uHalo;            // a, L
uniform float uDsMin, uDsMax, uDsNear;
uniform int uSteps;
uniform vec4 uNoiseF;          // f1, f2, f3, pixel angle
uniform float uDustNoise, uFrame;
uniform vec3 uElDust;          // elliptical dust lane: tilt, yaw, radius (0 = none)
varying vec2 vUv;

vec4 bulgeG(float t, float sqA, float h, vec4 c2){
  float s = sqA * (t + h);
  vec4 q = c2 + s * s;
  return s * (2.0 * s * s + 3.0 * c2) / (3.0 * c2 * c2 * q * sqrt(q));
}
float plumG(float t, float sqA, float h, float c2){
  float s = sqA * (t + h);
  float q = c2 + s * s;
  return s * (2.0 * s * s + 3.0 * c2) / (3.0 * c2 * c2 * q * sqrt(q));
}
// ρ ∝ (1 + r²/a²)^-2: projected Σ ∝ (1 + R²/a²)^-3/2 — finite light, much longer wings than Plummer
float hubG(float t, float sqA, float h, float c2){ float s = sqA * (t + h); float rc = sqrt(c2); return s / (2.0 * c2 * (c2 + s * s)) + atan(s / rc) / (2.0 * c2 * rc); }
float ferrF(float u, float E, float A){ float u2 = u * u; return u * (E * E - (2.0 / 3.0) * E * A * u2 + 0.2 * A * A * u2 * u2); }

float vint(float y0, float y1, float dt, float h){
  float dy = y1 - y0;
  if (abs(dy) < 1e-3 * h) { float c = cosh(clamp(0.5 * (y0 + y1) / h, -15.0, 15.0)); return dt / (c * c); }
  return h * dt / dy * (tanh(clamp(y1 / h, -15.0, 15.0)) - tanh(clamp(y0 / h, -15.0, 15.0)));
}

// Gaussian vertical profile exp(-y²/h²)/(√π h), integrated exactly along the segment (erf)
float gx_erf(float x){ float s = sign(x); x = abs(x); float t = 1.0 / (1.0 + 0.3275911 * x);
  return s * (1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x)); }
float gint(float y0, float y1, float dt, float h){
  float dy = y1 - y0;
  if (abs(dy) < 2e-3 * h) { float ym = 0.5 * (y0 + y1) / h; return dt * exp(-ym * ym) / (1.7724539 * h); }
  return dt / dy * 0.5 * (gx_erf(clamp(y1 / h, -6.0, 6.0)) - gx_erf(clamp(y0 / h, -6.0, 6.0)));
}

void main(){
  vec3 ro = uCamPos;
  vec4 vv = uInvProj * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
  vec3 rd = normalize(uRayMat * normalize(vv.xyz / vv.w));
  float jit = rv_hash12(gl_FragCoord.xy + vec2(mod(uFrame, 64.0) * 17.31, 5.1));

  // ---------------- analytic components (bulge, halo, bar)
  vec3 ob = ro / uBulgeS, db = rd / uBulgeS;
  float Ab = dot(db, db), hb = dot(ob, db) / Ab;
  vec3 wb = ob - db * hb;
  float Db = dot(wb, wb);
  float sqAb = sqrt(Ab);
  vec4 c2b = uBulgeA * uBulgeA + Db;
  vec4 Kb = uBulgeW * 3.0 * uBulgeA * uBulgeA / (4.0 * RV_PI * uBulgeS.x * uBulgeS.y * uBulgeS.z * sqAb) * uBulgeL;
  vec4 Gbinf = 2.0 / (3.0 * c2b * c2b);
  float c2H = uBulgeH.x * uBulgeH.x + Db;
  float KH = uBulgeH.y * uBulgeH.x / 9.8696044 / (uBulgeS.x * uBulgeS.y * uBulgeS.z * sqAb);
  float GHinf = 3.14159265 / (4.0 * c2H * sqrt(c2H));
  float hh = dot(ro, rd);
  vec3 wh = ro - rd * hh;
  float c2h = uHalo.x * uHalo.x + dot(wh, wh);
  float Kh = 3.0 * uHalo.x * uHalo.x / (4.0 * RV_PI) * uHalo.y;
  float Ghinf = 2.0 / (3.0 * c2h * c2h);
  // bar in its own frame (major axis at uBarAng), scaled by (a, c, b)
  float Kbar = 0.0, Abar = 1.0, hbar = 0.0, Ebar = -1.0;
  if (uBar.w > 0.0) {
    float ca = cos(-uBarAng), sa = sin(-uBarAng);
    vec3 o2 = vec3(ro.x * ca - ro.z * sa, ro.y, ro.x * sa + ro.z * ca) / uBar.xzy;
    vec3 d2 = vec3(rd.x * ca - rd.z * sa, rd.y, rd.x * sa + rd.z * ca) / uBar.xzy;
    Abar = dot(d2, d2); hbar = dot(o2, d2) / Abar;
    vec3 w2 = o2 - d2 * hbar;
    Ebar = 1.0 - dot(w2, w2);
    Kbar = uBar.w * 105.0 / (32.0 * RV_PI * uBar.x * uBar.y * uBar.z);
  }
  float umBar = Ebar > 0.0 ? sqrt(Ebar / Abar) : 0.0;

  // running antiderivatives
  vec4 Gb0 = bulgeG(0.0, sqAb, hb, c2b);
  float GH0 = hubG(0.0, sqAb, hb, c2H);
  float Gh0 = plumG(0.0, 1.0, hh, c2h);
  float Fb0 = Ebar > 0.0 ? ferrF(clamp(hbar, -umBar, umBar), Ebar, Abar) : 0.0;

  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);

  // ---------------- disk slab ∩ cylinder bounds
  float t0 = 0.0, t1 = 1e7;
  bool hit = true;
  if (abs(rd.y) > 1e-7) {
    float ta = (-uYmax - ro.y) / rd.y, tb = (uYmax - ro.y) / rd.y;
    t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb));
  } else if (abs(ro.y) > uYmax) hit = false;
  vec2 o2 = ro.xz, d2 = rd.xz;
  float qa = dot(d2, d2), qb = dot(o2, d2), qc = dot(o2, o2) - uRmax * uRmax;
  float disc = qb * qb - qa * qc;
  if (disc < 0.0 || qa < 1e-12) { if (qc > 0.0) hit = false; }
  else { float sq = sqrt(disc); t0 = max(t0, (-qb - sq) / qa); t1 = min(t1, (-qb + sq) / qa); }
  if (t1 <= t0) hit = false;

  if (!hit) {
    vec3 E = uColBulge * (dot(Kb, Gbinf - Gb0) + KH * (GHinf - GH0)) + uColHalo * Kh * (Ghinf - Gh0);
    if (Ebar > 0.0) E += uColBar * Kbar * (ferrF(umBar, Ebar, Abar) - Fb0);
    gl_FragColor = vec4(E, 1.0);
    return;
  }

  // front (unattenuated) analytic part [0, t0]
  {
    vec4 G1 = bulgeG(t0, sqAb, hb, c2b);
    float G1h = plumG(t0, 1.0, hh, c2h);
    float F1 = Ebar > 0.0 ? ferrF(clamp(t0 + hbar, -umBar, umBar), Ebar, Abar) : 0.0;
    float GH1 = hubG(t0, sqAb, hb, c2H);
    L += uColBulge * (dot(Kb, G1 - Gb0) + KH * (GH1 - GH0)) + uColHalo * Kh * (G1h - Gh0) + uColBar * Kbar * (F1 - Fb0);
    Gb0 = G1; Gh0 = G1h; Fb0 = F1; GH0 = GH1;
  }

  // ---------------- march
  float hD0 = uHDust;
  float t = t0;
  float f1 = uNoiseF.x, f2 = uNoiseF.y, f3 = uNoiseF.z, pixA = uNoiseF.w;
  for (int i = 0; i < 200; i++) {
    if (i >= uSteps || t >= t1) break;
    float yc = abs(ro.y + rd.y * t);
    float dsV = 0.42 * (yc + 1.5 * hD0) / max(abs(rd.y), 1e-4);
    float ds = min(dsV, min(uDsMax, uDsNear + 0.07 * t));
    ds = max(ds, uDsMin);
    if (i == 0) ds *= 0.35 + 0.65 * jit;
    if (i == uSteps - 1) ds = t1 - t;           // swallow the remainder in the last step
    float tb = min(t + ds, t1);
    float dt = tb - t;
    vec3 pa = ro + rd * t, pb = ro + rd * tb;
    // sample the maps where the thin layers weigh most: the point of the segment closest to the midplane
    float tcr = abs(rd.y) > 1e-7 ? clamp(-ro.y / rd.y, t, tb) : 0.5 * (t + tb);
    vec3 pm = ro + rd * tcr;
    vec2 uv = pm.xz / (2.0 * uMapR) + 0.5;
    // mip level from the pixel footprint on the disk (stretched along grazing rays)
    float footM = pixA * max(tcr, 1e-4) / max(abs(rd.y), 0.2);
    float lodM = max(0.0, log2(footM / uMapTexel) - 0.5);
    vec4 M = (abs(uv.x - 0.5) < 0.5 && abs(uv.y - 0.5) < 0.5) ? textureLod(tMap, uv, lodM) : vec4(0.0);
    // magnified far beyond the map's resolution (camera inside the disk) bilinear texels would show
    // as a checkerboard: blend toward a smoother (coarser) level there
    float magK = smoothstep(0.04, 0.35, footM / uMapTexel);
    if (magK < 1.0 && M.b + M.r > 0.0) M = mix(textureLod(tMap, uv, 2.5), M, 0.25 + 0.75 * magK);
    float rm = length(pm.xz);
    float fl = 1.0 + uFlare * (rm / uR) * (rm / uR);
    float flT = 1.0 + 0.35 * (fl - 1.0);               // young stars and dust stay thin (little flare)
    float hO = uHOld * fl, hY = uHYoung * flT, hD = uHDust * flT;
    float IO = vint(pa.y, pb.y, dt, hO) / (2.0 * hO);
    float IY = gint(pa.y, pb.y, dt, hY);
    float ID = gint(pa.y, pb.y, dt, hD);
    // multi-scale 3-D detail, faded by pixel footprint to avoid aliasing
    float foot = pixA * max(t, 1e-4);
    vec4 N1 = texture(tNoise, pm * f1);
    float w2 = 1.0 - smoothstep(0.08, 0.3, foot * f2);
    float w3 = 1.0 - smoothstep(0.08, 0.3, foot * f3);
    vec4 N2 = w2 > 0.0 ? texture(tNoise, pm * f2 + 0.37) : vec4(0.5);
    vec4 N3 = w3 > 0.0 ? texture(tNoise, pm * f3 + 0.71) : vec4(0.5);
    float dn = N1.r * 1.3 - 0.15;
    dn *= mix(1.0, 0.35 + 1.4 * N2.g, w2);
    dn *= mix(1.0, 0.45 + 1.1 * N3.r, w3);
    float dm = mix(1.0, clamp(dn, 0.0, 3.0), uDustNoise);
    float gm = mix(1.0, clamp(0.55 + 0.9 * N1.a + 0.5 * w2 * (N2.b - 0.5), 0.2, 2.0), uDustNoise);
    // magnified far beyond its resolution (inside the disk) the map's HII / cluster knots would show
    // as blocky texels: they fade out there (the individual nebulae and LOD stars take over)
    vec3 E = uColOld * (M.r * uOldL * IO) + (uColYoung * (M.g * uYoungL * mix(0.35, 1.0, magK)) + uColHII * (M.a * uHiiL * magK)) * (IY * gm);
    // clumpy dust mixed with the stars: local obscuration of this sample's own light
    float yl = pm.y / (1.6 * hD);
    E *= exp(-uExt * (M.b * uScreen * dm * exp(-yl * yl)));
    // analytic components over the segment
    vec4 G1 = bulgeG(tb, sqAb, hb, c2b);
    float G1h = plumG(tb, 1.0, hh, c2h);
    float GH1 = hubG(tb, sqAb, hb, c2H);
    E += uColBulge * (dot(Kb, G1 - Gb0) + KH * (GH1 - GH0)) + uColHalo * Kh * (G1h - Gh0);
    Gb0 = G1; Gh0 = G1h; GH0 = GH1;
    if (Ebar > 0.0) { float F1 = ferrF(clamp(tb + hbar, -umBar, umBar), Ebar, Abar); E += uColBar * Kbar * (F1 - Fb0); Fb0 = F1; }
    vec3 tau = uExt * (M.b * uDustL * ID * dm);
    vec3 att = exp(-tau);
    vec3 fr = vec3(tau.x > 1e-4 ? (1.0 - att.x) / tau.x : 1.0 - 0.5 * tau.x,
                   tau.y > 1e-4 ? (1.0 - att.y) / tau.y : 1.0 - 0.5 * tau.y,
                   tau.z > 1e-4 ? (1.0 - att.z) / tau.z : 1.0 - 0.5 * tau.z);
    L += T * E * fr;
    T *= att;
    t = tb;
    if (max(T.r, max(T.g, T.b)) < 0.003) { T = vec3(0.0); break; }
  }
  // back analytic part
  if (max(T.r, max(T.g, T.b)) > 0.0) {
    vec3 E = uColBulge * (dot(Kb, Gbinf - Gb0) + KH * (GHinf - GH0)) + uColHalo * Kh * (Ghinf - Gh0);
    if (Ebar > 0.0) E += uColBar * Kbar * (ferrF(umBar, Ebar, Abar) - Fb0);
    L += T * E;
  }
  gl_FragColor = vec4(L, dot(T, vec3(0.3333)));
}
`;

// Upsample (Catmull-Rom, 9 bilinear taps) + full-resolution detail transfer + composite:
//   out = emission + dst * transmittance
// Detail transfer: the raymarch runs at reduced resolution and samples the disk map at its own
// (coarse) footprint. Per full-res pixel we re-sample the map where the ray crosses the midplane at
// the fine and at the coarse level, and apply the difference: dust transmission ratio (half of the
// disk light lies behind the dust layer) and young/HII/old emission residual. Fine dust filaments and
// star-forming knots thus survive the upsample; nothing changes where the map has no sub-pixel detail.
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tVol;
uniform vec2 uVolSize;
uniform float uGain;
uniform sampler2D tMap;
uniform float uMapR, uMapTexel, uOldL, uYoungL, uHiiL, uDustL, uDetail, uPixF, uLodC;
uniform vec3 uCamPos, uColOld, uColYoung, uColHII, uExt;
uniform mat4 uInvProj;
uniform mat3 uRayMat;
varying vec2 vUv;
vec4 bicubic(sampler2D tex, vec2 uv, vec2 size){
  vec2 samplePos = uv * size;
  vec2 tc1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - tc1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 off12 = w2 / w12;
  vec2 tc0 = (tc1 - 1.0) / size, tc3 = (tc1 + 2.0) / size, tc12 = (tc1 + off12) / size;
  vec4 r = vec4(0.0);
  r += texture2D(tex, vec2(tc0.x, tc0.y)) * w0.x * w0.y;
  r += texture2D(tex, vec2(tc12.x, tc0.y)) * w12.x * w0.y;
  r += texture2D(tex, vec2(tc3.x, tc0.y)) * w3.x * w0.y;
  r += texture2D(tex, vec2(tc0.x, tc12.y)) * w0.x * w12.y;
  r += texture2D(tex, vec2(tc12.x, tc12.y)) * w12.x * w12.y;
  r += texture2D(tex, vec2(tc3.x, tc12.y)) * w3.x * w12.y;
  r += texture2D(tex, vec2(tc0.x, tc3.y)) * w0.x * w3.y;
  r += texture2D(tex, vec2(tc12.x, tc3.y)) * w12.x * w3.y;
  r += texture2D(tex, vec2(tc3.x, tc3.y)) * w3.x * w3.y;
  return r;
}
vec3 halfBehind(vec3 tau){ return 0.45 + 0.55 * exp(-tau); }
void main(){
  vec4 v = bicubic(tVol, vUv, uVolSize);
  vec4 b = texture2D(tVol, vUv);
  // guard against ringing around very bright cores: never go below the bilinear minimum
  v.rgb = max(v.rgb, b.rgb * 0.5);
  vec3 col = max(v.rgb, 0.0);
  if (uDetail > 0.0) {
    vec4 vv = uInvProj * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
    vec3 rd = normalize(uRayMat * normalize(vv.xyz / vv.w));
    float ay = abs(rd.y);
    float t = ay > 1e-5 ? -uCamPos.y / rd.y : -1.0;
    if (t > 0.0 && ay > 0.04) {
      vec3 pm = uCamPos + rd * t;
      vec2 uv = pm.xz / (2.0 * uMapR) + 0.5;
      if (abs(uv.x - 0.5) < 0.5 && abs(uv.y - 0.5) < 0.5) {
        float foot = uPixF * t / max(ay, 0.2);
        float lf = max(0.0, log2(foot / uMapTexel) - 0.5);
        vec4 Mf = textureLod(tMap, uv, lf), Mc = textureLod(tMap, uv, lf + uLodC);
        float fade = smoothstep(0.04, 0.25, ay) * uDetail;
        float ia = 1.0 / max(ay, 0.25);
        vec3 tf = halfBehind(uExt * (Mf.b * uDustL * ia)), tc = halfBehind(uExt * (Mc.b * uDustL * ia));
        float mk = smoothstep(0.04, 0.35, foot / uMapTexel);       // (see the raymarch: no magnified knots)
        vec3 ef = (uColOld * (Mf.r * uOldL) + uColYoung * (Mf.g * uYoungL) + uColHII * (Mf.a * uHiiL * mk)) * ia;
        vec3 ec = (uColOld * (Mc.r * uOldL) + uColYoung * (Mc.g * uYoungL) + uColHII * (Mc.a * uHiiL * mk)) * ia;
        vec3 dcol = col * (tf / max(tc, vec3(1e-3))) + (ef * tf - ec * tc);
        col = mix(col, max(dcol, col * 0.15), fade);
      }
    }
  }
  gl_FragColor = vec4(col * uGain, clamp(v.a, 0.0, 1.0));
}
`;

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
