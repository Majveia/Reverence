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
varying vec2 vQ;
varying float vViewZ;
varying float vFade;
void main(){
  if (aSeed.w > uAmount){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 rel = mod(aSeed.xyz * uBox - uCam - uOffset, uBox) - 0.5 * uBox;
  // snow / dust wobble
  if (uKind > 0.5){
    float ph = aSeed.w * 71.0;
    rel += vec3(sin(uTime * 1.3 + ph), sin(uTime * 0.9 + ph * 1.7) * 0.5, cos(uTime * 1.1 + ph * 0.7)) * (uKind > 1.5 ? 0.6 : 0.25);
  }
  vec3 wp = uCam + rel;
  vec3 camToP = normalize(rel);
  vec3 a = uFall;
  vec3 side;
  if (uKind < 0.5){
    side = normalize(cross(a, camToP) + 1e-5) * uWidth;
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
  vFade = smoothstep(0.3, 1.5, d) * (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, d));
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
  a *= uAlpha * vFade * soft;
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
    if (body.clouds?.type === 'storm') this.base.storms = Math.max(this.base.storms, 0.5);
    this.cold = cold;
    this.present = atmo.model.present;
    this.override = (Params.str?.('weather') || '').toLowerCase();
    this.forceBolt = Params.bool?.('lightning') || false;
    this.seed = ((body.seed ?? 1) % 997) / 997;
    this.state = atmo.weather;
    Object.assign(this.state, { rain: 0, snow: 0, dust: 0, fog: this.base.fog, storm: 0, wind: this.base.wind, coverBoost: 0, sunDim: 1, flash: 0 });
    this.wet = 0; this.snowCover = cold ? 0.5 : 0;

    // ---- particles
    const q = w.quality;
    const n = { low: 1400, med: 3000, high: 6000, ultra: 10000 }[q.tier] ?? 6000;
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
      uColor: { value: new THREE.Color(0.5, 0.55, 0.6) }, uAlpha: { value: 0.3 },
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

    // ---- lightning bolt ribbon (preallocated)
    this.boltN = 28;
    const bg = new THREE.BufferGeometry();
    this.boltPos = new Float32Array(this.boltN * 2 * 3);
    const bt = new Float32Array(this.boltN * 2);
    const idx = [];
    for (let i = 0; i < this.boltN; i++) { bt[i * 2] = bt[i * 2 + 1] = i / (this.boltN - 1); if (i < this.boltN - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
    bg.setAttribute('position', new THREE.BufferAttribute(this.boltPos, 3));
    bg.setAttribute('aT', new THREE.BufferAttribute(bt, 1));
    bg.setIndex(idx);
    this.boltMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */`
        attribute float aT; varying float vT; varying float vS;
        void main(){ vT = aT; vS = float(gl_VertexID % 2) * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform float uI; varying float vT; varying float vS;
        void main(){ float c = 1.0 - vS * vS; gl_FragColor = vec4(vec3(0.75, 0.82, 1.0) * uI * (c * c * 3.0 + 0.2), 1.0); }`,
      uniforms: { uI: { value: 0 } },
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
      case 'dust': dust = 1; rain = snow = 0; break;
      case 'fog': fog = 1; break;
      case 'aurora': aurora = 1; rain = snow = dust = storm = 0; fog *= 0.3; break;
      default: break;
    }
    if (storm > 0) rain = Math.max(rain, this.cold ? 0 : storm * 0.9), snow = this.cold ? Math.max(snow, storm) : snow;
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
    st.coverBoost = 0.5 * precip + 0.35 * st.storm + 0.15 * st.dust;
    st.sunDim = Math.max(0.12, 1 - 0.7 * precip - 0.3 * st.storm - 0.45 * st.dust);
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

    // lightning
    st.flash = 0;
    if (st.storm > 0.3 && this.present) {
      if (this.forceBolt && shot && this._boltT < 0) this._strike(t, true);
      else if (!shot && t > this._nextStrike) this._strike(t, false);
    }
    if (this._boltT >= 0) {
      const age = t - this._boltT;
      // double-pulse flash
      const f = age < 0 ? 0 : Math.exp(-age * 9) + 0.6 * Math.exp(-Math.abs(age - 0.16) * 25);
      st.flash = this.forceBolt && shot ? 1 : f;
      this.boltMat.uniforms.uI.value = 60 * st.flash;
      this.bolt.visible = st.flash > 0.02;
      if (!this.forceBolt && age > 1.2) { this._boltT = -1; this.bolt.visible = false; }
    }
    // environment flash (all PBR materials)
    const scene = this.world.scene;
    scene.environmentIntensity = 1 + st.flash * 5;
  }

  _strike(t, force) {
    this._boltT = t;
    const sd = this.seed;
    this._nextStrike = t + 3 + ((Math.sin(t * 12.9898 + sd * 78.233) * 43758.5453) % 1 + 1) % 1 * 9;
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
    // build the jagged ribbon in scene space (width 7 m)
    const P = this.boltPos, n = this.boltN;
    const o = w.origin;
    let jx = 0, jz = 0;
    const toCam = _v6;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      jx += (r(13.1 + i * 3.7) - 0.5) * 140 * (1 - f * 0.3);
      jz += (r(29.3 + i * 5.1) - 0.5) * 140 * (1 - f * 0.3);
      const p = _v7.copy(ground).multiplyScalar(top + (gR - top) * f).addScaledVector(side, jx).addScaledVector(fwd, jz);
      toCam.copy(camLocal).sub(p).normalize();
      const wdir = _v8.crossVectors(toCam, ground).normalize().multiplyScalar(7 + 10 * (1 - f));
      P[i * 6] = p.x - o.x - wdir.x; P[i * 6 + 1] = p.y - o.y - wdir.y; P[i * 6 + 2] = p.z - o.z - wdir.z;
      P[i * 6 + 3] = p.x - o.x + wdir.x; P[i * 6 + 4] = p.y - o.y + wdir.y; P[i * 6 + 5] = p.z - o.z + wdir.z;
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
    const amount = kind === 0 ? st.rain : kind === 1 ? st.snow : st.dust;
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
    u.uAmount.value = amount < 0.02 ? 0 : clamp(0.15 + amount * 0.85, 0, 1);
    const up = _v1.setFromMatrixPosition(cam.matrixWorld).add(this.world.origin).normalize();
    const wind = G.uWindDir.value, ws = G.uWindStrength.value;
    const dt = Math.min(this.world.engine.time.dt || 1 / 60, 0.1);
    let speed, box, width, alpha;
    const amb = G.uAmbientSky.value, sun = G.uSunColor.value;
    if (kind === 0) {
      speed = 9; box = 26; width = 0.009; alpha = 0.45;
      _v2.copy(up).multiplyScalar(-speed).addScaledVector(wind, ws * 6 + 1);
      u.uFall.value.copy(_v2).multiplyScalar(0.06); // shutter → streak length
      u.uColor.value.setRGB(amb.r * 0.32 + sun.r * 0.03 + 0.02, amb.g * 0.32 + sun.g * 0.03 + 0.022, amb.b * 0.32 + sun.b * 0.03 + 0.026);
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
    // keep the drift wrapped (precision)
    this._drift.set(this._drift.x % box, this._drift.y % box, this._drift.z % box);
    u.uOffset.value.copy(this._drift).negate();
    u.uBox.value = box; u.uWidth.value = width; u.uAlpha.value = alpha * (0.5 + 0.5 * amount);
    u.uColor.value.multiplyScalar(1 + st.flash * 4);
    const prev = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(io.output);
    this.points.visible = amount >= 0.02;
    renderer.render(this.pscene, cam);
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
