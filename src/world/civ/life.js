// Life in settlements: walking townsfolk (instanced, GPU-animated gait), flying traffic on
// looping lanes (cars / gliders / wooden ships), boats bobbing in harbours, and the space elevator.
// Everything animates in the vertex shader → zero per-frame CPU cost.
import * as THREE from 'three';
import { Geo, mat, PAT } from './geo.js';
import { makeCivMaterial } from './material.js';
import { G } from '../../core/Uniforms.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const LANTERN = new Set(['village', 'harbor', 'hearth', 'monastery', 'nomad', 'ruins', 'spire', 'organic', 'frontier']);
const _cache = new Map();

/** Person (~1.75 m), clothing uses PAT.FABRIC so the instance tint recolours it. */
function figureGeo(style) {
  const k = 'fig-' + style;
  if (_cache.has(k)) return _cache.get(k);
  const g = new Geo();
  g.begin(new THREE.Matrix4(), 0);
  const cloth = mat('#8a6a4a', 0.9, 0, PAT.FABRIC);
  const skin = mat(style === 'bizarre' ? '#9be870' : style === 'hearth' ? '#3a4a6a' : '#c89a7a', 0.7);
  const dark = mat('#2a2622', 0.8);
  const robe = style === 'monastery' || style === 'nomad' || style === 'spire' || style === 'ruins';
  // legs
  for (const s of [-1, 1]) g.box(s * 0.1, 0, 0, 0.13, 0.86, 0.15, 0.03, dark);
  if (robe) g.cyl(0, 0.12, 0, 0.3, 0.2, 1.3, 8, true, cloth);
  // torso
  g.box(0, 0.84, 0, 0.4, 0.62, 0.24, 0.06, cloth);
  // arms
  for (const s of [-1, 1]) g.box(s * 0.26, 0.86, 0, 0.1, 0.58, 0.12, 0.03, cloth);
  // head
  g.sphere(0, 1.6, 0, 0.12, 8, 5, skin);
  if (style === 'hearth') { for (const s of [-1, 1]) g.cyl(s * 0.07, 1.62, 0.1, 0.03, 0.02, 0.12, 4, true, skin); } // four-eyed Hearthian snout
  // hand lantern (PAT.LAMP: glows at night; only some instances carry one, see aP.w)
  if (LANTERN.has(style)) {
    g.cyl(0.33, 0.62, 0.04, 0.012, 0.012, 0.22, 4, false, dark);
    g.box(0.33, 0.44, 0.04, 0.13, 0.18, 0.13, 0.02, mat('#ffc070', 0.4, 0, PAT.LAMP, 7));
    g.box(0.33, 0.62, 0.04, 0.15, 0.03, 0.15, 0, dark);
  }
  if (style === 'village' || style === 'nomad' || style === 'harbor') g.cyl(0, 1.68, 0, 0.3, 0.02, 0.18, 10, true, mat('#c8a860', 0.9, 0, PAT.THATCH));
  else if (style === 'monastery' || style === 'ruins') g.cyl(0, 1.5, -0.02, 0.17, 0.08, 0.3, 8, true, cloth);
  else if (style === 'outpost' || style === 'nasapunk') g.sphere(0, 1.6, 0, 0.16, 10, 6, mat('#e8e8e8', 0.3, 0.3));
  else if (style === 'frontier') g.cyl(0, 1.7, 0, 0.26, 0.12, 0.1, 10, true, mat('#5a3a22', 0.8));
  const geo = g.build();
  _cache.set(k, geo);
  return geo;
}

function carGeo(kind) {
  const k = 'car-' + kind;
  if (_cache.has(k)) return _cache.get(k);
  const g = new Geo();
  g.begin(new THREE.Matrix4(), 0);
  if (kind === 'glider') {
    // Mehve-like jet glider: white swept wing, slim body, small engine glow
    const wing = mat('#f0ece0', 0.45, 0.1);
    g.push().scale(1, 0.25, 1); g.sphere(0, 0, 0, 0.5, 8, 5, wing); g.pop();
    for (const s of [-1, 1]) g.triFlat(V(0, 0, 1.2), V(s * 4.2, 0.35, -0.9), V(0, 0, -0.9), null, wing), g.triFlat(V(0, 0, 1.2), V(0, 0, -0.9), V(s * 4.2, 0.35, -0.9), null, wing);
    g.cyl(0, 0, -1.2, 0.2, 0.12, 0.3, 6, true, mat('#ffb040', 0.3, 0, PAT.NEON, 6));
    g.box(0, -0.35, 0.2, 0.3, 0.3, 0.6, 0.05, mat('#6a4a3a', 0.8));
  } else if (kind === 'ship') {
    const wood = mat('#8a6040', 0.8, 0, PAT.PLANKS), metal = mat('#9a9ea4', 0.4, 0.8, PAT.PANELS);
    g.push().rotX(Math.PI / 2); g.lathe(0, -3, 0, [[0.05, 0], [1.2, 1], [1.5, 3.5], [1.1, 5.5], [0.2, 6.2]], 10, wood); g.pop();
    for (const s of [-1, 1]) g.cyl(s * 1.6, -0.2, -2.2, 0.4, 0.5, 0.8, 8, true, metal);
    g.cyl(0, -0.3, -3.4, 0.5, 0.7, 0.4, 8, true, mat('#ff8a3a', 0.3, 0, PAT.NEON, 8));
    g.sphere(0, 0.9, 1.2, 0.8, 10, 6, mat('#2a4a5a', 0.05, 0.6));
  } else {
    // hover car: bevelled body, glass canopy, head/tail lights, underglow
    const paint = mat(kind === 'neon' ? '#2a2c34' : '#d8d8d4', 0.25, 0.7, PAT.PANELS);
    g.box(0, -0.35, 0, 2.0, 0.7, 4.6, 0.18, paint);
    g.box(0, 0.35, -0.3, 1.6, 0.55, 2.2, 0.2, mat('#101820', 0.05, 0.8));
    g.box(0, -0.1, 2.31, 1.4, 0.12, 0.05, 0, mat('#fff4e0', 0.2, 0, PAT.NEON, 10));
    g.box(0, -0.05, -2.31, 1.6, 0.12, 0.05, 0, mat('#ff2a1a', 0.2, 0, PAT.NEON, 10));
    g.box(0, -0.72, 0, 1.4, 0.04, 3.4, 0, mat(kind === 'neon' ? '#ff2e88' : '#40c8ff', 0.2, 0, PAT.NEON, 6));
    for (const s of [-1, 1]) g.cyl(s * 1.1, -0.5, -1.5, 0.28, 0.28, 0.6, 8, true, paint);
  }
  const geo = g.build();
  _cache.set(k, geo);
  return geo;
}

function boatGeo() {
  if (_cache.has('boat')) return _cache.get('boat');
  const g = new Geo();
  g.begin(new THREE.Matrix4(), 0);
  const hull = mat('#5a3a28', 0.8, 0, PAT.PLANKS), paint = mat('#e8e0d0', 0.7, 0, PAT.PLANKS);
  g.push().rotX(-Math.PI / 2).scale(1, 1, 0.55);
  g.lathe(0, -3.2, 0, [[0.05, 0], [1.0, 0.8], [1.3, 3.2], [1.0, 5.4], [0.05, 6.4]], 10, hull, { a0: 0, a1: Math.PI });
  g.pop();
  g.box(0, 0.0, 0, 2.2, 0.12, 5.2, 0.03, paint);
  g.box(0, 0.12, -1.2, 1.3, 1.1, 1.6, 0.05, paint);
  g.cyl(0, 0, 0.8, 0.07, 0.05, 6, 5, true, mat('#4a3a2a', 0.8));
  g.push().translate(0, 1.2, 1.4); g.triFlat(V(0, 0, -0.5), V(0, 4.3, -0.5), V(0, 0, 2.4), null, mat('#f0e8d0', 0.95, 0, PAT.FABRIC)); g.triFlat(V(0, 0, -0.5), V(0, 0, 2.4), V(0, 4.3, -0.5), null, mat('#f0e8d0', 0.95, 0, PAT.FABRIC)); g.pop();
  g.box(0, 1.25, -2.0, 0.18, 0.25, 0.18, 0, mat('#ffc070', 0.4, 0, PAT.LAMP, 6));
  const geo = g.build();
  _cache.set('boat', geo);
  return geo;
}

function instanced(base, count, attrs) {
  const ig = new THREE.InstancedBufferGeometry();
  for (const name of Object.keys(base.attributes)) ig.setAttribute(name, base.attributes[name]);
  ig.setIndex(base.index);
  for (const [name, [arr, size]] of Object.entries(attrs)) ig.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
  ig.instanceCount = count;
  return ig;
}

const TINTS = {
  village: ['#b8483a', '#3a6aa8', '#e8c46a', '#6a8a4a', '#e8e0d0', '#8a5a9a'], hearth: ['#c86a32', '#6a8aa8', '#8a6a4a', '#d8c7a2'],
  monastery: ['#6a5a4a', '#8a7a64', '#3a3c48', '#e8e4dc', '#a04a3a'], ruins: ['#8a6a4a', '#5a7a8a', '#c8b890'], nomad: ['#c83a2a', '#e8c040', '#3a6aa8', '#e8e0d0', '#6a8a8a'],
  neon: ['#1a1c22', '#2a2a34', '#ff2e88', '#23ffd5', '#e8e0d0', '#3a3a44'], industrial: ['#3a4a5a', '#8a3a2a', '#c8a040', '#4a4a44'],
  spire: ['#f4efe6', '#e98f75', '#86c6b7', '#f5d38c'], organic: ['#e27fb0', '#7fd2ff', '#ffd36b', '#5fbf8f'], frontier: ['#8a4a2a', '#3a5a7a', '#c8a070', '#2a2a2a'],
  outpost: ['#e8a020', '#dcdcd6', '#2a5aa8', '#6a6c70'], bizarre: ['#ff5fb0', '#6af0ff', '#b6ff4a', '#ffd23f'], crystal: ['#c09aff', '#9ad5ff', '#ffffff'],
};

/** Walkers on short path segments (mesh space). paths: [{a:Vector3, b:Vector3}] */
export function makeNPCs(style, paths, siteUp, rng, max) {
  const n = Math.min(paths.length, max);
  if (n <= 0) return null;
  const A = new Float32Array(n * 3), B = new Float32Array(n * 3), Pp = new Float32Array(n * 4), T = new Float32Array(n * 3);
  const tints = (TINTS[style] || TINTS.village).map((c) => new THREE.Color(c));
  for (let i = 0; i < n; i++) {
    const p = paths[i];
    A.set([p.a.x, p.a.y, p.a.z], i * 3); B.set([p.b.x, p.b.y, p.b.z], i * 3);
    const idle = rng.next() < 0.22;
    Pp.set([idle ? 0 : rng.range(0.9, 1.5), rng.next() * 7, rng.range(0.9, 1.08), rng.next() < 0.4 ? 1 : 0], i * 4);
    const c = tints[Math.floor(rng.next() * tints.length)];
    T.set([c.r, c.g, c.b], i * 3);
  }
  const geo = instanced(figureGeo(style), n, { aA: [A, 3], aB: [B, 3], aP: [Pp, 4], aTint: [T, 3] });
  if (globalThis.__civNpcBig) for (let i = 0; i < n; i++) Pp[i * 4 + 2] = 8;
  const m = makeCivMaterial({}, { anim: 'npc', key: 'npc' });
  m.userData.u.uUpL.value.copy(siteUp);
  const mesh = new THREE.Mesh(geo, m);
  mesh.frustumCulled = false;
  mesh.castShadow = false; mesh.receiveShadow = true;
  mesh.name = 'civ-npcs';
  return mesh;
}

/** Flying traffic on elliptical lanes above a site. */
export function makeTraffic(kind, site, n, rng, radius, altBase) {
  if (n <= 0) return null;
  const L = new Float32Array(n * 4), L2 = new Float32Array(n * 4);
  const lanes = Math.max(2, Math.round(n / 6));
  const laneDef = [];
  for (let k = 0; k < lanes; k++) laneDef.push({ cx: rng.range(-0.2, 0.2) * radius, cz: rng.range(-0.2, 0.2) * radius, a: radius * rng.range(0.35, 0.9), b: radius * rng.range(0.3, 0.8), alt: altBase * rng.range(0.7, 1.8), rot: rng.range(0, 6.28), dir: rng.next() < 0.5 ? -1 : 1 });
  for (let i = 0; i < n; i++) {
    const ln = laneDef[i % lanes];
    L.set([ln.cx, ln.cz, ln.a, ln.b], i * 4);
    L2.set([ln.alt + rng.range(-3, 3), ln.dir * rng.range(14, 26) * (kind === 'glider' ? 0.7 : 1), rng.range(0, 6.28), ln.rot], i * 4);
  }
  const geo = instanced(carGeo(kind), n, { aL: [L, 4], aL2: [L2, 4] });
  const m = makeCivMaterial({}, { anim: 'traffic', key: 'traffic' });
  const U = m.userData.u;
  U.uUpL.value.copy(site.up); U.uEastL.value.copy(site.east); U.uNorthL.value.copy(site.north);
  U.uSiteC.value.copy(site.pos); U.uRBase.value = site.R + site.h0;
  const mesh = new THREE.Mesh(geo, m);
  mesh.frustumCulled = false; mesh.castShadow = false;
  mesh.name = 'civ-traffic';
  return mesh;
}

/** Boats moored/bobbing at sea level. spots: [{x, z, heading}] in site tangent coords. */
export function makeBoats(site, spots, seaH) {
  const n = spots.length;
  if (!n) return null;
  const L = new Float32Array(n * 4), L2 = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { const s = spots[i]; L.set([s.x, s.z, seaH - site.h0 + 0.1, s.heading], i * 4); L2.set([i * 0.37 % 1, s.scale ?? 1, 0, 0], i * 4); }
  const geo = instanced(boatGeo(), n, { aL: [L, 4], aL2: [L2, 4] });
  const m = makeCivMaterial({}, { anim: 'boat', key: 'boat' });
  const U = m.userData.u;
  U.uUpL.value.copy(site.up); U.uEastL.value.copy(site.east); U.uNorthL.value.copy(site.north);
  U.uSiteC.value.copy(site.pos); U.uRBase.value = site.R + site.h0;
  const mesh = new THREE.Mesh(geo, m);
  mesh.frustumCulled = false; mesh.castShadow = false;
  mesh.name = 'civ-boats';
  return mesh;
}

/**
 * Space elevator: tether from the anchor to geostationary-ish height, drawn as a screen-space ribbon
 * (≥ 1.4 px wide, so it reads from anywhere on the hemisphere) with climbers and beacon lights.
 * anchor: mesh-space point of the base (in site mesh coords), up: unit up.
 */
export function makeElevator(anchor, up, height) {
  const N = 180;
  const pos = new Float32Array(N * 2 * 3), side = new Float32Array(N * 2), hh = new Float32Array(N * 2);
  const idx = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const h = height * Math.pow(t, 2.2);
    for (let s = 0; s < 2; s++) {
      const k = i * 2 + s;
      pos.set([anchor.x + up.x * h, anchor.y + up.y * h, anchor.z + up.z * h], k * 3);
      side[k] = s * 2 - 1; hh[k] = h;
    }
    if (i < N - 1) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  geo.setAttribute('aH', new THREE.BufferAttribute(hh, 1));
  geo.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    uniforms: { uUp: { value: up.clone() }, uRes: G.uResolution, uTimeC: G.uTime, uSunDirC: G.uSunDir, uH: { value: height } },
    vertexShader: /* glsl */`
      attribute float aSide; attribute float aH;
      uniform vec3 uUp; uniform vec2 uRes; uniform float uH;
      varying float vH; varying float vS; varying float vW;
      void main(){
        vec4 c0 = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec4 c1 = projectionMatrix * modelViewMatrix * vec4(position + uUp * 10.0, 1.0);
        vec2 s0 = c0.xy / c0.w, s1 = c1.xy / c1.w;
        vec2 dir = normalize((s1 - s0) * uRes + 1e-6);
        vec2 nrm = vec2(-dir.y, dir.x);
        float worldW = mix(7.0, 2.5, smoothstep(0.0, 3000.0, aH));
        // pixel width of the world width at this depth
        float px = worldW / max(c0.w, 1.0) * projectionMatrix[1][1] * uRes.y * 0.5;
        float w = max(px, 1.4);
        vW = px / w;
        c0.xy += nrm * aSide * w / uRes * c0.w * 2.0 * 0.5;
        gl_Position = c0;
        vH = aH; vS = aSide;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTimeC; uniform vec3 uSunDirC; uniform vec3 uUp; uniform float uH;
      varying float vH; varying float vS; varying float vW;
      void main(){
        float day = smoothstep(-0.1, 0.2, dot(uSunDirC, uUp));
        vec3 base = mix(vec3(0.05, 0.055, 0.06), vec3(0.55, 0.57, 0.6), day * (0.55 + 0.45 * vS * 0.5 + 0.25));
        // segment rings and beacons
        float ring = step(0.9, fract(vH / 60.0)) * smoothstep(0.6, 1.0, vW);
        base = mix(base, vec3(0.8, 0.82, 0.85) * (0.2 + day), ring * 0.5);
        base *= 0.85 + 0.3 * (0.5 + 0.5 * vS);
        vec3 emi = vec3(0.0);
        float blink = step(0.6, fract(uTimeC * 0.5 + vH / 5000.0));
        emi += vec3(1.0, 0.12, 0.06) * 8.0 * step(0.997, fract(vH / 6000.0)) * blink * step(vH, 20000.0);
        // climbers: two capsules riding up/down
        for (int i = 0; i < 3; i++) {
          float ph = fract(uTimeC * 0.004 + float(i) * 0.33);
          float hc = uH * ph * ph;
          emi += vec3(0.6, 0.85, 1.0) * 10.0 * (1.0 - smoothstep(0.0, 60.0 + hc * 0.01, abs(vH - hc)));
        }
        // faint glow of the lower tether at night
        emi += vec3(0.4, 0.6, 1.0) * (1.0 - day) * 0.6 * exp(-vH / 3000.0);
        gl_FragColor = vec4(base + emi, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, m);
  mesh.frustumCulled = false;
  mesh.name = 'civ-elevator';
  mesh.userData.noCSM = true;
  return mesh;
}
