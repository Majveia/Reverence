// Terrain material: MeshStandardMaterial + onBeforeCompile (keeps three's PBR lighting, CSM
// shadows, fog, IBL and the atmosphere track's cloud-shadow patch). OWNED BY THE TERRAIN TRACK.
//
// Features
//  • CDLOD geomorphing in the vertex shader (position + normal morph toward the parent level)
//  • biome blending from per-vertex hints (rock/cliff, sand, temperature, moisture, wetness,
//    glacier, curvature, mountain) + slope/altitude/macro noise, height-blended transitions
//  • procedurally baked detail array texture (rock facets, soil/grass, sand ripples, snow, pebbles,
//    strata) sampled triplanar (rock/cliffs) or up-projected (ground), IQ stochastic anti-tiling,
//    two scales up close (micro normals), faded with distance
//  • altitude-locked sedimentary strata on cliffs (mesas, canyons), macro color variation,
//    wet shoreline darkening, cavity/AO, snow sparkle, volcanic crack glow
//  • all detail coordinates are periodic in P = 4096 m and anchored with a float64-derived origin
//    offset → millimetre precision anywhere on a 100 km planet (floating origin safe)
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';

export const DETAIL_PERIOD = 4096;

const VERT_PARS = /* glsl */`
uniform vec3 uRvCam;   // main camera (scene space) — also used by the shadow pass so casters morph identically
attribute vec4 aMorph;
attribute vec4 aMorphN;  // xyz parent normal, w > 0: skirt vertex (log2-encoded skirt length)
uniform vec3 uRvPlanetC;
attribute vec4 aMat;
attribute vec4 aMat2;
attribute vec3 aUV;      // local texture frame: face u, v (m, per-chunk multiple of P removed) + altitude
varying vec3 vRvUV;
varying vec3 vRvW;
varying vec3 vRvN;
varying vec4 vRvMat;
varying vec4 vRvMat2;
`;

const VERT_NORMAL = /* glsl */`
vec4 rvW0 = modelMatrix * vec4( position, 1.0 );
float rvK = smoothstep( 0.66, 0.93, distance( rvW0.xyz, uRvCam ) / aMorph.w );
vec3 objectNormal = normalize( mix( normal, aMorphN.xyz, rvK ) );
vRvN = objectNormal;
vRvMat = aMat;
vRvMat2 = aMat2;
vRvUV = vec3( aUV.xy, aUV.z + dot( aMorph.xyz, normalize( rvW0.xyz - uRvPlanetC ) ) * rvK );
`;

const VERT_BEGIN = /* glsl */`
vec3 transformed = position + aMorph.xyz * rvK;
vRvW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

// skirts: rasterized lowered along -up, shaded (worldPosition, shadows, vRvW) at the edge vertex
// (in the shadow pass they stay at the edge: zero-area, they never cast)
const VERT_SKIRT = /* glsl */`
if ( aMorphN.w > 0.0 ) {
  vec3 rvUpS = normalize( vRvW - uRvPlanetC );
  float rvSk = exp2( aMorphN.w * 16.0 ) - 1.0;
  gl_Position = projectionMatrix * ( mvPosition - viewMatrix * vec4( rvUpS * rvSk, 0.0 ) );
}
`;

const FRAG_PARS = /* glsl */`
precision highp sampler2DArray;
uniform sampler2DArray uRvDetail;
uniform vec3 uRvOriginMod;
uniform vec3 uRvPlanetCenter;
uniform vec3 uRvSun;
uniform vec3 uRvBlade;
uniform vec3 uRvGrass, uRvGrass2, uRvRock, uRvRock2, uRvSand, uRvSnow, uRvForest, uRvSoil, uRvAccent, uRvDry, uRvSeabed;
uniform vec4 uRvP;   // radius, seaLevel, amp, detail quality (0..1)
uniform vec4 uRvS;   // strata, snow bias, volcanic glow, crystal sheen
uniform vec4 uRvS2;  // lushness, forest darkening, global wetness, global snow
uniform float uRvTime;
uniform float uRvDebug;
uniform float uRvLite; // 1 = software-GL budget: no micro layer, single-fetch tiling
uniform vec4 uRvF;   // detail fade distances: mid start/end, far start/end (scaled by quality)
varying vec3 vRvW;
varying vec3 vRvN;
varying vec4 vRvMat;
varying vec4 vRvMat2;
varying vec3 vRvUV;

vec3 rvN; float rvRough; float rvAO; vec3 rvEmis; bool rvStoch;
float rvLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

// ---- compact triplanar sampling in the LOCAL frame L = (face u, altitude, face v): axis 1 projects
//      along the planet's up (ground), axes 0/2 onto vertical planes (cliffs) — aligned with the
//      surface at every latitude (world-axis triplanar blended three oblique projections at mid
//      latitudes → smeared "brush-stroke" textures). ONE loop over the projection axes per material
//      group keeps the program small; fetches use explicit gradients (legal inside dynamic branches).
vec2 rvAx( int a, vec3 v ) { return a == 0 ? v.zy : ( a == 1 ? v.xz : v.xy ); }
vec3 rvGw( int a, vec2 g ) { return a == 0 ? vec3( 0.0, g.y, g.x ) : ( a == 1 ? vec3( g.x, 0.0, g.y ) : vec3( g.x, g.y, 0.0 ) ); }
float rvWa( int a, vec3 w ) { float v = a == 0 ? w.x : ( a == 1 ? w.y : w.z ); return v < 0.06 ? 0.0 : v; }
// Lattice-preserving orientation (the 8 symmetries of the square: swaps + mirrors). Arbitrary angles
// would break the exact 4096 m periodicity that keeps patterns stable across origin shifts; the D4
// group keeps it while still varying the grain/strata DIRECTION between regions.
mat2 rvOri( float h ) {
  float e = floor( fract( h ) * 8.0 );
  float sw = mod( e, 2.0 ), sx = mod( floor( e * 0.5 ), 2.0 ) * 2.0 - 1.0, sy = floor( e * 0.25 ) * 2.0 - 1.0;
  return mat2( sx * ( 1.0 - sw ), sy * sw, sx * sw, sy * ( 1.0 - sw ) );
}
float rvH1( float i ) { return fract( sin( i * 17.137 + 1.73 ) * 43758.5453 ); }
// one oriented + offset fetch; RG (height slope) is rotated back into the unrotated uv frame
vec4 rvTexO( float layer, vec2 uv, vec2 dx, vec2 dy, float id, float rot ) {
  vec2 o = fract( sin( vec2( 3.0, 7.0 ) * id + vec2( 0.3, 0.7 ) ) * 43758.5453 );
  if ( rot < 0.5 ) return textureGrad( uRvDetail, vec3( uv + o, layer ), dx, dy );
  mat2 M = rvOri( rvH1( id ) );
  vec4 t = textureGrad( uRvDetail, vec3( M * uv + o, layer ), M * dx, M * dy );
  t.rg = ( ( t.rg * 2.0 - 1.0 ) * M ) * 0.5 + 0.5;
  return t;
}
// IQ "texture repetition" #3 + per-region orientation: two variants blended by a smooth region index
vec4 rvFetchS( float layer, vec2 uv, vec2 dx, vec2 dy, float k, float rot ) {
  float l = k * 7.0; float i = floor( l ); float f = fract( l );
  vec4 a = rvTexO( layer, uv, dx, dy, i, rot );
  // second fetch only inside the transition band between two regions
  if ( rvStoch && f > 0.2 && f < 0.8 ) {
    vec4 b = rvTexO( layer, uv, dx, dy, i + 1.0, rot );
    return mix( a, b, smoothstep( 0.25, 0.75, f + 0.6 * ( a.b - b.b ) ) );
  }
  return f < 0.5 ? a : rvTexO( layer, uv, dx, dy, i + 1.0, rot );
}

float rvHB( float w, float h, float c ) { // height-blend: detail height pushes transitions around
  return smoothstep( 0.5 - c, 0.5 + c, w + ( h - 0.5 ) * 0.55 * ( 1.0 - abs( w * 2.0 - 1.0 ) ) );
}

void rvTerrain( inout vec3 albedo ) {
  vec3 W = vRvW;
  vec3 Lp = W - uRvPlanetCenter;
  float r = length( Lp );
  vec3 up = Lp / r;
  float alt = vRvUV.z;                    // float64-precise altitude from the CPU
  vec3 Ng = normalize( vRvN );
  float dist = length( W - cameraPosition );
  vec3 C = W + uRvOriginMod;
  float q = uRvP.w;
  // local frame: L = (u, alt, v); face tangents from screen derivatives (cotangent frame)
  vec3 L = vec3( vRvUV.x, alt, vRvUV.y );
  vec3 dLx = dFdx( L ), dLy = dFdy( L );
  vec3 dWx = dFdx( W ), dWy = dFdy( W );
  vec3 cpy = cross( dWy, up ), cpx = cross( up, dWx );
  vec3 Tu = cpy * dLx.x + cpx * dLy.x;
  Tu -= up * dot( Tu, up );
  float lTu = length( Tu );
  Tu = lTu > 1e-12 ? Tu / lTu : normalize( cross( up, abs( up.y ) < 0.9 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 ) ) );
  vec3 Tv = cross( up, Tu );
  if ( dot( Tv, cpy * dLx.z + cpx * dLy.z ) < 0.0 ) Tv = -Tv;
  vec3 Nl = vec3( dot( Ng, Tu ), dot( Ng, up ), dot( Ng, Tv ) );

  float rockA = vRvMat.x, sandA = vRvMat.y, temp = vRvMat.z * 1.8 - 0.5, moist = vRvMat.w;
  float wetA = vRvMat2.x, glac = vRvMat2.y, curv = vRvMat2.z * 2.0 - 1.0, mtn = vRvMat2.w;
  float slope = 1.0 - dot( Ng, up );

  vec3 wg = pow( abs( Nl ), vec3( 6.0 ) ); wg /= dot( wg, vec3( 1.0 ) );
  vec3 wu = vec3( 0.0, 1.0, 0.0 );

  // ---- macro noise (periodic, up-projected): 512 m and 64 m
  vec4 mA = vec4( 0.0 ), mC = vec4( 0.0 );
  // up-projection on flat ground, geometric triplanar on steep faces (no vertical stretching on cliffs)
  vec3 wm = mix( wu, wg, smoothstep( 0.12, 0.35, slope ) );
  for ( int a = 0; a < 3; a++ ) {
    float wa = rvWa( a, wm );
    if ( wa <= 0.0 ) continue;
    vec2 uv = rvAx( a, L ), gx = rvAx( a, dLx ), gy = rvAx( a, dLy );
    mA += wa * textureGrad( uRvDetail, vec3( uv * ( 1.0 / 512.0 ), 5.0 ), gx * ( 1.0 / 512.0 ), gy * ( 1.0 / 512.0 ) );
    if ( dist < 2500.0 ) mC += wa * textureGrad( uRvDetail, vec3( uv * ( 1.0 / 64.0 ), 5.0 ), gx * ( 1.0 / 64.0 ), gy * ( 1.0 / 64.0 ) );
  }
  { float ws = dot( step( vec3( 0.06 ), wm ), wm ); mA /= ws; mC = dist < 2500.0 ? mC / ws : vec4( 0.5 ); }
  float n1 = mA.r - 0.5, n2 = mA.g - 0.5, n3 = mA.b - 0.5, n4 = mC.a - 0.5;
  float kS = mA.a;

  float fNear = ( 1.0 - smoothstep( 18.0, 70.0, dist ) ) * ( 1.0 - uRvLite );
  rvStoch = true;
  float fMid = ( 1.0 - smoothstep( uRvF.x, uRvF.y, dist ) ) * q;
  float fFar = ( 1.0 - smoothstep( uRvF.z, uRvF.w, dist ) ) * q;

  // ---- geometric layer weights
  float sea = uRvP.y;
  float hs = alt - sea;
  float rockS = smoothstep( 0.13 + 0.07 * n2 + 0.05 * n4, 0.29 + 0.07 * n2, slope );
  float wRock = clamp( max( rockS, rockA * 0.95 ), 0.0, 1.0 );
  float dryness = smoothstep( 0.3, 0.08, moist + 0.12 * n1 ) * ( 1.0 - 0.6 * uRvS2.x );
  float wSand = clamp( max( sandA, dryness * 0.9 ) * ( 1.0 - rockS ), 0.0, 1.0 );
  float coldness = smoothstep( 0.12, -0.08, temp + 0.10 * n2 + 0.05 * n4 );
  float snowPot = clamp( coldness + glac * 0.7 + uRvS.y + uRvS2.w, 0.0, 1.0 );
  float wScree = clamp( smoothstep( 0.06, 0.16, slope ) * ( 1.0 - rockS ) * smoothstep( 0.2, 0.6, mtn + rockA ) + wetA * 0.5, 0.0, 1.0 );
  float wGround = ( 1.0 - wRock ) * ( 1.0 - wSand );

  vec3 gradT = vec3( 0.0 );
  float hRock = 0.5, hGround = 0.5, hSand = 0.5, hSnow = 0.5, aRock = 0.5, aMacro = 0.5;
  vec4 dGround = vec4( 0.5 ), dSand = vec4( 0.5 ), dSnow = vec4( 0.5 ), dPeb = vec4( 0.5 );

  // ---- rock: triplanar on the geometric normal — 64 m macro facets (far), 8 m stochastic, 2 m micro
  if ( wRock > 0.02 && fFar > 0.0 ) {
    vec4 accM = vec4( 0.0 ), accA = vec4( 0.0 ), accN = vec4( 0.0 );
    vec3 gM = vec3( 0.0 ), gA = vec3( 0.0 ), gN = vec3( 0.0 ); float ws = 0.0;
    for ( int a = 0; a < 3; a++ ) {
      float wa = rvWa( a, wg );
      if ( wa <= 0.0 ) continue;
      vec2 uv = rvAx( a, L ), gx = rvAx( a, dLx ), gy = rvAx( a, dLy );
      ws += wa;
      // macro crags: 512 m and 128 m tiles (facets of ~100 m and ~25 m read from kilometres away)
      // (uv warped by the low-frequency noise so the macro tiles never line up)
      // organic buttresses/undulations (noise relief, 512 m) + faceted crags (layer 0, 256 m, warped)
      // each projection axis gets its own orientation so the three planes never show the same grain
      float fa = float( a );
      vec4 t = rvTexO( 5.0, uv * ( 1.0 / 512.0 ), gx * ( 1.0 / 512.0 ), gy * ( 1.0 / 512.0 ), 11.0 + fa, 1.0 );
      vec4 t2 = rvTexO( 0.0, uv * ( 1.0 / 256.0 ) + ( mA.rb - 0.5 ) * 1.4, gx * ( 1.0 / 256.0 ), gy * ( 1.0 / 256.0 ), 23.0 + fa * 3.0, 1.0 );
      t = vec4( 0.5 + ( t.rg - 0.5 ) * 1.0 + ( t2.rg - 0.5 ) * 0.6, t.b * 0.5 + t2.b * 0.5, t.a * 0.4 + t2.a * 0.6 );
      accM += wa * t; gM += wa * rvGw( a, t.rg * 2.0 - 1.0 );
      if ( fMid > 0.0 ) {
        t = rvFetchS( 0.0, uv * 0.125, gx * 0.125, gy * 0.125, kS + fa * 0.37, 1.0 );
        accA += wa * t; gA += wa * rvGw( a, t.rg * 2.0 - 1.0 );
        if ( fNear > 0.0 ) {
          t = rvTexO( 0.0, uv * 0.5, gx * 0.5, gy * 0.5, floor( kS * 11.0 ) + 5.0 + fa, 1.0 );
          accN += wa * t; gN += wa * rvGw( a, t.rg * 2.0 - 1.0 );
        }
      }
    }
    float iw = 1.0 / ws;
    accM *= iw; accA *= iw; accN *= iw;
    // relief strength: full on real faces, gentler where "rock" is only a generator hint on a mild
    // slope (under low sun, strong mid-scale bumps on near-flat ground read as brush strokes / fur)
    float kRel = 0.45 + 0.55 * max( rockS, smoothstep( 0.08, 0.3, slope ) );
    gradT += ( gM * iw * fFar * 0.75 + gA * iw * fMid * 0.75 + gN * iw * fNear * 0.6 ) * wRock * kRel;
    hRock = mix( 0.5, accM.b, fFar );
    hRock = mix( hRock, hRock * 0.4 + accA.b * 0.6, fMid );
    hRock = mix( hRock, hRock * 0.7 + accN.b * 0.3, fNear );
    aMacro = mix( 0.5, accM.a, fFar );
    aRock = mix( aMacro, aMacro * 0.45 + accA.a * 0.55, fMid );
    aRock = mix( aRock, aRock * 0.7 + accN.a * 0.3, fNear );
  }
  // ---- ground layers: projected along the planet's up (one axis loop for all of them)
  if ( wRock < 0.9 && fMid > 0.0 ) {
    vec4 aG = vec4( 0.0 ), aGn = vec4( 0.0 ), aS = vec4( 0.0 ), aW = vec4( 0.0 ), aP = vec4( 0.0 );
    vec3 gG = vec3( 0.0 ), gGn = vec3( 0.0 ), gS = vec3( 0.0 ), gW = vec3( 0.0 ), gP = vec3( 0.0 ); float ws = 0.0;
    bool doS = wSand > 0.02, doW = snowPot > 0.02, doP = wScree > 0.05, doN = fNear > 0.0;
    for ( int a = 0; a < 3; a++ ) {
      float wa = rvWa( a, wu );
      if ( wa <= 0.0 ) continue;
      vec2 uv = rvAx( a, L ), gx = rvAx( a, dLx ), gy = rvAx( a, dLy );
      ws += wa;
      vec4 t = rvFetchS( 1.0, uv * 0.25, gx * 0.25, gy * 0.25, kS, 1.0 ); aG += wa * t; gG += wa * rvGw( a, t.rg * 2.0 - 1.0 );
      if ( doN ) { t = textureGrad( uRvDetail, vec3( uv, 1.0 ), gx, gy ); aGn += wa * t; gGn += wa * rvGw( a, t.rg * 2.0 - 1.0 ); }
      if ( doS ) { t = rvFetchS( 2.0, uv * 0.25, gx * 0.25, gy * 0.25, kS, 0.0 ); aS += wa * t; gS += wa * rvGw( a, t.rg * 2.0 - 1.0 ); }
      if ( doW ) { t = textureGrad( uRvDetail, vec3( uv * 0.125, 3.0 ), gx * 0.125, gy * 0.125 ); aW += wa * t; gW += wa * rvGw( a, t.rg * 2.0 - 1.0 ); }
      if ( doP ) { t = textureGrad( uRvDetail, vec3( uv * 0.5, 4.0 ), gx * 0.5, gy * 0.5 ); aP += wa * t; gP += wa * rvGw( a, t.rg * 2.0 - 1.0 ); }
    }
    float iw = 1.0 / ws;
    dGround = aG * iw; gradT += gG * iw * wGround * 0.5 * fMid;
    if ( doN ) { dGround = mix( dGround, dGround * 0.5 + aGn * iw * 0.5, fNear ); gradT += gGn * iw * wGround * 0.35 * fNear; }
    hGround = mix( 0.5, dGround.b, fMid );
    if ( doS ) { dSand = aS * iw; gradT += gS * iw * wSand * ( 1.0 - wRock ) * 0.5 * fMid * ( 0.25 + 0.75 * ( 1.0 - smoothstep( 40.0, 300.0, dist ) ) ); hSand = mix( 0.5, dSand.b, fMid ); }
    if ( doW ) { dSnow = aW * iw; gradT += gW * iw * snowPot * ( 1.0 - wRock ) * 0.45 * fMid; hSnow = mix( 0.5, dSnow.b, fMid ); }
    if ( doP ) { dPeb = aP * iw; gradT += gP * iw * wScree * ( 1.0 - wRock ) * 0.6 * fMid; }
  }

  // ---- cliff faces: sedimentary strata (layer 6, altitude-locked, noise-warped) and drainage /
  //      desert-varnish streaks (layer 7). Both project on the two vertical planes of the local
  //      frame (u-facing → v,alt and v-facing → u,alt), blended by the geometric normal.
  float bandH = 16.0 + 14.0 * uRvS.x;
  float band = alt / bandH + 2.2 * n2 + 1.4 * n4 + 0.8 * n1;
  float bi = floor( band ), bf = fract( band );
  float bh = fract( sin( bi * 12.9898 + 4.1 ) * 43758.5453 );
  float streakD = 0.0, streakL = 0.0, strA = 0.5;
  float sideW = wg.x + wg.z;
  if ( rockS > 0.05 && fFar > 0.0 && sideW > 0.05 ) {
    float wx = wg.x / sideW, wz = wg.z / sideW;
    float dAx = dLx.y, dAy = dLy.y;
    // streaks: 128 m x 256 m tiles, horizontal coordinate warped by two noise scales (no fixed period)
    float warp = ( mA.r - 0.5 ) * 90.0 + ( mC.b - 0.5 ) * 24.0;
    vec4 sx = vec4( 0.0 ), sz = vec4( 0.0 );
    if ( wx > 0.02 ) sx = textureGrad( uRvDetail, vec3( ( L.z + warp ) / 128.0, alt / 256.0, 7.0 ), vec2( dLx.z / 128.0, dAx / 256.0 ), vec2( dLy.z / 128.0, dAy / 256.0 ) );
    if ( wz > 0.02 ) sz = textureGrad( uRvDetail, vec3( ( L.x + warp ) / 128.0 + 0.37, alt / 256.0 + 0.21, 7.0 ), vec2( dLx.x / 128.0, dAx / 256.0 ), vec2( dLy.x / 128.0, dAy / 256.0 ) );
    vec4 st7 = sx * wx + sz * wz;
    // streaks gather in chutes/concavities, avoid convex ribs, and come and go in patches
    float sMask = smoothstep( 0.3, 0.8, rockS ) * smoothstep( 0.22, 0.5, slope ) * clamp( 0.3 + 1.1 * max( curv, 0.0 ) - 0.6 * max( -curv, 0.0 ) + 0.6 * ( mC.b - 0.5 ), 0.0, 1.0 )
                * smoothstep( 0.25, 0.65, mA.a + 0.25 * n4 ) * fFar;
    streakD = st7.b * sMask;
    streakL = max( st7.a - 0.5, 0.0 ) * 2.0 * sMask;
    // strata: real ledges (layer 6 relief) aligned with the colour bands, only on layered-rock worlds
    // (only on real faces: projected onto the vertical planes, a gentle slope would stretch the
    //  layers into contour-parallel brush strokes)
    float kStr = smoothstep( 0.4, 0.9, uRvS.x ) * rockS * smoothstep( 0.3, 0.6, slope ) * fFar;
    if ( kStr > 0.01 ) {
      float vS = band / 9.0, dvx = dAx / ( bandH * 9.0 ), dvy = dAy / ( bandH * 9.0 );
      vec4 ax = vec4( 0.5 ), az = vec4( 0.5 );
      if ( wx > 0.02 ) ax = textureGrad( uRvDetail, vec3( L.z / 128.0, vS, 6.0 ), vec2( dLx.z / 128.0, dvx ), vec2( dLy.z / 128.0, dvy ) );
      if ( wz > 0.02 ) az = textureGrad( uRvDetail, vec3( L.x / 128.0 + 0.5, vS, 6.0 ), vec2( dLx.x / 128.0, dvx ), vec2( dLy.x / 128.0, dvy ) );
      vec4 s6 = ax * wx + az * wz;
      // (gradient in local coordinates: x = u, y = up, z = v)
      vec3 gS = vec3( wz * ( az.r * 2.0 - 1.0 ), s6.g * 2.0 - 1.0, wx * ( ax.r * 2.0 - 1.0 ) );
      gradT += gS * kStr * 0.9;
      hRock = mix( hRock, hRock * 0.5 + s6.b * 0.5, kStr );
      strA = mix( 0.5, s6.a, kStr );
    }
  }
  // wind-drift relief on snowfields (64 m noise-relief slopes): shading on otherwise flat white
  gradT += vec3( mC.r - 0.5, 0.0, mC.g - 0.5 ) * 0.9 * snowPot * ( 1.0 - wRock ) * fFar;
  // ---- detail normal (surface gradient: local → world, then onto the tangent plane)
  gradT = Tu * gradT.x + up * gradT.y + Tv * gradT.z;
  gradT -= Ng * dot( gradT, Ng );
  rvN = normalize( Ng - gradT * 1.1 );
  float ndu = dot( rvN, up );

  // ---- final blend weights (snow on up-facing micro facets, rock peeks through)
  float bRock = rvHB( wRock, 0.6 * hRock + 0.4 * mC.g, 0.12 );
  float bSand = rvHB( wSand, 0.5 * ( 1.0 - hGround ) + 0.5 * mC.r, 0.34 );
  float snowFacing = smoothstep( 0.52 + 0.12 * n1, 0.82, ndu + 0.12 * ( hSnow - 0.5 ) + 0.25 * clamp( curv, 0.0, 1.0 ) );
  float bSnow = smoothstep( 0.3, 0.7, snowPot * snowFacing + ( hSnow - 0.5 ) * 0.15 );

  // ---- colors
  float lush = clamp( smoothstep( 0.3, 0.75, moist + 0.22 * n3 ) * uRvS2.x, 0.0, 1.0 );
  vec3 grassC = mix( uRvGrass2, uRvGrass, lush );
  grassC = mix( grassC, uRvForest, smoothstep( 0.6, 0.9, moist + 0.25 * n1 ) * uRvS2.y );
  grassC = mix( grassC, uRvDry, smoothstep( 0.4, 0.15, moist + 0.2 * n3 ) * 0.6 * ( 1.0 - 0.65 * uRvS2.x ) );
  grassC = mix( grassC, uRvGrass2 * vec3( 1.0, 0.92, 0.78 ), smoothstep( 0.28, 0.1, temp ) * 0.6 );
  grassC = mix( grassC, uRvGrass2, smoothstep( 0.55, 0.8, mC.r ) * 0.35 );
  grassC = mix( grassC, uRvForest * 0.85, smoothstep( 0.45, 0.85, mC.g * 0.5 + mA.g * 0.5 + 0.3 * n3 ) * 0.35 );
  grassC = mix( grassC, vec3( rvLum( grassC ) ), 0.26 );
  grassC *= 0.78 + 0.44 * mA.b + 0.2 * n4;
  // meadows (where the flora track grows dense grass): from mid distance the ground takes the grass
  // blade colour and loses soil patches, so meadows read dense where individual blades fade out
  float meadow = ( 1.0 - wRock ) * ( 1.0 - wSand ) * smoothstep( 0.3, 0.55, moist + 0.1 * n3 ) * smoothstep( 0.1, 0.3, temp ) * uRvS2.x;
  float soilM = smoothstep( 0.68, 0.95, mC.b * 0.6 + mA.b * 0.4 + 0.15 * n1 + 0.25 * wScree ) * ( 1.0 - 0.6 * meadow );
  grassC = mix( grassC, uRvBlade * ( 0.9 + 0.2 * mA.b ), meadow * mix( 0.25, 0.6, smoothstep( 15.0, 90.0, dist ) ) );
  vec3 groundC = mix( grassC, uRvSoil, soilM * 0.55 );
  groundC *= 0.8 + 0.4 * mix( 0.5, dGround.a, fMid );
  groundC = mix( groundC, uRvSoil * 0.95, wScree * 0.55 * mix( 0.6, dPeb.b, fMid ) );

  // rock tone: palette rock pulled toward neutral grey, strata bands only where the style asks for it
  vec3 rockBase = mix( uRvRock, vec3( rvLum( uRvRock ) ) * vec3( 0.95, 0.99, 1.07 ), 0.45 );
  float sk = uRvS.x * uRvS.x;
  // colour bands only on real faces: on gentle slopes altitude-locked bands become contour rings
  // (the "wood grain" look)
  float kBand = smoothstep( 0.25, 0.6, slope );
  vec3 rockC = mix( rockBase, uRvRock2, smoothstep( 0.2, 0.9, bh ) * ( 0.05 + 0.7 * sk ) * kBand );
  rockC = mix( rockC, uRvSand * 0.8, smoothstep( 0.8, 0.97, bh ) * 0.35 * sk * kBand * smoothstep( 0.55, 0.8, uRvS.x ) );
  // large lighter / darker rock bodies (tens to hundreds of metres) — not uniform grey noise
  rockC = mix( rockC, rockBase * 0.62, smoothstep( 0.35, 0.65, mC.g + 0.3 * n2 ) * 0.3 );
  rockC = mix( rockC, rockBase * 1.18 + 0.02, smoothstep( 0.55, 0.8, mA.g + 0.25 * n3 ) * 0.35 );
  rockC *= 0.68 + 0.64 * aRock;
  rockC *= 0.8 + 0.4 * strA;
  // drainage streaks: dark varnish (slightly warm) and rarer pale mineral streaks
  rockC = mix( rockC, rockC * vec3( 0.6, 0.56, 0.52 ), clamp( streakD * 0.75, 0.0, 0.6 ) );
  rockC = mix( rockC, rockC * 1.12 + vec3( 0.02 ), clamp( streakL * 0.3, 0.0, 0.25 ) );
  rockC *= 0.9 + 0.2 * mA.g;
  rockC *= mix( vec3( 1.07, 1.0, 0.9 ), vec3( 0.9, 0.97, 1.08 ), smoothstep( 0.25, 0.75, mA.b + 0.3 * n4 ) );
  // lichen / moss on moderately steep, moist rock
  rockC = mix( rockC, grassC * 0.75, ( 1.0 - rockS ) * smoothstep( 0.4, 0.8, moist ) * 0.45 * uRvS2.x );
  vec3 sandC = uRvSand * ( 0.86 + 0.28 * mix( 0.5, dSand.a, fMid * fNear * 0.7 + fMid * 0.3 ) + 0.12 * n1 + 0.08 * n4 );
  // snow: albedo below 1 (keeps sun-lit fields from clipping into flat white), wind-packed / fresh
  // patches, bluish hollows
  vec3 snowC = uRvSnow * ( 0.8 + 0.1 * mA.b + 0.06 * n4 + 0.06 * mix( 0.5, dSnow.a, fMid ) );
  snowC = mix( snowC, snowC * vec3( 0.84, 0.91, 1.04 ), clamp( curv, 0.0, 1.0 ) * 0.5 + smoothstep( 0.55, 0.8, mC.b ) * 0.25 );

  vec3 col = groundC;
  col = mix( col, sandC, bSand );
  col = mix( col, rockC, bRock );
  // vegetation on up-facing ledges of lush-world cliffs (moss/grass pockets break up big faces)
  float ledgeUp = smoothstep( 0.72, 0.93, ndu + 0.25 * ( hRock - 0.5 ) + 0.1 * n4 );
  float vegOK = uRvS2.x * smoothstep( 0.25, 0.55, moist + 0.2 * n3 ) * smoothstep( 0.05, 0.3, temp ) * ( 1.0 - smoothstep( 0.85, 1.0, rockA * mtn ) * 0.5 );
  col = mix( col, grassC * 0.72, bRock * ledgeUp * vegOK * 0.85 );
  col = mix( col, snowC, bSnow );

  // ---- shore / underwater / wetness
  float rough = mix( 0.95, 0.78, bRock );
  rough = mix( rough, 0.88, bSand * ( 1.0 - bRock ) );
  rough = mix( rough, 0.55, bSnow );
  float wet = 0.0;
  if ( sea > -1e8 ) {
    float shore = 1.0 - smoothstep( 0.2, 2.2 + 1.5 * n4, hs );
    wet = max( wet, shore );
    if ( hs < 0.0 ) col = mix( col, uRvSeabed, 0.35 + 0.5 * smoothstep( 0.0, 30.0, -hs ) );
  }
  wet = max( wet, wetA * 0.8 );
  wet = max( wet, uRvS2.z * ( 1.0 - bSnow ) * 0.8 );
  col *= 1.0 - 0.42 * wet * ( 1.0 - bSnow );
  rough = mix( rough, 0.18, wet * ( 1.0 - bSnow ) * 0.9 );

  // ---- cavity / AO
  float cav = clamp( curv, 0.0, 1.0 );
  float hD = mix( mix( hGround, hSand, bSand ), hRock, bRock );
  hD = mix( hD, hSnow, bSnow * 0.7 );
  // one occlusion budget: albedo cavity + ambient AO never stack below a sane floor (the old
  // multiplicative chain drove shadowed rock toward black, especially under ambient-only light)
  rvAO = clamp( ( 1.0 - 0.35 * cav ) * mix( mix( 0.62, 0.5, bRock ), 1.06, hD ), 0.45, 1.0 );
  float occ = mix( 1.0, 0.74 + 0.46 * hD, bRock ) * ( 1.0 - 0.16 * cav * ( 1.0 - bSnow ) );
  col *= max( occ, 0.66 );
  col *= 1.0 + ( 0.1 + 0.1 * bRock ) * clamp( -curv, 0.0, 1.0 );

  // ---- emissive extras
  rvEmis = vec3( 0.0 );
  if ( bSnow > 0.05 && dist < 60.0 ) {   // snow glitter
    vec3 cell = floor( C * 22.0 );
    float sp = step( 0.985, fract( sin( dot( cell, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ) );
    vec3 V = normalize( cameraPosition - W );
    float spec = pow( max( dot( reflect( -uRvSun, rvN ), V ), 0.0 ), 40.0 );
    rvEmis += vec3( 1.0, 0.98, 0.95 ) * sp * spec * bSnow * ( 1.0 - smoothstep( 20.0, 60.0, dist ) ) * 6.0 * max( dot( up, uRvSun ), 0.0 );
  }
  if ( uRvS.z > 0.0 ) {                   // volcanic: glowing cracks in lowland basalt
    float crack = smoothstep( 0.35, 0.05, hRock ) * smoothstep( 0.0, 0.5, cav + 0.3 ) * smoothstep( 0.4, 0.0, alt / uRvP.z );
    rvEmis += uRvAccent * crack * uRvS.z * 2.5 * ( 0.7 + 0.3 * sin( uRvTime * 1.3 + n4 * 20.0 ) );
  }
  rvRough = clamp( rough, 0.05, 1.0 );
  albedo = clamp( col, 0.0, 1.0 );
  // tdebug=3: unlit albedo as emissive (lighting-independent); tdebug=4: NaN finder (red normal,
  // green albedo, blue AO/roughness) as emissive
  if ( uRvDebug > 2.5 ) {
    rvEmis = uRvDebug < 3.5 ? albedo : vec3( any( isnan( rvN ) ) ? 1.0 : 0.0, any( isnan( col ) ) ? 1.0 : 0.0, ( isnan( rvAO ) || isnan( rvRough ) ) ? 1.0 : 0.0 ) + 0.05;
    return;
  }
  if ( uRvDebug > 0.5 ) albedo = uRvDebug < 1.5 ? vec3( bRock, ( 1.0 - bRock ) * ( 1.0 - bSand ) * ( 1.0 - bSnow ), bSand ) + bSnow : vec3( rockA, sandA, wetA );
}
`;

function col(hex, fb) { const c = new THREE.Color(); try { c.set(hex ?? fb); } catch (_) { c.set(fb); } return c; }

/** Per-world style knobs from type + art key. */
export function terrainStyle(body) {
  const art = body.art?.key || '';
  const T = body.type;
  let strata = { moebius: 1, bebop: 1, starfield: 0.8, bierstadt: 0.55, nms: 0.6, villeneuve: 0.7, kubrick: 0.4, stalenhag: 0.35, botw: 0.45, friedrich: 0.5, turner: 0.5 }[art] ?? 0.45;
  if (T === 'desert' || T === 'savanna' || T === 'barren') strata = Math.max(strata, 0.75);
  const lush = { jungle: 1, terran: 0.9, ocean: 0.9, archipelago: 0.95, toxic: 0.8, exotic: 0.85, savanna: 0.35, desert: 0.1, arctic: 0.3, barren: 0, volcanic: 0.05, crystal: 0.3 }[T] ?? 0.7;
  const forest = { jungle: 0.8, terran: 0.55, ocean: 0.45, archipelago: 0.5, exotic: 0.6, toxic: 0.6 }[T] ?? 0.3;
  return {
    strata,
    snowBias: T === 'arctic' ? 0.15 : 0,
    volcanic: T === 'volcanic' ? 1 : 0,
    crystal: T === 'crystal' ? 1 : 0,
    lush, forest,
  };
}

export function createTerrainMaterial(body, quality, opts = {}) {
  const p = body.art?.palette || {};
  const st = terrainStyle(body);
  const rock = col(p.rock, '#8a7d6c');
  const sand = col(p.sand, '#d9c9a0');
  const grass = col(p.grass, '#6f8f45');
  const grass2 = col(p.grass2, '#a7ad5d');
  const forest = col(p.flora?.[0], p.grass ?? '#4d6a30');
  const accent = col(p.accent, '#ffb060');
  const deep = col(p.deep, '#1c3a48');
  const rock2 = rock.clone().multiplyScalar(0.58).lerp(sand, 0.12);
  const soil = rock.clone().lerp(sand, 0.45).multiplyScalar(0.72);
  const dry = grass2.clone().lerp(sand, 0.55);
  const seabed = sand.clone().multiplyScalar(0.55).lerp(deep, 0.35);
  // average colour of the flora track's grass blades (base → tip), see flora/styles.js
  const blade = grass.clone().lerp(new THREE.Color(0.015, 0.035, 0.008), 0.3).multiplyScalar(0.5)
    .add(grass.clone().lerp(grass2, 0.55).lerp(new THREE.Color(0.75, 1, 0.45), 0.08).multiplyScalar(0.5));
  // barren / volcanic worlds: no vegetation colors on the ground
  if (body.type === 'barren' || body.type === 'volcanic') {
    const base = body.type === 'volcanic' ? new THREE.Color(0.035, 0.03, 0.028) : rock.clone().lerp(sand, 0.4);
    grass.copy(base); grass2.copy(base).lerp(sand, 0.25); forest.copy(base).multiplyScalar(0.8); dry.copy(grass2);
    soil.copy(base).multiplyScalar(0.8);
  }
  if (body.type === 'arctic') { grass2.lerp(new THREE.Color(0.55, 0.6, 0.62), 0.35); }

  const uniforms = {
    uRvDetail: { value: null },
    uRvOriginMod: { value: new THREE.Vector3() },
    uRvPlanetCenter: G.uPlanetCenter,
    uRvSun: G.uSunDir,
    uRvCam: G.uCameraPos,
    uRvPlanetC: G.uPlanetCenter,
    uRvTime: G.uTime,
    uRvDebug: { value: (() => { try { return +(new URLSearchParams(globalThis.location?.search || '').get('tdebug') || 0); } catch (_) { return 0; } })() },
    uRvBlade: { value: blade },
    uRvGrass: { value: grass }, uRvGrass2: { value: grass2 }, uRvRock: { value: rock }, uRvRock2: { value: rock2 },
    uRvSand: { value: sand }, uRvSnow: { value: col(p.snow, '#f4f6fa') }, uRvForest: { value: forest },
    uRvSoil: { value: soil }, uRvAccent: { value: accent }, uRvDry: { value: dry }, uRvSeabed: { value: seabed },
    uRvP: { value: new THREE.Vector4(body.radius, body.ocean?.present ? 0 : -1e9, body.terrain?.amplitude || 3000, quality?.tier === 'low' ? 0.6 : 1) },
    uRvS: { value: new THREE.Vector4(st.strata, st.snowBias, st.volcanic, st.crystal) },
    uRvS2: { value: new THREE.Vector4(st.lush, st.forest, 0, 0) },
    uRvLite: { value: opts.lite ? 1 : 0 },
    uRvF: { value: opts.lite ? new THREE.Vector4(160, 700, 2500, 7000) : new THREE.Vector4(250, 1400, 6000, 20000) },
  };

  // opts.lite: Lambert lighting (software rasterizers / headless captures, where GGX + IBL on every
  // terrain pixel dominates frame time). Same albedo, normals, AO and emissive; no specular.
  const mat = opts.lite
    ? new THREE.MeshLambertMaterial({ color: 0xffffff })
    : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
  mat.name = 'rv-terrain';
  mat.userData.rvTerrain = true;
  try { if (new URLSearchParams(globalThis.location?.search || '').get('tnoatmo')) mat.userData.noCSM = true; } catch (_) { /* */ }
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + VERT_PARS);
    vs = vs.replace('#include <beginnormal_vertex>', VERT_NORMAL);
    vs = vs.replace('#include <begin_vertex>', VERT_BEGIN);
    vs = vs.replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_SKIRT);
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\n' + FRAG_PARS);
    fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n{ vec3 rvAlb; rvTerrain( rvAlb ); diffuseColor.rgb *= rvAlb; }');
    fs = fs.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rvRough;');
    fs = fs.replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( rvN, 0.0 ) ).xyz );');
    fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rvEmis;');
    fs = fs.replace('#include <aomap_fragment>', /* glsl */`
      reflectedLight.indirectDiffuse *= rvAO;
      reflectedLight.indirectSpecular *= mix( 1.0, rvAO, 0.8 );
      reflectedLight.directDiffuse *= mix( 1.0, rvAO, 0.35 );`);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'rv-terrain-v18' + (opts.lite ? 'L' : '');
  return mat;
}

/** Shadow-pass material with the same geomorph as the visible surface (no self-shadow streaks). */
export function createTerrainDepthMaterial() {
  const m = new THREE.MeshDepthMaterial();
  m.name = 'rv-terrain-depth';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRvCam = G.uCameraPos;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRvCam;\nattribute vec4 aMorph;')
      .replace('#include <begin_vertex>', `vec4 rvW0 = modelMatrix * vec4( position, 1.0 );
float rvK = smoothstep( 0.66, 0.93, distance( rvW0.xyz, uRvCam ) / aMorph.w );
vec3 transformed = position + aMorph.xyz * rvK;`);
  };
  m.customProgramCacheKey = () => 'rv-terrain-depth-v1';
  return m;
}

/** Keep the periodic detail anchor in sync with the floating origin (float64 on the CPU). */
export function updateOriginMod(mat, origin) {
  const u = mat.userData.uniforms.uRvOriginMod.value;
  const P = DETAIL_PERIOD;
  u.set(((origin.x % P) + P) % P, ((origin.y % P) + P) % P, ((origin.z % P) + P) % P);
}
