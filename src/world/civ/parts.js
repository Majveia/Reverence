// Shared architectural parts used by every style kit. All take a Geo `g` whose current frame is the
// building frame (y = 0 at the floor, +z = front facing the street) and a materials table `M`.
import * as THREE from 'three';
import { PAT, mat, tint } from './geo.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Door with frame + step, on the +z face at (x, 0, z). */
export function door(g, x, z, w, h, M, frameM, lamp = null) {
  g.box(x, 0, z + 0.02, w + 0.3, h + 0.2, 0.18, 0.03, frameM);
  g.box(x, 0, z + 0.07, w, h, 0.12, 0, M.door || M.wood);
  g.box(x, -0.15, z + 0.45, w + 0.6, 0.18, 0.8, 0.04, M.step || M.found);
  if (lamp) { g.box(x + w / 2 + 0.35, h - 0.1, z + 0.12, 0.18, 0.28, 0.18, 0.02, lamp); g.light(x + w / 2 + 0.35, h + 0.04, z + 0.3, '#ffb86a', 3.5, 0.9, 0); }
}

/** Timber-frame beams over a wall face (x from -w/2..w/2 at depth z), height h. */
export function timberFrame(g, w, h, z, M, floors = 1) {
  const t = 0.16;
  g.box(0, 0, z, w + 0.1, t, t, 0.02, M);
  for (let f = 1; f <= floors; f++) g.box(0, h * f / floors - t / 2, z, w + 0.1, t, t, 0.02, M);
  const n = Math.max(2, Math.round(w / 1.6));
  for (let i = 0; i <= n; i++) {
    const x = -w / 2 + w * i / n;
    g.box(x, 0, z, t, h, t, 0.02, M);
  }
  // diagonal braces on the end bays
  for (const s of [-1, 1]) {
    const x0 = s * (w / 2 - w / n / 2);
    g.push().translate(x0, h / floors / 2, z).rotZ(s * 0.75);
    g.box(0, -h / floors * 0.55, 0, t * 0.9, h / floors * 1.1, t * 0.9, 0.01, M);
    g.pop();
  }
}

/** Chimney at (x, z) from roof base y0 to height h. */
export function chimney(g, x, y0, z, h, M, capM) {
  g.box(x, y0, z, 0.7, h, 0.7, 0.04, M);
  g.box(x, y0 + h, z, 0.9, 0.18, 0.9, 0.03, capM || M);
  g.box(x, y0 + h + 0.18, z, 0.35, 0.25, 0.35, 0.02, capM || M);
}

/** Flower box under a window. */
export function flowerBox(g, x, y, z, w, M, rng) {
  g.box(x, y, z + 0.15, w, 0.22, 0.3, 0.02, M.wood);
  const cols = ['#e2506a', '#f4c14a', '#f08bd0', '#ffffff', '#c04030'];
  const fm = mat(cols[Math.floor(rng.next() * cols.length)], 0.9, 0, PAT.PLAIN);
  const leaf = M.leaf || mat('#3f7a33', 0.9);
  for (let i = 0; i < 4; i++) g.sphere(x - w / 2 + w * (i + 0.5) / 4, y + 0.3, z + 0.18, 0.16, 6, 3, i % 2 ? fm : leaf);
}

/** Balcony slab + rails on the +z face. */
export function balcony(g, x, y, z, w, d, M, railM) {
  g.box(x, y, z + d / 2, w, 0.16, d, 0.03, M);
  const n = Math.max(3, Math.round(w / 0.25));
  g.box(x, y + 0.95, z + d, w, 0.06, 0.06, 0.01, railM);
  for (const s of [-1, 1]) g.box(x + s * w / 2, y + 0.95, z + d / 2, 0.06, 0.06, d, 0.01, railM);
  for (let i = 0; i <= n; i++) g.box(x - w / 2 + w * i / n, y + 0.16, z + d - 0.02, 0.035, 0.8, 0.035, 0, railM);
}

/** Awning (sloped fabric) over a shop front. */
export function awning(g, x, y, z, w, M) {
  g.push().translate(x, y, z).rotX(0.45);
  g.box(0, -0.03, 0.55, w, 0.05, 1.1, 0.02, M);
  g.pop();
}

/** Antenna mast with blinking red tip. */
export function antenna(g, x, y, z, h, M, blink = true) {
  g.cyl(x, y, z, 0.08, 0.03, h, 5, false, M);
  g.box(x, y + h * 0.35, z, 0.5, 0.04, 0.04, 0, M);
  g.box(x, y + h * 0.6, z, 0.35, 0.04, 0.04, 0, M);
  if (blink) g.light(x, y + h + 0.1, z, '#ff2a1a', 6, 1.4, 1);
}

/** Satellite / radar dish on a pedestal. */
export function dish(g, x, y, z, r, M, tilt = 0.7, yaw = 0) {
  g.cyl(x, y, z, r * 0.14, r * 0.1, r * 0.8, 8, true, M);
  g.push().translate(x, y + r * 0.85, z).rotY(yaw).rotX(-tilt);
  g.lathe(0, 0, 0, [[0.02, r * 0.28], [r * 0.35, r * 0.3], [r * 0.7, r * 0.2], [r, 0], [r * 0.97, 0.03], [0.02, r * 0.25]].map(([a, b]) => [a, -b + r * 0.3]), 18, M);
  g.cyl(0, r * 0.05, 0, 0.03 * r, 0.02 * r, r * 0.7, 4, false, M);
  g.pop();
}

/** Pipe run along a polyline (local points). */
export function pipes(g, pts, r, M) { g.tube(pts.map((p) => V(p[0], p[1], p[2])), r, 6, M); }

/** Sign board with emissive face (neon/holo) on +z face. */
export function sign(g, x, y, z, w, h, faceM, backM, vertical = false) {
  if (vertical) g.panel(x, y, z + 0.4, h, w, 0.12, faceM, backM);
  else g.panel(x, y, z + 0.1, w, h, 0.12, faceM, backM);
}

/** Street lamp (style: 'lantern' | 'modern' | 'neon' | 'torch' | 'pole'). */
export function lamp(g, x, z, kind, M, glowCol = '#ffc27a') {
  const L = M.lampGlow || mat(glowCol, 0.4, 0, PAT.LAMP, 6);
  if (kind === 'lantern') {
    g.cyl(x, 0, z, 0.09, 0.07, 3.0, 6, true, M.iron || M.wood);
    g.box(x + 0.35, 2.9, z, 0.75, 0.06, 0.06, 0, M.iron || M.wood);
    g.box(x + 0.65, 2.42, z, 0.26, 0.38, 0.26, 0.03, L);
    g.box(x + 0.65, 2.8, z, 0.34, 0.08, 0.34, 0.02, M.iron || M.wood);
    g.light(x + 0.65, 2.6, z, glowCol, 5, 1.3, 2);
  } else if (kind === 'torch') {
    g.cyl(x, 0, z, 0.1, 0.08, 1.8, 6, true, M.wood);
    g.cyl(x, 1.8, z, 0.12, 0.2, 0.3, 6, true, M.iron || M.wood);
    g.light(x, 2.25, z, '#ff8a2a', 6, 1.2, 2);
  } else if (kind === 'neon') {
    g.cyl(x, 0, z, 0.1, 0.08, 5.2, 6, true, M.metal);
    g.box(x, 5.2, z, 0.14, 0.12, 1.6, 0.02, M.metal);
    g.box(x, 5.08, z + 0.6, 0.12, 0.06, 0.5, 0, L);
    g.light(x, 4.95, z + 0.6, glowCol, 7, 1.8, 0);
  } else {
    g.cyl(x, 0, z, 0.1, 0.07, 4.6, 6, true, M.metal || M.iron);
    g.push().translate(x, 4.6, z);
    g.box(0, 0, 0.45, 0.12, 0.1, 0.9, 0.02, M.metal || M.iron);
    g.box(0, -0.1, 0.85, 0.32, 0.1, 0.5, 0.02, L);
    g.pop();
    g.light(x, 4.4, z + 0.85, glowCol, 6, 1.6, 0);
  }
  g.collider(x, 1.5, z, 0.15, 1.5, 0.15);
}

/** Stylised tree (rounded canopy or conifer), for gardens and plazas. */
export function tree(g, x, y, z, h, M, rng, conifer = false) {
  const trunk = M.bark || mat('#5a4030', 0.95);
  const leaf = M.leaf || mat('#3f7a33', 0.9);
  g.cyl(x, y, z, h * 0.05, h * 0.035, h * 0.55, 6, false, trunk);
  if (conifer) {
    for (let i = 0; i < 3; i++) g.cyl(x, y + h * (0.3 + i * 0.22), z, h * (0.28 - i * 0.07), 0.02, h * 0.38, 8, true, tint(leaf, 0.9 + i * 0.08));
  } else {
    const n = 4;
    for (let i = 0; i < n; i++) {
      const a = i / n * 6.28 + rng.next(), r = h * 0.16;
      g.sphere(x + Math.cos(a) * r, y + h * (0.62 + rng.next() * 0.12), z + Math.sin(a) * r, h * rng.range(0.2, 0.27), 8, 5, tint(leaf, rng.range(0.85, 1.15)));
    }
    g.sphere(x, y + h * 0.8, z, h * 0.24, 8, 5, tint(leaf, 1.1));
  }
}

/** Low fence / wall around a rectangle (w×d) with a gap at the front. */
export function fence(g, w, d, h, M, post = true) {
  const edges = [[-w / 2, -d / 2, w / 2, -d / 2], [w / 2, -d / 2, w / 2, d / 2], [-w / 2, d / 2, -1.2, d / 2], [1.2, d / 2, w / 2, d / 2], [-w / 2, d / 2, -w / 2, -d / 2]];
  for (const [x0, z0, x1, z1] of edges) {
    const l = Math.hypot(x1 - x0, z1 - z0); if (l < 0.3) continue;
    g.push().translate((x0 + x1) / 2, 0, (z0 + z1) / 2).rotY(Math.atan2(x1 - x0, z1 - z0) - Math.PI / 2);
    if (post) {
      g.box(0, h * 0.55, 0, l, 0.08, 0.05, 0, M); g.box(0, h * 0.2, 0, l, 0.08, 0.05, 0, M);
      const n = Math.max(1, Math.round(l / 1.8));
      for (let i = 0; i <= n; i++) g.box(-l / 2 + l * i / n, 0, 0, 0.1, h, 0.1, 0.02, M);
    } else g.box(0, 0, 0, l, h, 0.45, 0.06, M);
    g.pop();
  }
}

/** Market stall with canopy and goods. */
export function stall(g, M, rng, canvas) {
  const cm = canvas || mat(['#c8443a', '#e8c46a', '#3a7ab8', '#e8e0d0'][Math.floor(rng.next() * 4)], 0.95, 0, PAT.FABRIC, 0.6);
  for (const [x, z] of [[-1.3, -0.8], [1.3, -0.8], [-1.3, 0.8], [1.3, 0.8]]) g.cyl(x, 0, z, 0.05, 0.05, 2.3, 5, true, M.wood);
  g.box(0, 0.8, 0.2, 2.6, 0.12, 1.2, 0.02, M.wood);
  g.push().translate(0, 2.3, 0).rotX(0.25); g.box(0, 0, 0, 3.0, 0.05, 2.1, 0, cm); g.pop();
  const goods = ['#d65a3a', '#e8b84a', '#8ab04a', '#a0603a', '#d8d0b8'];
  for (let i = 0; i < 6; i++) g.box(-1.0 + i * 0.4, 0.92, 0.2 + (i % 2) * 0.3, 0.3, 0.22, 0.28, 0.03, mat(goods[i % goods.length], 0.8));
  g.light(0, 2.0, 0.3, '#ffb060', 3, 1.0, 2);
}

/** Barrel/crate clutter. */
export function clutter(g, x, z, M, rng, n = 3) {
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, 6.28), r = rng.range(0, 0.9);
    if (rng.next() < 0.5) g.cyl(x + Math.cos(a) * r, 0, z + Math.sin(a) * r, 0.32, 0.3, 0.85, 8, true, M.barrel || M.wood);
    else { g.push().translate(x + Math.cos(a) * r, 0, z + Math.sin(a) * r).rotY(rng.range(0, 1.5)); g.box(0, 0, 0, 0.7, 0.6, 0.7, 0.04, M.crate || M.wood); g.pop(); }
  }
}

/** Catenary cable between two local points (sag s). */
export function cable(g, a, b, sag, r, M, lanterns = 0, lanternCol = '#ffb35a') {
  const pts = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = V(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t);
    pts.push(p);
  }
  g.tube(pts, r, 3, M);
  if (lanterns > 0) {
    const L = mat(lanternCol, 0.5, 0, PAT.LAMP, 5);
    for (let i = 1; i <= lanterns; i++) {
      const t = i / (lanterns + 1);
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), z = a[2] + (b[2] - a[2]) * t;
      g.sphere(x, y - 0.25, z, 0.16, 6, 4, L);
      g.light(x, y - 0.25, z, lanternCol, 3, 0.8, 2);
    }
  }
}

/** Windmill (village landmark): stone tower, cap, 4 sails. */
export function windmill(g, M, h = 11, rot = 0.3) {
  g.lathe(0, 0, 0, [[3.2, 0], [3.0, h * 0.4], [2.5, h]], 12, M.stone);
  g.cyl(0, 0, 0, 3.25, 3.05, 0.9, 12, false, M.found);
  g.push().translate(0, h, 0); g.dome(0, 0, 0, 2.7, 12, 4, M.roof, 1.1); g.pop();
  g.push().translate(0, h + 0.8, 2.9).rotZ(rot);
  g.cyl(0, -0.3, 0, 0.25, 0.25, 0.6, 8, true, M.wood);
  for (let i = 0; i < 4; i++) {
    g.push().rotZ(i * Math.PI / 2);
    g.box(0, 0, 0.1, 0.22, h * 0.95, 0.12, 0.02, M.wood);
    g.box(0.7, h * 0.18, 0.12, 1.2, h * 0.72, 0.04, 0, M.sail || M.canvas);
    g.pop();
  }
  g.pop();
  door(g, 0, 3.0, 1.1, 2.1, M, M.wood);
  g.collider(0, h / 2, 0, 3.1, h / 2, 3.1);
}

/** Lattice truss tower (pylons, launch towers, radio masts). */
export function lattice(g, h, w0, w1, M, levels = 8, beam = 0.12) {
  const P = (i, s1, s2) => { const t = i / levels; const w = w0 + (w1 - w0) * t; return V(s1 * w / 2, h * t, s2 * w / 2); };
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [a, b] of corners) g.tube([P(0, a, b), P(levels, a, b)], beam, 4, M);
  for (let i = 0; i < levels; i++) {
    for (let k = 0; k < 4; k++) {
      const [a, b] = corners[k], [c, d] = corners[(k + 1) % 4];
      g.tube([P(i, a, b), P(i + 1, c, d)], beam * 0.6, 3, M);
      g.tube([P(i + 1, a, b), P(i + 1, c, d)], beam * 0.6, 3, M);
    }
  }
}

/** Colossal statue: robed figure with staff/raised arm. scale = height m. */
export function statue(g, h, M, rng, pose = 0) {
  const s = h / 10;
  const S = M.statue || M.stone;
  // plinth
  g.box(0, 0, 0, 5 * s, 1.2 * s, 5 * s, 0.1 * s, M.found);
  g.box(0, 1.2 * s, 0, 4.2 * s, 0.4 * s, 4.2 * s, 0.08 * s, S);
  g.push().translate(0, 1.6 * s, 0);
  // robe
  g.lathe(0, 0, 0, [[1.7 * s, 0], [1.55 * s, 1.0 * s], [1.2 * s, 3.2 * s], [0.95 * s, 4.8 * s], [1.05 * s, 5.6 * s], [0.8 * s, 6.2 * s], [0.35 * s, 6.5 * s]], 14, S);
  // head + hood
  g.sphere(0, 7.05 * s, 0.05 * s, 0.55 * s, 10, 6, S);
  g.lathe(0, 6.35 * s, -0.05 * s, [[0.75 * s, 0], [0.72 * s, 0.6 * s], [0.5 * s, 1.1 * s], [0.05 * s, 1.35 * s]], 12, tint(S, 0.92));
  // arms
  for (const sd of [-1, 1]) {
    const raised = pose === 1 && sd > 0;
    g.push().translate(sd * 1.0 * s, 5.8 * s, 0).rotZ(sd * (raised ? -2.6 : 0.25)).rotX(raised ? 0 : -0.3);
    g.cyl(0, -3.0 * s, 0, 0.3 * s, 0.42 * s, 3.0 * s, 8, true, S);
    g.sphere(0, -3.1 * s, 0, 0.3 * s, 8, 5, S);
    g.pop();
  }
  // staff
  if (pose !== 1) {
    g.cyl(1.35 * s, -1.6 * s, 0.6 * s, 0.1 * s, 0.1 * s, 9.5 * s, 6, true, M.metal || S);
    g.sphere(1.35 * s, 8.0 * s, 0.6 * s, 0.35 * s, 8, 6, M.glow || S);
    if (M.glow) g.light(1.35 * s, 8.0 * s, 0.6 * s, '#9fe8ff', 12, 3 * s, 0);
  } else {
    g.sphere(1.85 * s, 9.5 * s, 0, 0.5 * s, 10, 6, M.glow || S);
    if (M.glow) g.light(1.85 * s, 9.5 * s, 0, '#ffd890', 14, 4 * s, 0);
  }
  g.pop();
  g.collider(0, h / 2, 0, 2.5 * s, h / 2, 2.5 * s);
}

/** Obelisk with pyramidion (optionally glyph-covered). */
export function obelisk(g, h, M, glyphM) {
  const w = h * 0.1;
  g.box(0, 0, 0, w * 2.2, w * 0.6, w * 2.2, w * 0.05, M.found);
  g.push().translate(0, w * 0.6, 0);
  const pts = [[-w / 2, -w / 2], [w / 2, -w / 2], [w / 2, w / 2], [-w / 2, w / 2]];
  g.lathe(0, 0, 0, [[w * 0.72, 0], [w * 0.5, h * 0.9], [0.01, h]], 4, glyphM || M.stone, { a0: Math.PI / 4, a1: Math.PI / 4 + Math.PI * 2 });
  g.pop();
  void pts;
  g.collider(0, h / 2, 0, w * 0.7, h / 2, w * 0.7);
}

/** Beacon tower: tapered shaft + lantern room + light. */
export function beacon(g, h, M, col = '#ffe0a0') {
  g.lathe(0, 0, 0, [[2.2, 0], [1.9, h * 0.1], [1.3, h * 0.85], [1.6, h * 0.87], [1.6, h * 0.9]], 12, M.stone);
  g.cyl(0, h * 0.9, 0, 1.1, 1.1, 2.2, 10, false, mat(col, 0.3, 0, PAT.LAMP, 8));
  g.cyl(0, h * 0.9 + 2.2, 0, 1.5, 0.2, 1.6, 10, true, M.roof || M.metal);
  g.light(0, h * 0.9 + 1.1, 0, col, 30, 8, 0);
  g.collider(0, h / 2, 0, 2, h / 2, 2);
}

/** Ancient arch (monument / gate). */
export function arch(g, span, h, depth, M) {
  const legW = span * 0.18;
  for (const s of [-1, 1]) g.box(s * (span / 2 + legW / 2), 0, 0, legW, h, depth, 0.1, M);
  // arch ring (lathe half-torus approximated by boxes along an arc)
  const n = 14, r = span / 2 + legW / 2;
  for (let i = 0; i < n; i++) {
    const a0 = Math.PI * i / n, a1 = Math.PI * (i + 1) / n, am = (a0 + a1) / 2;
    g.push().translate(Math.cos(am) * r, h + Math.sin(am) * r * 0.7, 0).rotZ(am + Math.PI / 2);
    g.box(0, -legW / 2, 0, r * (a1 - a0) * 1.08, legW, depth * 0.95, 0.05, M);
    g.pop();
  }
  g.box(0, h + r * 0.7 + legW * 0.4, 0, legW * 1.3, legW * 1.2, depth * 1.05, 0.05, M.key || M);
  for (const s of [-1, 1]) g.collider(s * (span / 2 + legW / 2), h / 2, 0, legW / 2, h / 2, depth / 2);
}
