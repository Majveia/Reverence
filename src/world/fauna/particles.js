// Motes: the small life in the air around the player, one draw call.
//   • fireflies at dusk/night: blinking bioluminescent sparks hovering over the vegetation
//     (colour from the world's art direction; glowing worlds get their own hues)
//   • pollen / seeds / midges by day: sun-lit specks drifting on the wind, only visible against
//     the light (forward scattering), a BotW / Planet Earth "air is alive" layer
// Particles are anchored on the terrain around the player (CPU, re-seated when the player
// moves away) and animated entirely in the vertex shader (no per-frame CPU work).
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { hash01 } from './math.js';

const VERT = /* glsl */`
attribute vec4 aSeed;      // phase, speed, kind (0 firefly, 1 pollen), size
attribute float aOn;
uniform float uTime;
uniform float uNight;
uniform float uRadius;
uniform vec3 uCam;         // camera, relative to the particle origin
uniform vec2 uResolution;
uniform vec3 uWind;
uniform vec3 uSunDir;
varying float vA;
varying float vKind;
varying float vSun;
void main(){
  vec3 p = position;
  float ph = aSeed.x * 6.2831, sp = aSeed.y;
  float t = uTime;
  vKind = aSeed.z;
  if (aSeed.z < 0.5) {
    // firefly: slow looping hover (lissajous) + gentle rise/fall
    p += vec3(sin(t * 0.37 * sp + ph) * 1.4, sin(t * 0.23 * sp + ph * 1.7) * 0.6, cos(t * 0.31 * sp + ph * 0.6) * 1.4);
  } else {
    // pollen: drifts with the wind, wraps inside a 16 m tube, tiny turbulent wobble
    vec3 w = uWind * (0.6 + sp);
    vec3 d = mod(w * t + vec3(ph * 3.0, 0.0, ph * 5.0), 16.0) - 8.0;
    p += d + vec3(sin(t * 1.3 + ph * 4.0), sin(t * 0.9 + ph * 2.0) * 0.5, cos(t * 1.1 + ph * 3.0)) * 0.25;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  float dc = length(p - uCam);
  float edge = 1.0 - smoothstep(uRadius * 0.7, uRadius, dc);
  float a;
  float size;
  if (aSeed.z < 0.5) {
    // blinking: long dark gaps, soft 1 s glows
    float b = sin(t * (0.8 + sp * 0.9) + ph * 11.0);
    float blink = smoothstep(0.35, 1.0, b);
    a = blink * smoothstep(0.35, 0.8, uNight) * aOn;
    size = aSeed.w * 0.16;
  } else {
    vec3 V = normalize(p - uCam);
    vSun = pow(max(dot(V, uSunDir), 0.0), 3.0);
    a = (0.25 + 1.6 * vSun) * (1.0 - smoothstep(0.2, 0.6, uNight)) * aOn;
    size = aSeed.w * 0.035;
  }
  vA = a * edge;
  gl_PointSize = clamp(size * uResolution.y / max(dist, 0.1), 1.2, 48.0);
  if (vA < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */`
uniform vec3 uFire;
uniform vec3 uPollen;
uniform vec3 uSunColor;
varying float vA;
varying float vKind;
varying float vSun;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  vec3 col;
  float a;
  if (vKind < 0.5) {
    float core = exp(-r2 * 9.0), halo = exp(-r2 * 2.5) * 0.35;
    col = uFire * (core * 5.0 + halo * 1.2) + vec3(1.0, 1.0, 0.85) * core * core * 2.0;
    a = vA;
  } else {
    float core = exp(-r2 * 5.0);
    col = mix(uPollen, uSunColor * 1.4, vSun) * core * 0.9;
    a = vA;
  }
  gl_FragColor = vec4(col * a, 1.0);
}`;

export class Motes {
  constructor(fauna) {
    this.f = fauna;
    const q = fauna.q || {};
    const scale = Math.max(0.25, Math.min(1.5, q.particleScale ?? 1));
    const art = fauna.body.art || {};
    const glowWorld = (art.flora === 'bioluminescent') || ['bladerunner', 'rogerdean', 'nms', 'crystal', 'nausicaa', 'rickmorty'].includes(art.key);
    this.count = Math.round(520 * scale);
    this.radius = 46;
    this.origin = new Float64Array(3);
    this.visible = false;
    const pos = new Float32Array(this.count * 3);
    const seed = new Float32Array(this.count * 4);
    const on = new Float32Array(this.count);
    const bs = fauna.body.seed | 0;
    for (let i = 0; i < this.count; i++) {
      const kind = i % 5 < 2 ? 1 : 0;       // 60 % fireflies, 40 % pollen
      seed[i * 4] = hash01(bs + i * 7);
      seed[i * 4 + 1] = 0.5 + hash01(bs + i * 13) * 1.0;
      seed[i * 4 + 2] = kind;
      seed[i * 4 + 3] = 0.6 + hash01(bs + i * 17) * 0.8;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geo.setAttribute('aOn', new THREE.BufferAttribute(on, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geo = geo;
    const pal = art.palette || {};
    const fire = new THREE.Color(glowWorld && pal.flora?.length ? pal.flora[0] : '#c8ff5a');
    if (!glowWorld) fire.lerp(new THREE.Color('#ffd45a'), 0.35);
    const hsl = {}; fire.getHSL(hsl, THREE.SRGBColorSpace); fire.setHSL(hsl.h, Math.max(0.7, hsl.s), 0.55, THREE.SRGBColorSpace);
    this.uniforms = {
      uTime: G.uTime, uNight: G.uNight, uResolution: G.uResolution, uSunDir: G.uSunDir, uSunColor: G.uSunColor,
      uWind: { value: new THREE.Vector3(0.6, 0.05, 0.3) },
      uRadius: { value: this.radius },
      uCam: { value: new THREE.Vector3() },
      uFire: { value: fire },
      uPollen: { value: new THREE.Color(pal.sand || '#fff2d0').lerp(new THREE.Color('#ffffff'), 0.5).multiplyScalar(0.5) },
    };
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.name = 'fauna:motes';
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.matrixAutoUpdate = false;
    fauna.world.root.add(this.points);
    this._seated = false;
    this._last = new Float64Array(3);
  }

  /** (re)place particles outside the radius around the player onto the ground */
  _seat(all) {
    const f = this.f, P = f.playerPos, R = this.radius;
    const pos = this.geo.attributes.position.array, on = this.geo.attributes.aOn.array, seed = this.geo.attributes.aSeed.array;
    const O = this.origin;
    if (all) { O[0] = P[0]; O[1] = P[1]; O[2] = P[2]; }
    const l = Math.hypot(P[0], P[1], P[2]) || 1;
    const ux = P[0] / l, uy = P[1] / l, uz = P[2] / l;
    let ex = uz, ey = 0, ez = -ux; const el = Math.hypot(ex, ey, ez) || 1; ex /= el; ey /= el; ez /= el;
    const nx = uy * ez - uz * ey, ny = uz * ex - ux * ez, nz = ux * ey - uy * ex;
    let changed = 0;
    for (let i = 0; i < this.count; i++) {
      const x = pos[i * 3] + O[0], y = pos[i * 3 + 1] + O[1], z = pos[i * 3 + 2] + O[2];
      if (!all && Math.hypot(x - P[0], y - P[1], z - P[2]) < R * 1.05) continue;
      // new spot: random in the disc, biased to the ring ahead when re-seating
      const k = (f.frame * 131 + i * 7) | 0;
      const a = hash01(k) * Math.PI * 2, r = Math.sqrt(all ? hash01(k + 3) : 0.55 + 0.45 * hash01(k + 3)) * R * 0.98;
      const px = P[0] + (ex * Math.cos(a) + nx * Math.sin(a)) * r, py = P[1] + (ey * Math.cos(a) + ny * Math.sin(a)) * r, pz = P[2] + (ez * Math.cos(a) + nz * Math.sin(a)) * r;
      const pl = Math.hypot(px, py, pz);
      const h = f.surface.height(px / pl, py / pl, pz / pl);
      const kind = seed[i * 4 + 2];
      const lift = kind < 0.5 ? 0.4 + hash01(k + 5) * 2.2 : 0.6 + hash01(k + 5) * 7;
      const wet = h < f.sea + 0.2;
      on[i] = wet && kind < 0.5 ? 0 : 1;
      const rr = f.R + Math.max(h, f.sea) + lift;
      pos[i * 3] = px / pl * rr - O[0]; pos[i * 3 + 1] = py / pl * rr - O[1]; pos[i * 3 + 2] = pz / pl * rr - O[2];
      changed++;
    }
    if (changed) { this.geo.attributes.position.needsUpdate = true; this.geo.attributes.aOn.needsUpdate = true; }
  }

  update() {
    const f = this.f, P = f.playerPos;
    const l = Math.hypot(P[0], P[1], P[2]);
    const alt = l - f.R - Math.max(f.sea, f.surface.height(P[0] / l, P[1] / l, P[2] / l));
    this.visible = alt < 60;
    this.points.visible = this.visible;
    if (!this.visible) return;
    const O = this.origin;
    if (!this._seated || Math.hypot(P[0] - O[0], P[1] - O[1], P[2] - O[2]) > 800) { this._seat(true); this._seated = true; this._last.set(P); return; }
    if (Math.hypot(P[0] - this._last[0], P[1] - this._last[1], P[2] - this._last[2]) > 6) { this._seat(false); this._last.set(P); }
  }

  lateUpdate() {
    if (!this.visible) return;
    const w = this.f.world, O = this.origin;
    // particle origin in scene space: planet-local origin minus the floating origin (root is at -origin)
    this.points.position.set(O[0], O[1], O[2]);
    this.points.updateMatrix();
    this.points.updateMatrixWorld(true);
    const c = w.camera.position;
    this.uniforms.uCam.value.set(c.x - O[0], c.y - O[1], c.z - O[2]);
    const wd = G.uWindDir?.value, ws = G.uWindStrength?.value ?? 0.4;
    if (wd) this.uniforms.uWind.value.copy(wd).multiplyScalar(0.4 + ws * 1.6);
  }

  getState() { return { count: this.count, visible: this.visible }; }

  dispose() {
    this.points.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
