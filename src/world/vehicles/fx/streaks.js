// Speed streaks around the camera: faint wind lines at high atmospheric speed, bright star-streaks
// for the pulse drive. Instanced quads stretched along the relative velocity (one draw call).
import * as THREE from 'three';
import { FastRand } from '../util.js';

const VERT = /* glsl */`
attribute vec2 corner;
attribute vec4 iP;      // position rel. anchor, seed
uniform vec3 uVel;      // velocity of the camera (m/s)
uniform float uLen;     // seconds of motion blur
uniform float uWidth;
varying float vA;
varying float vSide;
varying float vAlong;
void main(){
  vec3 p0 = iP.xyz;
  vec3 p1 = iP.xyz - uVel * uLen * (0.6 + 0.8 * fract(iP.w * 7.13));
  vec4 a = modelViewMatrix * vec4(p0, 1.0);
  vec4 b = modelViewMatrix * vec4(p1, 1.0);
  vec4 ca = projectionMatrix * a, cb = projectionMatrix * b;
  vec2 sa = ca.xy / max(ca.w, 1e-3), sb = cb.xy / max(cb.w, 1e-3);
  vec2 d = sb - sa; float l = length(d);
  vec2 dir = l > 1e-6 ? d / l : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float t = corner.x * 0.5 + 0.5;
  vec4 c = mix(ca, cb, t);
  c.xy += nrm * corner.y * uWidth * c.w;
  vA = smoothstep(0.5, 6.0, -a.z) * (0.4 + 0.6 * fract(iP.w * 3.7));
  vSide = corner.y; vAlong = t;
  gl_Position = c;
}`;
const FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uPower;
varying float vA;
varying float vSide;
varying float vAlong;
void main(){
  float a = vA * (1.0 - abs(vSide)) * (1.0 - vAlong) * uPower;
  gl_FragColor = vec4(uColor * a, 0.0);
}`;

export class Streaks {
  constructor(world, count = 160) {
    this.world = world;
    this.count = count;
    this.rand = new FastRand(9173);
    this.pos = new Float64Array(count * 3);
    this.init = false;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iP', this.aP);
    g.instanceCount = count;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uVel: { value: new THREE.Vector3() }, uLen: { value: 0.05 }, uWidth: { value: 0.0015 }, uColor: { value: new THREE.Color(0.8, 0.9, 1.0) }, uPower: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.visible = false;
    this.geo = g;
    world.root.add(this.mesh);
    this.radius = 60;
    this._d = new THREE.Vector3();
  }

  _respawn(i, cam, dir, spread, ahead) {
    const r = this.rand;
    // a random point in a disc ahead of the camera (so streaks sweep past us)
    const a = r.next() * Math.PI * 2, rr = spread * (0.15 + 0.85 * Math.sqrt(r.next()));
    // build a basis around dir
    const d = dir;
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(d.y) > 0.9) { ux = 1; uy = 0; }
    // e1 = normalize(u × d), e2 = d × e1
    let e1x = uy * d.z - uz * d.y, e1y = uz * d.x - ux * d.z, e1z = ux * d.y - uy * d.x;
    const l1 = Math.hypot(e1x, e1y, e1z) || 1; e1x /= l1; e1y /= l1; e1z /= l1;
    const e2x = d.y * e1z - d.z * e1y, e2y = d.z * e1x - d.x * e1z, e2z = d.x * e1y - d.y * e1x;
    const f = ahead * (0.2 + r.next());
    const cx = Math.cos(a) * rr, cy = Math.sin(a) * rr;
    this.pos[i * 3] = cam.x + d.x * f + e1x * cx + e2x * cy;
    this.pos[i * 3 + 1] = cam.y + d.y * f + e1y * cx + e2y * cy;
    this.pos[i * 3 + 2] = cam.z + d.z * f + e1z * cx + e2z * cy;
  }

  /** vel: camera velocity (planet-local m/s), power 0..1, mode 'wind'|'pulse'. */
  update(dt, vel, power, mode = 'wind') {
    if (power < 0.01) { this.mesh.visible = false; this.init = false; return; }
    this.mesh.visible = true;
    const cam = this.world.camera.position;
    const speed = vel.length();
    if (speed < 1) { this.mesh.visible = false; return; }
    const dir = this._d.copy(vel).divideScalar(speed);
    const pulse = mode === 'pulse';
    const spread = pulse ? 90 : 26;
    const ahead = pulse ? 400 : 90;
    this.mesh.position.copy(cam);
    const P = this.aP.array;
    // Streak world positions are static in space; the camera flies through them.
    for (let i = 0; i < this.count; i++) {
      let px = this.pos[i * 3], py = this.pos[i * 3 + 1], pz = this.pos[i * 3 + 2];
      const dx = px - cam.x, dy = py - cam.y, dz = pz - cam.z;
      const along = dx * dir.x + dy * dir.y + dz * dir.z;
      if (!this.init || along < -20 || dx * dx + dy * dy + dz * dz > (ahead * 1.5) ** 2) {
        this._respawn(i, cam, dir, spread, this.init ? ahead : ahead * 0.5 + 10);
        px = this.pos[i * 3]; py = this.pos[i * 3 + 1]; pz = this.pos[i * 3 + 2];
      }
      P[i * 4] = px - cam.x; P[i * 4 + 1] = py - cam.y; P[i * 4 + 2] = pz - cam.z; P[i * 4 + 3] = (i * 0.37) % 1;
    }
    this.init = true;
    this.aP.needsUpdate = true;
    const u = this.mat.uniforms;
    u.uVel.value.copy(vel);
    u.uLen.value = pulse ? Math.min(0.2, 400 / speed) : Math.min(0.12, 12 / speed);
    u.uWidth.value = pulse ? 0.0022 : 0.0014;
    u.uPower.value = power * (pulse ? 1.4 : 0.5);
    if (pulse) u.uColor.value.setRGB(0.7, 0.85, 1.6); else u.uColor.value.setRGB(0.9, 0.95, 1.0);
  }

  dispose() { this.mesh.removeFromParent(); this.geo.dispose(); this.mat.dispose(); }
}
