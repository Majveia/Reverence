// Sacred flora (season 2): one World Tree of light per world, grown at the terrain track's sacred 'tree'
// site (`world.get('terrain').landmarks.sacred[kind = 'tree']`, falling back to `surface.landmarks`).
// Drawn as a single always-on instance with the shared flora plant material (bark relief, luminous
// leaf cards, veins of light that glow by day and blaze at night, wind), a trunk collider, a wonder POI
// and a clearing in the flora bands around its roots. Optional: without landmarks nothing is built.
import * as THREE from 'three';
import { InstanceLayer } from './layer.js';
import { makePlantMaterials } from './materials.js';
import { worldTree } from './geom/worldtree.js';
import { mulberry, h01 } from './util.js';
import { hashCombine } from '../../core/rng.js';

const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0), _yaw = new THREE.Quaternion(), _v = new THREE.Vector3();

/** palette per flora style: [leafA, leafB, glow, vein] (linear) — warm light on earthly worlds */
function palette(key, pal) {
  switch (key) {
    case 'bioluminescent': return [[0.05, 0.16, 0.17], [0.1, 0.3, 0.3], [0.35, 1.0, 0.95], [0.4, 1.0, 0.95]];
    case 'fungal': return [[0.42, 0.36, 0.5], [0.6, 0.55, 0.68], [0.75, 0.6, 1.0], [0.8, 0.7, 1.0]];
    case 'crystal': return [[0.45, 0.55, 0.7], [0.65, 0.75, 0.85], [0.6, 0.85, 1.0], [0.7, 0.9, 1.0]];
    case 'wacky': return [[0.6, 0.3, 0.55], [0.75, 0.55, 0.3], [1.0, 0.6, 0.9], [1.0, 0.8, 0.4]];
    case 'dead': return [[0.5, 0.48, 0.44], [0.7, 0.68, 0.62], [1.0, 0.9, 0.7], [1.0, 0.85, 0.6]];
    // deep jade and bronze foliage (so the light-cards and veins read as light, not a pale blob)
    default: return [[0.06, 0.13, 0.08], [0.2, 0.2, 0.08], [1.0, 0.64, 0.28], [1.0, 0.68, 0.3]];
  }
}

export class SacredFlora {
  constructor(flora) {
    this.flora = flora;
    this.world = flora.world;
    this.layer = null;
    this.site = null;
  }

  init() {
    const F = this.flora, W = this.world, S = W.surface;
    let L = null;
    try { L = W.get?.('terrain')?.landmarks || S?.landmarks || null; } catch (_) { L = S?.landmarks || null; }
    const site = L?.sacred?.find?.((q) => q && q.kind === 'tree' && q.dir);
    if (!site || F.styleKey === 'barren' || F.styleKey === 'none') return false;
    const dir = new THREE.Vector3(site.dir[0], site.dir[1], site.dir[2]).normalize();
    let h = site.height ?? 0;
    try { h = S.height(dir.x, dir.y, dir.z); } catch (_) { /* keep */ }
    const R = F.R;
    const seed = hashCombine(F.seed, 0x7ee5);
    const rnd = mulberry(seed);
    const scale = Math.min(1.25, Math.max(0.8, R / 68000));
    const [la, lb, gc, vc] = palette(F.styleKey, F.S.palette);
    const A = F.atlas;
    const gen = worldTree(rnd, {
      height: 195 * scale, crownR: 112 * scale, trunkR: 13 * scale,
      rects: { leaf: A.rect('small'), leaf2: A.rect('blossom'), glow: A.rect('blossom'), vine: A.rect('vine') },
      leafA: la, leafB: lb, glowC: gc, veinC: vc, bark: [0.06, 0.048, 0.045], glowFrac: 0.24,
    });
    const geo = gen.lod0.build();
    this.geo = geo;
    const mats = makePlantMaterials({
      shared: F.shared, barkLayer: 5, barkScale: 0.5, tint2: [0.08, 0.06, 0.05], transl: 1.0, glow: 5.0, cardGlow: 2.0, dayGlow: 0.14,
      moss: F.S.rock?.moss, mossAmt: 0.35, windAmp: 0.35, billboard: 0.8, fade: [0, 0, 1e9, 1e9], dfade: [0, 0, 2600, 3200], tintVar: 0.1,
      leafSoft: 0.55, dome: 0.6, standVar: 0,
    });
    this.mats = mats;
    const shadows = F.q.shadows !== false;
    const Ly = new InstanceLayer(geo, mats.material, mats.depth, { capacity: 1, parent: F.group, castShadow: shadows, name: 'flora-worldtree', boundsPad: gen.crownR * 1.2 });
    Ly.uniforms = mats.uniforms;
    // base sunk a little into the ground (the root arches bury their ends), up = planet normal, yawed
    const base = dir.clone().multiplyScalar(R + h - 1.5 * scale);
    _q.setFromUnitVectors(_up, dir);
    _yaw.setFromAxisAngle(_up, h01(seed, 3) * Math.PI * 2);
    _q.multiply(_yaw);
    Ly.begin(base.x, base.y, base.z);
    Ly.push(base.x, base.y, base.z, _q.x, _q.y, _q.z, _q.w, 1, 0.37, 0, 0.5, 0);
    Ly.end(1);
    Ly.mesh.frustumCulled = true;
    this.layer = Ly;
    F.layers.push(Ly);
    this.pos = base;
    this.site = { lat: site.lat, lon: site.lon, height: gen.height, crownR: gen.crownR };
    // trunk collider, wonder POI, and a clearing of the forest around the roots (grass and flowers stay)
    try { W.addCollider?.({ type: 'capsule', pos: base.clone(), radius: gen.trunkR, height: gen.forkY, tag: 'tree' }); } catch (_) { /* optional */ }
    try {
      const top = base.clone().addScaledVector(dir, gen.height * 0.6);
      W.addPOI?.({ kind: 'wonder', name: 'The World Tree', pos: top, radius: gen.crownR * 2.2, data: { flora: 'worldtree', sacred: true } });
    } catch (_) { /* ui optional */ }
    try { this.clearId = F.clearAround(base, gen.crownR * 0.75, 0.15, { grass: false }); } catch (_) { /* optional */ }
    return true;
  }

  getState() {
    return this.site ? { ...this.site, visible: !!this.layer?.mesh.visible } : null;
  }

  dispose() {
    this.geo?.dispose();
    this.mats?.material?.dispose?.(); this.mats?.depth?.dispose?.();
  }
}
