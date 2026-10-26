// The spirit fox (season 2): the explorer's small glowing companion, and her guide.
//   follow — trots after her, a little behind on her left
//   guide  — while she walks, runs ahead toward the nearest wonder (World Tree, sacred site, great
//            mountain, wonder POI), stops, looks back at her and waits until she catches up
//   sit    — sits down beside her (left hip) when she rests or meditates, and looks out at the same view
// Rendered and animated like any fauna creature (legged rig 'fox': GPU skinned, IK paws, sit pose).
// Public (world.get('fauna').companion): { pos: Vector3, headPos: Vector3, forward, up, mode, seated,
//   creature, target (Vector3 | null: the wonder it is leading to), setMode('auto'|'follow'|'sit'|'stay') }.
import * as THREE from 'three';
import { RNG, hashCombine } from '../../core/rng.js';
import { leggedGenome } from './bodies/legged.js';
import { damp } from './math.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const col = (h, s, l) => new THREE.Color().setHSL(((h % 1) + 1) % 1, s, l, THREE.SRGBColorSpace);

/** spirit fox look: white-silver coat, gold-tipped ears and tail, faint ring-of-light glow at night */
function foxLook(art) {
  const acc = new THREE.Color(art?.palette?.accent || '#ffd27a');
  const ha = {}; acc.getHSL(ha, THREE.SRGBColorSpace);
  return {
    back: col(0.09, 0.08, 0.86), belly: col(0.1, 0.05, 0.94), pattern: col(0.08, 0.55, 0.62),
    accent: col(0.07, 0.5, 0.7), keratin: col(0.08, 0.1, 0.3), eye: col(0.12, 0.8, 0.5),
    glow: col(ha.s > 0.25 ? ha.h : 0.12, 0.8, 0.6),
    patternParams: [4, 1.6, 0.3, 0.35],          // a faint saddle of warmer fur
    glowParams: [1.6, 3, 1.2, 1.0],              // tips glow: tail tip, ear tips
    surf: [0.8, 0.85, 1.0, 1.25],
    extra: [0.6, 0, 1.0, 0.7],
  };
}

export class SpiritFox {
  constructor(fauna) {
    this.fauna = fauna;
    const world = fauna.world;
    this.world = world;
    const rng = new RNG(hashCombine(world.body.seed, 0xf0c5));
    const g = leggedGenome(rng, 'fox', {});
    this.species = {
      id: 9000, archetype: 'fox', layer: 'companion', name: 'Spirit Fox', seed: hashCombine(world.body.seed, 0xf0c6),
      glowing: true, temper: 'calm', genome: g, look: foxLook(world.body.art), group: [1, 1], density: 0,
    };
    this.rt = fauna.runtime(this.species);
    this.c = null;
    this.mode = 'follow';
    this.userMode = 'auto';
    this.seated = false;
    this.pos = new THREE.Vector3();
    this.headPos = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.target = null;
    this._wonder = new THREE.Vector3();
    this._wonderT = 0;
    this._waitT = 0;
    this.leadPos = new THREE.Vector3();
    this.leading = false;
    this.hidden = false;
  }

  setMode(m) { this.userMode = m || 'auto'; }

  /** nearest wonder worth leading her to (planet-local Vector3) or null */
  _findWonder(P) {
    const w = this.world;
    let best = null, bd = Infinity;
    const consider = (v) => {
      if (!v) return;
      const d = v.distanceTo(P);
      if (d > 60 && d < 2500 && d < bd) { bd = d; best = v; }
    };
    try {
      const sac = w.get?.('flora')?.sacred?.pos;
      if (sac?.isVector3) consider(sac);
      const lm = w.get?.('terrain')?.landmarks;
      const R = w.body.radius;
      for (const s of lm?.sacred || []) {
        if (typeof s.lat !== 'number') continue;
        const la = s.lat * Math.PI / 180, lo = s.lon * Math.PI / 180;
        _c.set(Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo));
        const h = w.surface.height(_c.x, _c.y, _c.z);
        consider(_c.clone().multiplyScalar(R + h));
      }
      for (const p of w.pois || []) if ((p.kind === 'wonder' || p.kind === 'monument' || p.kind === 'ruin') && p.pos?.isVector3) consider(p.pos);
    } catch (_) { /* optional neighbours */ }
    return best;
  }

  _spawn(P, fwd) {
    const f = this.fauna;
    const l = P.length();
    _a.copy(P).divideScalar(l);
    _b.crossVectors(_a, fwd).normalize();                 // left
    const p = new Float64Array([P.x + _b.x * 1.5 - fwd.x * 1.6, P.y + _b.y * 1.5 - fwd.y * 1.6, P.z + _b.z * 1.5 - fwd.z * 1.6]);
    f.env.ground(p[0], p[1], p[2], p, 0);
    const rng = new RNG(hashCombine(this.species.seed, 7));
    const c = f._makeCreature(this.species, this.rt, p, [fwd.x, fwd.y, fwd.z], 1, 0.62, rng);
    c.companion = true;
    c.walkSpeed = this.species.genome.walkSpeed;
    c.turnSpeed = 6; c.accel = 6; c.decel = 7; c.maxSlope = 2.2;
    c.glow = 1;
    c.sit = 0;
    this.c = c;
    f.creatures.push(c);
  }

  update(dt) {
    const f = this.fauna, w = this.world;
    const pl = w.player;
    if (!pl?.pos?.isVector3) return;
    const P = pl.pos;
    const fwd = pl.forward?.isVector3 ? pl.forward : _c.set(0, 0, 1);
    const inVehicle = w.controller && w.controller !== pl;
    if (!this.c) this._spawn(P, fwd);
    const c = this.c;
    if (!c) return;
    // hidden while she rides a vehicle; re-snap on her return
    this.hidden = !!inVehicle;
    c.hidden = this.hidden;
    const dx = P.x - c.pos[0], dy = P.y - c.pos[1], dz = P.z - c.pos[2];
    const d = Math.hypot(dx, dy, dz);
    if (d > 35 || this.hidden) {
      // too far behind (gliding, sprinting, teleport): reappear beside her
      const l = P.length();
      _a.copy(P).divideScalar(l);
      _b.crossVectors(_a, fwd).normalize();
      c.pos[0] = P.x + _b.x * 1.5 - fwd.x * 1.8; c.pos[1] = P.y + _b.y * 1.5 - fwd.y * 1.8; c.pos[2] = P.z + _b.z * 1.5 - fwd.z * 1.8;
      f.env.ground(c.pos[0], c.pos[1], c.pos[2], c.pos, 0);
      const ul = Math.hypot(c.pos[0], c.pos[1], c.pos[2]);
      c.up[0] = c.pos[0] / ul; c.up[1] = c.pos[1] / ul; c.up[2] = c.pos[2] / ul;
      c.h = undefined; c.speed = 0;
      for (const L of c.legs || []) L.init = false;
    }
    const ux = c.up[0], uy = c.up[1], uz = c.up[2];
    _a.set(ux, uy, uz);
    _b.crossVectors(_a, fwd).normalize();                   // her left
    const resting = (pl.resting || 0) > 0.4 || (pl.meditating || 0) > 0.4 || !!pl.restS?.on;
    const speedP = f.playerSpeed;
    // ---- mode
    let mode = this.userMode === 'auto' ? 'follow' : this.userMode;
    if (this.userMode === 'auto') {
      if (resting) mode = 'sit';
      else {
        this._wonderT -= dt;
        if (this._wonderT <= 0) { this._wonderT = 2; const wv = this._findWonder(P); if (wv) { this._wonder.copy(wv); this.target = this._wonder; } else this.target = null; }
        if (this.target && speedP > 0.8) mode = 'guide';
        else if (this.target && this.leading && speedP <= 0.8) mode = 'guide';
      }
    }
    // ---- steering target
    let tx, ty, tz, speedK = 1;
    if (mode === 'sit') {
      tx = P.x + _b.x * 0.62 + fwd.x * 0.04; ty = P.y + _b.y * 0.62 + fwd.y * 0.04; tz = P.z + _b.z * 0.62 + fwd.z * 0.04;
      speedK = 0.45;
    } else if (mode === 'guide') {
      // lead: a point 14 m ahead of her toward the wonder; wait there, looking back, until she is close
      _c.copy(this._wonder).sub(P); _c.addScaledVector(_a, -_c.dot(_a));
      const wl = _c.length();
      if (wl > 1) _c.divideScalar(wl);
      if (!this.leading || this.leadPos.distanceTo(P) < 5) {
        this.leadPos.copy(P).addScaledVector(_c, Math.min(16, wl * 0.5));
        this.leading = true; this._waitT = 0;
      }
      tx = this.leadPos.x; ty = this.leadPos.y; tz = this.leadPos.z;
      if (this.leadPos.distanceTo(P) > 30) this.leading = false;
      speedK = 1.6;
    } else {
      this.leading = false;
      tx = P.x + _b.x * 1.4 - fwd.x * 1.7; ty = P.y + _b.y * 1.4 - fwd.y * 1.7; tz = P.z + _b.z * 1.4 - fwd.z * 1.7;
    }
    if (mode !== 'guide') this.leading = false;
    let wx = tx - c.pos[0], wy = ty - c.pos[1], wz = tz - c.pos[2];
    const dn = wx * ux + wy * uy + wz * uz;
    wx -= ux * dn; wy -= uy * dn; wz -= uz * dn;
    const dt2 = Math.hypot(wx, wy, wz);
    const settle = mode === 'sit' ? 0.12 : mode === 'guide' ? 0.8 : 0.9;
    let want = 0;
    if (dt2 > settle) want = Math.min(c.species.genome.runSpeed, Math.max(0.6, (dt2 - settle) * 1.6 * speedK, mode === 'follow' ? speedP * 1.05 : 0));
    // arrived: face her view (sitting) or turn to look back at her (guiding)
    c.look = null;
    if (want <= 0) {
      if (mode === 'sit') { wx = fwd.x; wy = fwd.y; wz = fwd.z; want = 0.002; }
      else if (mode === 'guide') { wx = P.x - c.pos[0]; wy = P.y - c.pos[1]; wz = P.z - c.pos[2]; want = 0.002; this._waitT += dt; }
      else { wx = fwd.x; wy = fwd.y; wz = fwd.z; want = 0.002; }
    }
    c.want[0] = wx; c.want[1] = wy; c.want[2] = wz;
    c.wantSpeed = want;
    c.grazeTarget = 0;
    if (d < 12) c.look = f.playerHead;
    const sitNow = (mode === 'sit' && dt2 < 0.35) || (mode !== 'sit' && want <= 0.01 && c.speed < 0.05 && (this._idle = (this._idle || 0) + dt) > 4);
    if (want > 0.01) this._idle = 0;
    c.sit += ((sitNow ? 1 : 0) - c.sit) * damp(sitNow ? 2.5 : 6, dt);
    this.seated = mode === 'sit' && c.sit > 0.8;
    this.mode = mode;
    // public vectors
    this.pos.set(c.pos[0], c.pos[1], c.pos[2]);
    this.up.set(ux, uy, uz);
    this.forward.set(c.fwd[0], c.fwd[1], c.fwd[2]);
    const wp = c.wp;
    if (wp) this.headPos.set(wp[6 * 3], wp[6 * 3 + 1], wp[6 * 3 + 2]); else this.headPos.copy(this.pos).addScaledVector(this.up, 0.45);
  }

  getState() {
    return { mode: this.mode, seated: this.seated, leading: this.leading, target: this.target ? +this.target.distanceTo(this.world.player?.pos || this.pos).toFixed(0) : null, sit: +(this.c?.sit || 0).toFixed(2) };
  }
}
