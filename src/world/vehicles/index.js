// Vehicles subsystem (order 55). OWNED BY THE VEHICLES TRACK.
//   Hoverbike (Ride) · Rover (Drive) · Starship (Board) — procedural AAA models, physics, cameras, FX.
//
// Spawns deterministically around the player spawn (and near civ landing/settlement POIs), handles
// enter/exit with the 'vehicle' action (F / gamepad Y / touch button) via world.setController, shows
// prompts, drives audio params ('engine', 'speed', 'boost', 'altitude') and minimal telemetry.
//
// URL: view=bike|rover|ship spawns directly in that vehicle. Extra (vehicles only):
//   cam=chase|cockpit|side|front|low|high|top|quarter|rear   camera preset for captures
//   alt=<m>  (view=ship) start airborne at this altitude above ground; above the atmosphere = orbit
//   speed=<m/s> initial forward speed (bike/rover/ship)      liv=<name> force a livery
// Hold 'vehicle' (F) on foot away from any vehicle → summon the last used vehicle (materializes).
import * as THREE from 'three';
import { Ground } from './ground.js';
import { ColliderGrid } from './colliders.js';
import { makeUberMaterial, makeGlowMaterial, makeDecalMaterial, makeGlassMaterial, EnvProbe, pickLivery, weathering, LIVERIES } from './materials.js';
import { Particles } from './fx/particles.js';
import { SpeedBlur } from './fx/speedblur.js';
import { Streaks } from './fx/streaks.js';
import { Hoverbike } from './Hoverbike.js';
import { Rover } from './Rover.js';
import { Starship } from './Starship.js';
import { clamp, damp, headingDir, orthoForward, fmtSpeed, FastRand } from './util.js';
import { latLonToDir } from '../../core/math.js';
import { G } from '../../core/Uniforms.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _n = new THREE.Vector3();
const _e = new THREE.Vector3(), _no = new THREE.Vector3();

const KINDS = { bike: Hoverbike, rover: Rover, ship: Starship };
// minimum distance (m) between a parked vehicle and the player's spawn
const KEEP = { bike: 3.5, rover: 6, ship: 18 };

class VehicleManager {
  constructor(world) {
    this.world = world;
    this.engine = world.engine;
    this.quality = world.quality || {};
    this.params = world.params || {};
    this.ground = new Ground(world);
    this.colliders = new ColliderGrid(world);
    this.vehicles = [];
    this.active = null;
    this.lastUsed = 'bike';
    this.cool = 0;
    this.holdT = 0;
    this.prompt = null;
    this.teleT = 0;
    this.baseFov = world.camera.fov;
    this._envTex = null;
    this._envState = 'none';
    this.rand = new FastRand(1337);
    this.errors = 0;
    this.placed = false;
    this._t0 = performance.now();

    // shared FX pools (few draw calls for every vehicle)
    const ps = clamp(this.quality.particleScale ?? 1, 0.25, 2);
    this.fx = {
      dust: new Particles(world, { max: Math.round(420 * ps), name: 'vehicle-dust' }),
      spray: new Particles(world, { max: Math.round(260 * ps), name: 'vehicle-spray' }),
      sparks: new Particles(world, { max: Math.round(120 * ps), additive: true, stretch: true, lit: false, name: 'vehicle-sparks', renderOrder: 9 }),
    };
    this.streaks = new Streaks(world, this.quality.mobile ? 80 : 160);
    try { this.probe = new EnvProbe(this.engine.renderer, world); } catch (e) { this.probe = null; }
    this.blur = this.quality.tier !== 'low' ? new SpeedBlur(this.engine.pipeline) : null;
  }

  // ------------------------------------------------------------------ materials & liveries
  livery(kind) {
    const force = this.params.liv;
    if (force && LIVERIES[force]) return { name: force, ...LIVERIES[force], artAccent: LIVERIES[force].accent };
    if (!this._liv) this._liv = {};
    if (!this._liv[kind]) this._liv[kind] = pickLivery(this.world.body, kind);
    return this._liv[kind];
  }
  makeMaterials(kind, opts = {}) {
    const liv = this.livery(kind);
    const wth = weathering(this.world.body);
    const pal = this.world.body.art?.palette || {};
    const hi = this.quality.tier === 'high' || this.quality.tier === 'ultra';
    const body = makeUberMaterial({
      clearcoat: hi, panelScale: opts.panelScale ?? 0.45, dirt: wth.dirt * (opts.dirtMul ?? 1), wear: wth.wear, rust: wth.rust * (opts.rustMul ?? 1),
      dirtColor: pal.sand || '#8a7a60', edgeColor: liv.edge, seed: opts.seed ?? 1.7, dirtLow: opts.dirtLow ?? 0, dirtHigh: opts.dirtHigh ?? 1.5, seamDark: opts.seamDark,
    });
    const glow = makeGlowMaterial();
    const decal = makeDecalMaterial({ wear: 0.25 + wth.wear * 0.35, seed: (opts.seed ?? 1.7) * 3.1 });
    const glass = makeGlassMaterial(liv.glass);
    // the pilot gets its own clean material: crisp suit colours, grime only on the boots
    const rider = makeUberMaterial({
      clearcoat: hi, panelScale: 0.12, dirt: Math.min(0.35, wth.dirt * 0.6), wear: 0.25, rust: 0,
      dirtColor: pal.sand || '#8a7a60', edgeColor: '#c8c8c8', seed: (opts.seed ?? 1.7) + 9.1, dirtLow: -1, dirtHigh: -0.4,
    });
    const mats = { body, glow, decal, glass, rider };
    (this._mats ||= []).push(mats);
    if (this._envTex) for (const m of [body, glass, decal, rider]) { m.envMap = this._envTex; m.needsUpdate = true; }
    return mats;
  }

  // ------------------------------------------------------------------ spawning
  /** Find a flat, dry spot near `center` (planet-local) at ~dist m in direction `dir` (tangent). */
  findSpot(center, dir, dist, { maxSlope = 0.18, footprint = 2, dry = true, tries = 48, avoid = [], clear = 0, keep = 0 } = {}) {
    const g = this.ground, R = this.world.body.radius;
    const up = _u.copy(center).normalize();
    const base = orthoForward(up, dir, new THREE.Vector3());
    const side = new THREE.Vector3().crossVectors(base, up).normalize();
    let best = null, bestScore = -1e9;
    const p = new THREE.Vector3();
    for (let i = 0; i < tries; i++) {
      const a = (i * 2.39996) % (Math.PI * 2);
      const rr = dist + Math.sqrt(i) * dist * 0.18;
      const off = i === 0 ? 0 : 1;
      p.copy(center).addScaledVector(base, dist * (1 - off) + off * (Math.cos(a) * rr * 0.35 + dist)).addScaledVector(side, off * Math.sin(a) * rr * 0.5);
      p.normalize();
      const h = g.terrainAt(p.clone().multiplyScalar(R));
      if (dry && g.hasOcean && h < g.sea + 0.6) continue;
      // flatness over the footprint
      let hmin = h, hmax = h;
      for (let k = 0; k < 4; k++) {
        const ang = k * Math.PI / 2 + 0.4;
        _w.copy(p).multiplyScalar(R).addScaledVector(base, Math.cos(ang) * footprint).addScaledVector(side, Math.sin(ang) * footprint);
        const hh = g.terrainAt(_w);
        hmin = Math.min(hmin, hh); hmax = Math.max(hmax, hh);
      }
      const slope = (hmax - hmin) / (footprint * 2);
      let score = -slope * 10 - i * 0.02;
      if (slope > maxSlope) score -= 5;
      for (const o of avoid) { const d = o.distanceTo(_w.copy(p).multiplyScalar(R + h)); if (d < footprint * 2 + 3) score -= 8; }
      const blocked = clear > 0 && this.blocked(_w.copy(p).multiplyScalar(R + h), clear);
      if (blocked) score -= 20;
      const pen = this._placePenalty(_w.copy(p).multiplyScalar(R + h), keep);
      score -= pen;
      if (score > bestScore) { bestScore = score; best = { dir: p.clone(), h, slope }; }
      if (slope < maxSlope * 0.35 && i > 2 && !blocked && pen === 0) break;
    }
    if (!best) {
      const d = _v.copy(center).addScaledVector(base, dist).normalize();
      const h = g.terrainAt(d.clone().multiplyScalar(R));
      best = { dir: d.clone(), h, slope: 1, wet: dry && g.hasOcean && h < g.sea + 0.3 };
    }
    return best;
  }

  /**
   * Placement penalty for a surface point q (planet-local, on the ground): civ plazas/clearings and
   * town POIs (civ asks us not to park on graded plazas), and the player's spawn (keep ≥ `keep` m so
   * a parked ship never hides the first frame). Returns 0 when the spot is fine.
   */
  _placePenalty(q, keep = 0) {
    let pen = 0;
    const w = this.world;
    const C = w.civ?.clearings || w.get?.('civ')?.clearings;
    if (C && C.length && !this._ignoreCiv) {
      const l = q.length() || 1, dx = q.x / l, dy = q.y / l, dz = q.z / l;
      for (let i = 0; i < C.length; i++) {
        const c = C[i];
        if (!c) continue;
        const d = dx * c[0] + dy * c[1] + dz * c[2];
        if (d > c[3]) { pen += 18; break; }
      }
    }
    const pois = w.pois;
    if (pois && pois.length && !this._ignoreCiv) {
      for (let i = 0; i < pois.length; i++) {
        const p = pois[i];
        if (!p?.pos?.isVector3 || (p.kind !== 'city' && p.kind !== 'village')) continue;
        if (p.pos.distanceTo(q) < (p.radius || 100) * 0.9) { pen += 12; break; }
      }
    }
    if (keep > 0 && this.spawn?.pos) {
      const d = this.spawn.pos.distanceTo(q);
      if (d < keep) pen += 14 * (1 - d / keep) + 4;
    }
    return pen;
  }

  /** True when static colliders (trees, rocks, buildings) crowd a disc of radius r around pos. */
  blocked(pos, r) {
    const cg = this.colliders;
    if (!cg.cells.size) return false;
    const up = _n.copy(pos).normalize();
    const e = _e, no = _no;
    if (Math.abs(up.y) > 0.99) e.set(1, 0, 0); else e.set(up.z, 0, -up.x).normalize();
    no.crossVectors(up, e);
    for (let k = 0; k < 9; k++) {
      const a = k * 0.785, rr = k === 0 ? 0 : r * 0.62;
      _v.copy(pos).addScaledVector(up, 2.2).addScaledVector(e, Math.cos(a) * rr).addScaledVector(no, Math.sin(a) * rr);
      if (cg.sphere(_v, r * 0.5 + 1.2)) return true;
    }
    return false;
  }

  /** Park a starship + hoverbike at the edge of the nearest settlements (deterministic: sorted by distance). */
  spawnAtSettlements() {
    const sp = this.spawn;
    if (!sp || this.params.view === 'orbit' || this.noProps) return;
    const pois = (this.world.pois || []).filter((p) => (p.kind === 'city' || p.kind === 'village') && p.pos?.isVector3);
    if (!pois.length) return;
    const R = this.world.body.radius;
    pois.sort((a, b) => a.pos.distanceTo(sp.pos) - b.pos.distanceTo(sp.pos));
    const max = this.quality.mobile || this.quality.tier === 'low' ? 1 : 2;
    let n = 0;
    for (const poi of pois) {
      if (n >= max) break;
      const d = poi.pos.distanceTo(sp.pos);
      if (d > 12000) break;
      const up = _u.copy(poi.pos).normalize();
      // the side of the settlement that faces the player spawn
      const toward = _w.copy(sp.pos).sub(poi.pos).addScaledVector(up, -_w.copy(sp.pos).sub(poi.pos).dot(up));
      const dir = toward.lengthSq() > 1 ? toward.normalize().clone() : headingDir(up, 90, new THREE.Vector3());
      const edge = poi.pos.clone().addScaledVector(dir, (poi.radius || 120) + 45);
      edge.normalize().multiplyScalar(R + this.ground.terrainAt(edge));
      if (d < (poi.radius || 120) + 80) continue;          // the player already starts in town: skip
      const others = this.vehicles.map((o) => o.pos);
      const ship = this.add('ship', { id: `ship-${poi.name || n}` });
      if (ship) {
        const spot = this.findClearing(edge, dir, 160, { footprint: 7, maxSlope: 0.16, clear: ship.clearRadius, avoid: others });
        this.placeOnGround(ship, spot.dir, dir.clone().negate().applyAxisAngle(up, 0.9));
        ship.pristine = true;
      }
      const bike = this.add('bike', { id: `bike-${poi.name || n}` });
      if (bike) {
        const spot = this.findClearing(edge.clone().addScaledVector(dir, -22), dir, 40, { footprint: 1.2, maxSlope: 0.35, dry: false, clear: bike.clearRadius, avoid: this.vehicles.map((o) => o.pos) });
        this.placeOnGround(bike, spot.dir, dir.clone().applyAxisAngle(up, -0.5));
        bike.pristine = true;
      }
      n++;
    }
  }

  /** Once neighbours have registered their colliders, move pristine parked vehicles out of trees/buildings. */
  finalizePlacement() {
    try { this.spawnAtSettlements(); } catch (e) { console.error('[vehicles] settlement spawn failed', e); }
    const list = this.world.colliders || [];
    for (let guard = 0; guard < 50 && this.colliders.count < list.length; guard++) this.colliders.sync(0);
    const sp = this.spawn;
    if (!sp) return;
    for (const v of this.vehicles) {
      if (!v.pristine) continue;
      const r = v.clearRadius ?? 2;
      const inStart = v.occupied && this.params.view === v.type;
      if (inStart) { if (!this.blocked(v.pos, r)) continue; }
      else {
        const gh = this.ground.terrainAt(v.pos);
        const wet = v.type !== 'bike' && this.ground.hasOcean && gh < this.ground.sea + 0.3;
        const gp = v.pos.clone().normalize().multiplyScalar(this.world.body.radius + gh);
        if (!wet && !this.blocked(v.pos, r) && this._placePenalty(gp, KEEP[v.type] ?? 0) === 0) continue;
      }
      const up = _u.copy(v.pos).normalize();
      const f = _w.copy(v.pos).sub(sp.pos).addScaledVector(up, -_w.copy(v.pos).sub(sp.pos).dot(up));
      const dir = f.lengthSq() > 1 ? f.normalize().clone() : v.fwdVec.clone();
      const spot = this.findClearing(v.pos, dir, v.type === 'ship' ? 220 : 60, { footprint: v.type === 'ship' ? 7 : 2, maxSlope: v.type === 'ship' ? 0.16 : 0.3, dry: v.type !== 'bike', clear: r, keep: inStart ? 0 : (KEEP[v.type] ?? 0), avoid: this.vehicles.filter((o) => o !== v).map((o) => o.pos) });
      if (spot.wet && !inStart) continue;
      this.placeOnGround(v, spot.dir, v.fwdVec.clone());
      v.startFromParams?.(v.occupied ? this.params : {});
      if (v.camera) v.camera.snapped = false;
    }
  }

  /** Spiral search for an open, flat, dry spot (no trees/buildings, low canopy cover) within maxDist. */
  findClearing(center, dir, maxDist, { maxSlope = 0.2, footprint = 3, dry = true, clear = 3, avoid = [], keep = 0 } = {}) {
    const g = this.ground, R = this.world.body.radius, fl = this.world.get?.('flora');
    const up = _u.copy(center).normalize();
    const base = orthoForward(up, dir, new THREE.Vector3());
    const side = new THREE.Vector3().crossVectors(base, up).normalize();
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    let best = null, bestScore = -1e9;
    const rings = 9;
    for (let k = 0; k <= rings; k++) {
      const rad = (k / rings) * maxDist, n = k === 0 ? 1 : 6 + k * 3;
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2 + k * 0.7;
        p.copy(center).addScaledVector(base, Math.cos(a) * rad).addScaledVector(side, Math.sin(a) * rad).normalize();
        const h = g.terrainAt(q.copy(p).multiplyScalar(R));
        if (dry && g.hasOcean && h < g.sea + 0.6) continue;
        let hmin = h, hmax = h;
        for (let m = 0; m < 4; m++) {
          const ang = m * Math.PI / 2 + 0.4;
          _w.copy(p).multiplyScalar(R).addScaledVector(base, Math.cos(ang) * footprint).addScaledVector(side, Math.sin(ang) * footprint);
          const hh = g.terrainAt(_w); hmin = Math.min(hmin, hh); hmax = Math.max(hmax, hh);
        }
        const slope = (hmax - hmin) / (footprint * 2);
        let dens = 0;
        try { dens = fl?.densityAt ? fl.densityAt(p) : 0; } catch (_) { dens = 0; }
        q.copy(p).multiplyScalar(R + h);
        const blocked = this.blocked(q, clear);
        let score = -slope * 12 - dens * 5 - (blocked ? 25 : 0) - rad / maxDist * 2 - (slope > maxSlope ? 6 : 0) - this._placePenalty(q, keep);
        for (const o of avoid) if (o.distanceTo(q) < clear * 2 + 3) score -= 10;
        if (score > bestScore) { bestScore = score; best = { dir: p.clone(), h, slope }; }
      }
      if (best && bestScore > -2.5) break;
    }
    if (best) return best;
    const h0 = g.terrainAt(center);
    return { dir: center.clone().normalize(), h: h0, slope: 1, wet: dry && g.hasOcean && h0 < g.sea + 0.3 };
  }

  spawnPoint() {
    const w = this.world, pl = w.player;
    if (pl?.pos && Number.isFinite(pl.pos.x) && pl.pos.lengthSq() > 1) {
      const up = _u.copy(pl.pos).normalize();
      const fwd = pl.forward ? orthoForward(up, pl.forward, new THREE.Vector3()) : headingDir(up, this.params.yaw ?? 30, new THREE.Vector3());
      return { pos: pl.pos.clone(), fwd };
    }
    const p = this.params;
    const dir = latLonToDir(p.lat !== undefined ? +p.lat : 12, p.lon !== undefined ? +p.lon : 28);
    const R = w.body.radius;
    const h = this.ground.terrainAt(dir.clone().multiplyScalar(R));
    const pos = dir.clone().multiplyScalar(R + Math.max(h, this.ground.hasOcean ? this.ground.sea : -1e9));
    return { pos, fwd: headingDir(dir, p.yaw ?? 30, new THREE.Vector3()) };
  }

  /**
   * Capture helper (URL vnear=capital|hamlet|<civ site id>, vdist=<m>): move vehicle v to a flat, open,
   * dry spot `dist` m outside that settlement's edge (on the side facing the player spawn, or `yaw`),
   * facing the settlement — robust framing for "vehicle with the city in the distance" shots.
   */
  placeNear(v, which, dist) {
    const w = this.world, civ = w.civ || w.get?.('civ');
    const sites = civ?.sites;
    if (!sites?.length) return false;
    const site = which === 'capital' ? sites[0] : which === 'hamlet' ? sites.find((x) => x.hamlet) : sites[+which];
    if (!site?.pos?.isVector3) return false;
    const r = site.radius ?? 150;
    const center = site.pos.clone().normalize();
    const R = w.body.radius, g = this.ground;
    const cpos = site.pos.clone();
    const up = center.clone().normalize();
    let dir;
    if (this.params.yaw !== undefined) dir = headingDir(up, +this.params.yaw + 180, new THREE.Vector3());
    else if (this.spawn?.pos) {
      dir = this.spawn.pos.clone().sub(cpos); dir.addScaledVector(up, -dir.dot(up));
      if (dir.lengthSq() < 1) dir = headingDir(up, 200, new THREE.Vector3()); else dir.normalize();
    } else dir = headingDir(up, 200, new THREE.Vector3());
    const target = cpos.clone().addScaledVector(dir, r + dist).normalize().multiplyScalar(R);
    void g;
    const spot = this.findClearing(target, dir, Math.max(60, dist * 0.6), { footprint: v.type === 'ship' ? 7 : 3, maxSlope: 0.12, clear: v.clearRadius ?? 3 });
    const p = spot.dir.clone().multiplyScalar(R + spot.h);
    const face = cpos.clone().sub(p); face.addScaledVector(spot.dir, -face.dot(spot.dir));
    this.placeOnGround(v, spot.dir, face.lengthSq() > 1 ? face.normalize() : dir.clone().negate());
    v.pristine = true;
    if (v.camera) v.camera.snapped = false;
    return true;
  }

  /**
   * Capture/test helper (URL vramp=<search radius m>): find a real dune crest / terrain lip near the
   * spawn with the CPU heightfield (a run-up that rises, then a convex drop) and put vehicle v at the
   * start of the run-up facing it. The jump itself is pure physics (speed= sets the entry speed).
   */
  placeRamp(v, maxDist = 400) {
    const g = this.ground, R = this.world.body.radius, sp = this.spawn;
    if (!sp) return false;
    const up = sp.pos.clone().normalize();
    const e = new THREE.Vector3(), n = new THREE.Vector3();
    if (Math.abs(up.y) > 0.99) e.set(1, 0, 0); else e.set(up.z, 0, -up.x).normalize();
    n.crossVectors(up, e);
    const rnd = new FastRand(4242);
    const p0 = new THREE.Vector3(), dir = new THREE.Vector3(), q = new THREE.Vector3();
    const prof = new Float64Array(24);
    let best = null, bestS = 0;
    for (let i = 0; i < 360; i++) {
      const a = rnd.next() * Math.PI * 2, r = Math.sqrt(rnd.next()) * maxDist, h = rnd.next() * Math.PI * 2;
      p0.copy(sp.pos).addScaledVector(e, Math.cos(a) * r).addScaledVector(n, Math.sin(a) * r).normalize().multiplyScalar(R);
      const u = q.copy(p0).normalize();
      dir.copy(e).multiplyScalar(Math.cos(h)).addScaledVector(n, Math.sin(h));
      dir.addScaledVector(u, -dir.dot(u)).normalize();
      for (let k = 0; k < prof.length; k++) {
        q.copy(p0).addScaledVector(dir, k * 3);
        prof[k] = g.terrainAt(q);
      }
      if (g.hasOcean && Math.min(...prof) < g.sea + 0.5) continue;
      // run-up (0..~30 m) must be smooth and driveable, crest somewhere in 8..16, then a drop
      for (let c = 6; c <= 14; c++) {
        let rough = 0, ok = true;
        for (let k = 1; k <= c; k++) {
          const s1 = (prof[k] - prof[k - 1]) / 3;
          if (s1 < -0.08 || s1 > 0.45) { ok = false; break; }
          if (k > 1) rough += Math.abs(s1 - (prof[k - 1] - prof[k - 2]) / 3);
        }
        if (!ok) continue;
        const lip = (prof[c] - prof[c - 2]) / 6;               // take-off slope
        const drop = prof[c] - prof[Math.min(prof.length - 1, c + 4)];   // fall over 12 m after the crest
        const land = prof[Math.min(prof.length - 1, c + 8)];
        if (lip < 0.1 || lip > 0.5 || drop < 1.2 || drop > 7 || land < prof[c] - 11) continue;
        let score = Math.min(drop, 5) * 1.0 + lip * 8 - rough * 6;
        q.copy(p0).addScaledVector(dir, c * 3);
        const sm = g.sample(q);
        score += (sm?.dune ?? 0) * 3 + (sm?.sand ?? 0) * 1.5 - (sm?.rock ?? 0) * 2 - (sm?.cliff ?? 0) * 4;
        if (score > bestS) {
          if (this.blocked(q.normalize().multiplyScalar(R + prof[c]), 3)) continue;
          bestS = score; best = { pos: p0.clone(), dir: dir.clone(), crest: c * 3, drop, lip };
        }
      }
    }
    if (!best) return false;
    this.placeOnGround(v, best.pos.clone().normalize(), best.dir);
    v.pristine = true;
    this.rampInfo = { crest: best.crest, drop: +best.drop.toFixed(1), lip: +best.lip.toFixed(2), score: +bestS.toFixed(2) };
    if (v.camera) v.camera.snapped = false;
    return true;
  }

  add(kind, opts = {}) {
    const C = KINDS[kind];
    if (!C) return null;
    try {
      const v = new C(this, { id: opts.id ?? kind, seed: this.vehicles.length * 1.37 });
      v.build();
      this.vehicles.push(v);
      return v;
    } catch (e) {
      console.error(`[vehicles] failed to build ${kind}`, e);
      return null;
    }
  }

  placeOnGround(v, dir, fwd, lift) {
    const R = this.world.body.radius;
    const h = this.ground.supportAt(_v.copy(dir).multiplyScalar(R));
    const pos = dir.clone().normalize().multiplyScalar(R + h + (lift ?? v.restHeight ?? 1));
    v.place(pos, fwd);
    v.settle?.();
  }

  spawnAll() {
    if (!this.ground.solid) return;
    const sp = this.spawnPoint();
    this.spawn = sp;
    const up = _u.copy(sp.pos).normalize();
    const fwd = sp.fwd;
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const view = this.params.view;
    const taken = [];
    // props=0 (civcam, creature showcases with &fauna=): only the vehicle we start in
    const pp = this.params.props;
    const noProps = pp === '0' || pp === 0 || pp === false || pp === 'false' || (this.params.fauna !== undefined && this.params.fauna !== null && this.params.fauna !== '');
    this.noProps = noProps;
    const mk = (kind, angleDeg, dist, opts) => {
      if (!KINDS[kind]) return null;
      if (noProps && view !== kind) return null;
      let spot;
      if (view === kind) spot = { dir: sp.pos.clone().normalize() };
      else {
        const a = angleDeg * Math.PI / 180;
        const dir = fwd.clone().multiplyScalar(Math.cos(a)).addScaledVector(right, Math.sin(a)).normalize();
        spot = this.findSpot(sp.pos, dir, dist, { ...opts, avoid: taken });
        // never park a rover/ship on the seabed (e.g. when the player spawns swimming)
        if (spot.wet) return null;
      }
      const v = this.add(kind);
      if (!v) return null;
      const heading = view === kind ? fwd.clone() : fwd.clone().applyAxisAngle(up, (opts?.turn ?? 0) * Math.PI / 180);
      this.placeOnGround(v, spot.dir, heading);
      v.pristine = true;
      taken.push(v.pos.clone());
      return v;
    };
    mk('bike', 38, 5.5, { footprint: 1.2, maxSlope: 0.35, dry: false, turn: -20, keep: KEEP.bike });
    mk('rover', -48, 9.5, { footprint: 2.2, maxSlope: 0.25, turn: 25, keep: KEEP.rover });
    mk('ship', -18, 34, { footprint: 7, maxSlope: 0.12, turn: 35, keep: KEEP.ship });
  }

  // ------------------------------------------------------------------ enter / exit
  enter(v) {
    if (!v || this.active === v) return;
    this.cool = 0.35;
    this.baseFov = this.world.camera.fov || this.baseFov;
    try {
      if (this.world.setController) this.world.setController(v);
      else { this.world.controller = v; v.onControlGained?.(); }
    } catch (e) { console.error('[vehicles] enter failed', e); }
  }
  onEnter(v) {
    this.active = v;
    this.lastUsed = v.type;
    this._clearPrompt();
    this.audio('play', 'vehicle.enter', { type: v.type });
    this.world.events?.emit?.('vehicle:enter', { type: v.type, vehicle: v });
    this.engine.ui?.hint?.(this._hintFor(v), 5500);
  }
  onExit(v) {
    if (this.active === v) this.active = null;
    this.audio('play', 'vehicle.exit', { type: v.type });
    this.audio('set', 'engine', 0); this.audio('set', 'boost', 0);
    if (this._danger) { this._danger = 0; this.audio('set', 'danger', 0); }
    this.world.events?.emit?.('vehicle:exit', { type: v.type, vehicle: v });
    this.engine.ui?.setTelemetry?.(null);
    const cam = this.world.camera;
    if (Math.abs(cam.fov - this.baseFov) > 0.01) { cam.fov = this.baseFov; cam.updateProjectionMatrix(); }
    if (this.blur) this.blur.strength = 0;
  }

  exit(v) {
    const pl = this.world.player;
    if (!pl) { this.engine.ui?.hint?.('No pilot to disembark', 2000); return; }
    if (v.canExit && !v.canExit()) { this.engine.ui?.hint?.(v.exitHint ?? 'Cannot exit here', 2200); return; }
    this.cool = 0.4;
    const p = v.exitPoint(new THREE.Vector3());
    // keep the player out of the water / colliders if possible
    const R = this.world.body.radius, g = this.ground;
    let h = g.terrainAt(p);
    if (g.hasOcean && h < g.sea) {
      v.exitPoint(p); p.addScaledVector(v.rightVec, 2 * (v.exitSide ?? 1.4));
      h = Math.max(g.terrainAt(p), g.sea);
    }
    p.normalize().multiplyScalar(R + Math.max(h, g.hasOcean ? g.sea : -1e9) + 0.05);
    try {
      if (typeof pl.teleport === 'function') pl.teleport(p);
      else { pl.pos?.copy(p); }
      pl.vel?.set?.(0, 0, 0);
      if (pl.forward?.isVector3) orthoForward(_u.copy(p).normalize(), v.fwdVec, pl.forward);
      if (pl.bodyFacing?.isVector3) pl.bodyFacing.copy(pl.forward);
    } catch (e) { console.error('[vehicles] player teleport failed', e); }
    try {
      if (this.world.setController) this.world.setController(pl);
      else { this.world.controller = pl; v.onControlLost?.(); }
    } catch (e) { console.error('[vehicles] exit failed', e); }
  }

  _hintFor(v) {
    const dev = this.engine.ui?.device || this.engine.input?.lastDevice;
    if (dev === 'touch') return v.type === 'ship' ? 'Left stick throttle/roll · drag to steer · buttons: boost, up/down' : 'Left stick drive · drag to look · boost & jump buttons';
    if (dev === 'gamepad') return v.type === 'ship' ? 'LS throttle/roll · RS steer · RT boost · A up · B down · Y exit' : 'LS drive · RS look · RT boost · A jump · Y exit';
    if (v.type === 'ship') return 'Mouse steer · W/S throttle · A/D roll · Shift boost/pulse · Space up · C down · V view · F exit';
    if (v.type === 'rover') return 'W/S drive · A/D steer · Space handbrake · Shift boost · E lights · V view · F exit';
    return 'W/S throttle · A/D steer · Shift boost · Space hop · V view · F exit';
  }

  _clearPrompt() { if (this.prompt) { this.engine.ui?.clearPrompt?.('vehicle'); this.prompt = null; } }

  summon() {
    const pl = this.world.player;
    if (!pl?.pos) return;
    const kind = this.lastUsed && KINDS[this.lastUsed] ? this.lastUsed : 'bike';
    let v = this.vehicles.find((x) => x.type === kind);
    if (!v) v = this.add(kind);          // props=0 sessions spawn nothing parked
    if (!v || v.occupied) return;
    const up = _u.copy(pl.pos).normalize();
    const f = pl.forward ? orthoForward(up, pl.forward, new THREE.Vector3()) : headingDir(up, 0, new THREE.Vector3());
    const dist = kind === 'ship' ? 26 : kind === 'rover' ? 6 : 4;
    const spot = this.findSpot(pl.pos, f, dist, { footprint: kind === 'ship' ? 7 : 2, maxSlope: kind === 'ship' ? 0.14 : 0.3, dry: kind !== 'bike' });
    this.placeOnGround(v, spot.dir, f.clone().applyAxisAngle(up, 0.6));
    v.pristine = false;
    v.materialize?.();
    this.audio('play', 'warp', { intensity: 0.4 });
    this.world.events?.emit?.('discovery', { kind: 'Summoned', name: v.displayName ?? v.type });
  }

  // ------------------------------------------------------------------ helpers
  audio(kind, name, v) {
    const a = this.engine.audio;
    if (!a) return;
    try { if (kind === 'set') a.setParam?.(name, v); else a.play?.(name, v || {}); } catch (_) { /* audio optional */ }
  }

  sparksAt(p, n, count) {
    const s = this.fx.sparks, r = this.rand;
    for (let i = 0; i < count; i++) {
      const vx = n.x * 4 + r.signed() * 6, vy = n.y * 4 + r.signed() * 6, vz = n.z * 4 + r.signed() * 6;
      s.spawn(p.x, p.y, p.z, vx, vy, vz, { life: 0.35 + r.next() * 0.4, size0: 0.05, size1: 0.02, alpha: 1, color: _e.set(6, 3.2, 1.2), drag: 2.5, grav: 9 });
    }
  }

  _updateEnv(dt) {
    const w = this.world;
    const sceneEnv = w.scene.environment;
    if (sceneEnv) {
      if (this._envState !== 'scene') {
        this._envState = 'scene';
        for (const ms of this._mats || []) for (const m of [ms.body, ms.glass, ms.decal, ms.rider]) { if (!m) continue; m.envMap = null; m.needsUpdate = true; }
      }
      return;
    }
    if (!this.probe) return;
    const made = this.probe.update(dt, this.active ? this.active.radialUp : (this.spawn ? _u.copy(this.spawn.pos).normalize() : null));
    if (made) {
      const tex = this.probe.texture;
      const first = this._envState !== 'probe';
      this._envState = 'probe';
      this._envTex = tex;
      for (const ms of this._mats || []) for (const m of [ms.body, ms.glass, ms.decal, ms.rider]) { if (!m) continue; m.envMap = tex; if (first) m.needsUpdate = true; }
    }
  }

  // ------------------------------------------------------------------ frame
  update(dt, t) {
    const w = this.world, input = w.input;
    this.cool = Math.max(0, this.cool - dt);
    this.colliders.sync(dt);
    if (!this.placed) {
      const fl = w.get?.('flora'), cv = w.get?.('civ');
      let ready = true;
      try { if (fl?.isReady && !fl.isReady()) ready = false; if (cv?.isReady && !cv.isReady()) ready = false; } catch (_) { /* ignore */ }
      if (ready || performance.now() - this._t0 > 45000) {
        this.placed = true;
        try { this.finalizePlacement(); } catch (e) { console.error('[vehicles] placement failed', e); }
      }
    }
    this._updateEnv(dt);

    const cam = w.camera.position;
    const pl = w.player;
    const onFoot = pl && w.controller === pl;
    // enter / exit / summon
    if (this.active && w.controller !== this.active) {
      // someone else took control (e.g. player track teleport) — release gracefully
      const a = this.active; this.active = null; a.occupied = false;
    }
    if (this.active) {
      if (this.cool <= 0 && input.down('vehicle')) this.exit(this.active);
      else if (input.down('view') && this.active.camera) this.active.camera.toggle();
    } else if (onFoot) {
      let best = null, bd = 1e9;
      for (const v of this.vehicles) {
        const d = v.pos.distanceTo(pl.pos) - v.enterRadius;
        if (d < bd) { bd = d; best = v; }
      }
      if (best && bd < 0) {
        if (this.prompt !== best) { this.engine.ui?.prompt?.('vehicle', best.promptText, 'vehicle'); this.prompt = best; }
        if (this.cool <= 0 && input.down('vehicle')) this.enter(best);
        this.holdT = 0;
      } else {
        this._clearPrompt();
        if (input.held('vehicle')) { this.holdT += dt; if (this.holdT > 0.6 && this.cool <= 0) { this.summon(); this.holdT = -10; this.cool = 1; } }
        else this.holdT = 0;
      }
    } else this._clearPrompt();

    // simulate & animate
    for (const v of this.vehicles) {
      try {
        v.distToCam = v.pos.distanceTo(cam);
        if (v.occupied && v.speed > 1.5 && this.placed) v.pristine = false;
        const vis = v.occupied || v.distToCam < (v.parkCull ?? v.cullDist ?? 1600);
        if (vis !== v.visible) { v.visible = vis; v.group.visible = vis; }
        if ((v.occupied || v.awake) && dt > 0) {
          const steps = v.substeps ?? 1;
          const h = dt / steps;
          for (let i = 0; i < steps; i++) v.simulate(h, input, i === steps - 1);
          v.syncTransform();
        }
        if (vis) v.animate(dt, t);
        this._weather(v, dt);
      } catch (e) {
        if (++this.errors < 5) console.error(`[vehicles] ${v.type} update failed`, e);
      }
    }
    // camera for the active vehicle (after physics)
    const a = this.active;
    if (a) {
      try { a.updateCamera(dt, input); } catch (e) { if (++this.errors < 5) console.error('[vehicles] camera failed', e); }
      this._activeFeedback(a, dt);
    }
    // vehicle vs vehicle nudges
    this._vehicleContacts();
    for (const k in this.fx) this.fx[k].update(dt);
  }

  _weather(v, dt) {
    const u = v.mats?.body?.userData?.u;
    if (!u) return;
    const rain = G.uWetness.value || 0;
    v.wet = Math.max(v.wet ?? 0, rain);
    if (v.onWater || v.inWater) v.wet = 1;
    v.wet = Math.max(rain, (v.wet ?? 0) - dt * 0.03);
    u.uWet.value = v.wet;
    // night fill tinted by the world's accent (neon cities glow magenta, campfire worlds amber)
    const night = G.uNight.value || 0;
    if (!this._fillBase) {
      const acc = new THREE.Color(this.world.body.art?.palette?.accent || '#9fb4ff');
      this._fillBase = new THREE.Color(0.55, 0.62, 0.8).lerp(acc, 0.45).multiplyScalar(0.05 * (1 + Math.min(4, this.world.body.civ?.level ?? 0) * 0.12));
    }
    u.uFill.value.copy(this._fillBase).multiplyScalar(night);
    const ru = v.mats?.rider?.userData?.u;
    if (ru) { ru.uWet.value = v.wet * 0.8; ru.uFill.value.copy(u.uFill.value); }
    if (v.occupied && v.speed > 3 && !v.onWater && v.type !== 'ship') u.uDirt.value = Math.min(1, u.uDirt.value + dt * v.speed * 0.00035);
    if (v.dustColor) u.uDirtColor.value.lerp(v.dustColor, dampF01(dt * 0.05));
  }

  _vehicleContacts() {
    const a = this.active;
    if (!a) return;
    for (const v of this.vehicles) {
      if (v === a || !v.visible) continue;
      const rr = (a.colliderRadius ?? 1) + (v.colliderRadius ?? 1);
      _v.copy(a.pos).sub(v.pos);
      const d = _v.length();
      if (d < rr && d > 1e-4) {
        _v.divideScalar(d);
        a.pos.addScaledVector(_v, rr - d);
        const vn = a.vel.dot(_v);
        if (vn < 0) { a.vel.addScaledVector(_v, -vn * 1.2); a.camera?.kick(Math.min(1, -vn * 0.05)); }
      }
    }
  }

  _activeFeedback(a, dt) {
    const sp = a.speed;
    this.audio('set', 'engine', a.engine ?? 0);
    this.audio('set', 'speed', sp);
    this.audio('set', 'boost', a.boost ?? 0);
    if (a.type === 'ship') this.audio('set', 'altitude', a.alt ?? 0);
    // danger: reentry heat, diving at the ground, or a rover about to roll
    let danger = 0;
    if (a.type === 'ship') {
      danger = clamp((a.heat ?? 0) * 0.9, 0, 1);
      if (a.state !== 'landed' && a.agl < 120) {
        const vDown = -a.vel.dot(a.radialUp);
        danger = Math.max(danger, clamp((vDown - 20) / 45, 0, 1) * clamp(1 - a.agl / 120, 0, 1));
      }
    } else if (a.type === 'rover') danger = clamp((0.55 - a.upVec.dot(a.radialUp)) / 0.4, 0, 1);
    if (Math.abs(danger - (this._danger ?? 0)) > 0.02 || (danger === 0 && this._danger)) { this._danger = danger; this.audio('set', 'danger', danger); }
    // speed blur toward the focus of expansion
    if (this.blur) {
      const k = a.blurAmount ? a.blurAmount() : clamp((sp - 34) / 50, 0, 1) * 0.4 + (a.boost ?? 0) * 0.22;
      this.blur.strength = damp(this.blur.strength, a.camera?.mode === 'cockpit' ? k * 0.5 : k, 4, dt);
      const cam = this.world.camera;
      _v.copy(a.vel);
      if (_v.lengthSq() > 1) {
        _v.normalize().multiplyScalar(1000).add(cam.position);
        _v.sub(this.world.origin); // → scene space
        _v.project(cam);
        if (_v.z < 1 && Math.abs(_v.x) < 1.5 && Math.abs(_v.y) < 1.5) this.blur.center.set(clamp(_v.x * 0.5 + 0.5, 0.1, 0.9), clamp(_v.y * 0.5 + 0.5, 0.1, 0.9));
      }
    }
    // streaks
    const sk = a.streakAmount ? a.streakAmount() : { power: clamp((sp - 35) / 40, 0, 1) * 0.5, mode: 'wind' };
    this.streaks.update(dt, a.vel, sk.power, sk.mode);
    // telemetry (5 Hz)
    this.teleT -= dt;
    if (this.teleT <= 0) {
      this.teleT = 0.2;
      const tele = a.telemetry ? a.telemetry() : { speed: fmtSpeed(sp) };
      this.engine.ui?.setTelemetry?.(tele);
    }
  }

  isReady() { return this.placed; }

  getState() {
    const st = { active: this.active ? this.active.type : null, count: this.vehicles.length, env: this._envState, placed: this.placed, colliders: this.colliders.count };
    if (this.rampInfo) st.ramp = this.rampInfo;
    for (const v of this.vehicles) { try { st[v.id] = v.getState(); } catch (_) { /* ignore */ } }
    if (this.active?.camera) st.cam = { mode: this.active.camera.mode, fov: +this.active.camera.fov.toFixed(1) };
    return st;
  }

  dispose() {
    this._clearPrompt();
    for (const v of this.vehicles) { try { v.dispose(); } catch (_) { /* ignore */ } }
    for (const k in this.fx) this.fx[k].dispose();
    this.streaks?.dispose();
    this.blur?.dispose();
    this.probe?.dispose();
    for (const ms of this._mats || []) for (const k in ms) ms[k]?.dispose?.();
  }
}

function dampF01(x) { return 1 - Math.exp(-x); }

export default {
  name: 'vehicles',
  order: 55,
  async create(world) {
    const mgr = new VehicleManager(world);
    world.vehicles = mgr;
    try { mgr.spawnAll(); } catch (e) { console.error('[vehicles] spawn failed', e); }
    // URL view=bike|rover|ship → start inside that vehicle
    const view = world.params?.view;
    const v = mgr.vehicles.find((x) => x.type === view);
    if (v) {
      try {
        if (world.params?.vnear) mgr.placeNear(v, world.params.vnear, +(world.params.vdist ?? 250) || 250);
        if (world.params?.vramp) mgr.placeRamp(v, +world.params.vramp > 20 ? +world.params.vramp : 400);
        v.startFromParams?.(world.params);
        mgr.enter(v);
        v.camera?.update(0, { look: null, allowLook: false, speed: v.speed, radialUp: v.radialUp });
      } catch (e) { console.error('[vehicles] start in vehicle failed', e); }
    }
    return mgr;
  },
};
