// CosmicSim — GPU particle-mesh gravity with COLA time stepping (Tassev+ 2013), driven from JS.
// OWNED BY THE COSMIC TRACK.
//
//   state      X (residual position) + P (residual momentum) per particle, MRT ping-pong (float RGBA)
//   one step   CIC deposit (point sprites, additive) → fold periodic ghosts → 3D FFT (Stockham, 2 complex
//              per texel) → Green's function + gradient in k-space → inverse FFT → field (ρ, Φ, |∇Φ|)
//              for rendering → COLA kick + drift
//
// All sim passes are RawShaderMaterial GLSL3 on a shared full-screen triangle. Everything here is
// guarded: if a float render target is not supported the solver reports `ok = false` and the mode
// falls back to pure 2LPT trajectories (still physically grounded, just no nonlinear collapse).
import * as THREE from 'three';
import * as S from './shaders.js';
const _cc0 = new THREE.Color(), _cc1 = new THREE.Color(), _cc2 = new THREE.Color();
import { D1, D2, driftFactor, kickFactor } from './cosmology.js';

const RAW = (vs, fs, uniforms, extra = {}) => new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3, vertexShader: vs, fragmentShader: fs, uniforms,
  depthTest: false, depthWrite: false, ...extra,
});
const ADD = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, transparent: true };

/** Tiles per row for an n³ slice atlas: as square as possible with power-of-two widths. */
export function atlasTiles(n) {
  const t = 1 << Math.ceil(Math.log2(Math.sqrt(n)));
  return Math.min(t, n);
}

export class CosmicSim {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{N:number, M:number, sub:(a:number)=>number}} opt  lattice size, mesh size, sub-mesh growth law
   */
  constructor(renderer, opt) {
    this.r = renderer;
    this.N = opt.N; this.M = opt.M;
    this.dsOf = opt.sub;
    this.tilesX = atlasTiles(this.N);
    this.meshTiles = atlasTiles(this.M);
    this.W = this.tilesX * this.N; this.H = (this.N / this.tilesX) * this.N;
    this.MW = this.meshTiles * this.M; this.MH = (this.M / this.meshTiles) * this.M;
    this.PW = this.meshTiles * (this.M + 2); this.PH = (this.M / this.meshTiles) * (this.M + 2);
    const ext = renderer.extensions;
    this.floatRT = !!ext.has('EXT_color_buffer_float');
    this.floatBlend = this.floatRT && !!ext.has('EXT_float_blend');
    this.ok = this.floatRT;
    this.stateType = this.floatRT ? THREE.FloatType : THREE.HalfFloatType;
    this.steps = 0;
    this.aState = null;          // a of the positions stored in X (a_{i+1} after a step)
    this.aPrevHalf = null;       // a at which P lives (a_{i+1/2})
    this.field = { a: [null, null], cur: 0 };

    // ------------------------------------------------------------------ shared uniforms
    const zeroTex = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    zeroTex.needsUpdate = true;
    this.zeroTex = zeroTex;
    this.U = {
      uN: { value: this.N }, uTilesX: { value: this.tilesX }, uM: { value: this.M }, uMTiles: { value: this.meshTiles },
      tPsiA: { value: zeroTex }, tPsiB: { value: zeroTex }, tPsiS: { value: zeroTex },
      tX: { value: zeroTex }, tP: { value: zeroTex },
    };

    // ------------------------------------------------------------------ targets
    const rt = (w, h, o = {}) => new THREE.WebGLRenderTarget(w, h, {
      type: this.stateType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, ...o,
    });
    this.xp = [rt(this.W, this.H, { count: 2 }), rt(this.W, this.H, { count: 2 })];
    this.xpCur = 0;
    this.dep = rt(this.PW, this.PH, { type: this.floatBlend ? THREE.FloatType : THREE.HalfFloatType });
    this.fold = rt(this.MW, this.MH);
    this.meshA = rt(this.MW, this.MH);
    this.meshB = rt(this.MW, this.MH);
    this.pot = null;
    // particle-resolution render density field (lattice N, padded, filterable)
    this.FW = this.tilesX * (this.N + 2); this.FH = (this.N / this.tilesX) * (this.N + 2);
    this.depHi = rt(this.FW, this.FH, { type: this.floatBlend ? THREE.FloatType : THREE.HalfFloatType });
    const fieldOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.fields = [rt(this.FW, this.FH, fieldOpts), rt(this.FW, this.FH, fieldOpts)];
    this.targets = [...this.xp, this.dep, this.depHi, this.fold, this.meshA, this.meshB, ...this.fields];

    // ------------------------------------------------------------------ passes
    const head = S.GLSL_HEAD + S.GLSL_ATLAS;
    const vs = head + S.FS_VERT;
    const U = this.U;
    this.mFold = RAW(vs, head + S.FOLD_FRAG, { ...U, tDep: { value: this.dep.texture } });
    this.mFFT = RAW(vs, head + S.FFT_FRAG, { ...U, tIn: { value: null }, uAxis: { value: 0 }, uSub: { value: 2 }, uSign: { value: -1 } });
    this.mK = RAW(vs, head + S.KSPACE_FRAG, { ...U, tIn: { value: null }, uSmooth: { value: 0.7 } });
    const UH = { ...U, uM: { value: this.N }, uMTiles: { value: this.tilesX } };
    this.mFoldHi = RAW(vs, head + S.FOLDPAD_FRAG, { ...UH, tDep: { value: this.depHi.texture } });
    // step-time position uniforms are private to the sim passes (render uses its own set)
    this.SU = { uD1: { value: 0 }, uD2: { value: 0 }, uDS: { value: 0 }, uG: { value: 0 } };
    this.mKick = RAW(vs, head + S.GLSL_POSITION + S.KICK_FRAG, { ...U, ...this.SU, tPot: { value: null }, uKick: { value: 0 }, uDrift: { value: 0 } });
    this.mDep = RAW(head + S.GLSL_POSITION + S.DEPOSIT_VERT, head + S.DEPOSIT_FRAG,
      { ...U, ...this.SU, uStride: { value: this.N / this.M }, uPadSize: { value: new THREE.Vector2(this.PW, this.PH) } }, ADD);

    this.tri = new THREE.BufferGeometry();
    this.tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(this.tri, this.mFold);
    this.quad.frustumCulled = false;
    this.qScene = new THREE.Scene(); this.qScene.add(this.quad);
    this.qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const dg = new THREE.BufferGeometry();
    dg.setDrawRange(0, 2 * this.M * this.M * this.M);
    this.depPts = new THREE.Points(dg, this.mDep);
    this.depPts.frustumCulled = false;
    this.depScene = new THREE.Scene(); this.depScene.add(this.depPts);
    this.mDepHi = RAW(head + S.GLSL_POSITION + S.DEPOSIT_VERT, head + S.DEPOSIT_FRAG,
      { ...UH, ...this.SU, uStride: { value: 1 }, uPadSize: { value: new THREE.Vector2(this.FW, this.FH) } }, ADD);
    const dh = new THREE.BufferGeometry();
    dh.setDrawRange(0, 2 * this.N * this.N * this.N);
    this.depHiPts = new THREE.Points(dh, this.mDepHi);
    this.depHiPts.frustumCulled = false;
    this.depHiScene = new THREE.Scene(); this.depHiScene.add(this.depHiPts);

    this._clearAll();
  }

  get X() { return this.xp[this.xpCur].textures[0]; }
  get P() { return this.xp[this.xpCur].textures[1]; }
  get fieldTexA() { return this.fields[1 - this.field.cur].texture; }   // older
  get fieldTexB() { return this.fields[this.field.cur].texture; }       // newer

  setIC({ psiA, psiB, psiS }) {
    if (psiA) this.U.tPsiA.value = psiA;
    if (psiB) { this.U.tPsiB.value = psiB; this.hasB = true; }
    if (psiS) { this.U.tPsiS.value = psiS; this.hasS = true; }
  }

  _clearAll() {
    const r = this.r, prev = r.getRenderTarget();
    const cc = r.getClearColor(_cc0), ca = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of this.targets) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setClearColor(cc, ca); r.setRenderTarget(prev);
  }

  /** Restart from pure 2LPT (residual = 0). */
  reset() {
    this._clearAll();
    this.xpCur = 0; this.steps = 0; this.aState = null; this.aPrevHalf = null;
    this.field.a = [null, null];
  }

  _pass(mat, target) {
    this.quad.material = mat;
    this.r.setRenderTarget(target);
    this.r.render(this.qScene, this.qCam);
  }

  _fft(srcTex, sign) {
    // Stockham radix-2 along x, y, z; ping-pong meshA/meshB. Returns the RT holding the result.
    const m = this.mFFT, L = Math.round(Math.log2(this.M));
    let src = srcTex, dst = srcTex === this.meshA.texture ? this.meshB : this.meshA;
    m.uniforms.uSign.value = sign;
    for (let axis = 0; axis < 3; axis++) {
      for (let s = 1; s <= L; s++) {
        m.uniforms.tIn.value = src;
        m.uniforms.uAxis.value = axis;
        m.uniforms.uSub.value = 1 << s;
        this._pass(m, dst);
        src = dst.texture;
        dst = dst === this.meshA ? this.meshB : this.meshA;
      }
    }
    return src === this.meshA.texture ? this.meshA : this.meshB;
  }

  /**
   * One COLA step: positions known at aFrom (this.aState, or pure 2LPT for the first step),
   * momentum known at this.aPrevHalf. Advances X to aTo, P to (aFrom+aTo)/2.
   */
  step(aFrom, aTo, withField = true) {
    const r = this.r;
    const prevRT = r.getRenderTarget();
    const autoClear = r.autoClear;
    const cc = r.getClearColor(_cc1), ca = r.getClearAlpha();
    r.autoClear = false;
    try {
      const aHalf = 0.5 * (aFrom + aTo);
      const aKick0 = this.aPrevHalf ?? aFrom;
      const su = this.SU;
      su.uD1.value = D1(aFrom); su.uD2.value = this.hasB ? D2(aFrom) : 0; su.uDS.value = this.hasS ? this.dsOf(aFrom) : 0; su.uG.value = 0;
      this.U.tX.value = this.X; this.U.tP.value = this.P;

      // 1. CIC deposit of the M³ source lattice
      r.setClearColor(0x000000, 0);
      r.setRenderTarget(this.dep); r.clear(true, false, false);
      r.render(this.depScene, this.qCam);
      // 2. fold ghosts → (δ, 0, ρ, 0)
      this._pass(this.mFold, this.fold);
      // 3. forward FFT, Green's function, inverse FFT
      const res = this._fft(this.fold.texture, -1);
      const kDst = res === this.meshA ? this.meshB : this.meshA;
      this.mK.uniforms.tIn.value = res.texture;
      this._pass(this.mK, kDst);
      const potRT = this._fft(kDst.texture, 1);
      // the potential must survive until kick + field: copy target identity
      // 4. particle-resolution render density (all particles, incl. sub-mesh displacements)
      if (withField) this.renderField(aFrom, false);
      // 5. COLA kick + drift
      const nxt = 1 - this.xpCur;
      this.mKick.uniforms.tPot.value = potRT.texture;
      this.mKick.uniforms.uKick.value = kickFactor(aKick0, aHalf);
      this.mKick.uniforms.uDrift.value = driftFactor(aFrom, aTo);
      this.U.tX.value = this.X; this.U.tP.value = this.P;
      this._pass(this.mKick, this.xp[nxt]);
      this.xpCur = nxt;
      this.U.tX.value = this.X; this.U.tP.value = this.P;
      this.aState = aTo; this.aPrevHalf = aHalf; this.steps++;
    } finally {
      r.autoClear = autoClear;
      r.setClearColor(cc, ca);
      r.setRenderTarget(prevRT);
    }
  }

  /** Deposit every particle at the current state (positions at aState, or pure 2LPT at `a`). */
  renderField(a, standalone = true) {
    const r = this.r;
    const prevRT = r.getRenderTarget(), autoClear = r.autoClear;
    const cc = r.getClearColor(_cc2), ca = r.getClearAlpha();
    try {
      r.autoClear = false;
      const su = this.SU;
      if (standalone) {
        su.uD1.value = D1(a); su.uD2.value = this.hasB ? D2(a) : 0; su.uDS.value = this.hasS ? this.dsOf(a) : 0; su.uG.value = 0;
        this.U.tX.value = this.X; this.U.tP.value = this.P;
      }
      r.setClearColor(0x000000, 0);
      r.setRenderTarget(this.depHi); r.clear(true, false, false);
      r.render(this.depHiScene, this.qCam);
      const slot = 1 - this.field.cur;
      this._pass(this.mFoldHi, this.fields[slot]);
      this.field.cur = slot; this.field.a[slot] = a;
    } finally {
      r.autoClear = autoClear; r.setClearColor(cc, ca); r.setRenderTarget(prevRT);
    }
  }

  dispose() {
    for (const t of this.targets) t.dispose();
    for (const m of [this.mFold, this.mFFT, this.mK, this.mFoldHi, this.mKick, this.mDep, this.mDepHi]) m.dispose();
    this.tri.dispose(); this.depPts.geometry.dispose(); this.depHiPts.geometry.dispose(); this.zeroTex.dispose();
  }
}
