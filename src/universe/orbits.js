// Keplerian orbital mechanics (system inertial frame: ecliptic = XZ plane, +Y = north).
// All lengths in meters, times in seconds (game time).
import * as THREE from 'three';

/** Game gravitational parameter scale: a star of 1 solar mass. Chosen so an inner
 *  planet at ~2.5e7 m has a ~2 h period (planets drift visibly over a long session). */
export const MU_SUN = 1.19e16;

export function orbitalPeriod(a, mu) { return 2 * Math.PI * Math.sqrt((a * a * a) / mu); }

/** Solve Kepler's equation M = E - e sin E for E (Newton). */
export function solveKepler(M, e) {
  M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 12; i++) {
    const f = E - e * Math.sin(E) - M;
    const d = 1 - e * Math.cos(E);
    const dE = f / d;
    E -= dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

/**
 * Position (and optionally velocity) at time t for orbit elements:
 * { a, e, i, lan (Ω), argp (ω), M0, mu }
 */
export function orbitPosition(el, t, out = new THREE.Vector3(), vel = null) {
  const { a, e = 0, i = 0, lan = 0, argp = 0, M0 = 0, mu } = el;
  const n = Math.sqrt(mu / (a * a * a));
  const M = M0 + n * t;
  const E = solveKepler(M, e);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const sq = Math.sqrt(1 - e * e);
  // perifocal coords (x toward periapsis, y 90° ahead in orbital plane)
  const xp = a * (cosE - e);
  const yp = a * sq * sinE;
  // rotate: argp around z, inclination around x, lan around z → then map (x,y,z)→(x,z,-y) for Y-up
  const cw = Math.cos(argp), sw = Math.sin(argp), ci = Math.cos(i), si = Math.sin(i), cO = Math.cos(lan), sO = Math.sin(lan);
  const x1 = cw * xp - sw * yp, y1 = sw * xp + cw * yp;
  const x2 = x1, y2 = ci * y1, z2 = si * y1;
  const X = cO * x2 - sO * y2, Y = sO * x2 + cO * y2, Z = z2;
  out.set(X, Z, -Y);
  if (vel) {
    const r = a * (1 - e * cosE);
    const vxp = (-Math.sqrt(mu * a) / r) * sinE;
    const vyp = (Math.sqrt(mu * a) / r) * sq * cosE;
    const vx1 = cw * vxp - sw * vyp, vy1 = sw * vxp + cw * vyp;
    const vy2 = ci * vy1, vz2 = si * vy1;
    const VX = cO * vx1 - sO * vy2, VY = sO * vx1 + cO * vy2;
    vel.set(VX, vz2, -VY);
  }
  return out;
}

/** Sample an orbit path as a polyline (for orbit lines in the map). */
export function orbitPath(el, segments = 256) {
  const pts = [];
  const period = orbitalPeriod(el.a, el.mu);
  for (let k = 0; k <= segments; k++) {
    // sample uniformly in eccentric anomaly for smoother ellipses
    const E = (k / segments) * Math.PI * 2;
    const M = E - (el.e || 0) * Math.sin(E);
    const n = Math.sqrt(el.mu / (el.a ** 3));
    const t = (M - (el.M0 || 0)) / n;
    pts.push(orbitPosition(el, t - Math.floor(t / period) * period, new THREE.Vector3()));
  }
  return pts;
}
