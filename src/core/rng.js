// Deterministic randomness + CPU noise.  Pure JS, no imports: safe to use from Web Workers.
// Everything procedural in Reverence must derive from seeds through these so the universe is reproducible.

/** Hash any mix of numbers/strings to a uint32. */
export function hash32(...parts) {
  let h = 0x811c9dc5 | 0;
  for (const p of parts) {
    if (typeof p === 'string') {
      for (let i = 0; i < p.length; i++) { h ^= p.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    } else {
      let x = Math.floor(p) | 0;
      const f = Math.floor((p - Math.floor(p)) * 4294967296) | 0;
      h ^= x; h = Math.imul(h, 0x01000193);
      h ^= f; h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  }
  return h >>> 0;
}

/** Seeded PRNG (sfc32).  const r = rng(seed); r() → [0,1) */
export function rng(seed) {
  let a = hash32(seed, 1), b = hash32(seed, 2), c = hash32(seed, 3), d = 1;
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * next());
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.chance = (p) => next() < p;
  next.gauss = () => { // Box–Muller
    let u = 0; while (u === 0) u = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * next());
  };
  next.weighted = (items, weights) => {
    let s = 0; for (const w of weights) s += w;
    let t = next() * s;
    for (let i = 0; i < items.length; i++) { t -= weights[i]; if (t <= 0) return items[i]; }
    return items[items.length - 1];
  };
  /** Uniform direction on the unit sphere → [x,y,z]. */
  next.dir = () => { const z = next() * 2 - 1, a2 = next() * 6.283185307179586, r = Math.sqrt(1 - z * z); return [r * Math.cos(a2), z, r * Math.sin(a2)]; };
  return next;
}

// ───────────────────────── scalar helpers ─────────────────────────
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const smootherstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * t * (t * (t * 6 - 15) + 10); };
export const remap = (x, a, b, c, d) => c + (d - c) * saturate((x - a) / (b - a));
/** Frame-rate independent exponential approach: x = damp(x, target, lambda, dt). */
export const damp = (x, target, lambda, dt) => target + (x - target) * Math.exp(-lambda * dt);

// ───────────────────────── 3D gradient noise ─────────────────────────
// Seeded simplex noise factory.  n = makeNoise(seed); n.simplex(x,y,z) ∈ ~[-1,1]
export function makeNoise(seed = 1) {
  const perm = new Uint8Array(512), r = rng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const G = new Float32Array([1,1,0, -1,1,0, 1,-1,0, -1,-1,0, 1,0,1, -1,0,1, 1,0,-1, -1,0,-1, 0,1,1, 0,-1,1, 0,1,-1, 0,-1,-1]);
  const F3 = 1 / 3, G3 = 1 / 6;

  function simplex(x, y, z) {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 0.5, y3 = y0 - 1 + 0.5, z3 = z0 - 1 + 0.5;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0, tt, g;
    tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (tt > 0) { g = (perm[ii + perm[jj + perm[kk]]] % 12) * 3; tt *= tt; n += tt * tt * (G[g] * x0 + G[g + 1] * y0 + G[g + 2] * z0); }
    tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (tt > 0) { g = (perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]] % 12) * 3; tt *= tt; n += tt * tt * (G[g] * x1 + G[g + 1] * y1 + G[g + 2] * z1); }
    tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (tt > 0) { g = (perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]] % 12) * 3; tt *= tt; n += tt * tt * (G[g] * x2 + G[g + 1] * y2 + G[g + 2] * z2); }
    tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (tt > 0) { g = (perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]] % 12) * 3; tt *= tt; n += tt * tt * (G[g] * x3 + G[g + 1] * y3 + G[g + 2] * z3); }
    return 32 * n;
  }

  /** Fractal Brownian motion, ~[-1,1]. */
  function fbm(x, y, z, octaves = 5, lacunarity = 2.02, gain = 0.5) {
    let a = 1, f = 1, s = 0, norm = 0;
    for (let o = 0; o < octaves; o++) { s += a * simplex(x * f, y * f, z * f); norm += a; a *= gain; f *= lacunarity; }
    return s / norm;
  }

  /** Ridged multifractal, [0,1] with sharp crests. */
  function ridged(x, y, z, octaves = 5, lacunarity = 2.05, gain = 0.5) {
    let a = 1, f = 1, s = 0, norm = 0, prev = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(simplex(x * f, y * f, z * f)); n *= n;
      s += n * a * prev; norm += a; prev = n; a *= gain; f *= lacunarity;
    }
    return s / norm;
  }

  /** Billowy (abs) noise, [0,1]. */
  function billow(x, y, z, octaves = 4, lacunarity = 2.03, gain = 0.5) {
    let a = 1, f = 1, s = 0, norm = 0;
    for (let o = 0; o < octaves; o++) { s += a * Math.abs(simplex(x * f, y * f, z * f)); norm += a; a *= gain; f *= lacunarity; }
    return s / norm;
  }

  /** Cellular (Worley) F1 distance in [0,~1]; also writes the cell id hash to worley.id. */
  function worley(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let best = 1e9, id = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy, cz = zi + dz;
      const h = perm[(cx & 255) + perm[(cy & 255) + perm[cz & 255]]];
      const h2 = perm[h + 37], h3 = perm[h2 + 91];
      const px = cx + h / 255, py = cy + h2 / 255, pz = cz + h3 / 255;
      const d = (px - x) * (px - x) + (py - y) * (py - y) + (pz - z) * (pz - z);
      if (d < best) { best = d; id = h * 65536 + h2 * 256 + h3; }
    }
    worley.id = id;
    return Math.sqrt(best);
  }

  return { simplex, fbm, ridged, billow, worley };
}
