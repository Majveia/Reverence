// Procedural locomotion for legged creatures.
//   • gait cycles (walk / trot / gallop / tripod / hop) with per-leg phase offsets & duty factors
//   • real foot planting: feet stay locked on the terrain during stance, swing along an arc to a
//     predicted landing spot sampled from PlanetSurface (IK-ish placement on slopes)
//   • analytic 2-bone IK with pole vectors (knees/hocks/elbows bend the right way)
//   • body height/pitch/roll from the planted feet, gait bob, spine sway, breathing
//   • neck/head graze + look-at, tail swish with lag, ear flicks
// Output: creature.wq (world bone quaternions) / creature.wp (world bone pivots), planet-local.
import { qmul, qrot, qeuler, qbasis, qlook, qidentity, qaxis, clamp, sat, smooth, damp, fract, vnoise1 } from '../math.js';
import { LEGGED_BONES as B } from '../bodies/legged.js';

const _q = new Float64Array(8);
const _v = new Float64Array(12);
const _qa = new Float64Array(4), _qb = new Float64Array(4), _qc = new Float64Array(4);

// gait tables: offsets per leg in rig order
// quadruped rig order: [LH, RH, LF, RF]; hexapod: [L0, R0, L1, R1, L2, R2] (0 = rear); hopper: [L, R]
const GAITS = {
  quad: {
    walk: { off: [0, 0.5, 0.25, 0.75], duty: 0.68, lift: 0.13, bob: 0.012, bobF: 2 },
    trot: { off: [0.5, 0, 0, 0.5], duty: 0.5, lift: 0.2, bob: 0.028, bobF: 2 },
    gallop: { off: [0, 0.1, 0.62, 0.52], duty: 0.36, lift: 0.28, bob: 0.05, bobF: 1 },
  },
  hexa: {
    walk: { off: [0, 0.5, 0.33, 0.83, 0.66, 0.16], duty: 0.72, lift: 0.18, bob: 0.008, bobF: 3 },
    trot: { off: [0, 0.5, 0.5, 0, 0, 0.5], duty: 0.55, lift: 0.24, bob: 0.015, bobF: 2 },
    gallop: { off: [0, 0.5, 0.5, 0, 0, 0.5], duty: 0.45, lift: 0.3, bob: 0.02, bobF: 2 },
  },
  biped: {
    walk: { off: [0, 0.03], duty: 0.42, lift: 0.3, bob: 0.0, bobF: 1, hop: 0.14 },
    trot: { off: [0, 0.02], duty: 0.36, lift: 0.4, bob: 0.0, bobF: 1, hop: 0.3 },
    gallop: { off: [0, 0.02], duty: 0.3, lift: 0.5, bob: 0.0, bobF: 1, hop: 0.45 },
  },
};

export class LeggedAnimator {
  constructor(rig, opts = {}) {
    this.rig = rig;
    const g = rig.g;
    this.nb = rig.nb;
    this.kind = g.kind;
    this.table = g.kind === 'hexapod' ? GAITS.hexa : g.kind === 'hopper' ? GAITS.biped : GAITS.quad;
    this.legH = rig.yB;                                  // leg length scale (m, at scale 1)
    this.walkSpeed = g.walkSpeed; this.runSpeed = g.runSpeed;
    this.baseF = g.walkSpeed / Math.max(0.2, this.legH * (g.kind === 'hexapod' ? 1.2 : g.kind === 'hopper' ? 2.2 : 1.35));
    this.opts = opts;
    // leg rest bases (inverse) for IK
    this.legs = rig.legs.map((L) => this._legRest(L));
    this.frontIdx = []; this.hindIdx = [];
    rig.legs.forEach((L, i) => { if (L.k > 0.6) this.frontIdx.push(i); else if (L.k < 0.4) this.hindIdx.push(i); });
    this.zFront = this.frontIdx.length ? rig.legs[this.frontIdx[0]].contact[2] : rig.shP[2];
    this.zHind = this.hindIdx.length ? rig.legs[this.hindIdx[0]].contact[2] : rig.hipP[2];
    this._calibrateGraze();
  }

  _legRest(L) {
    // rest basis for upper & lower: Z = bone dir, X = bend-plane normal from pole
    const r = L.root, k = L.knee, a = L.ankle, p = L.pole;
    const e1 = norm3([k[0] - r[0], k[1] - r[1], k[2] - r[2]]);
    const e2 = norm3([a[0] - k[0], a[1] - k[1], a[2] - k[2]]);
    const ra = [a[0] - r[0], a[1] - r[1], a[2] - r[2]];
    let side = norm3(cross3(ra, p));
    const inv = (dir) => {
      const sx = orth3(side, dir);
      const y = cross3(dir, sx);
      const q = new Float64Array(4);
      qbasis(q, 0, sx[0], sx[1], sx[2], y[0], y[1], y[2], dir[0], dir[1], dir[2]);
      q[0] = -q[0]; q[1] = -q[1]; q[2] = -q[2];   // inverse
      return q;
    };
    return { invUpper: inv(e1), invLower: inv(e2), foot: [L.contact[0] - a[0], L.contact[1] - a[1], L.contact[2] - a[2]], sideRest: side };
  }

  /** Find neck/head pitch so the muzzle reaches the ground when grazing (FK on rest skeleton). */
  _calibrateGraze() {
    const rig = this.rig;
    const hp = rig.headP, nb = rig.neckBase, nm = rig.neckMid;
    const tip = [hp[0] + rig.headDir[0] * rig.Lh, hp[1] + rig.headDir[1] * rig.Lh, hp[2] + rig.headDir[2] * rig.Lh];
    const muzzleY = (a) => {
      // neck1 pitch a*0.55 about nb, neck2 a*0.25 about nm, head a*0.35 about hp (pitch = rotation about X)
      const rot = (p, c, ang) => { const y = p[1] - c[1], z = p[2] - c[2]; const cs = Math.cos(ang), sn = Math.sin(ang); return [p[0], c[1] + y * cs - z * sn, c[2] + y * sn + z * cs]; };
      let t = rot(tip, hp, a * 0.4), h = hp, m = nm;
      t = rot(t, m, a * 0.18); h = rot(h, m, a * 0.18);
      t = rot(t, nb, a * 0.55); h = rot(h, nb, a * 0.55); m = rot(m, nb, a * 0.55);
      return t[1] - rig.hhAbs * 0.4;
    };
    let lo = 0, hi = 2.4;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (muzzleY(mid) > rig.S * 0.02) lo = mid; else hi = mid; }
    this.grazeA = Math.min(lo, 1.9);
    if (this.kind === 'giant') this.grazeA *= 0.62;   // giants browse bushes / low trees
  }

  /** allocate per-creature animation state */
  init(c, rng) {
    const nb = this.nb;
    c.wq = new Float64Array(nb * 4);
    c.wp = new Float64Array(nb * 3);
    c.lq = new Float64Array(nb * 4);
    for (let b = 0; b < nb; b++) qidentity(c.lq, b * 4);
    c.phase = rng.next();
    c.gaitW = [1, 0, 0];                // walk/trot/gallop weights
    c.legs = this.rig.legs.map(() => ({ plant: new Float64Array(3), from: new Float64Array(3), to: new Float64Array(3), cur: new Float64Array(3), mode: 0, timed: false, sig: 0, rate: 3, h: 0, init: false }));
    c.bodyPitch = 0; c.bodyRoll = 0; c.bodyLift = 0;
    c.hy = 0; c.hp = 0;                  // smoothed head yaw / pitch (look)
    c.graze = 0; c.grazeT = 0;
    c.tailSw = rng.next() * 10; c.earT = rng.next() * 10; c.breath = rng.next() * 6;
    c.hopY = 0;
    c.lastYaw = 0; c.turn = 0;
    c.animAcc = 0;
  }

  /**
   * Update pose. ctx: { ground(x,y,z, out) → sets out (planet-local surface point) and returns height rel. radius,
   *   lodSample: bool (sample terrain per foot), t: time }
   */
  update(c, dt, ctx) {
    const rig = this.rig, s = c.scale, nb = this.nb;
    const lq = c.lq, wq = c.wq, wp = c.wp;
    const speed = c.speed;
    // -------------------------------------------------- root frame
    const ux = c.up[0], uy = c.up[1], uz = c.up[2];
    qlook(_qa, 0, c.fwd[0], c.fwd[1], c.fwd[2], ux, uy, uz);
    wq[0] = _qa[0]; wq[1] = _qa[1]; wq[2] = _qa[2]; wq[3] = _qa[3];
    wp[0] = c.pos[0]; wp[1] = c.pos[1]; wp[2] = c.pos[2];
    // turn rate (for tail/lean)
    c.turn += (c.turnRate - c.turn) * damp(4, dt);

    // -------------------------------------------------- gait selection (speed based, smooth weights)
    const ws = this.walkSpeed * s, rs = this.runSpeed * s;
    const vr = speed / Math.max(0.01, ws);
    const wTrot = smooth(1.35, 1.9, vr) * (1 - smooth(rs * 0.55 / ws, rs * 0.75 / ws, vr));
    const wGal = smooth(rs * 0.55 / ws, rs * 0.75 / ws, vr);
    const wWalk = Math.max(0, 1 - wTrot - wGal);
    const gw = c.gaitW; const k = damp(3, dt);
    gw[0] += (wWalk - gw[0]) * k; gw[1] += (wTrot - gw[1]) * k; gw[2] += (wGal - gw[2]) * k;
    const T = this.table;
    const duty = T.walk.duty * gw[0] + T.trot.duty * gw[1] + T.gallop.duty * gw[2];
    const lift = (T.walk.lift * gw[0] + T.trot.lift * gw[1] + T.gallop.lift * gw[2]) * this.legH * s;
    const bobA = (T.walk.bob * gw[0] + T.trot.bob * gw[1] + T.gallop.bob * gw[2]) * rig.S * s;
    const hopA = ((T.walk.hop || 0) * gw[0] + (T.trot.hop || 0) * gw[1] + (T.gallop.hop || 0) * gw[2]) * rig.S * s;
    const moving = speed > 0.06 * s;
    const f = this.baseF * (0.5 + 0.5 * Math.sqrt(Math.max(0, speed / ws))) / Math.sqrt(s);
    if (moving) c.phase += f * dt;
    const stride = speed / Math.max(0.05, f);

    // -------------------------------------------------- feet
    const nl = rig.legs.length;
    let hF = 0, hH = 0, nF = 0, nH = 0, hAll = 0, lAir = 0;
    const ground = ctx.ground;
    for (let i = 0; i < nl; i++) {
      const L = rig.legs[i], st = c.legs[i];
      // home: rest contact under the body (world)
      qrot(wq, 0, L.contact[0] * s, 0, L.contact[2] * s, _v, 0);
      const hx = wp[0] + _v[0], hy = wp[1] + _v[1], hz = wp[2] + _v[2];
      if (!st.init) {
        if (ctx.sample) ground(hx, hy, hz, st.plant, 0); else this._flat(c, hx, hy, hz, st.plant);
        st.cur.set(st.plant); st.init = true;
      }
      const off = T.walk.off[i] * gw[0] + T.trot.off[i] * gw[1] + T.gallop.off[i] * gw[2];
      if (moving && !st.timed) {
        const lp = fract(c.phase + off);
        const inSwing = lp >= duty;
        if (inSwing && st.mode === 0) { st.mode = 1; st.from.set(st.plant); st.sk = -1; }
        if (!inSwing && st.mode === 1) { st.mode = 0; st.plant.set(st.to); st.cur.set(st.to); }
        if (st.mode === 1) {
          st.sig = (lp - duty) / Math.max(0.05, 1 - duty);
          st.rate = f / Math.max(0.05, 1 - duty);
          // predicted landing: home + velocity * (remaining swing + half stance)
          const lead = ((1 - st.sig) * (1 - duty) + duty * 0.5) / Math.max(0.05, f);
          const tx = hx + c.vel[0] * lead, ty = hy + c.vel[1] * lead, tz = hz + c.vel[2] * lead;
          // resample terrain at lift-off and once mid-swing; otherwise keep the last relative height
          const phaseK = st.sig < 0.5 ? 0 : 1;
          this._target(c, st, tx, ty, tz, ctx, st.sk !== phaseK);
          st.sk = phaseK;
        }
      } else if (st.mode === 0) {
        // idle: re-step if foot too far from home
        const dx = st.plant[0] - hx, dy = st.plant[1] - hy, dz = st.plant[2] - hz;
        const err = Math.hypot(dx, dy, dz);
        if (err > this.legH * s * 0.35 && !this._anySwinging(c, i)) {
          st.mode = 1; st.timed = true; st.sig = 0; st.rate = 3.2 / Math.sqrt(s); st.from.set(st.plant);
          this._target(c, st, hx, hy, hz, ctx, true);
        }
      }
      if (st.mode === 1 && (st.timed || !moving)) {
        st.sig += dt * st.rate;
        if (st.sig >= 1) { st.mode = 0; st.timed = false; st.plant.set(st.to); st.cur.set(st.to); }
      }
      // teleport guard
      const ex = st.plant[0] - hx, ey = st.plant[1] - hy, ez = st.plant[2] - hz;
      if (ex * ex + ey * ey + ez * ez > (this.legH * s * 3 + stride) ** 2) { this._project(c, hx, hy, hz, st.plant); st.cur.set(st.plant); st.mode = 0; st.timed = false; }
      // current contact position
      if (st.mode === 1) {
        const sg = clamp(st.sig, 0, 1), e = sg * sg * (3 - 2 * sg);
        const arc = Math.sin(Math.PI * sg);
        const lh = (st.timed ? this.legH * s * 0.12 : lift) + hopA * 0.6;
        st.cur[0] = st.from[0] + (st.to[0] - st.from[0]) * e + ux * lh * arc;
        st.cur[1] = st.from[1] + (st.to[1] - st.from[1]) * e + uy * lh * arc;
        st.cur[2] = st.from[2] + (st.to[2] - st.from[2]) * e + uz * lh * arc;
        lAir++;
      } else { st.cur.set(st.plant); }
      // height of the ground contact relative to the root plane
      const rel = (st.mode === 1 ? (st.from[0] + (st.to[0] - st.from[0]) * 0.5 - wp[0]) * ux + (st.from[1] + (st.to[1] - st.from[1]) * 0.5 - wp[1]) * uy + (st.from[2] + (st.to[2] - st.from[2]) * 0.5 - wp[2]) * uz
        : (st.plant[0] - wp[0]) * ux + (st.plant[1] - wp[1]) * uy + (st.plant[2] - wp[2]) * uz);
      hAll += rel;
      if (L.k > 0.6) { hF += rel; nF++; } else if (L.k < 0.4) { hH += rel; nH++; }
    }
    hAll /= nl;
    const avgF = nF ? hF / nF : hAll, avgH = nH ? hH / nH : hAll;
    const span = Math.max(0.1, (this.zFront - this.zHind) * s);
    const pitchT = this.kind === 'hopper' ? 0 : clamp(-Math.atan2(avgF - avgH, span) * 0.85, -0.45, 0.45);
    c.bodyPitch += (pitchT - c.bodyPitch) * damp(8, dt);
    const liftT = clamp(Math.min(avgF, avgH) * 0.35 + (avgF + avgH) * 0.5 * 0.65, -this.legH * s * 0.45, this.legH * s * 0.35);
    c.bodyLift += (liftT - c.bodyLift) * damp(10, dt);

    // -------------------------------------------------- body (pelvis/spine/chest)
    const ph = c.phase * Math.PI * 2;
    const bobF = T.walk.bobF * gw[0] + T.trot.bobF * gw[1] + T.gallop.bobF * gw[2];
    let bob = moving ? -Math.cos(ph * bobF) * bobA : 0;
    let gallopRock = moving ? Math.sin(ph) * 0.09 * gw[2] : 0;
    // hopping: ballistic body during flight phase
    let hop = 0;
    if (this.kind === 'hopper' && moving) {
      const lp = fract(c.phase);
      if (lp >= duty) { const sg = (lp - duty) / (1 - duty); hop = 4 * sg * (1 - sg) * hopA; gallopRock = -0.18 * Math.sin(Math.PI * sg) * (hopA > 0 ? 1 : 0); }
      else { const sg = lp / duty; bob = -Math.sin(Math.PI * sg) * rig.S * s * 0.07; }
    }
    c.breath += dt * (moving ? 1.8 + speed * 0.1 : 1.1);
    const breathe = Math.sin(c.breath) * 0.012;
    const sway = moving ? Math.sin(ph) * 0.035 * (gw[0] + gw[1] * 0.5) : 0;
    const liftY = c.bodyLift + bob + hop + (c.crouch || 0) * -rig.S * s * 0.12 - (c.rear || 0) * rig.S * s * 0.1;
    // pelvis local translation (root-local up)
    c.rear = (c.rear || 0) + ((c.rearTarget || 0) - (c.rear || 0)) * damp((c.rearTarget || 0) > (c.rear || 0) ? 4 : 6, dt);
    const rear = c.rear * c.rear * (3 - 2 * c.rear);
    qeuler(lq, B.PELVIS * 4, sway * 0.6 - c.turn * 0.05, c.bodyPitch + gallopRock + (c.lean || 0) + c.graze * 0.05 - rear * 1.2, sway * 0.5 + c.bodyRoll);
    qeuler(lq, B.SPINE * 4, -c.turn * 0.12 - sway * 0.5, -gallopRock * 0.3 + breathe * 0.4, 0);
    qeuler(lq, B.CHEST * 4, -c.turn * 0.12 - sway * 0.4, -gallopRock * 0.4 - breathe, -sway * 0.3);
    // -------------------------------------------------- neck & head (graze + look + idle)
    c.graze += ((c.grazeTarget || 0) - c.graze) * damp(c.grazeTarget > c.graze ? 1.6 : 3.5, dt);
    const g = c.graze * this.grazeA;
    // look-at in body frame
    let lyaw = 0, lpitch = 0;
    if (c.look) {
      // vector to target in root frame
      const dx = c.look[0] - wp[0], dy = c.look[1] - wp[1], dz = c.look[2] - wp[2];
      _qb[0] = -wq[0]; _qb[1] = -wq[1]; _qb[2] = -wq[2]; _qb[3] = wq[3];
      qrot(_qb, 0, dx, dy, dz, _v, 3);
      const hx = _v[3], hyv = _v[4] - rig.headP[1] * s, hz = _v[5] - rig.headP[2] * s;
      lyaw = clamp(Math.atan2(hx, hz), -1.6, 1.6);
      lpitch = clamp(-Math.atan2(hyv, Math.hypot(hx, hz)), -0.6, 0.7);
      if (Math.abs(Math.atan2(hx, hz)) > 2.2) { lyaw = 0; lpitch = 0; }
    }
    const t = ctx.t + c.seed * 100;
    const idleY = vnoise1(t * 0.23) * 0.35 * (1 - c.graze) * (c.look ? 0.2 : 1);
    const idleP = vnoise1(t * 0.31 + 7) * 0.12;
    const kh = damp(c.look ? 5 : 2.5, dt);
    c.hy += (lyaw * (1 - c.graze * 0.7) + idleY - c.hy) * kh;
    c.hp += (lpitch * (1 - c.graze) + idleP - c.hp) * kh;
    const chew = c.graze > 0.6 ? Math.sin(t * 9.0) * 0.04 : 0;
    const walkNod = moving ? Math.sin(ph * bobF + 0.6) * 0.05 * (gw[0] + gw[1]) : 0;
    const runNeck = gw[2] * 0.3 * (moving ? 1 : 0);
    // graze: the (slim) neck swings down from the withers almost straight (base 55 %, mid 18 %) and
    // the head tips toward vertical (40 %): neck, throat and jaw read as separate masses, not one tube
    qeuler(lq, B.NECK1 * 4, c.hy * 0.3, g * 0.55 + c.hp * 0.3 + walkNod * 0.5 + runNeck + rear * 0.55, 0);
    qeuler(lq, B.NECK2 * 4, c.hy * 0.3, g * 0.18 + c.hp * 0.3 + walkNod * 0.3 + rear * 0.3, 0);
    qeuler(lq, B.HEAD * 4, c.hy * 0.4, g * 0.4 + c.hp * 0.4 - walkNod * 0.6 + chew - runNeck * 0.8 + rear * 0.3, -c.hy * 0.15);
    // ears
    c.earT += dt;
    const flick = Math.max(0, Math.sin(c.earT * 0.9 + c.seed * 9) - 0.93) * 12;
    const earAlert = (c.alert || 0);
    qeuler(lq, B.EARL * 4, 0.2 * earAlert + flick * 0.25, -0.15 * earAlert + Math.sin(c.earT * 0.7) * 0.06, flick * 0.4);
    qeuler(lq, B.EARR * 4, -0.2 * earAlert - flick * 0.1, -0.15 * earAlert + Math.sin(c.earT * 0.6 + 2) * 0.06, -flick * 0.2);
    // tail
    c.tailSw += dt * (moving ? 2.2 + speed * 0.3 : 1.2);
    const swish = Math.max(0, Math.sin(c.tailSw * 0.37 + c.seed * 5) - 0.7) * 2.5;
    const tailLift = gw[2] * 0.55 + (c.alert || 0) * 0.3 - rear * 0.9;
    const tA = (moving ? 0.18 : 0.08) + swish * 0.3;
    for (let k2 = 0; k2 < 3; k2++) {
      const lag = k2 * 0.9;
      qeuler(lq, (B.TAIL1 + k2) * 4, Math.sin(c.tailSw * 2 - lag) * tA * (0.6 + k2 * 0.4) + c.turn * 0.15 * (k2 + 1), (k2 === 0 ? tailLift : tailLift * 0.3) + Math.sin(c.tailSw - lag) * 0.05, 0);
    }
    // arms (hoppers)
    if (rig.arms.length) {
      for (const A of rig.arms) {
        qeuler(lq, A.upper * 4, 0, (moving ? Math.sin(ph) * 0.3 : Math.sin(t * 0.5) * 0.05) - 0.2, 0);
        qeuler(lq, A.lower * 4, 0, -0.3, 0);
      }
    }

    // -------------------------------------------------- FK
    const piv = rig.pivots;
    for (let b = 1; b < nb; b++) {
      const p = rig.bones[b].parent;
      qmul(wq, p * 4, lq, b * 4, wq, b * 4);
      let ox = (piv[b * 3] - piv[p * 3]) * s, oy = (piv[b * 3 + 1] - piv[p * 3 + 1]) * s, oz = (piv[b * 3 + 2] - piv[p * 3 + 2]) * s;
      if (b === B.PELVIS) oy += liftY;
      qrot(wq, p * 4, ox, oy, oz, _v, 0);
      wp[b * 3] = wp[p * 3] + _v[0]; wp[b * 3 + 1] = wp[p * 3 + 1] + _v[1]; wp[b * 3 + 2] = wp[p * 3 + 2] + _v[2];
    }

    // -------------------------------------------------- leg IK
    for (let i = 0; i < nl; i++) this._solveLeg(c, i, dt);
    void lAir; void hAll;
  }

  _anySwinging(c, except) {
    for (let i = 0; i < c.legs.length; i++) if (i !== except && c.legs[i].mode === 1) return true;
    return false;
  }

  /** project a point onto the root plane (no terrain sampling) */
  _flat(c, x, y, z, out) {
    const ux = c.up[0], uy = c.up[1], uz = c.up[2];
    const d = (x - c.pos[0]) * ux + (y - c.pos[1]) * uy + (z - c.pos[2]) * uz;
    out[0] = x - ux * d; out[1] = y - uy * d; out[2] = z - uz * d;
    return 0;
  }
  _project(c, x, y, z, out) { return this._flat(c, x, y, z, out); }

  /** swing target: point on the root plane lifted by the (cached) terrain height relative to the root */
  _target(c, st, x, y, z, ctx, resample) {
    const ux = c.up[0], uy = c.up[1], uz = c.up[2];
    if (resample) {
      if (ctx.sample) {
        ctx.ground(x, y, z, _v, 6);
        st.th = (_v[6] - c.pos[0]) * ux + (_v[7] - c.pos[1]) * uy + (_v[8] - c.pos[2]) * uz;
      } else st.th = 0;
    }
    this._flat(c, x, y, z, st.to);
    const th = st.th || 0;
    st.to[0] += ux * th; st.to[1] += uy * th; st.to[2] += uz * th;
  }

  _solveLeg(c, i, dt) {
    const rig = this.rig, L = rig.legs[i], R = this.legs[i], st = c.legs[i];
    const s = c.scale, wq = c.wq, wp = c.wp;
    // foot orientation: root rotation * flex
    const sg = st.mode === 1 ? clamp(st.sig, 0, 1) : 0;
    let flex = 0;
    if (st.mode === 1) {
      const a = Math.sin(Math.PI * sg);
      if (this.kind === 'hexapod') flex = 0;
      else if (L.front) flex = a * 1.1 * (1 - sg * 0.4);
      else flex = -a * 0.35 + (sg < 0.3 ? 0.25 * (0.3 - sg) / 0.3 : 0);
      if (this.kind === 'hopper') flex = -a * 0.6;
    }
    qaxis(_qa, 0, 1, 0, 0, flex);
    qmul(wq, 0, _qa, 0, _qc, 0);                           // foot world rotation
    // ankle target = contact - footRot * (contact - ankle)
    const fv = R.foot;
    qrot(_qc, 0, fv[0] * s, fv[1] * s, fv[2] * s, _v, 0);
    let ax = st.cur[0] - _v[0], ay = st.cur[1] - _v[1], az = st.cur[2] - _v[2];
    // hip world
    const ui = L.upper, li = L.lower, fi = L.foot;
    const hx = wp[ui * 3], hy = wp[ui * 3 + 1], hz = wp[ui * 3 + 2];
    const rk = c.rear || 0;
    if (rk > 0.01 && L.k > 0.6) {
      // sitting up: front paws tucked against the chest (chest frame: down-and-forward of the shoulder)
      const reach = (L.L1 + L.L2) * s;
      qrot(wq, B.CHEST * 4, 0, -0.55 * reach, 0.35 * reach, _v, 6);
      const k = rk * rk * (3 - 2 * rk);
      ax += (hx + _v[6] - ax) * k; ay += (hy + _v[7] - ay) * k; az += (hz + _v[8] - az) * k;
    }
    let dx = ax - hx, dy = ay - hy, dz = az - hz;
    let dist = Math.hypot(dx, dy, dz);
    const L1 = L.L1 * s, L2 = L.L2 * s;
    const dmin = Math.abs(L1 - L2) * 1.02 + 1e-4, dmax = (L1 + L2) * 0.9995;
    const dc = clamp(dist, dmin, dmax);
    if (dist < 1e-6) { dx = 0; dy = -1; dz = 0; dist = 1; }
    const nx = dx / dist, ny = dy / dist, nz = dz / dist;
    // pole in world: root-rotated rest pole
    qrot(wq, 0, L.pole[0], L.pole[1], L.pole[2], _v, 3);
    let px = _v[3], py = _v[4], pz = _v[5];
    let pd = px * nx + py * ny + pz * nz;
    px -= nx * pd; py -= ny * pd; pz -= nz * pd;
    let pl = Math.hypot(px, py, pz);
    if (pl < 1e-5) { qrot(wq, 0, 0, 0, 1, _v, 3); px = _v[3]; py = _v[4]; pz = _v[5]; pd = px * nx + py * ny + pz * nz; px -= nx * pd; py -= ny * pd; pz -= nz * pd; pl = Math.hypot(px, py, pz) || 1; }
    px /= pl; py /= pl; pz /= pl;
    const a = (L1 * L1 - L2 * L2 + dc * dc) / (2 * dc);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const kx = hx + nx * a + px * h, ky = hy + ny * a + py * h, kz = hz + nz * a + pz * h;
    const ex = hx + nx * dc, ey = hy + ny * dc, ez = hz + nz * dc;
    // bend-plane normal (side) = (ankle - hip) × pole
    let sx = ny * pz - nz * py, sy = nz * px - nx * pz, sz = nx * py - ny * px;
    const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
    // upper
    this._boneRot(kx - hx, ky - hy, kz - hz, sx, sy, sz, R.invUpper, wq, ui);
    wp[li * 3] = kx; wp[li * 3 + 1] = ky; wp[li * 3 + 2] = kz;
    this._boneRot(ex - kx, ey - ky, ez - kz, sx, sy, sz, R.invLower, wq, li);
    wp[fi * 3] = ex; wp[fi * 3 + 1] = ey; wp[fi * 3 + 2] = ez;
    wq[fi * 4] = _qc[0]; wq[fi * 4 + 1] = _qc[1]; wq[fi * 4 + 2] = _qc[2]; wq[fi * 4 + 3] = _qc[3];
  }

  _boneRot(dx, dy, dz, sx, sy, sz, inv, wq, bi) {
    const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    // orthogonalize side vs dir
    const d = sx * dx + sy * dy + sz * dz;
    let ox = sx - dx * d, oy = sy - dy * d, oz = sz - dz * d;
    const ol = Math.hypot(ox, oy, oz) || 1; ox /= ol; oy /= ol; oz /= ol;
    const yx = dy * oz - dz * oy, yy = dz * ox - dx * oz, yz = dx * oy - dy * ox;
    qbasis(_q, 0, ox, oy, oz, yx, yy, yz, dx, dy, dz);
    qmul(_q, 0, inv, 0, wq, bi * 4);
  }
}

function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function orth3(v, dir) { const d = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]; return norm3([v[0] - dir[0] * d, v[1] - dir[1] * d, v[2] - dir[2] * d]); }
void sat;
