// Player track — the hero: a procedurally modelled, skinned cosmic mystic swordswoman.
//
// Season 2 (the creator's direction, 19 Oct: "Ghost of Yotei like figure and feel, she needs to look badass, sexy,
// and cool with katana on her back that you can draw and use"): an original lone wandering swordswoman. Athletic,
// tall (~7.5 heads) and poised; a fitted kimono-style coat with a cross-over collar, wrapped forearms and hakama
// trousers tucked into calf wraps, all in ONE deep night colour with a fine gold thread on hems and seams; a black
// lacquered guard on the left shoulder; a leather baldric across the chest for the katana on her back (Katana.js);
// dark hair swept back into a high ponytail (verlet, Hair in Cloth.js) with two locks framing the face; and ONE warm
// accent: the long red scarf worn loose at the neck (its tails are verlet cloth). Faint woven stars glow in the
// cloth at night and when an ability flows through her (SUIT_LIGHT.uStar).
//
// One skeleton (24 bones, identity rest orientations, character space: +Y up, +Z forward, +X = left), six
// skinned meshes (silk · lacquer/leather · gold · glow · skin · hair). Everything is generated in code — no assets.
// The `pack` bone now carries the scabbard (it is set down beside her when she sits); `antenna` is unused.
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
function seam(S, a, y0, y1, lift, radius, n = 14, rs = 5) {
  const pts = [], p = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    const y = y0 + (y1 - y0) * (i / n);
    const aa = typeof a === 'function' ? a(y) : a;
    S(aa, y, p); S.inside(aa, y, c);
    const d = p.clone().sub(c); d.y = 0; d.normalize();
    pts.push(p.clone().addScaledVector(d, lift));
  }
  return tube(pts, radius, n * 3, rs, false);
}
/**
 * The swordswoman's colours: one deep night colour for coat, sleeves and hakama (a fine gold thread on the
 * hems and seams), black lacquer and dark leather, and ONE warm accent: the red scarf (VISION rule 2).
 * The night colour shifts a little with the world so the figure always separates from the land.
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
    // one deep night colour (coat, sleeves, hakama), a darker shade for collars / obi / lining
    coat: hex('#1f2640'), coat2: hex('#10131f'), mantle: hex('#262e4a'), inner: hex('#4a4f66'),
    tunic: hex('#2a3150'), trousers: hex('#191e33'), patch: hex('#232a44'), wrap: hex('#2b2d36'),
    boot: hex('#1a1512'), sole: hex('#0b0908'), leather: hex('#2c211b'), strap: hex('#241b16'),
    lacquer: hex('#0d0c10'), gold: hex('#d1a554'), brass: hex('#c9a052'), iron: hex('#46464c'),
    steel: hex('#d8dce2'), silk: hex('#1a1622'),
    canvas: hex('#3a3540'), canvas2: hex('#2e2a33'), blanket: hex('#6e3a2b'), blanket2: hex('#cdb68a'), rope: hex('#a88a5c'), wood: hex('#2a1d14'),
    skin: hex('#d4a487'), lips: hex('#a8625b'), blush: hex('#c98a78'), hair: hex('#15100e'), hairHi: hex('#4a372d'),
    eye: hex('#140e0c'), lens: hex('#2a2016'),
    scarf: hex('#b71e17'), scarf2: hex('#d9a94a'),
    lamp: hex('#ffd2a0'), glow: hex('#ffe4b8'), star: hex('#ffe9c4'),
    // legacy keys (glider canopy / FX)
    shell: hex('#d9ccb0'), shell2: hex('#c2b597'), accent: hex('#b8743a'), accent2: hex('#8a5328'),
    suit: hex('#1f2640'), suit2: hex('#10131f'), dark: hex('#141218'), metal: hex('#8a8178'),
    visorTint: hex('#0b0d12'),
  };
  if (envHue > 0.55 && envHue <= 0.9) { // blue / violet / magenta worlds: a deep plum-black night instead of indigo
    P.coat = hex('#2b1d2c'); P.coat2 = hex('#170f18'); P.mantle = hex('#352538'); P.trousers = hex('#20151f'); P.tunic = hex('#3a2838');
  }
  if (key === 'bladerunner') { P.coat = hex('#1a1b20'); P.coat2 = hex('#0d0d10'); P.trousers = hex('#141519'); }
  if (key === 'botw') { P.coat = hex('#1d2f52'); P.coat2 = hex('#111c33'); P.trousers = hex('#16223b'); }
  if (key === 'moebius') { P.coat = hex('#18333f'); P.coat2 = hex('#0e1f27'); P.trousers = hex('#142a33'); }
  if (key === 'rickmorty') { P.glow = hex('#d8ffc0'); }
  P.suit = P.coat; P.suit2 = P.coat2;
  // dust from the world's ground (desaturated, mid value) — a faint film on the boots and hems only
  {
    const d = new THREE.Color(pal.sand || pal.rock || '#8a7a64');
    if (pal.rock) d.lerp(new THREE.Color(pal.rock), 0.35);
    d.getHSL(hsl);
    d.setHSL(hsl.h, Math.min(hsl.s, 0.32) * 0.8, clamp01(hsl.l * 0.8 + 0.12, 0.3, 0.5));
    P.dust = d;
  }
  P.dustK = 0.32;
  P.envHue = envHue; P.warm = warm;
  return P;
}

// ------------------------------------------------------------------ materials
/** Shared per-frame lighting context of the hero (fed by the Player): planet up, ground bounce, star glow. */
export const SUIT_LIGHT = {
  uUpW: { value: new THREE.Vector3(0, 1, 0) },
  uBounce: { value: new THREE.Color(0.06, 0.055, 0.045) },   // irradiance bounced off the ground below
  // waterline: world-space plane of the sea surface near the hero; the submerged part is absorbed toward the water
  uWaterN: { value: new THREE.Vector3(0, 1, 0) },
  uWaterP: { value: new THREE.Vector3(0, -1e4, 0) },
  uWaterOn: { value: 0 },
  uWaterCol: { value: new THREE.Color(0.02, 0.07, 0.08) },
  uLamp: { value: 0 },
  // woven star pattern in the night-coloured cloth: faint at night, bright when an ability flows through her
  uStar: { value: 0 },
};

export function patchLighting(mat, { rim = 0.0, sky = 0.2, wear = 1, key = 'x', sunRim = 0.8, stars = 0, starUv = false } = {}) {
  // • sun-keyed back rim: when the sun is behind the figure, grazing surfaces facing the sun catch a warm
  //   rim (the golden-hour halo that separates the silhouette from the land)
  // • soft rim + sky fresnel: grazing angles pick up the sky colour (ties the figure into the world's light)
  // • ground bounce: the underside of the body is lit by the colour of the terrain below
  // • per-vertex wear from the surface bake (bake.js): dirt roughens, worn edges go glossier
  // • woven stars: tiny gold-white points woven into the dark cloth (rest-pose / uv space so they never swim)
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRimStrength = { value: rim };
    sh.uniforms.uSkyRim = { value: sky };
    sh.uniforms.uSunRimK = { value: sunRim };
    sh.uniforms.uWearK = { value: wear };
    sh.uniforms.uStarK = { value: stars };
    sh.uniforms.uStar = SUIT_LIGHT.uStar; sh.uniforms.uTimeS = G.uTime;
    sh.uniforms.uUpW = SUIT_LIGHT.uUpW; sh.uniforms.uBounce = SUIT_LIGHT.uBounce; sh.uniforms.uSkyAmb = G.uAmbientSky;
    sh.uniforms.uSunDirW = G.uSunDir; sh.uniforms.uSunColW = G.uSunColor;
    sh.uniforms.uWaterN = SUIT_LIGHT.uWaterN; sh.uniforms.uWaterP = SUIT_LIGHT.uWaterP; sh.uniforms.uWaterOn = SUIT_LIGHT.uWaterOn; sh.uniforms.uWaterCol = SUIT_LIGHT.uWaterCol;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aWear;\nvarying vec2 vWear;\nvarying vec3 vStarP;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvWear = aWear;\n${starUv ? 'vStarP = vec3(uv * vec2(1.05, 0.66), 0.37);' : 'vStarP = position;'}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uRimStrength; uniform float uSkyRim; uniform float uSunRimK; uniform float uWearK; uniform vec3 uUpW; uniform vec3 uBounce; uniform vec3 uSkyAmb; uniform vec3 uSunDirW; uniform vec3 uSunColW;\nuniform vec3 uWaterN; uniform vec3 uWaterP; uniform float uWaterOn; uniform vec3 uWaterCol;\nuniform float uStarK; uniform float uStar; uniform float uTimeS;\nvarying vec2 vWear;\nvarying vec3 vStarP;')
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
          if (uStarK > 0.0) {
            // woven stars: sparse points in a jittered 3-D grid, twinkling; only on the dark night cloth
            vec3 sp = vStarP * 46.0;
            vec3 ci = floor(sp), cf = fract(sp) - 0.5;
            float h = fract(sin(dot(ci, vec3(127.1, 311.7, 74.7))) * 43758.5453);
            vec3 jo = vec3(fract(h * 13.17), fract(h * 71.31), fract(h * 7.73)) - 0.5;
            float d = length(cf - jo * 0.55);
            float big = step(0.985, h);
            float st = step(0.86, h) * smoothstep(mix(0.07, 0.13, big), 0.0, d) * (0.55 + 0.45 * sin(uTimeS * (1.3 + h * 2.0) + h * 40.0));
            float dk = 1.0 - smoothstep(0.035, 0.12, dot(diffuseColor.rgb, vec3(0.3333)));
            outgoingLight += vec3(1.0, 0.86, 0.6) * st * dk * uStarK * (0.06 + uStar * 3.2);
          }
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
  mat.customProgramCacheKey = () => 'rv-ronin-' + key + '-' + rim + '-' + sky + '-' + sunRim + '-' + stars + (starUv ? 'u' : 'p');
  return mat;
}

export function makeMaterials(renderer, P, quality) {
  const tex = getTextures(renderer);
  const hi = quality?.tier !== 'low';
  const Std = hi ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const woolN = tex.fabricNormal || tex.woolNormal;
  if (woolN) woolN.repeat.set(9, 9);
  // fine silk-cotton weave in the night colour: rough, with a cool silk sheen that draws the folds
  const fabric = new Std({ vertexColors: true, roughness: 0.82, metalness: 0.0, normalMap: woolN, normalScale: new THREE.Vector2(0.45, 0.45) });
  if (hi) { fabric.sheen = 0.7; fabric.sheenRoughness = 0.45; fabric.sheenColor = new THREE.Color(P.coat).lerp(new THREE.Color(0.62, 0.64, 0.8), 0.55); }
  // leather + black lacquer (bracers, boots, shoulder plate, strap): waxy, glossy edges
  const hard = new Std({ vertexColors: true, roughness: 0.48, metalness: 0.0, normalMap: woolN, normalScale: new THREE.Vector2(0.15, 0.15), roughnessMap: tex.wearRough });
  if (hi) { hard.clearcoat = 0.45; hard.clearcoatRoughness = 0.32; }
  if (tex.wearRough) tex.wearRough.repeat.set(3, 3);
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.9, roughnessMap: tex.wearRough });
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1, 1, 1).multiplyScalar(4.0) });
  const skin = new Std({ vertexColors: true, roughness: 0.52, metalness: 0.0 });
  if (hi) { skin.sheen = 0.3; skin.sheenRoughness = 0.45; skin.sheenColor = new THREE.Color(0.95, 0.6, 0.5); }
  // hair: dark, a soft anisotropic-looking sheen band (sheen) over a glossy-ish base
  const hair = new Std({ vertexColors: true, roughness: 0.42, metalness: 0.0, normalMap: woolN, normalScale: new THREE.Vector2(0.3, 0.9) });
  if (hi) { hair.sheen = 1.0; hair.sheenRoughness = 0.32; hair.sheenColor = new THREE.Color(P.hairHi).multiplyScalar(1.6); }
  patchLighting(fabric, { rim: 0.32, sky: 0.16, key: 'silk', sunRim: 1.15, stars: 1 });
  patchLighting(hard, { rim: 0.3, sky: 0.2, key: 'lacquer', sunRim: 0.8 });
  patchLighting(metal, { rim: 0.2, sky: 0.1, key: 'gold', wear: 0.4, sunRim: 0.5 });
  patchLighting(skin, { rim: 0.4, sky: 0.1, key: 'skin', sunRim: 1.0, wear: 0.2 });
  patchLighting(hair, { rim: 0.45, sky: 0.12, key: 'hair', sunRim: 1.4, wear: 0.1 });
  const mats = { fabric, hard, metal, glow, skin, hair };
  for (const [k, m] of Object.entries(mats)) { m.name = 'rv-explorer-' + k; }
  return mats;
}

// ------------------------------------------------------------------ model
/** Hair cap / head geometry constants (shared with Hair.js for the ponytail anchor). */
export const HEAD = {
  c: new THREE.Vector3(0, 1.672, 0.012),
  r: new THREE.Vector3(0.074, 0.1, 0.088),
  tie: new THREE.Vector3(0, 1.758, -0.072),   // ponytail tie at the back of the crown (group / rest space)
};

/**
 * Build the swordswoman. Returns { group, root (bone), bones, skeleton, meshes, materials, palette, triangles }.
 * `quality` scales tessellation. The katana and its scabbard are separate (Katana.js), the ponytail and the
 * scarf tails are verlet cloth (Cloth.js), the coat skirt too (Coat.js).
 */
export function buildExplorer(renderer, body, quality) {
  const P = heroPalette(body);
  const lod = quality?.tier === 'low' ? 0.6 : quality?.tier === 'med' ? 0.8 : 1;
  const R = (n) => Math.max(6, Math.round(n * lod));
  const A = new Assembler();
  const gold = P.gold;

  // ================================================================ torso: fitted kimono-style coat
  const torsoSecs = [
    { y: 0.84, rx: 0.124, rz: 0.094 },
    { y: 0.93, rx: 0.158, rz: 0.112, e: 2.3 },
    { y: 1.0, rx: 0.146, rz: 0.103, e: 2.3 },
    { y: 1.06, rx: 0.126, rz: 0.093, e: 2.3 },
    { y: 1.14, rx: 0.134, rz: 0.097, e: 2.4 },
    { y: 1.22, rx: 0.15, rz: 0.104, fz: 0.026, e: 2.5 },
    { y: 1.29, rx: 0.16, rz: 0.108, fz: 0.034, e: 2.6 },
    { y: 1.355, rx: 0.168, rz: 0.106, fz: 0.014, e: 2.7 },
    { y: 1.415, rx: 0.17, rz: 0.102, e: 2.8 },
    { y: 1.46, rx: 0.124, rz: 0.088, e: 2.4 },
    { y: 1.495, rx: 0.068, rz: 0.064 },
    { y: 1.54, rx: 0.052, rz: 0.054 },
  ];
  const torsoSkin = bandsY([[B.hips, 0.95], [B.spine, 1.1], [B.chest, 1.27], [B.chest, 1.45], [B.neck, 1.52]]);
  A.add('fabric', loft(torsoSecs, { radial: R(32), sub: 3, closeBottom: true }), P.coat, torsoSkin);
  const TS = loftSurface(torsoSecs);
  // inner kimono layer in the V of the cross-over collar
  A.add('fabric', patch(TS, { u0: -0.5, u1: 0.5, v0: 1.2, v1: 1.47, nu: R(10), nv: R(8), off: 0.0025, thick: 0.002, bevel: 0.002, round: 0,
    taper: (t) => [-0.04 - 0.5 * t, 0.04 + 0.5 * t] }), P.inner, torsoSkin);
  // cross-over lapels (left over right): a dark collar band edged with a fine gold thread
  {
    const lapL = (y) => lerp3(y, 1.5, 0.62, 1.29, 0.12, 1.07, -0.52); // wearer's left lapel crosses to her right
    const lapR = (y) => -lerp3(y, 1.5, 0.62, 1.3, 0.1, 1.2, -0.25);
    A.add('fabric', seam(TS, lapR, 1.2, 1.49, 0.006, 0.014, 16), P.coat2, torsoSkin);
    A.add('fabric', seam(TS, lapL, 1.07, 1.49, 0.009, 0.016, 18), P.coat2, torsoSkin);
    A.add('metal', seam(TS, (y) => lapL(y) + 0.11, 1.08, 1.47, 0.012, 0.0028, 18, 4), gold, torsoSkin);
    // collar round the back of the neck (stands a little)
    const pts = [];
    for (let i = 0; i <= 16; i++) { const a = 0.62 + (i / 16) * (Math.PI * 2 - 1.24); const p = new THREE.Vector3(); TS(a, 1.495, p); const c = p.clone(); c.y = 0; pts.push(p.clone().addScaledVector(c.normalize(), 0.012).setY(1.5 + 0.012 * Math.abs(Math.cos(a)))); }
    A.add('fabric', tube(pts, 0.016, R(32), 6), P.coat2, torsoSkin);
  }
  // side + back seams in a darker thread (tailoring lines read at game distance)
  for (const sd of [1, -1]) A.add('fabric', seam(TS, sd * Math.PI * 0.6, 1.08, 1.4, 0.002, 0.0035, 12), P.coat2, torsoSkin);
  A.add('fabric', seam(TS, Math.PI, 1.08, 1.44, 0.002, 0.0035, 12), P.coat2, torsoSkin);
  // obi: a wide dark sash, gold thread edges, knot at the back, a gold cord tied at the front-left
  {
    const obi = [{ y: 0.95, rx: 0.16, rz: 0.116, e: 2.3 }, { y: 1.015, rx: 0.152, rz: 0.11, e: 2.3 }, { y: 1.08, rx: 0.137, rz: 0.1, e: 2.3 }];
    A.add('fabric', loft(obi, { radial: R(32), sub: 2 }), P.coat2, rigid(B.hips));
    for (const s of [obi[0], obi[2]]) { const g = torus(1, 0.0032, 4, R(40)); xf(g, 0, s.y + (s === obi[0] ? 0.004 : -0.004), 0, Math.PI / 2, 0, 0, s.rx + 0.003, (s.rz + 0.003), 1); A.add('metal', g, gold, rigid(B.hips)); }
    const knot = box(0.11, 0.075, 0.05, 0.02, 3); xf(knot, 0, 1.0, -0.125); A.add('fabric', knot, P.coat2, rigid(B.hips));
    const cord = torus(0.022, 0.004, 4, 12); xf(cord, 0.09, 1.0, 0.105, 0, 0.6, 0); A.add('metal', cord, gold, rigid(B.hips));
    const tail = tube([new THREE.Vector3(0.095, 0.99, 0.11), new THREE.Vector3(0.1, 0.94, 0.112), new THREE.Vector3(0.105, 0.89, 0.108)], 0.0035, 8, 4); A.add('metal', tail, gold, rigid(B.hips));
  }
  // baldric: the scabbard strap crossing the chest from the right shoulder to the left hip
  {
    const strapA = (y) => lerp3(y, 1.43, -1.05, 1.22, -0.05, 1.02, 0.95);
    const g = seam(TS, strapA, 1.02, 1.43, 0.011, 0.013, 18, 6);
    A.add('hard', g, P.leather, torsoSkin);
    const p = new THREE.Vector3(); TS(strapA(1.22), 1.22, p);
    const bk = box(0.03, 0.026, 0.01, 0.004); xf(bk, p.x, p.y, p.z + 0.012, 0, strapA(1.22), -0.5); A.add('metal', bk, gold, torsoSkin);
  }

  // ================================================================ arms: fitted sleeves, wrapped forearms, gloves
  const buildArm = (side) => {
    const x = 0.19 * side, z = -0.025;
    const ax = (b) => B[b + (side > 0 ? 'L' : 'R')];
    const secs = [
      { y: 0.85, rx: 0.042, rz: 0.046, ox: x, oz: z },
      { y: 0.9, rx: 0.044, rz: 0.048, ox: x, oz: z },
      { y: 0.99, rx: 0.046, rz: 0.05, ox: x, oz: z },
      { y: 1.07, rx: 0.05, rz: 0.053, ox: x, oz: z },
      { y: 1.13, rx: 0.058, rz: 0.06, ox: x, oz: z },
      { y: 1.26, rx: 0.064, rz: 0.066, ox: x, oz: z },
      { y: 1.37, rx: 0.066, rz: 0.066, ox: x, oz: z },
      { y: 1.45, rx: 0.058, rz: 0.06, ox: x, oz: z },
    ];
    const skin = bandsY([[ax('hand'), 0.85], [ax('foreArm'), 0.88], [ax('foreArm'), 1.085], [ax('upperArm'), 1.14]]);
    A.add('fabric', loft(secs, { radial: R(18), sub: 3 }), P.coat, skin);
    const AS = loftSurface(secs);
    const outer = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    A.add('metal', seam(AS, outer + Math.PI * 0.1 * side, 1.14, 1.44, 0.003, 0.0022, 12, 4), gold, skin);
    // sleeve hem at the elbow: the loose upper sleeve ends over the forearm wrap
    { const g = torus(0.06, 0.008, R(6), R(18)); xf(g, x, 1.12, z, Math.PI / 2, 0, 0, 1, 1.05, 1); A.add('fabric', g, P.coat2, rigid(ax('foreArm'))); }
    // forearm wraps (dark cloth bands, slightly spiralled) under a lacquered leather bracer on the outer forearm
    for (let i = 0; i < 6; i++) { const g = torus(0.049 - i * 0.0006, 0.0055, 4, R(16)); xf(g, x, 0.9 + i * 0.034, z, Math.PI / 2 + (i % 2 ? 0.16 : -0.16)); A.add('fabric', g, P.wrap.clone().multiplyScalar(i % 2 ? 1 : 0.85), rigid(ax('foreArm'))); }
    A.add('hard', patch(AS, { u0: outer - 1.25, u1: outer + 1.25, v0: 0.9, v1: 1.07, nu: R(10), nv: R(6), off: 0.009, thick: 0.006, bevel: 0.003, round: 5 }), P.lacquer, rigid(ax('foreArm')));
    A.add('metal', patch(AS, { u0: outer - 0.12, u1: outer + 0.12, v0: 0.93, v1: 1.04, nu: 4, nv: 4, off: 0.016, thick: 0.002, bevel: 0.001, round: 3 }), gold, rigid(ax('foreArm')));
    // fingerless glove: leather palm + cuff, skin fingers and thumb
    const hx = x, hz = z + 0.004;
    { const g = box(0.038, 0.072, 0.07, 0.016); xf(g, hx, 0.803, hz); A.add('hard', g, P.leather, rigid(ax('hand'))); }
    { const g = box(0.03, 0.066, 0.064, 0.013); xf(g, hx - side * 0.003, 0.736, hz + 0.004, 0, 0, side * 0.06); A.add('skin', g, P.skin, rigid(ax('fingers'))); }
    { const g = ellipsoid(0.014, 0.031, 0.014, R(10), R(8)); xf(g, hx - side * 0.012, 0.782, hz + 0.047, 0.5, 0, -side * 0.25); A.add('skin', g, P.skin, rigid(ax('hand'))); }
    { const g = cylinder(0.036, 0.035, 0.026, R(16)); xf(g, hx, 0.848, hz); A.add('hard', g, P.leather, rigid(ax('hand'))); }
  };
  buildArm(1); buildArm(-1);
  // a single lacquered shoulder guard on the left shoulder (asymmetry: the sword hand stays free)
  {
    const SH = ellipsoidSurface(new THREE.Vector3(0.2, 1.405, -0.022), new THREE.Vector3(0.082, 0.072, 0.082));
    const sk = (x, y, z, o) => { o[0] = B.upperArmL; o[1] = 0.6; o[2] = B.chest; o[3] = 0.4; return o; };
    A.add('hard', patch(SH, { u0: 0.15, u1: 2.95, v0: -0.25, v1: 1.15, nu: R(14), nv: R(8), off: 0.006, thick: 0.007, bevel: 0.004, round: 4 }), P.lacquer, sk);
    A.add('hard', patch(SH, { u0: 0.4, u1: 2.7, v0: -0.95, v1: -0.2, nu: R(12), nv: R(5), off: 0.016, thick: 0.006, bevel: 0.003, round: 4 }), P.lacquer, rigid(B.upperArmL));
    const pts = []; const p = new THREE.Vector3();
    for (let i = 0; i <= 14; i++) { SH(0.4 + (i / 14) * 2.3, -0.95, p); const c = p.clone().sub(new THREE.Vector3(0.2, 1.405, -0.022)).normalize(); pts.push(p.clone().addScaledVector(c, 0.019)); }
    A.add('metal', tube(pts, 0.0026, R(28), 4), gold, rigid(B.upperArmL));
  }

  // ================================================================ legs: hakama trousers tucked into wraps, boots
  const buildLeg = (side) => {
    const x = 0.09 * side;
    const lb = (b) => B[b + (side > 0 ? 'L' : 'R')];
    const secs = [
      { y: 0.36, rx: 0.06, rz: 0.064, ox: x },
      { y: 0.43, rx: 0.08, rz: 0.084, ox: x, bz: 0.01 },
      { y: 0.52, rx: 0.084, rz: 0.088, ox: x },
      { y: 0.64, rx: 0.088, rz: 0.092, ox: x },
      { y: 0.78, rx: 0.095, rz: 0.098, ox: x },
      { y: 0.9, rx: 0.1, rz: 0.1, ox: x },
      { y: 0.99, rx: 0.09, rz: 0.09, ox: x - side * 0.01 },
    ];
    const skin = bandsY([[lb('shin'), 0.38], [lb('shin'), 0.475], [lb('thigh'), 0.56], [lb('thigh'), 0.9], [B.hips, 1.0]]);
    A.add('fabric', loft(secs, { radial: R(20), sub: 3, ripple: (y) => 1 + 0.02 * sstep(0.5, 0.4, y) }), P.trousers, skin);
    const LS = loftSurface(secs);
    // hakama pleats (darker folds down the front and back)
    for (const a of [0.22, -0.22, 0.62 * side, Math.PI - 0.3, Math.PI + 0.3]) A.add('fabric', seam(LS, a, 0.44, 0.95, 0.001, 0.0045, 12, 4), P.coat2, skin);
    // shin: slim wrapped calf (kyahan) — dark bands in a slight spiral, a gold tie at the top
    const shinSecs = [{ y: 0.12, rx: 0.046, rz: 0.05, ox: x }, { y: 0.24, rx: 0.052, rz: 0.058, ox: x, bz: 0.01 }, { y: 0.37, rx: 0.058, rz: 0.062, ox: x }];
    A.add('fabric', loft(shinSecs, { radial: R(16), sub: 2 }), P.wrap, bandsY([[lb('foot'), 0.1], [lb('shin'), 0.16]]));
    for (let i = 0; i < 6; i++) {
      const y = 0.15 + i * 0.038;
      const g = torus(0.05 + 0.006 * Math.sin(i), 0.006, 4, R(16)); xf(g, x, y, 0.002, Math.PI / 2 + (i % 2 ? 0.2 : -0.2), 0, 0, 1, 1.12, 1);
      A.add('fabric', g, P.wrap.clone().multiplyScalar(i % 2 ? 0.8 : 1.05), rigid(lb('shin')));
    }
    { const g = torus(0.062, 0.0035, 4, R(18)); xf(g, x, 0.385, 0, Math.PI / 2, 0, 0, 1, 1.05, 1); A.add('metal', g, gold, rigid(lb('shin'))); }
    // boots: slim, black leather, a fold at the ankle
    const bootSecs = [
      { y: 0.035, rx: 0.052, rz: 0.07, ox: x, oz: 0.01 },
      { y: 0.09, rx: 0.05, rz: 0.06, ox: x },
      { y: 0.13, rx: 0.05, rz: 0.056, ox: x },
    ];
    A.add('hard', loft(bootSecs, { radial: R(18), sub: 2 }), P.boot, bandsY([[lb('foot'), 0.1], [lb('shin'), 0.13]]));
    { const g = box(0.092, 0.07, 0.25, 0.032, 3); xf(g, x, 0.046, 0.05); A.add('hard', g, P.boot, rigid(lb('foot'))); }
    { const g = box(0.1, 0.02, 0.262, 0.009, 2); xf(g, x, 0.011, 0.05); A.add('hard', g, P.sole, rigid(lb('foot'))); }
  };
  buildLeg(1); buildLeg(-1);

  // ================================================================ head: face, hair, the scarf at the neck
  const hc = HEAD.c, hrd = HEAD.r;
  { const g = cylinder(0.038, 0.045, 0.13, R(14)); xf(g, 0, 1.55, 0.004); A.add('skin', g, P.skin, blendY(B.neck, B.head, 1.53, 1.6)); }
  { // head: an oval face, a fine jaw and a small chin
    const g = ellipsoid(hrd.x, hrd.y, hrd.z, R(24), R(18), {
      deform: (v) => {
        const ty = v.y / hrd.y, tz = v.z / hrd.z;
        if (ty < 0) { v.x *= 1 - 0.3 * ty * ty; v.z *= 1 - 0.08 * ty * ty * Math.max(0, -tz); }
        v.z += 0.01 * Math.max(0, -ty) * Math.max(0, tz) * (1 - Math.abs(v.x) / hrd.x); // chin / mouth forward
        if (tz > 0.6 && Math.abs(ty) < 0.25) v.x *= 1.03; // cheekbones
        v.add(hc);
      },
    });
    A.add('skin', g, P.skin, rigid(B.head));
  }
  const fz = hc.z + hrd.z;
  { const g = ellipsoid(0.0105, 0.021, 0.014, 8, 6); xf(g, 0, 1.662, fz - 0.002, -0.22); A.add('skin', g, P.skin, rigid(B.head)); }  // nose
  { const g = ellipsoid(0.017, 0.0055, 0.0075, 10, 6); xf(g, 0, 1.613, fz - 0.009, 0.15); A.add('skin', g, P.lips, rigid(B.head)); } // lips
  for (const s of [1, -1]) {
    const e = ellipsoid(0.0125, 0.0052, 0.006, 10, 6); xf(e, s * 0.029, 1.687, fz - 0.013, 0, s * 0.38, s * 0.12); A.add('metal', e, P.eye, rigid(B.head));
    const l = box(0.03, 0.0035, 0.008, 0.0015); xf(l, s * 0.03, 1.692, fz - 0.011, 0.1, s * 0.36, s * 0.16); A.add('hair', l, P.hair, rigid(B.head)); // lash line
    const b = box(0.034, 0.0055, 0.01, 0.0025); xf(b, s * 0.032, 1.705, fz - 0.012, 0.25, s * 0.32, -s * 0.16); A.add('hair', b, P.hair, rigid(B.head)); // brows, an arched line
    const ck = ellipsoid(0.016, 0.012, 0.006, 8, 6); xf(ck, s * 0.044, 1.655, fz - 0.026, 0, s * 0.6, 0); A.add('skin', ck, P.blush, rigid(B.head));
  }
  // hair: a sleek cap swept back to a high ponytail, two long locks framing the face, a side-swept fringe
  {
    const HC = hc.clone().add(new THREE.Vector3(0, 0.008, -0.006));
    const HS = ellipsoidSurface(HC, new THREE.Vector3(hrd.x + 0.01, hrd.y + 0.012, hrd.z + 0.012), (v, az, el) => {
      // volume swept back toward the tie; the nape tucks in
      const back = Math.max(0, -Math.cos(az));
      v.z -= 0.012 * back * Math.max(0, Math.sin(el + 0.4));
      v.y += 0.006 * Math.max(0, Math.sin(el));
    });
    const hk = rigid(B.head);
    // back / sides: down to the nape, narrowing toward the back at the bottom
    A.add('hair', patch(HS, { u0: 0.72, u1: Math.PI * 2 - 0.72, v0: -0.75, v1: 1.25, nu: R(22), nv: R(14), off: 0, thick: 0.007, bevel: 0.004, round: 3,
      taper: (t) => { const k = sstep(0.32, 0.0, t); return [0.72 + k * 1.15, Math.PI * 2 - 0.72 - k * 1.15]; } }), P.hair, hk);
    // crown + hairline over the forehead (a soft widow's peak)
    A.add('hair', patch(HS, { u0: -1.0, u1: 1.0, v0: 0.42, v1: 1.5, nu: R(14), nv: R(10), off: 0.0, thick: 0.007, bevel: 0.004, round: 3,
      taper: (t) => [-0.85 - 0.6 * t, 0.85 + 0.6 * t] }), P.hair, hk);
    // strand grooves (darker lines sweeping back to the tie) read as combed hair, not a helmet
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    for (let i = 0; i < 9; i++) {
      const az0 = -0.75 + i * 0.19;
      const pts = [];
      for (let k = 0; k <= 8; k++) { const t = k / 8; HS(az0 * (1 - t) + Math.PI * Math.sign(az0 || 1) * t * 0.98, 0.5 + 0.55 * Math.sin(t * Math.PI) * 0.6 + t * 0.15, p); q.copy(p).sub(HC).normalize(); pts.push(p.clone().addScaledVector(q, 0.0075)); }
      A.add('hair', tube(pts, 0.0028, 24, 3), P.hairHi.clone().multiplyScalar(0.55), hk);
    }
    // the tie: a gold band and a short cuff of hair where the ponytail springs out (the tail itself is cloth)
    const T = HEAD.tie;
    { const g = ellipsoid(0.03, 0.028, 0.04, R(10), R(8)); xf(g, T.x, T.y - 0.004, T.z + 0.012, -0.5); A.add('hair', g, P.hair, hk); }
    { const g = torus(0.02, 0.006, 5, R(14)); xf(g, T.x, T.y - 0.008, T.z - 0.012, 1.0); A.add('metal', g, gold, hk); }
    { const g = ellipsoid(0.019, 0.017, 0.03, R(8), R(6)); xf(g, T.x, T.y - 0.014, T.z - 0.034, 0.9); A.add('hair', g, P.hair, hk); }
    // two long face-framing locks (temple → below the jaw), flattened ribbons with a slight S
    for (const s of [1, -1]) {
      for (const [dx, len, rr] of [[0.0, 0.16, 0.0085], [0.012, 0.12, 0.007]]) {
        const pts = [];
        HS(s * (0.95 + dx * 10), 0.42, p);
        const base = p.clone();
        for (let k = 0; k <= 5; k++) { const t = k / 5; pts.push(base.clone().add(new THREE.Vector3(s * (0.004 + 0.008 * Math.sin(t * 2.6)), -len * t, 0.012 * Math.sin(t * Math.PI) - 0.004 * t))); }
        const g = tube(pts, rr, 16, 5);
        const pa = g.attributes.position; // flatten across the cheek
        for (let i2 = 0; i2 < pa.count; i2++) pa.setX(i2, base.x + (pa.getX(i2) - base.x) * 0.55);
        g.computeVertexNormals();
        A.add('hair', g, P.hair, hk);
      }
    }
    // side-swept fringe across the brow (from the parting on her left to the right temple)
    {
      const pts = [];
      for (let k = 0; k <= 6; k++) { const t = k / 6; HS(0.45 - t * 1.25, 0.62 - 0.22 * Math.sin(t * Math.PI * 0.9) - 0.06 * t, p); q.copy(p).sub(HC).normalize(); pts.push(p.clone().addScaledVector(q, 0.004)); }
      const g = tube(pts, 0.011, 20, 6);
      A.add('hair', g, P.hair, hk);
    }
  }
  // the red scarf: worn loose around the neck and the tops of the shoulders (the tails are verlet cloth)
  {
    const wrapSecs = [
      { y: 1.455, rx: 0.128, rz: 0.104 },
      { y: 1.49, rx: 0.106, rz: 0.094, fz: 0.014 },
      { y: 1.525, rx: 0.084, rz: 0.084, fz: 0.016 },
      { y: 1.55, rx: 0.07, rz: 0.074, fz: 0.006 },
    ];
    for (const s of wrapSecs) s.oz = 0.006;
    const wrapSkin = bandsY([[B.chest, 1.45], [B.neck, 1.52]]);
    A.add('fabric', loft(wrapSecs, { radial: R(30), sub: 3, ripple: (y) => 1 + 0.04 * Math.pow(Math.abs(Math.sin((y - 1.45) * 52)), 2) }), P.scarf, wrapSkin);
    { const g = ellipsoid(0.03, 0.026, 0.022, R(10), R(8)); xf(g, -0.055, 1.47, 0.1, 0.2, -0.3, -0.4); A.add('fabric', g, P.scarf, rigid(B.chest)); }
  }

  // ---------------- assemble
  const geos = A.build();
  try { bakeSurface(geos, P, 'ronin-' + lod); } catch (e) { console.warn('[player] surface bake skipped', e); }
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

/** Piecewise-linear a(y) through three (y, a) keys (descending y). */
function lerp3(y, y0, a0, y1, a1, y2, a2) {
  if (y >= y1) { const t = clamp01((y - y1) / (y0 - y1), 0, 1); return a1 + (a0 - a1) * t; }
  const t = clamp01((y - y2) / (y1 - y2), 0, 1); return a2 + (a1 - a2) * t;
}
