// Gerstner wave set shared by the GPU surface and CPU queries (heightAt, buoyancy, swimming).
//
// Waves live in a 2D "wave frame" tangent to the planet at an anchor point: Q(X) = (X·T1, X·T2) for a
// planet-local point X on the sea sphere. T1 points down-wind (prevailing wind at the anchor), so the
// spectrum is wind aligned. Per frame the CPU computes each wave's phase at the camera nadir in float64
// (mod 2π) and the GPU only adds k·(D·q_rel) for the small offset from the nadir → no float32 phase loss
// anywhere on the planet. The anchor moves only when the camera travels far (> ~0.12 rad).
import * as THREE from 'three';
import { RNG } from '../../core/rng.js';

export const MAX_WAVES = 12;
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
    this.count = Math.min(MAX_WAVES, opts.count ?? MAX_WAVES);
    this.g = Math.max(2, body.gravity || 9.81);
    this.liquid = liquid;
    // character: calm lakes (Tarkovsky, low wind) … rolling swell (monsoon oceans)
    const visc = liquid === 'lava' ? 0.22 : liquid === 'acid' ? 0.8 : liquid === 'ice' ? 0 : 1;
    const L0 = THREE.MathUtils.lerp(16, 46, windy) * (liquid === 'lava' ? 1.6 : 1);
    const slope = (liquid === 'lava' ? 0.035 : THREE.MathUtils.lerp(0.05, 0.11, windy)) * (liquid === 'ice' ? 0 : 1);
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
    const n = this.count;
    const qTotal = liquid === 'lava' ? 0.45 : 0.78;
    let lam = L0;
    for (let i = 0; i < n; i++) {
      const t = i / Math.max(1, n - 1);
      const L = lam * rng.range(0.9, 1.1);
      lam *= 0.74;
      const k = TAU / L;
      // direction: wind ± spread growing for shorter waves; a few cross-swells
      const spread = 0.25 + 0.75 * t;
      let ang = rng.range(-spread, spread);
      if (i === 2) ang += 0.55; if (i === 3) ang -= 0.5;
      const s = slope * (1.0 - 0.35 * t) * rng.range(0.8, 1.15);
      const A = s / k;
      this.k[i] = k; this.A[i] = A; this.lambda[i] = L;
      this.dx[i] = Math.cos(ang); this.dy[i] = Math.sin(ang);
      this.w[i] = Math.sqrt(this.g * k) * visc * (liquid === 'lava' ? 0.6 : 1);
      this.Q[i] = qTotal / (k * Math.max(A, 1e-6) * n);
      this.phi0[i] = rng.range(0, TAU);
    }
    // clamp Q·k·A sum ≤ qTotal (no loops) — already by construction; keep Q ≤ 1/(kA)
    for (let i = 0; i < n; i++) this.Q[i] = Math.min(this.Q[i], 1 / (this.k[i] * this.A[i] + 1e-9) * 0.95);
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
