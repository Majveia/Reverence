// Contact shadows: a soft multiplicative ambient-occlusion skirt on the ground around every building
// footprint (terrain, roads and plazas darken where they meet walls), so houses sit IN the ground rather
// than on it. One draw call per settlement; draped 3×3 grid per building; no lights involved.
import * as THREE from 'three';

/**
 * items: [{ verts: [[x,y,z] × 9] (mesh space, row-major 3×3 grid), q: [[qx,qz] × 9] (footprint-local m),
 *           hw, hd (half footprint m), reach (m), k (strength 0-1) }]
 */
export function makeContactShadows(items, reversed = false) {
  const n = items.length;
  if (!n) return null;
  const P = new Float32Array(n * 9 * 3), Q = new Float32Array(n * 9 * 2), B = new Float32Array(n * 9 * 4);
  const idx = new Uint32Array(n * 24);
  let ii = 0;
  for (let i = 0; i < n; i++) {
    const it = items[i];
    for (let k = 0; k < 9; k++) {
      const v = i * 9 + k;
      P[v * 3] = it.verts[k][0]; P[v * 3 + 1] = it.verts[k][1]; P[v * 3 + 2] = it.verts[k][2];
      Q[v * 2] = it.q[k][0]; Q[v * 2 + 1] = it.q[k][1];
      B[v * 4] = it.hw; B[v * 4 + 1] = it.hd; B[v * 4 + 2] = it.reach; B[v * 4 + 3] = it.k;
    }
    const b = i * 9;
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
      const a = b + r * 3 + c;
      idx[ii++] = a; idx[ii++] = a + 3; idx[ii++] = a + 4;
      idx[ii++] = a; idx[ii++] = a + 4; idx[ii++] = a + 1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('aQ', new THREE.BufferAttribute(Q, 2));
  geo.setAttribute('aB', new THREE.BufferAttribute(B, 4));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  const m = new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      attribute vec2 aQ; attribute vec4 aB;
      varying vec2 vQ; varying vec4 vB; varying float vFade;
      void main(){
        vQ = aQ; vB = aB;
        vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 tc = cameraPosition - wp; float dl = length(tc);
        wp += tc / max(dl, 1e-3) * min(dl * 0.0035, 8.0);
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        vFade = 1.0 - smoothstep(500.0, 900.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vQ; varying vec4 vB; varying float vFade;
      void main(){
        vec2 d2 = max(abs(vQ) - vB.xy, 0.0);
        float d = length(d2);
        // soft skirt: dark right at the wall, gone at 'reach'
        float occ = exp(-d / max(vB.z * 0.38, 0.2)) * (1.0 - smoothstep(vB.z * 0.6, vB.z, d));
        float k = occ * vB.w * vFade;
        gl_FragColor = vec4(vec3(1.0 - k), 1.0);
      }`,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: reversed ? 6 : -6,
  });
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = 'civ-contact';
  mesh.renderOrder = 3;
  mesh.userData.noCSM = true;
  return mesh;
}
