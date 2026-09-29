// Light pools: the ground-level footprint of every street lamp, lantern, shopfront and neon sign at
// night — soft coloured discs laid on the pavement (1 draw call per site, additive, no real lights).
// On wet ground (rain, G.uWetness) each pool stretches into a glossy reflection streak running from
// the light's base toward the camera, the Blade Runner "neon on wet asphalt" look.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';

/**
 * pools: [{x, y, z (mesh-space ground point), nx, ny, nz (unit up), r, g, b (linear * k), rad (m), hgt (light height m)}]
 */
export function makePools(pools, reversed = false) {
  const n = pools.length;
  if (!n) return null;
  const P = new Float32Array(n * 4 * 3), C = new Float32Array(n * 4 * 3), Q = new Float32Array(n * 4 * 4), U = new Float32Array(n * 4 * 3);
  const idx = new Uint32Array(n * 6);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < n; i++) {
    const p = pools[i];
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      P.set([p.x, p.y, p.z], v * 3);
      C.set([p.r, p.g, p.b], v * 3);
      Q.set([corners[k][0], corners[k][1], p.rad, p.hgt], v * 4);
      U.set([p.nx, p.ny, p.nz], v * 3);
    }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('aCol', new THREE.BufferAttribute(C, 3));
  geo.setAttribute('aQ', new THREE.BufferAttribute(Q, 4));
  geo.setAttribute('aUp', new THREE.BufferAttribute(U, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  if (geo.boundingSphere) geo.boundingSphere.radius += 40;
  const m = new THREE.ShaderMaterial({
    uniforms: { uWet: G.uWetness, uSunDirC: G.uSunDir, uPlanetC: G.uPlanetCenter, uTimeC: G.uTime },
    vertexShader: /* glsl */`
      attribute vec3 aCol; attribute vec4 aQ; attribute vec3 aUp;
      uniform float uWet; uniform vec3 uSunDirC, uPlanetC;
      varying vec3 vC; varying vec2 vQ; varying float vStretch; varying float vK; varying float vFres;
      void main(){
        vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 up = normalize(aUp);
        // toward the camera, in the ground plane
        vec3 tc = cameraPosition - wp; tc -= up * dot(tc, up);
        float lc = length(tc);
        vec3 fw = lc > 0.01 ? tc / lc : normalize(cross(up, vec3(0.0, 0.0, 1.0)));
        vec3 sd = normalize(cross(fw, up)); // (sd, fw) counter-clockwise seen from above → front face
        float wet = clamp(uWet * 1.4, 0.0, 1.0);
        // mirror image of a light at height h, seen from far away, spreads toward the viewer
        float stretch = 1.0 + wet * (1.3 + aQ.w * 0.2);
        float R = aQ.z;
        float along = aQ.y > 0.0 ? aQ.y * R * stretch : aQ.y * R;
        vec3 p = wp + sd * aQ.x * R * mix(1.0, 0.45, wet) + fw * along + up * 0.3; // above road (0.18) / pavement (0.09) / plaza (0.2) surfaces
        vQ = vec2(aQ.x, aQ.y > 0.0 ? aQ.y : aQ.y);
        vStretch = stretch;
        // only at night at this location
        float nightL = 1.0 - smoothstep(-0.12, 0.05, dot(normalize(wp - uPlanetC), normalize(uSunDirC)));
        float dist = length(cameraPosition - wp);
        vK = nightL * (1.0 - smoothstep(900.0, 1400.0, dist));
        vC = aCol * (1.0 + wet * 0.8);
        // a mirror image on wet ground is bright only at grazing view angles (Fresnel): the part of the streak
        // right under the viewer must fade, or a nearby lamp washes the whole foreground
        vec3 vd = normalize(cameraPosition - p);
        float cosV = abs(dot(vd, up));
        vFres = 0.04 + 0.96 * pow(1.0 - cosV, 5.0);
        vFres = clamp(vFres * 3.0, 0.0, 1.0);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        if (vK < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uWet, uTimeC;
      varying vec3 vC; varying vec2 vQ; varying float vStretch; varying float vK; varying float vFres;
      void main(){
        float r2 = dot(vQ, vQ);
        if (r2 > 1.0) discard;
        // bright core under the lamp + long soft skirt, zero at the rim
        float pool = (0.7 / (1.0 + 18.0 * r2) + 0.3 * exp(-r2 * 6.0)) * (1.0 - r2) * (1.0 - r2);
        // wet streak: long soft tail with rippling breakup along its length
        float wet = clamp(uWet * 1.4, 0.0, 1.0);
        float tail = step(0.0, vQ.y) * exp(-vQ.x * vQ.x * 16.0) * (1.0 - vQ.y) * (0.75 + 0.25 * sin(vQ.y * 38.0 + uTimeC * 2.0));
        float k = pool * mix(1.0, 0.7, wet) + wet * tail * 2.2 * vFres;
        gl_FragColor = vec4(vC * k * vK, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    // pull toward the camera like the road decal (three flips the factor for reversed depth, not the units)
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: reversed ? 6 : -6,
  });
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = 'civ-pools';
  mesh.renderOrder = 4;
  mesh.frustumCulled = true;
  mesh.userData.noCSM = true;
  return mesh;
}
