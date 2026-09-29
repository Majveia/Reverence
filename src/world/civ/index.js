// Civilization subsystem (order 35) — OWNED BY THE CIV TRACK. See docs/tracks/civ.md.
//
// body.civ { level 0-5, style, settlements, placeSeed } → sites (planner.js) → per-site layout
// (layout.js: roads, lots, props, walkers) → procedural architecture per style (styles.js + parts.js,
// merged by geo.js into one mesh per site, uber-shaded by material.js) + roads + night glow sprites +
// life (life.js: walkers, flying traffic, boats, space elevator) + colliders + POIs.
//
// Streaming: every site gets a cheap FAR representation (block massing + light cluster, visible from
// orbit at night). Sites near the camera are built in DETAIL, time-sliced across frames; far ones are
// dropped. isReady() waits for what the camera needs (deterministic captures).
import * as THREE from 'three';
import { RNG, hashCombine } from '../../core/rng.js';
import { dirToLatLon } from '../../core/math.js';
import { planSites, offsetDir } from './planner.js';
import { layoutSite, polyLen, along } from './layout.js';
import { Geo, mat, tint, PAT } from './geo.js';
import { makeCivMaterial, makeGlowMaterial } from './material.js';
import { getStyle, buildLamp, parts as P } from './styles.js';
import { makeNPCs, makeTraffic, makeBoats, makeElevator } from './life.js';
import { makePools } from './pools.js';
import { applyCivCam } from './camera.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _m = new THREE.Matrix4();
const _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3();
const MODERN = new Set(['neon', 'industrial', 'outpost', 'nasapunk', 'frontier', 'brutalist', 'spire', 'crystal', 'bizarre']);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class Civ {
  constructor(world) {
    this.world = world;
    this.body = world.body;
    this.S = world.surface;
    this.q = world.quality || {};
    const civ = this.body.civ || {};
    this.level = civ.level | 0;
    this.styleName = civ.style || 'village';
    this.root = new THREE.Group();
    this.root.name = 'civ';
    world.root.add(this.root);
    this.sites = [];
    this.jobs = [];
    this.stats = { built: 0, tris: 0, trisBuilt: 0, draw: 0, ms: 0, npcs: 0, traffic: 0, boats: 0, lotFails: 0, jobFails: 0, empty: 0, err: null };
    this.kits = new Map();
    this.glowMats = [];
    const qk = { low: 0.45, med: 0.7, high: 1, ultra: 1.25 }[this.q.tier] ?? 1;
    this.qk = qk;
    this.detailR = 3200 * (this.q.drawDistance ?? 1);
    this.dropR = this.detailR + 2500;
    this.farR = 90000;
    this.enabled = !!this.S && !this.body.isGas && (this.level > 0 || this.styleName === 'monolith');
    if (!this.enabled) return;
    const t0 = now();
    const plan = planSites(world);
    this.spawn = plan.spawn;
    for (const s of plan.sites) this._initSite(s);
    this._grade();
    this.stats.planMs = Math.round(now() - t0);
    // clearings for flora/fauna placement: [dirX, dirY, dirZ, cosAngularRadius, keepFraction]
    this.clearings = this.sites.map((s) => [s.up.x, s.up.y, s.up.z, Math.cos((s.radius * (s.hamlet ? 1.3 : 1.08)) / s.R), s.kind === 'ruin' || s.kind === 'monument' ? 0.5 : s.hamlet || s.kind === 'village' || s.kind === 'camp' ? 0.12 : this._kit(s.kit).style.pave ? 0.0 : 0.04]);
    const cap0 = this.sites[0];
    this.spawnTarget = cap0 ? cap0.pos.clone().addScaledVector(cap0.up, Math.min(40, cap0.radius * 0.1)) : null;
    try { world.civ = { clearings: this.clearings, sites: this.sites, spawnTarget: this.spawnTarget, capital: cap0 }; world.events?.emit?.('civ:clearings', { clearings: this.clearings }); } catch (_) { /* ignore */ }
    // capture framing presets (&civcam=plaza|street|hero|aerial|top|edge): writes the player's spawn params
    try { if (world.params?.civcam) applyCivCam(this, world.params); } catch (e) { console.warn('[civ] civcam failed', e); }
    this._debug = String(world.params?.civdbg || '');
    if (this._debug.includes('npcbig')) globalThis.__civNpcBig = true;
    // far LOD geometry + orbit lights for all sites (time-sliced, but required before ready)
    for (const s of this.sites) this.jobs.push({ site: s, kind: 'far', gen: this._buildFar(s) });
    this._roadsBetween();
  }

  // ------------------------------------------------------------------ setup
  _kit(name) {
    let k = this.kits.get(name);
    if (!k) {
      const style = getStyle(name);
      const rng = new RNG(hashCombine(this.body.civ?.placeSeed >>> 0, name.length * 977));
      const M = style.mats(this.body, rng);
      const look = style.look || {};
      const mainMat = makeCivMaterial(look, { key: '' });
      const roadMat = makeCivMaterial(look, { key: 'road', polygonOffset: true, reversed: !!this.world.engine?.reversedDepth });
      mainMat.userData.shared = true; roadMat.userData.shared = true;
      k = { name, style, M, mainMat, roadMat };
      this.world.lighting?.setupMaterial?.(mainMat);
      this.world.lighting?.setupMaterial?.(roadMat);
      this.kits.set(name, k);
    }
    return k;
  }

  _initSite(s) {
    const S = this.S;
    s.h0 = S.height(s.up.x, s.up.y, s.up.z);
    const sea = S.seaLevel > -1e8 ? S.seaLevel : -Infinity;
    if (s.h0 < sea + 3.5 && (s.style === 'neon' || s.style === 'harbor' || s.style === 'organic')) s.h0 = sea + 3.5;
    s.pos = s.up.clone().multiplyScalar(s.R + s.h0);
    s.kit = s.kind === 'ruin' ? 'ruins' : s.kind === 'camp' ? 'nomad' : this.styleName;
    s.detail = null; s.far = null; s.layout = null; s.building = false;
    const ll = dirToLatLon(s.up);
    s.lat = ll.lat; s.lon = ll.lon;
    const kind = s.capital || s.kind === 'metropolis' || s.kind === 'city' ? 'city' : s.kind === 'ruin' ? 'ruin' : s.kind === 'monument' ? 'monument' : 'village';
    try { this.world.addPOI({ kind, name: s.name, pos: s.pos.clone(), radius: s.radius, data: { style: s.kit, level: s.level, capital: !!s.capital, civ: this.body.civ?.name } }); } catch (_) { /* ignore */ }
    this.sites.push(s);
  }

  /**
   * Grade each settlement's civic heart into the terrain (terrain track flatten stamps): the plaza /
   * monument terrace becomes a level disc that blends into the hillside, so the town reads as built
   * on its land rather than floating on foundations. Stamps are added BEFORE any layout, so every
   * height civ samples afterwards (roads, lots, NPC paths) is already the graded one.
   */
  _grade() {
    const S = this.S;
    if (!S?.addFlatten) return;
    const sea = S.seaLevel > -1e8 ? S.seaLevel : -Infinity;
    this.flats = [];
    for (const s of this.sites) {
      const h = S.height(s.up.x, s.up.y, s.up.z);
      if (h < sea + 2) continue; // water cities stand on decks
      const r = s.kind === 'monument' ? 22 : s.hamlet ? 12 : ({ metropolis: 42, city: 32, town: 22, village: 13, camp: 13, ruin: 13 }[s.kind] ?? 16) + 4;
      try { const id = S.addFlatten({ dir: s.up, radius: r, height: h, falloff: Math.max(14, r * 0.9) }); if (id) this.flats.push(id); } catch (_) { /* optional */ }
      s.h0 = h;
      s.pos.copy(s.up).multiplyScalar(s.R + s.h0);
    }
  }

  _layout(s) {
    if (!s.layout) {
      const kit = this._kit(s.kit);
      const prof = { ...kit.style.profile };
      if (s.kind === 'monument') { prof.landmark = false; }
      s.layout = s.kind === 'monument' ? { roads: [], lots: [], props: [], paths: [], plaza: { x: 0, z: 0, r: 16, h: s.h0 }, ground: null, water: false }
        : layoutSite(s, this.S, prof, this.qk * ({ metropolis: 0.68, city: 0.85 }[s.kind] ?? 1));
      if (s.hamlet) this._hamletRoad(s);
    }
    return s.layout;
  }

  /** Building frame (mesh space, relative to the site origin) for a lot. */
  _frame(s, x, z, rot, h, out) {
    offsetDir(s, x, z, _Y);
    const p = _w.copy(_Y).multiplyScalar(s.R + h).sub(s.pos);
    _Z.copy(s.east).multiplyScalar(Math.sin(rot)).addScaledVector(s.north, Math.cos(rot));
    _Z.addScaledVector(_Y, -_Z.dot(_Y)).normalize();
    _X.crossVectors(_Y, _Z).normalize();
    return out.makeBasis(_X, _Y, _Z).setPosition(p);
  }

  // ------------------------------------------------------------------ far representation
  *_buildFar(s) {
    const L = this._layout(s);
    yield;
    const kit = this._kit(s.kit);
    const g = new Geo();
    const M = kit.M;
    const wallM = [M.wall, M.wallWin, M.wall2, M.brickWin, M.stoneWin].find((m) => m && (m.pat === PAT.WINDOWS || m.pat === PAT.GLASS || m.pat === PAT.ARCHWIN || m.pat === PAT.SLITS)) || M.wall || mat('#888');
    const roofM = M.roof || M.found;
    const lights = [];
    const rng = new RNG(s.seed ^ 0xfa7);
    const col = new THREE.Color(kit.style.look?.winCol ?? '#ffb467');
    for (const lot of L.lots) {
      const hgt = lot.farH ?? this._guessH(s, lot);
      const f = this._frame(s, lot.x, lot.z, lot.rot, lot.hMax, _m);
      g.begin(f, rng.next() * 100);
      g.windows(3, 3.4, 0);
      g.box(0, -(lot.hMax - lot.hMin) - 1, 0, lot.w * 0.9, hgt + (lot.hMax - lot.hMin) + 1, lot.d * 0.9, 0, wallM, { top: roofM });
      const nl = Math.min(4, 1 + Math.floor(hgt / 15));
      for (let i = 0; i < nl; i++) lights.push(this._pt(f, rng.range(-lot.w / 2, lot.w / 2), hgt * rng.range(0.2, 0.9), lot.d / 2 + 0.5, col, 3 + hgt * 0.05, 10 + hgt * 0.12, 3));
    }
    for (const p of L.props) if (p.type === 'lamp') { const f = this._frame(s, p.x, p.z, 0, p.h, _m); lights.push(this._pt(f, 0, 5, 0, col, 2.5, 8, 3)); }
    if (s.kind === 'monument' || s.capital) { const f = this._frame(s, 0, 0, 0, s.h0, _m); lights.push(this._pt(f, 0, 30, 0, new THREE.Color('#ffe0b0'), 6, 25, 3)); }
    // orbit glow: soft city-sized blobs so every settlement reads as a light cluster from space at night
    if (s.kind !== 'monument' && s.kind !== 'ruin') {
      const k = { metropolis: 3.2, city: 2.4, town: 1.6, village: 0.9, camp: 0.6 }[s.kind] ?? 1;
      const n = s.kind === 'metropolis' || s.kind === 'city' ? 7 : 3;
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2 + s.heading, rr = i === 0 ? 0 : s.radius * 0.55;
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        const f = this._frame(s, x, z, 0, (L.ground ? L.ground.g(x, z) : s.h0) + 20, _m);
        lights.push(this._pt(f, 0, 0, 0, col, 2.2 * k, s.radius * (i === 0 ? 1.4 : 0.9), 4));
      }
    }
    yield;
    const grp = new THREE.Group();
    grp.name = 'civ-far-' + s.id;
    grp.position.copy(s.pos);
    const geo = g.build();
    if (geo) {
      const mesh = new THREE.Mesh(geo, kit.mainMat);
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.userData.noCSM = false;
      grp.add(mesh);
    }
    const pts = this._points(lights.filter((l) => l.kind !== 4), 1);
    if (pts) { pts.material.uniforms.uFarFade.value.set(900, 1.2e6); grp.add(pts); }
    const blobs = this._points(lights.filter((l) => l.kind === 4), 1);
    if (blobs) { blobs.material.depthTest = false; blobs.material.uniforms.uFarFade.value.set(2500, 2e6); blobs.renderOrder = 6; grp.add(blobs); }
    s.far = grp;
    this.root.add(grp);
  }

  _guessH(s, lot) {
    const t = lot.type;
    if (t === 'tower') return this.styleName === 'neon' ? 90 : 35;
    if (t === 'landmark') return 30;
    if (t === 'spaceport') return 8;
    if (t === 'factory' || t === 'monolith') return 30;
    if (t === 'garden' || t === 'farm') return 3;
    return 7;
  }

  _pt(f, x, y, z, col, intensity, size, kind) {
    _v.set(x, y, z).applyMatrix4(f);
    this._ph = ((this._ph || 0) + 0.6180339887) % 1;
    return { x: _v.x, y: _v.y, z: _v.z, r: col.r * intensity, g: col.g * intensity, b: col.b * intensity, size, kind, phase: this._ph };
  }

  _points(lights, scale = 1) {
    const n = lights.length;
    if (!n) return null;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), kind = new Float32Array(n), ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const L = lights[i];
      pos[i * 3] = L.x; pos[i * 3 + 1] = L.y; pos[i * 3 + 2] = L.z;
      col[i * 3] = L.r; col[i * 3 + 1] = L.g; col[i * 3 + 2] = L.b;
      size[i] = L.size * scale; kind[i] = L.kind; ph[i] = L.phase;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    geo.computeBoundingSphere();
    const m = makeGlowMaterial();
    this.glowMats.push(m);
    const pts = new THREE.Points(geo, m);
    pts.frustumCulled = true;
    pts.renderOrder = 5;
    pts.name = 'civ-glow';
    pts.userData.noCSM = true;
    return pts;
  }

  // ------------------------------------------------------------------ detail build (generator)
  *_buildDetail(s) {
    const L = this._layout(s);
    const kit = this._kit(s.kit);
    const { M, style } = kit;
    const rng = new RNG(s.seed ^ 0xde7);
    const g = new Geo();
    g.segK = ({ metropolis: 0.5, city: 0.65, town: 0.85 }[s.kind] ?? 1) * (this.qk < 0.8 ? 0.75 : 1);
    const ctx = { M, rng, site: s, style: s.kit, level: s.level, kind: s.kind, neonM: M.neon };
    const sea = this.S.seaLevel > -1e8 ? this.S.seaLevel : -Infinity;
    // ---- buildings
    let k = 0;
    for (const lot of L.lots) {
      const floor = lot.hMax + 0.12;
      const f = this._frame(s, lot.x, lot.z, lot.rot, floor, _m);
      g.begin(f, rng.next() * 100);
      const drop = floor - lot.hMin;
      if (lot.water) {
        const terr = L.ground ? L.ground.h(lot.x, lot.z) : sea - 10;
        const depth = floor - Math.min(terr, sea - 2) + 1;
        if (style.waterBase) style.waterBase(g, lot, ctx, depth, floor - sea);
        else {
          g.box(0, -0.6, 0, lot.w + 1.6, 0.6, lot.d + 1.6, 0.05, M.found);
          for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) g.cyl(sx * lot.w * 0.42, -depth, sz * lot.d * 0.42, 0.7, 0.7, depth - 0.6, 8, false, M.found);
        }
      } else if (lot.type !== 'garden' && lot.type !== 'spaceport') {
        const round = style.roundTypes?.has(lot.type);
        const bat = Math.min(1.5, drop * 0.18);
        const fk = style.foundation;
        if ((fk === 'deck' || fk === 'stilts') && drop > (fk === 'deck' ? 0.35 : 1.2)) {
          // timber deck on posts (nomad camps, Hearthian cabins on stilts)
          const W2 = lot.w + (fk === 'deck' ? 1.4 : 0.6), D2 = lot.d + (fk === 'deck' ? 1.4 : 0.6);
          g.box(0, -0.3, 0, W2, 0.3, D2, 0.03, M.wood);
          const nx = Math.max(2, Math.round(W2 / 3)), nz = Math.max(2, Math.round(D2 / 3));
          for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
            if (i > 0 && i < nx - 1 && j > 0 && j < nz - 1) continue;
            const px = -W2 / 2 + 0.3 + (W2 - 0.6) * i / (nx - 1), pz = -D2 / 2 + 0.3 + (D2 - 0.6) * j / (nz - 1);
            g.cyl(px, -drop - 1.0, pz, 0.16, 0.14, drop + 0.75, 6, false, M.beam || M.wood);
          }
          if (fk === 'stilts') for (const sx of [-1, 1]) g.tube([new THREE.Vector3(sx * W2 / 2, -drop, -D2 / 2), new THREE.Vector3(-sx * W2 / 2, -0.35, -D2 / 2)], 0.07, 4, M.beam || M.wood);
        } else if (fk === 'none' || (fk === 'deck' && drop <= 0.35)) {
          // pitched straight on the ground
        } else if (round) {
          const r = Math.min(lot.w, lot.d) / 2 + 0.3;
          g.cyl(0, -drop - 1.2, 0, r + bat, r, drop + 1.25, 20, true, M.found);
        } else if (drop > 0.8) {
          // battered retaining terrace (wider at the base) + coping
          g.box(0, -drop - 1.2, 0, lot.w + 0.5 + bat * 2, drop * 0.5 + 1.2, lot.d + 0.5 + bat * 2, 0, M.found);
          g.box(0, -drop * 0.5, 0, lot.w + 0.5 + bat, drop * 0.5 + 0.05, lot.d + 0.5 + bat, 0, M.found);
          g.box(0, -0.12, 0, lot.w + 0.7 + bat, 0.2, lot.d + 0.7 + bat, 0.04, M.trim && M.trim.pat !== PAT.NEON ? M.trim : M.found);
        } else g.box(0, -drop - 1.2, 0, lot.w + 0.5, drop + 1.2 + 0.05, lot.d + 0.5, 0, M.found);
        if (drop > 1.2 && drop < 4.5 && !style.foundation) { // steps up to the door
          const n = Math.ceil(drop / 0.3);
          for (let i = 0; i < n; i++) g.box(0, -drop - 0.6, lot.d / 2 + 0.25 + (n - i) * 0.35, 1.6, i * 0.3 + 0.6, 0.36, 0, M.found);
        }
      }
      let h = 6;
      const t0 = g.tris;
      try { h = style.build(g, lot, ctx) ?? 6; } catch (e) {
        this.stats.lotFails++;
        if (!this.stats.err) this.stats.err = `${s.kit}/${lot.type}: ${e?.message || e}`;
        if (!this._warned) { console.warn('[civ] build failed', s.kit, lot.type, e); this._warned = true; }
      }
      lot.farH = h;
      if (globalThis.__civProf) { const P2 = globalThis.__civProf; P2[lot.type] = (P2[lot.type] || 0) + g.tris - t0; P2['#' + lot.type] = (P2['#' + lot.type] || 0) + 1; }
      if (++k % 6 === 0) yield;
    }
    if (globalThis.__civProf) globalThis.__civProf['@lots' + s.id] = g.tris;
    // ---- props: lamps, stalls, plaza centerpiece
    for (const p of L.props) {
      const f = this._frame(s, p.x, p.z, p.rot, p.h + 0.05, _m);
      g.begin(f, rng.next() * 100);
      if (p.type === 'lamp') buildLamp(g, style, M);
      else if (p.type === 'stall') P.stall(g, M, rng);
    }
    yield;
    if (globalThis.__civProf) globalThis.__civProf['@props' + s.id] = g.tris;
    if (style.profile?.powerLines && s.kind !== 'monument' && s.kind !== 'ruin') { this._powerLines(g, s, L, M, rng); yield; }
    if (globalThis.__civProf) globalThis.__civProf['@power' + s.id] = g.tris;
    if (L.wall) { this._wall(g, s, L, kit, rng); yield; }
    if (s.kind !== 'monument') this._plazaPiece(g, s, L, M, rng, ctx);
    else this._monument(g, s, M, rng, ctx);
    yield;
    // ---- roads & plaza surface
    const rg = new Geo();
    this._roads(rg, s, L, kit);
    yield;
    // ---- assemble
    const grp = new THREE.Group();
    grp.name = 'civ-site-' + s.id;
    grp.position.copy(s.pos);
    const geo = g.build();
    const life = { npcs: 0, traffic: 0, boats: 0 };
    if (geo) {
      const mesh = new THREE.Mesh(geo, kit.mainMat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = 'civ-buildings';
      grp.add(mesh);
    }
    const rgeo = rg.build();
    if (rgeo) {
      const rm = new THREE.Mesh(rgeo, kit.roadMat);
      rm.receiveShadow = true; rm.name = 'civ-roads';
      grp.add(rm);
    }
    const pts = this._points(g.lights, 1);
    if (pts) { pts.material.uniforms.uFarFade.value.set(0, this.dropR + 2000); grp.add(pts); }
    try { const pl = this._pools(s, L, g.lights); if (pl) grp.add(pl); } catch (e) { if (!this.stats.err) this.stats.err = 'pools: ' + (e?.message || e); }
    // ---- life
    const npcPaths = [];
    // busiest near the centre: sort walk segments by distance (with jitter) before the budget cut
    const pathsSorted = L.paths.map((p) => ({ p, k: Math.hypot(p.ax, p.az) * (0.6 + rng.next() * 0.8) })).sort((a, b) => a.k - b.k).map((x) => x.p);
    for (const pth of pathsSorted) {
      const a = offsetDir(s, pth.ax, pth.az, new THREE.Vector3()).multiplyScalar(s.R + pth.ah + 0.02).sub(s.pos);
      const b = offsetDir(s, pth.bx, pth.bz, new THREE.Vector3()).multiplyScalar(s.R + pth.bh + 0.02).sub(s.pos);
      npcPaths.push({ a, b });
    }
    const maxNPC = Math.round((s.kind === 'metropolis' ? 340 : s.kind === 'city' ? 280 : s.kind === 'town' ? 190 : 70) * this.qk);
    if (s.kind !== 'monument' && s.kind !== 'ruin') {
      const npcs = makeNPCs(s.kit, npcPaths, s.up, rng, s.kind === 'ruin' ? 0 : maxNPC);
      if (npcs) { grp.add(npcs); life.npcs = npcs.geometry.instanceCount; }
    }
    if (s.level >= 4 && (s.kind === 'city' || s.kind === 'metropolis')) {
      const tk = MODERN.has(s.kit) ? (s.kit === 'neon' ? 'neon' : 'car') : s.kit === 'hearth' ? 'ship' : 'glider';
      const n = Math.round((s.kind === 'metropolis' ? 70 : 40) * this.qk);
      const tr = makeTraffic(tk, s, n, rng, s.radius, s.kit === 'neon' ? 70 : 45);
      if (tr) { grp.add(tr); life.traffic = tr.geometry.instanceCount; }
    }
    if (s.coastal > 0 || L.water) {
      const spots = this._boatSpots(s, rng);
      const bt = makeBoats(s, spots, sea);
      if (bt) { grp.add(bt); life.boats = bt.geometry.instanceCount; }
    }
    if (s.spaceport && s.kit !== 'hearth') {
      const sp = L.lots.find((l) => l.type === 'spaceport');
      if (sp) {
        const f = this._frame(s, sp.x, sp.z, sp.rot, sp.hMax + 0.12, _m);
        const a = new THREE.Vector3(30, 0, 30).applyMatrix4(f);
        const up = offsetDir(s, sp.x, sp.z, new THREE.Vector3());
        const el = makeElevator(a, up, 60000);
        grp.add(el);
        // anchor station geometry
        const eg = new Geo();
        eg.begin(this._frame(s, sp.x, sp.z, sp.rot, sp.hMax + 0.12, new THREE.Matrix4()), 1);
        eg.translate(30, 0, 30);
        eg.cyl(0, 0, 0, 14, 11, 12, 20, true, M.found);
        eg.windows(3, 4, 12); eg.cyl(0, 12, 0, 9, 6, 26, 18, false, M.wall2 || M.wall);
        eg.cyl(0, 38, 0, 10, 10, 2, 18, true, M.trim);
        for (let i = 0; i < 6; i++) { const aa = i / 6 * Math.PI * 2; eg.tube([new THREE.Vector3(Math.cos(aa) * 13, 0, Math.sin(aa) * 13), new THREE.Vector3(Math.cos(aa) * 3, 70, Math.sin(aa) * 3)], 0.6, 6, M.metal); }
        eg.light(0, 40, 0, '#9fe8ff', 12, 6, 0);
        eg.collider(0, 20, 0, 10, 20, 10);
        const egeo = eg.build();
        if (egeo) { const em = new THREE.Mesh(egeo, kit.mainMat); em.castShadow = true; em.receiveShadow = true; grp.add(em); }
        const ep = this._points(eg.lights); if (ep) grp.add(ep);
        for (const b of eg.boxes) g.boxes.push(b);
        s.elevator = el;
      }
    }
    // ---- colliders
    const cols = [];
    for (const b of g.boxes) {
      const c = { type: 'box', pos: b.c.clone().add(s.pos), halfExtents: new THREE.Vector3(Math.max(0.1, b.hx), Math.max(0.1, b.hy), Math.max(0.1, b.hz)), quaternion: b.q.clone(), tag: 'civ' };
      cols.push(c);
      try { this.world.addCollider(c); } catch (_) { /* ignore */ }
    }
    // ---- validate: a detailed site must have geometry. Never mark an empty build as done silently.
    let tris = 0;
    grp.traverse((o) => { if (o.isMesh && o.geometry?.index) tris += o.geometry.index.count / 3 * (o.geometry.isInstancedBufferGeometry ? o.geometry.instanceCount : 1); });
    if (!(g.tris > 0) || !(tris > 0)) {
      this.stats.empty++;
      const why = `site ${s.id} '${s.name}' (${s.kit}/${s.kind}) built empty: lots=${L.lots.length} props=${L.props.length} roads=${L.roads.length} lotFails=${this.stats.lotFails} h0=${s.h0}`;
      if (!this.stats.err) this.stats.err = why;
      console.warn('[civ]', why);
    }
    s.detail = { grp, cols, tris, life };
    this.root.add(grp);
    try { const L = this.world.lighting; if (L?.setupMaterial) grp.traverse((o) => { if (o.isMesh && o.material && !o.userData.noCSM) L.setupMaterial(o.material); }); } catch (_) { /* ignore */ }
    if (s.far) s.far.visible = false;
    this.stats.built++;
    this.stats.trisBuilt += tris;
    this._recount();
  }

  /** live counters over the currently detailed sites (shown in __rv.state().civ). */
  _recount() {
    const st = this.stats;
    st.tris = 0; st.npcs = 0; st.traffic = 0; st.boats = 0;
    for (const s of this.sites) {
      const d = s.detail; if (!d) continue;
      st.tris += d.tris || 0; st.npcs += d.life?.npcs || 0; st.traffic += d.life?.traffic || 0; st.boats += d.life?.boats || 0;
    }
  }

  /** Ground light pools under low lights (street lamps, lanterns, shopfronts, signs). */
  _pools(s, L, lights) {
    const G = L.ground; if (!G) return null;
    const out = [];
    const max = Math.round(1600 * this.qk);
    for (const l of lights) {
      if (l.kind !== 0 && l.kind !== 2) continue;
      const lum = l.r * 0.3 + l.g * 0.55 + l.b * 0.15;
      if (lum < 0.6) continue;
      _v.set(l.x, l.y, l.z);
      const x = _v.dot(s.east), z = _v.dot(s.north);
      _w.copy(_v).add(s.pos);
      const lr = _w.length();
      const gh = G.g(x, z);
      const hgt = lr - s.R - gh;
      if (!(hgt > 0.4 && hgt < 8.5)) continue;
      _w.divideScalar(lr);
      const bx = _w.x * (s.R + gh) - s.pos.x, by = _w.y * (s.R + gh) - s.pos.y, bz = _w.z * (s.R + gh) - s.pos.z;
      const k = 0.04 * Math.min(1.5, 4.5 / Math.max(2, hgt));
      out.push({ x: bx, y: by, z: bz, nx: _w.x, ny: _w.y, nz: _w.z, r: l.r * k, g: l.g * k, b: l.b * k, rad: Math.min(6.5, Math.max(2.2, hgt * 1.15)), hgt, w: lum * k });
    }
    // over budget: keep the brightest pools (street lamps and shopfronts beat faint window spill)
    if (out.length > max) { out.sort((a, b) => b.w - a.w); out.length = max; }
    return makePools(out, !!this.world.engine?.reversedDepth);
  }

  _boatSpots(s, rng) {
    const S = this.S, spots = [];
    const sea = S.seaLevel;
    if (!(sea > -1e8)) return spots;
    for (let i = 0; i < 90 && spots.length < Math.round(10 * this.qk); i++) {
      const a = rng.range(0, Math.PI * 2), d = rng.range(s.radius * 0.6, s.radius * 1.8);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      offsetDir(s, x, z, _v);
      const h = S.heightLod ? S.heightLod(_v.x, _v.y, _v.z, 4) : S.height(_v.x, _v.y, _v.z);
      if (h > sea - 2 || h < sea - 40) continue;
      spots.push({ x, z, heading: rng.range(0, 6.28), scale: rng.range(0.8, 1.4) });
    }
    return spots;
  }

  // ------------------------------------------------------------------ roads
  _roads(rg, s, L, kit) {
    const { M, style } = kit;
    const G = L.ground;
    if (!G) return;
    const lift = 0.14;
    const eye = new THREE.Matrix4();
    rg.begin(eye, 0);
    for (const r of L.roads) {
      const Mr = style.road?.(r) === 'path' ? (M.path || M.road) : (M.road || M.path);
      const len = polyLen(r.pts);
      const step = 3.2;
      const n = Math.max(2, Math.ceil(len / step));
      const base = rg.vc;
      const across = [-1, -0.5, 0, 0.5, 1];
      for (let i = 0; i <= n; i++) {
        const p = along(r.pts, len * i / n);
        for (const a of across) {
          const x = p.x - p.tz * a * r.w / 2, z = p.z + p.tx * a * r.w / 2;
          const h = G.g(x, z) + lift + (Math.abs(a) < 0.9 ? 0.04 : 0);
          offsetDir(s, x, z, _v);
          const px = _v.x * (s.R + h) - s.pos.x, py = _v.y * (s.R + h) - s.pos.y, pz = _v.z * (s.R + h) - s.pos.z;
          rg.vert(px, py, pz, _v.x, _v.y, _v.z, a, len * i / n, { ...Mr });
        }
        if (i > 0) for (let j = 0; j < across.length - 1; j++) {
          const a0 = base + (i - 1) * across.length + j, b0 = a0 + across.length;
          rg.quadIdx(a0, b0, b0 + 1, a0 + 1);
        }
      }
    }
    // city pavement: the whole built-up disc is paved for modern (grid) styles
    if (style.pave && (s.kind === 'city' || s.kind === 'metropolis' || s.kind === 'town')) {
      const Mv = M.plaza || M.road;
      const RR = s.radius * 1.02, step = 6;
      const nx = Math.ceil(RR * 2 / step);
      const base = rg.vc;
      const idx = new Int32Array((nx + 1) * (nx + 1)).fill(-1);
      for (let j = 0; j <= nx; j++) for (let i = 0; i <= nx; i++) {
        const x = -RR + i * step, z = -RR + j * step;
        if (x * x + z * z > (RR + step) * (RR + step)) continue;
        if (!L.water && G.wet(x, z)) continue;
        const h = G.g(x, z) + 0.09;
        offsetDir(s, x, z, _v);
        idx[j * (nx + 1) + i] = rg.vert(_v.x * (s.R + h) - s.pos.x, _v.y * (s.R + h) - s.pos.y, _v.z * (s.R + h) - s.pos.z, _v.x, _v.y, _v.z, x, z, Mv);
      }
      for (let j = 0; j < nx; j++) for (let i = 0; i < nx; i++) {
        const a = idx[j * (nx + 1) + i], b = idx[j * (nx + 1) + i + 1], c = idx[(j + 1) * (nx + 1) + i + 1], d = idx[(j + 1) * (nx + 1) + i];
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        rg.quadIdx(a, b, c, d);
      }
      void base;
    }
    // plaza disc
    const pr = L.plaza.r, Mp = M.plaza || M.road;
    const rings = Math.max(3, Math.round(pr / 3)), segs = Math.max(16, Math.round(pr * 1.4));
    const c0 = rg.vc;
    for (let i = 0; i <= rings; i++) {
      const rr = pr * i / rings;
      for (let j = 0; j < (i === 0 ? 1 : segs); j++) {
        const a = j / segs * Math.PI * 2;
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        const h = G.g(x, z) + lift + 0.06;
        offsetDir(s, x, z, _v);
        rg.vert(_v.x * (s.R + h) - s.pos.x, _v.y * (s.R + h) - s.pos.y, _v.z * (s.R + h) - s.pos.z, _v.x, _v.y, _v.z, x, z, Mp);
      }
    }
    for (let j = 0; j < segs; j++) rg.tri(c0, c0 + 1 + j, c0 + 1 + (j + 1) % segs);
    for (let i = 1; i < rings; i++) for (let j = 0; j < segs; j++) {
      const a = c0 + 1 + (i - 1) * segs + j, b = c0 + 1 + (i - 1) * segs + (j + 1) % segs;
      rg.quadIdx(a, a + segs, b + segs, b);
    }
  }

  /** Hamlet: a path from next to the player's spawn, through the hamlet, towards the capital. */
  _hamletRoad(s) {
    const cap = this.sites[0];
    const L = s.layout;
    if (!cap || !L?.ground) return;
    const toLocal = (dir) => { const d = dir.clone().multiplyScalar(s.R / dir.dot(s.up)); return { x: d.dot(s.east), z: d.dot(s.north) }; };
    const sp = toLocal(s.spawn), cp = toLocal(cap.up);
    const pts = [];
    const a = { x: sp.x + (0 - sp.x) * 0.08, z: sp.z + (0 - sp.z) * 0.08 };
    const n1 = 14;
    for (let i = 0; i <= n1; i++) { const t = i / n1; pts.push({ x: a.x * (1 - t) + Math.sin(t * 3) * 6, z: a.z * (1 - t) + Math.cos(t * 2.3) * 5 }); }
    const dist = Math.hypot(cp.x, cp.z);
    const maxL = Math.min(dist - cap.radius * 0.6, 2200);
    for (let d = 10; d < maxL; d += 10) { const t = d / dist; pts.push({ x: cp.x * t + Math.sin(d * 0.013) * 18, z: cp.z * t + Math.cos(d * 0.011) * 14 }); }
    L.roads.push({ pts, w: 3.2, type: 'path' });
  }

  /** Orbit-scale light network: faint chains of lights along routes between neighbouring settlements. */
  _roadsBetween() {
    const S = this.S, lights = [];
    const col = new THREE.Color(this._kit(this.styleName).style.look?.winCol ?? '#ffb467');
    const real = this.sites.filter((s) => s.kind !== 'monument' && !s.hamlet);
    const done = new Set();
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    for (const a of real) {
      const near = real.filter((b) => b !== a).map((b) => ({ b, d: a.up.angleTo(b.up) * a.R })).filter((x) => x.d < 28000).sort((x, y) => x.d - y.d).slice(0, 2);
      for (const { b, d } of near) {
        const key = a.id < b.id ? a.id + '-' + b.id : b.id + '-' + a.id;
        if (done.has(key)) continue;
        done.add(key);
        const n = Math.floor(d / 260);
        for (let i = 1; i < n; i++) {
          const t = i / n;
          p.copy(a.up).lerp(b.up, t).normalize();
          // gentle meander so routes are not ruler-straight
          q.copy(a.east).multiplyScalar(Math.sin(t * Math.PI * 3 + a.id) * 0.004).add(p).normalize();
          const h = S.heightLod ? S.heightLod(q.x, q.y, q.z, 200) : S.height(q.x, q.y, q.z);
          if (S.seaLevel > -1e8 && h < S.seaLevel) continue;
          q.multiplyScalar(a.R + h + 15);
          lights.push({ x: q.x, y: q.y, z: q.z, r: col.r * 0.5, g: col.g * 0.5, b: col.b * 0.5, size: 90, kind: 4, phase: i * 0.37 % 1 });
        }
      }
    }
    const pts = this._points(lights, 1);
    if (pts) { pts.material.depthTest = false; pts.material.uniforms.uFarFade.value.set(4000, 2e6); pts.renderOrder = 6; pts.name = 'civ-network'; this.root.add(pts); this.network = pts; }
  }

  /** Stålenhag / Pacific Drive power lines: chains of lattice mega-pylons marching out of town, sagging cables. */
  _powerLines(g, s, L, M, rng) {
    const G = L.ground; if (!G) return;
    const iron = M.iron || M.metal;
    const lines = s.kind === 'metropolis' || s.kind === 'city' ? 3 : 2;
    const f = new THREE.Matrix4();
    const H = 34, arms = [-7, 7];
    for (let li = 0; li < lines; li++) {
      const a0 = s.heading + li / lines * Math.PI * 2 + 0.5;
      let prev = null;
      const n = Math.round((s.radius * 1.8 + 900) / 95);
      for (let i = 0; i < n; i++) {
        const d = s.radius * 0.6 + i * 95;
        const a = a0 + Math.sin(i * 0.35 + li) * 0.08;
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        if (G.wet(x, z)) { prev = null; continue; }
        const h = G.h(x, z);
        this._frame(s, x, z, a + Math.PI / 2, h, f);
        g.begin(f, rng.next() * 100);
        g.box(0, -1.5, 0, 7, 2, 7, 0.1, M.found);
        P.lattice(g, H, 6.5, 1.4, iron, 8, 0.16);
        for (const y of [H * 0.72, H * 0.9]) g.box(0, y, 0, 15, 0.5, 0.6, 0.02, iron);
        for (const y of [H * 0.72, H * 0.9]) for (const ax of arms) g.cyl(ax, y - 1.6, 0, 0.18, 0.18, 1.6, 6, true, mat('#c8d0d0', 0.2, 0, PAT.PLAIN));
        g.light(0, H + 0.3, 0, '#ff2a1a', 6, 1.8, 1);
        g.collider(0, H / 2, 0, 3.2, H / 2, 3.2);
        // attach points in mesh space
        const pts = [];
        for (const y of [H * 0.72, H * 0.9]) for (const ax of arms) pts.push(new THREE.Vector3(ax, y - 1.7, 0).applyMatrix4(f));
        if (prev) {
          g.begin(new THREE.Matrix4(), 0);
          for (let k = 0; k < pts.length; k++) {
            const A = prev[k], B = pts[k];
            const up = A.clone().add(s.pos).normalize();
            const cab = [];
            for (let t = 0; t <= 10; t++) { const u = t / 10; cab.push(A.clone().lerp(B, u).addScaledVector(up, -4.5 * 4 * u * (1 - u))); }
            g.tube(cab, 0.06, 3, iron);
          }
        }
        prev = pts;
      }
    }
  }

  /**
   * Fortified enclosure (kremlin / monastery wall): whitewashed stepped wall that follows the terrain,
   * swallow-tail merlons, a wall-walk, round corner towers with tent roofs every ~45 m and a gatehouse
   * tower wherever a road crosses. Lamps on the gates, colliders for every piece.
   */
  _wall(g, s, L, kit, rng) {
    const G = L.ground, W = L.wall; if (!G || !W) return;
    const { M, style } = kit;
    const wallM = M.wallW || M.trim || M.wall, capM = M.wallCap || M.roof, baseM = M.found;
    const towerRoof = M.roofs?.[1] || M.roof, dome = M.domeG || M.dome || towerRoof;
    const H = W.h, T = 2.2, r = W.r;
    const f = new THREE.Matrix4();
    const circ = Math.PI * 2 * r;
    const n = Math.ceil(circ / 5), segL = circ / n;
    const nt = Math.max(6, Math.round(circ / 46));
    const gateAt = (a) => W.gates.find((q) => Math.abs(Math.atan2(Math.sin(q.a - a), Math.cos(q.a - a))) * r < q.w / 2 + 4.5);
    const place = (a, rr, h) => this._frame(s, Math.cos(a) * rr, Math.sin(a) * rr, Math.PI / 2 - a, h, f);
    for (let i = 0; i < n; i++) {
      const a = (i + 0.5) / n * Math.PI * 2;
      if (gateAt(a)) continue;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (G.wet(x, z)) continue;
      const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
      const h0 = G.g(Math.cos(a0) * r, Math.sin(a0) * r), h1 = G.g(Math.cos(a1) * r, Math.sin(a1) * r), hm = G.g(x, z);
      const lo = Math.min(h0, h1, hm), top = Math.max(h0, h1, hm);
      g.begin(place(a, r, top), i * 0.37);
      const drop = top - lo + 1.2;
      g.box(0, -drop, 0, segL + 0.25, drop + 0.9, T + 0.5, 0, baseM);
      g.box(0, 0, 0, segL + 0.2, H, T, 0, wallM);
      g.box(0, H - 0.1, 0, segL + 0.3, 0.3, T + 0.3, 0, capM);
      // swallow-tail merlons on the outer edge, low parapet inside
      for (let k = 0; k < 3; k++) {
        const mx = -segL / 2 + (k + 0.5) * segL / 3;
        g.box(mx, H + 0.2, T / 2 - 0.35, 0.9, 1.1, 0.5, 0, wallM);
        for (const sx of [-1, 1]) { g.push().translate(mx + sx * 0.22, H + 1.3, T / 2 - 0.35).rotZ(sx * 0.35); g.box(0, 0, 0, 0.35, 0.55, 0.5, 0, wallM); g.pop(); }
      }
      g.box(0, H + 0.2, -T / 2 + 0.2, segL + 0.2, 0.6, 0.3, 0, wallM);
      // blind arcade on the outside face
      g.box(0, 1.2, T / 2 + 0.02, segL * 0.55, H * 0.55, 0.05, 0, tint(wallM, 0.86));
      g.collider(0, H / 2 - drop / 2, 0, segL / 2, (H + drop) / 2, T / 2);
    }
    // towers
    for (let k = 0; k < nt; k++) {
      const a = (k + 0.5) / nt * Math.PI * 2 + 0.07;
      if (gateAt(a)) continue;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (G.wet(x, z)) continue;
      const hh = G.g(x, z), lo = Math.min(G.g(x * 1.02, z * 1.02), G.g(x * 0.98, z * 0.98), hh);
      g.begin(place(a, r, hh), k + 0.5);
      const th = H + rng.range(5, 8), tr = 3.4;
      g.cyl(0, lo - hh - 1.2, 0, tr + 0.35, tr + 0.35, hh - lo + 2, 16, true, baseM);
      g.windows(1.8, 3.2, 0);
      g.cyl(0, 0.6, 0, tr + 0.15, tr, th, 16, false, M.wall || wallM);
      g.cyl(0, th + 0.6, 0, tr + 0.5, tr + 0.5, 0.4, 16, true, capM);
      for (let m = 0; m < 10; m++) { const b = m / 10 * Math.PI * 2; g.box(Math.cos(b) * (tr + 0.2), th + 1, Math.sin(b) * (tr + 0.2), 0.8, 1.0, 0.5, 0, wallM); }
      // tent roof with a small lantern + onion (kremlin skyline)
      g.cyl(0, th + 1.9, 0, tr * 0.72, tr * 0.72, 1.4, 12, false, wallM);
      g.cyl(0, th + 3.3, 0, tr * 0.85, 0.35, tr * 2.4, 12, true, towerRoof);
      g.cyl(0, th + 3.3 + tr * 2.4, 0, 0.35, 0.3, 1.2, 8, false, wallM);
      g.push().translate(0, th + 4.4 + tr * 2.4, 0); g.sphere(0, 0.45, 0, 0.55, 10, 6, dome); g.cyl(0, 0.9, 0, 0.18, 0.02, 0.9, 6, true, dome); g.pop();
      g.light(0, th * 0.55, tr + 0.3, style.look?.winCol ?? '#ffc680', 3, 1.6, 2);
      g.collider(0, th / 2, 0, tr, th / 2 + 1, tr);
    }
    // gatehouses where roads pass through
    for (const q of W.gates) {
      const x = Math.cos(q.a) * r, z = Math.sin(q.a) * r;
      if (G.wet(x, z)) continue;
      const hh = G.g(x, z);
      g.begin(place(q.a, r, hh), q.a);
      const gw = q.w + 2.2, pw = 2.6, gh = H + (q.main ? 9 : 5), D = T + 3;
      for (const sx of [-1, 1]) {
        g.box(sx * (gw / 2 + pw / 2), -1.5, 0, pw, gh + 1.5, D, 0.05, wallM);
        g.collider(sx * (gw / 2 + pw / 2), gh / 2, 0, pw / 2, gh / 2, D / 2);
      }
      // archway: stepped voussoirs, then the upper chamber
      const ah = Math.min(5.2, H - 0.8);
      for (let v = 0; v < 7; v++) { const b = Math.PI * v / 6; g.box(Math.cos(b) * gw / 2 * 0.98, ah + Math.sin(b) * 1.4, 0, 0.9, 0.9, D + 0.1, 0, tint(wallM, 0.92)); }
      g.box(0, ah + 1.4, 0, gw + 0.2, gh - ah - 1.4, D, 0.05, M.wall || wallM);
      g.box(0, gh, 0, gw + pw * 2 + 0.6, 0.4, D + 0.6, 0.03, capM);
      // icon niche above the arch (warm lit at night)
      g.box(0, ah + 2.4, D / 2 + 0.02, 1.4, 2.0, 0.08, 0, M.lampGlow || capM);
      g.cyl(0, gh + 0.4, 0, (gw + pw * 2) * 0.42, 0.3, q.main ? 8 : 5.5, 4, true, towerRoof, { a0: Math.PI / 4, a1: Math.PI / 4 + Math.PI * 2 });
      g.push().translate(0, gh + (q.main ? 8.4 : 5.9), 0); g.sphere(0, 0.6, 0, 0.8, 10, 6, dome); g.cyl(0, 1.3, 0, 0.22, 0.02, 1.4, 6, true, dome); g.pop();
      for (const sx of [-1, 1]) g.light(sx * (gw / 2 + 0.4), 3.6, D / 2 + 0.5, style.look?.winCol ?? '#ffc680', 5, 2.2, 2);
    }
  }

  // ------------------------------------------------------------------ centerpieces & monuments
  _plazaPiece(g, s, L, M, rng, ctx) {
    const f = this._frame(s, 0, 0, s.heading, L.plaza.h + 0.2, new THREE.Matrix4());
    g.begin(f, 7);
    const st = s.kit;
    // festive lantern strings across the plaza (they sway at night) + poles
    const festive = !MODERN.has(st) || st === 'spire' || st === 'bizarre';
    if (festive && L.plaza.r > 10) {
      const pr = L.plaza.r * 0.92, np = 6, poles = [];
      const lc = st === 'ruins' ? '#ffb060' : st === 'organic' ? '#aff8ff' : st === 'bizarre' ? '#b6ff4a' : '#ffc070';
      for (let i = 0; i < np; i++) {
        const a = i / np * Math.PI * 2 + 0.3;
        const x = Math.cos(a) * pr, z = Math.sin(a) * pr;
        const gh = (L.ground ? L.ground.g(x, z) : L.plaza.h) - L.plaza.h - 0.2;
        g.cyl(x, gh - 0.3, z, 0.12, 0.09, 6.3, 6, true, M.wood || M.metal);
        poles.push([x, gh + 5.8, z]);
      }
      for (let i = 0; i < np; i++) {
        const A = poles[i], B = poles[(i + 2) % np];
        P.cable(g, A, B, 1.2, 0.02, M.iron || M.wood, 5, lc);
      }
      // benches and planted trees around the rim
      for (let i = 0; i < np; i++) {
        const a = (i + 0.5) / np * Math.PI * 2 + 0.3;
        const x = Math.cos(a) * pr * 0.78, z = Math.sin(a) * pr * 0.78;
        g.push().translate(x, 0, z).rotY(-a + Math.PI / 2);
        g.box(0, 0.42, 0, 1.8, 0.08, 0.45, 0, M.wood); for (const sx of [-0.75, 0.75]) g.box(sx, 0, 0, 0.1, 0.42, 0.4, 0, M.iron || M.wood);
        g.box(0, 0.5, -0.2, 1.8, 0.45, 0.06, 0, M.wood);
        g.pop();
        if (i % 2 === 0 && st !== 'nomad') P.tree(g, Math.cos(a + 0.25) * pr * 0.85, 0, Math.sin(a + 0.25) * pr * 0.85, rng.range(5, 7), M, rng);
      }
    }
    if (st === 'hearth' || st === 'nomad') {
      // campfire ring with logs & benches
      for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2; g.sphere(Math.cos(a) * 1.3, 0, Math.sin(a) * 1.3, 0.35, 6, 3, M.stone || M.found); }
      for (let i = 0; i < 5; i++) { g.push().rotY(i * 1.2).translate(0, 0.25, 0).rotZ(0.9); g.cyl(0, -0.8, 0, 0.12, 0.1, 1.5, 6, true, M.wood); g.pop(); }
      g.sphere(0, 0.5, 0, 0.45, 8, 5, mat('#ff8a2a', 0.4, 0, PAT.NEON, 9));
      g.light(0, 0.9, 0, '#ff8a3a', 18, 3.5, 2);
      g.light(0, 1.6, 0, '#ffb060', 8, 2.0, 2);
      for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2 + 0.4; g.push().translate(Math.cos(a) * 4, 0.3, Math.sin(a) * 4).rotY(-a).rotZ(Math.PI / 2); g.cyl(0, -1.4, 0, 0.3, 0.3, 2.8, 8, true, M.wood); g.pop(); }
      // marshmallow stick :)
      g.push().translate(1.2, 0.5, 1.8).rotX(-0.9); g.cyl(0, 0, 0, 0.02, 0.02, 1.6, 4, true, M.wood); g.pop();
      return;
    }
    if (s.kind === 'village' || s.kind === 'camp' || s.hamlet) {
      // well / fountain
      g.cyl(0, 0, 0, 1.6, 1.6, 0.9, 14, true, M.stone || M.found);
      g.cyl(0, 0.9, 0, 1.3, 1.3, 0.05, 14, true, mat('#2a4a5a', 0.05, 0.3));
      for (const sx of [-1, 1]) g.box(sx * 1.2, 0.9, 0, 0.18, 2.1, 0.18, 0.02, M.wood);
      g.gable(0, 2.9, 0, 0.8, 3.0, 0.9, 0.2, 0.08, M.roof || M.wood);
      return;
    }
    // statue on a stepped plinth + water basin
    g.cyl(0, 0, 0, L.plaza.r * 0.32, L.plaza.r * 0.32, 0.7, 24, true, M.stone || M.found);
    g.cyl(0, 0.7, 0, L.plaza.r * 0.28, L.plaza.r * 0.28, 0.05, 24, true, mat('#2a4a5a', 0.04, 0.3));
    g.push().translate(0, 0.7, 0);
    P.statue(g, Math.min(22, L.plaza.r * 0.55), M, rng, rng.next() < 0.5 ? 1 : 0);
    g.pop();
    void ctx;
  }

  _monument(g, s, M, rng, ctx) {
    const h0 = s.h0;
    const f = this._frame(s, 0, 0, s.heading, h0 + 0.1, new THREE.Matrix4());
    g.begin(f, 11);
    // foundation terrace
    g.box(0, -6, 0, 30, 6.4, 30, 0.2, M.found);
    const pick = s.kit === 'monolith' ? 5 : rng.int(0, 4);
    const glyph = mat('#4a4a50', 0.5, 0.2, PAT.GLYPH, 4);
    if (pick === 0) P.statue(g, rng.range(38, 58), { ...M, glow: M.glow }, rng, rng.int(0, 1));
    else if (pick === 1) P.arch(g, 26, 22, 6, { ...M.stone, key: M.trim });
    else if (pick === 2) { P.obelisk(g, 40, M, glyph); for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2 + 0.78; g.push().translate(Math.cos(a) * 11, 0, Math.sin(a) * 11); P.obelisk(g, 14, M, glyph); g.pop(); } }
    else if (pick === 3) P.beacon(g, 34, M, '#ffe0a0');
    else if (pick === 4) {
      // glowing glyph wall ring (sculpture garden)
      for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2; g.push().translate(Math.cos(a) * 11, 0, Math.sin(a) * 11).rotY(-a + Math.PI / 2); g.box(0, 0, 0, 7, rng.range(6, 11), 1.4, 0.1, glyph); g.collider(0, 4, 0, 3.5, 4, 0.7); g.pop(); }
      g.sphere(0, 6, 0, 2.2, 16, 10, M.glow || glyph);
      g.light(0, 6, 0, '#9fe8ff', 20, 6, 0);
    } else {
      // Kubrick monolith 1:4:9
      g.box(0, -1, 0, 1.6 * 2.5, 9 * 2.5 + 1, 0.4 * 2.5, 0.01, mat('#030304', 0.05, 0.3));
      g.collider(0, 11, 0, 2, 12, 0.5);
    }
    void ctx;
  }

  // ------------------------------------------------------------------ frame loop
  update(dt) {
    if (!this.enabled) return;
    try { this._update(dt); } catch (e) {
      // never throw into the frame loop
      this.stats.jobFails++;
      if (!this._updWarned) { console.error('[civ] update failed', e); this._updWarned = true; }
    }
  }

  _update(dt) {
    this._t = (this._t || 0) + (dt || 0);
    if (this._debug.includes('npcbig') && !this._npcbig) { this._npcbig = true; this.root.traverse((o) => { if (o.name === 'civ-npcs') o.geometry.attributes.aP.array.forEach((v, i, a) => { if (i % 4 === 2) a[i] = 8; }); }); }
    if (this._debug.includes('noflora')) { const f = this.world.get?.('flora'); if (f?.group) f.group.visible = false; }
    const cam = this.world.camera.position;
    const alt = cam.length() - this.body.radius;
    // streaming decisions (cheap; every frame is fine for ≤ 20 sites)
    for (const s of this.sites) {
      const d = cam.distanceTo(s.pos) - s.radius;
      const want = d < this.detailR && alt < 9000;
      if (want && !s.detail && !s.building && !((s.retryAt || 0) > this._t)) {
        s.building = true;
        this.jobs.unshift({ site: s, kind: 'detail', gen: this._buildDetail(s), d });
      } else if (!want && s.detail && d > this.dropR) this._drop(s);
      if (s.far) s.far.visible = !s.detail && d > 500;
    }
    // nearest jobs first
    this.jobs.sort((a, b) => (a.kind === 'far') - (b.kind === 'far') || (a.site.pos.distanceTo(cam) - b.site.pos.distanceTo(cam)));
    const budget = this.world.engine?.shot && !this.world.engine?.isReady ? 250 : (dt === 0 ? 60 : 5);
    const t0 = now();
    while (this.jobs.length && now() - t0 < budget) {
      const j = this.jobs[0];
      let r;
      try { r = j.gen.next(); } catch (e) {
        this.stats.jobFails++;
        if (!this.stats.err) this.stats.err = `${j.kind} ${j.site.id}: ${e?.message || e}`;
        console.error('[civ] job failed', j.kind, j.site.id, e);
        r = { done: true };
        // a failing detail build must not be retried every frame: back off (retry after 10 s of sim time)
        if (j.kind === 'detail') j.site.retryAt = (this._t || 0) + 10;
      }
      if (r.done) { this.jobs.shift(); if (j.kind === 'detail') j.site.building = false; }
    }
    this.stats.ms = Math.round(now() - t0);
    // glow sprite projection params
    const h = this.world.engine?.renderer?.domElement?.height || this.world.engine?.height || 720;
    const fov = (this.world.camera.fov || 60) * Math.PI / 180;
    for (const m of this.glowMats) { m.uniforms.uPixH.value = h; m.uniforms.uFov.value = fov; }
  }

  _drop(s) {
    const d = s.detail; if (!d) return;
    for (const c of d.cols) this.world.removeCollider?.(c);
    d.grp.traverse((o) => {
      o.geometry?.dispose?.();
      const m = o.material;
      if (m && !m.userData?.shared) { m.dispose?.(); const i = this.glowMats.indexOf(m); if (i >= 0) this.glowMats.splice(i, 1); }
    });
    d.grp.removeFromParent();
    s.detail = null;
    if (s.far) s.far.visible = true;
    this._recount();
  }

  isReady() {
    if (!this.enabled) return true;
    const cam = this.world.camera.position;
    for (const j of this.jobs) {
      if (j.kind === 'far') return false;
      if (j.site.pos.distanceTo(cam) - j.site.radius < this.detailR) return false;
    }
    // sites that should be detailed but have not been queued yet (first frame)
    const alt = cam.length() - this.body.radius;
    if (alt < 9000) for (const s of this.sites) if (!s.detail && !((s.retryAt || 0) > (this._t || 0)) && cam.distanceTo(s.pos) - s.radius < this.detailR) return false;
    return true;
  }

  getState() {
    if (!this.enabled) return { enabled: false };
    const c = this.sites[0];
    return {
      style: this.styleName, level: this.level, sites: this.sites.length, detail: this.sites.filter((s) => s.detail).map((s) => s.id),
      jobs: this.jobs.length, tris: this.stats.tris, trisBuilt: this.stats.trisBuilt, npcs: this.stats.npcs, traffic: this.stats.traffic, boats: this.stats.boats,
      siteTris: Object.fromEntries(this.sites.filter((s) => s.detail).map((s) => [s.id, s.detail.tris])),
      fails: this.stats.lotFails + this.stats.jobFails + this.stats.empty, err: this.stats.err, farVis: this.sites.filter((s) => s.far?.visible).length,
      capDist: c ? Math.round(this.world.camera.position.distanceTo(c.pos)) : 0, planMs: this.stats.planMs, ms: this.stats.ms,
      capital: c ? { name: c.name, kind: c.kind, lat: +c.lat.toFixed(4), lon: +c.lon.toFixed(4), r: Math.round(c.radius) } : null,
      civcam: this.stats.civcam || undefined,
      hamlet: this.sites.find((s) => s.hamlet) ? { lat: +this.sites.find((s) => s.hamlet).lat.toFixed(4), lon: +this.sites.find((s) => s.hamlet).lon.toFixed(4) } : null,
    };
  }

  onOriginShift() { /* everything is parented to world.root in planet-local coordinates */ }

  dispose() {
    try { for (const id of this.flats || []) this.S?.removeFlatten?.(id); } catch (_) { /* ignore */ }
    for (const s of this.sites) { this._drop(s); if (s.far) { s.far.traverse((o) => o.geometry?.dispose?.()); s.far.removeFromParent(); } }
    for (const k of this.kits.values()) { k.mainMat.dispose(); k.roadMat.dispose(); }
    for (const m of this.glowMats) m.dispose();
    this.root.removeFromParent();
  }
}

export default {
  name: 'civ',
  order: 35,
  async create(world) {
    try { return new Civ(world); } catch (e) { console.error('[civ] create failed', e); return { getState: () => ({ error: String(e) }) }; }
  },
};
