// Camera effects: per-pixel camera motion blur (reprojection velocity, low intensity, skipped when
// the camera is still) and a bokeh depth of field (photo mode / cinematic transitions; auto-focus
// on the screen centre, 6-blade aperture-shaped gather with foreground bleeding protection).
import * as THREE from 'three';
import { makeFullscreenMaterial } from './common.js';

const MB_FRAG = /* glsl */ `
#include <rv_common>
#include <rv_post>
uniform sampler2D tColor, tDepth;
uniform vec4 uProj, uPrevProj; uniform mat3 uCurRot, uPrevRotInv; uniform vec3 uCamDelta;
uniform float uNear, uFar, uStrength, uMaxLen; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  float d = texture2D(tDepth, vUv).r;
  vec2 prev = rvp_reproject(vUv, d, uNear, uFar, uProj, uPrevProj, uCurRot, uPrevRotInv, uCamDelta);
  vec3 c0 = texture2D(tColor, vUv).rgb;
  if (prev.x < -0.5) { gl_FragColor = vec4(c0, 1.0); return; }
  vec2 v = (vUv - prev) * uStrength;
  float len = length(v);
  if (len > uMaxLen) v *= uMaxLen / len;
  if (length(v / uTexel) < 0.75) { gl_FragColor = vec4(c0, 1.0); return; }
  float j = rv_ign(gl_FragCoord.xy) - 0.5;
  vec3 acc = c0; float wsum = 1.0;
  for (int i = 1; i <= 8; i++) {
    float t = (float(i) + j) / 8.0 - 0.5;
    vec2 uv = vUv + v * t;
    // don't smear sky/background over nearer geometry
    float ds = texture2D(tDepth, uv).r;
    float w = rvp_closer(ds, d) == ds || rvp_isSky(d) ? 1.0 : 0.3;
    acc += texture2D(tColor, uv).rgb * w; wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}`;

const DOF_FRAG = /* glsl */ `
#include <rv_common>
#include <rv_post>
uniform sampler2D tColor, tDepth;
uniform float uNear, uFar, uFocus, uAperture, uMaxCoc, uAuto; uniform vec2 uTexel; uniform float uAspect;
varying vec2 vUv;
float linAt(vec2 uv){ float d = texture2D(tDepth, uv).r; return rvp_isSky(d) ? 1e9 : rvp_linDepth(d, uNear, uFar); }
float cocAt(float lin, float focus){ return clamp(uAperture * abs(1.0 - focus / lin), 0.0, 1.0) * uMaxCoc; }
void main(){
  float focus = uFocus;
  if (uAuto > 0.5) {
    focus = min(min(linAt(vec2(0.5)), linAt(vec2(0.47, 0.5))), min(linAt(vec2(0.53, 0.5)), linAt(vec2(0.5, 0.45))));
    focus = min(focus, 5e4);
  }
  float lin = linAt(vUv);
  float coc = cocAt(lin, focus);
  vec3 c0 = texture2D(tColor, vUv).rgb;
  if (coc < 0.6) { gl_FragColor = vec4(c0, 1.0); return; }
  vec3 acc = vec3(0.0); float wsum = 0.0;
  const int N = 40;
  float rot = rv_ign(gl_FragCoord.xy) * 6.2832;
  for (int i = 0; i < N; i++) {
    float r = sqrt((float(i) + 0.5) / float(N));
    float th = float(i) * 2.39996323 + rot;
    vec2 o = vec2(cos(th), sin(th)) * r * coc;
    vec2 uv = vUv + o * uTexel;
    float sl = linAt(uv);
    float sc = cocAt(sl, focus);
    // a sample contributes if its own blur reaches us; nearer-than-focus samples always may bleed
    float w = smoothstep(r * coc - 1.0, r * coc + 1.0, sl < lin ? sc : coc);
    vec3 s = texture2D(tColor, uv).rgb;
    w *= 1.0 + rv_luma(s) * 0.15;                                  // bright bokeh
    acc += s * w; wsum += w;
  }
  gl_FragColor = vec4(wsum > 0.0 ? acc / wsum : c0, 1.0);
}`;

export class CameraFX {
  constructor() {
    this.mbMat = makeFullscreenMaterial(MB_FRAG, {
      tColor: { value: null }, tDepth: { value: null },
      uProj: { value: new THREE.Vector4() }, uPrevProj: { value: new THREE.Vector4() },
      uCurRot: { value: new THREE.Matrix3() }, uPrevRotInv: { value: new THREE.Matrix3() }, uCamDelta: { value: new THREE.Vector3() },
      uNear: { value: 0.1 }, uFar: { value: 1e9 }, uStrength: { value: 0.35 }, uMaxLen: { value: 0.035 }, uTexel: { value: new THREE.Vector2() },
    });
    this.dofMat = makeFullscreenMaterial(DOF_FRAG, {
      tColor: { value: null }, tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 1e9 },
      uFocus: { value: 10 }, uAperture: { value: 1 }, uMaxCoc: { value: 10 }, uAuto: { value: 1 },
      uTexel: { value: new THREE.Vector2() }, uAspect: { value: 1 },
    });
  }

  motionBlur(renderer, quad, srcTex, depthTex, outRT, motion, strength, w, h) {
    const u = this.mbMat.uniforms;
    u.tColor.value = srcTex; u.tDepth.value = depthTex;
    u.uProj.value.copy(motion.proj); u.uPrevProj.value.copy(motion.prevProj);
    u.uCurRot.value.copy(motion.curRot); u.uPrevRotInv.value.copy(motion.prevRotInv); u.uCamDelta.value.copy(motion.camDelta);
    u.uNear.value = motion.near; u.uFar.value = motion.far; u.uStrength.value = strength;
    u.uTexel.value.set(1 / w, 1 / h);
    quad.draw(renderer, this.mbMat, outRT);
  }

  dof(renderer, quad, srcTex, depthTex, outRT, motion, s, w, h) {
    const u = this.dofMat.uniforms;
    u.tColor.value = srcTex; u.tDepth.value = depthTex;
    u.uNear.value = motion.near; u.uFar.value = motion.far;
    u.uAuto.value = s.focus > 0 ? 0 : 1; u.uFocus.value = s.focus > 0 ? s.focus : 10;
    u.uAperture.value = s.aperture ?? 1; u.uMaxCoc.value = (s.maxCoc ?? 12) * (h / 1080);
    u.uTexel.value.set(1 / w, 1 / h); u.uAspect.value = w / h;
    quad.draw(renderer, this.dofMat, outRT);
  }

  dispose() { this.mbMat.dispose(); this.dofMat.dispose(); }
}
