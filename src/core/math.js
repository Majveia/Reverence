// Small math helpers shared across the codebase.
import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => (x - a) / (b - a);
export const remap = (x, a, b, c, d) => c + ((x - a) * (d - c)) / (b - a);
export const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const smootherstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * t * (t * (t * 6 - 15) + 10); };

/** Frame-rate independent exponential smoothing factor. `rate` = 1/seconds-ish. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
export const dampFactor = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Critically damped spring (value, velocity) toward target. Returns new [x, v]. */
export function spring(x, v, target, omega, dt) {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const detInv = 1 / (f + hhoo);
  const detX = f * x + dt * v + hhoo * target;
  const detV = v + hoo * (target - x);
  return [detX * detInv, detV * detInv];
}

/** Angle wrap to [-PI, PI]. */
export const wrapAngle = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
export const dampAngle = (a, b, rate, dt) => a + wrapAngle(b - a) * dampFactor(rate, dt);

/** Lat/lon (degrees) → unit direction. Convention: +Y = north pole, lon 0 on +Z, lon 90 on +X. */
export function latLonToDir(latDeg, lonDeg, out = new THREE.Vector3()) {
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const c = Math.cos(lat);
  return out.set(c * Math.sin(lon), Math.sin(lat), c * Math.cos(lon));
}
export function dirToLatLon(dir) {
  const lat = Math.asin(clamp(dir.y / dir.length(), -1, 1)) / DEG;
  const lon = Math.atan2(dir.x, dir.z) / DEG;
  return { lat, lon };
}

/** Build an orthonormal tangent frame (east, north, up) at a surface direction on a +Y-polar sphere. */
export function tangentFrame(up, east = new THREE.Vector3(), north = new THREE.Vector3()) {
  const u = up.clone().normalize();
  const ref = Math.abs(u.y) > 0.999 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  east.crossVectors(ref, u).normalize();     // east = northPole x up
  north.crossVectors(u, east).normalize();   // north = up x east
  return { up: u, east, north };
}

/** Blackbody color (approx., Tanner Helland fit) for a temperature in Kelvin, returns linear THREE.Color. */
export function blackbody(kelvin, out = new THREE.Color()) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  out.setRGB(clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255, THREE.SRGBColorSpace);
  return out;
}

/** Hex/CSS → linear THREE.Color */
export const color = (c) => new THREE.Color(c);

export function disposeObject(obj) {
  if (!obj) return;
  obj.traverse?.((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
        m.dispose();
      }
    }
  });
  obj.removeFromParent?.();
}
