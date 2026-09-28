// Airborne & aquatic group behaviours on a spherical planet (planet-local float64 coordinates).
//   Flock  — boids around a wandering anchor that circles, climbs and swoops (birds, sky rays);
//            scatters away from the player, flaps when climbing, glides when descending, banks in turns
//   Pod    — sky whales cruising in loose formation high above the terrain (terrain look-ahead)
//   Swarm  — jellyfish drifting with the wind, lifted by every bell contraction
//   School — fish boids under the sea surface, avoiding the shallows; the odd one leaps
import { clamp, damp, vnoise1 } from '../math.js';
import { tangentBasis } from './ground.js';

const _e = new Float64Array(3), _n = new Float64Array(3);

/** unit up at p */
function upOf(p, out) { const l = Math.hypot(p[0], p[1], p[2]) || 1; out[0] = p[0] / l; out[1] = p[1] / l; out[2] = p[2] / l; return l; }

/** update heading/bank/turn from velocity (shared by all flyers/swimmers) */
function orient(c, dt, bankK = 1, maxBank = 1.1) {
  const v = c.vel, sp = Math.hypot(v[0], v[1], v[2]);
  const up = c.up;
  upOf(c.pos, up);
  if (sp > 1e-4) {
    const fx = v[0] / sp, fy = v[1] / sp, fz = v[2] / sp;
    // signed yaw rate about up (positive = turning toward +X = creature's left)
    const f = c.fwd;
    const cx = f[1] * fz - f[2] * fy, cy = f[2] * fx - f[0] * fz, cz = f[0] * fy - f[1] * fx;
    const yaw = Math.asin(clamp(cx * up[0] + cy * up[1] + cz * up[2], -1, 1));
    const tr = dt > 0 ? yaw / dt : 0;
    c.turnRate += (tr - c.turnRate) * damp(4, dt);
    f[0] = fx; f[1] = fy; f[2] = fz;
    c.climb = fx * up[0] + fy * up[1] + fz * up[2];
  }
  c.speed = sp;
  c.bank = clamp(-Math.atan(sp * c.turnRate / 9.8) * bankK, -maxBank, maxBank);
}

function groundH(env, p) { const l = Math.hypot(p[0], p[1], p[2]) || 1; return env.height(p[0] / l, p[1] / l, p[2] / l); }

// ============================================================================================ Flock
export class Flock {
  /**
   * @param members creatures with pos/vel set
   * @param home planet-local point at ground level
   * o: { agl:[min,max], radius, speed, ray:boolean }
   */
  constructor(species, members, home, rng, env, o = {}) {
    this.species = species; this.members = members; this.rng = rng;
    this.home = Float64Array.from(home);
    this.anchor = new Float64Array(3);
    this.center = new Float64Array(3);
    this.avgVel = new Float64Array(3);
    this.o = o;
    this.theta = rng.range(0, Math.PI * 2);
    this.omega = (rng.chance(0.5) ? 1 : -1) * (o.speed / Math.max(40, o.radius));
    this.aglT = rng.range(0, 100);
    this.gH = groundH(env, home);
    this.gT = 0;
    this.scatter = 0;
    this.sea = env.sea;
    this._anchor(0, env);
  }

  _anchor(dt, env) {
    const o = this.o;
    this.theta += this.omega * dt * (1 + this.scatter);
    this.aglT += dt;
    upOf(this.home, _n);
    const ux = _n[0], uy = _n[1], uz = _n[2];
    tangentBasis(ux, uy, uz, _e, _n);
    const nX = _n[0], nY = _n[1], nZ = _n[2];
    const r = o.radius * (0.75 + 0.25 * Math.sin(this.aglT * 0.05));
    const c = Math.cos(this.theta), s = Math.sin(this.theta);
    // lemniscate-ish loop around home
    const k2 = Math.sin(this.theta * 2) * 0.35;
    const x = this.home[0] + (_e[0] * c + nX * (s + k2)) * r;
    const y = this.home[1] + (_e[1] * c + nY * (s + k2)) * r;
    const z = this.home[2] + (_e[2] * c + nZ * (s + k2)) * r;
    this.gT -= dt;
    if (this.gT <= 0) { this.gH = Math.max(this.sea, groundH(env, [x, y, z])); this.gT = 0.5; }
    // altitude: slow breathing between min/max, with an occasional low swoop
    const swoop = Math.max(0, Math.sin(this.aglT * 0.11 + this.omega * 40) - 0.72) / 0.28;
    const agl = o.agl[0] + (o.agl[1] - o.agl[0]) * (0.5 + 0.5 * Math.sin(this.aglT * 0.07)) * (1 - swoop * 0.85) + this.scatter * 25;
    const l = Math.hypot(x, y, z);
    const R = env.R + this.gH + agl;
    this.anchor[0] = x / l * R; this.anchor[1] = y / l * R; this.anchor[2] = z / l * R;
  }

  update(dt, env) {
    if (dt <= 0) return;
    const M = this.members, n = M.length, o = this.o;
    // center & average velocity
    const C = this.center, A = this.avgVel;
    C[0] = C[1] = C[2] = 0; A[0] = A[1] = A[2] = 0;
    for (const m of M) { C[0] += m.pos[0]; C[1] += m.pos[1]; C[2] += m.pos[2]; A[0] += m.vel[0]; A[1] += m.vel[1]; A[2] += m.vel[2]; }
    C[0] /= n; C[1] /= n; C[2] /= n; A[0] /= n; A[1] /= n; A[2] /= n;
    // player threat
    const P = env.player;
    const dp = Math.hypot(P[0] - C[0], P[1] - C[1], P[2] - C[2]);
    // a still observer only spooks the flock at close range; a moving one (or a vehicle) much earlier
    const fear = o.fear * (env.playerSpeed < 0.6 ? 0.3 : env.playerSpeed > 6 ? 1.6 : 1);
    this.fearR = fear;
    const threat = dp < fear ? 1 : 0;
    this.scatter += (threat - this.scatter) * damp(threat ? 3 : 0.3, dt);
    this._anchor(dt, env);
    const spd = o.speed;
    const sepD = o.sep;
    for (let i = 0; i < n; i++) {
      const m = M[i];
      const s = m.scale;
      let ax = 0, ay = 0, az = 0;
      // seek anchor (with per-member offset so the flock spreads)
      const tx = this.anchor[0] + m.off[0] - m.pos[0], ty = this.anchor[1] + m.off[1] - m.pos[1], tz = this.anchor[2] + m.off[2] - m.pos[2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      const seekK = o.seek * Math.min(1, tl / 30);
      ax += tx / tl * seekK; ay += ty / tl * seekK; az += tz / tl * seekK;
      // cohesion + alignment
      ax += (C[0] - m.pos[0]) * o.coh + (A[0] - m.vel[0]) * o.ali;
      ay += (C[1] - m.pos[1]) * o.coh + (A[1] - m.vel[1]) * o.ali;
      az += (C[2] - m.pos[2]) * o.coh + (A[2] - m.vel[2]) * o.ali;
      // separation
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const q = M[j];
        const dx = m.pos[0] - q.pos[0], dy = m.pos[1] - q.pos[1], dz = m.pos[2] - q.pos[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < sepD * sepD && d2 > 1e-6) { const d = Math.sqrt(d2), k = (sepD - d) / d * o.sepK; ax += dx * k; ay += dy * k; az += dz * k; }
      }
      // flee the player (burst outward and upward)
      const up = m.up;
      const px = m.pos[0] - P[0], py = m.pos[1] - P[1], pz = m.pos[2] - P[2];
      const pd = Math.hypot(px, py, pz);
      if (pd < fear) { const k = (fear - pd) / fear * o.seek * 2.5 / (pd || 1); ax += px * k + up[0] * o.seek * 1.5; ay += py * k + up[1] * o.seek * 1.5; az += pz * k + up[2] * o.seek * 1.5; }
      // terrain / sea clearance
      m.gT = (m.gT || 0) - dt;
      if (m.gT <= 0) { m.gH = Math.max(env.sea, groundH(env, m.pos)); m.gT = m.dist < 200 ? 0.15 : 0.6; }
      const agl = Math.hypot(m.pos[0], m.pos[1], m.pos[2]) - env.R - m.gH;
      if (agl < o.minAgl) { const k = (o.minAgl - agl) * 0.8; ax += up[0] * k; ay += up[1] * k; az += up[2] * k; }
      // noise (individual wobble)
      const w = vnoise1(env.t * 0.5 + m.seed * 50) * o.wobble;
      _e[0] = m.fwd[1] * up[2] - m.fwd[2] * up[1]; _e[1] = m.fwd[2] * up[0] - m.fwd[0] * up[2]; _e[2] = m.fwd[0] * up[1] - m.fwd[1] * up[0];
      ax += _e[0] * w; ay += _e[1] * w; az += _e[2] * w;
      // integrate
      m.vel[0] += ax * dt; m.vel[1] += ay * dt; m.vel[2] += az * dt;
      let v = Math.hypot(m.vel[0], m.vel[1], m.vel[2]);
      const vmin = spd * 0.65 * Math.sqrt(s), vmax = spd * (1.35 + this.scatter * 0.6) * Math.sqrt(s);
      const vc = clamp(v, vmin, vmax);
      if (v > 1e-6) { m.vel[0] *= vc / v; m.vel[1] *= vc / v; m.vel[2] *= vc / v; v = vc; }
      // limit vertical component (no vertical loops)
      const vu = m.vel[0] * up[0] + m.vel[1] * up[1] + m.vel[2] * up[2];
      const lim = v * 0.55;
      if (Math.abs(vu) > lim) { const k = (Math.sign(vu) * lim - vu); m.vel[0] += up[0] * k; m.vel[1] += up[1] * k; m.vel[2] += up[2] * k; }
      m.pos[0] += m.vel[0] * dt; m.pos[1] += m.vel[1] * dt; m.pos[2] += m.vel[2] * dt;
      orient(m, dt, o.ray ? 0.6 : 1, o.ray ? 0.6 : 1.15);
      // flap when climbing / slow / scattering; glide when descending
      const burst = vnoise1(env.t * 0.13 + m.seed * 91) > (o.ray ? -1 : 0.05) ? 1 : 0;
      m.flap = clamp(0.15 + m.climb * 4 + this.scatter + burst * 0.7 - (v > spd * 1.1 ? 0.3 : 0), 0, 1);
      m.alert = this.scatter;
    }
  }
}

// ============================================================================================ Pod
export class Pod {
  constructor(species, members, rng, env, o = {}) {
    this.species = species; this.members = members; this.rng = rng; this.o = o;
    this.head = new Float64Array(3);
    this.t0 = rng.range(0, 100);
    const L = members[0];
    this.head.set(L.fwd);
    this.gT = 0; this.gH = 0;
  }
  update(dt, env) {
    if (dt <= 0) return;
    const o = this.o;
    this.t0 += dt;
    const M = this.members;
    const lead = M[0];
    // leader: slow heading wander
    const up = lead.up;
    const turn = vnoise1(this.t0 * 0.02) * 0.05;
    this.gT -= dt;
    if (this.gT <= 0) {
      // terrain look-ahead (max of here and 250 m ahead)
      const a = Math.max(groundH(env, lead.pos), groundH(env, [lead.pos[0] + lead.fwd[0] * 250, lead.pos[1] + lead.fwd[1] * 250, lead.pos[2] + lead.fwd[2] * 250]));
      this.gH = Math.max(env.sea, a);
      this.gT = 1.0;
    }
    for (let i = 0; i < M.length; i++) {
      const m = M[i];
      upOf(m.pos, m.up);
      const r = Math.hypot(m.pos[0], m.pos[1], m.pos[2]);
      const aglT = m.agl + Math.sin(this.t0 * 0.05 + i * 2) * Math.min(25, m.agl * 0.25);
      const alt = r - env.R - this.gH;
      const vUp = clamp((aglT - alt) * 0.05, -1.5, 2.5);
      // heading: leader wanders; followers keep slot relative to leader
      const f = m.fwd;
      // horizontal forward
      const fu = f[0] * m.up[0] + f[1] * m.up[1] + f[2] * m.up[2];
      let hx = f[0] - m.up[0] * fu, hy = f[1] - m.up[1] * fu, hz = f[2] - m.up[2] * fu;
      let hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
      let yaw = turn;
      if (i > 0) {
        // steer toward slot: behind-left/right of leader
        const L0 = lead;
        const sx = L0.pos[0] + (L0.side[0] * m.slot[0] - L0.fwd[0] * m.slot[1]), sy = L0.pos[1] + (L0.side[1] * m.slot[0] - L0.fwd[1] * m.slot[1]), sz = L0.pos[2] + (L0.side[2] * m.slot[0] - L0.fwd[2] * m.slot[1]);
        const dx = sx - m.pos[0], dy = sy - m.pos[1], dz = sz - m.pos[2];
        const lx = m.up[1] * hz - m.up[2] * hy, ly = m.up[2] * hx - m.up[0] * hz, lz = m.up[0] * hy - m.up[1] * hx;   // left
        const side = dx * lx + dy * ly + dz * lz, ahead = dx * hx + dy * hy + dz * hz;
        yaw = clamp(Math.atan2(side, Math.max(20, Math.abs(ahead) + 40)) * 0.08, -0.06, 0.06);
        m.speedT = o.speed * clamp(1 + ahead * 0.01, 0.7, 1.4);
      } else m.speedT = o.speed;
      // rotate heading about up by yaw*dt
      const c = Math.cos(yaw * dt), s = Math.sin(yaw * dt);
      const lx = m.up[1] * hz - m.up[2] * hy, ly = m.up[2] * hx - m.up[0] * hz, lz = m.up[0] * hy - m.up[1] * hx;
      hx = hx * c + lx * s; hy = hy * c + ly * s; hz = hz * c + lz * s;
      m.side = m.side || new Float64Array(3);
      m.side[0] = lx; m.side[1] = ly; m.side[2] = lz;
      m.spd = (m.spd ?? m.speedT) + (m.speedT - (m.spd ?? m.speedT)) * damp(0.3, dt);
      m.vel[0] = hx * m.spd + m.up[0] * vUp; m.vel[1] = hy * m.spd + m.up[1] * vUp; m.vel[2] = hz * m.spd + m.up[2] * vUp;
      m.pos[0] += m.vel[0] * dt; m.pos[1] += m.vel[1] * dt; m.pos[2] += m.vel[2] * dt;
      orient(m, dt, 0.35, 0.25);
      m.flap = clamp(0.4 + vUp * 0.3, 0, 1);
    }
  }
}

// ============================================================================================ Swarm
export class Swarm {
  constructor(species, members, home, rng, env, o = {}) {
    this.species = species; this.members = members; this.rng = rng; this.o = o;
    this.home = Float64Array.from(home);
    this.t0 = rng.range(0, 50);
    this.wind = new Float64Array(3);
    tangentBasis(...(() => { const u = new Float64Array(3); upOf(home, u); return [u[0], u[1], u[2]]; })(), _e, _n);
    const a = rng.range(0, Math.PI * 2);
    for (let k = 0; k < 3; k++) this.wind[k] = (_e[k] * Math.cos(a) + _n[k] * Math.sin(a)) * o.drift;
  }
  update(dt, env) {
    if (dt <= 0) return;
    this.t0 += dt;
    const o = this.o;
    const P = env.player;
    for (const m of this.members) {
      upOf(m.pos, m.up);
      m.gT = (m.gT || 0) - dt;
      if (m.gT <= 0) { m.gH = Math.max(env.sea, groundH(env, m.pos)); m.gT = 0.8; }
      const r = Math.hypot(m.pos[0], m.pos[1], m.pos[2]);
      const agl = r - env.R - m.gH;
      const pulse = m.pulse || 0;
      // vertical: spring to target altitude + pulse thrust
      const vUp = clamp((m.agl - agl) * 0.08, -0.6, 0.8) + pulse * 0.5 - 0.15;
      // horizontal: drift + gentle pull back to home range + wander
      const hx = this.home[0] - m.pos[0], hy = this.home[1] - m.pos[1], hz = this.home[2] - m.pos[2];
      const hd = Math.hypot(hx, hy, hz) || 1;
      const pull = Math.max(0, hd - o.range) * 0.02;
      const wx = vnoise1(this.t0 * 0.07 + m.seed * 13) * 0.4, wy = vnoise1(this.t0 * 0.06 + m.seed * 29) * 0.4;
      tangentBasis(m.up[0], m.up[1], m.up[2], _e, _n);
      let vx = this.wind[0] + hx / hd * pull + (_e[0] * wx + _n[0] * wy);
      let vy = this.wind[1] + hy / hd * pull + (_e[1] * wx + _n[1] * wy);
      let vz = this.wind[2] + hz / hd * pull + (_e[2] * wx + _n[2] * wy);
      // shy away from the player (slowly)
      const px = m.pos[0] - P[0], py = m.pos[1] - P[1], pz = m.pos[2] - P[2];
      const pd = Math.hypot(px, py, pz);
      if (pd < 6 * m.scale + 4) { const k = 1.2 / (pd || 1); vx += px * k; vy += py * k; vz += pz * k; }
      const du = vx * m.up[0] + vy * m.up[1] + vz * m.up[2];
      vx -= m.up[0] * du; vy -= m.up[1] * du; vz -= m.up[2] * du;
      const k = damp(1.2, dt);
      m.vel[0] += (vx + m.up[0] * vUp - m.vel[0]) * k; m.vel[1] += (vy + m.up[1] * vUp - m.vel[1]) * k; m.vel[2] += (vz + m.up[2] * vUp - m.vel[2]) * k;
      m.pos[0] += m.vel[0] * dt; m.pos[1] += m.vel[1] * dt; m.pos[2] += m.vel[2] * dt;
      // heading: horizontal drift direction (slowly)
      const hs = Math.hypot(vx, vy, vz);
      if (hs > 0.05) {
        const f = m.fwd, kk = damp(0.5, dt);
        f[0] += (vx / hs - f[0]) * kk; f[1] += (vy / hs - f[1]) * kk; f[2] += (vz / hs - f[2]) * kk;
        const fu = f[0] * m.up[0] + f[1] * m.up[1] + f[2] * m.up[2];
        f[0] -= m.up[0] * fu; f[1] -= m.up[1] * fu; f[2] -= m.up[2] * fu;
        const fl = Math.hypot(f[0], f[1], f[2]) || 1; f[0] /= fl; f[1] /= fl; f[2] /= fl;
      }
      m.speed = hs;
    }
  }
}

// ============================================================================================ School
export class School {
  constructor(species, members, home, rng, env, o = {}) {
    this.species = species; this.members = members; this.rng = rng; this.o = o;
    this.home = Float64Array.from(home);
    this.anchor = Float64Array.from(home);
    this.C = new Float64Array(3); this.A = new Float64Array(3);
    this.theta = rng.range(0, 6.28);
    this.t0 = rng.range(0, 60);
    this.jumpT = rng.range(3, 9);
  }
  _depthOK(env, x, y, z) { const l = Math.hypot(x, y, z); return env.height(x / l, y / l, z / l) < env.sea - (this.o.minDepth ?? 1.2); }
  update(dt, env) {
    if (dt <= 0) return;
    const o = this.o, M = this.members, n = M.length;
    this.t0 += dt;
    // anchor wanders on a loop around home, staying in deep enough water
    this.theta += dt * o.speed / Math.max(10, o.range);
    const u = this._u || (this._u = new Float64Array(3)); upOf(this.home, u);
    tangentBasis(u[0], u[1], u[2], _e, _n);
    const r = o.range * (0.6 + 0.4 * Math.sin(this.t0 * 0.03));
    const ax = this.home[0] + (_e[0] * Math.cos(this.theta) + _n[0] * Math.sin(this.theta)) * r;
    const ay = this.home[1] + (_e[1] * Math.cos(this.theta) + _n[1] * Math.sin(this.theta)) * r;
    const az = this.home[2] + (_e[2] * Math.cos(this.theta) + _n[2] * Math.sin(this.theta)) * r;
    if (this._depthOK(env, ax, ay, az)) { this.anchor[0] = ax; this.anchor[1] = ay; this.anchor[2] = az; }
    const C = this.C, A = this.A;
    C[0] = C[1] = C[2] = A[0] = A[1] = A[2] = 0;
    for (const m of M) { for (let k = 0; k < 3; k++) { C[k] += m.pos[k]; A[k] += m.vel[k]; } }
    for (let k = 0; k < 3; k++) { C[k] /= n; A[k] /= n; }
    const P = env.player;
    // leaping
    this.jumpT -= dt;
    if (this.jumpT <= 0) {
      this.jumpT = this.showy ? this.rng.range(0.12, 0.4) : this.rng.range(2.5, 8);
      for (let q = this.showy ? 3 : 1; q > 0; q--) {
      const j = M[Math.floor(this.rng.next() * n)];
      if (j && !j.leap) {
        j.leap = true; const up = j.up;
        // launch speed to clear the surface by an apex of 0.6–1.8 m from the current depth
        const dep = Math.max(0, env.R + env.sea - Math.hypot(j.pos[0], j.pos[1], j.pos[2]));
        const k = Math.sqrt(2 * 9.8 * (dep + 0.6 + this.rng.next() * 1.2)); j.vel[0] += up[0] * k; j.vel[1] += up[1] * k; j.vel[2] += up[2] * k; }
      }
    }
    for (let i = 0; i < n; i++) {
      const m = M[i];
      const up = m.up;
      const rr = upOf(m.pos, up);
      const depth = env.R + env.sea - rr;     // > 0 underwater
      if (m.leap) {
        // ballistic leap
        m.vel[0] -= up[0] * 9.8 * dt; m.vel[1] -= up[1] * 9.8 * dt; m.vel[2] -= up[2] * 9.8 * dt;
        m.pos[0] += m.vel[0] * dt; m.pos[1] += m.vel[1] * dt; m.pos[2] += m.vel[2] * dt;
        if (depth > 0.3 && (m.vel[0] * up[0] + m.vel[1] * up[1] + m.vel[2] * up[2]) < 0) m.leap = false;
        orient(m, dt, 0, 0);
        continue;
      }
      let axx = 0, ayy = 0, azz = 0;
      const tx = this.anchor[0] + m.off[0] - m.pos[0], ty = this.anchor[1] + m.off[1] - m.pos[1], tz = this.anchor[2] + m.off[2] - m.pos[2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      axx += tx / tl * o.seek; ayy += ty / tl * o.seek; azz += tz / tl * o.seek;
      axx += (C[0] - m.pos[0]) * 0.3 + (A[0] - m.vel[0]) * 1.2;
      ayy += (C[1] - m.pos[1]) * 0.3 + (A[1] - m.vel[1]) * 1.2;
      azz += (C[2] - m.pos[2]) * 0.3 + (A[2] - m.vel[2]) * 1.2;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const q = M[j];
        const dx = m.pos[0] - q.pos[0], dy = m.pos[1] - q.pos[1], dz = m.pos[2] - q.pos[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < o.sep * o.sep && d2 > 1e-8) { const d = Math.sqrt(d2), k = (o.sep - d) / d * 6; axx += dx * k; ayy += dy * k; azz += dz * k; }
      }
      // depth band
      const want = m.depthT;
      const kd = (depth - want) * 1.5;
      axx += up[0] * kd; ayy += up[1] * kd; azz += up[2] * kd;
      // shallows: push toward the anchor harder
      m.gT = (m.gT || 0) - dt;
      if (m.gT <= 0) { m.shallow = !this._depthOK(env, m.pos[0] + m.vel[0] * 1.5, m.pos[1] + m.vel[1] * 1.5, m.pos[2] + m.vel[2] * 1.5); m.gT = 0.3; }
      if (m.shallow) { axx += tx / tl * o.seek * 3; ayy += ty / tl * o.seek * 3; azz += tz / tl * o.seek * 3; }
      // startle
      const px = m.pos[0] - P[0], py = m.pos[1] - P[1], pz = m.pos[2] - P[2];
      const pd = Math.hypot(px, py, pz);
      if (pd < 7) { const k = (7 - pd) * 3 / (pd || 1); axx += px * k; ayy += py * k; azz += pz * k; }
      m.vel[0] += axx * dt; m.vel[1] += ayy * dt; m.vel[2] += azz * dt;
      const v = Math.hypot(m.vel[0], m.vel[1], m.vel[2]);
      const vmax = o.speed * (pd < 7 ? 3 : 1.4), vmin = o.speed * 0.4;
      const vc = clamp(v, vmin, vmax);
      if (v > 1e-6) { m.vel[0] *= vc / v; m.vel[1] *= vc / v; m.vel[2] *= vc / v; }
      m.pos[0] += m.vel[0] * dt; m.pos[1] += m.vel[1] * dt; m.pos[2] += m.vel[2] * dt;
      orient(m, dt, 0.2, 0.3);
    }
  }
}
