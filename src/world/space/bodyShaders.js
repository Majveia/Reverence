// GLSL for planets, moons, gas giants, atmospheres (limb shells) and rings. OWNED BY THE SPACE TRACK.

export const BODY_VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;
void main(){
  vObj = position;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// shared uniforms/helpers for the lit surfaces
const COMMON = /* glsl */ `
#include <rv_space>
uniform vec3 uSunDir;
uniform vec3 uSunIll;
uniform float uSunAng;
uniform vec3 uCenter;        // scene-space centre
uniform float uRadius;
uniform vec4 uOcc[4];        // eclipse occluders: scene centre, radius
uniform int uOccN;
uniform vec4 uRingP;         // inner, outer (m), has ring, opacity scale
uniform vec3 uRingN;
uniform sampler2D uRingTex;
uniform float uTime;
uniform float uDetail;       // 0..1 detail fade (screen size)
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;
float sunVisibility(vec3 w){
  float v = 1.0;
  for (int i = 0; i < 4; i++){
    if (i >= uOccN) break;
    v *= sp_occlude(w, uSunDir, uSunAng, uOcc[i].xyz, uOcc[i].w);
  }
  if (uRingP.z > 0.5){
    float dn = dot(uSunDir, uRingN);
    if (abs(dn) > 1e-4){
      float t = dot(uCenter - w, uRingN) / dn;
      if (t > 0.0){
        vec3 hp = w + uSunDir * t - uCenter;
        float rr = length(hp);
        float tt = (rr - uRingP.x) / (uRingP.y - uRingP.x);
        if (tt > 0.0 && tt < 1.0){
          float op = textureLod(uRingTex, vec2(tt, 0.5), 2.0).a * uRingP.w;
          float tau = -log(max(1.0 - op, 0.02));
          v *= exp(-tau / max(abs(dn), 0.05));
        }
      }
    }
  }
  return v;
}
`;

export const ROCKY_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uSeedOff;
uniform float uFreq;
uniform float uSeaT, uOcean, uLiquid;
uniform vec3 uDeep, uShallow, uSand, uGrass, uGrass2, uRock, uSnow, uVeg, uAccent;
uniform float uVegAmt, uIce, uCraters, uLava, uCrystal, uDesert;
uniform float uCloudCov, uCloudStreak, uCloudSoft, uStorm;
uniform vec3 uCloudCol;
uniform vec4 uCyclone[4];
uniform float uCity;
uniform vec3 uCityCol, uCityCol2;
uniform float uAtmo;
uniform vec3 uAtmoCol;
vec3 rotY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
float craterField(vec3 p, float f){
  vec2 w = rv_worley(p * f);
  float r = w.x * 1.35;
  float bowl = smoothstep(0.55, 0.0, r);
  float rim = exp(-pow((r - 0.55) * 7.0, 2.0));
  return rim * 0.6 - bowl * 0.45;
}
void main(){
  vec3 p = normalize(vObj);
  int OCT = uDetail > 0.6 ? 7 : uDetail > 0.25 ? 6 : 5;
  vec3 q = p * uFreq + uSeedOff;
  vec3 wq = vec3(rv_fbm(q * 0.8, 3), rv_fbm(q * 0.8 + 4.7, 3), rv_fbm(q * 0.8 + 9.3, 3));
  float h = rv_fbm(q + wq * 0.6, OCT);
  float ranges = smoothstep(0.45, 0.75, rv_fbm(q * 0.6 + 21.0, 3) * 0.5 + 0.5);   // mountain chains, not everywhere
  float mount = rv_ridged(q * 2.4 + wq * 1.1, OCT - 1) * (0.25 + 0.75 * ranges);
  float e = h - uSeaT;
  float moist = rv_fbm(q * 1.4 + 11.0 + wq, 4) * 0.5 + 0.5;
  float fine = rv_fbm(q * 9.0 + wq * 2.0, 4);
  float lat = abs(p.y);
  float temp = 1.0 - lat * 1.1 - max(e, 0.0) * 1.1 + (moist - 0.5) * 0.25;
  // ---- land
  vec3 land = mix(uSand, uGrass, smoothstep(0.38, 0.62, moist) * (1.0 - uDesert));
  land = mix(land, uGrass2, smoothstep(-0.2, 0.4, fine) * 0.45);
  land = mix(land, uVeg, uVegAmt * smoothstep(0.52, 0.78, moist) * smoothstep(0.15, 0.55, temp) * (1.0 - uDesert));
  float rockAmt = smoothstep(0.42, 0.8, mount * (0.55 + max(e, 0.0) * 4.0)) + uDesert * 0.25 * smoothstep(0.1, 0.5, fine);
  land = mix(land, uRock, clamp(rockAmt, 0.0, 1.0));
  // desert dune streaks
  if (uDesert > 0.5){ float dn = sin(dot(p, vec3(40.0, 13.0, 29.0)) + fine * 8.0) * 0.5 + 0.5; land *= 0.9 + 0.12 * dn; }
  // craters (airless / barren)
  float cr = 0.0;
  if (uCraters > 0.0){
    cr = craterField(p + uSeedOff * 0.01, 5.0) + craterField(p * 1.7 + uSeedOff * 0.02, 13.0) * 0.6 + craterField(p * 2.3, 31.0) * 0.35 * uDetail;
    land *= 1.0 + cr * 0.55 * uCraters;
    land = mix(land, land * vec3(0.78, 0.8, 0.85), smoothstep(0.2, -0.3, h) * uCraters * 0.8);   // maria
  }
  float snow = smoothstep(0.0, 0.06, (lat - uIce) + max(e, 0.0) * 0.9 * step(uIce, 1.0) + fine * 0.05);
  land = mix(land, uSnow, clamp(snow, 0.0, 1.0));
  // crystal worlds: iridescent facets
  if (uCrystal > 0.5){ vec2 wc = rv_worley(p * 22.0); land = mix(land, uAccent, smoothstep(0.1, 0.0, wc.y - wc.x) * 0.6); }
  // ---- ocean
  float isLand = uOcean > 0.5 ? smoothstep(-0.003, 0.003, e) : 1.0;
  vec3 sea = mix(uDeep, uShallow, smoothstep(-0.1, 0.0, e) * 0.85);
  float seaIce = uOcean > 0.5 ? smoothstep(-0.02, 0.04, lat - uIce - 0.04 + fine * 0.05) : 0.0;
  sea = mix(sea, uSnow * 0.92, seaIce);
  vec3 albedo = mix(sea, land, isLand);
  // ---- lighting
  vec3 N = normalize(vN);
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vW);
  // bump: tilt the normal with the mountain field gradient (cheap: one offset sample)
  if (uDetail > 0.3){
    vec3 T = normalize(cross(N, vec3(0.0, 1.0, 0.0) + N.zxy * 0.01));
    vec3 B = cross(N, T);
    float bumpAmt = isLand * (0.25 + uCraters * 0.5);
    float m2 = rv_ridged((p + T * 0.004) * uFreq * 2.7 + uSeedOff * 2.7 + wq * 1.3, 4);
    float m3 = rv_ridged((p + B * 0.004) * uFreq * 2.7 + uSeedOff * 2.7 + wq * 1.3, 4);
    float m1 = rv_ridged(p * uFreq * 2.7 + uSeedOff * 2.7 + wq * 1.3, 4);
    N = normalize(N - (T * (m2 - m1) + B * (m3 - m1)) * bumpAmt * 4.5 * (0.3 + 0.7 * ranges));
  }
  float NL = dot(N, L);
  float NLs = dot(normalize(vN), L);
  float vis = sunVisibility(vW);
  float wrap = uAtmo > 0.05 ? 0.14 : 0.03;
  float diff = max((NL + wrap) / (1.0 + wrap), 0.0) * smoothstep(-0.12, 0.05, NLs);
  vec3 sunLit = uSunIll * vis;
  // cloud layer (drifts over the surface)
  float cloud = 0.0, cloudShadow = 0.0;
  if (uCloudCov > 0.01){
    vec3 cp = rotY(p, uTime * 0.0035);
    // cyclones: swirl the cloud field around a few storm centres
    for (int k = 0; k < 4; k++){
      vec4 cy = uCyclone[k];
      vec3 c = vec3(cos(cy.x) * sin(cy.y), sin(cy.x), cos(cy.x) * cos(cy.y));
      float dd = length(cp - c);
      if (dd < cy.z){
        float a = cy.w * pow(1.0 - dd / cy.z, 2.0);
        float ca = cos(a), sa = sin(a);
        vec3 v = cp - c * dot(cp, c);
        vec3 bx = normalize(cross(c, vec3(0.0, 1.0, 0.0)) + 1e-5);
        vec3 by = cross(c, bx);
        vec2 l = vec2(dot(v, bx), dot(v, by));
        l = mat2(ca, -sa, sa, ca) * l;
        cp = normalize(c * dot(cp, c) + bx * l.x + by * l.y);
      }
    }
    // general circulation: cloudy ITCZ & storm belts, clear subtropics / poles
    float sl = cp.y;
    float band = 0.55 + 0.3 * cos(sl * RV_PI * 3.0);
    vec3 cq = vec3(cp.x, cp.y * uCloudStreak * 1.5, cp.z) * 3.4 + uSeedOff * 1.3;
    vec3 cw = vec3(rv_fbm(cq * 0.5, 3), rv_fbm(cq * 0.5 + 3.3, 3), 0.0);
    float cn = rv_fbm(cq + cw * (1.2 + uStorm), OCT - 1) * 0.5 + 0.5;
    float cf = rv_fbm(cq * 4.2 + cw * 2.0, 3) * 0.5 + 0.5;
    cn = cn * 0.78 + cf * 0.22;
    float cov = clamp(uCloudCov * (0.55 + band * 0.75), 0.0, 0.95);
    float th = 0.5 + (0.5 - cov) * 0.38;             // coverage → threshold on the fbm distribution
    cloud = smoothstep(th - 0.025, th + (uCloudSoft > 0.5 ? 0.2 : 0.07), cn);
    cloudShadow = cloud * smoothstep(-0.1, 0.4, NLs) * 0.8;
  }
  vec3 col = albedo / RV_PI * sunLit * diff * (1.0 - cloudShadow * 0.45);
  // ocean glint (sun specular)
  if (uOcean > 0.5 && uLiquid < 0.5){
    vec3 H = normalize(L + V);
    float nh = max(dot(normalize(vN), H), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
    float spec = pow(nh, 220.0) * 18.0 + pow(nh, 32.0) * 0.25;
    col += sunLit * spec * fres * (1.0 - isLand) * (1.0 - seaIce) * max(NLs, 0.0) * (1.0 - cloud);
  }
  // clouds on top
  float cdiff = smoothstep(-0.1, 0.35, NLs);
  vec3 cloudC = uCloudCol * sunLit * cdiff / RV_PI * 0.95;
  // warm terminator light on clouds
  cloudC *= mix(vec3(1.0, 0.55, 0.35), vec3(1.0), smoothstep(0.0, 0.25, NLs));
  col = mix(col, cloudC, cloud * (uCloudSoft > 0.5 ? 0.45 : 0.95));
  // ---- emission: lava, city lights
  float night = smoothstep(0.08, -0.12, NLs);
  if (uLiquid > 0.5 && uLiquid < 1.5){
    float crust = smoothstep(0.2, 0.7, rv_fbm(p * 30.0 + uTime * 0.002, 4) * 0.5 + 0.5);
    vec3 lava = vec3(1.0, 0.28, 0.04) * (1.2 + 1.5 * (1.0 - crust));
    col = mix(col, col * 0.3 + lava * (0.25 + night * 0.75), (1.0 - isLand) * (1.0 - cloud * 0.6));
  }
  if (uLava > 0.0){
    float cr1 = pow(1.0 - abs(rv_snoise(p * 7.0 + uSeedOff)), 14.0);
    float cr2 = pow(1.0 - abs(rv_snoise(p * 19.0 + uSeedOff * 1.3)), 18.0) * 0.6;
    float lakes = smoothstep(-0.24, -0.34, h);
    float glow = ((cr1 + cr2) * (1.0 - smoothstep(0.1, 0.5, mount)) + lakes * 1.2) * 0.8;
    vec3 lavaC = mix(vec3(1.0, 0.18, 0.02), vec3(1.0, 0.55, 0.12), clamp(glow - 0.4, 0.0, 1.0));
    col *= 1.0 - 0.35 * uLava * smoothstep(0.0, 0.4, glow);            // dark basalt around the flows
    col += lavaC * glow * uLava * isLand * (0.12 + 1.6 * night) * (1.0 - cloud * 0.6) * (1.0 - snow);
  }
  if (uCity > 0.0){
    float c1 = rv_fbm(p * 18.0 + uSeedOff * 3.0, 3);
    float c2 = rv_vnoise(p * 420.0 + uSeedOff);
    float c3 = rv_vnoise(p * 150.0 - uSeedOff);
    float region = smoothstep(0.05, 0.4, c1) * isLand * (1.0 - snow) * smoothstep(0.0, 0.03, e) * smoothstep(0.35, 0.05, e);
    float lights = region * (smoothstep(0.62, 0.95, c2) * 0.8 + smoothstep(0.55, 0.9, c3) * 0.6 * mix(1.0, 0.4, uDetail) + smoothstep(0.35, 0.7, c1) * 0.3);
    vec3 cc = mix(uCityCol, uCityCol2, smoothstep(0.4, 0.8, c3));
    col += cc * lights * uCity * night * (1.0 - cloud * 0.75) * 0.9;
  }
  // limb darkening of the cloud/surface (thin haze) is added by the atmosphere shell
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

export const GAS_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uBands;
uniform vec4 uStorm[6];
uniform int uStormN;
uniform vec3 uStormCol;
uniform float uJets, uFlow, uTurb;
uniform vec3 uSeedOff;
uniform vec3 uHaze;
vec3 rotY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
vec3 stormDir(vec4 s, float t){
  float lon = s.y + t * uFlow * 0.4 * sin(s.x * uJets);
  return vec3(cos(s.x) * sin(lon), sin(s.x), cos(s.x) * cos(lon));
}
vec3 gasColor(vec3 p, float shift, float phaseSeed, out float stormMask){
  float lat = asin(clamp(p.y, -1.0, 1.0));
  float jet = sin(lat * uJets) * (1.0 - smoothstep(1.15, 1.5, abs(lat)));
  vec3 q = rotY(p, jet * shift);
  stormMask = 0.0;
  vec3 scol = vec3(0.0);
  for (int i = 0; i < 6; i++){
    if (i >= uStormN) break;
    vec4 s = uStorm[i];
    vec3 c = stormDir(s, uTime);
    vec3 v = q - c * dot(q, c);
    float dist = length(v) / s.z;
    // ellipse: storms are wider in longitude
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), c));
    float de = dot(q - c, east), dn = (q - c).y;
    float de2 = length(vec2(de / 1.6, dn)) / s.z;
    if (de2 < 2.2){
      float a = s.w * 0.45 * exp(-de2 * de2 * 1.6);
      float ca = cos(a), sa = sin(a);
      vec3 north = cross(c, east);
      vec2 l = vec2(dot(q - c, east), dot(q - c, north));
      l = mat2(ca, -sa, sa, ca) * l;
      q = normalize(c + east * l.x + north * l.y);
      float m = smoothstep(1.0, 0.45, de2) + exp(-pow((de2 - 0.95) * 5.0, 2.0)) * 0.35;
      stormMask = max(stormMask, m * (i == 0 ? 1.0 : 0.7));
    }
  }
  vec3 s3 = vec3(q.x * 2.2, q.y * 11.0, q.z * 2.2) + uSeedOff + phaseSeed;
  float n1 = rv_fbm(s3 * 0.9, 5);
  float n2 = rv_fbm(vec3(q.x * 7.0, q.y * 26.0, q.z * 7.0) + n1 * 1.8 + uSeedOff, uDetail > 0.4 ? 5 : 3);
  float n3 = uDetail > 0.3 ? rv_fbm(vec3(q.x * 22.0, q.y * 70.0, q.z * 22.0) + n2 * 2.5 + uSeedOff, 3) : 0.0;
  float y = q.y + (n1 * 0.045 + n2 * 0.016 + n3 * 0.005) * uTurb;
  vec3 col = texture2D(uBands, vec2(clamp(y * 0.5 + 0.5, 0.0, 1.0), 0.5)).rgb;
  col *= 0.88 + 0.2 * n2 + 0.1 * n3;
  // festoons / white ovals along belt edges
  float edge = abs(texture2D(uBands, vec2(clamp(y * 0.5 + 0.5 + 0.004, 0.0, 1.0), 0.5)).g - texture2D(uBands, vec2(clamp(y * 0.5 + 0.5 - 0.004, 0.0, 1.0), 0.5)).g);
  col = mix(col, col * 1.18 + 0.05, smoothstep(0.02, 0.08, edge) * smoothstep(0.2, 0.6, n2 * 0.5 + 0.5) * 0.5);
  return col;
}
void main(){
  vec3 p = normalize(vObj);
  float T = 90.0;
  vec2 ph = sp_flowPhases(uTime, T);
  float wa = 1.0 - abs(2.0 * ph.x - 1.0);
  float sm1, sm2;
  vec3 c1 = gasColor(p, uFlow * (ph.x - 0.5) * T, 0.0, sm1);
  vec3 c2 = gasColor(p, uFlow * (ph.y - 0.5) * T, 7.31, sm2);
  vec3 albedo = mix(c2, c1, wa);
  float sm = mix(sm2, sm1, wa);
  albedo = mix(albedo, uStormCol * (0.85 + 0.25 * albedo.r), sm * 0.55);
  vec3 N = normalize(vN);
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vW);
  float NL = dot(N, L);
  float NV = max(dot(N, V), 0.0);
  // Minnaert limb darkening
  float k = 0.82;
  float NLw = (NL + 0.08) / 1.08;
  float diff = pow(max(NLw, 0.0), k) * pow(max(NV, 0.02), k - 1.0) * smoothstep(-0.08, 0.2, NL);
  diff = min(diff, 1.6);
  float vis = sunVisibility(vW);
  vec3 col = albedo / RV_PI * uSunIll * vis * diff;
  // reddened terminator (sunlight through the upper haze)
  col *= mix(vec3(1.0, 0.6, 0.42), vec3(1.0), smoothstep(0.0, 0.3, NL));
  // faint ring-shine on the night side
  if (uRingP.z > 0.5) col += albedo * uSunIll * 0.0025 * smoothstep(0.1, -0.2, NL) * (0.5 + 0.5 * abs(dot(uRingN, L)));
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

// Atmosphere limb shell: single scattering, few steps, in units of the planet radius.
// Output: premultiplied in-scatter (rgb) and transmittance (a) → blend ONE, SRC_ALPHA.
export const SHELL_FRAG = /* glsl */ `
#include <rv_space>
uniform vec3 uSunDir;
uniform vec3 uSunIll;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uTop;          // shell radius / planet radius
uniform vec3 uBetaR;         // Rayleigh-like scattering per planet radius (vertical depth scale)
uniform float uBetaM;        // Mie (haze)
uniform float uMieG;
uniform float uHScale;       // scale height / (top - 1)
uniform vec4 uOcc[4];
uniform int uOccN;
uniform float uSunAng;
varying vec3 vW;
void main(){
  vec3 ro = (cameraPosition - uCenter) / uRadius;
  vec3 rd = normalize(vW - cameraPosition);
  vec2 to = sp_raySphere(ro, rd, uTop);
  if (to.y < 0.0 || to.x > to.y){ discard; }
  vec2 tp = sp_raySphere(ro, rd, 1.0);
  float t0 = max(to.x, 0.0);
  float t1 = to.y;
  bool hitP = tp.x < tp.y && tp.y > 0.0;
  if (hitP) t1 = max(tp.x, t0);
  float H = (uTop - 1.0) * uHScale;
  const int STEPS = 10;
  float dt = (t1 - t0) / float(STEPS);
  vec3 L = uSunDir;
  float nu = dot(rd, L);
  vec3 sumR = vec3(0.0); vec3 sumM = vec3(0.0);
  vec3 odV = vec3(0.0);
  vec3 betaE = uBetaR + uBetaM * 1.1;
  float jit = rv_ign(gl_FragCoord.xy);
  for (int i = 0; i < STEPS; i++){
    float t = t0 + dt * (float(i) + jit);
    vec3 x = ro + rd * t;
    float r = length(x);
    float hh = max(r - 1.0, 0.0);
    float dens = exp(-hh / H) * (1.0 - smoothstep(uTop - 0.25 * (uTop - 1.0), uTop, r));
    odV += betaE * dens * dt;
    // sun path: analytic Chapman-like optical depth toward the star
    float mu = dot(x / r, L);
    float chap = H / max(mu + 0.15 * sqrt(H), 0.02 * sqrt(H));
    // planet shadow (ray toward the sun hits the ground)
    float b = dot(x, L);
    float d2 = dot(x, x) - b * b;
    float shadow = b > 0.0 ? 1.0 : smoothstep(0.985, 1.01, sqrt(max(d2, 0.0)));
    vec3 odS = betaE * dens * chap;
    vec3 att = exp(-(odV + odS)) * shadow;
    sumR += dens * att * dt;
    sumM += dens * att * dt;
  }
  float vis = 1.0;
  for (int i = 0; i < 4; i++){ if (i >= uOccN) break; vis *= sp_occlude(uCenter + (ro + rd * (t0 + t1) * 0.5) * uRadius, L, uSunAng, uOcc[i].xyz, uOcc[i].w); }
  vec3 inS = (sumR * uBetaR * sp_phaseR(nu) + sumM * uBetaM * sp_phaseHG(nu, uMieG)) * uSunIll * vis;
  vec3 T = exp(-odV);
  float Tm = dot(T, vec3(0.3333));
  gl_FragColor = vec4(inS, hitP ? Tm : 1.0);
}`;

export const RING_VERT = /* glsl */ `
varying vec3 vW;
varying vec2 vXY;
void main(){
  vXY = position.xy;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const RING_FRAG = /* glsl */ `
#include <rv_space>
uniform sampler2D uRingTex;
uniform float uIn, uOut;     // in object units (planet radius = 1)
uniform vec3 uCenter;
uniform vec3 uN;
uniform float uPR;
uniform vec3 uSunDir;
uniform vec3 uSunIll;
uniform float uSunAng;
uniform float uOpacity;
uniform float uTime;
varying vec3 vW;
varying vec2 vXY;
void main(){
  float r = length(vXY);
  float t = (r - uIn) / (uOut - uIn);
  if (t < 0.0 || t > 1.0) discard;
  vec4 rt = texture2D(uRingTex, vec2(t, 0.5));
  float fw = fwidth(t) * 2048.0;
  float fine = mix(0.62 + 0.76 * rv_vnoise(vec3(t * 6000.0, 0.5, 0.5)), 1.0, smoothstep(0.2, 1.0, fw * 3.0));
  // faint azimuthal density waves / spokes
  float az = atan(vXY.y, vXY.x);
  float spokes = 1.0 - 0.12 * smoothstep(0.55, 0.9, rv_fbm(vec3(az * 6.0 + uTime * 0.01, t * 30.0, 1.7), 3) * 0.5 + 0.5) * smoothstep(0.25, 0.4, t) * smoothstep(0.65, 0.5, t);
  float op = clamp(rt.a * fine * uOpacity * spokes, 0.0, 0.985);
  if (op < 0.002) discard;
  float tau = -log(1.0 - op);
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = uSunDir;
  float mu = max(abs(dot(V, uN)), 0.015);
  float mu0 = max(abs(dot(L, uN)), 0.015);
  bool litSide = dot(V, uN) * dot(L, uN) > 0.0;
  float a = 1.0 - exp(-tau / mu);
  // phase: icy particles backscatter; fine dust forward-scatters (dust fraction higher in sparse rings)
  float cfw = -dot(L, V);           // 1 → camera looks at the sun through the ring (forward scattering)
  float dustF = mix(0.12, 0.7, 1.0 - smoothstep(0.1, 0.6, op));
  float P = mix(sp_phaseHG(cfw, -0.3), sp_phaseHG(cfw, 0.72), dustF) * 4.0 * RV_PI;
  vec3 alb = rt.rgb * 1.15;
  float S;
  if (litSide){
    S = mu0 / (mu0 + mu) * (1.0 - exp(-tau * (1.0 / mu0 + 1.0 / mu)));
  } else {
    S = abs(mu0 - mu) < 1e-3 ? tau / mu * exp(-tau / mu) : mu0 / (mu0 - mu) * (exp(-tau / mu0) - exp(-tau / mu));
    S = max(S, 0.0);
  }
  vec3 Lr = alb * uSunIll * P / (4.0 * RV_PI) * S;
  // multiple scattering fill on the lit face
  if (litSide) Lr += alb * alb * uSunIll * 0.05 * a;
  else Lr += alb * alb * uSunIll * 0.07 * (1.0 - exp(-tau / mu0)) * exp(-tau * 0.6);   // diffuse transmission
  // planet shadow on the rings
  float sh = sp_occlude(vW, L, uSunAng, uCenter, uPR);
  Lr *= sh;
  gl_FragColor = vec4(Lr, a);
}`;
