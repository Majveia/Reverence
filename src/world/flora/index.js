// Flora subsystem (order 30). OWNED BY THE FLORA TRACK.
//
// Vegetation that makes worlds feel alive, dense and art-directed:
//   • procedural species (trees, alien plants, bushes, ferns, reeds, flowers, rocks) generated at
//     startup from body.art.flora (see styles.js) with two mesh LODs each + baked impostors,
//   • GPU-instanced grass patches with wind gusts, player push and color variation (grass.js),
//   • deterministic placement per cube-sphere cell from world.surface (biome, moisture, temperature,
//     slope, altitude, shore), computed in Web Workers (placement.js), streamed around the camera,
//   • distance LOD per band: mesh LOD0 → LOD1 → near impostors → far impostor forests (to the
//     horizon, visible from altitude), all with dithered crossfades,
//   • colliders for trees & rocks near the player, POIs for legendary giant trees.
//
// Public API (world.get('flora')):
//   .style                      resolved style key ('lush', 'boreal', 'fungal', …)
//   .densityAt(dir)             rough vegetation cover [0..1] at a unit direction (for other tracks)
//   .getState()                 { style, cells, instances, drawCalls, ready, … }
//   .setVisible(bool)
import * as THREE from 'three';
import { hashCombine } from '../../core/rng.js';
import { surfaceConfig } from '../planet/SurfaceGen.js';
import { mulberry, h01, clamp } from './util.js';
import { levelFor, forEachCellInCap, cellKey } from './cells.js';
import { InstanceLayer } from './layer.js';
import { FloraShared, makePlantMaterials, makeRockMaterials } from './materials.js';
import { makeLeafAtlas, makeBarkTexture, makeRockTexture } from './textures.js';
import { buildStyle } from './styles.js';
import { flowerPatch } from './geom/plants.js';
import { makeRock } from './geom/rocks.js';
import { STRIDE, runJob } from './placement.js';
import { makeGrassPatch, makeGrassMaterial } from './grass.js';
import { bakeImpostors, makeImpostorQuad, makeImpostorMaterials, MAX_IMP } from './impostor.js';

const _cam = new THREE.Vector3(), _v = new THREE.Vector3();

class Flora {
  constructor(world) {
    this.world = world;
    this.engine = world.engine;
    this.q = world.quality || {};
    this.body = world.body;
    this.surface = world.surface;
    this.R = world.body.radius;
    this.shot = !!world.engine?.shot;
    this.group = new THREE.Group();
    this.group.name = 'flora';
    world.root.add(this.group);
    this.models = [];
    this.layers = [];
    this.cells = new Map();         // key → cell record
    this.pending = new Map();       // key → job
    this.queue = [];
    this.jobId = 1;
    this.jobs = new Map();
    this.workers = [];
    this.ready = false;
    this.t0 = performance.now();
    this.stats = { jobs: 0, jobMs: 0 };
    this.pushU = { value: new THREE.Vector4(0, -1e7, 0, 1.3) };
    this.colliderCells = new Set();
    this.poiKeys = new Set();
    this.visible = true;
  }

  // ================================================================== setup
  async init() {
    const q = this.q;
    const tier = q.tier || 'high';
    const low = tier === 'low';
    this.density = clamp(q.floraDensity ?? 1, 0.15, 2);
    this.dd = clamp(q.drawDistance ?? 1, 0.4, 1.6);
    const seed = (this.body.seed ?? 1) >>> 0;
    this.seed = seed;

    this.atlas = makeLeafAtlas(low ? 1024 : 2048, (seed % 997) + 1);
    this.bark = makeBarkTexture(256, 512, 7 + (seed % 13));
    this.rockTex = makeRockTexture(low ? 256 : 512, 11 + (seed % 17));
    this.shared = new FloraShared({ atlas: this.atlas.texture, atlasSize: low ? 1024 : 2048, bark: this.bark });
    const S = buildStyle(this.body, this.atlas);
    this.S = S;
    this.styleKey = S.key;

    const sea = Number.isFinite(this.surface.seaLevel) && this.surface.seaLevel > -1e8 ? this.surface.seaLevel : null;
    this.sea = sea ?? -1e9;
    const base = sea ?? (this.surface.minHeight ?? -this.surface.amp);
    this.table = {
      R: this.R, seed: seed | 0, density: this.density, hasSea: sea !== null, sea: sea ?? -1e9, altBase: base,
      altSpan: Math.max(50, (this.surface.maxHeight ?? this.surface.amp) - base),
      layers: {},
      grass: null,
    };

    this._buildModels(S, tier);
    this._buildLayers(S, tier);
    this._buildGrass(S, tier);
    this._bands(tier);
    this._startWorkers();
    this.ready = false;
    this.initMs = Math.round(performance.now() - this.t0);
    return this;
  }

  _buildModels(S, tier) {
    const low = tier === 'low';
    const maxVarCanopy = low ? 1 : tier === 'med' ? 2 : 3;
    const maxVarUnder = low ? 1 : 2;
    const T = this.table;
    const mkLayerTable = (name, L, extra) => ({
      spacing: L.spacing, cover: Array.from(L.cover), salt: hashCombine(name.length * 7919, name.charCodeAt(0)) | 0,
      clusterScale: extra.clusterScale, clusterAmt: extra.clusterAmt, zoneScale: extra.zoneScale,
      minAboveSea: extra.minAboveSea ?? 0.25, allowShallow: !!extra.allowShallow, species: [],
    });
    T.layers.canopy = mkLayerTable('canopy', S.canopy, { clusterScale: 140, clusterAmt: 1.0, zoneScale: 300 });
    T.layers.under = mkLayerTable('under', S.under, { clusterScale: 45, clusterAmt: 0.9, zoneScale: 110, allowShallow: true, minAboveSea: 0.1 });
    T.layers.rock = mkLayerTable('rock', S.rock, { clusterScale: 70, clusterAmt: 1.3, zoneScale: 200, allowShallow: true, minAboveSea: -0.6 });
    let canopyCount = 0;
    for (const layer of ['canopy', 'under']) {
      const list = S[layer].species;
      list.forEach((sp, si) => {
        const nv = Math.max(1, Math.min(sp.variants || 1, layer === 'canopy' ? maxVarCanopy : maxVarUnder));
        const models = [];
        for (let v = 0; v < nv; v++) {
          if (layer === 'canopy' && canopyCount >= MAX_IMP) break;
          const rnd = mulberry(hashCombine(this.seed, si * 131 + (layer === 'canopy' ? 7 : 3), v, sp.id.length));
          let r;
          try { r = sp.gen(rnd, sp.params); } catch (e) { console.warn('[flora] generator failed', sp.id, e); continue; }
          const geo0 = r.lod0.build(), geo1 = r.lod1.build();
          const m = {
            idx: this.models.length, layer, sp, geo0, geo1, height: r.height || geo0.boundingBox.max.y,
            radius: r.radius ?? r.crownR ?? Math.max(geo0.boundingBox.max.x, geo0.boundingBox.max.z),
            colR: r.collider?.r ?? (r.trunkR ? r.trunkR * 1.15 : null), colH: r.collider?.h ?? (r.height ? r.height * 0.55 : 3),
            imp: layer === 'canopy' ? canopyCount++ : -1,
          };
          this.models.push(m);
          models.push(m.idx);
        }
        if (!models.length) return;
        T.layers[layer].species.push({
          id: sp.id, biomes: Array.from(sp.biomes), m: sp.m, t: sp.t, slope: sp.slope, alt: sp.alt, zone: sp.zone ?? -1,
          dens: sp.dens ?? 1, scale: sp.scale || [0.8, 1.2], lean: sp.lean ?? 0.05, sink: sp.sink ?? 0.2, shore: sp.shore || 0,
          align: layer === 'under' ? 0.35 : 0, models,
        });
      });
    }
    // flowers (placed with the grass patches)
    const flowers = [];
    for (const [fi, F] of (S.grass.flowers || []).entries()) {
      const models = [];
      for (let v = 0; v < (low ? 1 : 2); v++) {
        const rnd = mulberry(hashCombine(this.seed, 977 + fi, v));
        const P = { rect: F.rect, colA: F.colA, colB: F.colB, type: F.type, height: F.height ?? 0.42, radius: 0.35, headSize: F.type === 'daisy' ? 0.075 : 0.09, count: F.type === 'daisy' ? 9 : 5, stem: [0.05, 0.1, 0.03] };
        let r;
        try { r = flowerPatch(rnd, P); } catch (e) { console.warn('[flora] flower failed', e); continue; }
        const m = { idx: this.models.length, layer: 'flower', sp: { id: 'flower' + fi, tint2: F.tint2, glow: F.glow || 0, cardGlow: F.glow || 0, billboard: 0.9 }, geo0: r.lod0.build(), geo1: r.lod1.build(), height: r.height, radius: r.radius, imp: -1 };
        this.models.push(m); models.push(m.idx);
      }
      if (models.length) flowers.push({ freq: F.freq ?? 1, models });
    }
    this.flowerList = flowers;
    // rocks
    const shapes = S.rock.shapes || ['boulder'];
    const rockModels = [];
    shapes.forEach((shape, k) => {
      for (let v = 0; v < (low ? 1 : 2); v++) {
        if (v > 0 && k > 2) break;
        const r = makeRock(hashCombine(this.seed, 311 + k, v) % 100000, shape, low ? 3 : 4, 1);
        const m = { idx: this.models.length, layer: 'rock', sp: { id: 'rock-' + shape }, geo0: r.lod0, geo1: r.lod1, height: r.height, radius: r.radius, imp: -1, rock: r };
        this.models.push(m); rockModels.push(m.idx);
      }
    });
    const rs = S.rock.species[0];
    T.layers.rock.species.push({ id: 'rocks', biomes: Array.from(rs.biomes), m: null, t: null, slope: 3, alt: null, zone: -1, dens: 1, scale: [0.35, 2.6], lean: 0.4, sink: 0.22, shore: 0, align: 0.8, models: rockModels });
  }

  _plantMat(m, lod, fade, thin, cast) {
    const sp = m.sp, S = this.S;
    const p = makePlantMaterials({
      shared: this.shared, barkLayer: sp.barkLayer ?? 0, barkScale: sp.barkScale ?? 1, tint2: sp.tint2 ?? [0.12, 0.08, 0.05],
      transl: S.translucency ?? 0.9, glow: sp.glow ?? 0, cardGlow: sp.cardGlow ?? 0,
      moss: S.rock.moss, mossAmt: S.key === 'moss' ? 0.8 : 0.3, windAmp: (sp.windAmp ?? 1) * (S.windAmp ?? 1),
      billboard: sp.billboard ?? 0.85, fade, thin, tintVar: 0.4, alphaToCoverage: (this.q.msaa ?? 0) > 0,
    });
    return p;
  }

  _buildLayers(S, tier) {
    const dd = this.dd;
    const shadows = this.q.shadows !== false;
    const par = this.group;
    this.bandLayers = { canopy: [], under: [], rock: [], flower: [] };
    const add = (m, lod, geo, mats, o) => {
      const L = new InstanceLayer(geo, mats.material, mats.depth, { capacity: o.cap, parent: par, castShadow: shadows && o.cast, name: `flora-${m.sp.id}-${lod}` });
      L.model = m; L.lod = lod; L.uniforms = mats.uniforms; L.fadeV = o.fade;
      this.layers.push(L);
      return L;
    };
    // distances (m)
    const D = this.D = {
      c0: [55 * dd, 70 * dd], c1: [190 * dd, 240 * dd], cI: [680 * dd, 800 * dd],
      u0: [20 * dd, 28 * dd], uR: 150 * dd * Math.sqrt(this.density),
      r0: [45 * dd, 60 * dd], rR: 560 * dd,
      f0: [14, 20], fR: 48 * Math.sqrt(this.density),
    };
    for (const m of this.models) {
      if (m.layer === 'canopy') {
        const f0 = [0, 0, D.c0[0], D.c0[1]], f1 = [D.c0[0], D.c0[1], D.c1[0], D.c1[1]];
        m.L0 = add(m, 0, m.geo0, this._plantMat(m, 0, f0, null), { cap: 256, cast: true, fade: f0 });
        m.L1 = add(m, 1, m.geo1, this._plantMat(m, 1, f1, null), { cap: 1024, cast: false, fade: f1 });
        this.bandLayers.canopy.push(m);
      } else if (m.layer === 'under' || m.layer === 'flower') {
        const near = m.layer === 'flower' ? D.f0 : D.u0, R = m.layer === 'flower' ? D.fR : D.uR;
        const f0 = [0, 0, near[0], near[1]], f1 = [near[0], near[1], R * 0.8, R];
        const thin = [near[1] * 1.3, 0.9, 0.2, 1];
        m.L0 = add(m, 0, m.geo0, this._plantMat(m, 0, f0, null), { cap: 512, cast: m.layer === 'under' && m.height > 1.0, fade: f0 });
        m.L1 = add(m, 1, m.geo1, this._plantMat(m, 1, f1, thin), { cap: 2048, cast: false, fade: f1 });
        this.bandLayers[m.layer === 'flower' ? 'flower' : 'under'].push(m);
      } else if (m.layer === 'rock') {
        const S2 = S.rock;
        const mk = (fade) => makeRockMaterials({ tex: this.rockTex, colA: S2.colA, colB: S2.colB, moss: S2.moss, mossAmt: S2.mossAmt, strata: 0.35, fade, snow: 0 });
        const f0 = [0, 0, D.r0[0], D.r0[1]], f1 = [D.r0[0], D.r0[1], D.rR * 0.85, D.rR];
        m.L0 = add(m, 0, m.geo0, mk(f0), { cap: 256, cast: true, fade: f0 });
        m.L1 = add(m, 1, m.geo1, mk(f1), { cap: 1024, cast: false, fade: f1 });
        this.bandLayers.rock.push(m);
      }
    }
    // impostors
    const canopy = this.models.filter((m) => m.layer === 'canopy');
    this.imp = null;
    if (canopy.length && this.engine?.renderer) {
      try {
        const bk = bakeImpostors(this.engine.renderer, this.atlas.texture, canopy.map((m) => ({
          geo: m.geo0, tint2: m.sp.tint2, glow: m.sp.glow || 0, cardGlow: m.sp.cardGlow || 0,
          glowLevel: (m.sp.glow || m.sp.cardGlow) ? 1 : 0, avg: m.sp.params?.leafA || m.sp.params?.colA || [0.1, 0.14, 0.05],
        })), tier === 'low' ? 128 : 256);
        this.impBake = bk;
        const quad = makeImpostorQuad();
        this.impQuad = quad;
        const fN = [D.c1[0], D.c1[1], D.cI[0], D.cI[1]];
        const matN = makeImpostorMaterials(bk, { fade: fN, dfade: [D.c0[0], D.c0[1], D.cI[0], D.cI[1]], transl: S.translucency ?? 0.9, glow: 1 });
        const LN = new InstanceLayer(quad, matN.material, matN.depth, { capacity: 4096, parent: this.group, castShadow: shadows, name: 'flora-imp-near', boundsPad: 40 });
        LN.uniforms = matN.uniforms;
        this.layers.push(LN);
        this.farR = Math.min(9000, 4200 * dd);
        const fF = [D.cI[0], D.cI[1], this.farR * 0.8, this.farR];
        const matF = makeImpostorMaterials(bk, { fade: fF, transl: S.translucency ?? 0.9, glow: 1, scaleMul: 1.0 });
        const LF = new InstanceLayer(quad, matF.material, matF.depth, { capacity: 16384, parent: this.group, castShadow: false, name: 'flora-imp-far', boundsPad: 60 });
        LF.uniforms = matF.uniforms;
        this.layers.push(LF);
        this.imp = { near: LN, far: LF };
      } catch (e) {
        console.warn('[flora] impostor bake failed', e);
      }
    }
  }

  _buildGrass(S, tier) {
    const low = tier === 'low';
    const G = S.grass;
    const anyGrass = G.cover && Array.from(G.cover).some((v) => v > 0);
    this.grass = null;
    const dens = this.density * (G.density ?? 1);
    this.table.grass = {
      cover: Array.from(G.cover || new Float32Array(14)), spacing: 0.72 / Math.sqrt(clamp(dens, 0.3, 1.3)),
      dryAmount: G.dryAmount ?? 0.2, flowerAmt: 0.4, flowers: this.flowerList, flowerWsum: this.flowerList.reduce((a, f) => a + f.freq, 0),
    };
    if (!anyGrass) return;
    const R = this.grassR = (low ? 28 : 48) * Math.sqrt(clamp(this.density, 0.3, 1.5)) * (this.shot ? 1 : 1);
    const hgt = G.height ?? 0.55;
    const common = {
      base: G.base, tip: G.tip, dry: G.dry, glowTip: G.glowTip, glowAmt: 1.6, push: this.pushU,
      height: hgt * 0.62, patchR: 0.6, transl: 0.9, stiff: 1,
    };
    const dense = makeGrassPatch(low ? 30 : 64, low ? 3 : 4, 11);
    const sparse = makeGrassPatch(low ? 14 : 26, 2, 23);
    const nearF = [9, 13];
    const mD = makeGrassMaterial({ ...common, fade: [0, 0, nearF[0], nearF[1]], keep: [1e6, 1, 1, 1], width: 0.048, widenK: 0.008, density: 1 });
    const mS = makeGrassMaterial({ ...common, fade: [nearF[0], nearF[1], R * 0.72, R], keep: [nearF[1] * 1.4, 0.9, 0.25, 1], width: 0.1, widenK: 0.014, density: 1 });
    const LD = new InstanceLayer(dense, mD.material, null, { capacity: 2048, parent: this.group, castShadow: false, name: 'flora-grass-dense', boundsPad: 2 });
    const LS = new InstanceLayer(sparse, mS.material, null, { capacity: 8192, parent: this.group, castShadow: false, name: 'flora-grass-sparse', boundsPad: 2 });
    LD.uniforms = mD.uniforms; LS.uniforms = mS.uniforms;
    this.layers.push(LD, LS);
    this.grass = { dense: LD, sparse: LS, nearR: nearF[1] + 3, geoD: dense, geoS: sparse };
  }

  _bands() {
    const R = this.R, dd = this.dd;
    const lv = (m) => levelFor(R, m);
    this.bands = [
      { name: 'grass', kind: 'grass', L: lv(18), radius: this.grassR || 0, step: 1.5, enabled: !!this.grass, maxAlt: 250 },
      { name: 'under', kind: 'layer', layer: 'under', L: lv(64), radius: this.D.uR + 20, step: 4, enabled: this.table.layers.under.species.length > 0, maxAlt: 600 },
      { name: 'rock', kind: 'layer', layer: 'rock', L: lv(128), radius: this.D.rR + 40, step: 8, enabled: true, maxAlt: 2500 },
      { name: 'canopy', kind: 'layer', layer: 'canopy', L: lv(160), radius: this.D.cI[1] + 40, step: 8, enabled: this.table.layers.canopy.species.length > 0, maxAlt: 3000 },
      { name: 'far', kind: 'layer', layer: 'canopy', L: lv(1100), radius: this.farR || 0, step: 150, enabled: !!this.imp && this.table.layers.canopy.species.length > 0, maxAlt: 1e9,
        opt: { lod: 10, spacingMul: 2.1, scaleMul: 1.3, slopeStep: 12, maxGrid: 80 } },
    ];
    this.bands.forEach((b, i) => { b.idx = i; });
    for (const b of this.bands) { b.cells = new Map(); b.dirty = true; b.last = new THREE.Vector3(1e12, 0, 0); b.bucketT = 0; }
  }

  _startWorkers() {
    const n = this.q.mobile ? 1 : Math.max(2, Math.min(3, ((navigator.hardwareConcurrency || 4) >> 1) - 1));
    const cfg = surfaceConfig(this.body);
    for (let i = 0; i < n; i++) {
      try {
        const w = new Worker(new URL('./flora.worker.js', import.meta.url), { type: 'module' });
        const rec = { w, busy: 0, ok: false };
        w.onmessage = (ev) => this._onMsg(rec, ev.data);
        w.onerror = (e) => { console.warn('[flora] worker error', e.message || e); rec.dead = true; };
        w.postMessage({ type: 'init', cfg, table: this.table });
        this.workers.push(rec);
      } catch (e) { console.warn('[flora] workers unavailable, using main thread', e); break; }
    }
  }

  _onMsg(rec, m) {
    if (m.type === 'init') { rec.ok = true; return; }
    if (m.type === 'error') { console.warn('[flora] job failed', m.message); rec.busy = Math.max(0, rec.busy - 1); const j = this.jobs.get(m.id); if (j) { this.jobs.delete(m.id); this.pending.delete(j.key); } return; }
    if (m.type === 'job') {
      rec.busy = Math.max(0, rec.busy - 1);
      const j = this.jobs.get(m.id);
      if (!j) return;
      this.jobs.delete(m.id);
      this.pending.delete(j.key);
      this._accept(j, m.res);
      // keep workers fed between frames (software-GL frames can take seconds)
      if (this.queue.length) this._dispatch();
    }
  }

  // ================================================================== streaming
  _accept(j, res) {
    const b = j.band;
    if (!res) res = { n: 0, anchor: [0, 0, 0], inst: new Float32Array(0), model: new Uint16Array(0) };
    const c = { key: j.key, band: b, res, dir: j.dir, colliders: null };
    b.ms = (b.ms || 0) + (res.ms || 0); b.jobs = (b.jobs || 0) + 1;
    if (b.name === 'canopy') this._legendary(c);
    b.cells.set(j.key, c);
    b.dirty = true;
  }

  /** rare legendary giants: scaled-up canopy trees registered as POIs */
  _legendary(c) {
    const r = c.res, n = r.n;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      if (r.inst[o + 8] > 0.0035) continue;
      const m = this.models[r.model[i]];
      if (!m || m.height < 8 || !m.colR) continue;
      r.inst[o + 3] *= 2.4;
      const pos = new THREE.Vector3(r.anchor[0] + r.inst[o], r.anchor[1] + r.inst[o + 1], r.anchor[2] + r.inst[o + 2]);
      const key = c.key * 64 + i;
      if (this.poiKeys.has(key)) continue;
      this.poiKeys.add(key);
      const names = { oak: 'Elder Oak', spruce: 'Grandfather Spruce', pine: 'Ancient Pine', birch: 'White Sentinel', giant: 'World Tree', shroom: 'Spore Titan', tower: 'Fungal Spire', palm: 'Sky Palm', lollipop: 'Candy Colossus', umbrella: 'Parasol Ancient', acacia: 'Lone Acacia', deadtree: 'Bone Tree', lanterntree: 'Lantern Elder', crystal: 'Singing Spire' };
      try { this.world.addPOI?.({ kind: 'wonder', name: names[m.sp.id] || 'Ancient Tree', pos, radius: 40 + m.height * 2, data: { flora: m.sp.id } }); } catch (_) { /* ui optional */ }
    }
  }

  _stream(camLocal, alt) {
    const R = this.R;
    const dl = camLocal.length() || 1;
    const dx = camLocal.x / dl, dy = camLocal.y / dl, dz = camLocal.z / dl;
    for (const b of this.bands) {
      if (!b.enabled) continue;
      const active = alt < b.maxAlt;
      // wanted set
      if (active) {
        const ang = b.radius / R;
        b._want = b._want || new Set();
        b._want.clear();
        const list = this._tmpList || (this._tmpList = []);
        list.length = 0;
        forEachCellInCap(b.L, dx, dy, dz, ang, (f, i, j, cx, cy, cz, a) => {
          const key = cellKey(b.L, f, i, j) * 8 + b.idx;
          b._want.add(key);
          if (!b.cells.has(key) && !this.pending.has(key)) list.push({ key, f, i, j, a, cx, cy, cz });
        });
        list.sort((p, q) => p.a - q.a);
        for (const c of list) {
          const job = { key: c.key, band: b, dir: [c.cx, c.cy, c.cz], ang: c.a, msg: b.kind === 'grass'
            ? { kind: 'grass', cell: { L: b.L, f: c.f, i: c.i, j: c.j } }
            : { kind: 'layer', layer: b.layer, cell: { L: b.L, f: c.f, i: c.i, j: c.j }, opt: b.opt || {} } };
          this.pending.set(c.key, job);
          this.queue.push(job);
        }
      }
      // evict (hysteresis)
      const keepAng = (b.radius * 1.2 + 200) / R;
      const cosK = Math.cos(Math.min(Math.PI, keepAng));
      for (const [k, c] of b.cells) {
        const d = c.dir;
        if (!active || d[0] * dx + d[1] * dy + d[2] * dz < cosK) { this._dropCell(c); b.cells.delete(k); b.dirty = true; }
      }
    }
    // prioritise queue: nearest first across bands (grass & canopy first)
    if (this.queue.length > 1) {
      const pri = { grass: 0, under: 1, canopy: 1.5, rock: 2, far: 3 };
      this.queue.sort((a, b) => (pri[a.band.name] + a.ang * R / 400) - (pri[b.band.name] + b.ang * R / 400));
    }
    // drop jobs whose band no longer wants them
    this.queue = this.queue.filter((j) => { const ok = j.band._want?.has(j.key) && alt < j.band.maxAlt; if (!ok) this.pending.delete(j.key); return ok; });
    this._dispatch();
  }

  _dispatch() {
    const alive = this.workers.filter((w) => !w.dead);
    if (alive.length) {
      for (const w of alive) {
        const cap = this.shot ? 6 : 3;
        while (w.busy < cap && this.queue.length) {
          const job = this.queue.shift();
          const id = this.jobId++;
          this.jobs.set(id, job);
          w.busy++;
          w.w.postMessage({ type: 'job', id, job: job.msg });
        }
      }
    } else {
      // main-thread fallback, time-sliced
      const t0 = performance.now();
      while (this.queue.length && performance.now() - t0 < (this.shot ? 200 : 4)) {
        const job = this.queue.shift();
        this.pending.delete(job.key);
        let res = null;
        try { res = runJob(this.surface, this.table, job.msg); } catch (e) { console.warn('[flora] job failed', e); }
        this._accept(job, res);
      }
    }
  }

  _dropCell(c) {
    if (c.colliders) { this._removeColliders(c.colliders); c.colliders = null; }
  }

  // ================================================================== colliders
  _cellColliders(c) {
    if (c.colliders || !this.world.addCollider) return;
    const r = c.res, out = [];
    for (let i = 0; i < r.n; i++) {
      const o = i * STRIDE;
      const m = this.models[r.model[i]];
      if (!m) continue;
      const s = r.inst[o + 3];
      const pos = new THREE.Vector3(r.anchor[0] + r.inst[o], r.anchor[1] + r.inst[o + 1], r.anchor[2] + r.inst[o + 2]);
      if (m.layer === 'rock') {
        const rad = (m.radius * 0.55 + m.height * 0.45) * s * 0.8;
        if (rad < 0.45) continue;
        const up = _v.copy(pos).normalize();
        pos.addScaledVector(up, rad * 0.35);
        out.push({ type: 'sphere', pos, radius: rad, tag: 'rock' });
      } else if (m.colR) {
        out.push({ type: 'capsule', pos, radius: Math.max(0.15, m.colR * s), height: m.colH * s, tag: 'tree' });
      }
    }
    for (const col of out) this.world.addCollider(col);
    c.colliders = out;
  }
  _removeColliders(list) {
    const all = this.world.colliders;
    if (!Array.isArray(all) || !list.length) return;
    const set = new Set(list);
    // single pass filter keeps the array identity (other systems hold the reference)
    let w = 0;
    for (let i = 0; i < all.length; i++) { const c = all[i]; if (!set.has(c)) all[w++] = c; }
    all.length = w;
  }
  _updateColliders(camLocal) {
    const lim = 260;
    for (const name of ['canopy', 'rock']) {
      const b = this.bands.find((x) => x.name === name);
      if (!b) continue;
      for (const c of b.cells.values()) {
        const d = _v.set(c.res.anchor[0], c.res.anchor[1], c.res.anchor[2]).distanceTo(camLocal);
        if (d < lim && !c.colliders) this._cellColliders(c);
        else if (d > lim * 1.6 && c.colliders) { this._removeColliders(c.colliders); c.colliders = null; }
      }
    }
  }

  // ================================================================== layer rebuilds
  _rebuildBand(b, camLocal) {
    const cx = camLocal.x, cy = camLocal.y, cz = camLocal.z;
    const D = this.D;
    if (b.name === 'grass') {
      const G = this.grass;
      G.dense.begin(cx, cy, cz); G.sparse.begin(cx, cy, cz);
      for (const m of this.bandLayers.flower) { m.L0.begin(cx, cy, cz); m.L1.begin(cx, cy, cz); }
      const nr2 = G.nearR * G.nearR, fl0 = (D.f0[1] + 3) ** 2, fl1 = (D.f0[0] - 3) ** 2;
      for (const c of b.cells.values()) {
        const r = c.res, A = r.anchor, I = r.inst;
        for (let i = 0; i < r.n; i++) {
          const o = i * STRIDE;
          const px = A[0] + I[o], py = A[1] + I[o + 1], pz = A[2] + I[o + 2];
          const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
          if (d2 < nr2) G.dense.push(px, py, pz, I[o + 4], I[o + 5], I[o + 6], I[o + 7], I[o + 3], I[o + 8], I[o + 9], I[o + 10], I[o + 11]);
          if (d2 > 100) {
            // distance thinning: fewer, larger patches far away (keeps the silhouette, cuts triangles)
            const keep = d2 < 484 ? 1 : Math.max(0.28, Math.pow(484 / d2, 0.65));
            if (I[o + 8] < keep) G.sparse.push(px, py, pz, I[o + 4], I[o + 5], I[o + 6], I[o + 7], I[o + 3] / Math.sqrt(keep), I[o + 8], I[o + 9], I[o + 10], I[o + 11]);
          }
        }
        const F = r.finst;
        if (F) for (let i = 0; i < r.fn; i++) {
          const o = i * STRIDE;
          const m = this.models[r.fmodel[i]];
          if (!m) continue;
          const px = A[0] + F[o], py = A[1] + F[o + 1], pz = A[2] + F[o + 2];
          const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
          if (d2 < fl0) m.L0.push(px, py, pz, F[o + 4], F[o + 5], F[o + 6], F[o + 7], F[o + 3], F[o + 8], F[o + 9], F[o + 10], F[o + 11]);
          if (d2 > fl1) m.L1.push(px, py, pz, F[o + 4], F[o + 5], F[o + 6], F[o + 7], F[o + 3], F[o + 8], F[o + 9], F[o + 10], F[o + 11]);
        }
      }
      G.dense.end(1); G.sparse.end(1);
      for (const m of this.bandLayers.flower) { m.L0.end(1.5); m.L1.end(1.5); }
      return;
    }
    if (b.name === 'far') {
      const L = this.imp.far;
      L.begin(cx, cy, cz);
      for (const c of b.cells.values()) {
        const r = c.res, A = r.anchor, I = r.inst;
        for (let i = 0; i < r.n; i++) {
          const o = i * STRIDE;
          const m = this.models[r.model[i]];
          if (!m || m.imp < 0) continue;
          L.push(A[0] + I[o], A[1] + I[o + 1], A[2] + I[o + 2], I[o + 4], I[o + 5], I[o + 6], I[o + 7], I[o + 3], I[o + 8], I[o + 9], I[o + 10], m.imp);
        }
      }
      L.end(60);
      return;
    }
    const list = this.bandLayers[b.name];
    const near = b.name === 'canopy' ? D.c0 : b.name === 'under' ? D.u0 : D.r0;
    const mid = b.name === 'canopy' ? D.c1 : null;
    const margin = b.step + 2;
    const l0max = (near[1] + margin) ** 2, l1min = Math.max(0, near[0] - margin) ** 2;
    const l1max = mid ? (mid[1] + margin) ** 2 : Infinity, impMin = mid ? Math.max(0, near[0] - margin) ** 2 : Infinity;
    // understory LOD1: CPU-side rank thinning matching the shader's rvThin (fewer far instances)
    const thinRef2 = b.name === 'under' ? (D.u0[1] * 1.3) ** 2 : 0;
    for (const m of list) { m.L0.begin(cx, cy, cz); m.L1.begin(cx, cy, cz); }
    const imp = b.name === 'canopy' && this.imp ? this.imp.near : null;
    if (imp) imp.begin(cx, cy, cz);
    for (const c of b.cells.values()) {
      const r = c.res, A = r.anchor, I = r.inst;
      for (let i = 0; i < r.n; i++) {
        const o = i * STRIDE;
        const m = this.models[r.model[i]];
        if (!m || !m.L0) continue;
        const px = A[0] + I[o], py = A[1] + I[o + 1], pz = A[2] + I[o + 2];
        const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
        if (d2 < l0max) m.L0.push(px, py, pz, I[o + 4], I[o + 5], I[o + 6], I[o + 7], I[o + 3], I[o + 8], I[o + 9], I[o + 10], I[o + 11]);
        if (d2 > l1min && d2 < l1max && (!thinRef2 || d2 < thinRef2 || I[o + 9] < Math.max(0.2, Math.pow(thinRef2 / d2, 0.45)) + 0.08)) m.L1.push(px, py, pz, I[o + 4], I[o + 5], I[o + 6], I[o + 7], I[o + 3], I[o + 8], I[o + 9], I[o + 10], I[o + 11]);
        if (imp && d2 > impMin && m.imp >= 0) imp.push(px, py, pz, I[o + 4], I[o + 5], I[o + 6], I[o + 7], I[o + 3], I[o + 8], I[o + 9], I[o + 10], m.imp);
      }
    }
    const pad = b.name === 'canopy' ? 2.6 : 2;
    for (const m of list) { m.L0.end(pad); m.L1.end(pad); }
    if (imp) imp.end(pad);
  }

  // ================================================================== frame
  update(dt) {
    const cam = this.world.camera;
    if (!cam) return;
    _cam.copy(cam.position); // planet-local (camera is a child of root)
    const alt = _cam.length() - this.R - (this.surface.height ? 0 : 0);
    const altG = this._groundAlt(alt);
    this._streamT = (this._streamT || 0) + dt;
    if (this._streamT > (this.shot ? 0 : 0.2) || !this._streamed) {
      this._streamT = 0; this._streamed = true;
      this._stream(_cam, altG);
    } else if (this.queue.length) this._dispatch();
    // player push for grass
    const pp = this.world.controller?.pos || this.world.player?.pos;
    const org = this.world.origin;
    if (pp && org) this.pushU.value.set(pp.x - org.x, pp.y - org.y, pp.z - org.z, this.world.controller && this.world.controller !== this.world.player ? 2.6 : 1.1);
    // rebuild (one band per frame, round robin by need)
    let done = 0;
    for (const b of this.bands) {
      if (!b.enabled) continue;
      const moved = b.last.distanceToSquared(_cam) > b.step * b.step;
      if (b.dirty || moved) {
        if (done > 0 && !this.shot) continue;
        b.dirty = false; b.last.copy(_cam);
        try { this._rebuildBand(b, _cam); } catch (e) { console.warn('[flora] rebuild failed', b.name, e); }
        done++;
      }
    }
    const now = performance.now();
    if (!(now - (this._colT || 0) < 500)) { this._colT = now; this._updateColliders(_cam); }
    if (!this.ready) { this.ready = this._checkReady(altG); if (this.ready) this.readyMs = Math.round(now - this.t0); }
    // deterministic captures: don't pay for rendering half-streamed vegetation
    if (this.shot) this.group.visible = this.visible && this.ready;
  }

  _groundAlt(alt) {
    this._gT = (this._gT || 0) + 1;
    if (this._gA === undefined || this._gT > 15) {
      this._gT = 0;
      const p = this.world.camera.position, l = p.length() || 1;
      try { this._gH = this.surface.heightLod ? this.surface.heightLod(p.x / l, p.y / l, p.z / l, 4) : this.surface.height(p.x / l, p.y / l, p.z / l); } catch (_) { this._gH = 0; }
      this._gA = 1;
    }
    return alt - Math.max(this._gH || 0, this.table.hasSea ? this.table.sea : -1e9);
  }

  _checkReady(alt) {
    if (performance.now() - this.t0 > (this.shot ? 120000 : 20000)) return true;
    if (this.queue.length || this.jobs.size || this.pending.size) return false;
    if (this.workers.length && !this.workers.some((w) => w.ok || w.dead)) return false;
    for (const b of this.bands) if (b.enabled && b.dirty && alt < b.maxAlt) return false;
    return true;
  }

  isReady() { return this.ready; }

  setVisible(v) { this.visible = !!v; this.group.visible = this.visible; }

  densityAt(dir) {
    try {
      const s = this.surface.sample(dir.x, dir.y, dir.z, {}, false);
      return clamp(this.S.canopy.cover[s.biome] || 0, 0, 1);
    } catch (_) { return 0; }
  }

  getState() {
    let inst = 0, draws = 0, tris = 0;
    const top = [];
    for (const L of this.layers) if (L.mesh.visible && L.count) {
      inst += L.count; draws++;
      const ic = L.geometry.index ? L.geometry.index.count : 0;
      tris += (ic / 3) * L.count;
      top.push([L.name, L.count, Math.round((ic / 3) * L.count / 1000)]);
    }
    top.sort((a, b) => b[2] - a[2]);
    const cells = {};
    for (const b of this.bands) cells[b.name] = `${b.cells.size}/${b.jobs || 0}j/${Math.round(b.ms || 0)}ms`;
    return {
      style: this.styleKey, ready: this.ready, readyMs: this.readyMs, initMs: this.initMs, cells, queue: this.queue.length, jobs: this.jobs.size,
      instances: inst, drawCalls: draws, trisM: +(tris / 1e6).toFixed(2), models: this.models.length,
      workers: this.workers.length, colliders: this.world.colliders?.length ?? 0, top: top.slice(0, 8).map((t) => t.join(':')).join(' '),
    };
  }

  dispose() {
    for (const w of this.workers) { try { w.w.terminate(); } catch (_) {} }
    this.workers.length = 0;
    for (const b of this.bands || []) for (const c of b.cells.values()) this._dropCell(c);
    for (const L of this.layers) { L.dispose(); L.material?.dispose?.(); L.depthMaterial?.dispose?.(); }
    for (const m of this.models) { m.geo0?.dispose(); m.geo1?.dispose(); }
    this.grass?.geoD?.dispose(); this.grass?.geoS?.dispose();
    this.impQuad?.dispose();
    this.impBake?.albedo.dispose(); this.impBake?.normal.dispose();
    this.atlas?.texture?.dispose(); this.bark?.dispose(); this.rockTex?.dispose();
    this.group.removeFromParent();
  }
}

export default {
  name: 'flora',
  order: 30,
  async create(world) {
    if (!world.surface || world.body?.isGas) return { isReady: () => true, getState: () => ({ off: true }) };
    const f = new Flora(world);
    await f.init();
    return f;
  },
};
