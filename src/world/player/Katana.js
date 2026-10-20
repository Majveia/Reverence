// Player track — the katana: model (blade, tsuba, wrapped hilt, black lacquered scabbard with gold flecks), the
// draw / cut / iaido / sheathe state machine, blade trails of light, the cosmic glow along the edge, and the cut
// itself (petals and leaves flying, `player:slash` for flora / fauna / terrain to react).
//
// Frames: the sword's local frame has its origin at the tsuba, +Y along the blade, +Z toward the edge (the hilt
// runs down −Y). The scabbard shares it (mouth at the origin). Both are children of the explorer group and get
// their group-space transforms from the Animator (_swordSolve). Trails live in planet-local space (re-centred).
//
// Controls (Player feeds them in): draw / sheathe = G or gamepad Y; cut = primary (mouse / RB) — a tap while
// sheathed draws with a cut; hold primary = the iaido stance, release = the flash cut (sheathed: a slow sheathe and
// a click follow). Events: player:draw {drawn}, player:slash {pos, dir, radius, kind}.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ACTS } from './SwordAnim.js';
import { patchLighting } from './Explorer.js';
import { clamp, smoothstep, lerp, dampF } from './util.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion();
const _col = new THREE.Color();
const BLADE_L = 0.74, BLADE_Y0 = 0.03;

function hiltTexture() {
  const W = 64, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#e8e0cc'; ctx.fillRect(0, 0, W, H);          // samegawa (ray skin) under the wrap
  ctx.fillStyle = '#101014';
  // tsuka-ito: crossing silk bands leave a row of diamonds
  const step = 32;
  for (let y = -step; y < H + step; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y + step * 0.95); ctx.lineTo(W, y + step * 0.95 + 13); ctx.lineTo(0, y + 13); ctx.fill();
    ctx.beginPath(); ctx.moveTo(W, y); ctx.lineTo(0, y + step * 0.95); ctx.lineTo(0, y + step * 0.95 + 13); ctx.lineTo(W, y + 13); ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** A curved, faceted blade with a kissaki; aEdge = 1 along the cutting edge (glow / hamon). */
function bladeGeometry(seg = 26) {
  const pos = [], edge = [], idx = [];
  const ring = 6;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const y = BLADE_Y0 + t * BLADE_L;
    const sori = -0.017 * t * t;                       // the tip bends back toward the spine
    const tipK = smoothstep(0.9, 1.0, t);              // kissaki: the edge sweeps up to meet the back
    const w = lerp(0.031, 0.024, t) * (1 - tipK * 0.98);
    const th = lerp(0.0072, 0.0048, t) * (1 - tipK * 0.85);
    const yy = y + tipK * 0.0;
    const zb = sori - w * 0.5 * (1 - tipK) - tipK * 0.012; // the back (mune) line
    const ze = zb + w;                                     // the edge line
    const P6 = [
      [0, ze, 1],                       // edge
      [th * 0.45, zb + w * 0.62, 0.55], // shinogi +
      [th * 0.5, zb + w * 0.18, 0],
      [0, zb, 0],                       // mune
      [-th * 0.5, zb + w * 0.18, 0],
      [-th * 0.45, zb + w * 0.62, 0.55],
    ];
    for (const [x, z, e] of P6) { pos.push(x, yy, z); edge.push(e); }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < ring; j++) {
    const a = i * ring + j, b = i * ring + (j + 1) % ring, c = a + ring, d = b + ring;
    idx.push(a, c, b, b, c, d);
  }
  // cap the base (inside the habaki) and the very tip
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  g.setIndex(idx);
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  g.dispose();
  return ng;
}

/** Scabbard: a tapered oval tube following the blade's curve, mouth at y 0, closed end at y len. */
function sheathGeometry(len, seg = 20, rs = 14) {
  const pos = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const y = t * len;
    const zc = -0.017 * t * t - 0.002;
    const rz = lerp(0.0215, 0.0185, t), rx = lerp(0.0135, 0.0115, t);
    for (let j = 0; j <= rs; j++) {
      const a = (j / rs) * Math.PI * 2;
      pos.push(Math.sin(a) * rx, y, zc + Math.cos(a) * rz);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < rs; j++) {
    const a = i * (rs + 1) + j, b = a + 1, c = a + rs + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

class Trail {
  constructor(n = 30) {
    this.n = n; this.head = 0; this.count = 0;
    this.base = new Float64Array(n * 3); this.tip = new Float64Array(n * 3); this.age = new Float32Array(n).fill(9);
    const g = new THREE.BufferGeometry();
    this.posA = new Float32Array(n * 2 * 3);
    this.aA = new Float32Array(n * 2 * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this.posA, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aT', new THREE.BufferAttribute(this.aA, 2).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5);
    this.uGlow = { value: 1 };
    this.uColA = { value: new THREE.Color(3.2, 2.6, 1.7) };
    this.uColB = { value: new THREE.Color(0.9, 1.4, 3.2) };
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uGlow: this.uGlow, uColA: this.uColA, uColB: this.uColB },
      vertexShader: /* glsl */`
        attribute vec2 aT; varying vec2 vT;
        void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform float uGlow; uniform vec3 uColA; uniform vec3 uColB; varying vec2 vT;
        void main() {
          float age = clamp(vT.x, 0.0, 1.0), across = vT.y;      // across: 0 at the hilt side, 1 at the tip
          // a crescent of light: a thin bright line along the edge's path, a soft veil toward the hilt
          float fade = (1.0 - age) * (1.0 - age);
          float edge = exp(-pow((0.95 - across) / 0.06, 2.0));
          float veil = pow(across, 4.0) * 0.32 * (1.0 - age);
          float a = fade * (edge * 1.1 + veil) * smoothstep(1.0, 0.985, across);
          float core = edge * (1.0 - age);
          vec3 c = mix(uColB, uColA, core) * uGlow;
          if (a < 0.002) discard;
          gl_FragColor = vec4(c * a, a);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.name = 'katana-trail';
    this.life = 0.24;
  }
  push(base, tip) {
    const i = this.head;
    this.base[i * 3] = base.x; this.base[i * 3 + 1] = base.y; this.base[i * 3 + 2] = base.z;
    this.tip[i * 3] = tip.x; this.tip[i * 3 + 1] = tip.y; this.tip[i * 3 + 2] = tip.z;
    this.age[i] = 0;
    this.head = (i + 1) % this.n; this.count = Math.min(this.n, this.count + 1);
  }
  update(dt, center) {
    for (let i = 0; i < this.n; i++) this.age[i] += dt;
    const P = this.posA, A = this.aA;
    let live = 0;
    for (let k = 0; k < this.n; k++) {
      // newest first
      const i = (this.head - 1 - k + this.n * 2) % this.n;
      const t = this.age[i] / this.life;
      const o = k * 6;
      // points are stored relative to her feet (see Katana.update): the mesh rides at `center`
      P[o] = this.base[i * 3]; P[o + 1] = this.base[i * 3 + 1]; P[o + 2] = this.base[i * 3 + 2];
      P[o + 3] = this.tip[i * 3]; P[o + 4] = this.tip[i * 3 + 1]; P[o + 5] = this.tip[i * 3 + 2];
      A[k * 4] = t; A[k * 4 + 1] = 0; A[k * 4 + 2] = t; A[k * 4 + 3] = 1;
      if (t < 1) live++;
    }
    this.mesh.visible = live > 1;
    this.mesh.position.copy(center);
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.aT.needsUpdate = true;
  }
  clear() { this.age.fill(9); this.count = 0; }
  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}

/**
 * The crescent of a cut: a ring sector of light hung in the plane of the cut, thick and white-hot in the middle,
 * tapering to threads at both ends, cooling to cosmic blue on its inner edge; it reveals along the sweep in a few
 * hundredths of a second and fades (the iai crescent lingers through the held beat, stretched along the dash).
 * Planet-local (re-centred like the trail); a few pooled meshes, no per-frame allocation.
 */
class SlashArcs {
  constructor(n = 3) {
    const SEG = 40;
    const pos = [], at = [], idx = [];
    for (let i = 0; i <= SEG; i++) {
      const s = i / SEG;
      for (let k = 0; k < 2; k++) { pos.push(0, 0, 0); at.push(s, k); }
      if (i < SEG) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.geo.setAttribute('aT', new THREE.Float32BufferAttribute(at, 2));
    this.geo.setIndex(idx);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);
    this.items = [];
    this.group = new THREE.Group(); this.group.name = 'katana-arcs';
    for (let i = 0; i < n; i++) {
      const u = { uAge: { value: 1 }, uReveal: { value: 1 }, uA0: { value: 0 }, uA1: { value: 1 }, uThick: { value: 0.14 }, uStretch: { value: 1 }, uGlow: { value: 1 } };
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: u,
        vertexShader: /* glsl */`
          attribute vec2 aT; uniform float uA0; uniform float uA1; uniform float uThick; uniform float uStretch; uniform float uAge;
          varying vec2 vT;
          void main() {
            vT = aT;
            float th = mix(uA0, uA1, aT.x);
            float taper = pow(sin(3.14159 * aT.x), 0.7);
            float r = (1.0 + 0.1 * uAge) * (1.0 - aT.y * uThick * taper);
            vec3 p = vec3(cos(th) * r * uStretch, sin(th) * r, 0.0);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: /* glsl */`
          uniform float uAge; uniform float uReveal; uniform float uGlow; varying vec2 vT;
          void main() {
            float s = vT.x, x = vT.y;                       // s along the sweep (tail 0 → head 1), x 0 outer → 1 inner
            if (s > uReveal) discard;
            float edge = exp(-x * 5.0);
            float body = (1.0 - x) * 0.35;
            float ends = smoothstep(0.0, 0.18, s) * smoothstep(1.0, 0.8, s) * (0.55 + 0.45 * smoothstep(0.2, 0.9, s));
            float fade = pow(1.0 - clamp(uAge, 0.0, 1.0), 1.6);
            float a = (edge * 1.2 + body) * ends * fade;
            vec3 c = mix(vec3(0.7, 1.15, 3.0), vec3(3.4, 2.9, 2.1), edge) * uGlow;
            if (a < 0.003) discard;
            gl_FragColor = vec4(c * a, a);
          }`,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.frustumCulled = false; mesh.renderOrder = 12; mesh.visible = false; mesh.name = 'katana-arc';
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.items.push({ mesh, u, t: 9, life: 0.4, reveal: 0.06 });
    }
    this.next = 0;
    this._m = new THREE.Matrix4(); this._x = new THREE.Vector3(); this._y = new THREE.Vector3(); this._z = new THREE.Vector3();
  }
  /** center (planet-local), fwd / up unit; tilt: the cut plane leans from vertical toward her right (rad);
   *  a0..a1: the sweep in that plane (rad, 0 = forward, π/2 = up); radius (m); stretch along fwd; life (s). */
  spawn(center, fwd, up, tilt, a0, a1, radius, stretch, life, glow) {
    const it = this.items[this.next]; this.next = (this.next + 1) % this.items.length;
    const X = this._x.copy(fwd).normalize();
    const Z = this._z.crossVectors(X, up).normalize();             // her right
    const Y = this._y.copy(up).multiplyScalar(Math.cos(tilt)).addScaledVector(Z, Math.sin(tilt));
    Y.addScaledVector(X, -Y.dot(X)).normalize();
    Z.crossVectors(X, Y);
    this._m.makeBasis(X, Y, Z).scale(_a.set(radius, radius, radius)).setPosition(center);
    it.mesh.matrix.copy(this._m);
    it.u.uA0.value = a0; it.u.uA1.value = a1; it.u.uStretch.value = stretch; it.u.uGlow.value = glow;
    it.u.uThick.value = clamp(0.16 / Math.max(radius, 0.5) * 1.3, 0.08, 0.22);
    it.t = 0; it.life = life; it.reveal = life > 0.6 ? 0.08 : 0.05;
    it.mesh.visible = true;
  }
  update(dt) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.t += dt;
      it.u.uReveal.value = smoothstep(0, it.reveal, it.t) * 1.001;
      it.u.uAge.value = clamp((it.t - it.reveal) / Math.max(it.life - it.reveal, 1e-3), 0, 1);
      if (it.t >= it.life) it.mesh.visible = false;
    }
  }
  clear() { for (const it of this.items) { it.mesh.visible = false; it.t = 9; } }
  dispose() { this.geo.dispose(); for (const it of this.items) it.mesh.material.dispose(); }
}

/** A stand-alone sword (first-person copy): same geometry, its own materials; glow uniform shared if given. */
export function buildSwordGroup(P, quality, uGlow, uGlowCol) {
  const hi = quality?.tier !== 'low';
  const g = new THREE.Group(); g.name = 'katana-fp';
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 1.0, roughness: 0.17 });
  steel.onBeforeCompile = (sh) => {
    sh.uniforms.uGlow = uGlow; sh.uniforms.uGlowCol = uGlowCol;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aEdge; varying float vEdge; varying float vBy;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdge = aEdge; vBy = position.y;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uGlow; uniform vec3 uGlowCol; varying float vEdge; varying float vBy;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float hamon = smoothstep(0.42, 0.62, vEdge + 0.08 * sin(vBy * 120.0) * sin(vBy * 37.0));
        roughnessFactor = mix(roughnessFactor, 0.09, hamon);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uGlowCol * uGlow * (pow(vEdge, 3.0) * 1.6 + 0.1) * (0.75 + 0.25 * sin(vBy * 60.0 - uGlow * 3.0));`);
  };
  steel.customProgramCacheKey = () => 'rv-katana-steel-fp';
  const gold = new THREE.MeshStandardMaterial({ color: P.gold || 0xd1a554, metalness: 1.0, roughness: 0.3 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, metalness: 0.8, roughness: 0.45 });
  let hiltMap = null; try { hiltMap = hiltTexture(); } catch (_) { hiltMap = null; }
  const wrap = new THREE.MeshStandardMaterial({ color: 0xffffff, map: hiltMap, roughness: 0.75 });
  const add = (geo, m) => { const mesh = new THREE.Mesh(geo, m); mesh.frustumCulled = false; g.add(mesh); return mesh; };
  add(bladeGeometry(hi ? 28 : 16), steel);
  { const b = new THREE.BoxGeometry(0.0095, 0.03, 0.034); b.translate(0, 0.015, -0.002); add(b, gold); }
  { const b = new THREE.CylinderGeometry(0.037, 0.037, 0.0065, 24); b.scale(1, 1, 0.86); b.translate(0, -0.0035, 0); add(b, iron); }
  { const b = new THREE.TorusGeometry(0.0365, 0.0022, 4, 24); b.rotateX(Math.PI / 2); b.scale(1, 1, 0.86); b.translate(0, -0.0035, 0); add(b, gold); }
  { const b = new THREE.CylinderGeometry(0.0128, 0.0138, 0.25, 10, 1, true); b.scale(0.82, 1, 1.12); b.translate(0, -0.135, 0);
    const uv = b.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * 3.2); add(b, wrap); }
  g.userData.mats = [steel, gold, iron, wrap];
  return g;
}

export class Katana {
  constructor(world, P, quality) {
    this.world = world;
    const hi = quality?.tier !== 'low';
    this.group = new THREE.Group(); this.group.name = 'katana';
    this.sword = new THREE.Group(); this.sword.name = 'katana-sword';
    this.sheath = new THREE.Group(); this.sheath.name = 'katana-sheath';
    this.group.add(this.sword, this.sheath);
    // ---- materials
    this.uGlow = { value: 0.0 };
    this.uGlowCol = { value: new THREE.Color(1.0, 0.85, 0.6) };
    const steel = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 1.0, roughness: 0.17, envMapIntensity: 1.2 });
    steel.onBeforeCompile = (sh) => {
      sh.uniforms.uGlow = this.uGlow; sh.uniforms.uGlowCol = this.uGlowCol;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aEdge; varying float vEdge; varying float vBy;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdge = aEdge; vBy = position.y;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uGlow; uniform vec3 uGlowCol; varying float vEdge; varying float vBy;')
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          // hamon: a soft wavy temper line — the edge side is brighter, finer
          float hamon = smoothstep(0.42, 0.62, vEdge + 0.08 * sin(vBy * 120.0) * sin(vBy * 37.0));
          roughnessFactor = mix(roughnessFactor, 0.09, hamon);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += uGlowCol * uGlow * (pow(vEdge, 3.0) * 1.6 + 0.1) * (0.75 + 0.25 * sin(vBy * 60.0 - uGlow * 3.0));`);
    };
    steel.customProgramCacheKey = () => 'rv-katana-steel';
    const lacquer = new (hi ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial)({ color: 0x0b0a0e, roughness: 0.3, metalness: 0.0 });
    if (hi) { lacquer.clearcoat = 1.0; lacquer.clearcoatRoughness = 0.12; }
    patchLighting(lacquer, { rim: 0.25, sky: 0.25, key: 'saya', sunRim: 0.6, stars: 1.6, wear: 0 });
    const gold = new THREE.MeshStandardMaterial({ color: P.gold || 0xd1a554, metalness: 1.0, roughness: 0.3 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, metalness: 0.8, roughness: 0.45 });
    let hiltMap = null; try { hiltMap = hiltTexture(); } catch (_) { hiltMap = null; }
    const wrap = new THREE.MeshStandardMaterial({ color: 0xffffff, map: hiltMap, roughness: 0.75, metalness: 0 });
    const cord = new THREE.MeshStandardMaterial({ color: 0x2a1f35, roughness: 0.8 });
    this.mats = [steel, lacquer, gold, iron, wrap, cord];
    // ---- sword
    // small parts are batched per (parent, material) and merged → 4 draw calls for the sword, 4 for the scabbard
    const batches = [];
    const add = (parent, g, m) => {
      let b = batches.find((x) => x.parent === parent && x.m === m);
      if (!b) { b = { parent, m, list: [] }; batches.push(b); }
      const n = g.index ? g.toNonIndexed() : g;
      for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k);
      if (!n.attributes.normal) n.computeVertexNormals();
      b.list.push(n); if (n !== g) g.dispose();
    };
    this.bladeMesh = new THREE.Mesh(bladeGeometry(hi ? 28 : 16), steel);
    this.bladeMesh.castShadow = true; this.bladeMesh.receiveShadow = true; this.sword.add(this.bladeMesh);
    { const g = new THREE.BoxGeometry(0.0095, 0.03, 0.034); g.translate(0, 0.015, -0.002); add(this.sword, g, gold); }        // habaki
    { const g = new THREE.CylinderGeometry(0.037, 0.037, 0.0065, hi ? 28 : 14); g.scale(1, 1, 0.86); g.translate(0, -0.0035, 0); add(this.sword, g, iron); } // tsuba
    { const g = new THREE.TorusGeometry(0.0365, 0.0022, 4, hi ? 32 : 16); g.rotateX(Math.PI / 2); g.scale(1, 1, 0.86); g.translate(0, -0.0035, 0); add(this.sword, g, gold); }
    { const g = new THREE.CylinderGeometry(0.0128, 0.0138, 0.25, 10, 1, true); g.scale(0.82, 1, 1.12); g.translate(0, -0.135, 0);
      const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * 3.2); // tsuka
      add(this.sword, g, wrap); }
    { const g = new THREE.CylinderGeometry(0.0135, 0.0135, 0.016, 12); g.scale(0.85, 1, 1.12); g.translate(0, -0.015, 0); add(this.sword, g, gold); }  // fuchi
    { const g = new THREE.SphereGeometry(0.0145, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2); g.rotateX(Math.PI); g.scale(0.85, 0.7, 1.12); g.translate(0, -0.26, 0); add(this.sword, g, gold); } // kashira
    // ---- scabbard
    const SL = ACTS ? 0.79 : 0.79;
    add(this.sheath, sheathGeometry(SL, hi ? 22 : 12, hi ? 14 : 8), lacquer);
    { const g = new THREE.CylinderGeometry(0.0145, 0.0145, 0.018, 14, 1, true); g.scale(1, 1, 1.52); g.translate(0, 0.009, -0.002); add(this.sheath, g, gold); } // koiguchi
    { const g = new THREE.SphereGeometry(0.0145, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2); g.scale(0.82, 0.9, 1.25); g.translate(0, SL - 0.004, -0.019); add(this.sheath, g, gold); } // kojiri
    { const g = new THREE.TorusGeometry(0.008, 0.003, 5, 10); g.rotateY(Math.PI / 2); g.translate(0.0, 0.1, -0.024); add(this.sheath, g, iron); } // kurikata
    { // sageo: a dark silk cord wound around the scabbard below the kurikata
      for (let i = 0; i < 3; i++) { const g = new THREE.TorusGeometry(0.017, 0.0026, 4, 14); g.rotateX(Math.PI / 2); g.scale(0.8, 1, 1.25); g.translate(0, 0.13 + i * 0.016, -0.003); add(this.sheath, g, cord); }
    }
    for (const b of batches) {
      const geo = b.list.length > 1 ? mergeGeometries(b.list, false) : b.list[0];
      if (b.list.length > 1) for (const g of b.list) g.dispose();
      const mesh = new THREE.Mesh(geo, b.m); mesh.castShadow = true; mesh.receiveShadow = true; b.parent.add(mesh);
    }
    // ---- trail + light of the cut
    this.trail = new Trail(hi ? 30 : 18);
    this.trailGroup = new THREE.Group(); this.trailGroup.name = 'katana-trail-root';
    this.trailGroup.add(this.trail.mesh);
    this.arcs = new SlashArcs(hi ? 4 : 2);
    this.trailGroup.add(this.arcs.group);
    this.tipW = new THREE.Vector3(); this.baseW = new THREE.Vector3();
    this.prevTipW = new THREE.Vector3(); this.prevBaseW = new THREE.Vector3(); this.hasPrev = false; this.prevDir = new THREE.Vector3(0, 1, 0); this.wasFast = false; this.lastPushB = new THREE.Vector3();
    this._m = new THREE.Matrix4();

    // ---- state machine
    this.drawn = false;        // logically drawn (ready stance when no action)
    this.act = null; this.t = 0; this.dur = 1;
    this.combo = 0; this.queued = false;
    this.holdT = 0; this.charging = false; this.charge = 0; this.fromSheath = false;
    this.autoSheathe = false;
    this.hitDone = false;
    this.flash = 0;            // a short burst of light (draw ting, iai flash)
    this.glow = 0;             // edge glow (abilities flowing through the blade)
    this.lunge = 0;            // forward impulse requested from the Player (m/s)
    this.dash = 0;             // iai dash distance remaining (m)
    this.S = { act: null, u: 0, drawn: false };
    this._prim = false;
    this.palette = P;
    this.petalCols = [];
    const fl = world?.body?.art?.palette?.flora;
    if (Array.isArray(fl)) for (const c of fl) { try { this.petalCols.push(new THREE.Color(c)); } catch (_) { /* skip */ } }
    if (!this.petalCols.length) this.petalCols.push(new THREE.Color('#6cb04a'), new THREE.Color('#f4c6dc'), new THREE.Color('#ffe08a'));
    // the cut always opens a few blossoms too (pink, white, gold): the bloom reads against any meadow
    for (const c of ['#f7cfe0', '#fbf3ec', '#f2c34e', '#e8a2bd', '#fbf3ec']) this.petalCols.push(new THREE.Color(c));
  }

  get busy() { return !!this.act; }

  _start(act, speed = 1) {
    this.act = act; this.t = 0; this.dur = (ACTS[act]?.dur || 0.5) * speed; this.hitDone = false; this.queued = false;
  }

  /** Instantly put the sword away (entering water, climbing, a vehicle). */
  stow() {
    if (!this.drawn && !this.act) return;
    this.drawn = false; this.act = null; this.charging = false; this.charge = 0; this.autoSheathe = false;
    this.trail.clear();
  }

  /**
   * Input + timeline. `ctl` = { primary held, drawPressed, canAct (grounded or airborne, not swimming / climbing) }.
   * Returns nothing; read .S for the animator, .lunge / .dash for the Player, events go out through `emit`.
   */
  tick(dt, ctl, emit) {
    this.flash = Math.max(0, this.flash - dt * 3.5);
    this.lunge = 0;
    if (!ctl.canAct) { if (this.act || this.drawn) this.stow(); this._prim = ctl.primary; this.S.act = null; this.S.drawn = false; return; }
    const pressed = ctl.primary && !this._prim;
    const released = !ctl.primary && this._prim;
    this._prim = ctl.primary;
    // ---- start actions
    if (ctl.drawPressed && !this.act) {
      if (this.drawn) { this._start('sheathe'); }
      else { this._start('draw'); this.drawn = true; }
    }
    if (ctl.primary) this.holdT += dt; else if (!released) this.holdT = 0;
    if (!this.act) {
      if (ctl.primary && this.holdT > 0.26 && ctl.grounded) {
        // iaido stance
        this.charging = true; this.charge = 0; this.fromSheath = !this.drawn;
        this._start(this.drawn ? 'chargeDrawn' : 'charge');
      } else if (released && this.holdT < 0.26) {
        if (!this.drawn) { this._start('draw', 0.8); this.drawn = true; this.queued = true; }
        else { this.combo = 0; this._start('slash1'); }
      }
    } else if (this.act.startsWith('slash') && pressed) this.queued = true;
    else if (this.act === 'draw' && pressed) this.queued = true;
    if (released) this.holdT = 0;
    // ---- advance
    if (this.act) {
      const A = ACTS[this.act];
      const prevU = this.t / this.dur;
      if (this.charging) {
        this.t = Math.min(this.t + dt, this.dur); // hold at the end of the stance
        this.charge = Math.min(1, this.charge + dt / 0.9);
        if (!ctl.primary) { // release: the flash cut
          this.charging = false;
          this._start('iai');
          this.drawn = true;
          this.dash = 3.2 + 1.6 * this.charge;
          this.flash = 1;
          emit('draw', { drawn: true, iai: true });
        }
      } else this.t += dt;
      const u = this.t / this.dur;
      if (this.act === 'draw' && prevU < 0.42 && u >= 0.42) { this.flash = Math.max(this.flash, 0.6); emit('draw', { drawn: true }); }
      if (this.act === 'sheathe' && prevU < 0.8 && u >= 0.8) { this.flash = Math.max(this.flash, 0.35); this.drawn = false; emit('draw', { drawn: false, click: true }); emit('sheathed', {}); }
      if (A?.hit !== undefined && !this.hitDone && u >= A.hit) {
        this.hitDone = true;
        const kind = this.act === 'iai' ? 'iai' : this.act;
        emit('slash', { kind, radius: kind === 'iai' ? 3.6 : kind === 'slash3' ? 2.6 : 2.2 });
        if (kind !== 'iai') this.lunge = kind === 'slash3' ? 3.2 : 2.4;
      }
      // chain the combo at the end of a cut
      if (this.act.startsWith('slash') && this.queued && u >= 0.62) {
        this.combo = (this.combo + 1) % 3;
        this._start('slash' + (this.combo + 1));
      } else if (u >= 1) {
        const was = this.act;
        this.act = null;
        if (was === 'iai' && this.fromSheath) { this._start('sheathe', 1.35); }
        else if (was === 'draw' && this.queued) { this.combo = 0; this._start('slash1'); }
        else if (was === 'sheathe') this.drawn = false;
      }
    }
    this.S.act = this.act && !(this.charging && false) ? this.act : null;
    this.S.u = this.act ? clamp(this.t / this.dur, 0, 1) : 0;
    this.S.drawn = this.drawn;
  }

  /** Place the sword + scabbard (group space, from the animator) and feed the trail / glow. */
  update(dt, an, group, glowBoost, center) {
    if (!an) return;
    this.sheath.position.copy(an.sheathGP); this.sheath.quaternion.copy(an.sheathGQ);
    this.sword.position.copy(an.swordGP); this.sword.quaternion.copy(an.swordGQ);
    // edge glow: abilities flowing, the iaido charge, the flash of the cut
    const tgt = clamp(glowBoost + this.charge * 1.6 * (this.charging ? 1 : 0) + this.flash * 2.2, 0, 4);
    this.glow += (tgt - this.glow) * dampF(tgt > this.glow ? 14 : 3, dt);
    this.uGlow.value = this.glow;
    // trail: blade base + tip in planet-local space
    group.updateMatrixWorld(false);
    this.sword.updateMatrixWorld(true);
    this._m.multiplyMatrices(group.matrix, this.sword.matrix);  // group (planet-local) ← sword
    this.baseW.set(0, 0.22, -0.004).applyMatrix4(this._m);
    this.tipW.set(0, BLADE_Y0 + BLADE_L, -0.01).applyMatrix4(this._m);
    // the trail lives in BODY-relative space (offsets from her feet): the arc the blade draws around her stays a
    // crescent of light that travels with her — in world space the iai dash (4 m in 0.1 s) swept it into a flat card
    this.baseW.sub(center); this.tipW.sub(center);
    // only a SWEEP draws light: the blade direction itself must turn fast this frame (sliding out of the scabbard or
    // a lunge moves the tip in a straight line and drew hard-edged "card" outlines)
    _c.copy(this.tipW).sub(this.baseW).normalize();
    const turn = this.hasPrev && dt > 1e-5 ? Math.acos(clamp(_c.dot(this.prevDir), -1, 1)) / dt : 0;
    this.prevDir.copy(_c);
    const fast = an.swordSpeed > 5 && an.swIn > 0.6 && turn > 4 && this.act !== 'iai'; // the iai draws its crescent (arc)
    if (fast) {
      if (!this.wasFast && this.trail.count > 0) {
        // a new sweep after a pause: break the ribbon with zero-width joints (no bridging quad back to the last arc)
        this.trail.push(this.lastPushB, this.lastPushB);
        this.trail.push(this.prevBaseW, this.prevBaseW);
        this.trail.push(this.prevBaseW, this.prevTipW);
      }
      this.lastPushB.copy(this.baseW);
      if (this.hasPrev) {
        // sub-steps along the chord so a fast cut draws a smooth arc at low frame rates
        for (let k = 1; k <= 3; k++) {
          const f = k / 3;
          _a.lerpVectors(this.prevBaseW, this.baseW, f); _b.lerpVectors(this.prevTipW, this.tipW, f);
          this.trail.push(_a, _b);
        }
      } else this.trail.push(this.baseW, this.tipW);
    }
    this.wasFast = fast;
    this.hasPrev = true;
    this.prevBaseW.copy(this.baseW); this.prevTipW.copy(this.tipW);
    this.trail.uGlow.value = 0.55 + this.glow * 0.5 + (this.act === 'iai' ? 1.2 : 0);
    // the iai flash is over in a tenth of a second: its crescent lingers through the held follow-through (the beat)
    this.trail.life = this.act === 'iai' ? 0.75 : 0.3;
    this.trail.update(dt, center);
    this.arcs.update(dt);
  }

  /** Hang the crescent of a cut in the air (planet-local `pos` = her feet). */
  arc(kind, pos, up, fwd, mid = null) {
    if (!this.arcs) return;
    const g = 1 + Math.min(this.glow, 3) * 0.35;
    if (kind === 'iai') {
      // the flash cut: a long rising crescent stretched along the dash line, hung where she cut (she ends beyond it)
      if (mid) _b.copy(mid); else _b.copy(pos).addScaledVector(fwd, -1.8);
      _b.addScaledVector(up, 1.15);
      this.arcs.spawn(_b, fwd, up, 0.55, -2.25, 0.75, 0.95, 2.4, 1.2, g * 1.35);
    } else if (kind === 'slash1') { // kesa-giri: from high right down across the body
      _b.copy(pos).addScaledVector(fwd, 0.45).addScaledVector(up, 1.1);
      this.arcs.spawn(_b, fwd, up, -0.75, 2.0, -1.2, 1.15, 1.0, 0.42, g);
    } else if (kind === 'slash2') { // the flat backhand
      _b.copy(pos).addScaledVector(fwd, 0.35).addScaledVector(up, 1.15);
      this.arcs.spawn(_b, fwd, up, 1.35, -1.9, 1.4, 1.2, 1.0, 0.42, g);
    } else { // rising finisher
      _b.copy(pos).addScaledVector(fwd, 0.45).addScaledVector(up, 1.0);
      this.arcs.spawn(_b, fwd, up, 0.4, -2.2, 1.0, 1.25, 1.05, 0.5, g * 1.15);
    }
  }

  /** Petals, leaves and grass bits flung along the cut (and light motes when the blade glows). */
  burst(fx, center, up, fwd, radius, kind, groundR, glow) {
    if (!fx) return;
    const r = fx.rand;
    _c.crossVectors(up, fwd).normalize(); // left
    const n = Math.round((kind === 'iai' ? 70 : 34) * (fx.max > 400 ? 1 : 0.6));
    const sweep = kind === 'slash2' ? -1 : kind === 'slash1' ? 1 : (r.next() < 0.5 ? 1 : -1);
    for (let i = 0; i < n; i++) {
      const ang = (r.next() - 0.5) * 2.2;
      const d = 0.4 + Math.sqrt(r.next()) * radius;
      _a.copy(center).addScaledVector(fwd, Math.cos(ang) * d).addScaledVector(_c, Math.sin(ang) * d);
      const h = groundR ? groundR(_a) : _a.length();
      _a.setLength(h + 0.1 + r.next() * 0.7);
      // fling along the cut, up, then they drift
      _b.copy(_c).multiplyScalar(sweep * (1.5 + r.next() * 3)).addScaledVector(up, 1.6 + r.next() * 3.2).addScaledVector(fwd, (r.next() - 0.3) * 2.2);
      const col = this.petalCols[(r.next() * this.petalCols.length) | 0];
      _col.copy(col).multiplyScalar(0.75 + r.next() * 0.4);
      fx.emit(_a, _b, { kind: 3, size: 0.05 + r.next() * 0.05, size1: 0.045 + r.next() * 0.04, life: 2.2 + r.next() * 2.4, color: _col, alpha: 0.95, drag: 2.4, grav: 0.07, spin: 9 });
    }
    // grass cuttings (small, fast, green-gold)
    for (let i = 0; i < n * 0.6; i++) {
      const ang = (r.next() - 0.5) * 2.0, d = 0.3 + r.next() * radius * 0.8;
      _a.copy(center).addScaledVector(fwd, Math.cos(ang) * d).addScaledVector(_c, Math.sin(ang) * d);
      const h = groundR ? groundR(_a) : _a.length();
      _a.setLength(h + 0.05 + r.next() * 0.35);
      _b.copy(_c).multiplyScalar(sweep * (2 + r.next() * 3)).addScaledVector(up, 1 + r.next() * 2.5);
      _col.copy(this.petalCols[0]).lerp(this.petalCols[Math.min(1, this.petalCols.length - 1)], r.next());
      fx.emit(_a, _b, { kind: 1, size: 0.012 + r.next() * 0.01, size1: 0.01, life: 0.7 + r.next() * 0.6, color: _col, alpha: 0.9, drag: 1.2, grav: 0.5 });
    }
    // the light of the cut: motes of stardust along the arc (more when an ability flows through the blade)
    const m = Math.round(10 + glow * 14 + (kind === 'iai' ? 24 : 0));
    for (let i = 0; i < m; i++) {
      const ang = (r.next() - 0.5) * 2.4, d = 0.5 + r.next() * radius * 0.7;
      _a.copy(center).addScaledVector(fwd, Math.cos(ang) * d).addScaledVector(_c, Math.sin(ang) * d).addScaledVector(up, 0.6 + r.next() * 0.9);
      _b.copy(up).multiplyScalar(0.3 + r.next() * 0.6).addScaledVector(_c, sweep * r.next());
      fx.emit(_a, _b, { kind: 2, size: 0.03 + r.next() * 0.04, size1: 0.01, life: 0.9 + r.next() * 1.2, color: _col.setRGB(3.2, 2.7, 1.9), alpha: 0.9, drag: 1.5, grav: -0.02 });
    }
  }

  dispose() {
    for (const o of [this.sword, this.sheath]) o.traverse((m) => { if (m.isMesh) m.geometry.dispose(); });
    for (const m of this.mats) { m.map?.dispose?.(); m.dispose(); }
    this.trail.dispose();
    this.arcs?.dispose();
  }
}
