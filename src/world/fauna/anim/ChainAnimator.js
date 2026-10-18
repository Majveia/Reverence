// Procedural animation for chain-rig creatures (birds, sky rays, sky whales, fish, jellyfish).
//   birds : flap cycle with wrist fold on the upstroke, glide with gust wobble, banking, head
//           stabilisation (the head stays level while the body rolls), tail steering
//   rays  : travelling wave along the wing (inner → outer lag), whip tail
//   whales: slow dorso-ventral undulation growing toward the flukes, paddling pectorals, breathing
//   fish  : lateral body wave, frequency ∝ speed
//   jelly : bell contraction (per-bone scale), trailing tentacles with lag
// Input creature fields: pos (centre), fwd (unit, may be pitched), up (planet up), speed, flap (0..1),
// bank (rad), turnRate, look (target or null). Output: wq / wp (and bs for jellies).
import { qmul, qrot, qeuler, qlook, qidentity, qaxis, clamp, damp, fract, vnoise1 } from '../math.js';

const _qa = new Float64Array(4), _qb = new Float64Array(4), _v = new Float64Array(6), _gp = new Float64Array(3);

export class ChainAnimator {
  constructor(rig) {
    this.rig = rig;
    this.nb = rig.nb;
    this.kind = rig.kind;
  }

  init(c, rng) {
    const nb = this.nb;
    c.wq = new Float64Array(nb * 4);
    c.wp = new Float64Array(nb * 3);
    c.lq = new Float64Array(nb * 4);
    for (let b = 0; b < nb; b++) qidentity(c.lq, b * 4);
    if (this.kind === 'jelly') { c.bs = new Float64Array(nb); c.bs.fill(1); }
    c.ph = rng.next();
    c.flapS = 1;
    c.bankS = 0;
    c.hy = 0; c.hp = 0;
  }

  update(c, dt, ctx) {
    const rig = this.rig, g = rig.g, s = c.scale, lq = c.lq, wq = c.wq, wp = c.wp, E = rig.extra;
    const t = ctx.t + c.seed * 37;
    c.flapS += ((c.flap ?? 1) - c.flapS) * damp(2.5, dt);
    c.bankS += ((c.bank || 0) - c.bankS) * damp(3, dt);
    const flap = c.flapS;
    let bobUp = 0;
    // ------------------------------------------------ root
    if (this.kind === 'jelly') {
      // upright bell, leaning a little into the drift
      const lean = clamp(c.speed * 0.12, 0, 0.3);
      qlook(_qa, 0, c.fwd[0], c.fwd[1], c.fwd[2], c.up[0], c.up[1], c.up[2]);
      qeuler(_qb, 0, 0, lean + Math.sin(t * 0.4) * 0.05, Math.sin(t * 0.33) * 0.06);
      qmul(_qa, 0, _qb, 0, wq, 0);
    } else if (this.kind === 'serpent') {
      // serpentine: absolute heading of segment k = A·sin(φ − k·Δφ), φ advancing with the distance
      // travelled (wave speed = ground speed → every segment follows the head's path, no sliding)
      const lam = g.waveLen * g.L * s;
      const moving = c.speed > 0.03;
      c.trav = (c.trav || 0) + c.speed * dt + dt * 0.08;   // a slow idle ripple even at rest
      const speedK = clamp(c.speed / Math.max(0.1, g.walkSpeed * s), 0, 1.6);
      // resting serpents lie in a deep S (≈ 1.4× the crawling amplitude); faster → flatter wave
      const A = g.amp * (1.35 - 0.35 * Math.min(1, speedK)) * (1 - 0.3 * Math.max(0, speedK - 1)) * (1 - 0.35 * (c.alert || 0));
      c.serpA = (c.serpA ?? A) + (A - (c.serpA ?? A)) * damp(1.5, dt);
      const phi = Math.PI * 2 * c.trav / Math.max(0.2, lam);
      const segL = g.L * s * 0.66 / (rig.tail.length - 1);
      const dphi = Math.PI * 2 * segL / Math.max(0.2, lam);
      const th = (k) => c.serpA * Math.sin(phi - k * dphi) * (k === 0 ? 0.6 : 1);
      // alert: rear up the front of the body (cobra), head level, eyes on the threat
      c.rear = (c.rear || 0) + (((c.alert || 0) > 0.5 && !moving ? 1 : 0) - (c.rear || 0)) * damp(2, dt);
      qlook(_qa, 0, c.fwd[0], c.fwd[1], c.fwd[2], c.up[0], c.up[1], c.up[2]);
      qeuler(_qb, 0, th(0), -0.55 * c.rear, 0);
      qmul(_qa, 0, _qb, 0, wq, 0);
      let prev = th(0);
      for (let k = 0; k < rig.tail.length; k++) {
        const a = th(k + 1);
        qeuler(lq, rig.tail[k] * 4, a - prev, k === 0 ? 0.55 * c.rear : 0, 0);
        prev = a;
      }
      // head: counter the body wave, look at the target, flick
      let ly = 0;
      if (c.look) {
        const dx = c.look[0] - c.pos[0], dy = c.look[1] - c.pos[1], dz = c.look[2] - c.pos[2];
        const lx = c.up[1] * c.fwd[2] - c.up[2] * c.fwd[1], lyy = c.up[2] * c.fwd[0] - c.up[0] * c.fwd[2], lz = c.up[0] * c.fwd[1] - c.up[1] * c.fwd[0];
        ly = clamp(Math.atan2(dx * lx + dy * lyy + dz * lz, dx * c.fwd[0] + dy * c.fwd[1] + dz * c.fwd[2]), -0.9, 0.9);
      }
      c.hy += (ly - th(0) * 0.8 + vnoise1(t * 0.4) * 0.15 - c.hy) * damp(3, dt);
      qeuler(lq, 4, c.hy, 0.45 * c.rear - 0.05, 0);
    } else {
      qlook(_qa, 0, c.fwd[0], c.fwd[1], c.fwd[2], c.up[0], c.up[1], c.up[2]);
      qaxis(_qb, 0, 0, 0, 1, c.bankS);
      qmul(_qa, 0, _qb, 0, wq, 0);
    }
    wp[0] = c.pos[0]; wp[1] = c.pos[1]; wp[2] = c.pos[2];
    if (this.kind === 'serpent') { const lift = g.R * 0.62 * s; wp[0] += c.up[0] * lift; wp[1] += c.up[1] * lift; wp[2] += c.up[2] * lift; }

    // ------------------------------------------------ per kind local rotations
    if (this.kind === 'bird') {
      const hz = g.flapHz * (0.85 + 0.3 * flap) / Math.sqrt(s);
      c.ph += dt * hz * (flap > 0.05 ? 1 : 0.15);
      const ph = c.ph * Math.PI * 2;
      const sn = Math.sin(ph), cs = Math.cos(ph);
      const gust = vnoise1(t * 0.9) * 0.05;
      const A = 0.95 * flap;
      // glide = gull-wing "M": arms raised (dihedral), hands drooped & swept → a 3D silhouette under
      // back light instead of a flat kite; per-wing gust asymmetry keeps the flock from looking stamped
      const gustL = gust + vnoise1(t * 1.7 + 3.1) * 0.06, gustR = gust + vnoise1(t * 1.6 + 8.3) * 0.06;
      const r1 = A * (sn * 0.62 + 0.08) + (1 - flap) * 0.16;
      const r2 = A * Math.sin(ph - 0.7) * 0.55 + (1 - flap) * -0.26;
      const fold = flap * Math.max(0, cs) * 0.55 * (sn > 0 ? 1 : 0.4) + (1 - flap) * 0.16;   // wrist folds back on the upstroke
      const twist = flap * sn * 0.16;
      qeuler(lq, E.wL1 * 4, fold * 0.25, twist, r1 + (1 - flap) * gustL);
      qeuler(lq, E.wL2 * 4, fold, twist * 1.6 - (1 - flap) * 0.05, r2 + (1 - flap) * gustL * 0.6);
      qeuler(lq, E.wR1 * 4, -fold * 0.25, twist, -r1 - (1 - flap) * gustR);
      qeuler(lq, E.wR2 * 4, -fold, twist * 1.6 - (1 - flap) * 0.05, -r2 - (1 - flap) * gustR * 0.6);
      bobUp = -sn * g.span * 0.025 * flap * s;
      // tail steers & brakes
      const tpitch = clamp(-(c.climb || 0) * 0.3, -0.35, 0.35) + (1 - flap) * 0.05;
      qeuler(lq, rig.tail[0] * 4, -c.turnRate * 0.12, tpitch, c.bankS * 0.3);
      qeuler(lq, rig.tail[1] * 4, -c.turnRate * 0.08, tpitch * 0.5, 0);
      // head stays level (counter-roll) and scans
      c.hy += ((vnoise1(t * 0.35) * 0.6 + c.turnRate * 0.3) - c.hy) * damp(3, dt);
      qeuler(lq, 4, c.hy, clamp((c.climb || 0) * 0.4, -0.4, 0.4), -c.bankS * 0.85);
    } else if (this.kind === 'ray') {
      const hz = g.flapHz * (0.7 + 0.6 * flap) / Math.sqrt(s);
      c.ph += dt * hz;
      const ph = c.ph * Math.PI * 2;
      const A = 0.22 + 0.2 * flap;
      const r1 = A * Math.sin(ph), r2 = A * 1.45 * Math.sin(ph - 1.1);
      const pitchW = 0.12 * Math.sin(ph - 0.5);
      qeuler(lq, E.wL1 * 4, 0, pitchW, r1);
      qeuler(lq, E.wL2 * 4, 0, pitchW * 1.5, r2);
      qeuler(lq, E.wR1 * 4, 0, pitchW, -r1);
      qeuler(lq, E.wR2 * 4, 0, pitchW * 1.5, -r2);
      bobUp = -Math.sin(ph) * g.thick * 0.8 * s;
      for (let k = 0; k < rig.tail.length; k++) qeuler(lq, rig.tail[k] * 4, Math.sin(ph * 0.5 - k * 0.9) * 0.18 * (k + 1) - c.turnRate * 0.3, Math.sin(ph - k) * 0.05, 0);
      qeuler(lq, 4, 0, -Math.sin(ph) * 0.04, 0);
    } else if (this.kind === 'whale') {
      const hz = (0.09 + 0.05 * flap) / Math.sqrt(s);
      c.ph += dt * hz;
      const ph = c.ph * Math.PI * 2;
      const amp = [0.025, 0.05, 0.08, 0.13];
      for (let k = 0; k < rig.tail.length; k++) qeuler(lq, rig.tail[k] * 4, -c.turnRate * 0.25 * (k + 1) / rig.tail.length, amp[k] * (0.7 + 0.5 * flap) * Math.sin(ph - k * 0.75), 0);
      qeuler(lq, 4, c.turnRate * 0.2, -0.03 * Math.sin(ph + 0.8), 0);
      const pad = Math.sin(ph * 0.5 + 0.4);
      qeuler(lq, E.finL * 4, 0.12 * pad, 0.08 * pad, 0.2 + 0.28 * Math.sin(ph * 0.5));
      qeuler(lq, E.finR * 4, -0.12 * pad, 0.08 * pad, -0.2 - 0.28 * Math.sin(ph * 0.5));
      qeuler(lq, E.fin2L * 4, 0, 0, 0.15 + 0.2 * Math.sin(ph * 0.5 - 1.2));
      qeuler(lq, E.fin2R * 4, 0, 0, -0.15 - 0.2 * Math.sin(ph * 0.5 - 1.2));
      bobUp = Math.sin(ph) * rig.g.R * 0.04 * s;
    } else if (this.kind === 'fish') {
      const hz = (1.2 + 2.6 * clamp(c.speed / Math.max(0.1, g.speed * s), 0, 2)) / Math.sqrt(s);
      c.ph += dt * hz;
      const ph = c.ph * Math.PI * 2;
      const amp = [0.12, 0.22, 0.38];
      for (let k = 0; k < rig.tail.length; k++) qeuler(lq, rig.tail[k] * 4, amp[k] * Math.sin(ph - k * 1.0) - c.turnRate * 0.15, 0, 0);
      qeuler(lq, 4, -0.08 * Math.sin(ph + 0.8), 0, 0);
    } else if (this.kind === 'jelly') {
      c.ph += dt * g.pulseHz;
      const p = fract(c.ph);
      const contr = p < 0.28 ? Math.sin((p / 0.28) * Math.PI * 0.5) : Math.cos(((p - 0.28) / 0.72) * Math.PI * 0.5);
      c.pulse = contr;
      c.bs[E.bell] = 1 - 0.06 * contr;
      c.bs[E.rim] = 1 - 0.2 * contr;
      qeuler(lq, E.bell * 4, 0, 0, 0);
      qeuler(lq, E.rim * 4, 0, 0, 0);
      for (const [chain, off] of [[E.tentA, 0], [E.tentB, 2.1]]) {
        for (let k = 0; k < 3; k++) {
          const lag = k * 0.9 + off;
          qeuler(lq, chain[k] * 4, 0, 0.12 * Math.sin(t * 0.6 + lag) - (k === 0 ? c.speed * 0.15 : 0.05) + contr * 0.08 * (k + 1), 0.1 * Math.sin(t * 0.45 + lag * 1.3));
        }
      }
    }

    // ------------------------------------------------ FK
    const piv = rig.pivots, nb = this.nb, bs = c.bs;
    if (bobUp) { wp[0] += c.up[0] * bobUp; wp[1] += c.up[1] * bobUp; wp[2] += c.up[2] * bobUp; }
    for (let b = 1; b < nb; b++) {
      const p = rig.bones[b].parent;
      qmul(wq, p * 4, lq, b * 4, wq, b * 4);
      const k = s * (bs ? bs[p] : 1);
      qrot(wq, p * 4, (piv[b * 3] - piv[p * 3]) * k, (piv[b * 3 + 1] - piv[p * 3 + 1]) * k, (piv[b * 3 + 2] - piv[p * 3 + 2]) * k, _v, 0);
      wp[b * 3] = wp[p * 3] + _v[0]; wp[b * 3 + 1] = wp[p * 3 + 1] + _v[1]; wp[b * 3 + 2] = wp[p * 3 + 2] + _v[2];
    }
    // serpents drape over the terrain: shift each body segment to the ground under it (rotations
    // stay; the linear blend between neighbours keeps the skin continuous)
    if (this.kind === 'serpent' && ctx.sample && ctx.ground) {
      const lift = g.R * 0.62 * s;
      const base = (wp[0] - c.pos[0]) * c.up[0] + (wp[1] - c.pos[1]) * c.up[1] + (wp[2] - c.pos[2]) * c.up[2];
      for (let k = 0; k < rig.tail.length; k++) {
        const b = rig.tail[k];
        const x = wp[b * 3], y = wp[b * 3 + 1], z = wp[b * 3 + 2];
        const gh = ctx.ground(x, y, z, _gp, 0);
        const r = Math.hypot(x, y, z) || 1;
        const want = ctx.R + gh + Math.min(base, lift * 1.2);
        let d = want - r;
        d = clamp(d, -g.R * 6 * s, g.R * 6 * s);
        wp[b * 3] += x / r * d; wp[b * 3 + 1] += y / r * d; wp[b * 3 + 2] += z / r * d;
      }
    }
  }
}
