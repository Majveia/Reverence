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
attribute vec3 aMorphN;
attribute vec4 aMat;
attribute vec4 aMat2;
varying vec3 vRvW;
varying vec3 vRvN;
varying vec4 vRvMat;
varying vec4 vRvMat2;
`;

const VERT_NORMAL = /* glsl */`
vec4 rvW0 = modelMatrix * vec4( position, 1.0 );
float rvK = smoothstep( 0.66, 0.93, distance( rvW0.xyz, uRvCam ) / aMorph.w );
vec3 objectNormal = normalize( mix( normal, aMorphN, rvK ) );
vRvN = objectNormal;
vRvMat = aMat;
vRvMat2 = aMat2;
`;

const VERT_BEGIN = /* glsl */`
vec3 transformed = position + aMorph.xyz * rvK;
vRvW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const FRAG_PARS = /* glsl */`
precision highp sampler2DArray;
uniform sampler2DArray uRvDetail;
uniform vec3 uRvOriginMod;
uniform vec3 uRvPlanetCenter;
uniform vec3 uRvSun;
uniform vec3 uRvGrass, uRvGrass2, uRvRock, uRvRock2, uRvSand, uRvSnow, uRvForest, uRvSoil, uRvAccent, uRvDry, uRvSeabed;
uniform vec4 uRvP;   // radius, seaLevel, amp, detail quality (0..1)
uniform vec4 uRvS;   // strata, snow bias, volcanic glow, crystal sheen
uniform vec4 uRvS2;  // lushness, forest darkening, global wetness, global snow
uniform float uRvTime;
uniform float uRvDebug;
varying vec3 vRvW;
varying vec3 vRvN;
varying vec4 vRvMat;
varying vec4 vRvMat2;

vec3 rvN; float rvRough; float rvAO; vec3 rvEmis; bool rvStoch;
float rvLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

// ---- compact triplanar sampling: ONE loop over the projection axes per material group keeps the
//      program small (fast compiles everywhere, incl. software rasterizers) — fetches use explicit
//      gradients so they are legal inside the dynamic branches.
vec2 rvAx( int a, vec3 v ) { return a == 0 ? v.zy : ( a == 1 ? v.xz : v.xy ); }
vec3 rvGw( int a, vec2 g ) { return a == 0 ? vec3( 0.0, g.y, g.x ) : ( a == 1 ? vec3( g.x, 0.0, g.y ) : vec3( g.x, g.y, 0.0 ) ); }
float rvWa( int a, vec3 w ) { float v = a == 0 ? w.x : ( a == 1 ? w.y : w.z ); return v < 0.06 ? 0.0 : v; }
// IQ "texture repetition" #3: two offset fetches blended by a smooth per-region index
vec4 rvFetchS( float layer, vec2 uv, vec2 dx, vec2 dy, float k ) {
  float l = k * 7.0; float i = floor( l ); float f = fract( l );
  vec2 oa = fract( sin( vec2( 3.0, 7.0 ) * i + vec2( 0.3, 0.7 ) ) * 43758.5453 );
  vec4 a = textureGrad( uRvDetail, vec3( uv + oa, layer ), dx, dy );
  // second fetch only where the blend actually needs it and only up close (tiling is invisible far away)
  if ( rvStoch && f > 0.2 && f < 0.8 ) {
    vec2 ob = fract( sin( vec2( 3.0, 7.0 ) * ( i + 1.0 ) + vec2( 0.3, 0.7 ) ) * 43758.5453 );
    vec4 b = textureGrad( uRvDetail, vec3( uv + ob, layer ), dx, dy );
    return mix( a, b, smoothstep( 0.25, 0.75, f + 0.6 * ( a.b - b.b ) ) );
  }
  return a;
}

float rvHB( float w, float h, float c ) { // height-blend: detail height pushes transitions around
  return smoothstep( 0.5 - c, 0.5 + c, w + ( h - 0.5 ) * 0.55 * ( 1.0 - abs( w * 2.0 - 1.0 ) ) );
}

void rvTerrain( inout vec3 albedo ) {
  vec3 W = vRvW;
  vec3 Lp = W - uRvPlanetCenter;
  float r = length( Lp );
  vec3 up = Lp / r;
  float alt = r - uRvP.x;
  vec3 Ng = normalize( vRvN );
  float dist = length( W - cameraPosition );
  vec3 C = W + uRvOriginMod;
  float q = uRvP.w;

  float rockA = vRvMat.x, sandA = vRvMat.y, temp = vRvMat.z * 1.8 - 0.5, moist = vRvMat.w;
  float wetA = vRvMat2.x, glac = vRvMat2.y, curv = vRvMat2.z * 2.0 - 1.0, mtn = vRvMat2.w;
  float slope = 1.0 - dot( Ng, up );

  vec3 wg = pow( abs( Ng ), vec3( 6.0 ) ); wg /= dot( wg, vec3( 1.0 ) );
  vec3 wu = pow( abs( up ), vec3( 8.0 ) ); wu /= dot( wu, vec3( 1.0 ) );
  vec3 dCx = dFdx( C ), dCy = dFdy( C );

  // ---- macro noise (periodic, up-projected): 512 m and 64 m
  vec4 mA = vec4( 0.0 ), mC = vec4( 0.0 );
  // up-projection on flat ground, geometric triplanar on steep faces (no vertical stretching on cliffs)
  vec3 wm = mix( wu, wg, smoothstep( 0.12, 0.35, slope ) );
  for ( int a = 0; a < 3; a++ ) {
    float wa = rvWa( a, wm );
    if ( wa <= 0.0 ) continue;
    vec2 uv = rvAx( a, C ), gx = rvAx( a, dCx ), gy = rvAx( a, dCy );
    mA += wa * textureGrad( uRvDetail, vec3( uv * ( 1.0 / 512.0 ), 5.0 ), gx * ( 1.0 / 512.0 ), gy * ( 1.0 / 512.0 ) );
    if ( dist < 2500.0 ) mC += wa * textureGrad( uRvDetail, vec3( uv * ( 1.0 / 64.0 ), 5.0 ), gx * ( 1.0 / 64.0 ), gy * ( 1.0 / 64.0 ) );
  }
  { float ws = dot( step( vec3( 0.06 ), wm ), wm ); mA /= ws; mC = dist < 2500.0 ? mC / ws : vec4( 0.5 ); }
  float n1 = mA.r - 0.5, n2 = mA.g - 0.5, n3 = mA.b - 0.5, n4 = mC.a - 0.5;
  float kS = mA.a;

  float fNear = 1.0 - smoothstep( 18.0, 70.0, dist );
  rvStoch = dist < 260.0;
  float fMid = ( 1.0 - smoothstep( 250.0, 1400.0, dist ) ) * q;
  float fFar = ( 1.0 - smoothstep( 6000.0, 20000.0, dist ) ) * q;

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
      vec2 uv = rvAx( a, C ), gx = rvAx( a, dCx ), gy = rvAx( a, dCy );
      ws += wa;
      // macro crags: 512 m and 128 m tiles (facets of ~100 m and ~25 m read from kilometres away)
      // (uv warped by the low-frequency noise so the macro tiles never line up)
      // organic buttresses/undulations (noise relief, 96 m) + faceted crags (layer 0, 256 m, warped)
      vec4 t = textureGrad( uRvDetail, vec3( uv * ( 1.0 / 512.0 ) + 0.13, 5.0 ), gx * ( 1.0 / 512.0 ), gy * ( 1.0 / 512.0 ) );
      vec4 t2 = textureGrad( uRvDetail, vec3( uv * ( 1.0 / 192.0 ) + 0.71 + ( mA.rb - 0.5 ) * 1.4, 0.0 ), gx * ( 1.0 / 192.0 ), gy * ( 1.0 / 192.0 ) );
      t = vec4( 0.5 + ( t.rg - 0.5 ) * 1.0 + ( t2.rg - 0.5 ) * 0.6, t.b * 0.5 + t2.b * 0.5, t.a * 0.4 + t2.a * 0.6 );
      accM += wa * t; gM += wa * rvGw( a, t.rg * 2.0 - 1.0 );
      if ( fMid > 0.0 ) {
        t = rvFetchS( 0.0, uv * 0.125, gx * 0.125, gy * 0.125, kS );
        accA += wa * t; gA += wa * rvGw( a, t.rg * 2.0 - 1.0 );
        if ( fNear > 0.0 ) {
          t = textureGrad( uRvDetail, vec3( uv * 0.5, 0.0 ), gx * 0.5, gy * 0.5 );
          accN += wa * t; gN += wa * rvGw( a, t.rg * 2.0 - 1.0 );
        }
      }
    }
    float iw = 1.0 / ws;
    accM *= iw; accA *= iw; accN *= iw;
    gradT += ( gM * iw * fFar * 1.1 + gA * iw * fMid * 1.0 + gN * iw * fNear * 0.6 ) * wRock;
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
      vec2 uv = rvAx( a, C ), gx = rvAx( a, dCx ), gy = rvAx( a, dCy );
      ws += wa;
      vec4 t = rvFetchS( 1.0, uv * 0.25, gx * 0.25, gy * 0.25, kS ); aG += wa * t; gG += wa * rvGw( a, t.rg * 2.0 - 1.0 );
      if ( doN ) { t = textureGrad( uRvDetail, vec3( uv, 1.0 ), gx, gy ); aGn += wa * t; gGn += wa * rvGw( a, t.rg * 2.0 - 1.0 ); }
      if ( doS ) { t = rvFetchS( 2.0, uv * 0.25, gx * 0.25, gy * 0.25, kS ); aS += wa * t; gS += wa * rvGw( a, t.rg * 2.0 - 1.0 ); }
      if ( doW ) { t = textureGrad( uRvDetail, vec3( uv * 0.125, 3.0 ), gx * 0.125, gy * 0.125 ); aW += wa * t; gW += wa * rvGw( a, t.rg * 2.0 - 1.0 ); }
      if ( doP ) { t = textureGrad( uRvDetail, vec3( uv * 0.5, 4.0 ), gx * 0.5, gy * 0.5 ); aP += wa * t; gP += wa * rvGw( a, t.rg * 2.0 - 1.0 ); }
    }
    float iw = 1.0 / ws;
    dGround = aG * iw; gradT += gG * iw * wGround * 0.5 * fMid;
    if ( doN ) { dGround = mix( dGround, dGround * 0.5 + aGn * iw * 0.5, fNear ); gradT += gGn * iw * wGround * 0.35 * fNear; }
    hGround = mix( 0.5, dGround.b, fMid );
    if ( doS ) { dSand = aS * iw; gradT += gS * iw * wSand * ( 1.0 - wRock ) * 0.5 * fMid * ( 0.25 + 0.75 * ( 1.0 - smoothstep( 40.0, 300.0, dist ) ) ); hSand = mix( 0.5, dSand.b, fMid ); }
    if ( doW ) { dSnow = aW * iw; gradT += gW * iw * snowPot * ( 1.0 - wRock ) * 0.3 * fMid; hSnow = mix( 0.5, dSnow.b, fMid ); }
    if ( doP ) { dPeb = aP * iw; gradT += gP * iw * wScree * ( 1.0 - wRock ) * 0.6 * fMid; }
  }

  // ---- strata ledges on cliffs (altitude-locked, subtle) + vertical weathering streaks
  float band = alt / ( 16.0 + 14.0 * uRvS.x ) + 2.2 * n2 + 1.4 * n4 + 0.8 * n1;
  float bi = floor( band ), bf = fract( band );
  float bh = fract( sin( bi * 12.9898 + 4.1 ) * 43758.5453 );
  float streak = 0.5;
  if ( rockS > 0.05 && fFar > 0.0 ) {
    float hx = ( wg.x > wg.z ? C.z : C.x );
    vec2 uvS = vec2( hx / 16.0, alt / 160.0 );
    streak = mix( 0.5, textureGrad( uRvDetail, vec3( uvS, 5.0 ), dFdx( uvS ), dFdy( uvS ) ).g, fFar );
    // ledge: a small step at each band boundary, facing up
    float ledge = smoothstep( 0.0, 0.08, bf ) * ( 1.0 - smoothstep( 0.08, 0.3, bf ) );
    gradT -= up * ( ledge - 0.3 ) * uRvS.x * rockS * 0.35 * fFar;
  }

  // ---- detail normal (surface gradient, world space)
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
  grassC = mix( grassC, uRvForest * 0.85, smoothstep( 0.5, 0.75, mC.b + 0.3 * n3 ) * 0.4 );
  grassC = mix( grassC, vec3( rvLum( grassC ) ), 0.26 );
  grassC *= 0.78 + 0.44 * mA.b + 0.2 * n4;
  float soilM = smoothstep( 0.62, 0.8, mC.b + 0.2 * mA.r + 0.25 * wScree );
  vec3 groundC = mix( grassC, uRvSoil, soilM * 0.8 );
  groundC *= 0.8 + 0.4 * mix( 0.5, dGround.a, fMid );
  groundC = mix( groundC, uRvSoil * 0.95, wScree * 0.55 * mix( 0.6, dPeb.b, fMid ) );

  // rock tone: palette rock pulled toward neutral grey, strata bands only where the style asks for it
  vec3 rockBase = mix( uRvRock, vec3( rvLum( uRvRock ) ) * vec3( 0.95, 0.99, 1.07 ), 0.45 );
  vec3 rockC = mix( rockBase, uRvRock2, smoothstep( 0.2, 0.9, bh ) * ( 0.15 + 0.6 * uRvS.x * uRvS.x ) );
  rockC = mix( rockC, uRvSand * 0.8, smoothstep( 0.8, 0.97, bh ) * 0.35 * uRvS.x * uRvS.x );
  rockC = mix( rockC, rockBase * 0.55, smoothstep( 0.35, 0.65, mC.g + 0.3 * n2 ) * 0.35 );
  rockC *= 0.55 + 0.9 * aRock;
  rockC *= mix( 1.0, 0.86 + 0.28 * streak, rockS );
  rockC *= 0.88 + 0.24 * mA.g;
  rockC *= mix( vec3( 1.07, 1.0, 0.9 ), vec3( 0.9, 0.97, 1.08 ), smoothstep( 0.25, 0.75, mA.b + 0.3 * n4 ) );
  // lichen / moss on moderately steep, moist rock
  rockC = mix( rockC, grassC * 0.75, ( 1.0 - rockS ) * smoothstep( 0.4, 0.8, moist ) * 0.45 * uRvS2.x );
  vec3 sandC = uRvSand * ( 0.86 + 0.28 * mix( 0.5, dSand.a, fMid * fNear * 0.7 + fMid * 0.3 ) + 0.12 * n1 + 0.08 * n4 );
  vec3 snowC = uRvSnow * ( 0.93 + 0.07 * mix( 0.5, dSnow.a, fMid ) );
  snowC = mix( snowC, snowC * vec3( 0.82, 0.9, 1.05 ), clamp( curv, 0.0, 1.0 ) * 0.5 ); // bluish hollows

  vec3 col = groundC;
  col = mix( col, sandC, bSand );
  col = mix( col, rockC, bRock );
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
  rvAO = clamp( ( 1.0 - 0.5 * cav ) * mix( mix( 0.55, 0.38, bRock ), 1.08, hD ), 0.2, 1.0 );
  col *= mix( 1.0, 0.62 + 0.6 * hD, bRock ) * ( 1.0 - 0.18 * cav * ( 1.0 - bSnow ) );
  col *= 1.0 + ( 0.12 + 0.12 * bRock ) * clamp( -curv, 0.0, 1.0 );
  col *= 1.0 - 0.14 * bRock * cav;

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
    uRvTime: G.uTime,
    uRvDebug: { value: (() => { try { return +(new URLSearchParams(globalThis.location?.search || '').get('tdebug') || 0); } catch (_) { return 0; } })() },
    uRvGrass: { value: grass }, uRvGrass2: { value: grass2 }, uRvRock: { value: rock }, uRvRock2: { value: rock2 },
    uRvSand: { value: sand }, uRvSnow: { value: col(p.snow, '#f4f6fa') }, uRvForest: { value: forest },
    uRvSoil: { value: soil }, uRvAccent: { value: accent }, uRvDry: { value: dry }, uRvSeabed: { value: seabed },
    uRvP: { value: new THREE.Vector4(body.radius, body.ocean?.present ? 0 : -1e9, body.terrain?.amplitude || 3000, quality?.tier === 'low' ? 0.6 : 1) },
    uRvS: { value: new THREE.Vector4(st.strata, st.snowBias, st.volcanic, st.crystal) },
    uRvS2: { value: new THREE.Vector4(st.lush, st.forest, 0, 0) },
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
  mat.customProgramCacheKey = () => 'rv-terrain-v14' + (opts.lite ? 'L' : '');
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
