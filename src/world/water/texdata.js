// Water texture DATA — THREE-free (runs in the water worker or on the main thread as a fallback).
//
//   makeWaveTexture(seed, N)   Tessendorf/Phillips ocean spectrum → inverse FFT
//                              RGBA8: R,G = slope x,y (0.5 = flat, ±SLOPE_RANGE), B = choppy fold (foam), A = height
//   makeFoamTexture(seed, N)   RGBA8: R,G,B = dispersive caustics (from refracting light through the same
//                              spectrum onto a plane), A = foam web (Worley F2−F1 cell borders)
//
// Both wrap (RepeatWrapping) and are mipmapped, so the shader can scroll/scale them freely.
import { RNG } from '../../core/rng.js';

export const SLOPE_RANGE = 1.6;

// ---------------------------------------------------------------- tiny radix-2 FFT (in place)
function fft1(re, im, n, off, stride, inv) {
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = off + i * stride, b = off + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = off + (i + k) * stride, b = off + (i + k + len / 2) * stride;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
function ifft2(re, im, n) {
  for (let y = 0; y < n; y++) fft1(re, im, n, y * n, 1, true);
  for (let x = 0; x < n; x++) fft1(re, im, n, x, n, true);
}

function gauss(rng) {
  const u = Math.max(1e-9, rng.next()), v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Ocean heightfield over a periodic tile of size L (m) with N×N samples.
 * Returns { h, sx, sy, fold } Float32Arrays (row-major, y*N+x). Wind along +x.
 */
export function oceanSpectrumField(seed, N = 256, L = 32, windSpeed = 9, chop = 1.1, opts = {}) {
  const rng = new RNG((seed ^ 0x51a7e) >>> 0);
  const g = 9.81;
  const Lw = windSpeed * windSpeed / g;           // largest wave from the wind
  const small = opts.damp ?? L / N * 3.0;           // suppress capillary / sub-texel waves (smoother normals)
  const dirPow = opts.dirPow ?? 2;                   // directional spread (0 = isotropic)
  const H = new Float64Array(N * N * 2);
  const reH = new Float64Array(N * N), imH = new Float64Array(N * N);
  const reX = new Float64Array(N * N), imX = new Float64Array(N * N);
  const reY = new Float64Array(N * N), imY = new Float64Array(N * N);
  const reDx = new Float64Array(N * N), imDx = new Float64Array(N * N);
  const reDy = new Float64Array(N * N), imDy = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const m = i < N / 2 ? i : i - N, n = j < N / 2 ? j : j - N;
      const kx = 2 * Math.PI * m / L, ky = 2 * Math.PI * n / L;
      const k2 = kx * kx + ky * ky;
      const idx = j * N + i;
      if (k2 < 1e-12) continue;
      const k = Math.sqrt(k2);
      const cosw = kx / k;
      // Phillips spectrum with a directional spread (cos^4, both directions weakly)
      let P = Math.exp(-1 / (k2 * Lw * Lw)) / (k2 * k2);
      const dir = dirPow > 0 ? Math.pow(Math.abs(cosw), dirPow) * (cosw < 0 ? 0.3 : 1.0) + 0.04 : 1.0;
      P *= dir * Math.exp(-k2 * small * small);
      const a = Math.sqrt(P * 0.5);
      const hr = gauss(rng) * a, hi = gauss(rng) * a;
      H[idx * 2] = hr; H[idx * 2 + 1] = hi;
      reH[idx] = hr; imH[idx] = hi;
      // slopes: i k h
      reX[idx] = -kx * hi; imX[idx] = kx * hr;
      reY[idx] = -ky * hi; imY[idx] = ky * hr;
      // choppy displacement derivatives d(Dx)/dx = kx^2/k h, d(Dy)/dy = ky^2/k h  (for the Jacobian)
      reDx[idx] = kx * kx / k * hr; imDx[idx] = kx * kx / k * hi;
      reDy[idx] = ky * ky / k * hr; imDy[idx] = ky * ky / k * hi;
    }
  }
  ifft2(reH, imH, N); ifft2(reX, imX, N); ifft2(reY, imY, N); ifft2(reDx, imDx, N); ifft2(reDy, imDy, N);
  // normalise: height to unit RMS, slopes keep ratio
  let hr2 = 0;
  for (let i = 0; i < N * N; i++) hr2 += reH[i] * reH[i];
  const s = 1 / Math.sqrt(hr2 / (N * N) + 1e-30);
  const h = new Float32Array(N * N), sx = new Float32Array(N * N), sy = new Float32Array(N * N), fold = new Float32Array(N * N);
  // slope scale: target rms slope ≈ 0.22 for the whole texture
  let sr2 = 0;
  for (let i = 0; i < N * N; i++) sr2 += reX[i] * reX[i] + reY[i] * reY[i];
  const ss = 0.22 / Math.sqrt(sr2 / (N * N) + 1e-30);
  let jr2 = 0;
  for (let i = 0; i < N * N; i++) jr2 += (reDx[i] + reDy[i]) ** 2;
  const js = chop * 0.35 / Math.sqrt(jr2 / (N * N) + 1e-30);
  for (let i = 0; i < N * N; i++) {
    h[i] = reH[i] * s;
    sx[i] = reX[i] * ss; sy[i] = reY[i] * ss;
    fold[i] = 1 - (reDx[i] + reDy[i]) * js; // Jacobian ≈ 1 − chop·(∂Dx/∂x + ∂Dy/∂y)
  }
  return { h, sx, sy, fold, N, L };
}

const c8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

export function waveData(seed, N = 256) {
  const f = oceanSpectrumField(seed, N, 32, 8.5, 1.15);
  const out = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    out[i * 4] = c8(0.5 + 0.5 * f.sx[i] / SLOPE_RANGE);
    out[i * 4 + 1] = c8(0.5 + 0.5 * f.sy[i] / SLOPE_RANGE);
    out[i * 4 + 2] = c8(Math.max(0, Math.min(1, (0.62 - f.fold[i]) * 2.2))); // 0 flat … 1 folding crest
    out[i * 4 + 3] = c8(0.5 + 0.18 * f.h[i]);
  }
  return out;
}

/** Worley F1/F2 on a periodic grid of `cells`² jittered points. */
function worleyTile(rng, N, cells) {
  const pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < cells * cells; i++) { pts[i * 2] = rng.next(); pts[i * 2 + 1] = rng.next(); }
  const F1 = new Float32Array(N * N), F2 = new Float32Array(N * N);
  const cs = N / cells;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const gx = x / cs, gy = y / cs;
      const cx = Math.floor(gx), cy = Math.floor(gy);
      let d1 = 1e9, d2 = 1e9;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const ix = cx + ox, iy = cy + oy;
          const wx = ((ix % cells) + cells) % cells, wy = ((iy % cells) + cells) % cells;
          const px = ix + pts[(wy * cells + wx) * 2], py = iy + pts[(wy * cells + wx) * 2 + 1];
          const d = Math.hypot(px - gx, py - gy);
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
        }
      }
      F1[y * N + x] = d1; F2[y * N + x] = d2;
    }
  }
  return { F1, F2 };
}

/** Caustics: refract a dense grid of parallel rays through the spectrum's slopes onto a plane, splat, wrap. */
function causticTile(field, N, depthK) {
  const acc = new Float32Array(N * N);
  const sub = 2;
  const sN = field.N;
  const rng = new RNG(0xca05);
  const bil = (arr, u, v) => {
    const x = u * sN - 0.5, y = v * sN - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    const X0 = ((x0 % sN) + sN) % sN, Y0 = ((y0 % sN) + sN) % sN, X1 = (X0 + 1) % sN, Y1 = (Y0 + 1) % sN;
    return (arr[Y0 * sN + X0] * (1 - tx) + arr[Y0 * sN + X1] * tx) * (1 - ty) + (arr[Y1 * sN + X0] * (1 - tx) + arr[Y1 * sN + X1] * tx) * ty;
  };
  for (let sy = 0; sy < N * sub; sy++) {
    for (let sx = 0; sx < N * sub; sx++) {
      const u = (sx + rng.next()) / (N * sub), v = (sy + rng.next()) / (N * sub);
      // refracted ray offset ∝ slope × depth (small-angle, n = 1.33)
      let px = (u + bil(field.sx, u, v) * depthK) * N, py = (v + bil(field.sy, u, v) * depthK) * N;
      px = ((px % N) + N) % N; py = ((py % N) + N) % N;
      const x0 = Math.floor(px), y0 = Math.floor(py), tx = px - x0, ty = py - y0;
      const x1 = (x0 + 1) % N, y1 = (y0 + 1) % N;
      acc[y0 * N + x0] += (1 - tx) * (1 - ty); acc[y0 * N + x1] += tx * (1 - ty);
      acc[y1 * N + x0] += (1 - tx) * ty; acc[y1 * N + x1] += tx * ty;
    }
  }
  // 3×3 tent blur (wrap) to remove splat noise
  const out = new Float32Array(N * N);
  const inv = 1 / (sub * sub * 16);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let a = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const w = (2 - Math.abs(ox)) * (2 - Math.abs(oy));
        a += acc[((y + oy + N) % N) * N + ((x + ox + N) % N)] * w;
      }
      out[y * N + x] = a * inv; // 1 = average light
    }
  }
  return out;
}

export function foamData(seed, N = 256) {
  const rng = new RNG((seed ^ 0xf0a3) >>> 0);
  // caustics from a smaller-scale spectrum so the pattern is fine-grained
  const f = oceanSpectrumField(seed + 17, 128, 8, 3.2, 1.0, { dirPow: 0, damp: 8 / 128 * 2.5 });
  const cR = causticTile(f, N, 0.060), cG = causticTile(f, N, 0.066), cB = causticTile(f, N, 0.072);
  const w1 = worleyTile(rng, N, 12), w2 = worleyTile(rng, N, 28);
  const out = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    // caustic contrast curve: brightest filaments → 1, average light → ~0.25
    const cc = (x) => Math.pow(Math.max(0, x - 0.35) / 3.2, 0.8);
    out[i * 4] = c8(cc(cR[i]));
    out[i * 4 + 1] = c8(cc(cG[i]));
    out[i * 4 + 2] = c8(cc(cB[i]));
    // foam webs: thin bright borders between big cells + finer bubble cells
    const e1 = w1.F2[i] - w1.F1[i], e2 = w2.F2[i] - w2.F1[i];
    const web = Math.max(0, 1 - e1 / 0.22) ** 1.6 * 0.75 + Math.max(0, 1 - e2 / 0.3) ** 2 * 0.45 + (1 - Math.min(1, w2.F1[i] * 2.2)) * 0.12;
    out[i * 4 + 3] = c8(Math.min(1, web));
  }
  return out;
}

/** Crust texture for lava / ice: R = cell-edge distance (cracks), G = cell id hash, B = fine cells edge, A = fbm-ish. */
export function crustData(seed, N = 256) {
  const rng = new RNG((seed ^ 0xc2a57) >>> 0);
  const w1 = worleyTile(rng, N, 9), w2 = worleyTile(rng, N, 23);
  const f = oceanSpectrumField(seed + 5, N, 32, 12, 1);
  const out = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    out[i * 4] = c8(Math.min(1, (w1.F2[i] - w1.F1[i]) * 2.2));
    out[i * 4 + 1] = c8(Math.min(1, w1.F1[i] * 1.4));
    out[i * 4 + 2] = c8(Math.min(1, (w2.F2[i] - w2.F1[i]) * 2.5));
    out[i * 4 + 3] = c8(0.5 + 0.2 * f.h[i]);
  }
  return out;
}
