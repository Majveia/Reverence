// Tire tracks: ground-aligned strips (one per wheel, ONE draw call) laid behind the contact patches.
// Points are planet-local float64 kept in ring buffers; vertices are rebuilt only when a point is
// added, relative to an anchor near the camera (no float32 jitter). Fading is done in the shader
// from a per-vertex birth time, so idle frames cost nothing.
import * as THREE from 'three';

const VERT = /* glsl */`
attribute vec2 aUv;      // x: across (-1..1), y: distance along (m)
attribute vec2 aLife;    // birth time, strength
uniform float uTime;
uniform float uLife;
varying vec2 vUv;
varying float vA;
void main(){
  vUv = aUv;
  float age = uTime - aLife.x;
  vA = aLife.y * clamp(1.0 - age / uLife, 0.0, 1.0) * smoothstep(0.0, 0.3, age + 0.3);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */`
#include <rv_common>
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vA;
void main(){
  float across = abs(vUv.x);
  float edge = 1.0 - smoothstep(0.6, 1.0, across);
  // chevron tread blocks
  float t = fract(vUv.y * 3.2 + across * 0.35);
  float tread = 0.62 + 0.38 * smoothstep(0.35, 0.5, t) * (1.0 - smoothstep(0.85, 1.0, t));
  float a = vA * edge * tread * uOpacity;
  a *= 0.9 + 0.1 * rv_ign(gl_FragCoord.xy);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}`;

const _s = new THREE.Vector3();

export class TireTracks {
  constructor(world, { strips = 4, max = 120, width = 0.36, life = 45, minDist = 0.45, name = 'tire-tracks' } = {}) {
    this.world = world;
    this.strips = strips; this.max = max; this.width = width; this.minDist = minDist; this.life = life;
    const N = strips * max;
    this.px = new Float64Array(N); this.py = new Float64Array(N); this.pz = new Float64Array(N);
    this.sx = new Float32Array(N); this.sy = new Float32Array(N); this.sz = new Float32Array(N);
    this.birth = new Float32Array(N); this.str = new Float32Array(N); this.dist = new Float32Array(N);
    this.head = new Int32Array(strips); this.n = new Int32Array(strips); this.cutNext = new Uint8Array(strips).fill(1);
    this.pos = new Float32Array(N * 2 * 3);
    this.uv = new Float32Array(N * 2 * 2);
    this.lifeA = new Float32Array(N * 2 * 2);
    const idx = [];
    for (let s = 0; s < strips; s++) for (let k = 0; k < max - 1; k++) { const a = (s * max + k) * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aUv = new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage);
    this.aLife = new THREE.BufferAttribute(this.lifeA, 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aUv', this.aUv); g.setAttribute('aLife', this.aLife);
    g.setIndex(idx);
    this.geo = g;
    this.time = { value: 0 };
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uTime: this.time, uLife: { value: life }, uColor: { value: new THREE.Color(0.2, 0.17, 0.13) }, uOpacity: { value: 0.55 } },
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = name;
    this.anchor = new THREE.Vector3();
    this.dirty = false;
    this.any = false;
    world.root.add(this.mesh);
  }

  get color() { return this.mat.uniforms.uColor.value; }

  /** Break strip i (wheel left the ground): the next point starts a new segment. */
  cut(i) { this.cutNext[i] = 1; }

  /** Add a point for strip i at planet-local p (on the ground), with tangent-plane side vector and strength. */
  push(i, p, side, strength) {
    const M = this.max, base = i * M;
    const last = base + ((this.head[i] - 1 + M) % M);
    if (this.n[i] > 0 && !this.cutNext[i]) {
      const dx = p.x - this.px[last], dy = p.y - this.py[last], dz = p.z - this.pz[last];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < this.minDist * this.minDist) return;
      if (d2 > 36) this.cutNext[i] = 1;                    // teleport / respawn: don't bridge
    }
    const t = this.time.value;
    const add = (x, y, z, s) => {
      const k = base + this.head[i];
      const prev = base + ((this.head[i] - 1 + M) % M);
      this.dist[k] = this.n[i] > 0 ? this.dist[prev] + Math.hypot(x - this.px[prev], y - this.py[prev], z - this.pz[prev]) : 0;
      this.px[k] = x; this.py[k] = y; this.pz[k] = z;
      this.sx[k] = side.x; this.sy[k] = side.y; this.sz[k] = side.z;
      this.birth[k] = t; this.str[k] = s;
      this.head[i] = (this.head[i] + 1) % M;
      this.n[i] = Math.min(M, this.n[i] + 1);
    };
    if (this.cutNext[i]) {
      if (this.n[i] > 0) add(this.px[last], this.py[last], this.pz[last], 0);
      add(p.x, p.y, p.z, 0);
      this.cutNext[i] = 0;
    }
    add(p.x, p.y, p.z, strength);
    this.dirty = true;
    this.any = true;
  }

  update(dt) {
    this.time.value += dt;
    if (!this.any) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const cam = this.world.camera.position;
    if (cam.distanceToSquared(this.anchor) > 1e6) { this.anchor.copy(cam); this.mesh.position.copy(this.anchor); this.dirty = true; }
    if (!this.dirty) return;
    this.dirty = false;
    const M = this.max, w = this.width * 0.5, ax = this.anchor.x, ay = this.anchor.y, az = this.anchor.z;
    for (let s = 0; s < this.strips; s++) {
      const n = this.n[s], base = s * M;
      for (let k = 0; k < M; k++) {
        const o = (base + k) * 2;
        if (k >= n) {
          // collapse unused slots onto the newest point with zero strength
          const src = base + ((this.head[s] - 1 + M) % M);
          for (let e = 0; e < 2; e++) { this.pos[(o + e) * 3] = this.px[src] - ax; this.pos[(o + e) * 3 + 1] = this.py[src] - ay; this.pos[(o + e) * 3 + 2] = this.pz[src] - az; this.lifeA[(o + e) * 2] = -1e4; this.lifeA[(o + e) * 2 + 1] = 0; }
          continue;
        }
        const src = base + ((this.head[s] - n + k + M * 2) % M);   // chronological order
        _s.set(this.sx[src], this.sy[src], this.sz[src]);
        const x = this.px[src] - ax, y = this.py[src] - ay, z = this.pz[src] - az;
        this.pos[o * 3] = x - _s.x * w; this.pos[o * 3 + 1] = y - _s.y * w; this.pos[o * 3 + 2] = z - _s.z * w;
        this.pos[(o + 1) * 3] = x + _s.x * w; this.pos[(o + 1) * 3 + 1] = y + _s.y * w; this.pos[(o + 1) * 3 + 2] = z + _s.z * w;
        this.uv[o * 2] = -1; this.uv[o * 2 + 1] = this.dist[src];
        this.uv[(o + 1) * 2] = 1; this.uv[(o + 1) * 2 + 1] = this.dist[src];
        this.lifeA[o * 2] = this.birth[src]; this.lifeA[o * 2 + 1] = this.str[src];
        this.lifeA[(o + 1) * 2] = this.birth[src]; this.lifeA[(o + 1) * 2 + 1] = this.str[src];
      }
    }
    this.aPos.needsUpdate = true; this.aUv.needsUpdate = true; this.aLife.needsUpdate = true;
  }

  dispose() { this.mesh.removeFromParent(); this.geo.dispose(); this.mat.dispose(); }
}
