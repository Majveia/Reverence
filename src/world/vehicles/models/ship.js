// Starship model — NMS explorer/fighter × Bebop Swordfish × Starfield hauler: long lofted fuselage
// with a bubble canopy, twin engine nacelles on pylons with stacked main nozzles + VTOL pads, swept
// wings with canted winglets, dorsal fin, radiators, sensor dome, retractable 3-point landing gear.
// Object space: +Z forward, +Y up, +X = port (left). Origin ≈ center of mass; landed, the gear
// pads touch the ground at y = GEAR_Y.
// Returns { root, body, glow, decals, glass, sprites, rider, gear: [{group, axis, rest}], flames,
//           vtol, anchors }.
import * as THREE from 'three';
import { Builder, loft, rbox, bcyl, lathe, extrude, tube, slats, T, mergeGeometries } from '../geom.js';
import { SpriteBatch } from '../fx/glow.js';
import { buildRider } from './rider.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
export const SHIP = { gearY: -2.25, length: 14, span: 15 };

function nozzle(b, x, y, z, r, len, hot, ch) {
  // bell nozzle facing -Z (lathe along Y rotated to -Z)
  const m = new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(T([x, y, z]));
  b.add(lathe([[r * 0.62, 0], [r * 0.7, -len * 0.25], [r * 0.86, -len * 0.62], [r, -len], [r * 1.06, -len * 0.98], [r * 1.07, -len * 0.7], [r * 0.9, -len * 0.3], [r * 0.82, 0.02]], 36), 'darkMetal', '#2c2a28', m);
  // heat-tinted inner ring and throat glow
  b.add(new THREE.TorusGeometry(r * 1.02, r * 0.05, 8, 36), 'metal', '#8a6a55', T([x, y, z - len]));
  b.glow(new THREE.CircleGeometry(r * 0.66, 32), hot, ch, T([x, y, z - len * 0.2], [0, Math.PI, 0]));
  b.glow(new THREE.TorusGeometry(r * 0.78, r * 0.06, 6, 32), hot.map((c) => c * 0.6), ch, T([x, y, z - len * 0.55]));
}

export function buildShip(mats, liv) {
  const b = new Builder();
  const P = liv.primary, S = liv.secondary, A = liv.accent, TR = liv.trim;
  const glow = liv.glow;
  const hot = [glow[0] * 3.2, glow[1] * 3.2, glow[2] * 3.2];
  const glassGeos = [];

  // ---------------------------------------------------------------- fuselage
  const fus = loft([
    { z: -6.2, w: 0.7, ht: 0.6, hb: 0.5, y: 0.3, n: 3.0 },
    { z: -5.6, w: 1.15, ht: 0.95, hb: 0.75, y: 0.3, n: 3.2 },
    { z: -3.6, w: 1.4, ht: 1.15, hb: 0.85, y: 0.32, n: 3.2 },
    { z: -0.8, w: 1.5, ht: 1.22, hb: 0.92, y: 0.32, n: 3.0 },
    { z: 1.8, w: 1.38, ht: 1.08, hb: 0.86, y: 0.26, n: 2.8 },
    { z: 4.0, w: 1.02, ht: 0.8, hb: 0.72, y: 0.12, n: 2.6 },
    { z: 5.9, w: 0.58, ht: 0.46, hb: 0.44, y: -0.02, n: 2.4 },
    { z: 7.1, w: 0.2, ht: 0.16, hb: 0.16, y: -0.08, n: 2.2 },
    { z: 7.5, w: 0.02, ht: 0.02, hb: 0.02, y: -0.1, n: 2.0 },
  ], { radial: 56, along: 72, capStart: true, capEnd: false });
  b.add(fus.geometry, 'paint', P);
  // dorsal spine armor in secondary color
  const spine = loft([
    { z: -5.9, w: 0.3, ht: 0.12, hb: 0.05, y: 1.12, n: 3.4 },
    { z: -3.5, w: 0.62, ht: 0.18, hb: 0.05, y: 1.42, n: 3.6 },
    { z: -0.6, w: 0.7, ht: 0.2, hb: 0.05, y: 1.5, n: 3.6 },
    { z: 1.0, w: 0.55, ht: 0.14, hb: 0.05, y: 1.4, n: 3.4 },
    { z: 1.4, w: 0.05, ht: 0.03, hb: 0.03, y: 1.36, n: 2.0 },
  ], { radial: 28, along: 32 });
  b.add(spine.geometry, 'paint', S);
  // belly keel / cargo bay
  b.add(rbox(1.7, 0.4, 5.2, 0.12, 3), 'gunmetal', TR, T([0, -0.55, -1.6]));
  b.add(rbox(1.2, 0.06, 3.6, 0.02, 1), 'darkMetal', '#1c1c1d', T([0, -0.76, -1.6]));
  // nose sensor ring and chin intake
  b.add(new THREE.TorusGeometry(0.5, 0.04, 8, 32), 'metal', '#8e9296', T([0, -0.03, 6.0]));
  b.add(rbox(0.9, 0.3, 1.2, 0.1, 2), 'darkMetal', '#1a1b1c', T([0, -0.62, 3.6], [0.08, 0, 0]));
  b.add(slats(0.78, 0.22, 4, 0.04), 'metal', '#5a5d61', T([0, -0.6, 4.21], [0.2, 0, 0]));

  // ---------------------------------------------------------------- canopy + cockpit
  const can = loft([
    { z: 0.9, w: 0.06, ht: 0.05, hb: 0.05, y: 1.3, n: 2.0 },
    { z: 1.5, w: 0.74, ht: 0.6, hb: 0.3, y: 1.33, n: 2.4 },
    { z: 2.8, w: 0.82, ht: 0.66, hb: 0.3, y: 1.24, n: 2.4 },
    { z: 4.0, w: 0.58, ht: 0.36, hb: 0.3, y: 0.98, n: 2.3 },
    { z: 4.7, w: 0.08, ht: 0.05, hb: 0.05, y: 0.8, n: 2.0 },
  ], { radial: 36, along: 28 });
  {
    const g = can.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    glassGeos.push(g.index ? g.toNonIndexed() : g);
  }
  // canopy frame: arches + spine rail
  for (const tz of [0.14, 0.9]) {
    const pts = [];
    for (let i = 0; i <= 12; i++) { const P0 = new THREE.Vector3(), N0 = new THREE.Vector3(); can.evaluate(tz, -0.02 + (i / 12) * 0.54, P0, N0); P0.addScaledVector(N0, 0.015); pts.push(P0.toArray()); }
    b.add(tube(pts, 0.03, 24, 6), 'gunmetal', TR);
  }
  { const pts = []; for (let i = 0; i <= 6; i++) { const P0 = new THREE.Vector3(), N0 = new THREE.Vector3(); can.evaluate(0.02 + (i / 6) * 0.26, 0.25, P0, N0); P0.addScaledVector(N0, 0.015); pts.push(P0.toArray()); } b.add(tube(pts, 0.028, 12, 6), 'gunmetal', TR); }
  // canopy sill
  for (const s of [-1, 1]) b.add(tube([[0.72 * s, 1.08, 1.35], [0.8 * s, 1.02, 2.6], [0.6 * s, 0.82, 3.9], [0.2 * s, 0.72, 4.6]], 0.05, 20, 8), 'gunmetal', TR);
  // cockpit interior: seat, dash with screens, control sticks
  b.add(rbox(0.62, 0.16, 0.6, 0.06, 2), 'leather', '#2f2620', T([0, 0.86, 2.1]));
  b.add(rbox(0.6, 0.85, 0.16, 0.08, 3), 'leather', '#2f2620', T([0, 1.3, 1.78], [-0.28, 0, 0]));
  b.add(rbox(0.36, 0.22, 0.12, 0.05, 2), 'leather', '#2a221c', T([0, 1.8, 1.66], [-0.28, 0, 0]));
  b.add(rbox(1.02, 0.36, 0.07, 0.03, 2), 'plastic', '#16181a', T([0, 1.2, 3.3], [0.6, 0, 0]));
  b.add(rbox(1.08, 0.05, 0.3, 0.02, 1), 'plastic', '#1d1f21', T([0, 1.35, 3.42], [0.12, 0, 0]));
  for (const s of [-1, 1]) b.glow(rbox(0.012, 0.3, 0.012, 0.004, 1), [0.3, 1.1, 1.6], 6, T([0.49 * s, 1.21, 3.27], [0.6, 0, 0]));
  for (const s of [-1, 1]) b.add(tube([[0.24 * s, 0.95, 2.55], [0.24 * s, 1.13, 2.62]], 0.022, 3, 6), 'rubber', '#161616');

  // ---------------------------------------------------------------- nacelles on pylons
  const NX = 2.75, NY = 0.15;
  for (const s of [-1, 1]) {
    const nac = loft([
      { z: -5.4, w: 0.95, ht: 0.95, hb: 0.95, n: 2.6 },
      { z: -4.0, w: 1.02, ht: 1.05, hb: 1.0, n: 2.8 },
      { z: -1.0, w: 0.98, ht: 1.0, hb: 0.95, n: 2.8 },
      { z: 0.6, w: 0.86, ht: 0.84, hb: 0.84, n: 2.6 },
      { z: 1.3, w: 0.78, ht: 0.76, hb: 0.76, n: 2.4 },
    ], { radial: 40, along: 36, capStart: false, capEnd: true });
    b.add(nac.geometry, 'paint', P, T([NX * s, NY, 0]));
    // intake lip + fan
    b.add(new THREE.TorusGeometry(0.72, 0.08, 10, 40), 'metal', '#7d8186', T([NX * s, NY, 1.32]));
    b.add(new THREE.CircleGeometry(0.66, 32), 'darkMetal', '#0c0d0e', T([NX * s, NY, 1.34]));
    for (let k = 0; k < 14; k++) { const a = (k / 14) * Math.PI * 2; b.add(rbox(0.06, 0.6, 0.02, 0.01, 1), 'metal', '#5b5f64', T([NX * s + Math.cos(a) * 0.3, NY + Math.sin(a) * 0.3, 1.2], [0, 0.4, a - Math.PI / 2])); }
    b.add(bcyl(0.16, 0.2, 0.04, 16), 'chrome', '#b8bcc0', T([NX * s, NY, 1.2], [Math.PI / 2, 0, 0]));
    // stacked nozzles (main + two small)
    nozzle(b, NX * s, NY - 0.1, -5.35, 0.62, 0.9, hot, 0);
    nozzle(b, NX * s, NY + 0.92, -5.05, 0.26, 0.45, hot, 0);
    // nacelle accent band + glow strip
    b.add(loft([{ z: -2.6, w: 1.04, ht: 1.07, hb: 1.02, n: 2.8 }, { z: -2.2, w: 1.05, ht: 1.08, hb: 1.03, n: 2.8 }], { radial: 40, along: 2, capStart: false, capEnd: false }).geometry, 'paint', A, T([NX * s, NY, 0]));
    b.glow(rbox(0.03, 0.03, 3.2, 0.01, 1), hot, 4, T([(NX + 0.99) * s, NY, -2.0]));
    // VTOL lift pads underneath (glow, channel 5)
    b.add(bcyl(0.62, 0.16, 0.05, 32), 'darkMetal', '#1d1e20', T([NX * s, NY - 0.92, -1.9]));
    b.glow(new THREE.CircleGeometry(0.46, 32), hot, 5, T([NX * s, NY - 1.005, -1.9], [Math.PI / 2, 0, 0]));
    for (let k = 0; k < 4; k++) b.add(rbox(1.0, 0.03, 0.05, 0.01, 1), 'metal', '#5a5d61', T([NX * s, NY - 1.02, -1.9], [0, (k / 4) * Math.PI, 0]));
    // pylon (wing root) — swept extrusion from fuselage to nacelle
    const pylon = [[0.9, 1.4], [NX - 0.6, 0.6], [NX - 0.6, -3.8], [0.9, -3.4]];
    b.add(extrude(pylon.map(([x, z]) => [x * s, z]), 0.34, 0.08, { crease: 40 }), 'paint', S, new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(T([0, 0.25, 0])));
    // radiator fins on the pylon top
    for (let k = 0; k < 9; k++) b.add(rbox(0.9, 0.18, 0.04, 0.01, 1), 'darkMetal', '#2b2c2e', T([1.85 * s, 0.52, -2.8 + k * 0.28]));
    b.glow(rbox(0.85, 0.02, 2.4, 0.005, 1), [1.6, 0.5, 0.15], 4, T([1.85 * s, 0.44, -1.7]));
    // main wing (swept) with slight anhedral, winglet
    const wing = [[NX + 0.7, 0.2], [7.2, -2.7], [7.35, -4.0], [NX + 0.7, -3.9]];
    const wm = new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeRotationZ(-0.07 * s)).premultiply(T([0, NY - 0.1, 0]));
    b.add(extrude(wing.map(([x, z]) => [x * s, z]), 0.2, 0.07, { crease: 40 }), 'paint', P, wm);
    // wing stripe + flaps (secondary)
    b.add(extrude([[NX + 1.0, -3.3], [7.1, -3.55], [7.2, -3.95], [NX + 1.0, -3.85]].map(([x, z]) => [x * s, z]), 0.22, 0.03), 'paint', S, wm);
    b.add(extrude([[NX + 1.6, -0.35], [5.2, -1.6], [5.35, -2.0], [NX + 1.6, -0.75]].map(([x, z]) => [x * s, z]), 0.215, 0.02), 'paint', A, wm);
    const tip = new THREE.Vector3(7.28 * s, NY - 0.1 - 0.07 * 4.5, -3.35);
    const wl = [[0.1, 0], [-0.9, 1.2], [-1.4, 1.25], [-1.3, 0]];
    b.add(extrude(wl, 0.12, 0.04), 'paint', S, new THREE.Matrix4().makeRotationY(-Math.PI / 2).premultiply(new THREE.Matrix4().makeRotationZ(-0.35 * s)).premultiply(T([tip.x, tip.y, tip.z + 0.6])));
    // gun pods under the wing root (NMS fighter vibe)
    b.add(bcyl(0.14, 2.2, 0.03, 14), 'gunmetal', TR, T([(NX + 1.3) * s, NY - 0.45, 0.2], [Math.PI / 2, 0, 0]));
    b.add(bcyl(0.06, 0.9, 0.01, 10), 'darkMetal', '#1a1a1a', T([(NX + 1.3) * s, NY - 0.45, 1.7], [Math.PI / 2, 0, 0]));
    // RCS quads
    for (const z of [5.2, -5.0]) { b.add(rbox(0.16, 0.16, 0.16, 0.03, 1), 'darkMetal', '#222', T([(z > 0 ? 0.62 : 1.0) * s, z > 0 ? 0.0 : 0.3, z])); }
    // exhaust scorch shield plates
    b.add(rbox(0.05, 0.9, 1.4, 0.02, 1), 'metal', '#6d5a4d', T([(NX - 1.0) * s, NY, -4.8]));
  }
  // canards
  for (const s of [-1, 1]) b.add(extrude([[0.9 * s, 4.4], [2.1 * s, 3.4], [2.15 * s, 2.9], [0.9 * s, 3.2]], 0.1, 0.035), 'paint', S, new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(T([0, 0.15, 0])));

  // ---------------------------------------------------------------- dorsal fin, sensor dome, antennae
  const fin = [[-5.9, 1.2], [-3.4, 1.35], [-4.7, 3.0], [-5.75, 3.05], [-6.1, 2.6]];
  b.add(extrude(fin, 0.14, 0.05), 'paint', S, new THREE.Matrix4().makeRotationY(-Math.PI / 2));
  b.add(extrude([[-5.5, 2.2], [-4.9, 2.2], [-5.0, 2.95], [-5.55, 2.98]], 0.16, 0.02), 'paint', A, new THREE.Matrix4().makeRotationY(-Math.PI / 2));
  for (const s of [-1, 1]) b.add(extrude([[-5.2, -0.2], [-3.4, -0.3], [-4.6, -1.5], [-5.3, -1.45]], 0.1, 0.04), 'paint', S, new THREE.Matrix4().makeRotationY(-Math.PI / 2).premultiply(new THREE.Matrix4().makeRotationZ(0.5 * s)).premultiply(T([0.6 * s, 0, 0])));
  b.add(new THREE.SphereGeometry(0.34, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), 'ceramic', '#e6e2d8', T([0, 1.66, -1.4]));
  b.add(tube([[0.3, 1.6, -3.0], [0.32, 2.3, -3.2], [0.34, 2.8, -3.35]], 0.012, 8, 5), 'darkMetal', '#1e1e1e');
  b.add(tube([[-0.3, 1.6, -3.4], [-0.32, 2.1, -3.55]], 0.018, 6, 5), 'darkMetal', '#1e1e1e');
  b.add(bcyl(0.2, 0.05, 0.02, 16), 'metal', '#9a9ea4', T([-0.32, 2.12, -3.56], [0.4, 0, 0]));
  // hull hatches, vents, bolts
  for (const s of [-1, 1]) {
    b.add(slats(0.9, 0.5, 6, 0.05), 'darkMetal', '#1b1c1d', T([1.46 * s, 0.3, -2.0], [0, Math.PI / 2 * s, 0]));
    b.add(rbox(0.06, 0.9, 1.3, 0.03, 1), 'gunmetal', TR, T([1.45 * s, 0.3, 0.6]));
    for (let k = 0; k < 8; k++) b.add(bcyl(0.018, 0.02, 0.004, 8), 'metal', '#9a9ea4', T([1.5 * s, -0.25, -4.2 + k * 0.9], [0, 0, Math.PI / 2]));
  }
  // rear engine block between nacelles (center exhaust)
  nozzle(b, 0, 0.3, -6.1, 0.4, 0.55, hot, 0);

  // ---------------------------------------------------------------- lights
  b.glowPair(new THREE.SphereGeometry(0.07, 10, 8), [5, 0.3, 0.2], [0.3, 5, 0.6], 1, T([7.32, NY - 0.45, -3.9]));
  b.glowSym(new THREE.SphereGeometry(0.05, 8, 6), [5, 5, 5], 2, T([7.3, NY - 0.45, -4.05]));
  b.glow(new THREE.SphereGeometry(0.07, 10, 8), [5, 0.4, 0.2], 2, T([0, 3.08, -5.72]));
  // landing lights (channel 3) under the nose + canopy accent
  b.add(bcyl(0.14, 0.08, 0.02, 20), 'chrome', '#c4c8cc', T([0, -0.72, 4.6]));
  b.glow(new THREE.CircleGeometry(0.11, 20), [6, 5.8, 5.2], 3, T([0, -0.765, 4.6], [Math.PI / 2, 0, 0]));
  for (const s of [-1, 1]) b.glow(rbox(0.02, 0.02, 2.4, 0.006, 1), hot, 4, T([1.42 * s, -0.3, 0.8], [0, 0.05 * s, 0]));

  // ---------------------------------------------------------------- decals
  b.decalPatch(fus, 4, 0.34, 0.44, 0.02, 0.07, liv.decal, [0.05, 0.12, 0.95, 0.9], [8, 4], 0.006, true);
  b.decalPatch(fus, 4, 0.34, 0.44, 0.48, 0.43, liv.decal, [0.05, 0.12, 0.95, 0.9], [8, 4], 0.006, false);
  b.decalPatch(fus, 12, 0.14, 0.3, 0.03, 0.09, liv.decal, [0, 0.05, 1, 0.75], [8, 4], 0.006, true);
  b.decalPatch(fus, 12, 0.14, 0.3, 0.47, 0.41, liv.decal, [0, 0.05, 1, 0.75], [8, 4], 0.006, false);
  b.decalPatch(fus, 0, 0.8, 0.86, 0.9, 0.6, 0xffffff, [0, 0, 1, 0.25], [6, 6], 0.006, false);
  for (const s of [-1, 1]) {
    b.decal(8, [4.8 * s, NY + 0.06, -2.2], [0, 1, 0], [0, 0, 1], [1.1, 0.7], liv.decal);
    b.decal(14, [(NX + 0.98) * s, NY + 0.1, -3.6], [s, 0, 0], [0, 1, 0], [0.9, 0.5], 0xffffff, [0, 0, 1, 1], s < 0);
    b.decal(7, [(NX + 0.97) * s, NY - 0.25, -0.5], [s, 0, 0], [0, 1, 0], [0.8, 0.35], liv.decal, [0, 0.1, 1, 0.85], s < 0);
    b.decal(6, [1.49 * s, 0.35, 0.6], [s, 0, 0], [0, 1, 0], [0.7, 0.42], 0xffffff, [0, 0.2, 1, 0.8], s < 0);
  }
  b.decal(5, [0, 1.71, -2.2], [0, 1, 0], [0, 0, 1], [0.8, 0.8], liv.decal);

  // ---------------------------------------------------------------- build static parts
  const out = b.build({ body: mats.body, glow: mats.glow, decal: mats.decal }, { name: 'ship' });
  const root = new THREE.Group();
  root.name = 'ship-model';
  for (const k of ['body', 'glow', 'decals']) if (out[k]) root.add(out[k]);
  const gg = mergeGeometries(glassGeos, false);
  glassGeos.forEach((g) => g.dispose());
  const glass = new THREE.Mesh(gg, mats.glass);
  glass.renderOrder = 3;
  root.add(glass);

  // ---------------------------------------------------------------- landing gear (retractable)
  const gear = [];
  const mkGear = (x, y, z, len, pad) => {
    const gb = new Builder();
    gb.add(bcyl(0.13, len * 0.55, 0.03, 14), 'darkMetal', '#2a2b2d', T([0, -len * 0.28, 0]));
    gb.add(bcyl(0.08, len * 0.6, 0.02, 12), 'chrome', '#d2d5d9', T([0, -len * 0.7, 0]));
    gb.add(tube([[0, -0.1, 0.3], [0, -len * 0.45, 0.45], [0, -len * 0.75, 0.05]], 0.045, 10, 6), 'darkMetal', '#2a2b2d');
    gb.add(bcyl(pad, 0.12, 0.04, 24), 'gunmetal', TR, T([0, -len + 0.06, 0]));
    gb.add(bcyl(pad * 0.7, 0.05, 0.02, 20), 'rubber', '#161616', T([0, -len - 0.02, 0]));
    gb.add(rbox(0.3, 0.3, 0.3, 0.06, 2), 'darkMetal', '#1c1d1e', T([0, 0, 0]));
    gb.decal(0, [0, -len * 0.28, 0.135], [0, 0, 1], [0, 1, 0], [0.2, len * 0.3], 0xffffff, [0, 0, 0.25, 1]);
    const o = gb.build({ body: mats.body, decal: mats.decal }, { name: 'ship-gear' });
    const g = new THREE.Group();
    g.position.set(x, y, z);
    for (const k of ['body', 'decals']) if (o[k]) g.add(o[k]);
    root.add(g);
    gear.push({ group: g, len });
  };
  mkGear(0, -0.6, 4.6, SHIP.gearY * -1 - 0.6, 0.32);
  mkGear(NX, NY - 0.9, -2.9, -(SHIP.gearY - (NY - 0.9)), 0.42);
  mkGear(-NX, NY - 0.9, -2.9, -(SHIP.gearY - (NY - 0.9)), 0.42);

  // sprites: nozzles, nav, landing light, VTOL
  const sp = new SpriteBatch();
  for (const s of [-1, 1]) {
    sp.add([NX * s, NY - 0.1, -6.35], hot.map((c) => c * 0.45), 1.6, 0);
    sp.add([NX * s, NY + 0.92, -5.6], hot.map((c) => c * 0.4), 0.8, 0);
    sp.add([NX * s, NY - 1.1, -1.9], hot.map((c) => c * 0.35), 1.4, 5);
    sp.add([7.4 * s, NY - 0.45, -3.9], s > 0 ? [3, 0.15, 0.1] : [0.15, 3, 0.4], 0.55, 1);
    sp.add([7.4 * s, NY - 0.45, -4.1], [3, 3, 3], 0.9, 2);
  }
  sp.add([0, 0.3, -6.8], hot.map((c) => c * 0.4), 1.0, 0);
  sp.add([0, -0.85, 4.6], [3, 2.9, 2.6], 0.8, 3);
  sp.add([0, 3.15, -5.72], [3, 0.2, 0.1], 0.6, 2);
  const sprites = sp.build();
  if (sprites) root.add(sprites);

  const rider = buildRider(mats, liv, 'seat', {
    hip: V(0, 0.97, 2.08), handL: V(-0.24, 1.15, 2.62), handR: V(0.24, 1.15, 2.62),
    footL: V(-0.18, 0.8, 3.05), footR: V(0.18, 0.8, 3.05),
    knee: (s, hp) => hp.clone().add(V(0.1 * s, 0.18, 0.46)),
  });
  root.add(rider);

  return {
    root, body: out.body, glow: out.glow, decals: out.decals, glass, sprites, rider, gear, tris: b.tris,
    anchors: {
      nozzles: [V(NX, NY - 0.1, -6.25), V(-NX, NY - 0.1, -6.25), V(NX, NY + 0.92, -5.5), V(-NX, NY + 0.92, -5.5), V(0, 0.3, -6.65)],
      nozzleR: [0.62, 0.62, 0.26, 0.26, 0.4],
      vtol: [V(NX, NY - 1.02, -1.9), V(-NX, NY - 1.02, -1.9)],
      tips: [V(7.35, NY - 0.45, -4.0), V(-7.35, NY - 0.45, -4.0)],
      nose: V(0, -0.1, 7.5), eye: V(0, 1.72, 2.25), screen: { pos: V(0, 1.2235, 3.267), ax: 0.6, w: 0.92, h: 0.29 },
      ladder: V(1.9, -1.2, 1.5),
    },
  };
}
