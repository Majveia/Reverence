// FaintStars — the unresolved crowd of faint dwarfs around the camera in the stellar neighbourhood.
// Purely procedural on the GPU (not pickable: the real, catalogued LOD stars are in StarField).
// Stars live in a world-anchored 3-D grid of CELL-sized cells (pattern frame) → stable while the
// camera moves; the cube of G³ cells follows the camera. Per-cell counts follow the galaxy's disk
// map (old + young surface density) and a sech² vertical profile, so the crowd thins above the disk
// and thickens in the arms. Luminosities are drawn from a dwarf-dominated distribution (M…G),
// brightness is flux-conserving like the other stars (same gain as the local LOD population).
import * as THREE from 'three';
import '../../shaders/chunks.js';

const VERT = /* glsl */ `
precision highp float;
precision highp int;
#include <rv_color>
uniform sampler2D tMap;
uniform float uMapR, uHOld, uR, uFlare;
uniform vec3 uCamPat;          // camera, pattern frame (kly)
uniform float uPat, uCell, uGain, uLumExp, uPixScale, uWeight, uEps, uPerCell, uDensK;
uniform int uG;
varying vec3 vCol;
varying float vSize;
uint hsh(uint x){ x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
float u01(uint h){ return float(h) * (1.0 / 4294967296.0); }
vec3 rotT(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c); }
void main(){
  int id = gl_VertexID;
  int per = int(uPerCell);
  int cellId = id / per, k = id - cellId * per;
  int G = uG;
  ivec3 o = ivec3(cellId % G, (cellId / G) % G, cellId / (G * G)) - G / 2;
  ivec3 cc = ivec3(floor(uCamPat / uCell)) + o;
  uint h = hsh(uint(cc.x) * 73856093u ^ uint(cc.y) * 19349663u ^ uint(cc.z) * 83492791u ^ uint(k) * 2654435761u);
  vec3 p = (vec3(cc) + vec3(u01(hsh(h + 1u)), u01(hsh(h + 2u)), u01(hsh(h + 3u)))) * uCell;
  // acceptance: disk-map density × vertical profile (thins out of the plane, thickens in arms)
  vec2 uv = p.xz / (2.0 * uMapR) + 0.5;
  vec4 M = (abs(uv.x - 0.5) < 0.5 && abs(uv.y - 0.5) < 0.5) ? textureLod(tMap, uv, 3.0) : vec4(0.0);
  float rm = length(p.xz);
  float hO = uHOld * (1.0 + uFlare * (rm / uR) * (rm / uR));
  float cy = cosh(clamp(p.y / hO, -10.0, 10.0));
  float dens = (M.r * 2.2 + M.g * 1.2) / (cy * cy) * uDensK;
  vec3 rel = p - uCamPat;
  float d = length(rel);
  float span = uCell * float(G) * 0.5;
  float fade = 1.0 - smoothstep(span * 0.6, span * 0.98, d);
  if (u01(hsh(h + 4u)) > dens || fade <= 0.0 || d < 1e-6) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vSize = 1.0; return; }
  vec4 mv = modelViewMatrix * vec4(rotT(p, uPat), 1.0);
  gl_Position = projectionMatrix * mv;
  // dwarf-dominated luminosity function: log10 L in [-2.6, 0.4], most stars faint and red
  float ul = u01(hsh(h + 5u));
  float logL = -2.6 + 3.0 * pow(ul, 1.8);
  float T = 3300.0 + 3000.0 * clamp((logL + 2.6) / 3.0, 0.0, 1.0) + 600.0 * (u01(hsh(h + 6u)) - 0.5);
  vec3 col = rv_blackbody(T);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(vec3(0.0), l + (col - l) * 0.8);
  col /= max(col.r, max(col.g, col.b));
  float flux = exp2(logL * 3.3219281 * uLumExp) * uGain / (d * d) * uWeight * fade;
  float Fp = flux * uPixScale * uPixScale;
  Fp = min(Fp, uEps * 30.0);                    // dwarfs: never a big blob (the bright ones are real LOD stars)
  if (Fp < uEps * 0.05 || mv.z > 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vSize = 1.0; return; }
  float size = 3.0;
  gl_PointSize = size;
  vSize = size;
  vCol = col * Fp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vCol;
varying float vSize;
void main(){
  vec2 q = (gl_PointCoord - 0.5) * vSize;
  float r2 = dot(q, q);
  const float s2 = 0.62 * 0.62;
  float core = exp(-r2 / (2.0 * s2)) / (6.2831853 * s2);
  gl_FragColor = vec4(vCol * core, 1.0);
}
`;

export class FaintStars {
  /** @param shared  GalaxyVolume uniforms (tMap, uMapR, uHOld, uR, uFlare) */
  constructor(engine, shared) {
    const q = engine.quality;
    const G = q.tier === 'low' ? 18 : q.tier === 'med' ? 22 : 26;
    const per = q.tier === 'low' ? 6 : 10;
    this.count = G * G * G * per;
    const g = new THREE.BufferGeometry();
    // (positions are procedural; three.js sizes the draw from the position attribute → 1 byte per vertex)
    g.setAttribute('position', new THREE.BufferAttribute(new Uint8Array(this.count), 1));
    g.setDrawRange(0, this.count);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.uniforms = {
      tMap: shared.tMap, uMapR: shared.uMapR, uHOld: shared.uHOld, uR: shared.uR, uFlare: shared.uFlare,
      uCamPat: { value: new THREE.Vector3() }, uPat: { value: 0 },
      uCell: { value: 0.012 },            // kly (12 ly cells → cube of ±156 ly at high)
      uGain: { value: 0 }, uLumExp: { value: 0.44 }, uPixScale: { value: 500 }, uWeight: { value: 0 },
      uEps: { value: 0.0025 }, uPerCell: { value: per }, uDensK: { value: 0.6 }, uG: { value: G },
    };
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.visible = false;
  }

  /** weight 0..1 (fades in with the LOD population); gain = single-star gain of the local stars */
  update(camPat, pat, pixScale, weight, gain, eps) {
    const u = this.uniforms;
    u.uCamPat.value.copy(camPat);
    u.uPat.value = pat;
    u.uPixScale.value = pixScale;
    u.uWeight.value = weight;
    u.uGain.value = gain;
    u.uEps.value = eps;
    this.points.visible = weight > 0.002;
  }

  dispose() { this.points.geometry.dispose(); this.mat.dispose(); }
}
