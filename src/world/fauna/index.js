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
import { moveGround, Herd, tangentBasis, clearingPush } from './behavior/ground.js';
import { Flock, Pod, Swarm, School } from './behavior/air.js';
import { cellsPerFace, cellsAround, cellDir } from './cells.js';
import { Motes, Splashes } from './particles.js';
import { ColossusWalk } from './behavior/colossus.js';
import { SpiritFox } from './companion.js';
import { Murmuration } from './murmuration.js';
import { G } from '../../core/Uniforms.js';
import { Mount } from './mount.js';

const LEGGED = new Set(['grazer', 'giant', 'hexapod', 'hopper', 'critter', 'colossus', 'fox']);
const GROUND = new Set(['grazer', 'giant', 'hexapod', 'hopper', 'critter', 'serpent']);   // herd archetypes (&fauna= showcase)
const SHOW = { horses: 'horse', colossi: 'colossus', mount: 'colossus', murmuration: 'murmuration', flock: 'murmuration', serpents: 'serpent', snake: 'serpent', birds: 'bird', bird: 'bird', rays: 'ray', ray: 'ray', whales: 'whale', whale: 'whale', jellies: 'jelly', jelly: 'jelly', fish: 'fish' };
// per archetype: draw distance (m), LOD0 distance, discovery distance
const DIST = {
  grazer: [900, 95, 70], giant: [2000, 160, 220], hexapod: [900, 95, 70], hopper: [700, 70, 60], critter: [300, 40, 25],
  colossus: [3400, 340, 700], fox: [260, 45, 0],
  serpent: [320, 45, 30], bird: [750, 70, 140], ray: [1200, 140, 220], whale: [7000, 1100, 1800], jelly: [600, 90, 90], fish: [180, 30, 45],
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
    this.animCtx = { ground: this.env.ground, sample: true, t: 0, R: this.R };
    this.showcase = String(world.params?.fauna ?? '').toLowerCase();
    this.showRaw = Math.max(0.02, Math.min(4, parseFloat(world.params?.faunadist ?? 1) || 1));
    this.showDist = Math.max(0.3, this.showRaw);   // showcase distance multiplier (colossus: showRaw ≤ 0.25 = face to face)
    this.motes = null;
    try { this.motes = new Motes(this); } catch (e) { console.warn('[fauna] motes disabled', e); }
    this.splashes = null;
    if (this.hasOcean) {
      try {
        this.splashes = new Splashes(this);
        this.env.splash = (p, up, k) => this.splashes.burst(p, up, k, this.t);
      } catch (e) { console.warn('[fauna] splashes disabled', e); }
    }
    // season 2: colossi (+ their mounts), the spirit fox companion, the dusk murmuration, Resonance pulses
    this.colossusSp = null;
    this.colossi = [];
    this.mounts = [];
    this._colT = 0; this._colN = 0;
    this.companion = null;
    this.murmur = null;
    this.pulses = [];
    this._offPulse = null;
    try { this._offPulse = world.events?.on?.('player:pulse', (e) => this._onPulse(e)) || null; } catch (_) { this._offPulse = null; }
  }

  /** the mount nearest to the player (or null) */
  get mount() { return this.mountNear(this.playerPos, 1e9); }

  /** nearest mount within r metres of planet-local pos ({x,y,z} or Float64Array) */
  mountNear(pos, r = 40) {
    const px = pos.x ?? pos[0], py = pos.y ?? pos[1], pz = pos.z ?? pos[2];
    let best = null, bd = r;
    for (const m of this.mounts) { const d = Math.hypot(m.pos.x - px, m.pos.y - py, m.pos.z - pz); if (d < bd) { bd = d; best = m; } }
    return best;
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
      const crowd = new Crowd(this.root, { name: sp.name, bones: rig.nb, pivots: rig.pivots, lods, look: sp.look, castShadow: shadows, capacity: sp.archetype === 'colossus' || sp.archetype === 'fox' ? 4 : 16 });
      rt = { rig, animator, crowd, radius: Math.max(rig.length, rig.height) * 0.6, height: rig.height, centerUp: rig.height * 0.5 };
      // giants are mostly haze and silhouette (paler and cooler with distance, heads before feet)
      if (sp.archetype === 'colossus') crowd.look.pHaze.value.set(1.0, rig.height, 0.0024, 1.0);
      else if (sp.archetype === 'giant') crowd.look.pHaze.value.set(0.75, rig.height, 0.0017, 0.85);
    } else {
      const rig = chainRig(sp.genome);
      const lods = [chainGeometry(rig, 0), chainGeometry(rig, 1)];
      const animator = new ChainAnimator(rig);
      const jelly = sp.archetype === 'jelly';
      const crowd = new Crowd(this.root, {
        name: sp.name, bones: rig.nb, pivots: rig.pivots, lods, look: sp.look, capacity: 16,
        castShadow: shadows && (sp.archetype === 'whale' || sp.archetype === 'bird' || sp.archetype === 'ray' || sp.archetype === 'serpent'),
        transparent: jelly, opacity: 0.72, renderOrder: jelly ? 2 : 0,
      });
      rt = { rig, animator, crowd, radius: rig.radius, height: rig.height, centerUp: rig.center || 0 };
      if (sp.archetype === 'whale') crowd.look.pHaze.value.set(0.8, 1, 0.0009, 0.0);
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
    } else if (A === 'fish' || opts.school) {
      // fish schools — and, underwater, mantas (sky rays swim the same way: School boids in a depth band)
      const l = Math.hypot(home[0], home[1], home[2]);
      const Lb = g.L ?? g.span ?? 1;
      const spd = opts.speed ?? g.speed;
      for (let i = 0; i < n; i++) {
        const a = i * 2.39996, r = Lb * (opts.spread ?? 1.6) * Math.sqrt(i + 0.5);
        const depthT = opts.depth ? rng.range(opts.depth[0], opts.depth[1]) : Math.min(rng.range(0.5, 1.8), Math.max(0.25, opts.maxDepth ?? 9));
        P[0] = home[0] + (_e[0] * Math.cos(a) + _n[0] * Math.sin(a)) * r; P[1] = home[1] + (_e[1] * Math.cos(a) + _n[1] * Math.sin(a)) * r; P[2] = home[2] + (_e[2] * Math.cos(a) + _n[2] * Math.sin(a)) * r;
        const pl = Math.hypot(P[0], P[1], P[2]);
        const rr = this.R + this.sea - depthT;
        P[0] *= rr / pl; P[1] *= rr / pl; P[2] *= rr / pl;
        const c = this._makeFlyer(sp, rt, P, [fx, fy, fz], rng.range(0.75, 1.25) * (opts.scale ?? 1), rng);
        c.index = i; c.depthT = depthT;
        c.off[0] = (_e[0] * Math.cos(a) + _n[0] * Math.sin(a)) * r * 0.5; c.off[1] = (_e[1] * Math.cos(a) + _n[1] * Math.sin(a)) * r * 0.5; c.off[2] = (_e[2] * Math.cos(a) + _n[2] * Math.sin(a)) * r * 0.5;
        c.vel[0] = fx * spd; c.vel[1] = fy * spd; c.vel[2] = fz * spd;
        if (A !== 'fish') c.flap = 0.6;
        members.push(c);
      }
      void l;
      grp = new School(sp, members, home, rng.fork('school'), this.env, { speed: spd, range: opts.range ?? 22, seek: opts.seek ?? 2.5, sep: Lb * (A === 'fish' ? 1.1 : 1.4) * (opts.scale ?? 1), minDepth: opts.minDepth, noLeap: !!opts.noLeap });
    }
    if (!grp) return null;
    for (const m of members) { m.group = grp; this.creatures.push(m); }
    this.groups.push(grp);
    return grp;
  }

  _removeGroup(grp) {
    const i = this.groups.indexOf(grp);
    if (i >= 0) this.groups.splice(i, 1);
    if (grp.colossus) {
      const k = this.colossi.indexOf(grp);
      if (k >= 0) this.colossi.splice(k, 1);
      if (grp.mount) { grp.mount.dispose(); const j = this.mounts.indexOf(grp.mount); if (j >= 0) this.mounts.splice(j, 1); }
    }
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

  // ------------------------------------------------------------------------------ colossi
  /** spawn one colossus at planet-local ground point pos, heading angle (spawnAir convention) */
  _spawnColossus(pos, heading, rng, welcome = false, scale = 0) {
    const sp = this.colossusSp;
    if (!sp) return null;
    const rt = this.runtime(sp);
    const ul = Math.hypot(pos[0], pos[1], pos[2]);
    tangentBasis(pos[0] / ul, pos[1] / ul, pos[2] / ul, _e, _n);
    const fwd = [_e[0] * Math.cos(heading) + _n[0] * Math.sin(heading), _e[1] * Math.cos(heading) + _n[1] * Math.sin(heading), _e[2] * Math.cos(heading) + _n[2] * Math.sin(heading)];
    const c = this._makeCreature(sp, rt, pos, fwd, scale || rng.range(0.95, 1.5), rng.next(), rng);
    c.turnSpeed = 0.32; c.accel = 0.45; c.decel = 0.6; c.maxSlope = 0.85;
    c.born = welcome ? 1 : 0;
    const rig = rt.rig;
    // root → face distance when it bows its head to her (rest metres)
    const standoff = rig.shP[2] * 0.85 + rig.Lh + 2.8;   // (bowed head ≈ above the front feet, muzzle beyond)
    const grp = new ColossusWalk(sp, c, rng.fork('col'), this.env, { standoff });
    c.group = grp;
    if (welcome) grp.welcome = true;
    this.creatures.push(c);
    this.groups.push(grp);
    this.colossi.push(grp);
    try { grp.mount = new Mount(this, grp); this.mounts.push(grp.mount); } catch (e) { console.warn('[fauna] mount failed', e); }
    return grp;
  }

  /** keep 1–3 colossi walking the land around the player (they walk in from 400–650 m away) */
  _streamColossi(dt) {
    if (!this.colossusSp) return;
    this._colT -= dt;
    if (this._colT > 0) return;
    this._colT = 1.2;
    const P = this.playerPos;
    for (const g of [...this.colossi]) {
      const c = g.members[0];
      const d = Math.hypot(c.pos[0] - P[0], c.pos[1] - P[1], c.pos[2] - P[2]);
      if (d > 1800 && !g.carrying) this._removeGroup(g);
    }
    const l = Math.hypot(P[0], P[1], P[2]);
    const ux = P[0] / l, uy = P[1] / l, uz = P[2] / l;
    const alt = l - this.R - Math.max(this.sea, this.surface.height(ux, uy, uz));
    if (alt > 3000) return;
    const want = { low: 1, med: 2, high: 2, ultra: 3 }[this.q.tier || 'high'] ?? 2;
    let tries = 0;
    while (this.colossi.length < want && tries++ < 2) {
      const rng = new RNG(hashCombine(this.body.seed, 0xc01, this._colN++));
      tangentBasis(ux, uy, uz, _e, _n);
      for (let k = 0; k < 10; k++) {
        const a = rng.range(0, Math.PI * 2), r = rng.range(420, 680);
        const x = P[0] + (_e[0] * Math.cos(a) + _n[0] * Math.sin(a)) * r, y = P[1] + (_e[1] * Math.cos(a) + _n[1] * Math.sin(a)) * r, z = P[2] + (_e[2] * Math.cos(a) + _n[2] * Math.sin(a)) * r;
        const L = Math.hypot(x, y, z);
        const h = this.surface.height(x / L, y / L, z / L);
        if (h < this.sea + 4 || clearingPush(this.env, x, y, z, 40)) continue;
        const rr = this.R + h;
        // walk across the player's surroundings (tangent to the bearing, gently inward)
        const head = a + Math.PI * 0.5 * (rng.chance(0.5) ? 1 : -1) + rng.range(-0.5, 0.5) + Math.PI * 0.15;
        this._spawnColossus(new Float64Array([x / L * rr, y / L * rr, z / L * rr]), head, rng);
        break;
      }
    }
  }

  // ------------------------------------------------------------------------------ Resonance pulse
  _onPulse(e) {
    const p = e?.pos;
    if (!p) return;
    this.pulses.push({ x: p.x ?? p[0], y: p.y ?? p[1], z: p.z ?? p[2], t0: this.t, R: e.radius || 62 });
    if (this.pulses.length > 4) this.pulses.shift();
  }

  /** the curtain of light (≈ 25 m/s) reaches a creature → it lifts its head to the sky; giants bow */
  _applyPulses(dt) {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const pu = this.pulses[i];
      const wave = (this.t - pu.t0) * 25;
      if (wave > pu.R + 20) { this.pulses.splice(i, 1); continue; }
      for (const c of this.creatures) {
        if (c.companion || c._pulse === pu) continue;
        const d = Math.hypot(c.pos[0] - pu.x, c.pos[1] - pu.y, c.pos[2] - pu.z);
        const reach = pu.R * (c.group?.colossus ? 2.5 : 1);
        if (d < reach && d < wave + (c.group?.colossus ? 60 : 0)) {
          c._pulse = pu; c.pulseT = 4 + (c.seed || 0) * 1.5;
          if (c.group?.colossus) c.group.pulse();
        }
      }
    }
    for (const c of this.creatures) {
      if (!(c.pulseT > 0)) continue;
      c.pulseT -= dt;
      if (c.group?.colossus) continue;
      // look up at the sky, a little toward the light's source
      const ls = c.lookSky || (c.lookSky = new Float64Array(3));
      const P = this.playerHead;
      ls[0] = c.pos[0] + c.up[0] * 40 + (P[0] - c.pos[0]) * 0.4;
      ls[1] = c.pos[1] + c.up[1] * 40 + (P[1] - c.pos[1]) * 0.4;
      ls[2] = c.pos[2] + c.up[2] * 40 + (P[2] - c.pos[2]) * 0.4;
      if (!c.air) { c.look = ls; c.grazeTarget = 0; c.alert = Math.max(c.alert || 0, 0.7); if (c.wantSpeed > 0) c.wantSpeed *= 0.4; }
    }
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
    this._syncClearings();
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
          if (clearingPush(this.env, _d[0], _d[1], _d[2], 40)) continue;   // no herds in towns
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

  /** settlement clearings from the civ track (may appear after fauna is created) */
  _syncClearings() {
    let C = null;
    try { C = this.world.civ?.clearings || this.world.get?.('civ')?.clearings || null; } catch (_) { C = null; }
    this.env.clearings = Array.isArray(C) && C.length ? C : null;
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
    this._syncClearings();
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
    let want = SHOW[this.showcase] || this.showcase;
    if (want === 'giant' && !this.roster.some((x) => x.archetype === 'giant')) want = 'colossus';
    const entry = { groups: [] };
    this.cells.set('welcome', entry);
    const mark = (g) => { if (g) { g.welcome = true; entry.groups.push(g); } return g; };
    const dirAt = (ang) => { const c = Math.cos(ang), s = Math.sin(ang); return [fx * c + rx * s, fy * c + ry * s, fz * c + rz * s]; };
    const at = (dir, dist, side = 0) => [C.x + dir[0] * dist + rx * side, C.y + dir[1] * dist + ry * side, C.z + dir[2] * dist + rz * side];

    // ---- ground herd (default, or the requested legged archetype)
    if (want === 'horse' && !this.roster.some((x) => x.horse)) want = 'grazer';
    const legged = GROUND.has(want) || want === 'horse';
    if (!want || legged) {
      let sp = legged ? this.roster.find((x) => (want === 'horse' ? x.horse : x.archetype === want && !x.horse)) : null;
      const probe = sp || this.roster.find((x) => x.layer === 'ground' && x.archetype === 'grazer');
      if (probe) {
        const g = probe.genome;
        const base = (probe.archetype === 'serpent' ? 5 + g.L * 1.2 : probe.archetype === 'critter' ? 4.5 + g.S * 6 : Math.min(90, Math.max(12, 7 + g.S * (legged ? 7 : 10) + (probe.archetype === 'giant' ? 38 : 0)))) * this.showDist;
        const angs = [0, 0.3, -0.3, 0.55, -0.55, 0.8, -0.8];
        let placed = false, fallback = null;
        for (const k of [1, 0.7, 1.4, 0.5]) {
          for (const ang of angs) {
            const p = at(dirAt(ang), base * k);
            const h = this.env.ground(p[0], p[1], p[2], _d, 0);
            if (h < this.sea + 2) continue;
            if (clearingPush(this.env, _d[0], _d[1], _d[2], 15)) continue;   // not on plazas / streets
            if (!fallback) fallback = Float64Array.from(_d);
            if (!this._clearView(C, _d[0], _d[1], _d[2], g.S * 1.1)) continue;
            if (!sp) sp = this._pickGround(rng, [ux, uy, uz], h, (x) => x.archetype !== 'critter' && x.archetype !== 'serpent') || probe;
            // broadside to the camera: heading along the camera's right vector
            const dl = Math.hypot(_d[0], _d[1], _d[2]);
            tangentBasis(_d[0] / dl, _d[1] / dl, _d[2] / dl, _e, _n);
            const hd = Math.atan2(rx * _n[0] + ry * _n[1] + rz * _n[2], rx * _e[0] + ry * _e[1] + rz * _e[2]) + (rng.chance(0.5) ? Math.PI : 0) + 0.35;
            mark(this._spawnHerd(sp, Float64Array.from(_d), rng.fork('welcome'), sp.archetype === 'giant' ? rng.int(3, 4) : sp.archetype === 'serpent' ? rng.int(2, 3) : rng.int(Math.max(5, sp.group[0]), Math.max(8, sp.group[1])), hd));
            const hg = entry.groups[entry.groups.length - 1];
            if (hg) { hg.timer = 75; hg.tame = true; }   // stay and graze in front of the camera (until approached)
            placed = true;
            break;
          }
          if (placed) break;
        }
        if (!placed && fallback) {
          if (!sp) sp = probe;
          mark(this._spawnHerd(sp, fallback, rng.fork('welcome'), sp.archetype === 'giant' ? 3 : sp.archetype === 'serpent' ? 2 : Math.max(6, sp.group[0])));
          const hg = entry.groups[entry.groups.length - 1];
          if (hg) { hg.timer = 75; hg.tame = true; }
        }
      }
    }
    // ---- the colossus: one walks across the far view on every world (or framed by &fauna=colossus;
    //      &faunadist ≤ 0.25 brings it face to face, bowing its head to her)
    if (this.colossusSp && (!want || want === 'colossus')) {
      const rig = this.runtime(this.colossusSp).rig;
      const close = want === 'colossus' && this.showRaw <= 0.25;
      const base = want === 'colossus' ? (close ? Math.max(18, 120 * this.showRaw) : 230 * this.showRaw) : 430;
      const angs = want ? [0.18, -0.18, 0.35, -0.35, 0, 0.55, -0.55] : [0.32, -0.32, 0.5, -0.5, 0.15, -0.15];
      let done = false;
      for (const k of [1, 0.8, 1.25, 0.6]) {
        for (const ang of angs) {
          const p = at(dirAt(ang), base * k);
          const h = this.env.ground(p[0], p[1], p[2], _d, 0);
          if (h < this.sea + 3 || clearingPush(this.env, _d[0], _d[1], _d[2], 30)) continue;
          if (!close && !this._clearView(C, _d[0], _d[1], _d[2], rig.height * 0.55)) continue;
          const dl = Math.hypot(_d[0], _d[1], _d[2]);
          tangentBasis(_d[0] / dl, _d[1] / dl, _d[2] / dl, _e, _n);
          // across the view (right → left or left → right), or toward her when close
          let hd = Math.atan2(rx * _n[0] + ry * _n[1] + rz * _n[2], rx * _e[0] + ry * _e[1] + rz * _e[2]) + (ang > 0 ? Math.PI : 0) + (ang > 0 ? -0.25 : 0.25);
          if (close) hd = Math.atan2(-(fx * _n[0] + fy * _n[1] + fz * _n[2]), -(fx * _e[0] + fy * _e[1] + fz * _e[2])) + 0.2;
          const g = this._spawnColossus(Float64Array.from(_d), hd, rng.fork('wcol'), true, close ? 1 : 1.55);   // far: a 45 m giant over the treeline
          if (g) {
            mark(g);
            if (close) { g.bowHold = 40; g.bowW = 0.6; }   // already lowering its head when the view opens
            else {
              g.state = 'walk'; g.timer = 120;
              // a second one further back, across the view: two layers of haze (the farther, the paler and cooler)
              if (want === 'colossus' && !this._col2) {
                this._col2 = true;
                for (const a2 of [-ang * 1.6 - 0.25, -ang - 0.45, 0.6, -0.6]) {
                  const p2 = at(dirAt(a2), base * k * 2.4);
                  const h2 = this.env.ground(p2[0], p2[1], p2[2], _e, 0);
                  if (h2 < this.sea + 3 || clearingPush(this.env, _e[0], _e[1], _e[2], 30)) continue;
                  const q = Float64Array.from(_e);
                  const ql = Math.hypot(q[0], q[1], q[2]);
                  tangentBasis(q[0] / ql, q[1] / ql, q[2] / ql, _e, _n);
                  const hd2 = Math.atan2(rx * _n[0] + ry * _n[1] + rz * _n[2], rx * _e[0] + ry * _e[1] + rz * _e[2]) + (a2 > 0 ? Math.PI : 0);
                  const g2 = this._spawnColossus(q, hd2, rng.fork('wcol2'), true, 1.3);
                  if (g2) { mark(g2); g2.state = 'walk'; g2.timer = 120; }
                  break;
                }
              }
            }
            this.showcaseInfo = { ...(this.showcaseInfo || {}), colossus: Math.round(base * k) };
          }
          done = true; break;
        }
        if (done) break;
      }
    }
    if (want === 'murmuration' && this.murmur) {
      this.murmur.forced = true;
      const sp = (24 + 210 * this.showDist);
      this.murmur.place([C.x, C.y, C.z], [fx * Math.cos(0.1) + rx * Math.sin(0.1), fy * Math.cos(0.1) + ry * Math.sin(0.1), fz * Math.cos(0.1) + rz * Math.sin(0.1)], sp, 55 + sp * 0.18);
      this.showcaseInfo = { ...(this.showcaseInfo || {}), murmuration: Math.round(sp) };
    }
    // ---- sky life framed in the spawn view
    const wantSky = SHOW[this.showcase];
    const pick = (a) => this.roster.find((x) => x.archetype === a);
    const F3 = [fx, fy, fz];      // horizontal view direction (the player camera settles near the horizon)
    _v3.setFromMatrixColumn(cam.matrixWorld, 1).normalize();
    const camUp = [_v3.x, _v3.y, _v3.z];   // the lens' own up: view3d lifts stay inside the frame on slopes
    /** point `dist` m along the camera's 3D view ray (turned by yawOff rad, raised by liftDeg) →
     *  { home: ground point beneath, agl } (never below minAgl above ground / sea) */
    const aim = (dist, liftDeg, yawOff = 0, minAgl = 4, view3d = false) => {
      const c = Math.cos(yawOff), s2 = Math.sin(yawOff);
      // view3d: relative to the camera's actual (pitched) view ray, so big sky life stays in frame
      // when the spawn camera looks down a slope or up a hill
      const B = view3d ? [f3x, f3y, f3z] : F3;
      let dx = B[0] * c + rx * s2, dy = B[1] * c + ry * s2, dz = B[2] * c + rz * s2;
      const lr = liftDeg * Math.PI / 180;
      const U = view3d ? camUp : [ux, uy, uz];
      dx += U[0] * Math.tan(lr); dy += U[1] * Math.tan(lr); dz += U[2] * Math.tan(lr);
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
        // showcase: the pod drifts low overhead (60–140 m up), crossing the view — megafauna passing over you
        const { home, agl } = wantSky ? aim((70 + sp.genome.L * 1.1) * this.showDist, 10, -0.05, 22 + sp.genome.R, true) : aim(700, 7, 0.2, 90);
        mark(this._spawnAir(sp, home, rng.fork('ww'), wantSky ? 3 : undefined, { agl: [agl, agl + 10], heading: across(home, -0.35) }));
        // look up at them (unless the URL sets a pitch): the explorer small at the bottom of the frame,
        // the whales filling the sky above her
        if (wantSky && this.world.params?.pitch === undefined) {
          try {
            const pl = this.world.player;
            if (pl?.lookAt) {
              const hl = Math.hypot(home[0], home[1], home[2]) || 1;
              const k = agl * 0.62;
              pl.lookAt(new THREE.Vector3(home[0] + home[0] / hl * k, home[1] + home[1] / hl * k, home[2] + home[2] / hl * k));
            }
          } catch (_) { /* optional neighbour */ }
        }
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
        for (let dist = 9 * this.showDist; dist < 400; dist *= 1.1) {
          let done = false;
          for (const ang of [0.3, -0.3, 0.55, -0.55, 0, 0.9, -0.9]) {
            const p = at(dirAt(ang), dist);
            const pl = Math.hypot(...p);
            const h = this.surface.height(p[0] / pl, p[1] / pl, p[2] / pl);
            if (h < this.sea - 1.1) {
              const r = this.R + this.sea;
              // showcase fish are big leapers (≥ ~1.3 m, salmon/tarpon scale) so a breach reads at 15–30 m
              const big = Math.max(1, 1.75 / sp.genome.L);
              const g = mark(this._spawnAir(sp, [p[0] / pl * r, p[1] / pl * r, p[2] / pl * r], rng.fork('wf'), 22, { range: 5, minDepth: 0.55, maxDepth: (this.sea - h) * 0.55, scale: big }));
              if (g) { g.showy = true; g.jumpT = 0.2; }   // showcase school: frequent leaps so it reads above the surface
              this.showcaseInfo = { fish: Math.round(dist) };
              done = true; break;
            }
          }
          if (done) break;
        }
      }
    }
    this._nearCol = null;
  }

  // ------------------------------------------------------------------------------ underwater life
  /** When the camera dives, populate the water column around it: schools at the camera's depth (one
   *  framed in front of the lens), plus mantas gliding further out when the roster has rays. */
  _underwater(dt) {
    const cam = this.world.camera;
    const C = cam.position;
    const l = Math.hypot(C.x, C.y, C.z);
    const camD = this.R + this.sea - l;                 // camera depth below sea level (m)
    const ux = C.x / l, uy = C.y / l, uz = C.z / l;
    const uw = this._uw || (this._uw = { groups: [], at: null, above: 0, t: 0 });
    uw.t -= dt;
    if (camD < 0.6) {
      uw.above += dt;
      if (uw.groups.length && uw.above > 8) { for (const g of uw.groups) this._removeGroup(g); uw.groups.length = 0; uw.at = null; }
      return;
    }
    uw.above = 0;
    if (uw.t > 0) return;
    uw.t = 0.5;
    if (uw.at && Math.hypot(C.x - uw.at[0], C.y - uw.at[1], C.z - uw.at[2]) < 90) return;
    for (const g of uw.groups) this._removeGroup(g);
    uw.groups.length = 0;
    uw.at = [C.x, C.y, C.z];
    const fish = this.roster.find((x) => x.archetype === 'fish');
    const ray = this.roster.find((x) => x.archetype === 'ray');
    if (!fish && !ray) return;
    cam.getWorldDirection(_v3);
    let fx = _v3.x, fy = _v3.y, fz = _v3.z;
    const d0 = fx * ux + fy * uy + fz * uz;
    fx -= ux * d0; fy -= uy * d0; fz -= uz * d0;
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    const rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    const rng = new RNG(hashCombine(this.body.seed, 0x0f15, Math.round(C.x / 50), Math.round(C.z / 50)));
    const seaR = this.R + this.sea;
    /** sea-level point at (forward, right) metres from the camera, with the local water depth */
    const spot = (fwd, side) => {
      const px = C.x + fx * fwd + rx * side, py = C.y + fy * fwd + ry * side, pz = C.z + fz * fwd + rz * side;
      const pl = Math.hypot(px, py, pz);
      const depth = this.sea - this.surface.height(px / pl, py / pl, pz / pl);
      return { p: new Float64Array([px / pl * seaR, py / pl * seaR, pz / pl * seaR]), depth };
    };
    const across = (home, k = 0) => {
      const hl = Math.hypot(home[0], home[1], home[2]);
      tangentBasis(home[0] / hl, home[1] / hl, home[2] / hl, _e, _n);
      return Math.atan2(rx * _n[0] + ry * _n[1] + rz * _n[2], rx * _e[0] + ry * _e[1] + rz * _e[2]) + Math.PI + k;
    };
    const add = (g) => { if (g) { g.welcome = true; g.underwater = true; uw.groups.push(g); } };
    if (fish) {
      // a dense bait ball of small fish straight ahead at eye level, adults cruising deeper beside it,
      // a third school further out for depth layering
      const plan = [[14, 0, 56, 0, 0.55, 0.9], [20, 8, 18, 1.2, 1.1, 1.3], [30, -14, 24, -0.6, 0.8, 1.1]];
      for (const [fw, sd, n, dz, sc, spread] of plan) {
        const { p, depth } = spot(fw, sd);
        if (depth < 1.6) continue;
        const dc = Math.min(Math.max(0.8, camD + dz), depth - 0.7);
        add(this._spawnAir(fish, p, rng.fork('uwf' + fw), Math.round(n * Math.max(0.6, this.tierK)), {
          depth: [Math.max(0.6, dc - 1.0), Math.min(depth - 0.5, dc + 1.0)], range: 4 + fw * 0.12, minDepth: 0.6, noLeap: true,
          heading: across(p, rng.range(-0.3, 0.3)), spread, scale: sc,
        }));
      }
    }
    if (ray) {
      // mantas: wide wings gliding past (sky rays are at home in the sea too)
      for (const [fw, sd] of [[22, -5], [26, 10]]) {
        const { p, depth } = spot(fw, sd);
        if (depth < ray.genome.span * 0.4 + 2) continue;
        const dc = Math.min(Math.max(1.5, camD + 0.8), depth - ray.genome.span * 0.2 - 0.8);
        add(this._spawnAir(ray, p, rng.fork('uwr' + fw), rng.int(1, 2), {
          school: true, depth: [dc - 0.5, dc + 0.6], range: 14, minDepth: 1.2, noLeap: true, speed: 2.2, seek: 0.8, spread: 1.0,
          heading: across(p, -0.3),
        }));
        break;
      }
    }
    this.showcaseInfo = { ...(this.showcaseInfo || {}), underwater: { depth: +camD.toFixed(1), groups: uw.groups.length, n: uw.groups.reduce((a, g) => a + g.members.length, 0) } };
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
      try { this._streamColossi(0); } catch (e) { console.warn('[fauna] colossi failed', e); }
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
      try { this._streamColossi(dt); } catch (e) { if (!this._colErr) { this._colErr = true; console.warn('[fauna] colossi failed', e); } }
    }
    if (this.companion) { try { this.companion.update(dt); } catch (e) { if (!this._compErr) { this._compErr = true; console.warn('[fauna] companion failed', e); } } }
    if (this.hasOcean) { try { this._underwater(dt); } catch (e) { if (!this._uwErr) { this._uwErr = true; console.warn('[fauna] underwater life failed', e); } } }
    if (dt <= 0) { this._animateAll(0); return; }
    for (const g of this.groups) {
      try { g.update(dt, this.env); } catch (e) { if (!g._err) { g._err = true; console.warn('[fauna] group update failed', e); } }
      this._alarmCheck(g);
    }
    if (this.pulses.length || this._pulseLive) { this._applyPulses(dt); this._pulseLive = this.creatures.some((c) => c.pulseT > 0); }
    for (const c of this.creatures) {
      if (c.born !== undefined && c.born < 1) c.born = Math.min(1, c.born + dt / 6);
      if (c.air || !c.want) continue;
      const every = c.dist < c.rt.lod0 ? 1 : c.dist < 250 ? 3 : 6;
      moveGround(c, dt, this.env, every);
    }
    this._animateAll(dt);
    for (const m of this.mounts) m.update();
    this.motes?.update(dt, t);
    if (this.murmur) {
      try {
        const P = this.playerPos, l = Math.hypot(P[0], P[1], P[2]) || 1, S = G.uSunDir.value;
        const el = Math.asin(Math.max(-1, Math.min(1, (S.x * P[0] + S.y * P[1] + S.z * P[2]) / l))) * 180 / Math.PI;
        this.murmur.update(dt, t, el);
      } catch (e) { if (!this._murErr) { this._murErr = true; console.warn('[fauna] murmuration failed', e); } }
    }
  }

  /** 'creature:alarm' {archetype, species, name, pos, dist, count} when a herd bolts or a flock scatters
   *  (audio: alarm calls, stampede / wing bursts). Rate limited. */
  _alarmCheck(g) {
    let on;
    if (typeof g.state === 'number' && g.getState) on = g.state === 3;          // Herd FLEE
    else if (typeof g.scatter === 'number') on = g.scatter > 0.5;               // Flock scatter
    else return;
    const fire = on && !g._alarmOn;
    g._alarmOn = on;
    if (!fire || this.t - (this._lastAlarm ?? -9) < 1.2) return;
    this._lastAlarm = this.t;
    const m = g.members?.[0];
    if (!m) return;
    const P = this.playerPos;
    try {
      this.world.events?.emit?.('creature:alarm', {
        archetype: g.species.archetype, species: g.species.id, name: g.species.name,
        pos: new THREE.Vector3(m.pos[0], m.pos[1], m.pos[2]),
        dist: Math.hypot(m.pos[0] - P[0], m.pos[1] - P[1], m.pos[2] - P[2]), count: g.members.length,
      });
    } catch (_) { /* listeners must not break the frame */ }
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
      if (c.hidden) { c.visible = false; continue; }
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
      c.fade = Math.min(1, (far - dist) / (far * 0.12)) * (c.born ?? 1);
      if (c.fade < 0.02) { c.visible = false; continue; }
      rt.crowd.add(c, dist < rt.lod0 * (0.7 + 0.3 * s) ? 0 : 1);
    }
    for (const rt of this.rt.values()) rt.crowd.commit(O);
    this.motes?.lateUpdate();
    this.splashes?.lateUpdate(this.t);
    if (this.frame % 15 === 0) this._discover();
  }

  _discover() {
    if (this.t - this._lastDiscovery < 2.5) return;
    let best = null, bestD = Infinity;
    for (const c of this.creatures) {
      const sp = c.species;
      if (!c.visible || c.companion || this.discovered.has(sp.id)) continue;
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
      if (c.companion || (archetype && c.species.archetype !== archetype)) continue;
      const d = Math.hypot(c.pos[0] - P[0], c.pos[1] - P[1], c.pos[2] - P[2]);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  /**
   * Creatures whose body sphere intersects the sphere (pos, r) — for vehicle chase cameras / bumps.
   * pos: planet-local {x,y,z} or Float64Array(3). Returns [{ creature, pos: Float64Array(3) body centre,
   * radius, archetype, name }] (reuses `out` when given). Cheap: linear scan over ≤ maxCreatures.
   */
  near(pos, r = 20, out = []) {
    out.length = 0;
    const px = pos.x ?? pos[0], py = pos.y ?? pos[1], pz = pos.z ?? pos[2];
    for (const c of this.creatures) {
      const s = c.scale, rt = c.rt;
      const k = rt.centerUp * s;
      const cx = c.pos[0] + c.up[0] * k, cy = c.pos[1] + c.up[1] * k, cz = c.pos[2] + c.up[2] * k;
      const rad = rt.radius * s;
      const d = Math.hypot(cx - px, cy - py, cz - pz);
      if (d < r + rad) out.push({ creature: c, pos: new Float64Array([cx, cy, cz]), radius: rad, dist: d, archetype: c.species.archetype, name: c.species.name });
    }
    return out;
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
      drawn, meshes: calls + (this.motes?.visible ? 1 : 0) + (this.splashes?.points.visible ? 1 : 0),
      motes: this.motes?.getState?.(),
      discovered: [...this.discovered].map((id) => this.roster.find((s) => s.id === id)?.name),
      showcase: this.showcaseInfo || null,
      colossi: this.colossi.map((g) => { const c = g.members[0]; return { state: g.state, dist: Math.round(c.dist), bow: +(g.bowW || 0).toFixed(2), riders: g.carrying || 0 }; }),
      companion: this.companion?.getState?.() || null,
      murmuration: this.murmur?.getState?.() || null,
    };
  }

  onOriginShift() { /* positions are planet-local; the root group follows the origin in lateUpdate */ }

  dispose() {
    try { this._offPulse?.(); } catch (_) { /* ignore */ }
    for (const m of this.mounts) m.dispose();
    this.mounts.length = 0; this.colossi.length = 0;
    this.murmur?.dispose();
    for (const rt of this.rt.values()) rt.crowd.dispose();
    this.rt.clear();
    this.motes?.dispose();
    this.splashes?.dispose();
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
    // the colossus walks its own layer (not a herd species); the spirit fox companion; the dusk murmuration
    f.colossusSp = f.roster.find((sp) => sp.archetype === 'colossus') || null;
    const cp = String(world.params?.companion ?? '');
    if (cp !== '0' && cp !== 'wolf' && f.showcase !== 'none') {
      try { f.companion = new SpiritFox(f); } catch (e) { console.warn('[fauna] companion failed', e); f.companion = null; }
    }
    if (f.roster.some((sp) => sp.archetype === 'bird')) {
      const n = { low: 600, med: 1200, high: 2600, ultra: 4000 }[f.q.tier || 'high'] ?? 2600;
      try { f.murmur = new Murmuration(f, n); } catch (e) { console.warn('[fauna] murmuration failed', e); f.murmur = null; }
    }
    return f;
  },
};
