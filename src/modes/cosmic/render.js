// Render layers for the cosmic web. OWNED BY THE COSMIC TRACK.
//
//   Accumulation  every particle → soft adaptive-smoothing point sprite, additively accumulated into an
//                 offscreen float target: R = projected column density Σ, G = Σ·T (shock-heated gas),
//                 B = Σ·v (bulk streaming). Surface brightness is distance-invariant (flux/area), so the
//                 picture is a true projected density, exactly how Millennium/TNG images are made.
//   Composite     full-screen: log-density colour ramp (void black → blue-violet dark matter → magenta)
//                 blended toward a TNG-style temperature ramp (magenta → orange → white-gold) by T.
//   Galaxies      bright pinpoints riding on their host particles; ignite when their host collapses;
//                 resolve into tiny oriented discs / ellipticals up close.
//   Ring          hover ring for clusters and galaxies.
//
// Camera-relative, periodic rendering: the camera sits at the three.js origin, every position is
// wrapped around a "wrap centre" ahead of the camera (x − c − ⌊x − c + ½⌋), so the box tiles an
// infinite universe and float precision never degrades however far the player drifts.
import * as THREE from 'three';
import * as S from './shaders.js';
const _cc = new THREE.Color();

const ADD = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, transparent: true, depthTest: false, depthWrite: false };

// Shared by every render layer: camera-relative wrap, halo "orbits", local density estimate.
export const GLSL_VIEW = /* glsl */`
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uWrapC;      // wrap centre, box units
uniform vec3 uCamOff;     // (wrap centre − camera) · L, world units (Mpc/h)
uniform float uL;         // box size, Mpc/h
uniform float uFade;      // visible radius around the wrap centre, box units
uniform float uPxScale;   // px per world unit at unit depth
uniform float uTime;      // real (display) time, s
uniform float uOrbit;     // halo orbit amplitude, box units
uniform float uSigGlow;   // σ of the linear glow field
// wrapped camera-relative world position; .w = distance of the particle from the wrap centre (box units)
vec4 cwView(vec3 x) {
  vec3 rel = x - uWrapC; rel -= floor(rel + 0.5);
  return vec4(rel * uL + uCamOff, length(rel));
}
uniform float uSeedD;     // visual growth of the linear seed field during the opening (fog → wrinkles)
uniform float uSeedMix;   // 1 = linear seeds only, 0 = particle-resolution density only
float cwDensity(vec3 x, vec4 A) {
  float seed = max(0.1, 1.0 + max(uD1, uSeedD) * A.w / max(uSigGlow, 1e-3) * 0.5);
  if (uFieldOn < 0.5 || uSeedMix >= 1.0) return seed;
  return mix(max(cwField(x).x, 0.02), seed, uSeedMix);
}
// virialised matter keeps moving: particles inside collapsed halos trace randomly oriented,
// eccentric orbits whose angular frequency scales as √(Gρ)
vec3 cwOrbit(ivec3 L, float rho) {
  float vir = smoothstep(5.0, 40.0, rho);
  if (vir <= 0.0) return vec3(0.0);
  vec3 h = cwHash3(L);
  vec3 h2 = cwHash3(L.zxy + ivec3(17, 31, 7));
  vec3 n = normalize(h2 * 2.0 - 1.0 + vec3(1e-3, 2e-3, 0.0));
  vec3 e1 = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(n, e1);
  float r = uOrbit * (0.25 + h.z) * vir * inversesqrt(sqrt(rho / 5.0));
  float w = (0.5 + 0.9 * h.y) * 0.05 * sqrt(rho);
  float ph = 6.2831853 * h.x + uTime * w;
  return r * (cos(ph) * e1 + (0.35 + 0.65 * h2.x) * sin(ph) * e2);
}
`;

const HEAD = S.GLSL_HEAD + S.GLSL_ATLAS + S.GLSL_POSITION + S.GLSL_FIELD + GLSL_VIEW;
const OFF = 'gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0;';

// ------------------------------------------------------------------ accumulation
// Resolve pass: one texel per particle → (position incl. halo orbit + sub-lattice jitter, local density).
// Runs once per rendered frame so the (many) sprites only need one or two texel fetches each.
const RESOLVE_FRAG = HEAD + /* glsl */`
uniform float uHeatLo, uHeatHi;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oAux;   // heat, speed
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  ivec3 L = cwLatticeFromTexel(tc);
  vec4 A, B;
  vec3 x = cwPosition(tc, L, A, B);
  float rho = cwDensity(x, A);
  x += cwOrbit(L, rho);
  // sub-lattice jitter (render only) hides the Lagrangian grid in voids
  // (a uniform jitter of exactly one cell cancels every Bragg harmonic of the lattice: no moiré)
  x += (cwHash3(L + ivec3(91, 17, 43)) - 0.5) * (1.0 / float(uN)) * clamp(1.4 - 0.2 * log2(rho + 1.0), 0.2, 1.0);
  o = vec4(x, rho);
  // shock-heated gas: the intracluster medium extends to a few virial radii, so heat follows the
  // density smoothed over ~±2.5 Mpc/h (six taps of the particle-resolution field)
  float e = 2.5 / uL;
  float rs = cwField(x + vec3(e, 0.0, 0.0)).x + cwField(x - vec3(e, 0.0, 0.0)).x
           + cwField(x + vec3(0.0, e, 0.0)).x + cwField(x - vec3(0.0, e, 0.0)).x
           + cwField(x + vec3(0.0, 0.0, e)).x + cwField(x - vec3(0.0, 0.0, e)).x;
  rs = uFieldOn > 0.5 ? (rs / 6.0) * 0.6 + rho * 0.4 : rho;
  float heat = smoothstep(uHeatLo, uHeatHi, rs);
  vec3 P = texelFetch(tP, tc, 0).xyz;
  oAux = vec4(heat, clamp(length(P) * 60.0, 0.0, 1.0), 0.0, 0.0);
}
`;

const ACC_VERT = HEAD + /* glsl */`
uniform int uK;           // sprites per particle: 1 = particle only, 2-4 adds points on the Lagrangian sheet
uniform sampler2D tPos;   // resolved positions (xyz) + density (w)
uniform sampler2D tAux;   // heat, speed
uniform float uH0;        // base smoothing length, Mpc/h (mean interparticle spacing scale)
uniform float uMaxPx;
uniform float uMass;      // particle mass relative to the reference 2 Mpc/h lattice
uniform float uFog;       // attenuation length, Mpc/h
uniform float uFocus;     // focus distance for the depth-of-field look, Mpc/h
uniform float uCoc;       // circle of confusion strength, px
uniform float uSpacing;   // lattice spacing (mean particle spacing at ρ = 1), Mpc/h
uniform float uSph;       // kernel diameter / sample spacing once the lattice is resolved on screen
uniform float uDpr;       // accumulation px per CSS px
uniform float uKt;        // 1: sheet tracers hand their mass back to the particle in close-ups (fill rate)
out vec3 vW;
out vec2 vK;              // sprite half-size / kernel radius (px), 1 / kernel radius (px)
void main() {
  int id = gl_VertexID / uK;
  int sub = gl_VertexID - id * uK;
  ivec3 L = cwLatticeFromId(id);
  ivec2 tc = cwAtlas(L);
  vec4 p = texelFetch(tPos, tc, 0);
  vec3 x = p.xyz;
  float rho = p.w;
  if (sub > 0) {
    // dark-matter sheet sampling (Abel, Hahn & Kaehler 2012 in spirit): extra tracers on the edge to a
    // Lagrangian neighbour follow the phase-space sheet through shell crossing → smooth, continuous
    // filaments and caustics instead of discrete particle noise
    ivec3 e = sub == 1 ? ivec3(1, 0, 0) : (sub == 2 ? ivec3(0, 1, 0) : ivec3(0, 0, 1));
    ivec3 L2 = (L + e) % uN;
    vec4 p2 = texelFetch(tPos, cwAtlas(L2), 0);
    vec3 dx = p2.xyz - x; dx -= floor(dx + 0.5);
    float f = 0.3 + 0.4 * cwHash1(gl_VertexID);
    x += dx * f;
    rho = mix(rho, p2.w, f);
    // tracers interpolate two jittered particles (half the jitter): add their own in low-density regions
    x += (cwHash3(L * 3 + ivec3(sub * 7, 13, 29)) - 0.5) * (0.7 / float(uN)) * clamp(1.4 - 0.2 * log2(rho + 1.0), 0.0, 1.0);
  }
  vec4 wv = cwView(x);
  if (wv.w > uFade) { ${OFF} return; }
  vec4 v = viewMatrix * vec4(wv.xyz, 1.0);
  float d = -v.z;
  if (d < 0.3) { ${OFF} return; }
  gl_Position = projectionMatrix * v;
  float rq = pow(clamp(rho, 0.02, 3000.0), -0.3333);
  // adaptive (SPH-like) smoothing: kernel diameter h ∝ ρ^(-1/3). Far away many samples project into
  // one pixel, so a kernel narrower than the sample spacing keeps filaments razor sharp ...
  float h = uH0 * clamp(rq, 0.14, 1.8) * pow(float(uK), -0.3333);
  // the primordial fog is silky; the universe comes into focus as structure forms
  h *= 1.0 + 1.3 * uSeedMix;
  // ... but once the local sample spacing is resolved on screen (close-ups, inside a cluster) the kernels
  // must overlap like a proper SPH projection (diameter ≈ 2.6 spacings), or the gas breaks into discs
  float kc = pow(float(uK), 0.3333);
  float sp = uSpacing * clamp(rq, 0.1, 2.5) / kc;
  float spPx = sp * uPxScale / (d * uDpr);           // CSS px: the same look on 1× and 3× screens
  // (only collapsed matter — filaments, halos: void and sheet tracers stay fine dust, their haze comes
  // from the composite's sparse-region kernel and never lifts above black)
  // (kernels about one spacing wide are the worst of both worlds — Poisson blotches — so the switch from
  // sub-spacing dust to full SPH overlap happens over a short range)
  float res = smoothstep(4.0, 8.0, spPx) * smoothstep(2.0, 8.0, rho);
  // at that point the Lagrangian sheet tracers are redundant: their mass returns to the parent particle
  // (saves most of the fill rate of big close-up sprites)
  float kt = smoothstep(6.0, 12.0, spPx) * smoothstep(2.0, 8.0, rho) * uKt;
  h = max(h, sp * mix(1.0, kc, kt) * uSph * res);
  float mw = sub > 0 ? 1.0 - kt : 1.0 + float(uK - 1) * kt;
  if (mw <= 0.001) { ${OFF} return; }
  float px = h * uPxScale / d;
  float coc = uCoc * abs(1.0 - uFocus / d);
  float R = 0.5 * sqrt(px * px + coc * coc);       // kernel radius, px
  // anti-aliased splat: the Gaussian is evaluated in true sub-pixel distance and never narrower than
  // σ ≈ 0.45 px, so every sprite deposits the same flux wherever it lands (no lattice moiré, no shimmer)
  R = max(R, 1.1);
  float sz = min(2.0 * 1.2 * R + 1.0, uMaxPx);
  // flux of a sample ∝ mass/d² (surface brightness is distance invariant); per-pixel peak of a unit-flux
  // Gaussian exp(-3 r²/R²) is 3 / (π R² (1 − e⁻³))
  float w = uMass * (uPxScale / d) * (uPxScale / d) * mw / float(uK) * 3.0 / (3.1415927 * R * R * 0.9502);
  // a kernel larger than the sprite limit (a clump right in front of the lens) becomes a faint bokeh disc:
  // drawn at the limit with its surface brightness further dimmed by the size ratio
  float Rc = (sz - 1.0) / 2.4;
  if (R > Rc) { w *= Rc / R; R = Rc; }
  gl_PointSize = sz;
  vK = vec2(0.5 * sz, 1.0 / R);
  // fade: distance attenuation, the wrap sphere edge, and foreground matter in front of the focus
  w *= exp(-max(0.0, d - 0.75 * uFocus) / uFog) * smoothstep(uFade, uFade * 0.72, wv.w) * smoothstep(0.3, 3.0, d) * smoothstep(0.08, 0.4, d / uFocus);
  // voids are nearly empty in reality; tracer particles left there are dimmed further (OLED black)
  w *= mix(0.3, 1.0, smoothstep(0.12, 1.2, rho));
  // opening: the primordial fog carries its seed ripples visibly (weight ∝ ρ_seed^1.5)
  w *= mix(1.0, pow(max(rho, 0.05), 1.5), uSeedMix);
  // colour channel: mass-weighted local density (Springel-style), 0 at ρ = 0.3 … 1 at ρ ≈ 3000
  float hue = clamp((log2(rho) + 1.7) / 13.2, 0.0, 1.0);
  float heat = texelFetch(tAux, tc, 0).x;
  vW = w * vec3(1.0, hue, heat);
}
`;
const ACC_FRAG = S.GLSL_HEAD + /* glsl */`
in vec3 vW;
in vec2 vK;
layout(location = 0) out vec4 o;
void main() {
  // exact sub-pixel offset of this fragment from the (unsnapped) sprite centre, in kernel radii
  vec2 c = (gl_PointCoord * 2.0 - 1.0) * vK.x * vK.y;
  float r2 = dot(c, c);
  if (r2 > 1.44) discard;
  o = vec4(vW * exp(-3.0 * r2), 0.0);
}
`;

// ------------------------------------------------------------------ composite (ShaderMaterial, HDR)
const COMP_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const COMP_FRAG = /* glsl */`
#include <rv_common>
uniform sampler2D tAccum;
uniform vec2 uTexel;
uniform float uSigma0;    // column density at which the ramp starts to lift
uniform float uGain;
uniform float uHeatGain;
uniform float uDawn;      // 0..1 early-universe warm glow
uniform float uStream;
uniform float uToe;
uniform float uBright;
uniform float uWide;      // sparse-region kernel radius scale (accumulation texels)
uniform float uToeW;      // width of the toe (log2 units)
uniform float uKnee;      // highlight knee (log2 units)
varying vec2 vUv;
// 2D colour map: brightness from log column density l, hue from mass-weighted log density t.
// t low (voids, sheets): ink → blue-violet;  t mid (filaments): violet → magenta;
// t high (halos, shock-heated cluster gas): ember → orange → white-gold.
vec3 hueRamp(float t) {
  vec3 c = mix(vec3(0.24, 0.20, 0.95), vec3(0.46, 0.24, 1.00), smoothstep(0.10, 0.30, t));
  c = mix(c, vec3(0.95, 0.28, 0.85), smoothstep(0.28, 0.48, t));
  c = mix(c, vec3(1.00, 0.36, 0.22), smoothstep(0.46, 0.62, t));
  c = mix(c, vec3(1.00, 0.72, 0.36), smoothstep(0.60, 0.78, t));
  c = mix(c, vec3(1.00, 0.95, 0.85), smoothstep(0.78, 0.95, t));
  return c;
}
vec4 tap(vec2 o) { return texture2D(tAccum, vUv + o * uTexel); }
void main() {
  // splats are anti-aliased at deposit time, so dense filaments and nodes use the raw column density
  vec4 a = tap(vec2(0.0));
  // density-adaptive smoothing: only the sparsest regions (void tracers, the faint outskirts of sheets)
  // are resolved with a wider kernel — an 8-tap golden-angle spiral rotated per pixel (IGN), so the
  // taps never form a coherent lattice (no crosshatch) whatever the accumulation resolution
  float ang = rv_ign(gl_FragCoord.xy) * 6.2831853;
  vec4 wide = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    float fi = float(i) + 0.5;
    float th = ang + fi * 2.3999632;
    wide += tap(vec2(cos(th), sin(th)) * (1.2 + 3.6 * sqrt(fi / 8.0)) * uWide);
  }
  wide = wide * (0.7 / 8.0) + a * 0.3;
  float la = log2(1.0 + max(a.r, 0.0) / uSigma0) * uGain;
  a = mix(wide, a, smoothstep(uToe - 0.2, uToe + 1.4, la));
  float S = max(a.r, 0.0);
  float l = log2(1.0 + S / uSigma0) * uGain;
  float t = clamp(a.g / max(S, 1e-6), 0.0, 1.0);
  float heat = clamp(a.b / max(S, 1e-6), 0.0, 1.0);
  // brightness: soft toe to pure black, then ~exponential in l (HDR highlights feed the bloom)
  // above the measured highlight knee growth slows (a cluster core filling the screen keeps its gradient
  // instead of clipping to a flat white disc)
  float lk = min(l, uKnee) + max(l - uKnee, 0.0) * 0.35;
  float b = smoothstep(uToe, uToe + uToeW, l) * uBright * exp2(0.92 * lk);
  vec3 col = hueRamp(clamp(t * uHeatGain, 0.0, 1.0)) * b;
  // shock-heated intracluster gas (TNG-style temperature): magenta rim → orange → gold core
  vec3 hot = mix(vec3(1.0, 0.25, 0.55), vec3(1.0, 0.55, 0.18), smoothstep(0.2, 0.6, heat));
  hot = mix(hot, vec3(1.0, 0.82, 0.5), smoothstep(0.6, 1.0, heat));
  float hb = uStream * smoothstep(0.0, 0.5, heat) * smoothstep(uToe - 0.5, uToe + 2.5, l) * uBright * exp2(0.92 * lk + 0.6);
  col = mix(col, hot * max(b, hb), smoothstep(0.02, 0.55, heat) * 0.85);
  // cosmic dawn: before the first stars the whole fog glows a faint ember
  col *= mix(vec3(1.0), vec3(1.9, 0.95, 0.55), uDawn);
  col += (rv_ign(gl_FragCoord.xy) - 0.5) * 0.0025;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// ------------------------------------------------------------------ levels (auto black point)
// Tiny downsample of the column density (4 jittered taps per texel) read back every few frames: the
// composite's black point and highlight shoulder follow measured percentiles of what is on screen.
const LEVELS_FRAG = S.GLSL_HEAD + /* glsl */`
uniform sampler2D tAccum;
uniform vec2 uSize;
layout(location = 0) out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize, e = 0.25 / uSize;
  float r = texture(tAccum, uv + vec2(e.x, e.y)).r + texture(tAccum, uv + vec2(-e.x, e.y)).r
          + texture(tAccum, uv + vec2(e.x, -e.y)).r + texture(tAccum, uv - e).r;
  o = vec4(0.25 * r, 0.0, 0.0, 1.0);
}
`;

// ------------------------------------------------------------------ galaxies
const GAL_VERT = HEAD + /* glsl */`
in vec4 aG;      // host particle id, luminosity, ignition growth factor, kind (0 central 1 satellite 2 dwarf 3 BCG)
in vec4 aH;      // seed, environment, morphology (0 elliptical, 1 disc, 2 irregular), highlight
uniform sampler2D tPos;
uniform float uGalGain;
uniform float uFog;
uniform float uMaxPx;
uniform float uHover;     // id of hovered galaxy (-1 none)
uniform float uFocus;
out vec3 vCol;
out vec4 vShape;          // cos, sin of major axis, axis ratio, morphology
out float vSize;          // physical radius in px
out float vSeed;
void main() {
  int id = int(aG.x + 0.5);
  ivec3 L = cwLatticeFromId(id);
  vec3 x = texelFetch(tPos, cwAtlas(L), 0).xyz;
  float ign = smoothstep(aG.z, aG.z * 2.2, uD1);
  if (ign <= 0.0) { ${OFF} return; }
  vec4 wv = cwView(x);
  if (wv.w > uFade) { ${OFF} return; }
  vec4 v = viewMatrix * vec4(wv.xyz, 1.0);
  float d = -v.z;
  if (d < 0.02) { ${OFF} return; }
  gl_Position = projectionMatrix * v;
  float fade = smoothstep(uFade, uFade * 0.75, wv.w) * exp(-max(0.0, d - 0.75 * uFocus) / (uFog * 1.6));
  float flux = aG.y * ign * 900.0 / (d * d + 100.0);
  float I = 12.0 * pow(flux, 0.6) * uGalGain * fade;
  // physical size: ~15-45 kpc discs, bigger for giants
  float rPhys = (0.012 + 0.03 * sqrt(aG.y)) * (aG.w > 2.5 ? 1.8 : 1.0);
  float pxPhys = rPhys * uPxScale / d;
  float szp = 2.5 + 2.2 * sqrt(min(I, 6.0));
  float sz = clamp(max(szp, pxPhys * 2.6), 2.5, uMaxPx);
  // resolved galaxies spread their light over their disc (surface brightness is conserved)
  I = min(I, 6.0) * min(1.0, (szp * szp) / (sz * sz) * 3.0);
  gl_PointSize = sz;
  vSize = pxPhys / sz;
  // colour: red-sequence gold in clusters, blue cloud in the field, bluer still when young
  vec3 gold = vec3(1.0, 0.74, 0.46), white = vec3(0.92, 0.92, 1.0), blue = vec3(0.62, 0.74, 1.0);
  float red = clamp(0.35 + 0.25 * aH.y, 0.0, 1.0);
  red = aG.w > 2.5 ? 1.0 : (aG.w > 0.5 && aG.w < 1.5 ? max(red, 0.7) : red);
  vec3 c = mix(mix(blue, white, 0.5 + 0.5 * red), gold, red * red);
  c = mix(blue, c, smoothstep(0.25, 0.8, uD1));
  vCol = c * I * (1.0 + 2.0 * step(abs(aG.x - uHover), 0.5));
  // orientation of the disc on screen from a random 3D spin axis
  vec3 hs = cwHash3(L + ivec3(3, 5, 11)) * 2.0 - 1.0;
  vec3 nv = mat3(viewMatrix) * normalize(hs + vec3(1e-3));
  float q = max(abs(nv.z), aH.z < 0.5 ? 0.55 + 0.4 * abs(hs.x) : 0.08);
  vec2 ax = normalize(vec2(-nv.y, nv.x) + 1e-4);
  vShape = vec4(ax, q, aH.z);
  vSeed = aH.x;
}
`;
const GAL_FRAG = S.GLSL_HEAD + /* glsl */`
in vec3 vCol;
in vec4 vShape;
in float vSize;
in float vSeed;
layout(location = 0) out vec4 o;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  c.y = -c.y;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  // point-source core + soft halo (reads as a star-like pinpoint at distance)
  float core = exp(-r2 * 26.0) + 0.16 * exp(-r2 * 5.0);
  float res = smoothstep(0.08, 0.3, vSize);
  float shape = 0.0;
  if (res > 0.0) {
    // resolved: project into the disc frame
    vec2 u = vec2(dot(c, vShape.xy), dot(c, vec2(-vShape.y, vShape.x))) / max(vSize, 1e-3);
    u.y /= vShape.z;
    float r = length(u);
    if (vShape.w < 0.5) {
      shape = exp(-pow(r * 2.4, 0.8) * 3.0);                 // de Vaucouleurs-ish elliptical
    } else {
      float th = atan(u.y, u.x);
      float arms = 0.5 + 0.5 * cos(2.0 * th - 5.5 * log(max(r, 0.03)) + vSeed * 6.2831);
      float disc = exp(-r * 3.2) * (0.35 + 0.9 * pow(arms, 3.0)) * smoothstep(1.05, 0.6, r);
      float bulge = exp(-r * r * 60.0) * 2.2;
      shape = disc + bulge;
      if (vShape.w > 1.5) shape = exp(-r * 2.6) * (0.5 + 0.5 * sin(u.x * 9.0 + vSeed * 20.0) * sin(u.y * 7.0));
    }
    shape *= 1.6;
  }
  float k = mix(core, shape + 0.4 * exp(-r2 * 60.0), res);
  o = vec4(vCol * k, 0.0);
}
`;

// ------------------------------------------------------------------ hover ring (screen-space)
const RING_VERT = /* glsl */`
uniform vec3 uPos;       // camera-relative world position
uniform float uSize;     // px
uniform float uPixelRatio;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(uPos, 1.0);
  gl_PointSize = uSize * uPixelRatio;
}
`;
const RING_FRAG = /* glsl */`
uniform float uAlpha;
uniform float uSize;
uniform float uTime;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  float px = 2.0 / max(uSize, 8.0);
  float ring = smoothstep(px * 1.6, 0.0, abs(r - 0.82));
  float ang = atan(c.y, c.x) + uTime * 0.35;
  float ticks = smoothstep(0.93, 0.99, abs(cos(ang * 2.0))) * smoothstep(px * 2.0, 0.0, abs(r - 0.93)) ;
  float dash = 0.55 + 0.45 * step(0.0, sin(ang * 24.0));
  float a = (ring * dash + ticks) * uAlpha;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * a * 1.4, 1.0);
}
`;

// ------------------------------------------------------------------ gather (picking)
const GATHER_FRAG = HEAD + /* glsl */`
uniform sampler2D tList;
layout(location = 0) out vec4 o;
void main() {
  vec4 e = texelFetch(tList, ivec2(gl_FragCoord.xy), 0);
  if (e.x < 0.0) { o = vec4(0.0); return; }
  int id = int(e.x + 0.5);
  ivec3 L0 = cwLatticeFromId(id);
  vec4 A, B;
  vec3 x0 = cwPosition(cwAtlas(L0), L0, A, B);
  if (e.y < 0.5) { o = vec4(x0 + cwOrbit(L0, cwDensity(x0, A)), 1.0); return; }
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 27; k++) {
    ivec3 of = ivec3(k % 3, (k / 3) % 3, k / 9) - 1;
    ivec3 L = (L0 + of * 2 + uN) % uN;
    vec3 x = cwPosition(cwAtlas(L), L, A, B);
    vec3 d = x - x0; d -= floor(d + 0.5);
    acc += d;
  }
  vec3 xc = x0 + acc / 27.0;
  // w = density at the core (hero framing picks the most massive *final* halo, not the highest linear peak)
  float ec = 1.0 / float(uN);
  float rho = cwField(xc).x + 0.5 * (cwField(xc + vec3(ec, 0.0, 0.0)).x + cwField(xc - vec3(ec, 0.0, 0.0)).x
            + cwField(xc + vec3(0.0, ec, 0.0)).x + cwField(xc - vec3(0.0, ec, 0.0)).x
            + cwField(xc + vec3(0.0, 0.0, ec)).x + cwField(xc - vec3(0.0, 0.0, ec)).x);
  o = vec4(xc, uFieldOn > 0.5 ? rho / 4.0 : 0.0);
}
`;

export class CosmicRenderer {
  /**
   * @param {object} engine
   * @param {import('./sim.js').CosmicSim} sim
   * @param {object} opt  { L, subFrac, drawCount, h0, maxPx, accumScale }
   */
  constructor(engine, sim, opt) {
    this.engine = engine;
    this.r = engine.renderer;
    this.sim = sim;
    this.opt = opt;
    const accType = sim.floatBlend ? THREE.FloatType : THREE.HalfFloatType;
    let maxPt = 64;
    try { const gl = this.r.getContext(); maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)?.[1] || 64; } catch (_) { /* keep default */ }
    this.maxPoint = maxPt;
    this.accScale = opt.accumScale ?? 1;
    this.accum = new THREE.WebGLRenderTarget(4, 4, {
      type: accType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    // render-time uniforms (shared objects with the sim's atlas/texture uniforms)
    const U = this.U = {
      ...sim.U, uM: { value: sim.N }, uMTiles: { value: sim.tilesX },
      uD1: { value: 0 }, uD2: { value: 0 }, uDS: { value: 0 }, uG: { value: 0 },
      tFieldA: { value: sim.fields[0].texture }, tFieldB: { value: sim.fields[1].texture },
      uFieldSize: { value: new THREE.Vector2(sim.FW, sim.FH) }, uFieldMix: { value: 0 }, uFieldOn: { value: 0 },
      uWrapC: { value: new THREE.Vector3() }, uCamOff: { value: new THREE.Vector3() },
      uL: { value: opt.L }, uFade: { value: 0.48 }, uPxScale: { value: 500 }, uTime: { value: 0 },
      uOrbit: { value: 0.0035 }, uSigGlow: { value: 1 }, uSeedD: { value: 0 }, uSeedMix: { value: 1 },
      uFog: { value: opt.fog ?? 150 },
    };
    // resolved particle positions (one texel per particle)
    this.posRT = new THREE.WebGLRenderTarget(sim.W, sim.H, {
      type: sim.floatRT ? THREE.FloatType : THREE.HalfFloatType, depthBuffer: false, count: 2,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    this.resolveMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: S.GLSL_HEAD + S.FS_VERT, fragmentShader: RESOLVE_FRAG,
      uniforms: { ...U, uHeatLo: { value: 12 }, uHeatHi: { value: 90 } }, depthTest: false, depthWrite: false,
    });
    U.tPos = { value: this.posRT.textures[0] };
    U.tAux = { value: this.posRT.textures[1] };
    // accumulation layer
    this.accMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: ACC_VERT, fragmentShader: ACC_FRAG, ...ADD,
      uniforms: {
        ...U, uPxScale: { value: 500 }, uK: { value: opt.K }, uMass: { value: Math.pow(opt.L / sim.N / 2, 3) }, uH0: { value: opt.h0 }, uMaxPx: { value: Math.min(opt.maxPx, maxPt) },
        uFocus: { value: 80 }, uCoc: { value: 0 }, uSpacing: { value: opt.L / sim.N }, uSph: { value: opt.sph ?? 2.6 }, uKt: { value: opt.kt ?? 1 }, uDpr: { value: 1 },
      },
    });
    const g = new THREE.BufferGeometry();
    g.setDrawRange(0, opt.drawCount * opt.K);
    this.accPts = new THREE.Points(g, this.accMat);
    this.accPts.frustumCulled = false;
    this.accScene = new THREE.Scene();
    this.accScene.add(this.accPts);

    // composite quad (lives in the mode scene so the HDR pipeline blooms/tonemaps it)
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: COMP_VERT, fragmentShader: COMP_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tAccum: { value: this.accum.texture }, uTexel: { value: new THREE.Vector2(1, 1) },
        uSigma0: { value: 3.0 }, uGain: { value: 1.0 }, uHeatGain: { value: 1.0 }, uDawn: { value: 0 }, uStream: { value: 1.0 }, uToe: { value: 0.9 }, uBright: { value: 0.05 }, uWide: { value: 1 }, uToeW: { value: 1.9 }, uKnee: { value: 99 },
      },
    });
    this.comp = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compMat);
    this.comp.frustumCulled = false;
    this.comp.renderOrder = -10;

    // galaxies (added once the catalog arrives)
    this.galaxies = null;
    this.galMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: GAL_VERT, fragmentShader: GAL_FRAG, ...ADD,
      uniforms: { ...U, uPxScale: { value: 500 }, uFocus: { value: 80 }, uGalGain: { value: 1.0 }, uMaxPx: { value: Math.min(160, maxPt) }, uHover: { value: -1 } },
    });

    // hover ring
    this.ringMat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT, fragmentShader: RING_FRAG, ...ADD,
      uniforms: { uPos: { value: new THREE.Vector3() }, uSize: { value: 40 }, uAlpha: { value: 0 }, uTime: U.uTime, uPixelRatio: { value: 1 } },
    });
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.ring = new THREE.Points(rg, this.ringMat);
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 10;

    // gather (picking positions)
    this.gatherSize = 64;
    this.gatherList = new Float32Array(this.gatherSize * this.gatherSize * 4).fill(-1);
    this.gatherTex = new THREE.DataTexture(this.gatherList, this.gatherSize, this.gatherSize, THREE.RGBAFormat, THREE.FloatType);
    this.gatherTex.needsUpdate = true;
    this.gatherRT = new THREE.WebGLRenderTarget(this.gatherSize, this.gatherSize, {
      type: sim.floatRT ? THREE.FloatType : THREE.HalfFloatType, depthBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    this.gatherMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: S.GLSL_HEAD + S.FS_VERT, fragmentShader: GATHER_FRAG,
      uniforms: { ...U, tList: { value: this.gatherTex } }, depthTest: false, depthWrite: false,
    });
    this.gatherOut = new Float32Array(this.gatherSize * this.gatherSize * 4);
    // levels: 128×72 column-density thumbnail (float readback only)
    this.levels = null;
    if (sim.floatRT) {
      this.lvW = 128; this.lvH = 72;
      this.lvRT = new THREE.WebGLRenderTarget(this.lvW, this.lvH, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.lvMat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: S.GLSL_HEAD + S.FS_VERT, fragmentShader: LEVELS_FRAG,
        uniforms: { tAccum: { value: this.accum.texture }, uSize: { value: new THREE.Vector2(this.lvW, this.lvH) } }, depthTest: false, depthWrite: false,
      });
      this.lvBuf = new Float32Array(this.lvW * this.lvH * 4);
      this.lvSort = new Float32Array(this.lvW * this.lvH);
      this._lvReading = false;
    }
    this.gatherCount = 0;
    this._reading = false;
  }

  /** Galaxy catalog → instanced point attributes. */
  setGalaxies(cat, morph) {
    const n = cat.count;
    const aG = new Float32Array(n * 4), aH = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      aG[i * 4] = cat.host[i]; aG[i * 4 + 1] = cat.lum[i]; aG[i * 4 + 2] = cat.dign[i]; aG[i * 4 + 3] = cat.kind[i];
      aH[i * 4] = ((i * 0.6180339887) % 1); aH[i * 4 + 1] = cat.env[i]; aH[i * 4 + 2] = morph[i]; aH[i * 4 + 3] = 0;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('aG', new THREE.BufferAttribute(aG, 4));
    g.setAttribute('aH', new THREE.BufferAttribute(aH, 4));
    // Points need a 'position' count for the draw call; aG provides the vertex count via drawRange
    g.setDrawRange(0, n);
    this.galaxies = new THREE.Points(g, this.galMat);
    this.galaxies.frustumCulled = false;
    this.galaxies.renderOrder = 5;
    return this.galaxies;
  }

  setSize(w, h) {
    const s = this.accScale;
    const aw = Math.max(4, Math.round(w * s)), ah = Math.max(4, Math.round(h * s));
    this.accum.setSize(aw, ah);
    this.compMat.uniforms.uTexel.value.set(1 / aw, 1 / ah);
    this.accW = aw; this.accH = ah;
  }

  /** Accumulate particles into the offscreen density target. */
  renderAccum(camera) {
    const r = this.r;
    const prev = r.getRenderTarget(), autoClear = r.autoClear;
    const cc = r.getClearColor(_cc), ca = r.getClearAlpha();
    try {
      r.autoClear = false;
      this.sim.quad.material = this.resolveMat;
      r.setRenderTarget(this.posRT);
      r.render(this.sim.qScene, this.sim.qCam);
      r.setRenderTarget(this.accum);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
      r.render(this.accScene, camera);
    } finally {
      r.autoClear = autoClear; r.setClearColor(cc, ca); r.setRenderTarget(prev);
    }
  }

  /**
   * Measure the accumulated column density (call right after renderAccum). Calls cb(sortedΣ) with the
   * ascending column densities of a 128×72 thumbnail; async readback unless sync.
   */
  measureLevels(cb, sync = false) {
    if (!this.lvRT || this._lvReading) return;
    const r = this.r, prev = r.getRenderTarget(), sim = this.sim;
    try {
      sim.quad.material = this.lvMat;
      r.setRenderTarget(this.lvRT);
      r.render(sim.qScene, sim.qCam);
    } finally { r.setRenderTarget(prev); }
    const done = () => {
      const b = this.lvBuf, o = this.lvSort;
      for (let i = 0, n = o.length; i < n; i++) o[i] = b[i * 4];
      o.sort();
      cb(o);
    };
    try {
      if (!sync && r.readRenderTargetPixelsAsync) {
        this._lvReading = true;
        r.readRenderTargetPixelsAsync(this.lvRT, 0, 0, this.lvW, this.lvH, this.lvBuf)
          .then(() => { this._lvReading = false; done(); })
          .catch(() => { this._lvReading = false; });
      } else {
        r.readRenderTargetPixels(this.lvRT, 0, 0, this.lvW, this.lvH, this.lvBuf);
        done();
      }
    } catch (e) { this._lvReading = false; }
  }

  /** Set the list of particles whose positions we want back: [{id, mode}] (mode 1 = cluster core). */
  setGatherList(list) {
    const L = this.gatherList;
    L.fill(-1);
    const n = Math.min(list.length, this.gatherSize * this.gatherSize);
    for (let i = 0; i < n; i++) { L[i * 4] = list[i].id; L[i * 4 + 1] = list[i].mode; }
    this.gatherTex.needsUpdate = true;
    this.gatherCount = n;
  }

  /** Run the gather pass; read back (async where available). Calls cb(Float32Array) when done. */
  gather(cb, sync = false) {
    if (!this.gatherCount || this._reading) return;
    const r = this.r, prev = r.getRenderTarget();
    const sim = this.sim;
    sim.quad.material = this.gatherMat;
    r.setRenderTarget(this.gatherRT);
    r.render(sim.qScene, sim.qCam);
    r.setRenderTarget(prev);
    const rows = Math.ceil(this.gatherCount / this.gatherSize);
    const out = this.gatherOut;
    try {
      if (!sync && r.readRenderTargetPixelsAsync) {
        this._reading = true;
        r.readRenderTargetPixelsAsync(this.gatherRT, 0, 0, this.gatherSize, rows, out)
          .then(() => { this._reading = false; cb(out); })
          .catch(() => { this._reading = false; });
      } else {
        r.readRenderTargetPixels(this.gatherRT, 0, 0, this.gatherSize, rows, out);
        cb(out);
      }
    } catch (e) { this._reading = false; }
  }

  dispose() {
    this.accum.dispose(); this.posRT.dispose(); this.resolveMat.dispose(); this.accMat.dispose(); this.accPts.geometry.dispose();
    this.compMat.dispose(); this.comp.geometry.dispose();
    this.galMat.dispose(); this.galaxies?.geometry.dispose();
    this.ringMat.dispose(); this.ring.geometry.dispose();
    this.gatherTex.dispose(); this.gatherRT.dispose(); this.gatherMat.dispose();
    this.lvRT?.dispose(); this.lvMat?.dispose();
  }
}
