// SystemMode — a star system with a fully explorable current body (planet/moon).
// Hosts the World (src/world/World.js) which auto-loads every planet-scale subsystem.
// The mode itself stays thin: tracks extend the game through src/world/<track>/.
import * as THREE from 'three';
import { Mode } from '../../core/Mode.js';
import { World } from '../../world/World.js';
import { precompileAll } from '../../core/precompile.js';

const DEG = 180 / Math.PI;

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
    // the first update patches the scene's materials (cloud shadows), places lights, and the scene's
    // onBeforeRender builds the environment map: do both now, so the warmed programs are the variants the
    // first frame draws with (the scene renders into the pipeline's HDR target)
    try { this.world.update(0); } catch (err) { console.warn('[system] warm-up update', err); }
    try { this.scene.onBeforeRender?.(r, this.scene, this.camera, e.pipeline.sceneRT); } catch (err) { console.warn('[system] warm-up pre-render', err); }
    this.warmStats = await precompileAll(r, { scene: this.scene, camera: this.camera, target: e.pipeline.sceneRT, owners: [e.pipeline, ...this.world.order], sync });
  }

  /**
   * Where a rebuild picks up (director.recover after a GPU reset): the same body (params), the player's (or
   * vehicle's) position, the camera heading, the view and the local time of day — the menu's share state.
   */
  resumeState() {
    const w = this.world;
    if (!w?.player) return {};
    const pl = w.player, c = w.controller;
    const pos = (c && c.pos) || pl.pos || w.camera.position;
    const r = pos.length() || 1;
    const up = pos.clone().multiplyScalar(1 / r);
    const out = { lat: Math.asin(Math.max(-1, Math.min(1, up.y))) * DEG, lon: Math.atan2(up.x, up.z) * DEG };
    // heading: camera direction against local north / east (as the compass reads it)
    const n = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y);
    if (n.lengthSq() < 1e-8) n.set(0, 0, 1).addScaledVector(up, -up.z);
    n.normalize();
    const east = new THREE.Vector3().crossVectors(n, up), f = new THREE.Vector3();
    w.camera.getWorldDirection(f);
    const fx = f.dot(east), fy = f.dot(n);
    if (fx * fx + fy * fy > 1e-6) out.yaw = ((Math.atan2(fx, fy) * DEG) + 360) % 360;
    const vt = c && c !== pl ? String(c.type || '') : '';
    out.view = /ship/.test(vt) ? 'ship' : /rover/.test(vt) ? 'rover' : /bike/.test(vt) ? 'bike' : (pl.view || 'surface');
    try { const tod = w.celestial?.localTime?.(up); if (Number.isFinite(tod)) out.tod = tod; } catch (_) { /* optional */ }
    return out;
  }

  update(dt) { this.world.update(dt); }
  render(pipeline) { this.world.render(pipeline); }
  isReady() { return !!this.world && this.world.isReady(); }
  getState() { return this.world ? this.world.getState() : {}; }
  exit() { this.world?.dispose(); }
}
