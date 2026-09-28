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
    this.sun = {
      dir: new THREE.Vector3(0, 1, 0), angularRadius: 0.005, color: this.star ? this.star.color.clone() : new THREE.Color(1, 1, 1),
      visibility: 1, screen: new THREE.Vector2(), onScreen: false,
    };
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
    if (this.sky) this._safe('sky', () => this.sky.update(dt, t, ctx));
    if (this.star) this._safe('star', () => this.star.update(dt, t, ctx));
    if (this.bodiesSys) this._safe('bodies', () => this.bodiesSys.update(dt, t, ctx));
    if (this.small) this._safe('small', () => this.small.update(dt, t, ctx));
    this._safe('sun', () => this._updateSun(ctx));
  }

  _updateSun(ctx) {
    const w = this.world, cel = w.celestial, s = this.sun;
    s.dir.copy(cel.sunDir);
    s.angularRadius = this.star ? this.star.angularRadius : 0.005;
    // horizon occlusion by the current body (sea-level sphere) + eclipses by other bodies
    const camR = ctx.camLocal.length();
    const R = w.body.radius;
    const up = _v.copy(ctx.camLocal).divideScalar(Math.max(camR, 1));
    const sinDip = Math.sqrt(Math.max(0, 1 - (R * R) / Math.max(camR * camR, R * R)));
    const elev = up.dot(s.dir) + sinDip;      // > 0 : above the geometric horizon
    let vis = THREE.MathUtils.smoothstep(elev, -s.angularRadius, s.angularRadius);
    if (this.bodiesSys) vis *= this.bodiesSys.sunVisibility(ctx.camLocal, cel);
    s.visibility = vis;
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

  /** Fraction of the star disk visible from a planet-local point (eclipses by moons/planets). */
  sunVisibility(localPos) { return this.bodiesSys ? this.bodiesSys.sunVisibility(localPos, this.world.celestial) : 1; }

  /** Camera yaw/pitch (degrees, player URL convention: yaw 0 = north, 90 = east) to look at a body from a local position. */
  aim(ref, fromLocal = this.ctx.camLocal) {
    const e = this.bodies.find((x) => x.b.id === ref || x.b.id.endsWith('-' + ref) || x.b.name === ref);
    let target = ref === 'sun' ? _v2.copy(this.world.celestial.sunDir).multiplyScalar(1e12) : e ? e.local : null;
    if (ref === 'galcenter' && this.sky) {
      const p = this.world.star.position;
      target = _v2.set(-p.x, -p.y, -p.z).normalize().applyMatrix3(this.sky.uG2L.value).multiplyScalar(1e12);
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

  isReady() { return this.sky ? this.sky.isReady() : true; }

  getState() {
    return {
      sky: this.sky ? (this.sky.ready ? 'baked' : this.sky.failed ? 'failed' : 'baking') : 'none',
      stars: this.sky?.starCount ?? 0,
      bodies: this.bodies.filter((e) => e.mesh?.visible || e.ring?.visible).map((e) => e.b.id),
      sunVis: +this.sun.visibility.toFixed(3),
      sunAng: +(this.sun.angularRadius * 180 / Math.PI).toFixed(3),
    };
  }

  dispose() {
    this.sky?.dispose(); this.star?.dispose(); this.bodiesSys?.dispose(); this.small?.dispose();
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
