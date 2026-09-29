// Tree impostors: every canopy model is rendered once at startup (side + top view) into an atlas
// (albedo·AO + coverage, and normal + glow). Far trees are single camera-facing quads that sample
// the atlas, are lit by the same PBR/translucent foliage model as the meshes (so forests from
// altitude match the near trees), cast sun shadows, and crossfade (dithered) with the mesh LODs.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { PLANT_LIGHT_PARS, linkCommon } from './materials.js';

export const MAX_IMP = 32;

const BAKE_VS = /* glsl */`
attribute vec4 aInfo; attribute vec3 aShade; attribute vec3 aColor; attribute vec3 aCorner;
varying vec2 vUv; varying vec4 vInfo; varying vec3 vCol; varying vec3 vN; varying vec3 vObj;
uniform float uModelSpaceN;
void main(){
  vec3 p = position;
  if (aCorner.z > 0.5) {
    vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    p += camR * aCorner.x + camU * aCorner.y;
  }
  float kind = floor(aInfo.x / 16.0 + 0.001);
  vec3 n = (kind > 0.5 && kind < 2.5) ? aShade : normalize(mix(normal, aShade, 0.3));
  vN = uModelSpaceN > 0.5 ? n : normalize((viewMatrix * vec4(n, 0.0)).xyz);
  vUv = uv; vInfo = aInfo; vCol = aColor; vObj = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const BAKE_FS = /* glsl */`
uniform sampler2D uAtlas; uniform vec3 uTint2; uniform float uMode; uniform float uGlow; uniform float uCardGlow;
varying vec2 vUv; varying vec4 vInfo; varying vec3 vCol; varying vec3 vN; varying vec3 vObj;
void main(){
  float kind = floor(vInfo.x / 16.0 + 0.001);
  vec3 col = vCol;
  float glow = 0.0;
  if (kind < 0.5) col = vCol * 0.72;
  else if (kind < 2.5) {
    vec4 tx = texture2D(uAtlas, vUv);
    if (tx.a < 0.5) discard;
    col = mix(vCol, uTint2, tx.g) * (0.38 + tx.r * 0.95);
    if (kind > 1.5) glow = uCardGlow;
  } else if (kind > 3.5) glow = uGlow;
  float ao = vInfo.z;
  if (uMode < 0.5) gl_FragColor = vec4(col * mix(0.35, 1.0, ao), 1.0);
  else gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, clamp(glow * 0.25, 0.0, 1.0));
}`;

/**
 * Bake impostors for canopy models.
 * models: [{ geo, tint2:[r,g,b], glow, cardGlow, avg:[r,g,b] }]  →  { albedo, normal, dims: Float32Array(MAX_IMP*4), cols, rows }
 */
export function bakeImpostors(renderer, atlasTex, models, cellPx = 256) {
  const n = Math.min(MAX_IMP, models.length);
  const cols = 8, rows = Math.max(1, Math.ceil((n * 2) / cols));
  const W = cols * cellPx, H = rows * cellPx;
  const mk = () => {
    const rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, type: THREE.UnsignedByteType });
    rt.texture.colorSpace = THREE.NoColorSpace;
    return rt;
  };
  const rtA = mk(), rtN = mk();
  const bake = new THREE.ShaderMaterial({
    vertexShader: BAKE_VS, fragmentShader: BAKE_FS, side: THREE.DoubleSide, toneMapped: false,
    uniforms: { uAtlas: { value: atlasTex }, uTint2: { value: new THREE.Color() }, uMode: { value: 0 }, uGlow: { value: 0 }, uCardGlow: { value: 0 }, uModelSpaceN: { value: 0 } },
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(undefined, bake);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  const dims = new Float32Array(MAX_IMP * 4);

  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  const prevShadow = renderer.shadowMap.enabled;
  const prevXR = renderer.xr?.enabled;
  renderer.autoClear = false;
  renderer.shadowMap.enabled = false;
  if (renderer.xr) renderer.xr.enabled = false;
  try {
    for (const [pass, rt] of [[0, rtA], [1, rtN]]) {
      rt.viewport.set(0, 0, W, H); rt.scissor.set(0, 0, W, H); rt.scissorTest = false;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(pass === 0 ? new THREE.Color(0.08, 0.1, 0.05) : new THREE.Color(0.5, 0.5, 1.0), 0);
      renderer.clear(true, true, true);
      for (let m = 0; m < n; m++) {
        const M = models[m];
        const g = M.geo;
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox;
        const mc = g.userData.maxCard || 0;
        const y0 = Math.max(bb.min.y + mc, -0.5), y1 = bb.max.y;
        const hw = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x), Math.abs(bb.min.z), Math.abs(bb.max.z));
        const side = Math.max((y1 - y0) * 0.5, hw) * 1.02;
        const yc = (y0 + y1) * 0.5;
        dims[m * 4] = side; dims[m * 4 + 1] = yc; dims[m * 4 + 2] = hw * 1.02; dims[m * 4 + 3] = M.glowLevel ?? 0;
        mesh.geometry = g;
        bake.uniforms.uTint2.value.fromArray(M.tint2 || [0.1, 0.08, 0.05]);
        bake.uniforms.uMode.value = pass;
        bake.uniforms.uGlow.value = M.glow || 0;
        bake.uniforms.uCardGlow.value = M.cardGlow || 0;
        if (pass === 0 && M.avg) {
          // fill the cell with the model's mean color (alpha 0) so mips don't bleed dark fringes
          renderer.setClearColor(new THREE.Color().fromArray(M.avg), 0);
        }
        for (let v = 0; v < 2; v++) {
          const ci = m * 2 + v;
          const cx = (ci % cols) * cellPx, cy = Math.floor(ci / cols) * cellPx;
          rt.viewport.set(cx, cy, cellPx, cellPx); rt.scissor.set(cx, cy, cellPx, cellPx); rt.scissorTest = true;
          renderer.setRenderTarget(rt);
          if (pass === 0 && M.avg) renderer.clear(true, true, false);
          else renderer.clear(false, true, false);
          if (v === 0) {
            const s = side;
            cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
            cam.position.set(0, yc, 200); cam.up.set(0, 1, 0); cam.lookAt(0, yc, 0);
            bake.uniforms.uModelSpaceN.value = 0;
          } else {
            const s = hw * 1.02;
            cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
            cam.position.set(0, 300, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0);
            bake.uniforms.uModelSpaceN.value = 1;
          }
          cam.near = 1; cam.far = 600;
          cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
          renderer.render(scene, cam);
        }
      }
    }
  } finally {
    for (const rt of [rtA, rtN]) { rt.viewport.set(0, 0, W, H); rt.scissor.set(0, 0, W, H); rt.scissorTest = false; }
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    renderer.shadowMap.enabled = prevShadow;
    if (renderer.xr && prevXR !== undefined) renderer.xr.enabled = prevXR;
    bake.dispose();
  }
  return { albedo: rtA, normal: rtN, dims, cols, rows, count: n };
}

/** unit quad: corners x∈[-1,1], y∈[-1,1] */
export function makeImpostorQuad() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
  g.setIndex([0, 1, 3, 0, 3, 2]);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  return g;
}

const IMP_VERT_PARS = /* glsl */`
#include <rv_flora>
attribute vec4 iPos; attribute vec4 iRot; attribute vec4 iData;
uniform vec3 uCamPos; uniform vec3 uPlanetCenter; uniform vec4 uFade; uniform vec4 uDFade; uniform vec4 uThin; uniform vec4 uDims[${MAX_IMP}];
uniform vec2 uGrid; uniform float uScaleMul;
varying vec2 vUvS; varying vec2 vUvT; varying float vTopW; varying vec2 vFade; varying vec3 vR; varying vec3 vU; varying vec3 vV;
varying vec3 vMX; varying vec3 vMY; varying vec3 vMZ; varying float vTint; varying float vGlowLvl; varying float vSeedI;
vec3 rvQrotI(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec3 rvImpPos; vec3 rvImpN;
`;
const IMP_CORE = /* glsl */`
{
  int mi = int(iData.w + 0.5);
  vec4 dm = uDims[mi];
  vec3 baseW = (modelMatrix * vec4(iPos.xyz, 1.0)).xyz;
  float d = length(baseW - uCamPos);
  #ifdef DEPTH_PASS
    vFade = rvLodFade(d, uDFade);
  #else
    vFade = rvLodFade(d, uFade);
  #endif
  float sc = iPos.w * uScaleMul * rvThin(d, iData.y, uThin);
  vec3 up = rvQrotI(iRot, vec3(0.0, 1.0, 0.0));
  vec3 cW = baseW + up * dm.y * sc;
  vec3 v = normalize(uCamPos - cW);
  #ifdef DEPTH_PASS
    v = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) * -1.0;
  #endif
  float elev = dot(v, up);
  vec3 r = cross(up, v);
  r = length(r) > 1e-4 ? normalize(r) : rvQrotI(iRot, vec3(1.0, 0.0, 0.0));
  vec3 u = normalize(cross(v, r));
  vTopW = smoothstep(0.62, 0.9, elev);
  float s = mix(dm.x, dm.z, vTopW) * sc;
  vec3 off = (r * position.x + u * position.y) * s;
  // keep the quad from sinking into the terrain when seen from the side: pivot around the center
  rvImpPos = iPos.xyz + up * dm.y * sc + off;
  // side-view uv
  float ci0 = float(mi * 2), ci1 = ci0 + 1.0;
  vec2 cell0 = vec2(mod(ci0, uGrid.x), floor(ci0 / uGrid.x));
  vec2 cell1 = vec2(mod(ci1, uGrid.x), floor(ci1 / uGrid.x));
  vec2 lu = position.xy * 0.5 + 0.5;
  vUvS = (cell0 + lu * (dm.x > 0.0 ? 1.0 : 0.0)) / uGrid;
  // top-view uv: project the quad point onto the model's ground plane
  vec3 mX = rvQrotI(iRot, vec3(1.0, 0.0, 0.0)), mZ = rvQrotI(iRot, vec3(0.0, 0.0, 1.0));
  vec2 tp = vec2(dot(off, mX), -dot(off, mZ)) / max(dm.z * sc, 1e-3);
  vUvT = (cell1 + clamp(tp * 0.5 + 0.5, 0.0, 1.0)) / uGrid;
  vR = r; vU = u; vV = v; vMX = mX; vMY = up; vMZ = mZ;
  vTint = iData.z; vGlowLvl = dm.w; vSeedI = iData.x;
  rvImpN = v;
  if (vFade.x * vFade.y <= 0.001 || sc <= 1e-4) rvImpPos = iPos.xyz;
}
`;

const IMP_FRAG_PARS = /* glsl */`
#include <rv_flora>
uniform sampler2D uImpA; uniform sampler2D uImpN; uniform vec2 uAtlasPx; uniform float uNight; uniform float uTime; uniform float uTransl; uniform float uGlowStr; uniform float uTintVar;
varying vec2 vUvS; varying vec2 vUvT; varying float vTopW; varying vec2 vFade; varying vec3 vR; varying vec3 vU; varying vec3 vV;
varying vec3 vMX; varying vec3 vMY; varying vec3 vMZ; varying float vTint; varying float vGlowLvl; varying float vSeedI;
float rvTransl = 0.0; float rvWrap = 0.0; vec3 rvGlow = vec3(0.0); vec3 rvImpNW = vec3(0.0, 1.0, 0.0);
float rvImpAlpha(sampler2D t, vec2 uv){
  vec2 px = uv * uAtlasPx; vec2 dx = dFdx(px), dy = dFdy(px);
  float mip = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
  return texture2D(t, uv).a * (1.0 + mip * 0.3);
}
`;
const IMP_MAP = /* glsl */`
{
  float dth = rvDither(gl_FragCoord.xy);
  if (vFade.y < 0.999 && dth >= vFade.y) discard;
  if (vFade.x < 0.999 && (1.0 - dth) >= vFade.x) discard;
  bool top = fract(dth * 7.31 + 0.37) < vTopW;
  vec2 uv = top ? vUvT : vUvS;
  float a = rvImpAlpha(uImpA, uv);
  if (a < 0.5) discard;
  vec4 A = texture2D(uImpA, uv);
  vec4 N = texture2D(uImpN, uv);
  vec3 n = N.xyz * 2.0 - 1.0;
  rvImpNW = top ? normalize(vMX * n.x + vMY * n.y + vMZ * n.z) : normalize(vR * n.x + vU * n.y + vV * n.z);
  float tv = (vTint - 0.5) * uTintVar;
  vec3 alb = A.rgb * vec3(1.0 + tv * 0.6, 1.0 + tv * 0.25, 1.0 - tv * 0.35);
  diffuseColor.rgb *= alb;
  rvTransl = uTransl * 0.8;
  rvWrap = 0.5;
  if (N.a > 0.0) rvGlow = alb * N.a * 4.0 * uGlowStr * vGlowLvl * (0.08 + 0.92 * uNight);
}
`;

export function makeImpostorMaterials(bk, p = {}) {
  const u = {
    uImpA: { value: bk.albedo.texture }, uImpN: { value: bk.normal.texture },
    uAtlasPx: { value: new THREE.Vector2(bk.albedo.width, bk.albedo.height) },
    uDims: { value: Array.from({ length: MAX_IMP }, (_, i) => new THREE.Vector4(bk.dims[i * 4], bk.dims[i * 4 + 1], bk.dims[i * 4 + 2], bk.dims[i * 4 + 3])) },
    uGrid: { value: new THREE.Vector2(bk.cols, bk.rows) },
    uFade: { value: new THREE.Vector4(...(p.fade ?? [0, 0, 1e9, 1e9])) }, uDFade: { value: new THREE.Vector4(...(p.dfade ?? p.fade ?? [0, 0, 1e9, 1e9])) }, uThin: { value: new THREE.Vector4(...(p.thin ?? [0, 1, 0, 0])) },
    uScaleMul: { value: p.scaleMul ?? 1 }, uTransl: { value: p.transl ?? 0.8 }, uGlowStr: { value: p.glow ?? 1 }, uTintVar: { value: p.tintVar ?? 0.35 },
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0, side: THREE.DoubleSide });
  mat.name = 'flora-impostor';
  mat.onBeforeCompile = (shader) => {
    linkCommon(shader, u);
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + IMP_VERT_PARS);
    vs = vs.replace('#include <beginnormal_vertex>', IMP_CORE + '\nvec3 objectNormal = rvImpN;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(1.0,0.0,0.0);\n#endif');
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = rvImpPos;');
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\n' + IMP_FRAG_PARS);
    fs = fs.replace('#include <map_fragment>', IMP_MAP);
    fs = fs.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize((viewMatrix * vec4(rvImpNW, 0.0)).xyz);');
    fs = fs.replace('#include <lights_physical_pars_fragment>', PLANT_LIGHT_PARS);
    fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rvGlow;');
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'rv-flora-imp-v1';

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  depth.onBeforeCompile = (shader) => {
    linkCommon(shader, u);
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', '#define DEPTH_PASS\n#include <common>\n' + IMP_VERT_PARS);
    vs = vs.replace('#include <begin_vertex>', IMP_CORE + '\nvec3 transformed = rvImpPos;');
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\n' + /* glsl */`
#include <rv_flora>
uniform sampler2D uImpA; uniform vec2 uAtlasPx;
varying vec2 vUvS; varying vec2 vFade;
`);
    fs = fs.replace('#include <alphatest_fragment>', /* glsl */`
{
  vec2 px = vUvS * uAtlasPx; vec2 dx = dFdx(px), dy = dFdy(px);
  float mip = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
  if (texture2D(uImpA, vUvS).a * (1.0 + mip * 0.3) < 0.5) discard;
  if (vFade.x * vFade.y < 0.02) discard;
}`);
    shader.fragmentShader = fs;
  };
  depth.customProgramCacheKey = () => 'rv-flora-imp-depth-v1';
  return { material: mat, depth, uniforms: u };
}
