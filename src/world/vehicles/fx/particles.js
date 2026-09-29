// GPU-instanced billboard particles simulated on the CPU (small counts, zero per-frame allocation).
// Positions are planet-local float64 on the CPU and re-anchored near the camera before upload,
// so there is no float32 jitter far from the planet origin. Lit "sphere-impostor" smoke puffs
// (sun wrap lighting + sky ambient) or additive stretched sparks.
import * as THREE from 'three';
import { G } from '../../../core/Uniforms.js';

const VERT = /* glsl */`
attribute vec2 corner;
attribute vec3 iPos;
attribute vec4 iData;   // size, alpha, rotation, age01
attribute vec4 iColor;  // rgb, seed
attribute vec3 iVel;
attribute float iH;     // height of the particle centre above the ground (m), < -1e3 = no ground fade
uniform float uStretch;
uniform vec3 uUpAnchor;  // planet-local direction of 'up' at the pool anchor
varying float vH;
varying vec2 vUv;
varying vec4 vColor;
varying float vAlpha;
varying float vAge;
varying vec3 vSunV;
varying float vSeed;
uniform vec3 uSunDir;
void main(){
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float size = iData.x;
  vec2 c = corner;
  vec2 off;
  if (uStretch > 0.5) {
    vec3 vv = (modelViewMatrix * vec4(iPos + iVel, 1.0)).xyz - mv.xyz;
    vec2 d = vv.xy;
    float len = length(d);
    vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    off = dir * c.x * (size + len * 0.5) + nrm * c.y * size * 0.18;
    mv.xy += dir * len * 0.25;
  } else {
    float s = sin(iData.z), co = cos(iData.z);
    off = vec2(c.x * co - c.y * s, c.x * s + c.y * co) * size;
  }
  mv.xy += off;
  // height of this billboard corner above the ground plane → soft contact instead of a hard cut
  vec3 upV = normalize(mat3(viewMatrix) * uUpAnchor);
  vH = iH < -1000.0 ? 1e4 : iH + dot(vec3(off, 0.0), upV);
  // keep particles from swallowing the camera
  float dz = -mv.z;
  vAlpha = iData.y * smoothstep(0.25, 1.6, dz);
  vUv = corner;
  vColor = iColor;
  vAge = iData.w;
  vSeed = iColor.w;
  vSunV = normalize(mat3(viewMatrix) * uSunDir);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
#include <rv_common>
uniform vec3 uSunCol;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform float uLit;
uniform float uAdditive;
varying vec2 vUv;
varying vec4 vColor;
varying float vAlpha;
varying float vAge;
varying vec3 vSunV;
varying float vSeed;
varying float vH;
float pvn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  float a = rv_hash12(i), b = rv_hash12(i + vec2(1,0)), c = rv_hash12(i + vec2(0,1)), d = rv_hash12(i + vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
void main(){
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  vec3 col;
  float a;
  if (uAdditive > 0.5) {
    float core = exp(-r2 * 4.0);
    col = vColor.rgb * core;
    a = core * vAlpha;
    gl_FragColor = vec4(col * vAlpha, 0.0); // blended One/One
    return;
  }
  // fluffy puff: radial falloff eroded by noise, erosion grows with age
  vec2 q = vUv * 1.6 + vSeed * 17.0;
  float n = pvn(q * 1.3) * 0.6 + pvn(q * 3.1 + 5.0) * 0.4;
  float edge = 1.0 - r2;
  float dens = smoothstep(0.0, 0.55 + vAge * 0.3, edge * (0.55 + n * 0.9) - vAge * 0.25);
  a = dens * vAlpha * smoothstep(-0.05, 0.6, vH);
  if (a < 0.003) discard;
  // sphere impostor lighting
  vec3 nrm = normalize(vec3(vUv, sqrt(max(0.0, 1.0 - r2)) + 0.35));
  float lam = clamp(dot(nrm, vSunV) * 0.55 + 0.45, 0.0, 1.0);
  float up = nrm.y * 0.5 + 0.5;
  vec3 amb = mix(uAmbGround, uAmbSky, up);
  vec3 light = mix(vec3(1.0), uSunCol * lam * 0.33 + amb * 1.1 + 0.02, uLit);
  // forward scattering glow when looking toward the sun through the dust
  float fwd = pow(max(0.0, -vSunV.z), 6.0);
  col = vColor.rgb * (light + uSunCol * fwd * 0.12 * uLit);
  gl_FragColor = vec4(col * a, a); // premultiplied
}`;

export class Particles {
  constructor(world, { max = 256, additive = false, stretch = false, lit = true, name = 'particles', renderOrder = 5 } = {}) {
    this.world = world;
    this.max = max;
    this.count = 0;
    // SoA state (float64 positions)
    this.px = new Float64Array(max); this.py = new Float64Array(max); this.pz = new Float64Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max); this.vz = new Float32Array(max);
    this.age = new Float32Array(max); this.life = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max); this.rot = new Float32Array(max); this.rs = new Float32Array(max);
    this.cr = new Float32Array(max); this.cg = new Float32Array(max); this.cb = new Float32Array(max);
    this.seed = new Float32Array(max);
    this.drag = new Float32Array(max); this.grav = new Float32Array(max);
    this.order = new Uint16Array(max); this.depth = new Float32Array(max);
    this.gr = new Float64Array(max);   // ground radius under the particle (0 = none)

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aH = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iH', this.aH);
    geo.setAttribute('iPos', this.aPos); geo.setAttribute('iData', this.aData); geo.setAttribute('iColor', this.aColor); geo.setAttribute('iVel', this.aVel);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uStretch: { value: stretch ? 1 : 0 }, uLit: { value: lit ? 1 : 0 }, uAdditive: { value: additive ? 1 : 0 },
        uUpAnchor: { value: new THREE.Vector3(0, 1, 0) },
        uSunDir: G.uSunDir, uSunCol: G.uSunColor, uAmbSky: G.uAmbientSky, uAmbGround: G.uAmbientGround,
      },
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
    });
    this.mat.blendEquation = THREE.AddEquation;
    this.mat.blendSrc = THREE.OneFactor;
    this.mat.blendDst = additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
    this.mat.blendSrcAlpha = THREE.OneFactor;
    this.mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = name;
    this.anchor = new THREE.Vector3();
    this.mesh.position.copy(this.anchor);
    world.root.add(this.mesh);
    this.sorted = !additive;
    this._cam = new THREE.Vector3();
    this._cmp = (a, b) => this.depth[b] - this.depth[a];
  }

  /** Spawn one particle. o: {life, size0, size1, alpha, color (THREE.Color), rot, rotSpeed, drag, grav,
   *  ground (planet-local radius of the ground under it → soft fade where the puff meets the ground)} */
  spawn(x, y, z, vx, vy, vz, o) {
    let i;
    if (this.count < this.max) i = this.count++;
    else {
      // recycle the oldest (highest age/life)
      let best = 0, bv = -1;
      for (let k = 0; k < this.count; k += 3) { const v = this.age[k] / this.life[k]; if (v > bv) { bv = v; best = k; } }
      i = best;
    }
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = o.life ?? 1;
    this.s0[i] = o.size0 ?? 0.5; this.s1[i] = o.size1 ?? 1.5;
    this.a0[i] = o.alpha ?? 1;
    this.rot[i] = o.rot ?? 0; this.rs[i] = o.rotSpeed ?? 0;
    const c = o.color;
    this.cr[i] = c ? c.r : 1; this.cg[i] = c ? c.g : 1; this.cb[i] = c ? c.b : 1;
    this.seed[i] = o.seed ?? ((i * 0.618034) % 1);
    this.drag[i] = o.drag ?? 1.5; this.grav[i] = o.grav ?? 0;
    this.gr[i] = o.ground ?? 0;
    return i;
  }

  update(dt) {
    const w = this.world, cam = w.camera;
    this._cam.copy(cam.position);
    // re-anchor near the camera (precision)
    if (this._cam.distanceToSquared(this.anchor) > 250000) { this.anchor.copy(this._cam); this.mesh.position.copy(this.anchor); }
    let n = this.count;
    // integrate + kill
    for (let i = 0; i < n; i++) {
      const a = this.age[i] + dt;
      if (a >= this.life[i]) {
        n--;
        if (i !== n) this._move(n, i);
        i--;
        continue;
      }
      this.age[i] = a;
      const k = Math.exp(-this.drag[i] * dt);
      let vx = this.vx[i] * k, vy = this.vy[i] * k, vz = this.vz[i] * k;
      const g = this.grav[i];
      if (g !== 0) {
        // gravity (positive g = falls) / buoyancy (negative) along local radial up
        const px = this.px[i], py = this.py[i], pz = this.pz[i];
        const l = Math.sqrt(px * px + py * py + pz * pz) || 1;
        vx -= (px / l) * g * dt; vy -= (py / l) * g * dt; vz -= (pz / l) * g * dt;
      }
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      this.px[i] += vx * dt; this.py[i] += vy * dt; this.pz[i] += vz * dt;
      this.rot[i] += this.rs[i] * dt;
    }
    this.count = n;
    this._upload();
  }

  _move(from, to) {
    const arrs = [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.age, this.life, this.s0, this.s1, this.a0, this.rot, this.rs, this.cr, this.cg, this.cb, this.seed, this.drag, this.grav, this.gr];
    for (const a of arrs) a[to] = a[from];
  }

  _upload() {
    const n = this.count;
    const ax = this.anchor.x, ay = this.anchor.y, az = this.anchor.z;
    const P = this.aPos.array, D = this.aData.array, C = this.aColor.array, V = this.aVel.array, H = this.aH.array;
    const al = Math.hypot(ax, ay, az) || 1;
    this.mat.uniforms.uUpAnchor.value.set(ax / al, ay / al, az / al);
    const order = this.order;
    if (this.sorted && n > 1) {
      // back-to-front by distance to camera
      const cx = this._cam.x, cy = this._cam.y, cz = this._cam.z;
      for (let i = 0; i < n; i++) {
        const dx = this.px[i] - cx, dy = this.py[i] - cy, dz = this.pz[i] - cz;
        this.depth[i] = dx * dx + dy * dy + dz * dz; order[i] = i;
      }
      order.subarray(0, n).sort(this._cmp);
    } else for (let i = 0; i < n; i++) order[i] = i;
    for (let j = 0; j < n; j++) {
      const i = order[j];
      const t = this.age[i] / this.life[i];
      P[j * 3] = this.px[i] - ax; P[j * 3 + 1] = this.py[i] - ay; P[j * 3 + 2] = this.pz[i] - az;
      const fadeIn = Math.min(1, t * 8);
      const fadeOut = 1 - t;
      D[j * 4] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      D[j * 4 + 1] = this.a0[i] * fadeIn * fadeOut * fadeOut;
      D[j * 4 + 2] = this.rot[i];
      D[j * 4 + 3] = t;
      C[j * 4] = this.cr[i]; C[j * 4 + 1] = this.cg[i]; C[j * 4 + 2] = this.cb[i]; C[j * 4 + 3] = this.seed[i];
      const g = this.gr[i];
      H[j] = g > 0 ? Math.sqrt(this.px[i] * this.px[i] + this.py[i] * this.py[i] + this.pz[i] * this.pz[i]) - g : -1e4;
      V[j * 3] = this.vx[i] * 0.05; V[j * 3 + 1] = this.vy[i] * 0.05; V[j * 3 + 2] = this.vz[i] * 0.05;
    }
    this.geo.instanceCount = n;
    this.aPos.needsUpdate = true; this.aData.needsUpdate = true; this.aColor.needsUpdate = true; this.aVel.needsUpdate = true; this.aH.needsUpdate = true;
  }

  clear() { this.count = 0; this.geo.instanceCount = 0; }
  dispose() { this.mesh.removeFromParent(); this.geo.dispose(); this.mat.dispose(); }
}
