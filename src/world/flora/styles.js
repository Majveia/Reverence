// Art direction for vegetation. body.art.flora selects a style; colors come from the art palette
// so terrain, sky, flora and grade agree. Each style lists species per placement layer:
//   canopy (trees & big alien plants, far LOD + impostors) · under (bushes, ferns, reeds, props)
//   rock (boulders) · grass tiles (blades + flower patches, see grass.js)
// Biome ids (PlanetSurface.BIOMES): 0 ocean 1 beach 2 desert 3 savanna 4 grassland 5 forest
//   6 jungle 7 taiga 8 tundra 9 snow 10 rock 11 volcanic 12 crystal 13 toxic
import { hexLinear, mix3, scale3 } from './util.js';
import * as T from './geom/trees.js';
import * as PL from './geom/plants.js';
import * as AL from './geom/alien.js';
import { BARK } from './textures.js';

const B = { OCEAN: 0, BEACH: 1, DESERT: 2, SAVANNA: 3, GRASSLAND: 4, FOREST: 5, JUNGLE: 6, TAIGA: 7, TUNDRA: 8, SNOW: 9, ROCK: 10, VOLCANIC: 11, CRYSTAL: 12, TOXIC: 13 };
const bw = (o) => { const a = new Float32Array(14); for (const [k, v] of Object.entries(o)) a[B[k]] = v; return a; };

/** Resolve the vegetation style for a body. Returns null if the world is barren of plants. */
export function buildStyle(body, atlas) {
  const art = body.art || {};
  const pal = art.palette || {};
  const L = (h, d) => hexLinear(h || d || '#556b2f');
  const fl = (i) => L(pal.flora?.[i % Math.max(1, pal.flora?.length || 1)], pal.grass);
  const life = body.life?.flora ?? 0;
  let key = art.flora || 'lush';
  if (!(life > 0.05) && key !== 'none') key = 'barren';
  const R = (n) => atlas.rect(n);
  const rock = L(pal.rock), sand = L(pal.sand), grass = L(pal.grass), grass2 = L(pal.grass2), accent = L(pal.accent);
  const barkBrown = mix3(scale3(rock, 0.45), [0.09, 0.06, 0.035], 0.55);
  const darkBark = mix3(scale3(rock, 0.3), [0.05, 0.035, 0.02], 0.6);

  const S = {
    key, life: Math.max(0.35, life), palette: pal,
    canopy: { spacing: 5.8, cover: bw({ FOREST: 0.85, JUNGLE: 0.95, TAIGA: 0.8, GRASSLAND: 0.1, SAVANNA: 0.05, TUNDRA: 0.12, BEACH: 0.02 }), species: [] },
    under: { spacing: 2.7, cover: bw({ FOREST: 0.45, JUNGLE: 0.7, TAIGA: 0.35, GRASSLAND: 0.14, SAVANNA: 0.1, TUNDRA: 0.15, BEACH: 0.12, DESERT: 0.03 }), species: [] },
    rock: { spacing: 9, cover: bw({ ROCK: 0.5, TUNDRA: 0.3, DESERT: 0.12, SAVANNA: 0.1, GRASSLAND: 0.07, FOREST: 0.12, TAIGA: 0.2, SNOW: 0.2, BEACH: 0.1, JUNGLE: 0.05, VOLCANIC: 0.35, CRYSTAL: 0.2, TOXIC: 0.1 }), species: [], slopeBoost: 1.2 },
    grass: {
      density: 1, height: 0.55, cover: bw({ GRASSLAND: 1, SAVANNA: 0.95, FOREST: 0.55, JUNGLE: 0.75, TAIGA: 0.5, TUNDRA: 0.55, BEACH: 0.12, DESERT: 0.05, TOXIC: 0.6, CRYSTAL: 0.4 }),
      base: mix3(grass, [0.015, 0.035, 0.008], 0.3), tip: mix3(mix3(grass, grass2, 0.55), [0.75, 1, 0.45], 0.08), dry: mix3(sand, grass2, 0.4),
      dryAmount: 0.08, glowTip: null, flowers: [], widthMul: 1,
    },
    glow: 0, cardGlow: 0, windAmp: 1, translucency: 0.9,
  };
  S.grass.flowerRect = R('daisy');

  const add = (layer, sp) => { S[layer].species.push(sp); };
  const rocksDefault = (moss = 0.4, shapes = ['boulder', 'angular', 'boulder', 'slab']) => {
    S.rock.shapes = shapes;
    S.rock.colA = mix3(rock, [0.2, 0.2, 0.2], 0.2);
    S.rock.colB = mix3(rock, sand, 0.35);
    S.rock.moss = mix3(fl(0), grass, 0.4);
    S.rock.mossAmt = moss;
  };
  rocksDefault();

  // ------------------------------------------------------------------ common species factories
  const oak = (o = {}) => ({
    id: 'oak', layer: 'canopy', gen: T.broadleaf, variants: 3, collider: 'tree',
    
    barkLayer: BARK.furrow, tint2: [0.1, 0.07, 0.04],
    biomes: bw({ FOREST: 1, GRASSLAND: 0.8, SAVANNA: 0.35, JUNGLE: 0.5, TAIGA: 0.15 }), m: [0.3, 1.5], t: [0.25, 1.2], slope: 0.7, alt: [-0.01, 0.55],
    zone: 0, dens: 1, scale: [0.75, 1.3], lean: 0.05, sink: 0.35, ...o, params: { height: 13, crownR: 5.2, trunkR: 0.42, leafSize: 1.9, leafDensity: 6.5, fork: 0.72, rects: [R('broad'), R('broad2'), R('broad')], leafA: fl(0), leafB: fl(1), bark: barkBrown, gnarl: 0.3, ...o.params },
  });
  const conifer = (o = {}) => ({
    id: 'spruce', layer: 'canopy', gen: T.conifer, variants: 3, collider: 'tree',
    
    barkLayer: BARK.plates, tint2: [0.08, 0.06, 0.04], billboard: 0, windAmp: 0.8,
    biomes: bw({ TAIGA: 1, FOREST: 0.35, TUNDRA: 0.5, GRASSLAND: 0.08, SNOW: 0.15 }), m: [0.2, 1.5], t: [-0.1, 0.8], slope: 0.85, alt: [-0.01, 0.8],
    zone: 1, dens: 1, scale: [0.7, 1.3], lean: 0.02, sink: 0.4, ...o, params: { height: 20, trunkR: 0.35, branchLen: 3.8, whorlGap: 0.62, droop: 0.3, crownBase: 0.27, rect: R('needle'), leafA: fl(0), leafB: mix3(fl(0), fl(1), 0.6), bark: mix3(barkBrown, [0.12, 0.06, 0.035], 0.4), ...o.params },
  });
  const birch = (o = {}) => ({
    id: 'birch', layer: 'canopy', gen: T.slender, variants: 2, collider: 'tree',
    
    barkLayer: BARK.birch, tint2: [0.06, 0.05, 0.03], barkScale: 1,
    biomes: bw({ FOREST: 0.55, TAIGA: 0.5, GRASSLAND: 0.25, TUNDRA: 0.25 }), m: [0.3, 1.5], t: [0.05, 0.9], slope: 0.7, alt: [-0.01, 0.7],
    zone: 2, dens: 0.8, scale: [0.8, 1.2], lean: 0.06, sink: 0.3, ...o, params: { height: 15, trunkR: 0.2, crownR: 2.8, clumpR: 1.35, leafSize: 1.2, leafDensity: 9, rect: R('small'), leafA: mix3(fl(1), fl(2), 0.35), leafB: mix3(fl(2), [0.9, 0.85, 0.3], 0.25), bark: [0.62, 0.6, 0.55], ...o.params },
  });
  const bushSp = (o = {}) => ({
    id: 'bush', layer: 'under', gen: PL.bush, variants: 3,
    
    tint2: [0.08, 0.06, 0.03], billboard: 0.8,
    biomes: bw({ FOREST: 1, GRASSLAND: 0.7, JUNGLE: 1, SAVANNA: 0.35, TAIGA: 0.5, TUNDRA: 0.3 }), m: [0.25, 1.5], t: [0.1, 1.2], slope: 0.8, alt: [0, 0.6],
    zone: 0, dens: 1, scale: [0.6, 1.4], lean: 0.1, sink: 0.15, ...o, params: { radius: 1.0, rect: R('broad'), leafA: fl(0), leafB: fl(1), flowerRect: R('flowerball'), flowerA: fl(3), flowerB: accent, flowerChance: 0.2, leafSize: 0.95, ...o.params },
  });
  const fernSp = (o = {}) => ({
    id: 'fern', layer: 'under', gen: PL.fern, variants: 2,
    
    tint2: [0.06, 0.1, 0.03], billboard: 0,
    biomes: bw({ FOREST: 1, JUNGLE: 1, TAIGA: 0.8 }), m: [0.35, 1.5], t: [0.15, 1.2], slope: 0.9, alt: [0, 0.6],
    zone: 1, dens: 1.2, scale: [0.6, 1.3], lean: 0.1, sink: 0.05, ...o, params: { length: 1.1, rect: R('fern'), leafA: mix3(fl(0), fl(1), 0.3), leafB: fl(1), ...o.params },
  });
  const reedSp = (o = {}) => ({
    id: 'reeds', layer: 'under', gen: PL.reeds, variants: 2,
    
    tint2: [0.3, 0.28, 0.12], billboard: 0,
    biomes: bw({ BEACH: 1, GRASSLAND: 0.2, FOREST: 0.2, SAVANNA: 0.2, JUNGLE: 0.3 }), m: [0.2, 1.5], t: [0.1, 1.2], slope: 0.35, alt: [-0.01, 0.02],
    shore: 12, zone: -1, dens: 2.5, scale: [0.7, 1.3], lean: 0.08, sink: 0.1, ...o, params: { height: 1.6, rect: R('blades'), colA: mix3(fl(0), grass2, 0.4), colB: grass2, cattail: true, ...o.params },
  });
  const mossSp = (o = {}) => ({
    id: 'moss', layer: 'under', gen: PL.mossMound, variants: 2,
    
    tint2: [0.1, 0.12, 0.04], billboard: 0.6,
    biomes: bw({ FOREST: 1, TAIGA: 1, TUNDRA: 0.6, JUNGLE: 0.5 }), m: [0.35, 1.5], t: [0, 1], slope: 0.9, alt: [0, 0.7],
    zone: 2, dens: 0.8, scale: [0.6, 1.5], lean: 0.1, sink: 0.12, ...o, params: { radius: 0.9, rect: R('small'), colA: mix3(fl(0), grass, 0.5), colB: fl(1), ...o.params },
  });
  const shrubDry = (o = {}) => ({
    id: 'dryshrub', layer: 'under', gen: PL.reeds, variants: 2,
    
    tint2: scale3(barkBrown, 1.3), billboard: 0,
    biomes: bw({ DESERT: 1, SAVANNA: 0.7, TUNDRA: 0.4, ROCK: 0.3, BEACH: 0.3 }), m: [-0.5, 1.2], t: [0, 1.4], slope: 0.9, alt: [0, 0.8],
    zone: -1, dens: 0.8, scale: [0.6, 1.4], lean: 0.12, sink: 0.05, ...o, params: { height: 0.8, radius: 0.35, count: 3, widthRatio: 0.7, rect: R('twigs'), colA: mix3(rock, sand, 0.4), colB: sand, cattail: false, flex: 0.3, ...o.params },
  });

  // ------------------------------------------------------------------ styles
  switch (key) {
    case 'lush': {
      add('canopy', oak());
      add('canopy', oak({ id: 'autumn', variants: 2, params: { leafA: mix3(fl(2), fl(1), 0.25), leafB: fl(Math.min(3, (pal.flora?.length || 4) - 1)), height: 12, crownR: 4.8 }, biomes: bw({ FOREST: 0.2, GRASSLAND: 0.28, SAVANNA: 0.1 }), zone: 2, dens: 0.18 }));
      add('canopy', birch({ biomes: bw({ FOREST: 0.3, GRASSLAND: 0.2, TAIGA: 0.3 }), dens: 0.5 }));
      add('canopy', conifer({ params: { height: 19 }, biomes: bw({ TAIGA: 1, FOREST: 0.2, TUNDRA: 0.45, SNOW: 0.1 }), dens: 0.8 }));
      add('under', bushSp());
      add('under', fernSp());
      add('under', reedSp());
      S.grass.height = 0.62; S.grass.density = 1.1;
      S.grass.flowers = [
        { rect: R('daisy'), colA: [0.9, 0.88, 0.8], colB: [1, 1, 0.92], tint2: [0.85, 0.6, 0.08], type: 'daisy', freq: 1 },
        { rect: R('spike'), colA: fl(3), colB: accent, tint2: fl(1), type: 'spike', freq: 0.28, height: 0.5 },
        { rect: R('cup'), colA: mix3(accent, [1, 0.3, 0.2], 0.4), colB: fl(3), tint2: [0.06, 0.12, 0.03], type: 'cup', freq: 0.45 },
      ];
      rocksDefault(0.45);
      break;
    }
    case 'boreal': {
      add('canopy', conifer({ biomes: bw({ TAIGA: 1, FOREST: 1, TUNDRA: 0.55, GRASSLAND: 0.25, SAVANNA: 0.1, DESERT: 0.04, SNOW: 0.12 }), dens: 1.2, params: { height: 22 } }));
      add('canopy', conifer({ id: 'pine', variants: 2, params: { height: 24, rect: R('pine'), crownBase: 0.45, branchLen: 3.2, whorlGap: 0.9, gaps: 0.3, droop: 0.12, leafA: mix3(fl(0), fl(1), 0.5), leafB: fl(1) }, biomes: bw({ FOREST: 0.6, TAIGA: 0.5, GRASSLAND: 0.3, TUNDRA: 0.35, SAVANNA: 0.2, DESERT: 0.05 }), zone: 2, dens: 0.7 }));
      add('canopy', birch({ biomes: bw({ FOREST: 0.4, TAIGA: 0.3, GRASSLAND: 0.2, TUNDRA: 0.2 }), dens: 0.45 }));
      if ((pal.flora?.length || 0) > 2) add('canopy', oak({ id: 'ember', variants: 2, params: { leafA: fl(2), leafB: fl(3), height: 11, crownR: 4.2 }, biomes: bw({ FOREST: 0.15, GRASSLAND: 0.2, TAIGA: 0.08, TUNDRA: 0.05 }), dens: 0.3, zone: 1 }));
      add('under', fernSp({ dens: 1.4 }));
      add('under', mossSp());
      add('under', bushSp({ params: { radius: 0.8, flowerChance: 0.05 }, dens: 0.6 }));
      add('under', shrubDry({ dens: 0.5 }));
      S.canopy.cover = bw({ FOREST: 0.9, TAIGA: 0.92, TUNDRA: 0.35, GRASSLAND: 0.18, SAVANNA: 0.1, DESERT: 0.035, SNOW: 0.06, BEACH: 0.02 });
      S.grass.height = 0.62; S.grass.dryAmount = 0.22;
      S.grass.cover[B.DESERT] = 0.15; S.grass.cover[B.TUNDRA] = 0.65;
      S.grass.flowers = [{ rect: R('daisy'), colA: [0.92, 0.9, 0.85], colB: [1, 0.95, 0.75], tint2: [0.85, 0.65, 0.1], type: 'daisy', freq: 0.5 }];
      rocksDefault(0.35, ['boulder', 'boulder', 'angular', 'slab']);
      S.rock.cover[B.TUNDRA] = 0.4; S.rock.cover[B.TAIGA] = 0.25; S.rock.cover[B.DESERT] = 0.18;
      break;
    }
    case 'moss': {
      add('canopy', birch({ dens: 1, biomes: bw({ FOREST: 1, TAIGA: 0.7, GRASSLAND: 0.3, TUNDRA: 0.3, JUNGLE: 0.6 }) }));
      add('canopy', conifer({ dens: 0.8, params: { height: 17 } }));
      add('canopy', T.deadTree && { id: 'snag', layer: 'canopy', gen: T.deadTree, variants: 2, collider: 'tree', params: { height: 9, trunkR: 0.28, bark: [0.2, 0.19, 0.17], moss: mix3(fl(1), [0.5, 0.5, 0.4], 0.3), mossRect: R('vine') }, barkLayer: BARK.smooth, tint2: [0.2, 0.2, 0.15], billboard: 0,
        biomes: bw({ FOREST: 0.15, TAIGA: 0.2, TUNDRA: 0.2, GRASSLAND: 0.05 }), m: [0, 2], t: [-0.2, 1.5], slope: 0.8, alt: [0, 0.8], zone: -1, dens: 0.25, scale: [0.7, 1.3], lean: 0.15, sink: 0.3 });
      add('under', mossSp({ dens: 2 }));
      add('under', fernSp());
      add('under', reedSp());
      S.grass.height = 0.7; S.grass.dryAmount = 0.1;
      S.grass.flowers = [{ rect: R('daisy'), colA: [0.9, 0.9, 0.85], colB: [1, 1, 0.9], tint2: [0.8, 0.7, 0.2], type: 'daisy', freq: 0.35 }];
      rocksDefault(0.85);
      S.rock.cover = bw({ ROCK: 0.5, TUNDRA: 0.35, FOREST: 0.25, TAIGA: 0.3, GRASSLAND: 0.12, SNOW: 0.2, BEACH: 0.15, JUNGLE: 0.1 });
      break;
    }
    case 'giant': {
      add('canopy', { id: 'giant', layer: 'canopy', gen: T.giantTree, variants: 2, collider: 'tree',
        params: { height: 38, trunkR: 1.7, crownR: 13, leafSize: 3.4, leafDensity: 2.6, rects: [R('broad'), R('broad2')], leafA: fl(0), leafB: fl(1), bark: mix3(barkBrown, [0.25, 0.18, 0.12], 0.3), vines: true, vineRect: R('vine'), vineGlow: fl(3), vineLen: 1.2 },
        barkLayer: BARK.organic, tint2: fl(3), cardGlow: 2.2,
        biomes: bw({ JUNGLE: 1, FOREST: 1, GRASSLAND: 0.2, SAVANNA: 0.1 }), m: [0.3, 1.5], t: [0.2, 1.3], slope: 0.5, alt: [0, 0.5], zone: 0, dens: 0.18, scale: [0.8, 1.2], lean: 0.02, sink: 1.2 });
      add('canopy', oak({ params: { leafA: fl(0), leafB: fl(1), height: 15, crownR: 5.5 }, biomes: bw({ JUNGLE: 1, FOREST: 1, GRASSLAND: 0.5 }), dens: 1 }));
      add('canopy', { id: 'palm', layer: 'canopy', gen: T.palm, variants: 3, collider: 'tree', params: { height: 11, trunkR: 0.28, frondLen: 5.2, frondW: 1.3, rect: R('frond'), leafA: fl(1), leafB: fl(0), bark: mix3(barkBrown, sand, 0.3) },
        barkLayer: BARK.palm, tint2: [0.12, 0.1, 0.05], billboard: 0, biomes: bw({ BEACH: 0.8, JUNGLE: 0.6, GRASSLAND: 0.3, SAVANNA: 0.3 }), m: [0.2, 1.5], t: [0.4, 1.3], slope: 0.6, alt: [0, 0.3], zone: 1, dens: 0.6, scale: [0.8, 1.3], lean: 0.05, sink: 0.3 });
      add('under', { id: 'fronds', layer: 'under', gen: PL.alienFronds, variants: 3, params: { length: 1.6, rect: R('alienleaf'), colA: fl(1), colB: fl(4), bulb: fl(3) }, tint2: fl(3), cardGlow: 0.6, glow: 3,
        biomes: bw({ JUNGLE: 1, FOREST: 0.8, GRASSLAND: 0.3 }), m: [0.2, 1.5], t: [0.2, 1.3], slope: 0.8, alt: [0, 0.5], zone: 2, dens: 0.8, scale: [0.6, 1.4], lean: 0.08, sink: 0.05 });
      add('under', fernSp({ dens: 1.2 }));
      add('under', bushSp({ params: { flowerA: fl(2), flowerB: fl(4), flowerChance: 0.3 } }));
      S.canopy.cover = bw({ JUNGLE: 0.75, FOREST: 0.7, GRASSLAND: 0.12, SAVANNA: 0.06, BEACH: 0.08 });
      S.grass.height = 0.6; S.grass.glowTip = fl(3);
      S.grass.flowers = [{ rect: R('daisy'), colA: fl(2), colB: fl(4), tint2: fl(3), type: 'daisy', freq: 0.8, glow: 1.5 }];
      S.glow = 3.0;
      rocksDefault(0.5, ['boulder', 'layered', 'angular']);
      break;
    }
    case 'fungal': {
      const capA = fl(0), capB = fl(2), teal = fl(1), lav = fl(3), glowC = fl(4);
      add('canopy', { id: 'shroom', layer: 'canopy', gen: AL.giantMushroom, variants: 3, collider: 'tree',
        params: { height: 11, capR: 5.5, stemR: 0.6, capA, capB, stemA: mix3(capB, [0.5, 0.45, 0.35], 0.4), stemB: capB, gill: mix3(teal, glowC, 0.5), glow: true, spores: glowC, rings: true },
        glow: 2.6, tint2: glowC, billboard: 0, windAmp: 0.4,
        biomes: bw({ SAVANNA: 0.6, GRASSLAND: 0.8, FOREST: 1, JUNGLE: 1, TUNDRA: 0.2, DESERT: 0.1, TOXIC: 1 }), m: [0.1, 1.5], t: [0.05, 1.3], slope: 0.6, alt: [0, 0.6], zone: 0, dens: 1, scale: [0.6, 1.6], lean: 0.1, sink: 0.6 });
      add('canopy', { id: 'tower', layer: 'canopy', gen: AL.fungusTower, variants: 3, collider: 'tree',
        params: { height: 18, stemR: 0.9, shelfR: 3.2, capA: mix3(capA, teal, 0.3), capB: capB, stemA: mix3(teal, [0.3, 0.3, 0.25], 0.4), stemB: mix3(capA, teal, 0.5), gill: glowC, glow: true },
        glow: 2.2, tint2: glowC, billboard: 0, windAmp: 0.2,
        biomes: bw({ SAVANNA: 0.35, GRASSLAND: 0.5, FOREST: 0.8, JUNGLE: 0.8, TOXIC: 1, TUNDRA: 0.1 }), m: [0.1, 1.5], t: [0.05, 1.3], slope: 0.5, alt: [0, 0.6], zone: 1, dens: 0.6, scale: [0.7, 1.4], lean: 0.05, sink: 0.8 });
      add('canopy', { id: 'coral', layer: 'canopy', gen: AL.coralTree, variants: 2, collider: 'tree',
        params: { height: 7, trunkR: 0.3, colA: mix3(teal, [0.2, 0.2, 0.18], 0.4), colB: mix3(lav, capB, 0.4), tip: glowC, glow: true },
        glow: 2.4, tint2: glowC, billboard: 0, windAmp: 0.3,
        biomes: bw({ SAVANNA: 0.4, GRASSLAND: 0.4, FOREST: 0.5, JUNGLE: 0.5, DESERT: 0.1, TOXIC: 0.7 }), m: [0.05, 1.5], t: [0, 1.4], slope: 0.7, alt: [0, 0.7], zone: 2, dens: 0.5, scale: [0.7, 1.4], lean: 0.1, sink: 0.4 });
      add('under', { id: 'minishroom', layer: 'under', gen: PL.mushroomCluster, variants: 3, params: { height: 0.5, capR: 0.28, capA: capA, capB: lav, stem: capB, gill: glowC, glow: true }, glow: 2.5, tint2: glowC, billboard: 0,
        biomes: bw({ SAVANNA: 1, GRASSLAND: 1, FOREST: 1, JUNGLE: 1, TUNDRA: 0.4, DESERT: 0.2, TOXIC: 1 }), m: [0, 1.5], t: [0, 1.4], slope: 0.9, alt: [0, 0.7], zone: 0, dens: 1.2, scale: [0.6, 2.2], lean: 0.1, sink: 0.05 });
      add('under', { id: 'sporebulbs', layer: 'under', gen: PL.bulbs, variants: 2, params: { height: 1.1, bulbR: 0.14, colA: glowC, colB: lav, stem: mix3(teal, [0.2, 0.2, 0.1], 0.5) }, glow: 3.5, tint2: glowC, billboard: 0,
        biomes: bw({ SAVANNA: 0.6, GRASSLAND: 0.8, FOREST: 1, JUNGLE: 1, TOXIC: 1, TUNDRA: 0.2 }), m: [0, 1.5], t: [0, 1.4], slope: 0.9, alt: [0, 0.7], zone: 1, dens: 0.8, scale: [0.7, 1.6], lean: 0.1, sink: 0.05 });
      add('under', fernSp({ params: { leafA: mix3(teal, capA, 0.4), leafB: capA }, biomes: bw({ FOREST: 1, JUNGLE: 1, GRASSLAND: 0.4, SAVANNA: 0.3 }), dens: 0.8 }));
      S.canopy.cover = bw({ FOREST: 0.8, JUNGLE: 0.85, GRASSLAND: 0.32, SAVANNA: 0.26, TUNDRA: 0.08, DESERT: 0.05, TOXIC: 0.8, BEACH: 0.02 });
      S.under.cover = bw({ FOREST: 0.8, JUNGLE: 0.85, GRASSLAND: 0.45, SAVANNA: 0.35, TUNDRA: 0.15, DESERT: 0.08, TOXIC: 0.8 });
      S.grass.base = mix3(mix3(grass, teal, 0.35), [0.03, 0.04, 0.02], 0.35); S.grass.tip = mix3(mix3(grass2, capA, 0.4), teal, 0.2); S.grass.height = 0.72; S.grass.density = 1.25; S.grass.dryAmount = 0.02; S.grass.glowTip = glowC;
      S.grass.cover[B.DESERT] = 0.25; S.grass.cover[B.SAVANNA] = 1; S.grass.cover[B.FOREST] = 0.85; S.grass.cover[B.JUNGLE] = 0.9; S.grass.cover[B.GRASSLAND] = 1;
      S.grass.flowers = [{ rect: R('spores'), colA: glowC, colB: lav, tint2: [1, 1, 0.9], type: 'daisy', freq: 0.7, glow: 2.5 }];
      S.glow = 2.6;
      rocksDefault(0.3, ['boulder', 'layered', 'spire']);
      S.rock.colA = mix3(rock, capB, 0.25);
      break;
    }
    case 'crystal': {
      add('canopy', { id: 'crystal', layer: 'canopy', gen: AL.crystalCluster, variants: 4, collider: 'rock',
        params: { height: 7, radius: 0.55, spread: 1.6, colA: fl(0), colB: fl(1) }, glow: 1.8, tint2: fl(2), billboard: 0, windAmp: 0,
        biomes: bw({ CRYSTAL: 1, TUNDRA: 0.6, GRASSLAND: 0.5, SNOW: 0.4, ROCK: 0.5, SAVANNA: 0.3, DESERT: 0.3, FOREST: 0.5 }), m: [-0.5, 2], t: [-0.5, 2], slope: 1.2, alt: [0, 1], zone: 0, dens: 1, scale: [0.5, 1.8], lean: 0.15, sink: 0.5 });
      add('canopy', { id: 'crystaltree', layer: 'canopy', gen: AL.coralTree, variants: 2, collider: 'tree', params: { height: 8, trunkR: 0.28, colA: fl(4), colB: fl(3), tip: fl(1), glow: true },
        glow: 2.4, tint2: fl(1), billboard: 0, windAmp: 0.25, biomes: bw({ CRYSTAL: 0.6, GRASSLAND: 0.8, FOREST: 1, SAVANNA: 0.5, TUNDRA: 0.3 }), m: [0.1, 2], t: [-0.2, 2], slope: 0.7, alt: [0, 0.7], zone: 1, dens: 0.7, scale: [0.7, 1.3], lean: 0.08, sink: 0.4 });
      add('under', { id: 'shards', layer: 'under', gen: AL.crystalCluster, variants: 3, params: { height: 1.2, radius: 0.12, spread: 0.4, colA: fl(2), colB: fl(3) }, glow: 2, tint2: fl(2), billboard: 0, windAmp: 0,
        biomes: bw({ CRYSTAL: 1, TUNDRA: 0.7, GRASSLAND: 0.5, ROCK: 0.6, SNOW: 0.5, DESERT: 0.4, SAVANNA: 0.4, FOREST: 0.5 }), m: [-0.5, 2], t: [-0.5, 2], slope: 1.2, alt: [0, 1], zone: -1, dens: 1, scale: [0.5, 1.8], lean: 0.25, sink: 0.1 });
      add('under', { id: 'glowbulbs', layer: 'under', gen: PL.bulbs, variants: 2, params: { height: 0.8, bulbR: 0.1, colA: fl(1), colB: fl(4) }, glow: 3, tint2: fl(1), billboard: 0,
        biomes: bw({ GRASSLAND: 1, FOREST: 1, SAVANNA: 0.6, CRYSTAL: 0.4, TUNDRA: 0.3 }), m: [0, 2], t: [-0.3, 2], slope: 0.9, alt: [0, 0.7], zone: 2, dens: 0.8, scale: [0.6, 1.5], lean: 0.1, sink: 0.05 });
      S.canopy.cover = bw({ CRYSTAL: 0.4, GRASSLAND: 0.12, FOREST: 0.3, TUNDRA: 0.1, SAVANNA: 0.08, ROCK: 0.1, SNOW: 0.06, DESERT: 0.05 });
      S.grass.base = mix3(grass, [0.05, 0.04, 0.08], 0.4); S.grass.tip = mix3(grass2, [0.9, 0.9, 1], 0.3); S.grass.height = 0.35; S.grass.glowTip = fl(1);
      S.grass.flowers = [{ rect: R('daisy'), colA: fl(0), colB: fl(3), tint2: fl(1), type: 'daisy', freq: 0.6, glow: 1 }];
      S.glow = 2;
      rocksDefault(0.1, ['angular', 'spire', 'angular']);
      break;
    }
    case 'bioluminescent': {
      const cyan = fl(0), mag = fl(1), blue = fl(2), dark = fl(3);
      add('canopy', oak({ params: { leafA: mix3(dark, [0.01, 0.03, 0.03], 0.3), leafB: dark, height: 12, crownR: 4.6 }, tint2: cyan, cardGlow: 0, biomes: bw({ FOREST: 1, GRASSLAND: 0.6, JUNGLE: 1, SAVANNA: 0.3 }), dens: 0.8 }));
      add('canopy', { id: 'lanterntree', layer: 'canopy', gen: AL.lanternTree, variants: 3, collider: 'tree', params: { height: 8.5, trunkR: 0.3, bulbR: 0.36, colA: cyan, colB: mix3(cyan, blue, 0.6), trunk: mix3(dark, [0.06, 0.05, 0.07], 0.5), leafA: mix3(dark, [0.01, 0.04, 0.04], 0.4), leafB: mix3(dark, blue, 0.25), rect: R('broad') },
        glow: 2.2, cardGlow: 0.35, tint2: cyan, billboard: 0.8, windAmp: 0.7, biomes: bw({ FOREST: 0.7, GRASSLAND: 0.8, JUNGLE: 0.8, SAVANNA: 0.4 }), m: [0.1, 1.5], t: [0.1, 1.3], slope: 0.7, alt: [0, 0.6], zone: 1, dens: 0.55, scale: [0.75, 1.3], lean: 0.08, sink: 0.3 });
      add('canopy', { id: 'glowshroom', layer: 'canopy', gen: AL.giantMushroom, variants: 2, collider: 'tree', params: { height: 6, capR: 3, stemR: 0.3, capA: mix3(dark, mag, 0.25), capB: mag, stemA: [0.08, 0.07, 0.1], stemB: mix3(mag, [0.1, 0.1, 0.1], 0.6), gill: mag, glow: true, spores: cyan },
        glow: 2.4, tint2: mag, billboard: 0, windAmp: 0.3, biomes: bw({ FOREST: 0.5, JUNGLE: 0.6, GRASSLAND: 0.3, TOXIC: 1 }), m: [0.1, 1.5], t: [0, 1.4], slope: 0.6, alt: [0, 0.6], zone: 2, dens: 0.35, scale: [0.7, 1.5], lean: 0.1, sink: 0.4 });
      add('under', { id: 'bulbs', layer: 'under', gen: PL.bulbs, variants: 3, params: { height: 0.9, bulbR: 0.11, colA: cyan, colB: mag }, glow: 2.8, tint2: cyan, billboard: 0,
        biomes: bw({ FOREST: 1, GRASSLAND: 1, JUNGLE: 1, SAVANNA: 0.6, TOXIC: 1, BEACH: 0.3 }), m: [0, 1.5], t: [0, 1.4], slope: 0.9, alt: [0, 0.7], zone: 0, dens: 1.3, scale: [0.6, 1.5], lean: 0.1, sink: 0.05 });
      add('under', { id: 'fronds', layer: 'under', gen: PL.alienFronds, variants: 2, params: { length: 1.3, rect: R('alienleaf'), colA: dark, colB: mix3(dark, blue, 0.4) }, tint2: cyan, cardGlow: 1.6,
        biomes: bw({ FOREST: 1, JUNGLE: 1, GRASSLAND: 0.4 }), m: [0.1, 1.5], t: [0, 1.4], slope: 0.8, alt: [0, 0.6], zone: 1, dens: 0.8, scale: [0.6, 1.3], lean: 0.08, sink: 0.05 });
      add('under', reedSp({ params: { colA: dark, colB: mix3(dark, cyan, 0.2) }, tint2: cyan }));
      S.grass.base = mix3(grass, [0.01, 0.02, 0.02], 0.5); S.grass.tip = mix3(grass2, cyan, 0.15); S.grass.glowTip = cyan; S.grass.height = 0.5;
      S.grass.flowers = [{ rect: R('spores'), colA: cyan, colB: mag, tint2: [1, 1, 1], type: 'daisy', freq: 0.6, glow: 3 }];
      S.glow = 3.2;
      rocksDefault(0.2);
      break;
    }
    case 'wacky': {
      const cols = [0, 1, 2, 3, 4].map(fl);
      add('canopy', { id: 'lollipop', layer: 'canopy', gen: AL.lollipopTree, variants: 4, collider: 'tree', params: { height: 7, trunkR: 0.32, crownR: 3.2, colA: cols[0], colB: cols[4], trunk: mix3(cols[3], [0.9, 0.8, 0.6], 0.3) },
        glow: 0.6, tint2: cols[1], billboard: 0, windAmp: 0.5, biomes: bw({ JUNGLE: 1, FOREST: 1, GRASSLAND: 0.5, SAVANNA: 0.3, BEACH: 0.1 }), m: [0.1, 1.6], t: [0.1, 1.4], slope: 0.7, alt: [0, 0.6], zone: 0, dens: 0.8, scale: [0.7, 1.5], lean: 0.12, sink: 0.3 });
      add('canopy', { id: 'balloon', layer: 'canopy', gen: AL.balloonTree, variants: 3, collider: 'tree', params: { height: 9, trunkR: 0.3, colA: cols[1], colB: cols[3], trunk: mix3(cols[4], [0.2, 0.1, 0.25], 0.5), bulbPattern: 3 },
        glow: 1.2, tint2: cols[2], billboard: 0, windAmp: 0.6, biomes: bw({ JUNGLE: 1, FOREST: 0.8, GRASSLAND: 0.4 }), m: [0.1, 1.6], t: [0.1, 1.4], slope: 0.7, alt: [0, 0.6], zone: 1, dens: 0.6, scale: [0.7, 1.4], lean: 0.1, sink: 0.3 });
      add('canopy', { id: 'palm', layer: 'canopy', gen: T.palm, variants: 3, collider: 'tree', params: { height: 10, trunkR: 0.26, frondLen: 4.6, frondW: 1.2, rect: R('frond'), leafA: cols[2], leafB: mix3(cols[2], cols[1], 0.4), bark: mix3(cols[4], [0.3, 0.2, 0.3], 0.5), fruit: cols[0] },
        barkLayer: BARK.palm, tint2: cols[3], billboard: 0, biomes: bw({ JUNGLE: 0.9, FOREST: 0.6, BEACH: 1, GRASSLAND: 0.4, SAVANNA: 0.4 }), m: [0.1, 1.6], t: [0.1, 1.4], slope: 0.6, alt: [0, 0.5], zone: 2, dens: 0.8, scale: [0.8, 1.3], lean: 0.06, sink: 0.3 });
      add('canopy', { id: 'shroom', layer: 'canopy', gen: AL.giantMushroom, variants: 2, collider: 'tree', params: { height: 8, capR: 4, stemR: 0.5, capA: cols[0], capB: cols[3], stemA: [0.9, 0.85, 0.75], stemB: cols[1], gill: cols[4], glow: true, pattern: 3 },
        glow: 1.4, tint2: cols[4], billboard: 0, windAmp: 0.3, biomes: bw({ JUNGLE: 0.5, FOREST: 0.7, GRASSLAND: 0.3 }), m: [0.1, 1.6], t: [0, 1.4], slope: 0.6, alt: [0, 0.6], zone: 0, dens: 0.35, scale: [0.7, 1.5], lean: 0.1, sink: 0.4 });
      add('under', { id: 'tentacle', layer: 'under', gen: AL.tentaclePlant, variants: 3, params: { height: 2.2, radius: 0.8, thick: 0.12, colA: cols[4], colB: cols[0] }, tint2: cols[3], billboard: 0, windAmp: 0.6,
        biomes: bw({ JUNGLE: 1, FOREST: 1, GRASSLAND: 0.5, SAVANNA: 0.3 }), m: [0.1, 1.6], t: [0, 1.4], slope: 0.8, alt: [0, 0.6], zone: 1, dens: 0.7, scale: [0.6, 1.5], lean: 0.1, sink: 0.1 });
      add('under', { id: 'eyestalk', layer: 'under', gen: AL.eyeStalk, variants: 3, params: { height: 1.6, eyeR: 0.22, stalk: mix3(cols[2], [0.2, 0.3, 0.1], 0.4), iris: cols[1] }, tint2: cols[1], billboard: 0, windAmp: 0.8,
        biomes: bw({ JUNGLE: 1, FOREST: 0.8, GRASSLAND: 0.6, SAVANNA: 0.3 }), m: [0.1, 1.6], t: [0, 1.4], slope: 0.8, alt: [0, 0.6], zone: 2, dens: 0.45, scale: [0.6, 1.6], lean: 0.12, sink: 0.05 });
      add('under', bushSp({ params: { leafA: cols[2], leafB: mix3(cols[2], [1, 1, 0.4], 0.3), flowerA: cols[0], flowerB: cols[4], flowerChance: 0.45 } }));
      add('under', { id: 'fronds', layer: 'under', gen: PL.alienFronds, variants: 2, params: { length: 1.5, rect: R('alienleaf'), colA: cols[1], colB: cols[4], bulb: cols[3] }, tint2: [1, 1, 1], glow: 1.5,
        biomes: bw({ JUNGLE: 1, FOREST: 0.8, GRASSLAND: 0.3 }), m: [0.1, 1.6], t: [0, 1.4], slope: 0.8, alt: [0, 0.6], zone: 0, dens: 0.8, scale: [0.6, 1.4], lean: 0.08, sink: 0.05 });
      S.canopy.cover = bw({ JUNGLE: 0.7, FOREST: 0.65, GRASSLAND: 0.12, SAVANNA: 0.06, BEACH: 0.05 });
      S.grass.base = mix3(grass, [0.02, 0.05, 0.01], 0.35); S.grass.tip = mix3(grass2, [1, 1, 0.5], 0.15); S.grass.height = 0.55;
      S.grass.cover[B.FOREST] = 0.85; S.grass.cover[B.JUNGLE] = 0.9;
      S.grass.flowers = [
        { rect: R('daisy'), colA: cols[0], colB: cols[4], tint2: cols[3], type: 'daisy', freq: 1 },
        { rect: R('cup'), colA: cols[1], colB: cols[3], tint2: [0.1, 0.3, 0.05], type: 'cup', freq: 0.6 },
      ];
      rocksDefault(0.3, ['boulder', 'boulder', 'layered']);
      S.rock.colA = mix3(rock, cols[4], 0.2);
      break;
    }
    case 'alien': {
      const cols = [0, 1, 2, 3, 4].map(fl);
      add('canopy', { id: 'palm', layer: 'canopy', gen: T.palm, variants: 3, collider: 'tree', params: { height: 12, trunkR: 0.3, frondLen: 5.5, frondW: 1.4, rect: R('frond'), leafA: cols[2], leafB: cols[3], bark: mix3(rock, [0.2, 0.1, 0.1], 0.4) },
        barkLayer: BARK.palm, tint2: cols[1], billboard: 0, biomes: bw({ JUNGLE: 1, FOREST: 0.6, GRASSLAND: 0.4, SAVANNA: 0.3, BEACH: 0.8 }), m: [0.1, 1.6], t: [0.2, 1.4], slope: 0.6, alt: [0, 0.5], zone: 0, dens: 0.9, scale: [0.8, 1.3], lean: 0.05, sink: 0.3 });
      add('canopy', oak({ id: 'bloom', params: { leafA: cols[0], leafB: cols[1], height: 11, crownR: 4.8, rects: [R('broad2'), R('broad')] }, biomes: bw({ FOREST: 1, JUNGLE: 0.8, GRASSLAND: 0.6, SAVANNA: 0.35 }), zone: 1, dens: 0.8 }));
      add('canopy', { id: 'coral', layer: 'canopy', gen: AL.coralTree, variants: 3, collider: 'tree', params: { height: 8, trunkR: 0.32, colA: mix3(cols[4], [0.1, 0.05, 0.1], 0.4), colB: cols[4], tip: cols[1], glow: true },
        glow: 1.8, tint2: cols[1], billboard: 0, windAmp: 0.3, biomes: bw({ SAVANNA: 0.8, DESERT: 0.3, GRASSLAND: 0.5, FOREST: 0.3, JUNGLE: 0.3 }), m: [0, 1.6], t: [0, 1.5], slope: 0.7, alt: [0, 0.7], zone: 2, dens: 0.5, scale: [0.7, 1.4], lean: 0.1, sink: 0.4 });
      add('under', { id: 'fronds', layer: 'under', gen: PL.alienFronds, variants: 3, params: { length: 1.4, rect: R('alienleaf'), colA: cols[3], colB: cols[2], bulb: cols[1] }, tint2: [1, 0.9, 0.6], glow: 2,
        biomes: bw({ JUNGLE: 1, FOREST: 1, GRASSLAND: 0.6, SAVANNA: 0.4 }), m: [0.05, 1.6], t: [0, 1.5], slope: 0.8, alt: [0, 0.6], zone: 0, dens: 1, scale: [0.6, 1.5], lean: 0.08, sink: 0.05 });
      add('under', { id: 'bulbs', layer: 'under', gen: PL.bulbs, variants: 2, params: { height: 1.0, bulbR: 0.13, colA: cols[1], colB: cols[4] }, glow: 2.6, tint2: cols[1], billboard: 0,
        biomes: bw({ GRASSLAND: 1, SAVANNA: 1, FOREST: 0.6, JUNGLE: 0.6, DESERT: 0.3 }), m: [0, 1.6], t: [0, 1.5], slope: 0.9, alt: [0, 0.7], zone: 1, dens: 0.8, scale: [0.6, 1.5], lean: 0.1, sink: 0.05 });
      add('under', bushSp({ params: { leafA: cols[0], leafB: cols[2], flowerA: cols[4], flowerB: cols[1], flowerChance: 0.35 } }));
      S.grass.base = mix3(grass, [0.05, 0.02, 0.01], 0.4); S.grass.tip = mix3(grass2, [1, 0.9, 0.6], 0.2); S.grass.height = 0.6;
      S.grass.cover[B.DESERT] = 0.2; S.grass.cover[B.SAVANNA] = 1;
      S.grass.flowers = [
        { rect: R('daisy'), colA: cols[4], colB: cols[3], tint2: cols[1], type: 'daisy', freq: 1 },
        { rect: R('spike'), colA: cols[0], colB: cols[4], tint2: cols[2], type: 'spike', freq: 0.5, height: 0.7 },
      ];
      S.glow = 2;
      rocksDefault(0.25, ['boulder', 'angular', 'layered']);
      S.rock.colA = mix3(rock, [0.3, 0.1, 0.15], 0.2);
      break;
    }
    case 'sparse-alien': {
      const cols = [0, 1, 2, 3].map(fl);
      add('canopy', { id: 'umbrella', layer: 'canopy', gen: T.umbrella, variants: 3, collider: 'tree', params: { height: 9, trunkR: 0.32, crownR: 5.5, clumpR: 2, leafSize: 1.6, leafDensity: 6, rect: R('small'), leafA: cols[1], leafB: cols[2], bark: mix3(rock, [0.9, 0.85, 0.8], 0.4) },
        barkLayer: BARK.smooth, tint2: cols[0], biomes: bw({ SAVANNA: 1, GRASSLAND: 1, FOREST: 1, DESERT: 0.15, JUNGLE: 0.8 }), m: [0, 1.6], t: [0.1, 1.5], slope: 0.6, alt: [0, 0.6], zone: 0, dens: 1, scale: [0.7, 1.4], lean: 0.06, sink: 0.3 });
      add('canopy', { id: 'coral', layer: 'canopy', gen: AL.coralTree, variants: 2, collider: 'tree', params: { height: 6, trunkR: 0.28, colA: mix3(cols[0], [0.9, 0.85, 0.8], 0.3), colB: cols[0], tip: cols[3] },
        glow: 0.8, tint2: cols[3], billboard: 0, windAmp: 0.2, biomes: bw({ SAVANNA: 0.6, DESERT: 0.3, GRASSLAND: 0.4, FOREST: 0.3 }), m: [-0.5, 1.6], t: [0, 1.5], slope: 0.7, alt: [0, 0.7], zone: 1, dens: 0.5, scale: [0.7, 1.4], lean: 0.1, sink: 0.4 });
      add('under', { id: 'bulbs', layer: 'under', gen: PL.bulbs, variants: 2, params: { height: 1.2, bulbR: 0.16, colA: cols[3], colB: cols[0] }, glow: 1.2, tint2: cols[3], billboard: 0,
        biomes: bw({ SAVANNA: 1, GRASSLAND: 1, DESERT: 0.4, FOREST: 0.6 }), m: [-0.5, 1.6], t: [0, 1.5], slope: 0.9, alt: [0, 0.7], zone: 1, dens: 0.8, scale: [0.6, 1.5], lean: 0.1, sink: 0.05 });
      add('under', shrubDry({ dens: 0.8 }));
      add('under', { id: 'cactus', layer: 'under', gen: PL.cactus, variants: 3, params: { height: 2.2, radius: 0.2, color: mix3(cols[1], [0.2, 0.3, 0.2], 0.3), flower: cols[0] }, tint2: [1, 1, 1], billboard: 0, windAmp: 0,
        biomes: bw({ DESERT: 1, SAVANNA: 0.3 }), m: [-1, 0.6], t: [0.3, 2], slope: 0.6, alt: [0, 0.7], zone: -1, dens: 0.5, scale: [0.6, 1.6], lean: 0.05, sink: 0.2, collider: 'rock' });
      S.canopy.cover = bw({ SAVANNA: 0.1, GRASSLAND: 0.18, FOREST: 0.55, JUNGLE: 0.6, DESERT: 0.02, BEACH: 0.02 });
      S.grass.height = 0.5; S.grass.dryAmount = 0.35; S.grass.tip = mix3(grass2, [1, 0.9, 0.8], 0.2);
      S.grass.flowers = [{ rect: R('daisy'), colA: cols[0], colB: cols[3], tint2: cols[2], type: 'daisy', freq: 0.6 }];
      rocksDefault(0.1, ['spire', 'boulder', 'layered', 'spire']);
      S.rock.colA = mix3(rock, [0.9, 0.85, 0.8], 0.35); S.rock.colB = mix3(rock, sand, 0.5);
      S.rock.cover = bw({ SAVANNA: 0.18, DESERT: 0.22, GRASSLAND: 0.1, ROCK: 0.5, FOREST: 0.1, BEACH: 0.12 });
      break;
    }
    case 'sparse': {
      add('canopy', { id: 'acacia', layer: 'canopy', gen: T.umbrella, variants: 3, collider: 'tree', params: { height: 7.5, trunkR: 0.28, crownR: 4.6, clumpR: 1.6, leafSize: 1.3, leafDensity: 6.5, rect: R('small'), leafA: fl(0), leafB: fl(1), bark: darkBark },
        barkLayer: BARK.furrow, tint2: [0.08, 0.06, 0.04], biomes: bw({ SAVANNA: 1, GRASSLAND: 1, FOREST: 1, DESERT: 0.15, TUNDRA: 0.1, JUNGLE: 0.8 }), m: [0, 1.6], t: [0.1, 1.5], slope: 0.6, alt: [0, 0.6], zone: 0, dens: 1, scale: [0.7, 1.4], lean: 0.08, sink: 0.3 });
      add('canopy', { id: 'snag', layer: 'canopy', gen: T.deadTree, variants: 2, collider: 'tree', params: { height: 7, trunkR: 0.25, bark: mix3(rock, sand, 0.4) }, barkLayer: BARK.smooth, tint2: [0.2, 0.18, 0.15], billboard: 0,
        biomes: bw({ DESERT: 0.4, SAVANNA: 0.3, TUNDRA: 0.4, ROCK: 0.2 }), m: [-1, 2], t: [-0.5, 2], slope: 0.8, alt: [0, 0.8], zone: -1, dens: 0.4, scale: [0.7, 1.3], lean: 0.15, sink: 0.3 });
      add('under', shrubDry({ dens: 1.2 }));
      add('under', { id: 'cactus', layer: 'under', gen: PL.cactus, variants: 3, params: { height: 2.6, radius: 0.22, color: mix3(fl(0), [0.15, 0.25, 0.12], 0.4), flower: accent }, tint2: [1, 1, 1], billboard: 0, windAmp: 0,
        biomes: bw({ DESERT: 1, SAVANNA: 0.35 }), m: [-1, 0.6], t: [0.3, 2], slope: 0.6, alt: [0, 0.7], zone: -1, dens: 0.45, scale: [0.6, 1.6], lean: 0.05, sink: 0.2, collider: 'rock' });
      add('under', bushSp({ params: { radius: 0.7, flowerChance: 0.05, leafA: fl(0), leafB: fl(1) }, biomes: bw({ SAVANNA: 0.6, GRASSLAND: 0.8, FOREST: 1 }), dens: 0.6 }));
      S.canopy.cover = bw({ SAVANNA: 0.07, GRASSLAND: 0.12, FOREST: 0.45, JUNGLE: 0.5, DESERT: 0.012, TUNDRA: 0.02, BEACH: 0.01 });
      S.grass.height = 0.42; S.grass.dryAmount = 0.55; S.grass.cover[B.DESERT] = 0.12; S.grass.cover[B.SAVANNA] = 0.8;
      S.grass.tip = mix3(grass2, sand, 0.4);
      rocksDefault(0.08, ['boulder', 'angular', 'layered', 'slab']);
      S.rock.cover = bw({ DESERT: 0.25, SAVANNA: 0.18, ROCK: 0.5, GRASSLAND: 0.1, TUNDRA: 0.3, BEACH: 0.12, VOLCANIC: 0.35 });
      break;
    }
    case 'dead': {
      add('canopy', { id: 'deadtree', layer: 'canopy', gen: T.deadTree, variants: 4, collider: 'tree', params: { height: 11, trunkR: 0.35, bark: mix3(sand, [0.6, 0.55, 0.5], 0.3) }, barkLayer: BARK.smooth, tint2: [0.2, 0.18, 0.15], billboard: 0, windAmp: 0.4,
        biomes: bw({ DESERT: 0.4, SAVANNA: 0.8, GRASSLAND: 1, FOREST: 1, TUNDRA: 0.5, VOLCANIC: 0.3, ROCK: 0.2, TOXIC: 0.6, JUNGLE: 1 }), m: [-1, 2], t: [-0.5, 2], slope: 0.8, alt: [0, 0.8], zone: 0, dens: 1, scale: [0.6, 1.5], lean: 0.15, sink: 0.3 });
      add('under', shrubDry({ dens: 1.5, biomes: bw({ DESERT: 1, SAVANNA: 1, GRASSLAND: 1, FOREST: 1, TUNDRA: 0.6, VOLCANIC: 0.4, TOXIC: 0.6, JUNGLE: 1 }) }));
      S.canopy.cover = bw({ FOREST: 0.35, JUNGLE: 0.4, GRASSLAND: 0.1, SAVANNA: 0.06, DESERT: 0.03, TUNDRA: 0.05, VOLCANIC: 0.03, TOXIC: 0.15 });
      S.grass.height = 0.35; S.grass.dryAmount = 0.85; S.grass.density = 0.6;
      rocksDefault(0.05, ['angular', 'spire', 'layered']);
      break;
    }
    default: {
      // 'none' / 'barren': rocks only
      S.canopy.species = []; S.under.species = [];
      S.grass.cover = new Float32Array(14);
      rocksDefault(0, ['boulder', 'angular', 'slab', 'layered']);
      S.rock.cover = bw({ DESERT: 0.3, ROCK: 0.5, SAVANNA: 0.2, TUNDRA: 0.3, SNOW: 0.2, VOLCANIC: 0.4, GRASSLAND: 0.15, CRYSTAL: 0.3, TOXIC: 0.2, BEACH: 0.1 });
      break;
    }
  }
  // grass tint for the flower layer and rock species list
  S.rock.species = [{ id: 'rocks', layer: 'rock', rock: true, biomes: S.rock.cover, m: [-5, 5], t: [-5, 5], slope: 3, alt: [-0.02, 1.2], zone: -1, dens: 1, scale: [0.3, 2.8], lean: 0.35, sink: 0.25, collider: 'rock' }];
  for (const L2 of ['canopy', 'under']) S[L2].species = S[L2].species.filter(Boolean);
  return S;
}
