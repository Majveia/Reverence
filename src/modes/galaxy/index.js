// GalaxyMode — one galaxy, from the whole disk down to a stellar neighborhood and the event
// horizon of its central black hole. OWNED BY THE GALAXY TRACK.
// Contract: selecting a star calls
//   engine.director.go('system', { galaxy, star: <index> }, { transition: 'white' })
// Units: 1 scene unit = 1 kly. Galaxy at the origin, disk in XZ (+Y galactic north).
import * as THREE from 'three';
import { Mode } from '../../core/Mode.js';
import { clamp, smoothstep } from '../../core/math.js';
import { galaxyStructure, GLOBAL_STARS } from '../../universe/GalaxyModel.js';
import { GalaxyVolume } from './GalaxyVolume.js';
import { StarField } from './StarField.js';
import { GalaxyCamera, rotTheta } from './GalaxyCamera.js';
import { packStar } from './starPack.js';

const DEG = Math.PI / 180;

export default class GalaxyMode extends Mode {
  constructor(engine) {
    super(engine);
    this.inputScheme = 'orbit';
    this.look = {
      exposure: 1.0, tonemap: 'agx',
      bloom: { strength: 0.5, radius: 0.85, threshold: 1.2, knee: 0.8 },
      vignette: 0.3, grain: 0.018, chromatic: 0.0006, saturation: 1.12, contrast: 1.05,
    };
    this.workers = [];
    this.pending = 0;
    this.tau = 0;
    this.pat = 0;
    this._camPat = new THREE.Vector3();
    this.disposed = false;
  }

  async enter(params) {
    const e = this.engine;
    this.params = params;
    this.galaxyIndex = parseInt(params.galaxy ?? 0, 10) || 0;
    const gal = this.galaxy = e.universe.galaxy(this.galaxyIndex);
    const S = this.S = galaxyStructure(gal);
    this.R = S.R / 1000;
    this.camera.fov = 42;
    this.camera.updateProjectionMatrix();

    // --- volume
    this.volume = new GalaxyVolume(e, gal, S);
    this.volume.build(e.renderer);
    this.volume.setSize(e.pipeline.width, e.pipeline.height);
    this.scene.add(this.volume.composite);

    // --- stars
    let maxPt = 64;
    try { const gl = e.renderer.getContext(); maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64; } catch (_) { /* default */ }
    this.stars = new StarField(e, this.volume.uniforms, S, { maxPointSize: Math.min(128, maxPt || 64) });
    this.scene.add(this.stars.group);
    const n = Math.min(GLOBAL_STARS, Math.floor((gal.displayStars || 1.2e6) * e.quality.particleScale));
    this.starCount = n;
    this.stars.initGlobal(n);
    this._startGlobalGeneration(n);

    // --- camera
    const R = this.R;
    const yaw = params.yaw !== undefined ? parseFloat(params.yaw) * DEG : 0.55;
    const pitch = params.pitch !== undefined ? parseFloat(params.pitch) * DEG : 38 * DEG;
    const dist = params.dist !== undefined ? parseFloat(params.dist) : R * 1.9;
    this.rig = new GalaxyCamera(this.camera, { distance: dist, yaw, pitch, minDistance: 1e-10, maxDistance: R * 12, maxTarget: R * 1.6 });

    e.ui.setLocation({ scale: 'Galaxy', title: gal.name, subtitle: gal.type });
    e.ui.showTitle(gal.name.toUpperCase(), `${gal.type} galaxy`, 3000);
    e.ui.hint('drag to orbit · scroll or pinch to zoom · tap to dive in');
    e.audio.setScene('galaxy');
  }

  // ------------------------------------------------------------------ star generation
  _startGlobalGeneration(n) {
    const CH = 65536;
    const chunks = [];
    for (let s = 0; s < n; s += CH) chunks.push([s, Math.min(CH, n - s)]);
    this.pending = chunks.length;
    const galaxyData = this._galaxyData();
    let W = 0;
    try {
      W = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
      for (let k = 0; k < W; k++) {
        const w = new Worker(new URL('./starWorker.js', import.meta.url), { type: 'module' });
        w.onmessage = (ev) => this._onWorker(ev.data);
        w.onerror = (err) => { console.error('[galaxy] worker error', err.message || err); this._fallback(chunks); };
        this.workers.push(w);
      }
    } catch (err) {
      console.warn('[galaxy] workers unavailable, generating on main thread', err);
      this.workers = [];
    }
    if (!this.workers.length) { this._fallback(chunks); return; }
    this._chunkQueue = chunks;
    chunks.forEach((c, i) => this.workers[i % this.workers.length].postMessage({ type: 'global', id: i, galaxy: galaxyData, start: c[0], count: c[1] }));
  }

  _galaxyData() {
    const g = this.galaxy;
    const col = (c) => ({ r: c.r, g: c.g, b: c.b, isColor: true });
    return { ...g, colors: g.colors ? { core: col(g.colors.core), arms: col(g.colors.arms), hii: col(g.colors.hii), dust: col(g.colors.dust) } : null };
  }

  async _fallback(chunks) {
    if (this._fallbackRunning) return;
    this._fallbackRunning = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    const { galaxyStar } = await import('../../universe/GalaxyModel.js');
    const s = {};
    this.stars.filled = 0; this.stars.lumSum = 0;
    this.pending = chunks.length;
    for (const [start, count] of chunks) {
      if (this.disposed) return;
      const pos = new Float32Array(count * 3), col = new Uint8Array(count * 4), lum = new Float32Array(count);
      let sum = 0;
      for (let i = 0; i < count; i++) { galaxyStar(this.galaxy, start + i, s); sum += packStar(s, i, pos, col, lum); }
      this.stars.addGlobalChunk(start, pos, col, lum, sum);
      this.pending--;
      await new Promise((r) => setTimeout(r, 0));
    }
    this._onStarsComplete();
  }

  _onWorker(m) {
    if (this.disposed) return;
    if (m.type === 'global') {
      this.stars.addGlobalChunk(m.start, m.pos, m.col, m.lum, m.sum);
      if (--this.pending === 0) this._onStarsComplete();
    } else if (m.type === 'error') {
      console.error('[galaxy] worker failed', m.error);
    }
  }

  _onStarsComplete() {
    this.starsReady = true;
    this._calibrateStars();
  }

  /** Global tracer gain: stars carry ~30% of the galaxy's diffuse light. */
  _calibrateStars() {
    const u = this.volume.uniforms;
    const R = this.R, rd = this.S.rd / 1000;
    const diskLight = u.uOldL.value * 2 * Math.PI * rd * rd + u.uBulgeL.value * 0.9;
    const frac = this.galaxy.type === 'elliptical' ? 0.18 : 0.3;
    const sum = Math.max(1e-6, this.stars.lumSum);
    this.stars.globalMat.uniforms.uGain.value = frac * diskLight / sum;
    void R;
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    const e = this.engine, input = e.input;
    const R = this.R;
    // galactic time: time-lapse slows as you zoom in
    const dist = this.rig.distance;
    const rate = smoothstep(0.03 * R, 1.2 * R, dist);
    this.tau += dt * rate;
    this.pat = this.S.omegaP * this.tau;

    this.rig.handleInput(input, dt, { cursorPoint: (nx, ny) => this._cursorPoint(nx, ny) });
    this.rig.update(dt, this.pat);

    // uniforms
    this.volume.update(this.camera, this.pat);
    rotTheta(this.camera.position, -this.pat, this._camPat);
    this.stars.update(this.camera, this.pat, this.tau, this._camPat, e.pipeline.height);
  }

  /** Point on the galactic plane (pattern frame) under normalized screen coords, or null. */
  _cursorPoint(nx, ny) {
    const ray = this.rig.ray(nx, ny);
    const o = ray.origin, d = ray.direction;
    if (Math.abs(d.y) < 1e-6) return null;
    const t = -o.y / d.y;
    if (t <= 0) return null;
    const p = new THREE.Vector3().copy(o).addScaledVector(d, t);
    if (Math.hypot(p.x, p.z) > this.R * 1.3) return null;
    return rotTheta(p, -this.pat);
  }

  render(pipeline) {
    this.volume.render(this.engine.renderer);
    pipeline.render(this.scene, this.camera);
  }

  onResize(w, h) {
    super.onResize(w, h);
    const p = this.engine.pipeline;
    this.volume?.setSize(p.width, p.height);
  }

  isReady() { return !!(this.volume?.built && this.starsReady); }

  exit() {
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.volume?.dispose();
    this.stars?.dispose();
  }

  getState() {
    return {
      galaxy: this.galaxyIndex, type: this.galaxy?.type, distance: +this.rig?.distance.toPrecision(4),
      target: this.rig ? this.rig.target.toArray().map((v) => +v.toFixed(3)) : null,
      stars: this.stars?.filled, tau: +this.tau.toFixed(3),
    };
  }
}
