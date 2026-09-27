// Fauna subsystem (order 40). OWNED BY THE FAUNA TRACK.
//
// Planets teem with life: procedurally generated species (deterministic from body.seed, styled by
// body.art), streamed around the player in deterministic cells, animated procedurally on the CPU
// (gaits, foot planting IK, look-at, tails, wings…) and rendered with GPU skinning + instancing
// (one or two draw calls per species).
//
// Public API (world.get('fauna')):
//   .roster                       species list [{ id, name, archetype, layer, … }]
//   .creatures                    live individuals (planet-local .pos Float64Array)
//   .nearest(archetype?, from?)   → nearest creature (for cameras / UI markers)
//   .getState()                   counts, draw calls, discovered species
// Events: emits 'discovery' { kind: 'creature', name, species, archetype } once per species seen.
// URL: &fauna=<archetype>  frames a showcase group of that archetype in front of the spawn camera
//      (grazer|giant|hexapod|hopper|critter|birds|rays|whales|jellies|fish|serpent|none).
import * as THREE from 'three';
import { RNG, hashCombine } from '../../core/rng.js';
import { makeRoster } from './species.js';
import { leggedRig, leggedGeometry } from './bodies/legged.js';
import { LeggedAnimator } from './anim/LeggedAnimator.js';
import { Crowd } from './Crowd.js';
import { moveGround, Herd, tangentBasis } from './behavior/ground.js';
import { cellsPerFace, cellsAround, cellDir } from './cells.js';

const LEGGED = new Set(['grazer', 'giant', 'hexapod', 'hopper', 'critter']);
const _v3 = new THREE.Vector3(), _sph = new THREE.Sphere(), _mat = new THREE.Matrix4();
const _e = new Float64Array(3), _n = new Float64Array(3), _d = new Float64Array(3);

class Fauna {
  constructor(world) {
    this.world = world;
    this.engine = world.engine;
    this.q = world.quality || {};
    this.surface = world.surface;
    this.body = world.body;
    this.R = world.body.radius;
    this.sea = this.surface.seaLevel > -1e8 ? this.surface.seaLevel : -1e9;
    this.roster = makeRoster(world.body);
    this.rt = new Map();                      // species id → runtime { rig, animator, crowd }
    this.groups = [];
    this.creatures = [];
    this.cells = new Map();                   // cell key → { groups: [] }
    this.discovered = new Set();
    this._lastDiscovery = -10;
    this.root = new THREE.Group();
    this.root.name = 'fauna';
    world.root.add(this.root);
    const tier = this.q.tier || 'high';
    this.density = { low: 0.35, med: 0.6, high: 1.0, ultra: 1.3 }[tier] ?? 1;
    this.maxCreatures = { low: 40, med: 80, high: 150, ultra: 220 }[tier] ?? 150;
    this.drawDist = 900 * (this.q.drawDistance ?? 1);
    this.lod0Dist = { low: 35, med: 60, high: 95, ultra: 140 }[tier] ?? 95;
    this.cellSize = 210;
    this.N = cellsPerFace(this.R, this.cellSize);
    this.streamR = 620 * Math.min(1.3, this.q.drawDistance ?? 1);
    this._cellSet = new Set();
    this._lastStream = null;
    this._streamT = 0;
    this.frame = 0;
    this.t = 0;
    this.ready = false;
    this.frustum = new THREE.Frustum();
    this.playerPos = new Float64Array(3);
    this.playerHead = new Float64Array(3);
    this._prevPlayer = null;
    this.playerSpeed = 0;
    const self = this;
    this.env = {
      R: this.R, sea: this.sea, t: 0,
      player: this.playerPos, playerHead: this.playerHead, playerSpeed: 0, playerOnGround: true,
      height: (x, y, z) => self.surface.height(x, y, z),
      ground(x, y, z, out, o = 0) {
        const l = Math.hypot(x, y, z) || 1;
        const dx = x / l, dy = y / l, dz = z / l;
        const h = self.surface.height(dx, dy, dz);
        const r = self.R + h;
        out[o] = dx * r; out[o + 1] = dy * r; out[o + 2] = dz * r;
        return h;
      },
    };
    this.animCtx = { ground: this.env.ground, sample: true, t: 0 };
    this.showcase = String(world.params?.fauna ?? '').toLowerCase();
  }

  // ------------------------------------------------------------------------------ species runtime
  runtime(sp) {
    let rt = this.rt.get(sp.id);
    if (rt) return rt;
    if (LEGGED.has(sp.archetype)) {
      const rig = leggedRig(sp.genome);
      const lods = [leggedGeometry(rig, 0), leggedGeometry(rig, 1)];
      const animator = new LeggedAnimator(rig);
      const crowd = new Crowd(this.root, { name: sp.name, bones: rig.nb, pivots: rig.pivots, lods, look: sp.look, castShadow: !!this.q.shadows, capacity: 16 });
      rt = { rig, animator, crowd, radius: Math.max(rig.length, rig.height) * 0.6, height: rig.height };
    }
    this.rt.set(sp.id, rt);
    return rt;
  }

  // ------------------------------------------------------------------------------ spawning
  _makeCreature(sp, rt, gpos, fwd, scale, seed01, rng) {
    const g = sp.genome;
    const up = new Float64Array(3);
    const l = Math.hypot(gpos[0], gpos[1], gpos[2]);
    up[0] = gpos[0] / l; up[1] = gpos[1] / l; up[2] = gpos[2] / l;
    const f = Float64Array.from(fwd);
    const d = f[0] * up[0] + f[1] * up[1] + f[2] * up[2];
    f[0] -= up[0] * d; f[1] -= up[1] * d; f[2] -= up[2] * d;
    const fl = Math.hypot(f[0], f[1], f[2]) || 1; f[0] /= fl; f[1] /= fl; f[2] /= fl;
    const c = {
      species: sp, rt, index: 0,
      pos: Float64Array.from(gpos), up, fwd: f, vel: new Float64Array(3), want: new Float64Array(3),
      poseRoot: Float64Array.from(gpos),
      speed: 0, wantSpeed: 0, turnRate: 0,
      turnSpeed: sp.archetype === 'giant' ? 0.5 : sp.archetype === 'critter' ? 4 : 1.8,
      walkSpeed: g.walkSpeed * scale, accel: sp.archetype === 'giant' ? 0.6 : 2.5, decel: sp.archetype === 'giant' ? 0.8 : 3.5,
      maxSlope: sp.archetype === 'hexapod' ? 2.5 : 1.2,
      scale, seed: seed01, glow: sp.glowing ? 1 : 0, fade: 1, alert: 0, grazeTarget: 0, look: null,
      h: undefined, lod: 1, dist: 1e9, animAcc: 0, visible: false,
    };
    rt.animator.init(c, rng);
    return c;
  }

  /** Spawn a herd of species sp around ground point center (planet-local). */
  _spawnHerd(sp, center, rng, count) {
    const rt = this.runtime(sp);
    if (!rt) return null;
    const g = sp.genome;
    const n = count ?? rng.int(sp.group[0], sp.group[1]);
    const members = [];
    const ul = Math.hypot(center[0], center[1], center[2]);
    const ux = center[0] / ul, uy = center[1] / ul, uz = center[2] / ul;
    tangentBasis(ux, uy, uz, _e, _n);
    const baseA = rng.range(0, Math.PI * 2);
    const spacing = (g.S * g.bodyLen + g.S * 0.8) * 1.15;
    for (let i = 0; i < n; i++) {
      const a = i * 2.39996 + rng.range(-0.4, 0.4);
      const r = spacing * (0.4 + Math.sqrt(i + rng.next()) * 1.05);
      const px = center[0] + (_e[0] * Math.cos(a) + _n[0] * Math.sin(a)) * r;
      const py = center[1] + (_e[1] * Math.cos(a) + _n[1] * Math.sin(a)) * r;
      const pz = center[2] + (_e[2] * Math.cos(a) + _n[2] * Math.sin(a)) * r;
      const h = this.env.ground(px, py, pz, _d, 0);
      if (h < this.sea + 0.6) continue;
      const head = baseA + rng.range(-0.9, 0.9);
      const fx = _e[0] * Math.cos(head) + _n[0] * Math.sin(head), fy = _e[1] * Math.cos(head) + _n[1] * Math.sin(head), fz = _e[2] * Math.cos(head) + _n[2] * Math.sin(head);
      const juvenile = rng.chance(sp.archetype === 'giant' ? 0.25 : 0.18);
      const scale = juvenile ? rng.range(0.5, 0.65) : rng.range(0.88, 1.12);
      const c = this._makeCreature(sp, rt, _d, [fx, fy, fz], scale, rng.next(), rng);
      c.index = i;
      members.push(c);
    }
    if (!members.length) return null;
    const herd = new Herd(sp, members, center, rng.fork('herd'), this.env);
    for (const m of members) { m.group = herd; this.creatures.push(m); }
    this.groups.push(herd);
    return herd;
  }

  _removeGroup(grp) {
    const i = this.groups.indexOf(grp);
    if (i >= 0) this.groups.splice(i, 1);
    const set = new Set(grp.members);
    this.creatures = this.creatures.filter((c) => !set.has(c));
  }

  /** biome-weighted species choice for a ground point */
  _pickGround(rng, dir, h, layerFilter) {
    const smp = this.surface.sample(dir[0], dir[1], dir[2], {});
    const biome = smp.biome;
    let total = 0;
    const cands = [];
    for (const sp of this.roster) {
      if (sp.layer !== 'ground' || (layerFilter && !layerFilter(sp))) continue;
      const w = (sp.habitat?.[biome] ?? 0.05) * (sp.density ?? 1);
      if (w <= 0) continue;
      cands.push([sp, w]); total += w;
    }
    if (!cands.length) return null;
    return rng.weighted(cands);
  }

  _streamCells() {
    const P = this.playerPos;
    const l = Math.hypot(P[0], P[1], P[2]);
    const ux = P[0] / l, uy = P[1] / l, uz = P[2] / l;
    const alt = l - this.R - Math.max(0, this.surface.height(ux, uy, uz));
    if (alt > 2500) return;               // high above: no ground population streaming
    cellsAround(ux, uy, uz, this.R, this.streamR, this.cellSize, this.N, this._cellSet);
    const seed = this.body.seed;
    // spawn new cells
    for (const key of this._cellSet) {
      if (this.cells.has(key)) continue;
      const entry = { groups: [] };
      this.cells.set(key, entry);
      const rng = new RNG(hashCombine(seed, 0xce11, key));
      const pGroup = Math.min(0.85, (0.3 + 0.55 * (this.body.life?.fauna ?? 0.5)) * this.density);
      const tries = 2;
      for (let k = 0; k < tries; k++) {
        if (!rng.chance(k === 0 ? pGroup : pGroup * 0.35)) continue;
        cellDir(key, this.N, _d, rng.range(0.15, 0.85), rng.range(0.15, 0.85));
        const h = this.surface.height(_d[0], _d[1], _d[2]);
        if (h < this.sea + 2) continue;
        const sp = this._pickGround(rng, _d, h);
        if (!sp) continue;
        if (this.creatures.length > this.maxCreatures) continue;
        const r = this.R + h;
        const center = new Float64Array([_d[0] * r, _d[1] * r, _d[2] * r]);
        const grp = this._spawnHerd(sp, center, rng.fork('g' + k));
        if (grp) entry.groups.push(grp);
      }
    }
    // despawn far cells (hysteresis: not in the enlarged set)
    const keep = new Set();
    cellsAround(ux, uy, uz, this.R, this.streamR * 1.3, this.cellSize, this.N, keep);
    for (const [key, entry] of this.cells) {
      if (keep.has(key) || key === 'welcome') continue;
      for (const g of entry.groups) this._removeGroup(g);
      this.cells.delete(key);
    }
  }

  /** A showcase group in front of the spawn camera (the player lands and sees life at once). */
  _welcome() {
    if (this.showcase === 'none') return;
    const cam = this.world.camera;
    const P = this.playerPos;
    const l = Math.hypot(P[0], P[1], P[2]);
    const ux = P[0] / l, uy = P[1] / l, uz = P[2] / l;
    // camera forward projected on the tangent plane
    cam.getWorldDirection(_v3);
    let fx = _v3.x, fy = _v3.y, fz = _v3.z;
    const d = fx * ux + fy * uy + fz * uz;
    fx -= ux * d; fy -= uy * d; fz -= uz * d;
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    const rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;   // right
    const rng = new RNG(hashCombine(this.body.seed, 0x3e1c, Math.round(P[0]), Math.round(P[1]), Math.round(P[2])));
    const want = this.showcase;
    const filter = LEGGED.has(want) ? (sp) => sp.archetype === want : null;
    let sp = filter ? this.roster.find(filter) : null;
    for (let attempt = 0; attempt < 14; attempt++) {
      const ang = [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6, 2.2, -2.2, 2.8, -2.8, 3.1][attempt];
      const c = Math.cos(ang), s = Math.sin(ang);
      const dx = fx * c + rx * s, dy = fy * c + ry * s, dz = fz * c + rz * s;
      const probe = sp || this.roster.find((x) => x.layer === 'ground' && x.archetype === 'grazer');
      if (!probe) return;
      const g = probe.genome;
      const dist = Math.min(95, Math.max(16, 11 + g.S * 16 + (probe.archetype === 'giant' ? 40 : 0))) * (attempt > 5 ? 0.7 : 1);
      const px = P[0] + dx * dist + rx * dist * 0.12, py = P[1] + dy * dist + ry * dist * 0.12, pz = P[2] + dz * dist + rz * dist * 0.12;
      const h = this.env.ground(px, py, pz, _d, 0);
      if (h < this.sea + 2) continue;
      if (!sp) sp = this._pickGround(rng, [ux, uy, uz], h, (x) => x.archetype !== 'critter') || probe;
      const grp = this._spawnHerd(sp, Float64Array.from(_d), rng.fork('welcome'), sp.archetype === 'giant' ? rng.int(3, 4) : rng.int(Math.max(4, sp.group[0]), Math.max(6, sp.group[1])));
      if (grp) { this.cells.set('welcome', { groups: [grp] }); grp.welcome = true; }
      return;
    }
  }

  // ------------------------------------------------------------------------------ frame
  _updatePlayer(dt) {
    const w = this.world;
    const ctrl = w.controller;
    const src = (ctrl && ctrl.pos) || w.player?.pos || w.camera.position;
    const P = this.playerPos;
    if (this._prevPlayer && dt > 0) {
      const v = Math.hypot(src.x - this._prevPlayer[0], src.y - this._prevPlayer[1], src.z - this._prevPlayer[2]) / dt;
      this.playerSpeed += (Math.min(v, 200) - this.playerSpeed) * Math.min(1, dt * 4);
    }
    P[0] = src.x; P[1] = src.y; P[2] = src.z;
    this._prevPlayer = this._prevPlayer || new Float64Array(3);
    this._prevPlayer[0] = P[0]; this._prevPlayer[1] = P[1]; this._prevPlayer[2] = P[2];
    const l = Math.hypot(P[0], P[1], P[2]) || 1;
    this.playerHead[0] = P[0] + P[0] / l * 1.6; this.playerHead[1] = P[1] + P[1] / l * 1.6; this.playerHead[2] = P[2] + P[2] / l * 1.6;
    const alt = l - this.R - Math.max(0, this.surface.height(P[0] / l, P[1] / l, P[2] / l));
    this.env.playerSpeed = this.playerSpeed;
    this.env.playerOnGround = alt < 40;
  }

  update(dt, t) {
    this.t = t;
    this.env.t = t; this.animCtx.t = t;
    this.frame++;
    this._updatePlayer(dt);
    if (!this.ready) {
      this._welcome();
      this._streamCells();
      this.ready = true;
    } else {
      this._streamT -= dt;
      const P = this.playerPos, L = this._lastStream;
      const moved = !L || Math.hypot(P[0] - L[0], P[1] - L[1], P[2] - L[2]) > 60;
      if (moved || this._streamT <= 0) {
        this._streamCells();
        this._lastStream = Float64Array.from(P);
        this._streamT = 2.0;
      }
    }
    if (dt <= 0) { this._animateAll(0); return; }
    for (const g of this.groups) g.update(dt, this.env);
    for (const c of this.creatures) {
      const every = c.dist < this.lod0Dist ? 1 : c.dist < 250 ? 3 : 6;
      moveGround(c, dt, this.env, every);
    }
    this._animateAll(dt);
  }

  _animateAll(dt) {
    const f = this.frame;
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      c.animAcc += dt;
      const interval = !c.visible ? 8 : c.dist < this.lod0Dist ? 1 : c.dist < 220 ? 2 : 4;
      if (dt > 0 && (f + i) % interval !== 0) continue;
      this.animCtx.sample = c.dist < this.lod0Dist * 1.6;
      const adt = Math.min(c.animAcc, 0.25);
      c.animAcc = 0;
      c.rt.animator.update(c, adt, this.animCtx);
      c.poseRoot[0] = c.pos[0]; c.poseRoot[1] = c.pos[1]; c.poseRoot[2] = c.pos[2];
    }
  }

  lateUpdate() {
    const w = this.world, cam = w.camera;
    this.root.position.copy(w.origin);
    this.root.updateMatrixWorld(true);
    cam.updateMatrixWorld();
    _mat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_mat, THREE.WebGLCoordinateSystem, !!cam.reversedDepth);
    const O = w.origin;
    const cp = cam.position;   // planet-local (camera is a child of root)
    for (const rt of this.rt.values()) rt.crowd.begin();
    for (const c of this.creatures) {
      const rt = c.rt;
      const s = c.scale;
      const hx = c.pos[0] + c.up[0] * rt.height * 0.5 * s, hy = c.pos[1] + c.up[1] * rt.height * 0.5 * s, hz = c.pos[2] + c.up[2] * rt.height * 0.5 * s;
      const dist = Math.hypot(hx - cp.x, hy - cp.y, hz - cp.z);
      c.dist = dist;
      c.visible = false;
      if (dist > this.drawDist * (c.species.archetype === 'giant' ? 2.2 : 1)) continue;
      _sph.center.set(hx - O.x, hy - O.y, hz - O.z);
      _sph.radius = rt.radius * s * 1.3 + 2;
      if (dist > 30 && !this.frustum.intersectsSphere(_sph)) continue;
      c.visible = true;
      // distance fade-in at the far edge
      const far = this.drawDist * (c.species.archetype === 'giant' ? 2.2 : 1);
      c.fade = Math.min(1, (far - dist) / (far * 0.12));
      rt.crowd.add(c, dist < this.lod0Dist * (0.7 + 0.3 * s) ? 0 : 1);
    }
    for (const rt of this.rt.values()) rt.crowd.commit(O);
    if (this.frame % 15 === 0) this._discover();
  }

  _discover() {
    if (this.t - this._lastDiscovery < 2.5) return;
    let best = null, bestD = Infinity;
    for (const c of this.creatures) {
      const sp = c.species;
      if (!c.visible || this.discovered.has(sp.id)) continue;
      const lim = sp.archetype === 'giant' ? 220 : sp.archetype === 'critter' ? 25 : 70;
      if (c.dist < lim && c.dist < bestD) { best = c; bestD = c.dist; }
    }
    if (!best) return;
    const sp = best.species;
    this.discovered.add(sp.id);
    this._lastDiscovery = this.t;
    this.world.events.emit('discovery', { kind: 'creature', name: sp.name, species: sp.id, archetype: sp.archetype });
  }

  nearest(archetype = null, from = null) {
    const P = from || this.playerPos;
    let best = null, bd = Infinity;
    for (const c of this.creatures) {
      if (archetype && c.species.archetype !== archetype) continue;
      const d = Math.hypot(c.pos[0] - P[0], c.pos[1] - P[1], c.pos[2] - P[2]);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  isReady() { return this.ready; }

  getState() {
    let drawn = 0, calls = 0;
    for (const rt of this.rt.values()) { drawn += rt.crowd.drawn; for (const m of rt.crowd.meshes) if (m.visible) calls++; }
    return {
      species: this.roster.length,
      groups: this.groups.length,
      creatures: this.creatures.length,
      drawn, meshes: calls,
      discovered: [...this.discovered].map((id) => this.roster[id]?.name),
    };
  }

  onOriginShift() { /* positions are planet-local; the root group follows the origin in lateUpdate */ }

  dispose() {
    for (const rt of this.rt.values()) rt.crowd.dispose();
    this.rt.clear();
    this.root.removeFromParent();
    this.groups.length = 0; this.creatures.length = 0;
  }
}

export default {
  name: 'fauna',
  order: 40,
  async create(world) {
    if (!world.surface || world.body.isGas) return null;
    const f = new Fauna(world);
    if (!f.roster.length) { f.dispose(); return null; }
    // pre-build species meshes (yield between species so loading stays responsive)
    for (const sp of f.roster) {
      try { f.runtime(sp); } catch (e) { console.error('[fauna] species build failed', sp.name, e); }
      await new Promise((r) => setTimeout(r, 0));
    }
    return f;
  },
};
