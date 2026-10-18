// In-place 3D complex FFT (radix-2, iterative Cooley–Tukey) on split re/im Float32Arrays.
// Layout: index = x + N * (y + N * z). Forward = e^{-ikx}, inverse = e^{+ikx} scaled by 1/N³.
// Lines are gathered into Float64 scratch buffers (exact double arithmetic, cache-friendly).
// Worker-safe, no dependencies.

export class FFT3 {
  constructor(N) {
    if ((N & (N - 1)) !== 0) throw new Error('FFT3: N must be a power of two');
    this.N = N;
    this.log2N = Math.round(Math.log2(N));
    this.rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) {
      let r = 0;
      for (let b = 0; b < this.log2N; b++) r |= ((i >> b) & 1) << (this.log2N - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(N >> 1);
    this.sin = new Float64Array(N >> 1);
    for (let i = 0; i < N >> 1; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / N); this.sin[i] = Math.sin(2 * Math.PI * i / N); }
    // scratch: process LINES lines at once for the strided axes (better cache use)
    this.LINES = Math.min(N, 16);
    this.bre = new Float64Array(N * this.LINES);
    this.bim = new Float64Array(N * this.LINES);
  }

  /** 1D FFT of `count` consecutive lines of length N stored in re/im (Float64) at offsets k*N. */
  _lines(re, im, count, inverse) {
    const N = this.N, rev = this.rev, C = this.cos, S = this.sin, sgn = inverse ? 1 : -1;
    for (let l = 0; l < count; l++) {
      const o = l * N;
      // bit reversal
      for (let i = 0; i < N; i++) {
        const j = rev[i];
        if (j > i) {
          const tr = re[o + i]; re[o + i] = re[o + j]; re[o + j] = tr;
          const ti = im[o + i]; im[o + i] = im[o + j]; im[o + j] = ti;
        }
      }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let start = 0; start < N; start += size) {
          for (let k = 0; k < half; k++) {
            const wr = C[k * step], wi = sgn * S[k * step];
            const a = o + start + k, b = a + half;
            const xr = re[b] * wr - im[b] * wi;
            const xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr; im[b] = im[a] - xi;
            re[a] += xr; im[a] += xi;
          }
        }
      }
    }
  }

  /** In-place 3D transform of Float32Array re/im (length N³). */
  transform(re, im, inverse = false) {
    const N = this.N, N2 = N * N, L = this.LINES, br = this.bre, bi = this.bim;
    // --- x axis: contiguous lines
    for (let base = 0; base < N2; base += L) {
      const cnt = Math.min(L, N2 - base);
      for (let l = 0; l < cnt; l++) {
        const src = (base + l) * N, o = l * N;
        for (let i = 0; i < N; i++) { br[o + i] = re[src + i]; bi[o + i] = im[src + i]; }
      }
      this._lines(br, bi, cnt, inverse);
      for (let l = 0; l < cnt; l++) {
        const dst = (base + l) * N, o = l * N;
        for (let i = 0; i < N; i++) { re[dst + i] = br[o + i]; im[dst + i] = bi[o + i]; }
      }
    }
    // --- y axis: stride N; group L consecutive x
    for (let z = 0; z < N; z++) {
      for (let x0 = 0; x0 < N; x0 += L) {
        const cnt = Math.min(L, N - x0);
        const zb = z * N2 + x0;
        for (let y = 0; y < N; y++) {
          const src = zb + y * N;
          for (let l = 0; l < cnt; l++) { br[l * N + y] = re[src + l]; bi[l * N + y] = im[src + l]; }
        }
        this._lines(br, bi, cnt, inverse);
        for (let y = 0; y < N; y++) {
          const dst = zb + y * N;
          for (let l = 0; l < cnt; l++) { re[dst + l] = br[l * N + y]; im[dst + l] = bi[l * N + y]; }
        }
      }
    }
    // --- z axis: stride N²; group L consecutive x
    for (let y = 0; y < N; y++) {
      for (let x0 = 0; x0 < N; x0 += L) {
        const cnt = Math.min(L, N - x0);
        const yb = y * N + x0;
        for (let z = 0; z < N; z++) {
          const src = yb + z * N2;
          for (let l = 0; l < cnt; l++) { br[l * N + z] = re[src + l]; bi[l * N + z] = im[src + l]; }
        }
        this._lines(br, bi, cnt, inverse);
        for (let z = 0; z < N; z++) {
          const dst = yb + z * N2;
          for (let l = 0; l < cnt; l++) { re[dst + l] = br[l * N + z]; im[dst + l] = bi[l * N + z]; }
        }
      }
    }
    if (inverse) {
      const s = 1 / (N * N2), n = N * N2;
      for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; }
    }
  }
}
