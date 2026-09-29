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
import { FloraShared, makePlantMaterials, makeRockMaterials, FLORA_DITHER } from './materials.js';
import { G as GU } from '../../core/Uniforms.js';
import { makeLeafAtlas, makeBarkTexture, makeRockTexture } from './textures.js';
import { buildStyle } from './styles.js';
import { flowerPatch } from './geom/plants.js';
import { makeRock } from './geom/rocks.js';
import { STRIDE, runJob } from './placement.js';
import { makeGrassPatch, makeGrassMaterial, makeSwardDecal, makeSwardMaterial } from './grass.js';
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
    this.clears = [];               // [dx,dy,dz,cosR,keep,angR,source] clearings (civ, landings, clearAround)
    this.clearSig = '';
    this.flatGen = 0;               // bumps when flatten stamps change (stale worker jobs are dropped)
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
    // temporal dither index: follows the TAA sub-frame (shot stills render N jittered sub-frames in
    // one engine frame) so dithered crossfades / leaf edges average out instead of freezing
    const pipe = this.engine?.pipeline;
    const obr = () => {
      const taa = pipe?.stats?.taa && pipe.taa;
      FLORA_DITHER.frame.value = taa ? taa.index : (GU.uFrame?.value || 0);
      FLORA_DITHER.amt.value = taa ? 0.3 : 0;
    };
    for (const L of this.layers) L.mesh.onBeforeRender = obr;
    // debug: ?floradbg=nocast (no flora shadow casters) | noreceive (flora ignores shadows)
    let dbg = '';
    try { dbg = new URL(window.location.href).searchParams.get('floradbg') || ''; } catch (_) { /* no window */ }
    if (dbg.includes('nocast')) for (const L of this.layers) L.mesh.castShadow = false;
    if (dbg.includes('noreceive')) for (const L of this.layers) L.mesh.receiveShadow = false;
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
        const P = { rect: F.rect, colA: F.colA, colB: F.colB, type: F.type, height: F.height ?? 0.42, radius: 0.35, headSize: F.type === 'daisy' ? 0.058 : 0.09, count: F.type === 'daisy' ? 7 : 5, stem: [0.05, 0.1, 0.03] };
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

  _plantMat(m, lod, fade, thin, dfade) {
    const sp = m.sp, S = this.S;
    const p = makePlantMaterials({ dfade,
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
      c0: [55 * dd, 70 * dd], c1: [140 * dd, 180 * dd], cI: [680 * dd, 800 * dd], cS: [30, 38],
      u0: [20 * dd, 28 * dd], uR: 150 * dd * Math.sqrt(this.density),
      r0: [45 * dd, 60 * dd], rR: 560 * dd,
      f0: [14, 20], fR: 48 * Math.sqrt(this.density),
    };
    for (const m of this.models) {
      if (m.layer === 'canopy') {
        const f0 = [0, 0, D.c0[0], D.c0[1]], f1 = [D.c0[0], D.c0[1], D.c1[0], D.c1[1]];
        m.L0 = add(m, 0, m.geo0, this._plantMat(m, 0, f0, null, [0, 0, D.cS[0], D.cS[1]]), { cap: 256, cast: true, fade: f0 });
        m.L1 = add(m, 1, m.geo1, this._plantMat(m, 1, f1, null), { cap: 1024, cast: false, fade: f1 });
        this.bandLayers.canopy.push(m);
      } else if (m.layer === 'under' || m.layer === 'flower') {
        const near = m.layer === 'flower' ? D.f0 : D.u0, R = m.layer === 'flower' ? D.fR : D.uR;
        const f0 = [0, 0, near[0], near[1]], f1 = [near[0], near[1], R * 0.8, R];
        const thin = [near[1] * 1.3, 0.9, 0.2, 1];
        m.L0 = add(m, 0, m.geo0, this._plantMat(m, 0, f0, null, [0, 0, 16, 22]), { cap: 512, cast: m.layer === 'under' && m.height > 1.0, fade: f0 });
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
        const matN = makeImpostorMaterials(bk, { fade: fN, dfade: [D.cS[0], D.cS[1], D.cI[0], D.cI[1]], transl: S.translucency ?? 0.9, glow: 1 });
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
    // near-field grass keeps most of its density on reduced profiles (it is what the eye reads);
    // the patch count scales gently and the disc radius follows the spacing so patches overlap
    const spacing = 0.8 / Math.pow(clamp(dens, 0.3, 1.3), 0.4);
    this.table.grass = {
      cover: Array.from(G.cover || new Float32Array(14)), spacing,
      dryAmount: G.dryAmount ?? 0.2, flowerAmt: 0.3, flowers: this.flowerList, flowerWsum: this.flowerList.reduce((a, f) => a + f.freq, 0),
    };
    if (!anyGrass) return;
    const R = this.grassR = (low ? 28 : 44) * Math.sqrt(clamp(this.density, 0.3, 1.5));
    const hgt = G.height ?? 0.55;
    const pR = spacing * 0.8;
    const common = {
      base: G.base, tip: G.tip, dry: G.dry, glowTip: G.glowTip, glowAmt: 1.6, push: this.pushU,
      height: hgt * 0.66, patchR: pR, transl: 0.9, stiff: 1,
    };
    // tall blades (Bézier strips) over a turf carpet of short single-triangle blades
    const dense = makeGrassPatch(low ? 36 : 64, low ? 3 : 4, 11, low ? 70 : 150);
    const sparse = makeGrassPatch(low ? 16 : 28, 3, 23, low ? 24 : 56);
    const far = makeGrassPatch(low ? 12 : 22, 2, 37, low ? 12 : 24);
    const nearF = low ? [6, 9] : [8, 11.5];
    const midF = low ? [12, 15] : [17, 21];
    const mD = makeGrassMaterial({ ...common, fade: [0, 0, nearF[0], nearF[1]], keep: [1e6, 1, 1, 1], width: 0.029, widenK: 0.012, density: 1 });
    const mS = makeGrassMaterial({ ...common, fade: [nearF[0], nearF[1], midF[0], midF[1]], keep: [1e6, 1, 1, 1], width: 0.045, widenK: 0.018, patchR: pR * 1.05, density: 1 });
    const mF = makeGrassMaterial({ ...common, fade: [midF[0], midF[1], R * 0.72, R], keep: [1e6, 1, 1, 1], width: 0.06, widenK: 0.018, patchR: pR * 1.05, density: 1 });
    const LD = new InstanceLayer(dense, mD.material, null, { capacity: 2048, parent: this.group, castShadow: false, name: 'flora-grass-dense', boundsPad: 2 });
    const LS = new InstanceLayer(sparse, mS.material, null, { capacity: 4096, parent: this.group, castShadow: false, name: 'flora-grass-mid', boundsPad: 2 });
    const LF = new InstanceLayer(far, mF.material, null, { capacity: 8192, parent: this.group, castShadow: false, name: 'flora-grass-far', boundsPad: 3 });
    LD.uniforms = mD.uniforms; LS.uniforms = mS.uniforms; LF.uniforms = mF.uniforms;
    this.layers.push(LD, LS, LF);
    // sward shade: dark ground between the stems under near grass (see grass.js makeSwardDecal)
    const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    const mid = mix(G.base, G.tip, 0.4);
    const mx = Math.max(1e-3, ...mid);
    const shade = mix([0.55, 0.55, 0.55], mid.map((v) => (0.62 * v) / mx), 0.5);
    const swFar = midF[1] + 2;
    const decal = makeSwardDecal(low ? 8 : 12);
    let swDbg = false;
    try { swDbg = (new URL(window.location.href).searchParams.get('floradbg') || '').includes('sward'); } catch (_) { /* no window */ }
    const mW = makeSwardMaterial({ fade: [0, 0, swFar * 0.6, swFar], patchR: pR, size: 1.45, shade: swDbg ? [1, 0.02, 0.02] : shade, strength: G.shadeAmt ?? 0.9 });
    const LW = new InstanceLayer(decal, mW.material, null, { capacity: 4096, parent: this.group, castShadow: false, receiveShadow: false, name: 'flora-sward', boundsPad: 2 });
    LW.uniforms = mW.uniforms;
    if (swDbg) { try { if (new URL(window.location.href).searchParams.get('floradbg').includes('nodepth')) mW.material.depthTest = false; } catch (_) { /* ignore */ } }
    this.layers.push(LW);
    this.grass = {
      dense: LD, sparse: LS, far: LF, sward: LW, swardMax2: (swFar + 2) ** 2, geoW: decal, nearR: nearF[1] + 1.5, farMin2: Math.max(0, nearF[0] - 2) ** 2,
      midMax2: (midF[1] + 3) ** 2, far0: Math.max(0, midF[0] - 3) ** 2, geoD: dense, geoS: sparse, geoF: far,
    };
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
    // terrain flatten stamps (civ plazas, pads): keep worker surfaces in sync, re-place nearby cells
    try {
      const fl = this.surface.flats || this.surface.gen?.flats;
      if (fl?.length) this._sendFlats(fl);
      this._offFlat = this.surface.onFlattenChange?.((f, all) => this._onFlatten(f, all));
    } catch (e) { console.warn('[flora] flatten hook failed', e); }
    try { this._offClear = this.world.events?.on?.('civ:clearings', () => this._refreshClears(true)); } catch (_) { /* optional */ }
  }

  _sendFlats(all) {
    const flats = (all || []).map((f) => ({ id: f.id, x: f.x, y: f.y, z: f.z, radius: f.radius, falloff: f.falloff, height: f.height }));
    for (const w of this.workers) if (!w.dead) { try { w.w.postMessage({ type: 'flats', flats }); } catch (_) { /* ignore */ } }
  }

  _onFlatten(f, all) {
    this.flatGen++;
    this._sendFlats(all);
    if (!f || !this.bands) return;
    // drop cells overlapping the stamp so they are re-placed on the graded ground
    const ang = (f.radius + f.falloff) / this.R;
    for (const b of this.bands) {
      const cellAng = (Math.PI / 2) / (1 << b.L) * 0.8 + ang;
      const cosA = Math.cos(Math.min(Math.PI, cellAng));
      for (const [k, c] of b.cells) {
        const d = c.dir;
        if (d[0] * f.x + d[1] * f.y + d[2] * f.z > cosA) { this._dropCell(c); b.cells.delete(k); b.dirty = true; }
      }
    }
  }

  // ================================================================== clearings
  /**
   * Public: cull vegetation in a disc around a planet-local position (e.g. a parked starship).
   * keep = fraction of instances kept (0 = bare). Returns an id for removeClear().
   */
  clearAround(pos, radius, keep = 0) {
    if (!pos || !(radius > 0)) return 0;
    const l = Math.hypot(pos.x, pos.y, pos.z) || 1;
    this._dynClears = this._dynClears || [];
    const id = (this._clearId = (this._clearId || 0) + 1);
    this._dynClears.push({ id, c: [pos.x / l, pos.y / l, pos.z / l, Math.cos(radius / this.R), keep] });
    this._refreshClears(true);
    return id;
  }
  removeClear(id) {
    if (!this._dynClears) return;
    const n = this._dynClears.length;
    this._dynClears = this._dynClears.filter((d) => d.id !== id);
    if (this._dynClears.length !== n) this._refreshClears(true, true);
  }

  /** gather clearings from civ, 'landing' POIs and clearAround(); re-filter cells when they change */
  _refreshClears(force = false, removed = false) {
    const list = [];
    try {
      const C = this.world.civ?.clearings || this.world.get?.('civ')?.clearings;
      if (Array.isArray(C)) for (const c of C) if (c && c.length >= 4) list.push([c[0], c[1], c[2], c[3], c[4] ?? 0]);
    } catch (_) { /* civ optional */ }
    try {
      const P = this.world.pois;
      if (Array.isArray(P)) for (const p of P) {
        if (p?.kind !== 'landing' || !p.pos) continue;
        const l = Math.hypot(p.pos.x, p.pos.y, p.pos.z) || 1;
        list.push([p.pos.x / l, p.pos.y / l, p.pos.z / l, Math.cos(Math.max(8, p.radius || 12) / this.R), 0]);
      }
    } catch (_) { /* ignore */ }
    if (this._dynClears) for (const d of this._dynClears) list.push(d.c);
    let sig = '' + list.length;
    for (const c of list) sig += '|' + c[0].toFixed(5) + ',' + c[2].toFixed(5) + ',' + c[3].toFixed(9) + ',' + c[4];
    if (sig === this.clearSig && !force) return;
    const grew = sig !== this.clearSig;
    this.clearSig = sig;
    this.clears = list.map((c) => [c[0], c[1], c[2], c[3], c[4], Math.acos(Math.max(-1, Math.min(1, c[3])))]);
    if (!this.bands) return;
    if (removed) {
      // a clearing went away: re-place affected cells from scratch (instances were compacted out)
      for (const b of this.bands) { for (const c of b.cells.values()) this._dropCell(c); b.cells.clear(); b.dirty = true; }
      return;
    }
    if (!grew) return;
    for (const b of this.bands) {
      for (const c of b.cells.values()) {
        if (this._filterCell(c)) {
          if (c.colliders) { this._removeColliders(c.colliders); c.colliders = null; }
          b.dirty = true;
        }
      }
    }
  }

  /** compact a cell's instances against the clearings; returns true if anything was removed */
  _filterCell(c) {
    const C = this.clears;
    if (!C.length || !c.res) return false;
    const b = c.band, d = c.dir;
    const cellAng = (Math.PI / 2) / (1 << b.L) * 0.8;
    let rel = null;
    for (const q of C) {
      if (d[0] * q[0] + d[1] * q[1] + d[2] * q[2] > Math.cos(Math.min(Math.PI, q[5] + cellAng))) (rel || (rel = [])).push(q);
    }
    if (!rel) return false;
    const r = c.res, A = r.anchor;
    const run = (I, M, n) => {
      let w = 0;
      for (let i = 0; i < n; i++) {
        const o = i * STRIDE;
        const px = A[0] + I[o], py = A[1] + I[o + 1], pz = A[2] + I[o + 2];
        const il = 1 / (Math.hypot(px, py, pz) || 1);
        let keep = true;
        for (const q of rel) {
          if ((px * q[0] + py * q[1] + pz * q[2]) * il > q[3] && I[o + 8] >= q[4]) { keep = false; break; }
        }
        if (!keep) continue;
        if (w !== i) { I.copyWithin(w * STRIDE, o, o + STRIDE); if (M) M[w] = M[i]; }
        w++;
      }
      return w;
    };
    const n0 = r.n, f0 = r.fn || 0;
    r.n = run(r.inst, r.model, r.n);
    if (r.finst) r.fn = run(r.finst, r.fmodel, r.fn || 0);
    return r.n !== n0 || (r.fn || 0) !== f0;
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
    if (j.gen !== undefined && j.gen !== this.flatGen) { b.dirty = true; return; } // terrain changed meanwhile: re-request
    if (!res) res = { n: 0, anchor: [0, 0, 0], inst: new Float32Array(0), model: new Uint16Array(0) };
    const c = { key: j.key, band: b, res, dir: j.dir, colliders: null };
    if (this.clears.length) this._filterCell(c);
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
      // unique, deterministic names ("Elder Oak of Varneth") so markers/toasts never repeat
      const syl = ['va', 'mor', 'eth', 'lin', 'ka', 'sul', 'or', 'wen', 'dra', 'thi', 'bel', 'ny', 'ros', 'cai', 'um', 'fal'];
      let hsh = (hashCombine(this.seed, key) >>> 0);
      let nm = '';
      for (let q = 0; q < 2 + (hsh & 1); q++) { nm += syl[(hsh >>> (q * 4 + 1)) & 15]; }
      nm = nm.charAt(0).toUpperCase() + nm.slice(1);
      const title = `${names[m.sp.id] || 'Ancient Tree'} of ${nm}`;
      try { this.world.addPOI?.({ kind: 'wonder', name: title, pos, radius: 40 + m.height * 2, minor: true, data: { flora: m.sp.id } }); } catch (_) { /* ui optional */ }
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
          const job = { key: c.key, band: b, dir: [c.cx, c.cy, c.cz], ang: c.a, gen: this.flatGen, msg: b.kind === 'grass'
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
      const cl = camLocal.length();
      for (const c of b.cells.values()) {
        // anchors sit on the base sphere (radius R): compare at the camera's radius so high
        // terrain (anchor hundreds of metres below the ground) still registers nearby colliders
        _v.set(c.res.anchor[0], c.res.anchor[1], c.res.anchor[2]);
        const d = _v.multiplyScalar(cl / (_v.length() || 1)).distanceTo(camLocal);
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
      G.dense.begin(cx, cy, cz); G.sparse.begin(cx, cy, cz); G.far.begin(cx, cy, cz); G.sward.begin(cx, cy, cz);
      for (const m of this.bandLayers.flower) { m.L0.begin(cx, cy, cz); m.L1.begin(cx, cy, cz); }
      const nr2 = G.nearR * G.nearR, fl0 = (D.f0[1] + 3) ** 2, fl1 = (D.f0[0] - 3) ** 2;
      for (const c of b.cells.values()) {
        const r = c.res, A = r.anchor, I = r.inst;
        for (let i = 0; i < r.n; i++) {
          const o = i * STRIDE;
          const px = A[0] + I[o], py = A[1] + I[o + 1], pz = A[2] + I[o + 2];
          const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
          if (d2 < nr2) G.dense.push(px, py, pz, I[o + 4], I[o + 5], I[o + 6], I[o + 7], I[o + 3], I[o + 8], I[o + 9], I[o + 10], I[o + 11]);
          if (d2 < G.swardMax2) G.sward.push(px, py, pz, I[o + 4], I[o + 5], I[o + 6], I[o + 7], I[o + 3], I[o + 8], I[o + 9], I[o + 10], I[o + 11]);
          if (d2 > G.farMin2) {
            // distance thinning: fewer, larger patches far away (keeps the silhouette, cuts triangles)
            const keep = d2 < 400 ? 1 : Math.max(0.22, Math.pow(400 / d2, 0.75));
            if (I[o + 8] < keep) {
              const sc = I[o + 3] / Math.sqrt(keep);
              if (d2 < G.midMax2) G.sparse.push(px, py, pz, I[o + 4], I[o + 5], I[o + 6], I[o + 7], sc, I[o + 8], I[o + 9], I[o + 10], I[o + 11]);
              if (d2 > G.far0) G.far.push(px, py, pz, I[o + 4], I[o + 5], I[o + 6], I[o + 7], sc, I[o + 8], I[o + 9], I[o + 10], I[o + 11]);
            }
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
      G.dense.end(1); G.sparse.end(1); G.far.end(1); G.sward.end(1.5);
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
    const l1max = mid ? (mid[1] + margin) ** 2 : Infinity, impMin = mid ? Math.max(0, D.cS[0] - margin) ** 2 : Infinity;
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
    if (!this._streamed) { try { this._refreshClears(); } catch (_) { /* ignore */ } }
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
    if (!(now - (this._colT || 0) < 500)) {
      this._colT = now;
      try { this._refreshClears(); } catch (e) { console.warn('[flora] clearings failed', e); }
      this._updateColliders(_cam);
    }
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
    try { this._offFlat?.(); } catch (_) { /* ignore */ }
    try { if (typeof this._offClear === 'function') this._offClear(); } catch (_) { /* ignore */ }
    for (const w of this.workers) { try { w.w.terminate(); } catch (_) {} }
    this.workers.length = 0;
    for (const b of this.bands || []) for (const c of b.cells.values()) this._dropCell(c);
    for (const L of this.layers) { L.dispose(); L.material?.dispose?.(); L.depthMaterial?.dispose?.(); }
    for (const m of this.models) { m.geo0?.dispose(); m.geo1?.dispose(); }
    this.grass?.geoD?.dispose(); this.grass?.geoS?.dispose(); this.grass?.geoF?.dispose(); this.grass?.geoW?.dispose();
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
