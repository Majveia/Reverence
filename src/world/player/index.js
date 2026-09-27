// Player subsystem (order 50). OWNED BY THE PLAYER TRACK.
// Baseline controller with three views, spherical gravity and tangent-frame movement:
//   view=surface (default) third-person walker · view=fp first person · view=fly free flight ·
//   view=orbit planet overview.
// URL spawn params (must stay supported): lat, lon, yaw, pitch, alt, dist, tod, view.
// The player track replaces this with a full character (procedural animation, glider, climbing,
// camera collision, etc.). Vehicles take control via world.controller (see ARCHITECTURE.md).
import * as THREE from 'three';
import { latLonToDir, clamp, dampFactor, DEG } from '../../core/math.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _m = new THREE.Matrix4();

class Player {
  constructor(world) {
    this.world = world;
    const p = world.params;
    this.camera = world.camera;
    this.view = p.view || 'surface';
    this.R = world.body.radius;
    this.surface = world.surface;

    // --- spawn: requested lat/lon or nearest land to a pleasant default
    let dir = latLonToDir(p.lat !== undefined ? +p.lat : 12, p.lon !== undefined ? +p.lon : 28);
    if (p.lat === undefined && this.surface) dir = this._findLand(dir);
    this.pos = this._ground(dir, 0);
    this.vel = new THREE.Vector3();
    this.up = dir.clone();
    // forward = local north rotated by yaw
    const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), this.up).normalize();
    if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
    const north = new THREE.Vector3().crossVectors(this.up, east).normalize();
    const yaw = (p.yaw !== undefined ? +p.yaw : 30) * DEG;
    this.forward = north.multiplyScalar(Math.cos(yaw)).addScaledVector(east, Math.sin(yaw)).normalize();
    this.pitch = (p.pitch !== undefined ? +p.pitch : -8) * DEG;
    this.camDist = 5.5;
    this.grounded = true;
    if (p.tod !== undefined) world.celestial.setLocalTime(this.up, +p.tod);

    if (this.view === 'fly') this.pos.addScaledVector(this.up, p.alt !== undefined ? +p.alt : 120);
    this.orbit = { yaw: 0, pitch: 0.2, dist: p.dist !== undefined ? +p.dist : this.R * 3.2 };

    // placeholder body
    const g = new THREE.CapsuleGeometry(0.35, 1.1, 6, 12);
    g.translate(0, 0.9, 0);
    this.mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.55 }));
    this.mesh.castShadow = true;
    world.root.add(this.mesh);
    world.player = this;
    world.controller = this;
    this._updateCamera(1);
  }

  _ground(dir, offset) {
    const d = dir.clone().normalize();
    const h = this.surface ? this.surface.height(d.x, d.y, d.z) : 0;
    const floor = Math.max(h, this.surface && this.surface.seaLevel > -1e8 ? this.surface.seaLevel : -1e9);
    return d.multiplyScalar(this.R + floor + offset);
  }

  _findLand(dir) {
    const S = this.surface;
    if (!S || S.seaLevel < -1e8) return dir;
    let best = dir.clone(), bestScore = -Infinity;
    for (let i = 0; i < 400; i++) {
      const t = i * 2.39996; const r = Math.sqrt(i) * 0.02;
      const e = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
      const n = new THREE.Vector3().crossVectors(dir, e);
      const d = dir.clone().addScaledVector(e, Math.cos(t) * r).addScaledVector(n, Math.sin(t) * r).normalize();
      const h = S.height(d.x, d.y, d.z);
      const score = h > 20 && h < S.amp * 0.35 ? 1 - r : -1;
      if (score > bestScore) { bestScore = score; best = d; if (score > 0.9) break; }
    }
    return best;
  }

  update(dt) {
    if (this.world.controller !== this) { this.mesh.visible = false; return; }
    const input = this.world.input;
    const look = input.axis('look');
    if (input.down('view')) this.view = this.view === 'fp' ? 'surface' : this.view === 'surface' ? 'fp' : this.view;

    if (this.view === 'orbit') { this._orbit(dt, input); return; }

    // rotate heading around local up, pitch the camera
    this.up.copy(this.pos).normalize();
    this.forward.applyAxisAngle(this.up, -look.x);
    this.forward.addScaledVector(this.up, -this.forward.dot(this.up)).normalize();
    this.pitch = clamp(this.pitch + look.y, -1.35, 1.2);
    if (input.zoom) this.camDist = clamp(this.camDist * Math.exp(-input.zoom), 2.2, 14);

    const right = _v.crossVectors(this.forward, this.up).normalize();
    const mv = input.axis('move');

    if (this.view === 'fly') {
      const alt = this.pos.length() - this.R;
      const speed = clamp(alt * 0.8, 15, 20000) * (input.held('boost') ? 4 : 1);
      const camF = this.forward.clone().multiplyScalar(Math.cos(this.pitch)).addScaledVector(this.up, Math.sin(this.pitch));
      this.pos.addScaledVector(camF, mv.y * speed * dt).addScaledVector(right, mv.x * speed * dt);
      if (input.held('ascend')) this.pos.addScaledVector(this.up, speed * dt);
      if (input.held('descend')) this.pos.addScaledVector(this.up, -speed * dt);
      const minR = this._ground(this.up, 2).length();
      if (this.pos.length() < minR) this.pos.setLength(minR);
    } else {
      // walking with spherical gravity
      const g = this.world.body.gravity;
      const sprint = input.held('sprint');
      const speed = sprint ? 9.5 : 4.2;
      const wish = _w.set(0, 0, 0).addScaledVector(this.forward, mv.y).addScaledVector(right, mv.x);
      const tangentVel = this.vel.clone().addScaledVector(this.up, -this.vel.dot(this.up));
      const vertical = this.vel.dot(this.up);
      tangentVel.lerp(wish.multiplyScalar(speed), dampFactor(this.grounded ? 12 : 2, dt));
      let vy = vertical - g * dt;
      if (this.grounded && input.down('jump')) { vy = Math.sqrt(2 * g * 1.4); this.grounded = false; }
      this.vel.copy(tangentVel).addScaledVector(this.up, vy);
      this.pos.addScaledVector(this.vel, dt);
      const groundR = this._ground(this.pos, 0).length();
      const r = this.pos.length();
      if (r <= groundR) { this.pos.setLength(groundR); if (this.vel.dot(this.up) < 0) this.vel.addScaledVector(this.up, -this.vel.dot(this.up)); this.grounded = true; }
      else this.grounded = r - groundR < 0.05;
      // face movement direction
      if (tangentVel.lengthSq() > 0.2) {
        const f = tangentVel.clone().normalize();
        this.bodyFacing = this.bodyFacing ? this.bodyFacing.lerp(f, dampFactor(10, dt)).normalize() : f;
      }
    }
    this._updateCamera(dt);
  }

  _orbit(dt, input) {
    const o = this.orbit, look = input.axis('look');
    o.yaw -= look.x; o.pitch = clamp(o.pitch + look.y, -1.4, 1.4);
    if (input.zoom) o.dist = clamp(o.dist * Math.exp(-input.zoom), this.R * 1.05, this.R * 40);
    const cp = Math.cos(o.pitch);
    this.camera.position.set(Math.sin(o.yaw) * cp, Math.sin(o.pitch), Math.cos(o.yaw) * cp).multiplyScalar(o.dist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.mesh.visible = false;
  }

  _updateCamera(dt) {
    const up = this.up.copy(this.pos).normalize();
    const camF = this.forward.clone().multiplyScalar(Math.cos(this.pitch)).addScaledVector(up, Math.sin(this.pitch)).normalize();
    const right = new THREE.Vector3().crossVectors(camF, up).normalize();
    const camUp = new THREE.Vector3().crossVectors(right, camF).normalize();
    if (this.view === 'surface') {
      const head = this.pos.clone().addScaledVector(up, 1.6);
      const target = head.clone().addScaledVector(camF, -this.camDist).addScaledVector(right, 0.6);
      // keep camera above terrain
      const minR = this._ground(target, 0.6).length();
      if (target.length() < minR) target.setLength(minR);
      this.camera.position.copy(target);
      this.mesh.visible = true;
    } else {
      this.camera.position.copy(this.pos).addScaledVector(up, this.view === 'fp' ? 1.65 : 0);
      this.mesh.visible = false;
    }
    _m.makeBasis(right, camUp, camF.clone().negate());
    this.camera.quaternion.setFromRotationMatrix(_m);
    // body
    this.mesh.position.copy(this.pos);
    const bf = (this.bodyFacing || this.forward).clone().addScaledVector(up, -(this.bodyFacing || this.forward).dot(up)).normalize();
    const br = new THREE.Vector3().crossVectors(up, bf).normalize();
    _m.makeBasis(br, up, bf);
    this.mesh.quaternion.setFromRotationMatrix(_m);
  }

  getState() {
    return {
      view: this.view,
      alt: +(this.pos.length() - this.R - (this.surface ? this.surface.height(...this.pos.clone().normalize().toArray()) : 0)).toFixed(2),
      speed: +this.vel.length().toFixed(2),
      grounded: this.grounded,
    };
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

export default {
  name: 'player',
  order: 50,
  async create(world) { return new Player(world); },
};
