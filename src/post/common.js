// Shared helpers for the post track: fullscreen materials/quads, render-target factories and the
// GLSL depth/reprojection chunk used by TAA, SSAO, motion blur, DOF and the sun-occlusion probe.
import * as THREE from 'three';
import { registerChunk } from '../shaders/chunks.js';

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export function makeFullscreenMaterial(fragmentShader, uniforms = {}, extra = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader, uniforms,
    depthTest: false, depthWrite: false, ...extra,
  });
}

export class FullscreenQuad {
  constructor(material) {
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  get material() { return this.mesh.material; }
  set material(m) { this.mesh.material = m; }
  render(renderer, target) {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }
  /** Convenience: render with a given material, restoring the previous one. */
  draw(renderer, material, target) {
    const prev = this.mesh.material;
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    this.mesh.material = prev;
  }
  dispose() { this.mesh.geometry.dispose(); }
}

export function hdrRT(w, h, opts = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.LinearSRGBColorSpace,
    generateMipmaps: false, ...opts,
  });
}

// ---------------------------------------------------------------------------------------------
// rv_post: depth helpers. Scene depth is a Float32 depth texture; reversed-Z when available
// (USE_REVERSED_DEPTH_BUFFER is defined by three for every ShaderMaterial in that case).
//   uProj = (P[0], P[5], P[8], P[9]) of the UNJITTERED projection matrix.
registerChunk('rv_post', /* glsl */ `
bool rvp_isSky(float d){
#ifdef USE_REVERSED_DEPTH_BUFFER
  return d <= 1e-9;
#else
  return d >= 0.9999999;
#endif
}
// linear (positive) view distance along -Z
float rvp_linDepth(float d, float near, float far){
#ifdef USE_REVERSED_DEPTH_BUFFER
  return (near * far) / ((far - near) * d + near);
#else
  float z = d * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
#endif
}
// closer of two raw depths
float rvp_closer(float a, float b){
#ifdef USE_REVERSED_DEPTH_BUFFER
  return max(a, b);
#else
  return min(a, b);
#endif
}
vec3 rvp_viewPos(vec2 uv, float lin, vec4 proj){
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3((ndc.x + proj.z) / proj.x * lin, (ndc.y + proj.w) / proj.y * lin, -lin);
}
vec3 rvp_viewDir(vec2 uv, vec4 proj){
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(vec3((ndc.x + proj.z) / proj.x, (ndc.y + proj.w) / proj.y, -1.0));
}
vec2 rvp_project(vec3 v, vec4 proj){
  float iz = 1.0 / max(-v.z, 1e-6);
  vec2 ndc = vec2(proj.x * v.x * iz - proj.z, proj.y * v.y * iz - proj.w);
  return ndc * 0.5 + 0.5;
}
// Camera-motion reprojection: current uv + raw depth -> previous-frame uv.
//   uCurRot: camera->world rotation (current), uPrevRotInv: world->camera rotation (previous),
//   uCamDelta: current camera pos - previous camera pos (same frame, origin shifts compensated).
vec2 rvp_reproject(vec2 uv, float rawDepth, float near, float far, vec4 proj, vec4 prevProj,
                   mat3 curRot, mat3 prevRotInv, vec3 camDelta){
  if (rvp_isSky(rawDepth)) {
    vec3 w = curRot * rvp_viewDir(uv, proj);
    vec3 pv = prevRotInv * w;
    if (pv.z > -1e-4) return vec2(-1.0);
    return rvp_project(pv, prevProj);
  }
  float lin = rvp_linDepth(rawDepth, near, far);
  vec3 w = curRot * rvp_viewPos(uv, lin, proj) + camDelta;
  vec3 pv = prevRotInv * w;
  if (pv.z > -1e-4) return vec2(-1.0);
  return rvp_project(pv, prevProj);
}
`);
