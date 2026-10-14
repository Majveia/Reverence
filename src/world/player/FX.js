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
    // soft gaussian core with smooth value-noise breakup (wispy edges, no hard disc)
    vec2 g = vUv * 3.0 + vec2(vCol.a * 17.0, vCol.a * 5.0);
    vec2 gi = floor(g), gf = fract(g); gf = gf * gf * (3.0 - 2.0 * gf);
    float n = mix(mix(rv_hash12(gi), rv_hash12(gi + vec2(1.0, 0.0)), gf.x), mix(rv_hash12(gi + vec2(0.0, 1.0)), rv_hash12(gi + vec2(1.0, 1.0)), gf.x), gf.y);
    a = min(1.0, exp(-r * r * 2.2) * smoothstep(1.0, 0.5, r) * (0.75 + 0.8 * n) * 1.25);
    float lit = 0.55 + 0.45 * clamp(dot(vWorldN, uSunDir), 0.0, 1.0);
    col = col * (uSunColor * 0.5 * lit + uAmbientSky * 0.9 + 0.02);
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
          // two thin concentric crests with a darker trough inside each (reads as a wave, not a disc)
          float c1 = exp(-pow((d - 0.94) / 0.025, 2.0)), c2 = exp(-pow((d - 0.72) / 0.02, 2.0)) * 0.55;
          float tr = exp(-pow((d - 0.88) / 0.035, 2.0)) * 0.5;
          float a = (c1 + c2) * vM.y * vM.y;
          float ad = tr * vM.y * vM.y;
          if (a + ad < 0.004) discard;
          vec3 hi = uSunColor * 0.25 + uAmbientSky * 1.1 + 0.05;
          gl_FragColor = vec4(hi * a / max(a + ad, 1e-4), (a * 0.1 + ad * 0.05));
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
    // ---------------- swim wake: foam collar at the waterline around the body + Kelvin V-wake arms +
    // transverse chevrons + kick-foam trail, one plane in the swimmer's frame (x lateral, y behind)
    {
      const wg = new THREE.PlaneGeometry(1, 1);
      this.wakeMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
        uniforms: { uTime: G.uTime, uSunColor: G.uSunColor, uAmbientSky: G.uAmbientSky, uSpeed: { value: 0 }, uAlpha: { value: 0 } },
        vertexShader: /* glsl */`varying vec2 vP;
          void main(){ vP = vec2(position.x * 7.0, (0.5 - position.y) * 9.0 - 1.6); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
          uniform float uTime; uniform vec3 uSunColor; uniform vec3 uAmbientSky; uniform float uSpeed; uniform float uAlpha;
          varying vec2 vP;
          float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
          void main(){
            vec2 p = vP;                       // metres: x lateral, y behind the chest (+)
            float t = uTime;
            float mv = clamp(uSpeed / 3.0, 0.0, 1.0);
            // foam collar hugging the body outline at the waterline (body lies along +y when crawling)
            vec2 bc = p - vec2(0.0, mix(0.0, 0.5, mv));
            float e = length(bc / vec2(mix(0.42, 0.36, mv), mix(0.42, 1.05, mv)));
            float n1 = vn(p * 7.0 + vec2(0.0, t * 1.5 * (0.3 + mv))) * 0.6 + vn(p * 17.0 - vec2(t * 0.7, 0.0)) * 0.4;
            float collar = smoothstep(1.45, 1.0, e) * smoothstep(0.82, 1.0, e) * (0.45 + 0.75 * n1);
            // Kelvin arms (19.5 deg) from the head
            float yb = p.y + 0.15;
            float arm = abs(abs(p.x) - max(yb, 0.0) * 0.36);
            float aw = 0.03 + max(yb, 0.0) * 0.03;
            float armA = smoothstep(aw, 0.0, arm) * smoothstep(0.0, 0.5, yb) * exp(-max(yb, 0.0) * 0.55) * (0.35 + 0.8 * n1);
            // transverse chevrons between the arms
            float inside = smoothstep(0.08, -0.08, abs(p.x) - max(yb, 0.0) * 0.36) * step(0.0, yb);
            float tr = pow(0.5 + 0.5 * sin((yb + abs(p.x) * 0.4) * 10.0 - t * 7.0), 3.0) * inside * exp(-max(yb, 0.0) * 0.55);
            // churned kick foam behind the feet
            float kick = smoothstep(0.3, 0.0, abs(p.x) + (n1 - 0.5) * 0.25) * smoothstep(1.1, 1.7, yb) * exp(-max(yb - 1.7, 0.0) * 1.1) * n1 * n1;
            float a = collar * 0.42 + (armA * 0.2 + tr * 0.06 + kick * 0.3) * mv;
            a *= uAlpha * smoothstep(3.4, 2.6, abs(p.x)) * smoothstep(7.2, 5.5, p.y) * smoothstep(-1.6, -1.2, p.y);
            if (a < 0.004) discard;
            gl_FragColor = vec4(uSunColor * 0.06 + uAmbientSky * 0.7 + 0.02, min(a, 0.6));
          }`,
      });
      this.wake = new THREE.Mesh(wg, this.wakeMat);
      this.wake.frustumCulled = false; this.wake.visible = false; this.wake.renderOrder = 6;
      this.group.add(this.wake);
      this._wakeA = 0;
    }
    // ---------------- slide groove: a carved furrow ribbon conformed to the ground, fades over ~3 s
    {
      this.GN = 48;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.GN * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aA', new THREE.BufferAttribute(new Float32Array(this.GN * 2), 1).setUsage(THREE.DynamicDrawUsage));
      const uv = new Float32Array(this.GN * 4);
      for (let i = 0; i < this.GN; i++) { uv[i * 4] = i; uv[i * 4 + 1] = 0; uv[i * 4 + 2] = i; uv[i * 4 + 3] = 1; }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      const idx = [];
      for (let i = 0; i < this.GN - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      g.setIndex(idx);
      this.grooveMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
        uniforms: { uCol: { value: new THREE.Color(1, 0.9, 0.75) }, uSunColor: G.uSunColor, uAmbientSky: G.uAmbientSky },
        vertexShader: /* glsl */`attribute float aA; varying float vA; varying vec2 vUv; void main(){ vA = aA; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`uniform vec3 uCol; uniform vec3 uSunColor; uniform vec3 uAmbientSky; varying float vA; varying vec2 vUv;
          float h(float x){ return fract(sin(x * 91.7) * 4375.85); }
          void main(){
            float x = vUv.y * 2.0 - 1.0;
            float groove = smoothstep(0.75, 0.0, abs(x));                 // shaded trough
            float lip = smoothstep(0.55, 0.8, abs(x)) * smoothstep(1.0, 0.85, abs(x)); // thrown-up lips catch light
            float streak = 0.75 + 0.25 * h(floor(x * 9.0) + 3.0);
            vec3 lit = uCol * (uSunColor * 0.35 + uAmbientSky * 0.6);
            vec3 c = mix(vec3(0.0), lit, lip / max(lip + groove * 0.7, 1e-3));
            float a = (groove * 0.2 * streak + lip * 0.22) * vA;
            if (a < 0.004) discard;
            gl_FragColor = vec4(c, a);
          }`,
      });
      this.groove = { mesh: new THREE.Mesh(g, this.grooveMat), pts: new Float64Array(this.GN * 3), lat: new Float32Array(this.GN * 3), age: new Float32Array(this.GN), n: 0, acc: 0 };
      this.groove.mesh.frustumCulled = false; this.groove.mesh.visible = false; this.groove.mesh.renderOrder = 4;
      this.group.add(this.groove.mesh);
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
    { const gp = this.groove.pts; for (let i = 0; i < this.GN; i++) { gp[i * 3] -= d.x; gp[i * 3 + 1] -= d.y; gp[i * 3 + 2] -= d.z; } }
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
  spray(pos, dir, up, color, count, speed, kind = 0, size = 0.18, alpha = 0) {
    const r = this.rand, v = this._w;
    this._tangent(up);
    for (let k = 0; k < count; k++) {
      v.copy(dir).multiplyScalar(speed * (0.5 + r.next() * 0.7))
        .addScaledVector(up, speed * (0.35 + r.next() * 0.5))
        .addScaledVector(this._t1, (r.next() - 0.5) * speed * 0.6).addScaledVector(this._t2, (r.next() - 0.5) * speed * 0.6);
      this.emit(pos, v, { kind, size: size * (0.6 + r.next() * 0.8), size1: kind === 0 ? size * 3 : size * 0.8, life: 0.6 + r.next() * 0.7, color, alpha: alpha || (kind === 0 ? 0.45 : 0.85), drag: kind === 0 ? 1.8 : 0.4, grav: kind === 0 ? 0.3 : 1 });
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
    // swim wake
    const wk = ctx.wake;
    this._wakeA += ((wk && wk.on ? wk.alpha : 0) - this._wakeA) * Math.min(1, dt * 3);
    if (this._wakeA > 0.01 && wk) {
      const m = this.wake;
      m.visible = true;
      this.wakeMat.uniforms.uAlpha.value = this._wakeA;
      this.wakeMat.uniforms.uSpeed.value = wk.speed;
      // plane local: +x lateral (7 m), +y ahead (9 m); centre 2.9 m behind the chest
      const f = this._n.copy(wk.fwd); f.addScaledVector(wk.up, -f.dot(wk.up)).normalize();
      const x = this._w.crossVectors(f, wk.up).normalize();
      this._m.makeBasis(x, f, wk.up);
      m.quaternion.setFromRotationMatrix(this._m);
      m.scale.set(7, 9, 1);
      m.position.copy(wk.pos).addScaledVector(f, -2.9).addScaledVector(wk.up, 0.025).sub(this.origin);
    } else this.wake.visible = false;
    // slide groove
    const gv = this.groove, gc = ctx.groove;
    if (gc && gc.on) {
      gv.acc += dt;
      if (gv.acc > 0.06 || gv.n === 0) {
        gv.acc = 0;
        gv.pts.copyWithin(3, 0, (this.GN - 1) * 3); gv.lat.copyWithin(3, 0, (this.GN - 1) * 3); gv.age.copyWithin(1, 0, this.GN - 1);
        gv.n = Math.min(this.GN, gv.n + 1);
      }
      gv.pts[0] = gc.pos.x - this.origin.x; gv.pts[1] = gc.pos.y - this.origin.y; gv.pts[2] = gc.pos.z - this.origin.z;
      gv.lat[0] = gc.lat.x; gv.lat[1] = gc.lat.y; gv.lat[2] = gc.lat.z; gv.age[0] = 0;
      this.grooveMat.uniforms.uCol.value.copy(gc.color);
    }
    if (gv.n > 1) {
      for (let i = 0; i < gv.n; i++) gv.age[i] += dt;
      const pos = gv.mesh.geometry.attributes.position.array, aa = gv.mesh.geometry.attributes.aA.array;
      let any = false;
      for (let i = 0; i < this.GN; i++) {
        const ii = Math.min(i, gv.n - 1), o = ii * 3;
        const wv = 0.2 + 0.06 * Math.min(1, gv.age[ii]);
        pos[i * 6] = gv.pts[o] + gv.lat[o] * wv; pos[i * 6 + 1] = gv.pts[o + 1] + gv.lat[o + 1] * wv; pos[i * 6 + 2] = gv.pts[o + 2] + gv.lat[o + 2] * wv;
        pos[i * 6 + 3] = gv.pts[o] - gv.lat[o] * wv; pos[i * 6 + 4] = gv.pts[o + 1] - gv.lat[o + 1] * wv; pos[i * 6 + 5] = gv.pts[o + 2] - gv.lat[o + 2] * wv;
        const a = i < gv.n ? clamp(1 - gv.age[ii] / 3, 0, 1) * Math.min(1, i * 0.5) : 0;
        if (a > 0) any = true;
        aa[i * 2] = a; aa[i * 2 + 1] = a;
      }
      gv.mesh.geometry.attributes.position.needsUpdate = true; gv.mesh.geometry.attributes.aA.needsUpdate = true;
      gv.mesh.visible = any;
      if (!any && !(gc && gc.on)) gv.n = 0;
    } else gv.mesh.visible = false;
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
    this.wake.geometry.dispose(); this.wakeMat.dispose();
    this.groove.mesh.geometry.dispose(); this.grooveMat.dispose();
  }
}
