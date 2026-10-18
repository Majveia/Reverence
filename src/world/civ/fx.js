// City screen-space pass (pipeline effect, order 112: after water (95), atmosphere / sky (100) and clouds (110)).
//
//  1. Wet-street reflections (SSR): every flat, up-facing pixel inside a settlement (asphalt, plazas,
//     roofs, the harbour water) reflects the frame itself — lit facades, neon signs, shopfronts — by a
//     view-space ray march against the depth buffer. Puddles (world-space noise) are mirror-sharp, wet
//     asphalt in between gets a rougher, vertically smeared reflection (rain-streaked Blade Runner look).
//     Rays that leave the screen fall back to the glowing smog colour, so a wet street mirrors the lit sky.
//  2. City smog / light pollution at night: an analytic exponential height-fog integral along each view
//     ray, masked to the settlement, lit from below by the city (style palette, spatially varying tint).
//     Streets get layered depth, towers fade into a coloured haze, and the sky above a city glows.
//
// The pass is skipped (io.skip) when no settlement is near the camera, so it costs nothing elsewhere.
// Quality: off on `low`, 12 / 22 / 32 screen-space march steps on med / high / ultra.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { makeFullscreenMaterial, FullscreenQuad } from '../../post/common.js';
import '../../shaders/chunks.js';

// per style: wet (always-wet streets), smog density at ground (1/m), scale height (m), colours A/B, brightness
const SMOG = {
  neon: { wet: 1.0, dens: 0.003, H: 55, a: '#ff2f86', b: '#1fc8ff', k: 0.075 },
  industrial: { wet: 0.35, dens: 0.0022, H: 55, a: '#ff9a48', b: '#9fb4c8', k: 0.05 },
  frontier: { wet: 0.0, dens: 0.0014, H: 40, a: '#ff8a3a', b: '#ff4a6a', k: 0.05 },
  brutalist: { wet: 0.2, dens: 0.0016, H: 60, a: '#ffb070', b: '#7fb0ff', k: 0.04 },
  outpost: { wet: 0.0, dens: 0.001, H: 40, a: '#bfe4ff', b: '#ffb040', k: 0.035 },
  nasapunk: { wet: 0.0, dens: 0.001, H: 40, a: '#bfe4ff', b: '#ffb040', k: 0.035 },
  spire: { wet: 0.0, dens: 0.0009, H: 45, a: '#ffcf9a', b: '#9ff0e8', k: 0.035 },
  organic: { wet: 0.25, dens: 0.0012, H: 50, a: '#aff8ff', b: '#ff9ad5', k: 0.04 },
  crystal: { wet: 0.0, dens: 0.0012, H: 45, a: '#d8f0ff', b: '#ff9ad5', k: 0.05 },
  bizarre: { wet: 0.2, dens: 0.0014, H: 45, a: '#b6ff4a', b: '#ff5fb0', k: 0.05 },
  harbor: { wet: 0.4, dens: 0.0012, H: 35, a: '#ffc070', b: '#ffd9a0', k: 0.04 },
  default: { wet: 0.0, dens: 0.0009, H: 35, a: '#ffb25e', b: '#ffd9a0', k: 0.035 },
};

const FRAG = /* glsl */`
#include <rv_common>
#include <rv_noise>
#include <rv_post>
uniform sampler2D tColor, tDepth;
uniform vec4 uProj;
uniform vec2 uNearFar, uTexel;
uniform mat3 uCamRot, uCamRotInv;
uniform vec3 uCamPos, uPC, uSunDir;
uniform vec4 uSite[4];   // xyz centre (scene space), w radius (m)
uniform vec4 uSiteP[4];  // x ground radius from the planet centre, y wet, z smog density, w smog scale height
uniform vec3 uSmogA[4], uSmogB[4];
uniform int uN;
uniform float uWet, uTime, uFrame, uSSR, uSmogK, uDbg;
varying vec2 vUv;

float lin(float d){ return rvp_isSky(d) ? 1e9 : rvp_linDepth(d, uNearFar.x, uNearFar.y); }
vec3 vpos(vec2 uv){ float d = texture2D(tDepth, uv).r; return rvp_viewPos(uv, lin(d), uProj); }

// settlement influence at a scene-space point: strongest site (mask), returns its index
float siteMask(vec3 wp, out int si){
  float best = 0.0; si = 0;
  for (int i = 0; i < 4; i++) {
    if (i >= uN) break;
    float d = length(wp - uSite[i].xyz);
    float m = 1.0 - smoothstep(uSite[i].w * 0.85, uSite[i].w * 1.45 + 120.0, d);
    if (m > best) { best = m; si = i; }
  }
  return best;
}

// exponential height fog integral (locally flat): density rho0 * exp(-h / H) along a ray of length t
float fogInt(float h0, float ry, float t, float rho0, float H){
  float a = ry / H;
  float base = rho0 * exp(-clamp(h0, -50.0, 4000.0) / H);
  if (abs(a * t) < 1e-3) return base * t;
  return base * (1.0 - exp(-a * t)) / a;
}

void main(){
  vec3 col = texture2D(tColor, vUv).rgb;
  float d0 = texture2D(tDepth, vUv).r;
  bool sky = rvp_isSky(d0);
  float L0 = sky ? 6000.0 : rvp_linDepth(d0, uNearFar.x, uNearFar.y);
  vec3 vdir = rvp_viewDir(vUv, uProj);
  vec3 vp = vdir * (L0 / max(-vdir.z, 1e-4));
  vec3 rdW = uCamRot * vdir;                      // world-space view ray
  float dist = length(vp);
  vec3 wp = uCamPos + rdW * dist;
  vec3 upP = normalize(wp - uPC);
  vec3 upC = normalize(uCamPos - uPC);
  float nightP = 1.0 - smoothstep(-0.12, 0.06, dot(upP, uSunDir));
  int si; float mP = siteMask(wp, si);
  int sc; float mC = siteMask(uCamPos, sc);
  vec3 mid = uCamPos + rdW * min(dist, 3000.0) * 0.5;
  int sm; float mM = siteMask(mid, sm);
  int sx = mP >= mM ? si : sm;
  if (mC > max(mP, mM)) sx = sc;
  vec4 S = uSite[0]; vec4 SP = uSiteP[0]; vec3 sA = uSmogA[0], sB = uSmogB[0];
  for (int i = 1; i < 4; i++) if (i == sx) { S = uSite[i]; SP = uSiteP[i]; sA = uSmogA[i]; sB = uSmogB[i]; }

  // ---------------------------------------------------------------- smog colour at this pixel
  vec3 pl = wp - uPC;
  float tn = rv_vnoise(pl * 0.0021 + vec3(uTime * 0.01, 0.0, 0.0)) * 0.65 + rv_vnoise(pl * 0.0083) * 0.35;
  vec3 smogCol = mix(sA, sB, smoothstep(0.3, 0.7, tn));

  // ---------------------------------------------------------------- wet reflections
  if (!sky && uSSR > 0.5 && mP > 0.02) {
    float hA = length(pl) - SP.x;
    float wet = clamp(max(uWet * 1.2, SP.y), 0.0, 1.0) * mP;
    if (wet > 0.02 && hA > -25.0 && hA < 60.0 && dist < 900.0) {
      // geometric normal from depth (pick the smaller-difference neighbour on each axis)
      vec3 pr = vpos(vUv + vec2(uTexel.x, 0.0)), pL = vpos(vUv - vec2(uTexel.x, 0.0));
      vec3 pu = vpos(vUv + vec2(0.0, uTexel.y)), pD = vpos(vUv - vec2(0.0, uTexel.y));
      vec3 dx = abs(pr.z - vp.z) < abs(vp.z - pL.z) ? pr - vp : vp - pL;
      vec3 dy = abs(pu.z - vp.z) < abs(vp.z - pD.z) ? pu - vp : vp - pD;
      vec3 nV = normalize(cross(dx, dy));
      if (dot(nV, vp) > 0.0) nV = -nV;
      vec3 upV = uCamRotInv * upP;
      float nu = dot(nV, upV);
      // street / plaza / deck level: trust the planet up (depth-derived normals get noisy at grazing angles
      // and would stipple the reflection); elsewhere (roofs, terraces) require a flat reconstructed normal
      float street = (1.0 - smoothstep(0.5, 1.2, abs(hA - 0.15))) * step(0.5, nu);
      float flat_ = max(smoothstep(0.93, 0.985, nu), street);
      if (flat_ > 0.0) {
        // puddles: large mirror patches; between them rough wet asphalt (streakier, dimmer)
        float pn = rv_vnoise(pl * 0.31) * 0.6 + rv_vnoise(pl * 1.3) * 0.4;
        float puddle = smoothstep(0.5, 0.62, pn);
        float rough = mix(0.012, 0.003, puddle);
        float jit = rv_ign(gl_FragCoord.xy + uFrame * 5.588);
        float jit2 = rv_ign(gl_FragCoord.yx * 1.37 + uFrame * 3.17 + 11.0);
        // rain ripples perturb the normal a little (animated rings in puddles)
        vec3 E = normalize(cross(upP, rdW)); vec3 Fw = cross(E, upP);
        // slow, large-scale undulation of the wet film (high-frequency ripples alias into speckle)
        float rip = (rv_vnoise(pl * 0.7 + vec3(0.0, 0.0, uTime * 0.6)) - 0.5) * uWet * 0.006;
        // anisotropic microfacets: spread mostly along the view direction → vertical streaks on screen
        vec3 nW = normalize(upP + Fw * ((jit - 0.5) * rough * 2.2 + rip) + E * (jit2 - 0.5) * rough * 0.35);
        vec3 N = uCamRotInv * nW;
        vec3 V = normalize(vp);
        vec3 R = reflect(V, N);
        float cosV = clamp(dot(-V, N), 0.0, 1.0);
        float F = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
        vec3 refl = vec3(0.0); float hit = 0.0;
        // perspective-correct march in SCREEN space (covers the whole visible street in a fixed step count)
        vec3 o = vp + N * 0.03;
        float maxD = 450.0;
        if (R.z > 0.0) maxD = min(maxD, (-uNearFar.x * 1.5 - o.z) / R.z);
        vec3 e = o + R * maxD;
        vec2 P0 = rvp_project(o, uProj), P1 = rvp_project(e, uProj);
        // clip the screen segment to the viewport
        vec2 dP = P1 - P0;
        float sMax = 1.0;
        if (dP.x > 1e-6) sMax = min(sMax, (1.0 - P0.x) / dP.x); else if (dP.x < -1e-6) sMax = min(sMax, -P0.x / dP.x);
        if (dP.y > 1e-6) sMax = min(sMax, (1.0 - P0.y) / dP.y); else if (dP.y < -1e-6) sMax = min(sMax, -P0.y / dP.y);
        float k0 = 1.0 / -o.z, k1 = 1.0 / -e.z;
        float sPrev = 0.0, zPrev = -o.z;
        vec2 huv = vec2(0.0);
        for (int i = 1; i <= SSR_STEPS; i++) {
          float sl_ = pow((float(i) - 1.0 + jit) / float(SSR_STEPS), 1.5) * sMax;
          vec2 uv = P0 + dP * sl_;
          // the screen parameter maps to view depth through 1/z interpolation
          float zr = 1.0 / mix(k0, k1, sl_);
          float sd = lin(texture2D(tDepth, uv).r);
          float thick = abs(zr - zPrev) * 2.0 + 0.6 + zr * 0.02;
          if (zr > sd + 0.02 && zr - sd < thick) {
            float a = sPrev, b = sl_;
            for (int k = 0; k < 5; k++) {
              float m = 0.5 * (a + b);
              vec2 muv = P0 + dP * m;
              if (1.0 / mix(k0, k1, m) > lin(texture2D(tDepth, muv).r)) b = m; else a = m;
            }
            huv = P0 + dP * b;
            hit = 1.0;
            break;
          }
          sPrev = sl_; zPrev = zr;
        }
        if (hit > 0.5) {
          // vertical smear (wet asphalt streaks), tighter in puddles
          // rough wet asphalt = a vertically smeared reflection (Blade Runner streaks); puddles stay sharp
          float sm = mix(0.012, 0.0025, puddle);
          refl = texture2D(tColor, huv).rgb * 0.3
               + (texture2D(tColor, huv + vec2(0.0, sm)).rgb + texture2D(tColor, huv - vec2(0.0, sm)).rgb) * 0.22
               + (texture2D(tColor, huv + vec2(0.0, sm * 2.5)).rgb + texture2D(tColor, huv - vec2(0.0, sm * 2.5)).rgb) * 0.13;
          vec2 e = min(huv, 1.0 - huv);
          float edge = smoothstep(0.0, 0.08, min(e.x, e.y * 2.0));
          // energy from very hot pixels (sun disc, lightning) is clamped so the street does not sparkle
          refl = min(refl, vec3(40.0));
          refl = mix(smogCol * uSmogK * 1.5 * nightP, refl, edge);
        } else {
          // ray escaped the screen: reuse the frame where it left (sky at the top edge, far facades at the sides),
          // plus the lit smog at night
          vec2 euv = clamp(P0 + dP * sMax, vec2(0.002), vec2(0.998));
          refl = texture2D(tColor, euv).rgb * 0.85 + smogCol * uSmogK * 1.5 * nightP;
          refl = min(refl, vec3(20.0));
        }
        float k = F * wet * flat_ * mix(0.55, 1.0, puddle);
        col = col * (1.0 - k * 0.8) + refl * k;
        if (uDbg > 0.5) { gl_FragColor = vec4(k * 4.0, hit, flat_, 1.0); return; }
      }
    }
  }

  // ---------------------------------------------------------------- smog / light pollution (night)
  // height fog confined to a dome over each settlement: integrate only the chord of the view ray inside the
  // dome (chord length → 0 at its rim, so there is no visible boundary), sum over the nearby settlements
  float nightC = 1.0 - smoothstep(-0.12, 0.06, dot(upC, uSunDir));
  float night = max(nightC, nightP);
  if (night > 0.01 && uSmogK > 0.0) {
    float tMax = sky ? 8000.0 : dist;
    float tauT = 0.0; vec3 inT = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      if (i >= uN) break;
      vec3 C = uSite[i].xyz; float Rf = uSite[i].w * 1.5 + 250.0;
      vec3 oc = uCamPos - C;
      float b = dot(oc, rdW), c = dot(oc, oc) - Rf * Rf;
      float disc = b * b - c;
      if (disc <= 0.0) continue;
      float sq = sqrt(disc);
      float t0 = max(0.0, -b - sq), t1 = min(tMax, -b + sq);
      if (t1 <= t0) continue;
      vec3 upS = normalize(C - uPC);
      float h0 = dot(uCamPos + rdW * t0 - uPC, upS) - uSiteP[i].x;
      float ry = dot(rdW, upS);
      float tau = fogInt(h0, ry, t1 - t0, uSiteP[i].z, uSiteP[i].w);
      vec3 pc = uCamPos + rdW * (0.5 * (t0 + t1)) - uPC;
      float tn2 = rv_vnoise(pc * 0.0021 + vec3(uTime * 0.01, 0.0, 0.0)) * 0.65 + rv_vnoise(pc * 0.0083) * 0.35;
      inT += mix(uSmogA[i], uSmogB[i], smoothstep(0.3, 0.7, tn2)) * tau * (0.6 + 0.4 * tn2);
      tauT += tau;
    }
    if (tauT > 1e-5) {
      float f = 1.0 - exp(-tauT);
      vec3 inscat = inT / tauT * uSmogK * night;
      col = col * (1.0 - f * 0.55) + inscat * f;
    }
    // light-pollution sky glow: the low sky toward (or above) a city glows with its light, fading upward
    // (runs after the cloud pass: under an overcast deck this is the city light on the cloud base)
    if (sky) {
      for (int i = 0; i < 4; i++) {
        if (i >= uN) break;
        vec3 C = uSite[i].xyz; vec3 upS = normalize(C - uPC);
        vec3 tc = C - uCamPos; float dc = length(tc);
        vec3 th = tc - upS * dot(tc, upS); float lth = length(th);
        float inside = 1.0 - smoothstep(uSite[i].w * 0.6, uSite[i].w * 1.6 + 200.0, lth);
        vec3 rh = rdW - upS * dot(rdW, upS);
        float toward = lth > 1.0 && length(rh) > 1e-3 ? max(0.0, dot(normalize(rh), th / lth)) : 1.0;
        float dirF = mix(pow(toward, 3.0), 1.0, inside);
        float ry = dot(rdW, upS);
        float prox = 1.0 - smoothstep(1500.0, 9000.0, dc);
        // mottled like a lit cloud base, brightest low over the city, fading toward the zenith
        vec3 dn = rdW * 3.0 + vec3(uTime * 0.004, 0.0, 0.0);
        float mott = 0.45 + 0.75 * (rv_vnoise(dn) * 0.6 + rv_vnoise(dn * 2.7) * 0.4);
        float g = exp(-max(ry, 0.0) * mix(13.0, 6.0, inside)) * dirF * prox * uSiteP[i].z * 420.0 * mott;
        col += mix(uSmogA[i], uSmogB[i], 0.5 + 0.5 * sin(atan(rh.x, rh.z) * 2.0 + float(i))) * g * night * uSmogK;
      }
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const _c = new THREE.Color(), _m4 = new THREE.Matrix4();

export class CityFX {
  constructor(civ) {
    this.civ = civ;
    this.name = 'civ-city';
    this.order = 112; // after water (95), atmosphere (100) and clouds (110): reflections see the real sky, the glow lights the cloud base
    this.enabled = true;
    const tier = civ.q?.tier || 'high';
    this.steps = { low: 0, med: 12, high: 22, ultra: 32 }[tier] ?? 22;
    this.U = {
      tColor: { value: null }, tDepth: { value: null },
      uProj: { value: new THREE.Vector4(1, 1, 0, 0) }, uNearFar: { value: new THREE.Vector2(0.1, 1e9) },
      uTexel: { value: new THREE.Vector2(1 / 960, 1 / 540) },
      uCamRot: { value: new THREE.Matrix3() }, uCamRotInv: { value: new THREE.Matrix3() },
      uCamPos: { value: new THREE.Vector3() }, uPC: G.uPlanetCenter, uSunDir: G.uSunDir,
      uSite: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
      uSiteP: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
      uSmogA: { value: [0, 1, 2, 3].map(() => new THREE.Color()) },
      uSmogB: { value: [0, 1, 2, 3].map(() => new THREE.Color()) },
      uN: { value: 0 }, uWet: G.uWetness, uTime: G.uTime, uFrame: G.uFrame,
      uSSR: { value: this.steps > 0 ? 1 : 0 }, uSmogK: { value: 1 }, uDbg: { value: String(civ.world?.params?.civdbg || '').includes('fxdbg') ? 1 : 0 },
    };
    this.mat = makeFullscreenMaterial(FRAG, this.U);
    this.mat.defines = { SSR_STEPS: Math.max(1, this.steps) };
    this.quad = new FullscreenQuad(this.mat);
    this._list = [];
    this.active = false;
  }

  static params(kit) { return SMOG[kit] || SMOG.default; }

  /** choose the (up to 4) settlements nearest to the camera; called every frame by civ.update (no allocations). */
  update(camPos) {
    const civ = this.civ, U = this.U;
    const list = this._list; list.length = 0;
    for (const s of civ.sites) {
      if (s.kind === 'monument') continue;
      const d = camPos.distanceTo(s.pos) - s.radius;
      if (d < 4500) list.push(s);
    }
    list.sort((a, b) => camPos.distanceTo(a.pos) - camPos.distanceTo(b.pos));
    const n = Math.min(4, list.length);
    const root = civ.world.root.position;
    let smogK = 0;
    for (let i = 0; i < n; i++) {
      const s = list[i], p = SMOG[s.kit] || SMOG.default;
      const lvl = 0.6 + 0.1 * (s.level || 3) + (s.kind === 'metropolis' ? 0.3 : s.kind === 'city' ? 0.15 : s.kind === 'village' || s.kind === 'camp' || s.hamlet ? -0.35 : 0);
      U.uSite.value[i].set(s.pos.x + root.x, s.pos.y + root.y, s.pos.z + root.z, s.radius * (s.hamlet ? 1.2 : 1));
      U.uSiteP.value[i].set(s.R + s.h0, p.wet, p.dens * Math.max(0.2, lvl), p.H);
      // slightly desaturated toward a warm grey: city haze, not coloured gel
      U.uSmogA.value[i].set(p.a).lerp(_c.set('#b89a8a'), 0.3).multiplyScalar(p.k * Math.max(0.2, lvl));
      U.uSmogB.value[i].set(p.b).lerp(_c.set('#8aa0b0'), 0.3).multiplyScalar(p.k * Math.max(0.2, lvl));
      smogK = 1;
    }
    U.uN.value = n;
    U.uSmogK.value = smogK;
    this.active = n > 0 && !(civ._debug || '').includes('nofx');
  }

  render(renderer, io) {
    if (!this.active || !io.depth || !io.camera?.isPerspectiveCamera) { io.skip = true; return; }
    const U = this.U, cam = io.camera;
    U.tColor.value = io.input.texture; U.tDepth.value = io.depth;
    const P = cam.projectionMatrix.elements;
    U.uProj.value.set(P[0], P[5], P[8], P[9]);
    U.uNearFar.value.set(cam.near, cam.far);
    const w = io.input.width || 960, h = io.input.height || 540;
    U.uTexel.value.set(1 / w, 1 / h);
    U.uCamRot.value.setFromMatrix4(_m4.extractRotation(cam.matrixWorld));
    U.uCamRotInv.value.copy(U.uCamRot.value).transpose();
    U.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    this.quad.render(renderer, io.output);
  }

  dispose() { this.mat.dispose(); this.quad.dispose(); }
}
void _c;
