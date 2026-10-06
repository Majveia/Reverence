// Weather: state machine + precipitation / dust particles + lightning (OWNED BY THE ATMOSPHERE TRACK).
//
//  State (atmo.weather): rain, snow, dust, fog, storm, wind, coverBoost, sunDim, flash — derived from
//  body.weather / art.weather and a slow deterministic cycle (seeded by body.seed, driven by world.time).
//  URL override for captures: &weather=clear|rain|storm|snow|dust|fog|aurora  (&lightning=1 forces a
//  strike on the captured frame).
//  Drives G.uWetness (rain soaks, slowly dries), G.uSnow (accumulates), G.uWindStrength (gusts + storm).
//
//  Rendering: pipeline effect "weather" (order 125, after clouds / god rays): camera-local particle
//  volume wrapped in the vertex shader (zero per-frame CPU work), soft depth test against the scene
//  depth; rain = motion-blurred streaks, snow = tumbling flakes, dust = wind-driven motes.
//  Lightning: bolt ribbon + cloud flash (clouds uFlash) + environment flash.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { Params } from '../../core/Params.js';
import { fsMaterial, FSQuad } from './fs.js';

const clamp = THREE.MathUtils.clamp, smooth = THREE.MathUtils.smoothstep;

const P_VERT = /* glsl */`
attribute vec4 aSeed;
uniform vec3 uCam;          // camera scene position
uniform vec3 uOffset;       // accumulated drift (m), scene space
uniform float uBox;         // volume size (m)
uniform float uAmount;      // visible fraction 0..1
uniform vec3 uFall;         // streak direction × length (m) (velocity × shutter)
uniform float uWidth;
uniform float uKind;        // 0 rain, 1 snow, 2 dust
uniform float uTime;
uniform float uSheet;       // 1: far rain sheet (larger volume, fainter, thinner)
varying vec2 vQ;
varying float vViewZ;
varying float vFade;
varying float vVar;
void main(){
  if (aSeed.w > uAmount){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // per-particle variation (no regular diagonal grid): length, width, opacity, fall speed jitter
  float r1 = fract(aSeed.x * 91.7 + aSeed.y * 47.3 + aSeed.z * 13.1);
  float r2 = fract(aSeed.y * 63.1 + aSeed.z * 29.7 + aSeed.w * 7.3);
  vVar = 0.3 + 0.7 * r2 * r2;
  vec3 seedP = aSeed.xyz + vec3(0.0, r1 * 0.37, 0.0);
  vec3 rel = mod(seedP * uBox - uCam - uOffset * (0.85 + 0.3 * r1), uBox) - 0.5 * uBox;
  // snow / dust wobble
  if (uKind > 0.5){
    float ph = aSeed.w * 71.0;
    rel += vec3(sin(uTime * 1.3 + ph), sin(uTime * 0.9 + ph * 1.7) * 0.5, cos(uTime * 1.1 + ph * 0.7)) * (uKind > 1.5 ? 0.6 : 0.25);
  }
  vec3 wp = uCam + rel;
  vec3 camToP = normalize(rel);
  vec3 a = uFall * (uKind < 0.5 ? 0.55 + 1.1 * r1 : 1.0);
  vec3 side;
  if (uKind < 0.5){
    side = normalize(cross(a, camToP) + 1e-5) * uWidth * (0.7 + 0.7 * r2);
  } else {
    // camera-facing flake
    vec3 up = normalize(cross(camToP, vec3(0.0, 1.0, 0.0)) + 1e-5);
    side = up * uWidth;
    a = normalize(cross(side, camToP)) * uWidth * 2.0;
  }
  vec3 p = wp + side * position.x + a * (position.y - 0.5);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewZ = -mv.z;
  vQ = position.xy;
  float d = length(rel);
  vFade = smoothstep(uKind < 0.5 ? 1.8 : 0.3, uKind < 0.5 ? 6.0 : 1.5, d) * (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, d));
  // far sheet: only beyond the near volume, fading in (one continuous curtain of rain into the distance)
  if (uSheet > 0.5) vFade = smoothstep(9.0, 16.0, d) * (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, d));
  gl_Position = projectionMatrix * mv;
}`;

const P_FRAG = /* glsl */`
#include <rv_common>
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uNear;
uniform float uFar;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uKind;
varying vec2 vQ;
varying float vViewZ;
varying float vFade;
varying float vVar;
void main(){
  float dz = texture2D(tDepth, gl_FragCoord.xy / uRes).r;
  float sceneZ = rv_viewZFromDepth(dz, uNear, uFar);
  float soft = clamp((sceneZ - vViewZ) / 0.6, 0.0, 1.0);
  if (soft <= 0.0) discard;
  float a;
  if (uKind < 0.5){
    float x = vQ.x;
    a = (1.0 - x * x) * smoothstep(0.0, 0.25, vQ.y) * (1.0 - smoothstep(0.7, 1.0, vQ.y));
  } else {
    vec2 q = vec2(vQ.x, vQ.y * 2.0 - 1.0);
    a = max(0.0, 1.0 - dot(q, q));
    a *= a;
  }
  a *= uAlpha * vFade * soft * (uKind < 0.5 ? vVar : 1.0);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * a, a);
}`;

const COPY_FRAG = /* glsl */`
uniform sampler2D tColor;
varying vec2 vUv;
void main(){ gl_FragColor = vec4(texture2D(tColor, vUv).rgb, 1.0); }`;

export class Weather {
  constructor(atmo) {
    this.atmo = atmo;
    const w = atmo.world, body = w.body;
    this.world = w;
    this.name = 'weather';
    this.order = 125;
    this.enabled = true;
    const bw = body.weather || {}, aw = body.art?.weather || {};
    const cold = body.type === 'arctic' || (body.art?.key === 'friedrich');
    this.base = {
      rain: bw.rain ?? aw.rain ?? 0,
      snow: bw.snow ?? aw.snow ?? (cold ? 0.35 : 0),
      dust: bw.dust ?? aw.dust ?? 0,
      fog: bw.fog ?? aw.fog ?? 0,
      storms: bw.storms ?? 0,
      wind: bw.wind ?? aw.wind ?? 0.3,
      aurora: bw.aurora ?? 0,
    };
    this.stormType = body.clouds?.type === 'storm' || (Params.str?.('clouds') || '') === 'storm';
    if (this.stormType) this.base.storms = Math.max(this.base.storms, 0.5);
    this.cold = cold;
    this.present = atmo.model.present;
    this.override = (Params.str?.('weather') || '').toLowerCase();
    this.forceBolt = Params.bool?.('lightning') || false;
    this.seed = ((body.seed ?? 1) % 997) / 997;
    this.state = atmo.weather;
    Object.assign(this.state, { rain: 0, snow: 0, dust: 0, fog: this.base.fog, storm: 0, wind: this.base.wind, coverBoost: 0, sunDim: 1, flash: 0, boltDist: 0, boltTime: -1 });
    this.wet = 0; this.snowCover = cold ? 0.5 : 0;

    // ---- particles
    const q = w.quality;
    const n = { low: 2400, med: 6000, high: 12000, ultra: 16000 }[q.tier] ?? 12000;
    this.count = Math.round(n * (q.particleScale ?? 1));
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(this.count * 4);
    let s = (body.seed ?? 1) >>> 0 || 1;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    for (let i = 0; i < seeds.length; i++) seeds[i] = rnd();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = this.count;
    this.pu = {
      uCam: { value: new THREE.Vector3() }, uOffset: { value: new THREE.Vector3() },
      uBox: { value: 36 }, uAmount: { value: 0 }, uFall: { value: new THREE.Vector3(0, -1, 0) },
      uWidth: { value: 0.012 }, uKind: { value: 0 }, uTime: G.uTime,
      tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.05 }, uFar: { value: 2e10 },
      uColor: { value: new THREE.Color(0.5, 0.55, 0.6) }, uAlpha: { value: 0.3 }, uSheet: { value: 0 },
    };
    this.pmat = new THREE.ShaderMaterial({
      vertexShader: P_VERT, fragmentShader: P_FRAG, uniforms: this.pu,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Mesh(geo, this.pmat);
    this.points.frustumCulled = false;
    this.pscene = new THREE.Scene();
    this.pscene.add(this.points);
    this._drift = new THREE.Vector3();
    this._driftFar = new THREE.Vector3();

    // ---- lightning bolt ribbon (preallocated)
    // main channel (65 points, fractal midpoint displacement) + 3 branches (17 points each)
    this.boltMain = 65; this.boltBr = 17; this.boltBranches = 3;
    this.boltN = this.boltMain + this.boltBr * this.boltBranches;
    const bg = new THREE.BufferGeometry();
    this.boltPos = new Float32Array(this.boltN * 2 * 3);
    const bt = new Float32Array(this.boltN * 2);
    const idx = [];
    const strip = (start, n, t0, t1) => {
      for (let i = 0; i < n; i++) {
        const k = start + i;
        bt[k * 2] = bt[k * 2 + 1] = t0 + (t1 - t0) * i / (n - 1);
        if (i < n - 1) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
    };
    strip(0, this.boltMain, 0, 1);
    for (let b = 0; b < this.boltBranches; b++) strip(this.boltMain + b * this.boltBr, this.boltBr, 0.35, 1);
    this._bpts = Array.from({ length: this.boltMain }, () => new THREE.Vector3());
    this._bbr = Array.from({ length: this.boltBr }, () => new THREE.Vector3());
    bg.setAttribute('position', new THREE.BufferAttribute(this.boltPos, 3));
    bg.setAttribute('aT', new THREE.BufferAttribute(bt, 1));
    bg.setIndex(idx);
    this.boltMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */`
        attribute float aT; varying float vT; varying float vS; varying float vViewZ;
        void main(){ vT = aT; vS = float(gl_VertexID % 2) * 2.0 - 1.0; vec4 mv = modelViewMatrix * vec4(position, 1.0); vViewZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`
        #include <rv_common>
        uniform float uI; uniform sampler2D tDepth; uniform vec2 uRes; uniform float uNear; uniform float uFar;
        varying float vT; varying float vS; varying float vViewZ;
        void main(){
          // occluded by terrain / trees / buildings in front of it
          float sceneZ = rv_viewZFromDepth(texture2D(tDepth, gl_FragCoord.xy / uRes).r, uNear, uFar);
          if (vViewZ > sceneZ + 20.0) discard;
          float c = 1.0 - vS * vS; gl_FragColor = vec4(vec3(0.75, 0.82, 1.0) * uI * (c * c * 3.0 + 0.2), 1.0);
        }`,
      uniforms: { uI: { value: 0 }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.05 }, uFar: { value: 2e10 } },
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.bolt = new THREE.Mesh(bg, this.boltMat);
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    this.pscene.add(this.bolt);
    this._boltT = -1;
    this._boltLocal = new THREE.Vector3();
    this._nextStrike = 4 + this.seed * 6;

    this.quad = new FSQuad();
    this.copyMat = fsMaterial(COPY_FRAG, { tColor: { value: null } });
    this._envI = 1;
  }

  // ---------------------------------------------------------------- state machine
  _target(t) {
    const b = this.base, o = this.override;
    // slow deterministic cycle (~10 min), phase chosen so rainy worlds start wet
    const cyc = 0.5 + 0.5 * Math.cos((t / 600 + this.seed * 0.35) * Math.PI * 2);
    const cyc2 = 0.5 + 0.5 * Math.cos((t / 380 + this.seed) * Math.PI * 2);
    let rain = clamp((b.rain - 0.25) * 2.2 * (0.35 + 0.65 * cyc), 0, 1);
    let storm = clamp((b.storms - 0.4) * 2.0 * (0.3 + 0.7 * cyc2), 0, 1);
    let snow = clamp((b.snow - 0.15) * 2.2 * (0.4 + 0.6 * cyc), 0, 1);
    let dust = clamp((b.dust - 0.3) * 2.2 * (0.4 + 0.6 * cyc2), 0, 1);
    let fog = b.fog;
    let aurora = b.aurora;
    if (this.cold) { snow = Math.max(snow, rain); rain = 0; }
    switch (o) {
      case 'clear': rain = snow = dust = storm = 0; fog *= 0.4; break;
      case 'rain': rain = 1; snow = 0; dust = 0; break;
      case 'storm': rain = 1; storm = 1; snow = 0; dust = 0; break;
      case 'snow': snow = 1; rain = 0; dust = 0; break;
      case 'dust': dust = 1; rain = snow = storm = 0; break;
      case 'fog': fog = 1; rain = storm = dust = 0; break;
      case 'aurora': aurora = 1; rain = snow = dust = storm = 0; fog *= 0.3; break;
      default: break;
    }
    if (storm > 0) rain = Math.max(rain, this.cold ? 0 : storm * 0.9), snow = this.cold ? Math.max(snow, storm) : snow;
    // airless bodies have no weather at all
    if (!this.present) return { rain: 0, snow: 0, dust: 0, fog: 0, storm: 0, aurora: 0 };
    return { rain, snow, dust, fog, storm, aurora };
  }

  update(dt, t) {
    const st = this.state;
    const tg = this._target(t);
    const shot = this.world.engine.shot;
    const k = shot ? 1 : 1 - Math.exp(-dt / 8);
    st.rain += (tg.rain - st.rain) * k;
    st.snow += (tg.snow - st.snow) * k;
    st.dust += (tg.dust - st.dust) * k;
    st.fog += (tg.fog - st.fog) * k;
    st.storm += (tg.storm - st.storm) * k;
    st.aurora = tg.aurora;
    const precip = Math.max(st.rain, st.snow);
    // clear / aurora overrides break the deck up (aurora nights need clear air)
    const clearing = this.override === 'clear' ? 0.3 : this.override === 'aurora' ? 0.4 : 0;
    st.coverBoost = 0.55 * precip + 0.35 * st.storm + 0.15 * st.dust - clearing;
    // rain falls from a closed deck: the direct sun is mostly blocked (soft, shadowless light under it)
    st.sunDim = Math.max(0.04, 1 - 1.55 * precip - 0.4 * st.storm - 0.45 * st.dust);
    // surface state
    if (shot) { this.wet = Math.max(st.rain, this.base.rain * 0.3); this.snowCover = Math.max(this.snowCover, st.snow * 0.8, this.cold ? 0.5 : 0); }
    else {
      this.wet = st.rain > this.wet ? this.wet + (st.rain - this.wet) * (1 - Math.exp(-dt / 40)) : this.wet - dt / 400;
      this.snowCover = st.snow > 0.05 ? Math.min(1, this.snowCover + st.snow * dt / 180) : Math.max(this.cold ? 0.5 : 0, this.snowCover - dt / 900);
    }
    this.wet = clamp(this.wet, 0, 1);
    G.uWetness.value = this.present ? this.wet : 0;
    G.uSnow.value = this.snowCover;
    // wind: base + gusts + storm/dust
    const gust = 0.5 + 0.5 * Math.sin(t * 0.13) * Math.sin(t * 0.071 + 1.3);
    st.wind = clamp(this.base.wind * (0.75 + 0.5 * gust) + st.storm * 0.45 + st.dust * 0.35 + st.rain * 0.1, 0, 1);
    G.uWindStrength.value = this.present ? st.wind : 0;

    // lightning (deterministic from sim time, so captures of stormy worlds see strikes too)
    st.flash = 0;
    const stormy = Math.max(st.storm, this.stormType ? st.rain * 0.6 : 0);
    if (this._firstT === undefined) { this._firstT = t; this._nextStrike = t + (shot ? 0.3 + this.seed * 0.12 : 2 + this.seed * 5); }
    if (stormy > 0.25 && this.present) {
      if (this.forceBolt && shot && this._boltT < 0) this._strike(t, true);
      else if (!this.forceBolt && t > this._nextStrike) this._strike(t, false, stormy);
    }
    if (this._boltT >= 0) {
      const age = t - this._boltT;
      // double-pulse flash
      const f = age < 0 ? 0 : Math.exp(-age * 9) + 0.6 * Math.exp(-Math.abs(age - 0.16) * 25);
      st.flash = this.forceBolt && shot ? 0.55 : f;
      this.boltMat.uniforms.uI.value = 60 * st.flash;
      this.bolt.visible = st.flash > 0.02;
      if (!this.forceBolt && age > 1.2) { this._boltT = -1; this.bolt.visible = false; }
    }
    // environment flash (all PBR materials): striking at night, subtle under a daylit storm
    const scene = this.world.scene;
    const dayness = this.atmo.lighting?.dayness ?? 0;
    scene.environmentIntensity = (this.atmo.lighting?.envScale ?? 1) * (1 + st.flash * 2.5 * (1 - 0.75 * dayness));
  }

  _strike(t, force, stormy = 1) {
    this._boltT = t;
    const sd = this.seed;
    this._nextStrike = t + (3 + ((Math.sin(t * 12.9898 + sd * 78.233) * 43758.5453) % 1 + 1) % 1 * 9) / Math.max(0.35, stormy);
    // strike point 2–7 km away in front-ish of the camera, from the cloud base to the ground
    const w = this.world;
    const cam = w.camera;
    const up = _v1.setFromMatrixPosition(cam.matrixWorld).add(w.origin);
    const camLocal = _v4.copy(up);
    up.normalize();
    const fwd = _v2.set(0, 0, -1).transformDirection(cam.matrixWorld);
    fwd.addScaledVector(up, -fwd.dot(up)).normalize();
    const side = _v3.crossVectors(fwd, up).normalize();
    const r = (a) => ((Math.sin(t * a + sd * 311.7) * 43758.5453) % 1 + 1) % 1;
    const dist = force ? 3500 : 2000 + r(3.1) * 5000;
    const lateral = (r(7.7) - 0.5) * dist * (force ? 0.5 : 1.2);
    const ground = _v5.copy(camLocal).addScaledVector(fwd, dist).addScaledVector(side, lateral).normalize();
    const R = this.atmo.model.Rb;
    const gh = w.surface ? w.surface.height(ground.x, ground.y, ground.z) : 0;
    const top = this.atmo.clouds?.Rc0 ?? R + 2000;
    const gR = R + Math.max(gh, 0);
    this._boltLocal.copy(ground).multiplyScalar((gR + top) * 0.5);
    // audio hook: distance to the strike (thunder delay ≈ boltDist / 340 m/s) + event
    const st = this.state;
    st.boltDist = _v6.copy(ground).multiplyScalar(gR).distanceTo(camLocal);
    st.boltTime = t;
    try { w.events?.emit?.('weather:lightning', { dist: st.boltDist, pos: this._boltLocal.clone(), force: !!force }); } catch (_) { /* ignore */ }
    // fractal channel (midpoint displacement: big meanders + fine jaggedness), scene-space ribbon
    const o = w.origin;
    const rs = { s: ((Math.floor(t * 1000) ^ Math.floor(sd * 1e6)) >>> 0) || 1 };
    const rr = () => { rs.s ^= rs.s << 13; rs.s >>>= 0; rs.s ^= rs.s >>> 17; rs.s ^= rs.s << 5; rs.s >>>= 0; return rs.s / 4294967296 - 0.5; };
    const pts = this._bpts, M = this.boltMain;
    pts[0].copy(ground).multiplyScalar(top).addScaledVector(side, rr() * 400);
    pts[M - 1].copy(ground).multiplyScalar(gR);
    const H = top - gR;
    const subdiv = (arr, i0, i1, amp) => {
      if (i1 - i0 < 2) return;
      const m = (i0 + i1) >> 1;
      arr[m].copy(arr[i0]).add(arr[i1]).multiplyScalar(0.5).addScaledVector(side, rr() * amp).addScaledVector(fwd, rr() * amp);
      subdiv(arr, i0, m, amp * 0.55); subdiv(arr, m, i1, amp * 0.55);
    };
    subdiv(pts, 0, M - 1, H * 0.35);
    const P = this.boltPos;
    const toCam = _v6;
    const writeStrip = (arr, n, start, w0, w1) => {
      for (let i = 0; i < n; i++) {
        const f = i / (n - 1);
        const p = arr[i];
        toCam.copy(camLocal).sub(p).normalize();
        const tan = _v7.copy(arr[Math.min(i + 1, n - 1)]).sub(arr[Math.max(i - 1, 0)]).normalize();
        const wdir = _v8.crossVectors(toCam, tan).normalize().multiplyScalar(w0 + (w1 - w0) * f);
        const k = (start + i) * 6;
        P[k] = p.x - o.x - wdir.x; P[k + 1] = p.y - o.y - wdir.y; P[k + 2] = p.z - o.z - wdir.z;
        P[k + 3] = p.x - o.x + wdir.x; P[k + 4] = p.y - o.y + wdir.y; P[k + 5] = p.z - o.z + wdir.z;
      }
    };
    writeStrip(pts, M, 0, 4.5, 2.5);
    // branches fork off the upper half and die out
    const br = this._bbr, NB = this.boltBr;
    for (let b = 0; b < this.boltBranches; b++) {
      const i0 = 6 + Math.floor((rr() + 0.5) * M * 0.45);
      const len = H * (0.18 + (rr() + 0.5) * 0.22);
      br[0].copy(pts[i0]);
      const dirSide = rr() < 0 ? -1 : 1;
      br[NB - 1].copy(pts[i0]).addScaledVector(ground, -len * 0.8).addScaledVector(side, dirSide * len * 0.6).addScaledVector(fwd, rr() * len * 0.4);
      subdiv(br, 0, NB - 1, len * 0.3);
      writeStrip(br, NB, M + b * NB, 2.2, 0.4);
    }
    this.bolt.geometry.attributes.position.needsUpdate = true;
    this.bolt.geometry.computeBoundingSphere();
    const cl = this.atmo.clouds;
    if (cl?.u?.uFlash) cl.u.uFlash.value.set(this._boltLocal.x, this._boltLocal.y, this._boltLocal.z, 1);
  }

  onOriginShift() { this._boltT = -1; this.bolt.visible = false; }

  // ---------------------------------------------------------------- pipeline effect
  render(renderer, io) {
    const st = this.state;
    const kind = st.rain >= Math.max(st.snow, st.dust) ? 0 : st.snow >= st.dust ? 1 : 2;
    let amount = kind === 0 ? st.rain : kind === 1 ? st.snow : st.dust;
    // no precipitation above the cloud deck / dust layer, nor outside the atmosphere
    const camR = _v1.setFromMatrixPosition(io.camera.matrixWorld).add(this.world.origin).length();
    const m = this.atmo.model;
    const ceil = kind === 2 ? m.Rb + Math.max(1500, (this.world.surface?.maxHeight ?? 0) + 800)
      : (this.atmo.clouds?.present ? this.atmo.clouds.Rc0 + (this.atmo.clouds.Rc1 - this.atmo.clouds.Rc0) * 0.3 : m.Rb + m.height * 0.35);
    amount *= 1 - smooth(camR, ceil - 150, ceil + 150);
    const hasBolt = this.bolt.visible;
    if ((amount < 0.02 || !this.present) && !hasBolt) { io.skip = true; return; }
    const u = this.pu, cam = io.camera;
    this.copyMat.uniforms.tColor.value = io.input.texture;
    this.quad.render(renderer, this.copyMat, io.output);
    u.uCam.value.setFromMatrixPosition(cam.matrixWorld);
    u.tDepth.value = io.depth;
    u.uRes.value.set(io.output.width, io.output.height);
    u.uNear.value = cam.near; u.uFar.value = cam.far;
    u.uKind.value = kind;
    u.uAmount.value = amount < 0.02 ? 0 : clamp(0.15 + amount * 0.85, 0, 1) * (kind === 0 ? 1 : 0.55); // snow / dust: same density as before the denser rain pool
    const up = _v1.setFromMatrixPosition(cam.matrixWorld).add(this.world.origin).normalize();
    const wind = G.uWindDir.value, ws = G.uWindStrength.value;
    const dt = Math.min(this.world.engine.time.dt || 1 / 60, 0.1);
    let speed, box, width, alpha;
    const amb = G.uAmbientSky.value, sun = G.uSunColor.value;
    if (kind === 0) {
      speed = 9; box = 26; width = 0.0065; alpha = 0.5;
      _v2.copy(up).multiplyScalar(-speed).addScaledVector(wind, ws * 6 + 1);
      u.uFall.value.copy(_v2).multiplyScalar(0.032); // shutter → streak length
      // drops are small lenses: they show the (dim, grey) sky, not a white line
      u.uColor.value.setRGB(amb.r * 0.32 + sun.r * 0.03 + 0.02, amb.g * 0.32 + sun.g * 0.03 + 0.023, amb.b * 0.32 + sun.b * 0.03 + 0.028);
    } else if (kind === 1) {
      speed = 1.1; box = 22; width = 0.028; alpha = 1.0;
      _v2.copy(up).multiplyScalar(-speed).addScaledVector(wind, ws * 3 + 0.3);
      u.uFall.value.copy(up);
      u.uColor.value.setRGB(amb.r * 0.9 + sun.r * 0.15 + 0.02, amb.g * 0.9 + sun.g * 0.15 + 0.02, amb.b * 0.9 + sun.b * 0.15 + 0.024);
    } else {
      speed = 0.4; box = 30; width = 0.01; alpha = 0.6;
      _v2.copy(wind).multiplyScalar(4 + ws * 14).addScaledVector(up, -0.3);
      u.uFall.value.copy(up);
      const d = this.atmo.model.tint;
      u.uColor.value.setRGB((amb.r * 0.4 + sun.r * 0.15) * (0.6 + d.r * 0.5), (amb.g * 0.4 + sun.g * 0.15) * (0.55 + d.g * 0.4), (amb.b * 0.4 + sun.b * 0.15) * (0.45 + d.b * 0.3));
    }
    this._drift.addScaledVector(_v2, dt);
    this._driftFar.addScaledVector(_v2, dt);
    // keep the drift wrapped (precision)
    this._drift.set(this._drift.x % box, this._drift.y % box, this._drift.z % box);
    const fb = box * 3;
    this._driftFar.set(this._driftFar.x % fb, this._driftFar.y % fb, this._driftFar.z % fb);
    u.uOffset.value.copy(this._drift).negate();
    u.uBox.value = box; u.uWidth.value = width; u.uAlpha.value = alpha * (0.5 + 0.5 * amount);
    u.uColor.value.multiplyScalar(1 + st.flash * 4);
    const prev = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(io.output);
    this.points.visible = amount >= 0.02;
    const bu = this.boltMat.uniforms;
    bu.tDepth.value = io.depth; bu.uRes.value.copy(u.uRes.value); bu.uNear.value = cam.near; bu.uFar.value = cam.far;
    u.uSheet.value = 0;
    renderer.render(this.pscene, cam);
    if (kind === 0 && amount >= 0.02) {
      // far sheet: the same instances in a 3× larger volume, thinner and fainter (dense rain into the distance)
      const b0 = u.uBox.value, w0 = u.uWidth.value, a0 = u.uAlpha.value;
      this.bolt.visible = false;
      u.uSheet.value = 1; u.uBox.value = b0 * 3; u.uWidth.value = w0 * 3.2; u.uAlpha.value = a0 * 0.5;
      u.uOffset.value.copy(this._driftFar).negate();
      renderer.render(this.pscene, cam);
      u.uSheet.value = 0; u.uBox.value = b0; u.uWidth.value = w0; u.uAlpha.value = a0;
      this.bolt.visible = hasBolt;
    }
    renderer.autoClear = prev;
  }

  dispose() {
    this.points.geometry.dispose(); this.pmat.dispose();
    this.bolt.geometry.dispose(); this.boltMat.dispose();
    this.copyMat.dispose(); this.quad.dispose();
    if (this.world.scene) this.world.scene.environmentIntensity = 1;
  }
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3(), _v7 = new THREE.Vector3(), _v8 = new THREE.Vector3();
