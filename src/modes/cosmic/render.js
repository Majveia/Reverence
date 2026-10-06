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
uniform float uSlab;      // 0..1 depth-slab weighting around the focus (young web)
float cwSlab(float d, float focus) { float u = (d - focus) / (0.42 * focus); return mix(1.0, exp(-u * u), uSlab); }
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
uniform float uAniso;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oAux;   // heat, speed, J·Jᵀ xz, yz
layout(location = 2) out vec4 oCov;   // J·Jᵀ xx, yy, zz, xy (lattice spacings²)
// Lagrangian edge: central difference of the positions of two lattice neighbours (box units per step)
vec3 cwEdge(ivec3 L, ivec3 e) {
  ivec3 Lp = (L + e) % uN, Lm = (L - e + uN) % uN;
  vec4 A1, B1;
  vec3 d = cwPosition(cwAtlas(Lp), Lp, A1, B1) - cwPosition(cwAtlas(Lm), Lm, A1, B1);
  return 0.5 * (d - floor(d + 0.5));
}
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  ivec3 L = cwLatticeFromTexel(tc);
  vec4 A, B;
  vec3 x = cwPosition(tc, L, A, B);
  float rho = cwDensity(x, A);
  // Lagrangian deformation J = ∂x/∂q of this particle's lattice cell (the dark-matter sheet): its image
  // J·Jᵀ is the covariance of the cell in Eulerian space — needle-thin across a filament, long along it.
  // The accumulation uses it for anisotropic smoothing kernels in close-ups (Shapiro+ 1996 ASPH in spirit).
  vec3 Cd = vec3(1.0), Co = vec3(0.0);
  if (uAniso > 0.0) {
    vec3 ex = cwEdge(L, ivec3(1, 0, 0)) * float(uN), ey = cwEdge(L, ivec3(0, 1, 0)) * float(uN), ez = cwEdge(L, ivec3(0, 0, 1)) * float(uN);
    Cd = vec3(ex.x * ex.x + ey.x * ey.x + ez.x * ez.x, ex.y * ex.y + ey.y * ey.y + ez.y * ez.y, ex.z * ex.z + ey.z * ey.z + ez.z * ez.z);
    Co = vec3(ex.x * ex.y + ey.x * ey.y + ez.x * ez.y, ex.x * ex.z + ey.x * ey.z + ez.x * ez.z, ex.y * ex.z + ey.y * ey.z + ez.y * ez.z);
  }
  oCov = vec4(Cd, Co.x);
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
  // temperature proxy (virial scaling T ∝ M^(2/3) ∝ ρ_smoothed over the halo): log-scaled so the warm-hot
  // filament gas (WHIM), group outskirts, shocked cluster gas and the hot core sit on distinct stops of the
  // ramp instead of saturating together — only the innermost core reaches the white-hot end
  float heat = clamp(log2(max(rs, 1e-3) / uHeatLo) / log2(uHeatHi / uHeatLo), 0.0, 1.0);
  heat *= heat * (3.0 - 2.0 * heat) * 0.35 + heat * 0.65;
  vec3 P = texelFetch(tP, tc, 0).xyz;
  oAux = vec4(heat, clamp(length(P) * 60.0, 0.0, 1.0), Co.y, Co.z);
}
`;

const ACC_VERT = HEAD + /* glsl */`
uniform int uK;           // sprites per particle: 1 = particle only, 2-4 adds points on the Lagrangian sheet
uniform sampler2D tPos;   // resolved positions (xyz) + density (w)
uniform sampler2D tAux;   // heat, speed, J·Jᵀ xz, yz
uniform sampler2D tCov;   // J·Jᵀ xx, yy, zz, xy
uniform float uAniso;     // 0..1 anisotropic (Lagrangian-cell) kernels in the resolved regime
uniform float uAspect;    // max axis ratio of anisotropic kernels
uniform float uEarly;     // extra kernel width while the web is young
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
uniform float uVeilOn, uVeilLo, uVeilHi;   // particle share of the matter (rest: ray-marched veil)
uniform float uEm;        // emission exponent: sample weight ∝ ρ^uEm (0 = mass, 0.5 ≈ ρ^1.5 emissivity)
out vec4 vW;
out vec4 vQ;              // sprite half-size (px), inverse screen covariance (xx, xy, yy) in px⁻²
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
  // (and while the web is still young — z ≳ 2 — the render resolution follows the linear scale: smooth
  // wrinkles instead of shot-noise mottling)
  h *= 1.0 + 0.7 * uSeedMix + uEarly;
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
  float hIso = max(h, sp * mix(1.0, kc, kt) * uSph * res);
  float mw = sub > 0 ? 1.0 - kt : 1.0 + float(uK - 1) * kt;
  if (mw <= 0.001) { ${OFF} return; }
  float f = uPxScale / d;
  float coc = uCoc * abs(1.0 - uFocus / d);
  // screen covariance (px²) of the Gaussian kernel exp(-½ xᵀΣ⁻¹x); a kernel of diameter h has σ = h/(2√6)
  float sIso = hIso * f * hIso * f / 24.0;
  vec3 S2 = vec3(sIso, 0.0, sIso);
  // resolved filaments and sheets: the kernel takes the shape of the particle's own Lagrangian cell (J·Jᵀ),
  // projected to the screen — matter streams become crisp threads instead of isotropic cotton. Virialised
  // halos (multi-stream, J meaningless) keep the isotropic SPH kernel.
  float an = uAniso * res * (1.0 - smoothstep(25.0, 110.0, rho));
  if (an > 0.001) {
    vec4 c1 = texelFetch(tCov, tc, 0);
    vec2 c2 = texelFetch(tAux, tc, 0).zw;
    mat3 J = mat3(c1.x, c1.w, c2.x, c1.w, c1.y, c2.y, c2.x, c2.y, c1.z);
    float sc = 0.2 * uSph * uSpacing * mix(1.0 / kc, 1.0, kt);
    mat3 R3 = mat3(viewMatrix);
    vec3 m0 = (vec3(1.0, 0.0, v.x / d) * f) * R3;
    vec3 m1 = (vec3(0.0, 1.0, v.y / d) * f) * R3;
    vec3 Jm0 = J * m0, Jm1 = J * m1;
    vec3 Sa = sc * sc * vec3(dot(m0, Jm0), dot(m0, Jm1), dot(m1, Jm1));
    // ASPH-style: the cell supplies the *shape* (orientation, axis ratio ≤ uAspect); the area stays that of
    // the density-based isotropic kernel (multi-stream cells can be much larger than the matter they carry)
    float hd = h * f;
    float sMin = max(hd * hd / 24.0, 0.2025);
    float tr = 0.5 * (Sa.x + Sa.z), df = sqrt(0.25 * (Sa.x - Sa.z) * (Sa.x - Sa.z) + Sa.y * Sa.y);
    float l1 = tr + df, l2 = max(tr - df, 1e-3 * (tr + df) + 1e-12);
    vec2 e1 = abs(Sa.y) > 1e-9 * (abs(Sa.x) + abs(Sa.z) + 1e-20) ? normalize(vec2(Sa.y, l1 - Sa.x)) : (Sa.x >= Sa.z ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
    // (never stretch past the sprite limit: a clamped kernel would lose flux to the bokeh dimming)
    float sLim = (uMaxPx - 1.0) / 5.88; sLim *= sLim;
    float asp = clamp(sqrt(l1 / l2), 1.0, clamp(sLim / max(sIso, 1e-6), 1.0, uAspect));
    l1 = sIso * asp;
    l2 = max(sIso / asp, sMin);
    vec3 Sb = vec3(l1 * e1.x * e1.x + l2 * e1.y * e1.y, (l1 - l2) * e1.x * e1.y, l1 * e1.y * e1.y + l2 * e1.x * e1.x);
    S2 = mix(S2, Sb, an);
  }
  float sc2 = coc * coc / 24.0;
  S2.xz += sc2;
  // anti-aliased splat: the Gaussian is evaluated in true sub-pixel distance and never narrower than
  // σ ≈ 0.45 px, so every sprite deposits the same flux wherever it lands (no lattice moiré, no shimmer)
  float tr2 = 0.5 * (S2.x + S2.z), df2 = sqrt(0.25 * (S2.x - S2.z) * (S2.x - S2.z) + S2.y * S2.y);
  float L1 = max(tr2 + df2, 0.2025), L2 = max(tr2 - df2, 0.2025);
  if (L2 >= L1 * 0.999) { S2 = vec3(L1, 0.0, L1); }
  else {
    vec2 e = abs(S2.y) > 1e-12 ? normalize(vec2(S2.y, tr2 + df2 - S2.x)) : (S2.x >= S2.z ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
    S2 = vec3(L1 * e.x * e.x + L2 * e.y * e.y, (L1 - L2) * e.x * e.y, L1 * e.y * e.y + L2 * e.x * e.x);
  }
  float sz = min(2.0 * 2.94 * sqrt(L1) + 1.0, uMaxPx);
  // flux of a sample ∝ mass/d² (surface brightness is distance invariant); per-pixel peak of a unit-flux
  // Gaussian is 1 / (2π √det Σ) (0.9502: historical truncation constant, part of the calibrated exposure)
  float w = uMass * f * f * mw / float(uK) / (6.2831853 * sqrt(L1 * L2) * 0.9502);
  // a kernel larger than the sprite limit (a clump right in front of the lens) becomes a faint bokeh disc:
  // drawn at the limit with its surface brightness further dimmed by the size ratio
  float Lc = (sz - 1.0) / 5.88; Lc *= Lc;
  if (L1 > Lc) { float k = Lc / L1; w *= sqrt(k); S2 *= k; }
  float det = max(S2.x * S2.z - S2.y * S2.y, 1e-8);
  gl_PointSize = sz;
  vQ = vec4(0.5 * sz, S2.z / det, -S2.y / det, S2.x / det);
  // fade: distance attenuation, the wrap sphere edge, and foreground matter in front of the focus
  w *= exp(-max(0.0, d - 0.75 * uFocus) / uFog) * smoothstep(uFade, uFade * 0.72, wv.w) * smoothstep(0.3, 3.0, d) * smoothstep(0.08, 0.4, d / uFocus);
  w *= cwSlab(d, uFocus);
  // voids are nearly empty in reality; tracer particles left there are dimmed further (OLED black)
  w *= mix(0.3, 1.0, smoothstep(0.12, 1.2, rho));
  // diffuse matter is the ray-marched veil's (smooth partition of unity in ρ, see VEIL_FRAG)
  w *= mix(1.0, smoothstep(uVeilLo, uVeilHi, rho), uVeilOn);
  if (w <= 0.0) { ${OFF} return; }
  // emissivity: the picture is ∫ρ^(1+γ) dl rather than plain column density (like X-ray / Hα emission
  // measure, ∝ ρ²). Evaluated per sample in 3D — before projection — so a stack of faint sheets along the
  // line of sight never adds up to the brightness of one real filament: filaments read as thin bright
  // threads with dim flanks, nodes stand out, sheets stay a faint veil (no cotton-wool overlap)
  w *= pow(clamp(rho * 0.25, 0.05, 60.0), uEm);
  // opening: the primordial fog carries its seed ripples visibly (weight ∝ ρ_seed^1.5)
  w *= mix(1.0, pow(max(rho, 0.05), 1.5), uSeedMix);
  // colour channel: mass-weighted local density (Springel-style), 0 at ρ = 0.3 … 1 at ρ ≈ 3000
  float hue = clamp((log2(rho) + 1.7) / 13.2, 0.0, 1.0);
  float heat = texelFetch(tAux, tc, 0).x;
  // depth channel for aerial perspective: share of the light coming from beyond the focus
  float far = smoothstep(1.0, 2.2, d / uFocus);
  vW = w * vec4(1.0, hue, heat, far);
}
`;
const ACC_FRAG = S.GLSL_HEAD + /* glsl */`
in vec4 vW;
in vec4 vQ;
layout(location = 0) out vec4 o;
void main() {
  // exact sub-pixel offset of this fragment from the (unsnapped) sprite centre (px, y up)
  vec2 c = (gl_PointCoord * 2.0 - 1.0) * vQ.x;
  c.y = -c.y;
  float m = vQ.y * c.x * c.x + 2.0 * vQ.z * c.x * c.y + vQ.w * c.y * c.y;
  if (m > 8.64) discard;
  o = vW * exp(-0.5 * m);
}
`;

// ------------------------------------------------------------------ diffuse matter (ray-marched veil)
// Hybrid rendering: collapsed structure (filaments, halos — ρ ≳ 5) is drawn as particles, the diffuse
// matter (sheets, void walls, the near-uniform primordial fog) is ray-marched through the smooth
// particle-mesh density field (CIC of every particle, 2 Mpc/h). Both deposit the same quantity — emission
// weighted column density, ∫ρ(ρ/4)^γ dl with identical fog / fade / depth weights — and split the matter by
// a smooth partition of unity in ρ, so the sum is the same picture minus the Poisson noise of sparsely
// sampled sheets: silky veils around crisp threads. Rendered at half the accumulation resolution, then
// added into it.
const VEIL_FRAG = HEAD + /* glsl */`
uniform vec2 uProjXY;     // projection matrix [0][0], [1][1]
uniform mat3 uCamRot;     // camera rotation (camera sits at the origin)
uniform vec2 uVeilSize;
uniform int uSteps;
uniform float uVeilLo, uVeilHi, uEm, uFocus, uFog, uVeilGain, uNoise;
layout(location = 0) out vec4 o;
float vh(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  o = vec4(0.0);
  if (uFieldOn < 0.5 || uVeilGain <= 0.0) return;
  vec2 ndc = gl_FragCoord.xy / uVeilSize * 2.0 - 1.0;
  vec3 dv = normalize(vec3(ndc.x / uProjXY.x, ndc.y / uProjXY.y, -1.0));
  vec3 dw = uCamRot * dv;
  float cz = -dv.z;
  // the visible sphere around the wrap centre
  float R = uFade * uL;
  float b = dot(dw, uCamOff), c = dot(uCamOff, uCamOff) - R * R, disc = b * b - c;
  if (disc <= 0.0) return;
  float sq = sqrt(disc);
  float t0 = max(b - sq, 0.3), t1 = b + sq;
  if (t1 <= t0) return;
  float dt = (t1 - t0) / float(uSteps);
  float j = vh(gl_FragCoord.xy + uNoise);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 96; i++) {
    if (i >= uSteps) break;
    float t = t0 + (float(i) + j) * dt;
    vec3 rel = (dw * t - uCamOff) / uL;
    float rho = max(cwField(uWrapC + rel).x, 0.02);
    float keep = 1.0 - smoothstep(uVeilLo, uVeilHi, rho);
    if (keep <= 0.0) continue;
    float d = t * cz;
    // (mean density 1 ↔ 1/8 reference particle per (Mpc/h)³, as the particle splats)
    float w = rho * 0.125 * keep * dt;
    w *= exp(-max(0.0, d - 0.75 * uFocus) / uFog) * smoothstep(uFade, uFade * 0.72, length(rel)) * smoothstep(0.3, 3.0, d) * smoothstep(0.08, 0.4, d / uFocus);
    w *= cwSlab(d, uFocus);
    w *= mix(0.3, 1.0, smoothstep(0.12, 1.2, rho));
    w *= pow(clamp(rho * 0.25, 0.05, 60.0), uEm);
    w *= mix(1.0, pow(rho, 1.5), uSeedMix);
    acc += w * vec4(1.0, clamp((log2(rho) + 1.7) / 13.2, 0.0, 1.0), 0.0, smoothstep(1.0, 2.2, d / uFocus));
  }
  o = acc * uVeilGain;
}
`;
// bilinear upsample of the veil, added into the accumulation target
const VEILADD_FRAG = S.GLSL_HEAD + /* glsl */`
uniform sampler2D tVeil;
uniform vec2 uSize;
layout(location = 0) out vec4 o;
void main() { o = texture(tVeil, gl_FragCoord.xy / uSize); }
`;

// ------------------------------------------------------------------ substructure (accumulation layers)
// Subhalos: every satellite / central galaxy lives in its own dark-matter + gas subhalo, far more
// concentrated than the 2 Mpc/h particle resolution can hold. Each one is deposited as a projected
// Plummer clump (mass ∝ L^0.8, a few particles' worth, core radius ~0.06-0.2 Mpc/h) riding its host
// particle, so it orbits inside the cluster with it. Only drawn once resolved on screen (it is part of the
// particles' light below that); a cluster close-up shows tens of bright sub-clumps instead of a smooth blob.
const SUB_VERT = HEAD + /* glsl */`
in vec4 aG;      // host particle id, luminosity, ignition growth factor, kind
in vec4 aH;      // seed, environment, morphology, rank flag
uniform sampler2D tPos;
uniform sampler2D tAux;
uniform float uMaxPx, uFocus, uMass, uEm, uSubGain, uFog;
out vec4 vW;
out vec2 vQ;     // sprite half-size px, core radius px
void main() {
  int id = int(aG.x + 0.5);
  if (aG.w > 1.5 || uSubGain <= 0.0) { ${OFF} return; }       // dwarfs: too small; BCG: it is the core
  // (subhalos are bound, virialised clumps: they appear only once their host has long collapsed)
  float ign = smoothstep(aG.z * 1.6, aG.z * 3.0, uD1) * smoothstep(0.45, 0.8, uD1);
  if (ign <= 0.0) { ${OFF} return; }
  ivec3 L = cwLatticeFromId(id);
  ivec2 tc = cwAtlas(L);
  vec4 p = texelFetch(tPos, tc, 0);
  // offset from the host particle (sub-particle scale), so a subhalo is not glued to one sprite
  vec3 hs = cwHash3(L + ivec3(41, 7, 19)) - 0.5;
  vec4 wv = cwView(p.xyz + hs * (0.6 / uL));
  if (wv.w > uFade) { ${OFF} return; }
  vec4 v = viewMatrix * vec4(wv.xyz, 1.0);
  float d = -v.z;
  if (d < 0.3) { ${OFF} return; }
  gl_Position = projectionMatrix * v;
  float f = uPxScale / d;
  float lum = max(aG.y, 0.004);
  float m = (aG.w > 0.5 ? 10.0 : 16.0) * pow(lum, 0.8);         // reference (2 Mpc/h lattice) particle masses
  float a = (0.012 + 0.035 * sqrt(lum)) * f;                   // scale radius, px (cuspy: most light inside)
  float res = smoothstep(0.5, 2.0, a);                          // only once resolved
  if (res <= 0.0) { ${OFF} return; }
  float sz = min(2.0 * 5.0 * a + 2.0, uMaxPx);
  a = min(a, (sz - 2.0) / 10.0);
  gl_PointSize = sz;
  vQ = vec2(0.5 * sz, a);
  // flux ∝ m/d²; Σ ∝ (1 + r²/a²)^-1.5 has peak = flux / (2π a²)
  float w = uSubGain * m * f * f / (6.2831853 * a * a) * res * ign;
  w *= exp(-max(0.0, d - 0.75 * uFocus) / uFog) * smoothstep(uFade, uFade * 0.72, wv.w) * smoothstep(0.3, 3.0, d) * smoothstep(0.08, 0.4, d / uFocus);
  float rhoS = max(p.w, 150.0);                                // a bound clump is dense wherever it sits
  w *= pow(clamp(rhoS * 0.25, 0.05, 60.0), uEm);
  float hue = clamp((log2(rhoS) + 1.7) / 13.2, 0.0, 1.0);
  // cooler than the intracluster gas around it: reads as an amber knot inside a white-gold core
  float heat = texelFetch(tAux, tc, 0).x;
  // inside hot cluster gas a subhalo must outshine a much brighter background to be seen at all
  w *= 0.45 + 2.55 * smoothstep(0.4, 0.8, heat);
  heat *= 0.8;
  vW = w * vec4(1.0, hue, heat, smoothstep(1.0, 2.2, d / uFocus));
}
`;
const SUB_FRAG = S.GLSL_HEAD + /* glsl */`
in vec4 vW;
in vec2 vQ;
layout(location = 0) out vec4 o;
void main() {
  vec2 c = (gl_PointCoord * 2.0 - 1.0) * vQ.x;
  float r2 = dot(c, c) / (vQ.y * vQ.y);
  if (r2 > 25.0) discard;
  float k = inversesqrt(1.0 + r2);
  o = vW * max(k * k * k - 0.0075, 0.0);
}
`;

// Accretion shocks: gas falling into a cluster shocks at ~2 virial radii (the bright rims of TNG shock
// maps). One sprite per collapsed cluster deposits a projected thin spherical shell — limb-brightened,
// broken into arcs where filaments feed the cluster (no shock on the inflow), slowly breathing.
const SHELL_VERT = HEAD + /* glsl */`
in vec4 aC;      // centre (box units, from the GPU gather), shell radius (Mpc/h)
in vec4 aD;      // strength (∝ mass), seed, collapse growth factor, -
uniform float uFocus, uEm, uShellGain, uShellMaxPx, uFog;
out vec4 vW;
out vec4 vS;     // sprite half-size px, shell radius px, seed, inner radius fraction
void main() {
  float ign = smoothstep(aD.z * 0.6, aD.z * 1.4, uD1);
  if (ign <= 0.0 || uShellGain <= 0.0 || aC.w <= 0.0) { ${OFF} return; }
  vec4 wv = cwView(aC.xyz);
  if (wv.w > uFade) { ${OFF} return; }
  vec4 v = viewMatrix * vec4(wv.xyz, 1.0);
  float d = -v.z;
  float R = aC.w;
  if (d < R * 1.3) { ${OFF} return; }                          // inside / at the shell: nothing to see
  gl_Position = projectionMatrix * v;
  float f = uPxScale / d;
  float Rpx = R * f;
  float sz = 2.0 * Rpx * 1.14 + 2.0;
  float fit = 1.0 - smoothstep(0.8, 1.0, sz / uShellMaxPx);    // too big for a sprite: fade out
  if (Rpx < 2.5 || fit <= 0.0) { ${OFF} return; }
  gl_PointSize = min(sz, uShellMaxPx);
  float ri = 0.72;
  vS = vec4(0.5 * min(sz, uShellMaxPx), Rpx, aD.y, ri);
  // shell mass (gas at ~15× mean density, thickness 0.14 R) → flux ∝ m/d², spread over the disc
  float m = aD.x * R * R * R;
  float norm = 2.0943951 * (1.0 - ri * ri * ri) / sqrt(1.0 - ri * ri) * Rpx * Rpx;
  float w = uShellGain * m * f * f / norm * ign * fit * smoothstep(2.5, 8.0, Rpx);
  w *= exp(-max(0.0, d - 0.75 * uFocus) / uFog) * smoothstep(uFade, uFade * 0.72, wv.w) * smoothstep(0.08, 0.4, d / uFocus);
  w *= pow(15.0 * 0.25, uEm);
  vW = w * vec4(1.0, 0.52, 0.5, smoothstep(1.0, 2.2, d / uFocus));
}
`;
const SHELL_FRAG = S.GLSL_HEAD + /* glsl */`
uniform float uTime;
in vec4 vW;
in vec4 vS;
layout(location = 0) out vec4 o;
void main() {
  vec2 c = (gl_PointCoord * 2.0 - 1.0) * vS.x;
  c.y = -c.y;
  float th = atan(c.y, c.x);
  float sd = vS.z * 6.2831853;
  // irregular, breathing shock front
  float wob = 1.0 + 0.07 * sin(3.0 * th + sd) + 0.05 * sin(5.0 * th - 2.0 * sd + 0.05 * uTime) + 0.03 * sin(9.0 * th + 3.0 * sd);
  float R = length(c) / (vS.y * wob);
  if (R > 1.0) discard;
  float ri = vS.w;
  float sig = sqrt(max(0.0, 1.0 - R * R)) - sqrt(max(0.0, ri * ri - R * R));
  sig /= sqrt(1.0 - ri * ri);
  // arcs: the shock is broken where cold filaments punch through
  float arc = 0.5 + 0.3 * sin(2.0 * th + 1.7 * sd) + 0.25 * sin(4.0 * th - sd + 0.03 * uTime) + 0.15 * sin(7.0 * th + 2.3 * sd);
  arc = smoothstep(0.2, 1.0, arc);
  o = vW * (sig * arc * 0.9);
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
uniform float uClarity;   // local contrast of log column density (thread-like filaments)
uniform float uClarR;     // its radius, accumulation texels
uniform sampler2D tBlur;  // quarter-res smoothed log column density
uniform vec2 uBlurTexel;
uniform float uSmoothW;  // log2 range above the toe over which sparse regions blend to the smooth field
uniform float uRelief;    // strength of the sculpted (gradient-lit) relief
uniform float uNoiseSeed; // per-frame offset of the kernel rotation noise
varying vec2 vUv;
// 2D colour map: brightness from log column density l, hue from mass-weighted log density t, and a
// TNG-style temperature overlay from the mass-weighted temperature proxy.
// t low (void walls, sheets): cool cyan-blue → indigo;  t mid (filaments): violet → magenta-rose.
uniform float uGamma;     // brightness ∝ (column density)^uGamma above the toe
uniform float uShoulder;  // hue-preserving highlight ceiling (scene-linear, before bloom + tonemap)
uniform float uAerial;    // aerial perspective: matter beyond the focus drifts toward deep blue-violet
vec3 hueRamp(float t) {
  vec3 c = mix(vec3(0.14, 0.50, 1.00), vec3(0.28, 0.36, 1.00), smoothstep(0.08, 0.22, t));
  c = mix(c, vec3(0.50, 0.30, 1.00), smoothstep(0.22, 0.34, t));
  c = mix(c, vec3(0.86, 0.28, 0.96), smoothstep(0.32, 0.46, t));
  c = mix(c, vec3(1.00, 0.30, 0.62), smoothstep(0.46, 0.60, t));
  return c;
}
// temperature: warm-hot filament gas (magenta) → shocked group / cluster outskirts (orange) → amber →
// white-hot only in the innermost cores
vec3 hotRamp(float h) {
  vec3 c = mix(vec3(1.00, 0.22, 0.62), vec3(1.00, 0.36, 0.16), smoothstep(0.18, 0.45, h));
  c = mix(c, vec3(1.00, 0.62, 0.20), smoothstep(0.45, 0.74, h));
  c = mix(c, vec3(1.00, 0.88, 0.66), smoothstep(0.86, 0.99, h));
  return c;
}
vec4 tap(vec2 o) { return texture2D(tAccum, vUv + o * uTexel); }
void main() {
  // splats are anti-aliased at deposit time, so dense filaments and nodes use the raw column density;
  // sparse and mid-density regions (sheets, void walls, filament flanks — a few samples per pixel) blend to
  // the smooth quarter-res field, colours included: soft veils around crisp threads, no sample speckle
  vec4 a = tap(vec2(0.0));
  float la = log2(1.0 + max(a.r, 0.0) / uSigma0) * uGain;
  vec4 bl = texture2D(tBlur, vUv);
  // (decided by the smooth level: an isolated sprite's peak is bright, its neighbourhood is not)
  float wS = smoothstep(uToe - 0.2, uToe + uSmoothW, bl.r * uGain);
  vec3 rat = a.r > 1e-6 ? a.gba / a.r : bl.gba;
  a.r = mix(uSigma0 * (exp2(bl.r) - 1.0), a.r, wS);
  a.gba = mix(bl.gba, rat, wS) * a.r;
  float S = max(a.r, 0.0);
  float l = log2(1.0 + S / uSigma0) * uGain;
  // local contrast ("clarity") in log column density: every filament is compared with its surroundings
  // on the scale of its own width — cores lift, flanks fall toward black, so strands read as crisp
  // threads and cluster haloes show their internal density gradient instead of a flat glow
  // (ring rotated per pixel like the sparse kernel: no tap lattice)
  float relief = 1.0;
  if (uClarity > 0.0 || uRelief > 0.0) {
    float lb = texture2D(tBlur, vUv).r * uGain;
    vec2 gx = vec2(uBlurTexel.x, 0.0), gy = vec2(0.0, uBlurTexel.y);
    // ∇l per accumulation texel (central differences across one quarter-res texel = 4 accumulation texels)
    vec2 gr = vec2(texture2D(tBlur, vUv + gx).r - texture2D(tBlur, vUv - gx).r, texture2D(tBlur, vUv + gy).r - texture2D(tBlur, vUv - gy).r) * (uGain / 8.0);
    float gate = smoothstep(uToe - 0.2, uToe + 1.2, max(l, lb));
    l = max(0.0, l + uClarity * gate * clamp(l - lb, -1.5, 1.5));
    // sculpted relief: log density treated as a height field lit from the upper left — gas clouds and
    // halos read as 3D volumes (the look of volume-rendered TNG50 gas), voids untouched
    vec3 n = normalize(vec3(-gr * uClarR * uRelief, 1.0));
    float sh = dot(n, vec3(-0.45, 0.55, 0.70)) / 0.70;
    // (keeps 40 % in the highlights: with the smooth estimator a cluster core shows its shape, not noise)
    relief = mix(1.0, clamp(sh, 0.35, 1.9), smoothstep(uToe, uToe + 1.5, l) * (1.0 - 0.6 * smoothstep(uKnee - 1.5, uKnee + 0.5, l)));
  }
  float t = clamp(a.g / max(S, 1e-6), 0.0, 1.0);
  float heat = clamp(a.b / max(S, 1e-6), 0.0, 1.0);
  float far = clamp(a.a / max(S, 1e-6), 0.0, 1.0);
  // brightness: soft toe to pure black, then a power law in column density (uGamma > 1 gives filament cores
  // their edge over the flanks); above the measured highlight knee growth slows (a cluster core filling the
  // screen keeps its gradient instead of clipping to a flat disc)
  float lk = min(l, uKnee) + max(l - uKnee, 0.0) * 0.35;
  float b = smoothstep(uToe, uToe + uToeW, l) * uBright * exp2(uGamma * lk);
  vec3 col = hueRamp(clamp(t * uHeatGain, 0.0, 1.0)) * b;
  // shock-heated gas (TNG-style temperature colouring), slightly brighter than the base ramp
  float hw = smoothstep(0.06, 0.42, heat);
  float hb = uStream * smoothstep(uToe - 0.5, uToe + 2.5, l) * uBright * exp2(uGamma * lk + 0.35);
  col = mix(col, hotRamp(heat) * max(b, hb), hw * 0.9);
  // the densest gas at the bottom of a cluster potential is the hottest: past the highlight knee the core
  // whitens toward white-gold (white-hot centre, amber body, magenta rim)
  col = mix(col, vec3(1.0, 0.86, 0.66) * max(col.r, max(col.g, col.b)), smoothstep(uKnee + 2.0, uKnee + 5.5, l) * hw * 0.8);
  col *= relief;
  // aerial perspective: matter behind the focus cools toward a deep blue-violet and dims a little
  float lum = dot(col, vec3(0.3, 0.45, 0.25));
  col = mix(col, vec3(0.30, 0.30, 0.95) * lum * 1.1, far * uAerial) * (1.0 - 0.3 * far * uAerial);
  // hue-preserving highlight shoulder: the brightest channel rolls off smoothly toward uShoulder, so a
  // cluster core keeps its hue and gradient instead of the tonemapper bleaching it to a cream disc
  float mx = max(col.r, max(col.g, col.b));
  float k0 = 0.55 * uShoulder;
  if (mx > k0) { float r = uShoulder - k0; col *= (k0 + r * (1.0 - exp(-(mx - k0) / r))) / mx; }
  // cosmic dawn: before the first stars the fog glows a faint warm violet
  col *= mix(vec3(1.0), vec3(1.5, 0.8, 1.05), uDawn);
  col += (rv_ign(gl_FragCoord.xy) - 0.5) * 0.0025;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// ------------------------------------------------------------------ smooth log-density (clarity / relief)
// Quarter-resolution 4×4 box of log column density (four bilinear taps), upsampled bilinearly by the
// composite: a noise-free local mean and gradient (the earlier per-pixel randomly rotated tap ring printed
// estimator grain into every filament).
const BLUR_FRAG = S.GLSL_HEAD + /* glsl */`
uniform sampler2D tAccum;
uniform vec2 uSrcTexel;
uniform vec2 uSize;
uniform float uSigma0;
layout(location = 0) out vec4 o;
vec4 acc = vec4(0.0);
float lg(vec2 uv) { vec4 a = max(texture(tAccum, uv), 0.0); acc += a; return log2(1.0 + a.r / uSigma0); }
void main() {
  vec2 uv = gl_FragCoord.xy / uSize, e = uSrcTexel;
  float l = lg(uv + vec2(-e.x, -e.y)) + lg(uv + vec2(e.x, -e.y)) + lg(uv + vec2(-e.x, e.y)) + lg(uv + vec2(e.x, e.y));
  // .r mean log column density; .gba mass-weighted hue, temperature and depth share
  o = vec4(0.25 * l, acc.gba / max(acc.r, 1e-6));
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
out float vSpike;         // diffraction-spike share of the sprite (top 1 %), 0 otherwise
void main() {
  int id = int(aG.x + 0.5);
  ivec3 L = cwLatticeFromId(id);
  vec4 hp = texelFetch(tPos, cwAtlas(L), 0);
  vec3 x = hp.xyz;
  float ign = smoothstep(aG.z, aG.z * 2.2, uD1);
  if (ign <= 0.0) { ${OFF} return; }
  vec4 wv = cwView(x);
  if (wv.w > uFade) { ${OFF} return; }
  vec4 v = viewMatrix * vec4(wv.xyz, 1.0);
  float d = -v.z;
  if (d < 0.02) { ${OFF} return; }
  gl_Position = projectionMatrix * v;
  float fade = smoothstep(uFade, uFade * 0.75, wv.w) * exp(-max(0.0, d - 0.75 * uFocus) / (uFog * 1.6));
  // lognormal scatter around the luminosity–host relation (σ ≈ 0.6 dex in flux across the population)
  vec3 hq = cwHash3(L + ivec3(5, 23, 61));
  float gn = sqrt(-2.0 * log(max(hq.x, 1e-4))) * cos(6.2831853 * hq.y);
  float lumS = aG.y * exp(0.75 * clamp(gn, -2.5, 2.5));
  float flux = lumS * ign * 900.0 / (d * d + 100.0);
  float I = 12.0 * pow(flux, 0.6) * uGalGain * fade;
  // field dwarfs trace the web: the ones left in sheets / void walls fade (galaxy bias ∝ density)
  if (aG.w > 1.5 && aG.w < 2.5) I *= smoothstep(0.6, 5.0, hp.w);
  // physical size: ~15-45 kpc discs, bigger for giants
  float rPhys = (0.012 + 0.03 * sqrt(lumS)) * (aG.w > 2.5 ? 1.8 : 1.0);
  float pxPhys = rPhys * uPxScale / d;
  // the brightest 5 % keep a tiny resolved, oriented disc even far away (aH.w ≥ 1)
  float top = step(0.5, aH.w);
  pxPhys = max(pxPhys, top * min(3.2, 0.6 + 0.5 * sqrt(I)));
  float szp = 2.5 + 2.2 * sqrt(min(I, 6.0));
  float sz = clamp(max(szp, pxPhys * 2.6), 2.5, uMaxPx);
  // resolved galaxies spread their light over their disc (surface brightness is conserved)
  I = min(I, 6.0) * min(1.0, (szp * szp) / (sz * sz) * 3.0);
  // the brightest 1 % (aH.w ≥ 2) carry faint diffraction spikes (a lens, not a sim): bigger sprite
  vSpike = 0.0;
  if (aH.w > 1.5 && I > 0.8) { float big = min(uMaxPx, sz * 2.6); vSpike = 1.0 - sz / big; sz = big; }
  gl_PointSize = sz;
  vSize = pxPhys / (sz * (1.0 - vSpike));
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
in float vSpike;
layout(location = 0) out vec4 o;
void main() {
  vec2 c0 = gl_PointCoord * 2.0 - 1.0;
  c0.y = -c0.y;
  // spikes: four thin rays at a fixed instrument angle (like a telescope's), fading along their length
  float spike = 0.0;
  if (vSpike > 0.0) {
    vec2 q = vec2(c0.x * 0.966 - c0.y * 0.259, c0.x * 0.259 + c0.y * 0.966);
    spike = (exp(-abs(q.y) * 90.0) * (1.0 - abs(q.x)) + exp(-abs(q.x) * 90.0) * (1.0 - abs(q.y)));
    spike *= spike * 0.35;
  }
  vec2 c = c0 / max(1.0 - vSpike, 0.05);
  float r2 = dot(c, c);
  if (r2 > 1.0) { if (spike < 0.002) discard; o = vec4(vCol * spike, 0.0); return; }
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
  o = vec4(vCol * (k + spike), 0.0);
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
      uOrbit: { value: 0.0035 }, uSigGlow: { value: 1 }, uSlab: { value: 0 }, uSeedD: { value: 0 }, uSeedMix: { value: 1 },
      uFog: { value: opt.fog ?? 150 }, uAniso: { value: opt.aniso ?? 1 }, uAspect: { value: opt.aspect ?? 5 }, uEarly: { value: 0 },
    };
    // resolved particle positions (one texel per particle)
    this.posRT = new THREE.WebGLRenderTarget(sim.W, sim.H, {
      type: sim.floatRT ? THREE.FloatType : THREE.HalfFloatType, depthBuffer: false, count: 3,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    this.resolveMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: S.GLSL_HEAD + S.FS_VERT, fragmentShader: RESOLVE_FRAG,
      uniforms: { ...U, uHeatLo: { value: 6 }, uHeatHi: { value: 900 } }, depthTest: false, depthWrite: false,
    });
    U.tPos = { value: this.posRT.textures[0] };
    U.tAux = { value: this.posRT.textures[1] };
    U.tCov = { value: this.posRT.textures[2] };
    // accumulation layer
    this.accMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: ACC_VERT, fragmentShader: ACC_FRAG, ...ADD,
      uniforms: {
        ...U, uPxScale: { value: 500 }, uK: { value: opt.K }, uMass: { value: Math.pow(opt.L / sim.N / 2, 3) }, uH0: { value: opt.h0 }, uMaxPx: { value: Math.min(opt.maxPx, maxPt) },
        uFocus: { value: 80 }, uCoc: { value: 0 }, uEm: { value: opt.em ?? 0.5 }, uSpacing: { value: opt.L / sim.N }, uSph: { value: opt.sph ?? 2.6 }, uKt: { value: opt.kt ?? 1 }, uDpr: { value: 1 },
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
        uSigma0: { value: 3.0 }, uGain: { value: 1.0 }, uHeatGain: { value: 1.0 }, uDawn: { value: 0 }, uStream: { value: 1.0 }, uToe: { value: 0.9 }, uBright: { value: 0.05 }, uWide: { value: 1 }, uToeW: { value: 1.9 }, uKnee: { value: 99 }, uGamma: { value: 1.15 }, uShoulder: { value: 1.6 }, uAerial: { value: 0.55 }, uClarity: { value: 0.6 }, uClarR: { value: 5 }, tBlur: { value: null }, uSmoothW: { value: 2.0 }, uBlurTexel: { value: new THREE.Vector2(1, 1) }, uRelief: { value: 0.7 }, uNoiseSeed: { value: 0 },
      },
    });
    this.blurRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.blurMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: S.GLSL_HEAD + S.FS_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
      uniforms: { tAccum: { value: this.accum.texture }, uSrcTexel: { value: new THREE.Vector2(1, 1) }, uSize: { value: new THREE.Vector2(4, 4) }, uSigma0: this.compMat.uniforms.uSigma0 },
    });
    this.compMat.uniforms.tBlur.value = this.blurRT.texture;
    this.comp = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compMat);
    this.comp.frustumCulled = false;
    this.comp.renderOrder = -10;

    // galaxies (added once the catalog arrives)
    this.galaxies = null;
    this.galMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: GAL_VERT, fragmentShader: GAL_FRAG, ...ADD,
      uniforms: { ...U, uPxScale: { value: 500 }, uFocus: { value: 80 }, uGalGain: { value: 1.0 }, uMaxPx: { value: Math.min(160, maxPt) }, uHover: { value: -1 } },
    });

    // ray-marched veil of diffuse matter (half the accumulation resolution)
    const vu = { uVeilOn: { value: 0 }, uVeilLo: { value: opt.veilLo ?? 3.0 }, uVeilHi: { value: opt.veilHi ?? 10.0 } };
    Object.assign(this.accMat.uniforms, vu);
    this.veilSteps = opt.veilSteps ?? 40;
    this.veilRT = new THREE.WebGLRenderTarget(4, 4, { type: accType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.veilMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: S.GLSL_HEAD + S.FS_VERT, fragmentShader: VEIL_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        ...U, uVeilLo: vu.uVeilLo, uVeilHi: vu.uVeilHi, uEm: this.accMat.uniforms.uEm, uFocus: this.accMat.uniforms.uFocus,
        uProjXY: { value: new THREE.Vector2(1, 1) }, uCamRot: { value: new THREE.Matrix3() }, uVeilSize: { value: new THREE.Vector2(4, 4) },
        uSteps: { value: this.veilSteps }, uVeilGain: { value: opt.veilGain ?? 1 }, uNoise: { value: 0 },
      },
    });
    this.veilAddMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: S.GLSL_HEAD + S.FS_VERT, fragmentShader: VEILADD_FRAG, ...ADD,
      uniforms: { tVeil: { value: this.veilRT.texture }, uSize: { value: new THREE.Vector2(4, 4) } },
    });

    // substructure layers (accumulated with the particles): subhalos on galaxies, accretion shocks on clusters
    const au = this.accMat.uniforms;
    this.subMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: SUB_VERT, fragmentShader: SUB_FRAG, ...ADD,
      uniforms: { ...U, uPxScale: au.uPxScale, uMaxPx: au.uMaxPx, uFocus: au.uFocus, uMass: au.uMass, uEm: au.uEm, uSubGain: { value: opt.subGain ?? 1 } },
    });
    this.shellMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG, ...ADD,
      uniforms: { ...U, uPxScale: au.uPxScale, uFocus: au.uFocus, uEm: au.uEm, uShellGain: { value: opt.shellGain ?? 1 }, uShellMaxPx: { value: Math.min(1024, maxPt) } },
    });
    this.subPts = null; this.shells = null;

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
    // rank flags: brightest 5 % → resolved disc sprite (1), brightest 1 % → diffraction spikes too (2)
    const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => cat.lum[y] - cat.lum[x]);
    for (let r = 0; r < Math.ceil(n * 0.05); r++) aH[order[r] * 4 + 3] = r < Math.ceil(n * 0.01) ? 2 : 1;
    const g = new THREE.BufferGeometry();
    g.setAttribute('aG', new THREE.BufferAttribute(aG, 4));
    g.setAttribute('aH', new THREE.BufferAttribute(aH, 4));
    // Points need a 'position' count for the draw call; aG provides the vertex count via drawRange
    g.setDrawRange(0, n);
    this.galaxies = new THREE.Points(g, this.galMat);
    this.galaxies.frustumCulled = false;
    this.galaxies.renderOrder = 5;
    this.subPts = new THREE.Points(g, this.subMat);
    this.subPts.frustumCulled = false;
    this.accScene.add(this.subPts);
    return this.galaxies;
  }

  /** Cluster catalog → accretion-shock shells (positions arrive later from the GPU gather). */
  setClusters(cl) {
    const n = cl.count;
    const aC = new Float32Array(n * 4), aD = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      const nu = Math.max(1, cl.nu[k]);
      // shock radius ~2 R_vir of the hot halo; strength: gas at ~15× mean over 0.14 R, in particle masses
      // (mean density 1/spacing³), more massive clusters shock harder
      aD[k * 4] = 15 * 0.14 * 4 * Math.PI / 8 * Math.min(2, 0.5 + 0.25 * nu);   // (reference particle = 8 (Mpc/h)³)
      aD[k * 4 + 1] = ((k * 0.7548776662) % 1);
      aD[k * 4 + 2] = cl.dcoll[k];
      aC[k * 4 + 3] = 0;   // hidden until the first gather
    }
    this.clR = Float32Array.from({ length: n }, (_, k) => 2.0 * cl.radius[k] + 0.6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('aC', new THREE.BufferAttribute(aC, 4));
    g.setAttribute('aD', new THREE.BufferAttribute(aD, 4));
    g.setDrawRange(0, n);
    this.shells = new THREE.Points(g, this.shellMat);
    this.shells.frustumCulled = false;
    this.accScene.add(this.shells);
  }

  /** Gathered cluster centres (box units, xyz per cluster). */
  updateClusters(pos) {
    if (!this.shells) return;
    const attr = this.shells.geometry.getAttribute('aC'), A = attr.array, n = this.clR.length;
    for (let k = 0; k < n; k++) {
      const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) { A[k * 4 + 3] = 0; continue; }
      A[k * 4] = x; A[k * 4 + 1] = y; A[k * 4 + 2] = z; A[k * 4 + 3] = this.clR[k];
    }
    attr.needsUpdate = true;
  }

  setSize(w, h) {
    const s = this.accScale;
    const aw = Math.max(4, Math.round(w * s)), ah = Math.max(4, Math.round(h * s));
    this.accum.setSize(aw, ah);
    this.compMat.uniforms.uTexel.value.set(1 / aw, 1 / ah);
    // clarity radius: ~5 px of a 720p frame whatever the resolution
    this.compMat.uniforms.uClarR.value = Math.max(2, 5 * ah / 720);
    this.accW = aw; this.accH = ah;
    const vw = Math.max(1, Math.ceil(aw / 2)), vh = Math.max(1, Math.ceil(ah / 2));
    this.veilRT.setSize(vw, vh);
    this.veilMat.uniforms.uVeilSize.value.set(vw, vh);
    this.veilAddMat.uniforms.uSize.value.set(aw, ah);
    const bw = Math.max(1, Math.ceil(aw / 4)), bh = Math.max(1, Math.ceil(ah / 4));
    this.blurRT.setSize(bw, bh);
    this.blurMat.uniforms.uSize.value.set(bw, bh);
    this.blurMat.uniforms.uSrcTexel.value.set(1 / aw, 1 / ah);
    this.compMat.uniforms.uBlurTexel.value.set(1 / bw, 1 / bh);
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
      // diffuse matter: ray-march the PM density field, then add it in
      const vm = this.veilMat.uniforms, on = this.U.uFieldOn.value > 0.5 && vm.uVeilGain.value > 0;
      this.accMat.uniforms.uVeilOn.value = on ? 1 : 0;
      if (on) {
        const P = camera.projectionMatrix.elements;
        vm.uProjXY.value.set(P[0], P[5]);
        vm.uCamRot.value.setFromMatrix4(camera.matrixWorld);
        this.sim.quad.material = this.veilMat;
        r.setRenderTarget(this.veilRT);
        r.render(this.sim.qScene, this.sim.qCam);
        this.sim.quad.material = this.veilAddMat;
        r.setRenderTarget(this.accum);
        r.render(this.sim.qScene, this.sim.qCam);
      }
      this.sim.quad.material = this.blurMat;
      r.setRenderTarget(this.blurRT);
      r.render(this.sim.qScene, this.sim.qCam);
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
    this.compMat.dispose(); this.comp.geometry.dispose(); this.blurRT.dispose(); this.blurMat.dispose(); this.veilRT.dispose(); this.veilMat.dispose(); this.veilAddMat.dispose();
    this.galMat.dispose(); this.galaxies?.geometry.dispose();
    this.subMat.dispose(); this.shellMat.dispose(); this.shells?.geometry.dispose();
    this.ringMat.dispose(); this.ring.geometry.dispose();
    this.gatherTex.dispose(); this.gatherRT.dispose(); this.gatherMat.dispose();
    this.lvRT?.dispose(); this.lvMat?.dispose();
  }
}
