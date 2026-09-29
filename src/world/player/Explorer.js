// Player track — the Explorer: a procedurally modelled, skinned space-explorer character.
//
// One skeleton (24 bones, identity rest orientations, character space: +Y up, +Z forward, +X = left),
// five skinned meshes (fabric · hard shell · metal · glow · visor) → 5 draw calls (+ shadow pass).
// Suit design: armoured off-white plates with bevelled edges and panel grooves (normal atlas), dark
// technical fabric with quilted weave, accent colour blocking derived from the world's art direction,
// iridescent reflective visor, jetpack with twin thrusters, emissive trims, scarf wrap (cloth tails
// are simulated in Cloth.js). Everything is generated in code — no assets.
import * as THREE from 'three';
import {
  Assembler, loft, loftSurface, patch, ellipsoidSurface, ellipsoid, box, lathe, torus, cylinder, tube,
  xf, mirrorX, rigid, blendY, bandsY, quad, flatUv,
} from './geo.js';
import { getTextures } from './textures.js';
import { bakeSurface } from './bake.js';
import { G } from '../../core/Uniforms.js';

// ------------------------------------------------------------------ skeleton
export const B = {
  hips: 0, spine: 1, chest: 2, neck: 3, head: 4,
  shoulderL: 5, upperArmL: 6, foreArmL: 7, handL: 8,
  shoulderR: 9, upperArmR: 10, foreArmR: 11, handR: 12,
  thighL: 13, shinL: 14, footL: 15,
  thighR: 16, shinR: 17, footR: 18,
  pack: 19, fingersL: 20, fingersR: 21, antenna: 22, root: 23,
};
const REST = {
  root: [null, 0, 0, 0],
  hips: ['root', 0, 0.965, 0],
  spine: ['hips', 0, 1.075, -0.005],
  chest: ['spine', 0, 1.245, -0.01],
  neck: ['chest', 0, 1.475, -0.012],
  head: ['neck', 0, 1.585, 0.0],
  shoulderL: ['chest', 0.06, 1.405, -0.02],
  upperArmL: ['shoulderL', 0.19, 1.395, -0.025],
  foreArmL: ['upperArmL', 0.19, 1.115, -0.025],
  handL: ['foreArmL', 0.19, 0.855, -0.025],
  fingersL: ['handL', 0.19, 0.765, -0.02],
  thighL: ['hips', 0.092, 0.935, 0],
  shinL: ['thighL', 0.092, 0.51, 0.008],
  footL: ['shinL', 0.092, 0.09, -0.005],
  pack: ['chest', 0, 1.25, -0.17],
  antenna: ['head', 0.158, 1.70, -0.03],
};
// mirror right side
for (const k of ['shoulder', 'upperArm', 'foreArm', 'hand', 'fingers', 'thigh', 'shin', 'foot']) {
  const [p, x, y, z] = REST[k + 'L'];
  REST[k + 'R'] = [p === 'hips' || p === 'chest' ? p : p.replace(/L$/, 'R'), -x, y, z];
}
export const REST_POS = Object.fromEntries(Object.entries(REST).map(([k, v]) => [k, new THREE.Vector3(v[1], v[2], v[3])]));
export const PARENT = Object.fromEntries(Object.entries(REST).map(([k, v]) => [k, v[0]]));
export const BONE_NAMES = Object.keys(B).sort((a, b) => B[a] - B[b]);
export const DIM = {
  thigh: REST_POS.thighL.distanceTo(REST_POS.shinL),
  shin: REST_POS.shinL.distanceTo(REST_POS.footL),
  upper: REST_POS.upperArmL.distanceTo(REST_POS.foreArmL),
  fore: REST_POS.foreArmL.distanceTo(REST_POS.handL),
  ankle: 0.09, hip: 0.935, eye: 1.665,
};

export function makeSkeleton() {
  const bones = [];
  for (const name of BONE_NAMES) { const b = new THREE.Bone(); b.name = name; bones.push(b); }
  for (const name of BONE_NAMES) {
    const b = bones[B[name]], par = PARENT[name];
    const wp = REST_POS[name];
    if (par) {
      bones[B[par]].add(b);
      b.position.copy(wp).sub(REST_POS[par]);
    } else b.position.copy(wp);
  }
  const root = bones[B.root];
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  return { bones, skeleton, root };
}

// ------------------------------------------------------------------ art-directed hero palette
const hex = (h) => new THREE.Color(h);
const clamp01 = (x, a, b) => Math.min(b, Math.max(a, x));

/** Piping / seam cord running over a loft surface S at angle(s) a(y), from y0 to y1, lifted by `lift`. */
function seam(S, a, y0, y1, lift, radius, n = 14) {
  const pts = [], p = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    const y = y0 + (y1 - y0) * (i / n);
    const aa = typeof a === 'function' ? a(y) : a;
    S(aa, y, p); S.inside(aa, y, c);
    const d = p.clone().sub(c); d.y = 0; d.normalize();
    pts.push(p.clone().addScaledVector(d, lift));
  }
  return tube(pts, radius, n * 3, 5, false);
}
export function heroPalette(body) {
  const pal = body?.art?.palette || {};
  const key = body?.art?.key || '';
  // dominant environment hue from the ground palette
  const hsl = { h: 0, s: 0, l: 0 };
  let x = 0, y = 0, wsum = 0;
  for (const [c, w] of [[pal.grass, 1.2], [pal.grass2, 0.8], [pal.sand, 0.8], [pal.rock, 0.6]]) {
    if (!c) continue;
    new THREE.Color(c).getHSL(hsl);
    const ww = w * (0.2 + hsl.s);
    x += Math.cos(hsl.h * Math.PI * 2) * ww; y += Math.sin(hsl.h * Math.PI * 2) * ww; wsum += ww;
  }
  let envHue = wsum ? Math.atan2(y, x) / (Math.PI * 2) : 0.25;
  if (envHue < 0) envHue += 1;
  const warm = envHue < 0.12 || envHue > 0.9;
  const P = {
    shell: hex('#e9e4d9'), shell2: hex('#d3cdc0'), accent: hex('#d65f28'), accent2: hex('#a8431c'),
    suit: hex('#2c323b'), suit2: hex('#3a424e'), glove: hex('#3b3531'), sole: hex('#1c1a19'), strap: hex('#453c34'),
    metal: hex('#a2a8b0'), brass: hex('#b8935c'), dark: hex('#23252a'),
    glow: hex('#8af4ff'), scarf: hex('#c3301f'), scarf2: hex('#e0a13a'), visorTint: hex('#0b0d12'),
  };
  if (warm) {
    P.accent = hex('#1f8ea0'); P.accent2 = hex('#176c7c'); P.scarf = hex('#1a6fa8'); P.scarf2 = hex('#e8d6a8');
  } else if (envHue > 0.55 && envHue <= 0.9) {
    P.accent = hex('#e0892a'); P.scarf = hex('#e07a1c'); P.scarf2 = hex('#fff1c8');
  }
  // world-specific flourishes
  if (key === 'bladerunner') { P.glow = hex('#ff4fa8'); P.shell = hex('#d8dbe2'); P.scarf = hex('#d9263f'); }
  if (key === 'kubrick') { P.shell = hex('#f2f2f0'); P.accent = hex('#c9321f'); P.scarf = hex('#b8231a'); }
  if (key === 'rickmorty') { P.glow = hex('#7dff9a'); }
  if (key === 'botw') { P.scarf = hex('#c8341f'); P.accent = hex('#2f6fd0'); P.accent2 = hex('#244f96'); }
  if (key === 'outerwilds') { P.accent = hex('#d8702a'); P.scarf = hex('#b83a24'); }
  // dust / grime colour from the world's ground (desaturated, mid value) — the suit wears the planet
  {
    const d = new THREE.Color(pal.sand || pal.rock || '#8a7a64');
    if (pal.rock) d.lerp(new THREE.Color(pal.rock), 0.35);
    d.getHSL(hsl);
    d.setHSL(hsl.h, Math.min(hsl.s, 0.32) * 0.8, clamp01(hsl.l * 0.8 + 0.12, 0.3, 0.5));
    P.dust = d;
  }
  P.envHue = envHue; P.warm = warm;
  return P;
}

// ------------------------------------------------------------------ materials
function patchLighting(mat, { rim = 0.0, wear = 1, key = 'x' } = {}) {
  // • stylised rim/back light so silhouettes read against bright skies (BotW / Journey look)
  // • per-vertex wear from the surface bake (bake.js): dirt roughens and kills the clearcoat,
  //   chipped edges turn glossier / metallic
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRimStrength = { value: rim };
    sh.uniforms.uWearK = { value: wear };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aWear;\nvarying vec2 vWear;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWear = aWear;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uRimStrength; uniform float uWearK;\nvarying vec2 vWear;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + vWear.x * 0.32 * uWearK - vWear.y * 0.22 * uWearK, 0.04, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = clamp(metalnessFactor + vWear.y * 0.3 * uWearK, 0.0, 1.0);`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          material.clearcoat *= 1.0 - clamp(vWear.x * 1.3, 0.0, 1.0);
        #endif`)
      .replace('#include <opaque_fragment>', `
        {
          vec3 V = normalize(vViewPosition);
          float ndv = clamp(dot(normal, -V), 0.0, 1.0);
          float rimT = pow(1.0 - ndv, 3.0) * uRimStrength;
          outgoingLight += rimT * (totalDiffuse * 0.6 + diffuseColor.rgb * 0.08);
        }
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'rv-suit-' + key + '-' + rim;
  return mat;
}

/**
 * Gold-film astronaut visor: a procedural sky / horizon / ground / sun reflection (in the planet's local
 * frame) layered over the PBR env reflection, so the dome always reads as polished glass (Starfield/NMS).
 * `mat.userData.uUp` must be fed the player's local up each frame.
 */
function patchVisor(mat, P) {
  const uUp = { value: new THREE.Vector3(0, 1, 0) };
  const tint = { value: P.visorGold || new THREE.Color(1.0, 0.74, 0.4) };
  mat.userData.uUp = uUp;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uVUp = uUp; sh.uniforms.uVTint = tint;
    sh.uniforms.uVSun = G.uSunColor; sh.uniforms.uVSunDir = G.uSunDir; sh.uniforms.uVSky = G.uAmbientSky; sh.uniforms.uVGround = G.uAmbientGround;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uVUp; uniform vec3 uVTint; uniform vec3 uVSun; uniform vec3 uVSunDir; uniform vec3 uVSky; uniform vec3 uVGround;')
      .replace('#include <opaque_fragment>', `
        {
          vec3 Vv = normalize(vViewPosition);
          vec3 Rv = reflect(-Vv, normal);
          vec3 Rw = normalize((vec4(Rv, 0.0) * viewMatrix).xyz);
          float h = dot(Rw, uVUp);
          float fres = 0.3 + 0.7 * pow(1.0 - clamp(dot(normal, Vv), 0.0, 1.0), 2.5);
          vec3 sky = mix(uVSky * 1.1 + 0.02, uVSky * 2.6 + 0.04, smoothstep(0.0, 0.8, h));
          vec3 grd = uVGround * 0.25 + 0.004;
          vec3 env = mix(grd, sky, smoothstep(-0.06, 0.05, h));
          env += (uVSun * 0.12 + uVSky * 0.6) * exp(-abs(h) * 16.0);
          float sd = max(dot(Rw, normalize(uVSunDir)), 0.0);
          vec3 spec = uVSun * (pow(sd, 1200.0) * 40.0 + pow(sd, 60.0) * 0.5);
          outgoingLight += (env * fres) * uVTint * 0.32 + spec * uVTint;
          // soft studio-window glint (reads as a curved glass dome at any distance)
          vec3 Rvn = normalize(Rv);
          float win = smoothstep(0.35, 0.75, Rvn.y) * smoothstep(0.55, 0.1, abs(Rvn.x + 0.25));
          outgoingLight += uVTint * (uVSky * 1.6 + uVSun * 0.05) * win * 0.55;
          // warm gold interference band near the rim of the dome
          float rimG = pow(1.0 - clamp(dot(normal, Vv), 0.0, 1.0), 4.0);
          outgoingLight += vec3(1.0, 0.62, 0.2) * rimG * (uVSky * 0.9 + uVSun * 0.08);
        }
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'rv-visor';
  return mat;
}

export function makeMaterials(renderer, P, quality) {
  const tex = getTextures(renderer);
  const hi = quality?.tier !== 'low';
  const Std = hi ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const fabric = new Std({ vertexColors: true, roughness: 0.86, metalness: 0.0, normalMap: tex.fabricNormal, normalScale: new THREE.Vector2(0.55, 0.55) });
  if (hi) { fabric.sheen = 0.3; fabric.sheenRoughness = 0.6; fabric.sheenColor = new THREE.Color(P.suit).lerp(new THREE.Color(0.5, 0.52, 0.56), 0.35); }
  if (tex.fabricNormal) tex.fabricNormal.repeat.set(9, 9);
  const hard = new Std({ vertexColors: true, roughness: 0.52, metalness: 0.0, map: tex.panelAlbedo || null, normalMap: tex.panelNormal, normalScale: new THREE.Vector2(0.9, 0.9), roughnessMap: tex.wearRough });
  if (hi) { hard.clearcoat = 0.22; hard.clearcoatRoughness = 0.4; }
  if (tex.wearRough) tex.wearRough.repeat.set(3, 3);
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.92, roughnessMap: tex.wearRough });
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1, 1, 1).multiplyScalar(4.0) });
  const visor = hi
    ? new THREE.MeshPhysicalMaterial({
      // gold-film sun visor: gold metal F0 under a glass clearcoat, thin-film sheen at grazing angles
      color: new THREE.Color(0.5, 0.31, 0.09), roughness: 0.1, metalness: 1.0, clearcoat: 1, clearcoatRoughness: 0.03,
      iridescence: 0.25, iridescenceIOR: 1.35, iridescenceThicknessRange: [300, 480], envMapIntensity: 1.0,
    })
    : new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.31, 0.09), roughness: 0.1, metalness: 1.0, envMapIntensity: 1.0 });
  patchVisor(visor, P);
  patchLighting(fabric, { rim: 0.6, key: 'fabric' });
  patchLighting(hard, { rim: 0.8, key: 'hard' });
  patchLighting(metal, { rim: 0.3, key: 'metal', wear: 0.6 });
  const mats = { fabric, hard, metal, glow, visor };
  for (const m of Object.values(mats)) { m.name = 'rv-explorer-' + (m.type || ''); }
  return mats;
}

// ------------------------------------------------------------------ model
/**
 * Build the explorer. Returns { group, root (bone), bones, skeleton, meshes, materials, palette, anchors }.
 * `quality` scales tessellation.
 */
export function buildExplorer(renderer, body, quality) {
  const P = heroPalette(body);
  const lod = quality?.tier === 'low' ? 0.6 : quality?.tier === 'med' ? 0.8 : 1;
  const R = (n) => Math.max(6, Math.round(n * lod));
  const A = new Assembler();
  const L = (name) => B[name + 'L'], Rt = (name) => B[name + 'R'];

  // ---------------- torso (fabric)
  const torsoSecs = [
    { y: 0.84, rx: 0.112, rz: 0.084 },
    { y: 0.93, rx: 0.156, rz: 0.106, e: 2.3 },
    { y: 1.00, rx: 0.158, rz: 0.104, e: 2.4 },
    { y: 1.07, rx: 0.142, rz: 0.098, e: 2.4 },
    { y: 1.15, rx: 0.149, rz: 0.104, e: 2.5 },
    { y: 1.25, rx: 0.167, rz: 0.114, fz: 0.012, e: 2.6 },
    { y: 1.34, rx: 0.178, rz: 0.12, fz: 0.018, e: 2.7 },
    { y: 1.41, rx: 0.172, rz: 0.114, fz: 0.012, e: 2.8 },
    { y: 1.46, rx: 0.128, rz: 0.092, e: 2.4 },
    { y: 1.495, rx: 0.074, rz: 0.068 },
    { y: 1.56, rx: 0.056, rz: 0.056 },
  ];
  const torsoSkin = bandsY([[B.hips, 0.95], [B.spine, 1.1], [B.chest, 1.27], [B.chest, 1.45], [B.neck, 1.52]]);
  A.add('fabric', loft(torsoSecs, { radial: R(28), sub: 3, closeBottom: true }), P.suit, torsoSkin);
  const TS = loftSurface(torsoSecs);
  // abdominal bellows
  for (let i = 0; i < 4; i++) {
    const y = 1.035 + i * 0.03;
    const g = torus(0.146 + (i === 0 || i === 3 ? 0.002 : 0.006), 0.0105, R(8), R(28));
    xf(g, 0, y, 0, Math.PI / 2, 0, 0, 1, 0.7, 1);
    A.add('fabric', g, P.suit2, torsoSkin);
  }
  // chest plate (shell) + yoke (accent) + back plate + side ribs
  const chestSkin = bandsY([[B.spine, 1.16], [B.chest, 1.27]]);
  A.add('hard', patch(TS, { u0: -1.2, u1: 1.2, v0: 1.17, v1: 1.37, nu: R(14), nv: R(10), off: 0.011, thick: 0.016, bevel: 0.009, round: 5, bulge: 0.01, uvRect: quad(1), taper: (t) => [-0.95 - 0.3 * t, 0.95 + 0.3 * t] }), P.shell, chestSkin);
  A.add('hard', patch(TS, { u0: -1.42, u1: 1.42, v0: 1.378, v1: 1.452, nu: R(16), nv: R(5), off: 0.013, thick: 0.014, bevel: 0.008, round: 4, uvRect: quad(0) }), P.accent, rigid(B.chest));
  A.add('hard', patch(TS, { u0: Math.PI - 1.05, u1: Math.PI + 1.05, v0: 1.13, v1: 1.43, nu: R(12), nv: R(10), off: 0.01, thick: 0.014, bevel: 0.008, round: 5, uvRect: quad(2) }), P.shell2, chestSkin);
  for (const s of [1, -1]) {
    const g = patch(TS, { u0: s * 1.45 - 0.28, u1: s * 1.45 + 0.28, v0: 1.08, v1: 1.24, nu: R(6), nv: R(8), off: 0.009, thick: 0.012, bevel: 0.006, round: 6, uvRect: quad(3) });
    A.add('hard', g, P.shell2, bandsY([[B.spine, 1.1], [B.chest, 1.24]]));
  }
  // chest status light + accent stripe
  { const g = box(0.035, 0.012, 0.01, 0.004); xf(g, -0.085, 1.325, 0.152, -0.2, -0.45, 0); A.add('glow', g, P.glow, rigid(B.chest)); }
  { const g = box(0.012, 0.09, 0.012, 0.004); xf(g, 0.085, 1.28, 0.148, -0.18, 0.42, 0); A.add('hard', g, P.accent, rigid(B.chest)); }

  // side seams (accent piping) + front zip on the undersuit
  for (const sd of [1, -1]) A.add('fabric', seam(TS, sd * Math.PI / 2, 0.86, 1.43, 0.003, 0.0052, 16), P.accent2, torsoSkin);
  A.add('metal', seam(TS, 0, 0.99, 1.17, 0.002, 0.0042, 10), P.metal, torsoSkin);
  { const g = box(0.012, 0.022, 0.006, 0.002); xf(g, 0, 1.165, 0.118); A.add('metal', g, P.brass, rigid(B.chest)); }
  // belt + buckle + pouches
  { const g = torus(0.158, 0.021, R(8), R(32)); xf(g, 0, 0.978, 0.004, Math.PI / 2, 0, 0, 1, 0.69, 1); A.add('hard', g, P.strap, rigid(B.hips)); }
  { const g = box(0.07, 0.05, 0.024, 0.008); xf(g, 0, 0.978, 0.113); A.add('metal', g, P.brass, rigid(B.hips)); }
  { const g = box(0.036, 0.02, 0.012, 0.004); xf(g, 0, 0.978, 0.126); A.add('glow', g, P.glow, rigid(B.hips)); }
  for (const [a, w, h] of [[1.95, 0.075, 0.07], [-1.95, 0.075, 0.07], [2.55, 0.06, 0.06], [-2.55, 0.06, 0.06]]) {
    const g = box(w, h, 0.045, 0.012);
    const x = Math.sin(a) * 0.17, z = Math.cos(a) * 0.115;
    xf(g, x, 0.962, z, 0, a, 0);
    A.add('hard', g, P.shell2, rigid(B.hips));
  }
  // hip guards (move with the thighs)
  for (const s of [1, -1]) {
    const g = patch(TS, { u0: s * 1.55 - 0.42, u1: s * 1.55 + 0.42, v0: 0.84, v1: 0.955, nu: R(8), nv: R(6), off: 0.028, thick: 0.012, bevel: 0.006, round: 5, back: true, uvRect: quad(0) });
    A.add('hard', g, P.shell, rigid(s > 0 ? B.thighL : B.thighR));
  }
  // collar ring + scarf wrap
  { const g = torus(0.079, 0.013, R(8), R(28)); xf(g, 0, 1.515, -0.004, Math.PI / 2); A.add('metal', g, P.metal, rigid(B.neck)); }
  { const g = torus(0.104, 0.034, R(10), R(30)); xf(g, 0, 1.478, -0.01, Math.PI / 2 + 0.1, 0, 0, 1, 1, 0.9); A.add('fabric', g, P.scarf, bandsY([[B.chest, 1.45], [B.neck, 1.5]])); }
  { const g = ellipsoid(0.07, 0.05, 0.05, R(12), R(8)); xf(g, 0.03, 1.47, 0.085, 0.3, 0.2, 0.3); A.add('fabric', g, P.scarf, rigid(B.chest)); }

  // ---------------- arms (left built, mirrored for right)
  const buildArm = (side) => {
    const x = 0.19 * side, z = -0.025;
    const ax = (b) => B[b + (side > 0 ? 'L' : 'R')];
    const secs = [
      { y: 0.84, rx: 0.036, rz: 0.04, ox: x, oz: z },
      { y: 0.88, rx: 0.039, rz: 0.043, ox: x, oz: z },
      { y: 1.0, rx: 0.045, rz: 0.049, ox: x, oz: z },
      { y: 1.1, rx: 0.046, rz: 0.049, ox: x, oz: z },
      { y: 1.2, rx: 0.052, rz: 0.055, ox: x, oz: z },
      { y: 1.33, rx: 0.058, rz: 0.06, ox: x, oz: z },
      { y: 1.45, rx: 0.056, rz: 0.058, ox: x, oz: z },
    ];
    for (const q of secs) { q.rx *= 1.13; q.rz *= 1.13; }
    const skin = bandsY([[ax('hand'), 0.845], [ax('foreArm'), 0.875], [ax('foreArm'), 1.085], [ax('upperArm'), 1.14]]);
    A.add('fabric', loft(secs, { radial: R(18), sub: 3 }), P.suit, skin);
    const AS = loftSurface(secs);
    const outer = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    // outer piping + inner seam
    A.add('fabric', seam(AS, outer, 0.9, 1.44, 0.002, 0.0045, 12), P.accent2, skin);
    A.add('fabric', seam(AS, -outer, 0.9, 1.3, 0.001, 0.0032, 10), P.suit2, skin);
    // gauntlet
    A.add('hard', patch(AS, { u0: outer - 1.55, u1: outer + 1.55, v0: 0.885, v1: 1.06, nu: R(10), nv: R(8), off: 0.008, thick: 0.012, bevel: 0.006, round: 5, uvRect: quad(3) }), P.shell, rigid(ax('foreArm')));
    // upper arm band (accent)
    A.add('hard', patch(AS, { u0: outer - 1.7, u1: outer + 1.7, v0: 1.2, v1: 1.27, nu: R(10), nv: R(4), off: 0.007, thick: 0.01, bevel: 0.005, round: 4, uvRect: quad(0) }), P.accent, rigid(ax('upperArm')));
    // shoulder pauldron (two layers)
    const sc = new THREE.Vector3(x, 1.4, z);
    const E1 = ellipsoidSurface(sc, new THREE.Vector3(0.082, 0.07, 0.085));
    A.add('hard', patch(E1, { u0: outer - 1.25, u1: outer + 1.25, v0: -0.25, v1: 1.3, nu: R(12), nv: R(10), off: 0.012, thick: 0.012, bevel: 0.007, round: 5, back: true, uvRect: quad(0) }), P.shell, rigid(ax('upperArm')));
    const E2 = ellipsoidSurface(sc.clone().add(new THREE.Vector3(0.004 * side, -0.05, 0)), new THREE.Vector3(0.078, 0.06, 0.08));
    A.add('hard', patch(E2, { u0: outer - 1.1, u1: outer + 1.1, v0: -0.55, v1: 0.2, nu: R(10), nv: R(6), off: 0.014, thick: 0.01, bevel: 0.006, round: 5, back: true, uvRect: quad(0) }), P.accent, rigid(ax('upperArm')));
    // pauldron light strip
    { const g = box(0.008, 0.01, 0.05, 0.003); xf(g, x + side * 0.094, 1.39, z); A.add('glow', g, P.glow, rigid(ax('upperArm'))); }
    // elbow pad
    { const g = ellipsoid(0.038, 0.042, 0.022, R(12), R(8)); xf(g, x, 1.1, z - 0.045); A.add('hard', g, P.shell2, rigid(ax('upperArm'))); }
    // wrist ring
    { const g = torus(0.041, 0.008, R(6), R(18)); xf(g, x, 0.872, z, Math.PI / 2); A.add('metal', g, P.metal, rigid(ax('foreArm'))); }
    // wrist device (left arm only): screen
    if (side > 0) {
      const g = box(0.022, 0.07, 0.048, 0.006); xf(g, x + 0.05, 0.96, z); A.add('hard', g, P.dark, rigid(ax('foreArm')));
      const s = box(0.004, 0.052, 0.034, 0.002); xf(s, x + 0.061, 0.96, z); A.add('glow', s, P.glow, rigid(ax('foreArm')));
    }
    // glove: palm, fingers, thumb, knuckle guard
    const hx = x, hz = z + 0.005;
    { const g = box(0.048, 0.085, 0.086, 0.018); xf(g, hx, 0.8, hz); A.add('fabric', g, P.glove, rigid(ax('hand'))); }
    { const g = box(0.042, 0.078, 0.08, 0.017); xf(g, hx - side * 0.004, 0.728, hz + 0.004, 0, 0, side * 0.06); A.add('fabric', g, P.glove, rigid(ax('fingers'))); }
    { const g = ellipsoid(0.017, 0.035, 0.017, R(10), R(8)); xf(g, hx - side * 0.012, 0.78, hz + 0.05, 0.5, 0, -side * 0.25); A.add('fabric', g, P.glove, rigid(ax('hand'))); }
    { const g = box(0.012, 0.05, 0.07, 0.005); xf(g, hx + side * 0.027, 0.805, hz); A.add('hard', g, P.shell2, rigid(ax('hand'))); }
    // cuff
    { const g = cylinder(0.046, 0.043, 0.035, R(16)); xf(g, hx, 0.852, hz); A.add('fabric', g, P.glove, rigid(ax('hand'))); }
  };
  buildArm(1); buildArm(-1);

  // ---------------- legs
  const buildLeg = (side) => {
    const x = 0.092 * side;
    const lb = (b) => B[b + (side > 0 ? 'L' : 'R')];
    const secs = [
      { y: 0.1, rx: 0.042, rz: 0.047, ox: x },
      { y: 0.22, rx: 0.047, rz: 0.053, ox: x },
      { y: 0.35, rx: 0.056, rz: 0.058, ox: x, bz: 0.012 },
      { y: 0.46, rx: 0.052, rz: 0.056, ox: x },
      { y: 0.52, rx: 0.056, rz: 0.06, ox: x },
      { y: 0.63, rx: 0.068, rz: 0.07, ox: x },
      { y: 0.78, rx: 0.079, rz: 0.083, ox: x },
      { y: 0.9, rx: 0.087, rz: 0.089, ox: x },
      { y: 0.99, rx: 0.08, rz: 0.08, ox: x - side * 0.01 },
    ];
    for (const q of secs) { if (q.y > 0.2) { q.rx *= 1.14; q.rz *= 1.14; } }
    const skin = bandsY([[lb('foot'), 0.09], [lb('shin'), 0.15], [lb('shin'), 0.475], [lb('thigh'), 0.555], [lb('thigh'), 0.9], [B.hips, 1.0]]);
    A.add('fabric', loft(secs, { radial: R(20), sub: 3 }), P.suit, skin);
    const LS = loftSurface(secs);
    const outer = side > 0 ? 0.7 : -0.7;
    // outer piping + inner seam + knee quilting
    A.add('fabric', seam(LS, side > 0 ? Math.PI / 2 : -Math.PI / 2, 0.27, 0.95, 0.002, 0.0055, 16), P.accent2, skin);
    A.add('fabric', seam(LS, side > 0 ? -Math.PI / 2 : Math.PI / 2, 0.27, 0.86, 0.001, 0.0035, 12), P.suit2, skin);
    // thigh plate
    A.add('hard', patch(LS, { u0: outer - 1.15, u1: outer + 1.15, v0: 0.64, v1: 0.86, nu: R(10), nv: R(8), off: 0.009, thick: 0.013, bevel: 0.007, round: 5, uvRect: quad(1) }), P.shell, rigid(lb('thigh')));
    // thigh pouch (right) / holster
    if (side < 0) { const g = box(0.04, 0.09, 0.075, 0.014); xf(g, x - 0.085, 0.74, 0.0); A.add('hard', g, P.shell2, rigid(lb('thigh'))); }
    else { const g = box(0.02, 0.1, 0.05, 0.006); xf(g, x + 0.083, 0.72, 0.0); A.add('hard', g, P.accent, rigid(lb('thigh'))); }
    // shin guard
    A.add('hard', patch(LS, { u0: -1.05, u1: 1.05, v0: 0.25, v1: 0.46, nu: R(10), nv: R(9), off: 0.009, thick: 0.013, bevel: 0.007, round: 5, uvRect: quad(3), taper: (t) => [-0.95 + 0.1 * t, 0.95 - 0.1 * t] }), P.shell, rigid(lb('shin')));
    // knee pad
    const KE = ellipsoidSurface(new THREE.Vector3(x, 0.515, 0.02), new THREE.Vector3(0.058, 0.066, 0.05));
    A.add('hard', patch(KE, { u0: -1.15, u1: 1.15, v0: -0.95, v1: 0.95, nu: R(10), nv: R(10), off: 0.006, thick: 0.012, bevel: 0.006, round: 4, uvRect: quad(0) }), P.accent, rigid(lb('shin')));
    // boot shaft
    const bootSecs = [
      { y: 0.035, rx: 0.058, rz: 0.075, ox: x, oz: 0.01 },
      { y: 0.1, rx: 0.058, rz: 0.066, ox: x },
      { y: 0.2, rx: 0.059, rz: 0.064, ox: x },
      { y: 0.255, rx: 0.061, rz: 0.066, ox: x },
    ];
    A.add('hard', loft(bootSecs, { radial: R(18), sub: 2 }), P.dark, bandsY([[lb('foot'), 0.17], [lb('shin'), 0.25]]));
    { const g = torus(0.062, 0.009, R(6), R(20)); xf(g, x, 0.255, 0, Math.PI / 2, 0, 0, 1, 1.07, 1); A.add('hard', g, P.accent, rigid(lb('shin'))); }
    // foot
    { const g = box(0.104, 0.085, 0.262, 0.035, 3); xf(g, x, 0.052, 0.048); A.add('hard', g, P.dark, rigid(lb('foot'))); }
    { const g = box(0.098, 0.03, 0.12, 0.012, 2); xf(g, x, 0.088, 0.11, 0.18, 0, 0); A.add('hard', g, P.shell2, rigid(lb('foot'))); }
    { const g = box(0.114, 0.026, 0.278, 0.011, 2); xf(g, x, 0.013, 0.047); A.add('fabric', g, P.sole, rigid(lb('foot'))); }
    { const g = box(0.05, 0.012, 0.008, 0.003); xf(g, x, 0.07, -0.084); A.add('glow', g, P.glow, rigid(lb('foot'))); }
  };
  buildLeg(1); buildLeg(-1);

  // ---------------- helmet
  const hc = new THREE.Vector3(0, 1.668, 0.012);
  const hr = new THREE.Vector3(0.148, 0.158, 0.163);
  const helmetDeform = (v) => {
    // flatter sides, chin forward, fuller back
    const y = (v.y - hc.y) / hr.y, z = (v.z - hc.z) / hr.z;
    if (y < -0.2 && z > 0) v.z += 0.018 * Math.min(1, -y - 0.2) * z;
    if (z < 0) v.z -= 0.012 * (-z) * (1 - Math.abs(y));
    v.x *= 1 - 0.05 * Math.max(0, 1 - Math.abs(y) * 1.4);
  };
  {
    const g = ellipsoid(hr.x, hr.y, hr.z, R(40), R(28), { e: 2.25, deform: (v) => { v.add(hc); helmetDeform(v); } });
    A.add('hard', g, P.shell, rigid(B.head));
  }
  const HS = ellipsoidSurface(hc, hr.clone().multiplyScalar(1.0), (v, az, el) => { v.add(hc); helmetDeform(v); v.sub(hc); });
  // visor
  const visorTaper = (t) => [-0.86 - 0.26 * t, 0.86 + 0.26 * t];
  A.add('visor', patch(HS, { u0: -1.1, u1: 1.1, v0: -0.6, v1: 0.42, nu: R(22), nv: R(14), off: 0.006, thick: 0.01, bevel: 0.004, round: 3.2, taper: visorTaper }), P.visorTint, rigid(B.head));
  // visor frame (tube following the outline)
  {
    const pts = [];
    const tmp = new THREE.Vector3(), c2 = new THREE.Vector3();
    const n = 40;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      // squircle outline (round 3.2) in (s,t)
      const ca = Math.cos(a), sa = Math.sin(a);
      const k = Math.pow(Math.pow(Math.abs(ca), 3.2) + Math.pow(Math.abs(sa), 3.2), -1 / 3.2);
      const s = ca * k * 1.04, t = sa * k * 1.05;
      const tt = (t + 1) / 2;
      const [ua, ub] = visorTaper(tt);
      const u = ua + (ub - ua) * (s + 1) / 2, v = -0.6 + 1.02 * tt;
      HS(u, v, tmp);
      c2.copy(tmp).sub(hc).normalize();
      pts.push(tmp.clone().addScaledVector(c2, 0.004));
    }
    A.add('metal', tube(pts, 0.0065, R(80), 6, true), P.dark, rigid(B.head));
  }
  // crest ridge
  {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const el = 0.5 + (i / 10) * 2.1; // front-top over to the back
      const v = new THREE.Vector3(0, Math.sin(el) * hr.y, Math.cos(el) * hr.z).add(hc);
      helmetDeform(v);
      pts.push(v.add(new THREE.Vector3(0, 0.004, 0).add(v.clone().sub(hc).normalize().multiplyScalar(0.004))));
    }
    const g = tube(pts, 0.012, R(40), 8, false);
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) pa.setX(i, pa.getX(i) * 1.7);
    g.computeVertexNormals();
    A.add('hard', g, P.accent, rigid(B.head));
  }
  // ear pods + glow rings + antenna
  for (const s of [1, -1]) {
    const px = s * 0.147;
    { const g = cylinder(0.047, 0.05, 0.036, R(20)); xf(g, px, 1.655, -0.01, 0, 0, Math.PI / 2); A.add('hard', g, P.shell2, rigid(B.head)); }
    { const g = torus(0.033, 0.0045, R(6), R(22)); xf(g, px + s * 0.019, 1.655, -0.01, 0, Math.PI / 2, 0); A.add('glow', g, P.glow, rigid(B.head)); }
    { const g = cylinder(0.024, 0.028, 0.012, R(16)); xf(g, px + s * 0.02, 1.655, -0.01, 0, 0, Math.PI / 2); A.add('metal', g, P.metal, rigid(B.head)); }
  }
  {
    const g = cylinder(0.0035, 0.005, 0.2, 6);
    xf(g, 0, 0.1, 0);
    xf(g, 0.166, 1.69, -0.035, -0.28, 0, -0.12);
    A.add('metal', g, P.metal, blendY(B.head, B.antenna, 1.71, 1.76));
    const t = ellipsoid(0.009, 0.009, 0.009, 8, 6); xf(t, 0.166 + Math.sin(0.12) * 0.2, 1.69 + Math.cos(0.28) * 0.2, -0.035 - Math.sin(0.28) * 0.2);
    A.add('glow', t, P.glow, rigid(B.antenna));
  }
  // rear helmet vent + light
  { const g = box(0.07, 0.03, 0.02, 0.008); xf(g, 0, 1.64, -0.158, -0.25); A.add('hard', g, P.dark, rigid(B.head)); }
  { const g = box(0.05, 0.006, 0.006, 0.002); xf(g, 0, 1.64, -0.169, -0.25); A.add('glow', g, P.glow, rigid(B.head)); }

  // ---------------- backpack / jetpack
  const pk = rigid(B.pack);
  {
    const bx = box(0.3, 0.4, 0.15, 0.045, 3);
    // panel detail on the back face: map uv into atlas quadrant 2 (vents)
    const pa = bx.attributes.position, uva = bx.attributes.uv;
    const q = quad(2);
    for (let i = 0; i < pa.count; i++) {
      const u = (pa.getX(i) / 0.3) + 0.5, v = (pa.getY(i) / 0.4) + 0.5;
      uva.setXY(i, q[0] + (q[2] - q[0]) * u, q[1] + (q[3] - q[1]) * v);
    }
    xf(bx, 0, 1.235, -0.228);
    A.add('hard', bx, P.shell2, pk);
  }
  { const g = cylinder(0.058, 0.058, 0.31, R(20)); xf(g, 0, 1.455, -0.205, 0, 0, Math.PI / 2); A.add('hard', g, P.accent, pk); }
  for (const s of [1, -1]) {
    { const g = cylinder(0.062, 0.062, 0.012, R(20)); xf(g, s * 0.158, 1.455, -0.205, 0, 0, Math.PI / 2); A.add('metal', g, P.metal, pk); }
    { const g = cylinder(0.036, 0.036, 0.27, R(16)); xf(g, s * 0.168, 1.215, -0.215); A.add('hard', g, P.shell, pk); }
    { const g = torus(0.037, 0.006, R(6), R(16)); xf(g, s * 0.168, 1.3, -0.215, Math.PI / 2); A.add('metal', g, P.metal, pk); }
    { const g = torus(0.037, 0.006, R(6), R(16)); xf(g, s * 0.168, 1.13, -0.215, Math.PI / 2); A.add('metal', g, P.metal, pk); }
    // thruster nozzle
    const nz = lathe([[0.03, 0.0], [0.036, -0.012], [0.046, -0.045], [0.05, -0.07], [0.046, -0.074], [0.036, -0.05], [0.028, -0.02]], R(20));
    xf(nz, s * 0.085, 1.04, -0.245, -0.18, 0, 0);
    A.add('metal', nz, P.metal, pk);
    const gl = cylinder(0.032, 0.036, 0.004, R(16)); xf(gl, s * 0.085, 0.976, -0.257, -0.18, 0, 0);
    A.add('glow', gl, P.glow, pk);
  }
  // pack face details: status strip, grab handle, badge
  { const g = box(0.012, 0.16, 0.006, 0.003); xf(g, 0.1, 1.24, -0.306); A.add('glow', g, P.glow, pk); }
  { const g = tube([new THREE.Vector3(-0.07, 1.4, -0.29), new THREE.Vector3(-0.04, 1.43, -0.31), new THREE.Vector3(0.04, 1.43, -0.31), new THREE.Vector3(0.07, 1.4, -0.29)], 0.008, 16, 6); A.add('metal', g, P.dark, pk); }
  { const g = box(0.08, 0.05, 0.012, 0.01); xf(g, -0.06, 1.15, -0.304); A.add('hard', g, P.accent, pk); }
  // straps (over the shoulders to the chest plate)
  for (const s of [1, -1]) {
    const pts = [
      new THREE.Vector3(s * 0.11, 1.40, -0.16), new THREE.Vector3(s * 0.125, 1.47, -0.08),
      new THREE.Vector3(s * 0.13, 1.47, 0.03), new THREE.Vector3(s * 0.12, 1.41, 0.125), new THREE.Vector3(s * 0.11, 1.33, 0.152),
    ];
    const g = tube(pts, 0.014, R(24), 6);
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) { const xx = pa.getX(i); pa.setX(i, s * 0.12 + (xx - s * 0.12) * 1.9); }
    g.computeVertexNormals();
    A.add('fabric', g, P.strap, rigid(B.chest));
    const bk = box(0.034, 0.028, 0.016, 0.005); xf(bk, s * 0.11, 1.33, 0.158, -0.25); A.add('metal', bk, P.brass, rigid(B.chest));
  }

  // ---------------- assemble
  const geos = A.build();
  try { bakeSurface(geos, P, lod); } catch (e) { console.warn('[player] suit bake skipped', e); }
  const { bones, skeleton, root } = makeSkeleton();
  const mats = makeMaterials(renderer, P, quality);
  const group = new THREE.Group();
  group.name = 'explorer';
  group.add(root);
  const meshes = {};
  for (const [slot, geo] of geos) {
    const m = new THREE.SkinnedMesh(geo, mats[slot]);
    m.name = 'explorer-' + slot;
    m.frustumCulled = false;
    m.castShadow = slot !== 'glow';
    m.receiveShadow = slot !== 'glow' && slot !== 'visor';
    group.add(m);
    m.bind(skeleton, new THREE.Matrix4());
    meshes[slot] = m;
  }
  return { group, root, bones, skeleton, meshes, materials: mats, palette: P, triangles: A.tris };
}
