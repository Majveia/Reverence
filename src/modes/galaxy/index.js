// GalaxyMode — one galaxy, from the whole disk down to a stellar neighborhood and the event
// horizon of its central black hole. OWNED BY THE GALAXY TRACK.
// Contract: selecting a star calls
//   engine.director.go('system', { galaxy, star: <index> }, { transition: 'white' })
// Units: 1 scene unit = 1 kly. Galaxy at the origin, disk in XZ (+Y galactic north).
// URL: &galaxy=<i> &yaw/&pitch (deg) &dist (kly) &focus=core|local|star:<i>|neb:<k> &gx=<tuning>
import * as THREE from 'three';
import { Mode } from '../../core/Mode.js';
import { clamp, smoothstep } from '../../core/math.js';
import { galaxyStructure, galaxyNebulae, GLOBAL_STARS, CLASS_INDEX } from '../../universe/GalaxyModel.js';
import { GalaxyVolume } from './GalaxyVolume.js';
import { StarField } from './StarField.js';
import { GalaxyCamera, rotTheta } from './GalaxyCamera.js';
import { packStar } from './starPack.js';
import { BlackHole } from './BlackHole.js';
import { Nebulae } from './Nebulae.js';
import { Backdrop } from './Backdrop.js';
import { Reticle } from './Reticle.js';

const DEG = Math.PI / 180;
const CLASS_NAMES = ['O', 'B', 'A', 'F', 'G', 'K', 'M'];
const CLASS_DESC = { O: 'blue supergiant', B: 'blue-white giant', A: 'white star', F: 'yellow-white star', G: 'yellow dwarf', K: 'orange dwarf', M: 'red dwarf' };

function fmtDist(kly) {
  const ly = kly * 1000;
  if (ly >= 1000) return `${kly.toFixed(kly < 10 ? 1 : 0)} kly`;
  if (ly >= 1) return `${ly.toFixed(ly < 10 ? 1 : 0)} ly`;
  const au = ly * 63241;
  if (au >= 1) return `${au.toFixed(au < 10 ? 1 : 0)} AU`;
  return `${(au * 1.496e8).toExponential(1)} km`;
}

export default class GalaxyMode extends Mode {
  constructor(engine) {
    super(engine);
    this.inputScheme = 'orbit';
    this.look = {
      exposure: 0.8, tonemap: 'agx', filmLook: { power: 1.06, saturation: 1.3 },
      bloom: { strength: 0.26, radius: 0.8, threshold: 1.6, knee: 0.8 },
      vignette: 0.3, grain: 0.018, chromatic: 0.0006, saturation: 1.18, vibrance: 0.15, contrast: 1.06,
    };
    this.workers = [];
    this.pending = 0;
    this.tau = 0;
    this.pat = 0;
    this._camPat = new THREE.Vector3();
    this.disposed = false;
    this.edgeMeter = 0.55;
    this.exposureMul = 1;
    this.selected = null;
    this.lod = { center: new THREE.Vector3(1e9, 0, 0), radius: 0, pending: false, id: 0, on: false };
    this._pm = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._effects = [];
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

    // --- background universe, volume, stars
    this.backdrop = safe(() => new Backdrop(e, gal));
    if (this.backdrop) this.scene.add(this.backdrop.object);
    this.volume = new GalaxyVolume(e, gal, S);
    this.volume.build(e.renderer);
    this.volume.setSize(e.pipeline.width, e.pipeline.height);
    this.scene.add(this.volume.composite);

    let maxPt = 64;
    try { const gl = e.renderer.getContext(); maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64; } catch (_) { /* default */ }
    this.stars = new StarField(e, this.volume.uniforms, S, { maxPointSize: Math.min(128, maxPt || 64) });
    this.scene.add(this.stars.group);
    const n = Math.min(GLOBAL_STARS, Math.floor((gal.displayStars || 1.2e6) * e.quality.particleScale));
    this.starCount = n;
    this.stars.initGlobal(n);
    // art-direction overrides: &gx=OldL:0.5,DustL:6,exp:0.7,stars:1.2 (uniform names without 'u')
    if (params.gx) {
      for (const kv of String(params.gx).split(',')) {
        const [k, v] = kv.split(':');
        const un = this.volume.uniforms['u' + k] ?? this.stars.common['u' + k] ?? this.stars.globalMat.uniforms['u' + k];
        if (un && typeof un.value === 'number' && Number.isFinite(+v)) un.value = +v;
        else if (k === 'exp') { this.look.exposure = +v; this._expSet = true; }
        else if (k === 'stars') this.starGainMul = +v;
        else if (k === 'HaloL') this.volume.uniforms.uHalo.value.y = +v;
        else if (k === 'BarL') this.volume.uniforms.uBar.value.w = +v;
        else if (k === 'EnvL') this.volume.uniforms.uBulgeH.value.y = +v;
        else if (k === 'EnvA') this.volume.uniforms.uBulgeH.value.x = +v;
        else if (k === 'meter') { this.edgeMeter = +v; this._meterSet = true; }
        else if (k === 'tm') this.look.tonemap = v;
        else if (k === 'sat') this.look.saturation = +v;
        else if (k === 'fsat') this.look.filmLook = { ...this.look.filmLook, saturation: +v };
        else if (k === 'fpow') this.look.filmLook = { ...this.look.filmLook, power: +v };
        else if (k === 'bloom') this.look.bloom = { ...this.look.bloom, strength: +v };
      }
    }
    this._startGlobalGeneration(n);

    this.blackHole = safe(() => new BlackHole(e, S));
    this.nebulae = safe(() => new Nebulae(e, gal, S, this.volume.uniforms));
    if (this.nebulae) this.scene.add(this.nebulae.group);
    this.reticle = new Reticle();
    this.scene.add(this.reticle.object);

    // --- camera
    const R = this.R;
    const yaw = params.yaw !== undefined ? parseFloat(params.yaw) * DEG : 0.55;
    const pitch = params.pitch !== undefined ? parseFloat(params.pitch) * DEG : 44 * DEG;
    const dist = params.dist !== undefined ? parseFloat(params.dist) : R * (gal.type === 'elliptical' ? 1.5 : gal.type === 'lenticular' ? 2.3 : 1.95);
    const minD = this.blackHole ? this.blackHole.rs * 2.2 : 1e-10;
    this.rig = new GalaxyCamera(this.camera, { distance: dist, yaw, pitch, minDistance: minD, maxDistance: R * 12, maxTarget: R * 1.6 });
    this._applyFocus(params);

    // per-type look: early types are metered for their huge bulges and kept creamy (not orange)
    if (gal.type === 'lenticular' || gal.type === 'elliptical') {
      if (!this._meterSet) this.edgeMeter = 0.12;
      this.look.filmLook = { power: 1.04, saturation: 1.12 };
      if (!this._expSet) this.look.exposure = gal.type === 'lenticular' ? 1.0 : 0.85;
    }
    e.ui.setLocation({ scale: 'Galaxy', title: gal.name, subtitle: `${gal.type} galaxy` });
    e.ui.showTitle(gal.name.toUpperCase(), `${gal.type} galaxy · ${(gal.starCount / 1e9).toFixed(0)} billion stars`, 3000);
    e.ui.hint('drag to orbit · scroll or pinch to zoom · tap a star to select · double-tap to travel');
    e.audio.setScene('galaxy');
  }

  _applyFocus(params) {
    const f = String(params.focus ?? '');
    const S = this.S;
    const setD = (d, pitchDeg) => {
      if (params.dist === undefined) this.rig.setView({ distance: d });
      if (params.pitch === undefined && pitchDeg !== undefined) this.rig.setView({ pitch: pitchDeg * DEG });
    };
    if (f === 'core' && this.blackHole) {
      this.rig.setView({ target: new THREE.Vector3(0, 0, 0) });
      setD(this.blackHole.rs * 26, 7);
      if (params.dist !== undefined) this.rig.setView({ distance: parseFloat(params.dist) * this.blackHole.rs });
    } else if (f.startsWith('neb') && this.nebulae) {
      const k = parseInt(f.split(':')[1] ?? '0', 10) || 0;
      const nb = this.nebulae.list[k % this.nebulae.list.length];
      if (nb) {
        this.rig.setView({ target: new THREE.Vector3(nb.x, nb.y + (nb.kind === 'pillars' ? nb.radius * 0.1 : 0), nb.z).multiplyScalar(1 / 1000) });
        if (nb.kind === 'pillars' && params.yaw === undefined) this.rig.setView({ yaw: nb.tilt[0] });
        setD(nb.radius / 1000 * (nb.kind === 'pillars' ? 2.1 : nb.kind === 'emission' ? 2.7 : 3.0), nb.kind === 'pillars' ? 4 : 18);
        if (params.dist !== undefined) this.rig.setView({ distance: parseFloat(params.dist) * nb.radius / 1000 });
      }
    } else if (f.startsWith('star') || f === 'local' || params.star !== undefined) {
      const idx = f.startsWith('star') ? parseInt(f.split(':')[1] ?? '0', 10) : params.star !== undefined ? parseInt(params.star, 10) : 6;
      const st = this.engine.universe.star(this.galaxyIndex, idx || 0);
      this.rig.setView({ target: st.position.clone().multiplyScalar(1 / 1000) });
      setD(f === 'local' ? 0.25 : 0.04, 14);
      if (f !== 'local') this._select({ index: idx || 0, pos: st.position.clone().multiplyScalar(1 / 1000), follow: 1 });
    }
    void S;
  }

  // ------------------------------------------------------------------ star generation
  _startGlobalGeneration(n) {
    const CH = 65536;
    const chunks = [];
    for (let s = 0; s < n; s += CH) chunks.push([s, Math.min(CH, n - s)]);
    this.pending = chunks.length;
    const galaxyData = this._galaxyData();
    this._gd = galaxyData;
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
    } else if (m.type === 'local') {
      this.lod.pending = false;
      if (m.id !== this.lod.id) return;
      this.stars.setLocal(m.count, m.pos, m.col, m.lum, m.index);
      this.lod.center.set(m.center[0] / 1000, m.center[1] / 1000, m.center[2] / 1000);
      this.lod.radius = m.radius / 1000;
      this.lod.ready = true;
    } else if (m.type === 'error') {
      this.lod.pending = false;
      console.error('[galaxy] worker failed', m.error);
    }
  }

  _onStarsComplete() {
    this.starsReady = true;
    this._calibrateStars();
  }

  /** Global tracer gain: stars carry a fraction of the galaxy's diffuse light. */
  _calibrateStars() {
    const u = this.volume.uniforms;
    const rd = this.S.rd / 1000;
    const diskLight = u.uOldL.value * 2 * Math.PI * rd * rd + u.uBulgeL.value * 0.9;
    // (lumSum is Σ L^0.35; with uLumExp 0.6 the brightest young supergiants carry most of the tracer
    // light → Hubble-like resolved sparkle along the arms over a smooth unresolved disk)
    const frac = this.galaxy.type === 'elliptical' ? 0.1 : 0.4;
    const sum = Math.max(1e-6, this.stars.lumSum);
    this.stars.globalMat.uniforms.uGain.value = frac * diskLight / sum * (this.starGainMul ?? 1);
  }

  // ------------------------------------------------------------------ LOD: local neighborhood stars
  _updateLod() {
    const lod = this.lod;
    const dist = this.rig.distance;
    const want = dist < 2.2 && this.starsReady && this.workers.length > 0;
    const lm = this.stars.localMat.uniforms;
    if (!want) {
      lod.on = false;
      lm.uWeight.value = 0;
      this.stars.globalMat.uniforms.uLodRadius.value = 0;
      return;
    }
    lod.on = true;
    const tgt = this.rig.target;                     // pattern frame, kly
    const radius = clamp(dist * 1.6, 0.12, 1.1);
    const moved = tgt.distanceTo(lod.center);
    if (!lod.pending && (moved > lod.radius * 0.28 || radius > lod.radius * 1.5 || radius < lod.radius * 0.45)) {
      lod.pending = true;
      lod.id++;
      const cap = Math.floor(clamp(240000 * this.engine.quality.particleScale, 40000, 480000));
      const w = this.workers[lod.id % this.workers.length];
      w.postMessage({ type: 'local', id: lod.id, galaxy: this._gd, center: [tgt.x * 1000, tgt.y * 1000, tgt.z * 1000], radius: radius * 1000, capacity: cap });
    }
    if (lod.ready) {
      // fade the local population in as the camera approaches; global tracers fade out inside it
      const k = 1 - smoothstep(0.9, 2.2, dist);
      lm.uWeight.value = k;
      lm.uLodCenter.value.copy(lod.center);
      lm.uLodRadius.value = lod.radius;
      let nf = 0;
      for (const it of this.nebulae?.active ?? []) nf = Math.max(nf, it.fade);
      lm.uGain.value = this.stars.singleGain * (1 - 0.7 * nf);
      const gm = this.stars.globalMat.uniforms;
      gm.uLodCenter.value.copy(lod.center);
      gm.uLodRadius.value = lod.radius * k;
    }
  }

  // ------------------------------------------------------------------ picking
  _starWorld(px, py, pz, follow, out) {
    let ang;
    if (follow === 1) ang = this.pat;
    else if (follow === 0) {
      const r = Math.max(Math.hypot(px, pz), 1e-4);
      const v0 = this.S.v0 / 1000, rt = this.S.rt / 1000;
      ang = -v0 * (1 - Math.exp(-r / rt)) / r * this.tau;
    } else ang = this.pat * 0.08;
    const c = Math.cos(ang), s = Math.sin(ang);
    return out.set(px * c - pz * s, py, px * s + pz * c);
  }

  _pick(nx, ny) {
    const e = this.engine;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const m = this._pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const W = e.width * 0.5, H = e.height * 0.5;
    const rad = e.input.lastDevice === 'touch' ? 26 : 16;
    const rad2 = rad * rad;
    let best = null, bestScore = -Infinity;
    const gm = this.stars.globalMat.uniforms;
    const gNear = gm.uGainNear.value, nd0 = gm.uNearD.value.x, nd1 = gm.uNearD.value.y;
    const test = (x, y, z, logL, lumExp, gain, cand, near = false) => {
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 1e-12) return;
      if (near && gNear > 0 && cw < nd1) gain = Math.exp(Math.log(gNear) + (Math.log(gain) - Math.log(gNear)) * smoothstep(nd0, nd1, cw));
      const sx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
      const sy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
      const dx = (sx - nx) * W, dy = (sy - ny) * H;
      const d2 = dx * dx + dy * dy;
      if (d2 > rad2) return;
      const bright = logL * lumExp * 2.302585 + Math.log(gain / (cw * cw));
      const score = bright - 2.2 * d2 / rad2;
      if (score > bestScore) { bestScore = score; best = cand(); }
    };
    // global tracers
    const g = this.stars.global?.geometry;
    if (g) {
      const P = g.attributes.position.array, C = g.attributes.aCol.array, Lm = g.attributes.aLogL.array;
      const n = this.stars.filled;
      const gain = this.stars.globalMat.uniforms.uGain.value, le = this.stars.globalMat.uniforms.uLumExp.value;
      const v = this._v;
      for (let i = 0; i < n; i++) {
        const f = C[i * 4 + 3];
        const follow = (f >> 4) & 3;
        this._starWorld(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], follow, v);
        const idx = i;
        test(v.x, v.y, v.z, Lm[i], le, gain, () => ({ index: idx, pos: new THREE.Vector3(P[idx * 3], P[idx * 3 + 1], P[idx * 3 + 2]), follow: (C[idx * 4 + 3] >> 4) & 3 }), true);
      }
    }
    // local stars (pattern frame, follow the pattern)
    if (this.lod.on && this.lod.ready && this.stars.localCount) {
      const P = this.stars.localPos, Lm = this.stars.localLum, I = this.stars.localIndex;
      const gain = this.stars.localMat.uniforms.uGain.value * 50, le = this.stars.localMat.uniforms.uLumExp.value;
      const c = Math.cos(this.pat), s = Math.sin(this.pat);
      for (let i = 0; i < this.stars.localCount; i++) {
        const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
        const k = i;
        test(px * c - pz * s, py, px * s + pz * c, Lm[i], le, gain, () => ({ index: I[k], pos: new THREE.Vector3(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]), follow: 1 }));
      }
    }
    return best;
  }

  _select(sel) {
    if (!sel) {
      this.selected = null;
      this.engine.ui.clearPrompt('galaxy');
      this.reticle.hide();
      return;
    }
    let st = null;
    try { st = this.engine.universe.star(this.galaxyIndex, sel.index); } catch (err) { console.warn('[galaxy] star lookup failed', err); }
    if (!st) return;
    this.selected = { ...sel, star: st };
    this.engine.ui.prompt('galaxy', `Travel to ${st.name}`, 'interact');
    this.engine.audio?.play?.('select');
  }

  _travel() {
    const sel = this.selected;
    if (!sel || this._traveling) return;
    this._traveling = true;
    const e = this.engine;
    const pos = this._selPattern(this._v2);
    const d = Math.max(0.0035, (this.blackHole?.rs ?? 0) * 50);
    const dur = e.shot ? 0.01 : clamp(1.4 + 0.35 * Math.log10(this.rig.distance / d + 1), 1.6, 3.4);
    this.rig.flyTo(pos, d, dur, { arc: 0.15 });
    e.audio?.play?.('whoosh');
    this._travelT = dur;
  }

  /** Current pattern-frame position of the selection. */
  _selPattern(out) {
    const s = this.selected;
    if (s.follow === 1) return out.copy(s.pos);
    this._starWorld(s.pos.x, s.pos.y, s.pos.z, s.follow, out);
    return rotTheta(out, -this.pat);
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    const e = this.engine, input = e.input;
    const R = this.R;
    try {
      // galactic time: time-lapse slows as you zoom in
      const dist = this.rig.distance;
      const rate = smoothstep(0.03 * R, 1.2 * R, dist);
      this.tau += dt * rate;
      this.pat = this.S.omegaP * this.tau;

      if (!this._traveling) {
        const p = input.pointer;
        if (p.clicked && !p.dragging) {
          const hit = this.starsReady ? this._pick(p.nx, p.ny) : null;
          if (hit && p.doubleClicked && this.selected && this.selected.index === hit.index) this._travel();
          else if (hit) {
            if (this.selected && this.selected.index === hit.index) this._travel();
            else this._select(hit);
          } else if (!p.doubleClicked) this._select(null);
        }
        if (this.selected && input.down('interact')) this._travel();
        if (input.down('back') && this.selected) this._select(null);
      } else {
        this._travelT -= dt;
        if (!this.rig.flying || this._travelT < -0.5) {
          this._traveling = false;
          const sel = this.selected;
          if (sel) e.director.go('system', { galaxy: this.galaxyIndex, star: sel.index }, { transition: 'white' });
        }
      }

      this.rig.handleInput(input, dt, { cursorPoint: (nx, ny) => this._cursorPoint(nx, ny), lockTarget: this._traveling });
      this.rig.update(dt, this.pat);

      // exposure: edge-on disks are path-integrated (much brighter) → meter them down like a camera
      {
        const p = this.camera.position, len = p.length() || 1;
        const outside = smoothstep(0.35 * R, 0.9 * R, len);
        const face = smoothstep(0.03, 0.6, Math.abs(p.y) / len);
        const k = 1 - outside * (1 - face) * this.edgeMeter;
        e.pipeline.settings.exposure = this.look.exposure * k * this.exposureMul;
      }

      // eye adaptation: close to the disk the individual stars set the exposure, the diffuse glow recedes
      {
        const l = (Math.log10(Math.max(this.rig.distance, 1e-12)) - Math.log10(0.3)) / (Math.log10(12) - Math.log10(0.3));
        const k = clamp(l, 0, 1);
        // floor: from inside the disk the galaxy's own band / nebular glow stays visible behind the stars
        // a nearby nebula dominates the frame's exposure → the galaxy's diffuse glow recedes further
        let nf = 0;
        for (const it of this.nebulae?.active ?? []) nf = Math.max(nf, it.fade);
        this.volume.compositeMat.uniforms.uGain.value = (0.07 + 0.93 * k * k * (3 - 2 * k)) * (1 - 0.85 * nf);
      }
      this.volume.update(this.camera, this.pat);
      rotTheta(this.camera.position, -this.pat, this._camPat);
      this._updateLod();
      this.stars.update(this.camera, this.pat, this.tau, this._camPat, e.pipeline.height);
      this.backdrop?.update(this.camera);
      this.nebulae?.update(this.camera, this.pat, this._camPat, dt, e.time.t);
      this._updateSelectionUi();
      this._updateTelemetry(dt);
    } catch (err) {
      if (!this._warned) { console.error('[galaxy] update failed', err); this._warned = true; }
    }
  }

  _updateSelectionUi() {
    const e = this.engine;
    const list = this._markers || (this._markers = []);
    list.length = 0;
    try { this.nebulae?.markers(this.camera, e, list); } catch (_) { /* optional */ }
    if (this.selected) {
      const pw = this._selPattern(this._v2);
      rotTheta(pw, this.pat);
      this.reticle.show(pw);
      const v = this._v.copy(pw).project(this.camera);
      const vis = v.z < 1 && v.z > -1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      const st = this.selected.star;
      const sub = `${st.cls}-class ${CLASS_DESC[st.cls] ?? 'star'} · ${Math.round(st.temperature).toLocaleString('en-US')} K`;
      list.push({ id: 'gx-sel', x: (v.x * 0.5 + 0.5) * e.width, y: (0.5 - v.y * 0.5) * e.height - 22, visible: vis, label: st.name, sub });
    } else this.reticle.hide();
    const key = list.map((m) => m.id).join('|');
    if (list.length || this._markerKey) e.ui.setMarkers(list);
    this._markerKey = key;
  }

  _updateTelemetry(dt) {
    this._teleT = (this._teleT ?? 0) - dt;
    if (this._teleT > 0) return;
    this._teleT = 0.25;
    const bh = this.blackHole;
    const d = this.rig.distance;
    const t = { Scale: fmtDist(d) };
    if (bh && bh.active(this.camera)) t.Horizon = `${bh.distanceRs(this.camera).toFixed(bh.distanceRs(this.camera) < 100 ? 1 : 0)} rₛ`;
    this.engine.ui.setTelemetry(t);
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
    const r = this.engine.renderer;
    this.volume.render(r);
    this.nebulae?.render(r, this.camera);
    this._effects.length = 0;
    if (this.blackHole && this.blackHole.active(this.camera)) this._effects.push(this.blackHole.effect);
    pipeline.render(this.scene, this.camera, this._effects.length ? { effects: this._effects } : {});
  }

  onResize(w, h) {
    super.onResize(w, h);
    const p = this.engine.pipeline;
    this.volume?.setSize(p.width, p.height);
  }

  isReady() {
    const lodOk = !this.lod.on || this.lod.ready || !this.workers.length;
    return !!(this.volume?.built && this.starsReady && lodOk && (this.nebulae?.isReady?.() ?? true));
  }

  onBack() {
    if (this.selected) { this._select(null); return true; }
    return false;
  }

  exit() {
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    try { this.engine.ui.clearPrompt('galaxy'); this.engine.ui.setMarkers([]); this.engine.ui.setTelemetry(null); } catch (_) { /* ui optional */ }
    this.volume?.dispose();
    this.stars?.dispose();
    this.blackHole?.dispose();
    this.nebulae?.dispose();
    this.backdrop?.dispose();
    this.reticle?.dispose();
  }

  getState() {
    return {
      galaxy: this.galaxyIndex, type: this.galaxy?.type, distance: +this.rig?.distance.toPrecision(4),
      target: this.rig ? this.rig.target.toArray().map((v) => +v.toFixed(4)) : null,
      stars: this.stars?.filled, local: this.lod.on ? this.stars?.localCount ?? 0 : 0, tau: +this.tau.toFixed(3),
      selected: this.selected ? { index: this.selected.index, name: this.selected.star.name, cls: this.selected.star.cls } : null,
      blackHoleRs: this.blackHole ? +this.blackHole.distanceRs(this.camera).toPrecision(4) : null,
    };
  }
}

function safe(fn) {
  try { return fn(); } catch (err) { console.error('[galaxy] optional component failed', err); return null; }
}

export { CLASS_NAMES, CLASS_INDEX, galaxyNebulae };
