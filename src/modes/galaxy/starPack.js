// Packing of star records into GPU buffers (shared by the worker and the main-thread fallback).
//   pos : Float32 ×3  (kly, canonical pattern frame)
//   col : Uint8 ×4    (sqrt-encoded linear blackbody color, flags = follow*16 + class)
//   lum : Float32     (log10 L☉)
import { CLASS_INDEX } from '../../universe/GalaxyModel.js';

export const STRIDE_COL = 4;

const srgbToLinear = (c) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));

/** Blackbody color (linear, normalized so max channel = 1), Tanner Helland fit. */
export function blackbodyLinear(kelvin, out = [0, 0, 0]) {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  r = srgbToLinear(Math.min(255, Math.max(0, r)) / 255);
  g = srgbToLinear(Math.min(255, Math.max(0, g)) / 255);
  b = srgbToLinear(Math.min(255, Math.max(0, b)) / 255);
  const m = Math.max(r, g, b, 1e-6);
  out[0] = r / m; out[1] = g / m; out[2] = b / m;
  return out;
}

const _c = [0, 0, 0];
// Stellar colors in photographs read more saturated than raw blackbody: gentle boost around luminance.
export function starColor(kelvin, out = [0, 0, 0], sat = 1.6) {
  blackbodyLinear(kelvin, _c);
  const l = 0.2126 * _c[0] + 0.7152 * _c[1] + 0.0722 * _c[2];
  for (let k = 0; k < 3; k++) out[k] = Math.max(0, l + (_c[k] - l) * sat);
  const m = Math.max(out[0], out[1], out[2], 1e-6);
  out[0] /= m; out[1] /= m; out[2] /= m;
  return out;
}

const _sc = [0, 0, 0];
/** Pack star record s into slot i. Returns the luminosity weight (for normalization sums). */
export function packStar(s, i, pos, col, lum) {
  pos[i * 3] = s.x / 1000; pos[i * 3 + 1] = s.y / 1000; pos[i * 3 + 2] = s.z / 1000;
  const oldPop = s.component === 'spheroid' || s.component === 'halo' || s.component === 'bulge' || (s.component === 'disk' && !(s.young > 0.2));
  // display only: an old population holds no hot main-sequence stars (B/A lifetimes ≪ its age); the
  // catalogue class is untouched (picking shows the real record), the point shows the population's light
  starColor(oldPop ? Math.min(s.temperature, 6200) : s.temperature, _sc);
  col[i * 4] = Math.round(Math.sqrt(_sc[0]) * 255);
  col[i * 4 + 1] = Math.round(Math.sqrt(_sc[1]) * 255);
  col[i * 4 + 2] = Math.round(Math.sqrt(_sc[2]) * 255);
  const ci = CLASS_INDEX[s.cls] ?? 4;
  const cluster = s.sub === 'cluster' || s.sub === 'gc' ? 8 : 0;
  const sph = s.component === 'spheroid' || s.component === 'halo' || s.component === 'bulge' ? 64 : 0;
  col[i * 4 + 3] = sph + ((s.follow ?? 0) & 3) * 16 + cluster + ci;
  let l = Math.log10(Math.max(1e-4, s.luminosity));
  // display only: old spheroids hold no bright hot stars (blue stragglers stay faint)
  if (ci <= 2 && oldPop) l = Math.min(l, 0.4) - 0.3;
  lum[i] = l;
  return Math.pow(10, l * 0.35);
}
