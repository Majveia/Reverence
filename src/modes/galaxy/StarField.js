// StarField — GPU points for the representative (global) population and the local LOD stars.
// Streams packed buffers from workers; keeps CPU copies for picking.
import * as THREE from 'three';
import { STAR_VERT, STAR_FRAG } from './shaders/stars.js';

export class StarField {
  /**
   * @param shared  uniforms shared with GalaxyVolume (tMap, tNoise, uMapR, uHDust, uFlare, uR, uDustL, uNoiseF, uDustNoise, uExt)
   */
  constructor(engine, shared, S, { maxPointSize = 96 } = {}) {
    this.engine = engine;
    this.S = S;
    const q = engine.quality;
    this.dustSteps = q.tier === 'low' ? 3 : q.tier === 'med' ? 5 : 8;
    const common = {
      tMap: shared.tMap, tNoise: shared.tNoise, uMapR: shared.uMapR, uMapTexel: shared.uMapTexel, uHDust: shared.uHDust, uFlare: shared.uFlare,
      uR: shared.uR, uDustL: shared.uDustL, uNoiseF: shared.uNoiseF, uDustNoise: shared.uDustNoise, uExt: shared.uExt,
      uYmaxD: { value: 10 * S.hDust / 1000 * (1 + S.flare) },
      uDustSteps: { value: this.dustSteps },
      uPat: { value: 0 }, uTau: { value: 0 },
      uV0: { value: S.v0 / 1000 }, uRt: { value: S.rt / 1000 },
      uCamPat: { value: new THREE.Vector3() },
      uPixScale: { value: 500 },
      uEps: { value: 0.0025 }, uHaloR: { value: 2.2 }, uHaloFrac: { value: 0.035 }, uCoreSigma: { value: 0.62 },
      uSpikeFrac: { value: 0.035 }, uSpikeMin: { value: 2.2 }, uSphW: { value: S.type === 'elliptical' ? 1.0 : 0.4 },
      // old-disk tracers (differential rotation): unresolved at galaxy scale → mostly diffuse light, faint grain
      uDiskW: { value: S.type === 'lenticular' ? (S.dustRing ? 0.22 : 0.5) : 0.3 },
    };
    this.common = common;
    // gain of ONE real star (local LOD stars, and global tracers seen up close): a long-exposure
    // astrophoto of the neighbourhood — a Sun at 250 ly is a faint point, a B giant there a bright one
    this.singleGain = 1.5e-7;
    const mk = (own) => new THREE.ShaderMaterial({
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      uniforms: { ...common, ...own },
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.globalMat = mk({
      uGain: { value: 1e-4 }, uLumExp: { value: 0.6 }, uSoft: { value: 0.02 }, uWeight: { value: 1 }, uLocal: { value: 0 },
      uFadeNear: { value: new THREE.Vector2(0, 0.001) }, uLodCenter: { value: new THREE.Vector3() }, uLodRadius: { value: 1 },
      uMaxSize: { value: Math.min(64, maxPointSize) }, uClusterBoost: { value: 1.1 },
      uGainNear: { value: 1.5e-7 }, uNearD: { value: new THREE.Vector2(0.3, 6.0) }, uDustMul: { value: 1 },
    });
    this.localMat = mk({
      uGain: { value: 1e-6 }, uLumExp: { value: 0.44 }, uSoft: { value: 0.0005 }, uWeight: { value: 0 }, uLocal: { value: 1 },
      uFadeNear: { value: new THREE.Vector2(0, 1e-6) }, uLodCenter: { value: new THREE.Vector3() }, uLodRadius: { value: 1 },
      uMaxSize: { value: Math.min(44, maxPointSize) }, uClusterBoost: { value: 1 },
      uGainNear: { value: 0 }, uNearD: { value: new THREE.Vector2(0.3, 6.0) }, uDustMul: { value: 0.3 },
    });
    this.global = null;
    this.local = null;
    this.localIndex = null;
    this.group = new THREE.Group();
    this.filled = 0;
    this.lumSum = 0;
  }

  initGlobal(count) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3), col = new Uint8Array(count * 4), lum = new Float32Array(count).fill(-20);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(col, 4, true));
    g.setAttribute('aLogL', new THREE.BufferAttribute(lum, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.global = new THREE.Points(g, this.globalMat);
    this.global.frustumCulled = false;
    this.global.renderOrder = 3;
    this.group.add(this.global);
    this.count = count;
  }

  addGlobalChunk(start, pos, col, lum, sum = 0) {
    const g = this.global.geometry;
    const P = g.attributes.position, C = g.attributes.aCol, Lm = g.attributes.aLogL;
    P.array.set(pos, start * 3); C.array.set(col, start * 4); Lm.array.set(lum, start);
    const n = lum.length;
    P.addUpdateRange(start * 3, n * 3); P.needsUpdate = true;
    C.addUpdateRange(start * 4, n * 4); C.needsUpdate = true;
    Lm.addUpdateRange(start, n); Lm.needsUpdate = true;
    this.filled += n;
    this.lumSum += sum;
  }

  setLocal(count, pos, col, lum, index) {
    let g = this.local?.geometry;
    const cap = g ? g.attributes.aLogL.array.length : 0;
    if (!g || count > cap) {
      const ncap = Math.max(4096, Math.ceil(count * 1.3));
      if (this.local) { this.group.remove(this.local); g.dispose(); }
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ncap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aCol', new THREE.BufferAttribute(new Uint8Array(ncap * 4), 4, true).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aLogL', new THREE.BufferAttribute(new Float32Array(ncap).fill(-20), 1).setUsage(THREE.DynamicDrawUsage));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      this.local = new THREE.Points(g, this.localMat);
      this.local.frustumCulled = false;
      this.local.renderOrder = 3;
      this.group.add(this.local);
    }
    const P = g.attributes.position, C = g.attributes.aCol, Lm = g.attributes.aLogL;
    P.array.set(pos, 0); C.array.set(col, 0); Lm.array.set(lum, 0);
    P.clearUpdateRanges(); C.clearUpdateRanges(); Lm.clearUpdateRanges();
    P.addUpdateRange(0, count * 3); C.addUpdateRange(0, count * 4); Lm.addUpdateRange(0, count);
    P.needsUpdate = C.needsUpdate = Lm.needsUpdate = true;
    g.setDrawRange(0, count);
    this.localCount = count;
    this.localPos = P.array; this.localLum = Lm.array; this.localCol = C.array;
    this.localIndex = index;
  }

  /** per-frame uniforms */
  update(camera, pat, tau, camPat, height) {
    const c = this.common;
    c.uPat.value = pat; c.uTau.value = tau;
    c.uCamPat.value.copy(camPat);
    c.uPixScale.value = height / (2 * Math.tan(camera.fov * Math.PI / 360));
  }

  dispose() {
    this.global?.geometry.dispose(); this.local?.geometry.dispose();
    this.globalMat.dispose(); this.localMat.dispose();
  }
}
