// Ground locomotion on a spherical planet + herd behaviour.
import { clamp, damp, rotAxis, smooth } from '../math.js';

const _e = new Float64Array(3), _n = new Float64Array(3);

/** Tangent basis (east, north) at unit up vector u → writes into e, n. */
export function tangentBasis(ux, uy, uz, e, n) {
  // east = Y × up
  let ex = uz, ey = 0, ez = -ux;
  let l = Math.hypot(ex, ey, ez);
  if (l < 1e-6) { ex = 1; ey = 0; ez = 0; l = 1; }
  ex /= l; ey /= l; ez /= l;
  e[0] = ex; e[1] = ey; e[2] = ez;
  n[0] = uy * ez - uz * ey; n[1] = uz * ex - ux * ez; n[2] = ux * ey - uy * ex;
}

/**
 * Move a ground creature one step. env: { R, sea, height(dx,dy,dz) }
 * Reads c.want (direction, any length), c.wantSpeed; updates c.fwd, c.speed, c.pos, c.up, c.vel, c.turnRate.
 */
export function moveGround(c, dt, env, sampleEvery = 1) {
  const up = c.up, f = c.fwd;
  let wx = c.want[0], wy = c.want[1], wz = c.want[2];
  const d = wx * up[0] + wy * up[1] + wz * up[2];
  wx -= up[0] * d; wy -= up[1] * d; wz -= up[2] * d;
  const wl = Math.hypot(wx, wy, wz);
  let turn = 0, remain = 0;
  if (wl > 1e-6 && c.wantSpeed > 0.001) {
    wx /= wl; wy /= wl; wz /= wl;
    const cx = f[1] * wz - f[2] * wy, cy = f[2] * wx - f[0] * wz, cz = f[0] * wy - f[1] * wx;
    const sn = cx * up[0] + cy * up[1] + cz * up[2];
    const cs = f[0] * wx + f[1] * wy + f[2] * wz;
    const ang = Math.atan2(sn, cs);
    const maxT = c.turnSpeed * dt * (0.35 + 0.65 * Math.min(1, c.speed / Math.max(0.1, c.walkSpeed)) + (c.speed < 0.05 ? 0.4 : 0));
    turn = clamp(ang, -maxT, maxT);
    remain = Math.abs(ang - turn);
    if (Math.abs(turn) > 1e-7) rotAxis(f, 0, up[0], up[1], up[2], turn);
  }
  c.turnRate = dt > 0 ? turn / dt : 0;
  const target = c.wantSpeed * (remain > 0.9 ? 0.25 : remain > 0.4 ? 0.6 : 1);
  c.speed += (target - c.speed) * damp(c.speed < target ? c.accel : c.decel, dt);
  if (c.speed < 0.004) c.speed = 0;
  if (c.speed > 0 && dt > 0) {
    const step = c.speed * dt;
    const nx = c.pos[0] + f[0] * step, ny = c.pos[1] + f[1] * step, nz = c.pos[2] + f[2] * step;
    const l = Math.hypot(nx, ny, nz);
    const dx = nx / l, dy = ny / l, dz = nz / l;
    c.hAcc = (c.hAcc || 0) + 1;
    let h;
    if (c.hAcc >= sampleEvery || c.h === undefined) {
      h = env.height(dx, dy, dz);
      if (c.h !== undefined && c.hAcc > 0) c.hGrad = clamp((h - c.h) / Math.max(1e-3, step * c.hAcc), -3, 3);
      c.hAcc = 0;
    } else {
      h = c.h + (c.hGrad || 0) * step;
    }
    const wet = h < env.sea + (c.aquatic ? -1e9 : 0.35);
    const steep = Math.abs(c.hGrad || 0) > (c.maxSlope ?? 1.2);
    if (wet || (steep && c.hGrad > 0)) {
      c.blocked = (c.blocked || 0) + dt;
      c.speed *= 0.5;
      c.hAcc = sampleEvery;          // force resample next time
      if (wet) c.hGrad = 0;
    } else {
      c.blocked = Math.max(0, (c.blocked || 0) - dt * 0.5);
      c.h = h;
      const r = env.R + h;
      c.pos[0] = dx * r; c.pos[1] = dy * r; c.pos[2] = dz * r;
      up[0] = dx; up[1] = dy; up[2] = dz;
      const fd = f[0] * dx + f[1] * dy + f[2] * dz;
      f[0] -= dx * fd; f[1] -= dy * fd; f[2] -= dz * fd;
      const fl = Math.hypot(f[0], f[1], f[2]) || 1;
      f[0] /= fl; f[1] /= fl; f[2] /= fl;
    }
  }
  c.vel[0] = f[0] * c.speed; c.vel[1] = f[1] * c.speed; c.vel[2] = f[2] * c.speed;
}

// ------------------------------------------------------------------------------------------ herd
const GRAZE = 0, WANDER = 1, ALERT = 2, FLEE = 3;

export class Herd {
  /**
   * @param members creatures (already placed)
   * @param home Float64Array(3) planet-local ground point (home range center)
   */
  constructor(species, members, home, rng, env) {
    this.species = species;
    this.members = members;
    this.home = Float64Array.from(home);
    this.rng = rng;
    this.state = GRAZE;
    this.timer = rng.range(8, 30);
    this.target = Float64Array.from(home);
    this.center = new Float64Array(3);
    this.fleeDir = new Float64Array(3);
    const g = species.genome, sz = g.S;
    const giant = species.archetype === 'giant';
    this.alertR = giant ? 55 : 16 + sz * 12;
    this.fleeR = (species.temper === 'skittish') ? 8 + sz * 7 : (species.temper === 'calm' ? 4 + sz * 2 : 0);
    if (giant) this.fleeR = 0;
    this.safeR = this.alertR * 2.6;
    this.range = giant ? 260 : 140;
    this.spacing = (g.S * g.bodyLen + g.S * 0.8) * 1.15;
    this.env = env;
    // formation slots (polar offsets)
    members.forEach((m, i) => {
      const a = i * 2.39996 + rng.range(-0.3, 0.3);
      const r = this.spacing * (0.6 + Math.sqrt(i + 0.5) * 0.9);
      m.slotA = a; m.slotR = r;
      m.mode = 0; m.mtimer = rng.range(0, 8);
      m.stepTarget = new Float64Array(3);
    });
  }

  _computeCenter() {
    const c = this.center; c[0] = c[1] = c[2] = 0;
    for (const m of this.members) { c[0] += m.pos[0]; c[1] += m.pos[1]; c[2] += m.pos[2]; }
    const n = this.members.length || 1;
    c[0] /= n; c[1] /= n; c[2] /= n;
  }

  /** choose a new wander target within the home range, on land */
  _pickTarget(env) {
    const rng = this.rng;
    for (let k = 0; k < 6; k++) {
      const ux = this.center[0], uy = this.center[1], uz = this.center[2];
      const l = Math.hypot(ux, uy, uz);
      tangentBasis(ux / l, uy / l, uz / l, _e, _n);
      const a = rng.range(0, Math.PI * 2), r = rng.range(25, 70);
      let x = this.center[0] + (_e[0] * Math.cos(a) + _n[0] * Math.sin(a)) * r;
      let y = this.center[1] + (_e[1] * Math.cos(a) + _n[1] * Math.sin(a)) * r;
      let z = this.center[2] + (_e[2] * Math.cos(a) + _n[2] * Math.sin(a)) * r;
      // pull toward home if far
      const hx = this.home[0] - x, hy = this.home[1] - y, hz = this.home[2] - z;
      const hd = Math.hypot(hx, hy, hz);
      if (hd > this.range) { const k2 = (hd - this.range * 0.6) / hd; x += hx * k2; y += hy * k2; z += hz * k2; }
      const L = Math.hypot(x, y, z);
      const h = env.height(x / L, y / L, z / L);
      if (h > env.sea + 1.5) { const r2 = env.R + h; this.target[0] = x / L * r2; this.target[1] = y / L * r2; this.target[2] = z / L * r2; return true; }
    }
    this.target.set(this.home);
    return false;
  }

  update(dt, env) {
    this._computeCenter();
    const P = env.player;
    const dxp = P[0] - this.center[0], dyp = P[1] - this.center[1], dzp = P[2] - this.center[2];
    const dPlayer = Math.hypot(dxp, dyp, dzp);
    // nearest member distance (threat is personal)
    let dNear = Infinity;
    for (const m of this.members) { const d = Math.hypot(P[0] - m.pos[0], P[1] - m.pos[1], P[2] - m.pos[2]); m.dPlayer = d; if (d < dNear) dNear = d; }
    // a still observer is tolerated (Planet Earth camera-crew rule); a running / driving one is not
    const still = env.playerSpeed < 0.6;
    const threatBoost = env.playerSpeed > 6 ? 1.8 : env.playerSpeed > 3 ? 1.25 : still ? 0.55 : 1;
    this.timer -= dt;
    switch (this.state) {
      case GRAZE:
        if (dNear < this.alertR * threatBoost && env.playerOnGround && !(this.tame && env.playerSpeed < 1.5)) { this.state = ALERT; this.timer = 3; }
        else if (this.timer <= 0) { this.state = WANDER; this.timer = this.rng.range(25, 45); this._pickTarget(env); }
        break;
      case WANDER: {
        const tx = this.target[0] - this.center[0], ty = this.target[1] - this.center[1], tz = this.target[2] - this.center[2];
        if (dNear < this.alertR * threatBoost && env.playerOnGround && !(this.tame && env.playerSpeed < 1.5)) { this.state = ALERT; this.timer = 3; }
        else if (Math.hypot(tx, ty, tz) < this.spacing * 2 || this.timer <= 0) { this.state = GRAZE; this.timer = this.rng.range(20, 50); }
        break;
      }
      case ALERT:
        if (this.fleeR > 0 && dNear < this.fleeR * threatBoost * (still ? 0.6 : 1) && !(this.tame && env.playerSpeed < 1.5)) {
          this.state = FLEE; this.timer = this.rng.range(5, 9);
          this.fleeDir[0] = -dxp; this.fleeDir[1] = -dyp; this.fleeDir[2] = -dzp;
        } else if (dNear > this.alertR * 1.35 * threatBoost) { if (this.timer <= 0) { this.state = GRAZE; this.timer = this.rng.range(6, 20); } }
        else this.timer = 3;
        break;
      case FLEE:
        this.fleeDir[0] += (-dxp / (dPlayer || 1) - this.fleeDir[0]) * damp(1.5, dt);
        this.fleeDir[1] += (-dyp / (dPlayer || 1) - this.fleeDir[1]) * damp(1.5, dt);
        this.fleeDir[2] += (-dzp / (dPlayer || 1) - this.fleeDir[2]) * damp(1.5, dt);
        if (this.timer <= 0 && dNear > this.safeR * 0.6) { this.state = WANDER; this.timer = 12; this._pickTarget(env); }
        break;
    }
    this._members(dt, env);
  }

  _members(dt, env) {
    const sp = this.species, g = sp.genome;
    const walk = g.walkSpeed, run = g.runSpeed;
    const rng = this.rng;
    const P = env.playerHead;
    const cx = this.center[0], cy = this.center[1], cz = this.center[2];
    for (const m of this.members) {
      const s = m.scale;
      m.mtimer -= dt;
      m.look = null; m.alert += ((this.state >= ALERT ? 1 : 0) - m.alert) * damp(3, dt);
      let wantSpeed = 0, wx = 0, wy = 0, wz = 0, graze = 0;
      if (this.state === GRAZE) {
        // individual cycle: eat → look up → step
        if (m.mtimer <= 0) {
          m.mode = (m.mode + 1) % 3;
          if (m.mode === 0) m.mtimer = rng.range(4, 12);
          else if (m.mode === 1) m.mtimer = rng.range(1.5, 3.5);
          else {
            m.mtimer = rng.range(1.5, 3.2);
            // step to a spot near the herd, respecting the slot
            const up = m.up; tangentBasis(up[0], up[1], up[2], _e, _n);
            const a = rng.range(0, Math.PI * 2), r = rng.range(0.8, 3.0) * s;
            m.stepTarget[0] = m.pos[0] + (_e[0] * Math.cos(a) + _n[0] * Math.sin(a)) * r;
            m.stepTarget[1] = m.pos[1] + (_e[1] * Math.cos(a) + _n[1] * Math.sin(a)) * r;
            m.stepTarget[2] = m.pos[2] + (_e[2] * Math.cos(a) + _n[2] * Math.sin(a)) * r;
            // drift back toward the herd if straying
            const dc = Math.hypot(cx - m.pos[0], cy - m.pos[1], cz - m.pos[2]);
            if (dc > m.slotR * 1.6) { const k = 0.5; m.stepTarget[0] += (cx - m.pos[0]) * k * 0.2; m.stepTarget[1] += (cy - m.pos[1]) * k * 0.2; m.stepTarget[2] += (cz - m.pos[2]) * k * 0.2; }
          }
        }
        if (m.mode === 0) { graze = 1; }
        else if (m.mode === 1) { graze = 0; if (m.dPlayer < 80) m.look = P; }
        else {
          graze = 0.35;
          wx = m.stepTarget[0] - m.pos[0]; wy = m.stepTarget[1] - m.pos[1]; wz = m.stepTarget[2] - m.pos[2];
          wantSpeed = Math.hypot(wx, wy, wz) > 0.3 * s ? walk * 0.4 * s : 0;
        }
      } else if (this.state === WANDER) {
        // head for target + slot offset
        const up = m.up; tangentBasis(up[0], up[1], up[2], _e, _n);
        const ox = (_e[0] * Math.cos(m.slotA) + _n[0] * Math.sin(m.slotA)) * m.slotR;
        const oy = (_e[1] * Math.cos(m.slotA) + _n[1] * Math.sin(m.slotA)) * m.slotR;
        const oz = (_e[2] * Math.cos(m.slotA) + _n[2] * Math.sin(m.slotA)) * m.slotR;
        wx = this.target[0] + ox - m.pos[0]; wy = this.target[1] + oy - m.pos[1]; wz = this.target[2] + oz - m.pos[2];
        const dist = Math.hypot(wx, wy, wz);
        wantSpeed = dist > this.spacing * 0.5 ? walk * s * (0.85 + 0.3 * smooth(10, 40, dist)) : 0;
        graze = wantSpeed > 0 ? 0 : 0.8;
        if (m.dPlayer < 40) m.look = P;
      } else if (this.state === ALERT) {
        graze = 0;
        m.look = P;
        if (sp.temper === 'curious' && m.dPlayer > 6 + 4 * s && m.index % 2 === 0) {
          wx = P[0] - m.pos[0]; wy = P[1] - m.pos[1]; wz = P[2] - m.pos[2];
          wantSpeed = walk * 0.6 * s;
        } else if (m.dPlayer < this.alertR * 0.6 && sp.temper !== 'curious') {
          // shy away slowly
          wx = m.pos[0] - P[0]; wy = m.pos[1] - P[1]; wz = m.pos[2] - P[2];
          wantSpeed = walk * 0.5 * s;
        }
      } else { // FLEE
        graze = 0;
        wx = this.fleeDir[0]; wy = this.fleeDir[1]; wz = this.fleeDir[2];
        // cohesion: steer slightly toward herd center, keep formation spread
        wx += (cx - m.pos[0]) * 0.01; wy += (cy - m.pos[1]) * 0.01; wz += (cz - m.pos[2]) * 0.01;
        wantSpeed = run * s * (0.85 + 0.15 * m.seed);
        if (m.dPlayer < 30) m.look = null;
      }
      // separation
      let sx = 0, sy = 0, sz = 0;
      const minD = this.spacing * 0.75 * s;
      for (const o of this.members) {
        if (o === m) continue;
        const dx = m.pos[0] - o.pos[0], dy = m.pos[1] - o.pos[1], dz = m.pos[2] - o.pos[2];
        const d = Math.hypot(dx, dy, dz);
        if (d < minD && d > 1e-4) { const k = (minD - d) / (minD * d); sx += dx * k; sy += dy * k; sz += dz * k; }
      }
      const sepL = Math.hypot(sx, sy, sz);
      if (sepL > 0.15) {
        const wl = Math.hypot(wx, wy, wz) || 1;
        wx = wx / wl + sx * 1.5; wy = wy / wl + sy * 1.5; wz = wz / wl + sz * 1.5;
        if (wantSpeed < walk * 0.3 * s) wantSpeed = walk * 0.3 * s;
        graze = Math.min(graze, 0.3);
      }
      // blocked by water / cliffs: turn around
      if ((m.blocked || 0) > 0.6) {
        wx = cx - m.pos[0] + (this.home[0] - m.pos[0]) * 0.5; wy = cy - m.pos[1] + (this.home[1] - m.pos[1]) * 0.5; wz = cz - m.pos[2] + (this.home[2] - m.pos[2]) * 0.5;
        if (this.state === WANDER && m.blocked > 2) { this._pickTarget(env); m.blocked = 0; }
      }
      m.want[0] = wx; m.want[1] = wy; m.want[2] = wz;
      m.wantSpeed = wantSpeed;
      m.grazeTarget = graze;
      // small critters sit up on their haunches to look around (meerkat / prairie-dog sentinel):
      // during the look-up phase of grazing and whenever the herd is alert
      if (sp.archetype === 'critter') m.rearTarget = wantSpeed < 0.05 && ((this.state === GRAZE && m.mode === 1) || this.state === ALERT) ? 1 : 0;
    }
  }

  getState() { return ['graze', 'wander', 'alert', 'flee'][this.state]; }
}
