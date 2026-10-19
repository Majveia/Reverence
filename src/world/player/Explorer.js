// Player track — the Explorer: a procedurally modelled, skinned wayfarer.
//
// Season 2 redesign (the creator's Characters folder): the figure reads by SILHOUETTE first — one strong
// cloaked shape (deep hood, shoulder mantle, long coat whose split skirt is simulated cloth in Coat.js), a
// tall pack with a bedroll, a coil of rope, a tin mug and a small warm lantern, a walking staff strapped
// diagonally across the back (topped by a little ring of light), and ONE saturated accent: the red scarf
// wrapped up over the mouth (its tails are simulated in Cloth.js). Muted wool / canvas / leather tones
// that wear the planet's dust; ~7 heads tall.
//
// One skeleton (24 bones, identity rest orientations, character space: +Y up, +Z forward, +X = left),
// five skinned meshes (wool · leather · metal · glow · skin) → 5 draw calls (+ shadow pass).
// Everything is generated in code — no assets.
import * as THREE from 'three';
import {
  Assembler, loft, loftSurface, patch, ellipsoidSurface, ellipsoid, box, lathe, torus, cylinder, tube,
  xf, rigid, blendY, bandsY,
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
// `antenna` is now the LANTERN hook: a pendulum bone hanging off the pack's lower left corner (the animator's
// spring drives its swing).
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
  antenna: ['pack', 0.18, 1.0, -0.35],
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
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

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

/**
 * Muted wool / canvas / leather tones chosen against the world's dominant ground hue (the figure must
 * separate from the land by value and hue), plus the one warm accent: the red scarf (VISION rule 2).
 */
export function heroPalette(body) {
  const pal = body?.art?.palette || {};
  const key = body?.art?.key || '';
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
    // wool coat / hood / mantle: one strong, dark-ish shape
    coat: hex('#3c4553'), coat2: hex('#2a3039'), mantle: hex('#465060'),
    tunic: hex('#6b5d4c'), trousers: hex('#3a342e'), patch: hex('#5a4f42'), wrap: hex('#a29276'),
    boot: hex('#4b3323'), sole: hex('#1d1915'), leather: hex('#6a4528'), strap: hex('#563a24'),
    brass: hex('#b58c4e'), iron: hex('#5d5a56'), canvas: hex('#8e7a55'), canvas2: hex('#7a6748'),
    blanket: hex('#6e3a2b'), blanket2: hex('#cdb68a'), rope: hex('#a88a5c'), wood: hex('#6b4a2e'),
    skin: hex('#c4977a'), hair: hex('#3a2a20'), eye: hex('#14100e'), lens: hex('#2a2016'),
    scarf: hex('#b8261d'), scarf2: hex('#e3b25a'),
    lamp: hex('#ffb35a'), glow: hex('#ffd9a0'),
    // legacy keys (glider canopy / FX)
    shell: hex('#d9ccb0'), shell2: hex('#c2b597'), accent: hex('#b8743a'), accent2: hex('#8a5328'),
    suit: hex('#3c4553'), suit2: hex('#2a3039'), dark: hex('#2a2622'), metal: hex('#8a8178'),
    visorTint: hex('#0b0d12'),
  };
  if (warm) { // deserts / red rock: deep indigo wool reads against the warm land
    P.coat = hex('#353b55'); P.coat2 = hex('#262a3c'); P.mantle = hex('#41486a'); P.canvas = hex('#9a8a68');
  } else if (envHue > 0.55 && envHue <= 0.9) { // blue / violet / magenta worlds: warm umber wool
    P.coat = hex('#5a4535'); P.coat2 = hex('#3d2f25'); P.mantle = hex('#6a5241'); P.canvas = hex('#8a7a5a');
  }
  // world-specific flourishes
  if (key === 'bladerunner') { P.coat = hex('#25272c'); P.coat2 = hex('#18191c'); P.mantle = hex('#30333a'); P.lamp = hex('#ffa060'); }
  if (key === 'kubrick') { P.coat = hex('#d9d6cf'); P.coat2 = hex('#b9b5ac'); P.mantle = hex('#e6e3dc'); }
  if (key === 'rickmorty') { P.glow = hex('#c8ffb0'); }
  if (key === 'botw') { P.coat = hex('#34507a'); P.coat2 = hex('#24364f'); P.mantle = hex('#3f5d88'); }
  if (key === 'moebius') { P.coat = hex('#2f4a5c'); P.coat2 = hex('#22343f'); P.mantle = hex('#e8dfc8'); }
  P.suit = P.coat; P.suit2 = P.coat2;
  // dust / grime colour from the world's ground (desaturated, mid value) — the cloth wears the planet
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
/** Shared per-frame lighting context of the suit (fed by the Player): planet up and ground bounce. */
export const SUIT_LIGHT = {
  uUpW: { value: new THREE.Vector3(0, 1, 0) },
  uBounce: { value: new THREE.Color(0.06, 0.055, 0.045) },   // irradiance bounced off the ground below
  // waterline: world-space plane of the sea surface near the hero; the submerged part of the suit is absorbed
  // toward the water colour (reads as partially submerged even through a clear water surface), wet sheen line
  uWaterN: { value: new THREE.Vector3(0, 1, 0) },
  uWaterP: { value: new THREE.Vector3(0, -1e4, 0) },
  uWaterOn: { value: 0 },
  uWaterCol: { value: new THREE.Color(0.02, 0.07, 0.08) },
  uLamp: { value: 0 },                                      // lantern glow 0..1 (night / rest), warms the cloth near it
};

export function patchLighting(mat, { rim = 0.0, sky = 0.2, wear = 1, key = 'x', sunRim = 0.8 } = {}) {
  // • sun-keyed back rim: when the sun is behind the figure, grazing surfaces facing the sun catch a warm
  //   rim (the golden-hour halo that separates the silhouette from the land)
  // • soft rim + sky fresnel: grazing angles pick up the sky colour (ties the figure into the world's light)
  // • ground bounce: the underside of the body is lit by the colour of the terrain below
  // • per-vertex wear from the surface bake (bake.js): dirt roughens, worn edges go glossier
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRimStrength = { value: rim };
    sh.uniforms.uSkyRim = { value: sky };
    sh.uniforms.uSunRimK = { value: sunRim };
    sh.uniforms.uWearK = { value: wear };
    sh.uniforms.uUpW = SUIT_LIGHT.uUpW; sh.uniforms.uBounce = SUIT_LIGHT.uBounce; sh.uniforms.uSkyAmb = G.uAmbientSky;
    sh.uniforms.uSunDirW = G.uSunDir; sh.uniforms.uSunColW = G.uSunColor;
    sh.uniforms.uWaterN = SUIT_LIGHT.uWaterN; sh.uniforms.uWaterP = SUIT_LIGHT.uWaterP; sh.uniforms.uWaterOn = SUIT_LIGHT.uWaterOn; sh.uniforms.uWaterCol = SUIT_LIGHT.uWaterCol;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aWear;\nvarying vec2 vWear;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWear = aWear;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uRimStrength; uniform float uSkyRim; uniform float uSunRimK; uniform float uWearK; uniform vec3 uUpW; uniform vec3 uBounce; uniform vec3 uSkyAmb; uniform vec3 uSunDirW; uniform vec3 uSunColW;\nuniform vec3 uWaterN; uniform vec3 uWaterP; uniform float uWaterOn; uniform vec3 uWaterCol;\nvarying vec2 vWear;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + vWear.x * 0.2 * uWearK - vWear.y * 0.22 * uWearK, 0.04, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = clamp(metalnessFactor + vWear.y * 0.15 * uWearK, 0.0, 1.0);`)
      .replace('#include <opaque_fragment>', `
        {
          vec3 Vc = normalize(vViewPosition);            // fragment → camera (view space)
          float ndv = clamp(dot(normal, Vc), 0.0, 1.0);
          float fr = pow(1.0 - ndv, 3.0);
          outgoingLight += fr * uRimStrength * (totalDiffuse * 0.35 + diffuseColor.rgb * 0.03);
          vec3 upV = normalize((viewMatrix * vec4(uUpW, 0.0)).xyz);
          float nu = dot(normal, upV);
          // sky fresnel on upward / sideways facing grazing surfaces
          outgoingLight += fr * uSkyRim * uSkyAmb * (0.35 + 0.65 * clamp(nu * 0.5 + 0.6, 0.0, 1.0)) * (0.2 + 0.8 * diffuseColor.rgb);
          // sun back-rim (golden hour halo): sun behind the figure, normal turned toward the sun
          vec3 sV = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
          float back = clamp(-dot(sV, Vc) * 0.8 + 0.2, 0.0, 1.0);
          float facing = clamp(dot(normal, sV) * 0.7 + 0.3, 0.0, 1.0);
          float sunUp = clamp(dot(normalize(uSunDirW), uUpW) * 4.0 + 0.2, 0.0, 1.0);
          outgoingLight += uSunColW * pow(1.0 - ndv, 2.5) * back * back * facing * sunUp * uSunRimK * (0.25 + 0.75 * diffuseColor.rgb) * 0.35;
          // warm/cool bounce from the ground under the hero (BotW / Journey colour bleeding)
          float down = clamp(-nu * 0.6 + 0.4, 0.0, 1.0);
          outgoingLight += diffuseColor.rgb * uBounce * down * down;
          if (uWaterOn > 0.5) {
            vec3 wn = normalize((viewMatrix * vec4(uWaterN, 0.0)).xyz);
            vec3 wp = (viewMatrix * vec4(uWaterP, 1.0)).xyz;
            float depth = dot(wn, wp + vViewPosition); // > 0 below the surface
            float ab = 1.0 - exp(-max(depth, 0.0) * 3.2);
            outgoingLight = mix(outgoingLight, uWaterCol, clamp(ab * 0.9 + step(0.0, depth) * 0.25, 0.0, 0.95));
            outgoingLight += (uSkyAmb * 0.5 + 0.03) * smoothstep(0.035, 0.0, abs(depth)) * 0.8;
          }
        }
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'rv-wayfarer-' + key + '-' + rim + '-' + sky + '-' + sunRim;
  return mat;
}

export function makeMaterials(renderer, P, quality) {
  const tex = getTextures(renderer);
  const hi = quality?.tier !== 'low';
  const Std = hi ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const woolN = tex.woolNormal || tex.fabricNormal;
  if (woolN) woolN.repeat.set(7, 7);
  // felted wool / canvas: very rough, soft sheen in a lighter tone of the cloth
  const fabric = new Std({ vertexColors: true, roughness: 0.95, metalness: 0.0, normalMap: woolN, normalScale: new THREE.Vector2(0.7, 0.7) });
  if (hi) { fabric.sheen = 0.55; fabric.sheenRoughness = 0.75; fabric.sheenColor = new THREE.Color(P.coat).lerp(new THREE.Color(0.75, 0.72, 0.66), 0.45); }
  // leather (boots, straps, belt, bracer): waxy, worn edges (bake convexity) go glossier
  const hard = new Std({ vertexColors: true, roughness: 0.62, metalness: 0.0, normalMap: woolN, normalScale: new THREE.Vector2(0.25, 0.25), roughnessMap: tex.wearRough });
  if (hi) { hard.clearcoat = 0.12; hard.clearcoatRoughness = 0.55; }
  if (tex.wearRough) tex.wearRough.repeat.set(3, 3);
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.85, roughnessMap: tex.wearRough });
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1, 1, 1).multiplyScalar(4.0) });
  const skin = new Std({ vertexColors: true, roughness: 0.58, metalness: 0.0 });
  if (hi) { skin.sheen = 0.25; skin.sheenRoughness = 0.5; skin.sheenColor = new THREE.Color(0.9, 0.55, 0.45); }
  patchLighting(fabric, { rim: 0.35, sky: 0.14, key: 'wool', sunRim: 1.0 });
  patchLighting(hard, { rim: 0.3, sky: 0.12, key: 'leather', sunRim: 0.7 });
  patchLighting(metal, { rim: 0.2, sky: 0.1, key: 'metal', wear: 0.6, sunRim: 0.4 });
  patchLighting(skin, { rim: 0.4, sky: 0.1, key: 'skin', sunRim: 1.0, wear: 0.3 });
  const mats = { fabric, hard, metal, glow, skin };
  for (const [k, m] of Object.entries(mats)) { m.name = 'rv-explorer-' + k; }
  return mats;
}

// ------------------------------------------------------------------ model
/**
 * Build the explorer. Returns { group, root (bone), bones, skeleton, meshes, materials, palette, triangles }.
 * `quality` scales tessellation.
 */
export function buildExplorer(renderer, body, quality) {
  const P = heroPalette(body);
  const lod = quality?.tier === 'low' ? 0.6 : quality?.tier === 'med' ? 0.8 : 1;
  const R = (n) => Math.max(6, Math.round(n * lod));
  const A = new Assembler();

  // ================================================================ torso: wool coat body
  const torsoSecs = [
    { y: 0.84, rx: 0.118, rz: 0.09 },
    { y: 0.93, rx: 0.163, rz: 0.113, e: 2.3 },
    { y: 1.00, rx: 0.166, rz: 0.11, e: 2.4 },
    { y: 1.07, rx: 0.152, rz: 0.104, e: 2.4 },
    { y: 1.15, rx: 0.158, rz: 0.11, e: 2.5 },
    { y: 1.25, rx: 0.176, rz: 0.12, fz: 0.014, e: 2.6 },
    { y: 1.34, rx: 0.186, rz: 0.126, fz: 0.02, e: 2.7 },
    { y: 1.41, rx: 0.178, rz: 0.12, fz: 0.012, e: 2.8 },
    { y: 1.46, rx: 0.132, rz: 0.098, e: 2.4 },
    { y: 1.495, rx: 0.08, rz: 0.074 },
    { y: 1.54, rx: 0.06, rz: 0.06 },
  ];
  const torsoSkin = bandsY([[B.hips, 0.95], [B.spine, 1.1], [B.chest, 1.27], [B.chest, 1.45], [B.neck, 1.52]]);
  A.add('fabric', loft(torsoSecs, { radial: R(28), sub: 3, closeBottom: true }), P.coat, torsoSkin);
  const TS = loftSurface(torsoSecs);
  // wrap-over front closure (coat overlaps left over right): a dark fold line + toggles
  A.add('fabric', seam(TS, (y) => 0.16 + (y - 1.0) * 0.5, 0.99, 1.43, 0.004, 0.0075, 16), P.coat2, torsoSkin);
  for (let i = 0; i < 3; i++) {
    const y = 1.1 + i * 0.1, a = 0.16 + (y - 1.0) * 0.5;
    const p = new THREE.Vector3(); TS(a, y, p);
    const g = box(0.024, 0.012, 0.012, 0.005); xf(g, p.x, p.y, p.z + 0.006, 0, a, 0); A.add('metal', g, P.brass, torsoSkin);
  }
  // side + back seams (tailoring lines read at game distance)
  for (const sd of [1, -1]) A.add('fabric', seam(TS, sd * Math.PI * 0.62, 0.9, 1.4, 0.002, 0.004, 14), P.coat2, torsoSkin);
  A.add('fabric', seam(TS, Math.PI, 0.9, 1.44, 0.002, 0.004, 14), P.coat2, torsoSkin);
  // belt + buckle + pouches + a small satchel on the right hip
  { const g = torus(0.172, 0.022, R(8), R(32)); xf(g, 0, 0.978, 0.004, Math.PI / 2, 0, 0, 1, 0.7, 1); A.add('hard', g, P.leather, rigid(B.hips)); }
  { const g = box(0.06, 0.05, 0.02, 0.006); xf(g, 0, 0.978, 0.124); A.add('metal', g, P.brass, rigid(B.hips)); }
  { const g = box(0.034, 0.03, 0.022, 0.004); xf(g, 0, 0.978, 0.128); A.add('hard', g, P.leather, rigid(B.hips)); }
  for (const [a, w, h] of [[1.85, 0.08, 0.085], [2.5, 0.065, 0.07]]) {
    const g = box(w, h, 0.05, 0.014);
    const x = Math.sin(a) * 0.18, z = Math.cos(a) * 0.125;
    xf(g, x, 0.95, z, 0, a, 0);
    A.add('hard', g, P.leather, rigid(B.hips));
    const f = box(w * 1.04, 0.026, 0.054, 0.008); xf(f, x, 0.985, z, -0.1, a, 0); A.add('hard', f, P.strap, rigid(B.hips));
  }
  { // satchel (right hip) on a cross-body strap
    const g = box(0.05, 0.13, 0.16, 0.02); xf(g, -0.2, 0.9, 0.03, 0, 0, 0.06); A.add('fabric', g, P.canvas2, rigid(B.hips));
    const f = box(0.056, 0.06, 0.165, 0.012); xf(f, -0.202, 0.945, 0.03, 0, 0, 0.06); A.add('hard', f, P.leather, rigid(B.hips));
  }

  // ================================================================ mantle (short shoulder cape)
  const mantleSecs = [
    { y: 1.18, rx: 0.262, rz: 0.19, e: 2.15 },
    { y: 1.25, rx: 0.268, rz: 0.183, e: 2.25 },
    { y: 1.34, rx: 0.258, rz: 0.168, e: 2.4 },
    { y: 1.42, rx: 0.21, rz: 0.146, e: 2.4 },
    { y: 1.48, rx: 0.13, rz: 0.112 },
    { y: 1.525, rx: 0.092, rz: 0.088 },
  ];
  const mantleSkin = (x, y, z, o) => {
    // the sides ride a little with the upper arms so the cape lifts when the arms rise
    const t = sstep(0.14, 0.27, Math.abs(x)) * sstep(1.44, 1.3, y) * 0.42;
    o[0] = y > 1.47 ? B.neck : B.chest; o[1] = 1 - t; o[2] = x > 0 ? B.upperArmL : B.upperArmR; o[3] = t;
    return o;
  };
  const mantleLift = (g) => {
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      const fr = Math.max(0, z) / 0.19, k = fr * fr * (1 - 0.6 * sstep(0.12, 0.24, Math.abs(x)));
      if (y < 1.4) pa.setY(i, y + (1.4 - y) * 0.55 * k);
    }
    g.computeVertexNormals();
    return g;
  };
  A.add('fabric', mantleLift(loft(mantleSecs, { radial: R(32), sub: 3, ripple: (y) => 1 + 0.012 * sstep(1.3, 1.18, y) })), P.mantle, mantleSkin);
  { // thick hem (the cape has weight) + inner lining band seen from below
    const s = mantleSecs[0];
    const g = torus(s.rx + 0.004, 0.012, R(6), R(40)); xf(g, 0, s.y + 0.004, 0, Math.PI / 2, 0, 0, 1, (s.rz + 0.004) / (s.rx + 0.004), 1);
    A.add('fabric', mantleLift(g), P.coat2, mantleSkin);
    const inner = loft([{ y: 1.18, rx: s.rx - 0.006, rz: s.rz - 0.006, e: 2.15 }, { y: 1.27, rx: 0.25, rz: 0.17, e: 2.3 }], { radial: R(32), sub: 1 });
    // flip winding: visible from inside
    const ia = inner.index; for (let i = 0; i < ia.count; i += 3) { const b = ia.getX(i + 1); ia.setX(i + 1, ia.getX(i + 2)); ia.setX(i + 2, b); }
    const na = inner.attributes.normal; for (let i = 0; i < na.count; i++) na.setXYZ(i, -na.getX(i), -na.getY(i), -na.getZ(i));
    mantleLift(inner); // (normals recomputed from the flipped winding → face inward)
    A.add('fabric', inner, P.coat2, mantleSkin);
  }
  // a stitched trim band near the hem
  {
    const pts = []; const p = new THREE.Vector3(); const MS = loftSurface(mantleSecs);
    for (let i = 0; i <= 40; i++) { MS((i / 40) * Math.PI * 2, 1.205, p); const c = p.clone(); c.y = 0; const d = c.clone().normalize(); pts.push(p.clone().addScaledVector(d, 0.003)); }
    A.add('fabric', mantleLift(tube(pts, 0.0045, R(80), 4, true)), P.scarf2.clone().multiplyScalar(0.55), mantleSkin);
  }

  // ================================================================ arms: coat sleeves + leather gloves
  const buildArm = (side) => {
    const x = 0.19 * side, z = -0.025;
    const ax = (b) => B[b + (side > 0 ? 'L' : 'R')];
    const secs = [
      { y: 0.85, rx: 0.046, rz: 0.05, ox: x, oz: z },
      { y: 0.885, rx: 0.052, rz: 0.056, ox: x, oz: z },
      { y: 0.95, rx: 0.054, rz: 0.058, ox: x, oz: z },
      { y: 1.05, rx: 0.054, rz: 0.057, ox: x, oz: z },
      { y: 1.15, rx: 0.056, rz: 0.06, ox: x, oz: z },
      { y: 1.27, rx: 0.06, rz: 0.064, ox: x, oz: z },
      { y: 1.38, rx: 0.064, rz: 0.066, ox: x, oz: z },
      { y: 1.45, rx: 0.06, rz: 0.062, ox: x, oz: z },
    ];
    const skin = bandsY([[ax('hand'), 0.85], [ax('foreArm'), 0.88], [ax('foreArm'), 1.085], [ax('upperArm'), 1.14]]);
    A.add('fabric', loft(secs, { radial: R(18), sub: 3 }), P.coat, skin);
    const AS = loftSurface(secs);
    const outer = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    A.add('fabric', seam(AS, outer + Math.PI * 0.2 * side, 0.9, 1.44, 0.002, 0.0035, 12), P.coat2, skin);
    // turned-back cuff (lining colour)
    { const g = torus(0.054, 0.011, R(6), R(18)); xf(g, x, 0.872, z, Math.PI / 2, 0, 0, 1, 1.05, 1); A.add('fabric', g, P.coat2, rigid(ax('foreArm'))); }
    // patched elbow (patchwork: the coat carries the journey)
    A.add('fabric', patch(AS, { u0: Math.PI - 0.9, u1: Math.PI + 0.9, v0: 1.06, v1: 1.17, nu: R(8), nv: R(6), off: 0.003, thick: 0.004, bevel: 0.003, round: 3 }), P.patch, rigid(ax('upperArm')));
    // leather bracer on the left forearm, wrist wrap on the right
    if (side > 0) {
      A.add('hard', patch(AS, { u0: outer - 1.6, u1: outer + 1.6, v0: 0.9, v1: 1.03, nu: R(10), nv: R(6), off: 0.006, thick: 0.008, bevel: 0.004, round: 5 }), P.leather, rigid(ax('foreArm')));
      for (let i = 0; i < 2; i++) { const g = torus(0.06, 0.004, 4, R(16)); xf(g, x, 0.925 + i * 0.07, z, Math.PI / 2); A.add('hard', g, P.strap, rigid(ax('foreArm'))); }
    } else {
      for (let i = 0; i < 3; i++) { const g = torus(0.054, 0.006, 4, R(16)); xf(g, x, 0.9 + i * 0.022, z, Math.PI / 2 + (i % 2 ? 0.2 : -0.2)); A.add('fabric', g, P.wrap, rigid(ax('foreArm'))); }
    }
    // glove: palm, fingers, thumb, cuff
    const hx = x, hz = z + 0.005;
    { const g = box(0.042, 0.076, 0.076, 0.017); xf(g, hx, 0.802, hz); A.add('hard', g, P.leather, rigid(ax('hand'))); }
    { const g = box(0.036, 0.07, 0.07, 0.015); xf(g, hx - side * 0.004, 0.733, hz + 0.004, 0, 0, side * 0.06); A.add('hard', g, P.leather, rigid(ax('fingers'))); }
    { const g = ellipsoid(0.016, 0.034, 0.016, R(10), R(8)); xf(g, hx - side * 0.012, 0.78, hz + 0.05, 0.5, 0, -side * 0.25); A.add('hard', g, P.leather, rigid(ax('hand'))); }
    { const g = cylinder(0.04, 0.038, 0.03, R(16)); xf(g, hx, 0.85, hz); A.add('hard', g, P.strap, rigid(ax('hand'))); }
  };
  buildArm(1); buildArm(-1);

  // ================================================================ legs: trousers, wrapped shins, boots
  const buildLeg = (side) => {
    const x = 0.092 * side;
    const lb = (b) => B[b + (side > 0 ? 'L' : 'R')];
    const secs = [
      { y: 0.1, rx: 0.046, rz: 0.05, ox: x },
      { y: 0.22, rx: 0.052, rz: 0.058, ox: x },
      { y: 0.35, rx: 0.062, rz: 0.065, ox: x, bz: 0.012 },
      { y: 0.46, rx: 0.06, rz: 0.064, ox: x },
      { y: 0.52, rx: 0.065, rz: 0.069, ox: x },
      { y: 0.63, rx: 0.079, rz: 0.081, ox: x },
      { y: 0.78, rx: 0.092, rz: 0.095, ox: x },
      { y: 0.9, rx: 0.099, rz: 0.1, ox: x },
      { y: 0.99, rx: 0.09, rz: 0.09, ox: x - side * 0.01 },
    ];
    const skin = bandsY([[lb('foot'), 0.09], [lb('shin'), 0.15], [lb('shin'), 0.475], [lb('thigh'), 0.555], [lb('thigh'), 0.9], [B.hips, 1.0]]);
    A.add('fabric', loft(secs, { radial: R(20), sub: 3 }), P.trousers, skin);
    const LS = loftSurface(secs);
    A.add('fabric', seam(LS, side > 0 ? Math.PI / 2 : -Math.PI / 2, 0.42, 0.95, 0.002, 0.0035, 12), P.coat2, skin);
    // knee patch (patchwork) on the left knee, a darned square on the right thigh
    if (side > 0) A.add('fabric', patch(LS, { u0: -0.85, u1: 0.85, v0: 0.45, v1: 0.6, nu: R(8), nv: R(6), off: 0.003, thick: 0.004, bevel: 0.003, round: 3 }), P.patch, rigid(lb('shin')));
    else A.add('fabric', patch(LS, { u0: -0.3, u1: 0.5, v0: 0.7, v1: 0.8, nu: R(6), nv: R(5), off: 0.003, thick: 0.004, bevel: 0.003, round: 2.5 }), P.tunic, rigid(lb('thigh')));
    // puttee wraps (oatmeal cloth bands spiralling up the shin)
    for (let i = 0; i < 8; i++) {
      const y = 0.13 + i * 0.04;
      const p = new THREE.Vector3(); LS(Math.PI / 2, y, p);
      const rx = Math.abs(p.x - x) + 0.006;
      const q = new THREE.Vector3(); LS(0, y, q);
      const rz = q.z + 0.006;
      const g = torus(rx, 0.011, 4, R(18)); xf(g, x, y, 0, Math.PI / 2 + (i % 2 ? 0.22 : -0.22), 0, 0, 1, rz / rx, 1.4);
      A.add('fabric', g, P.wrap.clone().multiplyScalar(i % 2 ? 1 : 0.93), rigid(lb('shin')));
    }
    // boots: low leather boots with a turned cuff
    const bootSecs = [
      { y: 0.035, rx: 0.058, rz: 0.075, ox: x, oz: 0.01 },
      { y: 0.09, rx: 0.058, rz: 0.066, ox: x },
      { y: 0.14, rx: 0.059, rz: 0.064, ox: x },
    ];
    A.add('hard', loft(bootSecs, { radial: R(18), sub: 2 }), P.boot, bandsY([[lb('foot'), 0.1], [lb('shin'), 0.14]]));
    { const g = torus(0.06, 0.01, R(6), R(20)); xf(g, x, 0.142, 0, Math.PI / 2, 0, 0, 1, 1.08, 1); A.add('hard', g, P.boot.clone().multiplyScalar(0.85), rigid(lb('shin'))); }
    { const g = box(0.104, 0.085, 0.262, 0.035, 3); xf(g, x, 0.052, 0.048); A.add('hard', g, P.boot, rigid(lb('foot'))); }
    { const g = box(0.114, 0.026, 0.278, 0.011, 2); xf(g, x, 0.013, 0.047); A.add('hard', g, P.sole, rigid(lb('foot'))); }
    // laces
    for (let i = 0; i < 3; i++) { const g = box(0.06, 0.006, 0.008, 0.002); xf(g, x, 0.07 + i * 0.012, 0.13 - i * 0.03, 0.5); A.add('hard', g, P.strap, rigid(lb('foot'))); }
  };
  buildLeg(1); buildLeg(-1);

  // ================================================================ head: face, hood, goggles, scarf wrap
  const hc = new THREE.Vector3(0, 1.672, 0.016);
  const hrd = new THREE.Vector3(0.082, 0.106, 0.096);
  { const g = cylinder(0.046, 0.05, 0.12, R(14)); xf(g, 0, 1.55, 0.0); A.add('skin', g, P.skin, blendY(B.neck, B.head, 1.53, 1.6)); }
  { // head (slightly long ellipsoid, jaw narrowed)
    const g = ellipsoid(hrd.x, hrd.y, hrd.z, R(22), R(16), {
      deform: (v) => { const ty = v.y / hrd.y; if (ty < 0) { v.x *= 1 - 0.22 * ty * ty; } v.z += 0.012 * Math.max(0, -ty) * Math.max(0, v.z / hrd.z); v.add(hc); },
    });
    A.add('skin', g, P.skin, rigid(B.head));
  }
  // nose bridge + eyes + brows (only the upper face shows between the scarf and the hood)
  { const g = ellipsoid(0.012, 0.022, 0.016, 8, 6); xf(g, 0, 1.672, hc.z + hrd.z - 0.003, -0.25); A.add('skin', g, P.skin, rigid(B.head)); }
  for (const s of [1, -1]) {
    const g = ellipsoid(0.011, 0.0075, 0.006, 8, 6); xf(g, s * 0.031, 1.69, hc.z + hrd.z - 0.01, 0, s * 0.35, 0); A.add('metal', g, P.eye, rigid(B.head));
    const b = box(0.03, 0.008, 0.012, 0.003); xf(b, s * 0.031, 1.705, hc.z + hrd.z - 0.012, 0.2, s * 0.3, -s * 0.12); A.add('fabric', b, P.hair, rigid(B.head));
  }
  // hair: a cap with a fringe swept to one side (shows under the hood brim)
  {
    const HS = ellipsoidSurface(hc, new THREE.Vector3(hrd.x + 0.006, hrd.y + 0.008, hrd.z + 0.006));
    A.add('fabric', patch(HS, { u0: -1.4, u1: 1.4, v0: 0.42, v1: 1.45, nu: R(14), nv: R(8), off: 0.0, thick: 0.006, bevel: 0.004, round: 3, taper: (t) => [-1.4 - 1.5 * t, 1.4 + 1.5 * t] }), P.hair, rigid(B.head));
    for (const [ax, len, bend] of [[0.25, 0.075, 0.6], [0.55, 0.06, 0.4], [-0.15, 0.05, -0.3], [0.85, 0.07, 0.5], [-0.8, 0.06, -0.5]]) {
      const p0 = new THREE.Vector3(); HS(ax, 0.55, p0);
      const pts = [p0.clone(), p0.clone().add(new THREE.Vector3(Math.sin(ax) * 0.01 + bend * 0.012, -len * 0.5, 0.012)), p0.clone().add(new THREE.Vector3(Math.sin(ax) * 0.012 + bend * 0.03, -len, 0.008))];
      A.add('fabric', tube(pts, 0.006, 8, 4), P.hair, rigid(B.head));
    }
  }
  // hood: a deep cowl with a soft peak at the back; double-sided (lining) shell; the face opening narrows
  // toward the brow so the face sits in shadow
  const hoodC = new THREE.Vector3(0, 1.695, -0.004);
  const hoodR = new THREE.Vector3(0.122, 0.142, 0.136);
  const hoodDeform = (v, az, el) => {
    if (el < 0) { const k = 1 + 0.85 * Math.pow(-el, 1.35); v.x *= k; v.z *= k * 0.95; v.y -= 0.025 * -el; }
    const backK = Math.max(0, -Math.cos(az)), top = Math.max(0, Math.sin(el));
    v.z -= 0.055 * backK * top * top; v.y += 0.02 * backK * top * top * top;
    const front = Math.max(0, Math.cos(az));
    v.z += 0.018 * front * sstep(0.25, 0.9, el); // brim leans forward over the brow
  };
  const HOOD = ellipsoidSurface(hoodC, hoodR, hoodDeform);
  // face opening: wide at the cowl, arching closed over the brow (a → 0 = full ring above the forehead)
  const hoodA = (t) => 0.98 * (1 - sstep(0.46, 0.66, t)) - 0.02 * sstep(0.6, 0.66, t);
  const hoodTaper = (t) => { const a = hoodA(t); return [a, Math.PI * 2 - a]; };
  const hoodSkin = (x, y, z, o) => { const t = sstep(1.6, 1.53, y); o[0] = B.head; o[1] = 1 - t; o[2] = B.neck; o[3] = t; return o; };
  A.add('fabric', patch(HOOD, { u0: 0.98, u1: Math.PI * 2 - 0.98, v0: -1.18, v1: 1.5, nu: R(30), nv: R(20), off: 0, thick: 0.012, bevel: 0.007, round: 9, back: true, taper: hoodTaper }), P.mantle, hoodSkin);
  // hood rim (a rolled edge framing the face)
  {
    const pts = []; const p = new THREE.Vector3(), c = new THREE.Vector3();
    const n = 14;
    const edge = (t, sgn) => { HOOD(sgn * Math.max(0, hoodA(t)), -1.18 + 2.68 * t, p); c.copy(p).sub(hoodC).normalize(); pts.push(p.clone().addScaledVector(c, 0.004)); };
    for (let i = 0; i <= n; i++) edge(0.04 + (0.62 / n) * i, -1); // up the right edge
    for (let i = n - 1; i >= 0; i--) edge(0.04 + (0.62 / n) * i, 1); // down the left edge
    A.add('fabric', tube(pts, 0.011, R(60), 6), P.coat2, hoodSkin);
  }
  // goggles pushed up onto the hood brim: strap + two brass-rimmed lenses
  {
    const pts = []; const p = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i <= 20; i++) { const az = -1.55 + (i / 20) * 3.1; HOOD(az, 0.78, p); c.copy(p).sub(hoodC).normalize(); pts.push(p.clone().addScaledVector(c, 0.006)); }
    A.add('hard', tube(pts, 0.007, R(40), 5), P.strap, rigid(B.head));
    for (const s of [1, -1]) {
      HOOD(s * 0.36, 0.8, p); c.copy(p).sub(hoodC).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), c);
      const e = new THREE.Euler().setFromQuaternion(q);
      const rim = cylinder(0.025, 0.027, 0.018, R(14)); xf(rim, 0, 0, 0, e.x, e.y, e.z); rim.translate(p.x + c.x * 0.012, p.y + c.y * 0.012, p.z + c.z * 0.012);
      A.add('metal', rim, P.brass, rigid(B.head));
      const lens = cylinder(0.019, 0.019, 0.004, R(14)); xf(lens, 0, 0, 0, e.x, e.y, e.z); lens.translate(p.x + c.x * 0.022, p.y + c.y * 0.022, p.z + c.z * 0.022);
      A.add('metal', lens, P.lens, rigid(B.head));
    }
  }
  // the red scarf: wrapped up over the mouth and nose, a knot under the chin, a short front end
  {
    const wrapSecs = [
      { y: 1.465, rx: 0.118, rz: 0.112 },
      { y: 1.52, rx: 0.102, rz: 0.103, fz: 0.012 },
      { y: 1.575, rx: 0.088, rz: 0.098, fz: 0.018 },
      { y: 1.61, rx: 0.086, rz: 0.095, fz: 0.014 },
      { y: 1.63, rx: 0.084, rz: 0.092, fz: 0.01 },
    ];
    for (const s of wrapSecs) s.oz = 0.012;
    const wrapSkin = bandsY([[B.chest, 1.46], [B.neck, 1.52], [B.head, 1.6]]);
    A.add('fabric', loft(wrapSecs, { radial: R(28), sub: 3, ripple: (y) => 1 + 0.035 * Math.pow(Math.abs(Math.sin((y - 1.46) * 46)), 2) }), P.scarf, wrapSkin);
    { const g = ellipsoid(0.034, 0.028, 0.026, R(10), R(8)); xf(g, 0.045, 1.49, 0.118, 0.2, 0.3, 0.4); A.add('fabric', g, P.scarf, rigid(B.chest)); }
  }

  // ================================================================ pack: canvas rucksack, bedroll, rope, mug, lantern, staff
  const pk = rigid(B.pack);
  { // main bag (rounded, slightly bulging) + top flap + front pocket + straps
    const g = box(0.33, 0.47, 0.2, 0.06, 4);
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) { const y = pa.getY(i) / 0.235; const z = pa.getZ(i); if (z < 0) pa.setZ(i, z * (1 + 0.18 * (1 - y * y))); }
    g.computeVertexNormals();
    xf(g, 0, 1.215, -0.27); A.add('fabric', g, P.canvas, pk);
    const flap = box(0.34, 0.07, 0.22, 0.03, 3); xf(flap, 0, 1.43, -0.278, 0.08, 0, 0); A.add('fabric', flap, P.canvas2, pk);
    const pocket = box(0.2, 0.15, 0.06, 0.03, 3); xf(pocket, 0, 1.1, -0.39); A.add('fabric', pocket, P.canvas2, pk);
    for (const s of [1, -1]) {
      const st = box(0.03, 0.3, 0.008, 0.003); xf(st, s * 0.085, 1.29, -0.392, -0.12); A.add('hard', st, P.strap, pk);
      const bk = box(0.034, 0.024, 0.012, 0.004); xf(bk, s * 0.085, 1.2, -0.405); A.add('metal', bk, P.brass, pk);
    }
    // side pocket (left) and two thin brass vents underneath (the little aether thrusters of the double jump)
    { const sp = box(0.06, 0.18, 0.13, 0.025, 3); xf(sp, 0.19, 1.13, -0.27); A.add('fabric', sp, P.canvas2, pk); }
    for (const s of [1, -1]) {
      const nz = lathe([[0.02, 0.0], [0.026, -0.012], [0.032, -0.035], [0.028, -0.04], [0.02, -0.02]], R(14));
      xf(nz, s * 0.085, 0.99, -0.26, -0.18, 0, 0); A.add('metal', nz, P.brass, pk);
    }
    // shoulder straps (over the shoulders, under the mantle → visible at the chest)
    for (const s of [1, -1]) { // (the upper run hides under the mantle; only the chest run shows)
      const pts = [new THREE.Vector3(s * 0.12, 1.33, 0.135), new THREE.Vector3(s * 0.115, 1.22, 0.145), new THREE.Vector3(s * 0.125, 1.1, 0.128)];
      const g = tube(pts, 0.012, R(12), 6);
      const pa = g.attributes.position;
      for (let i = 0; i < pa.count; i++) { const xx = pa.getX(i), zz = pa.getZ(i); pa.setX(i, s * 0.12 + (xx - s * 0.12) * 2.0); pa.setZ(i, zz - (zz - 0.14) * 0.4); }
      g.computeVertexNormals();
      A.add('hard', g, P.strap, rigid(B.chest));
    }
  }
  { // bedroll across the top (striped wool blanket) + two straps
    const g = cylinder(0.074, 0.074, 0.5, R(18)); xf(g, 0, 1.52, -0.26, 0, 0, Math.PI / 2); A.add('fabric', g, P.blanket, pk);
    for (const s of [1, -1]) {
      const band = cylinder(0.076, 0.076, 0.035, R(18), true); xf(band, s * 0.17, 1.52, -0.26, 0, 0, Math.PI / 2); A.add('fabric', band, P.blanket2, pk);
      const end = torus(0.05, 0.022, 6, R(16)); xf(end, s * 0.252, 1.52, -0.26, 0, Math.PI / 2, 0); A.add('fabric', end, P.blanket.clone().multiplyScalar(0.8), pk);
      const st = torus(0.077, 0.006, 4, R(18)); xf(st, s * 0.1, 1.52, -0.26, 0, Math.PI / 2, 0); A.add('hard', st, P.strap, pk);
    }
  }
  { // coil of rope on the right flank (three loops) + a tie
    for (let i = 0; i < 3; i++) {
      const g = torus(0.088 - i * 0.004, 0.013, 6, R(22)); xf(g, -0.205 - i * 0.022, 1.2 + i * 0.006, -0.27, 0, Math.PI / 2, 0.15 * i);
      A.add('fabric', g, P.rope.clone().multiplyScalar(1 - i * 0.05), pk);
    }
    const tie = torus(0.024, 0.006, 4, 10); xf(tie, -0.225, 1.29, -0.27, Math.PI / 2, 0, 0); A.add('hard', tie, P.strap, pk);
  }
  { // tin mug hanging off the right lower corner
    const g = cylinder(0.03, 0.028, 0.06, R(12)); xf(g, -0.17, 0.97, -0.34, 0.25, 0, 0.1); A.add('metal', g, P.iron, pk);
    const h = torus(0.016, 0.004, 4, 10, Math.PI); xf(h, -0.205, 0.975, -0.34, 0, 0, Math.PI / 2); A.add('metal', h, P.iron, pk);
  }
  { // walking staff strapped diagonally across the back (top over the left shoulder), a ring of light on top
    const ang = 0.5, L = 1.62, cx = 0, cy = 1.22, cz = -0.4;
    const dx = Math.sin(ang), dy = Math.cos(ang);
    const g = cylinder(0.016, 0.019, L, R(10)); xf(g, cx, cy, cz, 0, 0, -ang); A.add('hard', g, P.wood, pk);
    const top = new THREE.Vector3(cx + dx * L / 2, cy + dy * L / 2, cz);
    // carved head: a brass ring with a soft glowing core (the sign of the source, carried)
    const ring = torus(0.05, 0.009, 6, R(22)); xf(ring, top.x + dx * 0.055, top.y + dy * 0.055, cz, 0, 0, -ang); A.add('metal', ring, P.brass, pk);
    const core = ellipsoid(0.014, 0.014, 0.014, 8, 6); xf(core, top.x + dx * 0.055, top.y + dy * 0.055, cz); A.add('glow', core, P.glow.clone().multiplyScalar(0.7), pk);
    const fer = cylinder(0.021, 0.021, 0.03, R(10)); xf(fer, cx - dx * (L / 2 - 0.02), cy - dy * (L / 2 - 0.02), cz, 0, 0, -ang); A.add('metal', fer, P.iron, pk);
    for (const t of [-0.12, 0.14]) { // lashings to the pack
      const s = torus(0.024, 0.006, 4, 10); xf(s, cx + dx * t, cy + dy * t, cz, Math.PI / 2, 0, -ang); A.add('hard', s, P.strap, pk);
    }
  }
  { // the lantern, hanging from its pendulum hook (antenna bone) at the pack's lower left corner
    const h = REST_POS.antenna;
    const lk = rigid(B.antenna);
    const bail = torus(0.022, 0.003, 4, 12, Math.PI); xf(bail, h.x, h.y - 0.022, h.z); A.add('metal', bail, P.brass, lk);
    const cap = lathe([[0.04, 0], [0.036, 0.012], [0.018, 0.03], [0.006, 0.04]], R(14)); xf(cap, h.x, h.y - 0.1, h.z); A.add('metal', cap, P.brass, lk);
    const glass = cylinder(0.03, 0.032, 0.07, R(14)); xf(glass, h.x, h.y - 0.137, h.z); A.add('glow', glass, P.lamp.clone().multiplyScalar(0.55), lk);
    const base = cylinder(0.04, 0.036, 0.018, R(14)); xf(base, h.x, h.y - 0.18, h.z); A.add('metal', base, P.brass, lk);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      const bar = box(0.006, 0.075, 0.006, 0.002); xf(bar, h.x + Math.sin(a) * 0.034, h.y - 0.137, h.z + Math.cos(a) * 0.034); A.add('metal', bar, P.brass, lk);
    }
  }

  // ---------------- assemble
  const geos = A.build();
  try { bakeSurface(geos, P, 'wayfarer-' + lod); } catch (e) { console.warn('[player] surface bake skipped', e); }
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
    m.receiveShadow = slot !== 'glow';
    group.add(m);
    m.bind(skeleton, new THREE.Matrix4());
    meshes[slot] = m;
  }
  return { group, root, bones, skeleton, meshes, materials: mats, palette: P, triangles: A.tris };
}
