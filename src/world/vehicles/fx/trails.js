// Camera-facing ribbon trails (contrails, wingtip vortices, Akira-style tail-light streaks).
// Ring buffer of float64 points, rebuilt as a triangle strip every frame (small N).
import * as THREE from 'three';

const VERT = /* glsl */`
attribute float aAlpha;
attribute float aT;
varying float vA;
varying float vT;
varying float vSide;
attribute float aSide;
void main(){
  vA = aAlpha; vT = aT; vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */`
#include <rv_common>
uniform vec3 uColor;
uniform float uAdditive;
varying float vA;
varying float vT;
varying float vSide;
void main(){
  float edge = 1.0 - abs(vSide);
  float a = vA * pow(edge, 1.5);
  if (uAdditive > 0.5) { gl_FragColor = vec4(uColor * a, 0.0); return; }
  gl_FragColor = vec4(uColor * a, a);
}`;

const _t = new THREE.Vector3(), _v = new THREE.Vector3(), _s = new THREE.Vector3();

export class Ribbon {
  constructor(world, { max = 48, color = [1, 1, 1], additive = false, life = 2.0, minDist = 1.0, name = 'ribbon' } = {}) {
    this.world = world;
    this.max = max;
    this.life = life;
    this.minDist = minDist;
    this.px = new Float64Array(max); this.py = new Float64Array(max); this.pz = new Float64Array(max);
    this.w = new Float32Array(max); this.a = new Float32Array(max); this.age = new Float32Array(max);
    this.head = 0; this.n = 0;
    const vcount = max * 2;
    this.pos = new Float32Array(vcount * 3);
    this.alpha = new Float32Array(vcount);
    this.tt = new Float32Array(vcount);
    this.side = new Float32Array(vcount);
    for (let i = 0; i < max; i++) { this.side[i * 2] = -1; this.side[i * 2 + 1] = 1; }
    const idx = [];
    for (let i = 0; i < max - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aA = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aAlpha', this.aA);
    g.setAttribute('aT', new THREE.BufferAttribute(this.tt, 1));
    g.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1));
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uColor: { value: new THREE.Color(...color) }, uAdditive: { value: additive ? 1 : 0 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = name;
    this.anchor = new THREE.Vector3();
    world.root.add(this.mesh);
    this._last = new THREE.Vector3(1e30, 0, 0);
  }

  /** Emit at planet-local position p with half-width w and opacity a (0 breaks the trail visually). */
  push(p, w, a) {
    const i0 = (this.head - 1 + this.max) % this.max;
    if (this.n > 0) {
      const dx = p.x - this.px[i0], dy = p.y - this.py[i0], dz = p.z - this.pz[i0];
      if (dx * dx + dy * dy + dz * dz < this.minDist * this.minDist) {
        // update the head point in place so the ribbon stays attached
        this.px[i0] = p.x; this.py[i0] = p.y; this.pz[i0] = p.z; this.w[i0] = w; this.a[i0] = a; this.age[i0] = 0;
        return;
      }
    }
    const i = this.head;
    this.px[i] = p.x; this.py[i] = p.y; this.pz[i] = p.z; this.w[i] = w; this.a[i] = a; this.age[i] = 0;
    this.head = (this.head + 1) % this.max;
    this.n = Math.min(this.max, this.n + 1);
  }

  reset() { this.n = 0; this.head = 0; this.geo.setDrawRange(0, 0); }

  update(dt) {
    const cam = this.world.camera.position;
    if (cam.distanceToSquared(this.anchor) > 250000) { this.anchor.copy(cam); this.mesh.position.copy(this.anchor); }
    for (let k = 0; k < this.n; k++) this.age[(this.head - 1 - k + this.max * 2) % this.max] += dt;
    // drop dead tail
    while (this.n > 0) { const tail = (this.head - this.n + this.max) % this.max; if (this.age[tail] > this.life) this.n--; else break; }
    const n = this.n;
    if (n < 2) { this.geo.setDrawRange(0, 0); return; }
    const ax = this.anchor.x, ay = this.anchor.y, az = this.anchor.z;
    for (let k = 0; k < n; k++) {
      // k = 0 newest
      const i = (this.head - 1 - k + this.max * 2) % this.max;
      const j = (this.head - 1 - Math.min(n - 1, k + 1) + this.max * 2) % this.max;
      const h = (this.head - 1 - Math.max(0, k - 1) + this.max * 2) % this.max;
      _t.set(this.px[h] - this.px[j], this.py[h] - this.py[j], this.pz[h] - this.pz[j]);
      _v.set(this.px[i] - cam.x, this.py[i] - cam.y, this.pz[i] - cam.z);
      _s.crossVectors(_t, _v);
      const l = _s.length();
      if (l > 1e-9) _s.multiplyScalar(1 / l); else _s.set(0, 1, 0);
      const life = this.age[i] / this.life;
      const w = this.w[i] * (1 + life * 1.8);
      const a = this.a[i] * (1 - life) * (1 - life) * Math.min(1, k * 0.5);
      const bx = this.px[i] - ax, by = this.py[i] - ay, bz = this.pz[i] - az;
      const o = k * 6;
      this.pos[o] = bx - _s.x * w; this.pos[o + 1] = by - _s.y * w; this.pos[o + 2] = bz - _s.z * w;
      this.pos[o + 3] = bx + _s.x * w; this.pos[o + 4] = by + _s.y * w; this.pos[o + 5] = bz + _s.z * w;
      this.alpha[k * 2] = a; this.alpha[k * 2 + 1] = a;
    }
    this.aPos.needsUpdate = true; this.aA.needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
  }

  dispose() { this.mesh.removeFromParent(); this.geo.dispose(); this.mat.dispose(); }
}
