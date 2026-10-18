// Rover model — rugged expedition exocraft (Pacific Drive wagon × NMS Roamer × Land Cruiser troopy).
// Object space: +Z forward, +Y up, +X = driver side (left); origin ≈ center of mass / suspension
// hard-point plane. Real openings in the cab (pillars + glass) so the driver is visible and the
// cockpit view works. Wheels are separate meshes sharing one geometry (spun/steered/suspended).
// Returns { root, body, glow, decals, glass, sprites, rider, wheels: [{group, spin, side, front}],
//           shocks: [{mesh, mount}], beams, anchors }.
import * as THREE from 'three';
import { Builder, rbox, bcyl, lathe, extrude, tube, slats, T, mergeGeometries } from '../geom.js';
import { SpriteBatch, makeBeam } from '../fx/glow.js';
import { buildRider } from './rider.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export const ROVER = {
  wheelR: 0.56, wheelW: 0.44,
  hard: [ // suspension hard points (x, y, z) — FL, FR, RL, RR
    [1.05, 0.05, 1.55], [-1.05, 0.05, 1.55], [1.05, 0.05, -1.45], [-1.05, 0.05, -1.45],
  ],
  rest: 0.52,    // max droop length (hard point → wheel center)
  bump: 0.25,    // bump stop (min length)
  archY: -0.28, archR: 0.66,
};

/** Side profile (z, y) with two wheel arches, extruded across X. */
function bodyProfile() {
  const pts = [];
  const bottom = -0.1, r = ROVER.archR, cy = ROVER.archY;
  const a0 = Math.asin((bottom - cy) / r);
  const arch = (cz) => { for (let i = 0; i <= 14; i++) { const a = Math.PI - a0 - (i / 14) * (Math.PI - 2 * a0); pts.push([cz + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
  // clockwise-ish: rear bottom → rear arch → mid → front arch → front bottom → front face → top → rear face
  pts.push([-2.18, bottom]);
  arch(ROVER.hard[2][2]);
  pts.push([0.05, bottom - 0.02]);
  arch(ROVER.hard[0][2]);
  pts.push([2.22, bottom + 0.02]);
  pts.push([2.36, 0.1]);
  pts.push([2.38, 0.36]);
  pts.push([2.3, 0.5]);
  pts.push([1.3, 0.57]);
  pts.push([-2.22, 0.57]);
  pts.push([-2.3, 0.45]);
  pts.push([-2.3, 0.02]);
  return pts;
}

function wheelGeometry() {
  const b = new Builder();
  const R = ROVER.wheelR, W = ROVER.wheelW / 2;
  // tire carcass (lathe around Y, then rotated so the axle is X)
  const prof = [[0.35, -W + 0.02], [0.42, -W], [0.5, -W + 0.005], [R - 0.012, -W + 0.04], [R - 0.004, -W + 0.1], [R - 0.004, W - 0.1], [R - 0.012, W - 0.04], [0.5, W - 0.005], [0.42, W], [0.35, W - 0.02]];
  const tireM = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
  b.add(lathe(prof, 56), 'rubber', '#1b1a19', tireM);
  // knobby tread lugs, two staggered rows + shoulder blocks
  const N = 22;
  const lug = rbox(0.15, 0.05, 0.12, 0.012, 1);
  const shoulder = rbox(0.07, 0.07, 0.1, 0.012, 1);
  for (let i = 0; i < N; i++) {
    for (const row of [-1, 1]) {
      const th = ((i + (row > 0 ? 0.5 : 0)) / N) * Math.PI * 2;
      b.add(lug, 'rubber', '#1f1e1c', T([row * 0.085, Math.cos(th) * (R + 0.012), Math.sin(th) * (R + 0.012)], [th + row * 0.12, 0, 0]));
      b.add(shoulder, 'rubber', '#1f1e1c', T([row * (W - 0.01), Math.cos(th) * (R - 0.035), Math.sin(th) * (R - 0.035)], [th, 0, 0]));
    }
  }
  // rim (outer face at +X), spokes, beadlock ring with bolts, hub
  const rimM = new THREE.Matrix4().makeRotationZ(-Math.PI / 2);
  b.add(lathe([[0.001, 0.07], [0.12, 0.075], [0.3, 0.12], [0.345, 0.16], [0.36, 0.17], [0.36, -0.17], [0.33, -0.16], [0.2, -0.05], [0.001, -0.05]].reverse(), 40), 'paintMetal', '#2e3033', rimM);
  b.add(new THREE.TorusGeometry(0.345, 0.022, 8, 40), 'metal', '#9da1a6', T([0.175, 0, 0], [0, Math.PI / 2, 0]));
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    b.add(bcyl(0.011, 0.02, 0.003, 6), 'chrome', '#c8cbd0', T([0.19, Math.cos(a) * 0.345, Math.sin(a) * 0.345], [0, 0, Math.PI / 2]));
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.add(rbox(0.05, 0.22, 0.06, 0.015, 1), 'paintMetal', '#35383c', T([0.13, Math.cos(a) * 0.19, Math.sin(a) * 0.19], [a, 0, 0]));
  }
  b.add(bcyl(0.09, 0.08, 0.02, 20), 'metal', '#8c9096', T([0.14, 0, 0], [0, 0, Math.PI / 2]));
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; b.add(bcyl(0.012, 0.03, 0.004, 6), 'chrome', '#d0d3d8', T([0.19, Math.cos(a) * 0.055, Math.sin(a) * 0.055], [0, 0, Math.PI / 2])); }
  return b;
}

export function buildRover(mats, liv) {
  const b = new Builder();
  const P = liv.primary, S = liv.secondary, A = liv.accent, TR = liv.trim;
  const glow = liv.glow;
  const hot = [glow[0] * 2.5, glow[1] * 2.5, glow[2] * 2.5];
  const glassGeos = [];
  const glassPanel = (geo, m) => { geo.applyMatrix4(m); for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k); glassGeos.push(geo.index ? geo.toNonIndexed() : geo); };
  const sideM = (x) => new THREE.Matrix4().makeRotationY(-Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(x, 0, 0));

  // ---------------------------------------------------------------- lower body (profile w/ arches)
  b.add(extrude(bodyProfile(), 1.9, 0.06, { bevelSeg: 3, curveSeg: 4, crease: 40 }), 'paint', P, sideM(0));
  // hood bulge + vents
  b.add(rbox(0.9, 0.08, 0.95, 0.04, 3), 'paint', P, T([0, 0.6, 1.78], [0.03, 0, 0]));
  for (const s of [-1, 1]) b.add(slats(0.28, 0.22, 6, 0.03), 'darkMetal', '#141516', T([0.62 * s, 0.585, 1.85], [-Math.PI / 2 + 0.03, 0, 0]));
  // lower rocker / skid band in secondary
  for (const s of [-1, 1]) b.add(rbox(0.06, 0.16, 1.55, 0.03, 2), 'paintMatte', S, T([0.955 * s, 0.0, 0.05]));
  // ---------------------------------------------------------------- fender flares over the wheels
  const flare = [];
  { const r0 = ROVER.archR - 0.02, r1 = ROVER.archR + 0.12;
    for (let i = 0; i <= 16; i++) { const a = 0.18 + (i / 16) * (Math.PI - 0.36); flare.push([Math.cos(a) * r1, Math.sin(a) * r1]); }
    for (let i = 16; i >= 0; i--) { const a = 0.18 + (i / 16) * (Math.PI - 0.36); flare.push([Math.cos(a) * r0, Math.sin(a) * r0]); } }
  for (const [x, , z] of ROVER.hard) {
    const s = Math.sign(x);
    b.add(extrude(flare, 0.42, 0.03, { curveSeg: 2, crease: 50 }), 'plastic', '#232322', new THREE.Matrix4().makeRotationY(-Math.PI / 2).premultiply(T([1.07 * s, ROVER.archY, z])));
    // mud flap behind each wheel
    b.add(rbox(0.36, 0.34, 0.02, 0.01, 1), 'rubber', '#161616', T([1.07 * s, -0.42, z - 0.72], [0.08, 0, 0]));
    // inner wheel-well liner (dark) so we never see through the body
    b.add(new THREE.CylinderGeometry(ROVER.archR - 0.02, ROVER.archR - 0.02, 0.08, 24, 1, false, 0.3, Math.PI - 0.6), 'darkMetal', '#101010', T([0.86 * s, ROVER.archY, z], [0, 0, Math.PI / 2]));
  }
  // ---------------------------------------------------------------- bumpers, bull bar, winch
  b.add(rbox(2.2, 0.26, 0.3, 0.05, 2), 'darkMetal', '#232426', T([0, -0.02, 2.44]));
  b.add(bcyl(0.09, 0.8, 0.015, 20), 'metal', '#6f7378', T([0, 0.0, 2.6], [0, 0, Math.PI / 2]));
  b.add(rbox(0.9, 0.06, 0.18, 0.02, 1), 'darkMetal', '#1b1c1d', T([0, 0.13, 2.56]));
  b.add(tube([[-0.95, -0.05, 2.5], [-0.9, 0.35, 2.58], [-0.55, 0.62, 2.55], [0.55, 0.62, 2.55], [0.9, 0.35, 2.58], [0.95, -0.05, 2.5]], 0.045, 48, 10), 'darkMetal', '#2b2c2e');
  for (const s of [-1, 1]) {
    b.add(tube([[0.35 * s, 0.1, 2.52], [0.35 * s, 0.6, 2.57]], 0.035, 6, 8), 'darkMetal', '#2b2c2e');
    b.add(new THREE.TorusGeometry(0.06, 0.018, 8, 16), 'paint', A, T([0.78 * s, -0.12, 2.6], [0, Math.PI / 2, 0]));
  }
  b.add(rbox(2.1, 0.24, 0.24, 0.05, 2), 'darkMetal', '#232426', T([0, 0.0, -2.38]));
  b.add(rbox(0.16, 0.12, 0.2, 0.03, 1), 'metal', '#77797c', T([0, -0.08, -2.5]));
  // grille
  b.add(rbox(1.2, 0.3, 0.05, 0.02, 1), 'darkMetal', '#0f1011', T([0, 0.3, 2.37], [-0.12, 0, 0]));
  b.add(slats(1.1, 0.26, 5, 0.04, 0.5), 'metal', '#5c5f63', T([0, 0.3, 2.39], [-0.12, 0, 0]));
  // ---------------------------------------------------------------- cab: pillars, roof, doors, glass
  const cabHalf = 0.93;
  const wsB = [1.2, 0.6], wsT = [0.66, 1.68];
  const wsLen = Math.hypot(wsT[0] - wsB[0], wsT[1] - wsB[1]);
  const wsA = -Math.asin((wsB[0] - wsT[0]) / wsLen);
  const wsMid = [(wsB[0] + wsT[0]) / 2, (wsB[1] + wsT[1]) / 2];
  for (const s of [-1, 1]) {
    b.add(rbox(0.1, wsLen + 0.06, 0.1, 0.03, 2), 'paint', S, T([cabHalf * s, wsMid[1], wsMid[0]], [wsA, 0, 0]));                 // A pillar
    b.add(rbox(0.1, 1.1, 0.14, 0.03, 2), 'paint', S, T([cabHalf * s, 1.13, 0.0]));                                               // B pillar
    b.add(rbox(0.1, 1.12, 0.2, 0.03, 2), 'paint', S, T([cabHalf * s, 1.13, -0.66]));                                             // C pillar
    b.add(rbox(0.1, 0.42, 1.9, 0.04, 2), 'paint', P, T([cabHalf * s, 0.78, 0.26]));                                              // door lower
    b.add(rbox(0.04, 0.035, 1.8, 0.01, 1), 'darkMetal', '#1a1a1b', T([(cabHalf + 0.05) * s, 0.99, 0.28]));                      // belt trim
    // door handles, hinges, mirror
    b.add(rbox(0.04, 0.035, 0.16, 0.012, 1), 'chrome', '#b8bcc0', T([(cabHalf + 0.06) * s, 0.9, 0.04]));
    b.add(rbox(0.04, 0.035, 0.16, 0.012, 1), 'chrome', '#b8bcc0', T([(cabHalf + 0.06) * s, 0.9, -0.55]));
    b.add(tube([[cabHalf * s, 1.0, 1.05], [(cabHalf + 0.18) * s, 1.12, 1.08], [(cabHalf + 0.26) * s, 1.12, 1.06]], 0.018, 8, 6), 'darkMetal', '#1a1a1b');
    b.add(rbox(0.07, 0.2, 0.26, 0.03, 2), 'darkMetal', '#1d1e20', T([(cabHalf + 0.28) * s, 1.14, 1.04], [0, 0.25 * s, 0]));
    b.add(rbox(0.01, 0.16, 0.2, 0.004, 1), 'chrome', '#d9dde2', T([(cabHalf + 0.25) * s, 1.14, 1.06], [0, 0.25 * s, 0]));
    // side glass: front door + rear window
    glassPanel(rbox(0.02, 0.66, 1.0, 0.01, 1), T([cabHalf * s, 1.33, 0.52]));
    glassPanel(rbox(0.02, 0.66, 0.56, 0.01, 1), T([cabHalf * s, 1.33, -0.33]));
    // rock slider / side step
    b.add(tube([[0.98 * s, -0.16, -0.72], [1.02 * s, -0.16, -0.2], [1.02 * s, -0.16, 0.5], [0.98 * s, -0.16, 0.86]], 0.05, 16, 10), 'darkMetal', '#262729');
    b.add(rbox(0.22, 0.03, 1.2, 0.01, 1), 'darkMetal', '#1c1d1e', T([0.97 * s, -0.12, 0.07]));
  }
  b.add(rbox(1.96, 0.1, 0.12, 0.03, 2), 'paint', S, T([0, 0.62, 1.2]));                                    // cowl
  b.add(rbox(1.98, 0.09, 1.5, 0.04, 3), 'paint', S, T([0, 1.72, -0.02]));                                  // roof
  b.add(rbox(1.7, 0.03, 1.3, 0.01, 1), 'paintMatte', P, T([0, 1.775, -0.05]));                             // roof skin (ribbed)
  for (let k = 0; k < 5; k++) b.add(rbox(1.6, 0.025, 0.04, 0.01, 1), 'paintMatte', P, T([0, 1.8, -0.55 + k * 0.25]));
  b.add(rbox(1.96, 0.1, 0.1, 0.03, 2), 'paint', S, T([0, 1.64, 0.68]));                                    // header
  b.add(rbox(1.9, 1.12, 0.08, 0.03, 2), 'paint', S, T([0, 1.13, -0.74]));                                  // cab rear wall
  glassPanel(rbox(1.78, wsLen - 0.06, 0.02, 0.01, 1), T([0, wsMid[1], wsMid[0] - 0.01], [wsA, 0, 0]));   // windshield
  // wipers
  for (const s of [-0.35, 0.35]) b.add(rbox(0.5, 0.012, 0.02, 0.004, 1), 'darkMetal', '#111', T([s, 0.7, 1.13], [wsA, 0.35, 0.3]));
  // ---------------------------------------------------------------- interior
  b.add(rbox(1.8, 0.04, 1.4, 0.01, 1), 'rubber', '#1c1c1c', T([0, 0.58, 0.28]));                           // floor mat
  b.add(rbox(1.78, 0.22, 0.3, 0.06, 2), 'plastic', '#2a2b2c', T([0, 0.89, 0.84]));                         // dashboard
  b.add(rbox(0.5, 0.16, 0.05, 0.02, 1), 'darkMetal', '#141414', T([0.45, 1.04, 0.74], [-0.4, 0, 0]));       // gauge hood
  b.glow(rbox(0.28, 0.16, 0.004, 0.002, 1), [1.4, 0.8, 0.3], 6, T([0, 0.99, 0.69], [-0.5, 0, 0]));        // center map screen
  b.add(new THREE.TorusGeometry(0.17, 0.022, 8, 28), 'rubber', '#1b1b1b', T([0.45, 1.0, 0.6], [-0.42, 0, 0]));
  b.add(tube([[0.45, 1.0, 0.6], [0.45, 0.95, 0.7], [0.45, 0.92, 0.78]], 0.03, 6, 8), 'darkMetal', '#222');
  b.add(rbox(0.3, 0.02, 0.05, 0.01, 1), 'darkMetal', '#222', T([0.45, 1.0, 0.6], [-0.42, 0, 0]));
  b.add(rbox(0.24, 0.24, 0.7, 0.04, 2), 'plastic', '#232425', T([0, 0.7, 0.35]));                          // console
  for (const s of [-1, 1]) {
    b.add(rbox(0.52, 0.14, 0.52, 0.06, 3), 'leather', '#3a2c22', T([0.45 * s, 0.67, 0.3]));
    b.add(rbox(0.5, 0.7, 0.14, 0.06, 3), 'leather', '#3a2c22', T([0.45 * s, 1.03, 0.03], [-0.16, 0, 0]));
    b.add(rbox(0.26, 0.16, 0.1, 0.04, 2), 'leather', '#2e241c', T([0.45 * s, 1.45, -0.02], [-0.16, 0, 0]));
  }
  // ---------------------------------------------------------------- cargo bed + load
  for (const s of [-1, 1]) b.add(rbox(0.08, 0.4, 1.56, 0.03, 2), 'paint', P, T([0.93 * s, 0.76, -1.46]));
  b.add(rbox(1.9, 0.42, 0.08, 0.03, 2), 'paint', P, T([0, 0.77, -2.24]));
  b.add(rbox(1.78, 0.04, 1.5, 0.01, 1), 'darkMetal', '#262626', T([0, 0.59, -1.46]));
  for (let k = 0; k < 6; k++) b.add(rbox(1.76, 0.02, 0.03, 0.005, 1), 'metal', '#6a6d71', T([0, 0.62, -0.8 - k * 0.27]));
  // crates, jerry cans, tarp roll
  b.add(rbox(0.7, 0.42, 0.55, 0.03, 2), 'plastic', '#4f5a3a', T([0.42, 0.82, -1.0], [0, 0.05, 0]));
  b.add(rbox(0.72, 0.03, 0.57, 0.01, 1), 'plastic', '#3c452c', T([0.42, 1.045, -1.0], [0, 0.05, 0]));
  b.add(rbox(0.6, 0.36, 0.45, 0.03, 2), 'plastic', '#ad7b33', T([-0.45, 0.8, -1.12], [0, -0.08, 0]));
  b.add(rbox(0.5, 0.3, 0.4, 0.03, 2), 'plastic', '#6c6f73', T([-0.3, 1.13, -1.1], [0, 0.2, 0]));
  for (let k = 0; k < 3; k++) {
    const z = -1.62 - k * 0.2;
    b.add(rbox(0.16, 0.44, 0.34, 0.03, 2), 'paint', k === 1 ? '#8f2a1c' : '#3d5a2a', T([0.72, 0.83, z]));
    b.add(rbox(0.06, 0.06, 0.1, 0.015, 1), 'darkMetal', '#222', T([0.72, 1.08, z + 0.08]));
  }
  b.add(bcyl(0.14, 1.1, 0.03, 16), 'fabric', '#6e6250', T([-0.2, 0.78, -1.95], [0, 0, Math.PI / 2]));
  b.add(tube([[-0.8, 1.1, -0.8], [-0.2, 1.2, -1.2], [0.6, 1.1, -1.6], [0.85, 0.95, -2.0]], 0.012, 16, 5), 'fabric', '#b1542a');
  // ---------------------------------------------------------------- roof rack, light bar, antenna, snorkel
  const rackY = 1.92;
  b.add(tube([[-0.9, rackY, 0.62], [0.9, rackY, 0.62]], 0.03, 4, 8), 'darkMetal', '#1f2022');
  b.add(tube([[-0.9, rackY, -0.72], [0.9, rackY, -0.72]], 0.03, 4, 8), 'darkMetal', '#1f2022');
  for (const s of [-1, 1]) {
    b.add(tube([[0.9 * s, rackY, 0.62], [0.9 * s, rackY, -0.72]], 0.03, 4, 8), 'darkMetal', '#1f2022');
    for (const z of [0.55, -0.1, -0.65]) b.add(tube([[0.9 * s, 1.76, z], [0.9 * s, rackY, z]], 0.022, 2, 6), 'darkMetal', '#1f2022');
  }
  for (let k = 0; k < 4; k++) b.add(tube([[-0.88, rackY + 0.01, 0.35 - k * 0.3], [0.88, rackY + 0.01, 0.35 - k * 0.3]], 0.015, 2, 6), 'darkMetal', '#2a2b2d');
  b.add(rbox(1.2, 0.1, 0.12, 0.03, 2), 'darkMetal', '#1a1b1c', T([0, rackY + 0.06, 0.66]));
  const barLamps = [-0.45, -0.15, 0.15, 0.45];
  for (const x of barLamps) {
    b.add(bcyl(0.1, 0.1, 0.02, 20), 'chrome', '#b9bdc2', T([x, rackY + 0.1, 0.74], [Math.PI / 2, 0, 0]));
    b.glow(new THREE.CircleGeometry(0.082, 20), [5, 4.7, 4.2], 7, T([x, rackY + 0.1, 0.791]));
  }
  b.add(rbox(0.5, 0.3, 0.9, 0.04, 2), 'plastic', '#33352f', T([0.3, rackY + 0.17, -0.25]));                // roof box
  b.add(rbox(0.52, 0.03, 0.92, 0.01, 1), 'paint', A, T([0.3, rackY + 0.33, -0.25]));
  b.add(tube([[-0.86, 1.8, -0.7], [-0.86, 2.6, -0.76], [-0.87, 3.1, -0.8]], 0.007, 12, 5), 'darkMetal', '#1a1a1a');   // antenna
  b.add(new THREE.SphereGeometry(0.022, 8, 6), 'led', '#ff3b1a', T([-0.87, 3.1, -0.8]));
  b.add(tube([[-1.02, 0.45, 1.2], [-1.0, 0.95, 1.15], [-0.98, 1.55, 0.78], [-0.98, 1.8, 0.7]], 0.055, 24, 10), 'darkMetal', '#1d1e1f');   // snorkel
  b.add(rbox(0.16, 0.12, 0.2, 0.04, 2), 'darkMetal', '#1d1e1f', T([-0.98, 1.85, 0.72]));
  // ---------------------------------------------------------------- rear: spare tire mount, ladder, lights
  b.add(rbox(0.1, 0.9, 0.08, 0.02, 1), 'darkMetal', '#232425', T([0, 0.85, -2.33]));
  for (const s of [-1, 1]) {
    b.add(tube([[0.7 * s, 0.6, -2.3], [0.7 * s, 1.72, -2.3]], 0.02, 2, 6), 'darkMetal', '#232425');
    b.add(rbox(0.12, 0.34, 0.06, 0.02, 1), 'darkMetal', '#141414', T([0.84 * s, 0.34, -2.32]));
    b.glow(rbox(0.09, 0.18, 0.02, 0.006, 1), [5, 0.2, 0.1], 2, T([0.84 * s, 0.4, -2.35]));
    b.glow(rbox(0.09, 0.06, 0.02, 0.006, 1), [4, 4, 4], 5, T([0.84 * s, 0.24, -2.35]));
  }
  for (let k = 0; k < 5; k++) b.add(tube([[0.7, 0.75 + k * 0.22, -2.3], [0.5, 0.75 + k * 0.22, -2.3]], 0.015, 2, 6), 'darkMetal', '#232425');
  // ---------------------------------------------------------------- lights (front)
  for (const s of [-1, 1]) {
    b.add(bcyl(0.13, 0.12, 0.02, 24), 'chrome', '#c4c8cc', T([0.72 * s, 0.34, 2.36], [Math.PI / 2, 0, 0]));
    b.glow(new THREE.CircleGeometry(0.105, 24), [6, 5.7, 5.2], 3, T([0.72 * s, 0.34, 2.425]));
    b.glow(rbox(0.18, 0.04, 0.02, 0.01, 1), [4, 1.8, 0.3], 1, T([0.72 * s, 0.14, 2.43]));
    // accent light strip along the lower body (livery glow)
    b.glow(rbox(0.015, 0.02, 1.2, 0.005, 1), hot, 4, T([0.99 * s, 0.09, 0.05]));
  }
  // ---------------------------------------------------------------- underside: frame, diffs, exhaust
  for (const s of [-1, 1]) b.add(rbox(0.12, 0.16, 4.2, 0.02, 1), 'darkMetal', '#1c1c1d', T([0.5 * s, -0.2, 0.05]));
  b.add(rbox(1.2, 0.05, 1.2, 0.02, 1), 'metal', '#4c4f53', T([0, -0.3, 1.5]));
  for (const z of [ROVER.hard[0][2], ROVER.hard[2][2]]) {
    b.add(new THREE.SphereGeometry(0.18, 16, 10), 'darkMetal', '#262728', T([0, -0.3, z], [0, 0, 0], [1, 0.8, 1]));
    for (const s of [-1, 1]) b.add(tube([[0.1 * s, -0.3, z], [0.6 * s, -0.3, z], [0.95 * s, -0.33, z]], 0.035, 4, 8), 'metal', '#5a5d61');
    // lower control arms (static approximation; the shock absorbers are animated separately)
    for (const s of [-1, 1]) b.add(tube([[0.45 * s, -0.25, z + 0.3], [0.88 * s, -0.33, z + 0.05], [0.45 * s, -0.25, z - 0.3]], 0.03, 12, 6), 'darkMetal', '#303133');
  }
  b.add(tube([[-0.3, -0.25, 1.0], [-0.35, -0.28, -1.0], [-0.4, -0.25, -2.0], [-0.55, -0.2, -2.4]], 0.045, 24, 8), 'metal', '#6b5b4f');
  b.add(bcyl(0.06, 0.1, 0.01, 12), 'darkMetal', '#111', T([-0.55, -0.2, -2.42], [Math.PI / 2, 0, 0]));
  // bolts along fenders and hood
  for (const s of [-1, 1]) for (let k = 0; k < 7; k++) b.add(bcyl(0.014, 0.012, 0.003, 8), 'metal', '#9a9ea4', T([0.965 * s, 0.4, -1.9 + k * 0.62], [0, 0, Math.PI / 2]));

  // ---------------------------------------------------------------- decals
  for (const s of [-1, 1]) {
    b.decal(4, [0.985 * s, 0.76, 0.5], [s, 0, 0], [0, 1, 0], [0.34, 0.3], liv.decal, [0.05, 0.12, 0.95, 0.9], s < 0);
    b.decal(12, [0.985 * s, 0.35, 1.45], [s, 0, 0], [0, 1, 0], [0.7, 0.2], liv.decal, [0, 0.1, 1, 0.75], s < 0);
    b.decal(7, [0.975 * s, 0.78, -1.3], [s, 0, 0], [0, 1, 0], [0.4, 0.2], liv.decal, [0, 0.1, 1, 0.85], s < 0);
    b.decal(9, [0.985 * s, 0.25, -0.4], [s, 0, 0], [0, 1, 0], [0.34, 0.2], liv.decal, [0, 0, 1, 1], s < 0);
    b.decal(8, [0.62 * s, 0.645, 1.5], [0, 1, 0.03], [0, 0, 1], [0.24, 0.16], liv.decal);
  }
  b.decal(0, [0, -0.02, 2.595], [0, 0, 1], [0, 1, 0], [2.1, 0.12], 0xffffff, [0, 0, 1, 0.12]);
  b.decal(0, [0, 0.0, -2.505], [0, 0, -1], [0, 1, 0], [2.0, 0.12], 0xffffff, [0, 0, 1, 0.12]);
  b.decal(5, [0, 0.645, 2.1], [0, 1, 0.08], [0, 0, 1], [0.3, 0.3], liv.decal);
  b.decal(6, [0, 0.85, -2.285], [0, 0, -1], [0, 1, 0], [0.34, 0.2], 0xffffff, [0, 0.2, 1, 0.8]);

  // ---------------------------------------------------------------- assemble
  const out = b.build({ body: mats.body, glow: mats.glow, decal: mats.decal }, { name: 'rover' });
  const root = new THREE.Group();
  root.name = 'rover-model';
  for (const k of ['body', 'glow', 'decals']) if (out[k]) root.add(out[k]);
  const gg = mergeGeometries(glassGeos, false);
  glassGeos.forEach((g) => g.dispose());
  const glass = new THREE.Mesh(gg, mats.glass);
  glass.renderOrder = 3;
  root.add(glass);

  // wheels (one geometry, 5 meshes incl. spare)
  const wb = wheelGeometry();
  const wo = wb.build({ body: mats.body }, { name: 'rover-wheel' });
  const wheelGeo = wo.body.geometry;
  const wheels = [];
  ROVER.hard.forEach(([x, y, z], i) => {
    const group = new THREE.Group();          // steering + suspension (positioned each frame)
    group.position.set(x, y - ROVER.rest + 0.12, z);
    const spin = new THREE.Mesh(wheelGeo, mats.body);
    spin.castShadow = true; spin.receiveShadow = true;
    if (x < 0) spin.rotation.y = Math.PI;      // outer face outward on both sides (spin sign flips)
    const spinG = new THREE.Group();
    spinG.add(spin);
    group.add(spinG);
    root.add(group);
    wheels.push({ group, spin: spinG, side: Math.sign(x), front: z > 0, hard: new THREE.Vector3(x, y, z) });
  });
  const spare = new THREE.Mesh(wheelGeo, mats.body);
  spare.position.set(0, 1.0, -2.62); spare.rotation.y = -Math.PI / 2; spare.scale.setScalar(0.92); spare.castShadow = true;
  root.add(spare);

  // animated shock absorbers: unit-length along +Y, oriented from chassis mount → hub each frame
  const sb = new Builder();
  sb.add(bcyl(0.045, 0.55, 0.01, 12), 'darkMetal', '#2a2b2d', T([0, 0.72, 0]));
  sb.add(bcyl(0.025, 0.6, 0.005, 10), 'chrome', '#d4d7db', T([0, 0.3, 0]));
  const coil = [];
  for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2 * 7; coil.push([Math.cos(a) * 0.075, 0.12 + (i / 64) * 0.76, Math.sin(a) * 0.075]); }
  sb.add(tube(coil, 0.013, 128, 5, false, 0.0), 'paint', A);
  sb.add(bcyl(0.1, 0.03, 0.01, 16), 'darkMetal', '#1c1d1e', T([0, 0.1, 0]));
  sb.add(bcyl(0.1, 0.03, 0.01, 16), 'darkMetal', '#1c1d1e', T([0, 0.9, 0]));
  const so = sb.build({ body: mats.body }, { name: 'rover-shock' });
  const shockGeo = so.body.geometry;
  const shocks = ROVER.hard.map(([x, y, z]) => {
    const mesh = new THREE.Mesh(shockGeo, mats.body);
    mesh.castShadow = false;
    root.add(mesh);
    return { mesh, mount: new THREE.Vector3(x * 0.62, y + 0.45, z + (z > 0 ? -0.18 : 0.18)) };
  });

  // light halos
  const sp = new SpriteBatch();
  for (const s of [-1, 1]) {
    sp.add([0.72 * s, 0.34, 2.45], [3.2, 3.0, 2.7], 0.55, 3);
    sp.add([0.84 * s, 0.4, -2.38], [2.4, 0.1, 0.05], 0.3, 2);
    sp.add([0.72 * s, 0.14, 2.45], [2.0, 0.9, 0.15], 0.2, 1);
  }
  for (const x of barLamps) sp.add([x, rackY + 0.1, 0.82], [3.0, 2.9, 2.6], 0.45, 7);
  const sprites = sp.build();
  if (sprites) root.add(sprites);

  // volumetric headlight beams (visible at dusk/night)
  const beams = [];
  for (const s of [-1, 1]) {
    const bm = makeBeam({ length: 22, radius: 4.2, color: [1.0, 0.93, 0.8] });
    bm.position.set(0.72 * s, 0.34, 2.45);
    bm.rotation.x = 0.07;
    root.add(bm); beams.push(bm);
  }
  const bar = makeBeam({ length: 30, radius: 7, color: [0.95, 0.95, 1.0] });
  bar.position.set(0, rackY + 0.1, 0.85); bar.rotation.x = 0.1;
  root.add(bar); beams.push(bar);

  const hip = V(0.45, 0.76, 0.22);
  const rider = buildRider(mats, liv, 'seat', {
    hip, handL: V(0.29, 1.0, 0.6), handR: V(0.61, 1.0, 0.6),
    footL: V(0.35, 0.62, 1.02), footR: V(0.55, 0.62, 1.02),
    knee: (s, hp) => hp.clone().add(V(0.03 * s, 0.14, 0.44)),
  });
  root.add(rider);

  return {
    root, body: out.body, glow: out.glow, decals: out.decals, glass, sprites, rider, wheels, shocks, beams, spare, tris: b.tris,
    anchors: {
      exhaust: V(-0.55, -0.2, -2.45), head: V(0, 0.34, 2.45), eye: V(0.45, 1.5, 0.42), screen: { pos: V(0.45, 1.02, 0.705), ax: 0.75, w: 0.42, h: 0.13 },
      tail: [V(0.84, 0.4, -2.36), V(-0.84, 0.4, -2.36)],
    },
  };
}
