// Seabed life around the camera: seagrass meadows, kelp forests, coral heads (branching, brain, fans), tube
// sponges and boulders — instanced, placed by the water worker on a planet-global lattice (reefplace.js),
// swaying in the surge of the passing waves and the current. Only alive while the camera is near the sea
// (seen through the clear shallows from above, or when swimming/diving). Colours follow the planet's art
// palette; bioluminescent / alien worlds get glowing polyp tips.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { buildReefGeometries } from './reefgeo.js';
import { REEF_TYPES, T_GRASS, T_KELP, T_BRANCH, T_BRAIN, T_FAN, T_ROCK, T_SPONGE } from './reefplace.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3();
const _p = new THREE.Vector3(), _a = new THREE.Vector3(), _up = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0), _c = new THREE.Color();

// per-type look: sway amplitude (m at the tip per metre of height), surface pattern id, roughness
const LOOK = [
  { sway: 0.35, pat: 0, rough: 0.7, side: THREE.DoubleSide, fluor: 0 },   // grass
  { sway: 0.1, pat: 0, rough: 0.6, side: THREE.DoubleSide, fluor: 0 },    // kelp (unit height → tip sway = 0.1·H)
  { sway: 0.015, pat: 1, rough: 0.85, side: THREE.FrontSide, fluor: 0.35 },  // branch coral (polyp dots)
  { sway: 0, pat: 2, rough: 0.9, side: THREE.FrontSide, fluor: 0.18 },       // brain coral (meander grooves)
  { sway: 0.12, pat: 3, rough: 0.8, side: THREE.DoubleSide, fluor: 0.3 },   // sea fan (mesh lattice)
  { sway: 0, pat: 4, rough: 0.95, side: THREE.FrontSide, fluor: 0 },      // boulder (encrusted speckle)
  { sway: 0.04, pat: 1, rough: 0.85, side: THREE.FrontSide, fluor: 0.22 },   // sponges
];

export class Reef {
  constructor(water) {
    this.water = water;
    const world = water.world;
    this.world = world;
    const q = world.quality || {};
    const tier = q.tier || 'high';
    const k = tier === 'low' ? 0.3 : tier === 'med' ? 0.55 : tier === 'ultra' ? 1.3 : 1;
    this.R = tier === 'low' ? 55 : tier === 'med' ? 70 : 85;
    this.caps = [1200, 260, 260, 260, 160, 260, 220].map((c) => Math.max(8, Math.round(c * k)));
    this.C = 6;
    this.per = tier === 'low' ? 3 : 5;
    const body = world.body, art = body.art || {}, pal = art.palette || {};
    this.glowK = (art.flora === 'bioluminescent' ? 2.2 : (art.flora === 'sparse-alien' || art.flora === 'giant' || body.type === 'exotic' || body.type === 'toxic') ? 0.9 : 0.0);
    // palette → coral colours (saturated, lit from above by blue-filtered light, so push warm & bright)
    const hex = (h, d) => { try { return new THREE.Color(h || d); } catch (_) { return new THREE.Color(d); } };
    const fl = (pal.flora && pal.flora.length ? pal.flora : ['#3f7f35', '#6cb04a', '#e0784a']).map((h) => hex(h, '#6cb04a'));
    const accent = hex(pal.accent, '#ffcf7a');
    // real reefs are mostly tan / olive / ochre / cream colonies with a few vivid ones (pink, violet, orange, teal)
    const reefCols = [
      hex('#ff7f6a'), hex('#ffb347'), hex('#c776d9'), hex('#f6e27a'), hex('#ff5f8f'), hex('#7fd6c8'), accent,
      ...fl.slice(2).map((c) => c.clone().offsetHSL(0, 0.15, 0.05)),
      hex('#b89266'), hex('#8f8250'), hex('#a8745a'), hex('#d2c29a'), hex('#7f8a5c'),
    ];
    const grass = hex(pal.grass, '#78b84e').lerp(new THREE.Color(0.18, 0.32, 0.08), 0.45);
    const kelpC = new THREE.Color(0.42, 0.34, 0.1).lerp(fl[0] || new THREE.Color(0.3, 0.4, 0.1), 0.25);
    const rockC = hex(pal.rock, '#8e8676').lerp(new THREE.Color(0.35, 0.36, 0.3), 0.35);
    this.palette = { reefCols, grass, kelpC, rockC, sand: hex(pal.sand, '#eadcad') };
    this.geoms = buildReefGeometries((body.seed ?? 1) >>> 0);
    this.uniforms = { uTime: G.uTime, uFlow: { value: new THREE.Vector3(1, 0, 0) }, uSurge: { value: 1 }, uGlowK: { value: this.glowK }, uFluorE: { value: 0 }, uFadeR: { value: this.R } };
    this.group = new THREE.Group();
    this.group.name = 'rv-reef';
    this.meshes = [];
    for (let t = 0; t < REEF_TYPES.length; t++) {
      const mat = this._material(t);
      const im = new THREE.InstancedMesh(this.geoms[t], mat, this.caps[t]);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = false;
      im.receiveShadow = true;
      im.name = 'rv-reef-' + REEF_TYPES[t];
      im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.caps[t] * 3), 3);
      this.meshes.push(im);
      this.group.add(im);
    }
    this.group.visible = false;
    world.root.add(this.group);
    this.pending = false;
    this.valid = false;
    this.center = new THREE.Vector3();
    this.reqId = 0;
    this.instances = 0;
    this.failed = false;
  }

  _material(t) {
    const L = LOOK[t];
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: L.rough, metalness: 0, side: L.side });
    const U = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = U.uTime; sh.uniforms.uFlow = U.uFlow; sh.uniforms.uSurge = U.uSurge;
      sh.uniforms.uGlowK = U.uGlowK; sh.uniforms.uFadeR = U.uFadeR; sh.uniforms.uFluorE = U.uFluorE;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute float sway; attribute float glow;
uniform float uTime, uSurge, uFadeR; uniform vec3 uFlow;
varying float vGlow; varying vec3 vRP;
#define SWAY ${L.sway.toFixed(3)}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  vRP = position;
  vGlow = glow;
  #ifdef USE_INSTANCING
  {
    mat3 im3 = mat3(instanceMatrix);
    float s2 = max(dot(im3[0], im3[0]), 1e-6);
    vec3 ip = instanceMatrix[3].xyz;
    // shrink into the bed near the edge of the live radius (no pop-in)
    vec3 wp = (modelMatrix * vec4(ip, 1.0)).xyz;
    float fade = 1.0 - smoothstep(uFadeR * 0.72, uFadeR * 0.98, length(wp - cameraPosition));
    transformed *= fade;
    #if ${L.sway > 0 ? 1 : 0}
    // surge of the passing waves (back and forth) + a steady lean down-current, phase travels with the flow
    float ph = dot(wp, uFlow) * 0.35 + dot(wp.xz, vec2(0.13, -0.21));
    float surge = sin(uTime * 0.9 - ph) * 0.75 + sin(uTime * 2.3 - ph * 2.1) * 0.18 + 0.35;
    vec3 perp = normalize(cross(uFlow, vec3(0.31, 0.93, 0.19)));
    vec3 dW = (uFlow * surge + perp * sin(uTime * 0.63 + ph * 1.7) * 0.35) * SWAY * uSurge * sway * sway * sqrt(s2);
    vec3 dL = transpose(im3) * dW / s2;
    transformed += dL * fade;
    #endif
  }
  #endif`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uGlowK, uTime, uFluorE; varying float vGlow; varying vec3 vRP;
float rfHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
  {
    #if ${L.pat} == 1
    // polyps: tiny bright dots over the surface
    vec3 pc = vRP * 38.0;
    vec3 cell = floor(pc); vec3 f = fract(pc) - 0.5;
    float dot1 = 1.0 - smoothstep(0.18, 0.34, length(f));
    diffuseColor.rgb *= 0.82 + 0.35 * dot1 * rfHash(cell);
    #elif ${L.pat} == 2
    // brain coral: meandering ridges and valleys
    float m = sin(vRP.x * 55.0 + sin(vRP.z * 21.0) * 2.6) * sin(vRP.z * 51.0 + sin(vRP.x * 19.0 + vRP.y * 9.0) * 2.8);
    float ridge = smoothstep(-0.2, 0.55, m);
    diffuseColor.rgb *= 0.55 + 0.6 * ridge;
    #elif ${L.pat} == 3
    // sea fan: fine mesh between the branches reads as a darker, dotted tone
    float mm = sin(vRP.x * 140.0) * sin(vRP.y * 140.0);
    diffuseColor.rgb *= 0.85 + 0.2 * step(0.6, mm);
    #elif ${L.pat} == 4
    // boulder: encrusting algae / sponge speckle
    float sp = rfHash(floor(vRP * 26.0));
    diffuseColor.rgb *= 0.78 + 0.34 * sp;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.25, 0.72, 0.85), step(0.93, sp) * 0.8);
    #endif
  }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * vGlow * uGlowK * (0.75 + 0.25 * sin(uTime * 1.3 + vRP.y * 7.0));
  // coral fluorescence (GFP-like pigments re-emit part of the incident light): proportional to the light
  // reaching the reef, keeps colonies saturated through the blue water
  totalEmissiveRadiance += diffuseColor.rgb * ${L.fluor.toFixed(3)} * uFluorE;`);
    };
    mat.customProgramCacheKey = () => 'rv-reef-' + t;
    mat.userData.rvReef = t;
    return mat;
  }

  /** per frame (from Water.lateUpdate): request placements around the nadir, fade in/out with altitude */
  update(camLocal, camH, dt) {
    const W = this.water;
    const near = camH < 260 && camH > -200;
    this.group.visible = near && this.valid;
    if (!near || !W.worker || this.failed) return;
    // current: down-wind in the wave frame (scene space = planet-local directions)
    this.uniforms.uFlow.value.copy(W.waves.T1);
    this.uniforms.uSurge.value = 0.6 + 0.8 * (W._amp ?? 1) * 0.6;
    const r = camLocal.length();
    _up.copy(camLocal).multiplyScalar(1 / r);
    // irradiance scale for the fluorescence (sun above the horizon + sky), ≈ E/π
    const kc = W.u?.uKeyColor?.value, kd = W.u?.uKeyDir?.value, a = G.uAmbientSky?.value;
    let E = 0;
    if (kc && kd) E += (kc.r * 0.2126 + kc.g * 0.7152 + kc.b * 0.0722) * Math.max(0, kd.dot(_up) / Math.max(kd.length(), 1e-6));
    if (a) E += (a.r * 0.2126 + a.g * 0.7152 + a.b * 0.0722);
    this.uniforms.uFluorE.value = Number.isFinite(E) ? E * 0.35 / Math.PI : 0;
    const moved = this.valid ? this.center.distanceTo(_up) * W.Rs : 1e9;
    if (this.pending || moved < this.R * 0.3) return;
    this.pending = true;
    this.reqId++;
    this._req = _up.clone();
    const body = this.world.body;
    W.worker.postMessage({
      type: 'reef', id: this.reqId,
      m: { dir: [_up.x, _up.y, _up.z], R: this.R, C: this.C, radius: body.radius, sea: W.seaLevel, seed: (body.seed ?? 1) >>> 0,
        per: this.per, caps: this.caps, warmBias: body.type === 'ocean' || body.type === 'jungle' ? 0.08 : 0 },
    });
  }

  apply(msg) {
    this.pending = false;
    if (msg.error) { this.failed = true; return; }
    if (msg.id !== this.reqId) return;
    const { pos, attr, n } = msg;
    // anchor: the requested nadir on the sea sphere (instance offsets stay small → float32-exact)
    const anchor = _a.copy(this._req).multiplyScalar(this.water.Rs);
    this.group.position.copy(anchor);
    this.group.updateMatrixWorld(true);
    const counts = new Int32Array(REEF_TYPES.length);
    const P = this.palette;
    for (let i = 0; i < n; i++) {
      const t = attr[i * 5] | 0, yaw = attr[i * 5 + 1], sc = attr[i * 5 + 2], va = attr[i * 5 + 3], depth = attr[i * 5 + 4];
      const im = this.meshes[t];
      const j = counts[t];
      if (j >= this.caps[t]) continue;
      counts[t]++;
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      _up.set(x, y, z).normalize();
      _q.setFromUnitVectors(_Y, _up);
      _q2.setFromAxisAngle(_Y, yaw);
      _q.multiply(_q2);
      // sink the base a little so nothing floats on a slope
      const sink = t === T_KELP ? 0.1 : t === T_GRASS ? 0.05 : 0.12 * sc;
      _p.set(x - _up.x * sink - anchor.x, y - _up.y * sink - anchor.y, z - _up.z * sink - anchor.z);
      if (t === T_KELP) _s.set(sc * 0.8, sc, sc * 0.8); else if (t === T_FAN) _s.set(sc, sc, sc); else _s.set(sc, sc * (t === T_BRAIN ? 0.8 + va * 0.5 : 1), sc);
      _m.compose(_p, _q, _s);
      im.setMatrixAt(j, _m);
      // colour per instance
      if (t === T_GRASS) _c.copy(P.grass).offsetHSL((va - 0.5) * 0.04, 0, (va - 0.5) * 0.08);
      else if (t === T_KELP) _c.copy(P.kelpC).offsetHSL((va - 0.5) * 0.05, 0, (va - 0.5) * 0.06);
      else if (t === T_ROCK) _c.copy(P.rockC).offsetHSL(0, 0, (va - 0.5) * 0.1);
      else {
        const cols = P.reefCols;
        _c.copy(cols[Math.floor(va * cols.length) % cols.length]);
        if (t === T_BRAIN) _c.lerp(P.sand, 0.35);
        if (t === T_SPONGE) _c.offsetHSL(0.03, -0.1, -0.05);
        // deeper colonies are paler (less light, less zooxanthellae) — the water filters the rest
        _c.offsetHSL(0, 0.1 - Math.min(0.25, depth * 0.008), 0.0);
      }
      im.setColorAt(j, _c);
    }
    let total = 0;
    for (let t = 0; t < this.meshes.length; t++) {
      const im = this.meshes[t];
      im.count = counts[t];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      total += counts[t];
    }
    this.instances = total;
    this.counts = Array.from(counts);
    this.center.copy(this._req);
    this.valid = true;
  }

  tris() {
    let t = 0;
    for (const im of this.meshes) t += (im.geometry.index.count / 3) * im.count;
    return t;
  }

  onOriginShift() { /* children of world.root in planet-local coordinates: nothing to do */ }

  dispose() {
    this.group.removeFromParent();
    for (const im of this.meshes) { im.material.dispose(); im.dispose?.(); }
    for (const g of this.geoms) g.dispose();
  }
}
