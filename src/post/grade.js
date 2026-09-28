// Procedural 3D colour-grading LUTs.
//
// The LUT is indexed by the display-referred, sRGB-encoded image AFTER the AgX tonemap and maps it
// to the graded sRGB-encoded image. It bakes the per-world art direction (body.art.grade →
// pipeline.settings): lift / gamma / gain, contrast (S-curve that pins 0 and 1), saturation
// (gamut-aware "vibrance"), split toning (shadow / highlight tints) and a hue-preserving
// highlight roll-off. Invariant: LUT(0,0,0) = (0,0,0) → true OLED blacks survive every grade.
import * as THREE from 'three';

export const LUT_SIZE = 32;

const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Numeric signature of the grade-relevant settings (cheap change detection, no allocation). */
export function gradeSignature(s) {
  let h = 17;
  const add = (v) => { h = (h * 31 + Math.round((+v || 0) * 10000)) % 2147483647; };
  add(s.saturation ?? 1); add(s.contrast ?? 1); add(s.vibrance ?? 0);
  for (const k of ['lift', 'gamma', 'gain', 'shadows', 'highlights']) {
    const a = s[k];
    if (Array.isArray(a)) { add(a[0]); add(a[1]); add(a[2]); } else add(k.length * 7);
  }
  add(s.splitBalance ?? 0);
  return h;
}

/**
 * Build (or refill) a HalfFloat Data3DTexture LUT from grade settings.
 * s: { saturation, contrast, lift[3], gamma[3], gain[3], shadows?[3], highlights?[3], vibrance?, splitBalance? }
 */
export function buildLUT(s, tex = null) {
  const N = LUT_SIZE;
  const data = tex ? tex.image.data : new Uint16Array(N * N * N * 4);
  const lift = s.lift || [0, 0, 0], gam = s.gamma || [1, 1, 1], gain = s.gain || [1, 1, 1];
  const sh = s.shadows || [0, 0, 0], hi = s.highlights || [0, 0, 0];
  const sat = s.saturation ?? 1, con = s.contrast ?? 1, vib = s.vibrance ?? 0;
  const bal = s.splitBalance ?? 0;
  const P = 0.435; // contrast pivot in encoded space (≈ linear 0.16)
  const toHalf = THREE.DataUtils.toHalfFloat;
  let o = 0;
  for (let bz = 0; bz < N; bz++) for (let gy = 0; gy < N; gy++) for (let rx = 0; rx < N; rx++) {
    let r = s2l(rx / (N - 1)), g = s2l(gy / (N - 1)), b = s2l(bz / (N - 1));
    const l0 = luma(r, g, b);
    if (l0 <= 0) { data[o++] = 0; data[o++] = 0; data[o++] = 0; data[o++] = toHalf(1); continue; }
    // --- lift / gamma / gain (lift fades in above black so 0 stays 0)
    const lk = smooth(0.0, 0.05, l0);
    r = Math.pow(Math.max(r * gain[0] + lift[0] * (1 - r) * lk, 0), 1 / Math.max(gam[0], 1e-3));
    g = Math.pow(Math.max(g * gain[1] + lift[1] * (1 - g) * lk, 0), 1 / Math.max(gam[1], 1e-3));
    b = Math.pow(Math.max(b * gain[2] + lift[2] * (1 - b) * lk, 0), 1 / Math.max(gam[2], 1e-3));
    // --- split toning (additive in linear, weighted by luminance zone; zero at black)
    const l1 = luma(r, g, b);
    const ws = smooth(0.0, 0.03, l1) * (1 - smooth(0.02, 0.35 + bal * 0.2, l1));
    const wh = smooth(0.25 + bal * 0.2, 0.9, l1);
    r += sh[0] * ws + hi[0] * wh; g += sh[1] * ws + hi[1] * wh; b += sh[2] * ws + hi[2] * wh;
    // --- contrast: S-curve in encoded space pinned at 0, pivot and 1
    let er = l2s(clamp01(r)), eg = l2s(clamp01(g)), eb = l2s(clamp01(b));
    if (con !== 1) {
      const sc = (e) => (e < P ? P * Math.pow(e / P, con) : 1 - (1 - P) * Math.pow((1 - e) / (1 - P), con));
      er = sc(er); eg = sc(eg); eb = sc(eb);
    }
    r = s2l(er); g = s2l(eg); b = s2l(eb);
    // --- saturation / vibrance (gamut-aware: already-saturated colours move less)
    const l2 = luma(r, g, b);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const chroma = mx > 1e-6 ? (mx - mn) / mx : 0;
    let k = sat;
    if (k > 1) k = 1 + (k - 1) * (1 - 0.55 * chroma);
    k *= 1 + vib * (1 - chroma);
    r = l2 + (r - l2) * k; g = l2 + (g - l2) * k; b = l2 + (b - l2) * k;
    // hue-preserving gamut clamp (scale toward luma instead of per-channel clipping)
    const lo = Math.min(r, g, b);
    if (lo < 0) { const t = l2 / Math.max(l2 - lo, 1e-6); r = l2 + (r - l2) * t; g = l2 + (g - l2) * t; b = l2 + (b - l2) * t; }
    const top = Math.max(r, g, b);
    if (top > 1) { const t = Math.max(0, (1 - l2) / Math.max(top - l2, 1e-6)); if (l2 < 1) { r = l2 + (r - l2) * t; g = l2 + (g - l2) * t; b = l2 + (b - l2) * t; } }
    data[o++] = toHalf(l2s(clamp01(r))); data[o++] = toHalf(l2s(clamp01(g))); data[o++] = toHalf(l2s(clamp01(b))); data[o++] = toHalf(1);
  }
  if (!tex) {
    tex = new THREE.Data3DTexture(data, N, N, N);
    tex.format = THREE.RGBAFormat; tex.type = THREE.HalfFloatType;
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.colorSpace = THREE.NoColorSpace;
  }
  tex.needsUpdate = true;
  return tex;
}
