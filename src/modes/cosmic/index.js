// CosmicMode — the cosmic web (universe scale). OWNED BY THE COSMIC TRACK.
// Placeholder implementation: noise-filament point cloud. Replace entirely.
// Contract: clicking/tapping a galaxy calls
//   engine.director.go('galaxy', { galaxy: <index> }, { transition: 'fade' })
import * as THREE from 'three';
import { Mode } from '../../core/Mode.js';
import { OrbitRig } from '../../core/OrbitRig.js';
import { Noise } from '../../core/noise.js';
import { RNG } from '../../core/rng.js';

export default class CosmicMode extends Mode {
  constructor(engine) {
    super(engine);
    this.inputScheme = 'orbit';
    this.look = { exposure: 1.0, bloom: { strength: 0.9, radius: 0.9, threshold: 0.6 }, vignette: 0.3, grain: 0.02 };
  }

  async enter() {
    const e = this.engine;
    const n = Math.floor(250000 * e.quality.particleScale);
    const noise = new Noise(e.universe.seed);
    const rng = new RNG(e.universe.seed);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let k = 0;
    while (k < n) {
      const x = rng.range(-1, 1), y = rng.range(-1, 1), z = rng.range(-1, 1);
      const w = 1 - Math.abs(noise.noise3(x * 2.2, y * 2.2, z * 2.2));
      if (rng.next() > Math.pow(w, 12)) continue;
      pos.set([x * 100, y * 100, z * 100], k * 3);
      const c = new THREE.Color().setHSL(0.6 + 0.15 * w, 0.8, 0.35 + 0.4 * Math.pow(w, 20));
      col.set([c.r, c.g, c.b], k * 3);
      k++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.35, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, sizeAttenuation: true }));
    this.scene.add(this.points);
    this.rig = new OrbitRig(this.camera, { distance: 220, minDistance: 5, maxDistance: 600 });
    this.camera.near = 0.1; this.camera.far = 5000; this.camera.updateProjectionMatrix();
    e.ui.setLocation({ scale: 'Universe', title: 'Cosmic Web' });
    e.ui.showTitle('REVERENCE', 'a universe, alive', 4000);
    e.ui.hint('drag to look · scroll to zoom · tap a light to descend');
    e.audio.setScene('cosmic');
    this.ray = new THREE.Raycaster();
    this.ray.params.Points.threshold = 1.0;
    this.ready = true;
  }

  update(dt) {
    const input = this.engine.input;
    this.rig.handleInput(input, dt);
    this.rig.update(dt);
    this.points.rotation.y += dt * 0.004;
    if (input.pointer.clicked && !input.pointer.dragging) {
      this.ray.setFromCamera(new THREE.Vector2(input.pointer.nx, input.pointer.ny), this.camera);
      const hit = this.ray.intersectObject(this.points)[0];
      if (hit) this.engine.director.go('galaxy', { galaxy: hit.index % this.engine.universe.cosmic.galaxyCount });
    }
  }

  exit() { this.points.geometry.dispose(); this.points.material.dispose(); }
  getState() { return { distance: this.rig.distance }; }
}
