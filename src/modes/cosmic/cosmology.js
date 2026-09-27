// Flat ΛCDM background + linear/second-order growth + COLA integration factors + EH98 power
// spectrum. Pure JS (no DOM, no three) so it runs in the IC worker and on the main thread.
//
// Units
//   lengths  Mpc/h (power spectrum, box size); the simulation itself works in BOX UNITS (x ∈ [0,1))
//   time     1/H0 inside the dynamics (H0 = 1); ages are reported in Gyr
//   momentum p = a² dx/dt  (box units, 1/H0)
//
// Equations of motion (comoving, box units, ∇²Φ = δ on the unit box):
//   dx/da = p / (a³ E(a))
//   dp/da = −(3/2) Ωm ∇Φ / (a² E(a))
// COLA (Tassev, Zaldarriaga & Eisenstein 2013) splits x = x_LPT(a) + x_res and integrates only the
// residual, whose "force" is gravity minus the 2LPT acceleration:
//   dp_res/da = (3/2) Ωm / (a² E) · [ −∇Φ(x) − D1 ψ1 − (D2 − D1²) ψ2 ]
// so a pure 2LPT flow has zero residual and very few PM steps give accurate halos and filaments.

export const COSMO = Object.freeze({
  Om: 0.3111,      // matter
  Ob: 0.0490,      // baryons
  h: 0.6766,
  ns: 0.9665,
  sigma8: 0.8102,
  Tcmb: 2.7255,
  Or: 9.06e-5,     // radiation (photons + neutrinos), used only for ages / early expansion
});
const OL = 1 - COSMO.Om - COSMO.Or;
export const HUBBLE_TIME_GYR = 977.792 / (100 * COSMO.h); // 1/H0 in Gyr (14.45 Gyr)

/** Dimensionless expansion rate (matter + Λ; radiation ignored for dynamics). */
export function E(a) { return Math.sqrt(COSMO.Om / (a * a * a) + (1 - COSMO.Om)); }
/** Expansion rate including radiation (for ages at recombination). */
export function Efull(a) { return Math.sqrt(COSMO.Or / (a * a * a * a) + COSMO.Om / (a * a * a) + OL); }
/** Ωm(a) */
export function OmegaM(a) { const e = E(a); return COSMO.Om / (a * a * a * e * e); }

// ---------------------------------------------------------------- growth tables
// D1 from the Heath (1977) integral (exact for matter + Λ):  D ∝ E(a) ∫0^a da' / (a' E(a'))³
// Tabulated on a log-a grid, normalised to D1(a=1) = 1.
const TAB_N = 1400, LNA0 = Math.log(1e-4), LNA1 = Math.log(40);
const tabLnA = new Float64Array(TAB_N), tabD1 = new Float64Array(TAB_N), tabAge = new Float64Array(TAB_N);
(function buildTables() {
  // integrand g(a) = 1/(a E)^3 ; for a→0, E ≈ sqrt(Om) a^-1.5 so g ≈ a^1.5 / Om^1.5 (integrable)
  let I = 0, age = 0;
  let prevA = 0, prevG = 0, prevT = 0;
  // analytic start for the first bin (matter dominated): I(a) = a^2.5 / (2.5 Om^1.5)
  for (let i = 0; i < TAB_N; i++) {
    const lna = LNA0 + (LNA1 - LNA0) * i / (TAB_N - 1);
    const a = Math.exp(lna);
    const g = 1 / Math.pow(a * E(a), 3);
    const tInt = 1 / (a * Efull(a));                 // dt/da
    if (i === 0) {
      I = Math.pow(a, 2.5) / (2.5 * Math.pow(COSMO.Om, 1.5));
      // age with radiation: t(a) = ∫ da/(a E); for tiny a use radiation+matter closed form
      const Om = COSMO.Om, Or = COSMO.Or;
      // t = (2/(3 Om^2)) * [ (Om a - 2 Or) sqrt(Or + Om a) + 2 Or^1.5 ]
      age = (2 / (3 * Om * Om)) * ((Om * a - 2 * Or) * Math.sqrt(Or + Om * a) + 2 * Math.pow(Or, 1.5));
    } else {
      // Simpson on [prevA, a] with midpoint
      const am = 0.5 * (prevA + a);
      const gm = 1 / Math.pow(am * E(am), 3);
      I += (a - prevA) / 6 * (prevG + 4 * gm + g);
      const tm = 1 / (am * Efull(am));
      age += (a - prevA) / 6 * (prevT + 4 * tm + tInt);
    }
    tabLnA[i] = lna;
    tabD1[i] = 2.5 * COSMO.Om * E(a) * I;
    tabAge[i] = age;
    prevA = a; prevG = g; prevT = tInt;
  }
  // normalise D1(1) = 1
  const d1 = interpTab(tabD1, 0);
  for (let i = 0; i < TAB_N; i++) tabD1[i] /= d1;
})();

function interpTab(tab, lna) {
  const u = (lna - LNA0) / (LNA1 - LNA0) * (TAB_N - 1);
  if (u <= 0) return tab[0] * (tab === tabD1 ? Math.exp(lna - LNA0) : 1);
  if (u >= TAB_N - 1) return tab[TAB_N - 1];
  const i = Math.floor(u), f = u - i;
  return tab[i] * (1 - f) + tab[i + 1] * f;
}

/** Linear growth factor, D1(1) = 1. */
export function D1(a) { return interpTab(tabD1, Math.log(a)); }
/** Second-order growth factor (Bouchet et al. 1995 fit): D2 = −3/7 D1² Ωm(a)^(−1/143). */
export function D2(a) { const d = D1(a); return -3 / 7 * d * d * Math.pow(OmegaM(a), -1 / 143); }
/** Cosmic age in Gyr (with radiation). */
export function ageGyr(a) { return interpTab(tabAge, Math.log(a)) * HUBBLE_TIME_GYR; }
/** Inverse of ageGyr (bisection in ln a). */
export function aOfAge(tGyr) {
  let lo = LNA0, hi = LNA1;
  for (let k = 0; k < 60; k++) { const m = 0.5 * (lo + hi); if (ageGyr(Math.exp(m)) < tGyr) lo = m; else hi = m; }
  return Math.exp(0.5 * (lo + hi));
}
/** Growth rate f = dlnD/dlna (Linder γ = 0.55 approximation). */
export function growthRate(a) { return Math.pow(OmegaM(a), 0.55); }

// ---------------------------------------------------------------- COLA factors
function simpson(fn, a0, a1, n = 24) {
  if (a1 === a0) return 0;
  const h = (a1 - a0) / n;
  let s = fn(a0) + fn(a1);
  for (let i = 1; i < n; i++) s += fn(a0 + i * h) * (i & 1 ? 4 : 2);
  return s * h / 3;
}
const driftIntegrand = (a) => 1 / (a * a * a * E(a));
const kickIntegrand = (a) => 1.5 * COSMO.Om / (a * a * E(a));
/** ∫ da / (a³ E) — multiplies the residual momentum in a drift from a0 to a1. */
export function driftFactor(a0, a1) { return simpson(driftIntegrand, a0, a1); }
/** ∫ (3/2) Ωm / (a² E) da — multiplies the residual force bracket in a kick from a0 to a1. */
export function kickFactor(a0, a1) { return simpson(kickIntegrand, a0, a1); }

// ---------------------------------------------------------------- power spectrum
/** Eisenstein & Hu (1998) no-wiggle transfer function, k in h/Mpc. */
export function transferEH(k) {
  const { Om, Ob, h, Tcmb } = COSMO;
  const theta = Tcmb / 2.7;
  const omh2 = Om * h * h, obh2 = Ob * h * h, fb = Ob / Om;
  const s = 44.5 * Math.log(9.83 / omh2) / Math.sqrt(1 + 10 * Math.pow(obh2, 0.75)); // Mpc
  const alphaG = 1 - 0.328 * Math.log(431 * omh2) * fb + 0.38 * Math.log(22.3 * omh2) * fb * fb;
  const gammaEff = Om * h * (alphaG + (1 - alphaG) / (1 + Math.pow(0.43 * k * h * s, 4)));
  const q = k * theta * theta / gammaEff;
  const L0 = Math.log(2 * Math.E + 1.8 * q);
  const C0 = 14.2 + 731 / (1 + 62.5 * q);
  return L0 / (L0 + C0 * q * q);
}

let _pkAmp = 0;
function tophatW(x) {
  if (x < 1e-3) return 1 - x * x / 10;
  return 3 * (Math.sin(x) - x * Math.cos(x)) / (x * x * x);
}
/** Linear P(k) at z = 0 in (Mpc/h)³, k in h/Mpc, normalised to σ8. */
export function powerSpectrum(k) {
  if (!_pkAmp) {
    // σ²(R) = 1/(2π²) ∫ k² P(k) W²(kR) dk
    let s = 0;
    const n = 4000, l0 = Math.log(1e-5), l1 = Math.log(200);
    for (let i = 0; i <= n; i++) {
      const lk = l0 + (l1 - l0) * i / n, kk = Math.exp(lk);
      const t = transferEH(kk), w = tophatW(kk * 8);
      const f = kk * kk * kk * Math.pow(kk, COSMO.ns) * t * t * w * w; // k³ P / A
      s += f * (i === 0 || i === n ? 0.5 : 1);
    }
    s *= (l1 - l0) / n / (2 * Math.PI * Math.PI);
    _pkAmp = COSMO.sigma8 * COSMO.sigma8 / s;
  }
  if (k <= 0) return 0;
  const t = transferEH(k);
  return _pkAmp * Math.pow(k, COSMO.ns) * t * t;
}

/** Redshift ↔ scale factor helpers. */
export const zOfA = (a) => 1 / a - 1;
export const aOfZ = (z) => 1 / (1 + z);

/** Human-readable cosmic age: 380 kyr / 12 Myr / 450 Myr / 13.8 Gyr. */
export function formatAge(gyr) {
  if (gyr < 0.001) return `${Math.round(gyr * 1e6)} kyr`;
  if (gyr < 1) return `${Math.round(gyr * 1000)} Myr`;
  return `${gyr.toFixed(gyr < 10 ? 2 : 1)} Gyr`;
}
export function formatZ(z) {
  if (z >= 100) return String(Math.round(z));
  if (z >= 10) return z.toFixed(1);
  if (z > -0.995) return z.toFixed(2);
  return z.toFixed(2);
}
