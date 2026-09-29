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
    float blink = 0.15 + 0.85 * smoothstep(0.05, 0.9, b);
    a = blink * smoothstep(0.35, 0.8, uNight) * aOn;
    size = aSeed.w * 0.42;
  } else {
    vec3 V = normalize(p - uCam);
    vSun = pow(max(dot(V, uSunDir), 0.0), 3.0);
    a = (0.25 + 1.6 * vSun) * (1.0 - smoothstep(0.2, 0.6, uNight)) * aOn;
    size = aSeed.w * 0.035;
  }
  vA = a * edge;
  gl_PointSize = clamp(size * uResolution.y / max(dist, 0.1), aSeed.z < 0.5 ? 3.0 : 1.2, 64.0);
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
    float core = exp(-r2 * 22.0), halo = exp(-r2 * 4.0);
    col = uFire * (core * 9.0 + halo * 1.1) + vec3(1.0, 1.0, 0.85) * core * core * 4.0;
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

// ------------------------------------------------------------------------------------------------
// Splashes: droplet sprays + surface foam when fish breach / re-enter the water (and anything else
// that calls burst()). A fixed ring buffer of point sprites, one draw call; each particle's
// ballistic path is evaluated in the vertex shader from (spawn pos, velocity, spawn time) so the
// CPU only writes the few particles of a new burst.
const SPLASH_VERT = /* glsl */`
attribute vec4 aVel;       // velocity (m/s), kind (0 droplet, 1 foam)
attribute vec4 aBirth;     // spawn time, life, size, seed
uniform float uTime;
uniform vec3 uCenter;      // planet centre, relative to the particle origin
uniform vec2 uResolution;
uniform vec3 uSunDir;
varying float vA;
varying float vKind;
varying float vLit;
void main(){
  float age = uTime - aBirth.x;
  float life = aBirth.y;
  vec3 up = normalize(position - uCenter);
  vec3 p = position;
  float k = clamp(age / life, 0.0, 1.0);
  if (aVel.w < 0.5) {
    p += aVel.xyz * age - up * 4.9 * age * age;
  } else {
    // foam: slides outward on the surface, decelerating
    p += aVel.xyz * (1.0 - exp(-age * 2.2)) / 2.2;
  }
  vKind = aVel.w;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float alive = step(0.0, age) * step(age, life);
  // droplets must not fall far below their spawn level (they hit the water)
  float below = dot(p - position, up);
  alive *= step(-0.25, below + 0.25 * aVel.w);
  vA = alive * (aVel.w < 0.5 ? (1.0 - k * k) : (1.0 - k) * 0.8);
  vLit = 0.55 + 0.45 * max(dot(up, uSunDir), 0.0);
  float size = aBirth.z * (aVel.w < 0.5 ? (1.0 - 0.4 * k) : (0.7 + 0.8 * k));
  gl_PointSize = clamp(size * uResolution.y / max(-mv.z, 0.1), 1.5, 48.0);
  if (vA < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const SPLASH_FRAG = /* glsl */`
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbient;
varying float vA;
varying float vKind;
varying float vLit;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float a = (vKind < 0.5 ? smoothstep(1.0, 0.35, r2) : smoothstep(1.0, 0.0, r2) * 0.45) * vA;
  vec3 light = uSunColor * min(uSunIntensity, 4.0) * 0.25 * vLit + uAmbient * 1.6 + 0.02;
  vec3 col = vec3(0.92, 0.96, 1.0) * light;
  gl_FragColor = vec4(col * a, a);
}`;

export class Splashes {
  constructor(fauna, count = 960) {
    this.f = fauna;
    const q = fauna.q || {};
    this.count = Math.round(count * Math.max(0.4, Math.min(1.2, q.particleScale ?? 1)));
    this.head = 0;
    this.origin = new Float64Array(3);
    this.hasOrigin = false;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.count * 3), 3));
    geo.setAttribute('aVel', new THREE.BufferAttribute(new Float32Array(this.count * 4), 4));
    const birth = new Float32Array(this.count * 4);
    for (let i = 0; i < this.count; i++) { birth[i * 4] = -1e6; birth[i * 4 + 1] = 1; }
    geo.setAttribute('aBirth', new THREE.BufferAttribute(birth, 4));
    for (const k of ['position', 'aVel', 'aBirth']) geo.attributes[k].setUsage(THREE.DynamicDrawUsage);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geo = geo;
    this.uniforms = {
      uTime: G.uTime, uResolution: G.uResolution, uSunDir: G.uSunDir, uSunColor: G.uSunColor,
      uSunIntensity: G.uSunIntensity ?? { value: 1 },
      uAmbient: G.uAmbientSky ?? { value: new THREE.Color(0.3, 0.35, 0.4) },
      uCenter: { value: new THREE.Vector3() },
    };
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SPLASH_VERT, fragmentShader: SPLASH_FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.name = 'fauna:splashes';
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.points.matrixAutoUpdate = false;
    this.points.visible = false;
    this.lastBurst = -1e9;
    fauna.world.root.add(this.points);
    this._dirtyLo = Infinity; this._dirtyHi = -1;
    this._seed = 1;
  }

  _rnd() { this._seed = (this._seed * 16807) % 2147483647; return this._seed / 2147483647; }

  /** planet-local position p (surface point), unit up, size k (~ body length in m), now = sim time */
  burst(p, up, k, now) {
    const O = this.origin;
    if (!this.hasOrigin || Math.hypot(p[0] - O[0], p[1] - O[1], p[2] - O[2]) > 1500) {
      O[0] = p[0]; O[1] = p[1]; O[2] = p[2]; this.hasOrigin = true;
      // invalidate old particles (their positions were relative to the old origin)
      const b = this.geo.attributes.aBirth.array;
      for (let i = 0; i < this.count; i++) b[i * 4] = -1e6;
      this._dirtyLo = 0; this._dirtyHi = this.count - 1;
    }
    const pos = this.geo.attributes.position.array, vel = this.geo.attributes.aVel.array, birth = this.geo.attributes.aBirth.array;
    // tangent basis
    let ex = up[1] * 0 - up[2] * 1, ey = up[2] * 0 - up[0] * 0, ez = up[0] * 1 - up[1] * 0;
    if (Math.hypot(ex, ey, ez) < 0.1) { ex = 0; ey = up[2]; ez = -up[1]; }
    const el = Math.hypot(ex, ey, ez); ex /= el; ey /= el; ez /= el;
    const nx = up[1] * ez - up[2] * ey, ny = up[2] * ex - up[0] * ez, nz = up[0] * ey - up[1] * ex;
    const nDrop = Math.round(14 + 26 * Math.min(2, k)), nFoam = Math.round(14 + 18 * Math.min(2, k));
    const vUp = 1.8 + 2.4 * Math.sqrt(k);
    for (let j = 0; j < nDrop + nFoam; j++) {
      const i = this.head; this.head = (this.head + 1) % this.count;
      const foam = j >= nDrop;
      const a = this._rnd() * Math.PI * 2, rr = this._rnd();
      const ca = Math.cos(a), sa = Math.sin(a);
      const r0 = (foam ? 0.15 : 0.05) * k * Math.sqrt(rr);
      pos[i * 3] = p[0] - O[0] + (ex * ca + nx * sa) * r0 + up[0] * 0.03;
      pos[i * 3 + 1] = p[1] - O[1] + (ey * ca + ny * sa) * r0 + up[1] * 0.03;
      pos[i * 3 + 2] = p[2] - O[2] + (ez * ca + nz * sa) * r0 + up[2] * 0.03;
      const hs = foam ? (0.4 + 0.9 * this._rnd()) * (0.6 + k) : (0.4 + 1.3 * this._rnd()) * (0.5 + 0.6 * k);
      const vs = foam ? 0 : vUp * (0.45 + 0.75 * this._rnd());
      vel[i * 4] = (ex * ca + nx * sa) * hs + up[0] * vs;
      vel[i * 4 + 1] = (ey * ca + ny * sa) * hs + up[1] * vs;
      vel[i * 4 + 2] = (ez * ca + nz * sa) * hs + up[2] * vs;
      vel[i * 4 + 3] = foam ? 1 : 0;
      birth[i * 4] = now + this._rnd() * 0.06;
      birth[i * 4 + 1] = foam ? 1.4 + this._rnd() * 1.2 : 0.7 + this._rnd() * 0.6;
      birth[i * 4 + 2] = foam ? 0.05 + 0.06 * k * this._rnd() : 0.022 + 0.035 * this._rnd() * (0.6 + k * 0.5);
      birth[i * 4 + 3] = this._rnd();
      if (i < this._dirtyLo) this._dirtyLo = i;
      if (i > this._dirtyHi) this._dirtyHi = i;
      if (this.head === 0) { this._dirtyLo = 0; this._dirtyHi = this.count - 1; }
    }
    this.lastBurst = now;
  }

  lateUpdate(now) {
    const vis = now - this.lastBurst < 3.5 && this.hasOrigin;
    this.points.visible = vis;
    if (!vis) return;
    if (this._dirtyHi >= 0) {
      for (const k of ['position', 'aVel', 'aBirth']) {
        const a = this.geo.attributes[k];
        a.clearUpdateRanges?.();
        const it = a.itemSize;
        a.addUpdateRange?.(this._dirtyLo * it, (this._dirtyHi - this._dirtyLo + 1) * it);
        a.needsUpdate = true;
      }
      this._dirtyLo = Infinity; this._dirtyHi = -1;
    }
    const O = this.origin;
    this.points.position.set(O[0], O[1], O[2]);
    this.points.updateMatrix();
    this.points.updateMatrixWorld(true);
    this.uniforms.uCenter.value.set(-O[0], -O[1], -O[2]);
  }

  dispose() {
    this.points.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
