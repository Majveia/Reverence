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
import { Clouds } from './clouds.js';
import { Weather } from './weather.js';
import { LightShafts } from './lightshafts.js';

const _up = new THREE.Vector3(), _v = new THREE.Vector3(), _n = new THREE.Vector3();

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
    try {
      this.clouds = new Clouds(this);
      if (this.clouds.present) this._removers.push(world.engine.pipeline.addEffect(this.clouds));
    } catch (e) { console.error('[atmosphere] clouds init failed', e); this.clouds = null; }
    try {
      this.shafts = new LightShafts(this);
      if (this.shafts.enabled) this._removers.push(world.engine.pipeline.addEffect(this.shafts));
    } catch (e) { console.error('[atmosphere] light shafts init failed', e); this.shafts = null; }
    try {
      this.weatherSys = new Weather(this);
      this._removers.push(world.engine.pipeline.addEffect(this.weatherSys));
    } catch (e) { console.error('[atmosphere] weather init failed', e); this.weatherSys = null; }

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
    const camLocal = w.camera.getWorldPosition(this._camLocal).add(w.origin);
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
    this.nightAmbient.setRGB(0.020 + tint.r * 0.006, 0.026 + tint.g * 0.008, 0.052 + tint.b * 0.012).multiplyScalar(night * E * 0.55 * (1 + 0.4 * (this.model.moody || 0)));   // moody (neon-noir) nights: glow-lit silhouettes read further
    const present = this.model.present;
    // night sky: scattered starlight + airglow continuum, art-lifted so a moonless sky reads deep blue
    // (not a void) after eye adaptation; airglow emission layer = faint green band along the horizon
    const ns = present ? night * E * 0.0032 * (0.55 + 0.45 * Math.min(this.model.density, 1.4)) : 0;
    S.uNightSky.value.set(0.26 * ns + tint.r * 0.05 * ns, 0.40 * ns + tint.g * 0.05 * ns, 0.85 * ns);
    S.uAirglow.value.set(0.12, 0.62, 0.30).multiplyScalar(present ? night * E * 0.00025 * (0.6 + this.model.density * 0.4) : 0);

    // overcast fraction of the sky (cloud type coverage + weather): greys & dims the ambient, feeds the env deck
    const W = this.weather;
    const mc = this.clouds?.present ? this.clouds.meanCover : 0;
    W.overcast = THREE.MathUtils.clamp(mc * mc * 0.8 + (W.coverBoost || 0) * 1.25 * (this.clouds?.present ? 1 : 0.4), 0, 1);
    this.lighting.update(dt, { model: this.model, camLocal, up, sunDir, camR, starColor: this.starColor, sunAngR: this.sunAngR, nightAmbient: this.nightAmbient, weather: this.weather });

    const moon = this.lighting.moon;
    S.uMoonDir.value.copy(moon.dir);
    const R = this.model.rayleigh;
    const rm = Math.max(R.x, R.y, R.z);
    const mE = moon.ill * E * (present ? 1 : 0) * night;
    S.uMoonSky.value.set(R.x / rm, R.y / rm, R.z / rm).multiplyScalar(mE * 0.06);

    // aurora
    const aur = this.weather.aurora ?? w.body.weather?.aurora ?? 0;
    S.uAurora.value = present ? aur * night * 1.6 : 0;
    S.uAuroraLat.value = Math.sin(THREE.MathUtils.lerp(58, 8, THREE.MathUtils.clamp(aur, 0, 1)) * Math.PI / 180);

    // wind direction (strength, wetness, snow: weather module)
    this._updateWind(t, up);
    if (this.weatherSys) {
      try { this.weatherSys.update(dt, t); } catch (e) { if ((this._wErr = (this._wErr || 0) + 1) < 4) console.error('[atmosphere] weather update failed', e); }
    }
    this._updateFog(t);
    if (this.clouds?.present) {
      try { this.clouds.update(dt, t, { G, lighting: this.lighting, sunDir, sunMu: muS, camR, coverBoost: this.weather.coverBoost || 0, flash: this.weather.flash || 0 }); }
      catch (e) { if ((this._cErr = (this._cErr || 0) + 1) < 4) console.error('[atmosphere] clouds update failed', e); }
    }
    this.effect.u.uFallbackSun.value = w.get('space') ? 0 : 1;
    this.frame++;
  }

  _updateWind(t, up) {
    const wx = this.world.body.art?.weather || {};
    const base = wx.wind ?? 0.3;
    const gust = 0.5 + 0.5 * Math.sin(t * 0.13) * Math.sin(t * 0.071 + 1.3);
    if (!this.weatherSys) G.uWindStrength.value = THREE.MathUtils.clamp(base * (0.75 + 0.5 * gust) + this.weather.storm * 0.4, 0, 1);
    // prevailing wind: eastward (tangent), slowly veering
    const east = _v.set(0, 1, 0).cross(up);
    if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = _n.crossVectors(up, east);
    const a = 0.6 * Math.sin(t * 0.017) + 0.3;
    G.uWindDir.value.copy(east).multiplyScalar(Math.cos(a)).addScaledVector(north, Math.sin(a)).normalize();
  }

  // height fog / fog banks / dust / rain haze (analytic exponential height fog in the atmosphere pass)
  _updateFog(t) {
    const W = this.weather, u = this.effect.u, m = this.model;
    if (!m.present) { u.uFog.value.set(0, 1, 0, 0); return; }
    const fog = W.fog || 0, dust = W.dust || 0, rain = Math.max(W.rain || 0, W.snow || 0);
    let rho = fog * fog * 2.0e-4 + rain * 5e-5 + dust * 1.2e-3;
    if (m.lava) rho *= 0.45;
    const Hf = THREE.MathUtils.lerp(320, 1600, THREE.MathUtils.clamp((rain + dust * 1.5) / Math.max(fog + rain + dust, 1e-3), 0, 1));
    const sea = this.world.surface?.seaLevel ?? 0;
    u.uFog.value.set(rho, Hf, sea + 30, 0.35 + 0.65 * fog);
    // fog color: dust tint / cool rain grey / white mist
    const tint = m.tint;
    const c = u.uFogAlbedo.value;
    c.set(0.95, 0.96, 1.0);
    if (dust > 0) c.lerp(_v.set(0.95 * Math.min(1, tint.r * 1.6 + 0.3), 0.75 * Math.min(1, tint.g * 1.4 + 0.25), 0.55 * Math.min(1, tint.b * 1.2 + 0.2)), Math.min(1, dust * 1.5));
    const sky = this.lighting.skyIrr, na = this.nightAmbient, nk = 0.03; // dark nights: no glowing fog
    u.uFogAmb.value.set((sky[0] + na.r * nk) / Math.PI, (sky[1] + na.g * nk) / Math.PI, (sky[2] + na.b * nk) / Math.PI);
    const sc = this.lighting.sunColor, sd = Math.max(0, W.sunDim ?? 1);
    u.uFogSun.value.set(sc.r, sc.g, sc.b).multiplyScalar(sd * sd);
    u.uFogWind.value.set(G.uWindDir.value.x, G.uWindDir.value.z).multiplyScalar(t * 6);
    // lava glow in the low haze (emission, so it reads most at dusk and night)
    if (m.lava) u.uLavaGlow.value.set(1.0 * 0.05, 0.3 * 0.05, 0.06 * 0.05, 1 / 350);
    else u.uLavaGlow.value.w = 0;
  }

  // ---------------------------------------------------------------- GPU pre-render
  _preRender(renderer, camera) {
    if (this._errors > 5) return;
    // only for the main view (reflection / probe cameras reuse this frame's LUTs)
    if (camera !== this.world.camera && this._preFrame === this.engine.time.frame) return;
    this._preFrame = this.engine.time.frame;
    const rs = this._rs;
    rs.save(renderer);
    try {
      renderer.autoClear = true;
      const camLocal = _v.setFromMatrixPosition(camera.matrixWorld).add(this.world.origin);
      const camR = camLocal.length();
      this.lighting.envU.uCamPlanet.value.copy(camLocal);
      if (this.luts) {
        if (!this.luts.staticDone) this.luts.buildStatic(renderer);
        if (camR < this.model.Rt * 1.001) {
          const muS = camLocal.normalize().dot(this.shared.uSunDir.value);
          const gi = this.lighting.envU.uGroundIrr.value;
          this.luts.updateSky(renderer, camR, muS, gi);
        }
        // blend LUT sky ↔ per-pixel march near the top of the atmosphere
        const h = (camR - this.model.Rb) / this.model.height;
        // brighter sky dome from the ground (game-like sky vs sunlit ground), relaxed toward the LUT→march blend
        this.atmoUniforms.uSkyViewGain.value = THREE.MathUtils.lerp(1.28 - 0.2 * (this.model.moody || 0), 1, THREE.MathUtils.smoothstep(h, 0.3, 0.8));
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

  // compass azimuth (deg, 0 = north, 90 = east) of a direction seen from local up
  _azimuth(up, d) {
    const east = _v.set(0, 1, 0).cross(up);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    const north = _n.crossVectors(up, east);
    return (Math.atan2(d.dot(east), d.dot(north)) * 57.2958 + 360) % 360;
  }

  getState() {
    const up = this._camLocal.clone().normalize();
    const L = this.lighting;
    return {
      sunElev: +(Math.asin(THREE.MathUtils.clamp(up.dot(this.world.celestial.sunDir), -1, 1)) * 57.2958).toFixed(1),
      key: L.keyIsMoon ? 'moon' : 'sun',
      moon: L.moon.body ? { name: L.moon.body.name, ill: +L.moon.ill.toFixed(3), elev: +(Math.asin(THREE.MathUtils.clamp(up.dot(L.moon.dir), -1, 1)) * 57.2958).toFixed(1), az: +this._azimuth(up, L.moon.dir).toFixed(1) } : null,
      sunAz: +this._azimuth(up, this.world.celestial.sunDir).toFixed(1),
      overcast: +(this.weather.overcast || 0).toFixed(2),
      night: +L.nightFactor.toFixed(2),
      env: !!L.envRT,
      shadows: !!L.key.castShadow,
      clouds: this.clouds?.present ? this.clouds.type : 'none',
      weather: Object.fromEntries(['rain', 'snow', 'dust', 'fog', 'storm', 'wind', 'flash'].map((k) => [k, +(this.weather[k] || 0).toFixed(2)])),
      wet: +G.uWetness.value.toFixed(2), snowCover: +G.uSnow.value.toFixed(2),
    };
  }

  dispose() {
    for (const r of this._removers) try { r(); } catch (_) { /* ignore */ }
    this.world.scene.onBeforeRender = this._prevOBR || function () {};
    this.effect.dispose();
    this.luts?.dispose();
    this.clouds?.dispose?.();
    this.shafts?.dispose?.();
    this.weatherSys?.dispose?.();
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
