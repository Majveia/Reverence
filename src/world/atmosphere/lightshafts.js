// Volumetric light shafts / god rays (pipeline effect "volumetric-light", order 120).
// OWNED BY THE ATMOSPHERE TRACK.
//
// Screen-space crepuscular rays: a quarter-res mask of unoccluded sky around the key light (scene depth
// = far, × cloud transmittance from the clouds pass), radially blurred toward the light's screen
// position in two passes, added with the key light color. Strength follows the haze of the world
// (Mie + fog + dust), grows at low sun, and fades when the light leaves the screen.
import * as THREE from 'three';
import { fsMaterial, FSQuad, hdrTarget } from './fs.js';
import { G } from '../../core/Uniforms.js';

const MASK_FRAG = /* glsl */`
#include <rv_common>
#include <rv_atmo_view>
uniform sampler2D tDepth;
uniform sampler2D tClouds;
uniform float uHasClouds;
uniform vec3 uLightDir;
varying vec2 vUv;
void main(){
  float d = texture(tDepth, vUv).r;
  float sky = atmo_isFar(d) ? 1.0 : 0.0;
  if (uHasClouds > 0.5) sky *= texture(tClouds, vUv).a;
  vec3 dir = normalize(mat3(uCamWorld) * atmo_viewDir(vUv));
  float c = max(dot(dir, uLightDir), 0.0);
  float glow = pow(c, 60.0) * 1.2 + pow(c, 8.0) * 0.25;
  gl_FragColor = vec4(sky * glow, 0.0, 0.0, 1.0);
}`;

const BLUR_FRAG = /* glsl */`
#include <rv_common>
uniform sampler2D tSrc;
uniform vec2 uCenter;      // light position in uv
uniform float uLen;        // fraction of the vector to the light covered
varying vec2 vUv;
void main(){
  vec2 dv = (uCenter - vUv) * uLen / 24.0;
  float j = rv_ign(gl_FragCoord.xy);
  vec2 uv = vUv + dv * j;
  float acc = 0.0, w = 1.0, wsum = 0.0;
  for (int i = 0; i < 24; i++){
    acc += texture(tSrc, uv).r * w;
    wsum += w;
    w *= 0.955;
    uv += dv;
  }
  gl_FragColor = vec4(acc / wsum, 0.0, 0.0, 1.0);
}`;

const COMP_FRAG = /* glsl */`
uniform sampler2D tColor;
uniform sampler2D tRays;
uniform vec3 uColor;
varying vec2 vUv;
void main(){
  vec3 c = texture(tColor, vUv).rgb;
  float r = texture(tRays, vUv).r;
  gl_FragColor = vec4(c + uColor * r, 1.0);
}`;

export class LightShafts {
  constructor(atmo) {
    this.atmo = atmo;
    this.name = 'volumetric-light';
    this.order = 120;
    this.enabled = !!atmo.model.present && (atmo.world.quality.tier !== 'low');
    this.quad = new FSQuad();
    this.a = hdrTarget(4, 4); this.b = hdrTarget(4, 4);
    this.u = {
      tDepth: { value: null }, tClouds: { value: null }, uHasClouds: { value: 0 },
      uLightDir: { value: new THREE.Vector3() },
      uCamWorld: { value: new THREE.Matrix4() }, uProjParams: { value: new THREE.Vector4(1, 1, 0, 0) },
      uNear: { value: 0.05 }, uFar: { value: 2e10 },
    };
    this.maskMat = fsMaterial(MASK_FRAG, this.u);
    this.blurMat = fsMaterial(BLUR_FRAG, { tSrc: { value: null }, uCenter: { value: new THREE.Vector2() }, uLen: { value: 1 } });
    this.compMat = fsMaterial(COMP_FRAG, { tColor: { value: null }, tRays: { value: null }, uColor: { value: new THREE.Vector3() } });
    this._v = new THREE.Vector4();
    const m = atmo.model;
    // world haze → ray strength
    this.haze = THREE.MathUtils.clamp(0.35 + (m.mieExt.x * m.HM) * 12 + (m.fog || 0) * 0.8 + (m.dust || 0) * 0.8, 0.3, 1.6);
  }

  setSize(w, h) {
    const q = 4;
    this.a.setSize(Math.max(1, Math.round(w / q)), Math.max(1, Math.round(h / q)));
    this.b.setSize(Math.max(1, Math.round(w / q)), Math.max(1, Math.round(h / q)));
  }

  render(renderer, io) {
    const atmo = this.atmo;
    const cam = io.camera;
    const L = atmo.lighting;
    const keyDir = L.uniforms.uKeyDir.value;
    // light screen position (direction → far point)
    const v = this._v.set(keyDir.x, keyDir.y, keyDir.z, 0);
    v.applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    if (v.w <= 1e-4) { io.skip = true; return; }
    const sx = v.x / v.w * 0.5 + 0.5, sy = v.y / v.w * 0.5 + 0.5;
    const off = Math.max(0, Math.max(Math.abs(sx - 0.5), Math.abs(sy - 0.5)) - 0.5);
    const onScreen = 1 - THREE.MathUtils.smoothstep(off, 0.0, 0.45);
    // strength: haze × low-sun boost × weather, fades at night
    const W = atmo.weather;
    const up = _up.setFromMatrixPosition(cam.matrixWorld).add(atmo.world.origin).normalize();
    const elev = up.dot(keyDir);
    const lowSun = 0.55 + 0.9 * (1 - THREE.MathUtils.smoothstep(elev, 0.05, 0.6));
    const kc = L.uniforms.uKeyColor.value;
    const strength = onScreen * this.haze * lowSun * (1 + (W.fog || 0) * 0.8 + (W.dust || 0)) * THREE.MathUtils.smoothstep(elev, -0.06, 0.03) * (L.keyIsMoon ? 0.35 : 1);
    if (strength < 0.01 || !(kc.r + kc.g + kc.b > 1e-4)) { io.skip = true; return; }
    const u = this.u, p = cam.projectionMatrix.elements;
    u.uCamWorld.value.copy(cam.matrixWorld);
    u.uProjParams.value.set(p[0], p[5], p[8], p[9]);
    u.uNear.value = cam.near; u.uFar.value = cam.far;
    u.tDepth.value = io.depth;
    u.uLightDir.value.copy(keyDir);
    const cl = atmo.clouds;
    const hasCl = cl?.present && cl.lowRT;
    u.uHasClouds.value = hasCl ? 1 : 0;
    u.tClouds.value = hasCl ? cl.lowRT.texture : null;
    this.quad.render(renderer, this.maskMat, this.a);
    const bm = this.blurMat.uniforms;
    bm.uCenter.value.set(sx, sy);
    bm.tSrc.value = this.a.texture; bm.uLen.value = 0.9;
    this.quad.render(renderer, this.blurMat, this.b);
    bm.tSrc.value = this.b.texture; bm.uLen.value = 0.35;
    this.quad.render(renderer, this.blurMat, this.a);
    const cm = this.compMat.uniforms;
    cm.tColor.value = io.input.texture;
    cm.tRays.value = this.a.texture;
    cm.uColor.value.set(kc.r, kc.g, kc.b).multiplyScalar(strength * 0.22);
    this.quad.render(renderer, this.compMat, io.output);
    void G;
  }

  dispose() {
    this.a.dispose(); this.b.dispose();
    this.maskMat.dispose(); this.blurMat.dispose(); this.compMat.dispose();
    this.quad.dispose();
  }
}

const _up = new THREE.Vector3();
