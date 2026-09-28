// Grass: GPU-instanced blade patches. One instance = one patch (~40 blades) rooted on the terrain by
// the placement worker (height, slope tilt, density, height & dryness per patch). Everything else —
// blade shape, curvature, wind gusts, player push, color variation, distance thinning — happens in
// the vertex shader. Blades are real geometry (no alpha test) and widen/thin with distance → no
// shimmer. MeshStandardMaterial + onBeforeCompile so CSM sun shadows, env light and fog apply.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { mulberry } from './util.js';

/** Patch geometry: `blades` blades with `segs` segments inside a unit disc (scaled by uPatchR). */
export function makeGrassPatch(blades, segs, seed = 3) {
  const rnd = mulberry(seed);
  const vpb = segs * 2 + 1;
  const pos = new Float32Array(blades * vpb * 3);
  const bl = new Float32Array(blades * vpb * 4);
  const sg = new Float32Array(blades * vpb * 2);
  const idx = [];
  for (let b = 0; b < blades; b++) {
    // blue-noise-ish distribution: sunflower spiral + jitter
    const rr = Math.sqrt((b + 0.5) / blades) * (0.92 + rnd() * 0.1);
    const th = b * 2.39996 + rnd() * 0.6;
    const x = Math.cos(th) * rr, z = Math.sin(th) * rr;
    const ang = rnd() * Math.PI * 2;
    const r = (b + rnd()) / blades; // rank for density thinning (uniform order)
    const base = b * vpb;
    for (let k = 0; k < vpb; k++) {
      const seg = k === vpb - 1 ? segs : Math.floor(k / 2);
      const t = seg / segs;
      const side = k === vpb - 1 ? 0 : (k % 2 === 0 ? -1 : 1);
      const i = base + k;
      pos[i * 3] = x; pos[i * 3 + 1] = t * 0.6; pos[i * 3 + 2] = z;
      bl[i * 4] = x; bl[i * 4 + 1] = z; bl[i * 4 + 2] = ang; bl[i * 4 + 3] = r;
      sg[i * 2] = t; sg[i * 2 + 1] = side;
    }
    for (let s = 0; s < segs - 1; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const a = base + (segs - 1) * 2;
    idx.push(a, a + 1, base + vpb - 1);
  }
  // shuffle blade order is already random via rank; keep index order
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aBlade', new THREE.BufferAttribute(bl, 4));
  g.setAttribute('aSeg', new THREE.BufferAttribute(sg, 2));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 2.5);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-2, -0.5, -2), new THREE.Vector3(2, 2, 2));
  return g;
}

const GRASS_VERT_PARS = /* glsl */`
#include <rv_flora>
attribute vec4 iPos; attribute vec4 iRot; attribute vec4 iData;
attribute vec4 aBlade; attribute vec2 aSeg;
uniform vec3 uCamPos; uniform vec3 uPlanetCenter; uniform float uTime; uniform vec3 uWindDir; uniform float uWindStrength;
uniform vec4 uFade; uniform float uPatchR; uniform float uHeight; uniform float uWidth; uniform float uDensity;
uniform vec4 uKeep; uniform vec4 uPush; uniform float uWidenK; uniform float uStiff;
varying float vT; varying float vDry; varying float vRand; varying vec2 vFade; varying float vAO; varying vec3 vGW; varying float vSide;
vec3 rvQrotG(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
float gHash(float n){ return fract(sin(n) * 43758.5453); }
vec3 rvGrassPos; vec3 rvGrassN;
`;

// computed in <beginnormal_vertex> (normals are needed before <begin_vertex>)
const GRASS_CORE = /* glsl */`
{
  vec3 anchorW = (modelMatrix * vec4(iPos.xyz, 1.0)).xyz;
  vec3 upP = normalize(anchorW - uPlanetCenter);         // true planet up (wind, push)
  vec3 up = rvQrotG(iRot, vec3(0.0, 1.0, 0.0));          // patch up (slope-tilted)
  float t = aSeg.x;
  float r = aBlade.w;
  float h1 = gHash(r * 91.7 + iData.x * 13.1), h2 = gHash(r * 47.3 + iData.x * 7.7), h3 = gHash(r * 13.9 + iData.x * 3.3);
  vec3 rootL = vec3(aBlade.x, 0.0, aBlade.y) * uPatchR * iPos.w;
  vec3 root = rvQrotG(iRot, rootL);
  vec3 rootW = anchorW + root;
  float d = length(rootW - uCamPos);
  vFade = rvLodFade(d, uFade);
  // distance thinning: keep fraction falls with distance; blades near the threshold shrink smoothly
  float keep = iData.y * uDensity * clamp(pow(uKeep.x / max(d, 1.0), uKeep.y), uKeep.z, 1.0);
  float alive = smoothstep(0.0, 0.08, keep - r) * vFade.x * vFade.y;
  float H = uHeight * iData.z * (0.55 + 0.6 * h1 * h1 + 0.2 * h2) * alive;
  float W = uWidth * (0.6 + 0.8 * h2) * (1.0 + d * uWidenK) * iPos.w;
  float ang = aBlade.z;
  vec3 fl = rvQrotG(iRot, vec3(cos(ang), 0.0, sin(ang)));       // blade facing (normal)
  vec3 sl = rvQrotG(iRot, vec3(-sin(ang), 0.0, cos(ang)));      // across the blade
  // static curvature (blades arc outward from the patch center + random lean)
  vec3 outward = length(rootL) > 1e-3 ? normalize(root) : fl;
  // coherent 'combed' lean over the field (flow field in world space) + slight tuft arc + noise
  vec3 plR = rootW - uPlanetCenter;
  float fa = sin(dot(plR, vec3(0.043, 0.037, 0.051))) * 2.2 + sin(dot(plR, vec3(-0.011, 0.017, 0.013))) * 3.0;
  vec3 e1 = normalize(cross(upP, abs(upP.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(upP, e1);
  vec3 flow = e1 * cos(fa) + e2 * sin(fa);
  vec3 D = (flow * 0.32 + outward * 0.12 + fl * (h3 - 0.5) * 0.45) * H * (0.3 + 0.4 * h2);
  // wind: travelling gusts (coherent over the field) + per-blade flutter
  vec3 wd = uWindDir - upP * dot(uWindDir, upP);
  wd = length(wd) > 1e-3 ? normalize(wd) : sl;
  vec3 wsd = cross(upP, wd);
  vec3 pl = rootW - uPlanetCenter;
  float along = dot(pl, wd), across = dot(pl, wsd);
  float g1 = sin(along * 0.18 - uTime * 2.3 + sin(across * 0.07 + uTime * 0.3) * 2.0);
  float g2 = sin(along * 0.047 - uTime * 0.9 + across * 0.021);
  float gust = clamp(0.5 + 0.35 * g1 + 0.3 * g2, 0.0, 1.2);
  float ws = uWindStrength;
  float flut = sin(uTime * (3.5 + h1 * 2.5) + h2 * 30.0 + along * 0.9);
  D += wd * H * (ws * (0.25 + 0.95 * gust) + 0.06 * flut * (0.3 + ws)) / uStiff;
  D += wsd * H * 0.08 * sin(uTime * 1.7 + h3 * 20.0 + across * 0.5) * (0.2 + ws);
  // interactive push away from the player (and flattening under their feet)
  vec3 pv = rootW - uPush.xyz;
  pv -= upP * dot(pv, upP);
  float pd = length(pv);
  float pf = 1.0 - smoothstep(uPush.w * 0.25, uPush.w, pd);
  if (pf > 0.0) D += (pd > 1e-3 ? pv / pd : fl) * pf * H * 1.35;
  // keep blade length roughly constant under bending
  float dl = length(D) / max(H, 1e-3);
  float vy = sqrt(max(0.04, 1.0 - min(dl * dl * 0.6, 0.96)));
  vec3 tipOff = up * H * vy + D;
  float tt = t * t;
  vec3 p = root + up * H * vy * t + D * tt;
  float wTaper = aSeg.y * W * 0.5 * (1.0 - pow(t, 1.5)) * (0.25 + 0.75 * alive);
  p += sl * wTaper;
  rvGrassPos = iPos.xyz + p;
  // normal: blade facing tilted toward the curve, rounded across the blade, blended with up
  vec3 tangent = normalize(up * H * vy + 2.0 * D * t + 1e-4 * fl);
  vec3 bn = normalize(cross(sl, tangent));
  if (dot(bn, uCamPos - rootW) < 0.0) bn = -bn;
  bn = normalize(bn + sl * aSeg.y * 0.45);
  rvGrassN = normalize(mix(bn, upP, 0.55));
  vT = t; vDry = iData.w; vRand = h1; vAO = mix(0.4, 1.0, smoothstep(0.0, 0.8, t)); vSide = aSeg.y;
  vGW = rootW;
  if (H < 1e-3) rvGrassPos = iPos.xyz;
}
`;

const GRASS_FRAG_PARS = /* glsl */`
#include <rv_flora>
uniform vec3 uBase; uniform vec3 uTip; uniform vec3 uDryC; uniform vec3 uGlowTip; uniform float uGlowAmt; uniform float uNight; uniform float uTime;
uniform float uTransl; uniform vec3 uPlanetCenter;
varying float vT; varying float vDry; varying float vRand; varying vec2 vFade; varying float vAO; varying vec3 vGW; varying float vSide;
float rvTransl = 0.0; float rvWrap = 0.0;
vec3 rvGlow = vec3(0.0);
float gH3(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float gVN(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gH3(i), gH3(i + vec3(1,0,0)), f.x), mix(gH3(i + vec3(0,1,0)), gH3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(gH3(i + vec3(0,0,1)), gH3(i + vec3(1,0,1)), f.x), mix(gH3(i + vec3(0,1,1)), gH3(i + vec3(1,1,1)), f.x), f.y), f.z); }
`;

const GRASS_MAP = /* glsl */`
{
  vec3 wp = vGW - uPlanetCenter;
  float macro = gVN(wp * 0.045) * 0.6 + gVN(wp * 0.17) * 0.4;
  float t = vT;
  vec3 base = uBase * (0.8 + 0.4 * macro);
  vec3 tip = uTip * (0.85 + 0.3 * vRand) * (0.9 + 0.25 * macro);
  vec3 c = mix(base, tip, smoothstep(0.0, 1.0, pow(t, 0.8)));
  float dry = clamp(vDry * (0.6 + 0.8 * vRand) + (macro - 0.5) * 0.35, 0.0, 1.0);
  c = mix(c, uDryC * (0.8 + 0.4 * vRand) * mix(0.75, 1.1, t), dry * dry * smoothstep(0.0, 0.5, t + 0.2));
  // hue jitter per blade
  c *= vec3(1.0 + (vRand - 0.5) * 0.18, 1.0, 1.0 - (vRand - 0.5) * 0.22);
  // pale sunlit tips
  c = mix(c, c * vec3(1.18, 1.12, 0.85) + 0.02, smoothstep(0.75, 1.0, t) * 0.5);
  diffuseColor.rgb *= c;
  rvTransl = uTransl * (0.45 + 0.55 * t);
  rvWrap = 0.6;
  if (uGlowAmt > 0.0) {
    // only some blades carry glowing tips; they breathe slowly in patches
    float sel = smoothstep(0.62, 0.8, vRand);
    float pulse = 0.55 + 0.45 * sin(uTime * 0.9 + macro * 12.0 + vRand * 6.0);
    rvGlow = uGlowTip * uGlowAmt * pow(t, 4.0) * (0.02 + uNight) * sel * pulse;
  }
}
`;

const GRASS_LIGHT_PARS = /* glsl */`
#include <lights_physical_pars_fragment>
void RE_Direct_Grass(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  RE_Direct_Physical(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  float nl = dot(geometryNormal, directLight.direction);
  float w = clamp((nl + rvWrap) / (1.0 + rvWrap), 0.0, 1.0) - clamp(nl, 0.0, 1.0);
  reflectedLight.directDiffuse += directLight.color * BRDF_Lambert(material.diffuseContribution) * w * 0.7;
  float scat = pow(clamp(dot(geometryViewDir, -directLight.direction), 0.0, 1.0), 3.0);
  vec3 tcol = material.diffuseContribution * vec3(1.1, 1.2, 0.55);
  reflectedLight.directDiffuse += directLight.color * tcol * rvTransl * (0.2 + 1.8 * scat) * RECIPROCAL_PI * 1.5;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Grass
`;

export function makeGrassMaterial(p) {
  const u = {
    uFade: { value: new THREE.Vector4(...(p.fade ?? [0, 0, 40, 50])) },
    uKeep: { value: new THREE.Vector4(...(p.keep ?? [12, 0.8, 0.12, 1])) },
    uPatchR: { value: p.patchR ?? 0.7 }, uHeight: { value: p.height ?? 0.55 }, uWidth: { value: p.width ?? 0.05 },
    uDensity: { value: p.density ?? 1 }, uWidenK: { value: p.widenK ?? 0.02 }, uStiff: { value: p.stiff ?? 1 },
    uPush: p.push, // shared {value: Vector4(scene xyz, radius)}
    uBase: { value: new THREE.Color().fromArray(p.base) }, uTip: { value: new THREE.Color().fromArray(p.tip) },
    uDryC: { value: new THREE.Color().fromArray(p.dry) }, uGlowTip: { value: new THREE.Color().fromArray(p.glowTip ?? [0, 0, 0]) },
    uGlowAmt: { value: p.glowTip ? (p.glowAmt ?? 2) : 0 }, uTransl: { value: p.transl ?? 0.9 },
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0, side: THREE.DoubleSide });
  mat.name = 'flora-grass';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = G.uTime; shader.uniforms.uWindDir = G.uWindDir; shader.uniforms.uWindStrength = G.uWindStrength;
    shader.uniforms.uCamPos = G.uCameraPos; shader.uniforms.uPlanetCenter = G.uPlanetCenter; shader.uniforms.uNight = G.uNight;
    for (const k in u) shader.uniforms[k] = u[k];
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + GRASS_VERT_PARS);
    vs = vs.replace('#include <beginnormal_vertex>', GRASS_CORE + '\nvec3 objectNormal = rvGrassN;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(1.0,0.0,0.0);\n#endif');
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = rvGrassPos;');
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\n' + GRASS_FRAG_PARS);
    fs = fs.replace('#include <map_fragment>', GRASS_MAP);
    fs = fs.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal *= faceDirection;');
    fs = fs.replace('#include <lights_physical_pars_fragment>', GRASS_LIGHT_PARS);
    fs = fs.replace('#include <aomap_fragment>', '{ reflectedLight.indirectDiffuse *= vAO; reflectedLight.indirectSpecular *= vAO * 0.6; reflectedLight.directDiffuse *= mix(1.0, vAO, 0.5); reflectedLight.directSpecular *= vAO * 0.5; }\n#include <aomap_fragment>');
    fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rvGlow;');
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'rv-flora-grass-v1';
  return { material: mat, uniforms: u };
}
