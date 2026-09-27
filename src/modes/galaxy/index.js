// GalaxyMode — one galaxy. OWNED BY THE GALAXY TRACK. Placeholder: star points from GalaxyModel.
// Contract: selecting a star calls
//   engine.director.go('system', { galaxy, star: <index> }, { transition: 'white' })
import * as THREE from 'three';
import { Mode } from '../../core/Mode.js';
import { OrbitRig } from '../../core/OrbitRig.js';
import { galaxyStar } from '../../universe/GalaxyModel.js';
import { blackbody } from '../../core/math.js';

export default class GalaxyMode extends Mode {
  constructor(engine) {
    super(engine);
    this.inputScheme = 'orbit';
    this.look = { exposure: 1.1, bloom: { strength: 0.8, radius: 0.85, threshold: 0.7 }, vignette: 0.3 };
  }

  async enter(params) {
    const e = this.engine;
    this.galaxyIndex = parseInt(params.galaxy ?? 0, 10) || 0;
    const gal = this.galaxy = e.universe.galaxy(this.galaxyIndex);
    const n = Math.floor(200000 * e.quality.particleScale);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const s = {}, c = new THREE.Color();
    const scale = 1 / 1000; // 1 unit = 1000 ly
    for (let i = 0; i < n; i++) {
      galaxyStar(gal, i, s);
      pos[i * 3] = s.x * scale; pos[i * 3 + 1] = s.y * scale; pos[i * 3 + 2] = s.z * scale;
      blackbody(s.temperature, c).multiplyScalar(0.25 + Math.min(2, Math.log10(1 + s.luminosity)) * 0.4);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.12, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    this.scene.add(this.points);
    this.rig = new OrbitRig(this.camera, { distance: gal.radius * scale * 2.2, minDistance: 0.05, maxDistance: gal.radius * scale * 6, pitch: 0.6 });
    this.camera.near = 0.01; this.camera.far = 1e5; this.camera.updateProjectionMatrix();
    e.ui.setLocation({ scale: 'Galaxy', title: gal.name, subtitle: gal.type });
    e.ui.showTitle(gal.name.toUpperCase(), `${gal.type} galaxy`, 3000);
    e.audio.setScene('galaxy');
    this.ray = new THREE.Raycaster();
    this.ray.params.Points.threshold = 0.08;
    this.ready = true;
  }

  update(dt) {
    const input = this.engine.input;
    this.rig.handleInput(input, dt);
    this.rig.update(dt);
    this.points.rotation.y += dt * 0.01;
    if (input.pointer.clicked && !input.pointer.dragging) {
      this.ray.setFromCamera(new THREE.Vector2(input.pointer.nx, input.pointer.ny), this.camera);
      const hit = this.ray.intersectObject(this.points)[0];
      if (hit) this.engine.director.go('system', { galaxy: this.galaxyIndex, star: hit.index }, { transition: 'white' });
    }
  }

  exit() { this.points.geometry.dispose(); this.points.material.dispose(); }
  getState() { return { galaxy: this.galaxyIndex, distance: this.rig.distance }; }
}
