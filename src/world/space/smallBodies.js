// Asteroid belts (Keplerian particle streams, lit by the star) and comets (nucleus, coma,
// straight blue ion tail + curved dusty tail pointing away from the star). OWNED BY THE SPACE TRACK.
import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { orbitPosition } from '../../universe/orbits.js';

const _p = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

const BELT_VERT = /* glsl */ `
attribute vec4 aOrb;     // r (m), phase0, height (m), size (m)
uniform float uMu, uTime;
uniform mat3 uQInv;
uniform vec3 uBodyPos;   // inertial position of the current body
uniform vec3 uCamLocal;
uniform vec3 uSunIll;
uniform vec3 uCol;
uniform float uPixAng, uPR, uBoost;
varying vec3 vCol;
void main(){
  float r = aOrb.x;
  float n = sqrt(uMu / (r * r * r));
  float a = aOrb.y + n * uTime;
  vec3 pi = vec3(r * cos(a), aOrb.z, -r * sin(a));
  vec3 rel = pi - uBodyPos;
  vec3 local = uQInv * rel;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(local, 1.0);
  vec3 toCam = uCamLocal - local;
  float d = length(toCam);
  // phase: star at inertial origin → local direction to the star from the rock
  vec3 toStar = uQInv * normalize(-pi);
  float ph = 0.5 + 0.5 * dot(toStar, toCam / d);
  float cover = (aOrb.w / d) / uPixAng;
  float I = 0.12 / 3.14159 * ph * ph * 3.14159 * cover * cover * uBoost + 0.0025 * uBoost * ph;
  vCol = uCol * uSunIll * I;
  gl_PointSize = clamp(1.6 + cover * 1.5, 1.6, 6.0) * uPR;
  if (I < 0.0004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const BELT_FRAG = /* glsl */ `
varying vec3 vCol;
void main(){
  vec2 p = gl_PointCoord - 0.5;
  float f = exp(-dot(p, p) * 22.0);
  gl_FragColor = vec4(vCol * f, 1.0);
}`;

const TAIL_VERT = /* glsl */ `
attribute vec2 aTS;      // t along (0 head → 1 end), s across (-1..1)
uniform vec3 uHead;      // local
uniform vec3 uAxis;      // local unit (away from the star)
uniform vec3 uBend;      // local unit (curvature direction: trailing the orbit)
uniform float uLen, uCurv, uW0, uW1;
uniform vec3 uCamLocal;
varying vec2 vTS;
varying float vDepthFade;
void main(){
  float t = aTS.x;
  vec3 P = uHead + uAxis * (t * uLen) + uBend * (t * t * uLen * uCurv);
  vec3 tang = normalize(uAxis + uBend * (2.0 * t * uCurv));
  vec3 view = normalize(P - uCamLocal);
  vec3 side = normalize(cross(tang, view));
  float w = mix(uW0, uW1, pow(t, 0.8));
  P += side * aTS.y * w;
  vTS = aTS;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(P, 1.0);
}`;
const TAIL_FRAG = /* glsl */ `
#include <rv_space>
uniform vec3 uCol;
uniform float uI, uKind, uTime, uSeed;
varying vec2 vTS;
void main(){
  float t = vTS.x, s = vTS.y;
  float I;
  if (uKind < 0.5){
    // ion tail: narrow, streamers, disconnection knots
    float str = rv_fbm(vec3(s * 5.0, t * 3.0 - uTime * 0.05, uSeed), 4) * 0.5 + 0.5;
    float core = exp(-s * s * 10.0);
    float rays = pow(str, 2.0) * exp(-s * s * 2.5);
    I = (core * 0.7 + rays * 0.9) * pow(1.0 - t, 1.3) * smoothstep(0.0, 0.03, t);
  } else {
    // dust tail: broad, smooth fan with striae
    float stri = 0.8 + 0.2 * sin(s * 9.0 + t * 14.0 + uSeed) * sin(s * 3.1 - t * 5.0);
    float prof = exp(-pow(s - 0.25 * t, 2.0) * 3.0);
    I = prof * stri * pow(1.0 - t, 1.8) * smoothstep(0.0, 0.04, t);
  }
  gl_FragColor = vec4(uCol * I * uI, 1.0);
}`;

const COMA_VERT = /* glsl */ `
uniform float uSize, uPR;
void main(){
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize * uPR;
}`;
const COMA_FRAG = /* glsl */ `
uniform vec3 uCol;
uniform float uI;
void main(){
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p) * 2.0;
  float I = exp(-r * 7.0) * 1.6 + exp(-r * 2.4) * 0.35;
  I *= 1.0 - smoothstep(0.8, 1.0, r);
  gl_FragColor = vec4(uCol * I * uI, 1.0);
}`;

export class SmallBodies {
  constructor(world, space) {
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'space-small-bodies';
    const q = world.quality || {};
    const ps = q.particleScale ?? 1;
    const sys = world.system;
    this.uQInv = { value: new THREE.Matrix3() };
    this.uBodyPos = { value: new THREE.Vector3() };
    this.uCamLocal = { value: new THREE.Vector3() };
    this.uSunIll = { value: new THREE.Vector3(6, 6, 6) };
    this.uTime = { value: 0 };
    this.uPixAng = { value: 0.001 };
    this.uPR = { value: 1 };
    this.belts = [];
    for (const b of sys.belts || []) {
      const r = new RNG(b.seed >>> 0);
      const n = Math.round(Math.min(b.count, 9000) * Math.min(1.5, ps) * (q.software ? 0.8 : 1));
      const orb = new Float32Array(n * 4);
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        // clumpy radial distribution with Kirkwood-like gaps
        let rr = b.radius + r.gauss(0, b.width * 0.35);
        const gap = Math.sin((rr - b.radius) / b.width * 9.0 + b.seed % 7);
        if (gap > 0.85 && r.chance(0.7)) rr += b.width * 0.08;
        orb[i * 4] = Math.max(rr, b.radius * 0.5);
        orb[i * 4 + 1] = r.range(0, Math.PI * 2);
        orb[i * 4 + 2] = r.gauss(0, b.thickness * 0.4);
        orb[i * 4 + 3] = Math.pow(r.next(), 3) * 18000 + 600;       // rock radius (m), a few giants
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aOrb', new THREE.BufferAttribute(orb, 4));
      const col = b.color ? new THREE.Vector3(b.color.r, b.color.g, b.color.b) : new THREE.Vector3(0.5, 0.45, 0.4);
      const cm = Math.max(col.x, col.y, col.z, 1e-3);
      col.multiplyScalar(1 / cm);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uMu: { value: sys.mu }, uTime: this.uTime, uQInv: this.uQInv, uBodyPos: this.uBodyPos, uCamLocal: this.uCamLocal,
          uSunIll: this.uSunIll, uCol: { value: col }, uPixAng: this.uPixAng, uPR: this.uPR, uBoost: { value: 3.0 * (b.density ?? 1) },
        },
        vertexShader: BELT_VERT, fragmentShader: BELT_FRAG,
        depthTest: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
      });
      mat.userData.noCSM = true;
      const pts = new THREE.Points(g, mat);
      pts.frustumCulled = false;
      pts.renderOrder = -400;
      pts.name = 'space-belt';
      this.group.add(pts);
      this.belts.push({ b, pts, mat });
    }
    // comets
    this.comets = [];
    const tailGeo = (M) => {
      const ts = [], idx = [];
      for (let i = 0; i <= M; i++) { const t = i / M; ts.push(t, -1, t, 1); }
      for (let i = 0; i < M; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('aTS', new THREE.Float32BufferAttribute(ts, 2));
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(ts.length / 2 * 3).fill(0), 3));
      g.setIndex(idx);
      return g;
    };
    for (const c of sys.comets || []) {
      const mk = (kind, col) => {
        const u = {
          uHead: { value: new THREE.Vector3() }, uAxis: { value: new THREE.Vector3(1, 0, 0) }, uBend: { value: new THREE.Vector3(0, 1, 0) },
          uLen: { value: 1e7 }, uCurv: { value: kind ? 0.35 : 0.02 }, uW0: { value: 3e4 }, uW1: { value: 1e6 },
          uCamLocal: this.uCamLocal, uCol: { value: col }, uI: { value: 0.1 }, uKind: { value: kind }, uTime: this.uTime, uSeed: { value: (c.seed % 97) * 0.31 + kind },
        };
        const m = new THREE.ShaderMaterial({
          uniforms: u, vertexShader: TAIL_VERT, fragmentShader: TAIL_FRAG,
          depthTest: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        });
        m.userData.noCSM = true;
        const mesh = new THREE.Mesh(tailGeo(48), m);
        mesh.frustumCulled = false;
        mesh.renderOrder = -300;
        mesh.name = kind ? 'space-comet-dust' : 'space-comet-ion';
        this.group.add(mesh);
        return { mesh, u };
      };
      const ion = mk(0, new THREE.Vector3(0.35, 0.6, 1.0));
      const dust = mk(1, new THREE.Vector3(1.0, 0.88, 0.7));
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
      const cu = { uSize: { value: 12 }, uPR: this.uPR, uCol: { value: new THREE.Vector3(0.75, 1.0, 0.85) }, uI: { value: 1 } };
      const cm = new THREE.ShaderMaterial({ uniforms: cu, vertexShader: COMA_VERT, fragmentShader: COMA_FRAG, depthTest: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending });
      cm.userData.noCSM = true;
      const coma = new THREE.Points(cg, cm);
      coma.frustumCulled = false;
      coma.renderOrder = -299;
      coma.name = 'space-comet-coma';
      this.group.add(coma);
      this.comets.push({ c, ion, dust, coma, cu, head: new THREE.Vector3() });
    }
  }

  update(dt, t, ctx) {
    const w = this.world, cel = w.celestial;
    _m4.makeRotationFromQuaternion(cel.qInv);
    this.uQInv.value.setFromMatrix4(_m4);
    this.uBodyPos.value.copy(cel.bodyPos);
    this.uCamLocal.value.copy(ctx.camLocal);
    this.uSunIll.value.copy(ctx.sunIll);
    this.uTime.value = t;
    this.uPixAng.value = ctx.pixAng;
    this.uPR.value = ctx.pixelRatio;
    for (const k of this.comets) {
      const c = k.c;
      orbitPosition(c.orbit, t, _p, _vel);
      const r = Math.max(_p.length(), 1);
      const act = THREE.MathUtils.clamp(Math.pow(2.6e8 / r, 1.4), 0.12, 2.2);
      cel.toLocal(_p, k.head);
      const axis = cel.toLocalDir(_v.copy(_p).multiplyScalar(1 / r), k.ion.u.uAxis.value);
      const vdir = cel.toLocalDir(_vel.normalize(), _v);
      // dust tail curves back along the orbit (trailing the motion)
      const bend = k.dust.u.uBend.value.copy(vdir).multiplyScalar(-1).addScaledVector(axis, -_v.dot(axis) * -1).normalize();
      k.dust.u.uAxis.value.copy(axis);
      const len = Math.min(r * 0.4, 7e7) * Math.sqrt(act);
      const dist = Math.max(k.head.distanceTo(ctx.camLocal), 1);
      const angSize = len / dist;
      const vis = angSize > 0.002 ? 1 : 0;
      const bright = Math.min(act, 1.5) * ctx.sunIll.x / 6;
      for (const tl of [k.ion, k.dust]) {
        tl.u.uHead.value.copy(k.head);
        tl.u.uLen.value = tl === k.ion ? len * 1.25 : len * 0.8;
        tl.u.uW0.value = Math.max(len * 0.004, 2000);
        tl.u.uW1.value = len * (tl === k.ion ? 0.035 : 0.12);
        tl.u.uI.value = (tl === k.ion ? 0.22 : 0.3) * bright;
        tl.mesh.visible = !!vis;
      }
      k.coma.position.copy(k.head);
      const comaPx = (len * 0.01 / dist) / ctx.pixAng;
      k.cu.uSize.value = THREE.MathUtils.clamp(comaPx * 6, 5, 90);
      k.cu.uI.value = 0.9 * bright;
      k.coma.visible = !!vis;
    }
  }

  dispose() {
    for (const b of this.belts) { b.pts.geometry.dispose(); b.mat.dispose(); }
    for (const k of this.comets) {
      for (const tl of [k.ion, k.dust]) { tl.mesh.geometry.dispose(); tl.mesh.material.dispose(); }
      k.coma.geometry.dispose(); k.coma.material.dispose();
    }
  }
}
