// Initial conditions for the cosmic web (Web Worker).
//
// 1. Gaussian random field δ(k) with a ΛCDM power spectrum (EH98, σ8-normalised), generated
//    directly in k-space with one hash-seeded complex Gaussian per wavevector. Seeding per signed
//    mode number means a 64³ and a 128³ run of the same seed share every large-scale mode: phones
//    and desktops see the *same* universe, the desktop just adds finer structure.
// 2. Zel'dovich displacement ψ1 = i k δ / k²  and the 2LPT displacement ψ2 = ∇φ(2) with
//    ∇²φ(2) = Σ_{i>j} (φ,ii φ,jj − φ,ij²)   (Scoccimarro 1998; x = q + D1 ψ1 + D2 ψ2).
//    ψ1 is split into the part the PM mesh resolves (ψ1L, drives COLA) and the sub-mesh part
//    (ψ1S, carried as truncated LPT by the render particles only).
// 3. Smoothed linear density at several scales → per-particle collapse times and peak catalogs:
//    galaxy hosts (peaks at ~1.6 Mpc/h) and clusters (peaks at ~5 Mpc/h), with the morphology–
//    density relation (environment density) for later type assignment.
//
// Everything is in BOX UNITS (x ∈ [0,1)). Output textures use the z-slice tile atlas layout shared
// with the GPU: texel (x + (z % tilesX)·N, y + ⌊z / tilesX⌋·N).
import { FFT3 } from './fft.js';
import { powerSpectrum } from './cosmology.js';

// lowbias32
function h32(x) {
  x |= 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}
function hash4(a, b, c, d) {
  let h = h32(a ^ 0x9e3779b9);
  h = h32(h ^ ((b | 0) + 0x85ebca6b));
  h = h32(h ^ ((c | 0) + 0xc2b2ae35));
  h = h32(h ^ ((d | 0) + 0x27d4eb2f));
  return h >>> 0;
}

const DELTA_C = 1.686;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg?.cmd !== 'ic') return;
  try { run(msg); }
  catch (err) { self.postMessage({ type: 'error', error: String(err?.stack || err) }); }
};

function run(opt) {
  const t0 = performance.now();
  const { seed, N, M, box: L, tilesX } = opt;
  const N3 = N * N * N, H = N >> 1;
  const W = tilesX * N, HH = (N / tilesX) * N;
  const fft = new FFT3(N);
  const V = L * L * L;
  const TWO_PI = Math.PI * 2;

  // ------------------------------------------------------------ δ(k)
  const dRe = new Float32Array(N3), dIm = new Float32Array(N3);
  const sgn = (i) => (i < H ? i : i - N);
  const ampN = N3 / Math.sqrt(V);
  // √P tabulated by integer |m|² (every mode with the same |m| shares one evaluation)
  const sqrtP = new Float64Array(H * H);
  for (let m2 = 1; m2 < H * H; m2++) sqrtP[m2] = ampN * Math.sqrt(powerSpectrum(TWO_PI * Math.sqrt(m2) / L));
  for (let l = 0; l < N; l++) {
    const mz = sgn(l);
    for (let j = 0; j < N; j++) {
      const my = sgn(j);
      for (let i = 0; i < N; i++) {
        const mx = sgn(i);
        const m2 = mx * mx + my * my + mz * mz;
        const idx = i + N * (j + N * l);
        if (m2 === 0 || m2 >= H * H) continue;          // mean + spherical Nyquist cutoff
        const pos = mz > 0 || (mz === 0 && (my > 0 || (my === 0 && mx > 0)));
        const cx = pos ? mx : -mx, cy = pos ? my : -my, cz = pos ? mz : -mz;
        const u1 = (hash4(seed, cx, cy, cz) + 0.5) / 4294967296;
        const u2 = (hash4(seed ^ 0x51ed27, cx, cy, cz) + 0.5) / 4294967296;
        const r = Math.sqrt(-2 * Math.log(u1)) * Math.SQRT1_2;
        const gr = r * Math.cos(TWO_PI * u2), gi = r * Math.sin(TWO_PI * u2);
        const A = sqrtP[m2];
        dRe[idx] = A * gr;
        dIm[idx] = A * (pos ? gi : -gi);                   // Hermitian partner = conjugate
      }
    }
  }

  // ------------------------------------------------------------ helpers
  const wRe = new Float32Array(N3), wIm = new Float32Array(N3);
  const kvec = new Float64Array(N);   // unit-box wavenumber 2π m
  for (let i = 0; i < N; i++) kvec[i] = TWO_PI * sgn(i);
  const inMesh = (i) => { const m = sgn(i); return m > -M / 2 && m < M / 2; };
  const meshOK = new Uint8Array(N); for (let i = 0; i < N; i++) meshOK[i] = inMesh(i) ? 1 : 0;

  // Fill w = A(k) + i B(k) where A, B are k-space fields of REAL functions, each given as
  // fn(idx, kx, ky, kz, k2, inMesh) → [re, im] written into out arrays via closure.
  const tmpA = [0, 0], tmpB = [0, 0];
  function fillPair(fa, fb) {
    for (let l = 0; l < N; l++) {
      const kz = kvec[l], mz = meshOK[l];
      for (let j = 0; j < N; j++) {
        const ky = kvec[j], my = meshOK[j];
        let idx = N * (j + N * l);
        for (let i = 0; i < N; i++, idx++) {
          const kx = kvec[i];
          const k2 = kx * kx + ky * ky + kz * kz;
          if (k2 === 0) { wRe[idx] = 0; wIm[idx] = 0; continue; }
          const mesh = meshOK[i] & my & mz;
          fa(idx, kx, ky, kz, k2, mesh, tmpA);
          if (fb) fb(idx, kx, ky, kz, k2, mesh, tmpB); else { tmpB[0] = 0; tmpB[1] = 0; }
          // A + iB
          wRe[idx] = tmpA[0] - tmpB[1];
          wIm[idx] = tmpA[1] + tmpB[0];
        }
      }
    }
    fft.transform(wRe, wIm, true);
  }
  // k-space field makers
  const psi1 = (c, part) => (idx, kx, ky, kz, k2, mesh, out) => {
    const keep = part === 'L' ? mesh : part === 'S' ? 1 - mesh : 1;
    if (!keep) { out[0] = 0; out[1] = 0; return; }
    const kc = c === 0 ? kx : c === 1 ? ky : kz;
    const f = kc / k2;                     // ψ = i k δ / k²
    out[0] = -f * dIm[idx]; out[1] = f * dRe[idx];
  };
  const smooth = (Rmpc) => {
    const s = (Rmpc / L) * (Rmpc / L) * 0.5;      // unit-box k² → exp(-k² R² / 2)
    return (idx, kx, ky, kz, k2, mesh, out) => { const w = Math.exp(-k2 * s); out[0] = dRe[idx] * w; out[1] = dIm[idx] * w; };
  };
  const hess = (a, b) => (idx, kx, ky, kz, k2, mesh, out) => {
    const ka = a === 0 ? kx : a === 1 ? ky : kz, kb = b === 0 ? kx : b === 1 ? ky : kz;
    const f = ka * kb / k2;                 // φ,ab = k_a k_b δ / k²
    out[0] = f * dRe[idx]; out[1] = f * dIm[idx];
  };

  // atlas writer
  const atlasIndex = new Uint32Array(N3);
  for (let z = 0; z < N; z++) {
    const ox = (z % tilesX) * N, oy = Math.floor(z / tilesX) * N;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) atlasIndex[x + N * (y + N * z)] = ((oy + y) * W + ox + x) * 4;
  }
  function toAtlas(atlas, ch, src) { for (let i = 0; i < N3; i++) atlas[atlasIndex[i] + ch] = src[i]; }

  const post = (payload, transfer) => self.postMessage(payload, transfer);

  // ------------------------------------------------------------ stage 1: ψ1 (mesh part) + glow δ
  const atlasA = new Float32Array(W * HH * 4);
  fillPair(psi1(0, 'L'), psi1(1, 'L'));
  toAtlas(atlasA, 0, wRe); toAtlas(atlasA, 1, wIm);
  fillPair(psi1(2, 'L'), smooth(opt.rGlow ?? 7));
  toAtlas(atlasA, 2, wRe); toAtlas(atlasA, 3, wIm);
  // glow stats (σ) for normalisation on the GPU
  let s2 = 0; for (let i = 0; i < N3; i++) s2 += wIm[i] * wIm[i];
  const sigGlow = Math.sqrt(s2 / N3);
  post({ type: 'stage1', atlasA, sigGlow, ms: performance.now() - t0 }, [atlasA.buffer]);

  // ------------------------------------------------------------ stage 2
  const splitS = M < N;
  const atlasS = splitS ? new Float32Array(W * HH * 4) : null;
  const dR1 = new Float32Array(N3);
  if (splitS) {
    fillPair(psi1(0, 'S'), psi1(1, 'S'));
    toAtlas(atlasS, 0, wRe); toAtlas(atlasS, 1, wIm);
    fillPair(psi1(2, 'S'), smooth(opt.rGal ?? 1.6));
    toAtlas(atlasS, 2, wRe); dR1.set(wIm);
  }

  // 2LPT source (full-resolution Hessian of φ1)
  const src = new Float32Array(N3);
  const tA = new Float32Array(N3);
  fillPair(hess(0, 0), hess(1, 1));                   // φxx, φyy
  for (let i = 0; i < N3; i++) { src[i] = wRe[i] * wIm[i]; tA[i] = wRe[i] + wIm[i]; }
  fillPair(hess(2, 2), hess(0, 1));                   // φzz, φxy
  for (let i = 0; i < N3; i++) src[i] += tA[i] * wRe[i] - wIm[i] * wIm[i];
  fillPair(hess(0, 2), hess(1, 2));                   // φxz, φyz
  for (let i = 0; i < N3; i++) src[i] -= wRe[i] * wRe[i] + wIm[i] * wIm[i];
  // forward FFT of the source
  wRe.set(src); wIm.fill(0);
  fft.transform(wRe, wIm, false);
  const sRe = src, sIm = tA;               // reuse buffers for the source spectrum
  sRe.set(wRe); sIm.set(wIm);
  const psi2 = (c) => (idx, kx, ky, kz, k2, mesh, out) => {
    if (!mesh) { out[0] = 0; out[1] = 0; return; }
    const kc = c === 0 ? kx : c === 1 ? ky : kz;
    const f = kc / k2;                     // ψ2 = ∇φ2, φ2 = −s/k²  →  −i k s / k²
    out[0] = f * sIm[idx]; out[1] = -f * sRe[idx];
  };
  const atlasB = new Float32Array(W * HH * 4);
  fillPair(psi2(0), psi2(1));
  toAtlas(atlasB, 0, wRe); toAtlas(atlasB, 1, wIm);
  const dRcl = new Float32Array(N3);
  fillPair(psi2(2), smooth(opt.rCluster ?? 5));
  toAtlas(atlasB, 2, wRe); dRcl.set(wIm);
  const dRenv = new Float32Array(N3);
  if (!splitS) {
    fillPair(smooth(opt.rGal ?? 1.6), smooth(opt.rEnv ?? 9));
    dR1.set(wRe); dRenv.set(wIm);
  } else {
    fillPair(smooth(opt.rEnv ?? 9), null);
    dRenv.set(wRe);
  }
  toAtlas(atlasB, 3, dR1);

  // ------------------------------------------------------------ statistics
  const rms = (a) => { let s = 0; for (let i = 0; i < N3; i++) s += a[i] * a[i]; return Math.sqrt(s / N3); };
  const sigR1 = rms(dR1), sigCl = rms(dRcl), sigEnv = rms(dRenv);

  // ------------------------------------------------------------ peaks
  const isPeak = (f, x, y, z) => {
    const v = f[x + N * (y + N * z)];
    for (let dz = -1; dz <= 1; dz++) {
      const zz = (z + dz + N) % N;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = (y + dy + N) % N;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy && !dz) continue;
          if (f[(x + dx + N) % N + N * (yy + N * zz)] > v) return false;
        }
      }
    }
    return true;
  };
  function findPeaks(f, thresh) {
    const out = [];
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = f[x + N * (y + N * z)];
      if (v > thresh && isPeak(f, x, y, z)) out.push(x + N * (y + N * z));
    }
    out.sort((a, b) => f[b] - f[a]);
    return out;
  }
  const dist2 = (a, b) => {
    const ax = a % N, ay = Math.floor(a / N) % N, az = Math.floor(a / (N * N));
    const bx = b % N, by = Math.floor(b / N) % N, bz = Math.floor(b / (N * N));
    let dx = Math.abs(ax - bx), dy = Math.abs(ay - by), dz = Math.abs(az - bz);
    dx = Math.min(dx, N - dx); dy = Math.min(dy, N - dy); dz = Math.min(dz, N - dz);
    return dx * dx + dy * dy + dz * dz;
  };

  // clusters: top peaks of the cluster-scale field with non-maximum suppression
  const clMax = opt.clusterMax ?? 160;
  const clCand = findPeaks(dRcl, sigCl * 1.2);
  const clusters = [];
  const cellMpc = L / N;
  const sepCells2 = Math.pow((opt.clusterSep ?? 14) / cellMpc, 2);
  for (const c of clCand) {
    if (clusters.length >= clMax) break;
    let ok = true;
    for (const o of clusters) if (dist2(o, c) < sepCells2) { ok = false; break; }
    if (ok) clusters.push(c);
  }

  // cluster properties
  const C = clusters.length;
  const cCenter = new Int32Array(C), cMass = new Float32Array(C), cRad = new Float32Array(C), cDcoll = new Float32Array(C), cBcg = new Int32Array(C).fill(-1);
  const cNu = new Float32Array(C);
  const rclCells = (opt.rCluster ?? 5) / cellMpc;
  for (let k = 0; k < C; k++) {
    const c = clusters[k];
    cCenter[k] = c;
    const nu = dRcl[c] / sigCl;
    cNu[k] = nu;
    cMass[k] = Math.pow(nu, 3);                          // relative mass proxy
    cRad[k] = 0.55 * nu;                                  // Mpc/h, display radius of the hot halo
    cDcoll[k] = DELTA_C / Math.max(1e-3, dRcl[c]);
  }

  // ---- galaxies
  // (1) centrals: peaks of the galaxy-scale field (one galaxy per collapsed small halo)
  // (2) satellites: hosts sampled inside each cluster's Lagrangian patch (HOD: N_sat ∝ ν^2.5), so
  //     rich clusters end up with hundreds of members once the patch collapses
  // (3) field dwarfs: density-biased sprinkling that traces filaments and sheets, faint
  const galMax = opt.galaxyMax ?? 32000;
  const used = new Uint8Array(N3);
  const hostL = [], lumL = [], envL = [], clL = [], kindL = [];
  const pushGal = (cell, lum, cl, kind) => { used[cell] = 1; hostL.push(cell); lumL.push(lum); envL.push(dRenv[cell] / sigEnv); clL.push(cl); kindL.push(kind); };
  const nuMin = opt.galNuMin ?? 0.6;
  let centrals = findPeaks(dR1, sigR1 * nuMin);
  const nCentral = Math.min(centrals.length, Math.floor(galMax * 0.45));
  centrals = centrals.slice(0, nCentral);
  const nuMax = centrals.length ? dR1[centrals[0]] / sigR1 : 3;
  for (const c of centrals) {
    const nu = dR1[c] / sigR1, env = dRenv[c] / sigEnv;
    pushGal(c, Math.pow(nu / nuMax, 3.2) * Math.exp(0.35 * Math.max(-1.5, Math.min(3, env))), -1, 0);
  }
  // cluster membership of centrals (nearest cluster whose patch contains them)
  const patchCells = (k) => rclCells * (1.15 + 0.22 * cNu[k]);
  for (let g = 0; g < hostL.length; g++) {
    let best = -1, bd = 1e9;
    for (let k = 0; k < C; k++) {
      const d2 = dist2(hostL[g], cCenter[k]);
      const R = patchCells(k);
      if (d2 < R * R && d2 < bd) { bd = d2; best = k; }
    }
    clL[g] = best;
  }
  // BCG: brightest central in the patch (or the peak cell itself), strongly boosted
  for (let k = 0; k < C; k++) {
    let best = -1, bl = -1;
    for (let g = 0; g < hostL.length; g++) if (clL[g] === k && lumL[g] > bl) { bl = lumL[g]; best = g; }
    if (best < 0 && !used[cCenter[k]]) { pushGal(cCenter[k], 0.5, k, 0); best = hostL.length - 1; }
    if (best >= 0) { cBcg[k] = best; lumL[best] = Math.max(lumL[best], 0.6) * (1.8 + 0.3 * cNu[k]); kindL[best] = 3; }
  }
  // satellites
  const satA = opt.satA ?? 5.5;
  const cx = (i) => i % N, cy = (i) => Math.floor(i / N) % N, cz = (i) => Math.floor(i / (N * N));
  for (let k = 0; k < C && hostL.length < galMax; k++) {
    const want = Math.min(Math.round(satA * Math.pow(Math.max(cNu[k], 1), 2.5) * Math.pow(N / 128, 0.0)), galMax - hostL.length);
    if (want <= 0) continue;
    const R = patchCells(k), Ri = Math.ceil(R), c0 = cCenter[k];
    const x0 = cx(c0), y0 = cy(c0), z0 = cz(c0);
    const cand = [];
    for (let dz = -Ri; dz <= Ri; dz++) for (let dy = -Ri; dy <= Ri; dy++) for (let dx = -Ri; dx <= Ri; dx++) {
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 > R * R) continue;
      const cell = ((x0 + dx + N) % N) + N * (((y0 + dy + N) % N) + N * ((z0 + dz + N) % N));
      if (used[cell]) continue;
      const v = dR1[cell] / sigR1;
      if (v <= 0) continue;
      const w = v * v * (1 - 0.5 * r2 / (R * R));
      const u = (hash4(seed ^ 0x5a7e11, cell, k, 7) + 0.5) / 4294967296;
      cand.push([Math.pow(u, 1 / w), cell]);           // weighted reservoir key
    }
    cand.sort((a, b) => b[0] - a[0]);
    const n = Math.min(want, cand.length);
    for (let s = 0; s < n; s++) {
      const u = (hash4(seed ^ 0x5a7, cand[s][1], 3, 9) + 0.5) / 4294967296;
      pushGal(cand[s][1], 0.25 * Math.pow(u, 2.2) + 0.01, k, 1);
    }
  }
  // field dwarfs (density-biased Bernoulli sprinkling)
  const dwarfsWanted = galMax - hostL.length;
  if (dwarfsWanted > 0) {
    let sw = 0;
    const wOf = (i) => { const v = dR1[i] / sigR1 - 0.3; const e = dRenv[i] / sigEnv; return v > 0 && e > -0.6 ? v * v * (e + 0.6) : 0; };
    for (let i = 0; i < N3; i++) if (!used[i]) sw += wOf(i);
    const kf = sw > 0 ? dwarfsWanted / sw : 0;
    for (let i = 0; i < N3 && hostL.length < galMax; i++) {
      if (used[i]) continue;
      const p = wOf(i) * kf;
      if (p <= 0) continue;
      const u = (hash4(seed ^ 0xd3a4f, i, 1, 2) + 0.5) / 4294967296;
      if (u < p) { const u2 = (hash4(seed ^ 0xd3a5, i, 5, 6) + 0.5) / 4294967296; pushGal(i, 0.004 + 0.05 * Math.pow(u2, 3), -1, 2); }
    }
  }
  const G = hostL.length;
  const gHost = Int32Array.from(hostL), gLum = Float32Array.from(lumL), gEnv = Float32Array.from(envL);
  const gCluster = Int16Array.from(clL), gKind = Uint8Array.from(kindL), gDign = new Float32Array(G);
  const fb = opt.formBoost ?? 4.5;
  for (let g = 0; g < G; g++) {
    // ignition growth factor from the host's small-scale overdensity (progenitors form earlier
    // than the resolved peak: formBoost); satellites/dwarfs form a little later and more spread
    const d = Math.max(0.05 * sigR1, dR1[gHost[g]]);
    const u = (hash4(seed ^ 0x16a1, g, 0, 0) + 0.5) / 4294967296;
    gDign[g] = DELTA_C / (d * fb) * (gKind[g] === 2 ? 1.2 + 0.6 * u : 0.9 + 0.25 * u);
  }

  const ms = performance.now() - t0;
  const transfer = [atlasB.buffer, gHost.buffer, gLum.buffer, gDign.buffer, gEnv.buffer, gCluster.buffer, gKind.buffer, cCenter.buffer, cMass.buffer, cRad.buffer, cDcoll.buffer, cBcg.buffer, cNu.buffer];
  if (atlasS) transfer.push(atlasS.buffer);
  post({
    type: 'stage2', atlasB, atlasS,
    stats: { sigR1, sigCl, sigEnv, nuMax, ms },
    galaxies: { host: gHost, lum: gLum, dign: gDign, env: gEnv, cluster: gCluster, kind: gKind, count: G },
    clusters: { center: cCenter, mass: cMass, radius: cRad, dcoll: cDcoll, bcg: cBcg, nu: cNu, count: C },
  }, transfer);
}
