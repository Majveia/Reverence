// Fauna subsystem (order 40). OWNED BY THE FAUNA TRACK.
//
// Planets teem with life: procedurally generated species (deterministic from body.seed, styled by
// body.art), streamed around the player in deterministic cells, animated procedurally on the CPU
// (gaits, foot planting IK, look-at, tails, wing flaps, fin undulation, bell pulses…) and rendered
// with GPU skinning + instancing (one or two draw calls per species) plus one particle draw call
// (fireflies / pollen / insects).
//
// Layers: ground (herds of legged species) · air (bird flocks, sky rays) · sky (sky-whale pods)
//         · float (jellyfish swarms) · water (fish schools near the shore).
//
// Public API (world.get('fauna')):
//   .roster                       species list [{ id, name, archetype, layer, … }]
//   .creatures                    live individuals (planet-local .pos Float64Array)
//   .nearest(archetype?, from?)   → nearest creature (for cameras / UI markers)
//   .getState()                   counts, draw calls, discovered species
// Events: emits 'discovery' { kind: 'creature', name, species, archetype } once per species seen.
// URL: &fauna=<archetype>  frames a showcase group of that archetype in front of the spawn camera
//      (grazer|giant|hexapod|hopper|critter|birds|rays|whales|jellies|fish|none).
import * as THREE from 'three';
import { RNG, hashCombine } from '../../core/rng.js';
import { makeRoster } from './species.js';
import { leggedRig, leggedGeometry } from './bodies/legged.js';
import { chainRig, chainGeometry } from './bodies/chain.js';
import { LeggedAnimator } from './anim/LeggedAnimator.js';
import { ChainAnimator } from './anim/ChainAnimator.js';
import { Crowd } from './Crowd.js';
import { moveGround, Herd, tangentBasis } from './behavior/ground.js';
import { Flock, Pod, Swarm, School } from './behavior/air.js';
import { cellsPerFace, cellsAround, cellDir } from './cells.js';
import { Motes } from './particles.js';

const LEGGED = new Set(['grazer', 'giant', 'hexapod', 'hopper', 'critter']);
const SHOW = { birds: 'bird', bird: 'bird', rays: 'ray', ray: 'ray', whales: 'whale', whale: 'whale', jellies: 'jelly', jelly: 'jelly', fish: 'fish' };
// per archetype: draw distance (m), LOD0 distance, discovery distance
const DIST = {
  grazer: [900, 95, 70], giant: [2000, 160, 220], hexapod: [900, 95, 70], hopper: [700, 70, 60], critter: [300, 40, 25],
  bird: [750, 70, 140], ray: [1200, 140, 220], whale: [7000, 1100, 1800], jelly: [600, 90, 90], fish: [180, 30, 45],
};
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
    this.hasOcean = !!world.body.ocean?.present && this.surface.seaLevel > -1e8;
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
    this.tierK = { low: 0.4, med: 0.65, high: 1.0, ultra: 1.3 }[tier] ?? 1;
    this.density = { low: 0.35, med: 0.6, high: 1.0, ultra: 1.3 }[tier] ?? 1;
    this.maxCreatures = { low: 90, med: 180, high: 320, ultra: 450 }[tier] ?? 320;
    this.dd = Math.min(1.4, this.q.drawDistance ?? 1);
    this.lodK = { low: 0.4, med: 0.65, high: 1.0, ultra: 1.4 }[tier] ?? 1;
    this.cellSize = 210;
    this.N = cellsPerFace(this.R, this.cellSize);
    this.airCell = 800; this.NA = cellsPerFace(this.R, this.airCell);
    this.skyCell = 3200; this.NS = cellsPerFace(this.R, this.skyCell);
    this.fishCell = 260; this.NF = cellsPerFace(this.R, this.fishCell);
    this.streamR = 620 * Math.min(1.3, this.dd);
    this._cellSet = new Set();
    this._keep = new Set();
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
    this.showDist = Math.max(0.3, Math.min(4, parseFloat(world.params?.faunadist ?? 1) || 1));   // showcase distance multiplier
    this.motes = null;
    try { this.motes = new Motes(this); } catch (e) { console.warn('[fauna] motes disabled', e); }
  }

  // ------------------------------------------------------------------------------ species runtime
  runtime(sp) {
    let rt = this.rt.get(sp.id);
    if (rt) return rt;
    const shadows = !!this.q.shadows;
    if (LEGGED.has(sp.archetype)) {
      const rig = leggedRig(sp.genome);
      const lods = [leggedGeometry(rig, 0), leggedGeometry(rig, 1)];
      const animator = new LeggedAnimator(rig);
      const crowd = new Crowd(this.root, { name: sp.name, bones: rig.nb, pivots: rig.pivots, lods, look: sp.look, castShadow: shadows, capacity: 16 });
      rt = { rig, animator, crowd, radius: Math.max(rig.length, rig.height) * 0.6, height: rig.height, centerUp: rig.height * 0.5 };
    } else {
      const rig = chainRig(sp.genome);
      const lods = [chainGeometry(rig, 0), chainGeometry(rig, 1)];
      const animator = new ChainAnimator(rig);
      const jelly = sp.archetype === 'jelly';
      const crowd = new Crowd(this.root, {
        name: sp.name, bones: rig.nb, pivots: rig.pivots, lods, look: sp.look, capacity: 16,
        castShadow: shadows && (sp.archetype === 'whale' || sp.archetype === 'bird' || sp.archetype === 'ray'),
        transparent: jelly, opacity: 0.72, renderOrder: jelly ? 2 : 0,
      });
      rt = { rig, animator, crowd, radius: rig.radius, height: rig.height, centerUp: rig.center || 0 };
    }
    const D = DIST[sp.archetype] || [800, 90, 70];
    rt.far = D[0] * (sp.archetype === 'whale' ? 1 : this.dd);
    rt.lod0 = D[1] * this.lodK;
    rt.discover = D[2];
    this.rt.set(sp.id, rt);
    return rt;
  }

  // ------------------------------------------------------------------------------ spawning (ground)
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
  _spawnHerd(sp, center, rng, count, heading) {
    const rt = this.runtime(sp);
    if (!rt) return null;
    const g = sp.genome;
    const n = count ?? rng.int(sp.group[0], sp.group[1]);
    const members = [];
    const ul = Math.hypot(center[0], center[1], center[2]);
    const ux = center[0] / ul, uy = center[1] / ul, uz = center[2] / ul;
    tangentBasis(ux, uy, uz, _e, _n);
    const baseA = heading ?? rng.range(0, Math.PI * 2);
    const spacing = (g.S * g.bodyLen + g.S * 0.8) * 1.15;
    for (let i = 0; i < n; i++) {
      const a = i * 2.39996 + rng.range(-0.4, 0.4);
      const r = spacing * (0.4 + Math.sqrt(i + rng.next()) * 1.05);
      const px = center[0] + (_e[0] * Math.cos(a) + _n[0] * Math.sin(a)) * r;
      const py = center[1] + (_e[1] * Math.cos(a) + _n[1] * Math.sin(a)) * r;
      const pz = center[2] + (_e[2] * Math.cos(a) + _n[2] * Math.sin(a)) * r;
      const h = this.env.ground(px, py, pz, _d, 0);
      if (h < this.sea + 0.6) continue;
      const head = baseA + rng.range(-0.9, 0.9) * (heading !== undefined ? 0.5 : 1);
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

  // ------------------------------------------------------------------------------ spawning (air/sky/water)
  _makeFlyer(sp, rt, pos, fwd, scale, rng) {
    const up = new Float64Array(3);
    const l = Math.hypot(pos[0], pos[1], pos[2]);
    up[0] = pos[0] / l; up[1] = pos[1] / l; up[2] = pos[2] / l;
    const f = Float64Array.from(fwd);
    const fl = Math.hypot(f[0], f[1], f[2]) || 1; f[0] /= fl; f[1] /= fl; f[2] /= fl;
    const c = {
      species: sp, rt, air: true, index: 0,
      pos: Float64Array.from(pos), up, fwd: f, vel: new Float64Array(3), off: new Float64Array(3),
      poseRoot: Float64Array.from(pos),
      speed: 0, turnRate: 0, climb: 0, flap: 1, bank: 0,
      scale, seed: rng.next(), glow: sp.glowing ? 1 : 0, fade: 1, alert: 0, look: null,
      dist: 1e9, animAcc: 0, visible: false,
    };
    rt.animator.init(c, rng);
    return c;
  }

  /** point `agl` meters above the ground (or sea) under planet-local p */
  _above(p, agl, out) {
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    const h = Math.max(this.sea, this.surface.height(p[0] / l, p[1] / l, p[2] / l));
    const r = this.R + h + agl;
    out[0] = p[0] / l * r; out[1] = p[1] / l * r; out[2] = p[2] / l * r;
    return h;
  }

  /** spawn an air/sky/float/water group of species sp centred on planet-local ground point `home` */
  _spawnAir(sp, home, rng, count, opts = {}) {
    const rt = this.runtime(sp);
    if (!rt) return null;
    const g = sp.genome, A = sp.archetype;
    const n = Math.max(1, Math.round((count ?? rng.int(sp.group[0], sp.group[1])) * (A === 'bird' || A === 'fish' ? Math.max(0.5, this.tierK) : 1)));
    const ul = Math.hypot(home[0], home[1], home[2]);
    tangentBasis(home[0] / ul, home[1] / ul, home[2] / ul, _e, _n);
    const head = opts.heading ?? rng.range(0, Math.PI * 2);
    const fx = _e[0] * Math.cos(head) + _n[0] * Math.sin(head), fy = _e[1] * Math.cos(head) + _n[1] * Math.sin(head), fz = _e[2] * Math.cos(head) + _n[2] * Math.sin(head);
    const members = [];
    const P = new Float64Array(3);
    let grp;
    if (A === 'bird' || A === 'ray') {
      const ray = A === 'ray';
      const size = ray ? g.span : g.span;
      const agl = opts.agl ?? (ray ? [18, 60] : [22, 110]);
      const spread = ray ? size * 2.2 : size * 3.2;
      for (let i = 0; i < n; i++) {
        const a = i * 2.39996, r = spread * Math.sqrt(i + 0.5) * 0.7;
        const ox = (_e[0] * Math.cos(a) + _n[0] * Math.sin(a)) * r, oy = (_e[1] * Math.cos(a) + _n[1] * Math.sin(a)) * r, oz = (_e[2] * Math.cos(a) + _n[2] * Math.sin(a)) * r;
        P[0] = home[0] + ox; P[1] = home[1] + oy; P[2] = home[2] + oz;
        this._above(P, (agl[0] + agl[1]) * 0.5 + rng.range(-1, 1) * spread * 0.4, P);
        const c = this._makeFlyer(sp, rt, P, [fx, fy, fz], rng.range(0.85, 1.15), rng);
        c.index = i;
        c.off[0] = ox * 0.35; c.off[1] = oy * 0.35; c.off[2] = oz * 0.35;
        const sp0 = g.speed * (ray ? 1 : 1);
        c.vel[0] = fx * sp0; c.vel[1] = fy * sp0; c.vel[2] = fz * sp0;
        members.push(c);
      }
      grp = new Flock(sp, members, home, rng.fork('flock'), this.env, {
        agl, radius: opts.radius ?? (ray ? rng.range(90, 180) : rng.range(80, 220)), speed: g.speed, ray,
        seek: ray ? 1.2 : 4.0, coh: ray ? 0.02 : 0.06, ali: ray ? 0.4 : 0.9, sep: size * (ray ? 1.6 : 1.3), sepK: ray ? 1.5 : 6,
        fear: ray ? 18 : 30, minAgl: ray ? 10 : 6, wobble: ray ? 0.5 : 2.5,
      });
    } else if (A === 'whale') {
      const agl = opts.agl ?? [140, 320];
      for (let i = 0; i < n; i++) {
        const side = i === 0 ? 0 : (i % 2 ? 1 : -1);
        const back = i === 0 ? 0 : g.L * (0.9 + 0.4 * Math.floor((i - 1) / 2));
        const lx = fy * (home[2] / ul) - fz * (home[1] / ul), ly = fz * (home[0] / ul) - fx * (home[2] / ul), lz = fx * (home[1] / ul) - fy * (home[0] / ul);
        P[0] = home[0] + lx * side * g.L * 0.8 - fx * back; P[1] = home[1] + ly * side * g.L * 0.8 - fy * back; P[2] = home[2] + lz * side * g.L * 0.8 - fz * back;
        const aglI = rng.range(agl[0], agl[1]) + (i ? rng.range(-20, 20) : 0);
        this._above(P, aglI, P);
        const scale = i === 0 ? 1.1 : rng.chance(0.3) ? rng.range(0.45, 0.6) : rng.range(0.8, 1.0);
        const c = this._makeFlyer(sp, rt, P, [fx, fy, fz], scale, rng);
        c.index = i; c.agl = aglI; c.slot = [side * g.L * 0.8, back];
        c.vel[0] = fx * g.speed; c.vel[1] = fy * g.speed; c.vel[2] = fz * g.speed;
        members.push(c);
      }
      grp = new Pod(sp, members, rng.fork('pod'), this.env, { speed: g.speed });
    } else if (A === 'jelly') {
      const agl = opts.agl ?? [5, 38];
      for (let i = 0; i < n; i++) {
        const a = i * 2.39996, r = g.R * 5 * Math.sqrt(i + 0.5);
        P[0] = home[0] + (_e[0] * Math.cos(a) + _n[0] * Math.sin(a)) * r; P[1] = home[1] + (_e[1] * Math.cos(a) + _n[1] * Math.sin(a)) * r; P[2] = home[2] + (_e[2] * Math.cos(a) + _n[2] * Math.sin(a)) * r;
        const aglI = rng.range(agl[0], agl[1]);
        this._above(P, aglI, P);
        const c = this._makeFlyer(sp, rt, P, [fx, fy, fz], rng.chance(0.3) ? rng.range(0.4, 0.65) : rng.range(0.8, 1.2), rng);
        c.index = i; c.agl = aglI;
        members.push(c);
      }
      grp = new Swarm(sp, members, home, rng.fork('swarm'), this.env, { drift: rng.range(0.3, 0.9), range: 60 });
    } else if (A === 'fish') {
      const l = Math.hypot(home[0], home[1], home[2]);
      for (let i = 0; i < n; i++) {
        const a = i * 2.39996, r = g.L * 1.6 * Math.sqrt(i + 0.5);
        const depthT = rng.range(0.5, 1.8);
        P[0] = home[0] + (_e[0] * Math.cos(a) + _n[0] * Math.sin(a)) * r; P[1] = home[1] + (_e[1] * Math.cos(a) + _n[1] * Math.sin(a)) * r; P[2] = home[2] + (_e[2] * Math.cos(a) + _n[2] * Math.sin(a)) * r;
        const pl = Math.hypot(P[0], P[1], P[2]);
        const rr = this.R + this.sea - depthT;
        P[0] *= rr / pl; P[1] *= rr / pl; P[2] *= rr / pl;
        const c = this._makeFlyer(sp, rt, P, [fx, fy, fz], rng.range(0.75, 1.25), rng);
        c.index = i; c.depthT = depthT;
        c.off[0] = (_e[0] * Math.cos(a) + _n[0] * Math.sin(a)) * r * 0.5; c.off[1] = (_e[1] * Math.cos(a) + _n[1] * Math.sin(a)) * r * 0.5; c.off[2] = (_e[2] * Math.cos(a) + _n[2] * Math.sin(a)) * r * 0.5;
        c.vel[0] = fx * g.speed; c.vel[1] = fy * g.speed; c.vel[2] = fz * g.speed;
        members.push(c);
      }
      void l;
      grp = new School(sp, members, home, rng.fork('school'), this.env, { speed: g.speed, range: opts.range ?? 22, seek: 2.5, sep: g.L * 1.1 });
    }
    if (!grp) return null;
    for (const m of members) { m.group = grp; this.creatures.push(m); }
    this.groups.push(grp);
    return grp;
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

  _pickLayer(rng, layer) {
    const cands = this.roster.filter((s) => s.layer === layer).map((s) => [s, s.density ?? 1]);
    return cands.length ? rng.weighted(cands) : null;
  }

  // ------------------------------------------------------------------------------ streaming
  _streamLayer(tag, N, cellSize, radius, ux, uy, uz, spawn) {
    const set = this._cellSet, keep = this._keep;
    cellsAround(ux, uy, uz, this.R, radius, cellSize, N, set);
    for (const key of set) {
      const k = tag + key;
      if (this.cells.has(k)) continue;
      const entry = { groups: [] };
      this.cells.set(k, entry);
      const rng = new RNG(hashCombine(this.body.seed, 0xce11, tag.charCodeAt(0), key));
      try { spawn(key, rng, entry); } catch (e) { console.warn('[fauna] spawn failed', e); }
    }
    cellsAround(ux, uy, uz, this.R, radius * 1.3, cellSize, N, keep);
    for (const [k, entry] of this.cells) {
      if (k[0] !== tag || keep.has(+k.slice(1)) || k === 'welcome') continue;
      for (const g of entry.groups) if (!g.welcome) this._removeGroup(g);
      this.cells.delete(k);
    }
  }

  _streamCells() {
    const P = this.playerPos;
    const l = Math.hypot(P[0], P[1], P[2]);
    const ux = P[0] / l, uy = P[1] / l, uz = P[2] / l;
    const alt = l - this.R - Math.max(0, this.surface.height(ux, uy, uz));
    const F = this.body.life?.fauna ?? 0.5;
    // per-layer budgets so bird flocks / fish schools never starve the herds
    const cnt = this._layerCount || (this._layerCount = {});
    for (const k in cnt) cnt[k] = 0;
    for (const c of this.creatures) { const L = c.species.layer; cnt[L] = (cnt[L] || 0) + 1; }
    const budget = { ground: 0.5, air: 0.4, float: 0.12, sky: 0.05, water: 0.25 };
    let layerNow = 'ground';
    const room = () => (cnt[layerNow] || 0) < this.maxCreatures * (budget[layerNow] ?? 0.3);
    if (alt < 2500) {
      // ground herds
      this._streamLayer('g', this.N, this.cellSize, this.streamR, ux, uy, uz, (key, rng, entry) => {
        const pGroup = Math.min(0.85, (0.3 + 0.55 * F) * this.density);
        for (let k = 0; k < 2; k++) {
          if (!rng.chance(k === 0 ? pGroup : pGroup * 0.35)) continue;
          cellDir(key, this.N, _d, rng.range(0.15, 0.85), rng.range(0.15, 0.85));
          const h = this.surface.height(_d[0], _d[1], _d[2]);
          layerNow = 'ground';
          if (h < this.sea + 2 || !room()) continue;
          const sp = this._pickGround(rng, _d, h);
          if (!sp) continue;
          const r = this.R + h;
          const grp = this._spawnHerd(sp, new Float64Array([_d[0] * r, _d[1] * r, _d[2] * r]), rng.fork('g' + k));
          if (grp) { entry.groups.push(grp); cnt[grp.species.layer] = (cnt[grp.species.layer] || 0) + grp.members.length; }
        }
      });
      // air: flocks, rays, jellies
      this._streamLayer('a', this.NA, this.airCell, 1300 * this.dd, ux, uy, uz, (key, rng, entry) => {
        const tries = [['air', 0.55 * this.density + 0.2], ['air', 0.25 * this.density], ['float', 0.3 * this.density]];
        for (let k = 0; k < tries.length; k++) {
          const [layer, p] = tries[k];
          layerNow = layer;
          if (!rng.chance(p) || !room()) continue;
          const sp = this._pickLayer(rng, layer);
          if (!sp) continue;
          cellDir(key, this.NA, _d, rng.range(0.1, 0.9), rng.range(0.1, 0.9));
          const h = this.surface.height(_d[0], _d[1], _d[2]);
          if (sp.archetype === 'jelly' && h < this.sea + 1) continue;
          const r = this.R + Math.max(h, this.sea);
          const grp = this._spawnAir(sp, new Float64Array([_d[0] * r, _d[1] * r, _d[2] * r]), rng.fork('a' + k));
          if (grp) { entry.groups.push(grp); cnt[grp.species.layer] = (cnt[grp.species.layer] || 0) + grp.members.length; }
        }
      });
      // water: fish schools near the player's shores
      if (this.hasOcean) {
        this._streamLayer('f', this.NF, this.fishCell, 420, ux, uy, uz, (key, rng, entry) => {
          layerNow = 'water';
          if (!rng.chance(0.55 * this.density + 0.2) || !room()) return;
          const sp = this._pickLayer(rng, 'water');
          if (!sp) return;
          for (let k = 0; k < 4; k++) {
            cellDir(key, this.NF, _d, rng.range(0.1, 0.9), rng.range(0.1, 0.9));
            const h = this.surface.height(_d[0], _d[1], _d[2]);
            if (h > this.sea - 1.5 || h < this.sea - 40) continue;
            const r = this.R + this.sea;
            const grp = this._spawnAir(sp, new Float64Array([_d[0] * r, _d[1] * r, _d[2] * r]), rng.fork('f' + k));
            if (grp) { entry.groups.push(grp); cnt.water = (cnt.water || 0) + grp.members.length; }
            return;
          }
        });
      }
    }
    // sky whales (visible from far away, also from low flight)
    if (alt < 12000) {
      this._streamLayer('s', this.NS, this.skyCell, 5200, ux, uy, uz, (key, rng, entry) => {
        layerNow = 'sky';
        if (!rng.chance(0.4 * Math.min(1, this.density + 0.2)) || !room()) return;
        const sp = this._pickLayer(rng, 'sky');
        if (!sp) return;
        cellDir(key, this.NS, _d, rng.range(0.2, 0.8), rng.range(0.2, 0.8));
        const h = Math.max(this.sea, this.surface.height(_d[0], _d[1], _d[2]));
        const r = this.R + h;
        const grp = this._spawnAir(sp, new Float64Array([_d[0] * r, _d[1] * r, _d[2] * r]), rng.fork('s'));
        if (grp) { entry.groups.push(grp); cnt[grp.species.layer] = (cnt[grp.species.layer] || 0) + grp.members.length; }
      });
    }
  }

  // ------------------------------------------------------------------------------ welcome / showcase
  /** is planet-local point p visible from the camera (terrain + big colliders)? */
  _clearView(cam, px, py, pz, lift) {
    const cx = cam.x, cy = cam.y, cz = cam.z;
    const l = Math.hypot(px, py, pz);
    const tx = px + px / l * lift, ty = py + py / l * lift, tz = pz + pz / l * lift;
    for (let i = 1; i < 16; i++) {
      const t = i / 16;
      const x = cx + (tx - cx) * t, y = cy + (ty - cy) * t, z = cz + (tz - cz) * t;
      const r = Math.hypot(x, y, z);
      if (r - this.R < this.surface.height(x / r, y / r, z / r) - 0.05) return false;
    }
    const dx = tx - cx, dy = ty - cy, dz = tz - cz, L2 = dx * dx + dy * dy + dz * dz;
    for (const c of this._nearCol || []) {
      const p = c.pos;
      const t = Math.max(0, Math.min(1, ((p.x - cx) * dx + (p.y - cy) * dy + (p.z - cz) * dz) / L2));
      const qx = cx + dx * t - p.x, qy = cy + dy * t - p.y, qz = cz + dz * t - p.z;
      const rad = (c.radius || Math.max(c.halfExtents?.x || 0, c.halfExtents?.z || 0) || 1) + 0.4;
      if (qx * qx + qy * qy + qz * qz < rad * rad && t > 0.02) return false;
    }
    return true;
  }

  _welcome() {
    if (this.showcase === 'none') return;
    const cam = this.world.camera;
    const C = cam.position;           // planet-local (camera is a child of world.root)
    const l = Math.hypot(C.x, C.y, C.z);
    const ux = C.x / l, uy = C.y / l, uz = C.z / l;
    cam.getWorldDirection(_v3);
    const f3x = _v3.x, f3y = _v3.y, f3z = _v3.z;
    let fx = _v3.x, fy = _v3.y, fz = _v3.z;
    const d = fx * ux + fy * uy + fz * uz;
    fx -= ux * d; fy -= uy * d; fz -= uz * d;
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    const rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;   // right
    const rng = new RNG(hashCombine(this.body.seed, 0x3e1c, Math.round(C.x), Math.round(C.z)));
    this._nearCol = (this.world.colliders || []).filter((c) => c.pos && Math.hypot(c.pos.x - C.x, c.pos.y - C.y, c.pos.z - C.z) < 260);
    const want = SHOW[this.showcase] || this.showcase;
    const entry = { groups: [] };
    this.cells.set('welcome', entry);
    const mark = (g) => { if (g) { g.welcome = true; entry.groups.push(g); } return g; };
    const dirAt = (ang) => { const c = Math.cos(ang), s = Math.sin(ang); return [fx * c + rx * s, fy * c + ry * s, fz * c + rz * s]; };
    const at = (dir, dist, side = 0) => [C.x + dir[0] * dist + rx * side, C.y + dir[1] * dist + ry * side, C.z + dir[2] * dist + rz * side];

    // ---- ground herd (default, or the requested legged archetype)
    const legged = LEGGED.has(want);
    if (!want || legged) {
      let sp = legged ? this.roster.find((x) => x.archetype === want) : null;
      const probe = sp || this.roster.find((x) => x.layer === 'ground' && x.archetype === 'grazer');
      if (probe) {
        const g = probe.genome;
        const base = Math.min(90, Math.max(12, 7 + g.S * (legged ? 7 : 10) + (probe.archetype === 'giant' ? 38 : 0))) * this.showDist;
        const angs = [0, 0.3, -0.3, 0.55, -0.55, 0.8, -0.8];
        let placed = false, fallback = null;
        for (const k of [1, 0.7, 1.4, 0.5]) {
          for (const ang of angs) {
            const p = at(dirAt(ang), base * k);
            const h = this.env.ground(p[0], p[1], p[2], _d, 0);
            if (h < this.sea + 2) continue;
            if (!fallback) fallback = Float64Array.from(_d);
            if (!this._clearView(C, _d[0], _d[1], _d[2], g.S * 1.1)) continue;
            if (!sp) sp = this._pickGround(rng, [ux, uy, uz], h, (x) => x.archetype !== 'critter') || probe;
            // broadside to the camera: heading along the camera's right vector
            const dl = Math.hypot(_d[0], _d[1], _d[2]);
            tangentBasis(_d[0] / dl, _d[1] / dl, _d[2] / dl, _e, _n);
            const hd = Math.atan2(rx * _n[0] + ry * _n[1] + rz * _n[2], rx * _e[0] + ry * _e[1] + rz * _e[2]) + (rng.chance(0.5) ? Math.PI : 0) + 0.35;
            mark(this._spawnHerd(sp, Float64Array.from(_d), rng.fork('welcome'), sp.archetype === 'giant' ? rng.int(3, 4) : rng.int(Math.max(5, sp.group[0]), Math.max(8, sp.group[1])), hd));
            const hg = entry.groups[entry.groups.length - 1];
            if (hg) { hg.timer = 75; hg.tame = true; }   // stay and graze in front of the camera (until approached)
            placed = true;
            break;
          }
          if (placed) break;
        }
        if (!placed && fallback) {
          if (!sp) sp = probe;
          mark(this._spawnHerd(sp, fallback, rng.fork('welcome'), sp.archetype === 'giant' ? 3 : Math.max(6, sp.group[0])));
          const hg = entry.groups[entry.groups.length - 1];
          if (hg) { hg.timer = 75; hg.tame = true; }
        }
      }
    }
    // ---- sky life framed in the spawn view
    const wantSky = SHOW[this.showcase];
    const pick = (a) => this.roster.find((x) => x.archetype === a);
    const F3 = [fx, fy, fz];      // horizontal view direction (the player camera settles near the horizon)
    void f3x; void f3y; void f3z;
    /** point `dist` m along the camera's 3D view ray (turned by yawOff rad, raised by liftDeg) →
     *  { home: ground point beneath, agl } (never below minAgl above ground / sea) */
    const aim = (dist, liftDeg, yawOff = 0, minAgl = 4) => {
      const c = Math.cos(yawOff), s2 = Math.sin(yawOff);
      let dx = F3[0] * c + rx * s2, dy = F3[1] * c + ry * s2, dz = F3[2] * c + rz * s2;
      const lr = liftDeg * Math.PI / 180;
      dx += ux * Math.tan(lr); dy += uy * Math.tan(lr); dz += uz * Math.tan(lr);
      const dl = Math.hypot(dx, dy, dz);
      const px = C.x + dx / dl * dist, py = C.y + dy / dl * dist, pz = C.z + dz / dl * dist;
      const pl = Math.hypot(px, py, pz);
      const gh = Math.max(this.sea, this.surface.height(px / pl, py / pl, pz / pl));
      const agl = Math.max(minAgl, pl - this.R - gh);
      const home = new Float64Array([px / pl * (this.R + gh), py / pl * (this.R + gh), pz / pl * (this.R + gh)]);
      return { home, agl };
    };
    /** heading angle (spawnAir convention) that crosses the view right → left */
    const across = (home, k = 0) => {
      const hl = Math.hypot(home[0], home[1], home[2]);
      tangentBasis(home[0] / hl, home[1] / hl, home[2] / hl, _e, _n);
      return Math.atan2(rx * _n[0] + ry * _n[1] + rz * _n[2], rx * _e[0] + ry * _e[1] + rz * _e[2]) + Math.PI + k;
    };
    if (!want || wantSky === 'bird') {
      const sp = pick('bird');
      if (sp) {
        const { home, agl } = wantSky ? aim(34 * this.showDist, 11, 0.05, 6) : aim(150, 12, 0.3, 25);
        mark(this._spawnAir(sp, home, rng.fork('wb'), wantSky ? Math.max(16, sp.group[1]) : undefined, { agl: [agl, agl + 6], radius: wantSky ? 22 : 90, heading: across(home, 0.4) }));
      }
    }
    if (wantSky === 'ray' || (!want && rng.chance(0.5))) {
      const sp = pick('ray');
      if (sp) {
        const { home, agl } = wantSky ? aim((24 + sp.genome.span * 3) * this.showDist, 8, -0.1, 8) : aim(220, 8, -0.25, 25);
        mark(this._spawnAir(sp, home, rng.fork('wr'), wantSky ? 5 : undefined, { agl: [agl, agl + 8], radius: wantSky ? 35 : 70, heading: across(home, 0.3) }));
      }
    }
    if (wantSky === 'whale' || !want) {
      const sp = pick('whale');
      if (sp) {
        const { home, agl } = wantSky ? aim((200 + sp.genome.L * 2.2) * this.showDist, 5 - 2 * (1 - Math.min(1, this.showDist)), -0.08, 14 + sp.genome.R) : aim(700, 7, 0.2, 90);
        mark(this._spawnAir(sp, home, rng.fork('ww'), wantSky ? 3 : undefined, { agl: [agl, agl + 10], heading: across(home, -0.35) }));
      }
    }
    const tod = +(this.world.params?.tod ?? 0.5);
    if (wantSky === 'jelly' || (!want && (tod > 0.7 || tod < 0.25))) {
      const sp = pick('jelly');
      if (sp) {
        const { home, agl } = wantSky ? aim((14 + sp.genome.R * 5) * this.showDist, 6, 0, 2.5) : aim(60, 5, -0.3, 3);
        mark(this._spawnAir(sp, home, rng.fork('wj'), wantSky ? 12 : undefined, { agl: [Math.max(2.5, agl - 6), agl + 6] }));
      }
    }
    if (wantSky === 'fish' && this.hasOcean) {
      const sp = pick('fish');
      if (sp) {
        // nearest water in front of the camera
        for (let dist = 10; dist < 400; dist *= 1.15) {
          let done = false;
          for (const ang of [0, 0.35, -0.35, 0.7, -0.7, 1.2, -1.2]) {
            const p = at(dirAt(ang), dist);
            const pl = Math.hypot(...p);
            const h = this.surface.height(p[0] / pl, p[1] / pl, p[2] / pl);
            if (h < this.sea - 1.3) {
              const r = this.R + this.sea;
              const g = mark(this._spawnAir(sp, [p[0] / pl * r, p[1] / pl * r, p[2] / pl * r], rng.fork('wf'), 28, { range: 8 }));
              if (g) g.showy = true;          // showcase school: frequent leaps so it reads above the surface
              done = true; break;
            }
          }
          if (done) break;
        }
      }
    }
    this._nearCol = null;
  }

  // ------------------------------------------------------------------------------ frame
  _updatePlayer(dt) {
    const w = this.world;
    const ctrl = w.controller;
    const src = (ctrl && ctrl.pos) || w.player?.pos || w.camera.position;
    const P = this.playerPos;
    if (this._prevPlayer && dt > 0) {
      const jump = Math.hypot(src.x - this._prevPlayer[0], src.y - this._prevPlayer[1], src.z - this._prevPlayer[2]);
      const v = jump / dt;
      if (jump < 60) this.playerSpeed += (Math.min(v, 200) - this.playerSpeed) * Math.min(1, dt * 4);   // ignore teleports
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
      // wait a couple of frames so the player has placed the camera, then frame the showcase
      if (this.frame < 3) return;
      // …and until the other subsystems are ready (vehicles / civ / flora colliders exist) so the
      // showcase group is framed in a clear line of sight
      if (this.frame < 1500) {
        for (const s of this.world.order || []) {
          if (s === this) continue;
          try { if (s.isReady && s.isReady() === false) return; } catch (_) { /* ignore */ }
        }
      }
      try { this._welcome(); } catch (e) { console.warn('[fauna] welcome failed', e); }
      this._streamCells();
      this._lastStream = Float64Array.from(this.playerPos);
      this._streamT = 2.0;
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
    for (const g of this.groups) {
      try { g.update(dt, this.env); } catch (e) { if (!g._err) { g._err = true; console.warn('[fauna] group update failed', e); } }
    }
    for (const c of this.creatures) {
      if (c.air || !c.want) continue;
      const every = c.dist < c.rt.lod0 ? 1 : c.dist < 250 ? 3 : 6;
      moveGround(c, dt, this.env, every);
    }
    this._animateAll(dt);
    this.motes?.update(dt, t);
  }

  _animateAll(dt) {
    const f = this.frame;
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i];
      c.animAcc += dt;
      const l0 = c.rt.lod0;
      const interval = !c.visible ? 8 : c.dist < l0 ? 1 : c.dist < l0 * 2.5 ? 2 : 4;
      if (dt > 0 && (f + i) % interval !== 0) continue;
      this.animCtx.sample = c.dist < l0 * 1.6;
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
      const k = rt.centerUp * s;
      const hx = c.pos[0] + c.up[0] * k, hy = c.pos[1] + c.up[1] * k, hz = c.pos[2] + c.up[2] * k;
      const dist = Math.hypot(hx - cp.x, hy - cp.y, hz - cp.z);
      c.dist = dist;
      c.visible = false;
      const far = rt.far;
      if (dist > far) continue;
      _sph.center.set(hx - O.x, hy - O.y, hz - O.z);
      _sph.radius = rt.radius * s * 1.3 + 2;
      if (dist > 30 && !this.frustum.intersectsSphere(_sph)) continue;
      c.visible = true;
      c.fade = Math.min(1, (far - dist) / (far * 0.12));
      rt.crowd.add(c, dist < rt.lod0 * (0.7 + 0.3 * s) ? 0 : 1);
    }
    for (const rt of this.rt.values()) rt.crowd.commit(O);
    this.motes?.lateUpdate();
    if (this.frame % 15 === 0) this._discover();
  }

  _discover() {
    if (this.t - this._lastDiscovery < 2.5) return;
    let best = null, bestD = Infinity;
    for (const c of this.creatures) {
      const sp = c.species;
      if (!c.visible || this.discovered.has(sp.id)) continue;
      if (c.dist < c.rt.discover && c.dist < bestD) { best = c; bestD = c.dist; }
    }
    if (!best) return;
    const sp = best.species;
    this.discovered.add(sp.id);
    this._lastDiscovery = this.t;
    this.world.events?.emit?.('discovery', { kind: 'creature', name: sp.name, species: sp.id, archetype: sp.archetype });
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
    const byKind = {};
    for (const rt of this.rt.values()) { drawn += rt.crowd.drawn; for (const m of rt.crowd.meshes) if (m.visible) calls++; }
    for (const c of this.creatures) byKind[c.species.archetype] = (byKind[c.species.archetype] || 0) + 1;
    return {
      species: this.roster.length,
      roster: this.roster.map((s) => `${s.archetype}:${s.name}`),
      groups: this.groups.length,
      creatures: this.creatures.length, byKind,
      drawn, meshes: calls + (this.motes?.visible ? 1 : 0),
      motes: this.motes?.getState?.(),
      discovered: [...this.discovered].map((id) => this.roster.find((s) => s.id === id)?.name),
    };
  }

  onOriginShift() { /* positions are planet-local; the root group follows the origin in lateUpdate */ }

  dispose() {
    for (const rt of this.rt.values()) rt.crowd.dispose();
    this.rt.clear();
    this.motes?.dispose();
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
    f.roster = f.roster.filter((sp) => f.rt.has(sp.id));
    return f;
  },
};
