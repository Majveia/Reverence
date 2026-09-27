// Atmosphere, sky, clouds, weather & lighting subsystem (order 20). OWNED BY THE ATMOSPHERE TRACK.
//
//   model.js      physical coefficients per body (Rayleigh/Mie/ozone), art-directed tint calibration,
//                 CPU transmittance & sky irradiance
//   luts.js       GPU LUTs (transmittance, multiple scattering, sky-view) — Hillaire 2020
//   effect.js     pipeline effect "atmosphere" (order 100): sky, aerial perspective, space view,
//                 night sky, airglow, aurora, star visibility
//   clouds.js     pipeline effect "clouds" (order 110): volumetric clouds + cloud shadow map
//   volumetric.js pipeline effect "volumetric-light" (order 120): god rays, fog banks, dust
//   weather.js    rain / snow / dust particles, lightning, weather state machine
//   lighting.js   key light (SunLight + cascaded shadows), moon, PMREM environment, material setup
//
// Public API (see docs/tracks/atmosphere.md):
//   world.lighting = { sun, csm, envMap, setupMaterial(mat), uniforms{rvCloudShadow*, uKeyDir, uKeyColor} }
//   world.atmosphere = this instance: skyRadiance(dir) (CPU approx), weather, shared uniforms
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import './glsl.js';
import { AtmosphereModel } from './model.js';
import { AtmosphereLUTs } from './luts.js';
import { AtmosphereEffect } from './effect.js';
import { Lighting } from './lighting.js';
import { RenderState } from './fs.js';

const _up = new THREE.Vector3(), _v = new THREE.Vector3();

class Atmosphere {
  constructor(world) {
    this.world = world;
    this.engine = world.engine;
    this.quality = world.quality;
    const body = world.body;
    this.model = new AtmosphereModel(body);
    this.atmoUniforms = this.model.uniforms();
    this.shared = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunIll: { value: new THREE.Vector3(1, 1, 1) },
      uNightSky: { value: new THREE.Vector3() },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonSky: { value: new THREE.Vector3() },
      uAirglow: { value: new THREE.Vector3() },
      uAurora: { value: 0 },
      uAuroraLat: { value: 0.8 },
      uTime: { value: 0 },
    };
    // star color normalized to unit luminance with chromatic adaptation (the eye white-balances to
    // its star: an M-dwarf world is warm, not orange; keep ~25% of the residual tint for flavor)
    const sc = world.star?.color ? world.star.color.clone() : new THREE.Color(1, 1, 1);
    const lum = Math.max(1e-3, sc.r * 0.2126 + sc.g * 0.7152 + sc.b * 0.0722);
    sc.multiplyScalar(1 / lum).lerp(new THREE.Color(1, 1, 1), 0.75);
    const lum2 = sc.r * 0.2126 + sc.g * 0.7152 + sc.b * 0.0722;
    sc.multiplyScalar(1 / lum2);
    this.starColor = sc;
    this.sunAngR = 0.005;
    this.nightAmbient = new THREE.Color();

    this.luts = this.model.present ? new AtmosphereLUTs(this.atmoUniforms, this.quality) : null;
    this.lighting = new Lighting(world, this);
    world.lighting = this.lighting;
    world.atmosphere = this;
    this.weather = { sunDim: 1, cloudCover: 0, fog: 0, rain: 0, snow: 0, dust: 0, storm: 0, wind: 0.3 };

    // remove the baseline exp2 fog (aerial perspective replaces it)
    world.scene.fog = null;
    world.scene.background = null;

    this.effect = new AtmosphereEffect(this);
    this.needsSkyPass = true;
    this._removers = [];
    this._removers.push(world.engine.pipeline.addEffect(this.effect));

    // GPU work that must happen before the scene renders (LUTs, env map, cloud shadows)
    this._rs = new RenderState();
    const prevOBR = world.scene.onBeforeRender;
    this._prevOBR = prevOBR;
    const self = this;
    world.scene.onBeforeRender = function (renderer, scene, camera, target) {
      try { prevOBR?.call(this, renderer, scene, camera, target); } catch (e) { console.error('[atmosphere] chained onBeforeRender failed', e); }
      self._preRender(renderer, camera);
    };
    this._errors = 0;
    this.frame = 0;
    this._camLocal = new THREE.Vector3();
  }

  // ---------------------------------------------------------------- per-frame CPU
  lateUpdate(dt, t) {
    const w = this.world, cel = w.celestial;
    const camLocal = this._camLocal.copy(w.camera.position);
    const camR = camLocal.length();
    const up = _up.copy(camLocal).divideScalar(Math.max(camR, 1));
    const sunDir = cel.sunDir;
    this.sunAngR = THREE.MathUtils.clamp((w.star?.radius || 7e5) / Math.max(cel.sunDistance, 1), 0.0015, 0.05);
    this.atmoUniforms.uSunAngR.value = this.sunAngR;
    const E = this.model.sunIlluminance;
    const S = this.shared;
    S.uSunDir.value.copy(sunDir);
    S.uSunIll.value.set(this.starColor.r * E, this.starColor.g * E, this.starColor.b * E);
    S.uTime.value = t;
    const muS = up.dot(sunDir);

    // night ambient (starlight + airglow), art-directed to keep nights readable
    const night = 1 - THREE.MathUtils.smoothstep(muS, -0.3, -0.02);
    const tint = this.model.tint;
    this.nightAmbient.setRGB(0.020 + tint.r * 0.006, 0.026 + tint.g * 0.008, 0.052 + tint.b * 0.012).multiplyScalar(night * E * 0.55);
    const present = this.model.present;
    const ns = present ? night * E * 0.0016 : 0;
    S.uNightSky.value.set(0.30 * ns, 0.42 * ns, 0.85 * ns);
    S.uAirglow.value.set(0.10, 0.55, 0.30).multiplyScalar(present ? night * E * 0.00055 * (0.6 + this.model.density * 0.4) : 0);

    this.lighting.update(dt, { model: this.model, camLocal, up, sunDir, camR, starColor: this.starColor, sunAngR: this.sunAngR, nightAmbient: this.nightAmbient, weather: this.weather });

    const moon = this.lighting.moon;
    S.uMoonDir.value.copy(moon.dir);
    const R = this.model.rayleigh;
    const rm = Math.max(R.x, R.y, R.z);
    const mE = moon.ill * E * (present ? 1 : 0) * night;
    S.uMoonSky.value.set(R.x / rm, R.y / rm, R.z / rm).multiplyScalar(mE * 0.2);

    // aurora
    const aur = w.body.weather?.aurora || 0;
    S.uAurora.value = present ? aur * night * 1.6 : 0;
    S.uAuroraLat.value = Math.sin(THREE.MathUtils.lerp(58, 8, THREE.MathUtils.clamp(aur, 0, 1)) * Math.PI / 180);

    // wind (until the weather module drives it)
    this._updateWind(t, up);
    this.effect.u.uFallbackSun.value = w.get('space') ? 0 : 1;
    this.frame++;
  }

  _updateWind(t, up) {
    const wx = this.world.body.art?.weather || {};
    const base = wx.wind ?? 0.3;
    const gust = 0.5 + 0.5 * Math.sin(t * 0.13) * Math.sin(t * 0.071 + 1.3);
    G.uWindStrength.value = THREE.MathUtils.clamp(base * (0.75 + 0.5 * gust) + this.weather.storm * 0.4, 0, 1);
    // prevailing wind: eastward (tangent), slowly veering
    const east = _v.set(0, 1, 0).cross(up);
    if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = new THREE.Vector3().crossVectors(up, east);
    const a = 0.6 * Math.sin(t * 0.017) + 0.3;
    G.uWindDir.value.copy(east).multiplyScalar(Math.cos(a)).addScaledVector(north, Math.sin(a)).normalize();
  }

  // ---------------------------------------------------------------- GPU pre-render
  _preRender(renderer, camera) {
    if (this._errors > 5) return;
    const rs = this._rs;
    rs.save(renderer);
    try {
      renderer.autoClear = true;
      const camLocal = this.world.camera.position;
      const camR = camLocal.length();
      if (this.luts) {
        if (!this.luts.staticDone) this.luts.buildStatic(renderer);
        if (camR < this.model.Rt * 1.001) {
          const muS = _v.copy(camLocal).normalize().dot(this.shared.uSunDir.value);
          const gi = this.lighting.envU.uGroundIrr.value;
          this.luts.updateSky(renderer, camR, muS, gi);
        }
        // blend LUT sky ↔ per-pixel march near the top of the atmosphere
        const h = (camR - this.model.Rb) / this.model.height;
        this.effect.u.uSpaceBlend.value = THREE.MathUtils.smoothstep(h, 0.82, 0.98);
      }
      this.clouds?.preRender?.(renderer, camera);
      this.lighting.updateEnv(renderer);
    } catch (e) {
      this._errors++;
      console.error('[atmosphere] pre-render failed', e);
    }
    rs.restore(renderer);
  }

  isReady() { return true; }

  getState() {
    const up = this.world.camera.position.clone().normalize();
    const L = this.lighting;
    return {
      sunElev: +(Math.asin(THREE.MathUtils.clamp(up.dot(this.world.celestial.sunDir), -1, 1)) * 57.2958).toFixed(1),
      key: L.keyIsMoon ? 'moon' : 'sun',
      night: +L.nightFactor.toFixed(2),
      env: !!L.envRT,
      shadows: !!L.key.castShadow,
    };
  }

  dispose() {
    for (const r of this._removers) try { r(); } catch (_) { /* ignore */ }
    this.world.scene.onBeforeRender = this._prevOBR || function () {};
    this.effect.dispose();
    this.luts?.dispose();
    this.clouds?.dispose?.();
    this.lighting.dispose();
    if (this.world.lighting === this.lighting) this.world.lighting = null;
    if (this.world.atmosphere === this) this.world.atmosphere = null;
  }
}

export default {
  name: 'atmosphere',
  order: 20,
  async create(world) { return new Atmosphere(world); },
};
