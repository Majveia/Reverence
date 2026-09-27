// Global shared uniforms. Materials may reference these objects directly
// (e.g. `uniforms: { uTime: G.uTime }`) — Three.js shares the same {value} object,
// so updating G.uTime.value once per frame updates every material.
import * as THREE from 'three';

export const G = {
  uTime: { value: 0 },                                   // seconds of simulation time
  uFrame: { value: 0 },
  uResolution: { value: new THREE.Vector2(1, 1) },       // drawing-buffer size in px
  uPixelRatio: { value: 1 },

  // --- Lighting (written by the atmosphere/sky subsystem in SystemMode) ---
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() }, // direction TOWARD the sun, scene space
  uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },   // linear, pre-multiplied by intensity
  uSunIntensity: { value: 3.0 },
  uAmbientSky: { value: new THREE.Color(0.25, 0.32, 0.45) },   // hemisphere ambient (sky side)
  uAmbientGround: { value: new THREE.Color(0.12, 0.1, 0.08) }, // hemisphere ambient (ground side)
  uNight: { value: 0 },                                   // 0 = day, 1 = full night at camera location

  // --- Planet context (camera-relative scene space) ---
  uPlanetCenter: { value: new THREE.Vector3(0, -1e5, 0) },
  uPlanetRadius: { value: 50000 },
  uSeaLevel: { value: 0 },                                // meters relative to radius
  uAtmosphereRadius: { value: 56000 },
  uCameraAltitude: { value: 0 },                          // meters above sea level

  // --- Weather / wind (flora, water, particles, audio read these) ---
  uWindDir: { value: new THREE.Vector3(1, 0, 0) },       // scene-space unit vector tangent to surface
  uWindStrength: { value: 0.3 },                          // 0..1
  uWetness: { value: 0 },                                 // 0..1 (rain)
  uSnow: { value: 0 },                                    // 0..1

  // --- Camera ---
  uCameraPos: { value: new THREE.Vector3() },
  uCameraNear: { value: 0.1 },
  uCameraFar: { value: 1e9 },
};

export function updateCameraUniforms(camera) {
  G.uCameraPos.value.setFromMatrixPosition(camera.matrixWorld);
  G.uCameraNear.value = camera.near;
  G.uCameraFar.value = camera.far;
}
