// Lighting for planet worlds (OWNED BY THE ATMOSPHERE TRACK).
//
//  • Key light: three's native SunLight (r186) with our own N-cascade shadow (RVSunShadow: 2–4
//    cascades in one atlas, texel-snapped, per-cascade normal bias, casters up to 15 km sun-ward).
//    Because SunLight is native, EVERY built-in material (Standard/Physical/Lambert/Phong/Toon)
//    gets cascaded soft shadows without patching. By day the key light is the star (color =
//    atmospheric transmittance at the camera → golden hour for free); by night it is the brightest
//    moon (phase-aware) or faint starlight.
//  • Sky ambient: PMREM environment map of the atmosphere (ray-marched cube, ground bounce, night
//    glow) assigned to scene.environment; refreshed as the sun moves / altitude changes.
//  • Fallback hemisphere light for non-PBR materials (PBR materials patched by setupMaterial skip it).
//  • setupMaterial(mat): adds cloud shadows to the key light (rv_cloudshadow) & skips the hemisphere
//    light for PBR materials. Auto-applied to world.root meshes periodically (skip userData.noCSM).
import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { G } from '../../core/Uniforms.js';
import { registerChunk } from '../../shaders/chunks.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _c = new THREE.Color();

// ------------------------------------------------------------------ shader chunk patches
let _patchedCascades = 0;
function patchSunShadowChunk(n) {
  if (_patchedCascades) return _patchedCascades;
  let s = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (s.includes('#define SUN_LIGHT_CASCADES 2')) s = s.replace('#define SUN_LIGHT_CASCADES 2', `#define SUN_LIGHT_CASCADES ${n}`);
  else n = 2;
  const a = 'vec4 shadowWorldPosition = vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * sunLightShadow.shadowNormalBias, 1.0 );';
  const b = 'sunShadowMatrix[ cascadeOffset + i ] * shadowWorldPosition';
  if (s.includes(a) && s.includes(b)) {
    s = s.replace(a, 'vec3 rvShadowPos = vSunShadowWorldPosition.xyz;');
    s = s.replace(b, 'sunShadowMatrix[ cascadeOffset + i ] * vec4( rvShadowPos + vSunShadowWorldNormal * sunLightShadow.shadowNormalBias * max( cascade.w, 0.0 ), 1.0 )');
  }
  // softer PCF on the middle cascades (22–900 m): trunk / rock / building shadows there are ~20 cm texels
  // at capture resolution; the near cascade keeps crisp contact shadows
  if (s.split('sunLightShadow.shadowRadius,').length === 2) {
    s = s.replace('sunLightShadow.shadowRadius,', 'sunLightShadow.shadowRadius * ( i == 1 ? 1.9 : ( i >= 2 ? 1.35 : 1.0 ) ),');
  }
  THREE.ShaderChunk.shadowmap_pars_fragment = s;
  _patchedCascades = n;
  return n;
}

// lights_fragment_begin with cloud shadows on the key light and optional hemisphere skip
(function buildLightsChunk() {
  let s = THREE.ShaderChunk.lights_fragment_begin;
  const cs = /* glsl */`
		#ifdef RV_CLOUD_SHADOW
		directLight.color *= rv_cloudShadow( ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz );
		#endif`;
  s = s.replace('getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight );' + cs);
  s = s.replace('irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );',
    '#ifndef RV_SKIP_HEMI\n\t\t\tirradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );\n\t\t\t#endif');
  registerChunk('rv_lights_fragment_begin', s);
})();

// ------------------------------------------------------------------ cascaded sun shadow
const _lightOri = new THREE.Matrix4(), _viewToLight = new THREE.Matrix4();
const _dir = new THREE.Vector3(), _up = new THREE.Vector3(), _center = new THREE.Vector3(), _zero = new THREE.Vector3();
const _near = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _cor = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new THREE.Vector3());

export class RVSunShadow extends THREE.LightShadow {
  constructor(splits, mapSize) {
    super(new THREE.OrthographicCamera(-5, 5, 5, -5, 0.5, 500));
    this.isSunLightShadow = true;
    this.splits = splits;
    const n = splits.length - 1;
    this.cascades = n;
    this.mapSize.set(mapSize, mapSize);
    this.fade = 0.12;
    this.casterReach = 15000;
    this._cameras = []; this._matrices = []; this._frustums = []; this._cascadeData = [];
    this._viewportCount = n;
    this.cols = n <= 2 ? n : n === 3 ? 3 : 2;
    this.rows = n === 4 ? 2 : 1;
    this._frameExtents.set(this.cols, this.rows);
    this._viewports = [];
    for (let i = 0; i < n; i++) {
      this._cameras.push(new THREE.OrthographicCamera());
      this._matrices.push(new THREE.Matrix4());
      this._frustums.push(new THREE.Frustum());
      this._cascadeData.push(new THREE.Vector4());
      this._viewports.push(new THREE.Vector4());
    }
  }
  getCamera(i = 0) { return this._cameras[i]; }
  getMatrix(i = 0) { return this._matrices[i]; }
  getFrustum(i = 0) { return this._frustums[i]; }

  updateMatrices(light, viewCamera) {
    if (!viewCamera) return;
    const n = this.cascades;
    const inset = Math.min(0.25, (Math.ceil(this.radius) + 2) / this.mapSize.x);
    for (let i = 0; i < n; i++) {
      const col = i % this.cols, row = Math.floor(i / this.cols);
      this._viewports[i].set(col + inset, row + inset, 1 - 2 * inset, 1 - 2 * inset);
    }
    const res = this.mapSize.x * (1 - 2 * inset);
    const camNear = Math.max(viewCamera.near, 1e-3);
    _dir.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_dir)) > 0.99) _up.set(0, 0, 1);
    _lightOri.lookAt(_zero, _dir, _up);
    _viewToLight.copy(_lightOri).transpose().multiply(viewCamera.matrixWorld);
    const zNear = viewCamera.reversedDepth ? 1 : -1;
    const inv = viewCamera.projectionMatrixInverse;
    for (let k = 0; k < 4; k++) {
      const x = k === 0 || k === 1 ? 1 : -1, y = k === 0 || k === 3 ? 1 : -1;
      _near[k].set(x, y, zNear).applyMatrix4(inv); // view space, z = -near
    }
    let prevFade = this.splits[0];
    for (let i = 0; i < n; i++) {
      const sNear = i === 0 ? Math.max(this.splits[0], camNear) : prevFade;
      const sFar = this.splits[i + 1];
      const fadeStart = sFar - this.fade * (sFar - this.splits[i]);
      prevFade = fadeStart;
      // slice corners (view space) → light space
      for (let k = 0; k < 4; k++) {
        _cor[k].copy(_near[k]).multiplyScalar(sNear / camNear).applyMatrix4(_viewToLight);
        _cor[k + 4].copy(_near[k]).multiplyScalar(sFar / camNear).applyMatrix4(_viewToLight);
      }
      _center.set(0, 0, 0);
      for (let k = 0; k < 8; k++) _center.add(_cor[k]);
      _center.multiplyScalar(1 / 8);
      let r2 = 0, minZ = Infinity, maxZ = -Infinity;
      for (let k = 0; k < 8; k++) {
        r2 = Math.max(r2, _cor[k].distanceToSquared(_center));
        minZ = Math.min(minZ, _cor[k].z); maxZ = Math.max(maxZ, _cor[k].z);
      }
      let radius = Math.sqrt(r2);
      radius /= 1 - 2 / res;
      const texel = 2 * radius / res;
      _center.x = Math.round(_center.x / texel) * texel;
      _center.y = Math.round(_center.y / texel) * texel;
      const top = maxZ + this.casterReach;
      _center.z = top;
      _center.applyMatrix4(_lightOri);
      const cam = this._cameras[i];
      cam.position.copy(_center);
      cam.quaternion.setFromRotationMatrix(_lightOri);
      cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
      cam.near = 0.5;
      cam.far = top - minZ + radius + 1;
      cam.coordinateSystem = this.camera.coordinateSystem;
      cam._reversedDepth = this.camera.reversedDepth;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      this._cascadeData[i].set(i === 0 ? -1e10 : sNear, sFar, i === n - 1 ? sFar - 0.25 * (sFar - this.splits[i]) : fadeStart, texel * 1.4);
      this._updateMatrix(cam, this._matrices[i], this._frustums[i], this._viewports[i]);
    }
  }
}

// ------------------------------------------------------------------ environment (sky cube → PMREM)
const ENV_VERT = /* glsl */`
varying vec3 vDir;
void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ENV_FRAG = /* glsl */`
#include <rv_atmo>
uniform vec3 uCamPlanet;
uniform vec3 uSunDir;
uniform vec3 uSunIll;
uniform vec3 uNightSky;
uniform vec3 uMoonDir;
uniform vec3 uMoonSky;
uniform vec3 uGroundIrr;
uniform float uHasAtmo;
uniform float uCloudCover;
uniform vec3 uCloudLight;
uniform vec3 uCloudShade;
uniform vec3 uNightAmb;     // art-directed "readable night" ambient radiance (upper hemisphere)
varying vec3 vDir;
void main(){
  vec3 dir = normalize(vDir);
  vec3 ro = uCamPlanet;
  float r = length(ro);
  vec3 up = ro / r;
  float nu = dot(dir, uSunDir);
  vec3 L = vec3(0.0);
  vec2 bot = atmo_raySphere(ro, dir, uAtmoRb);
  bool ground = bot.x > 0.0;
  vec3 T = vec3(1.0);
  if (uHasAtmo > 0.5){
    vec2 top = atmo_raySphere(ro, dir, uAtmoRt);
    if (top.y > 0.0){
      float t0 = max(top.x, 0.0);
      float t1 = ground ? bot.x : top.y;
      AtmoInscatter a = atmo_march(ro, dir, t0, t1, uSunDir, 20.0, 0.5);
      L = atmo_combine(a, nu) * uSunIll;
      T = a.T;
    }
  }
  if (ground){
    vec3 p = ro + dir * bot.x;
    vec3 n = normalize(p);
    float muS = dot(n, uSunDir);
    vec3 Ts = uHasAtmo > 0.5 ? atmo_sunTransmittance(length(p), muS) : vec3(smoothstep(-0.01, 0.01, muS));
    L += T * uGroundAlbedo / RV_PI * (Ts * max(muS, 0.0) * uSunIll + uGroundIrr);
  } else {
    // night sky glow + moonlit sky (inside the atmosphere)
    float cz = max(dot(dir, up), 0.0);
    // airless bodies: no sky glow / night sky / cloud deck (and uAtmoRt may be 0 → smoothstep(0,0) = NaN)
    float inside = uHasAtmo > 0.5 ? 1.0 - smoothstep(uAtmoRt * 0.985, uAtmoRt, r) : 0.0;
    float airmass = 1.0 / (cz + 0.12);
    float mnu = dot(dir, uMoonDir);
    L += (uNightSky * (0.45 + 0.18 * airmass) + uMoonSky * (atmo_phaseRayleigh(mnu) * (0.6 + 0.15 * airmass) + 0.35 * atmo_phaseHG(mnu, 0.8))) * inside;
    // cloud deck (smooth approximation of the volumetric layer for reflections / ambient)
    L += uNightAmb * (0.6 + 0.4 * cz) * inside;
    float cov = uCloudCover * smoothstep(-0.02, 0.25, dot(dir, up)) * inside;
    vec3 cl = mix(uCloudShade, uCloudLight, 0.5 + 0.5 * nu);
    L = mix(L, cl, cov);
  }
  // never let a NaN/Inf reach the PMREM: it would poison scene.environment for every lit material
  if (any(isnan(L)) || any(isinf(L))) L = vec3(0.0);
  gl_FragColor = vec4(max(L, vec3(0.0)), 1.0);
}`;

export class Lighting {
  constructor(world, atmo) {
    this.world = world;
    this.atmo = atmo;
    const q = world.quality;
    this.q = q;
    const tier = q.tier;
    // ---- cascades per tier
    const cfg = {
      low: null,
      med: { splits: [0.05, 30, 260], size: 1024 },
      high: { splits: [0.05, 22, 130, 900], size: 2048 },
      ultra: { splits: [0.05, 16, 80, 420, 2800], size: 2048 },
    }[tier] ?? { splits: [0.05, 22, 130, 900], size: 2048 };
    const shadows = !!q.shadows && !!cfg;

    this.key = new SunLight(0xffffff, 3);
    this.key.name = 'rv-key-light';
    if (shadows) {
      const n = patchSunShadowChunk(cfg.splits.length - 1);
      const splits = cfg.splits.slice(0, n + 1);
      if (n !== cfg.splits.length - 1) splits[n] = cfg.splits[cfg.splits.length - 1];
      this.key.shadow = new RVSunShadow(splits, cfg.size);
      this.key.shadow.radius = 2.2;
      this.key.shadow.bias = -0.00002;
      this.key.shadow.normalBias = 1.0;
      this.key.castShadow = true;
    } else {
      this.key.castShadow = false;
    }
    world.scene.add(this.key);    // scene (not root): SunLight direction comes from its world position

    this.hemi = new THREE.HemisphereLight(0x8fb0e0, 0x3a3020, 1);
    this.hemi.name = 'rv-hemi-fallback';
    world.scene.add(this.hemi);
    this.hemi.position.set(0, 1, 0);

    // ---- shared uniforms for materials (cloud shadow)
    this.uniforms = {
      rvCloudShadowMap: { value: null },
      rvCloudShadowMatrix: { value: new THREE.Matrix4() },
      rvCloudShadowParams: { value: new THREE.Vector4(0, 1, 0, 0) },
      uKeyDir: { value: new THREE.Vector3(0, 1, 0) },     // key light direction (sun by day, moon by night)
      uKeyColor: { value: new THREE.Color(0, 0, 0) },     // key light color × intensity
    };
    this._placeholder = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this._placeholder.needsUpdate = true;
    this.uniforms.rvCloudShadowMap.value = this._placeholder;

    // ---- environment
    this.envSize = tier === 'low' ? 16 : tier === 'med' ? 32 : 64;
    this.cubeRT = new THREE.WebGLCubeRenderTarget(this.envSize, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(0.1, 10, this.cubeRT);
    this.envScene = new THREE.Scene();
    this.envU = {
      uCamPlanet: { value: new THREE.Vector3() },
      uSunDir: atmo.shared.uSunDir, uSunIll: atmo.shared.uSunIll,
      uNightSky: atmo.shared.uNightSky, uMoonDir: atmo.shared.uMoonDir, uMoonSky: atmo.shared.uMoonSky,
      uGroundIrr: { value: new THREE.Vector3() },
      uHasAtmo: { value: atmo.model.present ? 1 : 0 },
      uCloudCover: { value: 0 },
      uCloudLight: { value: new THREE.Vector3(1, 1, 1) },
      uCloudShade: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      uNightAmb: { value: new THREE.Vector3() },
      ...atmo.atmoUniforms,
    };
    this.envMat = new THREE.ShaderMaterial({ vertexShader: ENV_VERT, fragmentShader: ENV_FRAG, uniforms: this.envU, side: THREE.BackSide, depthWrite: false, depthTest: false });
    this.envBox = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.envMat);
    this.envBox.frustumCulled = false;
    this.envScene.add(this.envBox);
    this.envScene.add(this.cubeCam);
    this.pmrem = new THREE.PMREMGenerator(world.engine.renderer);
    this.envRT = null;
    this._envTimer = 1e9;
    this._envKey = new THREE.Vector4(0, 0, 0, -1);
    world.scene.environment = null;
    world.scene.environmentIntensity = 1;

    // ---- state
    this.sunColor = new THREE.Color();     // linear sun color × intensity at the camera
    this.keyIsMoon = false;
    this.moon = { dir: new THREE.Vector3(0, 1, 0), ill: 0, body: null, phase: 0 };
    this.skyIrr = [0, 0, 0]; this.groundRad = [0, 0, 0];
    this.nightFactor = 0;
    this.envScale = 1;
    this._matTimer = 0;
    this._t = [1, 1, 1];
    this._candidates = this._moonCandidates();
  }

  get csm() { return this.key.shadow; }
  get sun() { return this.key; }
  get envMap() { return this.envRT?.texture ?? null; }
  /** Raw sky cube (planet-local directions, HDR, not prefiltered) — e.g. for water reflections. */
  get skyCube() { return this.cubeRT.texture; }

  _moonCandidates() {
    const w = this.world, b = w.body, sys = w.system;
    const out = [];
    if (b.isMoon) {
      const parent = sys.planets[b.parent];
      if (parent) { out.push(parent); for (const m of parent.moons || []) if (m !== b && m.id !== b.id) out.push(m); }
    } else for (const m of b.moons || []) out.push(m);
    return out;
  }

  _updateMoon(camLocal, up) {
    const cel = this.world.celestial;
    let best = null, bestI = 0;
    const sunDir = cel.sunDir;
    for (const b of this._candidates) {
      try {
        cel.bodyLocal(b, _v);
        _w.copy(_v).sub(camLocal);
        const dist = _w.length();
        if (!(dist > 0)) continue;
        _w.divideScalar(dist);
        const elev = _w.dot(up);
        if (elev < -0.05) continue;
        const angR = b.radius / dist;
        const cosA = -_w.dot(sunDir);             // phase angle at the moon (sun is far)
        const k = 0.5 * (1 + cosA);
        const albedo = b.isGas ? 0.45 : b.type === 'arctic' || b.type === 'crystal' ? 0.6 : 0.25;
        const size = Math.pow(Math.min(angR / 0.0045, 30), 0.55);
        const I = k * albedo * size * THREE.MathUtils.smoothstep(elev, -0.05, 0.08);
        if (I > bestI) { bestI = I; best = { b, dir: _w.clone() }; }
      } catch (_) { /* ignore */ }
    }
    if (best) { this.moon.dir.copy(best.dir); this.moon.body = best.b; }
    // illuminance relative to the sun (art-directed: readable nights)
    this.moon.ill = Math.min(0.16, 0.13 * bestI);
    return this.moon;
  }

  /** Per-frame CPU lighting (called from Atmosphere.update). */
  update(dt, ctx) {
    const { model, camLocal, up, sunDir, camR, weather } = ctx;
    const E = model.sunIlluminance;
    const starCol = ctx.starColor;
    const muS = up.dot(sunDir);
    // --- sun at the camera
    const T = this._t;
    if (model.present) model.sunTransmittance(camR, muS, ctx.sunAngR, T);
    else { const v = THREE.MathUtils.smoothstep(muS, -0.01, 0.01); T[0] = T[1] = T[2] = v; }
    // from high altitude / orbit the key light lights the whole visible disc: it is the unattenuated star
    // (terminator from the materials' N·L, air colour from the atmosphere pass), never the camera-local
    // shadow / moon (which lit the night side white and left the day side dark)
    const altK = THREE.MathUtils.smoothstep(camR - model.Rb, model.height * 0.9, model.height * 2.0);
    this.highView = altK;
    // a single sky probe cannot light a whole planet disc (it lit the night side): from orbit the image is the
    // direct star + the atmosphere pass, the sky ambient fades out (weather.js multiplies its flash into this)
    this.envScale = 1 - 0.9 * altK;
    if (altK > 0) for (let c = 0; c < 3; c++) T[c] += (1 - T[c]) * altK;
    // the deck dims the sun only from below it (above the clouds / from orbit the sun is clear)
    const clp = this.atmo.clouds?.present ? this.atmo.clouds : null;
    const above = Math.max(altK, clp ? THREE.MathUtils.smoothstep(camR, clp.Rc0 + (clp.Rc1 - clp.Rc0) * 0.5, clp.Rc1 + 200) : 0);
    const cloudDim = (weather ? weather.sunDim : 1) * (1 - above) + above;
    this.sunColor.setRGB(starCol.r * T[0] * E, starCol.g * T[1] * E, starCol.b * T[2] * E).multiplyScalar(cloudDim);
    const sunI = this.sunColor.r * 0.2126 + this.sunColor.g * 0.7152 + this.sunColor.b * 0.0722;

    // --- sky irradiance (CPU model) for the hemisphere fallback / ambient uniforms
    const sky = this.skyIrr, gr = this.groundRad;
    if (model.present) model.skyIrradiance(Math.min(camR, model.Rt - 1), muS, sky, gr);
    else { sky[0] = sky[1] = sky[2] = 0; const g = model.groundAlbedo; const c = Math.max(muS, 0) / Math.PI; gr[0] = g.r * c; gr[1] = g.g * c; gr[2] = g.b * c; }
    for (let c = 0; c < 3; c++) { sky[c] *= E * [starCol.r, starCol.g, starCol.b][c]; gr[c] *= E * [starCol.r, starCol.g, starCol.b][c]; }
    // overcast: the deck turns the blue sky dome into a grey, dimmer one; part of the blocked direct sun
    // comes back as diffuse light through the clouds
    const oc = weather?.overcast || 0;
    this.overcast = oc;
    if (oc > 0) {
      const sl = sky[0] * 0.2126 + sky[1] * 0.7152 + sky[2] * 0.0722;
      const blocked = Math.max(0, 1 - cloudDim) * Math.max(muS, 0) * 0.3;
      const sc0 = [starCol.r * T[0] * E, starCol.g * T[1] * E, starCol.b * T[2] * E];
      const neutral = [0.96, 0.99, 1.04];
      for (let c = 0; c < 3; c++) {
        const grey = sl * neutral[c] * 0.75 + sc0[c] * blocked;
        sky[c] += (grey - sky[c]) * oc * 0.85;
        gr[c] *= 1 - 0.45 * oc * (1 - cloudDim);
      }
    }

    // --- night: moon / starlight
    const moon = this._updateMoon(camLocal, up);
    const dayness = THREE.MathUtils.smoothstep(sunI / E, 0.004, 0.12);
    this.nightFactor = 1 - THREE.MathUtils.smoothstep(muS, -0.28, 0.02);
    const nightAmb = ctx.nightAmbient; // THREE.Color (irradiance)
    const moonE = moon.ill * E;
    const moonCol = _c.setRGB(0.62, 0.72, 1.0).multiplyScalar(moonE);

    // --- key light: whichever is brighter (sun, else moon, else starlight from above)
    const key = this.key;
    let keyDir, keyCol;
    if (altK > 0.5 || sunI > moonE * 0.6 || moonE <= 1e-5) {
      keyDir = sunDir; keyCol = this.sunColor; this.keyIsMoon = false;
      if (sunI < 1e-4 && moonE <= 1e-5) { keyDir = up; keyCol = _c.setRGB(0.02, 0.026, 0.04).multiplyScalar(E * 0.01); this.keyIsMoon = true; }
    } else { keyDir = moon.dir; keyCol = moonCol; this.keyIsMoon = true; }
    key.position.copy(keyDir);
    key.color.copy(keyCol);
    key.intensity = 1;
    key.updateMatrixWorld();
    this.uniforms.uKeyDir.value.copy(keyDir);
    this.uniforms.uKeyColor.value.copy(keyCol);

    // hemisphere fallback (non-PBR materials): sky irradiance + night ambient
    this.hemi.position.copy(up);
    this.hemi.color.setRGB(sky[0] + nightAmb.r, sky[1] + nightAmb.g, sky[2] + nightAmb.b);
    this.hemi.groundColor.setRGB(gr[0] * Math.PI + nightAmb.r * 0.3, gr[1] * Math.PI + nightAmb.g * 0.3, gr[2] * Math.PI + nightAmb.b * 0.3);
    this.hemi.intensity = this.envScale;
    this.hemi.updateMatrixWorld();

    // --- shared G uniforms
    G.uSunDir.value.copy(sunDir);
    G.uSunColor.value.copy(this.sunColor);
    G.uSunIntensity.value = sunI;
    // ambient irradiance (sky side / ground side), incl. moonlight folded in at night so custom
    // shaders (grass, water) stay consistent with the moonlit terrain
    const moonAmb = this.keyIsMoon ? moonE * 0.35 : 0;
    G.uAmbientSky.value.setRGB(sky[0] + nightAmb.r + moonAmb * 0.62, sky[1] + nightAmb.g + moonAmb * 0.72, sky[2] + nightAmb.b + moonAmb);
    G.uAmbientGround.value.copy(this.hemi.groundColor);
    G.uNight.value = this.nightFactor;
    this.dayness = dayness;
    this.envU.uGroundIrr.value.set(sky[0] / E, sky[1] / E, sky[2] / E).multiplyScalar(1);
    this.envU.uCamPlanet.value.copy(camLocal).multiplyScalar(Math.min(camR, model.Rb + model.height * 0.5) / Math.max(camR, 1));
    this.envU.uNightAmb.value.set(nightAmb.r, nightAmb.g, nightAmb.b).multiplyScalar(0.55 / Math.PI);
    // cloud deck seen from below (env map / reflections): shaded bases, silver toward the sun
    const cl = this.atmo.clouds;
    const cover = cl?.present ? THREE.MathUtils.clamp(cl.meanCover * 0.55 + (weather?.coverBoost || 0) * 0.9, 0, 0.95) : 0;
    this.envU.uCloudCover.value = cover;
    const skyL = (sky[0] * 0.2126 + sky[1] * 0.7152 + sky[2] * 0.0722) / Math.PI;
    const shade = this.envU.uCloudShade.value, light = this.envU.uCloudLight.value;
    const na = nightAmb, nk = 0.05 / Math.PI;
    shade.set(skyL * 0.85 + na.r * nk, skyL * 0.88 + na.g * nk, skyL * 0.92 + na.b * nk).multiplyScalar(1 - 0.4 * oc);
    light.set(this.sunColor.r, this.sunColor.g, this.sunColor.b).multiplyScalar(0.3 * (1 - 0.7 * oc) / Math.PI).add(shade);

    // periodic material auto-setup
    // (frame-based too: sim time is frozen while a capture streams in)
    this._matTimer -= Math.max(dt, 1 / 60);
    if (this._matTimer <= 0) { this._matTimer = 1.0; this.setupAll(); }
  }

  /** Env map refresh (GPU). Called before the scene renders. */
  updateEnv(renderer, force = false) {
    const key = this._envKey;
    const u = this.envU;
    const sd = this.atmo.shared.uSunDir.value;
    const r = u.uCamPlanet.value.length();
    const dSun = 1 - (key.x * sd.x + key.y * sd.y + key.z * sd.z);
    const dR = Math.abs(r - key.w) / Math.max(1, this.world.body.radius * 0.01);
    const dC = Math.abs(u.uCloudCover.value - (this._envCover ?? -1));
    this._envTimer += 1;
    const shot = this.world.engine.shot;
    if (!force && !shot && dSun < 2e-5 && dR < 1 && dC < 0.03 && this._envTimer < 90) return;
    if (!force && shot && dSun < 1e-7 && dR < 0.05 && dC < 0.005 && this.envRT) return;
    key.set(sd.x, sd.y, sd.z, r);
    this._envCover = u.uCloudCover.value;
    this._envTimer = 0;
    this.cubeCam.update(renderer, this.envScene);
    if (!this.envRT) this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture);
    else this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT);
    this.world.scene.environment = this.envRT.texture;
  }

  /** Patch a material: cloud shadows on the key light; PBR skips the hemisphere fallback light. */
  setupMaterial(mat) {
    if (!mat || mat.userData?.noCSM || mat.userData?.rvAtmo) return;
    const ok = mat.isMeshStandardMaterial || mat.isMeshLambertMaterial || mat.isMeshPhongMaterial || mat.isMeshToonMaterial;
    if (!ok) return;
    const pbr = !!mat.isMeshStandardMaterial;
    const U = this.uniforms;
    const prevOBC = mat.onBeforeCompile;
    const ownKey = mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey;
    const prevKey = mat.customProgramCacheKey;
    const prevStr = ownKey ? '' : (prevOBC ? prevOBC.toString() : '');
    mat.onBeforeCompile = function rvAtmoOBC(shader, renderer) {
      if (prevOBC) prevOBC.call(this, shader, renderer);
      shader.uniforms.rvCloudShadowMap = U.rvCloudShadowMap;
      shader.uniforms.rvCloudShadowMatrix = U.rvCloudShadowMatrix;
      shader.uniforms.rvCloudShadowParams = U.rvCloudShadowParams;
      let fs = shader.fragmentShader;
      if (!fs.includes('#include <lights_fragment_begin>')) return;
      fs = fs.replace('#include <lights_fragment_begin>', '#include <rv_lights_fragment_begin>');
      const defs = '#define RV_CLOUD_SHADOW\n' + (pbr ? '#define RV_SKIP_HEMI\n' : '');
      if (fs.includes('#include <common>')) fs = fs.replace('#include <common>', '#include <common>\n#include <rv_cloudshadow>');
      else fs = '#include <rv_cloudshadow>\n' + fs;
      shader.fragmentShader = defs + fs;
    };
    mat.customProgramCacheKey = function () { return (ownKey ? prevKey.call(this) : prevStr) + '|rvatmo' + (pbr ? 'P' : 'L'); };
    mat.userData.rvAtmo = true;
    mat.needsUpdate = true;
  }

  setupAll() {
    const root = this.world.root;
    root.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh) return;
      if (o.userData?.noCSM) return;
      const m = o.material;
      if (Array.isArray(m)) { for (const mm of m) this.setupMaterial(mm); } else this.setupMaterial(m);
    });
  }

  dispose() {
    this.key.removeFromParent(); this.key.dispose?.();
    this.key.shadow?.map?.dispose?.();
    this.hemi.removeFromParent();
    this.cubeRT.dispose(); this.envRT?.dispose(); this.pmrem.dispose();
    this.envMat.dispose(); this.envBox.geometry.dispose();
    this._placeholder.dispose();
    if (this.world.scene.environment === this.envRT?.texture) this.world.scene.environment = null;
  }
}
