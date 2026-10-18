// Ground-truth-style ambient occlusion (effect order 50, system mode, q.ssao tiers).
//
//   depth (full, reversed-Z float) → half-res linear depth
//   → GTAO at half res: horizon search in 2-4 screen-space slices, cosine-weighted visibility,
//     per-pixel + per-frame rotated slices (TAA integrates the noise) → AO + depth
//   → 4x4 depth-aware blur (half res)
//   → full-res bilateral upsample applied to the HDR colour (multi-bounce tinted, sky skipped,
//     faded with distance so far terrain keeps its aerial perspective).
import * as THREE from 'three';
import { makeFullscreenMaterial } from './common.js';

const DEPTH_FRAG = /* glsl */ `
#include <rv_post>
uniform sampler2D tDepth; uniform vec2 uTexel; uniform float uNear, uFar;
varying vec2 vUv;
void main(){
  // checkerboard-free: closest of the 2x2 footprint keeps thin foreground detail
  float d0 = texture2D(tDepth, vUv + vec2(-0.25, -0.25) * uTexel).r;
  float d1 = texture2D(tDepth, vUv + vec2( 0.25,  0.25) * uTexel).r;
  float d = rvp_closer(d0, d1);
  float lin = rvp_isSky(d) ? 1e12 : rvp_linDepth(d, uNear, uFar);
  gl_FragColor = vec4(lin, 0.0, 0.0, 1.0);
}`;

const AO_FRAG = /* glsl */ `
#include <rv_common>
#include <rv_post>
uniform sampler2D tLin; uniform vec2 uTexel; uniform vec2 uRes;
uniform vec4 uProj; uniform float uRadius, uFrame, uFadeFar, uMaxPx;
varying vec2 vUv;
#ifndef SLICES
#define SLICES 2
#endif
#ifndef STEPS
#define STEPS 4
#endif
vec3 vpos(vec2 uv){ float l = texture2D(tLin, uv).r; return rvp_viewPos(uv, l, uProj); }
void main(){
  float lin = texture2D(tLin, vUv).r;
  if (lin > 1e11 || lin > uFadeFar) { gl_FragColor = vec4(1.0, lin, 0.0, 1.0); return; }
  vec3 P = rvp_viewPos(vUv, lin, uProj);
  // normal from the smaller of the one-sided depth differences (no halos at silhouettes)
  vec3 pr = vpos(vUv + vec2(uTexel.x, 0.0)), pl = vpos(vUv - vec2(uTexel.x, 0.0));
  vec3 pu = vpos(vUv + vec2(0.0, uTexel.y)), pd = vpos(vUv - vec2(0.0, uTexel.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  vec3 V = normalize(-P);
  if (dot(N, V) < 0.0) N = -N;

  // world radius grows gently with distance so mid-ground rocks/buildings still ground themselves
  float R = uRadius * clamp(1.0 + lin * 0.012, 1.0, 5.0);
  float pxR = R * uProj.y * 0.5 * uRes.y / lin;          // radius in half-res pixels
  pxR = min(pxR, uMaxPx);
  if (pxR < 1.0) { gl_FragColor = vec4(1.0, lin, 0.0, 1.0); return; }
  float stepPx = pxR / float(STEPS);

  float noise = rv_ign(gl_FragCoord.xy + vec2(mod(uFrame, 8.0) * 5.588, mod(uFrame, 8.0) * 3.231));
  float jit = fract(noise + 0.618 * mod(uFrame, 16.0));
  float ao = 0.0;
  for (int s = 0; s < SLICES; s++) {
    float phi = (float(s) + noise) * RV_PI / float(SLICES);
    vec2 dir = vec2(cos(phi), sin(phi));
    // slice plane basis
    vec3 dirV = normalize(vec3(dir, 0.0));
    vec3 orthoDir = dirV - dot(dirV, V) * V;
    vec3 axis = normalize(cross(orthoDir, V));
    vec3 projN = N - axis * dot(N, axis);
    float projNLen = max(length(projN), 1e-4);
    float cosN = clamp(dot(projN, V) / projNLen, -1.0, 1.0);
    float n = sign(dot(orthoDir, projN)) * acos(cosN);
    float low0 = cos(n + RV_PI * 0.5), low1 = cos(n - RV_PI * 0.5);
    float h0 = low0, h1 = low1;
    for (int k = 0; k < STEPS; k++) {
      float t = (float(k) + jit) * stepPx + 1.0;
      vec2 o = dir * t * uTexel;
      vec3 s0 = vpos(vUv + o) - P, s1 = vpos(vUv - o) - P;
      float l0 = length(s0), l1 = length(s1);
      float f0 = clamp(1.0 - (l0 * l0) / (R * R), 0.0, 1.0);
      float f1 = clamp(1.0 - (l1 * l1) / (R * R), 0.0, 1.0);
      h0 = max(h0, mix(low0, dot(s0, V) / max(l0, 1e-4), f0));
      h1 = max(h1, mix(low1, dot(s1, V) / max(l1, 1e-4), f1));
    }
    float a0 = -acos(clamp(h1, -1.0, 1.0)), a1 = acos(clamp(h0, -1.0, 1.0));
    a0 = n + max(a0 - n, -RV_PI * 0.5);
    a1 = n + min(a1 - n, RV_PI * 0.5);
    float sn = sin(n);
    float v = 0.25 * (-cos(2.0 * a0 - n) + cosN + 2.0 * a0 * sn) + 0.25 * (-cos(2.0 * a1 - n) + cosN + 2.0 * a1 * sn);
    ao += projNLen * v;
  }
  ao = clamp(ao / float(SLICES), 0.0, 1.0);
  gl_FragColor = vec4(ao, lin, 0.0, 1.0);
}`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  vec2 c = texture2D(tAO, vUv).rg;
  float sum = 0.0, wsum = 0.0;
  for (int y = -1; y <= 2; y++) for (int x = -1; x <= 2; x++) {
    vec2 s = texture2D(tAO, vUv + (vec2(float(x), float(y)) - 0.5) * uTexel).rg;
    float w = 1.0 / (1e-3 + abs(s.g - c.g) / max(c.g, 1e-3) * 40.0);
    w = min(w, 1.0);
    sum += s.r * w; wsum += w;
  }
  gl_FragColor = vec4(sum / max(wsum, 1e-4), c.g, 0.0, 1.0);
}`;

const APPLY_FRAG = /* glsl */ `
#include <rv_common>
#include <rv_post>
uniform sampler2D tColor, tAO, tDepth; uniform vec2 uAOTexel;
uniform float uNear, uFar, uIntensity, uFadeNear, uFadeFar, uDebug;
varying vec2 vUv;
void main(){
  vec4 col = texture2D(tColor, vUv);
  float d = texture2D(tDepth, vUv).r;
  if (rvp_isSky(d)) { gl_FragColor = col; return; }
  float lin = rvp_linDepth(d, uNear, uFar);
  if (lin > uFadeFar) { gl_FragColor = col; return; }
  // bilateral upsample: 4 nearest half-res texels weighted by depth similarity
  vec2 base = vUv / uAOTexel - 0.5;
  vec2 f = fract(base);
  vec2 t0 = (floor(base) + 0.5) * uAOTexel;
  float sum = 0.0, wsum = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 s = texture2D(tAO, t0 + vec2(float(i), float(j)) * uAOTexel).rg;
    float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
    float dw = 1.0 / (1e-3 + abs(s.g - lin) / lin * 30.0);
    float w = bw * min(dw, 1.0) + 1e-5;
    sum += s.r * w; wsum += w;
  }
  float ao = sum / wsum;
  // multi-bounce (Jimenez 2016) with albedo guessed from the lit colour, and intensity curve
  vec3 alb = clamp(col.rgb / max(rv_luma(col.rgb) * 2.5, 0.25), 0.0, 0.9);
  ao = pow(ao, uIntensity);
  vec3 a = 2.0404 * alb - 0.3324, b = -4.7951 * alb + 0.6417, c = 2.7552 * alb + 0.6903;
  vec3 aoc = max(vec3(ao), ((ao * a + b) * ao + c) * ao);
  float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, lin);
  aoc = mix(vec3(1.0), aoc, fade);
  if (uDebug > 0.5) { gl_FragColor = vec4(aoc, 1.0); return; }
  gl_FragColor = vec4(col.rgb * aoc, col.a);
}`;

export class SSAO {
  constructor(w, h, tier) {
    const hi = tier === 'ultra';
    this.hw = Math.max(1, w >> 1); this.hh = Math.max(1, h >> 1);
    const opt = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false };
    const optF = { ...opt, type: THREE.FloatType };
    this.linRT = new THREE.WebGLRenderTarget(this.hw, this.hh, optF);
    this.aoRT = new THREE.WebGLRenderTarget(this.hw, this.hh, optF);
    this.blurRT = new THREE.WebGLRenderTarget(this.hw, this.hh, optF);
    this.depthMat = makeFullscreenMaterial(DEPTH_FRAG, {
      tDepth: { value: null }, uTexel: { value: new THREE.Vector2(1 / w, 1 / h) }, uNear: { value: 0.1 }, uFar: { value: 1e9 },
    });
    this.aoMat = makeFullscreenMaterial(AO_FRAG, {
      tLin: { value: this.linRT.texture }, uTexel: { value: new THREE.Vector2(1 / this.hw, 1 / this.hh) },
      uRes: { value: new THREE.Vector2(this.hw, this.hh) }, uProj: { value: new THREE.Vector4() },
      uRadius: { value: 1.6 }, uFrame: { value: 0 }, uFadeFar: { value: 900 }, uMaxPx: { value: hi ? 64 : 40 },
    }, { defines: { SLICES: hi ? 3 : 2, STEPS: hi ? 6 : 4 } });
    this.blurMat = makeFullscreenMaterial(BLUR_FRAG, { tAO: { value: this.aoRT.texture }, uTexel: { value: new THREE.Vector2(1 / this.hw, 1 / this.hh) } });
    this.applyMat = makeFullscreenMaterial(APPLY_FRAG, {
      tColor: { value: null }, tAO: { value: this.blurRT.texture }, tDepth: { value: null },
      uAOTexel: { value: new THREE.Vector2(1 / this.hw, 1 / this.hh) },
      uNear: { value: 0.1 }, uFar: { value: 1e9 }, uIntensity: { value: 1.2 }, uFadeNear: { value: 350 }, uFadeFar: { value: 900 }, uDebug: { value: 0 },
    });
  }

  setSize(w, h) {
    this.hw = Math.max(1, w >> 1); this.hh = Math.max(1, h >> 1);
    this.linRT.setSize(this.hw, this.hh); this.aoRT.setSize(this.hw, this.hh); this.blurRT.setSize(this.hw, this.hh);
    this.depthMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.aoMat.uniforms.uTexel.value.set(1 / this.hw, 1 / this.hh);
    this.aoMat.uniforms.uRes.value.set(this.hw, this.hh);
    this.blurMat.uniforms.uTexel.value.set(1 / this.hw, 1 / this.hh);
    this.applyMat.uniforms.uAOTexel.value.set(1 / this.hw, 1 / this.hh);
  }

  render(renderer, quad, srcTex, depthTex, outRT, motion, s, frame) {
    const near = motion.near, far = motion.far;
    const dm = this.depthMat.uniforms;
    dm.tDepth.value = depthTex; dm.uNear.value = near; dm.uFar.value = far;
    quad.draw(renderer, this.depthMat, this.linRT);
    const am = this.aoMat.uniforms;
    am.uProj.value.copy(motion.proj); am.uRadius.value = s.radius ?? 1.6; am.uFrame.value = frame;
    am.uFadeFar.value = s.fadeFar ?? 900;
    quad.draw(renderer, this.aoMat, this.aoRT);
    quad.draw(renderer, this.blurMat, this.blurRT);
    const ap = this.applyMat.uniforms;
    ap.tColor.value = srcTex; ap.tDepth.value = depthTex; ap.uNear.value = near; ap.uFar.value = far;
    ap.uIntensity.value = s.intensity ?? 1.2; ap.uFadeNear.value = (s.fadeFar ?? 900) * 0.4; ap.uFadeFar.value = s.fadeFar ?? 900;
    ap.uDebug.value = s.debug ? 1 : 0;
    quad.draw(renderer, this.applyMat, outRT);
  }

  dispose() {
    this.linRT.dispose(); this.aoRT.dispose(); this.blurRT.dispose();
    this.depthMat.dispose(); this.aoMat.dispose(); this.blurMat.dispose(); this.applyMat.dispose();
  }
}
