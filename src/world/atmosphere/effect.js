// Atmosphere post effect (pipeline order 100). OWNED BY THE ATMOSPHERE TRACK.
//
// For every pixel (reads scene color + depth):
//   • sky pixels (depth = far, or beyond the atmosphere: stars, sun disk, other planets drawn by the
//     space track) → background × view transmittance × daylight star visibility + in-scattered sky
//     (sky-view LUT inside the atmosphere, per-pixel ray march from space; blended near the top)
//   • geometry → aerial perspective: color × T(camera→surface) + in-scattering (ray-marched,
//     Rayleigh + Mie + ozone + multiple scattering, planet shadow → terminator/twilight wedge)
//   • night: moonlit sky, starlight/airglow gradient, airglow emission layer (limb band from space),
//     aurora curtains (weather.aurora)
import * as THREE from 'three';
import { fsMaterial, FSQuad } from './fs.js';
import { Params } from '../../core/Params.js';

const FRAG = /* glsl */ `
#include <rv_common>
#include <rv_atmo>
#include <rv_atmo_sky>
#include <rv_atmo_view>
#include <rv_noise>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec3 uCamPlanet;      // camera position, planet-centered (m)
uniform vec3 uSunDir;
uniform vec3 uSunIll;         // sun illuminance color (top of atmosphere)
uniform float uGeoSteps;
uniform float uSpaceSteps;
uniform float uSpaceBlend;    // 0: LUT for sky, 1: per-pixel march
uniform vec3 uNightSky;       // starlight/airglow sky radiance (zenith)
uniform vec3 uMoonDir;
uniform vec3 uMoonSky;        // moonlit sky radiance scale
uniform float uStarVis;       // contrast threshold factor for stars by day
uniform float uFallbackSun;   // 1 → draw a sun disk (no space track)
uniform vec3 uAirglow;        // airglow emission (radiance at zenith)
uniform float uAirglowR;      // radius of the airglow layer
uniform float uAirglowW;      // half thickness
uniform float uAurora;        // aurora strength (0 = off)
uniform float uAuroraLat;     // sin(latitude) where the auroral band starts
uniform vec3 uAuroraCol1;
uniform vec3 uAuroraCol2;
uniform float uTime;
uniform float uHasAtmo;
uniform float uDebug;
uniform float uAPScale;       // aerial perspective density scale for geometry (art control)
uniform mat3 uStarRot;        // planet-local → inertial (fallback star field wheels with the sky)
uniform vec4 uFog;            // height fog: density at base (1/m), scale height (m), base altitude (m), patchiness
uniform vec3 uFogAlbedo;
uniform vec3 uFogAmb;         // ambient radiance for the fog
uniform vec3 uFogSun;         // sun illuminance at the camera
uniform vec2 uFogWind;
uniform vec4 uLavaGlow;       // lava-lit haze: emitted radiance (rgb), 1 / glow height (m) above the fog base
uniform float uPixAng;        // angular size of a pixel (rad)
uniform float uGeoGain;       // in-scatter gain over geometry (the sky gain relaxes from altitude/space)
uniform vec4 uCities[12];     // settlements: unit direction (planet-local), angular radius (rad)
uniform float uCityW[12];     // light output weight (metropolis 1 … village 0.2)
uniform float uCityN;
uniform vec3 uCityCol;        // emitted radiance of a lit city core
uniform float uCityGround;    // ground emission seen from altitude / orbit (near the ground civ draws its own lights)
uniform float uCitySky;       // light-pollution sky glow seen from the ground at night
uniform vec2 uRural;          // sparse rural / road lights over land (civ level), sea-level radius (m)
varying vec2 vUv;

// Night lights of settlements seen from altitude / orbit: cores + sprawl along noise "roads", only where
// the sun is down at that point (terminator-aware).
vec3 cityGround(vec3 n, float rHit){
  if (uCityGround <= 0.0) return vec3(0.0);
  float night = smoothstep(0.04, -0.12, dot(n, uSunDir));
  if (night <= 0.0) return vec3(0.0);
  // rural lights: farms, roads and hamlets sprinkled over land (Earth-at-night speckle), in regional clusters
  float rural = 0.0;
  if (uRural.x > 0.0 && rHit > uRural.y + 3.0){
    vec3 qr = n * (uAtmoRb / 1400.0);
    float region = smoothstep(0.45, 0.8, rv_fbm(n * (uAtmoRb / 22000.0) + 3.7, 2) * 0.5 + 0.5);
    float sp = max(rv_snoise(qr), 0.0);
    rural = pow(sp, 6.0) * 6.0 * region * uRural.x;
  }
  float core = 0.0, halo = 0.0;
  for (int k = 0; k < 12; k++){
    if (float(k) >= uCityN) break;
    float a2 = max(0.0, 2.0 - 2.0 * dot(n, uCities[k].xyz));
    float r = uCities[k].w;
    core += uCityW[k] * exp(-a2 / (r * r));
    halo += uCityW[k] * exp(-a2 / (r * r * 16.0));
  }
  if (core + halo + rural < 1e-4) return vec3(0.0);
  // sprawl: clustered blocks + filaments (roads) between them
  vec3 q = n * (uAtmoRb / 700.0);
  float blocks = smoothstep(0.1, 0.7, rv_fbm(q, 3) * 0.5 + 0.5);
  float roads = pow(1.0 - abs(rv_snoise(q * 0.35 + 7.0)), 10.0);
  float f = core * (0.35 + 0.9 * blocks) + halo * (0.12 * blocks + 0.6 * roads) + rural;
  return uCityCol * f * night * uCityGround;
}

// Light pollution: the city glow scattered by the air above it, seen from the ground (warm dome on the horizon).
vec3 citySky(vec3 dir, vec3 up, float camR){
  if (uCityN < 0.5 || uCitySky <= 0.0) return vec3(0.0);
  float el = max(dot(dir, up), 0.0);
  vec3 vH = normalize(dir - up * dot(dir, up) + 1e-5);
  float acc = 0.0;
  for (int k = 0; k < 12; k++){
    if (float(k) >= uCityN) break;
    vec3 c = uCities[k].xyz;
    float cosD = dot(c, up);
    float d = acos(clamp(cosD, -1.0, 1.0)) * uAtmoRb;          // ground distance (m)
    float rr = uCities[k].w * uAtmoRb;                          // city radius (m)
    vec3 cH = c - up * cosD;
    float lh = length(cH);
    float az = lh > 1e-6 ? dot(vH, cH / lh) : 1.0;
    // inside the city: a dome overhead; far away: a glow on the horizon in its direction
    float spread = mix(1.0, 0.0, smoothstep(rr, rr * 3.0, d));
    float dirW = mix(exp((az - 1.0) * (2.5 + 2000.0 / (rr + 1.0))), 1.0, spread);
    float elW = exp(-el * mix(9.0, 2.5, spread));
    acc += uCityW[k] * dirW * elW / (1.0 + pow(d / (rr * 4.0 + 1500.0), 2.0));
  }
  return uCityCol * acc * uCitySky;
}

// Fallback night sky (only when the space track is absent): hashed stars + faint galactic band.
vec3 fallbackStars(vec3 d){
  vec3 col = vec3(0.0);
  for (int k = 0; k < 2; k++){
    float sc = k == 0 ? 90.0 : 190.0;
    vec3 q = d * sc;
    vec3 c = floor(q);
    vec3 h = rv_hash33(c + float(k) * 17.0);
    float thr = k == 0 ? 0.93 : 0.8;
    if (h.x > thr){
      vec3 sp = c + 0.2 + 0.6 * rv_hash33(c + 5.3);
      vec3 sd = normalize(sp);
      float a = length(cross(d, sd));
      float sig = max(uPixAng * 0.85, 1e-5);
      float b = pow((h.x - thr) / (1.0 - thr), k == 0 ? 3.0 : 5.0) * (k == 0 ? 2.2 : 0.7);
      vec3 tint = mix(vec3(1.0, 0.78, 0.55), vec3(0.72, 0.84, 1.0), h.y);
      col += tint * b * exp(-a * a / (sig * sig)) ;
    }
  }
  // galactic band
  vec3 gN = normalize(vec3(0.35, 0.8, 0.48));
  float lat = dot(d, gN);
  float band = exp(-lat * lat * 26.0);
  float n = rv_snoise(d * 5.0) * 0.5 + rv_snoise(d * 13.0) * 0.25 + 0.6;
  float dust = smoothstep(0.1, 0.6, rv_snoise(d * 7.0 + 3.0) * 0.5 + 0.5) * exp(-lat * lat * 140.0);
  col += vec3(0.55, 0.6, 0.75) * band * max(n, 0.0) * 0.012 * (1.0 - dust * 0.8);
  return col * 0.06;
}

// chord length of a ray through a spherical shell [r0, r1], clipped to [0, tMax]
float shellChord(vec3 ro, vec3 rd, float r0, float r1, float tMax){
  vec2 o = atmo_raySphere(ro, rd, r1);
  if (o.y <= 0.0) return 0.0;
  float a = max(o.x, 0.0), b = min(o.y, tMax);
  if (b <= a) return 0.0;
  float len = b - a;
  vec2 i = atmo_raySphere(ro, rd, r0);
  if (i.y > 0.0){
    float ia = max(i.x, a), ib = min(i.y, b);
    if (ib > ia) len -= (ib - ia);
  }
  return max(len, 0.0);
}

// Aurora curtains: folded emissive sheets in a high shell, brighter toward the poles.
vec3 auroraMarch(vec3 ro, vec3 rd, float tMax, float jitter){
  float H = uAtmoRt - uAtmoRb;
  float r0 = uAtmoRb + H * 0.50, r1 = uAtmoRb + H * 0.86;
  vec2 o = atmo_raySphere(ro, rd, r1);
  if (o.y <= 0.0) return vec3(0.0);
  float a = max(o.x, 0.0), b = min(o.y, tMax);
  vec2 i = atmo_raySphere(ro, rd, r0);
  if (i.x > a && i.x < b) b = i.x;          // looking up from below: first segment only
  else if (i.y > a && i.y < b && i.x < a) a = i.y;
  if (b <= a) return vec3(0.0);
  const float N = 40.0;
  float dt = (b - a) / N;
  vec3 acc = vec3(0.0);
  for (float k = 0.0; k < N; k += 1.0){
    vec3 p = ro + rd * (a + (k + jitter) * dt);
    float r = length(p);
    vec3 n = p / r;
    float hf = clamp((r - r0) / (r1 - r0), 0.0, 1.0);
    float band = smoothstep(uAuroraLat, uAuroraLat + 0.25, abs(n.y));
    if (band <= 0.0) continue;
    // curtain field on the sphere: warped longitude/latitude lines
    float lon = atan(n.x, n.z);
    vec2 q = vec2(lon * 3.0, n.y * 9.0);
    float w1 = rv_snoise(vec3(q * 0.7, uTime * 0.05));
    float w2 = rv_snoise(vec3(q * 1.9 + 3.1, uTime * 0.11));
    float f = n.y * 14.0 + w1 * 1.6 + w2 * 0.45;
    float curtain = pow(1.0 - abs(fract(f) * 2.0 - 1.0), 22.0);
    curtain += 0.6 * pow(1.0 - abs(fract(f * 1.7 + 0.37) * 2.0 - 1.0), 28.0);
    // rays (vertical striations)
    float rn = rv_snoise(vec3(lon * 260.0 + w1 * 3.0, hf * 0.5, uTime * 0.35)) * 0.5 + 0.5;
    float rays = 0.25 + 1.5 * rn * rn * rn;
    // vertical profile: sharp bottom, long fading top
    float prof = smoothstep(0.0, 0.025, hf) * exp(-hf * 2.4);
    vec3 col = mix(uAuroraCol1, uAuroraCol2, smoothstep(0.25, 0.85, hf));
    acc += col * curtain * rays * prof * band * dt;
  }
  return acc * uAurora / (r1 - r0);
}

// Analytic exponential height fog along [0, d] (flat-earth approximation near the camera), patchy banks.
vec3 applyFog(vec3 col, vec3 ro, vec3 dir, float d, vec3 up, float nu){
  if (uFog.x <= 0.0) return col;
  float camR = length(ro);
  float hc = camR - uAtmoRb - uFog.z;
  float cz = dot(dir, up);
  d = min(d, 60000.0);
  float Hf = uFog.y;
  float he = hc + cz * d;
  float e0 = exp(-max(hc, -2.0 * Hf) / Hf), e1 = exp(-max(he, -2.0 * Hf) / Hf);
  float od = abs(cz) > 1e-4 ? uFog.x * Hf * (e0 - e1) / cz : uFog.x * d * e0;
  // drifting banks: modulate by noise at the ray's end region
  vec3 pe = ro + dir * min(d, 8000.0);
  float n = rv_snoise(vec3(pe.xz * 0.00035 + uFogWind * 0.0004, pe.y * 0.0003)) * 0.5 + 0.5;
  od *= mix(1.0, 0.25 + 1.5 * n, uFog.w);
  float T = exp(-max(od, 0.0));
  vec3 L = uFogAmb * 1.6 + uFogSun * (atmo_phaseHG(nu, 0.55) * 0.9 + 0.05);
  L *= uFogAlbedo;
  // lava worlds: the low haze glows with the light of the lava below it
  if (uLavaGlow.w > 0.0) L += uLavaGlow.rgb * exp(-max(0.5 * (hc + he), 0.0) * uLavaGlow.w);
  return col * T + L * (1.0 - T);
}

void main(){
  vec3 col = texture(tColor, vUv).rgb;
  if (uHasAtmo < 0.5){ gl_FragColor = vec4(col, 1.0); return; }
  float depth = texture(tDepth, vUv).r;
  vec3 vd = atmo_viewDir(vUv);
  vec3 dir = normalize(mat3(uCamWorld) * vd);
  bool far = atmo_isFar(depth);
  float tHit = far ? 1e30 : atmo_depthToDist(depth, vd);
  vec3 ro = uCamPlanet;
  float camR = length(ro);
  vec3 up = ro / camR;
  float nu = dot(dir, uSunDir);
  float jitter = rv_ign(gl_FragCoord.xy);

  vec2 top = atmo_raySphere(ro, dir, uAtmoRt);
  bool beyond = far || top.y <= 0.0 || tHit >= top.y;   // surface is outside the atmosphere
  vec3 outc;
  if (!beyond){
    // ---------------- aerial perspective on geometry
    float t0 = max(top.x, 0.0);
    float t1 = tHit;
    float len = max(t1 - t0, 0.0);
    // more steps for long paths (from altitude / space)
    float steps = clamp(uGeoSteps * (0.5 + len / 6000.0), 4.0, uGeoSteps * 2.0);
    AtmoInscatter a = atmo_marchS(ro, dir, t0, t1, uSunDir, steps, 0.5, uAPScale);
    vec3 L = atmo_combine(a, nu) * uSunIll * uGeoGain;
    // moonlit / starlit air (tiny, keeps night silhouettes readable)
    float airT = 1.0 - dot(a.T, vec3(0.3333));
    L += (uNightSky * 0.5 + uMoonSky * atmo_phaseRayleigh(dot(dir, uMoonDir)) * 2.0) * airT;
    outc = col * a.T + L;
    if (uCityGround > 0.0){ vec3 ph = ro + dir * tHit; outc += cityGround(normalize(ph), length(ph)) * a.T; }
    outc = applyFog(outc, ro, dir, tHit, up, nu);
  } else {
    // ---------------- sky / background
    float tAtmEnd = far ? top.y : min(tHit, top.y);
    vec3 L = vec3(0.0);
    vec3 T = vec3(1.0);
    bool hitsAtmo = top.y > 0.0;
    if (hitsAtmo){
      vec2 bot = atmo_raySphere(ro, dir, uAtmoRb);
      bool hitGround = bot.x > 0.0;
      if (uDebug > 0.5 && camR < uAtmoRt){
        float cosZ = dot(dir, up);
        vec3 sH = uSunDir - up * dot(uSunDir, up);
        vec3 vH = dir - up * cosZ;
        float ls = length(sH), lv = length(vH);
        float cosAz = (ls > 1e-5 && lv > 1e-5) ? dot(sH, vH) / (ls * lv) : 1.0;
        vec2 bot2 = atmo_raySphere(up * camR, dir, uAtmoRb);
        vec2 uv = atmo_skyViewUV(bot2.x > 0.0, cosZ, cosAz, camR);
        vec3 dbg = uDebug < 1.5 ? texture(uSkyR, uv).rgb * atmo_phaseRayleigh(nu) : uDebug < 2.5 ? texture(uSkyM, uv).rgb * atmo_phaseMie(nu, uMieG) : uDebug < 3.5 ? texture(uSkyMS, uv).rgb : vec3(uv, 0.0) / 6.0;
        gl_FragColor = vec4(dbg * uSunIll, 1.0); return;
      }
      if (uSpaceBlend < 1.0 && camR < uAtmoRt){
        vec3 Llut = atmo_skyLUT(dir, up, camR, uSunDir, nu);
        T = hitGround ? vec3(0.0) : atmo_transmittance(camR, dot(dir, up));
        L = Llut;
      }
      if (uSpaceBlend > 0.0){
        float t0 = max(top.x, 0.0);
        float t1 = hitGround ? bot.x : tAtmEnd;
        float len = max(t1 - t0, 0.0);
        float steps = clamp(uSpaceSteps * (0.35 + len / (uAtmoRt - uAtmoRb) * 0.35), 6.0, uSpaceSteps);
        AtmoInscatter a = atmo_march(ro, dir, t0, t1, uSunDir, steps, jitter);
        vec3 Lm = atmo_combine(a, nu);
        vec3 Tm = hitGround ? vec3(0.0) : a.T;
        L = mix(L, Lm, uSpaceBlend);
        T = mix(T, Tm, uSpaceBlend);
      }
      L *= uSunIll;
      // night sky: starlight/airglow gradient + moonlit sky (inside the atmosphere)
      float inside = 1.0 - smoothstep(uAtmoRt * 0.985, uAtmoRt, camR);
      if (inside > 0.0 && !hitGround){
        float cz = max(dot(dir, up), 0.0);
        float airmass = 1.0 / (cz + 0.12);
        vec3 ns = uNightSky * (0.45 + 0.18 * airmass);
        float mnu = dot(dir, uMoonDir);
        vec3 ms = uMoonSky * (atmo_phaseRayleigh(mnu) * (0.6 + 0.15 * airmass) + 0.35 * atmo_phaseHG(mnu, 0.8));
        // aerosol aureole: a soft white halo hugging the moon disc (seats it in the sky)
        ms += vec3(dot(uMoonSky, vec3(0.3333))) * 0.25 * min(atmo_phaseHG(mnu, 0.9), 20.0) * (0.6 + 0.4 * uAPScale / 0.5);
        L += (ns + ms) * inside;
        if (uCitySky > 0.0) L += citySky(dir, up, camR) * inside;
      }
      // airglow emission layer (limb brightening; visible at night and from space)
      float ch = shellChord(ro, dir, uAirglowR - uAirglowW, uAirglowR + uAirglowW, hitGround ? bot.x : 1e30);
      L += uAirglow * ch / (2.0 * uAirglowW) * mix(vec3(1.0), T, 0.5);
      // aurora
      if (uAurora > 0.0) L += auroraMarch(ro, dir, hitGround ? bot.x : top.y, jitter) * mix(vec3(1.0), T, 0.3);
    }
    // background (stars, sun disk, planets) seen through the atmosphere; faint stars vanish by day
    vec3 bg = col;
    if (uFallbackSun > 0.5){
      // fallback star disk (limb-darkened) when no space track draws the star
      float ang = acos(clamp(nu, -1.0, 1.0));
      float x = clamp(ang / uSunAngR, 0.0, 1.0);
      float disk = 1.0 - smoothstep(0.92, 1.0, ang / uSunAngR);
      float limb = 0.45 + 0.55 * sqrt(max(1.0 - x * x, 0.0));
      bg += uSunIll * disk * limb * 40.0;
    }
    if (uFallbackSun > 0.5 && far) bg += fallbackStars(uStarRot * dir);
    bg *= T;
    float bl = rv_luma(bg);
    float sl = rv_luma(L);
    // daytime star hiding only for the far-plane background (planets / rings with real depth stay)
    float vis = far ? clamp((bl - uStarVis * sl) / max(bl, 1e-6), 0.0, 1.0) : 1.0;
    outc = bg * vis + L;
    if (camR < uAtmoRt) outc = applyFog(outc, ro, dir, far ? 40000.0 : tHit, up, nu);
  }
  gl_FragColor = vec4(outc, 1.0);
}`;

const _q = new THREE.Quaternion(), _m4 = new THREE.Matrix4();

export class AtmosphereEffect {
  constructor(atmo) {
    this.atmo = atmo;
    this.name = 'atmosphere';
    this.order = 100;
    this.enabled = true;
    const q = atmo.quality;
    this.quad = new FSQuad();
    const tier = q.tier;
    this.u = {
      tColor: { value: null }, tDepth: { value: null },
      uSkyR: { value: null }, uSkyM: { value: null }, uSkyMS: { value: null },
      uCamPlanet: { value: new THREE.Vector3() },
      uCamWorld: { value: new THREE.Matrix4() },
      uProjParams: { value: new THREE.Vector4(1, 1, 0, 0) },
      uNear: { value: 0.05 }, uFar: { value: 2e10 },
      uSunDir: atmo.shared.uSunDir,
      uSunIll: atmo.shared.uSunIll,
      uGeoSteps: { value: tier === 'low' ? 5 : tier === 'med' ? 7 : tier === 'high' ? 10 : 14 },
      uSpaceSteps: { value: tier === 'low' ? 12 : tier === 'med' ? 18 : 28 },
      uSpaceBlend: { value: 0 },
      uNightSky: atmo.shared.uNightSky,
      uMoonDir: atmo.shared.uMoonDir,
      uMoonSky: atmo.shared.uMoonSky,
      uStarVis: { value: 3.0 },
      uFallbackSun: { value: 0 },
      uAirglow: atmo.shared.uAirglow,
      uAirglowR: { value: atmo.model.Rb + atmo.model.height * 0.62 },
      uAirglowW: { value: atmo.model.height * 0.035 },
      uAurora: atmo.shared.uAurora,
      uAuroraLat: atmo.shared.uAuroraLat,
      uAuroraCol1: { value: new THREE.Vector3(0.1, 1.0, 0.45) },
      uAuroraCol2: { value: new THREE.Vector3(0.9, 0.15, 0.55) },
      uTime: atmo.shared.uTime,
      uHasAtmo: { value: atmo.model.present ? 1 : 0 },
      uDebug: { value: +(Params.num?.('atmoDebug') ?? 0) },
      uAPScale: { value: atmo.model.apScale ?? 1 },
      uStarRot: { value: new THREE.Matrix3() },
      uFog: { value: new THREE.Vector4(0, 1, 0, 0) },
      uFogAlbedo: { value: new THREE.Vector3(1, 1, 1) },
      uFogAmb: { value: new THREE.Vector3() },
      uFogSun: { value: new THREE.Vector3() },
      uFogWind: { value: new THREE.Vector2() },
      uLavaGlow: { value: new THREE.Vector4(0, 0, 0, 0) },
      uPixAng: { value: 0.001 },
      uGeoGain: { value: 1 },
      uCities: { value: Array.from({ length: 12 }, () => new THREE.Vector4(0, 1, 0, 0.01)) },
      uCityW: { value: new Array(12).fill(0) },
      uCityN: { value: 0 },
      uCityCol: { value: new THREE.Vector3(1.0, 0.62, 0.32) },
      uCityGround: { value: 0 },
      uCitySky: { value: 0 },
      uRural: { value: new THREE.Vector2(0, 0) },
      ...atmo.atmoUniforms,
    };
    this.mat = fsMaterial(FRAG, this.u);
  }

  updateCamera(camera) {
    const u = this.u, p = camera.projectionMatrix.elements;
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uProjParams.value.set(p[0], p[5], p[8], p[9]);
    u.uNear.value = camera.near; u.uFar.value = camera.far;
    const cel = this.atmo.world.celestial;
    if (cel?.qInv) { _q.copy(cel.qInv).invert(); _m4.makeRotationFromQuaternion(_q); u.uStarRot.value.setFromMatrix4(_m4); }
    u.uPixAng.value = 2 / (p[5] * Math.max(1, this.atmo.engine.pipeline?.height || 540));
    // planet-centered camera position: scene position + floating origin (root = -origin, no rotation)
    u.uCamPlanet.value.setFromMatrixPosition(camera.matrixWorld).add(this.atmo.world.origin);
    const m = this.atmo.model;
    const h = (u.uCamPlanet.value.length() - m.Rb) / m.height;
    u.uAPScale.value = THREE.MathUtils.lerp(m.apScale ?? 1, 1, THREE.MathUtils.smoothstep(h, 0.3, 1.0));
    // from high altitude / orbit the veil over land & oceans is physical (no art sky gain): deep blue oceans
    u.uGeoGain.value = THREE.MathUtils.lerp(1, 1.15 / Math.max(m.skyGain, 1), THREE.MathUtils.smoothstep(h, 0.4, 1.4));
    // city lights: ground emission fades in from altitude (civ draws real lights near the ground)
    const alt = u.uCamPlanet.value.length() - m.Rb;
    const E = m.sunIlluminance;
    u.uCityGround.value = (u.uCityN.value > 0 || u.uRural.value.x > 0) ? 0.11 * E * THREE.MathUtils.smoothstep(alt, 2500, 12000) : 0;
    u.uCitySky.value = u.uCityN.value > 0 && m.present ? 0.0035 * E * (this.atmo.lighting?.nightFactor ?? 0) * (1 + 1.5 * (m.moody || 0)) * (1 - THREE.MathUtils.smoothstep(alt, 6000, 20000)) : 0;
  }

  /** Settlement list for night lights (civ track: world.civ.sites). Polled until civ exists. */
  updateCities() {
    const w = this.atmo.world;
    const sites = w.civ?.sites;
    if (!sites || sites === this._sites) return;
    this._sites = sites;
    const K = { metropolis: 1.0, city: 0.75, town: 0.42, village: 0.2, camp: 0.07, harbor: 0.3 };
    const R = this.atmo.model.Rb;
    const list = [];
    for (const s of sites) {
      const wgt = (K[s.kind] ?? 0) * (s.hamlet ? 0.45 : 1) * (s.capital ? 1.3 : 1);
      if (!(wgt > 0) || !s.up) continue;
      // the lit footprint reaches past the planned town (suburbs, roads, farms): ×3 its radius
      list.push({ d: s.up, r: Math.max(700, (s.radius || 300) * 3.0) / R, w: wgt });
    }
    list.sort((a, b) => b.w - a.w);
    const u = this.u, n = Math.min(12, list.length);
    for (let i = 0; i < n; i++) { u.uCities.value[i].set(list[i].d.x, list[i].d.y, list[i].d.z, list[i].r); u.uCityW.value[i] = list[i].w; }
    u.uCityN.value = n;
    const lvl = w.body.civ?.level ?? 0;
    u.uRural.value.set(lvl > 0 ? 0.12 + 0.18 * lvl / 5 : 0, R + Math.max(0, w.surface?.seaLevel ?? 0));
    // neon-noir worlds: magenta / cyan glow; everyone else: sodium & warm windows
    const art = w.body.art || {};
    const neon = art.key === 'bladerunner' || w.body.civ?.style === 'neon';
    if (neon) u.uCityCol.value.set(0.95, 0.5, 0.95); else u.uCityCol.value.set(1.0, 0.62, 0.32);
  }

  render(renderer, io) {
    const u = this.u;
    if (!this.atmo.model.present && !this.atmo.needsSkyPass) { io.skip = true; return; }
    this.atmo.beforeComposite?.(renderer);
    if ((this._cityPoll = (this._cityPoll || 0) + 1) % 30 === 1) { try { this.updateCities(); } catch (_) { /* optional neighbour */ } }
    u.tColor.value = io.input.texture;
    u.tDepth.value = io.depth;
    const sky = this.atmo.luts?.skyTextures;
    if (sky) { u.uSkyR.value = sky[0]; u.uSkyM.value = sky[1]; u.uSkyMS.value = sky[2]; }
    this.updateCamera(io.camera);
    this.quad.render(renderer, this.mat, io.output);
  }

  dispose() { this.mat.dispose(); this.quad.dispose(); }
}
