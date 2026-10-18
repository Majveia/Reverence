// Canopy shade: a soft multiplicative disc on the ground under every canopy tree out to ~600 m.
// It is the tree's sky occlusion (ambient shadow under the crown) plus, by day, a fake cast shadow
// shifted away from the sun — so forests keep dark floors between crowns beyond the reach of the
// cascaded shadow maps (seen from altitude a forest reads as volume instead of "trees on a lawn").
// Rendered like the sward shade (grass.js): Gaussian weight, multiply blending, pulled toward the
// camera so it rides on the rendered (CDLOD) terrain.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';

export function makeCanopyShadeMaterial(p = {}) {
  const u = {
    uFade: { value: new THREE.Vector4(...(p.fade ?? [0, 0, 450, 600])) },
    uSize: { value: p.size ?? 1.2 },
    uShade: { value: new THREE.Color().fromArray(p.shade ?? [0.42, 0.46, 0.4]) },
    uStr: { value: p.strength ?? 1 },
    uCamPos: G.uCameraPos, uSunDir: G.uSunDir, uNight: G.uNight,
  };
  const mat = new THREE.ShaderMaterial({
    name: 'flora-canopy-shade',
    uniforms: u,
    vertexShader: /* glsl */`
#include <rv_flora>
attribute vec4 iPos; attribute vec4 iRot; attribute vec4 iData;
uniform vec4 uFade; uniform float uSize; uniform vec3 uCamPos; uniform vec3 uSunDir; uniform float uNight;
varying vec2 vL; varying float vK;
void main(){
  // iPos.w = crown radius (m, scaled), iData.x = tree height (m), iData.y = strength
  vec3 up = rvQrot(iRot, vec3(0.0, 1.0, 0.0));
  vec4 aw = modelMatrix * vec4(iPos.xyz, 1.0);
  vec3 upW = normalize((modelMatrix * vec4(up, 0.0)).xyz);
  float el = dot(uSunDir, upW);
  vec3 sd = uSunDir - upW * el;
  float sl = length(sd);
  // fake cast shadow: the crown's shadow centre lands ~0.55 H·cot(elevation) away from the trunk
  // (only beyond the cascaded shadow maps' reach — nearer, real shadows exist and this stays pure AO)
  float dA = length(aw.xyz - uCamPos);
  float farK = smoothstep(70.0, 180.0, dA);
  float shift = farK * (1.0 - uNight) * step(0.05, el) * min(iData.x * 0.55 * sl / max(el, 0.3), iPos.w * 2.5);
  vec3 off = sl > 1e-3 ? -sd / sl * shift : vec3(0.0);
  float R = iPos.w * uSize * (1.0 + 0.25 * shift / max(iPos.w, 0.1));
  vec3 lp = vec3(position.x, 0.0, position.z) * R;
  vec3 p = iPos.xyz + rvQrot(iRot, lp) + up * 0.1;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  wp.xyz += off;
  float d = length(wp.xyz - uCamPos);
  vK = iData.y * rvLodFade(d, uFade).y * mix(0.35, 1.0, farK);
  vec4 mv = viewMatrix * wp;
  float vl = length(mv.xyz);
  float sinT = abs(dot((wp.xyz - uCamPos) / max(d, 1e-3), upW));
  // far away the CDLOD mesh drops octaves of metres → pull proportionally more (2 % of distance)
  float pull = min(0.3 / max(sinT, 0.05), 2.0) + 0.02 * vl;
  mv.xyz *= max(0.1, 1.0 - pull / max(vl, 1e-3));
  gl_Position = projectionMatrix * mv;
  vL = position.xz;
  if (vK < 0.01) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`,
    fragmentShader: /* glsl */`
uniform vec3 uShade; uniform float uStr;
varying vec2 vL; varying float vK;
void main(){
  float r2 = dot(vL, vL);
  float w = max(0.0, (exp(-2.2 * r2) - 0.1108) / 0.8892);
  gl_FragColor = vec4(pow(uShade, vec3(w * vK * uStr)), 1.0);
}`,
    transparent: true, depthWrite: false, depthTest: true, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  return { material: mat, uniforms: u };
}
