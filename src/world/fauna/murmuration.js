// Murmuration (season 2): a flock as weather — hundreds to thousands of small birds moving as one
// folding, wheeling sheet at dusk and dawn, set against the low sun. GPU only: one instanced draw,
// every bird's position is evaluated in the vertex shader from its seed and the time (a deforming,
// rolling sheet with travelling density waves around a slowly looping centre); the CPU only moves the
// centre and the frame. Birds keep a minimum pixel size so the cloud reads at 150–400 m.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';

const VERT = /* glsl */`
uniform float uT;
uniform vec3 uCenter;      // scene space
uniform vec3 uE; uniform vec3 uU; uniform vec3 uN;   // frame at the centre (east, up, north)
uniform vec3 uSize;        // sheet half extents (m): along, thickness, across
uniform float uSpan;       // wingspan (m)
uniform float uPxK;        // pixels per radian (vertical)
uniform float uMinPx;
uniform float uFade;
attribute vec4 aSeed;
attribute vec3 aCorner;    // x: -1 left wing tip, 0 body, +1 right wing tip; y: 0 front 1 back; z: tip flag
varying float vShade;
varying float vFog;
varying float vRim;

vec3 sheet(vec4 s, float t){
  // folding sheet: (u, v) on a plane, bent by travelling waves, rolled about two slow axes
  float u = s.x * 2.0 - 1.0, v = s.y * 2.0 - 1.0, w = s.z * 2.0 - 1.0;
  float r = length(vec2(u, v));
  // round-ish blob with a tapered, comet-like tail that sweeps around
  float env = 1.0 - smoothstep(0.55, 1.0, r);
  u += 0.22 * sin(v * 3.1 + t * 0.9) + 0.12 * sin(u * 5.3 - t * 1.7);          // density waves
  v += 0.18 * sin(u * 2.7 - t * 0.6);
  float bend = 0.55 * sin(u * 2.2 + t * 0.45) + 0.35 * sin(v * 2.9 - t * 0.38);
  vec3 p = vec3(u * uSize.x, (bend + w * 0.12 * env) * uSize.y * 3.0, v * uSize.z);
  // tail: the far edge stretches out behind the turn
  p.x += smoothstep(0.4, 1.0, s.x) * uSize.x * 0.6 * sin(t * 0.3 + s.y * 2.0);
  // roll / pitch the whole sheet slowly (the cloud folds edge-on and back: thin dark ribbon ↔ broad veil)
  float a = 0.9 * sin(t * 0.21) + 0.3 * sin(t * 0.13 + 1.0);
  float b = 0.6 * sin(t * 0.17 + 2.0);
  float ca = cos(a), sa = sin(a), cb = cos(b), sb = sin(b);
  p = vec3(p.x, p.y * ca - p.z * sa, p.y * sa + p.z * ca);
  p = vec3(p.x * cb - p.y * sb, p.x * sb + p.y * cb, p.z);
  // wheel: the whole sheet yaws around the centre
  float y = t * 0.16 + 0.5 * sin(t * 0.07);
  float cy = cos(y), sy = sin(y);
  p = vec3(p.x * cy - p.z * sy, p.y, p.x * sy + p.z * cy);
  // individual jitter
  p += (vec3(s.w, fract(s.w * 7.13), fract(s.w * 3.71)) - 0.5) * uSize.y * 0.5;
  return p;
}

void main(){
  float t = uT * 1.0 + aSeed.w * 0.6;
  vec3 p0 = sheet(aSeed, t);
  vec3 p1 = sheet(aSeed, t + 0.15);
  vec3 vel = p1 - p0;
  vec3 local = p0;
  vec3 wp = uCenter + uE * local.x + uU * local.y + uN * local.z;
  vec3 fw = normalize(uE * vel.x + uU * vel.y + uN * vel.z + uE * 1e-4);
  vec3 rt = normalize(cross(fw, uU) + 1e-5);
  vec3 up = cross(rt, fw);
  // size: real span, but never below uMinPx on screen
  vec3 camRel = wp - cameraPosition;
  float dist = length(camRel);
  float k = max(1.0, uMinPx * dist / (uSpan * uPxK));
  float span = uSpan * k * (0.8 + 0.4 * fract(aSeed.w * 13.7));
  // flap: quick beats with glides
  float ph = uT * (11.0 + 4.0 * aSeed.x) + aSeed.w * 40.0;
  float glide = smoothstep(0.2, 0.6, sin(uT * 0.7 + aSeed.y * 9.0));
  float flap = mix(sin(ph), 0.15, glide);
  vec3 pos = wp;
  pos += rt * aCorner.x * span * 0.5;
  pos += up * abs(aCorner.x) * flap * span * 0.32;
  pos -= fw * aCorner.y * span * 0.32;
  pos += fw * (1.0 - abs(aCorner.x)) * (0.5 - aCorner.y) * span * 0.25;
  vShade = 0.5 + 0.5 * flap * abs(aCorner.x);
  vFog = 1.0 - exp(-dist * 0.0018);
  vec3 L = normalize(${'uSunDirV'});
  vRim = pow(clamp(dot(normalize(camRel), L), 0.0, 1.0), 4.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const FRAG = /* glsl */`
uniform vec3 uSky;
uniform vec3 uSunCol;
uniform float uFade;
varying float vShade;
varying float vFog;
varying float vRim;
void main(){
  // silhouettes: near-black against the bright sky, a warm edge glow when the cloud crosses the sun,
  // paler and cooler with distance
  vec3 c = vec3(0.012, 0.011, 0.014) * (0.7 + 0.6 * vShade) + uSky * 0.05 + uSunCol * vRim * 0.025;
  c = mix(c, uSky * vec3(0.9, 1.0, 1.12), clamp(vFog, 0.0, 0.75));
  gl_FragColor = vec4(c, uFade);
}
`;

export class Murmuration {
  constructor(fauna, count) {
    this.fauna = fauna;
    const n = Math.max(64, count | 0);
    this.n = n;
    const base = new THREE.InstancedBufferGeometry();
    // one bird: body diamond + two wings (3 triangles)
    const corners = new Float32Array([
      0, 0, 0, -1, 0.5, 1, 0, 1, 0,      // left wing
      0, 0, 0, 0, 1, 0, 1, 0.5, 1,       // right wing
      0, -0.6, 0, 0.18, 1.4, 0, -0.18, 1.4, 0,   // body / tail
    ]);
    base.setAttribute('aCorner', new THREE.BufferAttribute(corners, 3));
    base.setAttribute('position', new THREE.BufferAttribute(new Float32Array(27), 3));
    const seeds = new Float32Array(n * 4);
    // deterministic stratified seeds (sheet coordinates in a disc, thickness, jitter)
    let h = 0x9e3779b9 >>> 0;
    const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
    for (let i = 0; i < n; i++) {
      // concentrated toward the core (sum of three uniforms): a dense dark heart with thinning, ragged edges
      let u, v;
      do { u = (rnd() + rnd() + rnd()) / 3; v = (rnd() + rnd() + rnd()) / 3; u = 0.5 + (u - 0.5) * 1.7; v = 0.5 + (v - 0.5) * 1.7; } while ((u - 0.5) ** 2 + (v - 0.5) ** 2 > 0.25);
      seeds[i * 4] = u; seeds[i * 4 + 1] = v; seeds[i * 4 + 2] = rnd(); seeds[i * 4 + 3] = rnd();
    }
    base.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    base.instanceCount = n;
    base.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.u = {
      uT: { value: 0 }, uCenter: { value: new THREE.Vector3() },
      uE: { value: new THREE.Vector3(1, 0, 0) }, uU: { value: new THREE.Vector3(0, 1, 0) }, uN: { value: new THREE.Vector3(0, 0, 1) },
      uSize: { value: new THREE.Vector3(120, 6, 62) }, uSpan: { value: 0.75 }, uPxK: { value: 500 }, uMinPx: { value: 2.6 },
      uFade: { value: 0 }, uSunDirV: G.uSunDir, uSky: G.uAmbientSky, uSunCol: G.uSunColor,
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: 'uniform vec3 uSunDirV;\n' + VERT,
      fragmentShader: FRAG,
      transparent: true, depthWrite: true, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(base, mat);
    this.mesh.name = 'fauna:murmuration';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    fauna.root.add(this.mesh);
    this.center = new Float64Array(3);       // planet-local
    this.anchor = null;
    this.on = 0;
    this.forced = false;
    this.t0 = 0;
  }

  /** place the cloud's home `dist` m from the player toward azimuth unit vector dir (planet-local tangent) */
  place(P, dir, dist, agl) {
    const f = this.fauna;
    const x = P[0] + dir[0] * dist, y = P[1] + dir[1] * dist, z = P[2] + dir[2] * dist;
    const l = Math.hypot(x, y, z);
    const h = Math.max(f.sea, f.surface.height(x / l, y / l, z / l));
    const r = f.R + h + agl;
    this.anchor = new Float64Array([x / l * r, y / l * r, z / l * r]);
    this.agl = agl;
  }

  update(dt, t, sunElevDeg) {
    const f = this.fauna;
    const P = f.playerPos;
    // dusk and dawn (sun between −5° and 16°), or forced by the showcase
    const want = this.forced || (sunElevDeg > -5 && sunElevDeg < 16 && f.env.playerOnGround);
    this.on += ((want ? 1 : 0) - this.on) * Math.min(1, dt * 0.25);
    if (this.forced) this.on = 1;
    if (this.on < 0.01) { this.mesh.visible = false; return; }
    if (!this.anchor || Math.hypot(this.anchor[0] - P[0], this.anchor[1] - P[1], this.anchor[2] - P[2]) > 900) {
      // across the sun: the cloud is a silhouette against the bright sky
      const l = Math.hypot(P[0], P[1], P[2]);
      const ux = P[0] / l, uy = P[1] / l, uz = P[2] / l;
      const S = G.uSunDir.value;
      let dx = S.x, dy = S.y, dz = S.z;
      const d = dx * ux + dy * uy + dz * uz;
      dx -= ux * d; dy -= uy * d; dz -= uz * d;
      const dl = Math.hypot(dx, dy, dz) || 1;
      this.place(P, [dx / dl, dy / dl, dz / dl], 260, 85);
    }
    // the centre loops slowly around the anchor (a lazy figure of eight)
    const a = this.anchor;
    const l = Math.hypot(a[0], a[1], a[2]);
    const ux = a[0] / l, uy = a[1] / l, uz = a[2] / l;
    let ex = uz, ey = 0, ez = -ux; const el = Math.hypot(ex, ey, ez) || 1; ex /= el; ey /= el; ez /= el;
    const nx = uy * ez - uz * ey, ny = uz * ex - ux * ez, nz = ux * ey - uy * ex;
    const tt = t * 0.045;
    const ox = Math.sin(tt) * 70, oz = Math.sin(tt * 2) * 35, oy = Math.sin(tt * 1.3) * 18;
    const C = this.center;
    C[0] = a[0] + ex * ox + nx * oz + ux * oy; C[1] = a[1] + ey * ox + ny * oz + uy * oy; C[2] = a[2] + ez * ox + nz * oz + uz * oy;
    const u = this.u;
    const O = f.world.origin;
    u.uCenter.value.set(C[0] - O.x, C[1] - O.y, C[2] - O.z);
    u.uE.value.set(ex, ey, ez); u.uU.value.set(ux, uy, uz); u.uN.value.set(nx, ny, nz);
    u.uT.value = t;
    const cam = f.world.camera;
    const H = f.engine?.height || cam.userData?.h || 720;
    u.uPxK.value = (f.engine?.renderer?.domElement?.height || H) / (2 * Math.tan((cam.fov || 60) * Math.PI / 360));
    u.uFade.value = Math.min(1, this.on);
    this.mesh.visible = true;
  }

  getState() { return this.mesh.visible ? { n: this.n, dist: this.anchor ? Math.round(Math.hypot(this.center[0] - this.fauna.playerPos[0], this.center[1] - this.fauna.playerPos[1], this.center[2] - this.fauna.playerPos[2])) : null } : null; }

  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
