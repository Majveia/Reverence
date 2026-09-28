// GalaxyVolume — diffuse starlight, HII glow and absorbing dust of a whole galaxy.
//   1. one-off GPU passes: disk map (pattern frame) + tileable 3-D noise volume
//   2. per frame: low-resolution raymarch (VOLUME_FRAG) into an HDR target
//   3. composite quad in the main scene (bicubic upsample): out = emission + dst × transmittance
// Units: kly. See shaders/volume.js for the integration scheme.
import * as THREE from 'three';
import './shaders/galaxyCommon.js';
import { galaxyUniforms, TYPE_ID } from './shaders/galaxyCommon.js';
import { DISK_MAP_FRAG, NOISE3D_FRAG } from './shaders/maps.js';
import { VOLUME_FRAG, COMPOSITE_FRAG, FS_VERT } from './shaders/volume.js';

const K = 1 / 1000;

function fsMaterial(frag, uniforms, extra = {}) {
  return new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra });
}

/** Linear-rgb palette of a galaxy, tempered toward physically plausible population colors. */
export function galaxyPalette(S) {
  const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
  const norm = (c) => { const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; return c.map((v) => v / Math.max(1e-4, l)); };
  const c = S.colors || { core: [1, 0.7, 0.4], arms: [0.5, 0.65, 1], hii: [1, 0.3, 0.5], dust: [0.3, 0.2, 0.1] };
  const bulge = norm(mix([1.0, 0.72, 0.46], c.core, 0.35));
  const old = norm(mix([1.0, 0.84, 0.68], c.core, 0.15));
  const young = norm(mix([0.4, 0.58, 1.0], c.arms, 0.25));
  const hii = norm(mix([1.0, 0.28, 0.46], c.hii, 0.35));
  return { bulge, old, young, hii };
}

export class GalaxyVolume {
  constructor(engine, galaxy, S) {
    this.engine = engine;
    this.galaxy = galaxy;
    this.S = S;
    const q = engine.quality;
    this.tier = q.tier;
    this.mapSize = q.tier === 'ultra' ? 2048 : q.tier === 'high' ? 2048 : q.tier === 'med' ? 1024 : 768;
    this.noiseSize = q.tier === 'low' ? 64 : 128;
    this.steps = q.tier === 'ultra' ? 144 : q.tier === 'high' ? 112 : q.tier === 'med' ? 72 : 48;
    this.resScale = q.tier === 'ultra' ? 0.6 : q.tier === 'high' ? 0.5 : q.tier === 'med' ? 0.42 : 0.34;
    this.maxPixels = q.tier === 'ultra' ? 1.6e6 : q.tier === 'high' ? 9e5 : q.tier === 'med' ? 4.5e5 : 2.2e5;
    this.enabled = true;
    this.frame = 0;
    this.mapR = S.R * K * 1.3;

    const pal = galaxyPalette(S);
    this.palette = pal;
    const R = S.R * K;
    const type = S.type;
    const gu = galaxyUniforms(S);
    this.gu = gu;

    // --- analytic spheroid parameters
    let bulgeA, bulgeW, bulgeS, bulgeL;
    if (type === 'elliptical') {
      const a = S.ellA * K;
      bulgeA = new THREE.Vector4(a * 0.12, a * 0.45, a * 1.5, a * 4.5);
      bulgeW = new THREE.Vector4(0.1, 0.25, 0.37, 0.28);
      bulgeS = new THREE.Vector3(S.ellQ[0], S.ellQ[1], S.ellQ[2]);
      bulgeL = 60.0;
    } else {
      // Sérsic-like: nucleus + three Plummer spheres with extended wings (steeper than one Plummer)
      const bc = S.bulgeComp;
      bulgeA = new THREE.Vector4(S.nucA * K, bc[0].a * K * 1.2, bc[1].a * K * 1.1, bc[2].a * K * 2.2);
      bulgeW = new THREE.Vector4(0.02, 0.2, 0.42, 0.36);
      bulgeS = new THREE.Vector3(1, S.bulgeQ, 1);
      const fb = galaxy.bulgeFrac;
      bulgeL = (type === 'lenticular' ? (S.dustRing ? 50 : 20) : 24) * (fb / 0.14) * (S.barA > 0 ? 0.6 : 1);
    }
    this.uniforms = {
      ...gu,
      tMap: { value: null }, tNoise: { value: null },
      uMapR: { value: this.mapR },
      uCamPos: { value: new THREE.Vector3() },
      uInvProj: { value: new THREE.Matrix4() },
      uRayMat: { value: new THREE.Matrix3() },
      uR: { value: R }, uRmax: { value: R * 1.3 }, uYmax: { value: 7 * S.hOld * K * (1 + S.flare) },
      uHOld: { value: S.hOld * K }, uHYoung: { value: S.hYoung * K }, uHDust: { value: S.hDust * K }, uFlare: { value: S.flare },
      uColOld: { value: new THREE.Vector3(...pal.old) }, uColYoung: { value: new THREE.Vector3(...pal.young) },
      uColHII: { value: new THREE.Vector3(...pal.hii) }, uColBulge: { value: new THREE.Vector3(...pal.bulge) },
      uColBar: { value: new THREE.Vector3(...pal.bulge).lerp(new THREE.Vector3(...pal.old), 0.4) },
      uColHalo: { value: new THREE.Vector3(1.0, 0.86, 0.72) },
      uExt: { value: new THREE.Vector3(0.58, 0.76, 1.0) },
      uOldL: { value: type === 'lenticular' ? (S.dustRing ? 0.35 : 0.6) : type === 'irregular' ? 0.3 : 0.35 },
      uYoungL: { value: type === 'irregular' ? 0.9 : 0.8 },
      uHiiL: { value: type === 'irregular' ? 2.2 : 2.0 },
      uDustL: { value: 8.0 }, uScreen: { value: 0.9 },
      uBulgeA: { value: bulgeA }, uBulgeW: { value: bulgeW }, uBulgeS: { value: bulgeS }, uBulgeL: { value: bulgeL },
      uBar: { value: new THREE.Vector4(S.barA * K || 1, S.barB * K || 1, S.barC * K || 1, S.barA > 0 ? 30 * (galaxy.bulgeFrac / 0.14) : 0) },
      uBarAng: { value: S.phi0 },
      uHalo: { value: new THREE.Vector2(S.haloA * K, type === 'elliptical' ? 0.6 : 0.35) },
      uDsMin: { value: S.hDust * K * 0.25 }, uDsMax: { value: R / 36 }, uDsNear: { value: 0.02 },
      uSteps: { value: this.steps },
      uNoiseF: { value: new THREE.Vector4(1 / 5.0, 1 / 0.9, 1 / 0.16, 0.002) },
      uDustNoise: { value: 1.0 },
      uFrame: { value: 0 },
      uElDust: { value: new THREE.Vector3(0, 0, 0) },
    };

    this.volumeMat = fsMaterial(VOLUME_FRAG, this.uniforms, { glslVersion: null });
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.volumeMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.rt = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG,
      uniforms: { tVol: { value: this.rt.texture }, uVolSize: { value: new THREE.Vector2(4, 4) }, uGain: { value: 1 } },
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.composite = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMat);
    this.composite.frustumCulled = false;
    this.composite.renderOrder = 1;
    this._m3 = new THREE.Matrix3();
    this._v = new THREE.Vector3();
  }

  /** One-off GPU generation of the disk map and noise volume. */
  build(renderer) {
    const S = this.S;
    const N = this.mapSize;
    this.mapRT = new THREE.WebGLRenderTarget(N, N, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, colorSpace: THREE.LinearSRGBColorSpace,
    });
    const mapMat = fsMaterial(DISK_MAP_FRAG, {
      ...this.gu,
      uMapR: { value: this.mapR },
      uRd: { value: S.rd * K }, uRdY: { value: S.rdY * K },
      uDust: { value: S.dust }, uSpur: { value: S.spur }, uFloc: { value: S.floc }, uHii: { value: 1.0 },
      uSeedF: { value: (S.seed % 1000) * 0.137 },
      uDustRing: { value: new THREE.Vector3(S.dustRing ? S.dustRing.r * K : 0, S.dustRing ? S.dustRing.w * K : 1, S.dustRing ? S.dustRing.amp : 0) },
      uBar: { value: new THREE.Vector3(S.barA * K || 1, S.barB * K || 1, S.barC * K || 1) },
    });
    const prevTarget = renderer.getRenderTarget();
    this.quad.material = mapMat;
    renderer.setRenderTarget(this.mapRT);
    renderer.render(this.quadScene, this.quadCam);
    mapMat.dispose();

    const NS = this.noiseSize;
    this.noiseRT = new THREE.WebGL3DRenderTarget(NS, NS, NS, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    const nt = this.noiseRT.texture;
    nt.wrapS = nt.wrapT = nt.wrapR = THREE.RepeatWrapping;
    const noiseMat = fsMaterial(NOISE3D_FRAG, { uZ: { value: 0 }, uSize: { value: NS } });
    this.quad.material = noiseMat;
    for (let z = 0; z < NS; z++) {
      noiseMat.uniforms.uZ.value = (z + 0.5) / NS;
      renderer.setRenderTarget(this.noiseRT, z);
      renderer.render(this.quadScene, this.quadCam);
    }
    noiseMat.dispose();
    renderer.setRenderTarget(prevTarget);
    this.quad.material = this.volumeMat;
    this.uniforms.tMap.value = this.mapRT.texture;
    this.uniforms.tNoise.value = this.noiseRT.texture;
    this.built = true;
  }

  setSize(w, h) {
    let s = this.resScale;
    if (w * h * s * s > this.maxPixels) s = Math.sqrt(this.maxPixels / (w * h));
    const vw = Math.max(16, Math.round(w * s)), vh = Math.max(16, Math.round(h * s));
    this.rt.setSize(vw, vh);
    this.compositeMat.uniforms.uVolSize.value.set(vw, vh);
    this.volH = vh;
  }

  /**
   * @param camera   THREE camera (world frame, kly)
   * @param pat      current pattern rotation angle (rad, θ-convention)
   */
  update(camera, pat) {
    const u = this.uniforms;
    // world → pattern frame: rotate θ by -pat
    const c = Math.cos(-pat), s = Math.sin(-pat);
    const p = camera.position;
    u.uCamPos.value.set(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    const m = this._m3.setFromMatrix4(camera.matrixWorld).elements;
    // R_theta(-pat) (column-major 3x3): x' = c x - s z ; z' = s x + c z
    const out = u.uRayMat.value.elements;
    for (let col = 0; col < 3; col++) {
      const x = m[col * 3], y = m[col * 3 + 1], z = m[col * 3 + 2];
      out[col * 3] = x * c - z * s; out[col * 3 + 1] = y; out[col * 3 + 2] = x * s + z * c;
    }
    const fov = camera.fov * Math.PI / 180;
    u.uNoiseF.value.w = 2 * Math.tan(fov / 2) / Math.max(1, this.volH || 540);
    // near-camera step size scales with the camera's distance to the nearest structure
    const dDisk = Math.max(Math.abs(u.uCamPos.value.y), 0.002);
    u.uDsNear.value = Math.min(0.2, Math.max(0.0005, dDisk * 0.25 + 0.002));
    u.uFrame.value = this.engine.shot ? 0 : (this.frame++ % 64);
  }

  render(renderer) {
    if (!this.built || !this.enabled) return;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    renderer.render(this.quadScene, this.quadCam);
    renderer.setRenderTarget(prev);
  }

  dispose() {
    this.mapRT?.dispose(); this.noiseRT?.dispose(); this.rt.dispose();
    this.volumeMat.dispose(); this.compositeMat.dispose();
    this.quad.geometry.dispose(); this.composite.geometry.dispose();
  }
}

export { TYPE_ID };
