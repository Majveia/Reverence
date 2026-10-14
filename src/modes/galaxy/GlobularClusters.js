// GlobularClusters — the galaxy's globular-cluster system (GalaxyModel.globularClusters: 70–420 old,
// compact clusters in a roughly spherical, centrally concentrated halo). Each is drawn as one compact,
// golden point source (Plummer core ≈ the PSF at galaxy scale, a resolved fuzzy ball up close) with a
// log-normal luminosity function — the swarm of faint points around every Hubble elliptical (M87).
// Halo objects barely rotate (follow = 2 in GalaxyModel → angle = pattern × 0.08). One draw call.
import * as THREE from 'three';
import { globularClusters } from '../../universe/GalaxyModel.js';
import { hash32, hashCombine } from '../../core/rng.js';

const VERT = /* glsl */ `
attribute vec2 aGc;            // x = luminosity weight, y = half-light radius (kly)
uniform float uPat, uGain, uPixScale, uMaxSize;
varying float vFlux, vCore, vSize;
void main(){
  float a = uPat * 0.08;
  float c = cos(a), s = sin(a);
  vec3 p = vec3(position.x * c - position.z * s, position.y, position.x * s + position.z * c);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, 1e-6);
  // apparent core radius in px (≥ the PSF), flux ∝ L / d²
  float core = max(0.75, aGc.y / d * uPixScale);
  float flux = aGc.x * uGain / (d * d) * uPixScale * uPixScale;
  flux *= smoothstep(0.3, 2.0, d);              // up close the real cluster stars (LOD) take over
  if (flux < 0.004 || mv.z > 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float size = clamp(core * 7.0, 4.0, uMaxSize);
  gl_PointSize = size;
  vFlux = flux; vCore = core; vSize = size;
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
varying float vFlux, vCore, vSize;
void main(){
  vec2 q = (gl_PointCoord - 0.5) * vSize;
  float r2 = dot(q, q) / (vCore * vCore);
  // Plummer surface brightness (1 + r²/a²)^-2, normalised to unit flux
  float I = 1.0 / (3.14159265 * vCore * vCore * (1.0 + r2) * (1.0 + r2));
  float edge = 1.0 - smoothstep(0.42, 0.5, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(uColor * vFlux * I * edge, 1.0);
}`;

export class GlobularClusters {
  constructor(engine, galaxy, { maxPointSize = 64 } = {}) {
    const list = globularClusters(galaxy) || [];
    const n = list.length;
    const pos = new Float32Array(n * 3), gc = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const g = list[i];
      pos[i * 3] = g.x / 1000; pos[i * 3 + 1] = g.y / 1000; pos[i * 3 + 2] = g.z / 1000;
      // log-normal luminosity function (σ ≈ 0.5 dex), deterministic
      const u1 = Math.max(1e-6, (hash32(hashCombine(galaxy.seed, 0x6c00 + i)) >>> 0) / 4294967296);
      const u2 = (hash32(hashCombine(galaxy.seed, 0x6d00 + i)) >>> 0) / 4294967296;
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      gc[i * 2] = Math.pow(10, 0.5 * z);
      gc[i * 2 + 1] = (g.a || 15) / 1000;           // half-light radius (ly → kly)
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aGc', new THREE.BufferAttribute(gc, 2));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uPat: { value: 0 }, uGain: { value: 1 }, uPixScale: { value: 500 }, uMaxSize: { value: Math.min(64, maxPointSize) },
        uColor: { value: new THREE.Vector3(1.0, 0.8, 0.55) },
      },
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.engine = engine;
    this.count = n;
  }

  /** gain: flux scale (calibrated against the galaxy's diffuse light by the mode). */
  update(camera, pat, gain) {
    const u = this.mat.uniforms;
    u.uPat.value = pat;
    u.uGain.value = gain;
    u.uPixScale.value = this.engine.pipeline.height / (2 * Math.tan(camera.fov * Math.PI / 360));
    this.points.visible = gain > 0 && this.count > 0;
  }

  dispose() { this.points.geometry.dispose(); this.mat.dispose(); }
}
