// Tiny full-screen pass helpers for the atmosphere track (independent of the post track internals).
import * as THREE from 'three';

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export function fsMaterial(fragmentShader, uniforms = {}, extra = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader, uniforms,
    depthTest: false, depthWrite: false, ...extra,
  });
}

export class FSQuad {
  constructor() {
    this.geometry = new THREE.BufferGeometry();
    // one big triangle covering the screen (uv 0..1 inside the viewport)
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.mesh = new THREE.Mesh(this.geometry, null);
    this.mesh.frustumCulled = false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  render(renderer, material, target, layer = 0) {
    this.mesh.material = material;
    renderer.setRenderTarget(target, layer);
    renderer.render(this.mesh, this.camera);
  }
  dispose() { this.geometry.dispose(); }
}

/** Save/restore the renderer state touched by nested passes. */
export class RenderState {
  constructor() { this.color = new THREE.Color(); }
  save(r) {
    this.target = r.getRenderTarget();
    this.face = r.getActiveCubeFace();
    this.mip = r.getActiveMipmapLevel();
    r.getClearColor(this.color);
    this.alpha = r.getClearAlpha();
    this.autoClear = r.autoClear;
    this.xr = r.xr.enabled;
  }
  restore(r) {
    r.setRenderTarget(this.target, this.face, this.mip);
    r.setClearColor(this.color, this.alpha);
    r.autoClear = this.autoClear;
    r.xr.enabled = this.xr;
  }
}

export function hdrTarget(w, h, opts = {}) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    colorSpace: THREE.LinearSRGBColorSpace, ...opts,
  });
}
