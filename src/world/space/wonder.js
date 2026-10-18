// Cosmic & Otherworldly sky phenomena — rare events on a few worlds. OWNED BY THE SPACE TRACK.
//
//   halo   a ring of light hanging in a pale sky, a single thread of light falling from it to the ground
//   orb    a black orb with a thin blazing ring, pouring a pillar of light onto the land (a pool of light below)
//   + fragments: slabs of the land coming gently apart, drifting slowly upward around the foot of the wonder
//
// Chosen per world from its art direction (Tarkovsky / Friedrich / Annihilation → halo; Beksiński /
// Villeneuve / Kubrick → orb) or rarely by seed; `?wonder=halo|orb|off` overrides. The site is a dry-land
// point (terrain landmarks when that track exposes them, else seeded). Everything is real geometry at
// planet-local positions (aerial perspective applies: the wonder fades into haze with distance), drawn
// additively with depth test so terrain hides it. Visible from tens of kilometres: the world's luminous landmark.
import * as THREE from 'three';
import { RNG, hashCombine } from '../../core/rng.js';
import { latLonToDir } from '../../core/math.js';

const HALO_ARTS = ['tarkovsky', 'friedrich', 'crystal'];
const ORB_ARTS = ['beksinski', 'villeneuve'];
const MONO_ARTS = ['kubrick'];

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vW;
void main(){
  vUv = uv * 2.0 - 1.0;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// ring of light (unit radius = 1/1.35 of the quad half-size)
const RING_FRAG = /* glsl */ `
#include <rv_common>
uniform vec3 uCol;
uniform float uI, uTime, uPx;     // uPx: quad half-size in pixels (line width control)
uniform float uGap;               // 1: broken arc (halo), 0: full ring (orb rim)
varying vec2 vUv;
void main(){
  vec2 p = vUv * 1.35;
  float r = length(p);
  float a = atan(p.y, p.x);
  float w = max(2.2 / max(uPx, 1.0), 0.007);          // ≥ ~2 px core
  float d = abs(r - 1.0);
  float core = exp(-d * d / (w * w));
  float glow = exp(-d / (0.03 + w)) * 0.45 + exp(-d / 0.18) * 0.1;
  // brightness travels around the ring; the halo is a broken arc (one side dissolves)
  float travel = 0.75 + 0.25 * sin(a * 3.0 - uTime * 0.35) * sin(a * 1.0 + uTime * 0.11);
  float arc = mix(1.0, smoothstep(-0.95, 0.2, sin(a - 2.3)) * 0.92 + 0.08, uGap);
  float flick = 0.94 + 0.06 * sin(uTime * 2.1 + a * 7.0);
  vec3 c = uCol * uI * (core * 1.0 + glow) * travel * arc * flick;
  c += vec3(1.0, 0.9, 0.75) * uI * core * core * mix(0.12, 0.35, uGap) * arc;   // white-hot centre of the line
  gl_FragColor = vec4(c, 1.0);
}`;

// pillar / thread of light (vertical cylindrical billboard): x across [-1, 1], y along [0 = ground, 1 = top]
const BEAM_FRAG = /* glsl */ `
#include <rv_common>
#include <rv_noise>
uniform vec3 uCol;
uniform float uI, uTime, uFlow, uSoft;
varying vec2 vUv;
void main(){
  float x = vUv.x;
  float y = vUv.y * 0.5 + 0.5;
  float core = exp(-x * x / (uSoft * uSoft));
  float halo = exp(-abs(x) * 3.0) * 0.18;
  float n = rv_fbm(vec3(x * 3.0, y * 9.0 + uTime * uFlow, 0.7), 4) * 0.5 + 0.5;
  float n2 = rv_fbm(vec3(x * 7.0 + 3.0, y * 22.0 + uTime * uFlow * 1.7, 2.1), 3) * 0.5 + 0.5;
  float body = core * (0.55 + 0.6 * n * n2 * 1.6) + halo * n;
  float ends = smoothstep(0.0, 0.03, y) * smoothstep(1.0, 0.94, y);
  vec3 c = mix(uCol, vec3(1.0, 0.92, 0.75), core * core * 0.45) * uI * body * ends;
  gl_FragColor = vec4(max(c, 0.0), 1.0);
}`;

// pool of light where the pillar meets the land
const POOL_FRAG = /* glsl */ `
#include <rv_common>
#include <rv_noise>
uniform vec3 uCol;
uniform float uI, uTime;
varying vec2 vUv;
void main(){
  float r = length(vUv);
  float n = rv_fbm(vec3(vUv * 4.0, uTime * 0.05), 3) * 0.5 + 0.5;
  float g = exp(-r * r * 9.0) * 1.2 + exp(-r * 4.0) * 0.25 * n;
  g *= 1.0 - smoothstep(0.85, 1.0, r);
  gl_FragColor = vec4(uCol * uI * g, 1.0);
}`;

function additive(frag, uniforms) {
  const m = new THREE.ShaderMaterial({
    uniforms, vertexShader: QUAD_VERT, fragmentShader: frag,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  m.userData.noCSM = true;
  return m;
}

/** Which wonder (if any) this body gets. */
export function pickWonder(body, params) {
  const p = params?.wonder;
  if (p === 'off' || p === '0' || p === 'none') return null;
  if (p === 'halo' || p === 'orb' || p === 'monolith') return p;
  if (body.isGas) return null;
  const key = body.art?.key;
  if (HALO_ARTS.includes(key)) return 'halo';
  if (ORB_ARTS.includes(key)) return 'orb';
  if (MONO_ARTS.includes(key)) return 'monolith';
  const r = new RNG(hashCombine(body.seed >>> 0, 0x40d3));
  if (!(body.life?.flora > 0.1) && !body.atmosphere?.present) return null;
  return r.chance(0.1) ? (r.chance(0.5) ? 'halo' : 'orb') : null;
}

export class Wonder {
  constructor(world, kind) {
    this.world = world;
    this.kind = kind;
    const b = world.body;
    const R = b.radius;
    const surf = world.surface;
    const r = new RNG(hashCombine(b.seed >>> 0, 0x40d4));
    this.group = new THREE.Group();
    this.group.name = 'space-wonder';
    // ---- site: terrain landmark → else seeded, searched for dry land
    let lat = r.range(-40, 40), lon = r.range(-180, 180);
    const lm = world.get?.('terrain')?.landmarks;
    const sacred = lm?.sacred?.[0];
    if (sacred && Number.isFinite(sacred.lat)) { lat = sacred.lat; lon = sacred.lon; }
    const dir = new THREE.Vector3();
    const sea = surf && Number.isFinite(surf.seaLevel) ? surf.seaLevel : -Infinity;
    const hAt = (d) => { try { return surf ? surf.height(d.x, d.y, d.z) : 0; } catch (_) { return 0; } };
    let best = null;
    for (let k = 0; k < 64 && surf; k++) {
      const la = lat + (k ? r.range(-25, 25) : 0), lo = lon + (k ? r.range(-40, 40) : 0);
      latLonToDir(la, lo, dir);
      const h = hAt(dir);
      if (h > sea + 15) { best = { la, lo, h }; break; }
    }
    if (best) { lat = best.la; lon = best.lo; }
    latLonToDir(lat, lon, dir);
    this.lat = lat; this.lon = lon;
    this.dir = dir.clone();
    this.groundH = Math.max(hAt(dir), Number.isFinite(sea) ? sea : -1e9);
    const hScale = THREE.MathUtils.clamp(R * 0.12, 3500, 9000);
    this.height = hScale;
    this.base = dir.clone().multiplyScalar(R + this.groundH);
    this.up = dir.clone();
    this.time = 0;
    const pal = b.art?.palette || {};
    if (kind === 'halo') this._buildHalo(hScale, pal);
    else if (kind === 'monolith') this._buildMonolith(hScale);
    else this._buildOrb(hScale, pal);
    this._buildFragments(r, hScale);
    world.root.add(this.group);
  }

  _buildHalo(h, pal) {
    this.ringR = h * 0.36;
    this.centre = this.base.clone().addScaledVector(this.up, h * 0.52);
    const col = new THREE.Color(1.0, 0.9, 0.72);
    this.ringU = { uCol: { value: col }, uI: { value: 9 }, uTime: { value: 0 }, uPx: { value: 100 }, uGap: { value: 1 } };
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), additive(RING_FRAG, this.ringU));
    this.ring.scale.setScalar(this.ringR * 1.35);
    this.ring.frustumCulled = false; this.ring.renderOrder = 6; this.ring.userData.noCSM = true;
    this.ring.position.copy(this.centre);
    this.group.add(this.ring);
    // a single thread of light down to the ground
    this.beamU = { uCol: { value: new THREE.Color(1.0, 0.93, 0.8) }, uI: { value: 4.5 }, uTime: { value: 0 }, uFlow: { value: -0.6 }, uSoft: { value: 0.22 } };
    this.beam = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), additive(BEAM_FRAG, this.beamU));
    this.beamW = Math.max(10, h * 0.005);
    this.beamTop = h * 0.52 - this.ringR;
    this.beam.frustumCulled = false; this.beam.renderOrder = 6; this.beam.userData.noCSM = true;
    this.group.add(this.beam);
    this._buildPool(h * 0.04, new THREE.Color(1.0, 0.9, 0.75), 1.4);
  }

  _buildOrb(h, pal) {
    this.orbR = h * 0.16;
    this.centre = this.base.clone().addScaledVector(this.up, h * 0.82);
    // the black orb (writes depth, pure black: it hides the sky and the ring behind it)
    const om = new THREE.MeshBasicMaterial({ color: 0x000000 });
    om.userData.noCSM = true;
    this.orb = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 40), om);
    this.orb.scale.setScalar(this.orbR);
    this.orb.position.copy(this.centre);
    this.orb.userData.noCSM = true;
    this.group.add(this.orb);
    const hot = new THREE.Color(1.0, 0.42, 0.08);
    this.ringU = { uCol: { value: hot }, uI: { value: 5.5 }, uTime: { value: 0 }, uPx: { value: 100 }, uGap: { value: 0 } };
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), additive(RING_FRAG, this.ringU));
    this.ring.scale.setScalar(this.orbR * 1.35);
    this.ring.frustumCulled = false; this.ring.renderOrder = 6; this.ring.userData.noCSM = true;
    this.ring.position.copy(this.centre);
    this.group.add(this.ring);
    // pillar of light pouring from the orb to the land
    this.beamU = { uCol: { value: new THREE.Color(1.0, 0.5, 0.12) }, uI: { value: 4.5 }, uTime: { value: 0 }, uFlow: { value: 1.3 }, uSoft: { value: 0.32 } };
    this.beam = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), additive(BEAM_FRAG, this.beamU));
    this.beamW = this.orbR * 0.32;
    this.beamTop = h * 0.82 - this.orbR * 0.9;
    this.beam.frustumCulled = false; this.beam.renderOrder = 6; this.beam.userData.noCSM = true;
    this.group.add(this.beam);
    this._buildPool(this.orbR * 1.6, new THREE.Color(1.0, 0.55, 0.2), 2.4);
  }

  // the monolith: a featureless black slab (1 : 4 : 9) hanging over the land, one line of light down its edge
  // and a single thread of light falling from it to the ground
  _buildMonolith(h) {
    const H = h * 0.42;
    this.centre = this.base.clone().addScaledVector(this.up, h * 0.62);
    const sm = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.18, metalness: 0.6 });
    this.slab = new THREE.Mesh(new THREE.BoxGeometry(H / 9 * 4, H, H / 9), sm);
    this.slab.position.copy(this.centre);
    this.e1 = new THREE.Vector3().crossVectors(this.up, Math.abs(this.up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const e2 = new THREE.Vector3().crossVectors(this.e1, this.up);
    this.slab.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(this.e1, this.up, e2));
    this.group.add(this.slab);
    // its rim line: a thin vertical ring quad replaced by a beam along one edge
    this.ringU = { uCol: { value: new THREE.Color(1, 1, 1) }, uI: { value: 0 }, uTime: { value: 0 }, uPx: { value: 100 }, uGap: { value: 0 } };
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), additive(RING_FRAG, this.ringU));
    this.ring.visible = false;
    this.ring.position.copy(this.centre);
    this.group.add(this.ring);
    this.edgeU = { uCol: { value: new THREE.Color(1.0, 0.95, 0.85) }, uI: { value: 9 }, uTime: { value: 0 }, uFlow: { value: 0.2 }, uSoft: { value: 0.12 } };
    this.edge = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), additive(BEAM_FRAG, this.edgeU));
    this.edge.frustumCulled = false; this.edge.renderOrder = 6; this.edge.userData.noCSM = true;
    this.edgeOff = H / 9 * 2;
    this.edgeH = H;
    this.group.add(this.edge);
    this.beamU = { uCol: { value: new THREE.Color(1.0, 0.95, 0.88) }, uI: { value: 2.5 }, uTime: { value: 0 }, uFlow: { value: -0.4 }, uSoft: { value: 0.18 } };
    this.beam = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), additive(BEAM_FRAG, this.beamU));
    this.beamW = Math.max(5, h * 0.002);
    this.beamTop = h * 0.62 - H * 0.5;
    this.beam.frustumCulled = false; this.beam.renderOrder = 6; this.beam.userData.noCSM = true;
    this.group.add(this.beam);
    this._buildPool(h * 0.03, new THREE.Color(1.0, 0.95, 0.88), 1.2);
  }

  _buildPool(rad, col, I) {
    this.poolU = { uCol: { value: col }, uI: { value: I }, uTime: { value: 0 } };
    this.pool = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), additive(POOL_FRAG, this.poolU));
    this.pool.scale.setScalar(rad);
    this.pool.position.copy(this.base).addScaledVector(this.up, 3);
    this.pool.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.up);
    this.pool.frustumCulled = false; this.pool.renderOrder = 5; this.pool.userData.noCSM = true;
    this.group.add(this.pool);
  }

  _buildFragments(r, h) {
    const q = this.world.quality || {};
    const n = Math.round(THREE.MathUtils.clamp(110 * (q.particleScale ?? 1), 24, 140));
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.06, 0.055, 0.05), roughness: 0.92, metalness: 0.0 });
    this.frag = new THREE.InstancedMesh(geo, mat, n);
    this.frag.frustumCulled = false;
    this.frag.name = 'space-wonder-fragments';
    this.fr = [];
    const spread = this.kind === 'orb' ? this.orbR * 3.5 : h * 0.6;
    for (let i = 0; i < n; i++) {
      const a = r.range(0, Math.PI * 2), d = spread * Math.sqrt(r.range(0.04, 1));
      const s = Math.pow(r.next(), 2.4) * 110 + 6;
      this.fr.push({
        a, d, s, sx: s * r.range(0.6, 1.6), sy: s * r.range(0.25, 0.8), sz: s * r.range(0.6, 1.4),
        speed: r.range(3.0, 9.0) * (60 / (s + 40)), phase: r.next(), top: h * r.range(0.3, 0.9),
        ax: new THREE.Vector3(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize(), spin: r.range(0.02, 0.12),
      });
    }
    // tangent frame at the site
    this.t1 = new THREE.Vector3().crossVectors(this.up, Math.abs(this.up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    this.t2 = new THREE.Vector3().crossVectors(this.up, this.t1);
    // each fragment lifts off from the real ground below it
    const surf = this.world.surface, R = this.world.body.radius;
    const sea = surf && Number.isFinite(surf.seaLevel) ? surf.seaLevel : -1e9;
    const dv = new THREE.Vector3();
    for (const f of this.fr) {
      dv.copy(this.base).addScaledVector(this.t1, Math.cos(f.a) * f.d).addScaledVector(this.t2, Math.sin(f.a) * f.d).normalize();
      let gh = 0;
      try { gh = surf ? surf.height(dv.x, dv.y, dv.z) : 0; } catch (_) { gh = 0; }
      f.lift = Math.max(gh, sea) + R - this.base.length();      // ground offset relative to the site base
    }
    this.group.add(this.frag);
    this._m = new THREE.Matrix4(); this._p = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3();
    this._updateFragments(0);
  }

  _updateFragments(t) {
    const m = this._m, p = this._p, qq = this._q, sc = this._s;
    for (let i = 0; i < this.fr.length; i++) {
      const f = this.fr[i];
      const cyc = f.top / f.speed;                            // seconds per rise
      const u = ((t / cyc) + f.phase) % 1;
      const hgt = u * f.top;
      const grow = THREE.MathUtils.smoothstep(u, 0.0, 0.06) * (1 - THREE.MathUtils.smoothstep(u, 0.82, 1.0));
      const drift = 1 + u * 0.35;                             // spreads a little as it rises
      p.copy(this.base).addScaledVector(this.t1, Math.cos(f.a) * f.d * drift).addScaledVector(this.t2, Math.sin(f.a) * f.d * drift).addScaledVector(this.up, (f.lift || 0) + hgt - f.sy * 0.5);
      qq.setFromAxisAngle(f.ax, t * f.spin + f.phase * 6.28);
      sc.set(f.sx * grow + 1e-3, f.sy * grow + 1e-3, f.sz * grow + 1e-3);
      m.compose(p, qq, sc);
      this.frag.setMatrixAt(i, m);
    }
    this.frag.instanceMatrix.needsUpdate = true;
  }

  update(dt, t, ctx) {
    this.time = t;
    const cam = this.world.camera;
    const camL = ctx.camLocal;
    // camera-facing halo / rim (an impossible object: it is a circle from anywhere), tilted back a little
    const toCam = _a.copy(camL).sub(this.centre);
    const dist = Math.max(toCam.length(), 1);
    toCam.divideScalar(dist);
    this.ring.quaternion.setFromUnitVectors(_z, toCam);
    const halfPx = (this.ring.scale.x / dist) / Math.max(ctx.pixAng, 1e-6);
    this.ringU.uPx.value = halfPx;
    this.ringU.uTime.value = t;
    // the beam: vertical, rotated about the local up to face the camera
    const top = this.beamTop;
    const mid = _b.copy(this.base).addScaledVector(this.up, top * 0.5);
    const side = _c.copy(camL).sub(mid);
    side.addScaledVector(this.up, -side.dot(this.up));
    if (side.lengthSq() < 1e-6) side.copy(this.t1);
    side.normalize();
    const xAxis = _d.crossVectors(this.up, side).normalize();
    _mm.makeBasis(xAxis, this.up, side);
    this.beam.quaternion.setFromRotationMatrix(_mm);
    this.beam.position.copy(mid);
    this.beam.scale.set(this.beamW, top * 0.5, 1);
    this.beamU.uTime.value = t;
    this.poolU.uTime.value = t;
    if (this.edge) {
      // one line of light down the slab's edge (camera-facing about the local up)
      const sg = _c.copy(camL).sub(this.centre).dot(this.e1) >= 0 ? 1 : -1;      // the edge on the camera's side
      const em = _b.copy(this.centre).addScaledVector(this.e1, sg * this.edgeOff * 1.01);
      this.edge.position.copy(em);
      this.edge.quaternion.copy(this.beam.quaternion);
      this.edge.scale.set(Math.max(2.5, this.edgeH * 0.006), this.edgeH * 0.5, 1);
      this.edgeU.uTime.value = t;
    }
    // fade the whole wonder from orbit (it belongs to the land)
    const alt = camL.length() - this.world.body.radius;
    const vis = 1 - THREE.MathUtils.smoothstep(alt, this.height * 4, this.height * 12);
    this.group.visible = vis > 0.01;
    if (this.frag && dist < this.height * 30) this._updateFragments(t);
    void cam;
  }

  /** Planet-local aim point (for look('wonder')). */
  target(out) { return out.copy(this.centre); }

  state() { return { kind: this.kind, lat: +this.lat.toFixed(2), lon: +this.lon.toFixed(2), height: Math.round(this.height) }; }

  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.group.removeFromParent();
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _mm = new THREE.Matrix4();
