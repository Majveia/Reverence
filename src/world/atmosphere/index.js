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
    this._starEcl = sc.clone();
    this.eclipse = 0; this.twilight = 0;

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
    // eclipse (space track): the star is (partly) hidden by a moon / planet → sunlight dims, the sky turns to
    // a deep blue-violet dome ringed by last light all around the horizon (see effect.js twilightSky)
    this.eclipse = this._eclipse(camLocal);
    const ecl = 1 - 0.97 * this.eclipse;
    this._starEcl.copy(this.starColor).multiplyScalar(ecl);
    S.uSunDir.value.copy(sunDir);
    S.uSunIll.value.set(this._starEcl.r * E, this._starEcl.g * E, this._starEcl.b * E);
    S.uTime.value = t;
    const muS = up.dot(sunDir);
    this._sunMu = muS;

    // night ambient (starlight + airglow), art-directed to keep nights readable
    const night = 1 - THREE.MathUtils.smoothstep(muS, -0.3, -0.02);
    const tint = this.model.tint;
    const present = this.model.present;
    // blue hour: the sky keeps its colour while the land goes dark (expose for the sky): the art "readable
    // night" ground ambient is held back while the twilight dome glows, and returns once it is fully night
    const twRise = 1 - THREE.MathUtils.smoothstep(muS, -0.035, 0.045);
    const twFade = THREE.MathUtils.smoothstep(muS, -0.40, -0.19);
    const twi = present ? Math.max(twRise * twFade, this.eclipse) : 0;
    this.twilight = twi;
    this.twBlue = present ? twRise * twFade : 0;   // blue-hour window (lighting.js holds the land's ambient back)
    this.nightAmbient.setRGB(0.020 + tint.r * 0.006, 0.026 + tint.g * 0.008, 0.052 + tint.b * 0.012).multiplyScalar(night * E * 0.47 * (1 + 0.4 * (this.model.moody || 0)) * (1 - 0.6 * twRise * twFade));   // moody (neon-noir) nights: glow-lit silhouettes read further
    // night sky: scattered starlight + airglow continuum, art-lifted so a moonless sky reads deep blue
    // (not a void) after eye adaptation; airglow emission layer = faint green band along the horizon
    const ns = present ? night * E * 0.0032 * (0.55 + 0.45 * Math.min(this.model.density, 1.4)) : 0;
    // deep indigo (saturated, not slate): the night sky reads blue against a darker land
    S.uNightSky.value.set(0.20 * ns + tint.r * 0.05 * ns, 0.36 * ns + tint.g * 0.05 * ns, 1.25 * ns);
    // orbit: the soft airglow shell gives way to the thin hard limb line (effect.js limbLine)
    const hh = (camR - this.model.Rb) / Math.max(this.model.height, 1);
    const limbK = present ? THREE.MathUtils.smoothstep(hh, 1.0, 2.2) : 0;
    S.uAirglow.value.set(0.12, 0.62, 0.30).multiplyScalar(present ? night * E * 0.00025 * (0.6 + this.model.density * 0.4) * (1 - limbK) : 0);
    const eu = this.effect.u;
    eu.uLimb.value.x = limbK * E * 0.0095 * Math.min(1.3, 0.6 + 0.4 * this.model.density);
    if (!this._limbCol) {
      // limb line colours from the world's own sky (not a fixed teal / green): a pale, near-white line on the
      // day side with a breath of the sky hue, warm at the terminator, a very faint airglow hairline at night
      this._limbCol = true;
      const tl0 = Math.max(tint.r, tint.g, tint.b, 1e-3);
      eu.uLimbDay.value.set(0.62 + 0.38 * tint.r / tl0, 0.66 + 0.34 * tint.g / tl0, 0.72 + 0.28 * tint.b / tl0);
      eu.uLimbWarm.value.set(1.0, 0.56, 0.36);
      eu.uLimbNight.value.set(0.16 + 0.1 * tint.r / tl0, 0.22 + 0.12 * tint.g / tl0, 0.42 + 0.12 * tint.b / tl0);
      eu.uLimb.value.w = 0.012;
    }
    if (limbK > 0 && this._limbR === undefined) {
      // the emitting shell sits just above the cloud tops and the highest relief (else clouds / peaks cut it)
      const Hm = this.model.height, Rb = this.model.Rb;
      const cTop = this.clouds?.present ? this.clouds.Rc1 - Rb : 0;
      const relief = Math.max(0, this.world.surface?.maxHeight ?? 0);
      this._limbR = Rb + Math.min(0.62 * Hm, Math.max(0.12 * Hm, cTop + 0.05 * Hm, relief * 0.85));
      eu.uLimb.value.y = this._limbR;
      eu.uLimb.value.z = Hm * 0.016;
    }
    // blue hour palette: navy zenith (a touch of the world's sky tint), orange last light under the sun
    const tl = Math.max(1e-3, tint.r + tint.g + tint.b);
    eu.uTwiZen.value.set(0.05 * 0.75 + 0.25 * 0.6 * tint.r / tl, 0.11 * 0.75 + 0.25 * 0.6 * tint.g / tl, 0.5 * 0.75 + 0.25 * 0.6 * tint.b / tl).multiplyScalar(E * 0.04);
    eu.uTwiHor.value.set(1.0, 0.40, 0.12).multiplyScalar(E * 0.12);
    const ocT = this.weather.overcast || 0;
    eu.uTwi.value.set(twi * (1 - 0.75 * ocT), Math.max(Math.min(1.2, Math.exp(muS / 0.1)), this.eclipse), muS, this.eclipse);
    // stars & the galactic band: hidden by a bright day sky, shown against the dark night sky
    eu.uStarVis.value = THREE.MathUtils.lerp(3.0, 0.45, night);
    // the sky answers (player: world.player.meditating 0..1): more stars, a faint ring of light at the zenith
    let med = 0;
    try { med = THREE.MathUtils.clamp(+(w.player?.meditating || 0), 0, 1); } catch (_) { med = 0; }
    this.meditating = med;
    if (med > 0) eu.uStarVis.value *= 1 - 0.6 * med;
    eu.uSource.value.x = present ? med * med * E * (0.0012 + 0.0035 * night) : 0;

    // overcast fraction of the sky (cloud type coverage + weather): greys & dims the ambient, feeds the env deck
    const W = this.weather;
    const mc = this.clouds?.present ? this.clouds.meanCover : 0;
    W.overcast = THREE.MathUtils.clamp(mc * mc * 0.8 + (W.coverBoost || 0) * 1.25 * (this.clouds?.present ? 1 : 0.4), 0, 1);
    this.lighting.update(dt, { model: this.model, camLocal, up, sunDir, camR, starColor: this._starEcl, sunAngR: this.sunAngR, nightAmbient: this.nightAmbient, weather: this.weather });

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
    // meditation stills the wind (grass, clouds and particles read G.uWindStrength)
    if (this.meditating > 0) G.uWindStrength.value *= 1 - 0.8 * this.meditating;
    this._updateFog(t);
    if (this.clouds?.present) {
      try { this.clouds.update(dt, t, { G, lighting: this.lighting, sunDir, sunMu: muS, camR, coverBoost: this.weather.coverBoost || 0, flash: this.weather.flash || 0 }); }
      catch (e) { if ((this._cErr = (this._cErr || 0) + 1) < 4) console.error('[atmosphere] clouds update failed', e); }
    }
    this.effect.u.uFallbackSun.value = w.get('space') ? 0 : 1;
    // dust storm / heavy snow: from below, the clouds are swallowed by the veil (one-colour wall)
    if (this.clouds?.u?.uSwallow) {
      const W = this.weather, cl = this.clouds;
      const below = 1 - THREE.MathUtils.smoothstep(camR, cl.Rc0 - 200, cl.Rc0 + 300);
      this.clouds.u.uSwallow.value = THREE.MathUtils.clamp((W.dust || 0) * 0.92 + (W.snow || 0) * 0.45, 0, 0.95) * below;
    }
    this.frame++;
  }

  /** 0..1 eclipse of the star (space track: `space.eclipse`, else 1 − visible fraction of the disc). */
  _eclipse(camLocal) {
    const sp = this.world.get?.('space');
    if (!sp) return 0;
    try {
      if (typeof sp.eclipse === 'number') return THREE.MathUtils.clamp(sp.eclipse, 0, 1);
      if (typeof sp.sunVisibility === 'function') {
        if ((this._eclT = (this._eclT || 0) + 1) % 4 === 1) this._eclV = THREE.MathUtils.clamp(1 - sp.sunVisibility(camLocal), 0, 1);
        return this._eclV || 0;
      }
    } catch (_) { /* optional neighbour */ }
    return 0;
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
    // golden-hour haze: low sun → humid, forward-scattering low haze that glows toward the sun
    // (Pacific Drive / Bierstadt light); none at night, a whisper by day
    const se = this._sunMu ?? 0.5;
    const gold = THREE.MathUtils.smoothstep(se, -0.05, 0.03) * (1 - THREE.MathUtils.smoothstep(se, 0.1, 0.42));
    this.goldHaze = gold;
    // heavy rain: visibility of a few km (grey rain haze swallows the forest at a few hundred metres)
    const rn = W.rain || 0;
    // snow is fog (falling snow swallows the land within ~1 km); a dust storm is a one-colour wall
    const sn = W.snow || 0;
    let rho = fog * fog * 2.0e-4 + rn * 0.9e-4 + rn * rn * 2.4e-4 + sn * 3.0e-4 + sn * sn * 9e-4 + dust * 1.0e-3 + dust * dust * 1.6e-3 + gold * 2.6e-5 * (1 - 0.5 * (m.moody || 0));
    if (m.lava) rho *= 0.45;
    // bioluminescent worlds at night: a low mist that takes the glow of the flora (coloured fog lit by its
    // light source: teal around W4's glowing forest)
    const nf = this.lighting.nightFactor || 0;
    const bio = !m.lava && this._bioGlow() && nf > 0.05 ? nf : 0;
    rho += bio * 1.3e-4 * (1 - THREE.MathUtils.clamp(rain + dust, 0, 1));
    const wF = fog + rain + dust + gold * 0.12 + bio * 0.6;
    const Hf = THREE.MathUtils.lerp(320, 1600, THREE.MathUtils.clamp((rain + dust * 1.5) / Math.max(wF, 1e-3), 0, 1)) * (1 + gold * 0.6 * (1 - THREE.MathUtils.clamp(fog + rain + dust, 0, 1)));
    const sea = this.world.surface?.seaLevel ?? 0;
    u.uFog.value.set(rho, Hf, sea + 30, 0.35 + 0.65 * fog - 0.2 * gold * (1 - fog));
    // fog color: dust tint / cool rain grey / white mist
    const tint = m.tint;
    const c = u.uFogAlbedo.value;
    c.set(0.95, 0.96, 1.0);
    // the world's own fog hue (art palette): every haze carries a little of it (lavender rain veils, teal
    // neon smog, warm Bierstadt mist)
    const fh = this._fogHue();
    if (fh) c.lerp(fh, 0.3 + 0.15 * THREE.MathUtils.clamp(fog + rn, 0, 1));
    if (dust > 0) c.lerp(_v.set(0.95 * Math.min(1, tint.r * 1.6 + 0.3), 0.75 * Math.min(1, tint.g * 1.4 + 0.25), 0.55 * Math.min(1, tint.b * 1.2 + 0.2)), Math.min(1, dust * 1.5));
    // dust storm: everything in the haze collapses to ONE hue (the dust's, from the world's palette)
    const mono = u.uFogMono.value;
    if (dust > 0) {
      const ground = m.groundAlbedo || { r: 0.6, g: 0.45, b: 0.3 };
      _n.set(0.45 * ground.r + 0.55 * c.x, 0.45 * ground.g + 0.55 * c.y, 0.45 * ground.b + 0.55 * c.z);
      const mx = Math.max(_n.x, _n.y, _n.z, 1e-3);
      // push saturation: the dominant channel stays, the others fall away
      mono.set(Math.pow(_n.x / mx, 1.6), Math.pow(_n.y / mx, 1.6), Math.pow(_n.z / mx, 1.6), Math.min(0.92, dust * 1.1));
    } else mono.w = 0;
    const sky = this.lighting.skyIrr, na = this.nightAmbient, nk = 0.03; // dark nights: no glowing fog
    // under a closed deck the haze is lit by the dark cloud bases, not by a bright sky dome
    // (a storm deck is darker still: slate-grey rain haze, not a milky fog brighter than the cloud bases)
    // a plain rain (no storm) veil is pale: each ridge one step lighter, merging into the deck
    const ock = (1 - 0.45 * (W.overcast || 0)) * (1 - 0.5 * (W.storm || 0)) * (1 + 0.45 * rn * (1 - (W.storm || 0))) / Math.PI;
    u.uFogAmb.value.set((sky[0] + na.r * nk) * ock, (sky[1] + na.g * nk) * ock, (sky[2] + na.b * nk) * ock);
    const sc = this.lighting.sunColor, sd = Math.max(0, W.sunDim ?? 1);
    u.uFogSun.value.set(sc.r, sc.g, sc.b).multiplyScalar(sd * sd);
    u.uFogWind.value.set(G.uWindDir.value.x, G.uWindDir.value.z).multiplyScalar(t * 6);
    // landscape-scale aerial perspective (effect.js landOD / hazeSky): an exponential haze over the land whose
    // in-scatter is the sky colour behind each ridge → every ridge back one step paler; rain triples it
    {
      const L = u.uLand.value, oc = W.overcast || 0, storm = W.storm || 0;
      const sizeK = THREE.MathUtils.clamp((this.world.body.radius || 70000) / 70000, 0.6, 1.4);
      const camR = this._camLocal.length();
      const hh = (camR - m.Rb) / Math.max(m.height, 1);
      const highFade = 1 - THREE.MathUtils.smoothstep(hh, 0.55, 1.15);   // from orbit: the physical veil only
      const art = 1 + 0.6 * (m.moody || 0) + 0.5 * (m.fog || 0) + 0.3 * (m.dust || 0);
      const wet = 1 + 3.2 * rn + 1.2 * rn * rn + 0.8 * oc * oc + 0.8 * fog;
      const k = m.lava ? 0.35 : 1;
      L.set(0.62e-4 * art * wet * k * highFade / sizeK, 1 / ((1050 + 650 * rn + 300 * oc) * sizeK), m.Rb + Math.max(0, sea), 70000 * sizeK);
      // under a closed / raining deck the veil is the deck-lit air: a pale, lightly desaturated sky colour (the
      // world's fog hue), darker under storms
      const oL = u.uLandOC.value, sky = this.lighting.skyIrr, na = this.nightAmbient;
      const sl = (sky[0] * 0.2126 + sky[1] * 0.7152 + sky[2] * 0.0722) / Math.PI;
      const fhc = fh || _n.set(0.92, 0.95, 1.0);
      const lift = (0.76 + 0.26 * rn * (1 - storm)) * (1 - 0.55 * storm);
      oL.set((sl * (0.55 + 0.45 * fhc.x) + na.r * 0.02) * lift, (sl * (0.55 + 0.45 * fhc.y) + na.g * 0.02) * lift, (sl * (0.55 + 0.45 * fhc.z) + na.b * 0.02) * lift);
      oL.w = THREE.MathUtils.clamp(oc * 0.75 + rn * 0.5, 0, 0.9);
      u.uLandSun.value.x = THREE.MathUtils.smoothstep(this._sunMu ?? 0.5, -0.012, 0.015) * Math.max(0, Math.min(1, W.sunDim ?? 1));
    }
    // dust storm: the hidden sun glows inside the wall (one bright side), gust bands roll with the wind
    {
      const gl = u.uFogGlow.value, sc0 = this.lighting.sunColor, st = this.starColor, E = m.sunIlluminance;
      const muS = this._sunMu ?? 0.5;
      const above = THREE.MathUtils.smoothstep(muS, -0.06, 0.05);
      if (dust > 0.05) {
        const mono = u.uFogMono.value;
        const s = 0.07 * dust * E * above * (0.4 + 0.6 * Math.min(1, (sc0.r + sc0.g + sc0.b) / Math.max(1e-6, (st.r + st.g + st.b) * E) * 3));
        gl.set(mono.x * s, mono.y * s, mono.z * s, Math.min(1, dust * 1.1));
      } else if (fog > 0.4) {
        const s = 0.012 * (fog - 0.4) * above;
        gl.set(sc0.r * s, sc0.g * s, sc0.b * s, 0);
      } else gl.set(0, 0, 0, 0);
    }
    // lava glow in the low haze (emission, so it reads most at dusk and night)
    if (m.lava) u.uLavaGlow.value.set(1.0 * 0.05, 0.3 * 0.05, 0.06 * 0.05, 1 / 350);
    else if (bio > 0) { const g = this._bio; u.uLavaGlow.value.set(g.r * 0.006 * bio, g.g * 0.006 * bio, g.b * 0.006 * bio, 1 / 140); }
    else u.uLavaGlow.value.w = 0;
  }

  /** Fog hue from the art palette (max channel 1), or null. */
  _fogHue() {
    if (this._fh !== undefined) return this._fh;
    this._fh = null;
    try {
      const f = this.world.body.art?.palette?.fog;
      if (f) { const c = new THREE.Color(f); const mx = Math.max(c.r, c.g, c.b, 1e-3); this._fh = new THREE.Vector3(c.r / mx, c.g / mx, c.b / mx); }
    } catch (_) { this._fh = null; }
    return this._fh;
  }

  /** Glow colour of bioluminescent flora (art palette), or null. */
  _bioGlow() {
    if (this._bio !== undefined) return this._bio;
    this._bio = null;
    try {
      const art = this.world.body.art || {};
      const pf = art.palette?.flora;
      if (art.flora === 'bioluminescent' && pf?.length) {
        const c = new THREE.Color(pf[0]);
        const mx = Math.max(c.r, c.g, c.b, 1e-3);
        this._bio = c.multiplyScalar(1 / mx);
      }
    } catch (_) { this._bio = null; }
    return this._bio;
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
      // env map position: from high altitude / orbit a single probe at the camera would see the lit limb of the
      // planet as "ground" and light night-side facets with it → probe the air above the sub-camera point
      const envR = Math.min(camR, this.model.Rb + this.model.height * 0.5);
      this.lighting.envU.uCamPlanet.value.copy(camLocal).multiplyScalar(envR / Math.max(camR, 1));
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
      // orbit look (view-only, the LUTs stay physical): compressed shell → thin graded limb; relaxed sunset
      // reddening → a narrow orange terminator band instead of a broad orange quarter of the disc
      if (this.model.present) {
        const hh = (camR - this.model.Rb) / this.model.height;
        const ok = THREE.MathUtils.smoothstep(hh, 1.2, 3.2);
        const AU = this.atmoUniforms;
        AU.uOrbitK.value = ok;
        AU.uSunsetK.value = THREE.MathUtils.lerp(this.model.sunsetK, 1.15, ok);
        AU.uSunKDrop.value = 0.18 * ok;
        this.effect.u.uOrbitLit.value = this.lighting.highView || 0;
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
      cities: this.effect.u.uCityN.value, gold: +(this.goldHaze || 0).toFixed(2),
      twilight: +(this.twilight || 0).toFixed(2), eclipse: +(this.eclipse || 0).toFixed(2),
      rainbow: +(this.weather.rainbow || 0).toFixed(2), shafts: this.shafts?.dbg || null,
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
