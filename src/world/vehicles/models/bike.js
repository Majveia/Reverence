// Hoverbike model — "flow-state king": long, low speeder (Star Wars speeder × Master Cycle × Akira).
// Object space: +Z forward, +Y up, +X right; origin ≈ center of mass, ~1 m above the ground.
// Returns { root, body, glow, decals, sprites, rider, vanes: [L, R], anchors }.
import * as THREE from 'three';
import { Builder, loft, rbox, bcyl, lathe, extrude, tube, slats, T } from '../geom.js';
import { SpriteBatch } from '../fx/glow.js';
import { buildRider } from './rider.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export function buildBike(mats, liv, opts = {}) {
  const b = new Builder();
  const P = liv.primary, S = liv.secondary, A = liv.accent, TR = liv.trim;
  const glow = liv.glow;
  const hot = [glow[0] * 3, glow[1] * 3, glow[2] * 3];

  // ---------------------------------------------------------------- main hull
  const hull = loft([
    { z: -1.32, w: 0.06, ht: 0.07, hb: 0.07, y: 0.06, n: 2.4 },
    { z: -1.2, w: 0.2, ht: 0.15, hb: 0.14, y: 0.05, n: 2.6 },
    { z: -0.95, w: 0.29, ht: 0.2, hb: 0.2, y: 0.05, n: 2.8 },
    { z: -0.6, w: 0.3, ht: 0.17, hb: 0.23, y: 0.03, n: 2.8 },
    { z: -0.2, w: 0.29, ht: 0.19, hb: 0.25, y: 0.03, n: 2.8 },
    { z: 0.2, w: 0.27, ht: 0.3, hb: 0.23, y: 0.06, n: 2.6 },
    { z: 0.55, w: 0.22, ht: 0.27, hb: 0.2, y: 0.06, n: 2.5 },
    { z: 0.85, w: 0.15, ht: 0.17, hb: 0.14, y: 0.03, n: 2.4 },
    { z: 1.05, w: 0.07, ht: 0.07, hb: 0.07, y: 0.0, n: 2.2 },
    { z: 1.12, w: 0.012, ht: 0.012, hb: 0.012, y: 0.0, n: 2.0 },
  ], { radial: 44, along: 64, capStart: true, capEnd: false });
  b.add(hull.geometry, 'paint', P);

  // spine ridge / tank cover (secondary color) over the top of the front half
  const tank = loft([
    { z: -0.05, w: 0.02, ht: 0.02, hb: 0.02, y: 0.2, n: 2 },
    { z: 0.05, w: 0.19, ht: 0.08, hb: 0.06, y: 0.26, n: 3.2 },
    { z: 0.35, w: 0.2, ht: 0.11, hb: 0.06, y: 0.3, n: 3.2 },
    { z: 0.62, w: 0.16, ht: 0.08, hb: 0.06, y: 0.26, n: 3.0 },
    { z: 0.8, w: 0.1, ht: 0.05, hb: 0.05, y: 0.18, n: 2.6 },
    { z: 0.9, w: 0.02, ht: 0.02, hb: 0.02, y: 0.13, n: 2 },
  ], { radial: 36, along: 32 });
  b.add(tank.geometry, 'paint', S);
  // accent racing stripe on the tank (thin raised band)
  const stripe = loft([
    { z: 0.0, w: 0.001, ht: 0.001, hb: 0.001, y: 0.29, n: 2 },
    { z: 0.08, w: 0.045, ht: 0.084, hb: 0.03, y: 0.265, n: 3.2 },
    { z: 0.35, w: 0.05, ht: 0.114, hb: 0.03, y: 0.305, n: 3.2 },
    { z: 0.62, w: 0.04, ht: 0.084, hb: 0.03, y: 0.265, n: 3.0 },
    { z: 0.84, w: 0.001, ht: 0.001, hb: 0.001, y: 0.17, n: 2 },
  ], { radial: 16, along: 24 });
  b.add(stripe.geometry, 'paint', A);

  // belly keel (dark), houses repulsors
  const keel = loft([
    { z: -1.05, w: 0.05, ht: 0.05, hb: 0.03, y: -0.17, n: 2.5 },
    { z: -0.9, w: 0.2, ht: 0.08, hb: 0.07, y: -0.2, n: 3.5 },
    { z: 0.0, w: 0.2, ht: 0.08, hb: 0.08, y: -0.22, n: 3.5 },
    { z: 0.7, w: 0.17, ht: 0.07, hb: 0.07, y: -0.18, n: 3.5 },
    { z: 0.9, w: 0.04, ht: 0.04, hb: 0.03, y: -0.13, n: 2.5 },
  ], { radial: 28, along: 28 });
  b.add(keel.geometry, 'gunmetal', TR);

  // seat (quilted leather)
  const seat = loft([
    { z: -0.86, w: 0.05, ht: 0.03, hb: 0.03, y: 0.2, n: 2.5 },
    { z: -0.78, w: 0.17, ht: 0.07, hb: 0.03, y: 0.21, n: 3.4 },
    { z: -0.45, w: 0.2, ht: 0.07, hb: 0.03, y: 0.2, n: 3.6 },
    { z: -0.12, w: 0.18, ht: 0.075, hb: 0.03, y: 0.22, n: 3.4 },
    { z: 0.0, w: 0.1, ht: 0.05, hb: 0.03, y: 0.23, n: 2.8 },
    { z: 0.04, w: 0.02, ht: 0.02, hb: 0.02, y: 0.23, n: 2 },
  ], { radial: 28, along: 24 });
  b.add(seat.geometry, 'leather', '#2c2520');
  // seat cowl behind the rider
  b.add(rbox(0.26, 0.1, 0.16, 0.04, 3), 'paint', S, T([0, 0.28, -0.93], [0.35, 0, 0]));

  // ---------------------------------------------------------------- side fairings (profile extrusions)
  const fairing = [
    [-0.72, -0.06], [-0.55, -0.16], [-0.1, -0.2], [0.35, -0.16], [0.72, -0.06], [0.84, 0.03], [0.62, 0.1], [0.2, 0.12], [-0.25, 0.08], [-0.6, 0.05],
  ];
  for (const s of [-1, 1]) {
    const g = extrude(fairing, 0.035, 0.012);
    // profile in (z, y) → place in the XZ side plane: extrude along X
    // makeRotationY(-90°) maps profile X → +Z (forward), extrusion Z → X (thickness)
    const m = new THREE.Matrix4().makeRotationY(-Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(0.285 * s, 0.0, 0.0));
    b.add(g, 'paint', S, m);
    // dark vent grille recessed in the fairing
    const sl = slats(0.26, 0.1, 5, 0.02);
    b.add(sl, 'darkMetal', '#1c1d1f', new THREE.Matrix4().makeRotationY(Math.PI / 2 * s).premultiply(new THREE.Matrix4().makeTranslation(0.305 * s, -0.04, 0.22)));
    // accent light strip along the fairing edge
    b.glow(rbox(0.012, 0.012, 0.9, 0.004, 1), hot, 4, T([0.306 * s, -0.14, 0.05], [0.06, 0, 0]));
    // foot pegs + heel guards
    b.add(rbox(0.12, 0.035, 0.06, 0.012, 2), 'darkMetal', '#2a2b2d', T([0.36 * s, -0.12, -0.28]));
    b.add(rbox(0.02, 0.1, 0.12, 0.008, 1), 'metal', '#8a8d92', T([0.33 * s, -0.08, -0.34]));
    // side intake scoops at the front
    const scoop = loft([
      { z: 0.1, w: 0.02, ht: 0.03, hb: 0.03, n: 2.2 },
      { z: 0.22, w: 0.07, ht: 0.09, hb: 0.08, n: 2.8 },
      { z: 0.52, w: 0.08, ht: 0.1, hb: 0.09, n: 3.0 },
      { z: 0.62, w: 0.06, ht: 0.08, hb: 0.07, n: 2.8 },
    ], { radial: 20, along: 16, capEnd: true });
    b.add(scoop.geometry, 'gunmetal', TR, T([0.25 * s, 0.02, 0.0]));
    b.add(rbox(0.1, 0.13, 0.02, 0.01, 1), 'darkMetal', '#0c0c0d', T([0.25 * s, 0.02, 0.615]));
  }

  // ---------------------------------------------------------------- front steering vanes (animated)
  const vaneShape = [[-0.55, -0.02], [-0.25, -0.07], [0.35, -0.08], [0.55, -0.02], [0.5, 0.04], [0.1, 0.08], [-0.45, 0.05]];
  const vanes = [];
  const vb = [];
  for (const s of [-1, 1]) {
    const vbld = new Builder();
    const arm = extrude(vaneShape, 0.05, 0.012);
    vbld.add(arm, 'paint', P, new THREE.Matrix4().makeRotationY(-Math.PI / 2).premultiply(T([0, 0, 0.25])));
    vbld.add(rbox(0.03, 0.2, 0.34, 0.012, 2), 'paint', S, T([0.03 * s, 0.03, 0.5], [0, 0, 0]));
    vbld.add(rbox(0.02, 0.07, 0.22, 0.006, 1), 'darkMetal', TR, T([0.052 * s, 0.03, 0.47]));
    vbld.glow(rbox(0.008, 0.012, 0.3, 0.003, 1), [hot[0] * 1.2, hot[1] * 1.2, hot[2] * 1.2], 4, T([0.047 * s, 0.1, 0.48]));
    vbld.decal(0, [0.046 * s, -0.04, 0.44], [s, 0, 0], [0, 1, 0], [0.26, 0.055], 0xffffff, [0, 0, 1, 0.25]);
    vb.push(vbld);
    const vg = new THREE.Group();
    vg.position.set(0.24 * s, -0.02, 0.9);
    vg.rotation.y = 0.06 * s;
    vanes.push({ group: vg, builder: vbld, side: s });
  }
  // fork arms connecting hull → vanes
  for (const s of [-1, 1]) {
    b.add(tube([[0.12 * s, 0.0, 0.62], [0.2 * s, -0.02, 0.8], [0.24 * s, -0.03, 0.95]], 0.028, 16, 10), 'metal', '#9a9ea4');
    b.add(bcyl(0.045, 0.1, 0.01, 16), 'darkMetal', TR, T([0.24 * s, -0.02, 0.9]));
  }

  // ---------------------------------------------------------------- handlebars + cockpit
  b.add(tube([[-0.36, 0.42, 0.34], [-0.2, 0.44, 0.42], [0, 0.43, 0.46], [0.2, 0.44, 0.42], [0.36, 0.42, 0.34]], 0.017, 32, 10), 'chrome', '#c9ccd0');
  b.add(tube([[0, 0.3, 0.52], [0, 0.4, 0.49], [0, 0.43, 0.46]], 0.022, 8, 10), 'darkMetal', TR);
  for (const s of [-1, 1]) {
    b.add(bcyl(0.024, 0.12, 0.008, 14), 'rubber', '#161616', T([0.32 * s, 0.425, 0.36], [0, 0, Math.PI / 2 + 0.25 * s], 1));
    b.add(rbox(0.05, 0.025, 0.04, 0.008, 1), 'darkMetal', '#303236', T([0.26 * s, 0.44, 0.39]));
  }
  // instrument pod with screen
  b.add(rbox(0.2, 0.08, 0.1, 0.02, 2), 'gunmetal', TR, T([0, 0.4, 0.56], [-0.5, 0, 0]));
  b.add(rbox(0.15, 0.004, 0.06, 0.002, 1), 'screen', '#6ad8ff', T([0, 0.445, 0.555], [-0.5, 0, 0]));
  // windscreen (glass, separate mesh)
  const glassGeo = loft([
    { z: 0.0, w: 0.02, ht: 0.01, hb: 0.01, y: 0.0, n: 2 },
    { z: 0.05, w: 0.16, ht: 0.012, hb: 0.004, y: 0.02, n: 2.8 },
    { z: 0.16, w: 0.18, ht: 0.012, hb: 0.004, y: 0.1, n: 2.8 },
    { z: 0.24, w: 0.12, ht: 0.01, hb: 0.004, y: 0.18, n: 2.6 },
    { z: 0.27, w: 0.02, ht: 0.005, hb: 0.004, y: 0.2, n: 2 },
  ], { radial: 20, along: 12 });
  glassGeo.geometry.rotateX(-1.05);
  glassGeo.geometry.translate(0, 0.35, 0.62);

  // ---------------------------------------------------------------- repulsor pods (front + rear)
  const pod = (z, r) => {
    b.add(lathe([[0, -0.07], [r - 0.03, -0.07], [r, -0.05], [r + 0.015, 0.0], [r, 0.05], [r - 0.05, 0.07], [0, 0.07]], 40), 'gunmetal', TR, T([0, -0.26, z]));
    // inner turbine grille ring (dark)
    b.add(new THREE.TorusGeometry(r - 0.06, 0.012, 8, 40), 'darkMetal', '#101112', T([0, -0.33, z], [Math.PI / 2, 0, 0]));
    // glowing emitter ring + core (repulsor channel 5)
    b.glow(new THREE.TorusGeometry(r - 0.03, 0.014, 8, 48), hot, 5, T([0, -0.335, z], [Math.PI / 2, 0, 0]));
    b.glow(new THREE.CircleGeometry(r - 0.09, 32), [glow[0] * 1.4, glow[1] * 1.4, glow[2] * 1.4], 5, T([0, -0.333, z], [Math.PI / 2, 0, 0]));
    // fan blades visible through the grille
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      b.add(rbox(r - 0.1, 0.01, 0.04, 0.003, 1), 'metal', '#6c7076', T([Math.cos(a) * (r - 0.1) / 2, -0.315, z + Math.sin(a) * (r - 0.1) / 2], [0.35, -a, 0]));
    }
  };
  pod(0.62, 0.23);
  pod(-0.72, 0.28);

  // ---------------------------------------------------------------- tail: twin exhausts + fin
  for (const s of [-1, 1]) {
    const nx = 0.13 * s;
    b.add(lathe([[0.0, 0.0], [0.07, 0.0], [0.085, 0.03], [0.085, 0.2], [0.075, 0.3], [0.062, 0.32], [0.055, 0.2], [0.0, 0.18]], 28), 'metal', '#8a8e94', T([nx, 0.04, -1.08], [-Math.PI / 2, 0, 0]));
    b.add(new THREE.TorusGeometry(0.075, 0.012, 8, 28), 'darkMetal', '#222', T([nx, 0.04, -1.36]));
    b.glow(new THREE.CircleGeometry(0.056, 24), [hot[0] * 1.3, hot[1] * 1.3, hot[2] * 1.3], 0, T([nx, 0.04, -1.25], [0, Math.PI, 0]));
    // heat-sink fins around the exhaust
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      b.add(rbox(0.006, 0.03, 0.18, 0.002, 1), 'darkMetal', '#303236', T([nx + Math.cos(a) * 0.09, 0.04 + Math.sin(a) * 0.09, -1.16], [0, 0, a]));
    }
  }
  const fin = [[-0.2, 0], [0.12, 0], [0.02, 0.2], [-0.12, 0.22]];
  b.add(extrude(fin, 0.025, 0.008), 'paint', A, new THREE.Matrix4().makeRotationY(-Math.PI / 2).premultiply(T([0, 0.17, -1.05])));
  // tail light bar (brake channel 2)
  b.glow(rbox(0.22, 0.02, 0.02, 0.006, 1), [4, 0.25, 0.15], 2, T([0, 0.15, -1.26]));
  // headlight (channel 3)
  b.add(bcyl(0.05, 0.04, 0.008, 20), 'chrome', '#c0c4c8', T([0, 0.03, 1.08], [Math.PI / 2, 0, 0]));
  b.glow(new THREE.CircleGeometry(0.04, 20), [6, 5.6, 5], 3, T([0, 0.03, 1.101]));
  // side marker LEDs
  for (const s of [-1, 1]) b.glow(rbox(0.01, 0.01, 0.05, 0.003, 1), [3, 1.3, 0.3], 1, T([0.2 * s, 0.05, 0.98], [0, 0.4 * s, 0]));

  // ---------------------------------------------------------------- greebles: bolts, cables, antenna
  for (const s of [-1, 1]) {
    b.add(tube([[0.18 * s, -0.12, -0.5], [0.24 * s, -0.16, -0.2], [0.23 * s, -0.15, 0.2], [0.17 * s, -0.12, 0.45]], 0.011, 24, 6), 'rubber', '#1b1b1c');
    for (let k = 0; k < 5; k++) b.add(bcyl(0.012, 0.012, 0.003, 8), 'metal', '#9a9ea4', T([0.3 * s, 0.02 + (k % 2) * 0.05, -0.55 + k * 0.28], [0, 0, Math.PI / 2]));
  }
  b.add(tube([[-0.18, 0.2, -1.0], [-0.2, 0.5, -1.08], [-0.21, 0.8, -1.12]], 0.004, 12, 5), 'darkMetal', '#222');
  b.add(new THREE.SphereGeometry(0.012, 8, 6), 'led', '#ff4020', T([-0.21, 0.8, -1.12]));

  // ---------------------------------------------------------------- decals
  // conformal numbers on the tail flanks and labels
  b.decalPatch(hull, 4, 0.12, 0.25, 0.015, 0.075, liv.decal, [0.05, 0.12, 0.95, 0.9], [8, 4], 0.003, true);    // +X side
  b.decalPatch(hull, 4, 0.12, 0.25, 0.485, 0.435, liv.decal, [0.05, 0.12, 0.95, 0.9], [8, 4], 0.003, false);   // -X side
  b.decalPatch(hull, 12, 0.38, 0.52, 0.035, 0.085, liv.decal, [0, 0.05, 1, 0.75], [8, 4], 0.003, true);
  b.decalPatch(hull, 12, 0.38, 0.52, 0.465, 0.415, liv.decal, [0, 0.05, 1, 0.75], [8, 4], 0.003, false);
  b.decal(6, [0, 0.305, -0.98], [0, 0.8, -0.6], [0, 0.6, 0.8], [0.12, 0.07], 0xffffff);
  b.decal(8, [0.0, 0.34, 0.1], [0, 1, 0.1], [0, 0, 1], [0.1, 0.07], liv.decal);

  // ---------------------------------------------------------------- assemble
  const out = b.build({ body: mats.body, glow: mats.glow, decal: mats.decal }, { name: 'bike' });
  const root = new THREE.Group();
  root.name = 'bike-model';
  for (const k of ['body', 'glow', 'decals']) if (out[k]) root.add(out[k]);
  const glass = new THREE.Mesh(glassGeo.geometry, mats.glass);
  glass.renderOrder = 3;
  root.add(glass);
  for (const vn of vanes) {
    const o = vn.builder.build({ body: mats.body, glow: mats.glow, decal: mats.decal }, { name: 'bike-vane' });
    for (const k of ['body', 'glow', 'decals']) if (o[k]) vn.group.add(o[k]);
    root.add(vn.group);
  }
  // sprites: headlight, exhaust cores, repulsor halos, tail
  const sp = new SpriteBatch();
  sp.add([0, 0.03, 1.13], [3.0, 2.8, 2.5], 0.32, 3);
  for (const s of [-1, 1]) sp.add([0.13 * s, 0.04, -1.3], [glow[0] * 1.2, glow[1] * 1.2, glow[2] * 1.2], 0.22, 0);
  sp.add([0, -0.36, 0.62], [glow[0], glow[1], glow[2]], 0.5, 5);
  sp.add([0, -0.36, -0.72], [glow[0], glow[1], glow[2]], 0.6, 5);
  sp.add([0, 0.15, -1.28], [2.5, 0.12, 0.08], 0.14, 2, 1.5);
  const sprites = sp.build();
  if (sprites) root.add(sprites);

  const rider = buildRider(mats, liv, 'bike', {
    hip: V(0, 0.3, -0.42),
    handL: V(-0.33, 0.43, 0.36), handR: V(0.33, 0.43, 0.36),
    footL: V(-0.36, -0.08, -0.26), footR: V(0.36, -0.08, -0.26),
  });
  root.add(rider);

  return {
    root, body: out.body, glow: out.glow, decals: out.decals, glass, sprites, rider,
    vanes: vanes.map((v) => v.group), tris: b.tris,
    anchors: {
      exhaust: [V(-0.13, 0.04, -1.36), V(0.13, 0.04, -1.36)],
      repulsors: [V(0, -0.34, 0.62), V(0, -0.34, -0.72)],
      tail: V(0, 0.15, -1.28), head: V(0, 0.03, 1.12), seat: V(0, 0.3, -0.42),
      eye: V(0, 0.95, -0.05),
    },
  };
}
