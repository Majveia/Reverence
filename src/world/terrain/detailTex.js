// Procedural, tileable terrain detail textures. OWNED BY THE TERRAIN TRACK.
// Pure JS (worker-safe, no THREE): baked once in the terrain worker at startup, uploaded as one
// RGBA8 DataArrayTexture. Every layer is exactly periodic so the shader can tile it and break
// repetition with stochastic offsets.
//
// Layer texel = (R,G) slope dh/du,dh/dv (0.5 = flat) · B height (0..1) · A albedo variation (0.5 = neutral)
//   0 rock      cracked facets, grain, lichen blotches
//   1 ground    soil + grass clumps + roots / leaf litter
//   2 sand      wind ripples + grains
//   3 snow      soft drifts, wind-crust, sastrugi
//   4 pebbles   gravel / scree / river stones
//   5 noise     4 independent smooth periodic fbm channels (macro variation, stochastic tiling)
//   6 strata    horizontally layered sedimentary rock (cliff faces), v = up
//   7 streaks   drainage / desert-varnish streaks (irregular spacing, width, length), v = up;
//               B = streak density (0 none), A = light (calcite) vs dark (varnish) tint
export const DETAIL_SIZE = 256;
export const DETAIL_LAYERS = 8;

function makeHash(seed) {
  return (x, y) => {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/** Periodic 2D gradient noise, period p lattice cells over [0,1). Returns ~[-1,1]. */
function pnoise(hash, u, v, p) {
  const x = u * p, y = v * p;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const g = (i, j, dx, dy) => {
    const a = hash(((i % p) + p) % p, ((j % p) + p) % p) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10), sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const n00 = g(ix, iy, fx, fy), n10 = g(ix + 1, iy, fx - 1, fy);
  const n01 = g(ix, iy + 1, fx, fy - 1), n11 = g(ix + 1, iy + 1, fx - 1, fy - 1);
  return 1.414 * ((n00 + (n10 - n00) * sx) + ((n01 + (n11 - n01) * sx) - (n00 + (n10 - n00) * sx)) * sy);
}
function pfbm(hash, u, v, p, oct, gain = 0.5) {
  let s = 0, a = 1, n = 0;
  for (let o = 0; o < oct; o++) { s += a * pnoise(hash, u + o * 0.137, v + o * 0.291, p); n += a; a *= gain; p *= 2; }
  return s / n;
}
/** Periodic worley: returns [F1, F2, cellHash] with p cells per side. */
function pworley(hash, u, v, p, jit, out) {
  const x = u * p, y = v * p;
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j;
    const wx = ((cx % p) + p) % p, wy = ((cy % p) + p) % p;
    const px = cx + 0.5 + (hash(wx, wy) - 0.5) * jit, py = cy + 0.5 + (hash(wy + 911, wx + 71) - 0.5) * jit;
    const d = Math.hypot(px - x, py - y);
    if (d < f1) { f2 = f1; f1 = d; id = hash(wx + 313, wy + 177); } else if (d < f2) f2 = d;
  }
  out[0] = f1; out[1] = f2; out[2] = id;
  return out;
}
const sst = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

/** Bake all layers. Returns Uint8Array(size*size*4*layers). */
export function bakeDetail(size = DETAIL_SIZE) {
  const S = size, L = DETAIL_LAYERS;
  const out = new Uint8Array(S * S * 4 * L);
  const H = new Float32Array(S * S), A = new Float32Array(S * S);
  const w = [0, 0, 0], w2 = [0, 0, 0];
  const put = (layer, slopeK) => {
    const base = layer * S * S * 4;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const xl = y * S + ((x + S - 1) % S), xr = y * S + ((x + 1) % S);
      const yd = ((y + S - 1) % S) * S + x, yu = ((y + 1) % S) * S + x;
      const du = (H[xr] - H[xl]) * 0.5 * S * slopeK, dv = (H[yu] - H[yd]) * 0.5 * S * slopeK;
      const o = base + i * 4;
      out[o] = Math.max(0, Math.min(255, Math.round(128 + du * 127)));
      out[o + 1] = Math.max(0, Math.min(255, Math.round(128 + dv * 127)));
      out[o + 2] = Math.max(0, Math.min(255, Math.round(H[i] * 255)));
      out[o + 3] = Math.max(0, Math.min(255, Math.round(A[i] * 255)));
    }
  };
  const norm = () => {
    let mn = 1e9, mx = -1e9;
    for (let i = 0; i < H.length; i++) { if (H[i] < mn) mn = H[i]; if (H[i] > mx) mx = H[i]; }
    const k = 1 / Math.max(1e-6, mx - mn);
    for (let i = 0; i < H.length; i++) H[i] = (H[i] - mn) * k;
  };

  // ---- 0 rock: fractured, weathered stone. Angular facets come from per-cell planes blended with
  //      a narrow smooth band (chipped, faceted surfaces without a dark outline around every cell —
  //      the old voronoi borders read as dried mud tiles); only a sparse subset of borders are open
  //      fractures. No parallel joint hatching (it aliased into "fur" at mid range). Isotropic
  //      weathering fbm + fine pitting on top; albedo = per-block tone, lichen, mineral speckle.
  {
    const h1 = makeHash(11), h2 = makeHash(12), h3 = makeHash(13), h4 = makeHash(14);
    const res = [0, 0, 0, 0];
    // smooth faceted field: sum of cell planes weighted by a steep kernel on the distance
    const facets = (u, v, p, seedH, sharp) => {
      const x = u * p, y = v * p, ix = Math.floor(x), iy = Math.floor(y);
      let sw = 0, sh = 0, f1 = 9, f2 = 9, id1 = 0, id2 = 0;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const cx = ix + i, cy = iy + j, wx = ((cx % p) + p) % p, wy = ((cy % p) + p) % p;
        const px = cx + 0.5 + (seedH(wx, wy) - 0.5) * 0.9, py = cy + 0.5 + (seedH(wy + 911, wx + 71) - 0.5) * 0.9;
        const dx = x - px, dy = y - py, d2 = dx * dx + dy * dy;
        if (d2 > 4) continue;
        const a = seedH(wx + 5, wy + 17) * Math.PI * 2, sl = 0.25 + 0.55 * seedH(wx + 29, wy + 3);
        const hv = 0.5 * seedH(wx + 313, wy + 177) + sl * (Math.cos(a) * dx + Math.sin(a) * dy);
        const w = Math.exp(-sharp * d2);
        sw += w; sh += w * hv;
        const d = Math.sqrt(d2), id = seedH(wx + 57, wy + 211);
        if (d < f1) { f2 = f1; id2 = id1; f1 = d; id1 = id; } else if (d < f2) { f2 = d; id2 = id; }
      }
      res[0] = sh / Math.max(1e-9, sw); res[1] = f2 - f1; res[2] = id1; res[3] = id2;
      return res;
    };
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const wu = u + 0.04 * pfbm(h2, u, v, 3, 3), wv = v + 0.04 * pfbm(h2, u + 0.5, v + 0.3, 3, 3);
      // big angular blocks (planes, soft seams)
      facets(wu, wv, 4, h1, 11);
      const big = res[0], bid = res[2];
      // stepped ledges: terraced warped fbm → flat-ish planes with sharp risers (chipped / layered)
      const base = pfbm(h3, wu + 0.2, wv + 0.7, 3, 4, 0.5) * 3.2 + big * 1.5;
      const bi = Math.floor(base), bf = base - bi;
      const step = bi + 0.75 * sst(0.55, 0.95, bf) + 0.25 * bf;   // continuous across steps
      // a few long, gently curving fractures (zero-crossings of low-frequency noise, masked into
      // segments; no high-frequency term → no worm-like loops)
      const fn = pnoise(h4, u * 1 + 0.2 * pnoise(h1, u, v, 2), v, 4) + 0.15 * pnoise(h4, wu + 0.3, wv + 0.8, 8);
      const crack = (1 - sst(0.0, 0.022, Math.abs(fn))) * sst(0.05, 0.4, pnoise(h2, u + 0.9, v + 0.2, 3));
      const weath = pfbm(h2, u + 0.17, v + 0.61, 8, 4, 0.5);
      let rid = 0, amp = 0.5, pp = 32;
      for (let o = 0; o < 3; o++) { rid += amp * (1 - Math.abs(pnoise(h1, u + o * 0.17, v + o * 0.31, pp))); amp *= 0.5; pp *= 2; }
      const pits = sst(0.52, 0.8, pfbm(h1, u + 0.21, v + 0.63, 20, 3)) * 0.06;
      const hgt = 0.16 * step + 0.45 * big + 0.09 * weath + 0.03 * rid - 0.08 * crack - pits;
      H[y * S + x] = hgt;
      const lich = sst(0.35, 0.6, pfbm(h3, u, v, 6, 4)) * sst(0.45, 0.75, pnoise(h1, u, v, 28) * 0.5 + 0.5);
      const speck = pnoise(h4, u, v, 96) * 0.5 + pnoise(h4, u + 0.3, v + 0.8, 160) * 0.5;
      const riser = sst(0.55, 0.75, bf) * (1 - sst(0.85, 0.98, bf));
      A[y * S + x] = Math.max(0, Math.min(1, 0.5 + 0.18 * (bid - 0.5) + 0.1 * ((bi * 0.618) % 1 - 0.5) + 0.12 * weath + 0.05 * speck
        - 0.08 * riser - 0.18 * crack - 0.8 * pits + 0.1 * lich));
    }
    norm(); put(0, 0.10);
  }
  // ---- 1 ground: soil + grass clumps + roots/litter
  {
    const h1 = makeHash(21), h2 = makeHash(22), h3 = makeHash(23);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      pworley(h1, u, v, 22, 1.0, w);
      const tuft = Math.pow(Math.max(0, 1 - w[0] * 1.6), 1.5) * (0.6 + 0.4 * w[2]);
      const soil = pfbm(h2, u, v, 8, 5, 0.55);
      const blades = pfbm(h3, u * 1.0, v * 1.0, 48, 2, 0.5);
      H[y * S + x] = 0.55 * tuft + 0.3 * soil + 0.12 * blades;
      const patch = pfbm(h3, u + 0.3, v + 0.7, 4, 4);
      A[y * S + x] = Math.max(0, Math.min(1, 0.5 + 0.3 * (tuft - 0.3) + 0.22 * patch + 0.1 * blades));
    }
    norm(); put(1, 0.05);
  }
  // ---- 2 sand: wind ripples (asymmetric) + grain
  {
    const h1 = makeHash(31), h2 = makeHash(32);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const warp = 0.9 * pfbm(h1, u, v, 3, 3) + 0.25 * pnoise(h1, u + 0.4, v, 9);
      let ph = (u * 11 + v * 2 + warp * 1.4);
      ph -= Math.floor(ph);
      const rip = ph < 0.72 ? sst(0, 1, ph / 0.72) : 1 - sst(0, 1, (ph - 0.72) / 0.28);
      const grain = pnoise(h2, u, v, 96) * 0.5 + pnoise(h2, u + 0.3, v + 0.1, 192) * 0.5;
      const amp = 0.6 + 0.4 * pfbm(h2, u, v, 3, 2);
      H[y * S + x] = rip * amp * 0.8 + 0.1 * grain;
      A[y * S + x] = Math.max(0, Math.min(1, 0.5 + 0.12 * (rip - 0.5) + 0.12 * grain + 0.1 * pfbm(h1, u, v, 6, 3)));
    }
    norm(); put(2, 0.06);
  }
  // ---- 3 snow: soft drifts + wind crust + sastrugi
  {
    const h1 = makeHash(41), h2 = makeHash(42);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const drift = pfbm(h1, u, v, 3, 4, 0.5);
      const sas = Math.abs(pnoise(h2, u * 1 + 0.2 * drift, v, 12)) ;
      const crust = pfbm(h2, u, v, 32, 3, 0.5);
      H[y * S + x] = 0.6 * drift + 0.25 * (1 - sas) + 0.08 * crust;
      A[y * S + x] = 0.5 + 0.06 * drift + 0.04 * crust;
    }
    norm(); put(3, 0.05);
  }
  // ---- 4 pebbles: gravel / scree
  {
    const h1 = makeHash(51), h2 = makeHash(52), h3 = makeHash(53);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      pworley(h1, u, v, 18, 0.85, w);
      pworley(h2, u + 0.37, v + 0.11, 40, 0.9, w2);
      const r1 = 0.42 + 0.2 * w[2];
      const p1 = w[0] < r1 ? Math.sqrt(1 - (w[0] / r1) ** 2) * (0.6 + 0.4 * w[2]) : 0;
      const r2 = 0.4;
      const p2 = w2[0] < r2 ? Math.sqrt(1 - (w2[0] / r2) ** 2) * 0.5 : 0;
      const soil = pfbm(h3, u, v, 16, 3);
      H[y * S + x] = Math.max(p1, p2 * 0.7) + 0.1 * soil;
      A[y * S + x] = Math.max(0, Math.min(1, 0.5 + (p1 > 0 ? (w[2] - 0.5) * 0.5 + 0.1 : p2 > 0 ? -0.05 : -0.18) + 0.08 * soil));
    }
    norm(); put(4, 0.08);
  }
  // ---- 5 noise: B = smooth ridged-ish fbm "macro relief" (with its slopes in RG), A = independent fbm.
  //      RGBA are also used as four decorrelated macro-variation noises by the shader.
  {
    const h1 = makeHash(61), h2 = makeHash(64), h3 = makeHash(65);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const wu = u + 0.08 * pfbm(h3, u, v, 3, 2), wv = v + 0.08 * pfbm(h3, u + 0.4, v + 0.2, 3, 2);
      const n = pfbm(h1, wu, wv, 4, 5, 0.5);
      const r = 1 - Math.abs(pfbm(h1, wu + 0.3, wv + 0.7, 6, 3, 0.5));
      H[y * S + x] = 0.65 * n + 0.35 * r * r;
      A[y * S + x] = Math.max(0, Math.min(1, 0.5 + 0.62 * pfbm(h2, u, v, 4, 5, 0.5)));
    }
    norm(); put(5, 0.05);
  }
  // ---- 6 strata: layered sedimentary rock, v = vertical
  {
    const h1 = makeHash(71), h2 = makeHash(72), h3 = makeHash(73);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const warp = 0.03 * pfbm(h1, u, v, 3, 3);
      const vv = v + warp;
      const layer = vv * 9;
      const li = Math.floor(layer), lf = layer - li;
      const thick = makeHash(74)(((li % 9) + 9) % 9, 3);
      const ledge = sst(0.0, 0.12 + 0.2 * thick, lf) * (1 - sst(0.85, 1.0, lf) * 0.6);
      // (no vertical joints: thin vertical lines alias into scratches on walls seen from afar)
      // partings: thin recessed horizontal seams inside each bed, wandering in height
      let pf = layer * 3 + 0.5 * pnoise(h1, u, v, 4); pf -= Math.floor(pf);
      const parting = (1 - sst(0.0, 0.1, Math.abs(pf - 0.5) * 2 - 0.82)) * sst(-0.2, 0.4, pnoise(h3, u + 0.4, v, 3));
      // lenses: horizontally elongated tone patches (cross-bedding, iron bands)
      const lens = pfbm(h3, u + 0.11, vv * 4 + 0.37, 4, 3, 0.5);
      const grain = pfbm(h3, u, v, 32, 3);
      H[y * S + x] = (0.5 + 0.35 * thick) * ledge - 0.12 * parting + 0.1 * grain + 0.08 * lens + 0.06 * pfbm(h1, u + 0.2, v, 6, 3);
      A[y * S + x] = Math.max(0, Math.min(1, 0.5 + 0.3 * (thick - 0.5) + 0.16 * lens + 0.08 * grain - 0.16 * parting - 0.14 * (1 - ledge)));
    }
    norm(); put(6, 0.08);
  }
  // ---- 7 streaks: water / desert-varnish staining below ledges. Irregularly spaced, variable width,
  //      length and strength, slightly wandering, fading downward — never a periodic stripe pattern.
  {
    const h1 = makeHash(81), h2 = makeHash(82);
    H.fill(0); A.fill(0.5);
    const NS = 70;
    const D = new Float32Array(S * S), L = new Float32Array(S * S);
    for (let k = 0; k < NS; k++) {
      const uc = h1(k, 1), v0 = h1(k, 2), len = 0.15 + 0.7 * h1(k, 3) ** 1.5;
      const wid = 0.007 + 0.024 * h1(k, 4) ** 2, str = 0.35 + 0.65 * h1(k, 5), light = h1(k, 6) < 0.18;
      const wf = 1 + Math.floor(h1(k, 7) * 3), wa = 0.004 + 0.01 * h1(k, 8), wp = h1(k, 9) * 6.283;
      const x0 = Math.floor((uc - 0.08) * S), x1 = Math.ceil((uc + 0.08) * S);
      for (let y = 0; y < S; y++) {
        const v = y / S;
        let t = v0 - v; t -= Math.floor(t);              // distance below the streak's source (wraps)
        if (t > len) continue;
        const tt = t / len;
        const fade = sst(0, 0.04, tt) * Math.pow(1 - tt, 1.3);
        const wv = wid * (0.6 + 0.7 * tt) * (0.8 + 0.4 * pnoise(h2, uc, v, 9));
        const cu = uc + wa * Math.sin(6.283 * wf * v + wp) + 0.004 * pnoise(h2, uc + 0.5, v, 23);
        for (let xi = x0; xi <= x1; xi++) {
          const x = ((xi % S) + S) % S;
          let du = xi / S - cu; du -= Math.round(du);
          const q = Math.abs(du) / wv;
          if (q > 2.2) continue;
          const prof = Math.exp(-q * q * 1.6) * (0.75 + 0.25 * pnoise(h2, x / S, v, 64));
          const val = prof * fade * str;
          const i = y * S + x;
          D[i] = 1 - (1 - D[i]) * (1 - val);
          if (light) L[i] = Math.max(L[i], val); 
        }
      }
    }
    for (let i = 0; i < S * S; i++) { H[i] = -D[i] * 0.4; A[i] = 0.5 + 0.5 * L[i] - 0.1 * (D[i] - L[i]); }
    norm();
    // put() stores the normalized height in B; the shader wants the density itself → overwrite B
    put(7, 0.02);
    const base = 7 * S * S * 4;
    for (let i = 0; i < S * S; i++) out[base + i * 4 + 2] = Math.max(0, Math.min(255, Math.round(D[i] * 255)));
  }
  return out;
}
