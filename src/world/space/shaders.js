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

// 3D simplex noise with analytic gradient (Gustavson / McEwan, noise3Dgrad) → value in [-1, 1], grad
float sp_snoiseG(vec3 v, out vec3 grad){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = rv_mod289(i);
  vec4 p = rv_permute(rv_permute(rv_permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  vec3 ns = 0.142857142857 * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 nrm = rv_taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= nrm.x; p1 *= nrm.y; p2 *= nrm.z; p3 *= nrm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 m2 = m * m;
  vec4 m4 = m2 * m2;
  vec4 pdotx = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
  vec4 tmp = m2 * m * pdotx;
  grad = -8.0 * (tmp.x * x0 + tmp.y * x1 + tmp.z * x2 + tmp.w * x3);
  grad += m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
  grad *= 105.0;
  return 105.0 * dot(m4, pdotx);
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
