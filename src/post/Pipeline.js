// HDR render pipeline. Owned by the POST track (src/post/*), used by every mode.
//
//   scene (jittered on TAA tiers) → HDR target (HalfFloat colour + Float32 depth texture, reversed-Z,
//         optional MSAA)
//   → GTAO (order 50, system mode) → effects[] (ordered: atmosphere 100, clouds 110, shafts 120,
//     underwater 130, lens/heat 150 …; ping-pong HDR targets) → camera jitter restored
//   → TAA resolve (depth + camera-motion reprojection, variance clipping)   [high/ultra]
//   → depth of field (photo mode / setLook) → camera motion blur (low intensity)
//   → auto-exposure meter (log-average, centre-weighted, GPU-only adaptation)
//   → bloom (dual filter, Karis prefilter; additive or energy-conserving scatter)
//   → sun occlusion probe (depth + luminance)
//   → composite (exposure, WB, lens flare/ghosts/dirt, Purkinje, AgX + film look, vignette, 3D LUT grade)
//   → final (FXAA 3.11 quality on low/med · CAS sharpening after TAA; grain, dither, fade) → screen
//
// Effect contract:  { name, order, enabled, render(renderer, io) , setSize?(w,h), dispose?() }
//   io = { input: WebGLRenderTarget (HDR color), output: WebGLRenderTarget (write here),
//          depth: DepthTexture (scene depth, reversed-Z), camera, scene, pipeline }
//   An effect MUST write a full-screen result into io.output (or set io.skip = true to pass through).
//
// Per-mode defaults: settings marked 'auto' resolve from the current mode (see PROFILES): the
// planet/system mode gets the full AAA stack (TAA, GTAO, eye adaptation, lens flare, film look,
// energy-conserving bloom); the cosmic/galaxy modes keep their hand-tuned additive look.
import * as THREE from 'three';
import '../shaders/chunks.js';
import { G } from '../core/Uniforms.js';
import { makeFullscreenMaterial, FullscreenQuad, hdrRT } from './common.js';
import { TAA } from './taa.js';
import { SSAO } from './ssao.js';
import { AutoExposure } from './exposure.js';
import { Lens } from './lens.js';
import { CameraFX } from './camera.js';
import { buildLUT, gradeSignature, LUT_SIZE } from './grade.js';
import { COMPOSITE_FRAG, FINAL_FRAG } from './composite.js';
import { LegacyPipeline } from './legacy.js';
import { SMAA } from './smaa.js';

export { makeFullscreenMaterial, FullscreenQuad };

export const DEFAULT_POST = {
  exposure: 1.0,
  bloom: { strength: 0.6, radius: 0.85, threshold: 1.0, knee: 0.6, mode: 'auto', scatter: 0.06, highlightBoost: 4, spread: 0.55, skyThreshold: 3 },
  tonemap: 'agx',          // 'agx' | 'agx-punchy' (hue-preserving highlights) | 'aces' | 'reinhard' | 'none'
  tonemapHue: 0.6,         // 'agx-punchy': share of the hue/saturation-preserving curve
  filmLook: 'auto',        // 'auto' | 'neutral' | 'film' | 'punchy' | { power, saturation }
  saturation: 1.0,
  contrast: 1.0,
  vibrance: 0.0,
  temperature: 0.0,        // -1 cool .. +1 warm
  tint: 0.0,               // -1 green .. +1 magenta
  lift: [0, 0, 0],         // shadows offset (fades to 0 at black: OLED-safe)
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  shadows: null,           // optional split-tone [r,g,b] added to shadows (linear, small values)
  highlights: null,        // optional split-tone [r,g,b] added to highlights
  vignette: 0.25,
  grain: 0.02,
  chromatic: 0.002,        // lateral CA at the frame corners (ramps in over the outer ~25 %)
  blackPoint: 0.0,         // keep 0 for true OLED blacks
  aa: 'auto',              // 'auto' | 'taa' | 'smaa' | 'fxaa' | 'none'  (auto: TAA high/ultra, SMAA low/med)
  taa: { feedback: 0.9, sharpen: 0.35, shotSamples: 'auto' },
  ssao: { enabled: 'auto', radius: 2.0, intensity: 1.7, fadeFar: 900, debug: false },
  autoExposure: { enabled: 'auto', key: 'auto', strength: 0.7, min: 0.4, max: 4.0, nightMax: 6.0, nightDrop: 0.32, speedUp: 2.5, speedDown: 1.1, floor: 0.004 },
  flare: { enabled: 'auto', intensity: 1.0, ghosts: 1.0, starburst: 1.0, halo: 1.0, streak: 0.3, dirt: 0.3, ssGhosts: 0.05 },
  clarity: 'auto',         // local contrast (0..0.5), system default 0.22
  purkinje: 0.35,
  motionBlur: { enabled: 'auto', strength: 0.3 },
  dof: { enabled: false, focus: 0, aperture: 1.0, maxCoc: 28, bokeh: 3 },  // enabled: true | false | 'photo'; maxCoc px @1080p
};

// Mode-dependent defaults for 'auto' settings.
const PROFILES = {
  system: { aa: 'taa', ssao: true, autoExposure: true, flare: true, film: 'film', bloomMode: 'mix', motionBlur: true, key: 0.28, dof: 'photo', clarity: 0.25 },
  default: { aa: 'smaa', ssao: false, autoExposure: false, flare: false, film: 'neutral', bloomMode: 'add', motionBlur: false, key: 0.2, dof: false, clarity: 0 },
};
const FILM_LOOKS = { neutral: [1, 1], film: [1.22, 1.22], punchy: [1.4, 1.45] };
const TONEMAPS = { agx: 0, aces: 1, reinhard: 2, none: 3, 'agx-punchy': 4, hue: 4 };

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
const _v3 = new THREE.Vector3(), _v3b = new THREE.Vector3(), _q = new THREE.Quaternion(), _m4 = new THREE.Matrix4();

export class Pipeline {
  constructor(engine) {
    this.engine = engine;
    this.renderer = engine.renderer;
    this.q = engine.quality;
    this.settings = structuredClone(DEFAULT_POST);
    this.effects = [];
    this.enabled = true;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.width = size.x; this.height = size.y;
    this.stats = { taa: false, ssao: false, ae: false, flare: 0, samples: 1, mb: false, dof: false, aa: 'fxaa', ms: 0 };

    const gl = this.renderer.getContext();
    this.floatRT = !!(this.renderer.extensions.has?.('EXT_color_buffer_float') || gl.getExtension?.('EXT_color_buffer_float'));

    // --- HDR scene target with float depth for reversed-Z precision
    this.depthTexture = new THREE.DepthTexture(this.width, this.height, THREE.FloatType);
    this.depthTexture.format = THREE.DepthFormat;
    this.sceneRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace,
      samples: this.q.msaa || 0, depthBuffer: true, stencilBuffer: false, depthTexture: this.depthTexture,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.pingRT = hdrRT(this.width, this.height);
    this.pongRT = hdrRT(this.width, this.height);
    this.postA = hdrRT(this.width, this.height);  // post-TAA scratch (DOF / motion blur)
    this.ldrRT = hdrRT(this.width, this.height);   // graded, display-encoded (half float: no banding before dither)
    this.ldrB = null;                               // SMAA output (lazy)
    this.smaa = null;

    this._sunUv = new THREE.Vector2(0.5, 0.5);
    this._sunCol = new THREE.Color(1, 1, 1);
    this._sun = { uv: this._sunUv, onScreen: 0, radiusPx: 4 };
    this._sunLumRef = 60;
    this.quad = new FullscreenQuad(null);
    this.taa = null; this.ssao = null;            // created lazily (tier/mode dependent)
    this.ae = new AutoExposure();
    this.lens = new Lens();
    this.cam = new CameraFX();
    this._buildBloom();
    this._buildComposite();
    this._copyMat = makeFullscreenMaterial(/* glsl */`uniform sampler2D tSrc; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tSrc, vUv); }`, { tSrc: { value: null } });

    // motion state (camera reprojection)
    this.motion = {
      proj: new THREE.Vector4(1, 1, 0, 0), prevProj: new THREE.Vector4(1, 1, 0, 0),
      curRot: new THREE.Matrix3(), prevRotInv: new THREE.Matrix3(), camDelta: new THREE.Vector3(),
      near: 0.1, far: 1e9,
    };
    this._prevCamPos = new THREE.Vector3();
    this._prevRot = new THREE.Matrix3();
    this._prevCam = null; this._prevScene = null; this._prevMode = null;
    this._lastFrame = -10; this._lastReal = 0;
    this._fx = [];
    this._lutSig = null; this.lut = null;
    this._frameIndex = 0;

    try {
      engine.events?.on?.('origin:shift', (e) => { if (e?.delta) this._prevCamPos.sub(e.delta); });
    } catch (_) { /* optional */ }

    // debug hook (captures / console): __rvPost.meter(), __rvPost.stats
    try {
      window.__rvPost = {
        pipeline: this,
        get stats() { return this.pipeline.stats; },
        meter: () => this.ae.read(this.renderer),
        sun: () => {
          const px = new Uint16Array(4);
          try { this.renderer.readRenderTargetPixels(this.lens.visB, 0, 0, 1, 1, px); } catch (e) { return String(e); }
          return { vis: THREE.DataUtils.fromHalfFloat(px[0]), disc: THREE.DataUtils.fromHalfFloat(px[1]), ring: THREE.DataUtils.fromHalfFloat(px[2]), uv: this._sunUv.toArray(), onScreen: this._sun.onScreen, radiusPx: this._sun.radiusPx };
        },
      };
    } catch (_) { /* no window */ }
  }

  /** Register a full-screen effect (see contract at top). Returns an unregister fn. */
  addEffect(effect) {
    this.effects.push(effect);
    this.effects.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    effect.setSize?.(this.width, this.height);
    return () => this.removeEffect(effect);
  }
  removeEffect(effect) {
    const i = this.effects.indexOf(effect);
    if (i >= 0) this.effects.splice(i, 1);
  }

  /** Merge per-mode / per-planet look settings (art direction). Nested objects merge one level deep. */
  setLook(look = {}) {
    const s = this.settings;
    for (const [k, v] of Object.entries(look)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) Object.assign(s[k], v);
      else s[k] = Array.isArray(v) ? [...v] : v;
    }
  }
  resetLook() { this.settings = structuredClone(DEFAULT_POST); }

  setSize(w, h) {
    this.width = w; this.height = h;
    this.sceneRT.setSize(w, h);
    this.pingRT.setSize(w, h); this.pongRT.setSize(w, h); this.ldrRT.setSize(w, h); this.postA.setSize(w, h);
    this.ldrB?.setSize(w, h); this.smaa?.setSize(w, h);
    this._resizeBloom();
    this.taa?.setSize(w, h);
    this.ssao?.setSize(w, h);
    this.finalMat.uniforms.uInvRes.value.set(1 / w, 1 / h);
    for (const e of this.effects) e.setSize?.(w, h);
    this._lastFrame = -10;
  }

  // ------------------------------------------------------------------ bloom
  _buildBloom() {
    this.bloomMips = [];
    this.bloomPrefilter = makeFullscreenMaterial(/* glsl */`
      #include <rv_common>
      #include <rv_post>
      uniform sampler2D tSrc, tDepth; uniform vec2 uTexel; uniform float uThreshold, uKnee, uBoost, uBoostT, uSkyT, uHasDepth;
      varying vec2 vUv;
      vec3 samp(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }
      float karis(vec3 c){ return 1.0 / (1.0 + rv_luma(c)); }
      void main(){
        // 13-tap downsample (COD:AW) with Karis average to kill fireflies
        vec3 a = samp(vec2(-2, 2)), b = samp(vec2(0, 2)), c = samp(vec2(2, 2));
        vec3 d = samp(vec2(-2, 0)), e = samp(vec2(0, 0)), f = samp(vec2(2, 0));
        vec3 g = samp(vec2(-2, -2)), h = samp(vec2(0, -2)), i = samp(vec2(2, -2));
        vec3 j = samp(vec2(-1, 1)), k = samp(vec2(1, 1)), l = samp(vec2(-1, -1)), m = samp(vec2(1, -1));
        vec3 g0 = (a+b+d+e)*0.25, g1 = (b+c+e+f)*0.25, g2 = (d+e+g+h)*0.25, g3 = (e+f+h+i)*0.25, g4 = (j+k+l+m)*0.25;
        float w0 = karis(g0)*0.125, w1 = karis(g1)*0.125, w2 = karis(g2)*0.125, w3 = karis(g3)*0.125, w4 = karis(g4)*0.5;
        vec3 col = (g0*w0 + g1*w1 + g2*w2 + g3*w3 + g4*w4) / (w0+w1+w2+w3+w4);
        col = min(max(col, 0.0), vec3(6.0e4));
        // soft-knee threshold
        float br = max(col.r, max(col.g, col.b));
        float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
        rq = (rq * rq) / (4.0 * uKnee + 1e-5);
        float w = uThreshold <= 0.0 ? 1.0 : max(rq, br - uThreshold) / max(br, 1e-5);
        // highlight boost (mix mode): emitters/sun glints glow like strong halation, dim content only veils
        // far-plane pixels (sky, cloud silver linings) need a higher boost threshold: only the sun
        // itself should halate there, not every bright cloud edge
        float bt = uBoostT;
        if (uHasDepth > 0.5 && rvp_isSky(texture2D(tDepth, vUv).r)) bt *= uSkyT;
        w *= 1.0 + uBoost * smoothstep(bt, bt * 4.0, br);
        gl_FragColor = vec4(col * w, 1.0);
      }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 }, uKnee: { value: 0.5 }, uBoost: { value: 0 }, uBoostT: { value: 1 }, tDepth: { value: null }, uSkyT: { value: 1 }, uHasDepth: { value: 0 } });

    this.bloomDown = makeFullscreenMaterial(/* glsl */`
      uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
      vec3 samp(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }
      void main(){
        vec3 a = samp(vec2(-2, 2)), b = samp(vec2(0, 2)), c = samp(vec2(2, 2));
        vec3 d = samp(vec2(-2, 0)), e = samp(vec2(0, 0)), f = samp(vec2(2, 0));
        vec3 g = samp(vec2(-2, -2)), h = samp(vec2(0, -2)), i = samp(vec2(2, -2));
        vec3 j = samp(vec2(-1, 1)), k = samp(vec2(1, 1)), l = samp(vec2(-1, -1)), m = samp(vec2(1, -1));
        vec3 col = e*0.125 + (a+c+g+i)*0.03125 + (b+d+f+h)*0.0625 + (j+k+l+m)*0.125;
        gl_FragColor = vec4(col, 1.0);
      }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });

    // upsample: tent filter, blended onto the next-larger mip. uMix = 1 → additive (classic),
    // uMix < 1 → progressive lerp (energy-conserving, each level keeps its share).
    this.bloomUp = makeFullscreenMaterial(/* glsl */`
      uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uRadius, uMix; varying vec2 vUv;
      vec3 samp(vec2 o){ return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }
      void main(){
        vec3 col = samp(vec2(0,0))*4.0 + (samp(vec2(-1,0))+samp(vec2(1,0))+samp(vec2(0,-1))+samp(vec2(0,1)))*2.0
                 + samp(vec2(-1,-1))+samp(vec2(1,-1))+samp(vec2(-1,1))+samp(vec2(1,1));
        gl_FragColor = vec4(col / 16.0, uMix);
      }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 }, uMix: { value: 1 } },
      { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, transparent: true });
    this._resizeBloom();
  }

  _resizeBloom() {
    for (const rt of this.bloomMips) rt.dispose();
    this.bloomMips = [];
    const levels = this.q.bloomLevels || 5;
    let w = Math.max(1, this.width >> 1), h = Math.max(1, this.height >> 1);
    for (let i = 0; i < levels + 1; i++) {
      this.bloomMips.push(hdrRT(w, h));
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    }
  }

  _renderBloom(srcTex, mode) {
    const r = this.renderer, s = this.settings.bloom, mips = this.bloomMips;
    if (!s || !(s.strength > 0) || !mips.length) return null;
    const mix = mode === 'mix';
    this.bloomPrefilter.uniforms.tSrc.value = srcTex;
    this.bloomPrefilter.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.bloomPrefilter.uniforms.uThreshold.value = mix ? (s.mixThreshold ?? 0) : s.threshold;
    this.bloomPrefilter.uniforms.uKnee.value = Math.max(1e-3, s.knee ?? 0.5);
    this.bloomPrefilter.uniforms.uBoost.value = mix ? (s.highlightBoost ?? 4) : 0;
    this.bloomPrefilter.uniforms.uBoostT.value = Math.max(0.05, s.threshold ?? 1);
    this.bloomPrefilter.uniforms.tDepth.value = this.depthTexture;
    this.bloomPrefilter.uniforms.uHasDepth.value = mix ? 1 : 0;
    this.bloomPrefilter.uniforms.uSkyT.value = Math.max(1, s.skyThreshold ?? 3);
    this.quad.draw(r, this.bloomPrefilter, mips[0]);
    for (let i = 1; i < mips.length; i++) {
      this.bloomDown.uniforms.tSrc.value = mips[i - 1].texture;
      this.bloomDown.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      this.quad.draw(r, this.bloomDown, mips[i]);
    }
    const bu = this.bloomUp;
    // energy-conserving: dst = lerp(dst, up, 0.5)-style via constant alpha blend
    bu.blendSrc = mix ? THREE.SrcAlphaFactor : THREE.OneFactor;
    bu.blendDst = mix ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor;
    bu.uniforms.uMix.value = mix ? THREE.MathUtils.clamp(s.spread ?? 0.55, 0.2, 0.9) : 1.0;
    bu.needsUpdate = false;
    const prevAuto = r.autoClear; r.autoClear = false;
    for (let i = mips.length - 1; i > 0; i--) {
      bu.uniforms.tSrc.value = mips[i].texture;
      bu.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      bu.uniforms.uRadius.value = s.radius ?? 0.85;
      this.quad.draw(r, bu, mips[i - 1]);
    }
    r.autoClear = prevAuto;
    return mips[0].texture;
  }

  // ------------------------------------------------------------------ composite
  _buildComposite() {
    this.lut = buildLUT(DEFAULT_POST);
    this._lutSig = gradeSignature(DEFAULT_POST);
    this.compositeMat = makeFullscreenMaterial(COMPOSITE_FRAG, {
      tColor: { value: null }, tBloom: { value: null }, tBloomWide: { value: null }, tAdapt: { value: null },
      tSunVis: { value: null }, tDirt: { value: this.lens.dirt }, tLUT: { value: this.lut },
      uHasBloom: { value: 0 }, uClarity: { value: 0 }, uBloomMode: { value: 0 }, uBloomStrength: { value: 0.5 }, uBloomScatter: { value: 0.05 },
      uExposure: { value: 1 }, uAuto: { value: 0 }, uAEKey: { value: 0.2 }, uAEMin: { value: 0.4 }, uAEMax: { value: 4 }, uAEStrength: { value: 0.7 },
      uTemperature: { value: 0 }, uTint: { value: 0 }, uLookPower: { value: 1 }, uLookSat: { value: 1 },
      uVignette: { value: 0.25 }, uChromatic: { value: 0.001 }, uBlackPoint: { value: 0 }, uLutSize: { value: LUT_SIZE }, uUseLUT: { value: 1 },
      uTonemap: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
      uSunUv: { value: this._sunUv }, uSunCol: { value: new THREE.Vector3(1, 1, 1) }, uFlare: { value: 0 },
      uGhosts: { value: 1 }, uStarburst: { value: 1 }, uStreak: { value: 0.3 }, uHalo: { value: 1 }, uDirt: { value: 0.5 },
      uSSGhost: { value: 0 }, uHasDirt: { value: this.lens.dirt ? 1 : 0 }, uFlareRot: { value: 0.2 },
      uPurkinje: { value: 0 }, uTonemapHue: { value: 0.6 },
    });
    this.finalMat = makeFullscreenMaterial(FINAL_FRAG, {
      tSrc: { value: this.ldrRT.texture }, uInvRes: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
      uMode: { value: 1 }, uSharpen: { value: 0.35 }, uGrain: { value: 0.03 }, uTime: G.uTime,
      uFade: { value: 0 }, uFadeColor: { value: new THREE.Color(0, 0, 0) },
    });
    // back-compat alias (older code referenced fxaaMat)
    this.fxaaMat = this.finalMat;
  }

  // ------------------------------------------------------------------ helpers
  _profile() {
    const name = this.engine.director?.currentName;
    return PROFILES[name] || PROFILES.default;
  }

  _resolve(v, auto) { return v === 'auto' || v === undefined || v === null ? auto : v; }

  _updateMotion(camera) {
    const m = this.motion;
    const p = camera.projectionMatrix.elements;
    m.prevProj.copy(m.proj);
    m.proj.set(p[0], p[5], p[8], p[9]);
    m.near = camera.near ?? 0.1; m.far = camera.far ?? 1e9;
    camera.matrixWorld.decompose(_v3, _q, _v3b);
    _m4.makeRotationFromQuaternion(_q);
    m.curRot.setFromMatrix4(_m4);
    m.prevRotInv.copy(this._prevRot).transpose();
    m.camDelta.copy(_v3).sub(this._prevCamPos);
    // camera cut detection: large jump or big rotation between two rendered frames
    const e1 = m.curRot.elements, e0 = this._prevRot.elements;
    const cosFwd = e1[6] * e0[6] + e1[7] * e0[7] + e1[8] * e0[8];
    const cut = m.camDelta.length() > 20000 || cosFwd < 0.85;
    this._prevRot.copy(m.curRot);
    this._prevCamPos.copy(_v3);
    return cut;
  }

  _updateSun(camera, prof) {
    const sun = this._sun;
    sun.onScreen = 0;
    if (!prof.flare || !camera.isPerspectiveCamera) return 0;
    const world = this.engine.director?.current?.world;
    const sp = world?.space?.sun;
    // direction toward the sun in scene space (root never rotates → local == scene directions)
    const dir = _v3.copy(sp?.dir ?? G.uSunDir.value);
    if (dir.lengthSq() < 1e-8) return 0;
    dir.normalize();
    const vis = sp ? (sp.visibility ?? 1) : 1;
    if (vis <= 0.001) return 0;
    // project a far point along the direction (camera-relative)
    const e = camera.matrixWorldInverse.elements;
    const vx = e[0] * dir.x + e[4] * dir.y + e[8] * dir.z;
    const vy = e[1] * dir.x + e[5] * dir.y + e[9] * dir.z;
    const vz = e[2] * dir.x + e[6] * dir.y + e[10] * dir.z;
    if (vz > -1e-3) return 0;
    const mp = this.motion.proj;
    const nx = (mp.x * vx) / -vz - mp.z, ny = (mp.y * vy) / -vz - mp.w;
    if (Math.abs(nx) > 1.6 || Math.abs(ny) > 1.6) return 0;
    this._sunUv.set(nx * 0.5 + 0.5, ny * 0.5 + 0.5);
    // fade the flare in from beyond the screen edge (off-screen sun still veils a little)
    const edge = Math.max(Math.abs(nx), Math.abs(ny));
    sun.onScreen = THREE.MathUtils.clamp((1.15 - edge) / 0.25, 0, 1) * vis;
    const ang = sp?.angularRadius ?? 0.0047;
    sun.radiusPx = ang * mp.y * 0.5 * this.height;
    // colour: normalised sun colour (orange at sunset, white in space), brightness kept modest
    // space track's colour is the star's own (unreddened) colour; fall back to the surface sun colour
    const sc = (sp?.color && (sp.color.r + sp.color.g + sp.color.b) > 1e-4) ? sp.color : G.uSunColor.value;
    const l = Math.max(1e-4, 0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b);
    this._sunCol.setRGB(sc.r / l, sc.g / l, sc.b / l);
    return sun.onScreen;
  }

  _runEffects(r, scene, camera, opts) {
    let src = this.sceneRT;
    let list = this.effects;
    if (opts.effects && opts.effects.length) {
      const fx = this._fx; fx.length = 0;
      for (const e of this.effects) fx.push(e);
      for (const e of opts.effects) fx.push(e);
      fx.sort(byOrder);
      list = fx;
    }
    const io = this._io || (this._io = { input: null, output: null, depth: null, camera: null, scene: null, pipeline: this, skip: false });
    io.depth = this.depthTexture; io.camera = camera; io.scene = scene;
    // GTAO first (order 50)
    if (this._ssaoOn) {
      const dst = this.pingRT;
      try {
        this.ssao.render(r, this.quad, src.texture, this.depthTexture, dst, this.motion, this.settings.ssao, this._frameIndex);
        src = dst;
      } catch (err) { console.error('[pipeline] ssao failed', err); this._ssaoBroken = true; }
    }
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.enabled === false) continue;
      const dst = src === this.pingRT ? this.pongRT : this.pingRT;
      io.input = src; io.output = dst; io.skip = false;
      try { e.render(r, io); } catch (err) { console.error(`[pipeline] effect ${e.name} failed`, err); e.enabled = false; continue; }
      if (!io.skip) src = dst;
    }
    return src;
  }

  _shotSamples() {
    const v = this.settings.taa?.shotSamples;
    if (typeof v === 'number') return Math.max(1, Math.min(16, v | 0));
    try {
      const p = new URL(window.location.href).searchParams.get('taas');
      if (p) return Math.max(1, Math.min(16, +p | 0));
    } catch (_) { /* ignore */ }
    return this.q.tier === 'ultra' ? 6 : 4;
  }

  // ------------------------------------------------------------------ render
  /**
   * Render a scene through the full pipeline.
   * opts.clearColor: background (default black), opts.effects: extra one-shot effects array
   */
  render(scene, camera, opts = {}) {
    const r = this.renderer;
    if (!this.enabled || this._broken > 3) { r.setRenderTarget(null); r.render(scene, camera); return; }
    if (this._legacyMode === undefined) {
      try { this._legacyMode = new URL(window.location.href).searchParams.get('post') === 'legacy'; } catch (_) { this._legacyMode = false; }
    }
    if (this._legacyMode) {
      // A/B reference: original scaffold pipeline, sharing effects + settings
      if (!this._legacy) this._legacy = new LegacyPipeline(this.engine);
      const L = this._legacy;
      L.effects = this.effects; L.settings = this.settings;
      if (L.width !== this.width || L.height !== this.height) L.setSize(this.width, this.height);
      L.compositeMat.uniforms.uFade.value = this.finalMat.uniforms.uFade.value;
      L.render(scene, camera, opts);
      return;
    }
    try { this._render(scene, camera, opts); this._broken = 0; }
    catch (err) {
      // never blank the screen: restore the camera, log once, fall back to a direct render
      try { this.taa?.restore(); } catch (_) { /* ignore */ }
      this._broken = (this._broken || 0) + 1;
      if (this._broken === 1) console.error('[pipeline] post failed, falling back to direct render', err);
      try { r.setRenderTarget(null); r.render(scene, camera); } catch (_) { /* ignore */ }
    }
  }

  _render(scene, camera, opts) {
    const r = this.renderer;
    const t0 = performance.now();
    const s = this.settings, q = this.q, st = this.stats;
    const prof = this._profile();
    const persp = !!camera.isPerspectiveCamera;
    const eng = this.engine;
    const frame = eng.time?.frame ?? 0;
    const real = eng.time?.real ?? 0;
    const dt = Math.min(0.25, Math.max(0, real - this._lastReal));

    // ---- feature resolution
    let aa = this._resolve(s.aa, prof.aa);
    // TAA needs a perspective camera and a high/ultra tier (explicit aa:'taa' also allows med)
    if (aa === 'taa' && (!persp || !(q.tier === 'high' || q.tier === 'ultra' || (q.tier === 'med' && s.aa === 'taa')))) aa = 'smaa';
    if ((aa === 'fxaa' || aa === 'smaa') && q.msaa > 0 && prof.aa !== 'taa') aa = 'none';
    const useTAA = aa === 'taa';
    const ssaoOn = !!this._resolve(s.ssao?.enabled, prof.ssao) && !!q.ssao && persp && this.floatRT && !this._ssaoBroken;
    const aeOn = !!this._resolve(s.autoExposure?.enabled, prof.autoExposure);
    const flareOn = !!this._resolve(s.flare?.enabled, prof.flare) && (s.flare?.intensity ?? 1) > 0;
    const bloomMode = this._resolve(s.bloom?.mode, prof.bloomMode);
    let dofOn = this._resolve(s.dof?.enabled, prof.dof);
    if (dofOn === 'photo') dofOn = !!eng.ui?.photo && (q.tier === 'high' || q.tier === 'ultra');
    dofOn = !!dofOn && persp;
    const mbOn = !!this._resolve(s.motionBlur?.enabled, prof.motionBlur) && (q.tier === 'high' || q.tier === 'ultra') && (!eng.shot || s.motionBlur?.enabled === true) && persp && (s.motionBlur?.strength ?? 0) > 0;

    if (useTAA && !this.taa) this.taa = new TAA(this.width, this.height);
    if (ssaoOn && !this.ssao) { try { this.ssao = new SSAO(this.width, this.height, q.tier); } catch (e) { console.error('[pipeline] ssao init failed', e); this._ssaoBroken = true; } }
    this._ssaoOn = ssaoOn && !!this.ssao;

    // ---- history validity (frame gaps, mode/camera/scene changes, cuts)
    const modeName = eng.director?.currentName;
    const cut = this._updateMotion(camera);
    const gap = frame - this._lastFrame;
    const historyOK = !cut && gap >= 0 && gap <= 3 && this._prevCam === camera && this._prevScene === scene && this._prevMode === modeName;
    this._prevCam = camera; this._prevScene = scene; this._prevMode = modeName;
    this._lastFrame = frame; this._lastReal = real;
    if (!historyOK) { this.taa?.invalidate(); this.ae.snap = true; this.lens.snap = true; }

    // ---- scene + GTAO + HDR effects (jittered when TAA is on; N sub-frames for shot stills)
    r.setClearColor(opts.clearColor ?? 0x000000, 1);
    let hdr;
    let samples = 1;
    if (useTAA) {
      // shot stills: only the frame advance() captures is supersampled (not the progress render)
      samples = (eng.shot && !this.taa.valid && (eng._advancing || this.forceShotSamples)) ? this._shotSamples() : 1;
      const sm = r.shadowMap, shadowAuto = sm.autoUpdate;
      for (let i = 0; i < samples; i++) {
        if (i === samples - 1 && samples > 1) r.info.reset();
        // frozen instant: shadow maps from the first sub-frame stay valid
        if (i === 1) { sm.autoUpdate = false; sm.needsUpdate = false; }
        this.taa.jitter(camera);
        try {
          r.setRenderTarget(this.sceneRT);
          r.clear(true, true, false);
          r.render(scene, camera);
          this._frameIndex++;
          hdr = this._runEffects(r, scene, camera, opts);
        } finally { this.taa.restore(); }
        const ro = this._resolveOpts || (this._resolveOpts = { reset: false, accum: 0, feedback: 0.9 });
        ro.reset = i === 0 && !this.taa.valid; ro.accum = i === 0 ? 0 : 1 / (i + 1); ro.feedback = s.taa?.feedback ?? 0.9;
        hdr = this.taa.resolve(r, this.quad, hdr.texture, this.depthTexture, this.motion, ro);
      }
      sm.autoUpdate = shadowAuto;
    } else {
      this.taa?.invalidate();
      r.setRenderTarget(this.sceneRT);
      r.clear(true, true, false);
      r.render(scene, camera);
      this._frameIndex++;
      hdr = this._runEffects(r, scene, camera, opts);
    }

    // ---- camera effects
    if (dofOn) {
      const out = hdr === this.postA ? this.pingRT : this.postA;
      this.cam.dof(r, this.quad, hdr.texture, this.depthTexture, out, this.motion, s.dof || {}, this.width, this.height, aeOn ? this.ae.texture : null);
      hdr = out;
    }
    st.hist = historyOK; st.gap = gap;
    if (mbOn && historyOK && (st.moving = this._cameraMoving(dt))) {
      const out = hdr === this.postA ? this.pingRT : this.postA;
      const shutter = (s.motionBlur.strength ?? 0.3) * (dt > 0 ? Math.min(1, (1 / 60) / dt) : 1);
      this.cam.motionBlur(r, this.quad, hdr.texture, this.depthTexture, out, this.motion, shutter, this.width, this.height);
      hdr = out;
      st.mb = true;
    } else st.mb = false;

    // ---- eye adaptation
    const aes = s.autoExposure || {};
    // night keeps a lower key (the eye adapts, but night must still read as night)
    const night = modeName === 'system' ? THREE.MathUtils.clamp(G.uNight.value || 0, 0, 1) : 0;
    // (moderate drop: the deep-blue night sky and moonlit ground must stay readable; OLED black
    //  stays black because exposure is multiplicative and the meter ignores black pixels)
    const aeKey = this._resolve(aes.key, prof.key) * (1 - (aes.nightDrop ?? 0.32) * night);
    if (aeOn) {
      const o = this._aeOpts || (this._aeOpts = {});
      Object.assign(o, aes); o.key = aeKey;
      this.ae.update(r, this.quad, hdr.texture, dt, o);
    }

    // ---- bloom
    const bloomTex = this._renderBloom(hdr.texture, bloomMode);

    // ---- sun occlusion
    let flareVis = 0;
    if (flareOn) {
      flareVis = this._updateSun(camera, prof);
      // 1-px probe; always run (also when off-screen) so a reset never leaves a stale visibility behind
      this.lens.update(r, this.quad, this.depthTexture, hdr.texture, this._sun, dt, this.width, this.height, this._sunLumRef);
    }

    // ---- grade LUT (rebuilt only when the grade changes)
    const sig = gradeSignature(s);
    if (sig !== this._lutSig) { this._lutSig = sig; try { buildLUT(s, this.lut); } catch (e) { console.error('[pipeline] LUT build failed', e); } }

    // ---- composite
    const u = this.compositeMat.uniforms;
    u.tColor.value = s.debugView === 'scene' ? this.sceneRT.texture : hdr.texture;
    u.tBloom.value = bloomTex; u.uHasBloom.value = bloomTex ? 1 : 0;
    u.tBloomWide.value = bloomTex ? this.bloomMips[Math.min(3, this.bloomMips.length - 1)].texture : null;
    u.uBloomMode.value = bloomMode === 'mix' ? 1 : 0;
    u.uClarity.value = Math.max(0, +this._resolve(s.clarity, prof.clarity) || 0);
    u.uBloomStrength.value = s.bloom?.strength ?? 0;
    u.uBloomScatter.value = THREE.MathUtils.clamp((s.bloom?.scatter ?? 0.05), 0, 0.5);
    u.uExposure.value = s.exposure;
    u.uAuto.value = aeOn ? 1 : 0; u.tAdapt.value = this.ae.texture;
    u.uAEKey.value = aeKey; u.uAEMin.value = aes.min ?? 0.4;
    // the dark-adapted eye opens further at night (a thin ambient floor keeps silhouettes readable)
    const aeMax = THREE.MathUtils.lerp(aes.max ?? 4.0, Math.max(aes.max ?? 4.0, aes.nightMax ?? 6.0), night);
    const spaceK = this._spaceK(modeName);
    u.uAEMax.value = THREE.MathUtils.lerp(aeMax, Math.min(aeMax, aes.spaceMax ?? 1.1), spaceK); u.uAEStrength.value = aes.strength ?? 0.7;
    u.uTemperature.value = s.temperature ?? 0; u.uTint.value = s.tint ?? 0;
    let look = this._resolve(s.filmLook, prof.film);
    look = typeof look === 'object' ? [look.power ?? 1, look.saturation ?? 1] : (FILM_LOOKS[look] || FILM_LOOKS.neutral);
    u.uLookPower.value = look[0]; u.uLookSat.value = look[1];
    // vignette: an optical falloff reads on lit content; over black space it only thins the star field
    u.uVignette.value = (s.vignette ?? 0) * (modeName === 'system' ? 1 - 0.6 * spaceK : 1);
    u.uChromatic.value = s.chromatic ?? 0;
    u.uBlackPoint.value = Math.min(0.5, s.blackPoint ?? 0);
    u.uTonemap.value = TONEMAPS[s.tonemap] ?? 0;
    u.uTonemapHue.value = THREE.MathUtils.clamp(s.tonemapHue ?? 0.6, 0, 1);
    u.uRes.value.set(this.width, this.height);
    const f = s.flare || {};
    u.uFlare.value = flareOn ? (f.intensity ?? 1) : 0;
    u.tSunVis.value = this.lens.visTexture;
    u.uSunCol.value.set(this._sunCol.r, this._sunCol.g, this._sunCol.b);
    u.uGhosts.value = f.ghosts ?? 1; u.uStarburst.value = f.starburst ?? 1; u.uHalo.value = f.halo ?? 1;
    u.uStreak.value = f.streak ?? 0.3; u.uDirt.value = flareOn ? (f.dirt ?? 0.3) : 0;
    u.uSSGhost.value = flareOn ? (f.ssGhosts ?? 0.012) : 0;
    u.uPurkinje.value = aeOn ? (s.purkinje ?? 0) : 0;
    this.quad.draw(r, this.compositeMat, this.ldrRT);

    // ---- spatial AA (display-encoded): SMAA 1x on low/med; on TAA tiers SMAA cleans up a young
    //      history (first frames after a cut) and the shot-mode sub-frame accumulation, then CAS
    let ldr = this.ldrRT;
    let mode = 0;
    const taaConverged = aa === 'taa' && this.taa && this.taa.age >= 2 && samples === 1;
    let wantSmaa = aa === 'smaa' || (aa === 'taa' && !taaConverged);
    if (wantSmaa) {
      if (!this.smaa) {
        try { this.smaa = new SMAA(this.width, this.height, q.tier); this.ldrB = hdrRT(this.width, this.height); }
        catch (e) { console.error('[pipeline] smaa init failed', e); this.smaa = null; this._smaaBroken = true; }
      }
      if (this.smaa?.ready && !this._smaaBroken) {
        try { this.smaa.render(r, this.quad, this.ldrRT.texture, this.ldrB); ldr = this.ldrB; }
        catch (e) { console.error('[pipeline] smaa failed', e); this._smaaBroken = true; wantSmaa = false; }
      } else wantSmaa = false;
    }
    if (aa === 'taa') mode = taaConverged || samples > 1 ? 2 : (wantSmaa ? 0 : 1);
    else if (aa === 'fxaa' || (aa === 'smaa' && !wantSmaa)) mode = 1;   // FXAA until SMAA's lookup textures decode
    st.smaa = wantSmaa;

    // ---- final: sharpen / FXAA, grain, dither, fade → screen
    const fu = this.finalMat.uniforms;
    fu.uMode.value = mode;
    fu.uSharpen.value = s.taa?.sharpen ?? 0.35;
    fu.uGrain.value = s.grain ?? 0;
    fu.tSrc.value = ldr.texture;
    this.quad.draw(r, this.finalMat, null);

    st.taa = useTAA; st.ssao = this._ssaoOn; st.ae = aeOn; st.flare = +flareVis.toFixed(3); st.samples = samples;
    st.dof = dofOn; st.aa = aa; st.mode = modeName; st.ms = +(performance.now() - t0).toFixed(1);
  }

  /** 0 on the ground / inside the atmosphere … 1 in space above the current body (system mode). */
  _spaceK(modeName) {
    if (modeName !== 'system') return 0;
    const R = G.uPlanetRadius.value, H = Math.max(1, G.uAtmosphereRadius.value - R);
    const alt = G.uCameraAltitude.value;
    return THREE.MathUtils.smoothstep(alt, H * 0.9, H * 3.0);
  }

  _cameraMoving(dt) {
    const m = this.motion;
    const e1 = m.curRot.elements, e0 = m.prevRotInv.elements; // prevRotInv = transpose(prevRot)
    // forward vectors: column 2 of rot; for transpose, row 2
    const cosFwd = e1[6] * e0[2] + e1[7] * e0[5] + e1[8] * e0[8];
    const ang = Math.acos(Math.min(1, Math.max(-1, cosFwd)));
    const px = ang * m.proj.y * 0.5 * this.height;
    const tr = m.camDelta.length() / 4 * m.proj.y * 0.5 * this.height; // displacement of a point 4 m away
    return px > 1.5 || tr > 1.5;
  }

  /** Fade overlay drawn in the final pass (0..1). */
  setFade(v, color) {
    this.finalMat.uniforms.uFade.value = v;
    if (color !== undefined) this.finalMat.uniforms.uFadeColor.value.set(color);
  }

  dispose() {
    this.sceneRT.dispose(); this.pingRT.dispose(); this.pongRT.dispose(); this.ldrRT.dispose(); this.postA.dispose();
    for (const rt of this.bloomMips) rt.dispose();
    for (const e of this.effects) e.dispose?.();
    this.taa?.dispose(); this.ssao?.dispose(); this.smaa?.dispose(); this.ldrB?.dispose(); this.ae.dispose(); this.lens.dispose(); this.cam.dispose();
    this.lut?.dispose();
    this.compositeMat.dispose(); this.finalMat.dispose(); this.bloomPrefilter.dispose(); this.bloomDown.dispose(); this.bloomUp.dispose();
    this._copyMat.dispose();
    this.quad.dispose();
  }
}
