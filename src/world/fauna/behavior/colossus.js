// Colossus behaviour (season 2): one gentle giant made of the world, walking slowly along long curving
// paths through the land and the mist. States:
//   walk   — strolls toward a far goal (300–700 m), turning its head to watch the explorer as it passes
//   pause  — stands, breathes, browses the treetops, looks around
//   bow    — the explorer has stood still nearby for a few seconds (or sent a Resonance pulse): it turns
//            to her, walks up until its face is in front of hers and lowers its head (face to face)
//   ridden — a rider steers it through the mount API (`drive`)
// Steers around the player (never steps on her), avoids water and cliffs (moveGround), keeps out of
// settlement clearings.
import { damp, vnoise1 } from '../math.js';
import { tangentBasis, clearingPush } from './ground.js';

const _e = new Float64Array(3), _n = new Float64Array(3), _push = new Float64Array(3);

export class ColossusWalk {
  /**
   * @param member creature (placed); rig info in member.rt
   * o: { standoff (m, root → face distance when bowing) }
   */
  constructor(species, member, rng, env, o = {}) {
    this.species = species;
    this.members = [member];
    this.rng = rng;
    this.colossus = true;
    this.state = 'walk';
    this.timer = rng.range(25, 50);
    this.goal = new Float64Array(3);
    this.standoff = o.standoff ?? 12;
    this.bowR = this.standoff + 40;      // the explorer must be this close for a bow
    this.still = 0;
    this.bowHold = 0;                    // seconds left of a pulse-triggered bow
    this.bowW = 0;                       // 0..1 how far the head is lowered (smoothed)
    this.drive = null;                   // { dir: [x,y,z] tangent, speed 0..1 } from a rider
    this.kneel = 0;
    this.seed = rng.next() * 100;
    this._pickGoal(env, member.fwd);
  }

  /** a far goal roughly ahead (gentle curving walks, never a U-turn unless blocked) */
  _pickGoal(env, fwd, turn = 0.9) {
    const m = this.members[0];
    const l = Math.hypot(m.pos[0], m.pos[1], m.pos[2]);
    const ux = m.pos[0] / l, uy = m.pos[1] / l, uz = m.pos[2] / l;
    tangentBasis(ux, uy, uz, _e, _n);
    const f0 = Math.atan2(fwd[0] * _n[0] + fwd[1] * _n[1] + fwd[2] * _n[2], fwd[0] * _e[0] + fwd[1] * _e[1] + fwd[2] * _e[2]);
    for (let k = 0; k < 8; k++) {
      const a = f0 + this.rng.range(-turn, turn) * (1 + k * 0.4);
      const r = this.rng.range(300, 700);
      const x = m.pos[0] + (_e[0] * Math.cos(a) + _n[0] * Math.sin(a)) * r;
      const y = m.pos[1] + (_e[1] * Math.cos(a) + _n[1] * Math.sin(a)) * r;
      const z = m.pos[2] + (_e[2] * Math.cos(a) + _n[2] * Math.sin(a)) * r;
      const L = Math.hypot(x, y, z);
      const h = env.height(x / L, y / L, z / L);
      if (h > env.sea + 3 && !clearingPush(env, x, y, z, 30)) { const rr = env.R + h; this.goal[0] = x / L * rr; this.goal[1] = y / L * rr; this.goal[2] = z / L * rr; return; }
    }
    this.goal.set(m.pos);
  }

  /** Resonance pulse reached it: lower the head for a few seconds */
  pulse() { this.bowHold = Math.max(this.bowHold, 6); }

  update(dt, env) {
    const m = this.members[0];
    const P = env.player, H = env.playerHead;
    const dx = P[0] - m.pos[0], dy = P[1] - m.pos[1], dz = P[2] - m.pos[2];
    const d = Math.hypot(dx, dy, dz);
    m.dPlayer = d;
    const t = env.t;
    const g = this.species.genome, s = m.scale;
    const walk = g.walkSpeed * s;
    // the explorer standing still nearby (on the ground) → it comes to her and bows
    const near = d < this.bowR * s && env.playerOnGround && !this.carrying;
    if (near && env.playerSpeed < 0.35) this.still += dt; else this.still = Math.max(0, this.still - dt * 1.5);
    this.bowHold = Math.max(0, this.bowHold - dt);
    this.timer -= dt;
    if (this.drive) this.state = 'ridden';
    else if ((this.still > 3 || this.bowHold > 0) && near) this.state = 'bow';
    else if (this.state === 'bow' || this.state === 'ridden') { this.state = 'pause'; this.timer = 6; }
    let wx = 0, wy = 0, wz = 0, want = 0, graze = 0;
    m.look = null;
    switch (this.state) {
      case 'walk': {
        wx = this.goal[0] - m.pos[0]; wy = this.goal[1] - m.pos[1]; wz = this.goal[2] - m.pos[2];
        const gd = Math.hypot(wx, wy, wz);
        // a slow meander on top of the goal heading
        const up = m.up; tangentBasis(up[0], up[1], up[2], _e, _n);
        const wob = vnoise1(t * 0.035 + this.seed) * 0.5;
        if (gd > 1e-3) {
          const sx = up[1] * wz - up[2] * wy, sy = up[2] * wx - up[0] * wz, sz = up[0] * wy - up[1] * wx;
          wx += sx * wob; wy += sy * wob; wz += sz * wob;
        }
        want = walk * (0.85 + 0.15 * vnoise1(t * 0.05 + this.seed * 3));
        if (d < 160) m.look = H;
        if (gd < 40 || this.timer <= 0) { this.state = 'pause'; this.timer = this.rng.range(7, 16); }
        if ((m.blocked || 0) > 1.0) { this._pickGoal(env, [-m.fwd[0], -m.fwd[1], -m.fwd[2]], 1.6); m.blocked = 0; }
        break;
      }
      case 'pause': {
        graze = 0.03 + 0.06 * Math.max(0, vnoise1(t * 0.08 + this.seed));     // the long neck dips a little (browsing the treetops)
        if (d < 200) m.look = H;
        if (this.timer <= 0) { this.state = 'walk'; this.timer = this.rng.range(40, 80); this._pickGoal(env, m.fwd); }
        break;
      }
      case 'bow': {
        // walk up to her (slowly), then turn to face her and lower the head
        const so = this.standoff * s;
        wx = dx; wy = dy; wz = dz;
        if (d > so + 1.5) want = walk * Math.min(0.75, (d - so) / 12 + 0.2);
        else want = 0.003;          // turn in place
        const fx = m.fwd[0] * dx + m.fwd[1] * dy + m.fwd[2] * dz;
        const facing = d > 1e-3 ? fx / d : 0;
        graze = d < so + 10 && facing > 0.6 ? 0.84 : 0;
        m.look = H;
        break;
      }
      case 'ridden': {
        const dr = this.drive;
        wx = dr.dir[0]; wy = dr.dir[1]; wz = dr.dir[2];
        want = Math.hypot(wx, wy, wz) > 1e-6 ? walk * Math.max(0, Math.min(1.6, dr.speed ?? 1)) : 0;
        graze = 0;
        break;
      }
    }
    // personal space: never step on the explorer (feet straddle a 2 m disc around her at most)
    const pr = this.standoff * s * 0.7;
    if (this.state !== 'ridden' && d < pr && env.playerOnGround) {
      const al = d || 1;
      const wl = Math.hypot(wx, wy, wz);
      if (wl > 1e-6) { wx /= wl; wy /= wl; wz /= wl; }
      const k = (pr - d) / pr * 3;
      wx -= dx / al * k; wy -= dy / al * k; wz -= dz / al * k;
      want = Math.max(want, walk * 0.5);
    }
    // settlement clearings
    const cp = clearingPush(env, m.pos[0], m.pos[1], m.pos[2], 25, _push);
    if (cp > 0 && this.state !== 'ridden') {
      const wl = Math.hypot(wx, wy, wz);
      if (wl > 1e-6) { wx /= wl; wy /= wl; wz /= wl; }
      wx += _push[0] * cp * 3; wy += _push[1] * cp * 3; wz += _push[2] * cp * 3;
      want = Math.max(want, walk * 0.6);
    }
    m.want[0] = wx; m.want[1] = wy; m.want[2] = wz;
    m.wantSpeed = want;
    this.bowW += ((this.state === 'bow' ? graze : 0) - this.bowW) * damp(1.2, dt);
    m.grazeTarget = graze;
    // the bow: front legs fold a little and the shoulders dip so the long neck brings the face down to hers
    m.lean = this.bowW * 0.26;
    m.crouch = this.bowW * 0.75;
    this.kneel = this.bowW;
    m.alert = 0;
  }

  getState() { return this.state; }
}
