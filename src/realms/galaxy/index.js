// STUB — replaced by the galaxy realm.
import * as THREE from 'three';
import { defaultGrade } from '../../core/post/pipeline.js';
export default class Realm {
  constructor(engine) {
    this.name = 'galaxy'; this.engine = engine; this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, engine.aspect, 0.01, 1e5); this.camera.position.set(0, 0, 60);
    this.grade = { ...defaultGrade(), exposure: 1 }; this.passes = [];
  }
  async init() {
    const n = 20000, p = new Float32Array(n * 3); for (let i = 0; i < n * 3; i++) p[i] = (Math.random() - 0.5) * 80;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.2, color: 0x88aaff })); this.scene.add(this.points);
  }
  async enter() {} exit() {}
  update(dt) { this.points.rotation.y += dt * 0.03; }
  resize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
}
