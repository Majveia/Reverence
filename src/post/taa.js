// Temporal anti-aliasing (high/ultra).
//
//  * Halton(2,3) sub-pixel jitter applied to the camera projection matrix for the scene pass AND the
//    HDR effects (atmosphere/clouds reconstruct rays from the same jittered matrix, so sky and
//    geometry stay consistent); restored before post.
//  * Reprojection of the history with scene depth + camera motion (rotation and translation,
//    floating-origin aware) using the closest depth of a 3x3 neighbourhood (edge dilation).
//  * Catmull-Rom (5 bilinear taps) history fetch, YCoCg variance clipping in a Karis-tonemapped
//    space (no fireflies, minimal ghosting), motion- and disocclusion-adaptive feedback.
//  * Shot mode (deterministic stills): when the history is not valid the pipeline renders N
//    jittered sub-frames of the same instant and this pass accumulates them unclipped — exactly
//    what a converged TAA shows when the camera holds still.
import * as THREE from 'three';
import { makeFullscreenMaterial, hdrRT } from './common.js';

const FRAG = /* glsl */ `
#include <rv_common>
#include <rv_post>
uniform sampler2D tCur, tHist, tDepth;
uniform vec2 uTexel;
uniform vec4 uProj, uPrevProj;
uniform mat3 uCurRot, uPrevRotInv;
uniform vec3 uCamDelta;
uniform float uNear, uFar, uFeedback, uReset, uAccum, uGamma;
varying vec2 vUv;

vec3 toYCoCg(vec3 c){ return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25))); }
vec3 fromYCoCg(vec3 c){ return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
// Karis tonemap (reversible) so HDR fireflies don't dominate the blend
vec3 tm(vec3 c){ return c / (1.0 + max(max(c.r, c.g), c.b)); }
vec3 itm(vec3 c){ return c / max(1.0 - max(max(c.r, c.g), c.b), 1e-4); }

vec3 fetchCur(vec2 uv){ return tm(max(texture2D(tCur, uv).rgb, 0.0)); }

// Catmull-Rom history (5 bilinear taps, corners dropped)
vec3 historyCR(vec2 uv){
  vec2 texSize = 1.0 / uTexel;
  vec2 sp = uv * texSize;
  vec2 tp = floor(sp - 0.5) + 0.5;
  vec2 f = sp - tp;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 tc12 = (tp + w2 / w12) * uTexel;
  vec2 tc0 = (tp - 1.0) * uTexel;
  vec2 tc3 = (tp + 2.0) * uTexel;
  vec3 r = texture2D(tHist, vec2(tc12.x, tc0.y)).rgb * (w12.x * w0.y)
         + texture2D(tHist, vec2(tc0.x, tc12.y)).rgb * (w0.x * w12.y)
         + texture2D(tHist, tc12).rgb * (w12.x * w12.y)
         + texture2D(tHist, vec2(tc3.x, tc12.y)).rgb * (w3.x * w12.y)
         + texture2D(tHist, vec2(tc12.x, tc3.y)).rgb * (w12.x * w3.y);
  float ws = (w12.x * w0.y) + (w0.x * w12.y) + (w12.x * w12.y) + (w3.x * w12.y) + (w12.x * w3.y);
  return max(r / ws, 0.0);
}

vec3 clipAABB(vec3 mn, vec3 mx, vec3 p, vec3 q){
  vec3 c = 0.5 * (mx + mn), e = 0.5 * (mx - mn) + 1e-5;
  vec3 v = q - c;
  vec3 a = abs(v / e);
  float m = max(a.x, max(a.y, a.z));
  return m > 1.0 ? c + v / m : q;
}

void main(){
  vec3 cur = fetchCur(vUv);
  if (uReset > 0.5) { gl_FragColor = vec4(itm(cur), 1.0); return; }
  if (uAccum > 0.0) {
    // shot-mode supersampling: plain running average of jittered sub-frames of a frozen instant
    vec3 h = tm(texture2D(tHist, vUv).rgb);
    gl_FragColor = vec4(itm(mix(h, cur, uAccum)), 1.0);
    return;
  }
  // neighbourhood statistics (3x3) + closest depth for velocity dilation
  vec3 m1 = vec3(0.0), m2 = vec3(0.0), mn = vec3(1e9), mx = vec3(-1e9);
  float dClose = texture2D(tDepth, vUv).r;
  vec2 dUv = vUv;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y)) * uTexel;
    vec3 c = toYCoCg(x == 0 && y == 0 ? cur : fetchCur(vUv + o));
    m1 += c; m2 += c * c; mn = min(mn, c); mx = max(mx, c);
    if (abs(x) + abs(y) == 2) {
      float d = texture2D(tDepth, vUv + o).r;
      float cd = rvp_closer(d, dClose);
      if (cd != dClose) { dClose = cd; dUv = vUv + o; }
    }
  }
  m1 /= 9.0; m2 /= 9.0;
  vec3 sigma = sqrt(max(m2 - m1 * m1, 0.0));
  vec3 bmn = max(mn, m1 - uGamma * sigma), bmx = min(mx, m1 + uGamma * sigma);

  vec2 prevUv = rvp_reproject(dUv, dClose, uNear, uFar, uProj, uPrevProj, uCurRot, uPrevRotInv, uCamDelta);
  prevUv += vUv - dUv;
  bool off = any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)));
  if (off) { gl_FragColor = vec4(itm(cur), 1.0); return; }

  vec3 hist = toYCoCg(tm(historyCR(prevUv)));
  vec3 curY = toYCoCg(cur);
  vec3 clipped = clipAABB(bmn, bmx, m1, hist);
  // velocity in pixels: moving content gets more of the current frame (less blur, less ghosting)
  vec2 velPx = (vUv - prevUv) / uTexel;
  float speed = length(velPx);
  float fb = mix(uFeedback, 0.5, clamp(speed / 40.0, 0.0, 1.0));
  // anti-flicker: when history was clipped a lot, trust current more
  float clipAmt = length(hist - clipped) / max(1e-3, clipped.x + 0.05);
  fb = mix(fb, 0.35, clamp(clipAmt * 0.5, 0.0, 0.6));
  // luminance-weighted blend (reduces shimmer of small bright details)
  float wc = (1.0 - fb) / (1.0 + curY.x);
  float wh = fb / (1.0 + clipped.x);
  vec3 res = (curY * wc + clipped * wh) / (wc + wh);
  gl_FragColor = vec4(itm(max(fromYCoCg(res), 0.0)), 1.0);
}`;

function halton(i, b) { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }

export class TAA {
  constructor(w, h) {
    this.jitters = [];
    for (let i = 1; i <= 16; i++) this.jitters.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
    this.index = 0;
    this.a = hdrRT(w, h); this.b = hdrRT(w, h);
    this.w = w; this.h = h;
    this.valid = false;       // history holds a usable previous frame
    this.age = 0;             // frames accumulated since last reset
    this.jx = 0; this.jy = 0;
    this._saved = new Float64Array(16);
    this._savedInv = new Float64Array(16);
    this._jit = new Float64Array(16);
    this.mat = makeFullscreenMaterial(FRAG, {
      tCur: { value: null }, tHist: { value: null }, tDepth: { value: null },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uProj: { value: new THREE.Vector4() }, uPrevProj: { value: new THREE.Vector4() },
      uCurRot: { value: new THREE.Matrix3() }, uPrevRotInv: { value: new THREE.Matrix3() },
      uCamDelta: { value: new THREE.Vector3() },
      uNear: { value: 0.1 }, uFar: { value: 1e9 },
      uFeedback: { value: 0.9 }, uReset: { value: 1 }, uAccum: { value: 0 }, uGamma: { value: 1.1 },
    });
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    this.a.setSize(w, h); this.b.setSize(w, h);
    this.mat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.valid = false; this.age = 0;
  }

  /** Apply the next sub-pixel jitter to the camera projection (call restore() afterwards). */
  jitter(camera, scale = 1) {
    const j = this.jitters[this.index % this.jitters.length];
    this.index++;
    this.jx = j[0] * scale; this.jy = j[1] * scale;
    const p = camera.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) this._saved[i] = p[i];
    for (let i = 0; i < 16; i++) this._savedInv[i] = camera.projectionMatrixInverse.elements[i];
    p[8] += (2 * this.jx) / this.w;
    p[9] += (2 * this.jy) / this.h;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    for (let i = 0; i < 16; i++) this._jit[i] = p[i];
    this._jittered = camera;
  }

  restore() {
    const c = this._jittered;
    if (!c) return;
    const p = c.projectionMatrix.elements, pi = c.projectionMatrixInverse.elements;
    this._jittered = null;
    // If anything recomputed the projection meanwhile (three switches cameras to reversed-Z with
    // updateProjectionMatrix() on first use; fov/zoom changes), the new matrix is already unjittered.
    for (let i = 0; i < 16; i++) if (p[i] !== this._jit[i]) return;
    for (let i = 0; i < 16; i++) { p[i] = this._saved[i]; pi[i] = this._savedInv[i]; }
  }

  /**
   * Resolve `src` (HDR) against history; returns the resolved RT (also the new history).
   * motion = { proj, prevProj, curRot, prevRotInv, camDelta, near, far } (from Pipeline)
   * accum > 0: shot-mode running average weight (1/(n+1)).
   */
  resolve(renderer, quad, srcTex, depthTex, motion, { reset = false, accum = 0, feedback = 0.9 } = {}) {
    const u = this.mat.uniforms;
    const out = this.a;
    u.tCur.value = srcTex; u.tHist.value = this.b.texture; u.tDepth.value = depthTex;
    u.uProj.value.copy(motion.proj); u.uPrevProj.value.copy(motion.prevProj);
    u.uCurRot.value.copy(motion.curRot); u.uPrevRotInv.value.copy(motion.prevRotInv);
    u.uCamDelta.value.copy(motion.camDelta);
    u.uNear.value = motion.near; u.uFar.value = motion.far;
    u.uReset.value = (reset || !this.valid) ? 1 : 0;
    u.uAccum.value = accum;
    u.uFeedback.value = feedback;
    quad.draw(renderer, this.mat, out);
    // swap: `a` is always the write target, `b` the history
    this.a = this.b; this.b = out;
    this.age = (reset || !this.valid) ? 1 : this.age + 1;
    this.valid = true;
    return out;
  }

  invalidate() { this.valid = false; this.age = 0; }

  dispose() { this.a.dispose(); this.b.dispose(); this.mat.dispose(); }
}
