// Settlement site selection (deterministic from body.civ.placeSeed).
//  • capital: placed 0.7–2 km ahead of the DEFAULT player spawn (lat 12, lon 28 → nearest land, yaw 30°),
//    on the flattest dry ground with a clear line of sight, so it is the first thing you see.
//  • others: flat, dry, temperate land, preferring coasts/rivers; a ring of neighbours 3–15 km from the
//    capital (visible on the horizon / from the air), the rest spread around the globe.
import * as THREE from 'three';
import { RNG, hashCombine } from '../../core/rng.js';
import { latLonToDir, tangentFrame, clamp } from '../../core/math.js';

const _d = new THREE.Vector3();

export const KIND_RADIUS = { ruin: [90, 170], monument: [40, 60], village: [110, 160], town: [210, 290], city: [360, 460], metropolis: [560, 700], camp: [70, 110] };

/** Direction on the sphere from a tangent-plane offset (x east, z north, meters). */
export function offsetDir(site, x, z, out = new THREE.Vector3()) {
  const R = site.R;
  return out.copy(site.up).multiplyScalar(R).addScaledVector(site.east, x).addScaledVector(site.north, z).normalize();
}

export function makeFrame(dir, R) {
  const up = dir.clone().normalize();
  const east = new THREE.Vector3(), north = new THREE.Vector3();
  tangentFrame(up, east, north);
  return { up, east, north, R };
}

/** Replicates Player._findLand for the default spawn (no lat/lon in the URL). */
export function predictSpawn(world) {
  const S = world.surface;
  let dir = latLonToDir(12, 28);
  if (S && S.seaLevel > -1e8) {
    let best = dir.clone(), bestScore = -Infinity;
    const e = new THREE.Vector3(), n = new THREE.Vector3(), d = new THREE.Vector3();
    tangentFrame(dir, e, n);
    for (let i = 0; i < 400; i++) {
      const t = i * 2.39996, r = Math.sqrt(i) * 0.02;
      d.copy(dir).addScaledVector(e, Math.cos(t) * r).addScaledVector(n, Math.sin(t) * r).normalize();
      const h = S.height(d.x, d.y, d.z);
      let score = h > 20 && h < S.amp * 0.35 ? 1 - r : -1;
      if (score > 0) { const nn = S.normal(d, n.clone(), 1.2); score -= nn.dot(d) > 0.9 ? 0 : 0.6; }
      if (score > bestScore) { bestScore = score; best.copy(d); if (score > 0.9) break; }
    }
    dir = best;
  }
  const f = makeFrame(dir, world.body.radius);
  const yaw = 30 * Math.PI / 180;
  const forward = f.north.clone().multiplyScalar(Math.cos(yaw)).addScaledVector(f.east, Math.sin(yaw)).normalize();
  return { dir, forward, frame: f };
}

function kindsFor(level, style) {
  if (level <= 1) return [['ruin', 1]];
  if (level === 2) return [['village', 3], ['ruin', 1], ['camp', style === 'nomad' ? 3 : 0.3]];
  if (level === 3) return [['town', 2], ['village', 4], ['ruin', 1], ['monument', 1]];
  if (level === 4) return [['city', 1.4], ['town', 3], ['village', 3], ['ruin', 1], ['monument', 1]];
  return [['city', 3], ['town', 3], ['village', 2], ['monument', 1], ['ruin', 0.6]];
}
function capitalKind(level) { return ['ruin', 'ruin', 'village', 'town', 'city', 'metropolis'][clamp(level, 0, 5)]; }

/** Terrain statistics over a disc: mean/min/max height, dry fraction, max slope estimate. */
export function siteStats(S, frame, r, lod = 20, n = 10) {
  const site = { ...frame };
  const hs = [];
  let dry = 0, tot = 0, min = Infinity, max = -Infinity, sum = 0;
  const sea = S.seaLevel > -1e8 ? S.seaLevel : -Infinity;
  for (let ring = 0; ring <= 2; ring++) {
    const rr = r * ring / 2, cnt = ring === 0 ? 1 : n * ring;
    for (let i = 0; i < cnt; i++) {
      const a = i / cnt * Math.PI * 2 + ring * 0.37;
      offsetDir(site, Math.cos(a) * rr, Math.sin(a) * rr, _d);
      const h = S.heightLod ? S.heightLod(_d.x, _d.y, _d.z, lod) : S.height(_d.x, _d.y, _d.z);
      hs.push(h); tot++; sum += h;
      if (h > sea + 2.5) dry++;
      if (h < min) min = h; if (h > max) max = h;
    }
  }
  const mean = sum / tot;
  let dev = 0; for (const h of hs) dev += (h - mean) * (h - mean);
  return { mean, min, max, dry: dry / tot, rough: Math.sqrt(dev / tot) / Math.max(r, 1), range: max - min };
}

function coastal(S, frame, dist) {
  if (!(S.seaLevel > -1e8)) return 0;
  let wet = 0;
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    offsetDir(frame, Math.cos(a) * dist, Math.sin(a) * dist, _d);
    const h = S.heightLod ? S.heightLod(_d.x, _d.y, _d.z, 60) : S.height(_d.x, _d.y, _d.z);
    if (h < S.seaLevel - 0.5) wet++;
  }
  return wet / 8;
}

/** Line-of-sight test from eye to target (both planet-local points). */
function clearView(S, R, eye, target, steps = 24) {
  const p = new THREE.Vector3();
  let blocked = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    p.lerpVectors(eye, target, t);
    const len = p.length();
    _d.copy(p).divideScalar(len);
    const h = S.heightLod ? S.heightLod(_d.x, _d.y, _d.z, 12) : S.height(_d.x, _d.y, _d.z);
    const over = R + h - len;
    if (over > 0) blocked += over;
  }
  return blocked;
}

export function planSites(world) {
  const body = world.body, S = world.surface, civ = body.civ || {};
  const R = body.radius;
  const level = civ.level | 0;
  const style = civ.style || 'village';
  const rng = new RNG(hashCombine(civ.placeSeed >>> 0, 0x51735));
  const sea = S.seaLevel > -1e8 ? S.seaLevel : -Infinity;
  const waterOK = style === 'neon' || style === 'harbor' || style === 'organic';
  const sites = [];
  const name = (k) => { try { return world.universe.placeName(body, k); } catch (_) { return `Site ${k}`; } };

  // ------------------------------------------------ capital near the default spawn
  const spawn = predictSpawn(world);
  const sf = spawn.frame;
  const eye = spawn.dir.clone().multiplyScalar(R + S.height(spawn.dir.x, spawn.dir.y, spawn.dir.z) + 6);
  const ckind = level === 0 ? 'monument' : capitalKind(level);
  const cr = level === 0 ? 50 : (KIND_RADIUS[ckind][0] + KIND_RADIUS[ckind][1]) / 2;
  const search = (dists, angles, r, angW, hamlet = false) => {
    let best = null;
    for (const dist of dists) {
      for (const ao of angles) {
        const a = ao * Math.PI / 180;
        const fwd = spawn.forward.clone().applyAxisAngle(sf.up, a);
        const dir = sf.up.clone().multiplyScalar(R).addScaledVector(fwd, dist).normalize();
        const fr = makeFrame(dir, R);
        const st = siteStats(S, fr, r * 0.85, hamlet ? 6 : 16, 8);
        const tgt = dir.clone().multiplyScalar(R + st.mean + Math.min(40, r * 0.1));
        const block = hamlet ? 0 : clearView(S, R, eye, tgt);
        let score = -st.rough * 60 - (1 - st.dry) * (waterOK ? 0.4 : 6) - Math.abs(Math.abs(ao) - (hamlet ? 30 : 0)) / angW
          - Math.abs(dist - dists[1]) / 2500 - Math.min(block, 400) * 0.01;
        if (st.mean < sea + 3 && !(waterOK && st.mean > sea - 30)) score -= 4;
        if (!best || score > best.score) best = { score, fr, st, dist };
      }
    }
    return best;
  };
  const best = level === 0 ? search([200, 280, 380, 520], [0, -15, 15, -30, 30], cr, 40)
    : search([cr + 350, cr + 550, cr + 800, cr + 1100, cr + 1500, cr + 2000], [0, -12, 12, -24, 24, -36, 36, -50, 50, -65, 65], cr, 55);
  const cap = best.fr;
  sites.push({
    id: 0, capital: true, kind: ckind, style, level, name: name(0), ...cap,
    radius: cr, seed: hashCombine(civ.placeSeed >>> 0, 1), heading: rng.range(0, Math.PI * 2),
    coastal: coastal(S, cap, cr * 2.2), stats: best.st,
    spaceport: level >= 5,
  });
  // outlying hamlet between the spawn and the capital (foreground life from the first frame)
  if (level >= 2) {
    const hb = search([170, 230, 300, 380], [-50, -40, -30, -20, 20, 30, 40, 50], 55, 30, true);
    const fr = hb.fr;
    if (fr.up.angleTo(cap.up) * R > cr + 120) {
      sites.push({ id: 1, hamlet: true, kind: style === 'nomad' ? 'camp' : 'village', style, level: Math.min(level, 2), name: name(1), ...fr,
        radius: 55, seed: hashCombine(civ.placeSeed >>> 0, 2), heading: rng.range(0, Math.PI * 2), coastal: 0,
        stats: hb.st, spawn: spawn.dir.clone(), spawnFwd: spawn.forward.clone() });
    }
  }

  // ------------------------------------------------ other sites
  const target = Math.max(0, (civ.settlements | 0) - 1);
  if (target > 0 && level > 0) {
    const N = 2600;
    const cands = [];
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(0, 6.28), rng.range(0, 6.28), 0));
    const capDir = cap.up;
    for (let i = 0; i < N; i++) {
      const y = 1 - (i + 0.5) / N * 2, rr = Math.sqrt(1 - y * y), th = i * 2.39996323;
      const d = new THREE.Vector3(Math.cos(th) * rr, y, Math.sin(th) * rr).applyQuaternion(rot);
      const h = S.heightLod ? S.heightLod(d.x, d.y, d.z, 200) : S.height(d.x, d.y, d.z);
      if (h < sea + 6 || h > S.amp * 0.5) continue;
      if (Math.abs(d.y) > 0.93) continue;
      cands.push({ d, h, i });
    }
    // add a dense ring around the capital so neighbours exist in view
    for (let i = 0; i < 260; i++) {
      const a = rng.range(0, Math.PI * 2), dist = rng.range(2800, 16000);
      const d = cap.up.clone().multiplyScalar(R).addScaledVector(cap.east, Math.cos(a) * dist).addScaledVector(cap.north, Math.sin(a) * dist).normalize();
      const h = S.heightLod ? S.heightLod(d.x, d.y, d.z, 100) : S.height(d.x, d.y, d.z);
      if (h < sea + 4 || h > S.amp * 0.45) continue;
      cands.push({ d, h, near: true });
    }
    const scored = [];
    for (const c of cands) {
      const fr = makeFrame(c.d, R);
      const st = siteStats(S, fr, 180, 40, 6);
      if (st.dry < 0.8 || st.rough > 0.05) continue;
      let info = {};
      try { S.sample(c.d.x, c.d.y, c.d.z, info, false); } catch (_) { info = {}; }
      const temp = info.temperature ?? 0.5;
      const co = coastal(S, fr, 1400);
      const distCap = c.d.angleTo(capDir) * R;
      let score = 1 - st.rough * 25 + co * 0.7 - Math.abs(temp - 0.55) * 0.8 + rng.next() * 0.35;
      if (info.river > 0.3) score += 0.3;
      if (c.near || distCap < 16000) score += 0.9;
      scored.push({ ...c, fr, st, co, score, distCap });
    }
    scored.sort((a, b) => b.score - a.score);
    const minSep = Math.min(4500, Math.PI * R / Math.max(4, target) * 0.9);
    const kinds = kindsFor(level, style);
    for (const c of scored) {
      if (sites.length - 1 >= target + (level >= 2 ? 1 : 0)) break;
      let ok = c.distCap > 2600;
      for (const s of sites) if (ok && c.d.angleTo(s.up) * R < minSep) ok = false;
      if (!ok) continue;
      const kind = rng.weighted(kinds);
      const [r0, r1] = KIND_RADIUS[kind];
      const id = sites.length;
      sites.push({ id, kind, style, level, name: name(id), ...c.fr, radius: rng.range(r0, r1), seed: hashCombine(civ.placeSeed >>> 0, 100 + id),
        heading: rng.range(0, Math.PI * 2), coastal: c.co, stats: c.st, distCap: c.distCap });
    }
  }
  return { sites, spawn };
}
