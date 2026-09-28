// Player track — effects. All pooled, allocation-free per frame, ~7 draw calls total:
//   Particles  instanced billboards (dust puffs, sand/snow spray, splash droplets, mist, jet sparks,
//              thermal motes) lit by the shared sun/ambient uniforms; droplets stretch along velocity.
//   Ripples    expanding rings on the water surface.
//   Prints     footprints in sand / snow / beach (fade over time).
//   Shadow     soft contact shadow conformed to the heightfield under the feet (grounds the character).
//   Jets       twin jetpack flames (additive, noise-scrolled cones).
//   Trails     wingtip vapour ribbons while gliding fast.
// Positions are stored relative to a local FX origin (re-based as the player travels) → small floats.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { clamp, FastRand } from './util.js';

const PVERT = /* glsl */ `
attribute vec3 iPos; attribute vec3 iVel; attribute vec4 iCol; attribute vec3 iMisc; // size, kind, rot
varying vec4 vCol; varying vec2 vUv; varying float vKind; varying vec3 vWorldN;
void main(){
  vCol = iCol; vUv = position.xy + 0.5; vKind = iMisc.y;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float size = iMisc.x;
  vec2 q = position.xy;
  float c = cos(iMisc.z), s = sin(iMisc.z);
  q = mat2(c, -s, s, c) * q;
  vec3 off = vec3(q * size, 0.0);
  if (iMisc.y > 0.5 && iMisc.y < 1.5) {
    // stretched droplet along screen-space velocity
    vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
    vec2 d = vv.xy; float l = length(d);
    vec2 dir = l > 1e-4 ? d / l : vec2(0.0, 1.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float stretch = 1.0 + min(l * 0.05, 5.0);
    off = vec3(dir * position.y * size * stretch + nrm * position.x * size * 0.6, 0.0);
  }
  mv.xyz += off;
  vWorldN = normalize((inverse(viewMatrix) * vec4(normalize(vec3(position.xy, 0.7)), 0.0)).xyz);
  gl_Position = projectionMatrix * mv;
}`;
const PFRAG = /* glsl */ `
#include <rv_common>
uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uAmbientSky;
varying vec4 vCol; varying vec2 vUv; varying float vKind; varying vec3 vWorldN;
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a;
  vec3 col = vCol.rgb;
  if (vKind < 0.5) {
    // soft puff with a little noisy breakup and fake volume lighting
    float n = rv_hash12(floor(vUv * 9.0) + vCol.a * 13.0) * 0.18;
    a = smoothstep(1.0, 0.25 + n, r);
    float lit = 0.55 + 0.45 * clamp(dot(vWorldN, uSunDir), 0.0, 1.0);
    col = col * (uSunColor * 0.32 * lit + uAmbientSky * 0.9 + 0.02);
  } else if (vKind < 1.5) {
    a = smoothstep(1.0, 0.1, r);
    col = col * (uSunColor * 0.35 + uAmbientSky * 1.1) + pow(max(0.0, 1.0 - r), 3.0) * uSunColor * 0.15;
  } else {
    // emissive spark / mote
    a = smoothstep(1.0, 0.0, r);
    a *= a;
  }
  a *= vCol.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
}`;

export class FX {
  constructor(world, quality) {
    this.world = world;
    const ps = quality?.particleScale ?? 1;
    this.max = Math.max(160, Math.round(700 * Math.min(ps, 1.5)));
    this.group = new THREE.Group();
    this.group.name = 'player-fx';
    this.origin = new THREE.Vector3();
    this.rand = new FastRand(1234);
    // ---------------- particles
    const n = this.max;
    this.P = { pos: new Float64Array(n * 3), vel: new Float32Array(n * 3), age: new Float32Array(n), life: new Float32Array(n),
      s0: new Float32Array(n), s1: new Float32Array(n), col: new Float32Array(n * 3), a0: new Float32Array(n), drag: new Float32Array(n),
      grav: new Float32Array(n), kind: new Uint8Array(n), rot: new Float32Array(n), spin: new Float32Array(n), alive: 0 };
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iVel = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iCol = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iMisc = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.iPos); geo.setAttribute('iVel', this.iVel); geo.setAttribute('iCol', this.iCol); geo.setAttribute('iMisc', this.iMisc);
    geo.instanceCount = 0;
    this.pMat = new THREE.ShaderMaterial({
      vertexShader: PVERT, fragmentShader: PFRAG, transparent: true, depthWrite: false,
      uniforms: { uSunDir: G.uSunDir, uSunColor: G.uSunColor, uAmbientSky: G.uAmbientSky },
    });
    this.points = new THREE.Mesh(geo, this.pMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.group.add(this.points);
    this._quad = quad;

    // ---------------- ripples (water rings)
    this.RMAX = 24;
    const rg = new THREE.InstancedBufferGeometry();
    const rq = new THREE.PlaneGeometry(2, 2);
    rg.index = rq.index; rg.setAttribute('position', rq.attributes.position);
    this.rPos = new THREE.InstancedBufferAttribute(new Float32Array(this.RMAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.rUp = new THREE.InstancedBufferAttribute(new Float32Array(this.RMAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.rMisc = new THREE.InstancedBufferAttribute(new Float32Array(this.RMAX * 2), 2).setUsage(THREE.DynamicDrawUsage);
    rg.setAttribute('iPos', this.rPos); rg.setAttribute('iUp', this.rUp); rg.setAttribute('iMisc', this.rMisc);
    rg.instanceCount = 0;
    this.rMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uSunColor: G.uSunColor, uAmbientSky: G.uAmbientSky },
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute vec3 iUp; attribute vec2 iMisc; varying vec2 vP; varying vec2 vM;
        void main(){
          vec3 up = normalize(iUp);
          vec3 t = normalize(abs(up.y) > 0.9 ? cross(up, vec3(1.0,0.0,0.0)) : cross(up, vec3(0.0,1.0,0.0)));
          vec3 b = cross(up, t);
          float r = iMisc.x;
          vec3 wp = iPos + (t * position.x + b * position.y) * r + up * 0.02;
          vP = position.xy; vM = iMisc;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSunColor; uniform vec3 uAmbientSky; varying vec2 vP; varying vec2 vM;
        void main(){
          float d = length(vP);
          float ring = smoothstep(0.86, 0.93, d) * smoothstep(1.0, 0.95, d) + 0.3 * smoothstep(0.6, 0.66, d) * smoothstep(0.72, 0.68, d);
          float a = ring * vM.y;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uSunColor * 0.2 + uAmbientSky * 1.1 + 0.05, a * 0.28);
        }`,
    });
    this.ripples = new THREE.Mesh(rg, this.rMat);
    this.ripples.frustumCulled = false;
    this.group.add(this.ripples);
    this.R = { pos: new Float64Array(this.RMAX * 3), up: new Float32Array(this.RMAX * 3), age: new Float32Array(this.RMAX), life: new Float32Array(this.RMAX), r0: new Float32Array(this.RMAX), r1: new Float32Array(this.RMAX), n: 0, next: 0 };

    // ---------------- footprints
    this.FMAX = 56;
    const fq = new THREE.PlaneGeometry(0.13, 0.3);
    fq.rotateX(-Math.PI / 2);
    this.fMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      uniforms: {},
      vertexShader: /* glsl */`
        attribute float iAlpha; varying vec2 vUv; varying float vA;
        void main(){ vUv = uv; vA = iAlpha; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        varying vec2 vUv; varying float vA;
        void main(){
          vec2 p = vUv * 2.0 - 1.0;
          // sole shape: toe blob + heel blob, tread lines
          float toe = length((p - vec2(0.0, 0.35)) * vec2(1.0, 1.25));
          float heel = length((p - vec2(0.0, -0.5)) * vec2(1.15, 1.9));
          float m = smoothstep(0.75, 0.55, min(toe, heel));
          float tread = 0.75 + 0.25 * step(0.5, fract(p.y * 7.0));
          float a = m * vA * 0.42 * tread;
          if (a < 0.004) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }`,
    });
    this.prints = new THREE.InstancedMesh(fq, this.fMat, this.FMAX);
    this.pAlpha = new THREE.InstancedBufferAttribute(new Float32Array(this.FMAX), 1).setUsage(THREE.DynamicDrawUsage);
    fq.setAttribute('iAlpha', this.pAlpha);
    this.prints.frustumCulled = false;
    this.prints.count = 0;
    this.group.add(this.prints);
    this.F = { pos: new Float64Array(this.FMAX * 3), q: [], age: new Float32Array(this.FMAX), n: 0, next: 0 };
    for (let i = 0; i < this.FMAX; i++) this.F.q.push(new THREE.Quaternion());

    // ---------------- contact shadow (7x7 grid conformed to terrain)
    const SG = 7;
    const sg = new THREE.PlaneGeometry(1, 1, SG - 1, SG - 1);
    this.shadowGeo = sg;
    this.shMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
      uniforms: { uOpacity: { value: 0.5 } },
      vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity; varying vec2 vUv;
        void main(){ vec2 p = vUv * 2.0 - 1.0; float d = length(p * vec2(1.0, 1.25)); float a = pow(smoothstep(1.0, 0.0, d), 1.6) * uOpacity;
          if (a < 0.003) discard; gl_FragColor = vec4(0.0, 0.0, 0.0, a); }`,
    });
    this.shadow = new THREE.Mesh(sg, this.shMat);
    this.shadow.frustumCulled = false;
    this.shadow.renderOrder = 5;
    this.group.add(this.shadow);
    this.SG = SG;

    // ---------------- jets
    this.jetMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: G.uTime, uPower: { value: 0 }, uCol: { value: new THREE.Color(0.55, 0.95, 1.0) } },
      vertexShader: /* glsl */`varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`
        #include <rv_common>
        #include <rv_noise>
        uniform float uTime; uniform float uPower; uniform vec3 uCol; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){
          float t = vUv.y; // 1 at nozzle → 0 at tail
          float n = rv_snoise(vec3(vUv.x * 6.0, t * 4.0 + uTime * 18.0, uTime * 3.0)) * 0.5 + 0.5;
          float core = pow(t, 2.2);
          float edge = pow(abs(dot(vN, vV)), 1.2);
          float a = (core * 0.9 + n * 0.35 * t) * edge * uPower;
          vec3 col = mix(uCol, vec3(1.0, 0.95, 0.9), core) * (2.0 + 5.0 * core);
          gl_FragColor = vec4(col * a, a);
        }`,
    });
    const cone = new THREE.ConeGeometry(0.045, 0.5, 14, 1, true);
    cone.translate(0, -0.25, 0); // tip down, base at origin
    this.jetGeo = cone;
    this.jets = [new THREE.Mesh(cone, this.jetMat), new THREE.Mesh(cone, this.jetMat)];
    for (const j of this.jets) { j.frustumCulled = false; j.visible = false; j.renderOrder = 12; }

    // ---------------- wingtip trails
    this.TN = 28;
    this.trails = [];
    this.trailMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uSunColor: G.uSunColor, uAmbientSky: G.uAmbientSky },
      vertexShader: /* glsl */`attribute float aA; varying float vA; varying float vS; void main(){ vA = aA; vS = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`uniform vec3 uSunColor; uniform vec3 uAmbientSky; varying float vA; varying float vS;
        void main(){ float e = 1.0 - abs(vS * 2.0 - 1.0); float a = vA * e * e; if (a < 0.002) discard; gl_FragColor = vec4((uSunColor * 0.2 + uAmbientSky) * a, a); }`,
    });
    for (let k = 0; k < 2; k++) {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(this.TN * 2 * 3), aA = new Float32Array(this.TN * 2), uv = new Float32Array(this.TN * 2 * 2);
      for (let i = 0; i < this.TN; i++) { uv[i * 4] = i / (this.TN - 1); uv[i * 4 + 1] = 0; uv[i * 4 + 2] = i / (this.TN - 1); uv[i * 4 + 3] = 1; }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aA', new THREE.BufferAttribute(aA, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      const idx = [];
      for (let i = 0; i < this.TN - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      g.setIndex(idx);
      const m = new THREE.Mesh(g, this.trailMat);
      m.frustumCulled = false; m.visible = false;
      this.group.add(m);
      this.trails.push({ mesh: m, pts: new Float64Array(this.TN * 3), n: 0, acc: 0, alpha: 0 });
    }
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3(); this._n = new THREE.Vector3(); this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4(); this._s = new THREE.Vector3(1, 1, 1);
  }

  /** Re-base local origin near p (keeps float precision). */
  rebase(p) {
    const d = this._v.copy(p).sub(this.origin);
    if (d.lengthSq() < 400 * 400) return;
    const P = this.P;
    for (let i = 0; i < P.alive; i++) { P.pos[i * 3] -= d.x; P.pos[i * 3 + 1] -= d.y; P.pos[i * 3 + 2] -= d.z; }
    const R = this.R;
    for (let i = 0; i < this.RMAX; i++) { R.pos[i * 3] -= d.x; R.pos[i * 3 + 1] -= d.y; R.pos[i * 3 + 2] -= d.z; }
    const F = this.F;
    for (let i = 0; i < this.FMAX; i++) { F.pos[i * 3] -= d.x; F.pos[i * 3 + 1] -= d.y; F.pos[i * 3 + 2] -= d.z; }
    for (const t of this.trails) { for (let i = 0; i < this.TN; i++) { t.pts[i * 3] -= d.x; t.pts[i * 3 + 1] -= d.y; t.pts[i * 3 + 2] -= d.z; } }
    this.origin.copy(p);
  }

  // --------------------------------------------------------------------------- emitters
  /** kind: 0 puff, 1 droplet, 2 emissive spark/mote */
  emit(pos, vel, { kind = 0, size = 0.3, size1 = null, life = 1, color, alpha = 0.6, drag = 1.5, grav = 0, spin = 0 } = {}) {
    const P = this.P;
    let i = P.alive;
    if (i >= this.max) { i = (this.rand.next() * this.max) | 0; } else P.alive++;
    P.pos[i * 3] = pos.x - this.origin.x; P.pos[i * 3 + 1] = pos.y - this.origin.y; P.pos[i * 3 + 2] = pos.z - this.origin.z;
    P.vel[i * 3] = vel.x; P.vel[i * 3 + 1] = vel.y; P.vel[i * 3 + 2] = vel.z;
    P.age[i] = 0; P.life[i] = life; P.s0[i] = size; P.s1[i] = size1 ?? size * 2.2;
    P.col[i * 3] = color.r; P.col[i * 3 + 1] = color.g; P.col[i * 3 + 2] = color.b;
    P.a0[i] = alpha; P.drag[i] = drag; P.grav[i] = grav; P.kind[i] = kind;
    P.rot[i] = this.rand.next() * 6.283; P.spin[i] = spin * (this.rand.next() - 0.5);
  }

  /** Dust puff burst on ground contact. */
  dust(pos, up, color, count, speed = 1.2, size = 0.28, alpha = 0.45) {
    const r = this.rand, v = this._w;
    for (let k = 0; k < count; k++) {
      const a = r.next() * 6.283;
      this._tangent(up);
      v.copy(this._t1).multiplyScalar(Math.cos(a)).addScaledVector(this._t2, Math.sin(a)).multiplyScalar(speed * (0.4 + r.next()));
      v.addScaledVector(up, speed * 0.35 * r.next());
      this._n.copy(pos).addScaledVector(up, 0.05 + r.next() * 0.08);
      this.emit(this._n, v, { kind: 0, size: size * (0.6 + r.next() * 0.6), size1: size * (2.2 + r.next()), life: 0.9 + r.next() * 1.1, color, alpha: alpha * (0.6 + 0.4 * r.next()), drag: 2.2, grav: -0.15, spin: 1.2 });
    }
  }
  /** Directional spray (sand/snow while sliding, water wake). */
  spray(pos, dir, up, color, count, speed, kind = 0, size = 0.18) {
    const r = this.rand, v = this._w;
    this._tangent(up);
    for (let k = 0; k < count; k++) {
      v.copy(dir).multiplyScalar(speed * (0.5 + r.next() * 0.7))
        .addScaledVector(up, speed * (0.35 + r.next() * 0.5))
        .addScaledVector(this._t1, (r.next() - 0.5) * speed * 0.6).addScaledVector(this._t2, (r.next() - 0.5) * speed * 0.6);
      this.emit(pos, v, { kind, size: size * (0.6 + r.next() * 0.8), size1: kind === 0 ? size * 3 : size * 0.8, life: 0.6 + r.next() * 0.7, color, alpha: kind === 0 ? 0.45 : 0.85, drag: kind === 0 ? 1.8 : 0.4, grav: kind === 0 ? 0.3 : 1 });
    }
  }
  splash(pos, up, strength, waterColor) {
    const r = this.rand, v = this._w;
    this._tangent(up);
    const n = Math.round(clamp(strength * 5, 6, 60));
    for (let k = 0; k < n; k++) {
      const a = r.next() * 6.283, s = strength * (0.25 + r.next() * 0.55);
      v.copy(this._t1).multiplyScalar(Math.cos(a) * s * 0.45).addScaledVector(this._t2, Math.sin(a) * s * 0.45).addScaledVector(up, s * (0.8 + r.next()));
      this.emit(pos, v, { kind: 1, size: 0.05 + r.next() * 0.05, size1: 0.04, life: 0.8 + r.next() * 0.6, color: waterColor, alpha: 0.9, drag: 0.3, grav: 1 });
    }
    this.dust(pos, up, waterColor, Math.round(clamp(strength, 3, 14)), strength * 0.3, 0.45, 0.35);
    this.ripple(pos, up, 0.3, 1.6 + strength * 0.25, 1.6);
    this.ripple(pos, up, 0.1, 1.0 + strength * 0.12, 1.2);
  }
  ripple(pos, up, r0, r1, life) {
    const R = this.R, i = R.next;
    R.next = (R.next + 1) % this.RMAX; R.n = Math.min(this.RMAX, R.n + 1);
    R.pos[i * 3] = pos.x - this.origin.x; R.pos[i * 3 + 1] = pos.y - this.origin.y; R.pos[i * 3 + 2] = pos.z - this.origin.z;
    R.up[i * 3] = up.x; R.up[i * 3 + 1] = up.y; R.up[i * 3 + 2] = up.z;
    R.age[i] = 0; R.life[i] = life; R.r0[i] = r0; R.r1[i] = r1;
  }
  footprint(pos, up, forward) {
    const F = this.F, i = F.next;
    F.next = (F.next + 1) % this.FMAX; F.n = Math.min(this.FMAX, F.n + 1);
    F.pos[i * 3] = pos.x - this.origin.x; F.pos[i * 3 + 1] = pos.y - this.origin.y; F.pos[i * 3 + 2] = pos.z - this.origin.z;
    // orientation: +Y = up, -Z(plane) → forward
    const x = this._v.crossVectors(up, forward).normalize();
    const z = this._w.crossVectors(x, up).normalize();
    this._m.makeBasis(x, up, z);
    F.q[i].setFromRotationMatrix(this._m);
    F.age[i] = 0;
  }
  _tangent(up) {
    if (!this._t1) { this._t1 = new THREE.Vector3(); this._t2 = new THREE.Vector3(); }
    this._t1.set(0, 1, 0);
    if (Math.abs(up.y) > 0.9) this._t1.set(1, 0, 0);
    this._t1.cross(up).normalize();
    this._t2.crossVectors(up, this._t1);
  }

  // --------------------------------------------------------------------------- per-frame
  /**
   * @param ctx { dt, up (local), jet: {power, a:{pos,dir}, b:{pos,dir}} , shadow: {pos, up, heights, opacity, size},
   *              trails: {on, a(Vector3), b(Vector3), alpha}, gravity }
   */
  update(dt, ctx) {
    const P = this.P;
    const up = ctx.up;
    const g = ctx.gravity ?? 9.8;
    // particles
    let w = 0;
    const ip = this.iPos.array, iv = this.iVel.array, ic = this.iCol.array, im = this.iMisc.array;
    for (let i = 0; i < P.alive; i++) {
      P.age[i] += dt;
      if (P.age[i] >= P.life[i]) continue;
      const o = i * 3;
      const d = Math.exp(-P.drag[i] * dt);
      P.vel[o] = P.vel[o] * d - up.x * g * P.grav[i] * dt;
      P.vel[o + 1] = P.vel[o + 1] * d - up.y * g * P.grav[i] * dt;
      P.vel[o + 2] = P.vel[o + 2] * d - up.z * g * P.grav[i] * dt;
      P.pos[o] += P.vel[o] * dt; P.pos[o + 1] += P.vel[o + 1] * dt; P.pos[o + 2] += P.vel[o + 2] * dt;
      P.rot[i] += P.spin[i] * dt;
      // compact into slot w (keeps arrays dense)
      if (w !== i) this._move(i, w);
      const t = P.age[w] / P.life[w];
      const ow = w * 3;
      ip[ow] = P.pos[ow]; ip[ow + 1] = P.pos[ow + 1]; ip[ow + 2] = P.pos[ow + 2];
      iv[ow] = P.vel[ow]; iv[ow + 1] = P.vel[ow + 1]; iv[ow + 2] = P.vel[ow + 2];
      const fade = P.kind[w] === 2 ? Math.sin(Math.PI * Math.min(1, t)) : (1 - t) * (1 - t) * Math.min(1, t * 8 + 0.2);
      ic[w * 4] = P.col[ow]; ic[w * 4 + 1] = P.col[ow + 1]; ic[w * 4 + 2] = P.col[ow + 2]; ic[w * 4 + 3] = P.a0[w] * fade;
      im[ow] = P.s0[w] + (P.s1[w] - P.s0[w]) * t; im[ow + 1] = P.kind[w]; im[ow + 2] = P.rot[w];
      w++;
    }
    P.alive = w;
    this.points.geometry.instanceCount = w;
    if (w) { this.iPos.needsUpdate = this.iVel.needsUpdate = this.iCol.needsUpdate = this.iMisc.needsUpdate = true; }

    // ripples
    const R = this.R;
    let rn = 0;
    const rp = this.rPos.array, ru = this.rUp.array, rm = this.rMisc.array;
    for (let i = 0; i < this.RMAX; i++) {
      if (R.life[i] <= 0) continue;
      R.age[i] += dt;
      if (R.age[i] >= R.life[i]) { R.life[i] = 0; continue; }
      const t = R.age[i] / R.life[i];
      rp[rn * 3] = R.pos[i * 3]; rp[rn * 3 + 1] = R.pos[i * 3 + 1]; rp[rn * 3 + 2] = R.pos[i * 3 + 2];
      ru[rn * 3] = R.up[i * 3]; ru[rn * 3 + 1] = R.up[i * 3 + 1]; ru[rn * 3 + 2] = R.up[i * 3 + 2];
      rm[rn * 2] = R.r0[i] + (R.r1[i] - R.r0[i]) * (1 - (1 - t) * (1 - t)); rm[rn * 2 + 1] = (1 - t);
      rn++;
    }
    this.ripples.geometry.instanceCount = rn;
    if (rn) { this.rPos.needsUpdate = this.rUp.needsUpdate = this.rMisc.needsUpdate = true; }

    // footprints
    const F = this.F;
    let fn = 0;
    for (let i = 0; i < this.FMAX && fn < F.n; i++) {
      if (i >= F.n) break;
      F.age[i] += dt;
      const a = clamp(1 - F.age[i] / 40, 0, 1);
      this._v.set(F.pos[i * 3], F.pos[i * 3 + 1], F.pos[i * 3 + 2]);
      this._m.compose(this._v, F.q[i], this._s);
      this.prints.setMatrixAt(fn, this._m);
      this.pAlpha.array[fn] = a;
      fn++;
    }
    this.prints.count = fn;
    if (fn) { this.prints.instanceMatrix.needsUpdate = true; this.pAlpha.needsUpdate = true; }

    // contact shadow
    const sh = ctx.shadow;
    if (sh && sh.opacity > 0.01 && sh.heights) {
      this.shadow.visible = true;
      this.shMat.uniforms.uOpacity.value = sh.opacity;
      const pa = this.shadowGeo.attributes.position;
      const SG = this.SG;
      this._tangent(sh.up);
      const t1 = this._t1, t2 = this._t2;
      for (let j = 0; j < SG; j++) for (let i = 0; i < SG; i++) {
        const x = (i / (SG - 1) - 0.5) * sh.size, y = (0.5 - j / (SG - 1)) * sh.size;
        const q = this._v.copy(sh.pos).addScaledVector(t1, x).addScaledVector(t2, y);
        const gr = sh.heights.groundR(q);
        q.normalize().multiplyScalar(gr + 0.03).sub(this.origin);
        pa.setXYZ(j * SG + i, q.x, q.y, q.z);
      }
      pa.needsUpdate = true;
    } else this.shadow.visible = false;

    // jets (children of the character group are positioned by the caller)
    const jp = ctx.jetPower ?? 0;
    this.jetMat.uniforms.uPower.value = jp;
    for (const j of this.jets) j.visible = jp > 0.02;

    // trails
    const tr = ctx.trails;
    for (let k = 0; k < 2; k++) {
      const T = this.trails[k];
      const on = tr && tr.on;
      T.alpha += ((on ? tr.alpha : 0) - T.alpha) * Math.min(1, dt * 4);
      if (T.alpha < 0.01 && !on) { T.mesh.visible = false; T.n = 0; continue; }
      const src = k === 0 ? tr?.a : tr?.b;
      if (on && src) {
        T.acc += dt;
        if (T.acc > 0.035 || T.n === 0) {
          T.acc = 0;
          T.pts.copyWithin(3, 0, (this.TN - 1) * 3);
          T.pts[0] = src.x - this.origin.x; T.pts[1] = src.y - this.origin.y; T.pts[2] = src.z - this.origin.z;
          T.n = Math.min(this.TN, T.n + 1);
        } else { T.pts[0] = src.x - this.origin.x; T.pts[1] = src.y - this.origin.y; T.pts[2] = src.z - this.origin.z; }
      }
      const pos = T.mesh.geometry.attributes.position.array, aa = T.mesh.geometry.attributes.aA.array;
      const width = 0.05;
      for (let i = 0; i < this.TN; i++) {
        const ii = Math.min(i, T.n - 1);
        const o = ii * 3;
        const x = T.pts[o], y = T.pts[o + 1], z = T.pts[o + 2];
        const wv = width * (1 - i / this.TN);
        pos[i * 6] = x + up.x * wv; pos[i * 6 + 1] = y + up.y * wv; pos[i * 6 + 2] = z + up.z * wv;
        pos[i * 6 + 3] = x - up.x * wv; pos[i * 6 + 4] = y - up.y * wv; pos[i * 6 + 5] = z - up.z * wv;
        const a = T.alpha * (1 - i / (this.TN - 1)) * (i < T.n ? 1 : 0);
        aa[i * 2] = a; aa[i * 2 + 1] = a;
      }
      T.mesh.geometry.attributes.position.needsUpdate = true; T.mesh.geometry.attributes.aA.needsUpdate = true;
      T.mesh.visible = T.n > 1;
    }
    this.group.position.copy(this.origin);
  }

  _move(i, w) {
    const P = this.P;
    for (let k = 0; k < 3; k++) { P.pos[w * 3 + k] = P.pos[i * 3 + k]; P.vel[w * 3 + k] = P.vel[i * 3 + k]; P.col[w * 3 + k] = P.col[i * 3 + k]; }
    P.age[w] = P.age[i]; P.life[w] = P.life[i]; P.s0[w] = P.s0[i]; P.s1[w] = P.s1[i]; P.a0[w] = P.a0[i];
    P.drag[w] = P.drag[i]; P.grav[w] = P.grav[i]; P.kind[w] = P.kind[i]; P.rot[w] = P.rot[i]; P.spin[w] = P.spin[i];
  }

  dispose() {
    this.points.geometry.dispose(); this.pMat.dispose(); this._quad.dispose();
    this.ripples.geometry.dispose(); this.rMat.dispose();
    this.prints.geometry.dispose(); this.fMat.dispose(); this.prints.dispose?.();
    this.shadowGeo.dispose(); this.shMat.dispose();
    this.jetGeo.dispose(); this.jetMat.dispose();
    for (const t of this.trails) t.mesh.geometry.dispose();
    this.trailMat.dispose();
  }
}
