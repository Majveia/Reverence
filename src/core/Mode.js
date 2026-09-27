// Base class for a scale "mode" (cosmic → galaxy → system). A mode owns a scene + camera
// and is rendered by the engine through the shared HDR Pipeline.
import * as THREE from 'three';

export class Mode {
  /** @param {import('./Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, engine.aspect, 0.1, 1e9);
    this.ready = false;           // set true when the first view is fully built (shot mode waits for this)
    this.look = {};               // post-processing look (merged into pipeline.settings on enter)
    this.inputScheme = 'orbit';   // 'orbit' | 'character' | 'vehicle' | 'flight'
  }
  /** Build everything. params = URL params / director params. */
  async enter(params) { this.ready = true; }
  /** Tear down; dispose GPU resources. */
  exit() {}
  /** Simulation step. */
  update(dt, t) {}
  /** Default render: scene through pipeline. Override for custom multi-pass rendering. */
  render(pipeline) { pipeline.render(this.scene, this.camera); }
  onResize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  /** Readiness for deterministic capture (e.g. terrain chunks streamed in). */
  isReady() { return this.ready; }
  /** Compact JSON state for tests (positions, speeds, flags). */
  getState() { return {}; }
  /** Called when user presses back/escape at this mode's top level. Return true if handled. */
  onBack() { return false; }
}
