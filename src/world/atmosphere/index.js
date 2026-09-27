// Atmosphere & lighting subsystem (order 20). OWNED BY THE ATMOSPHERE TRACK.
// Baseline: sun DirectionalLight (+shadows following camera), hemisphere ambient, analytic sky
// dome at the far plane, exp2 fog. Writes shared lighting uniforms (G.uSunDir etc.).
// The atmosphere track replaces this with physically based scattering (post effect reading
// depth for aerial perspective), volumetric clouds, weather, stars/night sky, env maps.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
#ifdef USE_REVERSED_DEPTH_BUFFER
  gl_Position = vec4(p.xy, 0.0, p.w);
#else
  gl_Position = p.xyww;
#endif
}`;
const SKY_FRAG = /* glsl */ `
#include <rv_common>
uniform vec3 uSunDir; uniform vec3 uUp; uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSunColor;
uniform float uDay; uniform float uSpace;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float h = dot(d, uUp);
  float sh = dot(uSunDir, uUp);
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.45));
  // sunset glow toward the sun near the horizon
  float toward = max(dot(d, uSunDir), 0.0);
  float glow = pow(toward, 6.0) * smoothstep(0.35, -0.1, sh) * smoothstep(-0.35, 0.05, sh);
  sky += vec3(1.0, 0.45, 0.18) * glow * 1.6;
  sky *= uDay;
  // below horizon: darker ground haze
  sky = mix(sky, uHorizon * uDay * 0.35, smoothstep(0.0, -0.25, h));
  // sun disk + corona
  float sd = dot(d, uSunDir);
  sky += uSunColor * (smoothstep(0.99965, 0.99985, sd) * 60.0 + pow(max(sd, 0.0), 800.0) * 4.0);
  // stars when dark or in space
  float night = clamp(1.0 - uDay * 1.3 + uSpace, 0.0, 1.0);
  vec3 sd3 = floor(d * 420.0);
  float st = rv_hash13(sd3);
  sky += vec3(pow(st, 180.0) * 6.0) * night * smoothstep(-0.05, 0.1, h + uSpace);
  sky = mix(sky, vec3(0.0) + uSunColor * (smoothstep(0.99965, 0.99985, sd) * 60.0) + vec3(pow(st, 180.0) * 6.0), uSpace);
  gl_FragColor = vec4(sky, 1.0);
}`;

class Atmosphere {
  constructor(world) {
    this.world = world;
    const b = world.body;
    const pal = b.art.palette;
    this.zenith = new THREE.Color(pal.sky).multiplyScalar(0.85);
    this.horizon = new THREE.Color(pal.fog);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = world.quality.shadows;
    this.sun.shadow.mapSize.set(world.quality.shadowMapSize, world.quality.shadowMapSize);
    const sc = this.sun.shadow.camera;
    sc.left = -90; sc.right = 90; sc.top = 90; sc.bottom = -90; sc.near = 1; sc.far = 3000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    world.root.add(this.sun);
    world.root.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a3020, 0.6);
    world.root.add(this.hemi);

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, depthWrite: false, side: THREE.BackSide,
      uniforms: {
        uSunDir: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3(0, 1, 0) },
        uZenith: { value: this.zenith }, uHorizon: { value: this.horizon }, uSunColor: { value: new THREE.Color() },
        uDay: { value: 1 }, uSpace: { value: 0 },
      },
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    world.scene.add(this.sky);

    this.fog = new THREE.FogExp2(this.horizon.clone(), 0.00004 * (b.atmosphere.density || 0));
    world.scene.fog = b.atmosphere.present ? this.fog : null;
    this._c = new THREE.Color();
  }

  update(dt) {
    const w = this.world, cel = w.celestial;
    const camLocal = w.camera.position;
    const up = camLocal.clone().normalize();
    const alt = camLocal.length() - w.body.radius;
    const sunDir = cel.sunDir;
    const elev = up.dot(sunDir);
    const day = THREE.MathUtils.smoothstep(elev, -0.18, 0.12);
    const atmoH = w.body.atmosphere.height || 1;
    const space = w.body.atmosphere.present ? THREE.MathUtils.smoothstep(alt, atmoH * 0.4, atmoH * 1.2) : 1;

    // sun color: warmer near the horizon (Rayleigh extinction), star color tint
    const warm = THREE.MathUtils.smoothstep(elev, 0.35, -0.02);
    this._c.copy(w.star.color).lerp(new THREE.Color(1.0, 0.5, 0.22), warm * (1 - space));
    const sunI = 3.2 * THREE.MathUtils.smoothstep(elev, -0.06, 0.1);
    this.sun.color.copy(this._c);
    this.sun.intensity = Math.max(sunI, 0.0) + (1 - day) * 0.05;
    this.sun.position.copy(camLocal).addScaledVector(sunDir.lengthSq() ? sunDir : up, 1000);
    this.sun.target.position.copy(camLocal);
    if (day < 0.02) { // moonlight-ish fill
      this.sun.color.setRGB(0.45, 0.55, 0.8);
      this.sun.intensity = 0.12;
      this.sun.position.copy(camLocal).addScaledVector(up, 1000).addScaledVector(sunDir, -300);
    }
    this.hemi.position.copy(up);
    this.hemi.color.copy(this.zenith).multiplyScalar(0.25 + day);
    this.hemi.groundColor.set(w.body.art.palette.rock).multiplyScalar(0.25 * (0.15 + day));
    this.hemi.intensity = 0.25 + 0.75 * day;

    const u = this.skyMat.uniforms;
    u.uSunDir.value.copy(sunDir); u.uUp.value.copy(up);
    u.uSunColor.value.copy(this._c); u.uDay.value = day; u.uSpace.value = space;
    this.sky.position.set(0, 0, 0); // camera-centered via view rotation only

    if (this.fog) {
      this.fog.color.copy(this.horizon).multiplyScalar(0.08 + 0.92 * day);
      this.fog.density = 0.000035 * (w.body.atmosphere.density || 0) * (1 - space) * (1 + (w.body.weather.fog || 0) * 2);
    }

    // shared uniforms (directions are identical in local & scene space)
    G.uSunDir.value.copy(sunDir);
    G.uSunColor.value.copy(this._c).multiplyScalar(sunI);
    G.uSunIntensity.value = sunI;
    G.uAmbientSky.value.copy(this.hemi.color).multiplyScalar(this.hemi.intensity);
    G.uAmbientGround.value.copy(this.hemi.groundColor).multiplyScalar(this.hemi.intensity);
    G.uNight.value = 1 - day;
  }

  getState() {
    const up = this.world.camera.position.clone().normalize();
    return { sunElev: +(Math.asin(up.dot(this.world.celestial.sunDir)) * 57.3).toFixed(1) };
  }
  dispose() { this.sky.geometry.dispose(); this.skyMat.dispose(); this.sun.dispose(); }
}

export default {
  name: 'atmosphere',
  order: 20,
  async create(world) { return new Atmosphere(world); },
};
