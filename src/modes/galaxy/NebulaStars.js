// NebulaStars — the dense star field of a star-forming region, as JWST / Hubble frame it: thousands of
// point sources behind a nebula (drawn BEFORE the nebula composite, so its transmittance dims them and
// they vanish behind dense dust) plus a sparse foreground set (drawn after it). Camera-centred at
// infinity (no parallax needed at nebula scale), deterministic from the galaxy seed, power-law fluxes,
// blackbody colours and an analytic JWST point-spread function: 6 primary diffraction spikes (hexagonal
// segmented mirror) + 2 faint horizontal ones (secondary-mirror struts). Two instanced draws.
import * as THREE from 'three';
import { RNG, hashCombine } from '../../core/rng.js';

const VERT = /* glsl */ `
attribute vec4 aDir;      // xyz direction, w = flux
attribute vec4 aCol;      // rgb, w = 1 foreground / 0 background
uniform float uFade, uFront;
uniform vec2 uRes;
varying vec2 vQ;
varying vec3 vCol;
varying float vFlux, vHalf;
void main(){
  float F = aDir.w * uFade;
  if (abs(aCol.w - uFront) > 0.5 || F < 2e-3) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 c = projectionMatrix * vec4(mat3(viewMatrix) * normalize(aDir.xyz), 1.0);
  float hs = clamp(3.5 + 7.0 * sqrt(F), 3.5, 72.0);
  c.xy += position.xy * hs / (0.5 * uRes) * c.w;
  c.z = c.w * 0.99999;
  gl_Position = c;
  vQ = position.xy * hs;
  vCol = aCol.rgb;
  vFlux = F;
  vHalf = hs;
}`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vQ;
varying vec3 vCol;
varying float vFlux, vHalf;
float spike(vec2 q, float ang, float len){
  vec2 d = vec2(cos(ang), sin(ang));
  float al = abs(dot(q, d)), ac = dot(q, vec2(-d.y, d.x));
  return exp(-ac * ac * 2.5) * exp(-al / len);
}
void main(){
  vec2 q = vQ;
  float r2 = dot(q, q);
  float core = exp(-r2 / (2.0 * 0.75 * 0.75)) / (6.2831853 * 0.5625);
  float halo = 0.2 / (3.14159265 * 5.0 * (1.0 + r2 / 5.0) * (1.0 + r2 / 5.0));
  float sp = 0.0;
  if (vFlux > 2.0) {
    float len = 1.2 + 3.0 * sqrt(vFlux);
    sp = (spike(q, 1.5708, len) + spike(q, 0.5236, len) + spike(q, 2.618, len)) * 0.011
       + spike(q, 0.0, len * 0.45) * 0.004;
    sp *= smoothstep(2.0, 12.0, vFlux);
  }
  float edge = 1.0 - smoothstep(0.75, 1.0, length(vQ) / vHalf);
  gl_FragColor = vec4(vCol * vFlux * (core + halo + sp) * edge, 1.0);
}`;

function bb(T) {
  const t = T / 100;
  let r = t <= 66 ? 1 : Math.min(1, 1.29 * Math.pow(t - 60, -0.1332));
  let g = t <= 66 ? Math.max(0, Math.min(1, 0.39 * Math.log(t) - 0.632)) : Math.min(1, 1.13 * Math.pow(t - 60, -0.0755));
  let b = t >= 66 ? 1 : t <= 19 ? 0 : Math.max(0, Math.min(1, 0.543 * Math.log(t - 10) - 1.196));
  r **= 2.2; g **= 2.2; b **= 2.2;
  const m = Math.max(r, g, b);
  return [r / m, g / m, b / m];
}

export class NebulaStars {
  constructor(engine, galaxy) {
    const q = engine.quality;
    const n = q.tier === 'low' ? 4000 : q.tier === 'med' ? 8000 : 14000;
    const r = new RNG(hashCombine(galaxy.seed, 0x5ea5));
    const dir = new Float32Array(n * 4), col = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const z = r.range(-1, 1), a = r.range(0, Math.PI * 2), s = Math.sqrt(1 - z * z);
      const F = Math.min(90, 0.5 * Math.pow(Math.max(1e-6, r.next()), -0.7));
      dir.set([s * Math.cos(a), z, s * Math.sin(a), F], i * 4);
      const u = r.next();
      // young region: many hot blue-white stars, a reddened background of K giants
      const T = u < 0.35 ? r.range(3400, 5000) : u < 0.7 ? r.range(5000, 7500) : r.range(7500, 25000);
      const c = bb(T);
      col.set([c[0], c[1], c[2], r.next() < 0.12 ? 1 : 0], i * 4);
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aDir', new THREE.InstancedBufferAttribute(dir, 4));
    g.setAttribute('aCol', new THREE.InstancedBufferAttribute(col, 4));
    g.instanceCount = n;
    this.geometry = g;
    const mk = (front) => new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uFade: { value: 0 }, uFront: { value: front }, uRes: { value: new THREE.Vector2(1280, 720) } },
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.backMat = mk(0);
    this.frontMat = mk(1);
    this.back = new THREE.Mesh(g, this.backMat);
    this.front = new THREE.Mesh(g, this.frontMat);
    for (const m of [this.back, this.front]) m.frustumCulled = false;
    this.back.renderOrder = 4;            // before the nebula composite (5): attenuated by the nebula
    this.front.renderOrder = 6;           // after it
    this.engine = engine;
  }

  /** k: 0..1 visibility (the nearest nebula's fade). */
  update(k) {
    const e = this.engine;
    for (const m of [this.backMat, this.frontMat]) {
      m.uniforms.uFade.value = k;
      m.uniforms.uRes.value.set(e.pipeline.width, e.pipeline.height);
    }
    this.back.visible = this.front.visible = k > 0.002;
  }

  dispose() { this.geometry.dispose(); this.backMat.dispose(); this.frontMat.dispose(); }
}
