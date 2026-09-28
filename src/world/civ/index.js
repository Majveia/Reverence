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
import { Geo, mat, PAT } from './geo.js';
import { makeCivMaterial, makeGlowMaterial } from './material.js';
import { getStyle, buildLamp, parts as P } from './styles.js';
import { makeNPCs, makeTraffic, makeBoats, makeElevator } from './life.js';

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
    this.stats = { built: 0, tris: 0, draw: 0, ms: 0 };
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
    this.stats.planMs = Math.round(now() - t0);
    // clearings for flora/fauna placement: [dirX, dirY, dirZ, cosAngularRadius, keepFraction]
    this.clearings = this.sites.map((s) => [s.up.x, s.up.y, s.up.z, Math.cos((s.radius * (s.hamlet ? 1.3 : 1.08)) / s.R), s.kind === 'ruin' || s.kind === 'monument' ? 0.5 : s.hamlet || s.kind === 'village' || s.kind === 'camp' ? 0.12 : 0.04]);
    const cap0 = this.sites[0];
    this.spawnTarget = cap0 ? cap0.pos.clone().addScaledVector(cap0.up, Math.min(40, cap0.radius * 0.1)) : null;
    try { world.civ = { clearings: this.clearings, sites: this.sites, spawnTarget: this.spawnTarget, capital: cap0 }; world.events?.emit?.('civ:clearings', { clearings: this.clearings }); } catch (_) { /* ignore */ }
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
      const roadMat = makeCivMaterial(look, { key: 'road', polygonOffset: true });
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
    const kind = s.kind === 'metropolis' || s.kind === 'city' ? 'city' : s.kind === 'ruin' ? 'ruin' : s.kind === 'monument' ? 'monument' : 'village';
    try { this.world.addPOI({ kind, name: s.name, pos: s.pos.clone(), radius: s.radius, data: { style: s.kit, level: s.level, capital: !!s.capital, civ: this.body.civ?.name } }); } catch (_) { /* ignore */ }
    this.sites.push(s);
  }

  _layout(s) {
    if (!s.layout) {
      const kit = this._kit(s.kit);
      const prof = { ...kit.style.profile };
      if (s.kind === 'monument') { prof.landmark = false; }
      s.layout = s.kind === 'monument' ? { roads: [], lots: [], props: [], paths: [], plaza: { x: 0, z: 0, r: 16, h: s.h0 }, ground: null, water: false }
        : layoutSite(s, this.S, prof, this.qk);
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
          g.box(0, -drop - 1.2, 0, lot.w + 0.5 + bat * 2, drop * 0.5 + 1.2, lot.d + 0.5 + bat * 2, 0.08, M.found);
          g.box(0, -drop * 0.5, 0, lot.w + 0.5 + bat, drop * 0.5 + 0.05, lot.d + 0.5 + bat, 0.06, M.found);
          g.box(0, -0.12, 0, lot.w + 0.7 + bat, 0.2, lot.d + 0.7 + bat, 0.04, M.trim && M.trim.pat !== PAT.NEON ? M.trim : M.found);
        } else g.box(0, -drop - 1.2, 0, lot.w + 0.5, drop + 1.2 + 0.05, lot.d + 0.5, 0.04, M.found);
        if (drop > 1.8) { // steps up to the door
          const n = Math.ceil(drop / 0.3);
          for (let i = 0; i < n; i++) g.box(0, -drop - 0.6, lot.d / 2 + 0.25 + (n - i) * 0.35, 1.6, i * 0.3 + 0.6, 0.36, 0.02, M.found);
        }
      }
      let h = 6;
      try { h = style.build(g, lot, ctx) ?? 6; } catch (e) { if (!this._warned) { console.warn('[civ] build failed', lot.type, e); this._warned = true; } }
      lot.farH = h;
      if (++k % 6 === 0) yield;
    }
    // ---- props: lamps, stalls, plaza centerpiece
    for (const p of L.props) {
      const f = this._frame(s, p.x, p.z, p.rot, p.h + 0.05, _m);
      g.begin(f, rng.next() * 100);
      if (p.type === 'lamp') buildLamp(g, style, M);
      else if (p.type === 'stall') P.stall(g, M, rng);
    }
    yield;
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
    if (geo) {
      const mesh = new THREE.Mesh(geo, kit.mainMat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = 'civ-buildings';
      grp.add(mesh);
      this.stats.tris += g.tris;
    }
    const rgeo = rg.build();
    if (rgeo) {
      const rm = new THREE.Mesh(rgeo, kit.roadMat);
      rm.receiveShadow = true; rm.name = 'civ-roads';
      grp.add(rm);
    }
    const pts = this._points(g.lights, 1);
    if (pts) { pts.material.uniforms.uFarFade.value.set(0, this.dropR + 2000); grp.add(pts); }
    // ---- life
    const npcPaths = [];
    // busiest near the centre: sort walk segments by distance (with jitter) before the budget cut
    const pathsSorted = L.paths.map((p) => ({ p, k: Math.hypot(p.ax, p.az) * (0.6 + rng.next() * 0.8) })).sort((a, b) => a.k - b.k).map((x) => x.p);
    for (const pth of pathsSorted) {
      const a = offsetDir(s, pth.ax, pth.az, new THREE.Vector3()).multiplyScalar(s.R + pth.ah + 0.02).sub(s.pos);
      const b = offsetDir(s, pth.bx, pth.bz, new THREE.Vector3()).multiplyScalar(s.R + pth.bh + 0.02).sub(s.pos);
      npcPaths.push({ a, b });
    }
    const maxNPC = Math.round((s.kind === 'metropolis' ? 260 : s.kind === 'city' ? 200 : s.kind === 'town' ? 120 : 50) * this.qk);
    if (s.kind !== 'monument' && s.kind !== 'ruin') {
      const npcs = makeNPCs(s.kit, npcPaths, s.up, rng, s.kind === 'ruin' ? 0 : maxNPC);
      if (npcs) grp.add(npcs);
    }
    if (s.level >= 4 && (s.kind === 'city' || s.kind === 'metropolis')) {
      const tk = MODERN.has(s.kit) ? (s.kit === 'neon' ? 'neon' : 'car') : s.kit === 'hearth' ? 'ship' : 'glider';
      const n = Math.round((s.kind === 'metropolis' ? 70 : 40) * this.qk);
      const tr = makeTraffic(tk, s, n, rng, s.radius, s.kit === 'neon' ? 70 : 45);
      if (tr) grp.add(tr);
    }
    if (s.coastal > 0 || L.water) {
      const spots = this._boatSpots(s, rng);
      const bt = makeBoats(s, spots, sea);
      if (bt) grp.add(bt);
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
    s.detail = { grp, cols };
    this.root.add(grp);
    try { const L = this.world.lighting; if (L?.setupMaterial) grp.traverse((o) => { if (o.isMesh && o.material && !o.userData.noCSM) L.setupMaterial(o.material); }); } catch (_) { /* ignore */ }
    if (s.far) s.far.visible = false;
    this.stats.built++;
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

  // ------------------------------------------------------------------ centerpieces & monuments
  _plazaPiece(g, s, L, M, rng, ctx) {
    const f = this._frame(s, 0, 0, s.heading, L.plaza.h + 0.2, new THREE.Matrix4());
    g.begin(f, 7);
    const st = s.kit;
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
    if (this._debug.includes('npcbig') && !this._npcbig) { this._npcbig = true; this.root.traverse((o) => { if (o.name === 'civ-npcs') o.geometry.attributes.aP.array.forEach((v, i, a) => { if (i % 4 === 2) a[i] = 8; }); }); }
    if (this._debug.includes('noflora')) { const f = this.world.get?.('flora'); if (f?.group) f.group.visible = false; }
    const cam = this.world.camera.position;
    const alt = cam.length() - this.body.radius;
    // streaming decisions (cheap; every frame is fine for ≤ 20 sites)
    for (const s of this.sites) {
      const d = cam.distanceTo(s.pos) - s.radius;
      const want = d < this.detailR && alt < 9000;
      if (want && !s.detail && !s.building) {
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
      try { r = j.gen.next(); } catch (e) { console.error('[civ] job failed', e); r = { done: true }; }
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
    if (alt < 9000) for (const s of this.sites) if (!s.detail && cam.distanceTo(s.pos) - s.radius < this.detailR) return false;
    return true;
  }

  getState() {
    if (!this.enabled) return { enabled: false };
    const c = this.sites[0];
    return {
      style: this.styleName, level: this.level, sites: this.sites.length, detail: this.sites.filter((s) => s.detail).map((s) => s.id),
      jobs: this.jobs.length, tris: this.stats.tris, farVis: this.sites.filter((s) => s.far?.visible).length,
      capDist: c ? Math.round(this.world.camera.position.distanceTo(c.pos)) : 0, planMs: this.stats.planMs, ms: this.stats.ms,
      capital: c ? { name: c.name, kind: c.kind, lat: +c.lat.toFixed(4), lon: +c.lon.toFixed(4), r: Math.round(c.radius) } : null,
      hamlet: this.sites.find((s) => s.hamlet) ? { lat: +this.sites.find((s) => s.hamlet).lat.toFixed(4), lon: +this.sites.find((s) => s.hamlet).lon.toFixed(4) } : null,
    };
  }

  onOriginShift() { /* everything is parented to world.root in planet-local coordinates */ }

  dispose() {
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
