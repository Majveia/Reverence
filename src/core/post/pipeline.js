// HDR post-processing pipeline.
//
//   scene (layer 0, opaque + ordinary transparents) → sceneRT  (RGBA16F + float depth texture)
//   [opaque copy]  → post.shared.tOpaque (rgb = scene colour, a = linear view depth, metres ≤ 60000)
//   scene (layer LAYERS.REFRACTIVE: water, glass, heat haze …) → sceneRT, may sample tOpaque
//   realm HDR passes (PostPass: atmosphere, clouds, fog, lens …) ping-pong  → hdr
//   bloom (13-tap downsample chain, tent upsample)   auto-exposure (log-luminance, temporal)
//   composite: exposure → tone map → grade → vignette → sRGB → grain + OLED-safe dither → FXAA → canvas
//
// True black stays true black: nothing in the chain lifts a 0,0,0 pixel.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { GLSL } from '../glsl.js';

export const LAYERS = { DEFAULT: 0, REFRACTIVE: 2 };

export function defaultGrade() {
  return {
    exposure: 1.0,
    autoExposure: null,            // { key: 0.18, min: 0.25, max: 8, speedUp: 2.5, speedDown: 1.0 }
    tonemap: 'agx',                // 'agx' | 'aces' | 'neutral' | 'none'
    bloom: { strength: 0.7, threshold: 1.0, knee: 0.7, radius: 1.0 },
    contrast: 1.0, saturation: 1.0,
    lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
    temperature: 0.0,              // −1 cool … +1 warm
    vignette: 0.22, grain: 0.015, ca: 0.0,
  };
}

const TONEMAP = { none: 0, agx: 1, aces: 2, neutral: 3 };

const FS_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Vertex shader for PostPass: also provides a world-space view ray with unit view-depth, so
//   worldPos = uCamPos + vRay * rvViewDepth(texture2D(tDepth, vUv).x)
const PASS_VERT = /* glsl */`
uniform mat4 uViewInv;
uniform vec2 uProjScale; // (1/P[0][0], 1/P[1][1])
varying vec2 vUv;
varying vec3 vRay;
void main(){
  vUv = uv;
  vec2 ndc = position.xy;
  vRay = mat3(uViewInv) * vec3(ndc * uProjScale, -1.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

/**
 * A realm-supplied full-screen HDR pass.  The fragment shader receives:
 *   uniform sampler2D tColor;   // HDR scene colour so far (linear)
 *   uniform sampler2D tDepth;   // scene depth texture → use rvViewDepth(texture2D(tDepth, vUv).x), rvIsSky(d)
 *   uniform vec2  uResolution;  // render-target size in pixels
 *   uniform float uTime, uDt;   // seconds
 *   uniform vec3  uCamPos;      // camera position, scene space
 *   uniform mat4  uViewInv, uView, uProj, uProjInv;
 *   varying vec2  vUv;  varying vec3 vRay;   // see PASS_VERT
 * and must write gl_FragColor (HDR linear; alpha ignored).  GLSL.common and GLSL.depth are prepended for you.
 */
export class PostPass {
  constructor({ name = 'pass', fragment, uniforms = {}, defines = {}, order = 0, enabled = true }) {
    this.name = name; this.order = order; this.enabled = enabled;
    this.uniforms = {
      tColor: { value: null }, tDepth: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 }, uDt: { value: 0.016 }, uCamPos: { value: new THREE.Vector3() },
      uViewInv: { value: new THREE.Matrix4() }, uView: { value: new THREE.Matrix4() },
      uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() },
      uProjScale: { value: new THREE.Vector2(1, 1) }, uCamNear: { value: 0.1 }, uCamFar: { value: 1000 },
      uFrame: { value: 0 },
      ...uniforms,
    };
    this.material = new THREE.ShaderMaterial({
      name: 'PostPass:' + name, uniforms: this.uniforms, defines,
      vertexShader: PASS_VERT,
      fragmentShader: `${GLSL.common}\n${GLSL.depth}\nuniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 uResolution; uniform float uTime; uniform float uDt; uniform float uFrame;\nuniform vec3 uCamPos; uniform mat4 uViewInv; uniform mat4 uView; uniform mat4 uProj; uniform mat4 uProjInv;\nvarying vec2 vUv; varying vec3 vRay;\n${fragment}`,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  /** Optional hook, called right before the pass renders. */
  onBeforeRender(/* info: {renderer, camera, time, dt, width, height} */) {}
  dispose() { this.material.dispose(); this.quad.dispose(); }
}

const mat = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...extra });

export class PostPipeline {
  constructor(renderer, { fxaa = true, bloomLevels = 7 } = {}) {
    this.renderer = renderer;
    this.fxaa = fxaa;
    this.bloomLevels = bloomLevels;
    this.renderScale = 1;
    this.width = 1; this.height = 1;      // output (drawing buffer) size
    this.rw = 1; this.rh = 1;             // internal render size

    // global effects driven by the engine
    this.warp = 0;                        // 0..1 hyperspace streak
    this.fade = 0;                        // 0..1 fade to fadeColor
    this.fadeColor = new THREE.Color(0, 0, 0);
    this.letterbox = 0;                   // 0..1 cinematic bars
    this.flash = 0;                       // additive white flash
    this.frame = 0;

    const hdr = (w, h, depth = false) => {
      const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: depth, stencilBuffer: false, generateMipmaps: false });
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      if (depth) { rt.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType); rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter; }
      return rt;
    };
    this._hdr = hdr;
    this.sceneRT = hdr(1, 1, true);
    this.opaqueRT = hdr(1, 1);
    this.hdrA = hdr(1, 1); this.hdrB = hdr(1, 1);
    this.bloomRT = []; for (let i = 0; i < bloomLevels; i++) this.bloomRT.push(hdr(1, 1));
    this.meterRT = [hdr(64, 64), hdr(16, 16), hdr(4, 4)];
    this.lumRT = [hdr(1, 1), hdr(1, 1)];
    this.lumRT.forEach((rt) => { rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter; });
    this._lumIndex = 0; this._lumInit = false;
    this.ldrRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });

    /** Uniform objects to share with materials on LAYERS.REFRACTIVE (put these same objects into your `uniforms`). */
    this.shared = {
      tOpaque: { value: this.opaqueRT.texture },                 // rgb scene colour behind you, a = linear view depth (m)
      uOpaqueTexel: { value: new THREE.Vector2(1, 1) },           // 1 / render size  → screenUV = gl_FragCoord.xy * uOpaqueTexel
      uCamNear: { value: 0.1 }, uCamFar: { value: 1000 },
    };

    // ── materials ──
    this.copyMat = mat(/* glsl */`
      ${GLSL.common} ${GLSL.depth}
      uniform sampler2D tColor; uniform sampler2D tDepth; varying vec2 vUv;
      void main(){ float d = texture2D(tDepth, vUv).x; gl_FragColor = vec4(texture2D(tColor, vUv).rgb, rvIsSky(d) ? 60000.0 : min(rvViewDepth(d), 60000.0)); }`,
      { tColor: { value: null }, tDepth: { value: null }, uCamNear: this.shared.uCamNear, uCamFar: this.shared.uCamFar });

    this.blitMat = mat(/* glsl */`uniform sampler2D tColor; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tColor, vUv); }`, { tColor: { value: null } });

    // Bloom prefilter + first downsample: soft-knee threshold on exposed colour, Karis average to kill fireflies.
    // Alpha carries log2 luminance of the *unthresholded* colour for auto-exposure.
    this.prefilterMat = mat(/* glsl */`
      ${GLSL.common}
      uniform sampler2D tColor; uniform sampler2D tLum; uniform vec2 uTexel; uniform vec4 uThreshold; // (threshold, knee, exposure, auto)
      uniform vec3 uAuto; // key, min, max
      varying vec2 vUv;
      vec3 pre(vec3 c, float e){ c = min(c, vec3(64.0)) * e; float br = max(c.r, max(c.g, c.b)); float soft = clamp(br - uThreshold.x + uThreshold.y, 0.0, 2.0 * uThreshold.y); soft = soft * soft / (4.0 * uThreshold.y + 1e-4); return c * max(soft, br - uThreshold.x) / max(br, 1e-4); }
      float karis(vec3 c){ return 1.0 / (1.0 + rvLuma(c)); }
      void main(){
        float e = uThreshold.z;
        if (uThreshold.w > 0.5) { float avg = exp2(texture2D(tLum, vec2(0.5)).r); e *= clamp(uAuto.x / max(avg, 1e-5), uAuto.y, uAuto.z); }
        vec3 a = texture2D(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb, b = texture2D(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb;
        vec3 c = texture2D(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb, d = texture2D(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        float lum = 0.25 * (log2(max(rvLuma(a), 1e-5)) + log2(max(rvLuma(b), 1e-5)) + log2(max(rvLuma(c), 1e-5)) + log2(max(rvLuma(d), 1e-5)));
        a = pre(a, e); b = pre(b, e); c = pre(c, e); d = pre(d, e);
        float wa = karis(a), wb = karis(b), wc = karis(c), wd = karis(d);
        gl_FragColor = vec4((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd), lum);
      }`,
      { tColor: { value: null }, tLum: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: new THREE.Vector4(1, 0.5, 1, 0) }, uAuto: { value: new THREE.Vector3(0.18, 0.25, 8) } });

    this.downMat = mat(/* glsl */`
      uniform sampler2D tColor; uniform vec2 uTexel; varying vec2 vUv;
      void main(){ // 13-tap (Jimenez, "Next Generation Post Processing in Call of Duty")
        vec4 A = texture2D(tColor, vUv + uTexel * vec2(-2.0, -2.0)), B = texture2D(tColor, vUv + uTexel * vec2(0.0, -2.0)), C = texture2D(tColor, vUv + uTexel * vec2(2.0, -2.0));
        vec4 D = texture2D(tColor, vUv + uTexel * vec2(-1.0, -1.0)), E = texture2D(tColor, vUv + uTexel * vec2(1.0, -1.0));
        vec4 F = texture2D(tColor, vUv + uTexel * vec2(-2.0, 0.0)), G = texture2D(tColor, vUv), H = texture2D(tColor, vUv + uTexel * vec2(2.0, 0.0));
        vec4 I = texture2D(tColor, vUv + uTexel * vec2(-1.0, 1.0)), J = texture2D(tColor, vUv + uTexel * vec2(1.0, 1.0));
        vec4 K = texture2D(tColor, vUv + uTexel * vec2(-2.0, 2.0)), L = texture2D(tColor, vUv + uTexel * vec2(0.0, 2.0)), M = texture2D(tColor, vUv + uTexel * vec2(2.0, 2.0));
        gl_FragColor = (D + E + I + J) * 0.125 + (A + B + G + F) * 0.03125 + (B + C + H + G) * 0.03125 + (F + G + L + K) * 0.03125 + (G + H + M + L) * 0.03125;
      }`, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } });

    this.upMat = mat(/* glsl */`
      uniform sampler2D tColor; uniform vec2 uTexel; uniform float uWeight; varying vec2 vUv;
      void main(){ // 3x3 tent
        vec3 s = texture2D(tColor, vUv).rgb * 4.0;
        s += (texture2D(tColor, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(1.0, 0.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(0.0, 1.0)).rgb) * 2.0;
        s += texture2D(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        gl_FragColor = vec4(s * (uWeight / 16.0), 0.0);
      }`, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } },
      { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, transparent: true });

    // Auto-exposure metering: brightness- and centre-weighted log-luminance, so black space never drags exposure up.
    this.meterMat = mat(/* glsl */`
      ${GLSL.common}
      uniform sampler2D tColor; varying vec2 vUv;
      void main(){
        vec2 acc = vec2(0.0);
        for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++){
          vec2 uv = vUv + (vec2(float(x), float(y)) - 1.5) / (64.0 * 4.0);
          float l = rvLuma(min(texture2D(tColor, uv).rgb, vec3(64.0)));
          vec2 c = uv - 0.5; float w = smoothstep(0.0, 0.03, l) * (0.35 + 0.65 * exp(-dot(c, c) * 5.0));
          acc += vec2(w * log2(max(l, 1e-4)), w);
        }
        gl_FragColor = vec4(acc / 16.0, 0.0, 1.0);
      }`, { tColor: { value: null } });
    this.boxMat = mat(/* glsl */`
      uniform sampler2D tColor; uniform vec2 uTexel; varying vec2 vUv;
      void main(){ vec4 s = vec4(0.0); for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) s += texture2D(tColor, vUv + (vec2(float(x), float(y)) - 1.5) * uTexel); gl_FragColor = s / 16.0; }`,
      { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.lumMat = mat(/* glsl */`
      uniform sampler2D tLast; uniform sampler2D tPrev; uniform vec3 uAdapt; // (speedUp, speedDown, dt)  uAdapt.z<0 → snap
      varying vec2 vUv;
      void main(){
        vec2 s = vec2(0.0); for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) s += texture2D(tLast, (vec2(float(x), float(y)) + 0.5) / 4.0).rg;
        float prev = texture2D(tPrev, vec2(0.5)).r;
        float cur = s.y > 1e-4 ? s.x / s.y : (uAdapt.z < 0.0 ? -2.5 : prev);
        float k = cur > prev ? uAdapt.x : uAdapt.y;
        float v = uAdapt.z < 0.0 ? cur : mix(prev, cur, 1.0 - exp(-uAdapt.z * k));
        gl_FragColor = vec4(v, v, v, 1.0);
      }`, { tLast: { value: null }, tPrev: { value: null }, uAdapt: { value: new THREE.Vector3(2.5, 1, 0.016) } });

    this.compositeUniforms = {
      tHDR: { value: null }, tBloom: { value: null }, tLum: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
      uExposure: { value: 1 }, uAutoOn: { value: 0 }, uAuto: { value: new THREE.Vector3(0.18, 0.25, 8) },
      uTonemap: { value: 1 }, uBloom: { value: 0.7 },
      uContrast: { value: 1 }, uSaturation: { value: 1 }, uTemperature: { value: 0 },
      uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) }, uGain: { value: new THREE.Vector3(1, 1, 1) },
      uVignette: { value: 0.2 }, uGrain: { value: 0.015 }, uCA: { value: 0 },
      uWarp: { value: 0 }, uFade: { value: 0 }, uFadeColor: { value: this.fadeColor }, uLetterbox: { value: 0 }, uFlash: { value: 0 },
    };
    this.compositeMat = mat(/* glsl */`
      ${GLSL.common}
      #include <tonemapping_pars_fragment>
      uniform sampler2D tHDR; uniform sampler2D tBloom; uniform sampler2D tLum;
      uniform vec2 uRes; uniform float uTime;
      uniform float uExposure; uniform float uAutoOn; uniform vec3 uAuto; uniform int uTonemap; uniform float uBloom;
      uniform float uContrast; uniform float uSaturation; uniform float uTemperature;
      uniform vec3 uLift; uniform vec3 uGamma; uniform vec3 uGain;
      uniform float uVignette; uniform float uGrain; uniform float uCA;
      uniform float uWarp; uniform float uFade; uniform vec3 uFadeColor; uniform float uLetterbox; uniform float uFlash;
      varying vec2 vUv;

      vec3 sampleScene(vec2 uv){ return texture2D(tHDR, uv).rgb + texture2D(tBloom, uv).rgb * uBloom; }

      void main(){
        vec2 uv = vUv; vec2 c = uv - 0.5; float aspect = uRes.x / uRes.y; float r = length(c * vec2(aspect, 1.0));
        vec3 col;
        if (uWarp > 0.001) {
          // hyperspace: radial streaks with spectral dispersion, sampled toward the vanishing point
          const int N = 14; vec3 acc = vec3(0.0); float wsum = 0.0; float j = rvIGN(gl_FragCoord.xy + 13.0 * fract(uTime));
          float amt = uWarp * uWarp * 0.55;
          for (int i = 0; i < N; i++){
            float t = (float(i) + j) / float(N); float w = 1.0 - t * 0.6;
            vec2 o = c * (1.0 - amt * t);
            vec3 s; s.r = sampleScene(0.5 + o * (1.0 + 0.012 * uWarp)).r; s.g = sampleScene(0.5 + o).g; s.b = sampleScene(0.5 + o * (1.0 - 0.012 * uWarp)).b;
            acc += s * w; wsum += w;
          }
          col = acc / wsum; col *= 1.0 + uWarp * uWarp * 1.6 * smoothstep(0.9, 0.0, r);
        } else if (uCA > 0.0005) {
          vec2 o = c * uCA * r * 0.02;
          col = vec3(sampleScene(uv + o).r, sampleScene(uv).g, sampleScene(uv - o).b);
        } else col = sampleScene(uv);

        float e = uExposure;
        if (uAutoOn > 0.5) { float avg = exp2(texture2D(tLum, vec2(0.5)).r); e *= clamp(uAuto.x / max(avg, 1e-5), uAuto.y, uAuto.z); }
        col *= e;
        col += uFlash;
        // white balance (cheap temperature shift in linear)
        col *= mix(vec3(1.0), uTemperature > 0.0 ? vec3(1.10, 1.0, 0.86) : vec3(0.86, 0.97, 1.14), abs(uTemperature));

        if (uTonemap == 1) { col = AgXToneMapping(col); col = pow(col, vec3(1.12)); }        // AgX + a touch of "punchy"
        else if (uTonemap == 2) col = ACESFilmicToneMapping(col);
        else if (uTonemap == 3) col = NeutralToneMapping(col);
        else col = clamp(col, 0.0, 1.0);

        // grade (display-referred, still linear)
        col = pow(max(col, 0.0), 1.0 / max(uGamma, vec3(0.01))) * uGain + uLift * (1.0 - col);
        float l = rvLuma(col);
        col = mix(vec3(l), col, uSaturation * (uTonemap == 1 ? 1.18 : 1.0));
        col = mix(vec3(0.18), col, uContrast);
        col = max(col, 0.0);

        float vig = 1.0 - uVignette * smoothstep(0.35, 1.15, r) ; col *= vig * vig;
        col = mix(col, uFadeColor, uFade);

        // linear → sRGB
        col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));

        // film grain (luma-weighted, fades to zero in black) + triangular dither that never lifts pure black
        float lum = rvLuma(col);
        float g = rvTriNoise(gl_FragCoord.xy, uTime);
        col += g * uGrain * smoothstep(0.0, 0.12, lum) * (1.0 - 0.6 * lum);
        col += rvTriNoise(gl_FragCoord.xy + 91.7, uTime * 1.31) * (1.0 / 255.0) * smoothstep(0.0, 2.5 / 255.0, lum);

        if (uLetterbox > 0.001) { float bar = 0.5 - 0.5 * (1.0 - uLetterbox * 0.24); col *= step(bar, vUv.y) * step(vUv.y, 1.0 - bar); }
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }`, this.compositeUniforms);

    this.fxaaMat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms), vertexShader: FXAAShader.vertexShader, fragmentShader: FXAAShader.fragmentShader, depthTest: false, depthWrite: false, toneMapped: false });
    this.quad = new FullScreenQuad(this.blitMat);
    this._proj = new THREE.Matrix4();
  }

  setSize(width, height, renderScale = this.renderScale) {
    this.width = Math.max(1, Math.floor(width)); this.height = Math.max(1, Math.floor(height));
    this.renderScale = renderScale;
    const rw = Math.max(1, Math.round(this.width * renderScale)), rh = Math.max(1, Math.round(this.height * renderScale));
    if (rw === this.rw && rh === this.rh && this._sized) { this.ldrRT.setSize(this.width, this.height); return; }
    this._sized = true; this.rw = rw; this.rh = rh;
    this.sceneRT.setSize(rw, rh); this.opaqueRT.setSize(rw, rh); this.hdrA.setSize(rw, rh); this.hdrB.setSize(rw, rh);
    let w = rw, h = rh;
    for (const rt of this.bloomRT) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); rt.setSize(w, h); }
    this.ldrRT.setSize(this.width, this.height);
    this.shared.uOpaqueTexel.value.set(1 / rw, 1 / rh);
  }

  _draw(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene  @param {THREE.Camera} o.camera
   * @param {PostPass[]} [o.passes]  @param {object} [o.grade]  @param {number} o.dt  @param {number} o.time
   */
  render({ scene, camera, passes = [], grade, dt = 0.016, time = 0 }) {
    const r = this.renderer, g = grade || (this._defGrade ??= defaultGrade());
    this.frame++;
    r.autoClear = false;
    this.shared.uCamNear.value = camera.near; this.shared.uCamFar.value = camera.far;

    // 1 ─ opaque scene
    camera.layers.set(LAYERS.DEFAULT);
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 1); r.clear(true, true, false);
    r.render(scene, camera);

    // 2 ─ refractive layer (only if anything lives on it)
    if (scene.userData.hasRefractive) {
      this.copyMat.uniforms.tColor.value = this.sceneRT.texture; this.copyMat.uniforms.tDepth.value = this.sceneRT.depthTexture;
      this._draw(this.copyMat, this.opaqueRT);
      camera.layers.set(LAYERS.REFRACTIVE);
      const su = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;   // shadow maps were just rendered
      r.setRenderTarget(this.sceneRT);
      r.render(scene, camera);
      r.shadowMap.autoUpdate = su;
      camera.layers.set(LAYERS.DEFAULT);
    }

    // 3 ─ realm HDR passes
    let read = this.sceneRT.texture, write = this.hdrA;
    const info = { renderer: r, camera, time, dt, width: this.rw, height: this.rh };
    for (const p of passes) {
      if (!p || !p.enabled) continue;
      const u = p.uniforms;
      u.tColor.value = read; u.tDepth.value = this.sceneRT.depthTexture; u.uResolution.value.set(this.rw, this.rh);
      u.uTime.value = time; u.uDt.value = dt; u.uFrame.value = this.frame;
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      u.uViewInv.value.copy(camera.matrixWorld); u.uView.value.copy(camera.matrixWorldInverse);
      u.uProj.value.copy(camera.projectionMatrix); u.uProjInv.value.copy(camera.projectionMatrixInverse);
      u.uProjScale.value.set(1 / camera.projectionMatrix.elements[0], 1 / camera.projectionMatrix.elements[5]);
      u.uCamNear.value = camera.near; u.uCamFar.value = camera.far;
      p.onBeforeRender(info);
      this.quad.material = p.material; r.setRenderTarget(write); this.quad.render(r);
      read = write.texture; write = write === this.hdrA ? this.hdrB : this.hdrA;
    }

    // 4 ─ bloom + luminance
    const auto = g.autoExposure, B = this.bloomRT, bl = g.bloom || {};
    const lumPrev = this.lumRT[this._lumIndex], lumNext = this.lumRT[1 - this._lumIndex];
    const pu = this.prefilterMat.uniforms;
    pu.tColor.value = read; pu.tLum.value = lumPrev.texture; pu.uTexel.value.set(0.5 / this.rw, 0.5 / this.rh);
    pu.uThreshold.value.set(bl.threshold ?? 1, Math.max(bl.knee ?? 0.5, 1e-3), g.exposure ?? 1, auto ? 1 : 0);
    if (auto) pu.uAuto.value.set(auto.key ?? 0.18, auto.min ?? 0.25, auto.max ?? 8);
    this._draw(this.prefilterMat, B[0]);
    for (let i = 1; i < B.length; i++) {
      this.downMat.uniforms.tColor.value = B[i - 1].texture; this.downMat.uniforms.uTexel.value.set(1 / B[i - 1].width, 1 / B[i - 1].height);
      this._draw(this.downMat, B[i]);
    }
    // temporal luminance from the metering chain (64² → 16² → 4² → 1)
    const M = this.meterRT;
    this.meterMat.uniforms.tColor.value = read; this._draw(this.meterMat, M[0]);
    for (let i = 1; i < M.length; i++) { this.boxMat.uniforms.tColor.value = M[i - 1].texture; this.boxMat.uniforms.uTexel.value.set(1 / M[i - 1].width, 1 / M[i - 1].height); this._draw(this.boxMat, M[i]); }
    const lu = this.lumMat.uniforms;
    lu.tLast.value = M[M.length - 1].texture; lu.tPrev.value = lumPrev.texture;
    lu.uAdapt.value.set(auto?.speedUp ?? 2.5, auto?.speedDown ?? 1.0, this._lumInit ? dt : -1);
    this._draw(this.lumMat, lumNext); this._lumIndex = 1 - this._lumIndex; this._lumInit = true;
    const radius = bl.radius ?? 1;
    for (let i = B.length - 2; i >= 0; i--) {
      this.upMat.uniforms.tColor.value = B[i + 1].texture; this.upMat.uniforms.uTexel.value.set(radius / B[i + 1].width, radius / B[i + 1].height);
      this.upMat.uniforms.uWeight.value = 1.0;
      this._draw(this.upMat, B[i]);
    }

    // 5 ─ composite
    const cu = this.compositeUniforms;
    cu.tHDR.value = read; cu.tBloom.value = B[0].texture; cu.tLum.value = this.lumRT[this._lumIndex].texture;
    cu.uRes.value.set(this.width, this.height); cu.uTime.value = time % 1000;
    cu.uExposure.value = g.exposure ?? 1; cu.uAutoOn.value = auto ? 1 : 0;
    if (auto) cu.uAuto.value.set(auto.key ?? 0.18, auto.min ?? 0.25, auto.max ?? 8);
    cu.uTonemap.value = TONEMAP[g.tonemap ?? 'agx'] ?? 1;
    cu.uBloom.value = (bl.strength ?? 0.7) / B.length * 2.0;
    cu.uContrast.value = g.contrast ?? 1; cu.uSaturation.value = g.saturation ?? 1; cu.uTemperature.value = g.temperature ?? 0;
    cu.uLift.value.fromArray(g.lift ?? [0, 0, 0]); cu.uGamma.value.fromArray(g.gamma ?? [1, 1, 1]); cu.uGain.value.fromArray(g.gain ?? [1, 1, 1]);
    cu.uVignette.value = g.vignette ?? 0.2; cu.uGrain.value = g.grain ?? 0.015; cu.uCA.value = g.ca ?? 0;
    cu.uWarp.value = this.warp; cu.uFade.value = this.fade; cu.uLetterbox.value = this.letterbox; cu.uFlash.value = this.flash;

    if (this.fxaa) {
      this._draw(this.compositeMat, this.ldrRT);
      this.fxaaMat.uniforms.tDiffuse.value = this.ldrRT.texture; this.fxaaMat.uniforms.resolution.value.set(1 / this.width, 1 / this.height);
      this._draw(this.fxaaMat, null);
    } else {
      this._draw(this.compositeMat, null);
    }
    r.setRenderTarget(null);
  }

  dispose() {
    [this.sceneRT, this.opaqueRT, this.hdrA, this.hdrB, this.ldrRT, ...this.bloomRT, ...this.lumRT, ...this.meterRT].forEach((rt) => rt.dispose());
    [this.copyMat, this.blitMat, this.prefilterMat, this.downMat, this.upMat, this.lumMat, this.meterMat, this.boxMat, this.compositeMat, this.fxaaMat].forEach((m) => m.dispose());
  }
}
