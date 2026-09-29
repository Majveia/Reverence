// Star points: rotation (pattern / flat rotation curve), per-star dust extinction toward the camera
// (same dust field as the volume), flux-conserving PSF (Gaussian core + halo + diffraction spikes).
import { registerChunk } from '../../../shaders/chunks.js';

registerChunk('gx_dust', /* glsl */ `
#ifndef GX_DUST
#define GX_DUST
uniform sampler2D tMap;
uniform highp sampler3D tNoise;
uniform float uMapR, uMapTexel, uHDust, uFlare, uR, uDustL, uDustNoise, uYmaxD;
uniform vec4 uNoiseF;
uniform vec3 uExt;
uniform int uDustSteps;
float gxd_erf(float x){ float s = sign(x); x = abs(x); float t = 1.0 / (1.0 + 0.3275911 * x);
  return s * (1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x)); }
float gxd_gint(float y0, float y1, float dt, float h){
  float dy = y1 - y0;
  if (abs(dy) < 2e-3 * h) { float ym = 0.5 * (y0 + y1) / h; return dt * exp(-ym * ym) / (1.7724539 * h); }
  return dt / dy * 0.5 * (gxd_erf(clamp(y1 / h, -6.0, 6.0)) - gxd_erf(clamp(y0 / h, -6.0, 6.0)));
}
// optical depth (rgb) between two pattern-frame points
vec3 gx_dustTau(vec3 a, vec3 b, float jit, float lod){
  if (uDustSteps <= 0) return vec3(0.0);
  vec3 d = b - a; float len = length(d);
  if (len < 1e-7) return vec3(0.0);
  vec3 dir = d / len;
  float t0 = 0.0, t1 = len;
  if (abs(dir.y) > 1e-7) {
    float ta = (-uYmaxD - a.y) / dir.y, tb = (uYmaxD - a.y) / dir.y;
    t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb));
  } else if (abs(a.y) > uYmaxD) return vec3(0.0);
  if (t1 <= t0) return vec3(0.0);
  float tau = 0.0;
  float dt = (t1 - t0) / float(uDustSteps);
  for (int i = 0; i < 12; i++) {
    if (i >= uDustSteps) break;
    float ta = t0 + dt * float(i), tb = ta + dt;
    vec3 pa = a + dir * ta, pb = a + dir * tb;
    float tcr = abs(dir.y) > 1e-7 ? -a.y / dir.y : -1.0;
    vec3 pm = a + dir * ((tcr >= ta && tcr <= tb) ? tcr : ta + dt * jit);
    vec2 uv = pm.xz / (2.0 * uMapR) + 0.5;
    if (abs(uv.x - 0.5) >= 0.5 || abs(uv.y - 0.5) >= 0.5) continue;
    float Mb = textureLod(tMap, uv, lod).b;
    float rm = length(pm.xz);
    float hD = uHDust * (1.0 + 0.35 * uFlare * (rm / uR) * (rm / uR));
    float ID = gxd_gint(pa.y, pb.y, dt, hD);
    float n = textureLod(tNoise, pm * uNoiseF.x, 0.0).r * 1.3 - 0.15;
    tau += Mb * ID * mix(1.0, clamp(n, 0.0, 3.0), uDustNoise);
  }
  return uExt * (tau * uDustL);
}
#endif
`);

export const STAR_VERT = /* glsl */ `
precision highp float;
precision highp int;
#include <gx_dust>
attribute vec4 aCol;
attribute float aLogL;
uniform float uPat, uTau, uV0, uRt;
uniform vec3 uCamPat;
uniform float uPixScale, uGain, uLumExp, uSoft, uWeight, uLocal, uEps, uHaloR, uHaloFrac, uMaxSize, uSpikeMin;
uniform vec2 uFadeNear;
uniform vec3 uLodCenter;
uniform float uLodRadius;
uniform float uClusterBoost, uSphW, uDiskW;
uniform float uGainNear;       // single-star gain (global tracers only): a tracer stands for ~10^6 stars
uniform vec2 uNearD;           // far away, but close up it is just one star → blend the gain in log space
varying vec3 vCol;
varying float vSize;
varying float vSpike;
vec3 rotT(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c); }
void main(){
  int f = int(aCol.a * 255.0 + 0.5);
  int sph = f / 64;
  int follow = (f / 16) - sph * 4;
  int cl = (f / 8) - (f / 16) * 2;
  float r = max(length(position.xz), 1e-4);
  float omega = -uV0 * (1.0 - exp(-r / uRt)) / r;
  float ang = follow == 1 ? uPat : (follow == 0 ? omega * uTau : uPat * 0.08);
  vec3 pw = rotT(position, ang);
  vec4 mv = modelViewMatrix * vec4(pw, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = length(mv.xyz);
  float L = exp2(aLogL * 3.3219281 * uLumExp);
  float gain = uGain;
  if (uLocal < 0.5 && uGainNear > 0.0) gain = exp(mix(log(uGainNear), log(uGain), smoothstep(uNearD.x, uNearD.y, d)));
  float flux = L * gain / (d * d + uSoft * uSoft);
  flux *= smoothstep(uFadeNear.x, uFadeNear.y, d);
  vec3 sp = rotT(position, ang - uPat);            // pattern frame
  if (uLocal > 0.5) {
    float dl = length(position - uLodCenter);
    flux *= 1.0 - smoothstep(uLodRadius * 0.72, uLodRadius, dl);
  } else {
    if (cl == 1) flux *= uClusterBoost;
    // inside the local LOD sphere the real neighborhood stars take over
    if (uLodRadius > 0.0) flux *= smoothstep(0.5, 1.0, length(sp - uLodCenter) / uLodRadius);
  }
  flux *= uWeight * (sph == 1 ? uSphW : (follow == 0 ? uDiskW : 1.0));
  vec3 col = aCol.rgb * aCol.rgb;
  float Fp = flux * uPixScale * uPixScale;
  float lum0 = Fp * max(col.r, max(col.g, col.b));
  if (lum0 < uEps * 0.03 || mv.z > 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vSize = 1.0; vSpike = 0.0; return; }
  // dust map level ~ the star's pixel footprint (a star is a point but its column is seen through a pixel)
  float lodD = max(0.0, log2(d * uNoiseF.w / uMapTexel) - 0.5);
  col *= exp(-gx_dustTau(sp, uCamPat, fract(float(gl_VertexID) * 0.61803399), lodD));
  float lum = Fp * max(col.r, max(col.g, col.b));
  float x = lum * uHaloFrac / (3.14159265 * uHaloR * uHaloR * uEps);
  float rv = x > 1.0 ? uHaloR * sqrt(sqrt(x) - 1.0) : 0.0;
  float size = clamp(2.0 * max(rv, 1.7) + 1.0, 3.0, uMaxSize);
  gl_PointSize = size;
  vSize = size;
  vCol = col * Fp;
  vSpike = smoothstep(uSpikeMin, uSpikeMin * 40.0, lum);
}
`;

export const STAR_FRAG = /* glsl */ `
precision highp float;
uniform float uHaloR, uHaloFrac, uSpikeFrac, uCoreSigma;
varying vec3 vCol;
varying float vSize;
varying float vSpike;
void main(){
  vec2 q = (gl_PointCoord - 0.5) * vSize;
  float r2 = dot(q, q);
  float s2 = uCoreSigma * uCoreSigma;
  float core = exp(-r2 / (2.0 * s2)) / (6.2831853 * s2);
  float hr = uHaloR * uHaloR;
  float hq = 1.0 + r2 / hr;
  float halo = uHaloFrac / (3.14159265 * hr * hq * hq);
  float sp = 0.0;
  if (vSpike > 0.0) {
    vec2 a = abs(q);
    float along = max(a.x, a.y), across = min(a.x, a.y);
    sp = exp(-across * across * 1.6) / (1.0 + along * 0.35) * (1.0 - smoothstep(0.3, 0.5, length(gl_PointCoord - 0.5))) * uSpikeFrac * vSpike;
  }
  float edge = 1.0 - smoothstep(0.4, 0.5, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(vCol * ((core * (1.0 - uHaloFrac) + halo) * edge + sp), 1.0);
}
`;
