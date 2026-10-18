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
import { Geo } from './geo.js';
import { RNG } from '../../core/rng.js';

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

/** Exact height of a lot's building: dry-run the style kit into a scratch builder (once per lot). */
function estimateH(civ, s, lot) {
  if (lot._estH !== undefined) return lot._estH;
  let h = 18;
  try {
    const kit = civ._kit(s.kit);
    const g = new Geo();
    g.begin(new THREE.Matrix4(), 0);
    const ctx = { M: kit.M, rng: new RNG(s.seed ^ 0x51ee), site: s, style: s.kit, level: s.level, kind: s.kind, neonM: kit.M.neon };
    const r = kit.style.build(g, lot, ctx);
    let mx = 0; const X = g.X.a; for (let i = 0; i < g.X.n; i += 2) if (X[i] > mx) mx = X[i];
    h = Math.max(typeof r === 'number' ? r : 0, mx) || 18;
  } catch (_) { /* fall back */ }
  lot._estH = h;
  return h;
}
function guessH(civ, s, lot) { return lot.farH ?? civ._guessH(s, lot); }

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
  // the vehicles track parks a starship ~34 m (and bike/rover 5-10 m) in front of the player, i.e. BEHIND
  // the lens with camyaw=180; if that spot is cluttered by buildings it drifts into the frame. Prefer
  // viewpoints with a flat, open patch behind the camera.
  const parkPenalty = (x, z, fx, fz) => {
    const bx = x - fx * 34, bz = z - fz * 34;
    let pen = 0;
    for (const l of L.lots) { const d = Math.hypot(l.x - bx, l.z - bz) - Math.max(l.w, l.d) / 2; if (d < 10) pen += 1; }
    if (G) { const h = [G.g(bx - 7, bz), G.g(bx + 7, bz), G.g(bx, bz - 7), G.g(bx, bz + 7)]; pen += (Math.max(...h) - Math.min(...h)) / 3; if (!L.water && G.wet(bx, bz)) pen += 2; }
    return pen;
  };
  if (preset === 'plaza') {
    // stand where a main road enters the plaza, on the side opposite the landmark
    const b = roadPoint(pr + 7, (p) => {
      const lx = land ? land.x * 0.45 : 0, lz = land ? land.z * 0.45 : 0;
      const dx = lx - p.x, dz = lz - p.z, dl = Math.hypot(dx, dz) || 1;
      return -Math.cos(Math.atan2(p.z, p.x) - landA) * 1.5 - parkPenalty(p.x, p.z, dx / dl, dz / dl) * 0.6;
    });
    const [x, z] = b ? [b.p.x, b.p.z] : [Math.cos(landA + Math.PI) * (pr + 6), Math.sin(landA + Math.PI) * (pr + 6)];
    const lx = land ? land.x : 0, lz = land ? land.z : 0;
    const gh = G ? G.g(x, z) : hC;
    return res(x, z, lx * 0.45, lz * 0.45, hC + 7, gh + 1.7, { view: 'fp', flat: '0', pitchAdd: 3 });
  }
  if (preset === 'street') {
    // walk every road; score spots by how many buildings line BOTH sides of the view down the street
    // (a street is a canyon of facades, not a path across a meadow), plus the landmark in the view
    let best = null;
    for (const r of L.roads) {
      const len = polyLen(r.pts);
      for (let t = 4; t < len - 4; t += 6) {
        const p = along(r.pts, t);
        const dd = Math.hypot(p.x, p.z);
        if (dd < pr + 12 || dd > R * 0.8) continue;
        if (G && !L.water && G.wet(p.x, p.z)) continue;
        // look along the road, toward the centre
        const sg = p.tx * -p.x + p.tz * -p.z >= 0 ? 1 : -1;
        const fx = p.tx * sg, fz = p.tz * sg;
        let left = 0, right = 0, tall = 0;
        for (const l of L.lots) {
          const dx = l.x - p.x, dz = l.z - p.z;
          const fwd = dx * fx + dz * fz, lat = dx * fz - dz * fx;
          if (fwd < 3 || fwd > 80 || Math.abs(lat) > 12 + fwd * 0.35) continue;
          if (l.type === 'garden' || l.type === 'farm') continue;
          if (lat > 0) right++; else left++;
          if (l.type === 'landmark' || l.type === 'tower') tall++;
        }
        // flat eye line (no looking into a hillside)
        const g0 = G ? G.g(p.x, p.z) : 0, g1 = G ? G.g(p.x + fx * 30, p.z + fz * 30) : 0;
        const sc = Math.min(left, right) * 2 + left + right + tall * 2 - Math.abs(g1 - g0) * 0.25 + (r.type === 'avenue' || r.type === 'spoke' ? 1 : 0) - parkPenalty(p.x, p.z, fx, fz) * 1.2;
        if (!best || sc > best.sc) best = { sc, p, r, fx, fz };
      }
    }
    if (best) {
      const { p, r, fx, fz } = best;
      const off = r.w * 0.25;
      const x = p.x - fz * off, z = p.z + fx * off;
      const gh = G ? G.g(x, z) : hC;
      return res(x, z, x + fx * 60, z + fz * 60, (G ? G.g(x + fx * 60, z + fz * 60) : gh) + 4, gh + 1.7, { view: 'fp', flat: '0', pitchAdd: 2 });
    }
    return frameSite(civ, s, 'plaza');
  }
  if (preset === 'hero') {
    // Composition solver: the landmark is the focal silhouette. Pick a viewpoint whose distance fits the
    // whole landmark in frame (top ~1/6 below the frame edge, horizon on the upper third), whose line of
    // sight to the landmark and plaza is clear of buildings, with nothing tall right next to the lens;
    // then turn the camera so the landmark sits on a rule-of-thirds vertical with the plaza on the other side.
    const Hl = land ? estimateH(civ, s, land) : 18;
    const fx = land ? land.x : 0, fz = land ? land.z : 0;
    const hF = G ? G.g(fx, fz) : hC;
    const camUp = THREE.MathUtils.clamp(Hl * 0.32, 22, 70);
    const vfov = 58 * Math.PI / 180, pitch0 = -9 * Math.PI / 180;
    const topAng = vfov / 2 + pitch0 - 0.1;
    const Dfit = Math.max(pr + 30, (Hl + hF - (hC + camUp)) / Math.tan(topAng));
    const hOf = (l) => (l === land ? Hl : guessH(civ, s, l));
    let best = null;
    for (let k = 0; k < 24; k++) {
      const a = landA + Math.PI + (k / 24 - 0.5) * Math.PI * 1.9;
      for (const dk of [1, 1.25, 1.6]) {
        const D = Dfit * dk;
        const cx = fx + Math.cos(a) * D, cz = fz + Math.sin(a) * D;
        if (Math.hypot(cx, cz) > R * 1.6 + 200) continue;
        const gh = G ? G.g(cx, cz) : hC;
        const camH = Math.max(hC + camUp, gh + 18);
        let pen = 0;
        for (const l of L.lots) {
          const r0 = Math.max(l.w, l.d) * 0.55, lh = hOf(l) + (l.hMax ?? hC);
          // tall things right at the lens fill the frame
          const dc = Math.hypot(l.x - cx, l.z - cz) - r0;
          if (dc < 25 && lh > camH - 12) pen += (25 - dc) / 5 * (lh > camH ? 2 : 1);
          if (l === land) continue;
          // occluders on the sight lines to the landmark (mid-height) and to the plaza centre
          for (const [tx, tz, th] of [[fx, fz, hF + Hl * 0.45], [0, 0, hC + 2]]) {
            for (let i = 1; i < 12; i++) {
              const t = i / 12;
              const px = cx + (tx - cx) * t, pz = cz + (tz - cz) * t, py = camH + (th - camH) * t;
              if (Math.hypot(l.x - px, l.z - pz) < r0 && py < lh) { pen += 1.2; break; }
            }
          }
        }
        // terrain in the way
        const eye = pt(cx, cz, camH);
        pen += blocked(S, s.R, eye, pt(fx, fz, hF + Hl * 0.4), 14) * 0.05;
        // the plaza should be in the same view as the landmark (less than ~22° apart)
        const aF = Math.atan2(fz - cz, fx - cx), aP = Math.atan2(-cz, -cx);
        const sep = Math.abs(Math.atan2(Math.sin(aP - aF), Math.cos(aP - aF)));
        pen += Math.max(0, sep - 0.38) * 6;
        // an open vista behind the landmark (valley, sea, distant ranges), not a cliff wall filling the frame
        if (G) {
          const ux = (fx - cx) / D, uz = (fz - cz) / D;
          for (const dd of [250, 500, 900, 1500]) {
            const bh = G.h(fx + ux * dd, fz + uz * dd);
            pen += Math.max(0, bh - (camH + (D + dd) * 0.09)) / 30;
          }
        }
        const sc = -pen - (dk - 1) * 0.8 + Math.cos(a - landA - Math.PI) * 0.4 - parkPenalty(cx, cz, (fx - cx) / D, (fz - cz) / D) * 0.3;
        if (!best || sc > best.sc) best = { sc, cx, cz, camH, D, aF, aP, gh };
      }
    }
    const { cx, cz, camH, D, aF, aP, gh } = best;
    // rule of thirds: landmark on the vertical third line, plaza toward the other side
    const hfovT = Math.tan(vfov / 2) * 16 / 9;
    const off = Math.atan(hfovT / 3);
    const side = Math.sin(aP - aF) >= 0 ? -1 : 1; // plaza to the left of the landmark → landmark on the right third
    const look = aF + side * off;
    const r = res(cx, cz, cx + Math.cos(look) * D, cz + Math.sin(look) * D, camH + Math.tan(pitch0) * D, camH, { view: 'fly', alt: Math.round(camH - gh) });
    r.pitch = pitch0 * 180 / Math.PI;
    return r;
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
  const D = R * 0.95 + 150;
  let best = null;
  for (let k = 0; k < 12; k++) {
    const a = landA + k / 12 * Math.PI * 2;
    const x = Math.cos(a) * D, z = Math.sin(a) * D;
    const up = dirOf(s, x, z, new THREE.Vector3());
    const gh = S.height(up.x, up.y, up.z);
    // stay under the cloud deck: a low, oblique establishing shot (≈ 90-200 m above the town)
    const altAbs = Math.max(hC + Math.min(D * 0.24, 170) + 25, gh + 40);
    const eye = up.clone().multiplyScalar(s.R + altAbs);
    const bl = blocked(S, s.R, eye, pt(0, 0, hC + 15));
    const sea = S.seaLevel > -1e8 ? S.seaLevel : -Infinity;
    const wetCam = gh < sea ? 0.3 : 0;
    const sc = -bl * 0.05 - (altAbs - gh) * 0.002 + Math.cos(a - landA) * 0.6 - wetCam;
    if (!best || sc > best.sc) best = { sc, x, z, altAbs, gh };
  }
  const r = res(best.x, best.z, 0, 0, hC + 10, best.altAbs, { view: 'fly', alt: Math.round(best.altAbs - best.gh) });
  // keep the skyline anchors (megatowers / landmark) whole: tilt up until the tallest top is inside the frame
  let top = 0, tx = 0, tz = 0;
  for (const l of L.lots) { const h = l.mega || (l === land ? estimateH(civ, s, l) : 0); if (h > top) { top = h; tx = l.x; tz = l.z; } }
  if (top > 0) {
    const dd = Math.max(50, Math.hypot(tx - best.x, tz - best.z));
    const topAng = Math.atan2(hC + top - best.altAbs, dd) * 180 / Math.PI;
    r.pitch = Math.max(r.pitch, topAng - 58 / 2 + 5);
  }
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
  // keep parked props (vehicles track, `props=0` requested) out of settlement framings
  if (!given('props')) params.props = '0';
  civ.stats.civcam = { preset, site: s.id, lat: +f.lat.toFixed(5), lon: +f.lon.toFixed(5), yaw: Math.round(f.yaw), view };
  return f;
}
