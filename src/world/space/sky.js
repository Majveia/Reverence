// Night sky of the host galaxy: Milky-Way band (baked cube map), resolved stars (points),
// nebula glows and distant galaxies. OWNED BY THE SPACE TRACK.
//
// Pipeline: worker (skyBake.js) ray-marches GalaxyModel density from this star → equirect HDR band
// + star list  →  one GPU pass bakes a detailed cube map in the GALAXY frame (dust filaments,
// star clouds, nebulae)  →  per frame: a far-plane fullscreen triangle samples it through
// uL2G = (inertial→galaxy) · celestial.q (local→inertial), so the sky wheels with the planet's spin.
import * as THREE from 'three';
import { RNG, hashCombine } from '../../core/rng.js';
import { FULLSCREEN_BG_VERT, FAR_DIR_POS } from './shaders.js';
import { LAT_A, LAT_B } from './skyBake.js';

const _m3 = new THREE.Matrix3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();

const BAKE_FRAG = /* glsl */ `
#include <rv_space>
uniform sampler2D uBand;
uniform float uFloor, uGain, uSat, uContrast;
uniform vec3 uNebDir[10];
uniform vec4 uNebP[10];      // x: angular radius (rad), y: kind, z: seed, w: palette (0 natural, 1 hubble)
uniform int uNebN;
uniform float uSeed;
varying vec3 vDir;
vec2 bandUV(vec3 d){
  float y = asin(clamp(d.y, -1.0, 1.0)) / (RV_PI * 0.5);
  float t = y;
  for (int k = 0; k < 7; k++) t -= (${LAT_A.toFixed(3)} * t + ${LAT_B.toFixed(3)} * t * t * t - y) / (${LAT_A.toFixed(3)} + ${(3 * LAT_B).toFixed(3)} * t * t);
  return vec2(atan(d.x, d.z) / RV_TAU + 0.5, 0.5 - 0.5 * clamp(t, -1.0, 1.0));
}
vec3 nebula(vec3 d, vec3 c, vec4 P){
  float ang = acos(clamp(dot(d, c), -1.0, 1.0));
  float R = max(P.x, 0.002);
  if (ang > R * 3.0) return vec3(0.0);
  // tangent frame
  vec3 t1 = normalize(cross(abs(c.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), c));
  vec3 t2 = cross(c, t1);
  vec2 uv = vec2(dot(d - c, t1), dot(d - c, t2)) / R;
  vec3 q = vec3(uv * 1.3, P.z * 0.013);
  float w = rv_fbm(q * 1.2 + 3.1, 3);
  float n = rv_fbm(q * 2.0 + w * 1.4, 5) * 0.5 + 0.5;
  float fil = rv_ridged(q * 3.0 + w, 4);
  float r = length(uv);
  float body = exp(-r * r * 1.4) * smoothstep(0.25, 0.9, n + 0.35 * (1.0 - r));
  vec3 ha = vec3(1.0, 0.22, 0.34);           // H-alpha
  vec3 o3 = vec3(0.25, 0.85, 0.8);           // [OIII]
  vec3 refl = vec3(0.45, 0.6, 1.0);          // reflection nebula
  vec3 col = P.w > 0.5 ? mix(o3, vec3(1.0, 0.75, 0.3), smoothstep(0.3, 0.8, n)) : mix(ha, refl, smoothstep(0.55, 0.9, n) * 0.6);
  float kind = P.y;
  if (kind > 2.5){ // remnant: filamentary shell
    float shell = exp(-pow((r - 0.8) * 4.0, 2.0)) * (0.3 + fil);
    return col * shell * 0.9;
  }
  if (kind > 1.5){ // planetary: ring
    float ring = exp(-pow((r - 0.5) * 5.0, 2.0)) + exp(-r * r * 6.0) * 0.4;
    return mix(o3, ha, smoothstep(0.4, 0.7, r)) * ring;
  }
  float dark = smoothstep(0.35, 0.8, fil) * 0.7;   // dust pillars / lanes inside
  return col * body * (1.0 - dark) * (0.6 + fil * 0.8);
}
vec4 bandSoft(vec3 d){
  vec3 e1 = normalize(cross(abs(d.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), d));
  vec3 n1 = cross(d, e1);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int k = -3; k <= 3; k++){
    float o = float(k) * 0.014;
    float w = exp(-float(k * k) * 0.28);
    acc += texture2D(uBand, bandUV(normalize(d + n1 * o))) * w; ws += w;
  }
  return acc / ws;
}
void main(){
  vec3 d = normalize(vDir);
  vec4 b = mix(texture2D(uBand, bandUV(d)), bandSoft(d), 0.65);
  vec3 e = b.rgb;
  float tau = b.a;
  vec3 q = d * 9.0 + uSeed;
  vec3 w = vec3(rv_fbm(q * 0.5, 4), rv_fbm(q * 0.5 + 7.3, 4), rv_fbm(q * 0.5 + 13.1, 4));
  float clouds = rv_fbm(q * 1.2 + w * 1.2, 6) * 0.5 + 0.5;          // star clouds (large, soft)
  float fine = rv_fbm(q * 8.0 + w * 2.0, 4) * 0.5 + 0.5;
  // dust: multi-scale filaments (thin, branching) + soft patches
  float lanes = rv_ridged(q * 3.0 + w * 2.0, 6);
  float lanes2 = rv_ridged(q * 9.0 + w * 3.5, 5);
  float patches = smoothstep(0.45, 0.8, rv_fbm(q * 1.6 + w * 2.2 + 3.0, 5) * 0.5 + 0.5);
  float dmask = smoothstep(0.2, 2.2, tau);
  float extra = dmask * (pow(lanes, 3.0) * 1.1 + pow(lanes2, 4.0) * 0.6 + patches * 0.7);
  e *= mix(0.45, 1.55, clouds) * mix(0.94, 1.06, fine);
  e *= exp(-extra * vec3(0.9, 1.0, 1.1));
  // contrast / black floor (true black between the band and the stars)
  e = max(e - uFloor, 0.0);
  e = e / (1.0 + 0.8 * e);
  e = pow(e, vec3(uContrast));
  float l = rv_luma(e);
  e = mix(vec3(l), e, uSat * smoothstep(0.0, 0.35, l));   // dim haze is neutral, bright star clouds keep colour
  e *= uGain;
  // nebulae (emission / pillars / planetary / remnant)
  for (int i = 0; i < 10; i++){
    if (i >= uNebN) break;
    e += nebula(d, uNebDir[i], uNebP[i]) * (0.05 + 0.06 * dmask) * uGain;
  }
  gl_FragColor = vec4(max(e, 0.0), 1.0);
}`;

const BG_FRAG = /* glsl */ `
#include <rv_common>
uniform samplerCube uCube;
uniform mat3 uL2G;
uniform float uGain;
uniform float uPano;
uniform vec2 uRes;
varying vec3 vDir;
void main(){
  vec3 d = uL2G * normalize(vDir);
  if (uPano > 0.5){   // debug: equirectangular view of the galaxy-frame sky (?skypano=1)
    vec2 uv = gl_FragCoord.xy / uRes;
    float lon = (uv.x - 0.5) * 6.2831853, lat = (uv.y - 0.5) * 3.1415926;
    d = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  }
  vec3 c = textureCube(uCube, d).rgb * uGain;
  c += (rv_ign(gl_FragCoord.xy) - 0.5) * 0.0006 * step(1e-5, c.g);   // de-band dim gradients
  gl_FragColor = vec4(max(c, 0.0), 1.0);
}`;

const STAR_VERT = /* glsl */ `
${FAR_DIR_POS}
uniform mat3 uG2L;
uniform float uGain, uTwinkle, uTime, uPR, uFade;
attribute float aFlux;
attribute vec3 aCol;
varying vec3 vCol;
varying float vSize;
varying float vE;
void main(){
  vec3 d = uG2L * position;
  gl_Position = sp_farClip(d);
  float E = min(uGain * pow(aFlux, 0.46), 9.0);
  float h = fract(sin(float(gl_VertexID) * 12.9898) * 43758.5453);
  // scintillation (inside an atmosphere): stronger near the horizon of the view
  E *= 1.0 + uTwinkle * 0.45 * sin(uTime * (7.0 + h * 11.0) + h * 40.0) * sin(uTime * (3.1 + h * 5.0) + h * 17.0);
  E *= uFade;
  vE = E;
  vCol = aCol;
  float s = clamp(2.4 + 2.6 * log2(1.0 + E * 1.2), 2.4, 22.0);
  vSize = s;
  gl_PointSize = s * uPR;
  if (E < 0.0015) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // cull invisible stars
}`;

const STAR_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vSize;
varying float vE;
void main(){
  vec2 p = (gl_PointCoord - 0.5) * vSize;   // pixels from centre
  float r2 = dot(p, p);
  float core = exp(-r2 * 1.6);
  float halo = exp(-sqrt(r2) * 0.9) * 0.035;
  float spikes = 0.0;
  if (vE > 3.0){
    vec2 a = abs(p);
    spikes = (exp(-a.x * 1.6) * exp(-a.y * 0.22) + exp(-a.y * 1.6) * exp(-a.x * 0.22)) * 0.035 * smoothstep(3.0, 9.0, vE);
  }
  vec3 c = vCol * vE * (core * 1.25 + halo + spikes);
  float edge = 1.0 - smoothstep(0.35, 0.5, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(c * edge, 1.0);
}`;

// distant galaxies as procedural sprites
const GAL_VERT = /* glsl */ `
${FAR_DIR_POS}
uniform mat3 uG2L;
uniform float uPixAng, uPR, uGain, uFade;
attribute vec4 aP;    // x: angular radius (rad), y: axis ratio, z: position angle, w: type (0 spiral, 1 elliptical)
attribute vec3 aCol;
varying vec4 vP;
varying vec3 vCol;
varying float vSize;
void main(){
  vec3 d = uG2L * position;
  gl_Position = sp_farClip(d);
  float s = clamp(aP.x * 2.4 / uPixAng, 3.0, 256.0);
  vSize = s;
  gl_PointSize = s * uPR;
  vP = aP; vCol = aCol * uGain * uFade;
}`;
const GAL_FRAG = /* glsl */ `
#include <rv_common>
varying vec4 vP;
varying vec3 vCol;
varying float vSize;
void main(){
  vec2 p = (gl_PointCoord - 0.5) * 2.4;       // in units of the angular radius
  float ca = cos(vP.z), sa = sin(vP.z);
  vec2 q = vec2(ca * p.x - sa * p.y, sa * p.x + ca * p.y);
  q.y /= max(vP.y, 0.08);
  float r = length(q);
  float I;
  if (vP.w > 0.5){
    I = exp(-pow(r * 3.2, 0.6) * 2.2);
  } else {
    float th = atan(q.y, q.x);
    float arms = 0.55 + 0.45 * cos(2.0 * th - log(max(r, 0.02)) * 5.0);
    I = exp(-r * 9.0) * 1.2 + exp(-r * 3.4) * arms * 0.45 * smoothstep(1.2, 0.2, r);
  }
  float edge = 1.0 - smoothstep(0.42, 0.5, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(vCol * I * edge, 1.0);
}`;

export class Sky {
  constructor(world, space) {
    this.world = world;
    this.space = space;
    const q = world.quality || {};
    this.tier = q.tier || 'high';
    this.ready = false;
    this.failed = false;
    this.t0 = performance.now();
    this.group = new THREE.Group();
    this.group.name = 'space-sky';
    this.uL2G = { value: new THREE.Matrix3() };
    this.uG2L = { value: new THREE.Matrix3() };
    this.uGain = { value: 1 };
    this.uStarGain = { value: 0.075 };
    this.uFade = { value: 1 };
    this.uTwinkle = { value: 0 };
    this.uPixAng = { value: 0.001 };
    this.uPR = { value: 1 };

    // galaxy frame relative to the system's inertial frame (deterministic per star)
    const star = world.star;
    const r = new RNG(hashCombine(star.seed >>> 0, 0x5a7e));
    const incl = r.range(0.45, 1.25);
    this.qGal = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(r.range(-0.4, 0.4), r.range(0, Math.PI * 2), 0, 'YXZ'))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), incl))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.range(0, Math.PI * 2)));
    // qGal maps inertial → galaxy

    const big = this.tier === 'high' || this.tier === 'ultra';
    this.cubeSize = this.tier === 'ultra' ? 1024 : this.tier === 'high' ? 768 : this.tier === 'med' ? 512 : 384;
    if (q.software && !(world.params?.full === '1')) this.cubeSize = Math.min(this.cubeSize, 768);
    this.bakeParams = {
      galaxy: plainGalaxy(world.universe.galaxy(world.galaxyIndex)),
      pos: [star.position.x, star.position.y, star.position.z],
      W: big ? 768 : 384, H: big ? 256 : 160, steps: big ? 40 : 28,
      maxStars: this.tier === 'ultra' ? 45000 : big ? 30000 : this.tier === 'med' ? 16000 : 9000,
      localRadius: big ? 1200 : 900,
      globalSample: big ? 120000 : 40000,
    };
    this._buildBackground();
    this._buildGalaxies(r);
    this._startBake();
  }

  _startBake() {
    const onResult = (res) => {
      if (this.disposed) return;
      try { this._onBake(res); } catch (e) { console.error('[space] sky bake apply failed', e); this.failed = true; }
    };
    try {
      this.worker = new Worker(new URL('./sky.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const m = e.data;
        this.worker?.terminate(); this.worker = null;
        if (m.ok) onResult(m.r); else { console.error('[space] sky worker error', m.error); this.failed = true; }
      };
      this.worker.onerror = (e) => { console.error('[space] sky worker failed', e.message); this.worker?.terminate(); this.worker = null; this._bakeInline(onResult); };
      this.worker.postMessage(this.bakeParams);
    } catch (e) {
      this._bakeInline(onResult);
    }
  }

  async _bakeInline(onResult) {
    try {
      const { bakeSky } = await import('./skyBake.js');
      const p = { ...this.bakeParams, W: 256, H: 128, steps: 24, maxStars: 8000, globalSample: 20000 };
      onResult(bakeSky(p));
    } catch (e) { console.error('[space] inline sky bake failed', e); this.failed = true; }
  }

  _onBake(res) {
    const { W, H } = res;
    const data = new Uint16Array(W * H * 4);
    for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(Math.min(res.band[i], 60000));
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false; tex.needsUpdate = true;
    this.bandTex = tex;
    this.bandMedian = res.median;
    this.nebulae = res.nebulae || [];
    this._buildStars(res.stars, res.fluxRef);
    this.pendingCube = true;
  }

  /** GPU pass: bake the detailed cube map (once). Needs the renderer → called from update(). */
  _bakeCube(renderer) {
    this.pendingCube = false;
    const size = this.cubeSize;
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    const nebDir = [], nebP = [];
    const kinds = { emission: 0, pillars: 1, planetary: 2, remnant: 3 };
    for (let i = 0; i < 10; i++) {
      const n = this.nebulae[i];
      if (n) {
        nebDir.push(new THREE.Vector3(...n.dir));
        nebP.push(new THREE.Vector4(Math.min(Math.max(n.ang, 0.004), 0.5), kinds[n.kind] ?? 0, (n.seed % 997), n.palette === 'hubble' ? 1 : 0));
      } else { nebDir.push(new THREE.Vector3(0, 1, 0)); nebP.push(new THREE.Vector4()); }
    }
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uBand: { value: this.bandTex },
        uFloor: { value: (this.bandMedian || 0.05) * 0.5 },
        uGain: { value: 0.26 },
        uSat: { value: 0.85 },
        uContrast: { value: 1.15 },
        uNebDir: { value: nebDir }, uNebP: { value: nebP }, uNebN: { value: Math.min(10, this.nebulae.length) },
        uSeed: { value: (this.world.star.seed % 1000) * 0.137 },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: BAKE_FRAG,
      side: THREE.BackSide, depthTest: false, depthWrite: false,
    });
    const scene = new THREE.Scene();
    const geo = new THREE.BoxGeometry(2, 2, 2);
    scene.add(new THREE.Mesh(geo, mat));
    const cam = new THREE.CubeCamera(0.1, 10, rt);
    const prevRT = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevXR = renderer.xr?.enabled;
    try {
      if (renderer.xr) renderer.xr.enabled = false;
      renderer.autoClear = true;
      cam.update(renderer, scene);
    } finally {
      renderer.autoClear = prevAuto;
      if (renderer.xr) renderer.xr.enabled = prevXR;
      renderer.setRenderTarget(prevRT);
    }
    geo.dispose(); mat.dispose();
    this.cubeRT = rt;
    this.bgMat.uniforms.uCube.value = rt.texture;
    this.bg.visible = true;
    this.bandTex.dispose(); this.bandTex = null;
    this.ready = true;
  }

  _buildBackground() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.bgMat = new THREE.ShaderMaterial({
      uniforms: { uCube: { value: null }, uL2G: this.uL2G, uGain: this.uFade, uPano: { value: this.world.params?.skypano === '1' ? 1 : 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
      vertexShader: FULLSCREEN_BG_VERT, fragmentShader: BG_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.bgMat.userData.noCSM = true;
    this.bg = new THREE.Mesh(g, this.bgMat);
    this.bg.frustumCulled = false;
    this.bg.renderOrder = -1000;
    this.bg.visible = false;
    this.bg.name = 'space-milkyway';
    this.bg.userData.noCSM = true;
    this.group.add(this.bg);
  }

  _buildStars(st, fluxRef) {
    const n = st.n;
    const g = new THREE.BufferGeometry();
    const flux = new Float32Array(n);
    for (let i = 0; i < n; i++) flux[i] = st.flux[i] / fluxRef;
    g.setAttribute('position', new THREE.BufferAttribute(st.dir, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(st.col, 3));
    g.setAttribute('aFlux', new THREE.BufferAttribute(flux, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uG2L: this.uG2L, uGain: this.uStarGain, uTwinkle: this.uTwinkle, uTime: { value: 0 }, uPR: this.uPR, uFade: this.uFade },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, transparent: false,
    });
    mat.userData.noCSM = true;
    this.starMat = mat;
    this.stars = new THREE.Points(g, mat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -999;
    this.stars.name = 'space-stars';
    this.stars.userData.noCSM = true;
    this.group.add(this.stars);
    this.starCount = n;
  }

  _buildGalaxies(r) {
    const n = this.tier === 'low' ? 10 : 26;
    const pos = [], P = [], C = [];
    for (let i = 0; i < n; i++) {
      const v = r.unitVec();
      // galaxy frame: avoid the zone of avoidance (the band hides distant galaxies)
      if (Math.abs(v[1]) < 0.22) v[1] = (v[1] < 0 ? -1 : 1) * (0.22 + Math.abs(v[1]));
      const l = Math.hypot(v[0], v[1], v[2]);
      pos.push(v[0] / l, v[1] / l, v[2] / l);
      const hero = i === 0;
      const ang = hero ? r.range(0.028, 0.045) : Math.pow(r.next(), 2.5) * 0.009 + 0.0012;
      const ell = r.chance(0.3);
      P.push(ang, ell ? r.range(0.5, 0.95) : r.range(0.18, 0.7), r.range(0, Math.PI), ell ? 1 : 0);
      const warm = r.range(0, 1);
      const b = hero ? 0.9 : r.range(0.25, 0.7);
      C.push(b * (0.85 + warm * 0.15), b * (0.82 + warm * 0.05), b * (0.95 - warm * 0.25));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aP', new THREE.Float32BufferAttribute(P, 4));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(C, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uG2L: this.uG2L, uPixAng: this.uPixAng, uPR: this.uPR, uGain: { value: 0.05 }, uFade: this.uFade },
      vertexShader: GAL_VERT, fragmentShader: GAL_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    mat.userData.noCSM = true;
    this.galaxies = new THREE.Points(g, mat);
    this.galaxies.frustumCulled = false;
    this.galaxies.renderOrder = -998;
    this.galaxies.name = 'space-galaxies';
    this.group.add(this.galaxies);
  }

  update(dt, t, ctx) {
    const cel = this.world.celestial;
    // local → galaxy = qGal · q(local → inertial)
    _q.copy(this.qGal).multiply(cel.q);
    _m4.makeRotationFromQuaternion(_q);
    this.uL2G.value.setFromMatrix4(_m4);
    this.uG2L.value.copy(this.uL2G.value).transpose();
    this.uPixAng.value = ctx.pixAng;
    if (this.bgMat.uniforms.uPano.value) { ctx.renderer.getDrawingBufferSize(this.bgMat.uniforms.uRes.value); if (this.stars) this.stars.visible = false; this.galaxies.visible = false; }
    this.uPR.value = ctx.pixelRatio;
    this.uTwinkle.value = ctx.inAtmo;
    if (this.starMat) this.starMat.uniforms.uTime.value = t;
    if (this.pendingCube && ctx.renderer) {
      try { this._bakeCube(ctx.renderer); } catch (e) { console.error('[space] sky cube bake failed', e); this.failed = true; }
    }
  }

  isReady() {
    if (this.ready || this.failed) return true;
    return performance.now() - this.t0 > 45000;   // never block captures forever
  }

  dispose() {
    this.disposed = true;
    this.worker?.terminate();
    this.bg.geometry.dispose(); this.bgMat.dispose();
    this.stars?.geometry.dispose(); this.starMat?.dispose();
    this.galaxies?.geometry.dispose(); this.galaxies?.material.dispose();
    this.cubeRT?.dispose(); this.bandTex?.dispose();
  }
}

function plainGalaxy(g) {
  const o = {};
  for (const k of Object.keys(g)) {
    const v = g[k];
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') o[k] = v;
    else if (k !== 'colors' && v && typeof v === 'object' && !v.isColor) o[k] = JSON.parse(JSON.stringify(v));
  }
  return o;
}
