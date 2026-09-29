// Water subsystem (order 15) — oceans / lava seas / acid seas / frozen seas on spherical planets.
// OWNED BY THE WATER TRACK (src/world/water/*).
//
// Rendering scheme
//   • One camera-centred polar mesh laid on the sea sphere (radius + seaLevel): ring 0 at the camera
//     nadir, rings exponentially spaced out to just past the (wave-crest) horizon, so the same mesh
//     serves swimming, sailing, flying and orbit — no LOD seams, no popping, the horizon is a ring.
//   • The mesh lives in world.scene as the LAST opaque object (renderOrder 1e6). In its onBeforeRender
//     the current HDR colour + depth of the opaque scene are blitted into a grab target (resolves MSAA),
//     so the water shader can refract the seabed with depth-based absorption, draw shore foam where the
//     water is thin, reflect the scene (SSR) — and still write depth, so the atmosphere's aerial
//     perspective, clouds and every transparent object (splashes, ripples, particles) composite on top.
//   • Underwater: pipeline effect (order 130) — absorption fog, in-scatter with god rays, seabed caustics;
//     the surface seen from below shows Snell's window and total internal reflection.
//   • Shore (order 95): land pixels just above the sea (depth == pre-water grab depth) get the swash of the
//     shore swell — running water sheet, foam line, dark glossy wet sand; lava seas heat their rock rims.
//   • Lava worlds get a heat-shimmer effect (order 145).
//
// Public API (world.get('water'))
//   heightAt(p)            planet-local point → liquid surface height (m rel. body.radius, waves included)
//   surfaceHeight(p)       alias
//   normalAt(p, out)       approximate surface normal (planet-local)
//   isUnderwater(p)        true if p is below the local (wavy) surface
//   depthAt(p)             liquid depth above the seabed at p (m, ≥ 0)
//   liquid                 'water' | 'lava' | 'acid' | 'ice'
//   seaLevel, present, solid (ice: walkable)
//   waves                  WaveSet (Gerstner parameters)
//   getState()             { liquid, under, camH, waveH, amp, rings, ... }
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { WaveSet, MAX_WAVES } from './waves.js';
import { dataTexture, makeTexturesSync, placeholderTexture } from './textures.js';
import { surfaceConfig } from '../planet/SurfaceGen.js';
import { OCEAN_VERT, OCEAN_FRAG, UNDERWATER_FRAG, SHIMMER_FRAG, SHORE_FRAG, SNOW_VERT, SNOW_FRAG } from './shaders.js';
import { makeFullscreenMaterial, FullscreenQuad } from '../../post/Pipeline.js';
import { registerChunk } from '../../shaders/chunks.js';

// fallback when the atmosphere track (which owns rv_cloudshadow) is absent
function ensureChunks() {
  if (THREE.ShaderChunk.rv_cloudshadow) return;
  registerChunk('rv_cloudshadow', `
#ifndef RV_CLOUDSHADOW
#define RV_CLOUDSHADOW
uniform sampler2D rvCloudShadowMap; uniform mat4 rvCloudShadowMatrix; uniform vec4 rvCloudShadowParams;
float rv_cloudShadow(vec3 p){ return 1.0; }
#endif
`);
}

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = { x: 0, y: 0 }, _s = { slopeX: 0, slopeY: 0 };
const _c = new THREE.Color();
const QMOD = 4096;
// golden-ratio sequence over the pipeline's rendered (sub)frames (varies between TAA shot sub-samples too)
function frameJitter(engine) {
  const f = engine?.pipeline?._frameIndex ?? engine?.time?.frame ?? 0;
  return (f * 0.6180339887) % 1;
}

class Water {
  constructor(world) {
    this.world = world;
    this.engine = world.engine;
    const body = world.body;
    this.body = body;
    const oc = body.ocean || {};
    this.liquid = oc.liquid || 'water';
    this.present = true;
    this.solid = this.liquid === 'ice';
    this.seaLevel = Number.isFinite(world.surface?.seaLevel) ? world.surface.seaLevel : (oc.level ?? 0);
    this.Rs = body.radius + this.seaLevel;
    const q = world.quality || {};
    const tier = q.tier || 'high';
    this.tier = tier;
    this.NR = tier === 'low' ? 110 : tier === 'med' ? 150 : tier === 'ultra' ? 240 : 190;
    this.NS = tier === 'low' ? 128 : tier === 'med' ? 160 : tier === 'ultra' ? 256 : 208;
    const nw = tier === 'low' ? 8 : tier === 'med' ? 10 : 12;
    this.waves = new WaveSet(body, { liquid: this.liquid, count: nw });
    this.nw = this.waves.count;                          // wind sea + long swell
    this._anchored = false;
    this._amp = 1;
    this.camH = 1e9;
    this.under = false;
    this.time = 0;

    // ---------- textures (deterministic per planet) — synthesised in the water worker
    this.seed = (body.seed ?? 1) >>> 0;
    this.texN = tier === 'low' ? 128 : 256;
    this.texWaves = placeholderTexture(128, 128, 0, 128, 'rv-water-waves-ph');
    this.texFoam = placeholderTexture(0, 0, 0, 0, 'rv-water-foam-ph');
    this.texCrust = this.texFoam;
    this.texReady = false;
    this.genMs = 0;
    this._t0 = performance.now();

    // ---------- bathymetry around the camera (drives shore swell + shallow damping)
    this.bathyN = tier === 'low' ? 48 : tier === 'med' ? 64 : 96;
    this.bathyTex = new THREE.DataTexture(new Uint16Array(this.bathyN * this.bathyN), this.bathyN, this.bathyN, THREE.RedFormat, THREE.HalfFloatType);
    this.bathyTex.magFilter = this.bathyTex.minFilter = THREE.LinearFilter;
    this.bathyTex.wrapS = this.bathyTex.wrapT = THREE.ClampToEdgeWrapping;
    this.bathyTex.generateMipmaps = false;
    this.bathyTex.needsUpdate = true;
    this.bathy = { valid: false, pending: false, id: 0, qC: [0, 0], L: 0, anchorId: -1, t: 0 };
    this._anchorId = 0;
    // ---------- look (art direction)
    this._setupLook();

    // ---------- grab target (scene colour + depth before the water)
    this.grab = null;
    this._grabOK = false;
    this._grabErrChecked = false;
    this._blitDepth = true;

    // ---------- surface mesh
    this.material = this._makeMaterial();
    this.geometry = this._makeGeometry(this.NR, this.NS);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'rv-ocean';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1e6;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.noCSM = true;
    this.mesh.onBeforeRender = (renderer, scene, camera) => this._beforeRender(renderer, camera);
    world.scene.add(this.mesh);

    // ---------- post effects
    this._removers = [];
    const pipe = this.engine.pipeline;
    if (pipe && this.liquid !== 'ice') {
      this.underFx = this._makeUnderwaterEffect();
      this._removers.push(pipe.addEffect(this.underFx));
    }
    if (pipe && this.liquid !== 'ice' && tier !== 'low') {
      this.shoreFx = this._makeShoreEffect();
      this._removers.push(pipe.addEffect(this.shoreFx));
    }
    if (this.liquid === 'water' || this.liquid === 'acid') this._makeMarineSnow();
    if (pipe && this.liquid === 'lava' && tier !== 'low') {
      this.shimmerFx = this._makeShimmerEffect();
      this._removers.push(pipe.addEffect(this.shimmerFx));
    }
    G.uSeaLevel.value = this.seaLevel;
    this._startWorker();
  }

  // ======================================================================== worker
  _startWorker() {
    const crust = this.liquid === 'lava' || this.liquid === 'ice';
    let w = null;
    try {
      w = new Worker(new URL('./water.worker.js', import.meta.url), { type: 'module' });
    } catch (e) { w = null; }
    this.worker = w;
    if (!w) { this._applyTextures(makeTexturesSync(this.seed, this.texN, crust)); return; }
    w.onmessage = (ev) => {
      const m = ev.data;
      if (this._disposed) return;
      if (m.type === 'tex') this._applyTextures(m);
      else if (m.type === 'bathy') this._applyBathy(m);
      else if (m.type === 'error') { console.warn('[water] worker:', m.message); this.bathy.pending = false; this.bathy.failed = true; }
    };
    w.onerror = (e) => {
      console.warn('[water] worker failed, generating on the main thread', e?.message || e);
      this.worker = null;
      if (!this.texReady) this._applyTextures(makeTexturesSync(this.seed, this.texN, crust));
      this.bathy.failed = true;
    };
    try {
      if (this.world.surface) w.postMessage({ type: 'init', cfg: surfaceConfig(this.body) });
      else this.bathy.failed = true;
    } catch (e) { this.bathy.failed = true; }
    w.postMessage({ type: 'tex', seed: this.seed, N: this.texN, crust });
  }

  _applyTextures(m) {
    const N = m.N || this.texN;
    const old = [this.texWaves, this.texFoam, this.texCrust];
    this.texWaves = dataTexture(m.waves, N, 'rv-water-waves');
    this.texFoam = dataTexture(m.foam, N, 'rv-water-foam');
    this.texCrust = m.crust ? dataTexture(m.crust, N, 'rv-water-crust') : this.texFoam;
    for (const t of new Set(old)) t?.dispose();
    const u = this.u;
    u.tWaves.value = this.texWaves; u.tFoam.value = this.texFoam; u.tCrust.value = this.texCrust;
    if (this.underFx) this.underFx.setFoam(this.texFoam);
    if (this.shimmerFx) this.shimmerFx.setWaves(this.texWaves);
    this.texReady = true;
    this.genMs = Math.round(performance.now() - this._t0);
  }

  _requestBathy(qx, qy, camH) {
    const B = this.bathy, W = this.waves;
    if (!this.worker || B.failed || B.pending) return;
    const L = THREE.MathUtils.clamp(Math.abs(camH) * 4 + 260, 320, 2400);
    const moved = Math.hypot(qx - B.qC[0], qy - B.qC[1]);
    const need = !B.valid || B.anchorId !== this._anchorId || moved > B.L * 0.28 || L > B.L * 1.6 || L < B.L * 0.5;
    if (!need) return;
    B.pending = true; B.id++;
    B.req = { id: B.id, qC: [qx, qy], L, anchorId: this._anchorId };
    this.worker.postMessage({
      type: 'bathy', id: B.id, N: this.bathyN, A: W.anchor.toArray(), T1: W.T1.toArray(), T2: W.T2.toArray(),
      qC: [qx, qy], L, Rs: this.Rs, lod: Math.max(1, (2 * L) / this.bathyN * 0.5), sea: this.seaLevel,
    });
  }

  _applyBathy(m) {
    const B = this.bathy;
    B.pending = false;
    if (!B.req || m.id !== B.req.id || B.req.anchorId !== this._anchorId) return; // stale (re-anchored meanwhile)
    const N = m.N, src = m.data, img = this.bathyTex.image;
    if (img.width !== N) return;
    const dst = img.data;
    for (let i = 0; i < N * N; i++) dst[i] = THREE.DataUtils.toHalfFloat(THREE.MathUtils.clamp(src[i], -60, 400));
    this.bathyTex.needsUpdate = true;
    B.depth = src;
    B.qC = B.req.qC; B.L = B.req.L; B.anchorId = B.req.anchorId; B.valid = true;
  }

  // ======================================================================== look
  _setupLook() {
    const body = this.body, oc = body.ocean || {}, art = body.art || {}, pal = art.palette || {};
    const liquid = this.liquid;
    const shallow = oc.shallow ? new THREE.Color().copy(oc.shallow) : new THREE.Color(pal.water || '#2d8bb5');
    const deep = oc.deep ? new THREE.Color().copy(oc.deep) : new THREE.Color(pal.deep || '#0f3f63');
    // clarity: bright tropical palettes are clear, murky/dark palettes absorb fast
    const lum = shallow.r * 0.2126 + shallow.g * 0.7152 + shallow.b * 0.0722;
    let clarity = THREE.MathUtils.clamp(3 + lum * 26, 3, 11);           // m at which the bed takes the shallow tint
    if (liquid === 'acid') clarity = 2.5;
    const sig = new THREE.Vector3(
      -Math.log(THREE.MathUtils.clamp(shallow.r, 0.004, 0.95)),
      -Math.log(THREE.MathUtils.clamp(shallow.g, 0.004, 0.95)),
      -Math.log(THREE.MathUtils.clamp(shallow.b, 0.004, 0.95)),
    ).multiplyScalar(1 / clarity);
    // keep a minimum extinction so deep water always ends up the deep colour
    sig.x = Math.max(sig.x, 0.03); sig.y = Math.max(sig.y, 0.02); sig.z = Math.max(sig.z, 0.015);
    this.sigma = sig;
    // scattering albedo of the water body: deep palette colour, lifted so it reads under the sky
    // (saturated a little: the sky reflection and aerial perspective wash it out otherwise)
    const dl = deep.r * 0.2126 + deep.g * 0.7152 + deep.b * 0.0722;
    const scatter = new THREE.Vector3(deep.r, deep.g, deep.b).addScaledVector(new THREE.Vector3(deep.r - dl, deep.g - dl, deep.b - dl), 0.35).max(new THREE.Vector3(0.0005, 0.0005, 0.0005)).multiplyScalar(1.15);
    const sss = new THREE.Vector3(shallow.r, shallow.g, shallow.b).lerp(new THREE.Vector3(0.1, 0.9, 0.7), 0.35).multiplyScalar(1.4);
    const glow = new THREE.Vector3(0, 0, 0);
    if (liquid === 'acid') {
      // toxic: push toward venom green, self-luminous
      const g = new THREE.Vector3(0.18, 0.95, 0.12);
      scatter.lerp(g.clone().multiplyScalar(0.25), 0.6);
      sss.copy(g).multiplyScalar(2.0);
      glow.copy(g).multiplyScalar(0.05);
      sig.set(0.9, 0.12, 0.7);
    }
    if (liquid === 'lava') { glow.set(5, 1.1, 0.12); sig.set(3, 3, 3); }
    this.shallow = shallow; this.deep = deep;
    this.scatter = scatter; this.sss = sss; this.glow = glow;
    const windy = this.waves.windy;
    this.look = new THREE.Vector4(
      THREE.MathUtils.lerp(0.035, 0.07, windy),            // base roughness
      liquid === 'acid' ? 0.6 : THREE.MathUtils.lerp(0.35, 1.0, windy), // crest foam
      0.06,                                                  // refraction strength
      THREE.MathUtils.lerp(0.5, 0.9, windy),                // detail normal amplitude
    );
    // shore swell: amplitude (m), k per metre of depth, omega (rad/s), band depth (m)
    const swell = liquid === 'water' ? THREE.MathUtils.lerp(0.25, 0.75, windy) : liquid === 'acid' ? 0.3 : liquid === 'lava' ? 0.12 : 0;
    this.shore = new THREE.Vector4(swell, (Math.PI * 2) / THREE.MathUtils.lerp(1.6, 2.6, windy), liquid === 'lava' ? 0.25 : 1.05, THREE.MathUtils.lerp(5, 9, windy));
    this._shoreAmp = swell;
    const hi = this.tier === 'high' || this.tier === 'ultra';
    this.look2 = new THREE.Vector4(hi ? 1 : 0, liquid === 'acid' ? 0.7 : 1, liquid === 'water' ? 1 : 0.35, windy);
  }

  // ======================================================================== mesh
  _makeGeometry(NR, NS) {
    const nV = 1 + (NR - 1) * NS;
    const grid = new Float32Array(nV * 2);
    let o = 2;
    grid[0] = 0; grid[1] = 0;
    for (let i = 1; i < NR; i++) {
      for (let j = 0; j < NS; j++) { grid[o++] = i; grid[o++] = (j / NS) * Math.PI * 2; }
    }
    const idx = [];
    for (let j = 0; j < NS; j++) idx.push(0, 1 + j, 1 + ((j + 1) % NS));
    for (let i = 1; i < NR - 1; i++) {
      const r0 = 1 + (i - 1) * NS, r1 = 1 + i * NS;
      for (let j = 0; j < NS; j++) {
        const j1 = (j + 1) % NS;
        const a = r0 + j, b = r0 + j1, c = r1 + j, d = r1 + j1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('grid', new THREE.BufferAttribute(grid, 2));
    // `position` is required by three for draw-range computations; it is unused by the shader
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nV * 3), 3));
    g.setIndex(nV > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e12);
    return g;
  }

  _makeMaterial() {
    const L = this.world.lighting;
    const u = {
      uUp: { value: new THREE.Vector3(0, 1, 0) }, uE1: { value: new THREE.Vector3(1, 0, 0) }, uE2: { value: new THREE.Vector3(0, 0, 1) },
      uT1: { value: new THREE.Vector3(1, 0, 0) }, uT2: { value: new THREE.Vector3(0, 0, 1) },
      uPC: G.uPlanetCenter,
      uRs: { value: this.Rs }, uCamH: { value: 10 },
      uGrid: { value: new THREE.Vector4(1, 1000, this.NR, 0.05) },
      uWA: { value: Array.from({ length: this.nw }, () => new THREE.Vector4()) },
      uWB: { value: Array.from({ length: this.nw }, () => new THREE.Vector4()) },
      uCrestA: { value: 0.3 },
      uJit: { value: 0 },
      uTime: { value: 0 },
      uQN: { value: new THREE.Vector2() },
      tBathy: { value: this.bathyTex }, uBathy: { value: new THREE.Vector4(0, 0, 1e-3, 0) },
      uShore: { value: this.shore }, uBathyE: { value: 4 },
      tWaves: { value: this.texWaves }, tFoam: { value: this.texFoam }, tCrust: { value: this.texCrust },
      tSceneColor: { value: null }, tSceneDepth: { value: null }, uHasScene: { value: 0 },
      uInvRes: { value: new THREE.Vector2(1, 1) }, uNearFar: { value: new THREE.Vector2(0.05, 2e10) },
      tEnv: { value: null }, uHasEnv: { value: 0 },
      uKeyDir: L?.uniforms?.uKeyDir ?? G.uSunDir,
      uKeyColor: L?.uniforms?.uKeyColor ?? G.uSunColor,
      uAmbSky: G.uAmbientSky, uAmbGround: G.uAmbientGround,
      uSigma: { value: this.sigma }, uScatter: { value: this.scatter }, uShallow: { value: new THREE.Vector3(this.shallow.r, this.shallow.g, this.shallow.b) },
      uSSS: { value: this.sss }, uGlow: { value: this.glow },
      uLook: { value: this.look }, uLook2: { value: this.look2 },
      uNight: G.uNight,
      uDebug: { value: +(this.world.params?.wdebug ?? 0) || 0 },
      uProj: { value: new THREE.Matrix4() },
      rvCloudShadowMap: L?.uniforms?.rvCloudShadowMap ?? { value: null },
      rvCloudShadowMatrix: L?.uniforms?.rvCloudShadowMatrix ?? { value: new THREE.Matrix4() },
      rvCloudShadowParams: L?.uniforms?.rvCloudShadowParams ?? { value: new THREE.Vector4(0, 1, 0, 0) },
    };
    this.u = u;
    const defines = { NW: this.nw };
    if (this.liquid === 'lava') defines.LIQUID_LAVA = 1;
    else if (this.liquid === 'acid') defines.LIQUID_ACID = 1;
    else if (this.liquid === 'ice') defines.LIQUID_ICE = 1;
    const mat = new THREE.ShaderMaterial({
      name: 'rv-ocean',
      vertexShader: OCEAN_VERT, fragmentShader: OCEAN_FRAG,
      uniforms: u, defines,
      side: THREE.DoubleSide,
      depthTest: true, depthWrite: true, transparent: false,
    });
    mat.userData.noCSM = true;
    return mat;
  }

  // ======================================================================== grab (scene colour+depth)
  _ensureGrab() {
    const pipe = this.engine.pipeline;
    const rt = pipe?.sceneRT;
    if (!rt) return;
    const w = rt.width, h = rt.height;
    if (this.grab && this.grab.width === w && this.grab.height === h) return;
    const renderer = this.engine.renderer;
    if (!this.grab) {
      const dt = new THREE.DepthTexture(w, h, THREE.FloatType);
      dt.format = THREE.DepthFormat;
      dt.minFilter = dt.magFilter = THREE.NearestFilter;
      this.grab = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: true, stencilBuffer: false, depthTexture: dt,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      });
      this.grab.texture.name = 'rv-water-grab';
    } else this.grab.setSize(w, h);
    try {
      renderer.initRenderTarget(this.grab);
      this._grabOK = true;
    } catch (e) { console.warn('[water] grab target init failed', e); this._grabOK = false; }
    this.u.tSceneColor.value = this.grab.texture;
    this.u.tSceneDepth.value = this.grab.depthTexture;
    this.u.uInvRes.value.set(1 / w, 1 / h);
  }

  _beforeRender(renderer, camera) {
    const u = this.u;
    u.uHasScene.value = 0;
    if (camera !== this.world.camera) return;
    // decorrelated noise per rendered (sub)frame: TAA / shot supersampling averages it out
    u.uJit.value = frameJitter(this.engine);
    u.uProj.value.copy(camera.projectionMatrix);
    u.uNearFar.value.set(camera.near, camera.far);
    const pipe = this.engine.pipeline;
    if (!this._grabOK || !pipe || renderer.getRenderTarget() !== pipe.sceneRT) return;
    const g = this.grab;
    if (g.width !== pipe.sceneRT.width || g.height !== pipe.sceneRT.height) return;
    try {
      const gl = renderer.getContext();
      const dst = renderer.properties.get(g).__webglFramebuffer;
      if (!dst) return;
      const cur = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      const scissor = gl.isEnabled(gl.SCISSOR_TEST);
      if (scissor) gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, cur);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
      const mask = gl.COLOR_BUFFER_BIT | (this._blitDepth ? gl.DEPTH_BUFFER_BIT : 0);
      gl.blitFramebuffer(0, 0, g.width, g.height, 0, 0, g.width, g.height, mask, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, cur);
      if (scissor) gl.enable(gl.SCISSOR_TEST);
      if (!this._grabErrChecked) {
        this._grabErrChecked = true;
        const err = gl.getError();
        if (err !== gl.NO_ERROR) {
          console.warn('[water] depth blit failed (gl error ' + err + '); refraction without depth');
          this._blitDepth = false; this._grabOK = false;
          return;
        }
      }
      u.uHasScene.value = 1;
      this._grabbed = true;
    } catch (e) {
      this._grabOK = false;
      console.warn('[water] grab failed', e);
    }
  }

  // ======================================================================== per frame
  update(dt, t) {
    this.time = t;
    this._ensureGrab();
    // environment (raw sky cube from the atmosphere) for reflections
    const L = this.world.lighting;
    if (L?.uniforms && this.u.uKeyDir !== L.uniforms.uKeyDir) {
      // the atmosphere (order 20) is created after us: bind its shared uniforms once it exists
      this.u.uKeyDir = L.uniforms.uKeyDir; this.u.uKeyColor = L.uniforms.uKeyColor;
      this.u.rvCloudShadowMap = L.uniforms.rvCloudShadowMap;
      this.u.rvCloudShadowMatrix = L.uniforms.rvCloudShadowMatrix;
      this.u.rvCloudShadowParams = L.uniforms.rvCloudShadowParams;
    }
    const env = L?.cubeRT?.texture || null;
    this.u.tEnv.value = env;
    this.u.uHasEnv.value = env ? 1 : 0;
  }

  lateUpdate(dt, t) {
    this._grabbed = false;
    const cam = this.world.camera;
    // capture/debug: &uw=<m> puts the camera that many metres below sea level (player can't dive yet)
    const uw = +(this.world.params?.uw ?? 0);
    if (uw > 0) {
      const rr = cam.position.length();
      if (rr > 1) { cam.position.multiplyScalar((this.Rs - uw) / rr); cam.updateMatrixWorld(true); }
    }
    const W = this.waves;
    const camLocal = _v.copy(cam.position);
    const r = camLocal.length();
    if (!(r > 1)) return;
    const up = camLocal.multiplyScalar(1 / r);
    const u = this.u;
    // wave frame anchor (re-anchor only after long travel)
    if (!this._anchored || up.dot(W.anchor) < Math.cos(0.12)) {
      const wind = G.uWindDir.value;
      W.setAnchor(up, wind.lengthSq() > 0.5 ? wind : _w.set(1, 0, 0));
      this._anchored = true;
      this._anchorId++;
    }
    // amplitude follows wind strength (smoothed; lava/ice fixed)
    const target = this.liquid === 'water' || this.liquid === 'acid' ? 0.6 + 0.7 * G.uWindStrength.value : 1;
    this._amp += (target - this._amp) * Math.min(1, dt * 0.08 + (this._ampInit ? 0 : 1));
    this._ampInit = true;
    W.amp = this._amp;
    // nadir frame
    const camH = r - this.Rs;
    this.camH = camH;
    u.uUp.value.copy(up);
    const e1 = u.uE1.value.copy(W.T1).addScaledVector(up, -W.T1.dot(up));
    if (e1.lengthSq() < 1e-8) e1.set(1, 0, 0);
    e1.normalize();
    u.uE2.value.crossVectors(up, e1).normalize();
    u.uT1.value.copy(W.T1); u.uT2.value.copy(W.T2);
    u.uCamH.value = camH;
    // phases at the nadir
    const qx = up.x * this.Rs * W.T1.x + up.y * this.Rs * W.T1.y + up.z * this.Rs * W.T1.z;
    const qy = up.x * this.Rs * W.T2.x + up.y * this.Rs * W.T2.y + up.z * this.Rs * W.T2.z;
    W.updatePhases(qx, qy, t);
    for (let i = 0; i < this.nw; i++) {
      u.uWA.value[i].set(W.dx[i], W.dy[i], W.k[i], W.A[i] * W.amp);
      u.uWB.value[i].set(W.Q[i], W.phase[i], W.lambda[i], W.short[i]);
    }
    u.uQN.value.set(qx - Math.floor(qx / QMOD) * QMOD, qy - Math.floor(qy / QMOD) * QMOD);
    u.uCrestA.value = Math.max(W.seaA0 * W.amp, 0.05);
    // bathymetry map (worker) — shore swell only near the surface
    const B = this.bathy;
    if (this.liquid !== 'ice' && camH < 3000) this._requestBathy(qx, qy, camH);
    const bOK = B.valid && B.anchorId === this._anchorId && camH < 3000;
    u.uBathy.value.set(qx - B.qC[0], qy - B.qC[1], bOK ? 1 / (2 * B.L) : 1e-6, bOK ? 1 : 0);
    u.uBathyE.value = bOK ? (2 * B.L) / this.bathyN : 1;
    u.uShore.value.x = this._shoreAmp * (0.7 + 0.5 * G.uWindStrength.value);
    u.uTime.value = t % 3600;
    // grid extent: from under the camera to just past the horizon of the wave crests
    const Hmax = W.maxHeight * W.amp + 1.0;
    let dMax;
    if (camH > -0.5) {
      const hc = Math.max(camH, 0.2);
      const th = Math.acos(Math.min(1, this.Rs / (this.Rs + hc))) + Math.acos(Math.min(1, this.Rs / (this.Rs + Hmax)));
      dMax = Math.min(this.Rs * th * 1.1 + 40, this.Rs * Math.PI * 0.5);
    } else {
      dMax = Math.min(1800, this.Rs * 0.5);
    }
    let dMin = THREE.MathUtils.clamp(Math.abs(camH) * 0.3, 0.3, 1e9);
    dMin = Math.min(dMin, dMax * 0.02);
    const ratio = Math.pow(dMax / dMin, 1 / (this.NR - 2));
    u.uGrid.value.set(dMin, dMax, this.NR, Math.max(ratio - 1, (Math.PI * 2) / this.NS));
    // underwater state (camera below the local wavy surface)
    const hw = this.liquid === 'ice' ? 0 : W.heightQ(qx, qy, t);
    this.waveHCam = hw;
    this.under = this.liquid !== 'ice' && camH < hw - 0.05 && camH > -5000;
    if (this.snow) {
      this.snow.visible = this.under;
      if (this.under) {
        const su = this.snowU, kc = this.u.uKeyColor.value, a = G.uAmbientSky.value;
        su.uTime.value = t % 3600;
        su.uPx.value = (this.engine.height || 720) / 720 * 2.2;
        const dep = Math.exp(-Math.max(0, hw - camH) * 0.06);
        su.uCol.value.setRGB(kc.r * 0.06 + a.r * 0.1 + 0.02, kc.g * 0.07 + a.g * 0.1 + 0.03, kc.b * 0.07 + a.b * 0.1 + 0.03).multiplyScalar(dep);
      }
    }
  }

  // ======================================================================== CPU queries
  heightAt(p) {
    const r = p.length();
    if (!(r > 1)) return this.seaLevel;
    if (this.liquid === 'ice') return this.seaLevel;
    const W = this.waves;
    W.toQ(p, this.Rs, _q);
    const t = this.time;
    // same shallow damping + shore swell as the shader (swell amplitude variation taken at its mean)
    const D = this._bathyAt(_q.x, _q.y);
    let h;
    if (D < 1e3) {
      const damp = THREE.MathUtils.smoothstep(D, -0.2, 3.0);
      const a0 = W.amp; W.amp = a0 * damp;
      h = W.heightQ(_q.x, _q.y, t);
      W.amp = a0;
      const S = this.u.uShore.value;
      const band = (1 - THREE.MathUtils.smoothstep(D, S.w * 0.45, S.w)) * THREE.MathUtils.smoothstep(D, -0.4, 0.6);
      if (band > 0.001) {
        const ph = S.y * D + S.z * (t % 3600);
        const pr = Math.pow(0.5 + 0.5 * Math.sin(ph), 3);
        h += S.x * band * 0.9 * (pr - 0.18);
      }
    } else h = W.heightQ(_q.x, _q.y, t);
    return this.seaLevel + h;
  }
  /** Water depth (m) from the worker bathymetry map at wave coordinate q, 1e3 when unknown. */
  _bathyAt(qx, qy) {
    const B = this.bathy;
    if (!B.valid || !B.depth || B.anchorId !== this._anchorId) return 1e3;
    const N = this.bathyN;
    const fx = ((qx - B.qC[0]) / (2 * B.L) + 0.5) * N - 0.5, fy = ((qy - B.qC[1]) / (2 * B.L) + 0.5) * N - 0.5;
    if (fx < 0 || fy < 0 || fx > N - 1 || fy > N - 1) return 1e3;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const x1 = Math.min(x0 + 1, N - 1), y1 = Math.min(y0 + 1, N - 1), d = B.depth;
    return (d[y0 * N + x0] * (1 - tx) + d[y0 * N + x1] * tx) * (1 - ty) + (d[y1 * N + x0] * (1 - tx) + d[y1 * N + x1] * tx) * ty;
  }
  surfaceHeight(p) { return this.heightAt(p); }
  normalAt(p, out = new THREE.Vector3()) {
    const up = _w.copy(p).normalize();
    if (this.liquid === 'ice') return out.copy(up);
    this.waves.toQ(p, this.Rs, _q);
    this.waves.heightQ(_q.x, _q.y, this.time, _s);
    const W = this.waves;
    const t1 = _v.copy(W.T1).addScaledVector(up, -W.T1.dot(up)).normalize();
    out.copy(up).addScaledVector(t1, -_s.slopeX);
    const t2 = t1.crossVectors(up, t1);  // reuse _v
    return out.addScaledVector(t2, -_s.slopeY).normalize();
  }
  isUnderwater(p) { return p.length() - this.body.radius < this.heightAt(p); }
  depthAt(p) {
    const S = this.world.surface;
    if (!S) return 0;
    const d = _w.copy(p).normalize();
    return Math.max(0, this.heightAt(p) - S.height(d.x, d.y, d.z));
  }

  // ======================================================================== effects
  _makeUnderwaterEffect() {
    const self = this;
    const mat = makeFullscreenMaterial(UNDERWATER_FRAG, {
      tColor: { value: null }, tDepth: { value: null }, tFoam: { value: this.texFoam },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uNearFar: { value: new THREE.Vector2() },
      uCam: { value: new THREE.Vector3() }, uPC: G.uPlanetCenter, uUp: { value: new THREE.Vector3() },
      uT1: { value: new THREE.Vector3() }, uT2: { value: new THREE.Vector3() }, uL: { value: new THREE.Vector3() },
      uRs: { value: this.Rs }, uCamDepth: { value: 0 }, uTime: { value: 0 }, uUnder: { value: 1 }, uJit: { value: 0 },
      uSigma: { value: this.sigma }, uScatter: { value: this.scatter },
      uEsun: { value: new THREE.Vector3() }, uEamb: { value: new THREE.Vector3() }, uGlow: { value: this.glow },
      uQN: { value: new THREE.Vector2() },
    });
    const quad = new FullscreenQuad(mat);
    return {
      name: 'underwater', order: 130, enabled: true,
      render(renderer, io) {
        if (!self.under) { io.skip = true; return; }
        const U = mat.uniforms, cam = io.camera, su = self.u;
        U.tColor.value = io.input.texture; U.tDepth.value = io.depth;
        U.uInvProj.value.copy(cam.projectionMatrixInverse);
        U.uCamWorld.value.copy(cam.matrixWorld);
        U.uNearFar.value.set(cam.near, cam.far);
        U.uCam.value.setFromMatrixPosition(cam.matrixWorld);
        U.uUp.value.copy(su.uUp.value); U.uT1.value.copy(su.uT1.value); U.uT2.value.copy(su.uT2.value);
        U.uL.value.copy(su.uKeyDir.value).normalize();
        U.uCamDepth.value = Math.max(0, self.waveHCam - self.camH);
        U.uTime.value = su.uTime.value;
        U.uJit.value = +(self.world.params?.wdebug ?? 0) === 7 ? -1 : frameJitter(self.engine);
        U.uQN.value.copy(su.uQN.value);
        const kc = su.uKeyColor.value, sunUp = Math.max(0, U.uUp.value.dot(U.uL.value));
        const cs = Math.min(1, sunUp * 12);
        U.uEsun.value.set(kc.r, kc.g, kc.b).multiplyScalar(cs);
        const a = G.uAmbientSky.value;
        U.uEamb.value.set(a.r, a.g, a.b);
        quad.render(renderer, io.output);
      },
      setFoam(t) { mat.uniforms.tFoam.value = t; },
      dispose() { mat.dispose(); quad.dispose(); },
    };
  }

  _makeShoreEffect() {
    const self = this, su = this.u;
    const mat = makeFullscreenMaterial(SHORE_FRAG, {
      tColor: { value: null }, tDepth: { value: null }, tGrabDepth: { value: null },
      tFoam: { value: this.texFoam }, tWaves: { value: this.texWaves },
      tEnv: { value: null }, uHasEnv: { value: 0 },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uNearFar: { value: new THREE.Vector2() }, uCam: { value: new THREE.Vector3() }, uPC: G.uPlanetCenter,
      uUp: su.uUp, uT1: su.uT1, uT2: su.uT2, uCamH: su.uCamH, uRs: su.uRs, uTime: su.uTime, uQN: su.uQN,
      uShore: su.uShore, uShallow: su.uShallow, uAmbSky: G.uAmbientSky,
      uKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uKeyColor: { value: new THREE.Color(1, 1, 1) },
      uLiquid: { value: this.liquid === 'lava' ? 2 : this.liquid === 'acid' ? 1 : 0 },
    });
    const quad = new FullscreenQuad(mat);
    return {
      name: 'water-shore', order: 95, enabled: true,
      render(renderer, io) {
        // needs this frame's pre-water depth (grab) to tell land from water; near the surface only
        if (self.under || self.camH > 700 || self.camH < -1 || !self._grabbed || !self.grab || !io.depth) { io.skip = true; return; }
        const U = mat.uniforms, cam = io.camera;
        U.tColor.value = io.input.texture; U.tDepth.value = io.depth; U.tGrabDepth.value = self.grab.depthTexture;
        U.tFoam.value = self.texFoam; U.tWaves.value = self.texWaves;
        U.tEnv.value = su.tEnv.value; U.uHasEnv.value = su.uHasEnv.value;
        U.uKeyDir.value.copy(su.uKeyDir.value); U.uKeyColor.value.copy(su.uKeyColor.value);
        U.uInvProj.value.copy(cam.projectionMatrixInverse);
        U.uCamWorld.value.copy(cam.matrixWorld);
        U.uNearFar.value.set(cam.near, cam.far);
        U.uCam.value.setFromMatrixPosition(cam.matrixWorld);
        quad.render(renderer, io.output);
      },
      dispose() { mat.dispose(); quad.dispose(); },
    };
  }

  _makeShimmerEffect() {
    const self = this;
    const mat = makeFullscreenMaterial(SHIMMER_FRAG, {
      tColor: { value: null }, tDepth: { value: null }, tWaves: { value: this.texWaves },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uNearFar: { value: new THREE.Vector2() }, uCam: { value: new THREE.Vector3() }, uPC: G.uPlanetCenter,
      uRs: { value: this.Rs }, uTime: { value: 0 }, uStrength: { value: 1 },
    });
    const quad = new FullscreenQuad(mat);
    return {
      name: 'water-heat', order: 145, enabled: true,
      render(renderer, io) {
        if (self.camH > 2500 || self.under) { io.skip = true; return; }
        const U = mat.uniforms, cam = io.camera;
        U.tColor.value = io.input.texture; U.tDepth.value = io.depth;
        U.uInvProj.value.copy(cam.projectionMatrixInverse);
        U.uCamWorld.value.copy(cam.matrixWorld);
        U.uNearFar.value.set(cam.near, cam.far);
        U.uCam.value.setFromMatrixPosition(cam.matrixWorld);
        U.uTime.value = self.u.uTime.value;
        U.uStrength.value = 1 - THREE.MathUtils.smoothstep(self.camH, 300, 2500);
        quad.render(renderer, io.output);
      },
      setWaves(t) { mat.uniforms.tWaves.value = t; },
      dispose() { mat.dispose(); quad.dispose(); },
    };
  }

  _makeMarineSnow() {
    const n = Math.round(700 * Math.max(0.25, this.world.quality?.particleScale ?? 1));
    const seed = new Float32Array(n * 4);
    let h = 0x9e3779b9 ^ this.seed;
    const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
    for (let i = 0; i < n * 4; i++) seed[i] = rnd();
    const g = new THREE.BufferGeometry();
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e12);
    this.snowU = { uTime: { value: 0 }, uBox: { value: 14 }, uPx: { value: 1 }, uCol: { value: new THREE.Color() } };
    const m = new THREE.ShaderMaterial({
      name: 'rv-water-snow', vertexShader: SNOW_VERT, fragmentShader: SNOW_FRAG, uniforms: this.snowU,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.snow = new THREE.Points(g, m);
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    this.snow.renderOrder = 1e6 + 1;
    this.snow.userData.noCSM = true;
    this.world.scene.add(this.snow);
  }

  // ======================================================================== misc
  isReady() {
    if (!this.texReady) return false;
    const B = this.bathy;
    if (!this.worker || B.failed || this.liquid === 'ice' || this.camH > 3000) return true;
    return B.valid && B.anchorId === this._anchorId;
  }

  getState() {
    return {
      liquid: this.liquid,
      under: this.under,
      camH: +this.camH.toFixed(2),
      waveH: +(this.waveHCam ?? 0).toFixed(2),
      amp: +this._amp.toFixed(2),
      L0: +this.waves.L0.toFixed(1),
      grab: this._grabOK,
      tex: this.texReady,
      bathy: this.bathy.valid ? Math.round(this.bathy.L) : (this.bathy.failed ? 'failed' : 'pending'),
      grid: [+this.u.uGrid.value.x.toFixed(2), Math.round(this.u.uGrid.value.y)],
      tris: this.geometry.index.count / 3,
      genMs: this.genMs,
    };
  }

  dispose() {
    this._disposed = true;
    try { this.worker?.terminate(); } catch (_) { /* ignore */ }
    this.bathyTex.dispose();
    for (const r of this._removers) try { r(); } catch (_) { /* ignore */ }
    this.underFx?.dispose(); this.shimmerFx?.dispose(); this.shoreFx?.dispose();
    if (this.snow) { this.world.scene.remove(this.snow); this.snow.geometry.dispose(); this.snow.material.dispose(); }
    this.world.scene.remove(this.mesh);
    this.geometry.dispose(); this.material.dispose();
    this.texWaves.dispose(); this.texFoam.dispose();
    if (this.texCrust !== this.texFoam) this.texCrust.dispose();
    this.grab?.dispose();
  }
}

export default {
  name: 'water',
  order: 15,
  async create(world) {
    const b = world.body;
    if (!b || b.isGas || !b.ocean?.present) return null;
    if (world.surface && !(world.surface.seaLevel > -1e8)) return null;
    ensureChunks();
    const w = new Water(world);
    world.water = w;
    return w;
  },
};
