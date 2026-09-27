// HDR render pipeline. Owned by the POST track (src/post/*), used by every mode.
//
//   scene → HDR target (HalfFloat color + Float32 depth texture, reversed-Z, optional MSAA)
//         → effects[] (ordered; e.g. atmosphere 100, clouds 110, ...; ping-pong HDR targets)
//         → bloom (dual-filter, Karis-averaged prefilter)
//         → composite (exposure, filmic tonemap, grading, vignette, grain, CA, dither) → [FXAA] → screen
//
// Effect contract:  { name, order, enabled, render(renderer, io) , setSize?(w,h), dispose?() }
//   io = { input: WebGLRenderTarget (HDR color), output: WebGLRenderTarget (write here),
//          depth: DepthTexture (scene depth, reversed-Z), camera, scene, pipeline }
//   An effect MUST write a full-screen result into io.output (or set io.skip = true to pass through).
import * as THREE from 'three';
import '../shaders/chunks.js';
import { G } from '../core/Uniforms.js';

const FS_VERT = /* glsl */ `
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
  dispose() { this.mesh.geometry.dispose(); }
}

export const DEFAULT_POST = {
  exposure: 1.0,
  bloom: { strength: 0.6, radius: 0.85, threshold: 1.0, knee: 0.6 },
  tonemap: 'agx',          // 'agx' | 'aces' | 'reinhard' | 'none'
  saturation: 1.0,
  contrast: 1.0,
  temperature: 0.0,        // -1 cool .. +1 warm
  tint: 0.0,               // -1 green .. +1 magenta
  lift: [0, 0, 0],         // shadows offset (linear)
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  vignette: 0.25,
  grain: 0.035,
  chromatic: 0.0015,
  blackPoint: 0.0,         // keep 0 for true OLED blacks
};

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

    // --- HDR scene target with float depth for reversed-Z precision
    this.depthTexture = new THREE.DepthTexture(this.width, this.height, THREE.FloatType);
    this.depthTexture.format = THREE.DepthFormat;
    this.sceneRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace,
      samples: this.q.msaa || 0, depthBuffer: true, stencilBuffer: false, depthTexture: this.depthTexture,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.pingRT = this._hdrRT(this.width, this.height);
    this.pongRT = this._hdrRT(this.width, this.height);
    this.ldrRT = new THREE.WebGLRenderTarget(this.width, this.height, { type: THREE.UnsignedByteType, depthBuffer: false });

    this.quad = new FullscreenQuad(null);
    this._buildBloom();
    this._buildComposite();
    this._buildFXAA();
    this._copyMat = makeFullscreenMaterial(/* glsl */`uniform sampler2D tSrc; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tSrc, vUv); }`, { tSrc: { value: null } });
  }

  _hdrRT(w, h) {
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.LinearSRGBColorSpace,
    });
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

  /** Merge per-mode / per-planet look settings (art direction). */
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
    this.pingRT.setSize(w, h); this.pongRT.setSize(w, h); this.ldrRT.setSize(w, h);
    this._resizeBloom();
    this.fxaaMat.uniforms.uInvRes.value.set(1 / w, 1 / h);
    for (const e of this.effects) e.setSize?.(w, h);
  }

  // ------------------------------------------------------------------ bloom
  _buildBloom() {
    this.bloomMips = [];
    this.bloomPrefilter = makeFullscreenMaterial(/* glsl */`
      #include <rv_common>
      uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold, uKnee;
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
        col = min(col, vec3(6.0e4));
        // soft-knee threshold
        float br = max(col.r, max(col.g, col.b));
        float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
        rq = (rq * rq) / (4.0 * uKnee + 1e-5);
        float w = max(rq, br - uThreshold) / max(br, 1e-5);
        gl_FragColor = vec4(col * w, 1.0);
      }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 }, uKnee: { value: 0.5 } });

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

    this.bloomUp = makeFullscreenMaterial(/* glsl */`
      uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uRadius; varying vec2 vUv;
      vec3 samp(vec2 o){ return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }
      void main(){
        vec3 col = samp(vec2(0,0))*4.0 + (samp(vec2(-1,0))+samp(vec2(1,0))+samp(vec2(0,-1))+samp(vec2(0,1)))*2.0
                 + samp(vec2(-1,-1))+samp(vec2(1,-1))+samp(vec2(-1,1))+samp(vec2(1,1));
        gl_FragColor = vec4(col / 16.0, 1.0);
      }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
      { blending: THREE.AdditiveBlending, transparent: true });
    this._resizeBloom();
  }

  _resizeBloom() {
    for (const rt of this.bloomMips) rt.dispose();
    this.bloomMips = [];
    const levels = this.q.bloomLevels || 5;
    let w = Math.max(1, this.width >> 1), h = Math.max(1, this.height >> 1);
    for (let i = 0; i < levels; i++) {
      this.bloomMips.push(this._hdrRT(w, h));
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    }
  }

  _renderBloom(srcTex) {
    const r = this.renderer, s = this.settings.bloom, mips = this.bloomMips;
    if (!s || s.strength <= 0) return null;
    // prefilter into mip0
    this.bloomPrefilter.uniforms.tSrc.value = srcTex;
    this.bloomPrefilter.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.bloomPrefilter.uniforms.uThreshold.value = s.threshold;
    this.bloomPrefilter.uniforms.uKnee.value = Math.max(1e-3, s.knee ?? 0.5);
    this.quad.material = this.bloomPrefilter; this.quad.render(r, mips[0]);
    for (let i = 1; i < mips.length; i++) {
      this.bloomDown.uniforms.tSrc.value = mips[i - 1].texture;
      this.bloomDown.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      this.quad.material = this.bloomDown; this.quad.render(r, mips[i]);
    }
    const prevAuto = r.autoClear; r.autoClear = false;
    for (let i = mips.length - 1; i > 0; i--) {
      this.bloomUp.uniforms.tSrc.value = mips[i].texture;
      this.bloomUp.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      this.bloomUp.uniforms.uRadius.value = s.radius ?? 0.85;
      this.quad.material = this.bloomUp; this.quad.render(r, mips[i - 1]);
    }
    r.autoClear = prevAuto;
    return mips[0].texture;
  }

  // ------------------------------------------------------------------ composite
  _buildComposite() {
    this.compositeMat = makeFullscreenMaterial(/* glsl */`
      #include <rv_common>
      uniform sampler2D tColor; uniform sampler2D tBloom; uniform float uHasBloom;
      uniform float uExposure, uBloomStrength, uSaturation, uContrast, uTemperature, uTint;
      uniform vec3 uLift, uGamma, uGain;
      uniform float uVignette, uGrain, uChromatic, uBlackPoint, uTime; uniform int uTonemap;
      uniform vec2 uRes; uniform float uFade; uniform vec3 uFadeColor;
      varying vec2 vUv;

      // AgX (Troy Sobotka / Benjamin Wrensch fit) — natural highlight desaturation
      vec3 agxDefaultContrast(vec3 x){
        vec3 x2 = x*x; vec3 x4 = x2*x2;
        return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232;
      }
      vec3 agx(vec3 c){
        const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                            0.0784335999999992, 0.878468636469772, 0.0784336,
                            0.0792237451477643, 0.0791661274605434, 0.879142973793104);
        const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                             -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                             -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
        c = m * max(c, 0.0);
        c = clamp(log2(max(c, 1e-10)), -12.47393, 4.026069);
        c = (c + 12.47393) / (4.026069 + 12.47393);
        c = agxDefaultContrast(c);
        c = mi * c;
        return pow(max(c, 0.0), vec3(2.2)); // back to linear
      }
      vec3 aces(vec3 x){ const float a=2.51,b=0.03,c2=2.43,d=0.59,e=0.14; return clamp((x*(a*x+b))/(x*(c2*x+d)+e),0.0,1.0); }
      vec3 linearToSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }

      void main(){
        vec2 uv = vUv;
        vec2 dc = uv - 0.5;
        // chromatic aberration grows toward edges
        vec2 caOff = dc * uChromatic * (0.5 + dot(dc, dc) * 2.0);
        vec3 col;
        col.r = texture2D(tColor, uv - caOff).r;
        col.g = texture2D(tColor, uv).g;
        col.b = texture2D(tColor, uv + caOff).b;
        if (uHasBloom > 0.5) col += texture2D(tBloom, uv).rgb * uBloomStrength;
        col *= uExposure;
        // white balance (simple temperature/tint in linear)
        col *= vec3(1.0 + uTemperature * 0.10, 1.0 - uTint * 0.06, 1.0 - uTemperature * 0.10);
        // tonemap
        if (uTonemap == 0) col = agx(col);
        else if (uTonemap == 1) col = aces(col * 0.8);
        else if (uTonemap == 2) col = col / (1.0 + col);
        col = clamp(col, 0.0, 1.0);
        // grading: lift/gamma/gain (ASC-CDL-like), contrast around mid-grey, saturation
        // lift fades out toward pure black so OLED blacks stay at exactly 0
        float lk = smoothstep(0.0, 0.06, rv_luma(col));
        col = pow(max(col * uGain + uLift * (1.0 - col) * lk, 0.0), 1.0 / max(uGamma, vec3(1e-3)));
        col = (col - 0.18) * uContrast + 0.18;
        float l = rv_luma(col);
        col = max(mix(vec3(l), col, uSaturation), 0.0);
        // vignette (natural cos^4-ish falloff)
        float vig = 1.0 - uVignette * smoothstep(0.25, 1.1, length(dc * vec2(uRes.x / uRes.y, 1.0)) * 1.25);
        col *= vig;
        // true-black preserving black point
        col = max(col - uBlackPoint, 0.0) / (1.0 - uBlackPoint);
        col = linearToSRGB(clamp(col, 0.0, 1.0));
        // film grain (luma-weighted so blacks stay black on OLED) + dither against banding
        float n = rv_hash12(gl_FragCoord.xy + fract(uTime * 13.37) * 1000.0) - 0.5;
        col += n * uGrain * smoothstep(0.0, 0.25, l);
        col += (rv_ign(gl_FragCoord.xy + uTime * 60.0) - 0.5) / 255.0;
        col = mix(col, uFadeColor, uFade);
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }`, {
      tColor: { value: null }, tBloom: { value: null }, uHasBloom: { value: 0 },
      uExposure: { value: 1 }, uBloomStrength: { value: 0.5 }, uSaturation: { value: 1 }, uContrast: { value: 1 },
      uTemperature: { value: 0 }, uTint: { value: 0 },
      uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) }, uGain: { value: new THREE.Vector3(1, 1, 1) },
      uVignette: { value: 0.25 }, uGrain: { value: 0.03 }, uChromatic: { value: 0.001 }, uBlackPoint: { value: 0 },
      uTime: G.uTime, uTonemap: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
      uFade: { value: 0 }, uFadeColor: { value: new THREE.Color(0, 0, 0) },
    });
  }

  _buildFXAA() {
    // FXAA 3.11-style (quality preset ~12), operates on LDR sRGB.
    this.fxaaMat = makeFullscreenMaterial(/* glsl */`
      uniform sampler2D tSrc; uniform vec2 uInvRes; varying vec2 vUv;
      float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
      void main(){
        vec3 rgbM = texture2D(tSrc, vUv).rgb;
        float lM = luma(rgbM);
        float lN = luma(texture2D(tSrc, vUv + vec2(0, uInvRes.y)).rgb);
        float lS = luma(texture2D(tSrc, vUv - vec2(0, uInvRes.y)).rgb);
        float lE = luma(texture2D(tSrc, vUv + vec2(uInvRes.x, 0)).rgb);
        float lW = luma(texture2D(tSrc, vUv - vec2(uInvRes.x, 0)).rgb);
        float lMin = min(lM, min(min(lN, lS), min(lE, lW)));
        float lMax = max(lM, max(max(lN, lS), max(lE, lW)));
        float range = lMax - lMin;
        if (range < max(0.0312, lMax * 0.125)) { gl_FragColor = vec4(rgbM, 1.0); return; }
        float lNW = luma(texture2D(tSrc, vUv + vec2(-uInvRes.x, uInvRes.y)).rgb);
        float lNE = luma(texture2D(tSrc, vUv + uInvRes).rgb);
        float lSW = luma(texture2D(tSrc, vUv - uInvRes).rgb);
        float lSE = luma(texture2D(tSrc, vUv + vec2(uInvRes.x, -uInvRes.y)).rgb);
        vec2 dir;
        dir.x = -((lNW + lNE) - (lSW + lSE));
        dir.y =  ((lNW + lSW) - (lNE + lSE));
        float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0/128.0);
        float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
        dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uInvRes;
        vec3 rgbA = 0.5 * (texture2D(tSrc, vUv + dir * (1.0/3.0 - 0.5)).rgb + texture2D(tSrc, vUv + dir * (2.0/3.0 - 0.5)).rgb);
        vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tSrc, vUv + dir * -0.5).rgb + texture2D(tSrc, vUv + dir * 0.5).rgb);
        float lB = luma(rgbB);
        gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
      }`, { tSrc: { value: null }, uInvRes: { value: new THREE.Vector2(1 / this.width, 1 / this.height) } });
  }

  // ------------------------------------------------------------------ render
  /**
   * Render a scene through the full pipeline.
   * opts.clearColor: background (default black), opts.effects: extra one-shot effects array
   */
  render(scene, camera, opts = {}) {
    const r = this.renderer;
    if (!this.enabled) { r.setRenderTarget(null); r.render(scene, camera); return; }

    // 1. scene → HDR
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(opts.clearColor ?? 0x000000, 1);
    r.clear(true, true, false);
    r.render(scene, camera);

    // 2. effects chain (ping-pong)
    let src = this.sceneRT;
    const effects = opts.effects ? [...this.effects, ...opts.effects].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : this.effects;
    const io = { input: null, output: null, depth: this.depthTexture, camera, scene, pipeline: this, skip: false };
    for (const e of effects) {
      if (e.enabled === false) continue;
      const dst = src === this.pingRT ? this.pongRT : this.pingRT;
      io.input = src; io.output = dst; io.skip = false;
      try { e.render(r, io); } catch (err) { console.error(`[pipeline] effect ${e.name} failed`, err); e.enabled = false; continue; }
      if (!io.skip) src = dst;
    }

    // 3. bloom
    const bloomTex = this._renderBloom(src.texture);

    // 4. composite
    const s = this.settings, u = this.compositeMat.uniforms;
    u.tColor.value = src.texture;
    u.tBloom.value = bloomTex; u.uHasBloom.value = bloomTex ? 1 : 0;
    u.uExposure.value = s.exposure; u.uBloomStrength.value = s.bloom?.strength ?? 0;
    u.uSaturation.value = s.saturation; u.uContrast.value = s.contrast;
    u.uTemperature.value = s.temperature; u.uTint.value = s.tint;
    u.uLift.value.fromArray(s.lift); u.uGamma.value.fromArray(s.gamma); u.uGain.value.fromArray(s.gain);
    u.uVignette.value = s.vignette; u.uGrain.value = s.grain; u.uChromatic.value = s.chromatic;
    u.uBlackPoint.value = s.blackPoint;
    u.uTonemap.value = { agx: 0, aces: 1, reinhard: 2, none: 3 }[s.tonemap] ?? 0;
    u.uRes.value.set(this.width, this.height);
    const useFXAA = !(this.q.msaa > 0);
    this.quad.material = this.compositeMat;
    this.quad.render(r, useFXAA ? this.ldrRT : null);
    if (useFXAA) {
      this.fxaaMat.uniforms.tSrc.value = this.ldrRT.texture;
      this.quad.material = this.fxaaMat;
      this.quad.render(r, null);
    }
  }

  /** Fade overlay drawn inside the composite (0..1). */
  setFade(v, color) {
    this.compositeMat.uniforms.uFade.value = v;
    if (color !== undefined) this.compositeMat.uniforms.uFadeColor.value.set(color);
  }

  dispose() {
    this.sceneRT.dispose(); this.pingRT.dispose(); this.pongRT.dispose(); this.ldrRT.dispose();
    for (const rt of this.bloomMips) rt.dispose();
    for (const e of this.effects) e.dispose?.();
    this.quad.dispose();
  }
}
