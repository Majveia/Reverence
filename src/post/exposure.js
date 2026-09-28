// Auto-exposure (eye adaptation), fully on the GPU (no read-backs).
//
//   HDR → 64x64 metering grid: centre-weighted log2 luminance, pixels darker than the floor
//         (OLED-black space, night voids) are EXCLUDED so a lit planet on black isn't blown out
//   → 16x16 → 4x4 → 1x1 averages (weighted, RG = Σw·log2L, Σw)
//   → 1x1 adaptation ping-pong: asymmetric exponential smoothing in log space (fast to bright,
//     slower to dark, like the eye); instant snap when the pipeline says history is invalid.
// The composite samples the adapted log-luminance and derives
//   exposure = settings.exposure · clamp(key / adapted, min, max) · 2^compensation.
import * as THREE from 'three';
import { makeFullscreenMaterial } from './common.js';

const METER_FRAG = /* glsl */ `
#include <rv_common>
uniform sampler2D tSrc; uniform float uFloor;
varying vec2 vUv;
void main(){
  // 4 bilinear taps inside this 1/64 cell
  vec2 cell = vec2(1.0 / 64.0);
  vec3 c = texture2D(tSrc, vUv + cell * vec2(-0.25, -0.25)).rgb + texture2D(tSrc, vUv + cell * vec2(0.25, -0.25)).rgb
         + texture2D(tSrc, vUv + cell * vec2(-0.25, 0.25)).rgb + texture2D(tSrc, vUv + cell * vec2(0.25, 0.25)).rgb;
  float L = rv_luma(max(c * 0.25, 0.0));
  L = min(L, 6.0e4);
  vec2 d = (vUv - 0.5) * vec2(1.6, 1.0);
  float w = exp(-dot(d, d) * 3.0) + 0.15;                     // centre-weighted
  w *= smoothstep(uFloor, uFloor * 4.0, L);                    // ignore black space / voids
  gl_FragColor = vec4(w * log2(max(L, 1e-6)), w, 0.0, 1.0);
}`;

const REDUCE_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  // 4x4 source texels via 4 bilinear taps
  vec2 s = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rg + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rg
         + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rg + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rg;
  gl_FragColor = vec4(s * 0.25, 0.0, 1.0);
}`;

const ADAPT_FRAG = /* glsl */ `
uniform sampler2D tMeter, tPrev; uniform float uDt, uSpeedUp, uSpeedDown, uSnap, uDefault;
varying vec2 vUv;
void main(){
  vec2 m = texture2D(tMeter, vec2(0.5)).rg;
  float prev = texture2D(tPrev, vec2(0.5)).r;
  // nothing metered (all black): hold the previous value (or the default key)
  float target = m.g > 1e-5 ? m.r / m.g : (uSnap > 0.5 ? uDefault : prev);
  float cov = clamp(m.g * 4.0, 0.0, 1.0);                          // fraction of meaningful pixels
  target = mix(uDefault, target, cov);
  if (uSnap > 0.5 || prev != prev) { gl_FragColor = vec4(target, cov, 0.0, 1.0); return; }
  float sp = target > prev ? uSpeedUp : uSpeedDown;              // brighter scene → adapt faster
  float a = 1.0 - exp(-uDt * sp);
  gl_FragColor = vec4(mix(prev, target, a), cov, 0.0, 1.0);
}`;

export class AutoExposure {
  constructor() {
    const opt = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    const optN = { ...opt, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    this.m64 = new THREE.WebGLRenderTarget(64, 64, opt);
    this.m16 = new THREE.WebGLRenderTarget(16, 16, opt);
    this.m4 = new THREE.WebGLRenderTarget(4, 4, opt);
    this.m1 = new THREE.WebGLRenderTarget(1, 1, opt);
    this.adaptA = new THREE.WebGLRenderTarget(1, 1, optN);
    this.adaptB = new THREE.WebGLRenderTarget(1, 1, optN);
    this.meterMat = makeFullscreenMaterial(METER_FRAG, { tSrc: { value: null }, uFloor: { value: 0.004 } });
    this.reduceMat = makeFullscreenMaterial(REDUCE_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.adaptMat = makeFullscreenMaterial(ADAPT_FRAG, {
      tMeter: { value: this.m1.texture }, tPrev: { value: null }, uDt: { value: 0.016 },
      uSpeedUp: { value: 2.5 }, uSpeedDown: { value: 1.2 }, uSnap: { value: 1 }, uDefault: { value: -2 },
    });
    this.snap = true;
    this._px = new Uint16Array(4);
  }

  /** Current adapted texture (R = log2 luminance, G = coverage). */
  get texture() { return this.adaptB.texture; }

  update(renderer, quad, srcTex, dt, s) {
    this.meterMat.uniforms.tSrc.value = srcTex;
    this.meterMat.uniforms.uFloor.value = s.floor ?? 0.004;
    quad.draw(renderer, this.meterMat, this.m64);
    const r = this.reduceMat.uniforms;
    r.tSrc.value = this.m64.texture; r.uTexel.value.set(1 / 64, 1 / 64); quad.draw(renderer, this.reduceMat, this.m16);
    r.tSrc.value = this.m16.texture; r.uTexel.value.set(1 / 16, 1 / 16); quad.draw(renderer, this.reduceMat, this.m4);
    r.tSrc.value = this.m4.texture; r.uTexel.value.set(1 / 4, 1 / 4); quad.draw(renderer, this.reduceMat, this.m1);
    const a = this.adaptMat.uniforms;
    a.tPrev.value = this.adaptB.texture;
    a.uDt.value = Math.min(Math.max(dt, 0), 0.25);
    a.uSpeedUp.value = s.speedUp ?? 2.5; a.uSpeedDown.value = s.speedDown ?? 1.2;
    a.uSnap.value = this.snap ? 1 : 0;
    a.uDefault.value = Math.log2(s.key ?? 0.25);
    quad.draw(renderer, this.adaptMat, this.adaptA);
    const t = this.adaptA; this.adaptA = this.adaptB; this.adaptB = t;
    this.snap = false;
  }

  /** Debug read-back (slow; never per frame): { logLum, lum, coverage }. */
  read(renderer) {
    try {
      renderer.readRenderTargetPixels(this.adaptB, 0, 0, 1, 1, this._px);
      const l = THREE.DataUtils.fromHalfFloat(this._px[0]), c = THREE.DataUtils.fromHalfFloat(this._px[1]);
      return { logLum: +l.toFixed(3), lum: +Math.pow(2, l).toFixed(4), coverage: +c.toFixed(3) };
    } catch (e) { return { error: String(e) }; }
  }

  dispose() {
    for (const rt of [this.m64, this.m16, this.m4, this.m1, this.adaptA, this.adaptB]) rt.dispose();
    this.meterMat.dispose(); this.reduceMat.dispose(); this.adaptMat.dispose();
  }
}
