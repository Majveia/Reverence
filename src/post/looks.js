// Season 2 art direction for the post track:
//   * harmonyFromArt(art)  — per-world two-hue harmony (sky hue + land hue) + one warm accent (reds stay
//                            saturated), baked into the grading LUT (grade.js).
//   * PHOTO_LOOKS          — photo-mode looks the UI can select: two-tone, high-key black & white, flat poster
//                            (ink lines), candy sky (land in silhouette), woodcut (two-colour sky, line-work).
//   * SkyMeter             — average colour of the visible sky (GPU only, 4 tiny passes) used as the haze
//                            colour for depth-layered aerial perspective in the composite.
import * as THREE from 'three';
import { makeFullscreenMaterial } from './common.js';
import { hueOf } from './grade.js';

/** sRGB-encoded [r,g,b] of a CSS colour (three's Color works in linear; getHexString() re-encodes). */
function encHex(hex) {
  const c = new THREE.Color(); c.set(hex);
  // getHexString() returns the sRGB-encoded hex regardless of the working space
  const h = c.getHexString();
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

/** Two anchor hues from a body's art palette: A = sky (cool), B = land (grass/rock/sand chroma-weighted). */
export function harmonyFromArt(art, strength = 0.42) {
  const p = art?.palette;
  if (!p) return null;
  try {
    const sky = encHex(p.sky || p.fog || '#7ab8ff');
    // land: chroma-weighted average of the land colours in YIQ
    let I = 0, Q = 0;
    for (const k of ['grass', 'grass2', 'rock', 'sand']) {
      if (!p[k]) continue;
      const [r, g, b] = encHex(p[k]);
      const w = k === 'grass' ? 1.4 : 1;
      I += w * (0.596 * r - 0.274 * g - 0.322 * b); Q += w * (0.211 * r - 0.523 * g + 0.312 * b);
    }
    const hueB = Math.hypot(I, Q) > 1e-4 ? Math.atan2(Q, I) : hueOf(encHex(p.grass || '#78b84e'));
    const hueA = hueOf(sky);
    return {
      hueA, hueB, strength,
      accentHue: 0.33,       // YIQ angle of the explorer's red scarf / lanterns (~ pure red)
      accentWidth: 0.46,     // radians; reds/crimson fully exempt, orange (~-0.1) is pulled to the land hue
      accentSat: 1.2, otherSat: 0.8, weightB: 1.0,
      splitShadow: 0.04, splitHigh: 0.022, warmHue: -0.2,   // YIQ chroma: cool (sky-hue) shadows, warm highlights
    };
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------------------------
// Photo looks. Each is a set of composite uniforms; tones are sRGB-encoded display colours.
//   id 1 two-tone, 2 high-key B&W, 3 poster, 4 candy sky, 5 woodcut
export const PHOTO_LOOKS = {
  none: { id: 0 },
  twotone: { id: 1, toneA: '#000000', toneB: '#d0105e', toneC: '#ffd6ec', land: 0.45, accent: 0, ink: 0, grain: 0.035 },
  bw: { id: 2, toneA: '#000000', toneB: '#7a7a7a', toneC: '#ffffff', land: 1.0, accent: 0, ink: 0, grain: 0.05 },
  poster: { id: 3, toneA: '#14102a', toneB: 'auto', toneC: '#f6e7cf', land: 1.0, accent: 1, ink: 1, bands: 3, grain: 0.0 },
  candy: { id: 4, toneA: '#07040d', toneB: '#c2306e', toneC: '#ff7a5c', toneD: '#ffe2a8', land: 0.08, accent: 1, ink: 0, sat: 1.4, grain: 0.02 },
  woodcut: { id: 5, toneA: '#0a0710', toneB: 'auto', toneC: 'auto', toneD: '#f4ead6', land: 1.0, accent: 1, ink: 1, bands: 5, grain: 0.0 },
};
export const PHOTO_LOOK_NAMES = Object.keys(PHOTO_LOOKS);

/** Resolve a look (+ overrides, + world art for 'auto' tones) into plain uniform values. */
export function resolvePhotoLook(name, over = {}, art = null, out = {}) {
  const base = PHOTO_LOOKS[name] || PHOTO_LOOKS.none;
  const L = { ...base, ...over };
  const p = art?.palette || {};
  const auto = {
    // poster / woodcut: cool mid from the world's sky, light from its fog/accent
    toneB: p.sky ? shade(p.sky, 0.62, 0.9) : '#3b5f9a',
    toneC: p.fog || p.accent || '#f2c6a0',
  };
  out.id = L.id | 0;
  out.toneA = encHex(L.toneA && L.toneA !== 'auto' ? L.toneA : '#000000');
  out.toneB = encHex(L.toneB && L.toneB !== 'auto' ? L.toneB : auto.toneB);
  out.toneC = encHex(L.toneC && L.toneC !== 'auto' ? L.toneC : auto.toneC);
  out.toneD = encHex(L.toneD && L.toneD !== 'auto' ? L.toneD : '#ffffff');
  out.land = L.land ?? 1; out.accent = L.accent ?? 0; out.ink = L.ink ?? 0;
  out.bands = L.bands ?? 4; out.sat = L.sat ?? 1; out.grain = L.grain;
  out.inkWidth = L.inkWidth ?? 1.5;
  return out;
}

function shade(hex, v, s) {
  const c = new THREE.Color(); c.set(hex);
  const hsl = {}; c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(1, hsl.s * s), hsl.l * v);
  return '#' + c.getHexString();
}

// ---------------------------------------------------------------------------------------------
const SKY_METER_FRAG = /* glsl */ `
#include <rv_post>
uniform sampler2D tSrc, tDepth;
varying vec2 vUv;
void main(){
  vec2 cell = vec2(1.0 / 32.0);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 || i == 2 ? -0.25 : 0.25, i < 2 ? -0.25 : 0.25) * cell;
    float d = texture2D(tDepth, vUv + o).r;
    float w = rvp_isSky(d) ? 1.0 : 0.0;
    vec3 c = min(max(texture2D(tSrc, vUv + o).rgb, 0.0), vec3(50.0));
    acc += vec4(c * w, w);
  }
  // the haze is the sky near the horizon: weight the lower sky more
  float hw = 1.25 - vUv.y;
  gl_FragColor = acc * 0.25 * hw;
}`;
const SKY_REDUCE_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  gl_FragColor = 0.25 * (texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)) + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0))
                       + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)) + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)));
}`;

export class SkyMeter {
  constructor() {
    const opt = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    this.m32 = new THREE.WebGLRenderTarget(32, 32, opt);
    this.m8 = new THREE.WebGLRenderTarget(8, 8, opt);
    this.m2 = new THREE.WebGLRenderTarget(2, 2, opt);
    this.m1 = new THREE.WebGLRenderTarget(1, 1, { ...opt, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.meterMat = makeFullscreenMaterial(SKY_METER_FRAG, { tSrc: { value: null }, tDepth: { value: null } });
    this.reduceMat = makeFullscreenMaterial(SKY_REDUCE_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  }
  get texture() { return this.m1.texture; }
  update(renderer, quad, srcTex, depthTex) {
    this.meterMat.uniforms.tSrc.value = srcTex; this.meterMat.uniforms.tDepth.value = depthTex;
    quad.draw(renderer, this.meterMat, this.m32);
    const r = this.reduceMat.uniforms;
    r.tSrc.value = this.m32.texture; r.uTexel.value.set(1 / 32, 1 / 32); quad.draw(renderer, this.reduceMat, this.m8);
    r.tSrc.value = this.m8.texture; r.uTexel.value.set(1 / 8, 1 / 8); quad.draw(renderer, this.reduceMat, this.m2);
    r.tSrc.value = this.m2.texture; r.uTexel.value.set(1 / 4, 1 / 4); quad.draw(renderer, this.reduceMat, this.m1);
  }
  dispose() {
    for (const rt of [this.m32, this.m8, this.m2, this.m1]) rt.dispose();
    this.meterMat.dispose(); this.reduceMat.dispose();
  }
}
