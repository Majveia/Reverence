// Keplerian orbits.  Pure functions, doubles throughout.
// orbit = { a, e, inc, node, peri, M0, period }   angles in radians, a in metres, period in seconds

/** Solve Kepler's equation M = E − e·sin E (Newton–Raphson). */
export function eccentricAnomaly(M, e) {
  M = M % (2 * Math.PI); if (M < 0) M += 2 * Math.PI;
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 12; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d; if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

/** Position on the orbit at time t (seconds) relative to the parent, written to out[0..2].  Y is "north". */
export function orbitPosition(o, t, out = [0, 0, 0]) {
  const M = (o.M0 || 0) + (2 * Math.PI * t) / o.period;
  const e = o.e || 0;
  const E = eccentricAnomaly(M, e);
  const xp = o.a * (Math.cos(E) - e);                 // in-plane, periapsis along +x
  const zp = o.a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(o.peri || 0), sw = Math.sin(o.peri || 0);
  const cO = Math.cos(o.node || 0), sO = Math.sin(o.node || 0);
  const ci = Math.cos(o.inc || 0), si = Math.sin(o.inc || 0);
  const x1 = xp * cw - zp * sw, z1 = xp * sw + zp * cw;  // rotate by argument of periapsis
  const y2 = z1 * si, z2 = z1 * ci;                     // incline about x
  out[0] = x1 * cO - z2 * sO;                           // rotate by ascending node about y
  out[1] = y2;
  out[2] = x1 * sO + z2 * cO;
  return out;
}

/** Sample the full ellipse as a Float32Array of xyz triples (for drawing orbit lines). */
export function orbitPath(o, segments = 256) {
  const pts = new Float32Array((segments + 1) * 3), tmp = [0, 0, 0];
  const saveM0 = o.M0;
  for (let i = 0; i <= segments; i++) {
    // uniform in eccentric anomaly reads better than uniform in time
    const E = (i / segments) * 2 * Math.PI, e = o.e || 0;
    const M = E - e * Math.sin(E);
    orbitPosition({ ...o, M0: M, period: 1 }, 0, tmp);
    pts[i * 3] = tmp[0]; pts[i * 3 + 1] = tmp[1]; pts[i * 3 + 2] = tmp[2];
  }
  o.M0 = saveM0;
  return pts;
}

/** Period from semi-major axis and gravitational parameter μ. */
export const keplerPeriod = (a, mu) => 2 * Math.PI * Math.sqrt((a * a * a) / mu);
