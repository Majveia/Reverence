// Shared GLSL chunks (plain strings).  Concatenate them into your shaders:
//
//   import { GLSL } from '../../core/glsl.js';
//   fragmentShader: `${GLSL.common} ${GLSL.noise} void main(){ ... }`
//
// All functions are prefixed rv* / named distinctly so they never collide with three.js chunks.

const common = /* glsl */`
#ifndef RV_COMMON
#define RV_COMMON
#define RV_PI 3.141592653589793
#define RV_TAU 6.283185307179586
float rvSaturate(float x){ return clamp(x, 0.0, 1.0); }
vec3  rvSaturate(vec3 x){ return clamp(x, 0.0, 1.0); }
float rvRemap(float x, float a, float b, float c, float d){ return c + (d - c) * clamp((x - a) / (b - a), 0.0, 1.0); }
float rvLuma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
mat2  rvRot(float a){ float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }
// Integer-free hashes (Dave Hoskins) — stable across GPUs.
float rvHash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float rvHash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float rvHash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2  rvHash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3  rvHash33(vec3 p3){ p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
// Interleaved gradient noise (Jimenez) — great for dithering / jittering ray starts.
float rvIGN(vec2 px){ return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
// Triangular-PDF noise in [-1,1] for banding-free gradients.
float rvTriNoise(vec2 px, float t){ float a = rvHash12(px + 17.0 * fract(t)); float b = rvHash12(px + 59.0 * fract(t * 1.37) + 7.13); return a - b; }
#endif
`;

const noise = /* glsl */`
#ifndef RV_NOISE
#define RV_NOISE
// Value noise + analytic-quality fbm.  3D simplex (Ashima / Ian McEwan, MIT).
vec4 rvPermute(vec4 x){ return mod(((x * 34.0) + 10.0) * x, 289.0); }
vec4 rvTaylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float rvSimplex(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0); const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy)); vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz); vec3 l = 1.0 - g; vec3 i1 = min(g.xyz, l.zxy); vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx; vec3 x2 = x0 - i2 + C.yyy; vec3 x3 = x0 - D.yyy;
  i = mod(i, 289.0);
  vec4 p = rvPermute(rvPermute(rvPermute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857; vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z); vec4 x_ = floor(j * ns.z); vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy; vec4 y = y_ * ns.x + ns.yyyy; vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy); vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0; vec4 s1 = floor(b1) * 2.0 + 1.0; vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy; vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x); vec3 p1 = vec3(a0.zw, h.y); vec3 p2 = vec3(a1.xy, h.z); vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = rvTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0); m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
float rvValue(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float n = mix(mix(mix(rvHash13(i), rvHash13(i + vec3(1,0,0)), f.x), mix(rvHash13(i + vec3(0,1,0)), rvHash13(i + vec3(1,1,0)), f.x), f.y),
                mix(mix(rvHash13(i + vec3(0,0,1)), rvHash13(i + vec3(1,0,1)), f.x), mix(rvHash13(i + vec3(0,1,1)), rvHash13(i + vec3(1,1,1)), f.x), f.y), f.z);
  return n * 2.0 - 1.0;
}
float rvFbm(vec3 p, int oct){ float a = 0.5, s = 0.0; for (int i = 0; i < 8; i++){ if (i >= oct) break; s += a * rvSimplex(p); p = p * 2.02 + 19.19; a *= 0.5; } return s; }
float rvFbmFast(vec3 p, int oct){ float a = 0.5, s = 0.0; for (int i = 0; i < 8; i++){ if (i >= oct) break; s += a * rvValue(p); p = p * 2.02 + 19.19; a *= 0.5; } return s; }
float rvRidged(vec3 p, int oct){ float a = 0.5, s = 0.0, prev = 1.0; for (int i = 0; i < 8; i++){ if (i >= oct) break; float n = 1.0 - abs(rvSimplex(p)); n *= n; s += a * n * prev; prev = n; p = p * 2.05 + 7.7; a *= 0.5; } return s; }
// Cellular F1 (returns distance, cell hash in .y)
vec2 rvWorley(vec3 p){
  vec3 i = floor(p), f = fract(p); float d = 8.0, id = 0.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec3 g = vec3(float(x), float(y), float(z)); vec3 o = rvHash33(i + g); vec3 r = g + o - f; float dd = dot(r, r);
    if (dd < d){ d = dd; id = rvHash13(i + g + 3.3); }
  }
  return vec2(sqrt(d), id);
}
#endif
`;

const color = /* glsl */`
#ifndef RV_COLOR
#define RV_COLOR
// Approximate blackbody colour (linear sRGB, normalised to max channel 1) for T in Kelvin [1000, 40000].
vec3 rvBlackbody(float T){
  T = clamp(T, 1000.0, 40000.0) / 100.0; vec3 c;
  c.r = T <= 66.0 ? 1.0 : clamp(1.29293618606 * pow(T - 60.0, -0.1332047592), 0.0, 1.0);
  c.g = T <= 66.0 ? clamp(0.39008157876 * log(T) - 0.63184144378, 0.0, 1.0) : clamp(1.12989086089 * pow(T - 60.0, -0.0755148492), 0.0, 1.0);
  c.b = T >= 66.0 ? 1.0 : (T <= 19.0 ? 0.0 : clamp(0.54320678911 * log(T - 10.0) - 1.19625408914, 0.0, 1.0));
  return pow(c, vec3(2.2)); // the fit is in display space → linearise
}
vec3 rvHsv2rgb(vec3 c){ vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0); vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www); return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y); }
// Inigo Quilez cosine palette.
vec3 rvPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d){ return a + b * cos(6.28318 * (c * t + d)); }
#endif
`;

// Depth helpers for post passes that sample the scene depth texture.  Requires uniforms uCamNear / uCamFar.
// three.js injects USE_REVERSED_DEPTH_BUFFER / USE_LOGARITHMIC_DEPTH_BUFFER into every ShaderMaterial for us.
const depth = /* glsl */`
#ifndef RV_DEPTH
#define RV_DEPTH
uniform float uCamNear;
uniform float uCamFar;
// Raw depth-texture sample → positive distance along the camera's view axis, in scene units.
float rvViewDepth(float d){
  #if defined( USE_REVERSED_DEPTH_BUFFER )
    return (uCamNear * uCamFar) / (d * (uCamFar - uCamNear) + uCamNear);
  #elif defined( USE_LOGARITHMIC_DEPTH_BUFFER )
    return pow(uCamFar + 1.0, d) - 1.0;
  #else
    return (uCamNear * uCamFar) / (uCamFar - d * (uCamFar - uCamNear));
  #endif
}
// True where nothing was drawn (cleared depth).
bool rvIsSky(float d){
  #if defined( USE_REVERSED_DEPTH_BUFFER )
    return d <= 0.0;
  #else
    return d >= 1.0;
  #endif
}
#endif
`;

// Vertex/fragment boilerplate every custom scene ShaderMaterial MUST include so depth is correct in all modes.
const logdepthVertPars = '#include <common>\n#include <logdepthbuf_pars_vertex>';
const logdepthVert = '#include <logdepthbuf_vertex>';
const logdepthFragPars = '#include <logdepthbuf_pars_fragment>';
const logdepthFrag = '#include <logdepthbuf_fragment>';

export const GLSL = { common, noise, color, depth, logdepthVertPars, logdepthVert, logdepthFragPars, logdepthFrag };
export default GLSL;
