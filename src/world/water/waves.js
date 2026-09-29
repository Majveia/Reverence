// Gerstner wave set shared by the GPU surface and CPU queries (heightAt, buoyancy, swimming).
//
// Waves live in a 2D "wave frame" tangent to the planet at an anchor point: Q(X) = (X·T1, X·T2) for a
// planet-local point X on the sea sphere. T1 points down-wind (prevailing wind at the anchor), so the
// spectrum is wind aligned. Per frame the CPU computes each wave's phase at the camera nadir in float64
// (mod 2π) and the GPU only adds k·(D·q_rel) for the small offset from the nadir → no float32 phase loss
// anywhere on the planet. The anchor moves only when the camera travels far (> ~0.12 rad).
import * as THREE from 'three';
import { RNG } from '../../core/rng.js';

export const MAX_WAVES = 16;
const TAU = Math.PI * 2;

const _n = new THREE.Vector3();

export class WaveSet {
  /**
   * @param body planet data
   * @param opts { count, liquid, seed }
   */
  constructor(body, opts = {}) {
    const liquid = opts.liquid || 'water';
    const rng = new RNG(((body.seed ?? 1) ^ 0x3a7e5) >>> 0);
    const art = body.art || {};
    const wx = art.weather || {};
    const windy = THREE.MathUtils.clamp((wx.wind ?? 0.35) + (wx.rain ?? 0) * 0.35 + (body.type === 'ocean' ? 0.12 : 0), 0.05, 1);
    // long swell (generated far away, arrives smooth and wind-independent) + the local wind sea
    const nSwell = liquid === 'water' || liquid === 'acid' ? (opts.swell ?? 3) : 0;
    this.nSwell = nSwell;
    this.count = Math.min(MAX_WAVES, (opts.count ?? 12) + nSwell);
    this.g = Math.max(2, body.gravity || 9.81);
    this.liquid = liquid;
    // character: calm lakes (Tarkovsky, low wind) … rolling swell (monsoon oceans)
    const visc = liquid === 'lava' ? 0.22 : liquid === 'acid' ? 0.8 : liquid === 'ice' ? 0 : 1;
    const L0 = THREE.MathUtils.lerp(20, 58, windy) * (liquid === 'lava' ? 1.6 : 1);
    const slope = (liquid === 'lava' ? 0.035 : THREE.MathUtils.lerp(0.048, 0.1, windy)) * (liquid === 'ice' ? 0 : 1);
    this.windy = windy;
    this.L0 = L0;
    this.k = new Float64Array(MAX_WAVES);
    this.A = new Float64Array(MAX_WAVES);
    this.Q = new Float64Array(MAX_WAVES);
    this.w = new Float64Array(MAX_WAVES);
    this.dx = new Float64Array(MAX_WAVES);
    this.dy = new Float64Array(MAX_WAVES);
    this.phi0 = new Float64Array(MAX_WAVES);
    this.phase = new Float64Array(MAX_WAVES);   // phase at the camera nadir, this frame (mod 2π)
    this.lambda = new Float64Array(MAX_WAVES);
    this.short = new Float64Array(MAX_WAVES);   // 1 for the short wind-sea waves (gust-modulated in the shader)
    const n = this.count;
    // Σ Q·k·A ≤ ~1: swell stays smooth (rounded), the wind sea gets the choppy, peaked crests
    const qSea = liquid === 'lava' ? 0.45 : THREE.MathUtils.lerp(0.72, 0.9, windy);
    const qSwell = 0.1;
    const swellDir = rng.range(-0.45, 0.45);
    const swellL = [5.6, 3.7, 2.5];
    const swellS = THREE.MathUtils.lerp(0.03, 0.052, windy);
    for (let i = 0; i < nSwell; i++) {
      const L = L0 * swellL[i] * rng.range(0.92, 1.08);
      const k = TAU / L;
      const A = swellS * (1 - 0.18 * i) * rng.range(0.9, 1.1) / k;
      const ang = swellDir + rng.range(-0.14, 0.14) + (i === 2 ? 0.3 : 0);
      this.k[i] = k; this.A[i] = A; this.lambda[i] = L;
      this.dx[i] = Math.cos(ang); this.dy[i] = Math.sin(ang);
      this.w[i] = Math.sqrt(this.g * k) * visc;
      this.Q[i] = qSwell / (k * A);
      this.phi0[i] = rng.range(0, TAU);
    }
    const nSea = n - nSwell;
    let lam = L0;
    for (let j = 0; j < nSea; j++) {
      const i = nSwell + j;
      const t = j / Math.max(1, nSea - 1);
      const L = lam * rng.range(0.9, 1.1);
      lam *= 0.74;
      const k = TAU / L;
      // direction: wind ± spread growing for shorter waves; a few cross-swells
      const spread = 0.25 + 0.75 * t;
      let ang = rng.range(-spread, spread);
      if (j === 2) ang += 0.55; if (j === 3) ang -= 0.5;
      const s = slope * (1.0 - 0.5 * t) * rng.range(0.8, 1.15);
      const A = s / k;
      this.k[i] = k; this.A[i] = A; this.lambda[i] = L;
      this.dx[i] = Math.cos(ang); this.dy[i] = Math.sin(ang);
      this.w[i] = Math.sqrt(this.g * k) * visc * (liquid === 'lava' ? 0.6 : 1);
      this.Q[i] = qSea / (k * Math.max(A, 1e-6) * nSea);
      this.phi0[i] = rng.range(0, TAU);
      this.short[i] = j >= 2 ? 1 : 0;
    }
    // keep Q ≤ 1/(kA) per wave (no loops from a single wave)
    for (let i = 0; i < n; i++) this.Q[i] = Math.min(this.Q[i], 1 / (this.k[i] * this.A[i] + 1e-9) * 0.95);
    // amplitude of the dominant wind-sea wave (crest normaliser for foam / subsurface glow)
    this.seaA0 = this.A[nSwell] || this.A[0] || 0.1;
    this.amp = 1;            // runtime amplitude multiplier (wind strength)
    // wave frame
    this.anchor = new THREE.Vector3(0, 1, 0);
    this.T1 = new THREE.Vector3(1, 0, 0);
    this.T2 = new THREE.Vector3(0, 0, 1);
    this.Rs = body.radius;
    this.maxHeight = 0;
    for (let i = 0; i < n; i++) this.maxHeight += this.A[i];
  }

  /** (Re)anchor the wave frame at unit direction `dir` with down-wind tangent `wind` (scene/local dir). */
  setAnchor(dir, wind) {
    this.anchor.copy(dir).normalize();
    const up = this.anchor;
    const t1 = this.T1.copy(wind).addScaledVector(up, -wind.dot(up));
    if (t1.lengthSq() < 1e-8) t1.set(1, 0, 0).addScaledVector(up, -up.x);
    t1.normalize();
    this.T2.crossVectors(up, t1).normalize();
  }

  /** Per-frame phases at a wave-frame coordinate (qx, qy) of the camera nadir. */
  updatePhases(qx, qy, t) {
    for (let i = 0; i < this.count; i++) {
      const p = this.k[i] * (this.dx[i] * qx + this.dy[i] * qy) - this.w[i] * t + this.phi0[i];
      this.phase[i] = p - Math.floor(p / TAU) * TAU;
    }
  }

  /** Global phase (float64) at wave coordinate q. */
  _phase(i, qx, qy, t) { return this.k[i] * (this.dx[i] * qx + this.dy[i] * qy) - this.w[i] * t + this.phi0[i]; }

  /**
   * Height (m, relative to the sea sphere) of the displaced surface above wave-frame coordinate (qx,qy).
   * Inverts the Gerstner horizontal displacement with a few fixed-point iterations.
   */
  heightQ(qx, qy, t, out = null) {
    const n = this.count, amp = this.amp;
    let x = qx, y = qy;
    for (let it = 0; it < 3; it++) {
      let ox = 0, oy = 0;
      for (let i = 0; i < n; i++) {
        const c = Math.cos(this._phase(i, x, y, t)) * this.Q[i] * this.A[i] * amp;
        ox += this.dx[i] * c; oy += this.dy[i] * c;
      }
      x = qx - ox; y = qy - oy;
    }
    let h = 0, nx = 0, ny = 0;
    for (let i = 0; i < n; i++) {
      const p = this._phase(i, x, y, t);
      const A = this.A[i] * amp;
      h += A * Math.sin(p);
      if (out) { const wa = this.k[i] * A * Math.cos(p); nx += this.dx[i] * wa; ny += this.dy[i] * wa; }
    }
    if (out) { out.slopeX = nx; out.slopeY = ny; }
    return h;
  }

  /** Wave coordinate of a planet-local point projected onto the sea sphere. */
  toQ(p, Rs, out) {
    _n.copy(p).normalize().multiplyScalar(Rs);
    out.x = _n.dot(this.T1); out.y = _n.dot(this.T2);
    return out;
  }
}
