// SMAA 1x (Jimenez et al.): colour edge detection with local-contrast adaptation → blending-weight
// calculation (pattern search + precomputed area texture) → neighbourhood blending.
// Anti-aliasing path for low/med tiers (and a spatial clean-up of the shot-mode TAA accumulation on
// high/ultra). Runs on the display-encoded (sRGB) LDR image, as SMAA expects.
//
// Shaders and the area/search lookup textures come from three's reference port
// (examples/jsm/shaders/SMAAShader.js + SMAAPass.js); this module owns its targets and presets:
//   low : threshold 0.10, 8 search steps   (SMAA "high" preset)
//   med+: threshold 0.05, 16 search steps  (SMAA "ultra" preset, no diagonal pass)
// Until the lookup textures have decoded (data URLs, a few ms after start) `ready` is false and the
// pipeline falls back to FXAA for those frames.
import * as THREE from 'three';
import { SMAAEdgesShader, SMAAWeightsShader, SMAABlendShader } from 'three/examples/jsm/shaders/SMAAShader.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

function lookupTexture(src, nearest, onload) {
  const tex = new THREE.Texture();
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  tex.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  if (typeof Image === 'undefined') return tex;
  const img = new Image();
  img.onload = () => { tex.needsUpdate = true; onload(); };
  img.src = src;
  tex.image = img;
  return tex;
}

function material(shader, defines) {
  return new THREE.ShaderMaterial({
    defines: { ...shader.defines, ...defines },
    uniforms: THREE.UniformsUtils.clone(shader.uniforms),
    vertexShader: shader.vertexShader, fragmentShader: shader.fragmentShader,
    depthTest: false, depthWrite: false,
  });
}

export class SMAA {
  constructor(w, h, tier = 'med') {
    const opt = { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.edgesRT = new THREE.WebGLRenderTarget(w, h, opt);
    this.weightsRT = new THREE.WebGLRenderTarget(w, h, opt);
    let loaded = 0;
    const done = () => { loaded++; this.ready = loaded >= 2; };
    this.ready = false;
    const proto = SMAAPass.prototype;
    this.area = lookupTexture(proto._getAreaTexture.call(null), false, done);
    this.search = lookupTexture(proto._getSearchTexture.call(null), true, done);
    const hi = tier !== 'low';
    this.edgesMat = material(SMAAEdgesShader, { SMAA_THRESHOLD: hi ? '0.05' : '0.1' });
    this.weightsMat = material(SMAAWeightsShader, { SMAA_MAX_SEARCH_STEPS: hi ? '16' : '8' });
    this.weightsMat.uniforms.tDiffuse.value = this.edgesRT.texture;
    this.weightsMat.uniforms.tArea.value = this.area;
    this.weightsMat.uniforms.tSearch.value = this.search;
    this.blendMat = material(SMAABlendShader, {});
    this.blendMat.uniforms.tDiffuse.value = this.weightsRT.texture;
    this._cc = new THREE.Color();
    this.setSize(w, h);
  }

  setSize(w, h) {
    this.edgesRT.setSize(w, h); this.weightsRT.setSize(w, h);
    for (const m of [this.edgesMat, this.weightsMat, this.blendMat]) m.uniforms.resolution.value.set(1 / w, 1 / h);
  }

  /** srcTex: display-encoded colour; writes the anti-aliased image into outRT. */
  render(renderer, quad, srcTex, outRT) {
    const r = renderer;
    const alpha = r.getClearAlpha(); r.getClearColor(this._cc);
    r.setClearColor(0x000000, 0);
    // edges: the shader discards non-edge pixels, so the target must be cleared explicitly
    r.setRenderTarget(this.edgesRT); r.clear(true, false, false);
    this.edgesMat.uniforms.tDiffuse.value = srcTex;
    const prevAuto = r.autoClear; r.autoClear = false;
    quad.draw(r, this.edgesMat, this.edgesRT);
    r.setRenderTarget(this.weightsRT); r.clear(true, false, false);
    quad.draw(r, this.weightsMat, this.weightsRT);
    r.autoClear = prevAuto;
    r.setClearColor(this._cc, alpha);
    this.blendMat.uniforms.tColor.value = srcTex;
    quad.draw(r, this.blendMat, outRT);
  }

  dispose() {
    this.edgesRT.dispose(); this.weightsRT.dispose(); this.area.dispose(); this.search.dispose();
    this.edgesMat.dispose(); this.weightsMat.dispose(); this.blendMat.dispose();
  }
}
