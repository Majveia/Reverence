// Water textures — thin THREE wrappers around texdata.js (generated in the water worker when possible).
import * as THREE from 'three';
import { waveData, foamData, crustData, SLOPE_RANGE } from './texdata.js';

export { SLOPE_RANGE };

export function dataTexture(data, N, name) {
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

/** Synchronous fallback (no worker). */
export function makeTexturesSync(seed, N, crust) {
  return {
    waves: waveData(seed, N),
    foam: foamData(seed, N),
    crust: crust ? crustData(seed, N) : null,
  };
}

/** 1×1 placeholder (flat normal, no foam) used until the worker delivers. */
export function placeholderTexture(r, g, b, a, name) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.name = name;
  t.needsUpdate = true;
  return t;
}
