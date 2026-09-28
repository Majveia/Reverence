// Night-sky bake (pure JS, runs in a worker; also importable from node for tests).
// Renders the HOST GALAXY as seen from the current star, using the shared GalaxyModel:
//   • diffuse light: ray-marched stellar emission (bulge / old disk / young arms + HII glow) with
//     wavelength-dependent dust extinction → equirectangular HDR panorama in the GALAXY frame
//     (rgb = emission, a = dust optical depth used for procedural dust-lane detail in the shader)
//   • resolved stars: the real local-neighbourhood stars (GalaxyModel local LOD cells) plus luminous
//     distant giants from the global population, with fluxes L/d² and blackbody colours.
// Units: light-years. Galaxy frame: disk in XZ, +Y = galactic north.
import {
  galaxyDensity, galaxyStar, forEachLocalStar, localCellOf, galaxyStructure, galaxyNebulae,
  LOCAL_GRID, GLOBAL_STARS,
} from '../../universe/GalaxyModel.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Latitude of a panorama row coordinate t ∈ [-1, 1] (t = +1 top). Inverse in GLSL (sky.js). */
export const LAT_A = 0.35, LAT_B = 0.65;
export function tOfLat(lat) {
  const y = lat / (Math.PI / 2);
  let t = y;
  for (let k = 0; k < 8; k++) t -= (LAT_A * t + LAT_B * t * t * t - y) / (LAT_A + 3 * LAT_B * t * t);
  return Math.max(-1, Math.min(1, t));
}
export function latOfT(t) { return (Math.PI / 2) * (LAT_A * t + LAT_B * t * t * t); }

/** Approximate linear-sRGB colour of a blackbody (normalised to max channel 1). */
export function bbColor(T, out = [0, 0, 0]) {
  const t = Math.min(40000, Math.max(1000, T)) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const lin = (c) => { c = Math.min(255, Math.max(0, c)) / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  r = lin(r); g = lin(g); b = lin(b);
  const m = Math.max(r, g, b, 1e-6);
  out[0] = r / m; out[1] = g / m; out[2] = b / m;
  return out;
}

/**
 * @param {object} p { galaxy (plain record), pos [x,y,z] ly, W, H, steps, maxStars, localRadius, globalSample }
 * @returns {{ W, H, band: Float32Array(W*H*4), stars: { n, dir: Float32Array, col: Float32Array, flux: Float32Array }, fluxRef, nebulae }}
 */
export function bakeSky(p) {
  const g = p.galaxy;
  const S = galaxyStructure(g);
  const [px, py0, pz] = p.pos;
  // art direction: observe the diffuse band from near the mid-plane (stars far above/below the disk
  // would otherwise see a half-sky glow with a hard edge instead of a Milky-Way band)
  const py = Math.max(-S.hOld * 0.35, Math.min(S.hOld * 0.35, py0));
  const W = p.W, H = p.H, N = p.steps || 40;
  const band = new Float32Array(W * H * 4);
  const R = S.R;
  const s0 = 25, s1 = R * 2.6;
  const lr = Math.log(s1 / s0);
  // dust opacity per unit dust density per ly: calibrated so the in-plane column toward the centre is
  // several optical depths (dark rifts), off-plane sight lines are transparent
  const kDust = (p.kDust ?? 1.0) / Math.max(1e-6, S.dust) / Math.max(200, S.hDust) * 1.6;
  const d = {};
  // step table
  const sArr = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) sArr[i] = s0 * Math.exp(lr * i / N);
  const hCut = Math.max(2500, S.hOld * 6, R * 0.22);
  for (let j = 0; j < H; j++) {
    // non-linear latitude rows: fine near the galactic equator (dust lanes), coarse at the poles
    const tt = 1 - 2 * (j + 0.5) / H;
    const lat = latOfT(tt);
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W - 0.5) * Math.PI * 2;
      const dx = cl * Math.sin(lon), dy = sl, dz = cl * Math.cos(lon);
      let r = 0, gg = 0, b = 0, tauR = 0, tauG = 0, tauB = 0, tauNear = 0;
      // closest approach of the sight line to the galactic centre (the bulge is tall: don't cut it)
      const sStar = -(px * dx + py * dy + pz * dz);
      const cx0 = px + dx * sStar, cy0 = py + dy * sStar, cz0 = pz + dz * sStar;
      const passesBulge = sStar > 0 && Math.hypot(cx0, cy0, cz0) < R * 0.3;
      for (let k = 0; k < N; k++) {
        const sa = sArr[k], sb = sArr[k + 1];
        const s = (sa + sb) * 0.5, ds = sb - sa;
        galaxyDensity(g, px + dx * s, py + dy * s, pz + dz * s, d);
        const rho = d.stars * ds;
        const w = smooth(40, 350, s);           // resolved stars take over very close by
        const tD = d.dust * ds * kDust;
        // emission colour: bulge warm, old disk neutral-warm, young blue-white + HII pink
        const yb = d.young, bu = d.bulge, od = Math.max(0, 1 - yb - bu);
        const er = bu * 1.0 + od * 0.97 + yb * 0.74;
        const eg = bu * 0.82 + od * 0.93 + yb * 0.86;
        const eb = bu * 0.62 + od * 0.86 + yb * 1.0;
        // HII / reflection-nebula glow rides on the young population
        const hii = yb * yb * 0.25;
        const tr = Math.exp(-tauR - tD * 0.5 * 0.8), tg = Math.exp(-tauG - tD * 0.5), tb = Math.exp(-tauB - tD * 0.5 * 1.2);
        const e = rho * w;
        r += e * (er + hii * 1.0) * tr;
        gg += e * (eg + hii * 0.32) * tg;
        b += e * (eb + hii * 0.55) * tb;
        tauR += tD * 0.8; tauG += tD; tauB += tD * 1.2;
        if (s < 4000) tauNear += tD;
        // early out: far above/below the disk, moving away, outside the bulge
        const yy = py + dy * s;
        if (Math.abs(yy) > hCut && yy * dy > 0) {
          if (s > 3000 && (!passesBulge || s > sStar + R * 0.3)) break;
        }
      }
      const o = (j * W + i) * 4;
      band[o] = r; band[o + 1] = gg; band[o + 2] = b; band[o + 3] = Math.min(12, tauG * 0.35 + tauNear * 0.65);
    }
  }
  // normalise: the 99.7th percentile of luminance → 1
  const lum = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) lum[k] = band[k * 4] * 0.2126 + band[k * 4 + 1] * 0.7152 + band[k * 4 + 2] * 0.0722;
  const sorted = Float32Array.from(lum).sort();
  const ref = Math.max(1e-30, sorted[Math.floor(sorted.length * 0.98)]);
  const med = sorted[Math.floor(sorted.length * 0.5)] / ref;
  const lowRef = sorted[Math.floor(sorted.length * 0.3)] / ref;   // high-latitude sky level (black floor)
  for (let k = 0; k < W * H; k++) { band[k * 4] /= ref; band[k * 4 + 1] /= ref; band[k * 4 + 2] /= ref; }

  // ---------------------------------------------------------------- resolved stars
  const maxStars = p.maxStars || 30000;
  const Rl = p.localRadius || 1200;
  const list = []; // [flux, dx, dy, dz, T]
  const c = localCellOf(px, py0, pz, {});
  if (c) {
    const n = Math.ceil(Rl / 200) + 1;
    const sc = {};
    for (let cy = 0; cy < 8; cy++) for (let dzc = -n; dzc <= n; dzc++) for (let dxc = -n; dxc <= n; dxc++) {
      const cx = c.cx + dxc, cz = c.cz + dzc;
      if (cx < 0 || cz < 0 || cx >= LOCAL_GRID || cz >= LOCAL_GRID) continue;
      forEachLocalStar(g, cx, cy, cz, (idx, st) => {
        const ex = st.x - px, ey = st.y - py0, ez = st.z - pz;
        const dd = Math.hypot(ex, ey, ez);
        if (dd < 0.3 || dd > Rl) return;
        list.push([st.luminosity / (dd * dd), ex / dd, ey / dd, ez / dd, st.temperature, dd]);
      }, sc);
    }
  }
  // luminous distant stars (giants along the band) from the representative global population
  const gN = Math.min(GLOBAL_STARS, p.globalSample || 120000);
  const gs = {};
  for (let i = 0; i < gN; i++) {
    galaxyStar(g, i, gs);
    if (gs.luminosity < 30) continue;
    const ex = gs.x - px, ey = gs.y - py0, ez = gs.z - pz;
    const dd = Math.hypot(ex, ey, ez);
    if (dd < Rl) continue;
    list.push([gs.luminosity * 0.35 / (dd * dd), ex / dd, ey / dd, ez / dd, gs.temperature, dd]);
  }
  list.sort((a, b) => b[0] - a[0]);
  const ns = Math.min(maxStars, list.length);
  const dir = new Float32Array(ns * 3), col = new Float32Array(ns * 3), flux = new Float32Array(ns);
  const bc = [0, 0, 0];
  // extinction toward each star (sample the band's dust column, scaled by distance fraction)
  for (let k = 0; k < ns; k++) {
    const L = list[k];
    dir[k * 3] = L[1]; dir[k * 3 + 1] = L[2]; dir[k * 3 + 2] = L[3];
    bbColor(L[4], bc);
    // interstellar reddening along the band for distant stars
    const lon = Math.atan2(L[1], L[3]), lat = Math.asin(Math.max(-1, Math.min(1, L[2])));
    const bi = Math.min(W - 1, Math.max(0, Math.floor((lon / (Math.PI * 2) + 0.5) * W)));
    const bj = Math.min(H - 1, Math.max(0, Math.floor((1 - tOfLat(lat)) * 0.5 * H)));
    const tau = band[(bj * W + bi) * 4 + 3] * Math.min(1, L[5] / 6000);
    const ext = Math.exp(-tau * 0.8);
    col[k * 3] = bc[0] * Math.exp(-tau * 0.55); col[k * 3 + 1] = bc[1] * Math.exp(-tau * 0.8); col[k * 3 + 2] = bc[2] * Math.exp(-tau * 1.1);
    flux[k] = L[0] * ext;
  }
  const refRank = Math.min(ns - 1, p.refRank || 1200);
  const fluxRef = ns ? Math.max(1e-30, [...flux].sort((a, b) => b - a)[Math.max(0, refRank)]) : 1;

  // unresolved Milky-Way stars: faint points distributed like the band's light (the band sparkles)
  const nx = Math.round(p.extraStars ?? maxStars * 0.8);
  const cdf = new Float64Array(W * H);
  let acc = 0;
  for (let j = 0; j < H; j++) {
    const t0 = 1 - 2 * j / H, t1 = 1 - 2 * (j + 1) / H;
    const la0 = latOfT(t0), la1 = latOfT(t1);
    const w = Math.abs(Math.sin(la0) - Math.sin(la1));          // solid angle of the row
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const l = band[k * 4] * 0.3 + band[k * 4 + 1] * 0.6 + band[k * 4 + 2] * 0.1;
      acc += Math.pow(Math.max(l - med * 0.6, 0), 1.15) * w;
      cdf[k] = acc;
    }
  }
  const dir2 = new Float32Array((ns + nx) * 3), col2 = new Float32Array((ns + nx) * 3), flux2 = new Float32Array(ns + nx);
  dir2.set(dir); col2.set(col); flux2.set(flux);
  let seed = 0x9e3779b9 ^ (Math.floor(px * 7 + pz * 13) | 0);
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  let m = 0;
  if (acc > 0) {
    for (let e = 0; e < nx; e++) {
      const u = rnd() * acc;
      let lo = 0, hi = W * H - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
      const j = Math.floor(lo / W), i = lo - j * W;
      const lon = ((i + rnd()) / W - 0.5) * Math.PI * 2;
      const lat = latOfT(1 - 2 * (j + rnd()) / H);
      const cl = Math.cos(lat);
      const o = (ns + m) * 3;
      dir2[o] = cl * Math.sin(lon); dir2[o + 1] = Math.sin(lat); dir2[o + 2] = cl * Math.cos(lon);
      const k = lo * 4;
      const bl = Math.max(band[k], band[k + 1], band[k + 2], 1e-9);
      bbColor(3000 + Math.pow(rnd(), 1.5) * 9000, bc);
      col2[o] = bc[0] * 0.5 + 0.5 * band[k] / bl; col2[o + 1] = bc[1] * 0.5 + 0.5 * band[k + 1] / bl; col2[o + 2] = bc[2] * 0.5 + 0.5 * band[k + 2] / bl;
      flux2[ns + m] = fluxRef * (0.04 + Math.pow(rnd(), 4) * 0.9);
      m++;
    }
  }
  const nAll = ns + m;
  // notable nebulae (direction + angular size) for sprite rendering
  const nebulae = [];
  try {
    for (const nb of galaxyNebulae(g)) {
      const ex = nb.x - px, ey = nb.y - py, ez = nb.z - pz;
      const dd = Math.hypot(ex, ey, ez);
      const ang = Math.atan(nb.radius * 2.5 / Math.max(dd, 1));
      nebulae.push({ kind: nb.kind, dir: [ex / dd, ey / dd, ez / dd], ang, dist: dd, seed: nb.seed, palette: nb.palette });
    }
  } catch (_) { /* optional */ }

  return { W, H, band, median: med, lowRef, stars: { n: nAll, dir: dir2, col: col2, flux: flux2 }, fluxRef, nebulae };
}
