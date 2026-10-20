// Grass: GPU-instanced blade patches. One instance = one patch (~40 blades) rooted on the terrain by
// the placement worker (height, slope tilt, density, height & dryness per patch). Everything else —
// blade shape, curvature, wind gusts, player push, color variation, distance thinning — happens in
// the vertex shader. Blades are real geometry (no alpha test) and widen/thin with distance → no
// shimmer. MeshStandardMaterial + onBeforeCompile so CSM sun shadows, env light and fog apply.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { mulberry } from './util.js';
import { FLORA_DITHER, FLORA_SEASON, FLORA_CUTS } from './materials.js';

/**
 * Patch geometry: `blades` blades with `segs` segments inside a unit disc (scaled by uPatchR).
 * Blades are strips of (segs) rows + a single tip vertex; the vertex shader bends the centreline
 * along a quadratic Bézier (stiff base, curving top), tapers each blade with its own profile and
 * twists it slightly so no two blades read alike. The thinning rank is a random permutation that is
 * independent of the blade's position in the disc, so density thinning never shrinks a patch into
 * a clump (it removes blades uniformly over the whole patch).
 */
// Radial blade density inside a patch is a truncated Gaussian (σ = 0.4 of the patch radius): the
// patch grid (spacing ≈ 0.8 × radius) then sums to an almost perfectly even sward. Uniform discs
// on a near-regular grid left overlap/gap rows that read as stripes at grazing angles.
const SIG = 0.4, TRUNC = 1 - Math.exp(-1 / (2 * SIG * SIG));
const gaussR = (q) => Math.min(1.05, SIG * Math.sqrt(-2 * Math.log(1 - q * TRUNC)));

export function makeGrassPatch(blades, segs, seed = 3, carpet = 0) {
  const rnd = mulberry(seed);
  const vpb = segs * 2 + 1;
  const nv = blades * vpb + carpet * 3;
  const pos = new Float32Array(nv * 3);
  const bl = new Float32Array(nv * 4);
  const sg = new Float32Array(nv * 2);
  const idx = [];
  // random permutation of ranks (uniform thinning order, uncorrelated with radius)
  const perm = (n) => {
    const a = Array.from({ length: n }, (_, i) => (i + 0.5) / n);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  };
  const ranks = perm(blades);
  const put = (i, x, z, ang, r, t, side) => {
    pos[i * 3] = x; pos[i * 3 + 1] = t * 0.6; pos[i * 3 + 2] = z;
    bl[i * 4] = x; bl[i * 4 + 1] = z; bl[i * 4 + 2] = ang; bl[i * 4 + 3] = r;
    sg[i * 2] = t; sg[i * 2 + 1] = side;
  };
  for (let b = 0; b < blades; b++) {
    // blue-noise-ish distribution: sunflower spiral + jitter (disc edge softened so patches blend)
    const rr = gaussR(Math.min(0.999, (b + 0.2 + rnd() * 0.6) / blades));
    const th = b * 2.39996 + (rnd() - 0.5) * 0.9;
    const x = Math.cos(th) * rr, z = Math.sin(th) * rr;
    const ang = rnd() * Math.PI * 2;
    const base = b * vpb;
    for (let k = 0; k < vpb; k++) {
      const seg = k === vpb - 1 ? segs : Math.floor(k / 2);
      // rows packed toward the tip (where the curvature and the taper are)
      const t = Math.pow(seg / segs, 0.85);
      put(base + k, x, z, ang, ranks[b], t, k === vpb - 1 ? 0 : (k % 2 === 0 ? -1 : 1));
    }
    for (let s = 0; s < segs - 1; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const a = base + (segs - 1) * 2;
    idx.push(a, a + 1, base + vpb - 1);
  }
  // turf carpet: short single-triangle blades (rank offset by +2 flags them in the shader). They
  // cover the ground between the tall blades so meadows read as continuous sward, not tufts on soil.
  const cr = perm(carpet);
  const c0 = blades * vpb;
  for (let b = 0; b < carpet; b++) {
    const rr = gaussR(Math.min(0.999, (b + 0.2 + rnd() * 0.6) / carpet));
    const th = b * 2.39996 + 1.3 + (rnd() - 0.5) * 1.2;
    const x = Math.cos(th) * rr, z = Math.sin(th) * rr;
    const ang = rnd() * Math.PI * 2;
    const i = c0 + b * 3;
    put(i, x, z, ang, cr[b] + 2, 0, -1);
    put(i + 1, x, z, ang, cr[b] + 2, 0, 1);
    put(i + 2, x, z, ang, cr[b] + 2, 1, 0);
    idx.push(i, i + 1, i + 2);
  }
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
uniform float uSeasonAmt; uniform vec4 uCuts[8];
varying float vT; varying float vDry; varying float vRand; varying vec2 vFade; varying float vAO; varying vec3 vGW; varying float vCarp;
varying float vHead; varying float vBroad; varying vec3 vSea; varying float vGust;
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
  float carpet = step(1.5, aBlade.w);                    // short single-triangle turf blade
  float r = aBlade.w - 2.0 * carpet;
  float h1 = gHash(r * 91.7 + iData.x * 13.1), h2 = gHash(r * 47.3 + iData.x * 7.7), h3 = gHash(r * 13.9 + iData.x * 3.3);
  float h4 = gHash(r * 29.1 + iData.x * 5.9);
  // season region of this patch (packed with the dryness, see placement.js packSeason):
  // x blossom (petal carpet, fresh green) · y gold (pampas / susuki with seed plumes) · z crimson
  float seaV = floor(iData.w + 1e-4) / 64.0;
  // (membership on the terrain's season ramp: the same interpolation the ground is painted with)
  float sq = clamp(seaV, 0.0, 1.0) * 3.0, si0 = floor(min(sq, 2.999)), sf = smoothstep(0.0, 1.0, sq - si0);
  vec3 sea = uSeasonAmt * vec3(
    (1.0 - sf) * (1.0 - step(0.5, abs(si0 - 1.0))) + sf * (1.0 - step(0.5, si0)),
    (1.0 - sf) * (1.0 - step(0.5, abs(si0 - 2.0))) + sf * (1.0 - step(0.5, abs(si0 - 1.0))),
    sf * (1.0 - step(0.5, abs(si0 - 2.0))));
  vSea = sea;
  vec3 rootL = vec3(aBlade.x, 0.0, aBlade.y) * uPatchR * iPos.w;
  vec3 root = rvQrotG(iRot, rootL);
  vec3 rootW = anchorW + root;
  float d = length(rootW - uCamPos);
  vFade = rvLodFade(d, uFade);
  // distance thinning: keep fraction falls with distance; blades near the threshold shrink smoothly
  float keep = iData.y * uDensity * clamp(pow(uKeep.x / max(d, 1.0), uKeep.y), uKeep.z, 1.0);
  // (turf survives thinning longer than the tall blades: sparse patches read as short sward with
  //  a few tall blades, not as isolated spikes on bare soil)
  float alive = smoothstep(0.0, 0.08, mix(keep, min(1.0, keep * 1.8 + 0.15), carpet) - r) * vFade.x * vFade.y;
  // blade types: seed-head stalks (tall, slender, a spikelet at the top), broad-leaf blades (wide,
  // shorter, arching) and ordinary blades over the turf carpet
  float seedS = step(mix(0.93, 0.6, sea.y), h4) * (1.0 - carpet);
  float broad = step(0.8, h4) * (1.0 - seedS) * (1.0 - carpet) * (1.0 - step(0.5, sea.y));
  // clumping: blade height follows a world-space field (~2 m tussocks inside ~14 m swales), so the
  // sward has tufts and hollows instead of a uniformly trimmed fur
  vec3 plC = rootW - uPlanetCenter;
  float tuft = sin(dot(plC, vec3(2.1, 1.7, -1.9)) + h3 * 0.8) * sin(dot(plC, vec3(-1.3, 2.3, 1.1)));
  float swale = sin(dot(plC, vec3(0.31, -0.27, 0.22)) + sin(dot(plC, vec3(-0.13, 0.17, 0.11)) * 2.0));
  float hv = clamp(1.0 + 0.3 * tuft + 0.2 * swale, 0.55, 1.6);
  // per-blade height spans ~0.5×–1.8× (short turf under tall blades and seed stalks)
  float hb = mix(0.45 + 0.75 * h1 * h1 + 0.3 * h2, 0.34 + 0.34 * h1 * h1, carpet) * mix(1.0, mix(1.55, 1.85, sea.y), seedS) * mix(1.0, 0.72, broad);
  // pampas fields stand tall (1–1.6 m plumes over waist-high leaves); crimson fields a little lower
  hb *= mix(1.0, mix(1.65, 1.0, carpet), sea.y) * mix(1.0, 0.85, sea.z);
  // katana cuts (player:slash): blades inside a recent cut are shorn short, regrowing over ~40 s
  float cutK = 0.0;
  for (int ci = 0; ci < 8; ci++) {
    vec4 cu = uCuts[ci];
    if (cu.w > 0.0) { vec3 cv = rootW - cu.xyz; cv -= upP * dot(cv, upP); cutK = max(cutK, 1.0 - smoothstep(cu.w * 0.8, cu.w, length(cv))); }
  }
  hb *= mix(1.0, mix(0.16, 0.6, carpet), cutK);
  seedS *= 1.0 - step(0.5, cutK);
  // blades right at the camera shrink away (low TP / FP angles: single blades must not fill the frame)
  // (tall pampas clears a wider space around the lens: the camera rides at head height)
  float nearCam = smoothstep(0.55, 1.5 + 1.6 * sea.y, length(rootW + up * 0.3 - uCamPos));
  float H = uHeight * iData.z * hb * mix(hv, 1.0, 0.4 * carpet) * alive * nearCam;
  float W = uWidth * mix(0.55 + 0.9 * h2, 1.25 + 0.8 * h2, carpet) * mix(1.0, 2.3, broad) * mix(1.0, 0.55, seedS) * mix(1.0, 0.72, sea.y * (1.0 - carpet)) * (1.0 + d * uWidenK) * iPos.w;
  float ang = aBlade.z;
  vec3 fl = rvQrotG(iRot, vec3(cos(ang), 0.0, sin(ang)));       // blade facing (normal)
  // per-blade twist along the length: the width vector rotates toward the tip
  float tw = ang + (h3 - 0.5) * 1.6 * t;
  vec3 sl = rvQrotG(iRot, vec3(-sin(tw), 0.0, cos(tw)));        // across the blade
  // static curvature (blades arc outward from the patch center + random lean)
  vec3 outward = length(rootL) > 1e-3 ? normalize(root) : fl;
  // coherent 'combed' lean over the field (flow field in world space) + slight tuft arc + noise
  vec3 plR = rootW - uPlanetCenter;
  float fa = sin(dot(plR, vec3(0.043, 0.037, 0.051))) * 2.2 + sin(dot(plR, vec3(-0.011, 0.017, 0.013))) * 3.0;
  vec3 e1 = normalize(cross(upP, abs(upP.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(upP, e1);
  vec3 flow = e1 * cos(fa) + e2 * sin(fa);
  // droop: long blades arc over more (grass-like), short ones stay upright
  float droop = 0.25 + 0.55 * h2 * h2 + 0.3 * h1 + 0.25 * seedS + 0.45 * broad + 0.35 * sea.y * (1.0 - carpet);
  vec3 D = (flow * 0.3 + outward * 0.18 + fl * (h3 - 0.5) * 0.5) * H * droop;
  // turf blades splay in all directions (a matted sward), barely combed by the flow field
  D = mix(D, (flow * 0.22 + fl * (h3 - 0.5) * 0.9 + outward * 0.22) * H, carpet);
  // wind: travelling gusts (coherent over the field) + per-blade flutter
  vec3 wd = uWindDir - upP * dot(uWindDir, upP);
  wd = length(wd) > 1e-3 ? normalize(wd) : sl;
  vec3 wsd = cross(upP, wd);
  vec3 pl = rootW - uPlanetCenter;
  float along = dot(pl, wd), across = dot(pl, wsd);
  float g1 = sin(along * 0.18 - uTime * 2.3 + sin(across * 0.07 + uTime * 0.3) * 2.0);
  float g2 = sin(along * 0.047 - uTime * 0.9 + across * 0.021);
  float gust = clamp(0.5 + 0.35 * g1 + 0.3 * g2, 0.0, 1.2);
  // the long travelling wave (same field as the terrain's far-field sheen): gust fronts that lay the
  // whole field over and show the blades' pale sides, sweeping across the meadow as visible bands
  float g3 = sin(along * 0.0125 - uTime * 0.42 + sin(across * 0.0061) * 2.4);
  float gw = smoothstep(0.35, 1.0, 0.5 + 0.3 * g2 + 0.45 * g3 + 0.18 * g1);
  vGust = gw;
  float ws = uWindStrength;
  float flut = sin(uTime * (3.5 + h1 * 2.5) + h2 * 30.0 + along * 0.9);
  D += wd * H * (ws * (0.25 + 0.95 * gust + 0.7 * gw) + 0.06 * flut * (0.3 + ws) + 0.1 * gw) / uStiff * (1.0 - 0.6 * carpet) * (1.0 + 0.35 * sea.y);
  D += wsd * H * 0.08 * sin(uTime * 1.7 + h3 * 20.0 + across * 0.5) * (0.2 + ws);
  // interactive push away from the player (and flattening under their feet)
  // (a soft, wide falloff and a moderate bend: flattening blades to the ground showed their dark
  // roots as a black "stamp" under the player)
  vec3 pv = rootW - uPush.xyz;
  pv -= upP * dot(pv, upP);
  float pd = length(pv);
  float pf = 1.0 - smoothstep(uPush.w * 0.1, uPush.w * 1.25, pd);
  pf *= pf * (3.0 - 2.0 * pf);
  if (pf > 0.0) D += (pd > 1e-3 ? pv / pd : fl) * pf * H * 0.85;
  // keep blade length roughly constant under bending
  float dl = length(D) / max(H, 1e-3);
  float vy = sqrt(max(0.04, 1.0 - min(dl * dl * 0.6, 0.96)));
  // quadratic Bezier centreline: P0 = root, P1 = stiff mid (mostly vertical), P2 = bent tip
  vec3 P2 = up * H * vy + D;
  vec3 P1 = up * H * vy * (0.55 + 0.2 * h4) + D * (0.12 + 0.18 * h1);
  float it = 1.0 - t;
  vec3 p = root + 2.0 * it * t * P1 + t * t * P2;
  // per-blade taper profile (slender spikes ... broad blades with a quick pointed tip)
  float te = mix(1.2, 3.2, h2);
  float prof = (1.0 - pow(t, te)) * (0.7 + 0.3 * smoothstep(0.0, 0.18, t));
  // seed head: a spindle-shaped spikelet on the top fifth of the stalk
  float head = seedS * smoothstep(0.68, 0.8, t) * (1.0 - smoothstep(0.94, 1.0, t));
  prof = mix(prof, 3.2 * (0.6 + 0.4 * sin(clamp((t - 0.68) / 0.32, 0.0, 1.0) * 3.14159)), head);
  // pampas plume: a long feathery spray on the top 40 % of the stalk, widest in the middle
  float plume = seedS * sea.y * smoothstep(0.52, 0.62, t);
  prof = mix(prof, 5.2 * (0.35 + 0.65 * sin(clamp((t - 0.55) / 0.45, 0.0, 1.0) * 3.14159)), plume);
  float wTaper = aSeg.y * W * 0.5 * prof * (0.25 + 0.75 * alive);
  p += sl * wTaper;
  rvGrassPos = iPos.xyz + p;
  // normal: from the Bezier tangent, rounded across the blade, blended with up
  vec3 tangent = normalize(2.0 * it * P1 + 2.0 * t * (P2 - P1) + 1e-4 * up);
  vec3 bn = normalize(cross(sl, tangent));
  if (dot(bn, uCamPos - rootW) < 0.0) bn = -bn;
  bn = normalize(bn + sl * aSeg.y * 0.5);
  rvGrassN = normalize(mix(bn, upP, 0.5 + 0.3 * carpet));
  // turf reads as the lower part of the sward (base colour, root AO)
  t *= 1.0 - 0.3 * carpet;
  vT = t; vDry = clamp(fract(iData.w + 1e-4) / 0.98, 0.0, 1.0); vRand = h1; vAO = mix(mix(0.58, 1.0, smoothstep(0.0, 0.7, t)), 1.0, 0.45 * pf); vCarp = carpet;
  vHead = seedS * mix(smoothstep(0.66, 0.74, t), smoothstep(0.5, 0.6, t), sea.y); vBroad = broad;
  vGW = rootW;
  if (H < 1e-3) rvGrassPos = iPos.xyz;
}
`;

const GRASS_FRAG_PARS = /* glsl */`
#include <rv_flora>
uniform vec3 uBase; uniform vec3 uTip; uniform vec3 uDryC; uniform vec3 uGlowTip; uniform float uGlowAmt; uniform float uNight; uniform float uTime;
uniform float uTransl; uniform vec3 uPlanetCenter;
varying float vT; varying float vDry; varying float vRand; varying vec2 vFade; varying float vAO; varying vec3 vGW; varying float vCarp;
varying float vHead; varying float vBroad; varying vec3 vSea; varying float vGust;
uniform vec3 uHeadC; uniform float uHueVar; uniform vec3 uGlowTip2; uniform float uWet; uniform float uSnowG;
float rvTransl = 0.0; float rvWrap = 0.0;
vec3 rvGlow = vec3(0.0);
float gH3(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float gVN(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gH3(i), gH3(i + vec3(1,0,0)), f.x), mix(gH3(i + vec3(0,1,0)), gH3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(gH3(i + vec3(0,0,1)), gH3(i + vec3(1,0,1)), f.x), mix(gH3(i + vec3(0,1,1)), gH3(i + vec3(1,1,1)), f.x), f.y), f.z); }
`;

const GRASS_MAP = /* glsl */`
{
  // field-scale colour: rotated domain (no axis-aligned lattice beating against the placement
  // cells), wavelengths ~90 m / ~25 m / ~7 m → BotW-like swathes of greener and drier grass
  vec3 wp = mat3(0.80, 0.36, -0.48, -0.60, 0.48, -0.64, 0.0, 0.80, 0.60) * (vGW - uPlanetCenter);
  float m1 = gVN(wp * 0.011), m2 = gVN(wp * 0.04 + 7.1), m3 = gVN(wp * 0.14 + 3.3);
  float macro = m1 * 0.5 + m2 * 0.32 + m3 * 0.18;
  float t = vT;
  // root → sunlit tip gradient (BotW meadows: dark sappy base, bright yellow-green tips)
  vec3 base = mix(uBase, uTip, 0.42) * (0.8 + 0.4 * m2);
  vec3 tip = uTip * (0.86 + 0.3 * vRand) * (0.86 + 0.34 * macro);
  vec3 c = mix(base, tip, pow(t, 0.7));
  // hue field, two octaves (~25 m swathes and ~2.5 m patches): warm yellow-green ↔ cool blue-green
  float hn = m2 * 0.6 + gVN(wp * 0.4 + 1.7) * 0.4;
  c *= mix(vec3(0.86, 0.99, 1.08), vec3(1.15, 1.06, 0.66), smoothstep(0.12, 0.72, hn) * uHueVar + 0.5 * (1.0 - uHueVar));
  // broad-leaf blades are a deeper, bluer green; seed heads are pale straw / rusty
  c *= mix(vec3(1.0), vec3(0.78, 0.92, 0.96), vBroad);
  // dry swathes: per-patch dryness (moisture) pushed around by the large-scale field
  float dry = clamp(vDry * (0.55 + 0.7 * vRand) + (m1 - 0.5) * 1.1 + (m3 - 0.5) * 0.25, 0.0, 1.0);
  c = mix(c, uDryC * (0.8 + 0.4 * vRand) * mix(0.7, 1.12, t), smoothstep(0.15, 0.85, dry) * smoothstep(0.0, 0.5, t + 0.25));
  // lush dark-green swales where the field is wet
  c = mix(c, c * vec3(0.72, 0.86, 0.7), smoothstep(0.62, 0.9, 1.0 - m1) * 0.5 * (1.0 - dry));
  // hue jitter per blade
  c *= vec3(1.0 + (vRand - 0.5) * 0.24, 1.0 + (vRand - 0.5) * 0.06, 1.0 - (vRand - 0.5) * 0.3);
  // pale sunlit tips
  c = mix(c, c * vec3(1.2, 1.14, 0.84) + 0.02, smoothstep(0.7, 1.0, t) * 0.55);
  // ---- season regions (Ghost of Yotei): whole fields become one saturated hue
  if (vSea.x + vSea.y + vSea.z > 0.01) {
    // gold pampas: straw-gold leaves, green only at the root
    vec3 gold = mix(vec3(0.26, 0.16, 0.035), mix(vec3(0.74, 0.5, 0.12), vec3(0.66, 0.36, 0.08), smoothstep(0.5, 0.8, m2 + vRand * 0.25)), smoothstep(0.05, 0.85, t)) * (0.86 + 0.3 * vRand) * (0.9 + 0.22 * macro);
    gold = mix(gold, c * vec3(1.1, 0.95, 0.5), 0.25 * (1.0 - t));
    // crimson: russet autumn sward with rust-red tips
    vec3 rus = mix(vec3(0.2, 0.13, 0.04), mix(vec3(0.56, 0.31, 0.08), vec3(0.52, 0.16, 0.05), smoothstep(0.45, 0.75, m2 + vRand * 0.3)), smoothstep(0.05, 0.9, t)) * (0.88 + 0.26 * vRand) * (0.9 + 0.2 * macro);
    // blossom: fresh spring green over a carpet of fallen petals
    vec3 frs = c * vec3(1.06, 1.12, 0.8);
    float petals = vCarp * smoothstep(0.4, 0.62, m3 * 0.55 + m2 * 0.3 + vRand * 0.35);
    frs = mix(frs, mix(vec3(0.72, 0.38, 0.46), vec3(0.8, 0.7, 0.7), step(0.7, vRand)), petals);
    c = mix(c, gold, vSea.y);
    c = mix(c, rus, vSea.z);
    c = mix(c, frs, vSea.x);
  }
  vec3 headC = mix(uHeadC, vec3(0.95, 0.78, 0.5) * (0.92 + 0.16 * m3), vSea.y);
  c = mix(c, headC * (0.75 + 0.5 * vRand) * (0.85 + 0.3 * m3), vHead);
  // wind sheen: the gust front lays the blades over and shows their pale, silvery sides
  {
    // (season fields keep their hue in the sheen: gold glints gold, not grey)
    vec3 silver = mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))), 0.3 * (1.0 - 0.8 * (vSea.y + vSea.z))) * 1.3 + 0.012;
    c = mix(c * mix(1.0, 0.86, 1.0 - vGust), silver, vGust * 0.42 * smoothstep(0.2, 0.8, t));
  }
  // weather: rain darkens the sward; snow settles on the upper blades (deep snow buries the turf)
  c *= 1.0 - 0.3 * uWet;
  c = mix(c, vec3(0.86, 0.89, 0.93), uSnowG * clamp(smoothstep(0.25, 0.9, t) * 0.85 + vCarp * 0.6, 0.0, 1.0));
  #ifdef RV_SEASON_DBG
  c = vec3(vSea.z, vSea.y, vSea.x) + 0.02;
  #endif
  diffuseColor.rgb *= c;
  rvTransl = uTransl * (0.45 + 0.55 * t) * (1.0 + 0.9 * vHead * vSea.y);
  rvWrap = 0.6;
  if (uGlowAmt > 0.0) {
    // only some blades carry glowing tips; they breathe slowly in patches
    // some blades carry glowing tips, the tallest few glow along their whole upper blade (curved
    // strokes of light, Pacific Drive style); they breathe slowly in patches
    float sel = smoothstep(0.62, 0.8, vRand);
    float streak = smoothstep(0.86, 0.93, vRand) * smoothstep(0.35, 0.65, macro);
    float pulse = 0.55 + 0.45 * sin(uTime * 0.9 + macro * 12.0 + vRand * 6.0);
    float gl = pow(t, 4.0) * sel + streak * 0.55 * smoothstep(0.2, 1.0, t) * (0.6 + 0.4 * t);
    // glow varies in hue (two palette colours, drifting in patches) and in strength per blade
    float hsel = smoothstep(0.35, 0.75, gVN(wp * 0.09 + 5.3) * 0.7 + fract(vRand * 7.31) * 0.3);
    vec3 gc = mix(uGlowTip, uGlowTip2, hsel);
    float str = 0.3 + 0.7 * fract(vRand * 13.7 + macro);
    // (fades right at the lens: glowing tips in front of a low camera bloomed into big discs)
    rvGlow = gc * uGlowAmt * gl * str * (0.02 + uNight) * pulse * (1.0 - vCarp) * smoothstep(1.0, 3.0, length(vViewPosition));
    diffuseColor.rgb = mix(diffuseColor.rgb, gc * 0.25, streak * 0.6 * (1.0 - vCarp));
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

let GRASS_DBG = false;
try { GRASS_DBG = (new URL(globalThis.location?.href || 'http://x/').searchParams.get('floradbg') || '').includes('season'); } catch (_) { /* no window */ }

export function makeGrassMaterial(p) {
  const u = {
    uFade: { value: new THREE.Vector4(...(p.fade ?? [0, 0, 40, 50])) },
    uKeep: { value: new THREE.Vector4(...(p.keep ?? [12, 0.8, 0.12, 1])) },
    uPatchR: { value: p.patchR ?? 0.7 }, uHeight: { value: p.height ?? 0.55 }, uWidth: { value: p.width ?? 0.05 },
    uDensity: { value: p.density ?? 1 }, uWidenK: { value: p.widenK ?? 0.02 }, uStiff: { value: p.stiff ?? 1 },
    uPush: p.push, // shared {value: Vector4(scene xyz, radius)}
    uBase: { value: new THREE.Color().fromArray(p.base) }, uTip: { value: new THREE.Color().fromArray(p.tip) },
    uDryC: { value: new THREE.Color().fromArray(p.dry) }, uGlowTip: { value: new THREE.Color().fromArray(p.glowTip ?? [0, 0, 0]) }, uGlowTip2: { value: new THREE.Color().fromArray(p.glowTip2 ?? p.glowTip ?? [0, 0, 0]) },
    uGlowAmt: { value: p.glowTip ? (p.glowAmt ?? 2) : 0 }, uTransl: { value: p.transl ?? 0.9 },
    uHeadC: { value: new THREE.Color().fromArray(p.head ?? [0.55, 0.45, 0.22]) }, uHueVar: { value: p.hueVar ?? 1 },
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0, side: THREE.DoubleSide });
  mat.name = 'flora-grass';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = G.uTime; shader.uniforms.uWindDir = G.uWindDir; shader.uniforms.uWindStrength = G.uWindStrength;
    shader.uniforms.uCamPos = G.uCameraPos; shader.uniforms.uPlanetCenter = G.uPlanetCenter; shader.uniforms.uNight = G.uNight;
    shader.uniforms.uDitherF = FLORA_DITHER.frame; shader.uniforms.uDitherA = FLORA_DITHER.amt;
    shader.uniforms.uWet = G.uWetness; shader.uniforms.uSnowG = G.uSnow;
    shader.uniforms.uSeasonAmt = FLORA_SEASON; shader.uniforms.uCuts = FLORA_CUTS;
    for (const k in u) shader.uniforms[k] = u[k];
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + GRASS_VERT_PARS);
    vs = vs.replace('#include <beginnormal_vertex>', GRASS_CORE + '\nvec3 objectNormal = rvGrassN;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(1.0,0.0,0.0);\n#endif');
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = rvGrassPos;');
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', (GRASS_DBG ? '#define RV_SEASON_DBG\n' : '') + '#include <common>\n' + GRASS_FRAG_PARS);
    fs = fs.replace('#include <map_fragment>', GRASS_MAP);
    fs = fs.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal *= faceDirection;');
    fs = fs.replace('#include <lights_physical_pars_fragment>', GRASS_LIGHT_PARS);
    fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(roughnessFactor, 0.82, (vSea.y + vSea.z) * 0.8), 0.28, uWet * 0.7);');
    fs = fs.replace('#include <aomap_fragment>', '{ reflectedLight.indirectDiffuse *= vAO; reflectedLight.indirectSpecular *= vAO * 0.6; reflectedLight.directDiffuse *= mix(1.0, vAO, 0.5); reflectedLight.directSpecular *= vAO * 0.5; }\n#include <aomap_fragment>');
    fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rvGlow;');
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'rv-flora-grass-v4' + (GRASS_DBG ? 'd' : '');
  return { material: mat, uniforms: u };
}

/**
 * Sward shade: a soft multiplicative "decal" disc under every near grass patch. Real meadows are
 * dark between the stems (self-shadowing + occlusion in the sward); the terrain shader can't know
 * where the flora track grew grass, so without this the lit ground shows between blades and dense
 * grass reads as tufts on a lawn. Each disc multiplies the already-lit ground by shade^(w·k) with a
 * Gaussian weight w — overlapping discs on the jittered patch grid sum to a nearly uniform
 * darkening with gentle natural mottling, fading with patch density and distance.
 */
export function makeSwardDecal(segs = 12) {
  const pos = [0, 0, 0];
  for (let k = 0; k < segs; k++) { const a = (k / segs) * Math.PI * 2; pos.push(Math.cos(a), 0, Math.sin(a)); }
  const idx = [];
  for (let k = 0; k < segs; k++) idx.push(0, 1 + ((k + 1) % segs), 1 + k);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-2, -0.5, -2), new THREE.Vector3(2, 0.5, 2));
  return g;
}

export function makeSwardMaterial(p) {
  const u = {
    uFade: { value: new THREE.Vector4(...(p.fade ?? [0, 0, 16, 24])) },
    uPatchR: { value: p.patchR ?? 0.8 }, uSize: { value: p.size ?? 1.5 },
    uShade: { value: new THREE.Color().fromArray(p.shade ?? [0.5, 0.58, 0.42]) }, uStr: { value: p.strength ?? 0.6 },
    uCamPos: G.uCameraPos,
  };
  const mat = new THREE.ShaderMaterial({
    name: 'flora-sward',
    uniforms: u,
    vertexShader: /* glsl */`
#include <rv_flora>
attribute vec4 iPos; attribute vec4 iRot; attribute vec4 iData;
uniform vec4 uFade; uniform float uPatchR; uniform float uSize; uniform vec3 uCamPos;
varying vec2 vL; varying float vK;
void main(){
  vec3 lp = vec3(position.x, 0.0, position.z) * uPatchR * uSize * iPos.w;
  vec3 up = rvQrot(iRot, vec3(0.0, 1.0, 0.0));
  vec3 p = iPos.xyz + rvQrot(iRot, lp) + up * 0.08;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  float d = length(wp.xyz - uCamPos);
  vK = iData.y * rvLodFade(d, uFade).y;
  vec4 mv = viewMatrix * wp;
  // pulled toward the camera: the rendered terrain (CDLOD, octaves finer than its vertex spacing
  // removed, geomorphed) deviates from the analytic surface the patches root on by 10–20 cm, so a
  // disc sitting on the analytic ground vanishes in bands. The pull lifts it ~20 cm vertically
  // (pull = gap / sin(elevation), capped at grazing angles where blades hide the ground anyway).
  float vl = length(mv.xyz);
  float sinT = abs(dot((wp.xyz - uCamPos) / max(d, 1e-3), up));
  float pull = min(0.2 / max(sinT, 0.05), 1.2) + 0.004 * vl;
  mv.xyz *= max(0.1, 1.0 - pull / max(vl, 1e-3));
  gl_Position = projectionMatrix * mv;
  vL = position.xz;
  if (vK < 0.01) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`,
    fragmentShader: /* glsl */`
uniform vec3 uShade; uniform float uStr;
varying vec2 vL; varying float vK;
void main(){
  float r2 = dot(vL, vL);
  float w = max(0.0, (exp(-2.4 * r2) - 0.0907) / 0.9093);
  gl_FragColor = vec4(pow(uShade, vec3(w * vK * uStr)), 1.0);
}`,
    transparent: true, depthWrite: false, depthTest: true, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  return { material: mat, uniforms: u };
}
