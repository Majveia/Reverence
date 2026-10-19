// Player track — camera rig for the explorer.
//
//   third person : spring-arm with a critically-damped pivot, over-the-shoulder framing, look-ahead,
//                  terrain + collider collision (pull in fast, ease out slow), auto-recenter behind
//                  motion, pitch drift, FOV kick (sprint / glide / dive), trauma-based shake, glide roll.
//   first person : eye from the animated head (stabilised), body stays visible below (body awareness).
//   fly / orbit  : debug free-flight and planet overview (kept from the baseline for URL compatibility).
//
// The camera heading is a tangent vector (`fwd`) parallel-transported over the sphere every frame,
// so there is no gimbal / pole trouble anywhere on the planet. All math is planet-local float64.
import * as THREE from 'three';
import { clamp, dampF, damp, lerp, smoothstep, saturate, Spring3, Spring, projectOnPlane, orthoForward, quatLookDir, fbm1, wrapPi } from './util.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _r = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export class CameraRig {
  constructor(world, player) {
    this.world = world;
    this.player = player;
    this.cam = world.camera;
    this.fwd = new THREE.Vector3(0, 0, 1);   // tangent heading
    this.pitch = -0.14;
    this.zoom = 1;                          // user zoom multiplier (wheel / pinch)
    this.dist = 4.6;                        // current (collision-limited) arm length
    this.pivot = new Spring3(14, 1);
    this.pivotInit = false;
    this.fovBase = 58;
    this.fov = new Spring(58, 5, 1);
    this.trauma = 0;
    this.t = 0;
    this.idleLook = 99;                     // seconds since the last manual look input
    this.roll = 0;
    this.lift = 0;
    this.shoulder = 0.55;
    this.fpEye = new THREE.Vector3();
    this.fpInit = false;
    this.hideBody = false;
    this.camF = new THREE.Vector3();
    this.camRight = new THREE.Vector3();
    this.orbit = { yaw: 0, pitch: 0.25, dist: 0 };
    this.restSnap = false;                  // jump straight to the rest composition (act=rest captures)
    this.frameW = 0;                        // composition weight shown (rest / overlook), for debugging
    // framing preset (B cycles, URL frame=): 'auto' (the director: rest / overlook / glide…), 'shoulder' (close
    // over the right shoulder, the pack and the scarf in frame, the view ahead), 'wide' (the small figure under a
    // vast sky: lens far back and low, the horizon on the lower third), 'low' (lens near the ground looking up past
    // the figure — the walker against the sky / a giant overhead)
    this.framing = 'auto';
    this.fS = 0; this.fW = 0; this.fL = 0;
    this.snapFrame = false;
  }

  static FRAMINGS = ['auto', 'shoulder', 'wide', 'low'];

  /** Parallel-transport the heading onto the tangent plane of `up` (call once per frame). */
  transport(up) { orthoForward(up, this.fwd, this.fwd); }

  /** Apply look input (radians; x = yaw right, y = pitch up). */
  look(up, dx, dy, fp) {
    if (dx || dy) this.idleLook = 0;
    if (dx) this.fwd.applyAxisAngle(up, -dx);
    this.pitch = clamp(this.pitch + dy, fp ? -1.45 : -1.25, fp ? 1.45 : 1.05);
  }

  addTrauma(x) { this.trauma = Math.min(1, this.trauma + x); }

  /** Camera look direction (unit) and right vector at `up`. */
  frame(up) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.camF.copy(this.fwd).multiplyScalar(cp).addScaledVector(up, sp).normalize();
    this.camRight.crossVectors(this.fwd, up).normalize();
    return this.camF;
  }

  /** Rotate the heading toward a tangent direction `dir` at `rate` (rad/s-ish), used for recentering. */
  recenter(up, dir, rate, dt, maxAngle = 2.7) {
    _a.copy(dir); projectOnPlane(_a, up);
    if (_a.lengthSq() < 1e-6) return;
    _a.normalize();
    const ang = Math.atan2(_b.crossVectors(this.fwd, _a).dot(up), this.fwd.dot(_a));
    if (Math.abs(ang) > maxAngle) return;
    this.fwd.applyAxisAngle(up, ang * dampF(rate, dt));
  }

  // ---------------------------------------------------------------------------------- third person
  /**
   * @param ctx { pos (feet), up, vel, state, speed, sprint, glide, dive, grounded, heights, colliders, dt, fpBlend }
   */
  thirdPerson(dt, ctx) {
    this.t += dt;
    this.idleLook += dt;
    const up = ctx.up;
    const st = ctx.state;
    // ---- auto recenter behind motion (never fights the player: waits after manual look)
    const vt = _d.copy(ctx.vel); projectOnPlane(vt, up);
    const sp = vt.length();
    if (ctx.submerged && this.idleLook > 0.9) {
      // underwater: drift to a level ¾ profile of the diver (reads far better than the soles of the boots)
      _a.copy(sp > 0.4 ? vt : ctx.forward || this.fwd);
      projectOnPlane(_a, up);
      if (_a.lengthSq() > 1e-6) { _a.normalize().applyAxisAngle(up, 0.75); this.recenter(up, _a, 0.9, dt, 3.1); }
      this.pitch = damp(this.pitch, -0.04, 1.0, dt);
    } else if (this.idleLook > 0.9 && sp > 1.5 && st !== 'climb') {
      const k = st === 'glide' ? 1.1 : st === 'slide' ? 1.3 : st === 'swim' ? 0.6 : 0.55;
      this.recenter(up, vt, k * smoothstep(1.5, 7, sp), dt, st === 'glide' || st === 'slide' ? 3.0 : 2.3);
    }
    // measured motion of the feet (finite difference, smoothed): ground-snapped states (slide / run downhill) move
    // along the slope while their integrated velocity stays tangent to the sphere, so the true vertical rate
    // must come from the actual displacement
    if (!this._pp) { this._pp = new THREE.Vector3().copy(ctx.pos); this.mvel = new THREE.Vector3(); }
    if (dt > 1e-5) {
      _u.copy(ctx.pos).sub(this._pp).divideScalar(dt);
      if (_u.lengthSq() < 250 * 250) this.mvel.lerp(_u, dampF(10, dt)); else this.mvel.copy(ctx.vel);
    }
    this._pp.copy(ctx.pos);
    const vyC = st === 'slide' || st === 'ground' ? this.mvel.dot(up) : ctx.vel.dot(up);
    if (st === 'climb' && ctx.climbN && this.idleLook > 0.9) {
      // climbing: swing to a ¾ view of the wall on the side we came from, looking a touch up the route
      // high on the face the lens swings wider along the wall and looks down past the climber, so the
      // frame shows the drop and the vista instead of a screen-filling slab of rock
      const hi = smoothstep(3, 12, ctx.climbAgl || 0);
      _a.copy(ctx.climbN).negate(); projectOnPlane(_a, up);
      if (_a.lengthSq() > 1e-6) {
        _a.normalize().applyAxisAngle(up, (ctx.climbSide || 1) * (0.85 + 0.35 * hi));
        this.recenter(up, _a, 1.4, dt, 3.1);
      }
      this.pitch = damp(this.pitch, lerp(0.02, -0.2, hi), 1.2, dt);
    } else if (this.idleLook > 0.9 && sp > 2.5 && (st === 'slide' || st === 'ground')) {
      // follow the grade of the motion: look down the slope you're surfing / running down
      const target = st === 'slide' ? clamp(-0.2 + Math.atan2(vyC, sp) * 0.25, -0.6, 0.1) // surf: keep the run-out and the horizon in frame
        : clamp(-0.13 + Math.atan2(vyC, sp) * 0.75, -0.95, 0.25);
      this.pitch = damp(this.pitch, target, 1.6 * smoothstep(2.5, 9, sp), dt);
    } else if ((ctx.rest || 0) > 0.01 && this.idleLook > 1.5 && st === 'ground') {
      // REST composition: a slow drift to a ¾-back view of the seated figure, lens low and tilted up so the
      // sky holds two thirds of the frame and the figure sits small in the lower third (the creator's
      // "rest as a verb" frames); a very slow breathing drift keeps it alive
      const rw = ctx.rest;
      _a.copy(ctx.forward).applyAxisAngle(up, (ctx.restSide || 1) * (0.78 + 0.05 * Math.sin(this.t * 0.11)));
      this.recenter(up, _a, (this.restSnap ? 60 : 0.55) * rw, dt, 3.14);
      const tgtP = (ctx.restLie ? -0.5 : 0.15) + 0.015 * Math.sin(this.t * 0.17); // lying: look down onto the figure in the flowers (from above the grass, not through it)
      this.pitch = this.restSnap ? tgtP : damp(this.pitch, tgtP, 0.6 * rw, dt);
    } else if ((ctx.stance || 0) > 0.01 && st === 'ground') {
      // STANDOFF: the iaido stance — the lens swings to a low ¾ front-side angle (Ghost-style duel framing),
      // the figure against the sky, held through the flash cut and the slow sheathe
      const sw = ctx.stance;
      _a.copy(ctx.forward).applyAxisAngle(up, 2.25); // the lens looks back at her from the front-left
      this.recenter(up, _a, 1.6 * sw, dt, 3.14);
      this.pitch = damp(this.pitch, 0.1, 1.4 * sw, dt);
    } else if ((ctx.overlook || 0) > 0.01 && this.idleLook > 2 && st === 'ground') {
      // OVERLOOK: standing still at a drop — the lens pulls back, drops to chest height and tilts a touch up:
      // the horizon settles near the lower third, the sky holds about two thirds, the figure small and centred
      // on the lower edge of the land (the creator's "classic overlook" / "over-the-edge" frames)
      this.pitch = damp(this.pitch, 0.11 + 0.01 * Math.sin(this.t * 0.15), 0.7 * ctx.overlook, dt);
    } else if ((this.fW > 0.01 || this.fL > 0.01) && this.idleLook > 1.2 && (st === 'ground' || st === 'swim')) {
      // WIDE / LOW framing presets: the horizon on the lower third (wide), or tilted up past the figure (low)
      const tgt = lerp(lerp(-0.06, 0.1 + 0.01 * Math.sin(this.t * 0.15), this.fW), 0.26, this.fL);
      this.pitch = this.snapFrame ? tgt : damp(this.pitch, tgt, 0.8, dt);
    } else if (this.idleLook > 2.2) {
      const target = st === 'glide' ? 0.01 : st === 'swim' ? -0.32 : st === 'slide' ? -0.2 : sp > 7 ? -0.12 : -0.06;
      this.pitch = damp(this.pitch, target, 0.5, dt);
    }
    // ---- arm length by state
    const glideK = st === 'glide' ? 1 : 0;
    let arm = 4.3 + 0.45 * smoothstep(6, 11, sp) * (1 - glideK) + glideK * (2.9 + (ctx.dive ? 0.9 : 0)) + (st === 'swim' ? 0.35 : st === 'slide' ? -0.15 : 0) + (st === 'climb' ? 0.2 + 0.7 * smoothstep(3, 12, ctx.climbAgl || 0) : 0);
    // looking up from low: shorten the arm so the camera sits low behind the explorer and can tilt up past 45°
    // to frame a giant planet / the sky overhead (BotW; space request)
    const restW = st === 'ground' ? (ctx.rest || 0) : 0;
    const ovW = st === 'ground' ? (ctx.overlook || 0) * (1 - restW) : 0;
    arm *= 1 - (0.35 + 0.2 * smoothstep(0.5, 1.0, this.pitch)) * smoothstep(0.05, 0.9, this.pitch) * (1 - Math.max(restW, ovW));
    arm = lerp(arm, (ctx.restLie ? 3.3 : 5.3) + 0.12 * Math.sin(this.t * 0.13), restW);
    arm = lerp(arm, 9.0, ovW);
    const stW = st === 'ground' ? (ctx.stance || 0) * (1 - restW) : 0;
    arm = lerp(arm, 3.6, stW);
    // framing presets (on foot / swimming; rest keeps its own composition)
    const onFoot = st === 'ground' || st === 'swim' || st === 'slide' ? 1 : 0;
    const fk = this.snapFrame ? 60 : 2.2;
    this.fS = damp(this.fS, this.framing === 'shoulder' ? onFoot : 0, fk, dt);
    this.fW = damp(this.fW, this.framing === 'wide' ? onFoot : 0, fk, dt);
    this.fL = damp(this.fL, this.framing === 'low' ? onFoot : 0, fk, dt);
    const pS = this.fS * (1 - restW), pW = this.fW * (1 - restW), pL = this.fL * (1 - restW);
    arm = lerp(lerp(lerp(arm, 2.7, pS), 9.5, pW), 3.6, pL);
    arm *= this.zoom;
    this.frameW = Math.max(restW, ovW);
    // ---- pivot (critically damped; looser in the air so jumps don't jerk the frame)
    let pivotH = st === 'swim' ? 1.6 : st === 'slide' ? 0.5 : st === 'glide' ? 2.15 : 1.6;
    pivotH = lerp(lerp(pivotH, 1.45, ovW), ctx.restLie ? 0.55 : 1.32, restW);
    pivotH = lerp(lerp(lerp(pivotH, 1.78, pS), 1.45, pW), 0.95, pL);
    pivotH = lerp(pivotH, 1.0, st === 'ground' ? (ctx.stance || 0) * (1 - restW) : 0);
    this.pivot.omega = st === 'glide' ? 10 : st === 'air' ? 12 : st === 'slide' ? 14 : 18;
    // velocity feed-forward cancels the spring's steady-state lag (2v/ω): fast falls / glides / sprints stay
    // framed, while small hops (|vy| < 4 m/s) keep their vertical smoothing
    const vy = st === 'slide' || st === 'ground' ? vyC : ctx.vel.dot(up);
    const ff = 2 / this.pivot.omega;
    const tgt = _a.copy(ctx.pos).addScaledVector(up, pivotH);
    if (st === 'slide') tgt.addScaledVector(this.mvel, ff); // steady fall-line motion: cancel the whole 3D lag (else the pivot trails uphill and the rider drops out of the bottom of the frame)
    else tgt.addScaledVector(vt, 0.1 + ff * 0.85).addScaledVector(up, vy * ff * smoothstep(4, 12, Math.abs(vy)));
    if (st === 'climb' && ctx.climbN) { // chest height along the wall, pulled off the rock
      tgt.copy(ctx.pos).addScaledVector(ctx.climbUp, 1.2).addScaledVector(ctx.climbN, 0.55);
    }
    if (!this.pivotInit || this.restSnap) { this.pivot.reset(tgt); this.pivotInit = true; }
    this.pivot.update(tgt, dt);
    // never let the pivot drift too far (teleports / high speeds)
    if (this.pivot.x.distanceToSquared(tgt) > 16) this.pivot.x.lerp(tgt, 0.5);
    const pivot = _b.copy(this.pivot.x);
    // ---- desired camera position
    const camF = this.frame(up);
    const right = this.camRight;
    let sh = this.shoulder * clamp(arm / 4.5, 0.5, 1.2) * (st === 'glide' ? 1.5 : 1); // gliding: wider side offset → wing silhouette against the sky
    sh = lerp(lerp(sh, 0, ovW), 0.35, restW);
    sh = lerp(lerp(lerp(sh, 0.78, pS), 0, pW), 0.25, pL);
    const want = _c.copy(pivot).addScaledVector(camF, -arm).addScaledVector(right, sh);
    // ---- collision: first try to rise over terrain along the arm (BotW), then pull in as a fallback
    const H = ctx.heights;
    // on foot the lens rides ~1 m over the ground so it stays above meadow grass (flora billboards right
    // in front of the lens read as giant blades); tighter when swimming / climbing / under water
    const clear = lerp(st === 'ground' || st === 'slide' || st === 'air' ? 0.95 : 0.45, 0.6, pL);
    let lift = 0;
    if (H) {
      const N = 9;
      for (let k = 1; k <= N; k++) {
        const t = k / N;
        _f.copy(pivot).lerp(want, t);
        const deficit = H.groundR(_f) + clear - _f.length();
        if (deficit > 0) lift = Math.max(lift, deficit / t);
      }
    }
    lift = Math.min(lift, 3.2);
    this.lift = this.restSnap ? lift : lift > this.lift ? damp(this.lift, lift, 16, dt) : damp(this.lift, lift, 1.8, dt);
    want.addScaledVector(up, this.lift);
    const dir = _r.copy(want).sub(pivot);
    const len = dir.length();
    dir.divideScalar(len || 1);
    let allowed = len;
    if (H) {
      const N = 9;
      for (let k = 1; k <= N; k++) {
        const t = k / N;
        _f.copy(pivot).addScaledVector(dir, len * t);
        const gr = H.groundR(_f) + 0.3;
        if (_f.length() < gr) { allowed = Math.min(allowed, Math.max(0.6, len * (k - 0.8) / N)); break; }
      }
    }
    if (ctx.colliders) {
      const hit = ctx.colliders.raycast(pivot, dir, len, 0.28, 2.2); // small props/vehicles don't block the lens
      if (hit < allowed) allowed = Math.max(1.1, hit - 0.12);
    }
    // pull in fast, ease back out slowly
    this.dist = this.restSnap ? allowed : allowed < this.dist ? damp(this.dist, allowed, 28, dt) : damp(this.dist, allowed, 2.6, dt);
    const pos = _f.copy(pivot).addScaledVector(dir, this.dist);
    // final ground clearance (also over the terrain directly beneath the lens)
    if (H) {
      const gr = H.groundR(pos) + (clear > 0.5 ? 0.75 : 0.28);
      if (pos.length() < gr) pos.setLength(gr);
      if (H.hasOcean && !H.solidSea && !ctx.submerged) { // the lens stays above the sea unless we dive
        const sea = H.R + H.sea + (st === 'swim' ? 0.25 : 0.2);
        if (pos.length() < sea) pos.setLength(sea);
      }
    }
    // ---- shake
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const tr = this.trauma * this.trauma;
    if (tr > 1e-4) {
      const t = this.t * 22;
      pos.addScaledVector(right, fbm1(t, 1) * 0.16 * tr).addScaledVector(up, fbm1(t, 2) * 0.12 * tr);
    }
    this.cam.position.copy(pos);
    // ---- orientation: keep the heading (so the shoulder offset frames the hero off-centre)
    const rollT = st === 'glide' ? clamp(-ctx.bank * 0.12, -0.12, 0.12) : st === 'slide' ? clamp(-ctx.carve * 0.05, -0.06, 0.06) : 0;
    this.roll = damp(this.roll, rollT, 3, dt);
    const rollJ = tr > 1e-4 ? fbm1(this.t * 19, 3) * 0.018 * tr : 0;
    // tilt down to keep the hero framed when the lens rose over terrain
    // (looking up: keep the upward tilt — the lens sits low behind the explorer rather than re-aiming down)
    const liftK = (st === 'slide' ? 0.5 : 0.95) * (1 - smoothstep(0.25, 0.7, this.pitch)) * (1 - 0.25 * restW) * (1 - pL);
    const look = this.lift > 0.02 ? _d.copy(camF).addScaledVector(up, -this.lift * liftK / Math.max(this.dist, 1)).normalize() : camF; // surfing: let the rider sit low so the run-out + horizon stay in frame
    quatLookDir(look, up, this.cam.quaternion);
    if (this.roll || rollJ) { _q.setFromAxisAngle(_u.set(0, 0, 1), this.roll + rollJ); this.cam.quaternion.multiply(_q); }
    // ---- FOV kick
    const fovT = this.fovBase + 5 * smoothstep(6.5, 11, sp) * (st === 'ground' || st === 'slide' ? 1 : 0.4)
      + (st === 'glide' ? 6 + 8 * smoothstep(10, 24, sp) : 0) + (st === 'slide' ? 1.5 * smoothstep(6, 18, sp) : 0)
      + (st === 'air' ? 5 * smoothstep(12, 30, sp) : 0) + ctx.boost * 5;
    let fovF = lerp(lerp(fovT, Math.max(fovT, 50), ovW), Math.min(fovT, 44), restW);
    fovF = lerp(lerp(lerp(fovF, Math.min(fovF, 50), pS), Math.min(fovF, 50), pW), Math.max(fovF, 62), pL);
    if (this.snapFrame) this.fov.reset(fovF);
    if (this.restSnap) this.fov.reset(fovF);
    this._setFov(this.fov.update(fovF, dt));
    this.restSnap = false; this.snapFrame = false;
    this.hideBody = this.dist < 0.75;
    this.fpInit = false;
  }

  // ---------------------------------------------------------------------------------- first person
  firstPerson(dt, ctx, eyeLocal) {
    this.t += dt;
    this.idleLook += dt;
    const up = ctx.up;
    // stabilise the animated eye (keep ~35% of the head motion: alive but not nauseating)
    const stable = _a.copy(ctx.pos).addScaledVector(up, ctx.state === 'swim' ? 1.4 : ctx.state === 'slide' ? 1.25 : 1.64);
    const eye = _b.copy(stable).lerp(eyeLocal, 0.4);
    if (!this.fpInit) { this.fpEye.copy(eye); this.fpInit = true; }
    this.fpEye.lerp(eye, dampF(30, dt));
    if (this.fpEye.distanceToSquared(eye) > 1) this.fpEye.copy(eye);
    const camF = this.frame(up);
    // push the lens slightly forward so the neck ring never clips into view
    const pos = _c.copy(this.fpEye).addScaledVector(this.fwd, 0.14);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const tr = this.trauma * this.trauma;
    this.cam.position.copy(pos);
    quatLookDir(camF, up, this.cam.quaternion);
    const roll = (ctx.state === 'glide' ? clamp(-ctx.bank * 0.15, -0.15, 0.15) : 0) + (tr > 1e-4 ? fbm1(this.t * 19, 3) * 0.02 * tr : 0);
    this.roll = damp(this.roll, roll, 4, dt);
    if (Math.abs(this.roll) > 1e-5) { _q.setFromAxisAngle(_u.set(0, 0, 1), this.roll); this.cam.quaternion.multiply(_q); }
    if (tr > 1e-4) { _q.setFromAxisAngle(_u.set(1, 0, 0), fbm1(this.t * 21, 5) * 0.02 * tr); this.cam.quaternion.multiply(_q); }
    const sp = Math.hypot(ctx.vel.x, ctx.vel.y, ctx.vel.z);
    const fovT = (this.fpFov || 72) + 6 * smoothstep(6.5, 11, sp) + (ctx.state === 'glide' ? 8 : 0) + ctx.boost * 4;
    this._setFov(this.fov.update(fovT, dt));
    this.hideBody = false;
    this.pivotInit = false;
  }

  _setFov(f) {
    if (Math.abs(this.cam.fov - f) > 0.01) { this.cam.fov = f; this.cam.updateProjectionMatrix(); }
  }

  // ---------------------------------------------------------------------------------- orbit / fly
  orbitView(dt, input, R) {
    const o = this.orbit, look = input.axis('look');
    if (!o.dist) o.dist = R * 3.2;
    o.yaw -= look.x; o.pitch = clamp(o.pitch + look.y, -1.4, 1.4);
    if (input.zoom) o.dist = clamp(o.dist * Math.exp(-input.zoom), R * 1.05, R * 40);
    const cp = Math.cos(o.pitch);
    this.cam.position.set(Math.sin(o.yaw) * cp, Math.sin(o.pitch), Math.cos(o.yaw) * cp).multiplyScalar(o.dist);
    // planet-local orientation (camera is a child of world.root, which only translates): look at the centre
    _a.copy(this.cam.position).negate().normalize();
    _u.set(0, 1, 0);
    if (Math.abs(_a.y) > 0.999) _u.set(0, 0, 1);
    quatLookDir(_a, _u, this.cam.quaternion);
    this._setFov(this.fov.update(55, dt));
  }

  flyView(dt, pos, up) {
    const camF = this.frame(up);
    this.cam.position.copy(pos);
    quatLookDir(camF, up, this.cam.quaternion);
    this._setFov(this.fov.update(62, dt));
  }
}
