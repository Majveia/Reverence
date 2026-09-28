// Backdrop — the distant universe behind a galaxy: a few thousand background galaxies (procedural
// spirals / ellipticals / edge-on disks with random orientation and redshifted colors) and a faint
// field of foreground halo stars, drawn at infinity (camera-centred) before everything else.
// Deterministic from the galaxy seed. One draw call (instanced quads).
import * as THREE from 'three';
import { RNG, hashCombine } from '../../core/rng.js';

const VERT = /* glsl */ `
attribute vec4 aDir;      // xyz direction, w = angular size (rad)
attribute vec4 aShape;    // x = type (0 elliptical, 1 spiral, 2 star), y = axis ratio, z = position angle, w = seed
attribute vec3 aColor;
varying vec2 vQ;
varying vec4 vShape;
varying vec3 vColor;
varying float vPix;
uniform float uPixScale;
void main(){
  vec3 d = normalize(aDir.xyz);
  // camera-centred: rotate only
  vec4 c = projectionMatrix * vec4(mat3(viewMatrix) * d, 1.0);
  float sizePx = max(aDir.w * uPixScale, aShape.x > 1.5 ? 2.2 : 2.6);
  vec2 off = position.xy * sizePx / uPixScale;             // radians (small angle)
  c.xy += off * vec2(projectionMatrix[0][0], projectionMatrix[1][1]) * c.w;
  c.z = c.w * 0.99999;                                      // far away (works with either depth convention: depth test is off)
  gl_Position = c;
  vQ = position.xy;
  vShape = aShape;
  vColor = aColor;
  vPix = sizePx;
}`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vQ;
varying vec4 vShape;
varying vec3 vColor;
varying float vPix;
float h11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main(){
  vec2 q = vQ;
  float r0 = length(q);
  if (r0 > 1.0) discard;
  float I;
  if (vShape.x > 1.5) {
    I = exp(-r0 * r0 * 10.0) * 2.0;
  } else {
    float ca = cos(vShape.z), sa = sin(vShape.z);
    vec2 p = vec2(ca * q.x - sa * q.y, sa * q.x + ca * q.y);
    p.y /= max(vShape.y, 0.08);
    float r = length(p);
    if (vShape.x < 0.5) {
      I = exp(-pow(r * 3.2, 0.7) * 3.0) * 3.0;                            // de Vaucouleurs-ish
    } else {
      float th = atan(p.y, p.x);
      float arms = 0.5 + 0.5 * cos(2.0 * (th - log(max(r, 0.02)) * (2.0 + 2.0 * h11(vShape.w))));
      float disk = exp(-r * 4.2);
      I = disk * (0.45 + 0.9 * arms * smoothstep(0.05, 0.25, r)) * 2.2 + exp(-r * r * 90.0) * 2.5;
    }
  }
  float soft = 1.0 - smoothstep(0.7, 1.0, r0);
  // sub-pixel sprites keep their total flux (area-normalized)
  float norm = clamp(vPix * vPix / 64.0, 0.08, 1.0);
  gl_FragColor = vec4(vColor * I * soft * mix(1.0, 1.0 / norm, 0.0) , 1.0);
}`;

export class Backdrop {
  constructor(engine, galaxy) {
    const r = new RNG(hashCombine(galaxy.seed, 0xbac6));
    const q = engine.quality;
    const nGal = Math.floor((q.tier === 'low' ? 900 : q.tier === 'med' ? 1600 : 2600));
    const nStar = Math.floor((q.tier === 'low' ? 600 : 1500));
    const n = nGal + nStar;
    const dir = new Float32Array(n * 4), shape = new Float32Array(n * 4), color = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // uniform on the sphere
      const z = r.range(-1, 1), a = r.range(0, Math.PI * 2), s = Math.sqrt(1 - z * z);
      dir.set([s * Math.cos(a), z, s * Math.sin(a)], i * 4);
      if (i < nGal) {
        const u = r.next();
        const size = 0.0016 * Math.pow(r.next(), 4.0) * 14 + 0.0015 + 0.0015 * r.next();        // rad: mostly tiny, a few large
        dir[i * 4 + 3] = size;
        const spiral = u < 0.62;
        shape.set([spiral ? 1 : 0, spiral ? r.range(0.12, 1) : r.range(0.55, 1), r.range(0, Math.PI), r.range(0, 1000)], i * 4);
        const zred = Math.pow(r.next(), 0.6);                       // farther → redder, fainter
        const b = (0.06 + 0.7 * Math.pow(r.next(), 4)) * (1.2 - zred) * (spiral ? 0.9 : 1.1);
        const cr = spiral ? [0.75, 0.82, 1.0] : [1.0, 0.8, 0.58];
        const red = [1.0, 0.92 - 0.2 * zred, 0.85 - 0.3 * zred];
        color.set([cr[0] * red[0] * b, cr[1] * red[1] * b, cr[2] * red[2] * b], i * 3);
      } else {
        dir[i * 4 + 3] = 0;
        shape.set([2, 1, 0, 0], i * 4);
        const t = r.next();
        const b = 0.03 + 0.5 * Math.pow(r.next(), 6);
        color.set(t < 0.6 ? [1.0 * b, 0.82 * b, 0.62 * b] : [0.72 * b, 0.82 * b, 1.0 * b], i * 3);
      }
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aDir', new THREE.InstancedBufferAttribute(dir, 4));
    g.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 4));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3));
    g.instanceCount = n;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uPixScale: { value: 700 } },
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Mesh(g, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = -10;
    this.engine = engine;
  }

  update(camera) {
    this.mat.uniforms.uPixScale.value = this.engine.pipeline.height / (2 * Math.tan(camera.fov * Math.PI / 360));
  }

  dispose() { this.object.geometry.dispose(); this.mat.dispose(); }
}
