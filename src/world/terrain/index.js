// Terrain subsystem (order 10). OWNED BY THE TERRAIN TRACK.
//
// Quadtree cube-sphere CDLOD renderer:
//  • 6 cube faces (tangent-warped) → quadtree down to ~0.35 m vertex spacing (65x65 vertex chunks)
//  • selection by distance to each node's bounding sphere (CDLOD ranges: D = K · chunk side),
//    horizon culling (+ mountain margin), three's per-mesh frustum culling for drawing
//  • chunks generated in a pool of Web Workers (they import the same SurfaceGen as physics),
//    uploads time-sliced on the main thread, coarse levels first so there is never a hole
//  • per-vertex geomorphing toward the parent level (position + normal) → no popping;
//    closed skirts as a crack safety net
//  • one shared index buffer, one shared material (see material.js), near chunks cast shadows
import * as THREE from 'three';
import { surfaceConfig } from '../planet/SurfaceGen.js';
import { buildChunk, buildIndices, cubeDir, FACES } from './chunkBuild.js';
import { bakeDetail, DETAIL_SIZE, DETAIL_LAYERS } from './detailTex.js';
import { createTerrainMaterial, createTerrainDepthMaterial, updateOriginMod } from './material.js';

const RES_DEFAULT = 64;
const _dir = new Float64Array(3), _dir2 = new Float64Array(3);
const _v = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();

class Node {
  constructor(t, face, level, u0, v0, size, parent) {
    this.face = face; this.level = level; this.u0 = u0; this.v0 = v0; this.size = size; this.parent = parent;
    this.children = null; this.mesh = null; this.state = 0; this.dead = false;
    this.used = 0; this.drawn = 0; this.prio = 0; this.closest = 0; this.inView = true;
    cubeDir(face, u0 + size / 2, v0 + size / 2, _dir);
    this.dx = _dir[0]; this.dy = _dir[1]; this.dz = _dir[2];
    cubeDir(face, u0, v0, _dir2);
    const c1 = Math.min(1, this.dx * _dir2[0] + this.dy * _dir2[1] + this.dz * _dir2[2]);
    this.ang = Math.acos(c1);                    // centre → corner angle
    cubeDir(face, u0, v0 + size / 2, _dir); cubeDir(face, u0 + size, v0 + size / 2, _dir2);
    this.side = t.R * Math.acos(Math.min(1, _dir[0] * _dir2[0] + _dir[1] * _dir2[1] + _dir[2] * _dir2[2]));
    this.rf = parent ? parent.rf : 1;       // relief factor (steep chunks refine earlier), see _makeMesh
    this.D = t.K * this.side * this.rf;
    this.hMin = parent ? parent.hMin : t.hMin0;
    this.hMax = parent ? parent.hMax : t.hMax0;
  }
}

class Terrain {
  constructor(world) {
    this.world = world;
    this.engine = world.engine;
    this.surface = world.surface;
    this.body = world.body;
    this.R = world.body.radius;
    const q = world.quality || {};
    this.q = q;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    world.root.add(this.group);
    this.material = createTerrainMaterial(world.body, q, { lite: this._liteLighting(q) });
    this.depthMaterial = createTerrainDepthMaterial();
    // quads per chunk side
    this.RES = RES_DEFAULT;
    const RES = this.RES;
    this.index = new THREE.BufferAttribute(buildIndices(RES), 1);
    // CDLOD range factor from a screen-space error target: a chunk quad should cover ~ppq pixels
    // at the closest distance it is drawn (D = K · side). Fixed per world (baked into morph data).
    const eng = world.engine || {};
    const hPx = Math.max(360, (eng.height || 720) * (q.pixelRatio || 1));
    const fov = ((world.camera?.fov) || 60) * Math.PI / 180;
    // (triangle budget, lead PERF request: ≈1.1–1.3 M terrain triangles at 1080p high)
    const ppq = { low: 15, med: 11, high: 8.5, ultra: 6 }[q.tier] ?? 8.5;
    // (deterministic captures run on software GL: coarser target so frames stay renderable. At
    //  K ≈ 1 a quad spans ~10 px at 720p and far mesas/ridges read as low-poly facets, so aerial
    //  hero captures add `tk=1.7` (≈ +50 % chunks — fine from the air, ~3.8 M triangles on foot))
    const shotMode = !!world.engine?.shot;
    this.K = Math.max(shotMode ? 1.05 : 1.3, Math.min(2.2, hPx / (fov * RES * ppq * (shotMode ? 1.3 : 1)) * Math.sqrt(q.terrainDetail ?? 1)));
    try { const tk = parseFloat(new URLSearchParams(globalThis.location?.search || '').get('tk')); if (tk > 0.9 && tk < 4) this.K = tk; } catch (_) { /* no url */ }
    // relief-aware split boost (0 = off): up to +60 % range on chunks spanning tall walls
    this.reliefK = q.tier === 'low' ? 0 : q.tier === 'med' ? 0.35 : 0.6;
    try { const tr = new URLSearchParams(globalThis.location?.search || '').get('trelief'); if (tr !== null && tr !== '') this.reliefK = Math.max(0, Math.min(1.5, +tr || 0)); } catch (_) { /* no url */ }
    const leaf = q.tier === 'low' ? 0.8 : q.tier === 'med' ? 0.5 : 0.35;   // metres between vertices at max depth
    this.maxLevel = Math.max(4, Math.ceil(Math.log2((this.R * Math.PI / 2) / (RES * leaf))));
    this.hMin0 = this.surface.minHeight ?? -this.surface.amp;
    this.hMax0 = this.surface.maxHeight ?? this.surface.amp;
    this.shadowDist = q.tier === 'ultra' ? 2800 : q.tier === 'med' ? 300 : 900;
    // software rasterizers (headless captures) are fill-rate bound in the shadow cascades: terrain
    // only casts into the near cascades there (GPU tiers keep the full range)
    this.receiveDist = this.shadowDist * 1.15;
    if (this._softGL()) { this.shadowDist = Math.min(this.shadowDist, 110); this.receiveDist = Math.min(this.receiveDist, 420); }
    this.shot = !!world.engine?.shot;
    this.uploadBudgetMs = this.shot ? 1e9 : 3;
    this.frame = 0;
    this.roots = [];
    for (let f = 0; f < 6; f++) this.roots.push(new Node(this, f, 0, -1, -1, 2, null));
    this.desired = [];
    this.pending = [];        // nodes needing a build (rebuilt every frame)
    this.uploads = [];        // finished builds waiting for GPU upload
    this.inflight = 0;
    this.jobs = new Map();    // id → node
    this.jobId = 1;
    this.meshCount = 0; this.triCount = 0;
    this.texReady = false;
    this._cam = new THREE.Vector3();
    this._initWorkers();
    this._first = true;
    // flatten stamps (civ plazas / pads): resync workers and rebuild the chunks they touch
    this._offFlat = this.surface.onFlattenChange?.((f, all) => this._onFlatten(f, all));
    this.ms = 0; this.msMax = 0;
    this._t0 = performance.now(); this.readyMs = 0; this.builds = 0; this.buildMs = 0;
  }

  // ------------------------------------------------------------------ workers
  _initWorkers() {
    this.workers = [];
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const n = Math.max(1, Math.min(this.q.mobile ? 2 : 4, hc - 1));
    const cfg = surfaceConfig(this.body);
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./terrain.worker.js', import.meta.url), { type: 'module' });
        w.busy = 0;
        w.onmessage = (ev) => this._onMessage(w, ev.data);
        w.onerror = (e) => {
          console.warn('[terrain] worker error — falling back to main-thread builds', e.message || e);
          this._workerFailed = true;
          // requeue whatever was in flight so nothing waits forever
          for (const n of this.jobs.values()) if (n.state === 1) n.state = 0;
          this.jobs.clear(); this.inflight = 0;
          if (!this.texReady) this._setDetail(bakeDetail(DETAIL_SIZE), DETAIL_SIZE);
        };
        w.postMessage({ type: 'init', cfg });
        this.workers.push(w);
      }
      this.workers[0].postMessage({ type: 'bake', size: DETAIL_SIZE });
    } catch (e) {
      console.warn('[terrain] workers unavailable, building on the main thread', e);
      for (const w of this.workers) w.terminate();
      this.workers = [];
    }
    if (!this.workers.length) this._setDetail(bakeDetail(DETAIL_SIZE), DETAIL_SIZE);
  }

  _onFlatten(f, all) {
    const flats = (all || []).map((x) => ({ id: x.id, x: x.x, y: x.y, z: x.z, radius: x.radius, falloff: x.falloff, height: x.height }));
    for (const w of this.workers) { try { w.postMessage({ type: 'flats', flats }); } catch (_) { /* */ } }
    const ang = (f.radius + f.falloff) / this.R + 1e-4;
    const walk = (n) => {
      const c = Math.min(1, Math.max(-1, n.dx * f.x + n.dy * f.y + n.dz * f.z));
      if (Math.acos(c) > n.ang * 1.05 + ang) return;
      if (n.mesh) { n.stale = true; if (n.state === 2) n.state = 0; }
      else if (n.state === 1) n.restale = true;          // in flight with the old stamps
      if (n.children) for (let i = 0; i < 4; i++) walk(n.children[i]);
    };
    for (const r of this.roots) walk(r);
  }

  _onMessage(w, m) {
    if (m.type === 'bake') { this._setDetail(m.data, m.size); return; }
    if (m.type === 'build' || m.type === 'error') {
      w.busy = Math.max(0, w.busy - 1);
      this.inflight = Math.max(0, this.inflight - 1);
      const node = this.jobs.get(m.id);
      this.jobs.delete(m.id);
      if (!node) return;
      if (m.type === 'error') { console.warn('[terrain] build failed', m.message); node.state = 0; node.fail = (node.fail || 0) + 1; return; }
      if (node.dead) return;
      this.builds++;
      this.uploads.push([node, m]);
    }
  }

  _setDetail(data, size) {
    try {
      const tex = new THREE.DataArrayTexture(data, size, size, DETAIL_LAYERS);
      tex.format = THREE.RGBAFormat;
      tex.type = THREE.UnsignedByteType;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = this.q.tier === 'low' ? 1 : this._softGL() ? 2 : 4;
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      this.detailTex = tex;
      const U = this.material.userData.uniforms;
      U.uRvDetail.value = tex;
      U.uRvP.value.w = this.q.tier === 'low' ? 0.6 : 1;
      this.texReady = true;
    } catch (e) { console.warn('[terrain] detail texture failed', e); this.texReady = true; }
  }

  _liteLighting(q) {
    try {
      const v = new URLSearchParams(globalThis.location?.search || '').get('tlite');
      if (v === '0') return false;
      if (v === '1') return true;
    } catch (_) { /* no url */ }
    return q.tier === 'low' || this._softGL();
  }

  _softGL() {
    try {
      const gl = this.engine.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return /SwiftShader|llvmpipe|Software/i.test(String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)));
    } catch (_) { return false; }
  }

  // ------------------------------------------------------------------ per frame
  lateUpdate() {
    const t0 = performance.now();
    try { this._frame(); } catch (e) {
      if (!this._warned) { console.warn('[terrain] update error', e); this._warned = true; }
    }
    const dt = performance.now() - t0;
    this.ms = this.ms * 0.9 + dt * 0.1;
    if (dt > this.msMax) this.msMax = dt;
  }

  _frame() {
    const S = this.surface;
    if (!S) return;
    this.frame++;
    const world = this.world;
    const cam = this._cam.copy(world.camera.position);
    const R = this.R;
    const camDist = Math.max(cam.length(), 1);
    this.cdx = cam.x / camDist; this.cdy = cam.y / camDist; this.cdz = cam.z / camDist;
    const rLow = R + Math.min(0, this.hMin0 * 0.3);
    this.horizon = Math.acos(Math.min(1, rLow / Math.max(camDist, rLow))) + Math.acos(Math.min(1, rLow / (R + this.hMax0))) + 0.02;
    // frustum in scene space (priorities only; three culls meshes itself)
    const c = world.camera;
    c.updateMatrixWorld();
    _pm.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    this.origin = world.origin;
    updateOriginMod(this.material, world.origin);

    // 1. select
    this.desired.length = 0;
    for (const r of this.roots) this._select(r, cam);
    // 2. requests (missing desired nodes + the always-present coarse levels)
    const pend = this.pending; pend.length = 0;
    for (const r of this.roots) { this._want(r); r.used = this.frame; }
    for (const n of this.desired) { n.used = this.frame; this._want(n); }
    this._dispatch();
    // 3. uploads
    this._upload();
    // 4. draw set
    this._draw(cam);
    // shot mode: skip drawing the terrain while it streams (software GL renders of the partial
    // terrain only slow the capture down); it appears complete once ready
    if (this.shot) this.group.visible = this.isReady() || this._shown === true;
    if (this.group.visible) this._shown = true;
    // 5. housekeeping
    if ((this.frame & 31) === 0) this._gc();
  }

  _want(n) {
    if (n.state !== 0 || (n.mesh && !n.stale) || (n.fail || 0) > 3) return;
    // priority: in view first, coarse before fine, near before far
    n.prio = (n.inView ? 0 : 1e9) + n.level * 1e7 + n.closest;
    this.pending.push(n);
  }

  _bound(n) {
    const hm = (n.hMin + n.hMax) * 0.5;
    const rr = this.R + hm;
    const ext = (this.R + n.hMax) * Math.sin(Math.min(n.ang, 1.5)) + (n.hMax - n.hMin) * 0.5 + (this.R + n.hMax) * (1 - Math.cos(Math.min(n.ang, 1.5)));
    _sphere.center.set(n.dx * rr, n.dy * rr, n.dz * rr);
    _sphere.radius = ext;
    return _sphere;
  }

  _select(n, cam) {
    // horizon culling
    if (n.level > 0) {
      const a = Math.acos(Math.max(-1, Math.min(1, n.dx * this.cdx + n.dy * this.cdy + n.dz * this.cdz)));
      if (a - n.ang > this.horizon) return;
    }
    const s = this._bound(n);
    const d = s.center.distanceTo(cam) - s.radius;
    n.closest = d > 0 ? d : 0;
    s.center.sub(this.origin);
    n.inView = _frustum.intersectsSphere(s);
    // only refine built nodes: their real height range bounds the children (progressive refinement)
    // shot mode: nodes outside the view stay coarse (captures only need what is on screen)
    const lim = this.shot && !n.inView ? 0.3 : 1;
    if (n.level < this.maxLevel && n.closest < n.D * lim && n.mesh) {
      if (!n.children) {
        const h = n.size / 2;
        n.children = [
          new Node(this, n.face, n.level + 1, n.u0, n.v0, h, n),
          new Node(this, n.face, n.level + 1, n.u0 + h, n.v0, h, n),
          new Node(this, n.face, n.level + 1, n.u0, n.v0 + h, h, n),
          new Node(this, n.face, n.level + 1, n.u0 + h, n.v0 + h, h, n),
        ];
      }
      n.used = this.frame;
      for (let i = 0; i < 4; i++) this._select(n.children[i], cam);
    } else {
      this.desired.push(n);
    }
  }

  _job(n) {
    return { face: n.face, u0: n.u0, v0: n.v0, size: n.size, RES: this.RES, Dp: n.parent ? n.parent.D : 0 };
  }

  _dispatch() {
    const pend = this.pending;
    if (!pend.length) return;
    pend.sort((a, b) => a.prio - b.prio);
    if (this.workers.length && !this._workerFailed) {
      const cap = this.workers.length * (this.shot ? 6 : 2);
      let i = 0;
      while (this.inflight < cap && i < pend.length) {
        let w = this.workers[0];
        for (const x of this.workers) if (x.busy < w.busy) w = x;
        const n = pend[i++];
        const id = this.jobId++;
        n.state = 1; n.restale = false;
        this.jobs.set(id, n);
        w.busy++; this.inflight++;
        w.postMessage({ type: 'build', id, job: this._job(n) });
      }
    } else {
      // main-thread fallback (time-sliced)
      const t0 = performance.now();
      const budget = this.shot ? 400 : 6;
      let i = 0;
      while (i < pend.length && performance.now() - t0 < budget) {
        const n = pend[i++];
        try { this.uploads.push([n, buildChunk(this.surface, this._job(n))]); n.state = 1; } catch (e) { n.fail = 9; console.warn('[terrain] build', e); }
      }
    }
  }

  _upload() {
    const ups = this.uploads;
    this.changed = ups.length > 0;
    if (!ups.length) return;
    const t0 = performance.now();
    // coarse first so fallbacks exist
    if (ups.length > 1) ups.sort((a, b) => a[0].level - b[0].level || a[0].closest - b[0].closest);
    let k = 0;
    while (k < ups.length && (k < 2 || performance.now() - t0 < this.uploadBudgetMs)) {
      const [n, m] = ups[k++];
      if (n.dead) continue;
      this._makeMesh(n, m);
    }
    ups.splice(0, k);
  }

  _makeMesh(n, m) {
    if (n.mesh) { n.mesh.geometry.dispose(); this.group.remove(n.mesh); n.mesh = null; }
    n.stale = false;
    if (n.restale) { n.restale = false; n.stale = true; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 4, true));
    g.setAttribute('aMorph', new THREE.BufferAttribute(m.morph, 4));
    g.setAttribute('aMorphN', new THREE.BufferAttribute(m.nrmP, 4, true));
    g.setAttribute('aMat', new THREE.BufferAttribute(m.mat, 4, true));
    g.setAttribute('aMat2', new THREE.BufferAttribute(m.mat2, 4, true));
    if (m.mat3) g.setAttribute('aMat3', new THREE.BufferAttribute(m.mat3, 4, true));
    g.setAttribute('aUV', new THREE.BufferAttribute(m.uvw, 3));
    g.setIndex(this.index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), m.radius);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-m.radius, -m.radius, -m.radius), new THREE.Vector3(m.radius, m.radius, m.radius));
    const mesh = new THREE.Mesh(g, this.material);
    mesh.name = 'terrain-chunk';
    mesh.customDepthMaterial = this.depthMaterial;
    mesh.position.set(m.center[0], m.center[1], m.center[2]);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.visible = false;
    mesh.userData.terrain = true;
    this.group.add(mesh);
    n.mesh = mesh; n.state = 2;
    // refine height bounds for this node and its future children
    n.hMin = m.hMin; n.hMax = m.hMax;
    // relief-aware range: chunks spanning tall walls refine earlier (a heightfield wall of slope s
    // has only spacing·s vertical resolution — kilometre walls otherwise read as smooth sheets).
    // Set once, before children exist (their morph data bakes this D). CDLOD seamlessness needs
    // D(child) ≤ 0.66·D(parent) ⇒ rf(child) ≤ 1.32·rf(parent).
    if (!n.children && !n.rfSet && n.level > 2) {
      n.rfSet = true;
      const rel = (m.hMax - m.hMin) / Math.max(1, n.side);
      const want = 1 + this.reliefK * Math.min(1, Math.max(0, (rel - 0.6) / 2.4));
      const pr = n.parent ? n.parent.rf : 1;
      n.rf = Math.max(pr * 0.5, Math.min(want, pr * 1.3));
      n.D = this.K * n.side * n.rf;
    }
    if (n.children) for (const c of n.children) { if (!c.mesh) { c.hMin = m.hMin; c.hMax = m.hMax; } }
  }

  _draw() {
    const f = this.frame;
    // mark fallbacks: nearest built ancestor of every missing desired node
    for (const n of this.desired) {
      if (n.mesh) continue;
      let p = n.parent;
      while (p && !p.mesh) p = p.parent;
      if (p) p.drawn = f;
    }
    let count = 0, casters = 0;
    for (const n of this.desired) {
      if (!n.mesh) continue;
      let covered = false;
      for (let p = n.parent; p; p = p.parent) if (p.drawn === f) { covered = true; break; }
      if (!covered) n.drawn = f;
    }
    // apply visibility (walk all nodes with meshes)
    const walk = (n) => {
      if (n.mesh) {
        const vis = n.drawn === f;
        n.mesh.visible = vis;
        if (vis) {
          count++;
          n.used = f;
          // only chunks that are both near and small enough cast into the (<= ~1 km) sun cascades
          // (caster budget: ≲ 25–35 chunks ≈ 0.3 M triangles per cascade)
          const cast = this.q.shadows !== false && n.closest < (n.inView ? this.shadowDist * 0.45 : this.shadowDist * 0.15) && n.side < this.shadowDist * 0.5;
          n.mesh.castShadow = cast;
          // chunks beyond the last cascade skip the (expensive) shadow lookups entirely
          n.mesh.receiveShadow = n.closest < this.receiveDist;
          if (cast) casters++;
        }
      }
      if (n.children) for (let i = 0; i < 4; i++) walk(n.children[i]);
    };
    for (const r of this.roots) walk(r);
    this.meshCount = count; this.casters = casters;
  }

  _gc() {
    const f = this.frame, keep = this.shot ? 1e9 : 300;
    const visit = (n) => {
      const fresh = f - n.used <= keep;
      let alive = fresh || n.state === 1;
      if (n.children) {
        let ch = false;
        for (let i = 0; i < 4; i++) if (visit(n.children[i])) ch = true;
        if (!ch && !fresh) { for (const c of n.children) c.dead = true; n.children = null; }
        else if (ch) alive = true;
      }
      if (n.mesh && n.level > 1 && !fresh) {
        n.mesh.geometry.dispose(); this.group.remove(n.mesh); n.mesh = null; n.state = 0;
      }
      return alive || !!n.mesh;
    };
    for (const r of this.roots) visit(r);
  }

  // ------------------------------------------------------------------ public
  isReady() {
    if (!this.texReady || this.desired.length === 0) return false;
    if (this.uploads.length || this.changed || this.inflight) return false;
    for (const n of this.desired) if ((!n.mesh || n.stale) && (n.fail || 0) <= 3) return false;
    if (!this.readyMs) this.readyMs = Math.round(performance.now() - this._t0);
    return true;
  }

  /**
   * Flora request: the `lod` (m) of the terrain mesh drawn under unit direction (x, y, z) — 1.5 × the
   * vertex spacing of the finest visible chunk there. `surface.heightLod(x, y, z, terrain.lodAt(x, y, z))`
   * is then the height of the rendered mesh at its vertices (between vertices the mesh interpolates
   * linearly; geomorphing blends toward 2× this lod near the chunk's range limit). Cheap (tree walk).
   */
  lodAt(x, y, z) {
    try {
      let f = 0, best = -2;
      for (let i = 0; i < 6; i++) { const F = FACES[i].n; const d = x * F[0] + y * F[1] + z * F[2]; if (d > best) { best = d; f = i; } }
      const F = FACES[f];
      const u = Math.atan((x * F.u[0] + y * F.u[1] + z * F.u[2]) / best) / (Math.PI / 4);
      const v = Math.atan((x * F.v[0] + y * F.v[1] + z * F.v[2]) / best) / (Math.PI / 4);
      let n = this.roots[f], found = n.mesh ? n : null;
      while (n && n.children) {
        const h = n.size / 2;
        const c = n.children[(u >= n.u0 + h ? 1 : 0) + (v >= n.v0 + h ? 2 : 0)];
        if (!c) break;
        if (c.mesh && c.mesh.visible) found = c;
        n = c;
      }
      if (!found) return 64;
      return (found.side / this.RES) * 1.5;
    } catch (_) { return 1; }
  }

  /** Height (m rel. radius) of the rendered terrain mesh at unit direction (see lodAt). */
  renderedHeight(x, y, z) { return this.surface.heightLod(x, y, z, this.lodAt(x, y, z)); }

  getState() {
    const hist = {}; let iv = 0;
    for (const n of this.desired) { hist[n.level] = (hist[n.level] || 0) + 1; if (n.inView) iv++; }
    return { chunks: this.meshCount, casters: this.casters, desired: this.desired.length, inflight: this.inflight, uploads: this.uploads.length, maxLevel: this.maxLevel, K: +this.K.toFixed(2), workers: this.workers.length, tex: this.texReady, inView: iv, levels: hist, ms: +this.ms.toFixed(2), msMax: +this.msMax.toFixed(1), readyMs: this.readyMs, builds: this.builds };
  }

  onOriginShift() { /* chunk transforms are planet-local under world.root: nothing to do */ }

  dispose() {
    for (const w of this.workers) { try { w.terminate(); } catch (_) { /* */ } }
    this.workers = [];
    try { this._offFlat?.(); } catch (_) { /* */ }
    const walk = (n) => { if (n.mesh) { n.mesh.geometry.dispose(); n.mesh = null; } n.dead = true; if (n.children) n.children.forEach(walk); };
    this.roots.forEach(walk);
    this.material.dispose();
    this.depthMaterial.dispose();
    this.detailTex?.dispose();
    this.group.removeFromParent();
  }
}

export default {
  name: 'terrain',
  order: 10,
  async create(world) {
    if (!world.surface) return null;
    return new Terrain(world);
  },
};
