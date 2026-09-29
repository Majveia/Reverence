// Capture framing presets for settlements: `&civcam=<preset>[&civsite=<id>]`.
//
// Settlement positions depend on the terrain generator and the predicted default spawn, so hard-coded
// lat/lon capture URLs go stale whenever another track changes the terrain. `civcam` computes the camera
// from the settlement's own layout (plaza, landmark, roads) at create time and writes the player's spawn
// params (lat, lon, yaw, camyaw, pitch, alt, view, flat) BEFORE the player subsystem (order 50) reads
// them — so a URL like `/?mode=system&star=6&planet=1&civcam=plaza&tod=0.8` always frames the plaza.
// Explicit URL params win (`view`, `pitch`, `alt`, `camyaw` given in the URL are kept).
//
// Presets
//   plaza   eye level on the plaza rim where a main road enters, looking across the centrepiece to the landmark
//   street  eye level on a main road ~45 % out, looking down the street toward the centre
//   hero    low flight (≈28 m) over the plaza rim, looking over the rooftops at the landmark
//   aerial  establishing shot from outside the town (clear line of sight), pitched down onto the centre
//   top     110 m straight above the centre (the round-1 "night, above the capital" case)
//   edge    third-person on the road just outside the town, looking in
import * as THREE from 'three';
import { dirToLatLon, tangentFrame } from '../../core/math.js';
import { offsetDir } from './planner.js';
import { polyLen, along } from './layout.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _e = new THREE.Vector3(), _n = new THREE.Vector3();

/** yaw (deg, 0 = north, 90 = east, player convention) of a planet-local direction at a surface point. */
function yawAt(up, dir) {
  tangentFrame(up, _e, _n);
  return Math.atan2(dir.dot(_e), dir.dot(_n)) * 180 / Math.PI;
}

/** Site-plane point (x east, z north, m) → unit direction. */
function dirOf(s, x, z, out = new THREE.Vector3()) { return offsetDir(s, x, z, out); }

/** Terrain clearance of the straight segment between two planet-local points (m of rock in the way). */
function blocked(S, R0, eye, tgt, steps = 20) {
  let b = 0;
  for (let i = 1; i < steps; i++) {
    _a.lerpVectors(eye, tgt, i / steps);
    const len = _a.length();
    _b.copy(_a).divideScalar(len);
    const h = S.heightLod ? S.heightLod(_b.x, _b.y, _b.z, 8) : S.height(_b.x, _b.y, _b.z);
    const over = R0 + h - len;
    if (over > 0) b += over;
  }
  return b;
}

/**
 * Compute the camera for a preset. Returns {lat, lon, yaw, pitch, alt?, view} (degrees / meters) where
 * `yaw` is the LOOK direction; the caller converts it to player yaw + camyaw.
 */
export function frameSite(civ, s, preset) {
  const L = civ._layout(s);
  const G = L.ground;
  const S = civ.S;
  const R = s.radius, pr = L.plaza?.r ?? 15;
  const hC = L.plaza?.h ?? s.h0;
  const land = L.lots.find((l) => l.type === 'landmark');
  const landA = land ? Math.atan2(land.z, land.x) : s.heading + Math.PI;
  const main = L.roads.filter((r) => r.type === 'spoke' || r.type === 'avenue');
  const roads = main.length ? main : L.roads;
  const pt = (x, z, h) => dirOf(s, x, z, new THREE.Vector3()).multiplyScalar(s.R + h);
  const res = (x, z, lookX, lookZ, lookH, eyeH, extra = {}) => {
    const up = dirOf(s, x, z, new THREE.Vector3());
    const eye = up.clone().multiplyScalar(s.R + eyeH);
    const tgt = pt(lookX, lookZ, lookH);
    const d = tgt.clone().sub(eye);
    const horiz = d.clone().addScaledVector(up, -d.dot(up));
    const yaw = yawAt(up, horiz.normalize());
    const pitch = Math.atan2(d.dot(up), Math.max(1, d.clone().addScaledVector(up, -d.dot(up)).length())) * 180 / Math.PI;
    const ll = dirToLatLon(up);
    return { lat: ll.lat, lon: ll.lon, yaw, pitch, ...extra };
  };
  // the point where a road leaves the plaza (search each main road for the sample nearest pr + off)
  const roadPoint = (distWanted, pickScore) => {
    let best = null;
    for (const r of roads) {
      const len = polyLen(r.pts);
      for (let t = 0; t <= len; t += 2) {
        const p = along(r.pts, t);
        const dd = Math.hypot(p.x, p.z);
        if (Math.abs(dd - distWanted) > 5) continue;
        if (G && G.wet(p.x, p.z) && !L.water) continue;
        const sc = pickScore(p, r);
        if (!best || sc > best.sc) best = { p, r, sc };
      }
    }
    return best;
  };
  const sideOk = (x, z) => !(G && !L.water && G.wet(x, z));
  if (preset === 'plaza') {
    // stand where a main road enters the plaza, on the side opposite the landmark
    const b = roadPoint(pr + 7, (p) => -Math.cos(Math.atan2(p.z, p.x) - landA));
    const [x, z] = b ? [b.p.x, b.p.z] : [Math.cos(landA + Math.PI) * (pr + 6), Math.sin(landA + Math.PI) * (pr + 6)];
    const lx = land ? land.x : 0, lz = land ? land.z : 0;
    const gh = G ? G.g(x, z) : hC;
    return res(x, z, lx * 0.45, lz * 0.45, hC + 7, gh + 1.7, { view: 'fp', flat: '0', pitchAdd: 3 });
  }
  if (preset === 'street') {
    // a main road ~45 % out, looking back toward the centre (houses on both sides, landmark at the end)
    const b = roadPoint(Math.max(pr + 25, R * 0.45), (p, r) => r.w + (r.type === 'avenue' ? 2 : 0) - Math.abs(Math.cos(Math.atan2(p.z, p.x) - landA - Math.PI)) * 0.5);
    if (b) {
      const off = b.r.w * 0.22;
      const x = b.p.x - b.p.tz * off, z = b.p.z + b.p.tx * off;
      const gh = G ? G.g(x, z) : hC;
      return res(x, z, 0, 0, hC + 6, gh + 1.7, { view: 'fp', flat: '0', pitchAdd: 2 });
    }
    return frameSite(civ, s, 'plaza');
  }
  if (preset === 'hero') {
    const a = landA + Math.PI + 0.35;
    const x = Math.cos(a) * (pr + 18), z = Math.sin(a) * (pr + 18);
    const gh = G ? G.g(x, z) : hC;
    const lx = land ? land.x : 0, lz = land ? land.z : 0;
    return res(x, z, lx * 0.5, lz * 0.5, hC + 4, gh + 28, { view: 'fly', alt: 28 });
  }
  if (preset === 'top') {
    const lx = land ? land.x : 20, lz = land ? land.z : 0;
    const r = res(0, 0, lx, lz, hC, hC + 110, { view: 'fly', alt: 110 });
    r.pitch = -38;
    return r;
  }
  if (preset === 'edge') {
    const b = roadPoint(R * 1.02, (p) => -Math.cos(Math.atan2(p.z, p.x) - landA)) || roadPoint(R * 0.9, () => 0);
    const [x, z] = b ? [b.p.x, b.p.z] : [Math.cos(landA + Math.PI) * R, Math.sin(landA + Math.PI) * R];
    const gh = G ? G.g(x, z) : hC;
    return res(x, z, 0, 0, hC + 12, gh + 1.7, { view: 'surface', flat: '0' });
  }
  // aerial: 8 azimuths around the town; prefer an unobstructed view, lower ground under the camera, and
  // the side facing the landmark (so it stands in front of the skyline)
  const D = R * 1.15 + 140;
  let best = null;
  for (let k = 0; k < 12; k++) {
    const a = landA + k / 12 * Math.PI * 2;
    const x = Math.cos(a) * D, z = Math.sin(a) * D;
    const up = dirOf(s, x, z, new THREE.Vector3());
    const gh = S.height(up.x, up.y, up.z);
    const altAbs = Math.max(hC + D * 0.32 + 30, gh + 45);
    const eye = up.clone().multiplyScalar(s.R + altAbs);
    const bl = blocked(S, s.R, eye, pt(0, 0, hC + 15));
    const sea = S.seaLevel > -1e8 ? S.seaLevel : -Infinity;
    const wetCam = gh < sea ? 0.3 : 0;
    const sc = -bl * 0.05 - (altAbs - gh) * 0.002 + Math.cos(a - landA) * 0.6 - wetCam;
    if (!best || sc > best.sc) best = { sc, x, z, altAbs, gh };
  }
  const r = res(best.x, best.z, 0, 0, hC + 10, best.altAbs, { view: 'fly', alt: Math.round(best.altAbs - best.gh) });
  return r;
}

/**
 * Apply `civcam` to the shared world params before the player spawns. Explicit URL params win.
 */
export function applyCivCam(civ, params) {
  const preset = String(params.civcam || '');
  if (!preset || !civ.sites.length) return null;
  const id = params.civsite !== undefined ? +params.civsite : 0;
  const s = civ.sites.find((q) => q.id === id) || civ.sites[0];
  const f = frameSite(civ, s, preset);
  if (!f) return null;
  const given = (k) => params[k] !== undefined && params[k] !== null && params[k] !== '';
  params.lat = f.lat.toFixed(5);
  params.lon = f.lon.toFixed(5);
  if (!given('view')) params.view = f.view;
  const view = params.view;
  // the vehicles track parks the bike/rover in FRONT of the player: face away and turn the camera 180°
  // (camyaw) so they end up behind the lens and the street stays clear
  const cy = given('camyaw') ? +params.camyaw : 180;
  params.yaw = ((f.yaw + cy) % 360 + 360) % 360;
  params.camyaw = cy;
  if (!given('pitch')) params.pitch = Math.max(-60, Math.min(20, f.pitch + (f.pitchAdd || 0))).toFixed(1);
  if (f.alt !== undefined && !given('alt') && (view === 'fly')) params.alt = f.alt;
  if (f.flat && !given('flat')) params.flat = f.flat;
  civ.stats.civcam = { preset, site: s.id, lat: +f.lat.toFixed(5), lon: +f.lon.toFixed(5), yaw: Math.round(f.yaw), view };
  return f;
}
