// Great-mountain weather: cloud crossing the great mountain at three heights + a sea of cloud below it.
// OWNED BY THE TERRAIN TRACK.
//
//  • Ray-marched volume (pipeline effect "terrain-clouds", order 95: after GTAO, BEFORE the atmosphere's
//    aerial perspective at 100, so the clouds take the same haze as the mountain behind them). Only pixels
//    whose view ray crosses a bounding cylinder around the mountain are marched; everything else is a copy.
//  • Three bands hug the cone (the creator's "whole mountain in one frame with cloud crossing it at three
//    heights"): a ragged foot band, a long shoulder band crossing in front of the cone from the spawn side,
//    and a thin streak / cap near the summit. Each band is a partial ring around the cone (seeded sector),
//    shaped by a baked tileable Perlin-Worley volume and drifting with the wind.
//  • A sea of cloud fills the low ground around the mountain (top = a low quantile of the terrain heights
//    around it). It is drawn only when the camera is above it ("above the weather": the cone and the high
//    ridges stand out of a white floor as islands); from below it is not drawn at all (no fog ceiling).
//  • Terrain-aware: a baked height grid of the real terrain around the mountain (CPU, from PlanetSurface,
//    time-sliced) gives soft contact where cloud meets slope, the mountain's shadow on its clouds and the
//    valley-filling shape of the sea; the depth buffer clips the march exactly.
//  • Lighting: sun × Beer (two light samples) × powder, dual-lobe HG (silver lining toward the sun), terrain
//    shadow from the height grid, sky ambient (top) and ground bounce (bottom) from the shared G uniforms.
//  • Cost: ≤ 40 steps (tier-scaled, 16 on low / software GL) only inside the cylinder; light samples only
//    where there is cloud; early exit at T < 0.03. No per-frame allocation.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';

const N3 = 48;   // noise volume resolution (tileable)

function hash3(x, y, z, s) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Tileable Perlin-Worley (R) + Worley detail (G) volume, N3³ RG8. ~40-70 ms. */
function bakeNoise(seed) {
  const N = N3, out = new Uint8Array(N * N * N * 2);
  const worley = (cells) => {
    // feature point per cell, wrapped
    const fp = new Float32Array(cells * cells * cells * 3);
    for (let z = 0; z < cells; z++) for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
      const i = ((z * cells + y) * cells + x) * 3;
      fp[i] = hash3(x, y, z, seed + cells); fp[i + 1] = hash3(x, y, z, seed + cells * 7 + 1); fp[i + 2] = hash3(x, y, z, seed + cells * 13 + 2);
    }
    const res = new Float32Array(N * N * N);
    const k = cells / N;
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const px = (x + 0.5) * k, py = (y + 0.5) * k, pz = (z + 0.5) * k;
      const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
      let md = 9;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const ix = (cx + dx + cells) % cells, iy = (cy + dy + cells) % cells, iz = (cz + dz + cells) % cells;
        const i = ((iz * cells + iy) * cells + ix) * 3;
        const qx = cx + dx + fp[i] - px, qy = cy + dy + fp[i + 1] - py, qz = cz + dz + fp[i + 2] - pz;
        const d = qx * qx + qy * qy + qz * qz;
        if (d < md) md = d;
      }
      res[(z * N + y) * N + x] = 1 - Math.min(1, Math.sqrt(md) * 1.15);
    }
    return res;
  };
  const value = (cells, s) => {
    const lat = new Float32Array(cells * cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = hash3(i, i * 3 + 1, s, seed) * 2 - 1;
    const res = new Float32Array(N * N * N);
    const k = cells / N;
    const sm = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const px = x * k, py = y * k, pz = z * k;
      const x0 = Math.floor(px), y0 = Math.floor(py), z0 = Math.floor(pz);
      const fx = sm(px - x0), fy = sm(py - y0), fz = sm(pz - z0);
      const L = (a, b, c) => lat[((c % cells) * cells + (b % cells)) * cells + (a % cells)];
      const c00 = L(x0, y0, z0) + (L(x0 + 1, y0, z0) - L(x0, y0, z0)) * fx;
      const c10 = L(x0, y0 + 1, z0) + (L(x0 + 1, y0 + 1, z0) - L(x0, y0 + 1, z0)) * fx;
      const c01 = L(x0, y0, z0 + 1) + (L(x0 + 1, y0, z0 + 1) - L(x0, y0, z0 + 1)) * fx;
      const c11 = L(x0, y0 + 1, z0 + 1) + (L(x0 + 1, y0 + 1, z0 + 1) - L(x0, y0 + 1, z0 + 1)) * fx;
      const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
      res[(z * N + y) * N + x] = c0 + (c1 - c0) * fz;
    }
    return res;
  };
  const w4 = worley(4), w8 = worley(8), w16 = worley(16), w24 = worley(24);
  const v4 = value(4, 1), v8 = value(8, 2), v16 = value(16, 3);
  for (let i = 0; i < N * N * N; i++) {
    const wf = w4[i] * 0.625 + w8[i] * 0.25 + w16[i] * 0.125;
    const pf = 0.5 + 0.5 * (v4[i] * 0.6 + v8[i] * 0.3 + v16[i] * 0.15);
    // Schneider remap: perlin billowed by worley
    const lo = wf - 1;
    let pw = (pf - lo) / (1 - lo);
    pw = Math.max(0, Math.min(1, pw * 0.85 + wf * 0.25 - 0.08));
    const det = w8[i] * 0.3 + w16[i] * 0.4 + w24[i] * 0.3;
    out[i * 2] = Math.round(pw * 255);
    out[i * 2 + 1] = Math.round(Math.max(0, Math.min(1, det)) * 255);
  }
  const tex = new THREE.Data3DTexture(out, N, N, N);
  tex.format = THREE.RGFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */`
#include <rv_common>
precision highp float;
precision highp sampler3D;
uniform sampler2D tDepth;
uniform sampler3D tNoise;
uniform sampler2D tHgt;
uniform mat4 uCamWorld;
uniform vec4 uProjParams;
uniform float uNear, uFar;
uniform vec3 uCamP;          // camera, planet-centred (m)
uniform vec3 uC, uE, uN;     // mountain axis + tangent basis
uniform vec4 uM;             // R, base altitude, summit altitude, cone footprint radius Rb
uniform vec4 uCyl;           // cylinder radius, top above the base point, grid tan-extent, steps
uniform vec4 uBA[4];         // band: altitude, half thickness, inner radius (cone surface), radial extent
uniform vec4 uBS[4];         // band: sector centre (rad), sector cos half-width, coverage, noise scale (m)
uniform vec4 uSea;           // sea top altitude, thickness of the billow, strength (camera-gated), noise scale
uniform vec4 uHgtR;          // grid: min height, height range (unused if float), -, -
uniform vec3 uSunL;          // toward the sun (planet frame = scene orientation)
uniform vec3 uSunC;          // sun illuminance (linear)
uniform vec3 uAmbS, uAmbG;   // sky / ground irradiance
uniform vec3 uWind;          // noise offset (m), planet frame
uniform float uFrame;
uniform float uDens;         // extinction scale (1/m)
varying vec2 vUv;

float hgt( vec3 p ) {
  float cd = dot( p, uC );
  vec2 g = vec2( dot( p, uE ), dot( p, uN ) ) / max( cd, 1.0 ) / uCyl.z;   // gnomonic, -1..1 on the grid
  vec2 uv = g * 0.5 + 0.5;
  if ( any( lessThan( uv, vec2( 0.0 ) ) ) || any( greaterThan( uv, vec2( 1.0 ) ) ) ) return -1e5;
  return texture( tHgt, uv ).r;
}

// density at planet-centred point p (alt = |p| - R known), terrain height hT
float dens( vec3 p, float alt, float hT, bool lite ) {
  float clr = alt - hT;
  if ( clr < 0.0 ) return 0.0;
  vec3 dir = p / ( alt + uM.x );
  float ca = dot( dir, uC );
  vec2 tg = vec2( dot( dir, uE ), dot( dir, uN ) );
  float hd = atan( length( tg ), ca ) * uM.x;            // horizontal distance from the axis (m)
  float phi = atan( tg.x, tg.y );
  vec3 q = p + uWind;
  float d = 0.0;
  for ( int i = 0; i < 4; i++ ) {
    vec4 A = uBA[i], S = uBS[i];
    if ( S.z <= 0.0 ) continue;
    float dv = ( alt - A.x ) / A.y;
    if ( abs( dv ) > 1.6 ) continue;
    float gap = hd - A.z;
    if ( gap > A.w ) continue;
    vec4 n = texture( tNoise, q / S.w );
    float lowN = texture( tNoise, q / ( S.w * 4.3 ) + 0.37 ).r;
    // ragged top / bottom: the altitude profile is displaced by the noise
    float dvn = dv + ( n.r - 0.5 ) * 1.1 + ( lowN - 0.5 ) * 0.8;
    float vprof = clamp( 1.0 - dvn * dvn, 0.0, 1.0 );
    float rad = smoothstep( -0.6 * A.w, 0.0, gap ) * ( 1.0 - smoothstep( 0.25 * A.w, A.w, gap + ( lowN - 0.5 ) * 0.5 * A.w ) );
    float sec = smoothstep( S.y - 0.25, S.y + 0.3, cos( phi - S.x ) + ( lowN - 0.5 ) * 0.7 );
    float base = n.r * vprof * rad * sec;
    float c = clamp( ( base - ( 1.0 - S.z ) ) / max( S.z, 0.05 ), 0.0, 1.0 );
    if ( !lite && c > 0.0 ) c = clamp( c - ( 1.0 - c ) * texture( tNoise, q / ( S.w * 0.23 ) ).g * 0.55, 0.0, 1.0 );
    d = max( d, c );
  }
  // sea of cloud: a billowing white floor over the low ground (camera-gated)
  if ( uSea.z > 0.0 && alt < uSea.x + uSea.y ) {
    vec4 n = texture( tNoise, q / uSea.w );
    float lowN = texture( tNoise, q / ( uSea.w * 5.1 ) + 0.61 ).r;
    float top = uSea.x + ( n.r - 0.45 ) * uSea.y + ( lowN - 0.5 ) * uSea.y * 1.4;
    float gE = length( tg / max( ca, 0.1 ) ) / uCyl.z;
    float s = smoothstep( 0.0, uSea.y * 0.5, top - alt ) * uSea.z * ( 1.0 - smoothstep( 0.72, 0.97, gE ) );
    if ( !lite && s > 0.0 ) s = clamp( s - ( 1.0 - s ) * n.g * 0.5, 0.0, 1.0 );
    d = max( d, s );
  }
  // soft contact with the slope (no hard intersection line)
  return d * smoothstep( 0.0, 90.0, clr );
}

float hg( float c, float g ) { float g2 = g * g; return ( 1.0 - g2 ) / ( 4.0 * 3.14159265 * pow( max( 1.0 + g2 - 2.0 * g * c, 1e-4 ), 1.5 ) ); }

void main() {
  // (half-resolution march: output = in-scattered light (rgb) + transmittance (a); the composite pass
  //  below filters it depth-aware at full resolution, so the per-pixel jitter never shows as a dither)
  vec4 src = vec4( 0.0, 0.0, 0.0, 1.0 );
  float depth = texture( tDepth, vUv ).r;
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 vd = vec3( ( ndc.x + uProjParams.z ) / uProjParams.x, ( ndc.y + uProjParams.w ) / uProjParams.y, -1.0 );
  vec3 rd = normalize( mat3( uCamWorld ) * vd );
#ifdef USE_REVERSED_DEPTH_BUFFER
  bool far = depth <= 1e-9;
#else
  bool far = depth >= 0.9999999;
#endif
  float tHit = far ? 1e9 : rv_viewZFromDepth( depth, uNear, uFar ) * length( vd );
  // ---- bounding cylinder around the axis through the base point B = C·(R + base)
  vec3 o = uCamP - uC * ( uM.x + uM.y );
  vec3 oq = o - uC * dot( o, uC ), dq = rd - uC * dot( rd, uC );
  float a = dot( dq, dq ), b = dot( oq, dq ), c = dot( oq, oq ) - uCyl.x * uCyl.x;
  float disc = b * b - a * c;
  if ( disc <= 0.0 || a < 1e-8 ) { gl_FragColor = src; return; }
  float sq = sqrt( disc );
  float t0 = max( ( -b - sq ) / a, 0.0 ), t1 = min( ( -b + sq ) / a, tHit );
  // top plane
  float oy = dot( o, uC ), dy = dot( rd, uC );
  if ( oy > uCyl.y && dy >= 0.0 ) { gl_FragColor = src; return; }
  if ( abs( dy ) > 1e-6 ) {
    float tp = ( uCyl.y - oy ) / dy;
    if ( dy > 0.0 ) t1 = min( t1, tp ); else t0 = max( t0, tp );
  }
  if ( t1 <= t0 ) { gl_FragColor = src; return; }
  float len = t1 - t0;
  float NS = clamp( ceil( len / 260.0 ), 6.0, uCyl.w );
  float dt = len / NS;
  float jit = fract( rv_ign( gl_FragCoord.xy ) + uFrame * 0.618034 );
  float T = 1.0;
  vec3 L = vec3( 0.0 );
  float nu = dot( rd, uSunL );
  float ph = mix( hg( nu, 0.62 ), hg( nu, -0.15 ), 0.45 ) * 4.0 * 3.14159265;   // relative to isotropic
  float sunUp = smoothstep( -0.08, 0.06, dot( normalize( uCamP ), uSunL ) );
  for ( int i = 0; i < 64; i++ ) {
    if ( float( i ) >= NS || T < 0.03 ) break;
    float t = t0 + ( float( i ) + jit ) * dt;
    vec3 p = uCamP + rd * t;
    float r = length( p ), alt = r - uM.x;
    float hT = hgt( p );
    float d = dens( p, alt, hT, false );
    if ( d <= 0.002 ) continue;
    float sig = d * uDens;
    // light: two samples toward the sun (Beer) + the terrain's shadow from the height grid
    vec3 p1 = p + uSunL * 180.0, p2 = p + uSunL * 620.0;
    float a1 = length( p1 ) - uM.x, a2 = length( p2 ) - uM.x;
    float tau = ( dens( p1, a1, hgt( p1 ), true ) * 180.0 + dens( p2, a2, hgt( p2 ), true ) * 440.0 ) * uDens;
    float sh = 1.0;
    vec3 p3 = p + uSunL * 1400.0, p4 = p + uSunL * 3600.0;
    sh *= smoothstep( -60.0, 60.0, length( p3 ) - uM.x - hgt( p3 ) );
    sh *= smoothstep( -120.0, 120.0, length( p4 ) - uM.x - hgt( p4 ) );
    float beer = exp( -tau ) * sh;
    float powder = 1.0 - exp( -sig * 260.0 );
    float hf = clamp( ( alt - hT ) / 500.0, 0.0, 1.0 );
    vec3 Ls = uSunC * ( beer * mix( 0.55, 1.0, powder ) * ( 0.32 + 0.68 * ph ) + 0.06 * sh ) * sunUp
            + uAmbS * mix( 0.55, 1.05, hf ) + uAmbG * 0.25;
    Ls *= 0.92 / 3.14159265;
    float ex = exp( -sig * dt );
    L += T * Ls * ( 1.0 - ex );
    T *= ex;
  }
  gl_FragColor = vec4( L, T );
}
`;

const COMP = /* glsl */`
#include <rv_common>
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tCloud;
uniform vec2 uCTex;          // half-res texel size (uv)
uniform float uNear, uFar;
varying vec2 vUv;
float lin( vec2 uv ) {
  float d = texture( tDepth, uv ).r;
#ifdef USE_REVERSED_DEPTH_BUFFER
  if ( d <= 1e-9 ) return 1e9;
#else
  if ( d >= 0.9999999 ) return 1e9;
#endif
  return rv_viewZFromDepth( d, uNear, uFar );
}
void main() {
  vec4 src = texture( tColor, vUv );
  float z0 = lin( vUv );
  vec4 acc = vec4( 0.0 ); float wsum = 0.0;
  // 4x4 taps over the half-res grid (bilinear fetches: ~3x3 half-res texels, tent-weighted), each
  // weighted by depth similarity so cloud never bleeds across a near silhouette
  for ( int j = 0; j < 4; j++ ) for ( int i = 0; i < 4; i++ ) {
    vec2 o = vec2( float( i ) - 1.5, float( j ) - 1.5 );
    vec2 uv = vUv + o * uCTex * 0.75;
    float z = lin( uv );
    float w = ( 2.0 - abs( o.x ) * 0.6 ) * ( 2.0 - abs( o.y ) * 0.6 );
    w *= exp( -abs( z - z0 ) / ( 0.04 * min( z0, z ) + 2.0 ) );
    acc += texture( tCloud, uv ) * w; wsum += w;
  }
  vec4 c = wsum > 1e-4 ? acc / wsum : texture( tCloud, vUv );
  gl_FragColor = vec4( src.rgb * c.a + c.rgb, src.a );
}
`;

export class MountainClouds {
  constructor(world, terrain) {
    this.world = world;
    this.terrain = terrain;
    this.ready = false;
    const L = terrain.landmarks, M = L?.mountain, S = world.surface;
    const pipe = world.engine?.pipeline;
    if (!M || !S || !pipe?.addEffect || world.body?.atmosphere?.present === false) return;
    const R = world.body.radius;
    this.R = R;
    const q = world.quality || {};
    const soft = !!terrain._softGL?.();
    const tier = q.tier || 'high';
    this.steps = soft ? 28 : tier === 'low' ? 16 : tier === 'med' ? 24 : tier === 'ultra' ? 48 : 36;
    // ---- geometry of the mountain
    const C = M.dir, Hk = M.peak || 4000, Rb = M.radius || 10000;
    const top = M.height;                           // summit altitude
    const base = top - Hk * 0.92;                   // (the generator's crater rim sits at ~0.92 of the cone's H)
    this.base = base; this.top = top;
    const e = [C[2], 0, -C[0]]; { const l = Math.hypot(e[0], e[1], e[2]) || 1; e[0] /= l; e[1] /= l; e[2] /= l; }
    const n = [C[1] * e[2] - C[2] * e[1], C[2] * e[0] - C[0] * e[2], C[0] * e[1] - C[1] * e[0]];
    this.C = C; this.E = e; this.N = n;
    // grid: gnomonic square around the axis, 2.3 footprints out
    this.GN = soft ? 112 : 136;
    this.gExt = Math.tan(Math.min(0.9, (Rb * 2.3) / R));
    this.hgt = new Float32Array(this.GN * this.GN);
    this._gi = 0;
    this.seed = ((M.lat * 1000) | 0) ^ ((M.lon * 977) | 0);
    let rs = (this.seed >>> 0) || 7;
    const rnd = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs / 4294967296; };
    // spawn bearing (around the cone, measured like the shader's phi = atan(E, N))
    const sp = L.spawn?.dir || C;
    const phiS = Math.atan2(sp[0] * e[0] + sp[1] * e[1] + sp[2] * e[2], sp[0] * n[0] + sp[1] * n[1] + sp[2] * n[2]);
    // cone radius at an altitude (inverse of the generator's profile, sampled along the spawn bearing)
    const dirAt = (phi, dist) => {
      const ang = dist / R, s = Math.sin(ang), c = Math.cos(ang), cp = Math.cos(phi), spn = Math.sin(phi);
      const d = [0, 1, 2].map((k) => C[k] * c + (n[k] * cp + e[k] * spn) * s);
      const l = Math.hypot(d[0], d[1], d[2]); return [d[0] / l, d[1] / l, d[2] / l];
    };
    const coneR = (alt) => {
      // mean over 6 bearings of the outermost distance where the terrain is still above `alt`
      let sum = 0;
      for (let k = 0; k < 6; k++) {
        const phi = phiS + (k / 6) * Math.PI * 2;
        let lo = 0, hi = Rb * 1.3;
        for (let it = 0; it < 14; it++) {
          const mid = (lo + hi) / 2, d = dirAt(phi, mid);
          if (S.heightLod(d[0], d[1], d[2], 60) > alt) lo = mid; else hi = mid;
        }
        sum += lo;
      }
      return sum / 6;
    };
    // ---- three bands (foot, shoulder, summit streak) + an optional cap
    const H = top - base;
    const cov = 0.62 + 0.12 * rnd();
    const bands = [
      // altitude fraction, half thickness (×H), radial extent (×Rb), sector offset from the spawn side, half width (deg), coverage, noise scale
      // (foot and shoulder bands are centred to either side of the spawn bearing, so from the spawn side
      //  — where the capture / first views stand — one crosses the left flank low and one the right
      //  shoulder high, and both overlap in front of the cone)
      // (radial extents stay well inside the spawn / view distance ~1.15-1.3 Rb from the axis: seen from
      //  the ground the bands are bands hugging the cone, never a veil overhead)
      { f: 0.22, w: 0.06, ext: 0.32, off: -0.75 + (rnd() - 0.5) * 0.5, hw: 100, cov: cov + 0.04, sc: 2600 },
      { f: 0.52, w: 0.055, ext: 0.36, off: 0.6 + (rnd() - 0.5) * 0.5, hw: 95, cov: cov + 0.01, sc: 1700 },
      { f: 0.84, w: 0.035, ext: 0.42, off: Math.PI + (rnd() - 0.5) * 1.2, hw: 140, cov: cov * 0.9, sc: 1700 },
    ];
    if (rnd() < 0.55) bands.push({ f: 1.05, w: 0.03, ext: 0.3, off: 0, hw: 180, cov: 0.55, sc: 1500, cap: true });
    this.uBA = []; this.uBS = [];
    for (let i = 0; i < 4; i++) {
      const b = bands[i];
      if (!b) { this.uBA.push(new THREE.Vector4(0, 1, 0, 0)); this.uBS.push(new THREE.Vector4(0, 1, 0, 1000)); continue; }
      const alt = base + H * b.f;
      const rc = b.cap ? 0 : coneR(alt);
      this.uBA.push(new THREE.Vector4(alt, Math.max(90, H * b.w), rc, Rb * b.ext));
      this.uBS.push(new THREE.Vector4(phiS + b.off, Math.cos(b.hw * Math.PI / 180), b.cov, b.sc));
    }
    // ---- noise, height grid textures
    this.noise = bakeNoise(this.seed & 0xffff);
    this.hTex = new THREE.DataTexture(new Float32Array(this.GN * this.GN), this.GN, this.GN, THREE.RedFormat, THREE.FloatType);
    this.hTex.minFilter = this.hTex.magFilter = THREE.NearestFilter;   // (R32F is not filterable everywhere: filtered in-shader below)
    this.hTex.generateMipmaps = false;
    this.hTex.needsUpdate = true;
    const art = world.body.art || {};
    const seaAmt = world.body.type === 'barren' ? 0 : (art.key === 'bladerunner' ? 0.6 : 1);
    this.seaAmt = seaAmt * (rnd() < 0.85 ? 1 : 0);
    this.u = {
      tColor: { value: null }, tDepth: { value: null }, tNoise: { value: this.noise }, tHgt: { value: this.hTex },
      uCamWorld: { value: new THREE.Matrix4() }, uProjParams: { value: new THREE.Vector4() }, uNear: { value: 0.1 }, uFar: { value: 1e7 },
      uCamP: { value: new THREE.Vector3() },
      uC: { value: new THREE.Vector3(C[0], C[1], C[2]) }, uE: { value: new THREE.Vector3(e[0], e[1], e[2]) }, uN: { value: new THREE.Vector3(n[0], n[1], n[2]) },
      uM: { value: new THREE.Vector4(R, base, top, Rb) },
      uCyl: { value: new THREE.Vector4(Rb * 2.25, top - base + H * 0.35, this.gExt, this.steps) },
      uBA: { value: this.uBA }, uBS: { value: this.uBS },
      uSea: { value: new THREE.Vector4(-1e5, Math.max(120, H * 0.05), 0, 3200) },
      uHgtR: { value: new THREE.Vector4() },
      uSunL: { value: new THREE.Vector3(0, 1, 0) }, uSunC: { value: new THREE.Color() },
      uAmbS: { value: new THREE.Color() }, uAmbG: { value: new THREE.Color() },
      uWind: { value: new THREE.Vector3() }, uFrame: { value: 0 },
      uDens: { value: 0.0065 },
    };
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.u, depthTest: false, depthWrite: false });
    // half-resolution march target + depth-aware full-resolution composite
    this.rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.cu = { tColor: { value: null }, tDepth: { value: null }, tCloud: { value: this.rt.texture }, uCTex: { value: new THREE.Vector2(0.5, 0.5) }, uNear: this.u.uNear, uFar: this.u.uFar };
    this.cmat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COMP, uniforms: this.cu, depthTest: false, depthWrite: false });
    // (linear filtering of the height grid: R32F + manual bilinear would cost 4 fetches; use a half-float
    //  copy instead once baked, see _finishGrid)
    this.quad = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.quad.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad.frustumCulled = false;
    this.qcam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.windOff = new THREE.Vector3();
    this.frame = 0;
    this.enabled = false;
    // shot mode / software GL: bake the grid now (deterministic, ~0.3 s); otherwise time-sliced in update()
    if (world.engine?.shot) this._bake(1e9);
    this.effect = { name: 'terrain-clouds', order: 95, enabled: true, render: (r, io) => this._render(r, io), setSize: (w, h) => this._setSize(w, h) };
    this._off = pipe.addEffect(this.effect);
  }

  _bake(budgetMs) {
    const S = this.world.surface, GN = this.GN, C = this.C, E = this.E, N = this.N, ge = this.gExt;
    const t0 = performance.now();
    while (this._gi < GN * GN) {
      const i = this._gi % GN, j = (this._gi / GN) | 0;
      const u = ((i + 0.5) / GN * 2 - 1) * ge, v = ((j + 0.5) / GN * 2 - 1) * ge;
      let x = C[0] + E[0] * u + N[0] * v, y = C[1] + E[1] * u + N[1] * v, z = C[2] + E[2] * u + N[2] * v;
      const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
      let h = S.heightLod(x, y, z, 90);
      if (Number.isFinite(S.seaLevel) && h < S.seaLevel) h = S.seaLevel;
      this.hgt[this._gi] = h;
      this._gi++;
      if ((this._gi & 31) === 0 && performance.now() - t0 > budgetMs) break;
    }
    if (this._gi >= GN * GN) this._finishGrid();
  }

  _finishGrid() {
    const GN = this.GN, h = this.hgt;
    // half-float copy (filterable): heights to ±65504 m, ~2-4 m precision at these altitudes
    const hf = new Uint16Array(GN * GN);
    for (let i = 0; i < h.length; i++) hf[i] = THREE.DataUtils.toHalfFloat(h[i]);
    this.hTex.dispose();
    this.hTex = new THREE.DataTexture(hf, GN, GN, THREE.RedFormat, THREE.HalfFloatType);
    this.hTex.minFilter = this.hTex.magFilter = THREE.LinearFilter;
    this.hTex.generateMipmaps = false;
    this.hTex.needsUpdate = true;
    this.u.tHgt.value = this.hTex;
    // sea of cloud: top at a low quantile of the ground around the mountain (outside its cone), so the
    // valleys and the plain fill and the ridges and the cone stand out as islands
    const R = this.R, C = this.C, ge = this.gExt;
    const outside = [];
    for (let j = 0; j < GN; j += 2) for (let i = 0; i < GN; i += 2) {
      const u = ((i + 0.5) / GN * 2 - 1) * ge, v = ((j + 0.5) / GN * 2 - 1) * ge;
      const dist = Math.atan(Math.hypot(u, v)) * R;
      if (dist > this.u.uM.value.w * 1.05 && Math.hypot(u, v) < ge) outside.push(h[j * GN + i]);
    }
    outside.sort((a, b) => a - b);
    const sea = Number.isFinite(this.world.surface.seaLevel) ? this.world.surface.seaLevel : -1e9;
    if (outside.length > 20) {
      const q = outside[Math.floor(outside.length * 0.42)];
      this.seaTop = Math.max(q + 80, sea + 220);
    } else this.seaTop = -1e5;
    this.u.uSea.value.x = this.seaTop;
    this.ready = true;
    this.enabled = true;
  }

  _setSize(w, h) {
    if (!this.rt) return;
    const hw = Math.max(2, Math.ceil(w / 2)), hh = Math.max(2, Math.ceil(h / 2));
    if (this.rt.width !== hw || this.rt.height !== hh) this.rt.setSize(hw, hh);
    this.cu.uCTex.value.set(1 / hw, 1 / hh);
  }

  update(dt) {
    if (!this.mat) return;
    if (!this.ready) this._bake(3);
    // wind drift (m): the clouds slide slowly around the mountain
    const W = G.uWindDir?.value, ws = 6 + 10 * (G.uWindStrength?.value ?? 0.4);
    if (W) this.windOff.addScaledVector(W, -Math.min(dt || 0, 0.1) * ws);
    this.frame = (this.frame + 1) % 64;
  }

  _render(r, io) {
    const u = this.u;
    if (!this.enabled || !io.depth || !io.input) { io.skip = true; return; }
    const cam = io.camera;
    const p = cam.projectionMatrix.elements;
    u.uCamWorld.value.copy(cam.matrixWorld);
    u.uProjParams.value.set(p[0], p[5], p[8], p[9]);
    u.uNear.value = cam.near; u.uFar.value = cam.far;
    u.uCamP.value.setFromMatrixPosition(cam.matrixWorld).add(this.world.origin);
    // camera altitude gates the sea of cloud (only from above it)
    const camAlt = u.uCamP.value.length() - this.R;
    const seaK = this.seaTop > -1e4 ? THREE.MathUtils.smoothstep(camAlt, this.seaTop + 120, this.seaTop + 700) * this.seaAmt : 0;
    u.uSea.value.z = seaK;
    // cheap reject: camera far beyond the cylinder and looking away is handled per pixel; skip if the
    // whole mountain is beyond the horizon
    const cl = u.uCamP.value.length();
    const cdot = (u.uCamP.value.x * this.C[0] + u.uCamP.value.y * this.C[1] + u.uCamP.value.z * this.C[2]) / Math.max(cl, 1);
    const distM = Math.acos(Math.max(-1, Math.min(1, cdot))) * this.R;
    const horizon = Math.sqrt(Math.max(0, 2 * this.R * Math.max(camAlt, 2))) + Math.sqrt(2 * this.R * Math.max(this.top + 1000, 100)) + u.uCyl.value.x;
    if (distM > horizon) { io.skip = true; this.skips = (this.skips | 0) + 1; return; }
    this.renders = (this.renders | 0) + 1;
    u.uSunL.value.copy(G.uSunDir.value);
    u.uSunC.value.copy(G.uSunColor.value);
    u.uAmbS.value.copy(G.uAmbientSky.value);
    u.uAmbG.value.copy(G.uAmbientGround.value);
    u.uWind.value.copy(this.windOff);
    u.uFrame.value = this.frame;
    u.tDepth.value = io.depth;
    const iw = io.input.width, ih = io.input.height;
    if (this.rt.width !== Math.max(2, Math.ceil(iw / 2)) || this.rt.height !== Math.max(2, Math.ceil(ih / 2))) this._setSize(iw, ih);
    this.quad.material = this.mat;
    r.setRenderTarget(this.rt);
    r.render(this.quad, this.qcam);
    this.cu.tColor.value = io.input.texture;
    this.cu.tDepth.value = io.depth;
    this.quad.material = this.cmat;
    r.setRenderTarget(io.output);
    r.render(this.quad, this.qcam);
  }

  dispose() {
    try { this._off?.(); } catch (_) { /* */ }
    this.noise?.dispose(); this.hTex?.dispose(); this.mat?.dispose(); this.cmat?.dispose(); this.rt?.dispose(); this.quad?.geometry.dispose();
  }
}
