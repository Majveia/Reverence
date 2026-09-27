// Light/energy effects attached to a vehicle (all additive, HDR → bloom):
//   SpriteBatch  camera-facing halos (nozzles, head/tail lights, nav strobes) in ONE draw call,
//                per-sprite channel intensities like the glow material
//   makeFlame    exhaust plume cone: scrolling noise, shock diamonds, soft fresnel edges
//   makeBeam     volumetric headlight cone (soft, view-dependent)
//   makePool     radial light pool quad laid on the ground (repulsor / headlight / thruster wash)
import * as THREE from 'three';

// ------------------------------------------------------------------ sprites
const SPR_VERT = /* glsl */`
attribute vec2 corner;
attribute vec3 aCenter;
attribute vec4 aColor;   // rgb (HDR), channel
attribute vec2 aSize;    // size (m), stretch along object +Z (0 = round)
uniform float uCh[8];
varying vec2 vUv;
varying vec3 vCol;
varying float vK;
void main(){
  int ci = int(aColor.w + 0.5);
  float k = ci == 0 ? uCh[0] : ci == 1 ? uCh[1] : ci == 2 ? uCh[2] : ci == 3 ? uCh[3] : ci == 4 ? uCh[4] : ci == 5 ? uCh[5] : ci == 6 ? uCh[6] : uCh[7];
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  float s = aSize.x * (0.55 + 0.45 * clamp(k, 0.0, 2.0));
  // pull toward the camera so halos are not clipped by the emitting geometry
  vec3 toCam = normalize(-mv.xyz);
  mv.xyz += toCam * min(s * 0.6, 1.5);
  vec2 off = corner * s;
  if (aSize.y > 0.0) {
    vec3 ax = normalize(mat3(modelViewMatrix) * vec3(0.0, 0.0, 1.0));
    vec2 d = ax.xy; float l = length(d);
    if (l > 0.05) { d /= l; vec2 n = vec2(-d.y, d.x); off = d * corner.x * s * (1.0 + aSize.y * l) + n * corner.y * s; }
  }
  mv.xy += off;
  vUv = corner; vCol = aColor.rgb; vK = k;
  gl_Position = projectionMatrix * mv;
}`;
const SPR_FRAG = /* glsl */`
varying vec2 vUv;
varying vec3 vCol;
varying float vK;
void main(){
  float r = length(vUv);
  if (r > 1.0 || vK <= 0.001) discard;
  float core = exp(-r * r * 18.0);
  float halo = exp(-r * 4.2) * (1.0 - r);
  // faint anamorphic streak
  float streak = exp(-abs(vUv.y) * 40.0) * (1.0 - abs(vUv.x)) * 0.35;
  vec3 c = vCol * vK * (core * 2.2 + halo * 0.55 + streak);
  gl_FragColor = vec4(c, 0.0);
}`;

export class SpriteBatch {
  constructor() { this.items = []; }
  add(center, rgb, size, channel = 0, stretch = 0) { this.items.push({ center, rgb, size, channel, stretch }); return this; }
  build() {
    const n = this.items.length;
    if (!n) return null;
    const corner = [], cen = [], col = [], siz = [], idx = [];
    const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    this.items.forEach((it, k) => {
      for (const c of C) {
        corner.push(c[0], c[1]); cen.push(it.center[0], it.center[1], it.center[2]);
        col.push(it.rgb[0], it.rgb[1], it.rgb[2], it.channel); siz.push(it.size, it.stretch);
      }
      const b = k * 4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cen, 3));
    g.setAttribute('corner', new THREE.Float32BufferAttribute(corner, 2));
    g.setAttribute('aCenter', new THREE.Float32BufferAttribute(cen, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 4));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(siz, 2));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);
    const ch = new Float32Array(8).fill(1);
    const mat = new THREE.ShaderMaterial({
      vertexShader: SPR_VERT, fragmentShader: SPR_FRAG, uniforms: { uCh: { value: ch } },
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;
    mesh.userData.ch = ch;
    return mesh;
  }
}

// ------------------------------------------------------------------ exhaust flame
const FLAME_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main(){
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const FLAME_FRAG = /* glsl */`
#include <rv_common>
#include <rv_noise>
uniform float uTime;
uniform float uPower;
uniform vec3 uCore;
uniform vec3 uOuter;
uniform float uDiamonds;
uniform float uSeed;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main(){
  float along = vUv.y;               // 0 at nozzle → 1 at tip
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float soft = pow(facing, 1.6);
  float n = rv_snoise(vec3(vUv.x * 6.0, along * 5.0 - uTime * 9.0, uSeed)) * 0.5 + 0.5;
  float n2 = rv_snoise(vec3(vUv.x * 13.0 + 3.0, along * 11.0 - uTime * 17.0, uSeed + 4.0)) * 0.5 + 0.5;
  float fall = pow(1.0 - along, 1.4);
  float diamonds = 1.0 + uDiamonds * 0.6 * pow(0.5 + 0.5 * cos(along * 38.0 - uTime * 2.0), 6.0) * (1.0 - along);
  float dens = fall * (0.55 + 0.45 * n) * (0.8 + 0.2 * n2) * diamonds;
  vec3 col = mix(uOuter, uCore, pow(fall, 2.2) * soft);
  float a = dens * soft * uPower;
  gl_FragColor = vec4(col * a, 0.0);
}`;

/** Cone along -Z of length 1 and base radius 1 (scale the mesh). */
export function makeFlame({ core = [2.5, 2.2, 3.5], outer = [0.2, 0.5, 2.0], diamonds = 1, seed = 1, radial = 16 } = {}, time) {
  const geo = new THREE.CylinderGeometry(0.35, 1.0, 1, radial, 12, true);
  geo.rotateX(-Math.PI / 2); // Y → -Z: cylinder top (y=+.5) → z=-0.5
  geo.translate(0, 0, -0.5);
  // uv.y: 0 at nozzle (z = 0) → 1 at tip (z = -1)
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setY(i, Math.min(1, Math.max(0, -p.getZ(i))));
  const mat = new THREE.ShaderMaterial({
    vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
    uniforms: {
      uTime: time, uPower: { value: 1 }, uCore: { value: new THREE.Color(...core) }, uOuter: { value: new THREE.Color(...outer) },
      uDiamonds: { value: diamonds }, uSeed: { value: seed },
    },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = 7;
  return m;
}

// ------------------------------------------------------------------ headlight beam
const BEAM_FRAG = /* glsl */`
#include <rv_common>
uniform float uPower;
uniform vec3 uColor;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main(){
  float along = vUv.y;
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float a = pow(facing, 2.5) * pow(1.0 - along, 2.2) * smoothstep(0.0, 0.08, along) * uPower;
  a *= 0.92 + 0.08 * rv_ign(gl_FragCoord.xy);
  gl_FragColor = vec4(uColor * a, 0.0);
}`;
export function makeBeam({ length = 14, radius = 3.2, color = [1.0, 0.92, 0.78] } = {}) {
  const geo = new THREE.CylinderGeometry(0.12, radius, length, 20, 8, true);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, length / 2);           // from origin toward +Z
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setY(i, Math.min(1, Math.max(0, p.getZ(i) / length)));
  const mat = new THREE.ShaderMaterial({
    vertexShader: FLAME_VERT, fragmentShader: BEAM_FRAG,
    uniforms: { uPower: { value: 0 }, uColor: { value: new THREE.Color(...color) } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = 6;
  return m;
}

// ------------------------------------------------------------------ ground light pool
const POOL_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const POOL_FRAG = /* glsl */`
#include <rv_common>
uniform float uPower;
uniform vec3 uColor;
uniform vec2 uShape; // x: forward elongation, y: forward offset (headlight pools)
varying vec2 vUv;
void main(){
  vec2 p = vUv;
  p.y = (p.y - uShape.y) / max(uShape.x, 1e-3);
  float r = length(p);
  float a = exp(-r * r * 3.2) * (1.0 - smoothstep(0.85, 1.0, length(vUv)));
  a *= uPower * (0.94 + 0.06 * rv_ign(gl_FragCoord.xy));
  gl_FragColor = vec4(uColor * a, 0.0);
}`;
/** Quad in the XZ plane (normal +Y), size×size. */
export function makePool({ size = 4, color = [0.4, 0.9, 1.6], shape = [1, 0] } = {}) {
  const geo = new THREE.PlaneGeometry(size, size);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
    uniforms: { uPower: { value: 0 }, uColor: { value: new THREE.Color(...color) }, uShape: { value: new THREE.Vector2(...shape) } },
    transparent: true, depthWrite: false, blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: 0,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = 3;
  return m;
}
