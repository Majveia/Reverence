// GLSL for the cosmic web: COLA particle-mesh solver passes + render layers.
// All shaders are GLSL ES 3.00 (three GLSL3). Integer atlas addressing everywhere (texelFetch).
//
// Atlas layouts (z-slice tiles):
//   particles  (lattice n³)      texel = (x + (z % tilesX)·n, y + ⌊z/tilesX⌋·n)
//   mesh       (M³, unpadded)    same with (M, meshTiles)       — FFT / force / fold
//   padded     ((M+2)² tiles)    interior cell (x,y) at (x+1, y+1) of its tile, 1-texel periodic ring
//                                — CIC deposit target and the filterable render fields

export const GLSL_HEAD = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
`;

export const GLSL_ATLAS = /* glsl */`
uniform int uN;        // particle lattice size
uniform int uTilesX;   // particle atlas tiles per row
uniform int uM;        // PM mesh size
uniform int uMTiles;   // mesh atlas tiles per row
ivec2 cwAtlas(ivec3 L) { return ivec2(L.x + (L.z % uTilesX) * uN, L.y + (L.z / uTilesX) * uN); }
ivec3 cwLatticeFromId(int i) { return ivec3(i % uN, (i / uN) % uN, i / (uN * uN)); }
ivec3 cwLatticeFromTexel(ivec2 t) { int tx = t.x / uN, ty = t.y / uN; return ivec3(t.x - tx * uN, t.y - ty * uN, tx + ty * uTilesX); }
vec3 cwQ(ivec3 L) { return (vec3(L) + 0.5) / float(uN); }
ivec2 cwMesh(ivec3 c) { return ivec2(c.x + (c.z % uMTiles) * uM, c.y + (c.z / uMTiles) * uM); }
ivec3 cwMeshCell(ivec2 t) { int tx = t.x / uM, ty = t.y / uM; return ivec3(t.x - tx * uM, t.y - ty * uM, tx + ty * uMTiles); }
vec3 cwHash3(ivec3 p) {
  uvec3 v = uvec3(p) * uvec3(1597334673u, 3812015801u, 2798796415u);
  v = (v.x ^ v.y ^ v.z) * uvec3(1597334673u, 3812015801u, 2798796415u);
  return vec3(v) * (1.0 / 4294967295.0);
}
float cwHash1(int i) {
  uint v = uint(i) * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  v = (v >> 22u) ^ v;
  return float(v) * (1.0 / 4294967295.0);
}
`;

// Particle position at the current evaluation time (render or step), comoving box units (unwrapped).
export const GLSL_POSITION = /* glsl */`
uniform sampler2D tPsiA;   // ψ1 (mesh-resolved) .xyz, δ glow (linear, smoothed) .w
uniform sampler2D tPsiB;   // ψ2 (mesh-resolved) .xyz, δ(R≈1.6 Mpc/h) .w
uniform sampler2D tPsiS;   // ψ1 sub-mesh .xyz
uniform sampler2D tX;      // residual position (COLA)
uniform sampler2D tP;      // residual momentum (COLA)  .w = potential at particle
uniform float uD1, uD2, uDS, uG;
vec3 cwPosition(ivec2 tc, ivec3 L, out vec4 A, out vec4 B) {
  A = texelFetch(tPsiA, tc, 0);
  B = texelFetch(tPsiB, tc, 0);
  vec3 S = texelFetch(tPsiS, tc, 0).xyz;
  vec4 X = texelFetch(tX, tc, 0);
  vec4 P = texelFetch(tP, tc, 0);
  return cwQ(L) + uD1 * A.xyz + uD2 * B.xyz + uDS * S + X.xyz - uG * P.xyz;
}
`;

// Filterable density / potential field (padded atlas, bilinear in x,y + manual z-lerp).
export const GLSL_FIELD = /* glsl */`
uniform sampler2D tFieldA;   // older field  (rho, phi, |grad phi|, -)
uniform sampler2D tFieldB;   // newer field
uniform vec2 uFieldSize;
uniform float uFieldMix;     // 0 → A, 1 → B
uniform float uFieldOn;      // 0 = no PM field yet (use linear estimate)
vec4 cwFieldTex(sampler2D t, vec3 x) {
  vec3 g = fract(x) * float(uM);
  float zc = g.z - 0.5; float z0 = floor(zc); float fz = zc - z0;
  int iz0 = (int(z0) + uM) % uM; int iz1 = (iz0 + 1) % uM;
  int P = uM + 2;
  vec2 o0 = vec2(float((iz0 % uMTiles) * P), float((iz0 / uMTiles) * P));
  vec2 o1 = vec2(float((iz1 % uMTiles) * P), float((iz1 / uMTiles) * P));
  vec2 xy = g.xy + 1.0;
  return mix(texture(t, (o0 + xy) / uFieldSize), texture(t, (o1 + xy) / uFieldSize), fz);
}
vec4 cwField(vec3 x) {
  return mix(cwFieldTex(tFieldA, x), cwFieldTex(tFieldB, x), uFieldMix);
}
`;

// ------------------------------------------------------------------ sim passes
export const FS_VERT = /* glsl */`
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// CIC deposit of the source lattice (M³ particles) into the padded atlas.
// Two vertices per source (the two z-slices); each vertex is a 2×2 point sprite whose fragments
// pick their bilinear weight from the side of the sprite centre they fall on.
export const DEPOSIT_VERT = /* glsl */`
uniform int uStride;        // n / M
uniform vec2 uPadSize;
out vec3 vW;
out vec2 vCenter;
void main() {
  int s = gl_VertexID >> 1; int zs = gl_VertexID & 1;
  ivec3 Ls = ivec3(s % uM, (s / uM) % uM, s / (uM * uM));
  ivec3 L = Ls * uStride;
  ivec2 tc = cwAtlas(L);
  vec3 x = cwQ(L) + uD1 * texelFetch(tPsiA, tc, 0).xyz + uD2 * texelFetch(tPsiB, tc, 0).xyz + texelFetch(tX, tc, 0).xyz;
  x = fract(x);
  vec3 g = x * float(uM) - 0.5;
  vec3 i0 = floor(g); vec3 f = g - i0;
  int iz = int(i0.z) + zs;
  iz = (iz + uM) % uM;
  float wz = zs == 0 ? 1.0 - f.z : f.z;
  int P = uM + 2;
  vec2 org = vec2(float((iz % uMTiles) * P), float((iz / uMTiles) * P));
  vec2 c = org + i0.xy + 2.0;
  vCenter = c;
  vW = vec3(f.xy, wz);
  gl_Position = vec4(c / uPadSize * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 2.0;
}
`;
export const DEPOSIT_FRAG = /* glsl */`
in vec3 vW;
in vec2 vCenter;
layout(location = 0) out vec4 o;
void main() {
  vec2 side = step(vCenter, gl_FragCoord.xy);
  float wx = mix(1.0 - vW.x, vW.x, side.x);
  float wy = mix(1.0 - vW.y, vW.y, side.y);
  o = vec4(wx * wy * vW.z, 0.0, 0.0, 0.0);
}
`;

// Fold the periodic ghost ring back into the interior; output (δ, 0, ρ, 0) on the unpadded mesh.
export const FOLD_FRAG = /* glsl */`
uniform sampler2D tDep;
layout(location = 0) out vec4 o;
void main() {
  ivec3 c = cwMeshCell(ivec2(gl_FragCoord.xy));
  int P = uM + 2;
  ivec2 org = ivec2((c.z % uMTiles) * P, (c.z / uMTiles) * P);
  float rho = texelFetch(tDep, org + ivec2(c.x + 1, c.y + 1), 0).r;
  int wx = c.x == 0 ? uM + 1 : (c.x == uM - 1 ? 0 : -1);
  int wy = c.y == 0 ? uM + 1 : (c.y == uM - 1 ? 0 : -1);
  if (wx >= 0) rho += texelFetch(tDep, org + ivec2(wx, c.y + 1), 0).r;
  if (wy >= 0) rho += texelFetch(tDep, org + ivec2(c.x + 1, wy), 0).r;
  if (wx >= 0 && wy >= 0) rho += texelFetch(tDep, org + ivec2(wx, wy), 0).r;
  o = vec4(rho - 1.0, 0.0, rho, 0.0);
}
`;

// One radix-2 Stockham stage along one axis, two complex numbers per texel (RG, BA).
export const FFT_FRAG = /* glsl */`
uniform sampler2D tIn;
uniform int uAxis;
uniform int uSub;
uniform float uSign;
layout(location = 0) out vec4 o;
void main() {
  ivec3 c = cwMeshCell(ivec2(gl_FragCoord.xy));
  int idx = uAxis == 0 ? c.x : (uAxis == 1 ? c.y : c.z);
  int hs = uSub >> 1;
  int ev = (idx / uSub) * hs + (idx % hs);
  int od = ev + (uM >> 1);
  ivec3 ce = c, co = c;
  if (uAxis == 0) { ce.x = ev; co.x = od; }
  else if (uAxis == 1) { ce.y = ev; co.y = od; }
  else { ce.z = ev; co.z = od; }
  vec4 E = texelFetch(tIn, cwMesh(ce), 0);
  vec4 O = texelFetch(tIn, cwMesh(co), 0);
  float ang = uSign * 6.283185307179586 * float(idx % uSub) / float(uSub);
  vec2 w = vec2(cos(ang), sin(ang));
  o = E + vec4(w.x * O.x - w.y * O.y, w.x * O.y + w.y * O.x, w.x * O.z - w.y * O.w, w.x * O.w + w.y * O.z);
}
`;

// Green's function: Φ = −δ/k²_eff (FD Laplacian), ∇Φ with a 4-point FD kernel; packs
// (∂xΦ + i∂yΦ, ∂zΦ + iΦ) so ONE inverse RGBA FFT returns the full force field and the potential.
export const KSPACE_FRAG = /* glsl */`
uniform sampler2D tIn;
uniform float uSmooth;   // Gaussian force smoothing, mesh cells
layout(location = 0) out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cwMeshCell(t);
  ivec3 m = c - ivec3(greaterThanEqual(c, ivec3(uM / 2))) * uM;
  float Mf = float(uM);
  vec3 th = 6.283185307179586 * vec3(m) / Mf;
  vec3 s = 2.0 * Mf * sin(0.5 * th);
  float k2 = dot(s, s);
  if (k2 <= 0.0) { o = vec4(0.0); return; }
  vec2 d = texelFetch(tIn, t, 0).xy;
  vec3 kk = 6.283185307179586 * vec3(m);
  float sm = exp(-0.5 * dot(kk, kk) * uSmooth * uSmooth / (Mf * Mf));
  vec2 phi = -d / k2 * sm;
  vec3 D = Mf * (8.0 * sin(th) - sin(2.0 * th)) / 6.0;
  vec2 gx = vec2(-D.x * phi.y, D.x * phi.x);
  vec2 gy = vec2(-D.y * phi.y, D.y * phi.x);
  vec2 gz = vec2(-D.z * phi.y, D.z * phi.x);
  vec2 G1 = vec2(gx.x - gy.y, gx.y + gy.x);
  vec2 G2 = vec2(gz.x - phi.y, gz.y + phi.x);
  o = vec4(G1, G2) / (Mf * Mf * Mf);
}
`;

// Render field (padded, filterable): (ρ, Φ, |∇Φ|, 0)
export const FIELD_FRAG = /* glsl */`
uniform sampler2D tFold;
uniform sampler2D tPot;
layout(location = 0) out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int P = uM + 2;
  int tx = t.x / P, ty = t.y / P;
  int z = tx + ty * uMTiles;
  ivec2 l = t - ivec2(tx * P, ty * P) - 1;
  ivec3 c = ivec3((l.x + uM) % uM, (l.y + uM) % uM, z);
  float rho = texelFetch(tFold, cwMesh(c), 0).z;
  vec4 pot = texelFetch(tPot, cwMesh(c), 0);
  o = vec4(rho, pot.w, length(pot.xyz), 0.0);
}
`;

// COLA kick + drift for every particle (MRT: residual position, residual momentum).
export const KICK_FRAG = /* glsl */`
uniform sampler2D tPot;
uniform float uKick, uDrift;
layout(location = 0) out vec4 oX;
layout(location = 1) out vec4 oP;
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  ivec3 L = cwLatticeFromTexel(tc);
  vec4 A = texelFetch(tPsiA, tc, 0);
  vec4 B = texelFetch(tPsiB, tc, 0);
  vec3 S = texelFetch(tPsiS, tc, 0).xyz;
  vec4 X = texelFetch(tX, tc, 0);
  vec4 Pm = texelFetch(tP, tc, 0);
  vec3 x = fract(cwQ(L) + uD1 * A.xyz + uD2 * B.xyz + uDS * S + X.xyz);
  vec3 g = x * float(uM) - 0.5;
  vec3 i0 = floor(g); vec3 f = g - i0;
  ivec3 c0 = ivec3(i0);
  vec3 grad = vec3(0.0); float phi = 0.0;
  for (int k = 0; k < 8; k++) {
    ivec3 of = ivec3(k & 1, (k >> 1) & 1, k >> 2);
    ivec3 c = (c0 + of + uM) % uM;
    vec3 w3 = mix(1.0 - f, f, vec3(of));
    float w = w3.x * w3.y * w3.z;
    vec4 v = texelFetch(tPot, cwMesh(c), 0);
    grad += w * v.xyz; phi += w * v.w;
  }
  vec3 bracket = -grad - uD1 * A.xyz - (uD2 - uD1 * uD1) * B.xyz;
  vec3 Pn = Pm.xyz + uKick * bracket;
  vec3 Xn = X.xyz + uDrift * Pn;
  oX = vec4(Xn, 0.0);
  oP = vec4(Pn, phi);
}
`;

// Gather pass: positions of listed particles (galaxy hosts / cluster cores) for CPU picking.
// tList texel: x = particle id, y = mode (0 single particle, 1 = 3×3×3 cluster core average)
export const GATHER_FRAG = /* glsl */`
uniform sampler2D tList;
layout(location = 0) out vec4 o;
void main() {
  vec4 e = texelFetch(tList, ivec2(gl_FragCoord.xy), 0);
  if (e.x < 0.0) { o = vec4(0.0); return; }
  int id = int(e.x + 0.5);
  ivec3 L0 = cwLatticeFromId(id);
  vec4 A, B;
  vec3 x0 = cwPosition(cwAtlas(L0), L0, A, B);
  if (e.y < 0.5) { o = vec4(x0, 1.0); return; }
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 27; k++) {
    ivec3 of = ivec3(k % 3, (k / 3) % 3, k / 9) - 1;
    ivec3 L = (L0 + of + uN) % uN;
    vec3 x = cwPosition(cwAtlas(L), L, A, B);
    vec3 d = x - x0; d -= floor(d + 0.5);
    acc += d;
  }
  o = vec4(x0 + acc / 27.0, 1.0);
}
`;
