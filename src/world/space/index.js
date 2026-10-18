// SPACE subsystem (order 5). OWNED BY THE SPACE TRACK. See docs/tracks/space.md.
//
// Everything in the sky and in space except the current planet's own ground/atmosphere:
//   sky.js         host-galaxy night sky: Milky-Way band baked from GalaxyModel (worker + GPU cube),
//                  resolved local stars with real colours/fluxes, nebula glows, distant galaxies
//   star.js        the star: limb-darkened HDR disk, granulation, spots, prominences, corona, glare
//   bodies.js      other planets/moons (+ the current body when it is a gas giant): rocky & gas
//                  shaders, atmosphere limb shells, rings (+ shadows both ways), eclipses, far dots
//   smallBodies.js asteroid belts (Keplerian particle streams) and comets (ion + dust tails)
// Everything is a background for the atmosphere pass (far plane / real depth beyond the air), so the
// atmosphere track attenuates it by transmittance and hides faint stars by day.
//
// Public API: world.space = this instance
//   sun { dir (local unit), angularRadius, color (linear), visibility (0..1: horizon + eclipses),
//         screen (NDC Vector2), onScreen }            → lens flare / glare hooks for the post track
//   sunVisibility(localPos) → 0..1 fraction of the star disk visible past other bodies (eclipses)
//   bodies (entries: { b, local (planet-local Vector3) })   aim(bodyRef) → { yaw, pitch } helper
import * as THREE from 'three';
import './shaders.js';
import { Sky } from './sky.js';
import { Star } from './star.js';
import { Bodies } from './bodies.js';
import { SmallBodies } from './smallBodies.js';
import { Wonder, pickWonder } from './wonder.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _size = new THREE.Vector2();

class Space {
  constructor(world) {
    this.world = world;
    this.engine = world.engine;
    this.group = new THREE.Group();
    this.group.name = 'space';
    world.root.add(this.group);
    world.space = this;
    this._err = {};
    const tryMake = (name, fn) => { try { return fn(); } catch (e) { console.error(`[space] ${name} init failed`, e); return null; } };
    this.sky = tryMake('sky', () => new Sky(world, this));
    this.star = tryMake('star', () => new Star(world));
    this.bodiesSys = tryMake('bodies', () => new Bodies(world, this));
    this.small = tryMake('small bodies', () => new SmallBodies(world, this));
    // background layers are drawn camera-independent (far plane); keep them out of world.root's
    // translation by adding to root too (positions are ignored by their vertex shaders)
    if (this.sky) this.group.add(this.sky.group);
    if (this.star) this.group.add(this.star.mesh);
    if (this.bodiesSys) this.group.add(this.bodiesSys.group);
    if (this.small) this.group.add(this.small.group);
    // Cosmic & Otherworldly: a ring of light / a black orb with a pillar of light, on a few worlds
    const wk = tryMake('wonder pick', () => pickWonder(world.body, world.params));
    this.wonder = wk ? tryMake('wonder', () => new Wonder(world, wk)) : null;
    this.sun = {
      dir: new THREE.Vector3(0, 1, 0), angularRadius: 0.005, color: this.star ? this.star.color.clone() : new THREE.Color(1, 1, 1),
      visibility: 1, screen: new THREE.Vector2(), onScreen: false,
    };
    this.eclipse = 0;            // 0..1 fraction of the star disc hidden by bodies (not the horizon) — for atmosphere / post
    this.eclipseBody = null;
    this.ctx = {
      camLocal: new THREE.Vector3(), pixAng: 0.001, pixelRatio: 1, inAtmo: 0, renderer: this.engine.renderer,
      sunIll: new THREE.Vector3(6, 6, 6),
    };
  }

  get bodies() { return this.bodiesSys ? this.bodiesSys.entries : []; }

  _safe(name, fn) {
    if ((this._err[name] || 0) > 5) return;
    try { fn(); } catch (e) { this._err[name] = (this._err[name] || 0) + 1; if (this._err[name] < 3) console.error(`[space] ${name} failed`, e); }
  }

  lateUpdate(dt, t) {
    const w = this.world, cam = w.camera, ctx = this.ctx;
    cam.getWorldPosition(ctx.camLocal).add(w.origin);
    const r = this.engine.renderer;
    r.getDrawingBufferSize(_size);
    const hpx = Math.max(_size.y, 1);
    ctx.pixelRatio = r.getPixelRatio ? r.getPixelRatio() : 1;
    ctx.pixAng = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov || 60) / 2) / hpx;
    const body = w.body;
    const atmTop = body.radius + (body.atmosphere?.present ? (body.atmosphere.height || 0) : 0);
    const camR = ctx.camLocal.length();
    ctx.inAtmo = body.atmosphere?.present ? 1 - THREE.MathUtils.smoothstep(camR, body.radius + (atmTop - body.radius) * 0.5, atmTop) : 0;
    // illuminance at the current body (same scale the atmosphere track uses)
    const atm = w.atmosphere;
    const E = atm?.model?.sunIlluminance ?? 6;
    const sc = this.star ? this.star.color : null;
    const lum = sc ? Math.max(1e-3, sc.r * 0.2126 + sc.g * 0.7152 + sc.b * 0.0722) : 1;
    // chromatic adaptation like the atmosphere track (keep ~35% of the star tint)
    if (atm?.starColor) ctx.sunIll.set(atm.starColor.r * E, atm.starColor.g * E, atm.starColor.b * E);
    else if (sc) ctx.sunIll.set(THREE.MathUtils.lerp(1, sc.r / lum, 0.35) * E, THREE.MathUtils.lerp(1, sc.g / lum, 0.35) * E, THREE.MathUtils.lerp(1, sc.b / lum, 0.35) * E);
    // Workaround (see docs/tracks/space.md Requests): the atmosphere track's rocky-planet cumulus shell
    // covers a gas giant's banded cloud deck (which this track renders). Until that track declares it
    // handles gas giants (`atmosphere.gasGiantSurface`), switch its cloud shell off for gas bodies.
    if (!this._gasCloudsDone && body.isGas && atm) {
      this._gasCloudsDone = true;
      if (!atm.gasGiantSurface && atm.clouds && atm.clouds.present) { atm.clouds.present = false; atm.clouds.enabled = false; }
    }
    if (this.sky) this._safe('sky', () => this.sky.update(dt, t, ctx));
    if (this.star) this._safe('star', () => this.star.update(dt, t, ctx));
    if (this.bodiesSys) this._safe('bodies', () => this.bodiesSys.update(dt, t, ctx));
    if (this.small) this._safe('small', () => this.small.update(dt, t, ctx));
    if (this.wonder) this._safe('wonder', () => this.wonder.update(dt, t, ctx));
    this._safe('sun', () => this._updateSun(ctx));
  }

  _updateSun(ctx) {
    const w = this.world, cel = w.celestial, s = this.sun;
    s.dir.copy(cel.sunDir);
    s.angularRadius = this.star ? this.star.angularRadius : 0.005;
    // horizon occlusion by the current body (sea-level sphere) + eclipses by other bodies
    const camR = ctx.camLocal.length();
    const R = this._visRadius();
    const up = _v.copy(ctx.camLocal).divideScalar(Math.max(camR, 1));
    const sinDip = Math.sqrt(Math.max(0, 1 - (R * R) / Math.max(camR * camR, R * R)));
    const elev = up.dot(s.dir) + sinDip;      // > 0 : above the geometric horizon
    let vis = THREE.MathUtils.smoothstep(elev, -s.angularRadius, s.angularRadius);
    if (this.bodiesSys) vis *= this.bodiesSys.sunVisibility(ctx.camLocal, cel);
    s.visibility = vis;
    this._updateEclipse(ctx, camR, R);
    // screen position (NDC)
    const cam = w.camera;
    _v2.copy(s.dir).applyQuaternion(_q.copy(cam.quaternion).invert());
    s.onScreen = false;
    if (_v2.z < 0) {
      const f = 1 / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
      s.screen.set((_v2.x / -_v2.z) * f / cam.aspect, (_v2.y / -_v2.z) * f);
      s.onScreen = Math.abs(s.screen.x) < 1.2 && Math.abs(s.screen.y) < 1.2;
    }
  }

  /** Eclipse as an event: which body covers the star as seen from the camera, how much (this.eclipse 0..1,
   *  the fraction of the star disc hidden by bodies — not by the horizon), and the eclipse ring around it. */
  _updateEclipse(ctx, camR, R) {
    const es = this._es || (this._es = { vis: 1, bestS: 0, best: { dir: new THREE.Vector3(), ang: 0, sep: 0, tint: new THREE.Color(), strength: 0, id: null } });
    es.vis = 1; es.bestS = 0;
    for (const e of this.bodies) {
      if (e.isCurrent) continue;
      if (e.mesh && !e.mesh.visible) continue;
      this._eclConsider(ctx, e.app || e.local, e.visR || e.b.radius, !!e.b.atmosphere?.present, !!e.b.isGas, e.b.id);
    }
    // the current planet itself, seen from above its air (orbit / ship): its night disc eclipses the star
    const b = this.world.body;
    const inside = Math.max(ctx.inAtmo, 1 - THREE.MathUtils.smoothstep(camR - b.radius, b.radius * 0.03, b.radius * 0.12));
    if (inside < 0.5) {
      const top = R + (b.atmosphere?.present ? (b.atmosphere.height || 0) * 0.25 : 0);
      const v0 = es.vis;
      this._eclConsider(ctx, _v2.set(0, 0, 0), top, !!b.atmosphere?.present, !!b.isGas, b.id);
      es.vis = v0 + (es.vis - v0) * (1 - inside * 2);
    }
    this.eclipse = THREE.MathUtils.clamp(1 - es.vis, 0, 1);
    const on = es.bestS > 0.002;
    es.best.strength = es.bestS;
    this.eclipseBody = on ? es.best.id : null;
    this.star?.setEclipse(on ? es.best : null, ctx);
  }

  _eclConsider(ctx, centre, r, atm, gas, id) {
    const es = this._es, L = this.world.celestial.sunDir, rs = Math.max(this.sun.angularRadius, 1e-6);
    _v.copy(centre).sub(ctx.camLocal);
    const d = _v.length();
    if (d < r * 1.0001) return;
    const along = _v.dot(L);
    if (along <= 0) return;
    const sep = Math.acos(THREE.MathUtils.clamp(along / d, -1, 1));
    const ro = Math.asin(Math.min(1, r / d));
    if (sep > ro + rs * 4 + ctx.pixAng * 6) return;
    let x = THREE.MathUtils.clamp((sep - Math.abs(ro - rs)) / Math.max(ro + rs - Math.abs(ro - rs), 1e-9), 0, 1);
    x = x * x * (3 - 2 * x);
    const full = ro >= rs ? 0 : 1 - (ro * ro) / (rs * rs);
    es.vis *= full + (1 - full) * x;
    // the ring needs a disc larger than the star; it grows as the star slips behind the limb
    const st = (1 - THREE.MathUtils.smoothstep(sep, ro - rs * 0.5, ro + rs * 2.5 + ctx.pixAng * 4)) * THREE.MathUtils.smoothstep(ro / rs, 1.0, 1.6);
    if (st > es.bestS) {
      es.bestS = st;
      const best = es.best;
      best.dir.copy(_v).divideScalar(d); best.ang = ro; best.sep = sep; best.id = id;
      if (atm) best.tint.setRGB(1.0, gas ? 0.62 : 0.5, gas ? 0.32 : 0.24); else best.tint.setRGB(1.0, 0.93, 0.86);
    }
  }

  /** Radius of the current body's visible disk (a gas giant's drawn cloud deck sits above body.radius). */
  _visRadius() {
    if (this._curEntry === undefined) this._curEntry = this.bodies.find((e) => e.isCurrent && e.visR) || null;
    return this._curEntry ? this._curEntry.visR : this.world.body.radius;
  }

  /** Fraction of the star disk visible from a planet-local point (eclipses by moons/planets). */
  sunVisibility(localPos) { return this.bodiesSys ? this.bodiesSys.sunVisibility(localPos, this.world.celestial) : 1; }

  /** Camera yaw/pitch (degrees, player URL convention: yaw 0 = north, 90 = east) to look at a body from a local position. */
  aim(ref, fromLocal = this.ctx.camLocal) {
    ref = this._resolveRef(ref);
    const e = this.bodies.find((x) => x.b.id === ref || x.b.id.endsWith('-' + ref) || x.b.name === ref);
    let target = ref === 'sun' ? _v2.copy(this.world.celestial.sunDir).multiplyScalar(1e12) : e ? e.local : null;
    const cm = /^comet(\d+)$/.exec(ref);
    if (cm && this.small?.comets[+cm[1]]) target = this.small.comets[+cm[1]].head;
    if (ref === 'galcenter' && this.sky) {
      const p = this.world.star.position;
      target = _v2.set(-p.x, -p.y, -p.z).normalize().applyMatrix3(this.sky.uG2L.value).multiplyScalar(1e12);
    }
    if (ref === 'wonder' && this.wonder) target = this.wonder.target(_v2);
    if ((ref === 'pulsar' || ref === 'nebula' || ref === 'nebula1') && this.sky) {
      const g = ref === 'pulsar' ? this.sky.pulsarDir : this.sky.heroNebulae?.[ref === 'nebula1' ? 1 : 0]?.dir;
      if (g) target = _v2.copy(g).applyMatrix3(this.sky.uG2L.value).multiplyScalar(1e12);
    }
    if (!target) return null;
    const d = _v.copy(target).sub(fromLocal).normalize();
    const up = fromLocal.clone().normalize();
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
    const east = new THREE.Vector3().crossVectors(north, up);
    const pitch = Math.asin(THREE.MathUtils.clamp(d.dot(up), -1, 1)) * 180 / Math.PI;
    const yaw = Math.atan2(d.dot(east), d.dot(north)) * 180 / Math.PI;
    return { yaw: +yaw.toFixed(1), pitch: +pitch.toFixed(1) };
  }

  /** 'parent' → the planet a moon orbits (else the body that looks biggest in the sky); 'moon' → the
   *  biggest-looking moon; 'biggest' → the body with the largest angular size. Other refs pass through. */
  _resolveRef(ref) {
    if (ref !== 'parent' && ref !== 'moon' && ref !== 'biggest') return ref;
    const cur = this.world.body, sys = this.world.system;
    if (ref === 'parent' && cur.isMoon && sys?.planets?.[cur.parent]) return sys.planets[cur.parent].id;
    let best = null, bestA = -1;
    for (const e of this.bodies) {
      if (e.isCurrent || (ref === 'moon' && !e.b.isMoon)) continue;
      const d = Math.max(_v.copy(e.app || e.local).sub(this.ctx.camLocal).length(), 1);
      const a = (e.b.rings ? e.b.rings.outer * 0.6 : e.b.radius) / d;
      if (a > bestA) { bestA = a; best = e.b.id; }
    }
    return best || ref;
  }

  /** Angular radius (deg) and direction info of a sky object as seen from the camera: { yaw, pitch, angDeg }. */
  skyInfo(ref) {
    const id = this._resolveRef(ref);
    const e = this.bodies.find((x) => x.b.id === id);
    const a = this.aim(id);
    if (!a || !e) return a;
    const d = Math.max(_v.copy(e.app || e.local).sub(this.ctx.camLocal).length(), 1);
    return { ...a, id, mag: +(e.mag || 1).toFixed(2), angDeg: +(Math.atan(e.b.radius / d) * 180 / Math.PI).toFixed(2), ringDeg: e.b.rings ? +(Math.atan(e.b.rings.outer / d) * 180 / Math.PI).toFixed(2) : 0 };
  }

  /** Capture helper (view=fp/surface): turn the player camera toward a sky object ('0-2-2', 'sun',
   *  'galcenter', 'comet0', 'parent', 'moon', 'biggest'), optionally offset by (dYawDeg, dPitchDeg). Steps: {"eval":"__rv.world.space.look('galcenter')"} */
  look(ref, dYaw = 0, dPitch = 0) {
    const pl = this.world.player, cam = pl?.cam;
    if (!cam) return null;
    const from = pl.pos || this.ctx.camLocal;
    const a = this.aim(ref, from);
    if (!a) return null;
    const up = from.clone().normalize();
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
    const east = new THREE.Vector3().crossVectors(north, up);
    const y = (a.yaw + dYaw) * Math.PI / 180;
    cam.fwd.copy(north).multiplyScalar(Math.cos(y)).addScaledVector(east, Math.sin(y)).normalize();
    cam.pitch = THREE.MathUtils.clamp((a.pitch + dPitch) * Math.PI / 180, -1.45, 1.45);
    cam.idleLook = 0;
    return a;
  }

  /** Capture helper (view=fp/surface): frame two sky objects together, e.g. the parent giant and the
   *  galactic core — looks at the point a fraction f of the way from refA to refB (on the sky). */
  frame(refA, refB, f = 0.5, dYaw = 0, dPitch = 0) {
    const pl = this.world.player, cam = pl?.cam;
    if (!cam) return null;
    const from = pl.pos || this.ctx.camLocal;
    const a = this.aim(refA, from), b = this.aim(refB, from);
    if (!a || !b) return null;
    const toV = (o) => { const y = o.yaw * Math.PI / 180, p = o.pitch * Math.PI / 180; return new THREE.Vector3(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y)); };
    const d = toV(a).multiplyScalar(1 - f).add(toV(b).multiplyScalar(f)).normalize();
    const yaw = Math.atan2(d.z, d.x) * 180 / Math.PI, pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)) * 180 / Math.PI;
    const up = from.clone().normalize();
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
    const east = new THREE.Vector3().crossVectors(north, up);
    const y = (yaw + dYaw) * Math.PI / 180;
    cam.fwd.copy(north).multiplyScalar(Math.cos(y)).addScaledVector(east, Math.sin(y)).normalize();
    cam.pitch = THREE.MathUtils.clamp((pitch + dPitch) * Math.PI / 180, -1.45, 1.45);
    cam.idleLook = 0;
    return { yaw: +yaw.toFixed(1), pitch: +pitch.toFixed(1), a, b };
  }

  /** Capture helper (view=surface/fp): stand on dry land `dist` metres from the wonder (bearing `bearDeg` from
   *  the site, 0 = north) and look at it. Steps: {"eval":"__rv.world.space.wonderShot(9000)"},{"advance":1.5},
   *  {"eval":"__rv.world.space.look('wonder',0,-8)"} */
  wonderShot(dist = 9000, bearDeg = 200) {
    const w = this.world, W = this.wonder, pl = w.player, surf = w.surface;
    if (!W || !pl?.teleport || !surf) return null;
    const R = w.body.radius, up = W.up;
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
    const east = new THREE.Vector3().crossVectors(north, up);
    const sea = Number.isFinite(surf.seaLevel) ? surf.seaLevel : -Infinity;
    const d = new THREE.Vector3(), eye = new THREE.Vector3(), p = new THREE.Vector3();
    const target = W.target(new THREE.Vector3());
    let fallback = null;
    // nearest bearing first, a few distances: dry land with a clear line of sight to the wonder
    for (let k = 0; k < 48; k++) {
      const b = (bearDeg + Math.ceil(k / 2) * 15 * (k % 2 ? 1 : -1)) * Math.PI / 180;
      for (const f of [1, 0.75, 1.3, 0.55]) {
        const a = (dist * f) / R;
        d.copy(up).multiplyScalar(Math.cos(a)).addScaledVector(north, Math.sin(a) * Math.cos(b)).addScaledVector(east, Math.sin(a) * Math.sin(b)).normalize();
        const h = surf.height(d.x, d.y, d.z);
        if (!(h > sea + 3)) continue;
        try { if (surf.normal(d, p, 6).dot(d) < 0.975) continue; } catch (_) { /* optional */ }   // flat footing
        eye.copy(d).multiplyScalar(R + h + 2);
        if (!fallback) fallback = { pos: d.clone().multiplyScalar(R + h + 1.5), b, h };
        let clear = true;
        for (let i = 1; i < 40 && clear; i++) {
          p.lerpVectors(eye, target, i / 40);
          const rr = p.length();
          p.divideScalar(rr);
          if (surf.height(p.x, p.y, p.z) + R > rr - 5) clear = false;
        }
        if (clear) {
          pl.teleport(d.clone().multiplyScalar(R + h + 1.5));
          return { ok: true, bearing: +(b * 180 / Math.PI).toFixed(1), dist: Math.round(dist * f), h: Math.round(h) };
        }
      }
    }
    if (fallback) { pl.teleport(fallback.pos); return { ok: false, bearing: +(fallback.b * 180 / Math.PI).toFixed(1), h: Math.round(fallback.h) }; }
    return null;
  }

  /** Capture helper: find dry land near (lat, lon) within `spanDeg` and teleport the player there. */
  dryLand(lat, lon, spanDeg = 8) {
    const w = this.world, pl = w.player, surf = w.surface;
    if (!pl?.teleport || !surf) return null;
    const sea = Number.isFinite(surf.seaLevel) ? surf.seaLevel : -Infinity;
    const R = w.body.radius, d = new THREE.Vector3();
    for (let k = 0; k < 400; k++) {
      const rr = spanDeg * Math.sqrt(k / 400), a = k * 2.39996;
      const la = lat + rr * Math.cos(a), lo = lon + rr * Math.sin(a) / Math.max(0.2, Math.cos(la * Math.PI / 180));
      const cl = Math.cos(la * Math.PI / 180);
      d.set(cl * Math.sin(lo * Math.PI / 180), Math.sin(la * Math.PI / 180), cl * Math.cos(lo * Math.PI / 180));
      const h = surf.height(d.x, d.y, d.z);
      let flat = true;
      try { flat = surf.normal(d, new THREE.Vector3(), 6).dot(d) > 0.97; } catch (_) { /* optional */ }
      if (h > sea + 4 && flat) { pl.teleport(d.clone().multiplyScalar(R + h + 1.5)); return { lat: +la.toFixed(2), lon: +lo.toFixed(2), h: Math.round(h) }; }
    }
    return null;
  }

  /** Capture helper (view=orbit): put the orbit camera so the star sits `deg` degrees from the planet
   *  centre, behind it (deg < planet angular radius → eclipse / backlit rim; a bit more → sun at the limb).
   *  Usage in shoot steps: {"eval":"__rv.world.space.orbitSunShot(21, 10)"}, then {"advance":0.5}. */
  orbitSunShot(deg = 21, rollDeg = 0) {
    const o = this.world.player?.cam?.orbit;
    if (!o) return false;
    const s = this.world.celestial.sunDir;
    const axis = new THREE.Vector3(0, 1, 0).cross(s);
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
    axis.normalize().applyAxisAngle(s, rollDeg * Math.PI / 180);
    const c = s.clone().negate().applyAxisAngle(axis, deg * Math.PI / 180);
    o.yaw = Math.atan2(c.x, c.z);
    o.pitch = Math.asin(THREE.MathUtils.clamp(c.y, -1, 1));
    return true;
  }

  /** Capture helper (view=orbit): star just `offDeg` degrees outside (+) or inside (-) the planet's limb as
   *  seen from the orbit camera → diamond-ring / backlit-crescent glare shots. */
  orbitLimbShot(offDeg = 0.3, rollDeg = 0) {
    const o = this.world.player?.cam?.orbit;
    if (!o) return false;
    const R = this._visRadius();
    const d = Math.max(this.ctx.camLocal.length(), R * 1.001);
    const limb = Math.asin(Math.min(1, R / d)) * 180 / Math.PI;
    return this.orbitSunShot(limb + offDeg, rollDeg);
  }

  isReady() { return this.sky ? this.sky.isReady() : true; }

  getState() {
    return {
      sky: this.sky ? (this.sky.ready ? 'baked' : this.sky.failed ? 'failed' : 'baking') : 'none',
      stars: this.sky?.starCount ?? 0,
      bodies: this.bodies.filter((e) => e.mesh?.visible || e.ring?.visible).map((e) => e.b.id),
      sunVis: +this.sun.visibility.toFixed(3),
      sunAng: +(this.sun.angularRadius * 180 / Math.PI).toFixed(3),
      eclipse: +(this.eclipse || 0).toFixed(3), eclipseBody: this.eclipseBody || null,
      wonder: this.wonder ? this.wonder.state() : null,
    };
  }

  dispose() {
    this.sky?.dispose(); this.star?.dispose(); this.bodiesSys?.dispose(); this.small?.dispose(); this.wonder?.dispose();
    this.group.removeFromParent();
    if (this.world.space === this) this.world.space = null;
  }
}

const _q = new THREE.Quaternion();

export default {
  name: 'space',
  order: 5,
  async create(world) { return new Space(world); },
};
