// Shared GLSL for the space track. OWNED BY THE SPACE TRACK.
import { registerChunk } from '../../shaders/chunks.js';

registerChunk('rv_space', /* glsl */ `
#include <rv_common>
#include <rv_noise>
#ifndef RV_SPACE
#define RV_SPACE
// ray / sphere: returns (t0, t1); t1 < 0 or t0 > t1 → miss
vec2 sp_raySphere(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1e30, -1e30);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
float sp_phaseHG(float mu, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * RV_PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}
float sp_phaseR(float mu){ return 3.0 / (16.0 * RV_PI) * (1.0 + mu * mu); }

// Fraction of the star's disk visible from point p (scene space) past one spherical occluder
// (center c, radius r). L = unit direction to the star, sunAng = star angular radius.
float sp_occlude(vec3 p, vec3 L, float sunAng, vec3 c, float r){
  vec3 d = c - p;
  float dist = length(d);
  if (dist < r * 1.0001) return 1.0;
  float along = dot(d, L);
  if (along <= 0.0) return 1.0;
  float sep = acos(clamp(along / dist, -1.0, 1.0));
  float ro = asin(clamp(r / dist, 0.0, 1.0));
  float rs = max(sunAng, 1e-4);
  // overlap of two disks (radii ro, rs) with separation sep → approximate visible fraction
  float x = clamp((sep - abs(ro - rs)) / max(ro + rs - abs(ro - rs), 1e-6), 0.0, 1.0);
  x = x * x * (3.0 - 2.0 * x);
  float full = ro >= rs ? 0.0 : 1.0 - (ro * ro) / (rs * rs);   // umbra (total) or annular minimum
  return mix(full, 1.0, x);
}

// Flow-noise helper: two phases of a displaced field, cross-faded (no infinite shear)
vec2 sp_flowPhases(float t, float period){
  float a = fract(t / period);
  float b = fract(t / period + 0.5);
  return vec2(a, b);
}
#endif
`);

// Background vertex helper: fullscreen triangle at the far plane, outputs the world view ray.
export const FULLSCREEN_BG_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vec2 p = position.xy;
  vec4 v = inverse(projectionMatrix) * vec4(p, 0.5, 1.0);
  vec3 vd = v.xyz / v.w;
  vDir = (vec4(vd, 0.0) * viewMatrix).xyz;
#ifdef USE_REVERSED_DEPTH_BUFFER
  gl_Position = vec4(p, 0.0, 1.0);
#else
  gl_Position = vec4(p, 0.999999, 1.0);
#endif
}`;

// Places a direction at infinity (far plane) — used by point-like background sprites.
export const FAR_DIR_POS = /* glsl */ `
vec4 sp_farClip(vec3 dirWorld){
  vec3 v = mat3(viewMatrix) * dirWorld;
  vec4 c = projectionMatrix * vec4(v, 1.0);
#ifdef USE_REVERSED_DEPTH_BUFFER
  c.z = 0.0;
#else
  c.z = c.w * 0.999999;
#endif
  return c;
}`;
