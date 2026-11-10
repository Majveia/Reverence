// The canonical shape of a world.  ONE deterministic function per planet, shared by everything:
// terrain meshing (workers), physics, placement of flora / cities / creatures, the from-orbit bake.
// Pure JS, no three.js / DOM — importable from module workers.
//
//   const field = createHeightField(body);            // body = a landable BodyDesc from the Universe
//   field.height(x, y, z)      → metres above the base radius for unit direction (x,y,z)
//   field.surface(x, y, z, out)→ out = { h, slope (0 flat … 1 vertical), r, g, b (linear albedo), wet, snow, veg, biome }
//   field.radius, field.amplitude, field.seaHeight (metres above base radius, or -Infinity without an ocean)
//   field.sites   → [{ id, kind:'city'|'town'|'outpost'|'monument'|'arrival', name, dir:[x,y,z], radius, height, seed }]
//   field.spawn   → { dir:[x,y,z], site }   where the wanderer first sets foot
//
// OWNER: the terrain module.  It may rewrite the internals freely (per-theme shaping, erosion, caves of light…)
// but must keep this API stable and deterministic for a given body.

import { makeNoise, rng, hash32, smoothstep, saturate, lerp } from '../core/rng.js';
import { placeName } from '../core/universe/names.js';

const SITE_RADIUS = { city: [520, 900], town: [170, 300], outpost: [55, 95], monument: [45, 120], arrival: [26, 26] };

function hexToLinear(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return c;
}

export function createHeightField(body) {
  const T = body.terrain, R = body.radius, A = T.amplitude;
  const noise = makeNoise(body.seed);
  const noise2 = makeNoise(body.seed + 101);
  const seaHeight = body.ocean ? T.seaLevel * A : -Infinity;
  const pal = {}; for (const k in body.palette) pal[k] = hexToLinear(body.palette[k]);
  const fScale = Math.sqrt(R / 6.0e4);        // keep feature sizes in metres similar across planet sizes

  // ── raw (un-flattened) terrain ──
  function raw(x, y, z) {
    // domain warp for organic coastlines
    const w = 0.35 * T.continents;
    const wx = x + w * noise2.simplex(x * 1.7 + 3.1, y * 1.7, z * 1.7), wy = y + w * noise2.simplex(x * 1.7, y * 1.7 + 7.7, z * 1.7), wz = z + w * noise2.simplex(x * 1.7, y * 1.7, z * 1.7 + 5.3);
    const f0 = 1.6 * fScale;
    let cont = noise.fbm(wx * f0, wy * f0, wz * f0, 5, 2.03, 0.52);            // −1..1 continents
    cont = cont * 0.5 + 0.5;
    const land = smoothstep(T.seaLevel - 0.18, T.seaLevel + 0.22, cont * (0.55 + 0.6 * T.continents));
    // mountains: ridged, masked so ranges form belts
    const f1 = 9 * fScale;
    const belt = smoothstep(0.35, 0.75, noise2.fbm(x * 2.6 * fScale + 9, y * 2.6 * fScale, z * 2.6 * fScale, 3) * 0.5 + 0.5);
    const mount = noise.ridged(wx * f1, wy * f1, wz * f1, 6, 2.07, 0.5) * T.ridged * belt;
    const f2 = 34 * fScale;
    const hills = (noise2.fbm(x * f2, y * f2, z * f2, 5, 2.1, 0.5) * 0.5 + 0.5) * T.hills;
    let h = cont * 0.42 + land * (0.10 + mount * 0.62 + hills * 0.11);
    // craters (airless worlds)
    if (T.craters > 0) {
      const f3 = 22 * fScale; const d = noise.worley(x * f3, y * f3, z * f3);
      const bowl = smoothstep(0.0, 0.42, d), rim = smoothstep(0.42, 0.34, d) * smoothstep(0.2, 0.36, d);
      h += T.craters * (-(1 - bowl) * 0.10 + rim * 0.035);
    }
    // mesas / terraces
    if (T.terraces > 0) { const steps = 9; const q = Math.floor(h * steps) / steps, fr = h * steps - Math.floor(h * steps); const t = q + smoothstep(0.72, 1.0, fr) / steps; h = lerp(h, t, T.terraces * land * 0.85); }
    // fine detail
    const f4 = 190 * fScale;
    h += noise.fbm(x * f4, y * f4, z * f4, 4, 2.2, 0.5) * 0.012 * T.roughness * (0.3 + land);
    // dunes
    if (T.dunes > 0) { const f5 = 420 * fScale; const d = Math.abs(Math.sin((x * 0.8 + z * 0.6 + 0.25 * noise2.simplex(x * 40, y * 40, z * 40)) * f5)); h += T.dunes * (1 - d) * (1 - d) * 0.012 * (1 - smoothstep(0.1, 0.5, mount)); }
    return Math.max(0, h) * A;
  }

  // ── settlements: pick buildable ground, then flatten around it ──
  const sites = [];
  (function chooseSites() {
    const civ = body.civ; if (!civ) return;
    const r = rng(hash32(body.seed, 'sites'));
    const wants = [['city', civ.cities || 0], ['town', civ.towns || 0], ['outpost', civ.outposts || 0], ['monument', civ.monuments || 0]];
    const minSea = seaHeight === -Infinity ? -1e9 : seaHeight + 6;
    for (const [kind, count] of wants) {
      for (let i = 0; i < count; i++) {
        let best = null;
        for (let tries = 0; tries < 60; tries++) {
          const d = r.dir();
          if (Math.abs(d[1]) > 0.82) continue;                                   // keep off the poles
          const rad = lerp(SITE_RADIUS[kind][0], SITE_RADIUS[kind][1], r());
          const h0 = raw(d[0], d[1], d[2]);
          if (h0 < minSea || (kind !== 'monument' && h0 > Math.max(seaHeight, 0) + A * 0.42)) continue;
          // roughness of the footprint
          const up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
          const tx = [up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]]; const tl = Math.hypot(...tx); tx[0] /= tl; tx[1] /= tl; tx[2] /= tl;
          const ty = [d[1] * tx[2] - d[2] * tx[1], d[2] * tx[0] - d[0] * tx[2], d[0] * tx[1] - d[1] * tx[0]];
          let rough = 0, wet = false; const a = (rad * 0.8) / R;
          for (let k = 0; k < 6; k++) {
            const ang = (k / 6) * Math.PI * 2, cx = Math.cos(ang) * a, cy = Math.sin(ang) * a;
            let px = d[0] + tx[0] * cx + ty[0] * cy, py = d[1] + tx[1] * cx + ty[1] * cy, pz = d[2] + tx[2] * cx + ty[2] * cy; const l = Math.hypot(px, py, pz); px /= l; py /= l; pz /= l;
            const hh = raw(px, py, pz); rough = Math.max(rough, Math.abs(hh - h0)); if (hh < minSea - 4) wet = true;
          }
          if (wet && kind !== 'town') continue;
          let ok = true; for (const s of sites) { const dot = d[0] * s.dir[0] + d[1] * s.dir[1] + d[2] * s.dir[2]; const dist = R * Math.acos(Math.min(1, dot)); if (dist < (s.radius + rad) * 2.4 + 200) { ok = false; break; } }
          if (!ok) continue;
          const score = -rough / rad + (kind === 'monument' ? h0 / A : 0) + r() * 0.05;
          if (!best || score > best.score) best = { score, d, rad, h0 };
          if (tries > 24 && best && rough / rad < 0.12) break;
        }
        if (best) sites.push({ id: `${kind}${i}`, kind, name: placeName(hash32(body.seed, kind, i)), dir: best.d, radius: best.rad, height: Math.max(best.h0, minSea), seed: hash32(body.seed, 'site', kind, i) });
      }
    }
  })();

  // ── arrival terrace: a ridge near the first settlement, looking over it ──
  let spawn;
  (function chooseSpawn() {
    const anchor = sites.find((s) => s.kind === 'city') || sites.find((s) => s.kind === 'town') || sites[0];
    let d = anchor ? anchor.dir : null, best = null;
    if (!d) { const r = rng(hash32(body.seed, 'spawn')); for (let i = 0; i < 80; i++) { const c = r.dir(); const h = raw(c[0], c[1], c[2]); if (h > Math.max(seaHeight, 0) + 10 && Math.abs(c[1]) < 0.7) { d = c; break; } } d ||= [0, 0, 1]; }
    const up = [0, 1, 0];
    const tx = [up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]]; const tl = Math.hypot(...tx) || 1; tx[0] /= tl; tx[1] /= tl; tx[2] /= tl;
    const ty = [d[1] * tx[2] - d[2] * tx[1], d[2] * tx[0] - d[0] * tx[2], d[0] * tx[1] - d[1] * tx[0]];
    const base = anchor ? anchor.radius : 300;
    for (let k = 0; k < 24; k++) {
      const ang = (k / 24) * Math.PI * 2, dist = base * (1.35 + 0.5 * ((k * 7) % 5) / 5), a = dist / R;
      let px = d[0] + (tx[0] * Math.cos(ang) + ty[0] * Math.sin(ang)) * a, py = d[1] + (tx[1] * Math.cos(ang) + ty[1] * Math.sin(ang)) * a, pz = d[2] + (tx[2] * Math.cos(ang) + ty[2] * Math.sin(ang)) * a;
      const l = Math.hypot(px, py, pz); px /= l; py /= l; pz /= l;
      const h = raw(px, py, pz); if (h < seaHeight + 8) continue;
      const score = h - (anchor ? anchor.height : 0);
      if (!best || score > best.score) best = { score, dir: [px, py, pz], h };
    }
    if (!best) best = { dir: d, h: raw(d[0], d[1], d[2]) };
    const site = { id: 'arrival', kind: 'arrival', name: 'First Step', dir: best.dir, radius: SITE_RADIUS.arrival[0], height: Math.max(best.h, seaHeight + 3), seed: hash32(body.seed, 'arrival') };
    sites.push(site);
    spawn = { dir: best.dir, site, toward: anchor ? anchor.dir : null };
  })();

  const siteCos = sites.map((s) => Math.cos(Math.min(1.5, (s.radius * 1.9) / R)));

  function height(x, y, z) {
    let h = raw(x, y, z);
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i], dot = x * s.dir[0] + y * s.dir[1] + z * s.dir[2];
      if (dot < siteCos[i]) continue;
      const dist = R * Math.acos(Math.min(1, dot));
      const w = 1 - smoothstep(s.radius * 0.8, s.radius * 1.8, dist);
      h = lerp(h, s.height, w);
    }
    return h;
  }

  const _n = [0, 0, 0];
  function surface(x, y, z, out = {}) {
    const h = height(x, y, z);
    // slope from a small tangent-plane stencil
    const e = 12 / R;
    const up = Math.abs(y) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    let tx0 = up[1] * z - up[2] * y, tx1 = up[2] * x - up[0] * z, tx2 = up[0] * y - up[1] * x; const tl = Math.hypot(tx0, tx1, tx2); tx0 /= tl; tx1 /= tl; tx2 /= tl;
    const ty0 = y * tx2 - z * tx1, ty1 = z * tx0 - x * tx2, ty2 = x * tx1 - y * tx0;
    const hx = height(x + tx0 * e, y + tx1 * e, z + tx2 * e), hy = height(x + ty0 * e, y + ty1 * e, z + ty2 * e);
    const gx = (hx - h) / 12, gy = (hy - h) / 12;
    const slope = saturate(Math.sqrt(gx * gx + gy * gy) / 1.4);
    const sea = seaHeight === -Infinity ? 0 : seaHeight;
    const alt = saturate((h - sea) / Math.max(1, A - sea));
    const lat = Math.abs(y);
    const n1 = noise2.fbm(x * 60, y * 60, z * 60, 3) * 0.5 + 0.5;
    const snowLine = T.snowLine - lat * lat * 0.55;
    const snow = saturate(smoothstep(snowLine - 0.04, snowLine + 0.06, alt + (n1 - 0.5) * 0.12) * (1 - slope * 0.7));
    const beach = body.ocean ? 1 - smoothstep(2, 14, h - sea) : 0;
    const veg = saturate((1 - smoothstep(0.15, 0.5, slope)) * (1 - snow) * (1 - beach) * (0.4 + 0.8 * n1) * Math.min(1, body.life?.flora ?? 0));
    const forest = saturate(veg * smoothstep(0.45, 0.7, noise.fbm(x * 25 + 4, y * 25, z * 25, 3) * 0.5 + 0.5));
    let c = lerp3(pal.soil, pal.grass, veg);
    c = lerp3(c, pal.grass2, veg * n1 * 0.6);
    c = lerp3(c, pal.forest, forest * 0.85);
    c = lerp3(c, pal.rock, smoothstep(0.28, 0.6, slope));
    c = lerp3(c, pal.rock2, smoothstep(0.55, 0.9, slope) * 0.7);
    c = lerp3(c, pal.sand, beach);
    if (!body.ocean && T.dunes > 0) c = lerp3(c, pal.sand, (1 - smoothstep(0.1, 0.4, slope)) * 0.8);
    c = lerp3(c, pal.snow, snow);
    if (h < sea) c = lerp3(pal.shallow, pal.deep, smoothstep(0, 60, sea - h));
    out.h = h; out.slope = slope; out.r = c[0]; out.g = c[1]; out.b = c[2];
    out.wet = h < sea ? 1 : 0; out.snow = snow; out.veg = veg; out.forest = forest; out.alt = alt;
    out.biome = h < sea ? 'water' : snow > 0.5 ? 'snow' : slope > 0.5 ? 'rock' : beach > 0.5 ? 'beach' : forest > 0.5 ? 'forest' : veg > 0.3 ? 'grass' : 'bare';
    return out;
  }
  function lerp3(a, b, t) { _n[0] = a[0] + (b[0] - a[0]) * t; _n[1] = a[1] + (b[1] - a[1]) * t; _n[2] = a[2] + (b[2] - a[2]) * t; return [_n[0], _n[1], _n[2]]; }

  return { body, radius: R, amplitude: A, seaHeight, height, raw, surface, sites, spawn, palette: pal };
}
