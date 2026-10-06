// AtmosphereModel — CPU side of the physically based atmosphere (OWNED BY THE ATMOSPHERE TRACK).
//
// Derives Rayleigh / Mie / ozone coefficients for a body from its data (body.atmosphere, body.art):
//   • scale heights are proportional to the (exaggerated) atmosphere height,
//   • vertical optical depths are Earth-like × density (a little thicker to compensate for the
//     small planet radius, which shortens horizon air-mass → keeps sunsets red),
//   • the Rayleigh spectrum is calibrated so the midday zenith sky matches the art-directed tint
//     hue (palette.sky) — alien tints produce physically consistent alien sunsets (orange sky →
//     bluish sunset, like Mars),
//   • pale / desaturated tints add Mie haze, dusty presets add tinted absorbing dust.
// Also provides a CPU transmittance table (same parameterization as the GPU LUT) used for the sun
// light color, and a small CPU sky integrator for hemisphere/ambient irradiance.
import * as THREE from 'three';

const EARTH_RAY = [5.802e-6, 13.558e-6, 33.1e-6];   // 1/m (H = 8 km)
const EARTH_OZONE = [0.650e-6, 1.881e-6, 0.085e-6]; // 1/m (tent, 15 km effective)
export const SUN_ILLUMINANCE = 6.0;                  // top-of-atmosphere sun illuminance (scene units)

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  return { h, s: mx > 0 ? d / mx : 0, v: mx };
}

export class AtmosphereModel {
  constructor(body) {
    this.body = body;
    const A = body.atmosphere || {};
    const art = body.art || { palette: {}, weather: {} };
    const pal = art.palette || {};
    const wx = art.weather || {};
    this.present = !!A.present && (A.density ?? 0) > 0.05;
    this.density = A.density ?? 0;
    const R = body.radius;
    this.Rb = R;
    const H = Math.max(A.height || R * 0.12, 2000);
    this.Rt = R + H;
    this.height = H;

    // --- scale heights (fractions of the atmosphere thickness). The worlds are miniature (R ≈ 30–110 km,
    // relief up to 7 km), so the air is "taller" relative to the shell than Earth's (8 km / 100 km):
    // mountains stay inside the air and the density fades smoothly to zero at the top (see medium()).
    this.HR = H * 0.36;
    this.HM = this.HR * 0.28;   // aerosols hug the ground (Earth ≈ 0.15): pale horizon band, deep zenith
    this.ozoneCenter = H * 0.55;
    this.ozoneHalfWidth = H * 0.3;
    this.topFade0 = H * 0.62;
    // Sun-path reddening: small planets have a short horizon air mass (≈ sqrt(πR/2H) ≈ 5 vs Earth's 38),
    // which would give pale sunsets. Low-sun transmittance is raised to this power (GPU + CPU) so the
    // light reaching the air and the ground turns gold → orange → red as on Earth, without extra haze.
    this.sunsetK = 1.9;
    this.skyGain = 2.0;   // (reduced below for moody / dark-tinted worlds)
    this.H = H;

    // --- art-directed sky tint (linear)
    const tint = new THREE.Color(pal.sky || '#7ab8ff');
    const hsv = rgbToHsv(tint.r, tint.g, tint.b);
    this.tint = tint;
    this.tintHSV = hsv;
    const d = this.present ? this.density : 0;

    // Rayleigh: vertical optical depth = Earth × kR  (kR > 1 compensates the small planet)
    const kR = 1.3 * clamp(d, 0, 1.8);
    this.rayleigh = new THREE.Vector3(...EARTH_RAY.map((b) => b * 8000 * kR / this.HR));

    // Mie (aerosols / haze / dust)
    const pale = clamp(1 - hsv.s, 0, 1);            // desaturated tint → hazier sky
    const dust = wx.dust ?? A.haze ?? 0;
    const fog = wx.fog ?? 0;
    const tauM = 0.011 * (A.mie ?? 1) * clamp(d, 0, 1.8) * (1 + pale * 0.8 + dust * 2.5 + fog * 0.8);
    this.fog = fog; this.dust = dust;
    // aerial perspective distance scale (UE-style art control): the per-meter air of these small worlds is
    // denser than Earth's for the same sky color; near the ground geometry sees a lighter veil, blending to
    // fully physical from altitude/space. Foggy/dusty presets get more veil.
    this.apScale = clamp(0.4 + fog * 0.35 + dust * 0.3, 0.25, 0.85);
    this.mieG = clamp((A.mieG ?? 0.8) + 0.04, 0.75, 0.9);
    // dust absorbs blue: tint the aerosol albedo toward the (warm) sky color when dusty
    const warm = clamp((tint.r - tint.b) / Math.max(tint.r, 1e-3), 0, 1);
    const dustiness = clamp(dust * 1.3 + warm * 0.5, 0, 1);
    const albedo = new THREE.Vector3(0.92, 0.92, 0.92);
    if (dustiness > 0) {
      const t = new THREE.Vector3(tint.r, tint.g, tint.b);
      const mx = Math.max(t.x, t.y, t.z, 1e-3);
      t.divideScalar(mx);
      albedo.lerp(new THREE.Vector3(0.95 * Math.pow(t.x, 0.35), 0.9 * Math.pow(t.y, 0.45), 0.85 * Math.pow(t.z, 0.6)), dustiness);
    }
    // dark tints (smog / moody worlds) → absorbing aerosols, thicker smog, dimmer sky
    this.moody = clamp((0.45 - hsv.v) / 0.35, 0, 1) * (d > 0 ? 1 : 0);
    if (this.moody > 0) albedo.multiplyScalar(1 - this.moody * 0.4);
    const betaM = tauM * (1 + (this.moody || 0) * 2.5) / this.HM;
    this.mieExt = new THREE.Vector3(betaM, betaM, betaM);
    this.mieScat = new THREE.Vector3(betaM * albedo.x, betaM * albedo.y, betaM * albedo.z);

    // Ozone (drives the blue hour); scaled like the Rayleigh layer
    const kO = 0.95 * clamp(d, 0, 1.8);
    this.ozone = new THREE.Vector3(...EARTH_OZONE.map((b) => b * 15000 * kO / (this.ozoneHalfWidth)));

    this.skyGain *= 1 - this.moody * 0.35;
    this.apScale = Math.min(0.9, (this.apScale ?? 0.4) + this.moody * 0.25);
    // lava worlds: keep the air near the glowing surface clear enough to see the lava
    this.lava = body.ocean?.present && body.ocean?.liquid === 'lava';
    if (this.lava) this.apScale = Math.min(this.apScale, 0.42);

    // Ground albedo (average of the world palette, ocean-weighted) for multiple scattering
    const land = new THREE.Color(0, 0, 0);
    const cols = [pal.grass, pal.grass2, pal.rock, pal.sand].filter(Boolean);
    for (const c of cols) land.add(new THREE.Color(c));
    if (cols.length) land.multiplyScalar(0.85 / cols.length); else land.setRGB(0.2, 0.2, 0.2);
    const oceanFrac = body.terrain?.oceanFraction ?? 0;
    const water = new THREE.Color(0.04, 0.05, 0.06);
    this.groundAlbedo = land.clone().lerp(water, oceanFrac);

    // Sun
    this.sunIlluminance = SUN_ILLUMINANCE;

    // --- CPU transmittance table + calibration of the Rayleigh hue toward the tint
    this.TW = 64; this.TH = 32;
    this.table = new Float32Array(this.TW * this.TH * 3);
    this._buildTable();
    if (this.present) this._calibrate();
    this._tmp = new THREE.Vector3();
  }

  // ------------------------------------------------------------ medium
  medium(h, outS, outE) {
    h = Math.max(h, 0);
    const f = 1 - smooth(this.topFade0, this.H, h);
    const dR = Math.exp(-h / this.HR) * f, dM = Math.exp(-h / this.HM) * f;
    const dO = Math.max(0, 1 - Math.abs(h - this.ozoneCenter) / this.ozoneHalfWidth);
    const R = this.rayleigh, M = this.mieScat, ME = this.mieExt, O = this.ozone;
    outS[0] = R.x * dR; outS[1] = R.y * dR; outS[2] = R.z * dR;
    outS[3] = M.x * dM; outS[4] = M.y * dM; outS[5] = M.z * dM;
    outE[0] = R.x * dR + ME.x * dM + O.x * dO;
    outE[1] = R.y * dR + ME.y * dM + O.y * dO;
    outE[2] = R.z * dR + ME.z * dM + O.z * dO;
  }

  // Optical depth from radius r along zenith cosine mu to the top of the atmosphere (numerical).
  _opticalDepth(r, mu, out, steps = 40) {
    const Rt = this.Rt;
    const disc = r * r * (mu * mu - 1) + Rt * Rt;
    const dist = Math.max(0, -r * mu + Math.sqrt(Math.max(disc, 0)));
    const dt = dist / steps;
    out[0] = out[1] = out[2] = 0;
    const s = [0, 0, 0, 0, 0, 0], e = [0, 0, 0];
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * dt;
      const rr = Math.sqrt(r * r + t * t + 2 * r * mu * t);
      this.medium(rr - this.Rb, s, e);
      out[0] += e[0] * dt; out[1] += e[1] * dt; out[2] += e[2] * dt;
    }
    return out;
  }

  _buildTable() {
    const { TW, TH, Rb, Rt } = this;
    const Hh = Math.sqrt(Rt * Rt - Rb * Rb);
    const od = [0, 0, 0];
    for (let j = 0; j < TH; j++) {
      const xR = j / (TH - 1);
      const rho = Hh * xR;
      const r = Math.sqrt(rho * rho + Rb * Rb);
      for (let i = 0; i < TW; i++) {
        const xMu = i / (TW - 1);
        const dMin = Rt - r, dMax = rho + Hh;
        const dd = dMin + xMu * (dMax - dMin);
        const mu = dd === 0 ? 1 : clamp((Hh * Hh - rho * rho - dd * dd) / (2 * r * dd), -1, 1);
        this._opticalDepth(r, mu, od, 48);
        const k = (j * TW + i) * 3, K = 1;
        this.table[k] = Math.exp(-od[0] * K); this.table[k + 1] = Math.exp(-od[1] * K); this.table[k + 2] = Math.exp(-od[2] * K);
      }
    }
  }

  /** Transmittance from radius r toward zenith cosine mu to space (ignores ground). out: [r,g,b] */
  transmittance(r, mu, out = [1, 1, 1]) {
    const { TW, TH, Rb, Rt } = this;
    r = clamp(r, Rb + 0.5, Rt);
    const Hh = Math.sqrt(Rt * Rt - Rb * Rb);
    const rho = Math.sqrt(Math.max(0, r * r - Rb * Rb));
    const disc = r * r * (mu * mu - 1) + Rt * Rt;
    const dd = Math.max(0, -r * mu + Math.sqrt(Math.max(disc, 0)));
    const dMin = Rt - r, dMax = rho + Hh;
    const xMu = clamp((dd - dMin) / Math.max(dMax - dMin, 1e-3), 0, 1);
    const xR = clamp(rho / Hh, 0, 1);
    const fx = xMu * (TW - 1), fy = xR * (TH - 1);
    const x0 = Math.min(TW - 2, Math.floor(fx)), y0 = Math.min(TH - 2, Math.floor(fy));
    const tx = fx - x0, ty = fy - y0;
    const T = this.table;
    for (let c = 0; c < 3; c++) {
      const a = T[(y0 * TW + x0) * 3 + c], b = T[(y0 * TW + x0 + 1) * 3 + c];
      const cc = T[((y0 + 1) * TW + x0) * 3 + c], dv = T[((y0 + 1) * TW + x0 + 1) * 3 + c];
      out[c] = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + dv * tx) * ty;
    }
    return out;
  }

  /** Sun transmittance incl. soft planet shadow (angular radius a). */
  sunTransmittance(r, muS, angR = 0.005, out = [1, 1, 1]) {
    r = Math.max(r, this.Rb + 0.5);
    const sinH = this.Rb / r;
    const cosH = -Math.sqrt(Math.max(0, 1 - sinH * sinH));
    const a = Math.max(angR, 0.004);
    const vis = smooth(-a, a, (muS - cosH) / Math.max(sinH, 1e-3));
    this.transmittance(r, muS, out);
    const K = (this.sunsetK ?? 1) + (1 - (this.sunsetK ?? 1)) * smooth(0, 0.2, muS);
    out[0] = Math.pow(out[0], K) * vis; out[1] = Math.pow(out[1], K) * vis; out[2] = Math.pow(out[2], K) * vis;
    return out;
  }

  /**
   * Single-scattering sky radiance (sun illuminance = 1) for a view direction given by its zenith
   * cosine muV and the cosine of the angle to the sun (nu), at radius r, sun zenith cosine muS.
   * A multiple-scattering factor approximates higher orders. out: [r,g,b]
   */
  skyRadiance(r, muV, muS, nu, out = [0, 0, 0], steps = 16, mieScale = 1) {
    const Rb = this.Rb, Rt = this.Rt;
    r = Math.max(r, Rb + 0.5);
    // distance to top or ground
    const discG = r * r * (muV * muV - 1) + Rb * Rb;
    let tMax;
    if (muV < 0 && discG >= 0) tMax = -r * muV - Math.sqrt(discG);
    else { const disc = r * r * (muV * muV - 1) + Rt * Rt; tMax = Math.max(0, -r * muV + Math.sqrt(Math.max(disc, 0))); }
    out[0] = out[1] = out[2] = 0;
    if (tMax <= 0) return out;
    const dt = tMax / steps;
    const s = [0, 0, 0, 0, 0, 0], e = [0, 0, 0], Ts = [0, 0, 0];
    const Tv = [1, 1, 1];
    const pR = 3 / (16 * Math.PI) * (1 + nu * nu);
    const g = this.mieG, g2 = g * g;
    const pM = 3 / (8 * Math.PI) * (1 - g2) / (2 + g2) * (1 + nu * nu) / Math.pow(Math.max(1 + g2 - 2 * g * nu, 1e-4), 1.5);
    const sinV = Math.sqrt(Math.max(0, 1 - muV * muV));
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * dt;
      // position in a 2D frame: (x along horizontal of view, y up)
      const px = t * sinV, py = r + t * muV;
      const rr = Math.sqrt(px * px + py * py);
      // sun zenith cosine at the sample: rotate sun dir into the local frame (approximation using
      // the angle travelled along the great circle in the view azimuth plane)
      const ang = Math.atan2(px, py);
      // component of the sun direction in the view azimuth plane
      const sunH = Math.sqrt(Math.max(0, 1 - muS * muS));
      const cosAz = sinV > 1e-4 ? clamp((nu - muV * muS) / (sinV * sunH + 1e-6), -1, 1) : 0;
      const muSs = muS * Math.cos(ang) + sunH * cosAz * Math.sin(ang);
      this.medium(rr - Rb, s, e);
      this.sunTransmittance(rr, muSs, 0.005, Ts);
      for (let c = 0; c < 3; c++) {
        const Tseg = Math.exp(-e[c] * dt);
        const integ = Tv[c] * (1 - Tseg) / Math.max(e[c], 1e-12);
        out[c] += integ * (s[c] * pR + s[c + 3] * pM * mieScale) * Ts[c] + integ * (s[c] + s[c + 3] * mieScale) * 0.08 * Ts[c] * Math.max(0.15, muSs + 0.25);
        Tv[c] *= Tseg;
      }
    }
    const gain = this.skyGain ?? 1;
    out[0] *= gain; out[1] *= gain; out[2] *= gain;
    return out;
  }

  _calibrate() {
    // target chromaticity: the tint with Earth-like saturation (paleness goes into Mie instead)
    const t = this.tint, hsv = this.tintHSV;
    const tc = new THREE.Color().setHSL(0, 0, 0);
    // rebuild the tint with saturation >= 0.55 (in HSV space) at full value
    const moodyK = clamp((0.45 - hsv.v) / 0.35, 0, 1);
    const h = hsv.h, s = Math.max(hsv.s, 0.8) * (1 - 0.55 * moodyK);
    const hsvToRgb = (hh, ss, vv) => {
      const i = Math.floor(hh * 6), f = hh * 6 - i, p = vv * (1 - ss), q = vv * (1 - f * ss), u = vv * (1 - (1 - f) * ss);
      return [[vv, u, p], [q, vv, p], [p, vv, u], [p, q, vv], [u, p, vv], [vv, p, q]][((i % 6) + 6) % 6];
    };
    // HSV above is computed on linear values; do the same here (linear space)
    const tgt = hsvToRgb(h, s, 1);
    tc.setRGB(tgt[0], tgt[1], tgt[2]);
    const tsum = tc.r + tc.g + tc.b;
    const target = [tc.r / tsum, tc.g / tsum, tc.b / tsum];
    // how far to trust the tint: pure blue-ish hues stay near Earth physics
    const out = [0, 0, 0];
    const earth = this.rayleigh.clone();
    for (let it = 0; it < 7; it++) {
      // zenith sky, sun at ~50° elevation, from sea level
      this.skyRadiance(this.Rb + 50, 1, 0.77, 0.77, out, 14, 0);
      const sum = out[0] + out[1] + out[2];
      if (!(sum > 0)) break;
      const cur = [out[0] / sum, out[1] / sum, out[2] / sum];
      const f = [0, 1, 2].map((c) => Math.pow(target[c] / Math.max(cur[c], 1e-4), 0.8));
      // keep the green channel (≈ luminance) optical depth constant
      const fg = f[1];
      this.rayleigh.x *= f[0] / fg; this.rayleigh.z *= f[2] / fg;
      // clamp relative to Earth's spectrum
      this.rayleigh.x = clamp(this.rayleigh.x, earth.x * 0.3, earth.x * 6);
      this.rayleigh.z = clamp(this.rayleigh.z, earth.z * 0.2, earth.z * 2.2);
      this._buildTableFast();
    }
    this._buildTable();
    void t;
  }

  _buildTableFast() {
    // lower-precision rebuild during calibration
    const { TW, TH, Rb, Rt } = this;
    const Hh = Math.sqrt(Rt * Rt - Rb * Rb);
    const od = [0, 0, 0];
    for (let j = 0; j < TH; j += 1) {
      const xR = j / (TH - 1);
      const rho = Hh * xR;
      const r = Math.sqrt(rho * rho + Rb * Rb);
      for (let i = 0; i < TW; i++) {
        const xMu = i / (TW - 1);
        const dMin = Rt - r, dMax = rho + Hh;
        const dd = dMin + xMu * (dMax - dMin);
        const mu = dd === 0 ? 1 : clamp((Hh * Hh - rho * rho - dd * dd) / (2 * r * dd), -1, 1);
        this._opticalDepth(r, mu, od, 16);
        const k = (j * TW + i) * 3, K = 1;
        this.table[k] = Math.exp(-od[0] * K); this.table[k + 1] = Math.exp(-od[1] * K); this.table[k + 2] = Math.exp(-od[2] * K);
      }
    }
  }

  /**
   * Hemispherical irradiance at radius r for a surface facing up (sky) and the average radiance
   * of the lower hemisphere (ground bounce), sun illuminance = 1. Cheap: 3 rings × 6 azimuths.
   */
  skyIrradiance(r, muS, outSky, outGround) {
    outSky[0] = outSky[1] = outSky[2] = 0;
    const L = [0, 0, 0];
    const sunH = Math.sqrt(Math.max(0, 1 - muS * muS));
    const rings = [0.92, 0.6, 0.22];
    const wts = [0.25, 0.42, 0.33];
    let wsum = 0;
    for (let k = 0; k < rings.length; k++) {
      const muV = rings[k];
      const sinV = Math.sqrt(1 - muV * muV);
      for (let a = 0; a < 6; a++) {
        const az = (a + 0.5) / 6 * Math.PI * 2;
        const nu = muV * muS + sinV * sunH * Math.cos(az);
        this.skyRadiance(r, muV, muS, nu, L, 10);
        const w = wts[k] / 6;
        outSky[0] += L[0] * w; outSky[1] += L[1] * w; outSky[2] += L[2] * w;
        wsum += w;
      }
    }
    // irradiance = π × average (cosine-weighted) radiance
    for (let c = 0; c < 3; c++) outSky[c] *= Math.PI / wsum;
    // ground: albedo × (direct sun + sky) / π  (radiance of a lambertian ground)
    const Ts = [0, 0, 0];
    this.sunTransmittance(r, muS, 0.005, Ts);
    const al = this.groundAlbedo;
    const cosS = Math.max(muS, 0);
    outGround[0] = al.r * (Ts[0] * cosS + outSky[0]) / Math.PI;
    outGround[1] = al.g * (Ts[1] * cosS + outSky[1]) / Math.PI;
    outGround[2] = al.b * (Ts[2] * cosS + outSky[2]) / Math.PI;
  }

  /** Uniform values for the rv_atmo chunk. */
  uniforms() {
    return {
      uAtmoRb: { value: this.Rb },
      uAtmoRt: { value: this.Rt },
      uRayScat: { value: this.rayleigh.clone() },
      uRayInvH: { value: 1 / this.HR },
      uMieScat: { value: this.mieScat.clone() },
      uMieExt: { value: this.mieExt.clone() },
      uMieInvH: { value: 1 / this.HM },
      uMieG: { value: this.mieG },
      uOzoneAbs: { value: this.ozone.clone() },
      uOzoneCenter: { value: this.ozoneCenter },
      uOzoneInvHalfW: { value: 1 / this.ozoneHalfWidth },
      uTopFade: { value: new THREE.Vector2(this.topFade0, this.H) },
      uSunsetK: { value: this.sunsetK },
      uSkyGain: { value: this.skyGain },
      // the art sky gain only partly applies to the Mie (haze / sun aureole) term: brighter blue sky without
      // a blown-out glare disc around the sun and a milky veil over backlit terrain
      uMieGain: { value: 1 + (this.skyGain - 1) * 0.6 },
      uSkyViewGain: { value: 1 },
      uGroundAlbedo: { value: new THREE.Vector3(this.groundAlbedo.r, this.groundAlbedo.g, this.groundAlbedo.b) },
      uSunAngR: { value: 0.005 },
      uTransLUT: { value: null },
      uMsLUT: { value: null },
    };
  }
}
