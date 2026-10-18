// Shared GLSL chunks registered into THREE.ShaderChunk so any ShaderMaterial /
// onBeforeCompile can `#include <rv_common>` / `#include <rv_noise>`.
// Tracks may register additional chunks from their own folders via registerChunk().
import * as THREE from 'three';

export function registerChunk(name, glsl) {
  THREE.ShaderChunk[name] = glsl;
}

registerChunk('rv_common', /* glsl */ `
#ifndef RV_COMMON
#define RV_COMMON
#define RV_PI 3.14159265359
#define RV_TAU 6.28318530718
float rv_saturate(float x){ return clamp(x, 0.0, 1.0); }
vec3  rv_saturate(vec3 x){ return clamp(x, 0.0, 1.0); }
float rv_luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float rv_remap(float x, float a, float b, float c, float d){ return c + (x - a) * (d - c) / (b - a); }
float rv_hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float rv_hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float rv_hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2  rv_hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3  rv_hash33(vec3 p3){ p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
// Interleaved gradient noise — for dithering banding away (use on every smooth gradient!)
float rv_ign(vec2 fragCoord){ return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715)))); }
// Linearize a depth-buffer value. Handles reversed-Z (three sets USE_REVERSED_DEPTH_BUFFER).
float rv_viewZFromDepth(float depth, float near, float far){
#ifdef USE_REVERSED_DEPTH_BUFFER
  // reversed: near -> 1, far -> 0 (ZERO_TO_ONE clip control)
  return (near * far) / ((far - near) * depth + near) ;
#else
  float z = depth * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
#endif
}
#endif
`);

// Simplex noise (Ashima / Stefan Gustavson, MIT) + fbm helpers.
registerChunk('rv_noise', /* glsl */ `
#include <rv_common>
#ifndef RV_NOISE
#define RV_NOISE
vec3 rv_mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 rv_mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 rv_permute(vec4 x){ return rv_mod289(((x * 34.0) + 10.0) * x); }
vec4 rv_taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float rv_snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
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
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
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
  vec4 norm = rv_taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
float rv_fbm(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 10; i++){ if (i >= oct) break; s += a * rv_snoise(p); n += a; p = p * 2.02 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s / n;
}
float rv_ridged(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0, w = 1.0;
  for (int i = 0; i < 10; i++){ if (i >= oct) break; float r = 1.0 - abs(rv_snoise(p)); r *= r * w; w = clamp(r * 2.0, 0.0, 1.0); s += a * r; n += a; p = p * 2.03 + vec3(3.1, 1.7, 8.3); a *= 0.5; }
  return s / n;
}
// Value noise (cheap) and 3D worley (F1, F2)
float rv_vnoise(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rv_hash13(i + vec3(0,0,0)), rv_hash13(i + vec3(1,0,0)), f.x),
                 mix(rv_hash13(i + vec3(0,1,0)), rv_hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(rv_hash13(i + vec3(0,0,1)), rv_hash13(i + vec3(1,0,1)), f.x),
                 mix(rv_hash13(i + vec3(0,1,1)), rv_hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
vec2 rv_worley(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); float f1 = 8.0, f2 = 8.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec3 b = vec3(float(x), float(y), float(z));
    vec3 r = b + rv_hash33(i + b) - f; float d = dot(r, r);
    if (d < f1){ f2 = f1; f1 = d; } else if (d < f2){ f2 = d; }
  }
  return sqrt(vec2(f1, f2));
}
#endif
`);

// Physically-inspired helpers for emissive/space objects.
registerChunk('rv_color', /* glsl */ `
#ifndef RV_COLOR
#define RV_COLOR
// Approximate blackbody color (linear RGB, normalized) for temperature in Kelvin.
vec3 rv_blackbody(float T){
  T = clamp(T, 1000.0, 40000.0) / 100.0;
  vec3 c;
  c.r = T <= 66.0 ? 1.0 : clamp(1.29293618606 * pow(T - 60.0, -0.1332047592), 0.0, 1.0);
  c.g = T <= 66.0 ? clamp(0.39008157876 * log(T) - 0.63184144378, 0.0, 1.0) : clamp(1.12989086089 * pow(T - 60.0, -0.0755148492), 0.0, 1.0);
  c.b = T >= 66.0 ? 1.0 : (T <= 19.0 ? 0.0 : clamp(0.54320678911 * log(T - 10.0) - 1.19625408914, 0.0, 1.0));
  return pow(c, vec3(2.2));
}
#endif
`);
