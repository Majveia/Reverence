// SystemMode — a star system with a fully explorable current body (planet/moon).
// Hosts the World (src/world/World.js) which auto-loads every planet-scale subsystem.
// The mode itself stays thin: tracks extend the game through src/world/<track>/.
import { Mode } from '../../core/Mode.js';
import { World } from '../../world/World.js';
import { precompileAll } from '../../core/precompile.js';

/** director.preload('system'): fetch every world subsystem's code before the first planet visit. */
export function preload() { return World.preload(); }

export default class SystemMode extends Mode {
  constructor(engine) {
    super(engine);
    this.inputScheme = 'character';
  }

  async enter(params) {
    const e = this.engine;
    this.world = new World(e, this, params);
    this.scene = this.world.scene;
    const b = this.world.body;
    // Art-directed grade for this world (post track may refine per time of day / weather)
    this.look = { exposure: 1.0, ...(b.art?.grade || {}), bloom: { strength: 0.35, radius: 0.8, threshold: 1.2 } };
    await this.world.init();
    e.ui.setLocation({ scale: this.world.star.name, title: b.name, subtitle: `${b.type}${b.isMoon ? ' moon' : ''}` });
    if (!params.returning) e.ui.showTitle(b.name.toUpperCase(), `${b.art?.name ?? b.type} · ${this.world.star.name}`, 4200);
    e.audio.setScene('surface', { body: b });
  }

  /**
   * Behind the transition veil (Director.settle): link the world's programs — scene materials and the
   * full-screen passes of the pipeline, atmosphere, clouds … — all at once in the driver's background threads
   * (KHR_parallel_shader_compile; see core/precompile.js), instead of one blocking link per pass on the first
   * frames. Without the extension the first frames behind the veil compile them (`?precompile=sync` forces
   * the synchronous path, for tests).
   */
  async warmup() {
    const e = this.engine, r = e.renderer;
    if (!this.world || !r?.compileAsync) return;
    const sync = new URLSearchParams(location.search).get('precompile') === 'sync';
    if (!sync && !r.extensions?.has('KHR_parallel_shader_compile')) return;
    this.warmStats = await precompileAll(r, { scene: this.scene, camera: this.camera, owners: [e.pipeline, ...this.world.order], sync });
  }

  update(dt) { this.world.update(dt); }
  render(pipeline) { this.world.render(pipeline); }
  isReady() { return !!this.world && this.world.isReady(); }
  getState() { return this.world ? this.world.getState() : {}; }
  exit() { this.world?.dispose(); }
}
