// Mount API (season 2): a gentle colossus can carry two riders on its back.
//   const m = world.get('fauna').mountNear(pos, 40)   // or fauna.mount (nearest to the player), fauna.mounts
//   m.seats[0|1]   THREE.Object3D children of world.root, planet-local; +Z = the mount's forward, +Y = up
//                  (the two seats sit side by side, close, just behind the withers)
//   m.board(rider, i?) → seat Object3D (or null when both are taken); m.leave(rider)
//   m.kneel        0..1 how far it has lowered its head (it bows when a rider stands still before it)
//   m.drive(dir, speed)  steer while ridden: dir = planet-local tangent Vector3 (null → it walks its own
//                  gentle path, a scenic ride), speed 0..1.6 of its walking pace
//   m.pos, m.forward, m.up (Vector3, planet-local), m.height (seat height above its feet, m), m.name
import * as THREE from 'three';
import { qrot } from './math.js';

const _v = new Float64Array(3);
const CHEST = 3;

export class Mount {
  constructor(fauna, group) {
    this.fauna = fauna;
    this.group = group;
    this.creature = group.members[0];
    this.name = group.species.name;
    this.riders = [null, null];
    this.pos = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    const rig = this.creature.rt.rig;
    const g = rig.g, D = rig.D;
    // seat rest positions (body frame, relative to the chest pivot)
    const top = rig.shP[1] + D * (0.6 + (g.hump || 0) * 0.42);
    this.rest = [[0.42, top - rig.shP[1], -D * 0.45], [-0.42, top - rig.shP[1], -D * 0.45]];
    this.height = top;
    this.seats = [0, 1].map((i) => {
      const o = new THREE.Object3D();
      o.name = `fauna:mount-seat${i}`;
      o.userData.mount = this;
      o.userData.index = i;
      o.matrixAutoUpdate = true;
      fauna.world.root.add(o);
      return o;
    });
    this.update();
  }

  get kneel() { return this.group.kneel || 0; }
  get speed() { return this.creature.speed; }

  board(rider, i) {
    if (i === undefined || i === null) i = this.riders.indexOf(null);
    if (i < 0 || i > 1 || (this.riders[i] && this.riders[i] !== rider)) return null;
    this.riders[i] = rider || true;
    this.group.carrying = this.riders.filter(Boolean).length;
    return this.seats[i];
  }

  leave(rider) {
    for (let i = 0; i < 2; i++) if (this.riders[i] === rider || (rider === undefined && this.riders[i])) this.riders[i] = null;
    this.group.carrying = this.riders.filter(Boolean).length;
    if (!this.group.carrying) this.group.drive = null;
  }

  drive(dir, speed = 1) {
    if (!dir) { this.group.drive = null; return; }
    const d = this.group.drive || (this.group.drive = { dir: [0, 0, 0], speed: 1 });
    d.dir[0] = dir.x ?? dir[0]; d.dir[1] = dir.y ?? dir[1]; d.dir[2] = dir.z ?? dir[2];
    d.speed = speed;
  }

  /** seat sockets follow the chest bone (call after the pose update) */
  update() {
    const c = this.creature;
    const s = c.scale;
    this.pos.set(c.pos[0], c.pos[1], c.pos[2]);
    this.forward.set(c.fwd[0], c.fwd[1], c.fwd[2]);
    this.up.set(c.up[0], c.up[1], c.up[2]);
    const wq = c.wq, wp = c.wp, pr = c.poseRoot;
    if (!wq || !wp) return;
    const sx = pr ? c.pos[0] - pr[0] : 0, sy = pr ? c.pos[1] - pr[1] : 0, sz = pr ? c.pos[2] - pr[2] : 0;
    for (let i = 0; i < 2; i++) {
      const r = this.rest[i];
      qrot(wq, CHEST * 4, r[0] * s, r[1] * s, r[2] * s, _v, 0);
      const o = this.seats[i];
      o.position.set(wp[CHEST * 3] + _v[0] + sx, wp[CHEST * 3 + 1] + _v[1] + sy, wp[CHEST * 3 + 2] + _v[2] + sz);
      o.quaternion.set(wq[CHEST * 4], wq[CHEST * 4 + 1], wq[CHEST * 4 + 2], wq[CHEST * 4 + 3]);
    }
  }

  dispose() { for (const o of this.seats) o.removeFromParent(); }
}
