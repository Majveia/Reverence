// Camera effects: per-pixel camera motion blur (reprojection velocity, low intensity, skipped when
// the camera is still) and a bokeh depth of field (photo mode / cinematic transitions; auto-focus
// on the screen centre, 6-blade aperture-shaped gather with foreground bleeding protection).
import * as THREE from 'three';
import { makeFullscreenMaterial, hdrRT } from './common.js';

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

// ---- depth of field: half-res scatter-as-gather bokeh (COD/Gustafsson style)
//   prep  (half res): colour (4-tap average, highlights kept) + signed CoC in half-res px (A; < 0 = near)
//   tiles (1/16 res): max near-field CoC per tile (so sharp pixels behind a blurry foreground gather it)
//   gather(half res): 61-tap Vogel disc scaled to max(own CoC, dilated near CoC); a sample counts where
//                     its own CoC reaches this pixel in a HEXAGONAL metric (6-blade aperture → hexagonal
//                     bokeh), background samples may not blur more than 2x the centre (no background
//                     bleeding onto sharp midground), highlights are weighted up so bright points
//                     resolve into discs (lens bokeh) instead of a gaussian wash.
//   post  (half res): 3x3 hole-filling tent on the gathered result
//   merge (full res): sharp ↔ bokeh by full-res CoC / foreground coverage (no halo at focus edges)
const DOF_COMMON = /* glsl */ `
#include <rv_common>
#include <rv_post>
uniform float uNear, uFar, uFocus, uAperture, uMaxCoc, uAuto;
float linAt(sampler2D d, vec2 uv){ float z = texture2D(d, uv).r; return rvp_isSky(z) ? 1e9 : rvp_linDepth(z, uNear, uFar); }
float focusDist(sampler2D d){
  if (uAuto < 0.5) return uFocus;
  // auto-focus: nearest of a small centre cross (the subject), capped
  float f = min(min(linAt(d, vec2(0.5)), linAt(d, vec2(0.47, 0.5))), min(linAt(d, vec2(0.53, 0.5)), linAt(d, vec2(0.5, 0.45))));
  f = min(f, linAt(d, vec2(0.5, 0.42)));
  return min(f, 5e4);
}
// signed circle of confusion in units of uMaxCoc-scaled pixels (thin lens: ∝ |1 - focus/d|)
float cocOf(float lin, float focus){
  float c = uAperture * (1.0 - focus / max(lin, 1e-3));
  return clamp(c, -1.0, 1.0) * uMaxCoc;
}
`;

const DOF_PREP_FRAG = /* glsl */ `
${DOF_COMMON}
uniform sampler2D tColor, tDepth; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  float focus = focusDist(tDepth);
  vec3 c = vec3(0.0); float coc = 0.0, nearC = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 || i == 2 ? -0.5 : 0.5, i < 2 ? -0.5 : 0.5) * uTexel;
    c += min(texture2D(tColor, vUv + o).rgb, vec3(6.0e4));
    float k = cocOf(linAt(tDepth, vUv + o), focus);
    coc += k; nearC = min(nearC, k);
  }
  coc *= 0.25;
  // near field wins inside the 2x2 footprint (thin foreground stays blurred at its edges)
  if (nearC < -0.5) coc = min(coc, nearC);
  gl_FragColor = vec4(c * 0.25, coc);
}`;

const DOF_TILE_FRAG = /* glsl */ `
uniform sampler2D tPrep; uniform vec2 uTexel;   // texel of the half-res prep target
varying vec2 vUv;
void main(){
  float m = 0.0;
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
    vec2 o = (vec2(float(x), float(y)) - 3.5) * uTexel;
    m = max(m, -texture2D(tPrep, vUv + o).a);
  }
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}`;

const DOF_GATHER_FRAG = /* glsl */ `
#include <rv_common>
uniform sampler2D tPrep, tTile, tAdapt; uniform vec2 uTexel, uTileTexel; uniform float uBokeh, uBokehT, uHasAdapt;
varying vec2 vUv;
float hexLen(vec2 p){ p = abs(p); return max(p.x * 0.866025 + p.y * 0.5, p.y); }
void main(){
  vec4 c0 = texture2D(tPrep, vUv);
  float cc = c0.a;
  // dilated near-field CoC (3x3 tiles)
  float nearMax = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++)
    nearMax = max(nearMax, texture2D(tTile, vUv + vec2(float(x), float(y)) * uTileTexel).r);
  float R = max(abs(cc), nearMax);
  if (R < 0.5) { gl_FragColor = vec4(c0.rgb, 0.0); return; }
  // highlight threshold relative to the eye-adapted mean luminance (else absolute)
  float bt = uHasAdapt > 0.5 ? exp2(texture2D(tAdapt, vec2(0.5)).r) * uBokehT : uBokehT;
  float lc = rv_luma(c0.rgb);
  float w0 = 1.0 + uBokeh * smoothstep(bt, bt * 6.0, lc);
  vec3 acc = c0.rgb * w0; float wsum = w0;
  float fg = 0.0, fgN = 0.0;
  const int N = 61;
  float rot = rv_ign(gl_FragCoord.xy) * 6.2832;
  for (int i = 0; i < N; i++) {
    float r = sqrt((float(i) + 0.5) / float(N));
    float th = float(i) * 2.39996323 + rot;
    vec2 o = vec2(cos(th), sin(th)) * r * R;
    vec4 s = texture2D(tPrep, vUv + o * uTexel);
    float d = hexLen(o) * 1.08;                               // hexagonal aperture
    float sc = s.a;
    float size = abs(sc);
    if (sc > cc) size = min(size, abs(cc) * 2.0);              // farther: no bleeding onto sharp midground
    float w = smoothstep(d - 0.75, d + 0.25, size);
    float near = step(sc, -0.5) * w;
    fg += near; fgN += 1.0;
    float l = rv_luma(s.rgb);
    w *= 1.0 + uBokeh * smoothstep(bt, bt * 6.0, l);  // bright points → visible bokeh discs
    acc += s.rgb * w; wsum += w;
  }
  // alpha: how blurred this pixel is (own CoC or covering foreground), in half-res px
  float a = max(abs(cc), nearMax * clamp(fg / max(fgN, 1.0) * 3.0, 0.0, 1.0));
  gl_FragColor = vec4(acc / wsum, a);
}`;

const DOF_POST_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  vec4 c = texture2D(tSrc, vUv);
  // hole filling only where blurred: 3x3 tent
  if (c.a < 1.0) { gl_FragColor = c; return; }
  vec4 s = c * 4.0;
  s += (texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)) + texture2D(tSrc, vUv - vec2(uTexel.x, 0.0))
      + texture2D(tSrc, vUv + vec2(0.0, uTexel.y)) + texture2D(tSrc, vUv - vec2(0.0, uTexel.y))) * 2.0;
  s += texture2D(tSrc, vUv + uTexel) + texture2D(tSrc, vUv - uTexel)
     + texture2D(tSrc, vUv + vec2(uTexel.x, -uTexel.y)) + texture2D(tSrc, vUv + vec2(-uTexel.x, uTexel.y));
  gl_FragColor = vec4(s.rgb / 16.0, c.a);
}`;

const DOF_MERGE_FRAG = /* glsl */ `
${DOF_COMMON}
uniform sampler2D tColor, tDepth, tBokeh;
varying vec2 vUv;
void main(){
  vec3 sharp = texture2D(tColor, vUv).rgb;
  vec4 b = texture2D(tBokeh, vUv);
  float coc = abs(cocOf(linAt(tDepth, vUv), focusDist(tDepth)));   // half-res px
  float k = smoothstep(0.35, 1.25, max(coc, b.a));
  gl_FragColor = vec4(mix(sharp, b.rgb, k), 1.0);
}`;

export class CameraFX {
  constructor() {
    this.mbMat = makeFullscreenMaterial(MB_FRAG, {
      tColor: { value: null }, tDepth: { value: null },
      uProj: { value: new THREE.Vector4() }, uPrevProj: { value: new THREE.Vector4() },
      uCurRot: { value: new THREE.Matrix3() }, uPrevRotInv: { value: new THREE.Matrix3() }, uCamDelta: { value: new THREE.Vector3() },
      uNear: { value: 0.1 }, uFar: { value: 1e9 }, uStrength: { value: 0.35 }, uMaxLen: { value: 0.035 }, uTexel: { value: new THREE.Vector2() },
    });
    const du = () => ({ uNear: { value: 0.1 }, uFar: { value: 1e9 }, uFocus: { value: 10 }, uAperture: { value: 1 }, uMaxCoc: { value: 10 }, uAuto: { value: 1 } });
    this.dofPrep = makeFullscreenMaterial(DOF_PREP_FRAG, { tColor: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, ...du() });
    this.dofTile = makeFullscreenMaterial(DOF_TILE_FRAG, { tPrep: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.dofGather = makeFullscreenMaterial(DOF_GATHER_FRAG, { tPrep: { value: null }, tTile: { value: null }, uTexel: { value: new THREE.Vector2() }, uTileTexel: { value: new THREE.Vector2() }, uBokeh: { value: 3 }, uBokehT: { value: 1 }, tAdapt: { value: null }, uHasAdapt: { value: 0 } });
    this.dofPost = makeFullscreenMaterial(DOF_POST_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.dofMerge = makeFullscreenMaterial(DOF_MERGE_FRAG, { tColor: { value: null }, tDepth: { value: null }, tBokeh: { value: null }, ...du() });
    this._dofRT = null;
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

  _dofTargets(w, h) {
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const tw = Math.max(1, Math.ceil(hw / 8)), th = Math.max(1, Math.ceil(hh / 8));
    let t = this._dofRT;
    if (!t) {
      t = this._dofRT = { prep: hdrRT(hw, hh), gather: hdrRT(hw, hh), post: hdrRT(hw, hh), tile: hdrRT(tw, th, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }) };
    } else if (t.prep.width !== hw || t.prep.height !== hh) {
      t.prep.setSize(hw, hh); t.gather.setSize(hw, hh); t.post.setSize(hw, hh); t.tile.setSize(tw, th);
    }
    return t;
  }

  /** s: { focus (m, 0 = auto), aperture, maxCoc (px at 1080p), bokeh (highlight weight), bokehThreshold } */
  dof(renderer, quad, srcTex, depthTex, outRT, motion, s, w, h, adaptTex = null) {
    const t = this._dofTargets(w, h);
    const hw = t.prep.width, hh = t.prep.height;
    const maxCoc = Math.min(48, (s.maxCoc ?? 28) * (h / 1080) * 0.5);   // half-res px
    const common = (u) => {
      u.uNear.value = motion.near; u.uFar.value = motion.far;
      u.uAuto.value = s.focus > 0 ? 0 : 1; u.uFocus.value = s.focus > 0 ? s.focus : 10;
      u.uAperture.value = s.aperture ?? 1; u.uMaxCoc.value = maxCoc;
    };
    let u = this.dofPrep.uniforms;
    common(u); u.tColor.value = srcTex; u.tDepth.value = depthTex; u.uTexel.value.set(1 / w, 1 / h);
    quad.draw(renderer, this.dofPrep, t.prep);
    u = this.dofTile.uniforms;
    u.tPrep.value = t.prep.texture; u.uTexel.value.set(1 / hw, 1 / hh);
    quad.draw(renderer, this.dofTile, t.tile);
    u = this.dofGather.uniforms;
    u.tPrep.value = t.prep.texture; u.tTile.value = t.tile.texture;
    u.uTexel.value.set(1 / hw, 1 / hh); u.uTileTexel.value.set(1 / t.tile.width, 1 / t.tile.height);
    u.uBokeh.value = s.bokeh ?? 3; u.tAdapt.value = adaptTex; u.uHasAdapt.value = adaptTex ? 1 : 0;
    u.uBokehT.value = s.bokehThreshold ?? (adaptTex ? 5.0 : 1.0);
    quad.draw(renderer, this.dofGather, t.gather);
    u = this.dofPost.uniforms;
    u.tSrc.value = t.gather.texture; u.uTexel.value.set(1 / hw, 1 / hh);
    quad.draw(renderer, this.dofPost, t.post);
    u = this.dofMerge.uniforms;
    common(u); u.tColor.value = srcTex; u.tDepth.value = depthTex; u.tBokeh.value = t.post.texture;
    quad.draw(renderer, this.dofMerge, outRT);
  }

  dispose() {
    this.mbMat.dispose();
    for (const m of [this.dofPrep, this.dofTile, this.dofGather, this.dofPost, this.dofMerge]) m.dispose();
    if (this._dofRT) for (const rt of Object.values(this._dofRT)) rt.dispose();
  }
}
